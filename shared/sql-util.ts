import type { Cell, Dialect, ObjectRef, TableInfo } from './api-types';

export function quoteIdent(dialect: Dialect, name: string): string {
  switch (dialect) {
    case 'mysql':
      return '`' + name.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + name.replace(/]/g, ']]') + ']';
    case 'postgres':
      return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name) ? name : '"' + name.replace(/"/g, '""') + '"';
    case 'elasticsearch':
      // SQL von Elasticsearch: Index- und Feldnamen mit - . usw. nur in Anführungszeichen
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

/** Name, wie man ihn in einer Abfrage auf der aktuellen Datenbank schreibt */
/**
 * Muss eine Tabelle aus der Vervollständigung mit Schema eingesetzt werden? Ohne Schema sucht der Server nur im Suchpfad
 * (CompletionInfo.searchPath) und nimmt das erste Schema darin, das eine Tabelle dieses Namens hat – eine Tabelle in einem
 * anderen Schema fände er nicht („Invalid object name“) oder eine gleichnamige weiter vorn. Ohne Suchpfad (älterer Stand):
 * SQL Server dbo, PostgreSQL public. Namen vergleicht SQL Server meist ohne Groß-/Kleinschreibung, PostgreSQL genau.
 */
export function needsSchema(
  dialect: Dialect,
  t: { schema: string; name: string },
  all: readonly { schema: string; name: string }[],
  searchPath?: readonly string[],
): boolean {
  if (!t.schema || dialect === 'mysql' || dialect === 'elasticsearch') return false;
  const path = searchPath ?? (dialect === 'mssql' ? ['dbo'] : ['public']);
  const norm = (s: string) => (dialect === 'mssql' ? s.toLowerCase() : s);
  const at = (schema: string) => path.findIndex((p) => norm(p) === norm(schema));
  const mine = at(t.schema);
  if (mine < 0) return true;
  // eine gleichnamige Tabelle in einem Schema weiter vorn im Suchpfad verdeckt diese
  return all.some((o) => o !== t && norm(o.name) === norm(t.name) && at(o.schema) >= 0 && at(o.schema) < mine);
}

export function objectName(dialect: Dialect, ref: Pick<ObjectRef, 'schema' | 'name'>): string {
  if (dialect === 'mysql' || !ref.schema) return quoteIdent(dialect, ref.name);
  return `${quoteIdent(dialect, ref.schema)}.${quoteIdent(dialect, ref.name)}`;
}

export function literal(dialect: Dialect, v: Cell, numeric = false): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || (numeric && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) return String(v);
  if (typeof v === 'boolean') return dialect === 'postgres' || dialect === 'elasticsearch' ? String(v) : v ? '1' : '0';
  let s = v.replace(/'/g, "''");
  if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\');
  // PostgreSQL: mit Backslash als E'…' (Backslash verdoppelt) – gilt auch bei standard_conforming_strings = off
  if (dialect === 'postgres' && s.includes('\\')) return "E'" + s.replace(/\\/g, '\\\\') + "'";
  return (dialect === 'mssql' ? "N'" : "'") + s + "'";
}

/**
 * Binärwert, wie die Treiber ihn anzeigen ('0x1F2E'), als Literal der Bytes; null = kein vollständiger Binärwert
 * (gekürzt „0x…… (n Bytes)“ oder anderer Text). Als Zeichenkette verglichen träfe er nichts (MySQL) bzw. scheiterte
 * (SQL Server: nvarchar → varbinary); PostgreSQL über decode – unabhängig von standard_conforming_strings.
 */
export function hexLiteral(dialect: Dialect, v: Cell): string | null {
  const hex = typeof v === 'string' ? /^0x([0-9A-Fa-f]*)$/.exec(v)?.[1]?.toUpperCase() : undefined;
  if (hex === undefined || hex.length % 2) return null;
  if (dialect === 'postgres') return `decode('${hex}', 'hex')`;
  if (dialect === 'mysql') return hex ? `0x${hex}` : "X''";
  if (dialect === 'mssql') return `0x${hex}`;
  return null;
}

/** Bedingung "spalte = wert" bzw. "IS NULL" für den Filter aus dem Kontextmenü; binary: Binärspalte, Wert als '0x…' */
export function condition(dialect: Dialect, column: string, v: Cell, op: '=' | '<>', numeric: boolean, binary = false): string {
  const c = quoteIdent(dialect, column);
  if (v === null) return `${c} IS ${op === '=' ? '' : 'NOT '}NULL`;
  const hex = binary ? hexLiteral(dialect, v) : null;
  return `${c} ${op} ${hex ?? literal(dialect, v, numeric)}`;
}

/** Datentyp mit Bytes statt Text: deren Zellen zeigen die Treiber als '0x…' */
export function isBinaryType(dataType: string): boolean {
  return /binary|blob|bytea|^image$|^bit\b/.test(baseType(dataType));
}

/**
 * Typname ohne Länge, Genauigkeit und die Werteliste eines enum('…')/set('…'), klein geschrieben – Prüfungen auf den
 * ganzen Typ trafen sonst Werte wie enum('image','blob') oder Domänen wie image_ref
 */
export function baseType(dataType: string): string {
  return dataType.toLowerCase().replace(/\(.*$/s, '').trim();
}

/**
 * Prüft die freie WHERE-Bedingung der Tabellenansicht. Sie wird als "WHERE (…)" eingesetzt und darf diese
 * Klammer nicht verlassen: ausgeglichene Klammern, kein Semikolon, keine Kommentare, keine offenen Zeichenketten.
 * (Ohne diese Prüfung ließe sich bei SQL Server z. B. "1=1) DELETE FROM t WHERE (1=1" einschleusen.)
 * Rückgabe: Fehlermeldung oder null.
 */
export function checkWhere(text: string, dialect: Dialect): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if ((c === '-' && next === '-') || (c === '/' && next === '*') || (c === '#' && dialect === 'mysql')) {
      return 'Kommentare sind in der WHERE-Bedingung nicht erlaubt.';
    }
    const close = c === "'" || c === '"' ? c : c === '`' && dialect === 'mysql' ? '`' : c === '[' && dialect === 'mssql' ? ']' : null;
    if (close) {
      // PostgreSQL: in E'…' gilt der Backslash als Escape (E'\'' schließt nicht) – sonst wären Prüfer und Server versetzt
      const eString = close === "'" && dialect === 'postgres' && /[eE]/.test(text[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(text[i - 2] ?? '');
      const backslash = (dialect === 'mysql' && close !== '`') || eString;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (backslash && text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === close) {
          if (text[j + 1] === close) {
            j++;
            continue;
          }
          break;
        }
      }
      if (j >= text.length) return 'Eine Zeichenkette oder ein Bezeichner in der WHERE-Bedingung ist nicht geschlossen.';
      i = j;
      continue;
    }
    if (c === '$' && dialect === 'postgres' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i))) {
      return 'Dollar-Quoting ist in der WHERE-Bedingung nicht erlaubt.';
    }
    if (c === ';') return 'Ein Semikolon ist in der WHERE-Bedingung nicht erlaubt – hier geht nur eine Bedingung, keine weitere Anweisung.';
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) return 'Die WHERE-Bedingung hat mehr schließende als öffnende Klammern.';
  }
  if (depth !== 0) return 'Die WHERE-Bedingung hat nicht geschlossene Klammern.';
  return null;
}

