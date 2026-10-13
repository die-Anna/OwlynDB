/*
 * Datenvergleich zweier Tabellen, auch über Verbindungen und Datenbanktypen hinweg. Zeilen werden über den Schlüssel
 * einander zugeordnet, nicht über die Sortierung – unterschiedliche Kollationen (Groß/klein, Umlaute) stören so nicht.
 *  1. Ziel lesen: je Zeile Schlüssel → Prüfsumme der verglichenen Spalten (nur das bleibt im Speicher)
 *  2. Quelle lesen und vergleichen: fehlt im Ziel, unterschiedlich oder gleich; Quellzeilen der Unterschiede merken
 *  3. nur falls nötig das Ziel noch einmal: alte Werte der geänderten Zeilen und die Zeilen, die es nur im Ziel gibt
 * Die Quelle (oft Prod) wird nur einmal gelesen. Zu jedem Unterschied entsteht die Anweisung, die das Ziel angleicht.
 * Für große Abgleiche schreibt writeDataScript dieselben Anweisungen ohne Obergrenze direkt in eine Datei (auch für alle
 * Tabellen eines Schemas, in der Reihenfolge der Fremdschlüssel); compareSchemaData zählt die Unterschiede je Tabelle.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Cell,
  ColumnInfo,
  DataCompareAllRequest,
  DataCompareAllResult,
  DataCompareRequest,
  DataCompareResult,
  DataDiffRow,
  DataDiffStatus,
  Dialect,
  ResultColumn,
  TableInfo,
} from '../shared/api-types';
import { commentOut, commentText, keyColumns, literal, quoteIdent } from '../shared/sql-util';
import { ABORTED, errorText, NUMERIC_TYPE, normalizeCell, rowBytes, type CancelCheck, type MetaDriver } from './drivers/common';
import { valueConverter } from './dump';
import type { ExportCell } from './export';
import { canon, kindOf, type CanonOptions, type Kind } from './values';

/** so viele Zeilen je Art kommen mit Werten und Anweisung zurück (gezählt wird alles) */
export const DIFF_LIMIT = 5000;
/** so viele Zeilen darf das Ziel haben (Schlüssel und Prüfsumme je Zeile bleiben im Speicher) */
export const MAX_TARGET_ROWS = 5_000_000;
/** so viel dürfen die behaltenen Zeilen des Vergleichs (für Liste und Skript) im Speicher belegen */
const KEPT_BYTES = 100 * 1024 * 1024;
/** SQL Server: alle so viele Anweisungen ein GO in der Skript-Datei */
const GO_EVERY = 1000;

export interface DataSide {
  driver: MetaDriver;
  dialect: Dialect;
  database: string;
  schema: string;
  table: string;
}

export interface DataCompareProgress {
  phase: string;
  rows: number;
  /** Skript-Datei: geschriebene Anweisungen */
  statements?: number;
}

/** Spalte auf beiden Seiten (Namen können sich in Groß-/Kleinschreibung unterscheiden) */
interface Pair {
  src: ColumnInfo;
  dst: ColumnInfo;
}

const label = (s: DataSide) => [s.database, s.schema, s.table].filter(Boolean).join('.');
const lower = (s: string) => s.toLowerCase();

/** Tabelle ohne Primärschlüssel und eindeutigen Index ohne NULL, kein Schlüssel gewählt */
class NoKeyError extends Error {}

function qualified(s: DataSide): string {
  const q = (x: string) => quoteIdent(s.dialect, x);
  if (s.dialect === 'mysql') return `${q(s.database)}.${q(s.table)}`;
  if (s.dialect === 'postgres') return `${q(s.schema)}.${q(s.table)}`;
  return `${q(s.database)}.${q(s.schema)}.${q(s.table)}`;
}

/** Zeilen einer Seite lesen; onRow gibt false zurück, wenn nichts mehr gebraucht wird */
async function scan(
  side: DataSide,
  where: string | undefined,
  progress: DataCompareProgress,
  cancelled: CancelCheck,
  onBegin: (cols: ResultColumn[]) => void,
  onRow: (r: ExportCell[]) => boolean | void | Promise<void>,
): Promise<void> {
  const STOP = 'Datenvergleich: alles gefunden';
  try {
    await side.driver.streamTable(
      {
        object: { connectionId: '', database: side.database, schema: side.schema, name: side.table, kind: 'table' },
        limit: 0,
        offset: 0,
        sort: [],
        where: where?.trim() || undefined,
      },
      {
        begin: async (cols) => onBegin(cols),
        rows: async (batch) => {
          if (cancelled()) throw new Error('Abgebrochen.');
          for (const r of batch) {
            progress.rows++;
            const x = onRow(r);
            if (x === false) throw new Error(STOP);
            // Skript-Datei: beim Schreiben warten (Gegendruck)
            if (x instanceof Promise) await x;
          }
        },
      },
      // Abbrechen erreicht die Abfrage auch, solange der Server noch keine Zeile geliefert hat
      cancelled.signal,
    );
  } catch (e) {
    if (!(e instanceof Error && e.message === STOP)) throw e;
  }
}

/** Stelle jeder gesuchten Spalte in den gelesenen Zeilen */
function positions(cols: ResultColumn[], names: string[], side: DataSide): number[] {
  return names.map((n) => {
    const i = cols.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
    if (i < 0) throw new Error(`Spalte ${n} fehlt in ${label(side)} – hat sich die Tabelle geändert?`);
    return i;
  });
}

