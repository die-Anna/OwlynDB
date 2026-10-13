import { createReadStream, promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Dialect, ImportRequest, QueryRun, StatementInput } from '../shared/api-types';
import { splitSql, withoutLeadingComments, type SplitStatement } from '../shared/sql-splitter';
import { errorText, type CopyTarget, type Session } from './drivers/common';

export interface ImportProgress {
  bytes: number;
  total: number;
  statements: number;
  errors: number;
  /** übersprungene USE- und DROP/CREATE/ALTER DATABASE-Anweisungen (skipUse) */
  skipped: number;
  /** Warnungen des Servers (MySQL: gekürzte Werte, ungültige Daten – mysqldump schaltet den strikten Modus ab) */
  warnings: number;
  /** Fehler übersprungen: Zeilen der fehlgeschlagenen INSERT-Anweisungen (ein Mehrzeilen-INSERT fällt ganz weg) */
  lostRows: number;
  /** Fehler übersprungen: fehlgeschlagene Index-, Schlüssel- und Constraint-Anweisungen */
  missingObjects: number;
  line: number;
  log: string[];
}

/** pg_dump: COPY … FROM stdin; danach Datenzeilen bis "\." */
const COPY_STDIN = /^COPY\b[\s\S]*\bFROM\s+STDIN\b/i;
const USE_STMT = /^USE\s/i;
/** SQL Server: nur die USE-Anweisung am Anfang des Batches (ohne GO gehört der Rest des Batches dazu) */
const USE_HEAD = /^USE\s+(?:\[[^\]]*\]|"[^"]*"|[^\s;]+)\s*;?/i;
/**
 * Datenbank-Anweisungen mit festem Namen (mysqldump --databases/--add-drop-database, pg_dump -C, SSMS): mit skipUse
 * übersprungen – sie träfen die Quell-Datenbank auf dem Zielserver (bis hin zu DROP DATABASE)
 */
const DATABASE_STMT = /^(?:\/\*M?!\d*\s*)?(?:DROP|CREATE|ALTER)\s+DATABASE\b/i;
/** MySQL: SCHEMA ist dort dasselbe wie DATABASE */
const SCHEMA_STMT_MYSQL = /^(?:\/\*M?!\d*\s*)?(?:DROP|CREATE|ALTER)\s+SCHEMA\b/i;
/**
 * Kodierungs-Anweisungen der Datei: die Datei ist schon nach ihrer Kodierung gelesen, und die Treiber sprechen UTF-8.
 * An den Server gegeben, stellten sie die Verbindung um (mysql2 kodierte danach z. B. mit latin1 und kappte Zeichen).
 */
const CHARSET_STMT: Partial<Record<Dialect, RegExp>> = {
  mysql: /^(?:\/\*M?!\d*\s*)?SET\s+(?:NAMES\b|CHARACTER\s+SET\b|(?:@@(?:SESSION\.|LOCAL\.)?)?CHARACTER_SET_(?:CLIENT|CONNECTION|RESULTS)\s*=)/i,
  postgres: /^SET\s+client_encoding\b/i,
};
/** so viele Anweisungen gehen zusammen an den Server (eine Ausführung, Fehler mit Index) */
const BATCH = 200;
const MAX_LOGGED_ERRORS = 50;

/** Index, Primär-/Fremdschlüssel, UNIQUE: fehlt er im Ziel, verhält sich die Kopie anders als die Quelle */
const KEY_DDL = /^(CREATE\s+(UNIQUE\s+)?((NON)?CLUSTERED\s+)?INDEX\b|ALTER\s+TABLE\b[\s\S]*?\bADD\s+(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|INDEX|KEY)\b)/i;

/**
 * Zeilen einer INSERT … VALUES-Anweisung: Tupel auf oberster Ebene nach VALUES, bis ON …/RETURNING/;. Zeichenketten und
 * Bezeichner in Anführungszeichen werden übersprungen (verdoppelte Zeichen, bei MySQL auch \-Escapes). 0 = kein solches INSERT.
 */
