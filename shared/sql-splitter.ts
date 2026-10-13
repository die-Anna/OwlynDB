import type { Dialect } from './api-types';

export interface SplitStatement {
  sql: string;
  /** Offset des ersten Zeichens der Anweisung im Gesamttext */
  start: number;
  /** Offset hinter dem letzten Zeichen (ohne Trennzeichen) */
  end: number;
  /** MySQL: Trennzeichen, das für diese Anweisung galt (DELIMITER) */
  delimiter?: string;
  /** SQL Server: „GO n“ – der Batch soll n-mal laufen (steht an jeder seiner Anweisungen) */
  repeat?: number;
  /** SQL Server: Nummer des Batches (Anweisungen bis zum nächsten GO); „GO n“ wiederholt ihn als Ganzes */
  batch?: number;
}

/** Bezeichnerzeichen (E'…'-Präfix, $tag$-Beginn) */
const IDENT = /[A-Za-z0-9_$]/;
/** SQL Server: GO auf eigener Zeile, mit Wiederholungszahl und Kommentar dahinter wie in SSMS/sqlcmd */
const GO_LINE = /^GO(?:\s+(\d+))?\s*(?:--.*|\/\*.*\*\/\s*)?$/i;

/**
 * Zerlegt ein Skript in einzelne Anweisungen.
 *
 * - Zeichenketten, Bezeichner in Quotes und Kommentare werden übersprungen.
 * - MySQL: `DELIMITER xx` wie im mysql-Client; Backslash-Escape in Zeichenketten, nicht in Backticks.
 * - PostgreSQL: Dollar-Quoting ($$ … $$, $tag$ … $tag$), E'…' mit Backslash; `;` trennt nicht in Klammern und
 *   nicht in BEGIN ATOMIC … END (SQL-Funktionen ab PostgreSQL 14).
 * - SQL Server: `GO` auf eigener Zeile trennt immer (auch mit Kommentar, `GO n` = n-mal); `;` trennt nur außerhalb von
 *   BEGIN…END/CASE…END und nicht in CREATE/ALTER PROCEDURE|FUNCTION|TRIGGER|VIEW
 *   (mit mssqlGoOnly gar nicht: ein Batch bis zum nächsten GO, wie in SSMS).
 */