/** Schlüssel in Vergleichsform aufsteigend: Zahlen als Zahlen, sonst als Text, NULL zuerst */
function compareKeys(a: (string | null)[], b: (string | null)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny) && nx !== ny) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Vorbereitung: Struktur beider Seiten, Schlüssel, verglichene Spalten, Hinweise */
interface Plan {
  src: DataSide;
  dst: DataSide;
  req: DataCompareRequest;
  o: CanonOptions;
  key: string[];
  keyPairs: Pair[];
  /** Spalten auf beiden Seiten (für INSERT) */
  common: Pair[];
  /** verglichene Spalten: Schlüssel zuerst */
  cmp: Pair[];
  keyCount: number;
  sKind: Kind[];
  tKind: Kind[];
  warnings: string[];
  /** Struktur des Ziels (Fremdschlüssel für die Reihenfolge im Skript mehrerer Tabellen) */
  target: TableInfo;
}

async function planCompare(src: DataSide, dst: DataSide, req: DataCompareRequest, progress: DataCompareProgress): Promise<Plan> {
  progress.phase = 'Struktur lesen';
  const [si, ti]: TableInfo[] = await Promise.all([
    src.driver.describeTable(src.database, src.schema, src.table),
    dst.driver.describeTable(dst.database, dst.schema, dst.table),
  ]);
  if (!si.columns.length) throw new Error(`Tabelle ${label(src)} nicht gefunden.`);
  if (!ti.columns.length) throw new Error(`Tabelle ${label(dst)} nicht gefunden.`);
  const inTarget = new Map(ti.columns.map((c) => [lower(c.name), c]));
  const inSource = new Map(si.columns.map((c) => [lower(c.name), c]));
  const warnings: string[] = [];

  // Schlüssel: gewählt, sonst Primärschlüssel bzw. eindeutiger Index ohne NULL der Quelle
  const key = req.key?.length ? req.key : (keyColumns(si) ?? []);
  if (!key.length) {
    throw new NoKeyError(
      `${src.table} hat weder Primärschlüssel noch einen eindeutigen Index ohne NULL – bitte die Schlüsselspalten wählen, über die die Zeilen einander zugeordnet werden.`,
    );
  }
  const keyPairs: Pair[] = key.map((k) => {
    const s = inSource.get(lower(k));
    const d = inTarget.get(lower(k));
    if (!s) throw new Error(`Schlüsselspalte ${k} gibt es in der Quelle nicht.`);
    if (!d) throw new Error(`Schlüsselspalte ${k} gibt es im Ziel nicht.`);
    return { src: s, dst: d };
  });
  const isKey = new Set(keyPairs.map((p) => lower(p.src.name)));
  // berechnete Spalten und rowversion lassen sich nicht schreiben (und folgen aus anderen Spalten): nicht vergleichen
  const generated = (c: ColumnInfo) => c.generated !== undefined || !!c.rowversion;
  const skipped = si.columns.filter((c) => inTarget.has(lower(c.name)) && (generated(c) || generated(inTarget.get(lower(c.name))!)) && !isKey.has(lower(c.name)));
  if (skipped.length) warnings.push(`Berechnet bzw. vom Server gesetzt, nicht verglichen: ${skipped.map((c) => c.name).join(', ')}.`);
  const common: Pair[] = si.columns
    .filter((c) => inTarget.has(lower(c.name)) && !(generated(c) || generated(inTarget.get(lower(c.name))!)) )
    .map((c) => ({ src: c, dst: inTarget.get(lower(c.name))! }));
  const wanted = req.columns?.length ? new Set(req.columns.map(lower)) : null;
  if (wanted) for (const n of wanted) if (!inSource.has(n)) throw new Error(`Spalte ${n} gibt es in der Quelle nicht.`);
  const cmp: Pair[] = [...keyPairs, ...common.filter((p) => !isKey.has(lower(p.src.name)) && (!wanted || wanted.has(lower(p.src.name))))];
  const onlySource = si.columns.filter((c) => !inTarget.has(lower(c.name))).map((c) => c.name);
  const onlyTarget = ti.columns.filter((c) => !inSource.has(lower(c.name)));
  if (onlySource.length) warnings.push(`Nur in der Quelle, nicht verglichen: ${onlySource.join(', ')}.`);
  if (onlyTarget.length) {
    const required = onlyTarget.filter((c) => !c.nullable && c.defaultValue == null && !c.autoIncrement).map((c) => c.name);
    warnings.push(
      `Nur im Ziel, nicht verglichen: ${onlyTarget.map((c) => c.name).join(', ')} – beim Einfügen gilt dort der Standardwert` +
        (required.length ? `; ${required.join(', ')} ist NOT NULL ohne Standardwert, Einfügen schlägt fehl.` : '.'),
    );
  }
  for (const p of cmp.slice(keyPairs.length)) {
    if (kindOf(p.src.dataType) !== kindOf(p.dst.dataType) || (src.dialect === dst.dialect && lower(p.src.dataType) !== lower(p.dst.dataType))) {
      warnings.push(`Spalte ${p.src.name}: Typ ${p.src.dataType} in der Quelle, ${p.dst.dataType} im Ziel – Werte werden in Textform verglichen.`);
    }
  }
  return {
    src,
    dst,
    req,
    o: { ignoreCase: !!req.ignoreCase, trailing: !!req.ignoreTrailingSpaces },
    key,
    keyPairs,
    common,
    cmp,
    keyCount: keyPairs.length,
    sKind: cmp.map((p) => kindOf(p.src.dataType)),
    tKind: cmp.map((p) => kindOf(p.dst.dataType)),
    warnings,
    target: ti,
  };
}

