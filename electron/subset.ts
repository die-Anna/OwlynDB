/*
 * Teil-Dump (Test-Datenbank aus Prod): je Tabelle nur ein Teil der Zeilen, dazu alle Zeilen, auf die diese per
 * Fremdschlüssel verweisen – über beliebig viele Stufen und Selbstbezüge. Tabellen mit „abhängige Zeilen“ bekommen
 * umgekehrt die Zeilen, die auf mitkommende Zeilen einer Tabelle mit eigener Auswahl verweisen (Positionen der
 * gewählten Bestellungen). Erst planen (nur Schlüssel- und Fremdschlüsselspalten lesen), dann genau die geplanten
 * Zeilen schreiben: so passt die Kopie zusammen, auch wenn sich die Quelle zwischendurch ändert.
 */
import type { Dialect, RowRule, TableDataRequest, TableInfo } from '../shared/api-types';
import { keyColumns, literal, quoteIdent } from '../shared/sql-util';
import { canon, kindOf } from './values';
import { NUMERIC_TYPE, type CancelCheck, type MetaDriver } from './drivers/common';
import type { ExportCell } from './export';

export interface SubsetTable {
  schema: string;
  name: string;
  info: TableInfo;
  rule: RowRule;
}

/** was beim Schreiben je Tabelle gelesen wird */
export type DataPlan =
  | { mode: 'all' }
  | { mode: 'none' }
  /** genau diese Zeilen (Schlüsselwerte) */
  | { mode: 'keys'; key: string[]; keys: ExportCell[][] }
  /** Tabelle ohne Schlüssel: die Regel beim Schreiben noch einmal anwenden */
  | { mode: 'rule'; rule: RowRule }
  /** Tabelle ohne Schlüssel mit abhängigen Zeilen: alle Zeilen mit diesen Fremdschlüssel-Werten */
  | { mode: 'refs'; cols: string[]; values: ExportCell[][] };

/** Zeilen je Abfrage beim Holen über Schlüssel (einspaltig bzw. zusammengesetzt) */
export const KEY_CHUNK = 1000;
export const COMPOSITE_CHUNK = 200;

export const tableId = (schema: string, name: string) => `${schema}\u0000${name}`;

interface Edge {
  cols: string[];
  parent: Node;
  refCols: string[];
}

interface Node {
  t: SubsetTable;
  key: string[] | null;
  /** gewählte Zeilen: Vergleichsform des Schlüssels → Schlüsselwerte */
  chosen: Map<string, ExportCell[]>;
  /** Fremdschlüssel zu Tabellen, die nur teilweise mitkommen */
  out: Edge[];
  /** schon angefragte Werte je Spaltenliste */
  asked: Map<string, Set<string>>;
  /** noch zu holende Werte je Spaltenliste */
  pending: Map<string, { cols: string[]; values: Map<string, ExportCell[]> }>;
  /** abhängige Tabellen, die auf diese verweisen: ihre Zeilen zu den mitkommenden Zeilen hier holen */
  down: Down[];
}

/** Fremdschlüssel einer Tabelle mit „abhängige Zeilen“ (child) auf diese Tabelle, in Gegenrichtung gelesen */
interface Down {
  child: Node;
  /** Spalten in child */
  cols: string[];
  /** Spalten hier, auf die sie verweisen */
  refCols: string[];
  /** schon weitergegebene Werte (Vergleichsform) und alle Werte in Reihenfolge (für Tabellen ohne Schlüssel) */
  pushed: Set<string>;
  all: ExportCell[][];
  /** noch nicht abgefragt */
  queue: ExportCell[][];
}

/** Tabellen mit eigener Auswahl: ihre Zeilen ziehen abhängige Zeilen nach sich (nicht „alle“, nicht „keine“) */
const DRIVING = new Set<RowRule['kind']>(['last', 'where', 'dependent']);

const NO_OPTIONS = { ignoreCase: false, trailing: false };

function columnType(info: TableInfo, column: string): string {
  return info.columns.find((c) => c.name === column)?.dataType ?? '';
}

/** Wert als Literal in der Quelle (für WHERE … IN) */
function keyLiteral(dialect: Dialect, v: ExportCell, type: string): string {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) {
    const hex = v.toString('hex');
    return dialect === 'postgres' ? `'\\x${hex}'::bytea` : dialect === 'mssql' ? `0x${hex.toUpperCase()}` : `X'${hex}'`;
  }
  if (typeof v === 'boolean') return dialect === 'postgres' ? String(v) : v ? '1' : '0';
  return literal(dialect, v, NUMERIC_TYPE.test(type));
}

/** Bedingung „Spalten in diesen Werten“ (einspaltig als IN, sonst als OR-Kette) */
export function keyWhere(dialect: Dialect, info: TableInfo, cols: string[], rows: ExportCell[][]): string {
  const q = (c: string) => quoteIdent(dialect, c);
  if (cols.length === 1) {
    const type = columnType(info, cols[0]);
    return `${q(cols[0])} IN (${rows.map((r) => keyLiteral(dialect, r[0], type)).join(', ')})`;
  }
  return rows.map((r) => '(' + cols.map((c, i) => `${q(c)} = ${keyLiteral(dialect, r[i], columnType(info, c))}`).join(' AND ') + ')').join(' OR ');
}