export function splitSql(text: string, dialect: Dialect, initialDelimiter = ';', mssqlGoOnly = false): SplitStatement[] {
  const out: SplitStatement[] = [];
  const n = text.length;
  let delimiter = initialDelimiter;
  // nur Leerraum seit dem letzten Zeilenumbruch? (inkrementell – lange Zeilen wie in Dumps blieben sonst quadratisch)
  let lineClean = true;
  let stmtStart = 0;
  let i = 0;
  // SQL Server und PostgreSQL: Blöcke (BEGIN…END, CASE…END) und Klammern, in denen ";" nicht trennt
  let blockDepth = 0;
  let parenDepth = 0;
  let noSemicolonSplit = false;
  let atStatementStart = true;
  /** PostgreSQL: zuletzt gesehenes Wort (BEGIN ATOMIC erkennen) */
  let prevWord = '';
  /** SQL Server: laufende Nummer des Batches */
  let batch = 0;

  const push = (endExclusive: number, repeat?: number) => {
    const raw = text.slice(stmtStart, endExclusive);
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    if (sql && !isOnlyComments(sql, dialect)) {
      out.push({
        sql,
        start: stmtStart + lead,
        end: stmtStart + lead + sql.length,
        ...(dialect === 'mysql' ? { delimiter } : {}),
        ...(dialect === 'mssql' ? { batch } : {}),
        ...(repeat && repeat > 1 ? { repeat } : {}),
      });
    }
    blockDepth = 0;
    parenDepth = 0;
    noSemicolonSplit = false;
    atStatementStart = true;
    prevWord = '';
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') {
      lineClean = true;
      i++;
      continue;
    }
    // erstes Zeichen einer Zeile: DELIMITER (MySQL) bzw. GO (SQL Server)
    if (lineClean && !/\s/.test(c)) {
      const lineEnd = indexOrEnd(text, '\n', i);
      const line = text.slice(i, lineEnd).replace(/\r$/, '');
      if (dialect === 'mysql') {
        const m = /^DELIMITER\s+(\S+)\s*$/i.exec(line);
        if (m) {
          push(i);
          delimiter = m[1];
          i = lineEnd;
          stmtStart = i;
          continue;
        }
      }
      if (dialect === 'mssql') {
        const m = GO_LINE.exec(line);
        if (m) {
          const n = m[1] ? Number(m[1]) : undefined;
          push(i, n);
          // ohne mssqlGoOnly kann der Batch aus mehreren Anweisungen bestehen (an „;“ geteilt): alle bekommen die Zahl,
          // auch wenn nach dem letzten „;“ nichts mehr kam
          if (n && n > 1) for (let k = out.length - 1; k >= 0 && out[k].batch === batch; k--) out[k].repeat = n;
          batch++;
          i = lineEnd;
          stmtStart = i;
          continue;
        }
      }
    }
    if (!/\s/.test(c)) lineClean = false;

    // Kommentare
    // MySQL: "--" ist nur mit folgendem Leerraum ein Kommentar ("5--3" ist eine Rechnung)
    if (c === '-' && next === '-' && (dialect !== 'mysql' || /\s/.test(text[i + 2] ?? ' '))) {
      i = indexOrEnd(text, '\n', i);
      continue;
    }
    if (c === '#' && dialect === 'mysql') {
      i = indexOrEnd(text, '\n', i);
      continue;
    }
    if (c === '/' && next === '*') {
      i = skipBlockComment(text, i, dialect !== 'mysql');
      continue;
    }

    // Zeichenketten und Bezeichner
    if (c === "'" || c === '"' || (c === '`' && dialect === 'mysql')) {
      // E'…' nur, wenn das E allein steht (sonst wäre „name'…'“ ein E-String)
      const eString = c === "'" && dialect === 'postgres' && /[eE]/.test(text[i - 1] ?? '') && !IDENT.test(text[i - 2] ?? '');
      const backslash = (dialect === 'mysql' && c !== '`') || eString;
      i = skipQuoted(text, i, c, backslash);
      atStatementStart = false;
      continue;
    }
    if (c === '[' && dialect === 'mssql') {
      i = skipQuoted(text, i, ']', false);
      atStatementStart = false;
      continue;
    }
    if (c === '$' && dialect === 'postgres' && !IDENT.test(text[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = text.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        atStatementStart = false;
        continue;
      }
    }

    // Trennzeichen (SQL Server beim Einspielen: nur GO trennt, wie in SSMS – sonst gingen Variablen verloren)
    if (text.startsWith(delimiter, i) && !(dialect === 'mssql' && mssqlGoOnly)) {
      const splitHere =
        dialect === 'mssql' ? blockDepth <= 0 && !noSemicolonSplit : dialect === 'postgres' ? blockDepth <= 0 && parenDepth <= 0 : true;
      if (splitHere) {
        push(i);
        i += delimiter.length;
        stmtStart = i;
        continue;
      }
      i += delimiter.length;
      continue;
    }

    if (dialect === 'postgres') {
      if (c === '(') parenDepth++;
      else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    }

    // Schlüsselwörter (SQL Server: Blöcke und Routinen; PostgreSQL: BEGIN ATOMIC … END)
    if ((dialect === 'mssql' || dialect === 'postgres') && /[A-Za-z_]/.test(c) && !/[A-Za-z0-9_@#$]/.test(text[i - 1] ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 40))!;
      const word = m[0].toUpperCase();
      if (dialect === 'mssql') {
        if (atStatementStart && (word === 'CREATE' || word === 'ALTER')) {
          const head = text.slice(i, i + 120).toUpperCase().replace(/\s+/g, ' ');
          if (/^(CREATE|ALTER)( OR ALTER)? (PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\b/.test(head)) {
            noSemicolonSplit = true;
          }
        }
        if (word === 'BEGIN') {
          const after = text.slice(i + 5, i + 40).toUpperCase();
          if (!/^\s+(TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b/.test(after) && !/^\s*;/.test(after)) {
            blockDepth++;
          }
        } else if (word === 'CASE') {
          blockDepth++;
        } else if (word === 'END') {
          blockDepth = Math.max(0, blockDepth - 1);
        }
      } else {
        // PostgreSQL: nur BEGIN ATOMIC öffnet einen Block (BEGIN allein ist der Transaktionsbeginn), CASE…END darin zählt mit
        if (word === 'ATOMIC' && prevWord === 'BEGIN') blockDepth++;
        else if (blockDepth > 0 && word === 'CASE') blockDepth++;
        else if (blockDepth > 0 && word === 'END') blockDepth--;
        prevWord = word;
      }
      atStatementStart = false;
      i += word.length;
      continue;
    }

    if (!/\s/.test(c)) atStatementStart = false;
    i++;
  }
  push(n);
  return out;
}

/** Anweisung unter dem Cursor; steht der Cursor dahinter auf derselben Zeile, zählt die vorherige. */
export function statementAt(statements: SplitStatement[], text: string, offset: number): SplitStatement | undefined {
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) return s;
  }
  // Cursor hinter dem Semikolon oder in einer Leerzeile: nächstgelegene Anweisung davor auf derselben Zeile
  let best: SplitStatement | undefined;
  for (const s of statements) {
    if (s.end <= offset) {
      const between = text.slice(s.end, offset);
      if (!between.includes('\n')) best = s;
    }
  }
  // Cursor auf einer Leerzeile: nichts ausführen (früher lief hier die nächste Anweisung – womöglich ein DELETE)
  return best;
}

/** Blockkommentar überspringen; PostgreSQL und SQL Server erlauben Verschachtelung */
function skipBlockComment(text: string, i: number, nested: boolean): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    if (text[j] === '/' && text[j + 1] === '*') {
      depth = nested ? depth + 1 : 1;
      j += 2;
    } else if (text[j] === '*' && text[j + 1] === '/') {
      j += 2;
      if (--depth <= 0) return j;
    } else j++;
  }
  return text.length;
}