function keyOf(p: Plan, r: ExportCell[], pos: number[], kinds: Kind[]): string {
  return JSON.stringify(pos.slice(0, p.keyCount).map((i, j) => canon(r[i], kinds[j], p.o)));
}

function hashOf(p: Plan, r: ExportCell[], pos: number[], kinds: Kind[]): string {
  return createHash('sha1')
    .update(JSON.stringify(pos.slice(p.keyCount).map((i, j) => canon(r[i], kinds[p.keyCount + j], p.o))))
    .digest('base64');
}

const keyText = (p: Plan, k: string) => (JSON.parse(k) as (string | null)[]).map((v, j) => `${p.key[j]} = ${v ?? 'NULL'}`).join(', ');

/** Markierungen in seen nach dem Lesen der Quelle (sonst steht dort die Prüfsumme der Zielzeile) */
const SOURCE_ONLY = '+';
const SAME = '=';
const DIFFERENT = '!';

/** 1. Ziel lesen: Schlüssel → Prüfsumme */
async function readTarget(
  p: Plan,
  progress: DataCompareProgress,
  cancelled: CancelCheck,
): Promise<{ seen: Map<string, string>; tCols: ResultColumn[]; tPos: number[] }> {
  const seen = new Map<string, string>();
  let tCols: ResultColumn[] = [];
  let tPos: number[] = [];
  let doubled = 0;
  let example = '';
  progress.phase = `Ziel lesen (${label(p.dst)})`;
  await scan(
    p.dst,
    p.req.where,
    progress,
    cancelled,
    (cols) => {
      tCols = cols;
      tPos = positions(cols, p.cmp.map((x) => x.dst.name), p.dst);
    },
    (r) => {
      const k = keyOf(p, r, tPos, p.tKind);
      if (seen.has(k)) {
        doubled++;
        example ||= k;
        return;
      }
      seen.set(k, hashOf(p, r, tPos, p.tKind));
      if (seen.size > MAX_TARGET_ROWS) {
        throw new Error(`Das Ziel hat mehr als ${MAX_TARGET_ROWS.toLocaleString('de-CH')} Zeilen – bitte mit einer WHERE-Bedingung einschränken.`);
      }
    },
  );
  if (doubled) {
    throw new Error(`Der Schlüssel (${p.key.join(', ')}) ist im Ziel nicht eindeutig: ${doubled} doppelte Werte, z. B. ${keyText(p, example)}. Bitte andere Schlüsselspalten wählen.`);
  }
  return { seen, tCols, tPos };
}

/** Anweisungen im Ziel; Werte der Quelle in die Typen des Ziels übersetzt */
function statements(p: Plan, sCols: ResultColumn[], tCols: ResultColumn[]) {
  const dd = p.dst.dialect;
  const T = qualified(p.dst);
  const q = (n: string) => quoteIdent(dd, n);
  const numeric = (cols: ResultColumn[], name: string, c: ColumnInfo) => cols.find((x) => lower(x.name) === lower(name))?.numeric ?? NUMERIC_TYPE.test(c.dataType);
  const fromSource = (x: Pair) => valueConverter(dd, x.dst.dataType, x.src.dataType, numeric(sCols, x.src.name, x.src));
  const cmpConv = p.cmp.map(fromSource);
  const allConv = p.common.map(fromSource);
  const keyConv = p.keyPairs.map((x) => valueConverter(dd, x.dst.dataType, x.dst.dataType, numeric(tCols, x.dst.name, x.dst)));
  const cond = (q0: string, lit: string | null) => (lit === null ? `${q0} IS NULL` : `${q0} = ${lit}`);
  const identity = p.common.filter((x) => x.dst.autoIncrement);
  const insertBefore: string[] = [];
  const insertAfter: string[] = [];
  if (identity.length && dd === 'mssql') {
    insertBefore.push(`SET IDENTITY_INSERT ${T} ON;`);
    insertAfter.push(`SET IDENTITY_INSERT ${T} OFF;`);
  }
  if (identity.length && dd === 'postgres') {
    // eingefügte Werte schieben die Sequenz nicht weiter: nachziehen, sonst stoßen spätere Einfügungen auf belegte Werte
    for (const x of identity) {
      insertAfter.push(`SELECT setval(pg_get_serial_sequence(${literal(dd, T)}, ${literal(dd, x.dst.name)}), COALESCE(MAX(${q(x.dst.name)}), 0) + 1, false) FROM ${T};`);
    }
  }
  const overriding = identity.length && dd === 'postgres' ? 'OVERRIDING SYSTEM VALUE ' : '';
  const insertHead = `INSERT INTO ${T} (${p.common.map((x) => q(x.dst.name)).join(', ')}) ${overriding}VALUES (`;
  return {
    insertBefore,
    insertAfter,
    /** Quellzeile einfügen (sAll: Stellen der gemeinsamen Spalten) */
    insert: (r: ExportCell[], sAll: number[]) => insertHead + sAll.map((i, j) => allConv[j](r[i])).join(', ') + ');',
    /** Zielzeile angleichen: geänderte Spalten (Index in cmp), Schlüssel wie im Ziel */
    update: (changed: number[], s: ExportCell[], sPos: number[], d: ExportCell[], tPos: number[]) =>
      `UPDATE ${T} SET ${changed.map((j) => `${q(p.cmp[j].dst.name)} = ${cmpConv[j](s[sPos[j]])}`).join(', ')} WHERE ` +
      p.keyPairs.map((x, j) => cond(q(x.dst.name), d[tPos[j]] === null || d[tPos[j]] === undefined ? null : keyConv[j](d[tPos[j]]))).join(' AND ') +
      ';',
    /** Skript-Datei: alle verglichenen Spalten setzen, Schlüssel aus der Quelle (die Zielzeile wird nicht noch einmal gelesen) */
    updateAll: (s: ExportCell[], sPos: number[]) => {
      const set = p.cmp.slice(p.keyCount).map((x, j) => `${q(x.dst.name)} = ${cmpConv[p.keyCount + j](s[sPos[p.keyCount + j]])}`);
      if (!set.length) return '';
      return (
        `UPDATE ${T} SET ${set.join(', ')} WHERE ` +
        p.keyPairs.map((x, j) => cond(q(x.dst.name), s[sPos[j]] === null || s[sPos[j]] === undefined ? null : cmpConv[j](s[sPos[j]]))).join(' AND ') +
        ';'
      );
    },
    /** Zeile löschen, die es nur im Ziel gibt */
    del: (d: ExportCell[], tPos: number[]) =>
      `DELETE FROM ${T} WHERE ` +
      p.keyPairs.map((x, j) => cond(q(x.dst.name), d[tPos[j]] === null || d[tPos[j]] === undefined ? null : keyConv[j](d[tPos[j]]))).join(' AND ') +
      ';',
  };
}

