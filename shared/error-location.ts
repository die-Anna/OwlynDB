import type { Dialect } from './api-types';

/** Stelle in einer Anweisung: Anfang und Ende (exklusiv) als Zeichenposition */
export type ErrorRange = [number, number];

export interface ErrorHints {
  /** PostgreSQL: Zeichen (ab 1) im gesendeten Text */
  position?: number;
  /** Zeile (ab 1) in der Anweisung – SQL Server je Fehler; MySQL steht sie in der Meldung („at line 3“) */
  line?: number;
}

/** Meldungen mit dem Namen bzw. der Stelle des Fehlers; near = Text ab der Fehlerstelle (markiert wird sein erstes Wort) */
const PATTERNS: { re: RegExp; near?: boolean }[] = [
  // SQL Server
  { re: /Invalid (?:column|object) name '([^']+)'/i },
  { re: /Ambiguous column name '([^']+)'/i },
  { re: /The multi-part identifier "([^"]+)" could not be bound/i },
  { re: /Must declare the (?:scalar|table) variable "([^"]+)"/i },
  { re: /Could not find stored procedure '([^']+)'/i },
  { re: /'([^']+)' is not a recognized built-in function name/i },
  { re: /Incorrect syntax near (?:the keyword )?'([^']*)'/i, near: true },
  // MySQL / MariaDB
  { re: /Unknown column '([^']+)'/i },
  { re: /Column '([^']+)' in [\w ]+ is ambiguous/i },
  { re: /Table '([^']+)' doesn't exist/i },
  { re: /Unknown table '([^']+)'/i },
  { re: /FUNCTION ([\w$.]+) does not exist/i },
  { re: /near '([\s\S]*?)' at line \d+/i, near: true },
  // PostgreSQL ohne Positionsangabe
  { re: /(?:column|relation|function|table|schema|type) "([^"]+)" does not exist/i },
  { re: /column reference "([^"]+)" is ambiguous/i },
  { re: /syntax error at or near "([^"]*)"/i, near: true },
];

const WORD = /[\w$#@]/;

/**
 * Wo in der Anweisung liegt der Fehler? Für die Markierung im Editor statt der ganzen Anweisung: die Stelle laut Server
 * (PostgreSQL), sonst der Name aus der Meldung – in der gemeldeten Zeile, wenn er dort steht, sonst überall in der
 * Anweisung –, sonst die gemeldete Zeile. Leer, wenn sich nichts finden lässt. Namen in Kommentaren und Zeichenketten
 * zählen nicht.
 */
export function errorRanges(dialect: Dialect, sql: string, message: string, hints: ErrorHints = {}): ErrorRange[] {
  if (!sql) return [];
  if (hints.position !== undefined && hints.position >= 1 && hints.position <= sql.length + 1) return [tokenAt(sql, hints.position - 1)];
  const line = hints.line ?? (dialect === 'mysql' ? Number(/at line (\d+)/i.exec(message)?.[1]) || undefined : undefined);
  const span = line ? lineSpan(sql, line) : null;
  const masked = mask(dialect, sql);
  for (const { re, near } of PATTERNS) {
    const m = re.exec(message);
    if (!m) continue;
    if (near) {
      const r = nearRange(sql, masked, m[1], span);
      if (r) return [r];
      continue;
    }
    // qualifizierte Namen (dbo.kunden, t.spalte): erst so, wie sie dastehen, dann nur der letzte Teil
    const parts = m[1].split('.');
    for (const name of [...new Set([m[1], parts[parts.length - 1]])]) {
      const hits = findName(masked, name);
      if (!hits.length) continue;
      const here = span ? hits.filter(([a]) => a >= span[0] && a <= span[1]) : [];
      return here.length ? here : hits;
    }
  }
  return span ? [trimSpan(sql, span)] : [];
}

/** Kommentare und Zeichenketten mit Leerzeichen überdecken – die Stellen bleiben gleich */
function mask(dialect: Dialect, sql: string): string {
  const out = sql.split('');
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if ((c === '-' && n === '-') || (dialect === 'mysql' && c === '#')) {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? sql.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (dialect === 'mysql' && sql[j] === '\\') j++;
        else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j++;
          else break;
        }
      }
      blank(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

/** alle Stellen des Namens als eigenes Wort (auch in [ ], " " oder ` `), ohne Groß-/Kleinschreibung */
function findName(masked: string, name: string): ErrorRange[] {
  if (!name) return [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$#@])${esc}(?![\\w$#@])`, 'gi');
  const out: ErrorRange[] = [];
  for (const m of masked.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Text ab der Fehlerstelle („near …“): sein erstes Wort, in der gemeldeten Zeile zuerst; leer = Ende (letztes Wort) */
function nearRange(sql: string, masked: string, near: string, span: [number, number] | null): ErrorRange | null {
  const head = near.split('\n')[0].trim().slice(0, 40);
  if (!head) return lastToken(sql, span ? span[1] : sql.length);
  const from = span ? sql.indexOf(head, span[0]) : -1;
  const at = from >= 0 && (!span || from <= span[1]) ? from : sql.indexOf(head);
  if (at < 0 || masked[at] === ' ') return null;
  return tokenAt(sql, at);
}

/** letztes Wort vor dieser Stelle (Fehler „am Ende der Eingabe“), sonst das letzte Zeichen */
function lastToken(sql: string, end: number): ErrorRange {
  let e = end;
  while (e > 0 && /\s/.test(sql[e - 1])) e--;
  let a = e;
  while (a > 0 && WORD.test(sql[a - 1])) a--;
  return a < e ? [a, e] : [Math.max(0, e - 1), Math.max(1, e)];
}

/** Wort bzw. Name in Anführungszeichen ab dieser Stelle; am Ende der Anweisung das letzte Wort */
function tokenAt(sql: string, at: number): ErrorRange {
  if (at >= sql.length) return lastToken(sql, sql.length);
  const open = sql[at];
  const close = open === '[' ? ']' : open === '"' || open === '`' ? open : null;
  if (close) {
    const e = sql.indexOf(close, at + 1);
    return [at, e < 0 ? sql.length : e + 1];
  }
  let e = at;
  while (e < sql.length && WORD.test(sql[e])) e++;
  return [at, e > at ? e : at + 1];
}

/** Anfang und Ende (ohne Zeilenumbruch) der Zeile (ab 1); null, wenn es sie nicht gibt */
function lineSpan(sql: string, line: number): [number, number] | null {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const n = sql.indexOf('\n', start);
    if (n < 0) return null;
    start = n + 1;
  }
  const e = sql.indexOf('\n', start);
  return [start, e < 0 ? sql.length : e];
}

/** Zeile ohne Einrückung und Leerraum am Ende */
function trimSpan(sql: string, [a, b]: [number, number]): ErrorRange {
  while (a < b && /\s/.test(sql[a])) a++;
  while (b > a && /\s/.test(sql[b - 1])) b--;
  return [a, b];
}
