import type { Cell, ColumnInfo, Dialect, ObjectRef, RowChange, TableInfo } from '../shared/api-types';
import { baseType, keyColumns, literal, quoteIdent } from '../shared/sql-util';
import type { WriteOp } from './drivers/common';
import type { ExportCell } from './export';

/** Typname ohne Länge und ohne die Werteliste eines enum('…')/set('…') */
const NOT_COMPARABLE = /\b(date|time|datetime|datetime2|smalldatetime|datetimeoffset|timestamp|timestamptz|year|float|double|real|binary|varbinary|blob|tinyblob|mediumblob|longblob|bytea|image|json|jsonb|xml|geometry|geography|point|line|lseg|box|path|polygon|circle|linestring|multipoint|multipolygon|interval|money|smallmoney|hierarchyid|sql_variant)\b/;
const COMPARABLE = /\b(int|integer|tinyint|smallint|mediumint|bigint|int2|int4|int8|serial|bigserial|smallserial|bit|bool|boolean|dec|decimal|numeric|char|varchar|nchar|nvarchar|character|text|tinytext|mediumtext|longtext|uuid|uniqueidentifier|enum|set|name)\b/;

/** Spalten, deren alter Wert sich exakt vergleichen lässt (Zeit-, Gleitkomma-, Binär- und JSON-Werte nicht) */
function comparable(c: ColumnInfo, dialect: Dialect): boolean {
  // nur der Typname: enum('realtime') oder ein Typ namens „json“ in der Werteliste schalteten die Prüfung sonst still ab
  const t = baseType(c.dataType);
  if (c.dataType.includes('[]') || NOT_COMPARABLE.test(t)) return false;
  // SQL Server: text/ntext lassen sich nicht mit = vergleichen; MySQL BIT kommt als Bytes (0x01) – nicht mit = vergleichbar
  if (dialect === 'mssql' && /^n?text$/.test(t)) return false;
  if (dialect === 'mysql' && t === 'bit') return false;
  return COMPARABLE.test(t);
}

const BINARY = /\b(binary|varbinary|blob|tinyblob|mediumblob|longblob|bytea|image)\b/;
const TEXTUAL = /\b(char|varchar|nchar|nvarchar|character|text|tinytext|mediumtext|longtext|enum|set|json|jsonb|xml|uuid|uniqueidentifier|name|citext)\b/;
const DATETIME = /\b(date|datetime|datetime2|smalldatetime|datetimeoffset|timestamp|time)\b/;

/**
 * Wert, wie er gebunden wird: Binärschlüssel aus der Anzeige (0x…) zurück in Bytes, leere Eingabe in Zahl-/Datumsspalten als
 * NULL (SQL Server machte aus '' sonst still 0 bzw. 1900-01-01, MySQL ohne STRICT ebenso), MySQL-BIT als Zahl (als Text wäre
 * '1' das Byte 0x31), Zeitstempel für SQL Server mit T (sprachneutral)
 */