/**
 * Vergleich einer Tabelle mit Liste und Skript. keep = so viele Zeilen je Art mit Werten (Vorgabe DIFF_LIMIT); 0 = nur
 * zählen (Übersicht eines ganzen Schemas – das Ziel wird dann nur einmal gelesen).
 */
export async function compareData(
  src: DataSide,
  dst: DataSide,
  req: DataCompareRequest,
  progress: DataCompareProgress,
  cancelled: CancelCheck,
  keep = DIFF_LIMIT,
): Promise<DataCompareResult> {
  const t0 = performance.now();
  const p = await planCompare(src, dst, req, progress);
  const first = await readTarget(p, progress, cancelled);
  const seen = first.seen;
  let tCols = first.tCols;
  let tPos = first.tPos;

  // 2. Quelle vergleichen
  interface Kept {
    status: DataDiffStatus;
    key: string;
    src?: ExportCell[];
    dst?: ExportCell[];
  }
  const kept: Kept[] = [];
  // behaltene Zeilen auch nach Größe begrenzen: 5000 Zeilen mit Dokumenten wären Gigabytes (und gingen so an die Oberfläche)
  let keptBytes = 0;
  let keptCut = false;
  const room = (...rows: (ExportCell[] | undefined)[]) => {
    for (const r of rows) if (r) keptBytes += rowBytes(r);
    if (keptBytes <= KEPT_BYTES) return true;
    keptCut = true;
    return false;
  };
  const differentByKey = new Map<string, Kept>();
  const counts: DataCompareResult['counts'] = { onlySource: 0, onlyTarget: 0, different: 0, same: 0 };
  let sCols: ResultColumn[] = [];
  let sPos: number[] = [];
  let sAll: number[] = [];
  let doubled = 0;
  let example = '';
  progress.phase = `Quelle lesen und vergleichen (${label(src)})`;
  await scan(
    src,
    req.where,
    progress,
    cancelled,
    (cols) => {
      sCols = cols;
      sPos = positions(cols, p.cmp.map((x) => x.src.name), src);
      sAll = positions(cols, p.common.map((x) => x.src.name), src);
    },
    (r) => {
      const k = keyOf(p, r, sPos, p.sKind);
      const t = seen.get(k);
      if (t === undefined) {
        seen.set(k, SOURCE_ONLY);
        // auch die nur in der Quelle vorhandenen Schlüssel zählen gegen die Grenze (sie bleiben in seen)
        if (seen.size > MAX_TARGET_ROWS) throw new Error(`Quelle und Ziel haben zusammen mehr als ${MAX_TARGET_ROWS.toLocaleString('de-CH')} verschiedene Schlüssel – bitte mit einer WHERE-Bedingung einschränken.`);
        if (counts.onlySource++ < keep && room(r)) kept.push({ status: 'onlySource', key: k, src: r });
      } else if (t === SOURCE_ONLY || t === SAME || t === DIFFERENT) {
        doubled++;
        example ||= k;
      } else if (t === hashOf(p, r, sPos, p.sKind)) {
        seen.set(k, SAME);
        counts.same++;
      } else {
        seen.set(k, DIFFERENT);
        if (counts.different++ < keep && room(r)) {
          const item: Kept = { status: 'different', key: k, src: r };
          kept.push(item);
          differentByKey.set(k, item);
        }
      }
    },
  );
  if (doubled) {
    throw new Error(`Der Schlüssel (${p.key.join(', ')}) ist in der Quelle nicht eindeutig: ${doubled} doppelte Werte, z. B. ${keyText(p, example)}. Bitte andere Schlüsselspalten wählen.`);
  }
  // übrig: Zeilen, die es nur im Ziel gibt
  const need = new Set(differentByKey.keys());
  for (const [k, v] of seen) {
    if (v === SOURCE_ONLY || v === SAME || v === DIFFERENT) continue;
    if (counts.onlyTarget++ < keep) need.add(k);
  }
  seen.clear();

  // 3. Ziel noch einmal: alte Werte der Unterschiede und die Zeilen, die nur dort stehen
  if (need.size) {
    progress.phase = 'Ziel: Werte der Unterschiede holen';
    await scan(
      dst,
      req.where,
      progress,
      cancelled,
      (cols) => {
        tCols = cols;
        tPos = positions(cols, p.cmp.map((x) => x.dst.name), dst);
      },
      (r) => {
        const k = keyOf(p, r, tPos, p.tKind);
        if (!need.delete(k)) return;
        const d = differentByKey.get(k);
        if (d) d.dst = r;
        else if (room(r)) kept.push({ status: 'onlyTarget', key: k, dst: r });
        if (!need.size) return false;
      },
    );
  }
  progress.phase = 'Skript erstellen';

  const st = statements(p, sCols, tCols);
  const show = (r: ExportCell[], pos: number[]): Cell[] => pos.map((i) => normalizeCell(r[i]));
  const rows: (DataDiffRow & { k: (string | null)[] })[] = [];
  const warnings = [...p.warnings];
  if (keptCut) warnings.push(`Nicht alle Unterschiede aufgelistet: die behaltenen Zeilen überschreiten ${Math.round(KEPT_BYTES / 1024 / 1024)} MB – die Zählung stimmt, für das vollständige Skript „Skript als Datei“ nehmen.`);
  let vanished = 0;
  for (const it of kept) {
    const k = JSON.parse(it.key) as (string | null)[];
    if (it.status === 'onlySource') {
      rows.push({ k, status: 'onlySource', source: show(it.src!, sPos), sql: st.insert(it.src!, sAll) });
    } else if (it.status === 'onlyTarget') {
      rows.push({ k, status: 'onlyTarget', target: show(it.dst!, tPos), sql: st.del(it.dst!, tPos) });
    } else {
      // zwischen den Durchgängen im Ziel gelöscht oder angeglichen: nicht mehr aufführen
      if (!it.dst) {
        vanished++;
        continue;
      }
      const s = it.src!;
      const d = it.dst;
      const changed: number[] = [];
      for (let j = p.keyCount; j < p.cmp.length; j++) if (canon(s[sPos[j]], p.sKind[j], p.o) !== canon(d[tPos[j]], p.tKind[j], p.o)) changed.push(j);
      if (!changed.length) {
        vanished++;
        continue;
      }
      rows.push({ k, status: 'different', source: show(s, sPos), target: show(d, tPos), changed, sql: st.update(changed, s, sPos, d, tPos) });
    }
  }
  if (vanished) warnings.push(`${vanished} Zeile(n) haben sich während des Vergleichs im Ziel geändert und fehlen in der Liste – bitte neu vergleichen.`);
  rows.sort((a, b) => compareKeys(a.k, b.k));

  const columns: ResultColumn[] = p.cmp.map((x) => {
    const c = sCols.find((y) => lower(y.name) === lower(x.src.name));
    return { name: x.src.name, typeName: x.src.dataType, numeric: c?.numeric ?? NUMERIC_TYPE.test(x.src.dataType) };
  });
  if (keep > 0) {
    for (const [what, n] of [
      ['fehlen im Ziel', counts.onlySource],
      ['gibt es nur im Ziel', counts.onlyTarget],
      ['sind unterschiedlich', counts.different],
    ] as const) {
      if (n > keep) warnings.push(`${n.toLocaleString('de-CH')} Zeilen ${what} – Liste und Skript zeigen die ersten ${keep.toLocaleString('de-CH')}; „Skript als Datei“ schreibt alle.`);
    }
  }
  return {
    dialect: dst.dialect,
    columns,
    key: p.keyPairs.map((x) => x.src.name),
    counts,
    rows: rows.map(({ k: _k, ...r }) => r),
    limit: keep,
    insertBefore: counts.onlySource ? st.insertBefore : [],
    insertAfter: counts.onlySource ? st.insertAfter : [],
    warnings,
    durationMs: Math.round(performance.now() - t0),
  };
}