export function insertRowCount(sql: string, dialect: Dialect): number {
  const m = /^\s*INSERT\b[\s\S]*?\bVALUES\b/i.exec(sql);
  if (!m) return 0;
  let depth = 0;
  let rows = 0;
  for (let i = m.index + m[0].length; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < sql.length; i++) {
        if (sql[i] === '\\' && dialect === 'mysql' && c !== '`') i++;
        else if (sql[i] === c) {
          if (sql[i + 1] !== c) break;
          i++;
        }
      }
    } else if (c === '(') {
      if (depth++ === 0) rows++;
    } else if (c === ')') depth--;
    // nach den Tupeln: ON DUPLICATE KEY / ON CONFLICT / RETURNING bzw. Ende
    else if (depth === 0 && rows > 0 && /[A-Za-z;]/.test(c)) break;
  }
  return rows;
}

/** Zusammenfassung nach dem Einspielen mit übersprungenen Fehlern: was im Ziel fehlt */
export function skippedSummary(p: ImportProgress): string {
  const parts = [`${p.errors} Anweisung(en) mit Fehler übersprungen`];
  if (p.lostRows) parts.push(`${p.lostRows.toLocaleString('de-CH')} Zeile(n) nicht eingefügt`);
  if (p.missingObjects) parts.push(`${p.missingObjects} Index/Schlüssel fehlen im Ziel`);
  return parts.join(' – ') + '.';
}
/** größer darf eine einzelne Anweisung nicht werden (fehlendes Trennzeichen ließe den Puffer sonst bis zum Absturz wachsen) */
const MAX_STATEMENT = 256 * 1024 * 1024;
/** MySQL: solche Anweisungen am Stück werden in einer Transaktion gebündelt (siehe runImport) */
const WRITE_STMT = /^(INSERT|REPLACE|UPDATE|DELETE)\b/i;
const LOCK_TABLES = /^LOCK\s+TABLES?\b/i;
const UNLOCK_TABLES = /^UNLOCK\s+TABLES?\b/i;
/** liest, was die Anweisung davor hinterlassen hat – COMMIT bzw. START TRANSACTION dazwischen setzten es zurück */
const READS_LAST = /\b(ROW_COUNT|FOUND_ROWS)\s*\(|@@(SESSION\.)?(WARNING_COUNT|ERROR_COUNT)\b|\bSHOW\s+(COUNT\s*\(\s*\*\s*\)\s+)?(WARNINGS|ERRORS)\b|\bGET\s+(CURRENT\s+|STACKED\s+)?DIAGNOSTICS\b/i;

/** Anweisung und ihre Zeile in der Datei */
interface Stmt {
  sql: string;
  line: number;
}

/**
 * SQL-Datei Anweisung für Anweisung in der Sitzung ausführen. Liest in Blöcken (auch sehr große Dumps),
 * erkennt die Kodierung (BOM, UTF-16, SET NAMES / client_encoding der Datei, sonst UTF-8 mit Rückfall Windows-1252),
 * DELIMITER (mysqldump), GO (SSMS) und COPY FROM stdin (pg_dump).
 * source: statt der Datei ein Datenstrom in UTF-8 (Kopieren: kommt direkt aus dem Dump).
 * MySQL hat keine Transaktion fürs Ganze (DDL schreibt sofort fest) und schriebe so jede Anweisung einzeln fest – bei
 * vielen einzelnen INSERTs langsam (Test-Server: 11 statt 0,9 ms je Anweisung). Deshalb gehen INSERT/UPDATE/DELETE am Stück
 * in einer Transaktion je Block, solange das Skript keine eigene führt (Autocommit an, keine offen, keine LOCK TABLES).
 * Nach außen bleibt es wie einzeln: schlägt eine Anweisung fehl, wird festgeschrieben, was davor lief; liest eine
 * Anweisung ROW_COUNT() & Co. der vorigen, steht zwischen den beiden kein eigenes COMMIT.
 */
export async function runImport(
  session: Session,
  dialect: Dialect,
  req: ImportRequest,
  p: ImportProgress,
  cancelled: () => boolean,
  source?: Readable,
): Promise<void> {
  if (!source) p.total = (await fs.stat(req.file)).size;
  const head = source ? { encoding: 'utf-8' } : await inspectFile(req.file, dialect);
  if (head.note) p.log.push(head.note);
  // Datei: ungültige Bytefolgen sind ein Fehler (falsche Kodierung, Rohbytes) – still ersetzt kämen falsche Daten ins Ziel
  const decoder = new TextDecoder(head.encoding, { fatal: !source });
  // beim Kopieren gibt es keine Datei, deren Zeilennummer weiterhelfen würde
  const where = (line: number) => (source ? 'Im Ziel' : `Zeile ${line}`);
  const since = (st: Stmt) => (source ? '' : ` ab Zeile ${st.line}`);
  let buffer = '';
  let delimiter = ';';
  let copy: { target: CopyTarget; sql: string } | undefined;
  /** COPY: der Server hat mitten im Datenstrom abgelehnt – Rest bis "\." nur noch überlesen */
  let copyFailure: unknown;
  let first = true;
  /** MySQL: LOCK TABLES aktiv – START TRANSACTION höbe die Sperren auf, also nicht bündeln */
  let locked = false;
  /** erst ab dieser Puffergröße erneut zerlegen: eine riesige Anweisung würde sonst mit jedem Block von vorn gelesen (quadratisch) */
  let nextScan = 0;
  let charsetNoted = false;

  /** Anweisung ohne Kommentare davor, auch ohne /*! … *\/ – zum Erkennen der Art (USE, COPY, LOCK TABLES, Schreiben) */
  const bare = (sql: string) => withoutLeadingComments(sql, dialect, false);

  /** fehlgeschlagene Anweisung: aufhören oder ins Protokoll und weiter */
  const failed = (st: Stmt, error: string) => {
    const head = `${where(st.line)}: ${error}`;
    const sql = `\n  ${st.sql.replace(/\s+/g, ' ').slice(0, 160)}`;
    p.errors++;
    if (req.stopOnError || session.broken) throw new Error(head + sql);
    // übersprungen: sagen, was im Ziel fehlt – ein Mehrzeilen-INSERT mit einer Dublette verliert alle seine Zeilen, ein
    // fehlgeschlagener UNIQUE-Index bzw. Fremdschlüssel fehlte sonst still
    const code = bare(st.sql);
    const rows = insertRowCount(code, dialect);
    const key = KEY_DDL.test(code);
    p.lostRows += rows;
    if (key) p.missingObjects++;
    const what = rows ? ` – ${rows} Zeile(n) dieser Anweisung fehlen im Ziel` : key ? ' – fehlt im Ziel' : '';
    // fehlende Indizes und Schlüssel immer melden, auch nach vielen anderen Fehlern
    if (p.log.length < MAX_LOGGED_ERRORS || key) p.log.push((key ? 'Achtung, Index/Schlüssel: ' : '') + head + what + sql);
  };

  /** Warnungen des Servers zählen (MySQL: „N Warnungen“ je Anweisung, PostgreSQL: WARNING-Meldungen) */
  const noteWarnings = (r: QueryRun) => {
    for (const m of r.messages) {
      const w = /^(\d+) Warnung/.exec(m);
      if (w) p.warnings += Number(w[1]);
      else if (/^WARNING:/.test(m)) p.warnings++;
    }
  };

  /** Anweisungen, wie sie sind (ohne Transaktion schreibt der Server jede einzeln fest); Rückgabe: so viele sind erledigt */
  const plain = async (part: Stmt[]): Promise<number> => {
    const input: StatementInput[] = part.map((s) => ({ sql: s.sql, offset: 0 }));
    const r = await session.run(input, 0);
    noteWarnings(r);
    for (const o of r.statements) {
      if (o.error) continue;
      const code = bare(part[o.statementIndex].sql);
      if (LOCK_TABLES.test(code)) locked = true;
      else if (UNLOCK_TABLES.test(code)) locked = false;
    }
    const bad = r.statements.find((s) => s.error);
    p.statements += r.statements.filter((s) => !s.error).length;
    if (!bad) return part.length;
    failed(part[bad.statementIndex], bad.error ?? '');
    return bad.statementIndex + 1;
  };

  /**
   * MySQL: INSERT/UPDATE/DELETE am Stück in einer Transaktion – einmal festschreiben statt nach jeder Anweisung. Schlägt
   * eine fehl, wird festgeschrieben, was davor lief, und es geht weiter wie ohne Bündeln. Rückgabe: so viele sind erledigt.
   */
  const group = async (part: Stmt[]): Promise<number> => {
    const input: StatementInput[] = [{ sql: 'START TRANSACTION', offset: 0 }, ...part.map((s) => ({ sql: s.sql, offset: 0 })), { sql: 'COMMIT', offset: 0 }];
    const r = await session.run(input, 0);
    noteWarnings(r);
    const bad = r.statements.find((s) => s.error);
    if (!bad && r.statements.length === input.length) {
      p.statements += part.length;
      return part.length;
    }
    if (bad?.statementIndex === 0) throw new Error(`${where(part[0].line)}: START TRANSACTION: ${bad.error}`);
    if (bad?.statementIndex === input.length - 1) {
      throw new Error(`${where(part.at(-1)!.line)}: COMMIT: ${bad.error}\n  Die ${part.length} Anweisung(en)${since(part[0])} sind womöglich nicht eingespielt.`);
    }
    // so viele liefen ohne Fehler (ohne Fehler, aber nicht alle: abgebrochen)
    const ran = Math.max(0, Math.min(part.length, (bad ? bad.statementIndex : r.statements.length) - 1));
    const at = part[Math.min(ran, part.length - 1)];
    if (session.broken) {
      throw new Error(`${where(at.line)}: ${bad?.error ?? 'Verbindung getrennt'}\n  Die ${ran} Anweisung(en) davor${since(part[0])} waren noch nicht festgeschrieben und sind nicht eingespielt.`);
    }
    // meist nimmt MySQL nur die fehlerhafte Anweisung zurück – ein Deadlock rollt aber die ganze Transaktion zurück
    await session.run([{ sql: 'DO 0', offset: 0 }], 0);
    if (session.inTransaction) {
      const c = await session.run([{ sql: 'COMMIT', offset: 0 }], 0);
      if (c.statements[0]?.error) throw new Error(`${where(at.line)}: COMMIT: ${c.statements[0].error}`);
    } else if (ran > 0) {
      throw new Error(
        `${where(at.line)}: ${bad?.error ?? 'abgebrochen'}\n  Der Server hat dabei die ganze Transaktion zurückgerollt: die ${ran} Anweisung(en) davor${since(part[0])} sind nicht eingespielt, alles davor schon.`,
      );
    }
    p.statements += ran;
    if (!bad) return ran;
    failed(part[ran], bad.error ?? '');
    return ran + 1;
  };

  /** more: es folgen noch Anweisungen (die nächste ist noch nicht gelesen) */
  const exec = async (list: Stmt[], more: boolean) => {
    const isWrite = (k: number) => WRITE_STMT.test(bare(list[k].sql));
    // ROW_COUNT() & Co. der Anweisung davor: dazwischen darf kein eigenes COMMIT bzw. START TRANSACTION stehen
    const readsLast = (k: number) => (k < list.length ? READS_LAST.test(list[k].sql) : more);
    let i = 0;
    while (i < list.length) {
      if (cancelled()) throw new Error('Abgebrochen.');
      const canGroup = dialect === 'mysql' && !locked && session.autocommitIdle === true;
      let n = 0;
      if (canGroup && !readsLast(i)) {
        while (n < BATCH && i + n < list.length && isWrite(i + n)) n++;
        // liest die Anweisung danach ROW_COUNT() (oder ist sie noch unbekannt): die letzte einzeln, ohne COMMIT danach
        if (n && readsLast(i + n)) n--;
      }
      if (n >= 2) {
        i += await group(list.slice(i, i + n));
        continue;
      }
      let size = Math.min(BATCH, list.length - i);
      if (canGroup) {
        // nur bis vor die nächste Schreib-Anweisung (die dann vielleicht gebündelt wird)
        size = 1;
        while (size < BATCH && i + size < list.length && !isWrite(i + size)) size++;
      }
      i += await plain(list.slice(i, i + size));
    }
  };

  /**
   * Anweisung der Datei, die nicht an den Server geht: USE und DATABASE-Anweisungen (skipUse), Kodierungs-SETs.
   * Rückgabe: was auszuführen ist (SQL Server: der Batch ohne seine USE-Zeile), oder '' = überspringen.
   */
  const filtered = (raw: string): string => {
    // Kommentare davor (mysqldump: "-- Current Database: `shop`") zählen nicht, /*!…*/ und /*M!…*/ führt MySQL aber aus;
    // verschachtelte Blockkommentare (PostgreSQL, SQL Server) ganz
    const sql = withoutLeadingComments(raw, dialect);
    const charset = CHARSET_STMT[dialect];
    if (charset?.test(sql)) {
      // Hinweis nur, wenn die Datei etwas anderes als UTF-8 verlangt (SET NAMES utf8mb4 steht in jedem mysqldump)
      const name = /\b(?:NAMES|CHARACTER\s+SET|=)\s*['"]?([A-Za-z][A-Za-z0-9_-]*)/i.exec(sql)?.[1]?.toLowerCase();
      const wants = name ? (CHARSETS[name] ?? name) : 'utf-8';
      if (!charsetNoted && (wants !== 'utf-8' || head.encoding !== 'utf-8')) {
        charsetNoted = true;
        p.log.push(
          `${sql.replace(/\s+/g, ' ').slice(0, 60)} der Datei übersprungen: die Datei wurde bereits als ${head.encoding.toUpperCase()} gelesen, die Verbindung bleibt auf UTF-8.`,
        );
      }
      return '';
    }
    if (!req.skipUse) return sql;
    if (DATABASE_STMT.test(sql) || (dialect === 'mysql' && SCHEMA_STMT_MYSQL.test(sql))) {
      p.skipped++;
      return '';
    }
    if (dialect === 'postgres') return sql;
    const code = bare(sql);
    if (!USE_STMT.test(code)) return sql;
    p.skipped++;
    // SQL Server ohne GO: der Batch geht nach USE weiter – nur die USE-Anweisung entfernen
    return dialect === 'mssql' ? code.replace(USE_HEAD, '').trim() : '';
  };

  /** COPY-Daten an den Server; nach einem Fehler nur noch überlesen (bis "\."), bei stopOnError sofort aufhören */
  const copyWrite = async (data: string) => {
    if (!copy || copyFailure !== undefined || !data) return;
    try {
      await copy.target.write(data);
    } catch (e) {
      copyFailure = e;
      copy.target.abort();
      if (req.stopOnError) throw new Error(`bis Zeile ${p.line}: ${errorText(e)}\n  ${copy.sql.slice(0, 160)}`);
    }
  };

  /** Puffer abarbeiten; final = Dateiende */
  const drain = async (final: boolean): Promise<void> => {
    for (;;) {
      if (copy) {
        // Datenzeilen bis zur Zeile "\."
        const m = /(^|\n)\\\.\r?(\n|$)/.exec(buffer);
        if (m) {
          const cut = m.index + m[1].length;
          if (cut) await copyWrite(buffer.slice(0, cut));
          countLines(buffer.slice(0, m.index + m[0].length));
          buffer = buffer.slice(m.index + m[0].length);
          await finishCopy();
          continue;
        }
        if (final) {
          await copyWrite(buffer);
          countLines(buffer);
          buffer = '';
          await finishCopy();
          return;
        }
        const last = buffer.lastIndexOf('\n');
        if (last >= 0) {
          await copyWrite(buffer.slice(0, last + 1));
          countLines(buffer.slice(0, last + 1));
          buffer = buffer.slice(last + 1);
        }
        return;
      }
      if (buffer.length > MAX_STATEMENT) {
        throw new Error(`${where(p.line + 1)}: eine einzelne Anweisung ist größer als ${MAX_STATEMENT / 1024 / 1024} MB – fehlt ein Trennzeichen (;, GO, DELIMITER)?`);
      }
      // noch keine vollständige Anweisung im Puffer: erst weiterlesen, bis er sich verdoppelt hat
      if (!final && buffer.length < nextScan) return;
      const stmts = splitSql(buffer, dialect, delimiter, true);
      const complete = final ? stmts : stmts.slice(0, -1);
      nextScan = complete.length ? 0 : Math.min(MAX_STATEMENT + 1, buffer.length * 2);
      const list: Stmt[] = [];
      let pos = 0;
      let lineAt = p.line;
      let copyStart: SplitStatement | undefined;
      for (const st of complete) {
        lineAt += newlines(buffer, pos, st.start);
        pos = st.start;
        let sql = dialect === 'postgres' ? stripPsqlMeta(st.sql) : st.sql;
        if (!sql) continue;
        sql = filtered(sql);
        if (!sql) continue;
        if (dialect === 'postgres' && COPY_STDIN.test(bare(sql))) {
          copyStart = { ...st, sql };
          break;
        }
        // SQL Server „GO n“: der Batch läuft n-mal (wie in SSMS/sqlcmd)
        for (let k = 0; k < (st.repeat ?? 1); k++) list.push({ sql, line: lineAt + 1 });
      }
      await exec(list, !final || copyStart !== undefined);
      if (copyStart) {
        // Daten beginnen in der Zeile nach dem ";"
        const nl = buffer.indexOf('\n', copyStart.end);
        const dataStart = nl < 0 ? buffer.length : nl + 1;
        countLines(buffer.slice(0, dataStart));
        if (!session.copyIn) throw new Error('COPY FROM stdin wird hier nicht unterstützt.');
        copy = { target: await session.copyIn(copyStart.sql), sql: copyStart.sql };
        copyFailure = undefined;
        buffer = buffer.slice(dataStart);
        continue;
      }
      if (final) {
        buffer = '';
        return;
      }
      // letzte (evtl. unvollständige) Anweisung bleibt im Puffer
      const last = stmts.at(-1);
      if (last) {
        countLines(buffer.slice(0, last.start));
        delimiter = last.delimiter ?? delimiter;
        buffer = buffer.slice(last.start);
      }
      return;
    }
  };

  const finishCopy = async () => {
    const c = copy!;
    const fail = copyFailure;
    copy = undefined;
    copyFailure = undefined;
    try {
      if (fail !== undefined) throw fail;
      await c.target.end();
      p.statements++;
    } catch (e) {
      p.errors++;
      const msg = `bis Zeile ${p.line}: ${errorText(e)}\n  ${c.sql.slice(0, 160)}`;
      if (req.stopOnError || session.broken) throw new Error(msg);
      if (p.log.length < MAX_LOGGED_ERRORS) p.log.push(msg);
    }
  };

  const countLines = (s: string) => {
    p.line += newlines(s, 0, s.length);
  };

  const stream = source ?? createReadStream(req.file, { highWaterMark: 4 * 1024 * 1024 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (cancelled()) throw new Error('Abgebrochen.');
      p.bytes += chunk.length;
      let text = decodeChunk(decoder, chunk, true);
      if (first) {
        text = text.replace(/^﻿/, '');
        first = false;
      }
      buffer += text;
      await drain(false);
    }
    buffer += decodeChunk(decoder, undefined, false);
    await drain(true);
    if (p.warnings) {
      p.log.unshift(
        `${p.warnings} Warnung(en) des Servers beim Einspielen (z. B. gekürzte oder umgewandelte Werte) – mysqldump schaltet den strikten Modus ab; ` +
          'Details liefert SHOW WARNINGS direkt nach der betroffenen Anweisung.',
      );
    }
  } catch (e) {
    copy?.target.abort();
    throw e;
  } finally {
    stream.destroy();
  }

  /** Block dekodieren; ungültige Bytes (falsche Kodierung, Rohbytes) sind ein Fehler mit Stelle statt stiller Ersatzzeichen */
  function decodeChunk(d: TextDecoder, chunk: Buffer | undefined, stream: boolean): string {
    try {
      return chunk ? d.decode(chunk, { stream }) : d.decode();
    } catch {
      throw new Error(
        `${where(p.line + 1)}: ungültige Bytefolge für ${d.encoding.toUpperCase()} – die Datei hat eine andere Kodierung oder enthält Binärwerte als Rohbytes` +
          (dialect === 'mysql' ? ' (mysqldump: mit --hex-blob erstellen).' : '.'),
      );
    }
  }
}

function newlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = s.indexOf('\n', from); i >= 0 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/** psql-Befehle (\connect, \restrict …) vor dem eigentlichen SQL einer Anweisung entfernen (Kommentare dürfen davor stehen) */
function stripPsqlMeta(sql: string): string {
  if (!sql.includes('\\')) return sql;
  const lines = sql.split('\n');
  let i = 0;
  const keep: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^\\[A-Za-z]/.test(l)) continue;
    if (l === '' || l.startsWith('--')) {
      keep.push(lines[i]);
      continue;
    }
    break;
  }
  const out = keep.concat(lines.slice(i)).join('\n').trim();
  // nur Kommentare übrig: nichts auszuführen
  return out.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('--')) ? '' : out;
}