function bindValue(v: Cell, c: ColumnInfo | undefined, dialect: Dialect, table: string): ExportCell {
  if (v === null || v === undefined || !c) return v ?? null;
  const t = baseType(c.dataType);
  if (typeof v === 'string') {
    if (BINARY.test(t)) {
      // aus der Anzeige (0x…) zurück in Bytes – als Text verglichen träfe ein Binärschlüssel keine Zeile
      const m = /^0x([0-9a-f]*)$/i.exec(v);
      if (m) return Buffer.from(m[1], 'hex');
      if (/… \(\d+ Bytes\)$/.test(v)) throw new Error(`${table}.${c.name}: der angezeigte Binärwert ist gekürzt – diese Zeile lässt sich so nicht gezielt ändern.`);
      return v;
    }
    if (!v.trim() && !TEXTUAL.test(t)) {
      if (!c.nullable && c.defaultValue == null && !c.autoIncrement) throw new Error(`${table}.${c.name}: leer geht nicht – die Spalte verlangt einen Wert (NOT NULL ohne Standardwert).`);
      return null;
    }
    if (dialect === 'mysql' && t === 'bit') {
      const n = /^(true|on)$/i.test(v) ? 1 : /^(false|off)$/i.test(v) ? 0 : Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${table}.${c.name}: BIT braucht eine ganze Zahl (0, 1, …).`);
      return n;
    }
    // datetimeoffset zeigt '… +00:00' mit Leerzeichen vor der Zone – mit T davor nimmt SQL Server das nur ohne das Leerzeichen
    if (dialect === 'mssql' && DATETIME.test(t) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return v.replace(' ', 'T').replace(/ (?=[+-]\d{2}:?\d{2}$)/, '');
  }
  return v;
}

/** Stück einer Anweisung; mit value = Parameter (col: zugehörige Spalte, für die Vorschau) */
interface Part {
  text: string;
  value?: Cell;
  col?: string;
}

function tableName(dialect: Dialect, ref: ObjectRef): string {
  const q = (s: string) => quoteIdent(dialect, s);
  if (dialect === 'mysql') return `${q(ref.database)}.${q(ref.name)}`;
  if (dialect === 'postgres') return `${q(ref.schema)}.${q(ref.name)}`;
  return `${q(ref.database)}.${q(ref.schema)}.${q(ref.name)}`;
}

/**
 * Änderungen in Anweisungen mit Parametern übersetzen (zum Ausführen) und mit eingesetzten Werten (zur Anzeige).
 * Reihenfolge: löschen, ändern, einfügen – so stören sich z. B. eindeutige Werte nicht.
 * Jede Anweisung muss genau eine Zeile treffen, sonst rollt der Treiber alles zurück.
 */
export function buildWrites(dialect: Dialect, ref: ObjectRef, info: TableInfo, changes: RowChange[]): { ops: WriteOp[]; preview: string[] } {
  const key = keyColumns(info);
  const cols = new Map(info.columns.map((c) => [c.name, c]));
  const table = tableName(dialect, ref);
  const q = (s: string) => quoteIdent(dialect, s);
  const ops: WriteOp[] = [];
  const preview: string[] = [];

  const check = (names: string[]) => {
    for (const n of names) if (!cols.has(n)) throw new Error(`Spalte ${n} gibt es in ${ref.name} nicht (mehr). Bitte neu laden.`);
  };

  /** in der Vorschau Zahlen in Zahlspalten ohne Anführungszeichen ("10" statt N'10') */
  const numericCol = (name?: string) => !!name && /int|serial|dec|numeric|float|double|real|money|bit/i.test(cols.get(name)?.dataType ?? '');
  const build = (parts: Part[], label: string) => {
    const params: ExportCell[] = [];
    const types: (string | undefined)[] = [];
    let sql = '';
    let shown = '';
    for (const p of parts) {
      sql += p.text;
      shown += p.text;
      if ('value' in p) {
        const bound = bindValue(p.value ?? null, p.col ? cols.get(p.col) : undefined, dialect, ref.name);
        params.push(bound);
        types.push(p.col ? cols.get(p.col)?.dataType : undefined);
        sql += dialect === 'mysql' ? '?' : dialect === 'postgres' ? `$${params.length}` : `@p${params.length}`;
        // Vorschau zeigt, was gebunden wird (Binärwerte als 0x…, Zahlen in Zahlspalten ohne Anführungszeichen)
        shown += Buffer.isBuffer(bound) ? '0x' + bound.toString('hex').toUpperCase() : literal(dialect, bound, typeof bound === 'number' || numericCol(p.col));
      }
    }
    ops.push({ sql, params, types, expect: 1, label });
    preview.push(shown + ';');
  };

  /** WHERE schlüssel = … [AND geänderte Spalte = alter Wert …] */
  const where = (keyValues: Record<string, Cell>, original: Record<string, Cell> = {}) => {
    const parts: Part[] = [{ text: ' WHERE ' }];
    const conds: { col: string; v: Cell }[] = key!.map((k) => ({ col: k, v: keyValues[k] }));
    for (const [col, v] of Object.entries(original)) {
      if (!key!.includes(col) && comparable(cols.get(col)!, dialect)) conds.push({ col, v });
    }
    conds.forEach((c, i) => {
      if (i) parts.push({ text: ' AND ' });
      if (c.v === null) parts.push({ text: `${q(c.col)} IS NULL` });
      else parts.push({ text: `${q(c.col)} = `, value: c.v, col: c.col });
    });
    return parts;
  };

  const describe = (keyValues: Record<string, Cell>) => key!.map((k) => `${k} = ${keyValues[k]}`).join(', ');
  const order = { delete: 0, update: 1, insert: 2 } as const;
  for (const ch of [...changes].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (ch.kind !== 'insert') {
      if (!key) throw new Error(`${ref.name} hat keinen Primärschlüssel – Zeilen lassen sich nicht eindeutig ändern oder löschen.`);
      if (!ch.key || key.some((k) => !(k in ch.key!))) throw new Error('Schlüsselwerte fehlen – bitte neu laden.');
      if (key.some((k) => ch.key![k] === null)) throw new Error('Eine Zeile ohne Schlüsselwert (NULL) lässt sich nicht gezielt ändern.');
      check(key);
    }
    if (ch.kind === 'delete') {
      build([{ text: `DELETE FROM ${table}` }, ...where(ch.key!)], `Löschen (${describe(ch.key!)})`);
    } else if (ch.kind === 'update') {
      const values = Object.entries(ch.values ?? {});
      if (!values.length) continue;
      check(values.map(([c]) => c));
      const parts: Part[] = [{ text: `UPDATE ${table} SET ` }];
      values.forEach(([c, v], i) => {
        parts.push({ text: `${i ? ', ' : ''}${q(c)} = `, value: v, col: c });
      });
      build([...parts, ...where(ch.key!, ch.original ?? {})], `Ändern (${describe(ch.key!)})`);
    } else {
      const values = Object.entries(ch.values ?? {});
      check(values.map(([c]) => c));
      if (!values.length) {
        build([{ text: dialect === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES` }], 'Einfügen');
        continue;
      }
      const parts: Part[] = [{ text: `INSERT INTO ${table} (${values.map(([c]) => q(c)).join(', ')}) VALUES (` }];
      values.forEach(([c, v], i) => parts.push({ text: i ? ', ' : '', value: v, col: c }));
      parts.push({ text: ')' });
      build(parts, 'Einfügen');
    }
  }
  return { ops, preview };
}