// ---------- ganzes Schema ----------

export interface SchemaSide {
  driver: MetaDriver;
  dialect: Dialect;
  database: string;
  schema: string;
}

/** Tabellen auf beiden Seiten (Name ohne Groß/klein), dazu die nur auf einer Seite */
export async function tablePairs(
  src: SchemaSide,
  dst: SchemaSide,
  only?: string[],
): Promise<{ pairs: { source: string; target: string }[]; onlySource: string[]; onlyTarget: string[] }> {
  const [s, t] = await Promise.all([src.driver.listObjects(src.database, src.schema), dst.driver.listObjects(dst.database, dst.schema)]);
  const sNames = s.filter((o) => o.kind === 'table').map((o) => o.name);
  const tNames = t.filter((o) => o.kind === 'table').map((o) => o.name);
  const byLower = new Map(tNames.map((n) => [lower(n), n]));
  const wanted = only?.length ? new Set(only.map(lower)) : null;
  const pairs = sNames
    .filter((n) => byLower.has(lower(n)) && (!wanted || wanted.has(lower(n))))
    .sort((a, b) => a.localeCompare(b, 'de'))
    .map((n) => ({ source: n, target: byLower.get(lower(n))! }));
  const sLower = new Set(sNames.map(lower));
  return {
    pairs,
    onlySource: wanted ? [] : sNames.filter((n) => !byLower.has(lower(n))).sort((a, b) => a.localeCompare(b, 'de')),
    onlyTarget: wanted ? [] : tNames.filter((n) => !sLower.has(lower(n))).sort((a, b) => a.localeCompare(b, 'de')),
  };
}

