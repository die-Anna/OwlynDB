/*
 * Ausführungspläne der Datenbanken in einen gemeinsamen Baum übersetzen, mit Anteilen und Hinweisen.
 * Reine Funktionen ohne Datenbank, damit sie sich mit festen Beispielen prüfen lassen.
 *
 * MySQL 8: EXPLAIN FORMAT=TREE bzw. EXPLAIN ANALYZE (Text), sonst FORMAT=JSON; MariaDB: EXPLAIN/ANALYZE FORMAT=JSON;
 * PostgreSQL: EXPLAIN (FORMAT JSON); SQL Server: Showplan-XML (SHOWPLAN_XML bzw. STATISTICS XML).
 */
import type { PlanNode, StatementPlan } from '../shared/api-types';

/** Zwischenstand je Schritt; die Felder ohne Gegenstück in PlanNode braucht nur die Berechnung hier */
interface Draft {
  op: string;
  detail?: string;
  rows?: number;
  actualRows?: number;
  loops?: number;
  /** wie gemeldet (PostgreSQL/MySQL-Baum: je Durchlauf, mit den Schritten darunter) */
  cost?: number;
  /** so oft läuft der Schritt laut Schätzung je Lauf des Elternschritts (innere Seite einer Nested Loop) */
  estLoops?: number;
  /** eigene Kosten, wenn die Datenbank sie direkt meldet (MySQL/MariaDB-JSON je Tabelle) */
  selfCost?: number;
  /** Zeit mit den Schritten darunter, über alle Durchläufe */
  timeMs?: number;
  /** eigene Zeit, wenn die Datenbank sie direkt meldet (MariaDB, SQL Server im Batch-Modus) */
  selfMs?: number;
  /** Zeilen, die ein Lesen der ganzen Tabelle anfasst (je Durchlauf) */
  scanRows?: number;
  /** PostgreSQL: CTE Scan liest diese CTE (ihre Zeit steckt in der eigenen) bzw. InitPlan, der diese CTE berechnet */
  cteScan?: string;
  cteInit?: string;
  warnings: string[];
  props: [string, string][];
  children: Draft[];
}

/**
 * Schritte, die früh aufhören: ihre Kinder liefern weniger Zeilen als geschätzt, ohne dass die Statistik schlecht wäre.
 * „Semi Join“ (PostgreSQL, SQL Server) auch zusammengeschrieben (MySQL: „Nested loop semijoin“, „Hash antijoin“)
 */
const EARLY_STOP = /\b(Limit|Top|Semi ?Join|Anti ?Join|Merge Join)\b/i;

function draft(op: string): Draft {
  return { op, warnings: [], props: [], children: [] };
}

/** ab so vielen gelesenen Zeilen wird ein Lesen der ganzen Tabelle erwähnt */
export const SCAN_WARN_ROWS = 10_000;

const intFmt = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