/** so viel vom Anfang der Datei entscheidet über Kodierung und Format */
const HEAD_BYTES = 1024 * 1024;

/** Archive und Binärformate, die kein SQL-Text sind */
const SIGNATURES: { bytes: number[]; what: string }[] = [
  { bytes: [0x1f, 0x8b], what: 'gzip-komprimiert (.gz) – bitte entpacken' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], what: 'ein ZIP-Archiv – bitte entpacken' },
  { bytes: [0x42, 0x5a, 0x68], what: 'bzip2-komprimiert – bitte entpacken' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a], what: 'xz-komprimiert – bitte entpacken' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], what: 'ein 7z-Archiv – bitte entpacken' },
  { bytes: [0x50, 0x47, 0x44, 0x4d, 0x50], what: 'ein pg_dump-Archiv (Format custom/directory) – mit pg_restore einspielen oder den Dump mit pg_dump -Fp als Text erstellen' },
];

/** Namen aus SET NAMES (MySQL) und client_encoding (PostgreSQL) → Kodierung für TextDecoder */
const CHARSETS: Record<string, string> = {
  utf8: 'utf-8',
  utf8mb3: 'utf-8',
  utf8mb4: 'utf-8',
  'utf-8': 'utf-8',
  unicode: 'utf-8',
  // SQL_ASCII: PostgreSQL legt die Bytes unverändert ab – fast immer UTF-8
  sql_ascii: 'utf-8',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  iso88591: 'windows-1252',
  iso_8859_1: 'windows-1252',
  win1252: 'windows-1252',
  cp1252: 'windows-1252',
  latin9: 'iso-8859-15',
  iso885915: 'iso-8859-15',
  latin2: 'iso-8859-2',
  iso88592: 'iso-8859-2',
  win1250: 'windows-1250',
  cp1250: 'windows-1250',
  win1251: 'windows-1251',
  cp1251: 'windows-1251',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  greek: 'iso-8859-7',
  iso88597: 'iso-8859-7',
  hebrew: 'iso-8859-8',
  iso88598: 'iso-8859-8',
  win1256: 'windows-1256',
  cp1256: 'windows-1256',
  tis620: 'windows-874',
  sjis: 'shift_jis',
  cp932: 'shift_jis',
  eucjp: 'euc-jp',
  euc_jp: 'euc-jp',
  gbk: 'gbk',
  gb2312: 'gbk',
  big5: 'big5',
  euckr: 'euc-kr',
  euc_kr: 'euc-kr',
};