/**
 * alle Tabellen eines Schemas vergleichen (nur zählen); eine Tabelle ohne Schlüssel o. Ä. hält die übrigen nicht auf.
 * Schlüssel je Tabelle: gewählt (req.keys), sonst Primärschlüssel bzw. eindeutiger Index.
 */
export async function compareSchemaData(
  src: SchemaSide,
  dst: SchemaSide,
  req: DataCompareAllRequest,
  progress: DataCompareProgress,
  cancelled: CancelCheck,
): Promise<DataCompareAllResult> {
  const t0 = performance.now();
  progress.phase = 'Tabellen lesen';
  const { pairs, onlySource, onlyTarget } = await tablePairs(src, dst, req.tables);
  const tables: DataCompareAllResult['tables'] = [];
  for (const [i, pr] of pairs.entries()) {
    if (cancelled()) throw new Error('Abgebrochen.');
    const one: DataCompareProgress = { phase: '', rows: 0 };
    const before = progress.rows;
    const t1 = performance.now();
    const at = `${i + 1}/${pairs.length} ${pr.source}`;
    // Fortschritt der einzelnen Tabelle durchreichen
    const live = setInterval(() => {
      progress.phase = `${at}: ${one.phase}`;
      progress.rows = before + one.rows;
    }, 200);
    try {
      progress.phase = at;
      const r = await compareData(
        { ...src, table: pr.source },
        { ...dst, table: pr.target },
        {
          source: { connectionId: '', database: src.database, schema: src.schema, table: pr.source },
          target: { connectionId: '', database: dst.database, schema: dst.schema, table: pr.target },
          // nur eigene Einträge: eine Tabelle „constructor“ träfe sonst Object.prototype
          key: req.keys && Object.hasOwn(req.keys, pr.source) ? req.keys[pr.source] : undefined,
          ignoreCase: req.ignoreCase,
          ignoreTrailingSpaces: req.ignoreTrailingSpaces,
        },
        one,
        cancelled,
        0,
      );
      tables.push({ source: pr.source, target: pr.target, key: r.key, counts: r.counts, warnings: r.warnings, durationMs: Math.round(performance.now() - t1) });
    } catch (e) {
      if (cancelled()) throw e;
      tables.push({
        source: pr.source,
        target: pr.target,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof NoKeyError ? { noKey: true } : {}),
        warnings: [],
        durationMs: Math.round(performance.now() - t1),
      });
    } finally {
      clearInterval(live);
      progress.rows = before + one.rows;
    }
  }
  return { dialect: dst.dialect, tables, onlySource, onlyTarget, durationMs: Math.round(performance.now() - t0) };
}

// ---------- Abgleich-Skript als Datei ----------

/**
 * Auf 'drain' warten – oder auf 'error'/'close': ein zerstörter Strom (Platte voll, Laufwerk weg) liefert kein 'drain'
 * mehr, der Aufrufer hinge sonst für immer (mitsamt Cursor, Pool-Verbindung und Abbrechen).
 */
function waitDrain(stream: WriteStream, failure: () => Error | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (e?: Error) => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
      if (e) reject(e);
      else resolve();
    };
    const onDrain = () => done();
    const onError = (e: Error) => done(e);
    const onClose = () => done(failure() ?? new Error('Die Datei wurde geschlossen.'));
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

/** Text in eine temporäre Datei, mit Gegendruck; später an die eigentliche Datei angehängt */
class Spool {
  private out: WriteStream;
  private failure?: Error;
  lines = 0;

  /** goEvery: SQL Server – alle so viele Anweisungen ein GO, damit das Einspielen die Datei stückweise schickt */
  constructor(
    readonly file: string,
    private goEvery = 0,
  ) {
    this.out = createWriteStream(file, { encoding: 'utf8' });
    this.out.on('error', (e) => (this.failure = e));
  }

  write(s: string): Promise<void> | void {
    if (this.failure) throw this.failure;
    this.lines++;
    const go = this.goEvery && this.lines % this.goEvery === 0 ? '\nGO' : '';
    if (!this.out.write(s + go + '\n')) return waitDrain(this.out, () => this.failure);
  }

