import type { Dialect } from './api-types';
import { isConsoleRequest } from './es-console';

/** Bezeichnerzeichen (Wortgrenzen, E'…'-Präfix, $tag$-Beginn) */
const IDENT = /[A-Za-z0-9_$]/;

/**
 * Text ohne Kommentare und mit geleerten Zeichenketten/Bezeichnern in Quotes – damit Schlüsselwörter
 * in Strings ("… WHERE …") oder Kommentaren nicht mitgezählt werden.
 * - MySQL/MariaDB führen /*! … *\/ und /*M! … *\/ aus: ihr Inhalt bleibt Code.
 * - PostgreSQL: in E'…' gilt der Backslash als Escape, $tag$ nur, wenn kein Bezeichnerzeichen davorsteht.
 * - MySQL: Backslash-Escape in Zeichenketten, nicht in Backtick-Bezeichnern.
 * - Zwischen Ziffer und Buchstabe kommt ein Leerzeichen: SQL Server liest „1AS x“ als zwei Token, \b in JavaScript nicht.
 * keepIdents: Bezeichner in Quotes bleiben als Wort stehen (Funktionsprüfung: "pg_terminate_backend"(…) ist derselbe Aufruf).
 */
function codeOnly(sql: string, dialect: Dialect, keepIdents = false): string {
  if (dialect === 'mysql') sql = sql.replace(/\/\*M?!\d{0,6}/g, (m) => ' '.repeat(m.length));
  let out = '';
  const n = sql.length;
  for (let i = 0; i < n; ) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-' && (dialect !== 'mysql' || /\s/.test(sql[i + 2] ?? ' '))) {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth = dialect === 'mysql' ? 1 : depth + 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2;
          if (--depth <= 0) break;
        } else i++;
      }
      out += ' ';
      continue;
    }
    const close = c === "'" || c === '"' ? c : c === '`' && dialect === 'mysql' ? '`' : c === '[' && dialect === 'mssql' ? ']' : null;
    if (close) {
      const isIdent = c === '`' || c === '[' || (c === '"' && dialect !== 'mysql');
      const backslash =
        (dialect === 'mysql' && c !== '`') || (dialect === 'postgres' && c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !IDENT.test(sql[i - 2] ?? ''));
      const from = i + 1;
      i++;
      while (i < n) {
        if (backslash && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const inner = sql.slice(from, Math.max(from, i - 1));
      out += keepIdents && isIdent ? ' ' + inner.replace(/[^A-Za-z0-9_$]/g, '_') + ' ' : ' x ';
      continue;
    }
    if (c === '$' && dialect === 'postgres' && !IDENT.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
        out += ' x ';
        continue;
      }
    }
    if (/[A-Za-z]/.test(c) && /\d/.test(out[out.length - 1] ?? '')) out += ' ';
    out += c;
    i++;
  }
  return out;
}