/** Abfrage-Teile für eine Regel (letzte N bzw. WHERE) */
export function ruleQuery(rule: RowRule): Pick<TableDataRequest, 'sort' | 'top' | 'where'> {
  // NULLS LAST: PostgreSQL stellte NULL bei DESC sonst an den Anfang, und „die letzten N“ wären Zeilen ohne Wert
  if (rule.kind === 'last') return { sort: [{ column: rule.column, dir: 'desc', nulls: 'last' }], top: Math.max(0, Math.floor(rule.count)) };
  if (rule.kind === 'where') return { sort: [], where: rule.where };
  return { sort: [] };
}

/** so viele Schlüssel hält die Planung höchstens im Speicher */
export const MAX_SUBSET_KEYS = 2_000_000;

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function planSubset(
  driver: MetaDriver,
  dialect: Dialect,
  database: string,
  tables: SubsetTable[],
  progress: { table: string; warnings: string[] },
  cancelled: CancelCheck,
): Promise<Map<string, DataPlan>> {
  const nodes = tables.map(
    (t): Node => ({ t, key: keyColumns(t.info), chosen: new Map(), out: [], asked: new Map(), pending: new Map(), down: [] }),
  );
  const find = (schema: string, name: string) => nodes.find((n) => n.t.name === name && (dialect === 'mysql' || n.t.schema === schema));
  for (const n of nodes) {
    for (const fk of n.t.info.foreignKeys) {
      const parent = find(fk.refSchema, fk.refTable);
      // nicht im Dump (Fremdschlüssel fällt weg) oder ganz dabei: nichts zu verfolgen
      if (!parent || parent.t.rule.kind === 'all') continue;
      parent.key ??= fk.refColumns;
      n.out.push({ cols: fk.columns, parent, refCols: fk.refColumns });
      // abhängige Zeilen: nur von Tabellen mit eigener Auswahl her (sonst zöge z. B. jeder Artikel alle seine Positionen nach)
      if (n.t.rule.kind === 'dependent' && DRIVING.has(parent.t.rule.kind)) {
        parent.down.push({ child: n, cols: fk.columns, refCols: fk.refColumns, pushed: new Set(), all: [], queue: [] });
      }
    }
    const r = n.t.rule;
    if (r.kind === 'last' && !n.t.info.columns.some((c) => c.name === r.column)) {
      throw new Error(`${n.t.name}: Spalte ${r.column} für „die letzten ${r.count}“ gibt es nicht.`);
    }
  }
  for (const n of nodes) {
    if (n.t.rule.kind !== 'dependent') continue;
    const via = nodes.flatMap((p) => p.down.filter((d) => d.child === n));
    if (!via.length) {
      progress.warnings.push(`${n.t.name}: „abhängige Zeilen“, aber keine gewählte Tabelle mit eigener Auswahl (die letzten …, WHERE), auf die sie verweist – es kommen nur Zeilen mit, auf die verwiesen wird.`);
    } else if (!n.key && via.length > 1) {
      // ohne Schlüssel lassen sich Zeilen, die über zwei Wege kommen, nicht auseinanderhalten: nur der erste Weg
      for (const d of via.slice(1)) for (const p of nodes) p.down = p.down.filter((x) => x !== d);
      progress.warnings.push(`${n.t.name} hat keinen Schlüssel: abhängige Zeilen nur über ${via[0].cols.join(', ')} (sonst kämen Zeilen doppelt).`);
    }
  }

  const canonOf = (n: Node, cols: string[], vals: ExportCell[]) =>
    JSON.stringify(vals.map((v, i) => canon(v, kindOf(columnType(n.t.info, cols[i])), NO_OPTIONS)));
  /** gelesene Spalten: Schlüssel, Fremdschlüssel zu Teil-Tabellen, Spalten, auf die abhängige Tabellen verweisen */
  const columnsOf = (n: Node) => [...new Set([...(n.key ?? []), ...n.out.flatMap((e) => e.cols), ...n.down.flatMap((d) => d.refCols)])];

  const read = async (n: Node, cols: string[], q: Partial<TableDataRequest>, onRow: (r: ExportCell[]) => void) => {
    progress.table = `Auswahl ${n.t.name}`;
    await driver.streamTable(
      { object: { connectionId: '', database, schema: n.t.schema, name: n.t.name, kind: 'table' }, limit: 0, offset: 0, sort: [], only: !n.t.info.special, ...q, columns: cols },
      {
        begin: async () => undefined,
        rows: async (batch) => {
          if (cancelled()) throw new Error('Abgebrochen.');
          for (const r of batch) onRow(r);
        },
      },
      cancelled.signal,
    );
  };

  /** Fremdschlüssel-Werte einer Zeile als offene Verweise bei den Elterntabellen vormerken */
  // alle gesammelten Schlüssel liegen im Hauptprozess: über einer Grenze lieber abbrechen als den Speicher sprengen
  let collected = 0;
  const count = () => {
    if (++collected > MAX_SUBSET_KEYS) {
      throw new Error(
        `Teilmenge: mehr als ${MAX_SUBSET_KEYS.toLocaleString('de-CH')} Schlüssel zu verfolgen – bitte die Regeln enger fassen (WHERE, „die letzten N“) oder Tabellen abwählen; ganze Tabellen mit Verweis auf eine Teilmenge ziehen alle ihre Fremdschlüssel nach.`,
      );
    }
  };
  const follow = (e: Edge, vals: ExportCell[]) => {
    if (vals.some((v) => v === null || v === undefined)) return;
    const p = e.parent;
    const c = canonOf(p, e.refCols, vals);
    const sig = e.refCols.join('\u0000');
    if (p.asked.get(sig)?.has(c)) return;
    if (p.key && p.key.join('\u0000') === sig && p.chosen.has(c)) return;
    let open = p.pending.get(sig);
    if (!open) p.pending.set(sig, (open = { cols: e.refCols, values: new Map() }));
    if (!open.values.has(c)) count();
    open.values.set(c, vals);
  };

  /** Zeile übernehmen (falls neu), ihre Verweise verfolgen und abhängige Zeilen vormerken */
  const take = (n: Node, cols: string[], r: ExportCell[]) => {
    const at = (c: string) => r[cols.indexOf(c)];
    if (n.key) {
      const kv = n.key.map(at);
      const c = canonOf(n, n.key, kv);
      if (n.chosen.has(c)) return;
      count();
      n.chosen.set(c, kv);
    }
    for (const e of n.out) follow(e, e.cols.map(at));
    for (const d of n.down) {
      const vals = d.refCols.map(at);
      if (vals.some((v) => v === null || v === undefined)) continue;
      const c = canonOf(n, d.refCols, vals);
      if (d.pushed.has(c)) continue;
      d.pushed.add(c);
      d.all.push(vals);
      d.queue.push(vals);
    }
  };

  // 1. Startmenge nach den Regeln; ganze Tabellen geben nur ihre Verweise weiter (DISTINCT); abhängige warten auf ihre Eltern
  for (const n of nodes) {
    const r = n.t.rule;
    if (r.kind === 'all') {
      for (const e of n.out) await read(n, e.cols, { distinct: true }, (row) => follow(e, row));
      continue;
    }
    if (r.kind === 'none' || r.kind === 'dependent') continue;
    const cols = columnsOf(n);
    if (!cols.length) continue;
    await read(n, cols, ruleQuery(r), (row) => take(n, cols, row));
  }

  // 2. offene Verweise holen und abhängige Zeilen nachziehen, bis nichts mehr dazukommt (Kreise und Selbstbezüge enden,
  //    weil nur Neues geholt wird)
  for (;;) {
    let busy = false;
    for (const n of nodes) {
      for (const [sig, p] of n.pending) {
        if (!p.values.size) continue;
        busy = true;
        const values = [...p.values.entries()];
        p.values = new Map();
        let asked = n.asked.get(sig);
        if (!asked) n.asked.set(sig, (asked = new Set()));
        for (const [c] of values) asked.add(c);
        const cols = columnsOf(n);
        for (const part of chunks(values.map(([, v]) => v), p.cols.length === 1 ? KEY_CHUNK : COMPOSITE_CHUNK)) {
          await read(n, cols, { where: keyWhere(dialect, n.t.info, p.cols, part) }, (row) => take(n, cols, row));
        }
      }
    }
    for (const n of nodes) {
      for (const d of n.down) {
        if (!d.queue.length) continue;
        busy = true;
        const values = d.queue;
        d.queue = [];
        const cols = columnsOf(d.child);
        for (const part of chunks(values, d.cols.length === 1 ? KEY_CHUNK : COMPOSITE_CHUNK)) {
          await read(d.child, cols, { where: keyWhere(dialect, d.child.t.info, d.cols, part) }, (row) => take(d.child, cols, row));
        }
      }
    }
    if (!busy) break;
  }

  const plans = new Map<string, DataPlan>();
  for (const n of nodes) {
    const r = n.t.rule;
    const id = tableId(n.t.schema, n.t.name);
    if (r.kind === 'all') plans.set(id, { mode: 'all' });
    else if (n.key) plans.set(id, n.chosen.size ? { mode: 'keys', key: n.key, keys: [...n.chosen.values()] } : { mode: 'none' });
    else if (r.kind === 'none') plans.set(id, { mode: 'none' });
    else if (r.kind === 'dependent') {
      const d = nodes.flatMap((p) => p.down).find((x) => x.child === n);
      plans.set(id, d?.all.length ? { mode: 'refs', cols: d.cols, values: d.all } : { mode: 'none' });
    } else {
      plans.set(id, { mode: 'rule', rule: r });
      progress.warnings.push(`${n.t.name} hat keinen Schlüssel: die Teilmenge wird beim Schreiben noch einmal gelesen (ändert sich die Quelle dazwischen, kann sie abweichen).`);
    }
  }
  return plans;
}