  async close(): Promise<void> {
    if (this.failure) {
      this.out.destroy();
      throw this.failure;
    }
    await new Promise<void>((resolve, reject) => this.out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (this.failure) throw this.failure;
  }
}

/** Tabellen so ordnen, dass jede nach denen kommt, auf die sie verweist (Kreise: in Namensreihenfolge aufgelöst) */
function fkOrder<T extends { name: string; refs: string[] }>(list: T[]): T[] {
  const byName = new Map(list.map((x) => [lower(x.name), x]));
  const out: T[] = [];
  const state = new Map<T, 'busy' | 'done'>();
  const visit = (x: T) => {
    if (state.get(x)) return;
    state.set(x, 'busy');
    for (const r of x.refs) {
      const dep = byName.get(lower(r));
      if (dep && dep !== x && !state.get(dep)) visit(dep);
    }
    state.set(x, 'done');
    out.push(x);
  };
  for (const x of list) visit(x);
  return out;
}

export interface ScriptTable {
  src: DataSide;
  dst: DataSide;
  req: DataCompareRequest;
}

export interface ScriptSummary {
  tables: { table: string; inserts: number; updates: number; deletes: number; error?: string }[];
  statements: number;
}

/**
 * Abgleich-Skript ohne Obergrenze in eine Datei: je Tabelle die Unterschiede zählen und die Anweisungen sofort in
 * temporäre Dateien schreiben (nichts davon bleibt im Speicher), am Ende zusammensetzen – erst alle Löschungen (Tabellen,
 * die verweisen, zuerst), dann je Tabelle Änderungen und Einfügungen (Tabellen, auf die verwiesen wird, zuerst).
 * UPDATE setzt hier alle verglichenen Spalten (die Zielzeile wird nicht ein zweites Mal gelesen).
 */
export async function writeDataScript(
  list: ScriptTable[],
  file: string,
  opts: { includeDeletes: boolean; header: string[] },
  progress: DataCompareProgress,
  cancelled: CancelCheck,
): Promise<ScriptSummary> {
  const dir = path.join(os.tmpdir(), `owlyndb-abgleich-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  progress.statements = 0;
  try {
    interface Done {
      name: string;
      refs: string[];
      plan?: Plan;
      inserts: number;
      updates: number;
      deletes: number;
      error?: string;
      before: string[];
      after: string[];
      del?: Spool;
      upd?: Spool;
      ins?: Spool;
      notes: string[];
    }
    const done: Done[] = [];
    for (const [i, t] of list.entries()) {
      if (cancelled()) throw new Error('Abgebrochen.');
      const at = list.length > 1 ? `${i + 1}/${list.length} ${t.src.table}: ` : '';
      const d: Done = { name: t.dst.table, refs: [], inserts: 0, updates: 0, deletes: 0, before: [], after: [], notes: [] };
      done.push(d);
      const one: DataCompareProgress = { phase: '', rows: 0 };
      const before = progress.rows;
      const live = setInterval(() => {
        progress.phase = at + one.phase;
        progress.rows = before + one.rows;
      }, 200);
      try {
        const p = await planCompare(t.src, t.dst, t.req, one);
        d.plan = p;
        d.refs = p.target.foreignKeys.map((f) => f.refTable);
        d.notes.push(...p.warnings);
        if ((p.o.ignoreCase || p.o.trailing) && p.sKind.slice(0, p.keyCount).some((k) => k === 'other')) {
          d.notes.push('Schlüssel mit Text und „Groß/klein egal“ bzw. „Leerzeichen egal“: UPDATE nennt den Schlüssel, wie er in der Quelle steht.');
        }
        const { seen, tCols } = await readTarget(p, one, cancelled);
        let st: ReturnType<typeof statements> | undefined;
        let sPos: number[] = [];
        let sAll: number[] = [];
        const spool = (kind: 'del' | 'upd' | 'ins') => (d[kind] ??= new Spool(path.join(dir, `${i}-${kind}.sql`), t.dst.dialect === 'mssql' ? GO_EVERY : 0));
        one.phase = `Quelle lesen und Skript schreiben (${label(t.src)})`;
        await scan(
          t.src,
          t.req.where,
          one,
          cancelled,
          (cols) => {
            sPos = positions(cols, p.cmp.map((x) => x.src.name), t.src);
            sAll = positions(cols, p.common.map((x) => x.src.name), t.src);
            st = statements(p, cols, tCols);
            d.before = st.insertBefore;
            d.after = st.insertAfter;
          },
          (r) => {
            const k = keyOf(p, r, sPos, p.sKind);
            const v = seen.get(k);
            if (v === undefined) {
              seen.set(k, SOURCE_ONLY);
              if (seen.size > MAX_TARGET_ROWS) throw new Error(`Quelle und Ziel haben zusammen mehr als ${MAX_TARGET_ROWS.toLocaleString('de-CH')} verschiedene Schlüssel – bitte mit einer WHERE-Bedingung einschränken.`);
              d.inserts++;
              progress.statements!++;
              return spool('ins').write(st!.insert(r, sAll));
            }
            if (v === SOURCE_ONLY || v === SAME || v === DIFFERENT) throw new Error(`Der Schlüssel (${p.key.join(', ')}) ist in der Quelle nicht eindeutig, z. B. ${keyText(p, k)}.`);
            if (v === hashOf(p, r, sPos, p.sKind)) {
              seen.set(k, SAME);
              return;
            }
            seen.set(k, DIFFERENT);
            const sql = st!.updateAll(r, sPos);
            if (!sql) return;
            d.updates++;
            progress.statements!++;
            return spool('upd').write(sql);
          },
        );
        // Zeilen nur im Ziel: ein zweites Mal das Ziel lesen, für das DELETE mit den Werten des Ziels
        let left = 0;
        for (const v of seen.values()) if (v !== SOURCE_ONLY && v !== SAME && v !== DIFFERENT) left++;
        if (left) {
          one.phase = 'Ziel: Zeilen holen, die nur dort stehen';
          let tPos: number[] = [];
          await scan(
            t.dst,
            t.req.where,
            one,
            cancelled,
            (cols) => {
              tPos = positions(cols, p.cmp.map((x) => x.dst.name), t.dst);
              st ??= statements(p, [], cols);
            },
            (r) => {
              const k = keyOf(p, r, tPos, p.tKind);
              const v = seen.get(k);
              if (v === undefined || v === SOURCE_ONLY || v === SAME || v === DIFFERENT) return;
              seen.delete(k);
              d.deletes++;
              progress.statements!++;
              const sql = st!.del(r, tPos);
              // auskommentiert: jede Zeile einzeln – ein Schlüsselwert mit Zeilenumbruch machte sonst den Rest zu lebendigem SQL
              const x = spool('del').write(opts.includeDeletes ? sql : commentOut(sql));
              if (!--left) return x ?? false;
              return x;
            },
          );
        }
        seen.clear();
      } catch (e) {
        if (cancelled()) throw e;
        d.error = e instanceof Error ? e.message : String(e);
      } finally {
        clearInterval(live);
        progress.rows = before + one.rows;
        // jede Zwischendatei schließen, auch wenn eine davon scheitert (sonst blieben Handles bis zum Programmende offen)
        for (const s of [d.del, d.upd, d.ins]) {
          try {
            await s?.close();
          } catch (e) {
            d.error ??= `Zwischendatei nicht geschrieben: ${errorText(e)}`;
          }
        }
      }
    }

    // zusammensetzen
    progress.phase = 'Datei schreiben';
    const out = createWriteStream(file, { encoding: 'utf8' });
    let failure: Error | undefined;
    out.on('error', (e) => (failure = e));
    const put = async (s: string) => {
      if (failure) throw failure;
      if (!out.write(s)) await waitDrain(out, () => failure);
      if (failure) throw failure;
    };
    // als Text lesen: ein Buffer-Block könnte mitten in einem Mehrbyte-Zeichen enden, einzeln dekodiert würde es zerstört
    const append = async (s: Spool) => {
      for await (const chunk of createReadStream(s.file, { encoding: 'utf8' })) {
        if (cancelled()) throw new Error(ABORTED);
        await put(chunk as string);
      }
    };
    // Namen und Hinweise aus der Datenbank in Kommentarzeilen: ohne Zeilenumbrüche, sonst wäre der Rest SQL
    const line = (s: string) => `-- ${commentText(s)}\n`;
    try {
      const dialect = list[0]?.dst.dialect;
      // Tabellen mit Fehler: nichts davon ins Skript (ihre halb geschriebenen Teile fallen weg)
      for (const x of done) {
        if (!x.error) continue;
        x.del = x.upd = x.ins = undefined;
        x.inserts = x.updates = x.deletes = 0;
      }
      const order = fkOrder(done);
      const sum = (k: 'inserts' | 'updates' | 'deletes') => done.reduce((n, x) => n + x[k], 0);
      await put(
        opts.header.map(line).join('') +
          `-- ${sum('deletes')} löschen${opts.includeDeletes ? '' : ' (auskommentiert)'}, ${sum('updates')} ändern, ${sum('inserts')} einfügen` +
          (list.length > 1 ? ` in ${done.filter((x) => x.inserts + x.updates + x.deletes).length} von ${list.length} Tabellen` : '') +
          '\n',
      );
      for (const x of done) {
        if (x.error) await put(line(`${x.name}: übersprungen – ${x.error.replace(/\s+/g, ' ')}`));
        for (const n of x.notes) await put(line(`Hinweis ${x.name}: ${n}`));
      }
      const any = sum('inserts') + sum('updates') + sum('deletes') > 0;
      // MySQL: Fremdschlüssel während des Abgleichs nicht prüfen (Reihenfolge und Kreise egal); eine Transaktion, weil das
      // Einspielen bei MySQL sonst jede Zeile einzeln festschreibt (langsam, und ein Fehler hinterließe einen halben Abgleich)
      if (dialect === 'mysql' && list.length > 1) await put('\nSET FOREIGN_KEY_CHECKS = 0;\n');
      if (dialect === 'mysql' && any) await put('\nSTART TRANSACTION;\n');
      // SQL Server: GO trennt die Abschnitte (und alle GO_EVERY Anweisungen in den Zwischendateien) – ohne GO läse das
      // Einspielen die ganze Datei als einen Batch
      const go = dialect === 'mssql' ? 'GO\n' : '';
      for (const x of [...order].reverse()) {
        if (!x.del) continue;
        if (cancelled()) throw new Error(ABORTED);
        await put('\n' + line(`Löschen: ${x.name}, ${x.deletes} Zeile(n), die es nur im Ziel gibt${opts.includeDeletes ? '' : ' – auskommentiert'}`));
        await append(x.del);
        await put(go);
      }
      for (const x of order) {
        if (cancelled()) throw new Error(ABORTED);
        if (x.upd) {
          await put('\n' + line(`Ändern: ${x.name}, ${x.updates} Zeile(n)`));
          await append(x.upd);
          await put(go);
        }
        if (x.ins) {
          await put('\n' + line(`Einfügen: ${x.name}, ${x.inserts} Zeile(n), die im Ziel fehlen`));
          for (const l of x.before) await put(l + '\n');
          if (x.before.length) await put(go);
          await append(x.ins);
          await put(go);
          for (const l of x.after) await put(l + '\n');
          if (x.after.length) await put(go);
        }
      }
      if (dialect === 'mysql' && any) await put('\nCOMMIT;\n');
      if (dialect === 'mysql' && list.length > 1) await put('\nSET FOREIGN_KEY_CHECKS = 1;\n');
      if (!any) await put('\n-- keine Unterschiede\n');
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      if (failure) throw failure;
      return {
        tables: done.map((x) => ({ table: x.name, inserts: x.inserts, updates: x.updates, deletes: x.deletes, ...(x.error ? { error: x.error } : {}) })),
        statements: sum('inserts') + sum('updates') + sum('deletes'),
      };
    } catch (e) {
      // Datei schließen, bevor der Aufrufer sie löscht (unter Windows bliebe sie sonst „Löschen ausstehend“)
      await new Promise<void>((resolve) => {
        if (out.closed) return resolve();
        out.once('close', () => resolve());
        out.destroy();
      });
      throw e;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