/** Wörter (auch @x, #t), Zahlen und einzelne Zeichen des geleerten Textes */
const TOKENS = /[A-Z_@#$][A-Z0-9_@#$.]*|\d[\d.]*|\S/g;

/** Liste auf oberster Klammerebene am Komma teilen */
function topLevelSplit(code: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth <= 0) {
      parts.push(code.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(code.slice(from));
  return parts;
}

const START_WORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE']);
/**
 * davor ist UPDATE/DELETE keine Anweisung: ON UPDATE CASCADE, FOR UPDATE, ON DUPLICATE KEY UPDATE, ON CONFLICT DO UPDATE,
 * WHEN MATCHED THEN UPDATE, GRANT UPDATE, BEFORE INSERT OR UPDATE, INSTEAD OF DELETE
 */
const NOT_STATEMENT_BEFORE = new Set(['ON', 'FOR', 'OF', 'INSTEAD', 'AFTER', 'BEFORE', 'KEY', 'DO', 'THEN', 'GRANT', 'REVOKE', 'OR', ',']);

/**
 * Anweisungen, vor deren Ausführung nachgefragt werden soll. Rückgabe: Beschreibungen, leer = unbedenklich.
 * Nur eine Heuristik als Sicherheitsnetz gegen Versehen – keine Garantie.
 */
export function riskyStatements(statements: string[], dialect: Dialect): string[] {
  const found: string[] = [];
  for (const sql of statements) {
    const code = codeOnly(sql, dialect).toUpperCase();
    const short = sql.replace(/\s+/g, ' ').trim().slice(0, 90);
    // Token mit Klammertiefe: Anweisungen beginnen nur auf Tiefe 0 (SQL Server: mehrere Anweisungen ohne ";" in einem Batch)
    const tokens: { t: string; depth: number }[] = [];
    let depth = 0;
    for (const m of code.matchAll(TOKENS)) {
      const t = m[0];
      if (t === ')') depth = Math.max(0, depth - 1);
      tokens.push({ t, depth });
      if (t === '(') depth++;
    }
    const starts: { kw: string; at: number }[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const { t, depth: d } = tokens[k];
      if (d !== 0 || !START_WORDS.has(t)) continue;
      const prev = tokens[k - 1]?.t ?? '';
      if ((t === 'UPDATE' || t === 'DELETE') && NOT_STATEMENT_BEFORE.has(prev)) continue;
      // TRUNCATE(x, d) ist bei MySQL eine Funktion
      if (t === 'TRUNCATE' && tokens[k + 1]?.t === '(') continue;
      starts.push({ kw: t, at: k });
    }
    starts.forEach((s, k) => {
      const end = starts[k + 1]?.at ?? tokens.length;
      if (s.kw === 'DELETE' || s.kw === 'UPDATE') {
        // WHERE der Anweisung selbst (nicht einer Unterabfrage in Klammern)
        const hasWhere = tokens.slice(s.at, end).some((x) => x.depth === 0 && x.t === 'WHERE');
        if (!hasWhere) found.push(`${s.kw} ohne WHERE: ${short}`);
      } else if (s.kw === 'DROP') {
        found.push(`DROP: ${short}`);
      } else if (s.kw === 'TRUNCATE') {
        found.push(`TRUNCATE: ${short}`);
      }
    });
  }
  return [...new Set(found)];
}

/**
 * SQL Server, Strg+Enter: ohne ";" oder GO gehören mehrere Zeilen zu einer Anweisung. Wenn darin mehr als eine
 * Anweisung steckt und eine davon schreibt, soll die Oberfläche nachfragen. Zeilen in offenen Klammern und ein SELECT
 * als Teil der vorigen Anweisung (INSERT … SELECT, CREATE VIEW … AS, UNION) zählen nicht als eigene Anweisung.
 */
export function batchHasSeveralStatements(sql: string, dialect: Dialect): boolean {
  if (dialect !== 'mssql') return false;
  const code = codeOnly(sql, dialect).toUpperCase();
  const lineStarts: string[] = [];
  let depth = 0;
  let prev = '';
  for (const raw of code.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const start = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE)\b/.exec(l)?.[1];
    const continued = /\b(AS|UNION|ALL|EXCEPT|INTERSECT)\s*$|\($/.test(prev) || (/^INSERT\b/.test(prev) && !/\bVALUES\b/.test(prev));
    if (depth === 0 && start && !(start === 'SELECT' && continued)) lineStarts.push(start);
    for (const c of l) {
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
    }
    prev = l;
  }
  return lineStarts.length > 1 && lineStarts.some((l) => l !== 'SELECT');
}

/**
 * Export über „max. Zeilen“ hinaus: die Anweisung läuft dafür noch einmal – nur, wenn sie nur liest. Rückgabe: Grund,
 * warum nicht, oder null.
 */
export function rerunBlocker(sql: string, dialect: Dialect): string | null {
  if (dialect === 'elasticsearch') {
    return isConsoleRequest(sql) ? 'Bei Konsolen-Anfragen bestimmt "size" im Such-Body, wie viele Treffer kommen – erneut ausführen lässt sich nur SQL.' : null;
  }
  return readOnlyViolation(sql, dialect)
    ? 'Für den vollständigen Export liefe die Anweisung noch einmal – das geht nur bei Anweisungen, die nur lesen (SELECT …).'
    : null;
}

/** vor „SELECT“: zweiter Teil einer Mengenoperation, keine eigene Ergebnismenge */
const SET_OPERATION = new Set(['UNION', 'ALL', 'EXCEPT', 'INTERSECT']);
/** SELECT @x = … weist nur zu und liefert keine Ergebnismenge (auch TOP/DISTINCT davor, auch +=, -= …) */
const ASSIGNING_SELECT = /^\s*(?:ALL\s+|DISTINCT\s+)?(?:TOP\s*(?:\([^)]*\)|\d+)\s*(?:PERCENT\s+)?(?:WITH\s+TIES\s+)?)?@[A-Z0-9_@#$]+\s*[-+*/%&|^]?=/;
/** Wörter, Variablen (SQL Server trennt „SELECT@x“ in zwei), Zahlen, einzelne Zeichen */
const TOKEN = /[A-Z_][A-Z0-9_$]*|[@#]+[A-Z0-9_@#$]*|\d[\d.]*|\S/g;
/** davor steht „(SELECT“ als Unterabfrage bzw. abgeleitete Tabelle – sonst könnte es eine eigene Anweisung sein */
const SUBQUERY_AFTER = new Set([
  ...['FROM', 'JOIN', 'APPLY', 'IN', 'EXISTS', 'AS', 'ON', 'WHERE', 'AND', 'OR', 'NOT', 'SELECT', 'WHEN', 'THEN', 'ELSE', 'CASE'],
  ...['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'ANY', 'SOME', 'IF', 'RETURN', 'PRINT', 'BY', 'HAVING', 'DISTINCT', 'TOP', 'LIKE', 'BETWEEN', 'IS'],
  ...['=', '<', '>', '+', '-', '*', '/', '%', ',', '(', '!', '&', '|', '^', '~'],
]);
/** Anweisungen, die nach der letzten Abfrage noch etwas täten (Meldung, Fehler, Warten, Zuweisung …) */
const AFTER_LAST = new Set(['SET', 'DECLARE', 'PRINT', 'RAISERROR', 'THROW', 'IF', 'ELSE', 'BEGIN', 'RETURN', 'WAITFOR', 'USE', 'BREAK', 'CONTINUE', 'OPEN', 'CLOSE', 'DEALLOCATE', 'EXEC', 'EXECUTE']);

/**
 * SQL Server: Darf das Lesen nach „max. Zeilen“ abgebrochen werden? Ein Abbruch beendet den ganzen Batch – das geht nur
 * in seiner letzten Ergebnismenge und nur, wenn danach keine Anweisung mehr folgt. Rückgabe: so viele Ergebnismengen
 * liefert der Batch, die letzte davon darf abgebrochen werden; 0 = nicht abbrechen.
 * Nur lesende Batches; keine Schleifen, Sprünge und Cursor (sonst kämen mehr Ergebnisse, als im Text stehen). Mit IF/ELSE
 * kommen womöglich weniger – dann wird die Zahl nie erreicht und nichts abgebrochen. UNION & Co., Unterabfragen und
 * SELECT @x = … zählen nicht als eigene Ergebnismenge.
 */
export function stoppableResults(sql: string): number {
  if (readOnlyViolation(sql, 'mssql')) return 0;
  const code = codeOnly(sql, 'mssql').toUpperCase();
  // FETCH auch in OFFSET … ROWS FETCH NEXT … ROWS ONLY – das ist kein Cursor
  if (/\b(WHILE|GOTO|CURSOR|READTEXT)\b/.test(code) || /(?<!\bROWS?\s+)\bFETCH\b/.test(code)) return 0;
  let depth = 0;
  let cases = 0;
  let sets = 0;
  let quiet = true;
  let prev = '';
  for (const m of code.matchAll(TOKEN)) {
    const t = m[0];
    const at = m.index ?? 0;
    if (t === '(') {
      // (SELECT …) als eigene Anweisung lieferte eine Ergebnismenge, die hier nicht mitgezählt würde
      if (depth === 0 && /^[\s(]*SELECT\b/.test(code.slice(at + 1)) && !SUBQUERY_AFTER.has(prev)) return 0;
      depth++;
    } else if (t === ')') depth--;
    else if (depth <= 0) {
      if (t === 'CASE') cases++;
      else if (t === 'END' && cases > 0) cases--;
      else if (t === 'SELECT' && !SET_OPERATION.has(prev)) {
        // SELECT @x = … liefert nichts, täte nach der letzten Abfrage aber noch etwas
        if (!ASSIGNING_SELECT.test(code.slice(at + 6))) {
          sets++;
          quiet = true;
        } else if (sets) quiet = false;
      } else if (sets && AFTER_LAST.has(t) && !(t === 'ELSE' && cases > 0)) quiet = false;
    }
    prev = t;
  }
  return quiet ? sets : 0;
}

/** Nur-lesen-Modus: womit eine Anweisung beginnen darf */
const READ_START: Record<Dialect, RegExp> = {
  mysql: /^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC|USE|TABLE|VALUES|SET\s+@(?!@))\b/,
  postgres: /^(SELECT|WITH|SHOW|EXPLAIN|TABLE|VALUES)\b/,
  mssql: /^(SELECT|WITH|USE|DECLARE|SET\s+@(?!@))\b/,
  // SQL von Elasticsearch kann ohnehin nur lesen
  elasticsearch: /^(SELECT|WITH|SHOW|DESCRIBE|DESC|SYS)\b/,
};

/**
 * Was innerhalb einer erlaubten Anweisung noch schreiben oder sperren kann. MySQL/PostgreSQL: eine Anweisung
 * (Abfragen werden an ";" geteilt) – also nur Teile davon wie WITH … DELETE, SELECT … INTO, FOR UPDATE.
 * SQL Server: ein Batch kann ohne ";" weitere Anweisungen enthalten, deshalb die vollständige Liste; dazu die Sperrhinweise,
 * die Sperren bis zum Ende der Transaktion halten (wie FOR UPDATE bzw. FOR SHARE bei MySQL und PostgreSQL).
 */
const WRITE_WORDS: Record<Dialect, RegExp> = {
  mysql: /\b(INSERT|UPDATE|DELETE|REPLACE\s+INTO|INTO|LOCK\s+IN\s+SHARE|FOR\s+SHARE)\b/,
  postgres: /\b(INSERT|UPDATE|DELETE|MERGE|INTO|FOR\s+(SHARE|NO\s+KEY|KEY\s+SHARE))\b/,
  mssql:
    /\b(INSERT|UPDATE|DELETE|MERGE|INTO|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|COMMIT|ROLLBACK|KILL|SHUTDOWN|BACKUP|RESTORE|DBCC|BULK|RECONFIGURE|OPENROWSET|OPENDATASOURCE|OPENQUERY|CHECKPOINT|UPDATETEXT|WRITETEXT|BEGIN\s+(TRAN|TRANSACTION|DISTRIBUTED)|SAVE\s+(TRAN|TRANSACTION)|(EN|DIS)ABLE\s+TRIGGER|SEND\s+ON|RECEIVE|UPDLOCK|XLOCK|TABLOCKX|HOLDLOCK|SERIALIZABLE|REPEATABLEREAD)\b/,
  elasticsearch: /\b(INSERT|UPDATE|DELETE|INTO)\b/,
};

/**
 * Funktionen mit Nebenwirkung, die keine Transaktion zurückholt (Sequenzen, Sperren, andere Sitzungen, Dateien,
 * Statistiken, Replikation, Sicherung)
 */
const SIDE_EFFECT_FUNCTIONS =
  /\b(PG_(TERMINATE|CANCEL|RELOAD|ROTATE|SWITCH|PROMOTE|CREATE|DROP|FILE|ADVISORY|TRY_ADVISORY|REPLICATION|NOTIFY|LOG|STAT_RESET|BACKUP|START_BACKUP|STOP_BACKUP|LOGICAL|IMPORT|COPY|WAL_REPLAY|XLOG_REPLAY|CATALOG\.PG_(TERMINATE|CANCEL|RELOAD|ADVISORY|TRY_ADVISORY|STAT_RESET))\w*|BRIN_SUMMARIZE\w*|BRIN_DESUMMARIZE\w*|GIN_CLEAN_PENDING_LIST|SET_CONFIG|NEXTVAL|SETVAL|LO_\w+|DBLINK\w*|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS)\s*\(|\bNEXT\s+VALUE\s+FOR\b/;

/**
 * Nur-lesen-Modus: Grund, warum die Anweisung nicht laufen darf, oder null.
 * Erste Schicht vor dem Senden; zusätzlich läuft jede Ausführung in einer Transaktion, die zurückgerollt wird.
 */
export function readOnlyViolation(sql: string, dialect: Dialect): string | null {
  const code = codeOnly(sql, dialect).toUpperCase().trim().replace(/^[(\s]+/, '');
  if (!code || /^;*$/.test(code)) return null;
  const allowed =
    dialect === 'mysql' ? 'SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, USE' : dialect === 'postgres' ? 'SELECT, WITH, SHOW, EXPLAIN, TABLE, VALUES' : 'SELECT, WITH, USE, DECLARE';
  if (!READ_START[dialect].test(code)) return `Nur lesen: erlaubt sind ${allowed} – „${code.split(/\s/)[0]}“ nicht.`;
  const setError = 'Nur lesen: SET ist nur für eigene Variablen erlaubt (SET @name = …).';
  // SET am Anfang: jede Zuweisung der Liste muss eine eigene Variable sein (SET @a = 1, GLOBAL x = 1 mischt)
  if (/^SET\b/.test(code)) {
    for (const part of topLevelSplit(code.replace(/^SET\s*/, '').replace(/;\s*$/, ''))) {
      if (!/^@[A-Z0-9_.$]+\s*:?=/.test(part.trim())) return setError;
    }
  }
  // weitere SET (SQL Server: mehrere Anweisungen in einem Batch) nur für eigene Variablen; CHARACTER SET ist keins
  for (const m of code.matchAll(/\b(CHARACTER\s+)?SET\b(\s*@?@?)/g)) {
    if (m[1] || m.index === 0) continue;
    if (m[2].trim() !== '@') return setError;
  }
  // MySQL/PostgreSQL: genau eine Anweisung (PostgreSQL würde mehrere in einem Aufruf ausführen); „;;“ am Ende ist keine zweite
  if (dialect !== 'mssql' && code.replace(/[;\s]+$/, '').includes(';')) return 'Nur lesen: bitte eine Anweisung pro Abschnitt (durch ; getrennt).';
  const w = WRITE_WORDS[dialect].exec(code);
  if (w) return `Nur lesen: „${w[1].replace(/\s+/g, ' ')}“ ist in diesem Modus nicht erlaubt.`;
  // Funktionen auch in Anführungszeichen erkennen ("pg_terminate_backend"(…) ist derselbe Aufruf)
  const f = SIDE_EFFECT_FUNCTIONS.exec(codeOnly(sql, dialect, true).toUpperCase());
  if (f) return `Nur lesen: „${f[0].replace(/\s*\($/, '').toLowerCase()}“ hat Nebenwirkungen und ist in diesem Modus nicht erlaubt.`;
  return null;
}