/**
 * Kodierung der Datei: BOM, UTF-16 ohne BOM (SSMS), Archive (abgelehnt), die im Kopf deklarierte Kodierung
 * (SET NAMES, client_encoding), sonst UTF-8 – und falls der Anfang kein gültiges UTF-8 ist, Windows-1252 mit Hinweis.
 * Rohe Binärwerte (mysqldump ohne --hex-blob) lassen sich nicht verlustfrei lesen: Abbruch mit Hinweis.
 */
export async function inspectFile(file: string, dialect: Dialect): Promise<{ encoding: string; note?: string }> {
  const h = await fs.open(file, 'r');
  let b: Buffer;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await h.read(buf, 0, HEAD_BYTES, 0);
    b = buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
  for (const s of SIGNATURES) {
    if (b.length >= s.bytes.length && s.bytes.every((x, i) => b[i] === x)) throw new Error(`Die Datei ist ${s.what}.`);
  }
  if (b.length >= 4 && ((b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff))) {
    throw new Error('Die Datei ist UTF-32-kodiert – bitte als UTF-8 oder UTF-16 speichern.');
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf-8' };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { encoding: 'utf-16le' };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { encoding: 'utf-16be' };
  // UTF-16 ohne BOM: jedes zweite Byte 0
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return { encoding: 'utf-16le' };
  if (b.length >= 4 && b[0] === 0 && b[2] === 0 && b[1] !== 0) return { encoding: 'utf-16be' };

  // im Kopf deklarierte Kodierung (die Deklaration selbst ist ASCII)
  const ascii = b.toString('latin1');
  const declared =
    dialect === 'mysql'
      ? (/\bSET\s+NAMES\s+['"]?([A-Za-z0-9_-]+)/i.exec(ascii)?.[1] ?? /\bCHARACTER_SET_CLIENT\s*=\s*['"]?([A-Za-z][A-Za-z0-9_-]*)/i.exec(ascii)?.[1])
      : dialect === 'postgres'
        ? /\bSET\s+client_encoding\s*=\s*['"]?([A-Za-z0-9_-]+)/i.exec(ascii)?.[1]
        : undefined;
  if (declared) {
    const name = declared.toLowerCase();
    const encoding = CHARSETS[name] ?? name;
    try {
      new TextDecoder(encoding);
    } catch {
      throw new Error(`Die Datei deklariert die Kodierung „${declared}“ – die kennt OwlynDB nicht. Bitte als UTF-8 speichern.`);
    }
    if (encoding !== 'utf-8') return { encoding, note: `Kodierung laut Datei: ${declared} – sie wird als ${encoding.toUpperCase()} gelesen.` };
  }
  // UTF-8: der Anfang muss gültig sein (eine am Blockende angefangene Folge zählt nicht)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true });
    return { encoding: 'utf-8' };
  } catch {
    // kein UTF-8
  }
  if (dialect === 'mysql' && /_binary\s*'/i.test(ascii)) {
    throw new Error(
      'Die Datei enthält Binärwerte als Rohbytes (_binary \'…\') und ist deshalb kein gültiges UTF-8 – so ließe sie sich nicht verlustfrei einspielen. ' +
        'Bitte den Dump mit mysqldump --hex-blob erstellen.',
    );
  }
  return {
    encoding: 'windows-1252',
    note: 'Die Datei ist kein gültiges UTF-8 und deklariert keine Kodierung – sie wird als Windows-1252 (Latin-1, ANSI) gelesen. Umlaute im Ziel prüfen.',
  };
}