function indexOrEnd(text: string, needle: string, from: number): number {
  const e = text.indexOf(needle, from);
  return e < 0 ? text.length : e;
}

function skipQuoted(text: string, i: number, close: string, backslash: boolean): number {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const ch = text[j];
    if (backslash && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === close) {
      // verdoppeltes Quote-Zeichen = Escape
      if (text[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/** MySQL/MariaDB führen /*! … *\/ bzw. /*M! … *\/ aus (mysqldump: SET FOREIGN_KEY_CHECKS=0, mariadb-dump: SET NOTE_VERBOSITY …) */
const EXECUTABLE_COMMENT = /^\/\*M?!/;

/**
 * Stelle des ersten Zeichens, das weder Kommentar noch Leerraum ist (sql.length = nur Kommentare). PostgreSQL und
 * SQL Server verschachteln Blockkommentare; keepExecutable: MySQL-/*! … *\/ und /*M! … *\/ zählen als Code.
 */
function codeStart(sql: string, dialect: Dialect, keepExecutable: boolean): number {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) i++;
    else if (c === '-' && sql[i + 1] === '-' && (dialect !== 'mysql' || /\s/.test(sql[i + 2] ?? ' '))) i = indexOrEnd(sql, '\n', i);
    else if (c === '#' && dialect === 'mysql') i = indexOrEnd(sql, '\n', i);
    else if (c === '/' && sql[i + 1] === '*') {
      if (keepExecutable && dialect === 'mysql' && EXECUTABLE_COMMENT.test(sql.slice(i, i + 4))) break;
      i = skipBlockComment(sql, i, dialect !== 'mysql');
    } else break;
  }
  return i;
}

/**
 * Anweisung ohne Kommentare und Leerraum davor – verschachtelte Blockkommentare ganz (ein regulärer Ausdruck endete am
 * ersten „*\/“ und ließe „*\/ SELECT …“ stehen). keepExecutable = false: auch MySQL-/*! … *\/ fällt weg (zum Erkennen der Art).
 */
export function withoutLeadingComments(sql: string, dialect: Dialect, keepExecutable = true): string {
  return sql.slice(codeStart(sql, dialect, keepExecutable));
}

/** nur Kommentare und Leerraum? (ohne Zeichenkette aufzubauen – bei großen Dumps kostete das Sekunden und viel Speicher) */
function isOnlyComments(sql: string, dialect: Dialect): boolean {
  return codeStart(sql, dialect, true) >= sql.length;
}