export function selectTop(dialect: Dialect, ref: Pick<ObjectRef, 'schema' | 'name'>, n: number): string {
  const name = objectName(dialect, ref);
  return dialect === 'mssql' ? `SELECT TOP (${n}) *\nFROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT ${n};`;
}

/** reservierte Wörter von PostgreSQL (auch die, die nur als Funktion/Typ ungequotet gehen): als Name nur in Anführungszeichen */
const PG_RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization', 'binary', 'both', 'case', 'cast',
  'check', 'collate', 'collation', 'column', 'concurrently', 'constraint', 'create', 'cross', 'current_catalog', 'current_date',
  'current_role', 'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc',
  'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full', 'grant', 'group',
  'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left',
  'like', 'limit', 'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select', 'session_user', 'similar', 'some',
  'symmetric', 'system_user', 'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using',
  'variadic', 'verbose', 'when', 'where', 'window', 'with',
]);

/**
 * Spalten, über die eine Zeile eindeutig getroffen wird: Primärschlüssel, sonst ein eindeutiger Index,
 * dessen Spalten alle NOT NULL sind. Ohne solchen Schlüssel ist Bearbeiten nicht möglich.
 */
export function keyColumns(info: TableInfo): string[] | null {
  const pk = info.indexes.find((i) => i.primary);
  if (pk?.columns.length) return pk.columns;
  const pkCols = info.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pkCols.length) return pkCols;
  const notNull = new Set(info.columns.filter((c) => !c.nullable).map((c) => c.name));
  const unique = info.indexes.find((i) => i.unique && i.columns.length && i.columns.every((c) => notNull.has(c)));
  return unique ? unique.columns : null;
}

/**
 * Anweisung als Kommentar: jede Zeile bekommt ihr eigenes „-- “. Werte dürfen Zeilenumbrüche enthalten – mit nur einem
 * „-- “ davor wäre ab der zweiten Zeile wieder lebendiges SQL (ein Textschlüssel „x'\nDROP TABLE …“ im Skript).
 * \r zählt mit: PostgreSQL und SQL Server beenden einen Zeilenkommentar auch dort.
 */
export function commentOut(sql: string): string {
  return sql.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/).map((l) => '-- ' + l).join('\n');
}

/** Text für eine einzeilige Kommentarzeile (Namen aus der Datenbank, Hinweise): Zeilenumbrüche und Steuerzeichen werden Leerzeichen */
export function commentText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\r\n\u0085\u2028\u2029\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ');
}