function rowsText(n: number): string {
  return n < 10 && !Number.isInteger(n) ? String(Math.round(n * 10) / 10) : intFmt.format(n);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function sum(...v: (number | undefined)[]): number | undefined {
  const known = v.filter((x): x is number => x !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Schätzung und Wirklichkeit liegen weit auseinander (meist veraltete Statistiken). Unter einem Schritt, der früh aufhört
 * (Limit, Top, Semi/Anti-Join, Merge Join), zählt nur „zu niedrig“: weniger Zeilen als geschätzt heißt dort nur, dass der
 * Lauf abgebrochen wurde
 */
function misestimate(d: Draft, early: boolean): string | null {
  if (d.rows === undefined || d.actualRows === undefined || !d.loops) return null;
  const est = d.rows;
  const act = d.actualRows;
  if (early && act < est) return null;
  const ratio = (Math.max(est, act) + 1) / (Math.min(est, act) + 1);
  if (ratio < 10 || Math.max(est, act) * d.loops < 100) return null;
  const f = intFmt.format(Math.round(ratio));
  return act > est
    ? `Schätzung zu niedrig: ${rowsText(est)} statt ${rowsText(act)} Zeilen (${f}×)`
    : `Schätzung zu hoch: ${rowsText(est)} statt ${rowsText(act)} Zeilen (${f}×)`;
}

/**
 * Eigene Kosten bzw. Zeiten (ohne die Schritte darunter) berechnen, Anteile und Hinweise setzen.
 * Anteil nach Zeit, wenn mit Laufzeit und Zeiten bekannt; sonst nach geschätzten Kosten.
 */
function finish(root: Draft, analyzed: boolean): { root: PlanNode; shareBy?: 'time' | 'cost' } {
  /** eigene Kosten/Zeit und Zeit mit den Schritten darunter (falls irgendwo darin Zeiten bekannt sind) */
  const own = new Map<Draft, { cost?: number; ms?: number; inclMs?: number }>();
  const walk = (d: Draft, mult: number): { cost: number; ms: number; timed: boolean } => {
    const m = mult * (d.estLoops ?? 1);
    let kidCost = 0;
    let kidMs = 0;
    let timed = d.timeMs !== undefined || d.selfMs !== undefined;
    for (const c of d.children) {
      const r = walk(c, m);
      kidCost += r.cost;
      kidMs += r.ms;
      timed ||= r.timed;
    }
    let cost: number | undefined;
    let inclCost: number;
    if (d.selfCost !== undefined) {
      cost = d.selfCost;
      inclCost = d.selfCost + kidCost;
    } else if (d.cost !== undefined) {
      inclCost = d.cost * m;
      cost = Math.max(0, inclCost - kidCost);
    } else inclCost = kidCost;
    let ms: number | undefined;
    let inclMs: number;
    if (d.selfMs !== undefined) {
      ms = d.selfMs;
      inclMs = d.timeMs ?? d.selfMs + kidMs;
    } else if (d.timeMs !== undefined) {
      inclMs = d.timeMs;
      ms = Math.max(0, d.timeMs - kidMs);
    } else inclMs = kidMs;
    own.set(d, { cost, ms, inclMs: timed ? inclMs : undefined });
    return { cost: inclCost, ms: inclMs, timed };
  };
  walk(root, 1);
  let totalMs = 0;
  let totalCost = 0;
  for (const v of own.values()) {
    totalMs += v.ms ?? 0;
    totalCost += v.cost ?? 0;
  }
  const shareBy = analyzed && totalMs > 0 ? 'time' : totalCost > 0 ? 'cost' : undefined;
  const total = shareBy === 'time' ? totalMs : totalCost;
  const out = (d: Draft, early = false): PlanNode => {
    const o = own.get(d)!;
    const below = early || EARLY_STOP.test(d.op);
    const node: PlanNode = { op: d.op, warnings: [...d.warnings], props: d.props, children: d.children.map((c) => out(c, below)) };
    if (d.detail) node.detail = d.detail;
    if (d.rows !== undefined) node.rows = d.rows;
    if (d.actualRows !== undefined) node.actualRows = d.actualRows;
    if (d.loops !== undefined) node.loops = d.loops;
    if (d.cost !== undefined) node.cost = d.cost;
    if (o.inclMs !== undefined) node.timeMs = o.inclMs;
    if (o.ms !== undefined) node.selfMs = o.ms;
    const part = shareBy === 'time' ? o.ms : shareBy === 'cost' ? o.cost : undefined;
    if (part !== undefined) node.share = part / total;
    const mis = misestimate(d, early);
    if (mis) node.warnings.unshift(mis);
    if (d.scanRows !== undefined && d.scanRows >= SCAN_WARN_ROWS) node.warnings.push(`Liest die ganze Tabelle (${intFmt.format(d.scanRows)} Zeilen)`);
    return node;
  };
  return { root: out(root), shareBy };
}

function statement(sql: string, root: Draft, analyzed: boolean, extra: Omit<StatementPlan, 'sql' | 'root' | 'shareBy'>): StatementPlan {
  const f = finish(root, analyzed);
  const plan: StatementPlan = { sql, root: f.root, ...extra };
  if (f.shareBy) plan.shareBy = f.shareBy;
  return plan;
}

function propText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(propText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ---------------------------------------------------------------- PostgreSQL ---- */

type Rec = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

const PG_AGGREGATE: Record<string, string> = { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Mixed: 'MixedAggregate' };

function pgOp(p: Rec): string {
  const t = str(p['Node Type']);
  const jt = str(p['Join Type']);
  let op = t;
  if (t === 'Aggregate') op = PG_AGGREGATE[str(p['Strategy'])] ?? 'Aggregate';
  else if (t === 'ModifyTable') op = str(p['Operation']) || t;
  else if (t === 'SetOp') op = `${p['Strategy'] === 'Hashed' ? 'HashSetOp' : 'SetOp'} ${str(p['Command'])}`.trim();
  else if ((t === 'Nested Loop' || t === 'Hash Join' || t === 'Merge Join') && jt && jt !== 'Inner') {
    op = t === 'Nested Loop' ? `Nested Loop ${jt} Join` : t.replace(' Join', ` ${jt} Join`);
  }
  const partial = str(p['Partial Mode']);
  if (partial && partial !== 'Simple') op = `${partial} ${op}`;
  if (p['Parallel Aware'] === true) op = 'Parallel ' + op;
  return op;
}

function pgDetail(p: Rec): string | undefined {
  const target: string[] = [];
  if (p['Index Name']) target.push(`using ${str(p['Index Name'])}`);
  const rel = str(p['Relation Name']);
  const alias = str(p['Alias']);
  if (rel) target.push(`on ${p['Schema'] ? str(p['Schema']) + '.' : ''}${rel}${alias && alias !== rel ? ' ' + alias : ''}`);
  else if (p['CTE Name']) target.push(`on ${str(p['CTE Name'])}${alias && alias !== p['CTE Name'] ? ' ' + alias : ''}`);
  else if (p['Function Name']) target.push(`on ${str(p['Function Name'])}${alias && alias !== p['Function Name'] ? ' ' + alias : ''}`);
  else if (alias) target.push(`on ${alias}`);
  const parts: string[] = [];
  if (p['Subplan Name']) parts.push(str(p['Subplan Name']));
  if (target.length) parts.push(target.join(' '));
  const keys = ['Index Cond', 'Hash Cond', 'Merge Cond', 'Recheck Cond', 'Join Filter', 'Filter', 'Sort Key', 'Group Key'];
  const cond = keys.map((k) => p[k]).find((v) => v !== undefined && v !== '');
  if (cond !== undefined) parts.push(propText(cond));
  if (p['Actual Loops'] === 0) parts.push('nie ausgeführt');
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * parallel = Teilnehmer (Worker plus Leader) unter einem Gather: dort sind Zeit und Zeilen je Teilnehmer gemittelt und
 * „Actual Loops“ ist ihre Anzahl – Zeit × Loops wäre die Summe der CPU-Zeiten, nicht die Wanduhrzeit
 */
function pgNode(p: Rec, analyzed: boolean, parallel = 1): Draft {
  const type = str(p['Node Type']);
  const d = draft(pgOp(p));
  d.detail = pgDetail(p);
  d.rows = num(p['Plan Rows']);
  d.cost = num(p['Total Cost']);
  if (type === 'CTE Scan') d.cteScan = str(p['CTE Name']);
  const sub = str(p['Subplan Name']);
  if (p['Parent Relationship'] === 'InitPlan' && /^CTE /.test(sub)) d.cteInit = sub.slice(4);
  if (analyzed && p['Actual Loops'] !== undefined) {
    d.loops = num(p['Actual Loops']) ?? 0;
    d.actualRows = num(p['Actual Rows']) ?? 0;
    d.timeMs = ((num(p['Actual Total Time']) ?? 0) * d.loops) / parallel;
    const removed = num(p['Rows Removed by Filter']) ?? 0;
    // Parallel Seq Scan: Zeilen je Teilnehmer gemittelt, die ganze Tabelle ist das Vielfache
    if (type === 'Seq Scan') d.scanRows = (d.actualRows + removed) * (parallel > 1 ? d.loops : 1);
    else if (removed * d.loops >= SCAN_WARN_ROWS && removed >= 9 * d.actualRows) {
      d.warnings.push(`Filter verwirft ${Math.round((removed / (removed + d.actualRows)) * 100)} % der gelesenen Zeilen (${intFmt.format(removed * d.loops)})`);
    }
    if (/external/i.test(str(p['Sort Method'])) || p['Sort Space Type'] === 'Disk') {
      d.warnings.push(`Sortiert auf der Platte (${propText(p['Sort Space Used'])} kB) – work_mem reicht nicht`);
    }
    const batches = num(p['Hash Batches']) ?? num(p['HashAgg Batches']);
    if (batches && batches > 1) d.warnings.push(`Hash in ${batches} Teilen – work_mem reicht nicht`);
  }
  for (const [k, v] of Object.entries(p)) {
    if (k === 'Plans' || v === false || (/Blocks$/.test(k) && v === 0)) continue;
    d.props.push([k, propText(v)]);
  }
  const kids = (Array.isArray(p['Plans']) ? p['Plans'] : []) as Rec[];
  const outer = kids.find((k) => k['Parent Relationship'] === 'Outer');
  // unter Gather/Gather Merge: Worker plus Leader
  const below = /^Gather/.test(type) ? (num(p['Workers Launched']) ?? num(p['Workers Planned']) ?? 0) + 1 : parallel;
  for (const k of kids) {
    const c = pgNode(k, analyzed, below);
    const rel = k['Parent Relationship'];
    // Kosten der inneren Seite gelten je Durchlauf (Materialize/Memoize: Wiederholungen sind billig)
    if (type === 'Nested Loop' && rel === 'Inner' && !/^(Materialize|Memoize)$/.test(str(k['Node Type']))) c.estLoops = Math.max(1, num(outer?.['Plan Rows']) ?? 1);
    else if (rel === 'SubPlan') {
      // ein „hashed SubPlan“ (IN/NOT IN (SELECT …)) läuft einmal, nicht je Zeile
      const name = str(k['Subplan Name']);
      const hashed = !!name && Object.values(p).some((v) => typeof v === 'string' && v.includes(`hashed ${name}`));
      c.estLoops = hashed ? 1 : Math.max(1, num(p['Plan Rows']) ?? 1);
    }
    d.children.push(c);
  }
  return d;
}

/**
 * CTE-Zeit nur einmal: der erste CTE Scan führt die CTE selbst aus, ihr InitPlan hängt zusätzlich als Kind am Elternknoten.
 * Die Zeit gehört dem InitPlan: sie wird beim CTE Scan und bei allen Schritten dazwischen bis unter den Elternknoten des
 * InitPlans abgezogen – sonst bliebe sie z. B. im Hash Join darüber stehen (als dessen eigene Zeit) und zählte doppelt
 */
function dedupeCte(root: Draft): void {
  const init = new Map<string, { ms: number; parent: Draft }>();
  const collect = (d: Draft) => {
    for (const c of d.children) {
      if (c.cteInit !== undefined && c.timeMs !== undefined) init.set(c.cteInit, { ms: c.timeMs, parent: d });
      collect(c);
    }
  };
  collect(root);
  const seen = new Set<string>();
  const fix = (d: Draft, path: Draft[]) => {
    if (d.cteScan !== undefined && !seen.has(d.cteScan) && d.timeMs !== undefined) {
      seen.add(d.cteScan);
      const i = init.get(d.cteScan);
      if (i) {
        const at = path.indexOf(i.parent);
        // liegt der Elternknoten des InitPlans nicht darüber (ungewöhnlicher Plan): nur der CTE Scan
        for (const x of at >= 0 ? [...path.slice(at + 1), d] : [d]) {
          if (x.timeMs !== undefined) x.timeMs = Math.max(0, x.timeMs - i.ms);
        }
      }
    }
    for (const c of d.children) fix(c, [...path, d]);
  };
  fix(root, []);
}

/** Ergebnis von EXPLAIN (FORMAT JSON …); json = die eine Zelle der Antwort (Array mit einem Objekt) */
export function postgresPlan(sql: string, json: unknown, analyzed: boolean): StatementPlan {
  const raw = JSON.stringify(json, null, 2);
  const top = (Array.isArray(json) ? json[0] : json) as Rec | undefined;
  const p = top?.['Plan'] as Rec | undefined;
  if (!p) return { sql, error: 'PostgreSQL hat keinen Plan geliefert.', notes: [], raw, rawFormat: 'json' };
  const notes: string[] = [];
  for (const t of (Array.isArray(top?.['Triggers']) ? top['Triggers'] : []) as Rec[]) {
    notes.push(`Trigger ${str(t['Trigger Name'])}${t['Relation'] ? ' auf ' + str(t['Relation']) : ''}: ${propText(t['Calls'])}× in ${propText(t['Time'])} ms`);
  }
  const root = pgNode(p, analyzed);
  dedupeCte(root);
  return statement(sql, root, analyzed, {
    notes,
    totalCost: num(p['Total Cost']),
    planningMs: num(top?.['Planning Time']),
    executionMs: num(top?.['Execution Time']),
    raw,
    rawFormat: 'json',
  });
}

/* ---------------------------------------------------------------- MySQL: Baum (Text) ---- */

const NUM = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const TREE_COST = new RegExp(String.raw`\s*\(cost=(${NUM})(?:\.\.(${NUM}))? rows=(${NUM})\)\s*$`, 'i');
const TREE_ACTUAL = new RegExp(String.raw`\s*\(actual time=(${NUM})\.\.(${NUM}) rows=(${NUM}) loops=(\d+)\)\s*$`, 'i');
const TREE_NEVER = /\s*\(never executed\)\s*$/i;

/** "Index lookup on b using ix (x=1)" → Operation und Rest */
function splitLabel(label: string): { op: string; detail?: string } {
  let m = /^([A-Za-z][\w <>#-]*?): ([\s\S]+)$/.exec(label);
  if (m) return { op: m[1], detail: m[2] };
  m = /^([^(]+?) on ([\s\S]+)$/.exec(label);
  if (m) return { op: m[1], detail: m[2] };
  m = /^([A-Za-z][\w #-]*?) (\([\s\S]*)$/.exec(label);
  if (m) return { op: m[1], detail: m[2] };
  return { op: label };
}

function treeNode(text: string, analyzed: boolean): Draft {
  let label = text;
  const props: [string, string][] = [];
  let cost: RegExpExecArray | null = null;
  let actual: RegExpExecArray | null = null;
  let never = false;
  // Kennzahlen stehen in Klammern am Zeilenende: (cost=… rows=…) (actual time=… rows=… loops=…) bzw. (never executed)
  for (;;) {
    const a = TREE_ACTUAL.exec(label);
    if (a) {
      actual = a;
      label = label.slice(0, a.index);
      continue;
    }
    if (TREE_NEVER.test(label)) {
      never = true;
      label = label.replace(TREE_NEVER, '');
      continue;
    }
    const c = TREE_COST.exec(label);
    if (c) {
      cost = c;
      label = label.slice(0, c.index);
      continue;
    }
    break;
  }
  label = label.trim();
  const { op, detail } = splitLabel(label);
  const d = draft(op);
  d.detail = detail;
  props.push(['Schritt', label]);
  if (cost) {
    d.cost = Number(cost[2] ?? cost[1]);
    d.rows = Number(cost[3]);
    props.push(['cost', cost[2] ? `${cost[1]}..${cost[2]}` : cost[1]], ['rows', cost[3]]);
  }
  if (actual) {
    d.loops = Number(actual[4]);
    d.actualRows = Number(actual[3]);
    d.timeMs = Number(actual[2]) * d.loops;
    props.push(['actual time', `${actual[1]}..${actual[2]} ms`], ['actual rows', actual[3]], ['loops', actual[4]]);
  } else if (never && analyzed) {
    d.loops = 0;
    d.actualRows = 0;
    d.timeMs = 0;
    d.detail = (d.detail ? d.detail + ' · ' : '') + 'nie ausgeführt';
    props.push(['actual', 'never executed']);
  }
  d.props = props;
  return d;
}

/**
 * Innere Seite einer Nested Loop (MySQL): die Kosten gelten je Zeile der äußeren Seite. Bei einem Nachschlagen in einer
 * materialisierten Unterabfrage (IN-Semijoin) nennt MySQL sie aber schon für alle Durchläufe (cost=1407 für 5 627 Zeilen):
 * ein Kind kostet nie mehr als der Schritt selbst, dann wird nicht noch einmal vervielfacht
 */
function innerLoops(nl: Draft): void {
  const loops = Math.max(1, nl.children[0].rows ?? 1);
  for (const c of nl.children.slice(1)) c.estLoops = nl.cost !== undefined && c.cost !== undefined && c.cost * loops > nl.cost ? 1 : loops;
}

/** EXPLAIN FORMAT=TREE bzw. EXPLAIN ANALYZE (MySQL ab 8.0.16 bzw. 8.0.18) */
export function mysqlTreePlan(sql: string, text: string, analyzed: boolean): StatementPlan {
  const entries: { indent: number; text: string }[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(\s*)-> ([\s\S]*)$/.exec(line);
    if (m) entries.push({ indent: m[1].length, text: m[2] });
    // Fortsetzung, z. B. Zeilenumbruch in einer Zeichenkette der Bedingung
    else if (entries.length && line.trim()) entries[entries.length - 1].text += '\n' + line;
  }
  const roots: Draft[] = [];
  const stack: { indent: number; d: Draft }[] = [];
  for (const e of entries) {
    const d = treeNode(e.text, analyzed);
    while (stack.length && stack[stack.length - 1].indent >= e.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.d.children.push(d);
    else roots.push(d);
    stack.push({ indent: e.indent, d });
  }
  if (!roots.length) return { sql, error: 'MySQL hat keinen Plan geliefert.', notes: [], raw: text, rawFormat: 'text' };
  const fix = (d: Draft, parent: Draft | undefined) => {
    // innere Seite einer Nested Loop: Kosten je Zeile der äußeren Seite
    if (/^Nested loop/i.test(d.op) && d.children.length > 1) innerLoops(d);
    // abhängige Unterabfrage: läuft etwa einmal je Zeile der Stelle, an der sie hängt
    if (/^Select #\d+/.test(d.op) && /dependent/i.test(d.detail ?? '')) {
      const base = parent ? parent.children.find((c) => !/^Select #/.test(c.op)) : roots[0] !== d ? roots[0] : undefined;
      if (base?.rows) d.estLoops = Math.max(1, base.rows);
    }
    // Tabelle ohne Schritte darunter (nicht <temporary> und keine materialisierte Unterabfrage)
    if (d.op === 'Table scan' && !d.children.length && d.detail && !d.detail.startsWith('<')) {
      d.scanRows = analyzed ? d.actualRows : d.rows;
    }
    for (const c of d.children) fix(c, d);
  };
  for (const r of roots) fix(r, undefined);
  // Unterabfragen ("Select #2 …") stehen bei MySQL neben der Hauptabfrage
  let root = roots[0];
  if (roots.length > 1) {
    root = draft('Abfrage');
    root.children = roots;
  }
  const top = roots[0];
  return statement(sql, root, analyzed, {
    notes: [],
    totalCost: top.cost,
    executionMs: analyzed ? top.timeMs : undefined,
    raw: text,
    rawFormat: 'text',
  });
}

/* ---------------------------------------------------------------- MySQL/MariaDB: JSON ---- */

/** JSON-Objekt mit Schlüsseln in Reihenfolge – MariaDB wiederholt "table" im selben Objekt (JSON.parse behielte nur das letzte) */
export class JObj {
  constructor(readonly entries: [string, JVal][]) {}
  get(key: string): JVal | undefined {
    return this.entries.find((e) => e[0] === key)?.[1];
  }
}
export type JVal = null | boolean | number | string | JVal[] | JObj;

export function parseJsonKeepKeys(text: string): JVal {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`Plan (JSON) nicht lesbar: ${what} an Stelle ${i}`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const expect = (c: string) => {
    ws();
    if (text[i] !== c) fail(`„${c}“ erwartet`);
    i++;
  };
  const string = (): string => {
    expect('"');
    let s = '';
    for (;;) {
      const c = text[i++];
      if (c === undefined) return fail('Zeichenkette ohne Ende');
      if (c === '"') return s;
      if (c !== '\\') {
        s += c;
        continue;
      }
      const e = text[i++];
      if (e === 'u') {
        s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
        i += 4;
      } else s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
    }
  };
  const value = (): JVal => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const entries: [string, JVal][] = [];
      ws();
      if (text[i] === '}') {
        i++;
        return new JObj(entries);
      }
      for (;;) {
        const k = string();
        expect(':');
        entries.push([k, value()]);
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          continue;
        }
        expect('}');
        return new JObj(entries);
      }
    }
    if (c === '[') {
      i++;
      const list: JVal[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return list;
      }
      for (;;) {
        list.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        expect(']');
        return list;
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) return fail('unerwartetes Zeichen');
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'null' ? null : Number(m[0]);
  };
  const v = value();
  ws();
  if (i < text.length) fail('Text nach dem Ende');
  return v;
}

function jtext(v: JVal | undefined): string {
  if (v === undefined || v === null) return '';
  if (v instanceof JObj) return '{' + v.entries.map(([k, x]) => `${k}: ${jtext(x)}`).join(', ') + '}';
  if (Array.isArray(v)) return v.map(jtext).join(', ');
  return String(v);
}

const ACCESS: Record<string, string> = {
  ALL: 'Table scan',
  index: 'Full index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  eq_ref: 'Single-row index lookup',
  ref_or_null: 'Index lookup or NULL',
  const: 'Constant row',
  system: 'Constant row',
  index_merge: 'Index merge',
  fulltext: 'Fulltext index',
  unique_subquery: 'Unique subquery lookup',
  index_subquery: 'Index subquery lookup',
  hash_ALL: 'Hash join, table scan',
  hash_index: 'Hash join, index',
  hash_range: 'Hash join, range',
  hash_index_merge: 'Hash join, index merge',
};

/** Objekte, die nur Kennzahlen eines Schritts tragen (keine eigenen Schritte) */
const JSON_INFO = new Set(['cost_info', 'r_engine_stats', 'buffer', 'query_optimization', 'r_index_stats']);
/** Teilnehmer eines Joins: stehen mehrere hintereinander (MariaDB bis 10.x), bilden sie eine Nested Loop */
const JOIN_MEMBER = new Set(['table', 'block-nl-join', 'hash-join', 'range-checked-for-each-record']);

function jsonOp(key: string, o: JObj): string {
  switch (key) {
    case 'query_block': {
      const id = o.get('select_id');
      const kind = o.get('operation');
      return `Select${id !== undefined ? ' #' + jtext(id) : ''}${kind ? ' (' + jtext(kind) + ')' : ''}`;
    }
    case 'table': {
      const acc = jtext(o.get('access_type'));
      let op = ACCESS[acc] ?? (acc ? `Access ${acc}` : 'Table');
      for (const f of ['update', 'delete', 'insert']) if (o.get(f) === true) op = `${f[0].toUpperCase()}${f.slice(1)}: ${op}`;
      return op;
    }
    case 'nested_loop':
      return 'Nested loop';
    case 'filesort':
      return 'Sort';
    case 'temporary_table':
      return 'Temporary table';
    case 'union_result':
      return 'Union';
    case 'window_functions_computation':
    case 'windowing':
      return 'Window functions';
    case 'materialized':
    case 'materialized_from_subquery':
      return 'Materialize';
    case 'subquery_cache':
      return 'Subquery cache';
    case 'expression_cache':
      return 'Expression cache';
    case 'duplicates_removal':
      return 'Remove duplicates';
    case 'ordering_operation':
      return o.get('using_filesort') === true ? 'Sort' : 'Ordering';
    case 'grouping_operation':
      return o.get('using_temporary_table') === true ? 'Group (temporary table)' : 'Group';
    case 'block-nl-join':
      return 'Block nested loop join';
    case 'read_sorted_file':
      return 'Read sorted file';
    default:
      return key.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

function jsonDetail(key: string, o: JObj): string | undefined {
  const parts: string[] = [];
  if (key === 'table' || key === 'union_result') {
    const t = jtext(o.get('table_name'));
    const k = jtext(o.get('key'));
    if (t) parts.push(t + (k ? ` using ${k}` : ''));
  }
  for (const c of ['index_condition', 'attached_condition', 'sort_key', 'having_condition']) {
    const v = o.get(c);
    if (v !== undefined && v !== null) parts.push(jtext(v));
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function jsonNode(key: string, o: JObj, analyzed: boolean, wrapperProps: [string, string][] = []): Draft {
  const d = draft(jsonOp(key, o));
  d.detail = jsonDetail(key, o);
  d.props.push(...wrapperProps);
  const kids: { key: string; d: Draft }[] = [];
  const addList = (k: string, list: JVal[]) => {
    const found: { key: string; d: Draft }[] = [];
    for (const w of list) {
      if (!(w instanceof JObj)) continue;
      // Listeneintrag {"table": {…}} bzw. {"dependent": true, "query_block": {…}}
      const scalars = w.entries.filter(([, v]) => !(v instanceof JObj) && !Array.isArray(v)).map(([k2, v]) => [k2, jtext(v)] as [string, string]);
      for (const [k2, v] of w.entries) if (v instanceof JObj) found.push({ key: k2, d: jsonNode(k2, v, analyzed, scalars) });
    }
    if (k === 'nested_loop' && found.length > 1) {
      const nl = draft('Nested loop');
      nl.children = found.map((f) => f.d);
      kids.push({ key: k, d: nl });
    } else kids.push(...found);
  };
  for (const [k, v] of o.entries) {
    if (v instanceof JObj) {
      if (JSON_INFO.has(k)) for (const [k2, v2] of v.entries) d.props.push([`${k}.${k2}`, jtext(v2)]);
      else kids.push({ key: k, d: jsonNode(k, v, analyzed) });
    } else if (Array.isArray(v) && v.some((x) => x instanceof JObj)) addList(k, v);
    else d.props.push([k, jtext(v)]);
  }
  // MariaDB bis 10.x: mehrere "table" hintereinander statt "nested_loop"
  for (let i = 0; i < kids.length; i++) {
    let j = i;
    while (j < kids.length && JOIN_MEMBER.has(kids[j].key)) j++;
    if (j - i > 1) {
      const nl = draft('Nested loop');
      nl.children = kids.slice(i, j).map((x) => x.d);
      kids.splice(i, j - i, { key: 'nested_loop', d: nl });
    }
  }
  d.children = kids.map((x) => x.d);

  const n = (k: string) => num(o.get(k));
  const info = o.get('cost_info');
  const ci = (k: string) => (info instanceof JObj ? num(info.get(k)) : undefined);
  if (key === 'table') {
    d.rows = n('rows') ?? n('rows_examined_per_scan');
    // MariaDB: cost der Tabelle über alle Durchläufe; MySQL: read_cost + eval_cost
    const own = n('cost') ?? sum(ci('read_cost'), ci('eval_cost'));
    if (own !== undefined) {
      d.selfCost = own;
      d.cost = own;
    }
    if (analyzed) {
      d.loops = n('r_loops');
      d.actualRows = n('r_rows');
      d.selfMs = sum(n('r_table_time_ms'), n('r_other_time_ms')) ?? n('r_total_time_ms');
    }
    const name = jtext(o.get('table_name'));
    if (o.get('access_type') === 'ALL' && name && !name.startsWith('<')) d.scanRows = analyzed ? d.actualRows : d.rows;
  } else if (key === 'query_block') {
    d.cost = n('cost') ?? ci('query_cost');
    if (analyzed) {
      d.loops = n('r_loops');
      d.timeMs = n('r_total_time_ms');
    }
  } else {
    const own = ci('sort_cost');
    if (own !== undefined) d.selfCost = own;
    if (analyzed) {
      d.loops = n('r_loops');
      d.actualRows = n('r_rows') ?? n('r_output_rows');
      const t = n('r_total_time_ms');
      if (t !== undefined) d.selfMs = t;
    }
  }
  return d;
}

/** MySQL 8.3+ mit explain_json_format_version = 2: Baum wie FORMAT=TREE, nur als JSON */
function jsonV2Node(o: JObj, analyzed: boolean): Draft {
  const label = jtext(o.get('operation'));
  const { op, detail } = splitLabel(label);
  const d = draft(op);
  d.detail = detail;
  d.rows = num(o.get('estimated_rows'));
  d.cost = num(o.get('estimated_total_cost'));
  if (analyzed) {
    d.actualRows = num(o.get('actual_rows'));
    d.loops = num(o.get('actual_loops'));
    const last = num(o.get('actual_last_row_ms'));
    if (last !== undefined) d.timeMs = last * (d.loops ?? 1);
  }
  for (const [k, v] of o.entries) {
    if (Array.isArray(v) && v.some((x) => x instanceof JObj && x.get('operation') !== undefined)) {
      for (const x of v) if (x instanceof JObj) d.children.push(jsonV2Node(x, analyzed));
    } else if (!(v instanceof JObj)) d.props.push([k, jtext(v)]);
  }
  if (/^Nested loop/i.test(op) && d.children.length > 1) innerLoops(d);
  if (op === 'Table scan' && !d.children.length && detail && !detail.startsWith('<')) d.scanRows = analyzed ? d.actualRows : d.rows;
  return d;
}

/** EXPLAIN FORMAT=JSON (MySQL, MariaDB) bzw. ANALYZE FORMAT=JSON (MariaDB) */
export function mysqlJsonPlan(sql: string, text: string, analyzed: boolean): StatementPlan {
  const top = parseJsonKeepKeys(text);
  if (!(top instanceof JObj)) return { sql, error: 'Der Server hat keinen lesbaren Plan geliefert.', notes: [], raw: text, rawFormat: 'json' };
  const qb = top.get('query_block');
  let root: Draft;
  if (qb instanceof JObj) root = jsonNode('query_block', qb, analyzed);
  else if (top.get('operation') !== undefined) root = jsonV2Node(top, analyzed);
  else return { sql, error: 'Der Server hat keinen lesbaren Plan geliefert.', notes: [], raw: text, rawFormat: 'json' };
  const opt = top.get('query_optimization');
  const notes: string[] = [];
  const msg = qb instanceof JObj ? qb.get('message') ?? qb.get('table') : undefined;
  if (msg instanceof JObj && msg.get('message')) notes.push(jtext(msg.get('message')));
  else if (typeof msg === 'string') notes.push(msg);
  return statement(sql, root, analyzed, {
    notes,
    totalCost: root.cost,
    planningMs: opt instanceof JObj ? num(opt.get('r_total_time_ms')) : undefined,
    executionMs: analyzed ? root.timeMs : undefined,
    raw: text,
    rawFormat: 'json',
  });
}

/* ---------------------------------------------------------------- SQL Server: Showplan-XML ---- */

export interface XEl {
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
  });
}

/** kleiner XML-Leser für Showplans: nur Elemente und Attribute (Text, Kommentare und Deklarationen werden übersprungen) */
export function parseXml(text: string): XEl {
  const doc: XEl = { name: '#document', attrs: {}, children: [] };
  const stack: XEl[] = [doc];
  const n = text.length;
  let i = 0;
  const skipTo = (end: string, from: number) => {
    const k = text.indexOf(end, from);
    return k < 0 ? n : k + end.length;
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) i = skipTo('-->', lt + 4);
    else if (text.startsWith('<![CDATA[', lt)) i = skipTo(']]>', lt + 9);
    else if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) i = skipTo('>', lt + 2);
    else if (text[lt + 1] === '/') {
      if (stack.length > 1) stack.pop();
      i = skipTo('>', lt + 2);
    } else {
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(text[j])) j++;
      const el: XEl = { name: text.slice(lt + 1, j).replace(/^.*:/, ''), attrs: {}, children: [] };
      let selfClosing = false;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (j >= n) break;
        if (text[j] === '/') {
          selfClosing = true;
          j = skipTo('>', j);
          break;
        }
        if (text[j] === '>') {
          j++;
          break;
        }
        const eq = text.indexOf('=', j);
        if (eq < 0) throw new Error('Plan (XML) nicht lesbar: Attribut ohne Wert');
        const name = text.slice(j, eq).trim();
        let q = eq + 1;
        while (q < n && /\s/.test(text[q])) q++;
        const quote = text[q];
        const end = text.indexOf(quote, q + 1);
        if (end < 0) throw new Error('Plan (XML) nicht lesbar: Attribut ohne Ende');
        el.attrs[name] = decodeXml(text.slice(q + 1, end));
        j = end + 1;
      }
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) stack.push(el);
      i = j;
    }
  }
  return doc.children[0] ?? doc;
}

function escapeXml(s: string): string {
  // auch Tabulatoren: ein XML-Parser (SSMS) machte sonst ein Leerzeichen daraus, der StatementText wäre verändert
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;').replace(/\r/g, '&#xd;').replace(/\t/g, '&#x9;');
}

/** eingerückt ausgeben (lesbar, weiterhin gültig für SSMS & Co.) */
export function xmlPretty(el: XEl, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');
  if (!el.children.length) return `${pad}<${el.name}${attrs} />`;
  return `${pad}<${el.name}${attrs}>\n${el.children.map((c) => xmlPretty(c, depth + 1)).join('\n')}\n${pad}</${el.name}>`;
}

function child(el: XEl | undefined, name: string): XEl | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Elemente dieses Namens unterhalb, aber nicht in tieferen Schritten (RelOp) */
function findLocal(el: XEl | undefined, name: string): XEl[] {
  const out: XEl[] = [];
  const visit = (e: XEl) => {
    for (const c of e.children) {
      if (c.name === name) out.push(c);
      else if (c.name !== 'RelOp') visit(c);
    }
  };
  if (el) visit(el);
  return out;
}

/** die nächsten Schritte darunter */
function childRelOps(el: XEl): XEl[] {
  const out: XEl[] = [];
  const visit = (e: XEl) => {
    for (const c of e.children) {
      if (c.name === 'RelOp') out.push(c);
      else visit(c);
    }
  };
  visit(el);
  return out;
}

/** [db].[schema].[tabelle].[spalte] as [alias].[spalte] → alias.spalte */
export function tidySql(s: string): string {
  return s
    .replace(/\[[^\]]*\]\.\[[^\]]*\]\.\[[^\]]*\]\.\[[^\]]*\] as (\[[^\]]*\]\.\[[^\]]*\])/g, '$1')
    .replace(/\[[^\]]*\]\.\[[^\]]*\]\.(\[[^\]]*\]\.\[[^\]]*\])/g, '$1')
    .replace(/\[([A-Za-z_@#][\w$#@]*)\]/g, '$1');
}

function unbracket(s: string | undefined): string {
  return (s ?? '').replace(/^\[|\]$/g, '');
}

function colName(c: XEl): string {
  const t = unbracket(c.attrs.Alias ?? c.attrs.Table);
  return (t ? t + '.' : '') + unbracket(c.attrs.Column);
}

function seekText(op: XEl): string | undefined {
  const groups: string[] = [];
  const SCAN: Record<string, string> = { EQ: '=', GE: '>=', GT: '>', LE: '<=', LT: '<', IS: 'IS', 'IS NOT': 'IS NOT' };
  for (const sp of findLocal(op, 'SeekPredicates')) {
    for (const g of sp.children) {
      const parts: string[] = [];
      for (const kind of ['Prefix', 'StartRange', 'EndRange']) {
        for (const r of findLocal(g, kind)) {
          const cols = findLocal(child(r, 'RangeColumns'), 'ColumnReference').map(colName);
          const exprs = (child(r, 'RangeExpressions')?.children ?? []).map((so) => tidySql(so.attrs.ScalarString ?? '?'));
          const sym = SCAN[r.attrs.ScanType ?? 'EQ'] ?? r.attrs.ScanType ?? '=';
          cols.forEach((c, i) => parts.push(`${c} ${sym} ${exprs[i] ?? '?'}`));
        }
      }
      if (parts.length) groups.push(parts.join(' AND '));
    }
  }
  return groups.length ? groups.join(' OR ') : undefined;
}

function objectText(o: XEl): string {
  const table = unbracket(o.attrs.Table);
  const alias = unbracket(o.attrs.Alias);
  const index = unbracket(o.attrs.Index);
  return `${table}${alias && alias !== table ? ' ' + alias : ''}${index ? ` (${index})` : ''}`;
}

function warningText(w: XEl): string {
  const a = w.attrs;
  switch (w.name) {
    case 'PlanAffectingConvert':
      return `Implizite Umwandlung ${tidySql(a.Expression ?? '')}${a.ConvertIssue === 'Seek Plan' ? ' – verhindert die Index-Suche (Seek)' : ' – kann die Schätzung verfälschen'}`;
    case 'SpillToTempDb':
      return `Lagert nach tempdb aus (Stufe ${a.SpillLevel ?? '?'}) – zu wenig Arbeitsspeicher zugeteilt`;
    case 'SortSpillDetails':
    case 'HashSpillDetails':
    case 'ExchangeSpillDetails':
      return `${w.name.replace('SpillDetails', '')}: ${a.WritesToTempDb ?? '?'} Seiten nach tempdb geschrieben`;
    case 'NoJoinPredicate':
      return 'Join ohne Bedingung – jede Zeile mit jeder';
    case 'ColumnsWithNoStatistics':
      return 'Keine Statistik für: ' + findLocal(w, 'ColumnReference').map(colName).join(', ');
    case 'MemoryGrantWarning':
      return `Speicherzuteilung: ${a.GrantWarningKind ?? '?'} (angefordert ${a.RequestedMemory ?? '?'} kB, gebraucht ${a.MaxUsedMemory ?? '?'} kB)`;
    case 'Wait':
      return `Gewartet: ${a.WaitType ?? '?'} ${a.WaitTime ?? '?'} ms`;
    default:
      return w.name + (Object.keys(a).length ? ' ' + Object.entries(a).map(([k, v]) => `${k}=${v}`).join(' ') : '');
  }
}

function warningsOf(el: XEl): string[] {
  const w = child(el, 'Warnings');
  if (!w) return [];
  const out = w.children.map(warningText);
  for (const [k, v] of Object.entries(w.attrs)) {
    if (v !== 'true' && v !== '1') continue;
    out.push(k === 'NoJoinPredicate' ? 'Join ohne Bedingung – jede Zeile mit jeder' : k === 'UnmatchedIndexes' ? 'Gefilterter Index ließ sich nicht nutzen' : k);
  }
  return out;
}

const RELOP_META = new Set(['OutputList', 'Warnings', 'MemoryFractions', 'RunTimeInformation', 'RunTimePartitionSummary', 'InternalInfo']);

function relOpNode(el: XEl, analyzed: boolean): Draft {
  const a = el.attrs;
  const phys = a.PhysicalOp ?? '?';
  const d = draft(a.LogicalOp && a.LogicalOp !== phys ? `${phys} (${a.LogicalOp})` : phys);
  d.rows = num(a.EstimateRows);
  // gilt bei SQL Server schon für alle Ausführungen (auch auf der inneren Seite einer Nested Loop)
  d.cost = num(a.EstimatedTotalSubtreeCost);
  const ops = el.children.filter((c) => !RELOP_META.has(c.name));
  const obj = ops.flatMap((o) => (o.name === 'Object' ? [o] : findLocal(o, 'Object')))[0];
  const seek = ops.map(seekText).find((s) => s);
  const pred = ops.flatMap((o) => findLocal(o, 'Predicate'))[0];
  const predText = pred ? tidySql(child(pred, 'ScalarOperator')?.attrs.ScalarString ?? '') : '';
  const parts: string[] = [];
  if (obj) parts.push(objectText(obj));
  if (seek) parts.push(`Seek: ${seek}`);
  if (predText) parts.push(`Filter: ${predText}`);
  d.detail = parts.length ? parts.join(' · ') : undefined;
  for (const [k, v] of Object.entries(a)) d.props.push([k, v]);
  if (obj) d.props.push(['Object', Object.values(obj.attrs).join(' ')]);
  if (seek) d.props.push(['Seek', seek]);
  if (predText) d.props.push(['Predicate', predText]);
  for (const o of ops) for (const [k, v] of Object.entries(o.attrs)) d.props.push([`${o.name}.${k}`, v]);
  const output = findLocal(child(el, 'OutputList'), 'ColumnReference').map(colName);
  if (output.length) d.props.push(['Output', output.join(', ')]);
  let rowsRead: number | undefined;
  if (analyzed) {
    const threads = findLocal(child(el, 'RunTimeInformation'), 'RunTimeCountersPerThread');
    if (threads.length) {
      const total = (k: string) => threads.reduce((s, t) => s + (num(t.attrs[k]) ?? 0), 0);
      const execs = total('ActualExecutions');
      // so oft lief der Schritt (parallel: in jedem Thread einmal – die Threads teilen sich die Zeilen); innere Seite einer
      // Nested Loop in einer parallelen Zone: jeder Thread führt sie für seine Zeilen aus, dann zählt die Summe
      const perThread = threads.map((t) => num(t.attrs.ActualExecutions) ?? 0);
      const runs = perThread.filter((x) => x > 1).length > 1 ? Math.max(1, execs) : Math.max(1, ...perThread);
      d.loops = execs > 0 ? runs : 0;
      d.actualRows = execs > 0 ? total('ActualRows') / runs : 0;
      if (threads.some((t) => t.attrs.ActualRowsRead !== undefined)) rowsRead = total('ActualRowsRead') / runs;
      if (threads.some((t) => t.attrs.ActualElapsedms !== undefined)) {
        // Threads laufen parallel: die längste Zeit zählt. Zeilenmodus: mit den Schritten darunter; Batch-Modus: nur dieser Schritt
        const ms = Math.max(...threads.map((t) => num(t.attrs.ActualElapsedms) ?? 0));
        if (threads.some((t) => t.attrs.ActualExecutionMode === 'Batch')) d.selfMs = ms;
        else d.timeMs = ms;
      }
      d.props.push(['ActualRows', String(total('ActualRows'))], ['ActualExecutions', String(execs)]);
      for (const k of ['ActualElapsedms', 'ActualCPUms', 'ActualLogicalReads', 'ActualPhysicalReads', 'ActualRowsRead']) {
        if (threads.some((t) => t.attrs[k] !== undefined)) {
          d.props.push([k, String(k === 'ActualElapsedms' ? Math.max(...threads.map((t) => num(t.attrs[k]) ?? 0)) : total(k))]);
        }
      }
      if (threads.length > 1) d.props.push(['Threads', String(threads.length)]);
    }
  }
  if (/^(Table Scan|Clustered Index Scan|Index Scan)$/.test(phys)) d.scanRows = rowsRead ?? num(a.EstimatedRowsRead) ?? num(a.TableCardinality);
  d.warnings.push(...warningsOf(el));
  for (const c of childRelOps(el)) d.children.push(relOpNode(c, analyzed));
  return d;
}

function missingIndexes(qp: XEl): string[] {
  const out: string[] = [];
  for (const g of findLocal(child(qp, 'MissingIndexes'), 'MissingIndexGroup')) {
    for (const mi of g.children.filter((c) => c.name === 'MissingIndex')) {
      const cols = (usage: string) =>
        mi.children.filter((c) => c.name === 'ColumnGroup' && c.attrs.Usage === usage).flatMap((cg) => cg.children.map((c) => c.attrs.Name ?? '?'));
      const keys = [...cols('EQUALITY'), ...cols('INEQUALITY')];
      const incl = cols('INCLUDE');
      const name = `[IX_${unbracket(mi.attrs.Table)}_${keys.map(unbracket).join('_')}]`;
      const ddl = `CREATE NONCLUSTERED INDEX ${name} ON ${mi.attrs.Schema ?? ''}.${mi.attrs.Table ?? ''} (${keys.join(', ')})${incl.length ? ` INCLUDE (${incl.join(', ')})` : ''}`;
      const impact = num(g.attrs.Impact);
      out.push(`Fehlender Index${impact !== undefined ? ` (laut SQL Server ${Math.round(impact * 10) / 10} % günstiger)` : ''}: ${ddl}`);
    }
  }
  return out;
}

function mssqlStatement(st: XEl, qp: XEl, analyzed: boolean, raw: string): StatementPlan {
  const sql = (st.attrs.StatementText ?? '').trim();
  const rel = child(qp, 'RelOp');
  const notes = [...missingIndexes(qp), ...warningsOf(qp)];
  if (st.attrs.StatementOptmEarlyAbortReason === 'TimeOut') notes.push('Der Optimierer hat wegen Zeitlimit aufgehört – der Plan ist möglicherweise nicht der beste.');
  const extra = {
    notes,
    totalCost: num(st.attrs.StatementSubTreeCost),
    planningMs: num(qp.attrs.CompileTime),
    executionMs: analyzed ? num(child(qp, 'QueryTimeStats')?.attrs.ElapsedTime) : undefined,
    raw,
    rawFormat: 'xml' as const,
  };
  if (!rel) return { sql, ...extra, error: 'Kein Plan für diese Anweisung.' };
  return statement(sql, relOpNode(rel, analyzed), analyzed, extra);
}

/**
 * Showplan-XML (eines je Batch bzw. je ausgeführter Anweisung) in Pläne je Anweisung.
 * skip: Anweisungen, die nicht von der Nutzerin stammen (vorangestellte Prüfung des Sitzungskennzeichens).
 */
export function mssqlPlans(xmls: string[], analyzed: boolean, skip?: (statementText: string) => boolean): StatementPlan[] {
  const out: StatementPlan[] = [];
  for (const xml of xmls) {
    const doc = parseXml(xml);
    const batches = findLocal(child(doc, 'BatchSequence'), 'Batch');
    // auch aus der Rohausgabe entfernen (sie wird weitergegeben)
    for (const batch of batches) {
      for (const s of batch.children.filter((c) => c.name === 'Statements')) s.children = s.children.filter((st) => !skip?.(st.attrs.StatementText ?? ''));
    }
    const raw = xmlPretty(doc);
    const visit = (stmts: XEl) => {
      for (const st of stmts.children) {
        if (skip?.(st.attrs.StatementText ?? '')) continue;
        const qp = child(st, 'QueryPlan') ?? child(child(st, 'Condition'), 'QueryPlan');
        if (qp) out.push(mssqlStatement(st, qp, analyzed, raw));
        for (const branch of ['Then', 'Else']) {
          const inner = child(child(st, branch), 'Statements');
          if (inner) visit(inner);
        }
      }
    };
    for (const batch of batches) for (const s of batch.children.filter((c) => c.name === 'Statements')) visit(s);
  }
  return out;
}
