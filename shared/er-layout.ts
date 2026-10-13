/*
 * Anordnung für das ER-Diagramm, ohne DOM (die Größen der Kästen kommen von außen). Schichten-Layout (Sugiyama):
 * je zusammenhängende Gruppe Schichten von links (verwiesene Tabellen) nach rechts (verweisende); Verbindungen über
 * mehrere Schichten bekommen Durchgänge in den Lücken dazwischen, damit sie nicht hinter fremden Kästen verlaufen.
 * Reihenfolge je Schicht nach dem Schwerpunkt der Nachbarn (die mit den wenigsten Kreuzungen gewinnt), Höhe so, dass die
 * Linien möglichst waagrecht laufen. Gruppen reihenweise nebeneinander, die größte zuerst; Tabellen ohne Fremdschlüssel
 * als Raster darunter.
 */

export interface ErBox {
  key: string;
  width: number;
  height: number;
}

/** from = verweisende Tabelle (mit dem Fremdschlüssel), to = verwiesene */
export interface ErLink {
  from: string;
  to: string;
  /** Höhe des Anschlusses im Kasten von from bzw. to (ab Oberkante); ohne Angabe die Mitte */
  fromY?: number;
  toY?: number;
}

/** waagrechter Durchgang einer langen Verbindung durch eine Spalte */
export interface ErWaypoint {
  x1: number;
  x2: number;
  y: number;
}

export interface ErLayout {
  pos: Map<string, { x: number; y: number }>;
  /** lange Verbindungen je Paar (erLinkKey): Durchgänge zwischen den Kästen, der Reihe nach von from nach to */
  routes: Map<string, ErWaypoint[]>;
  width: number;
  height: number;
}

export interface ErLayoutOptions {
  gapX: number;
  gapY: number;
  margin: number;
  /** so breit werden Reihen kleiner Gruppen und das Raster der Einzeltabellen (mindestens so breit wie die breiteste Gruppe) */
  rowWidth: number;
  /** höhere Schichten werden auf mehrere Spalten verteilt */
  maxColumnHeight: number;
}

const DEFAULTS: ErLayoutOptions = { gapX: 110, gapY: 36, margin: 30, rowWidth: 1600, maxColumnHeight: 1800 };
/** Höhe eines Durchgangs und sein Abstand zu Kästen und anderen Durchgängen */
const LANE = 2;
const LANE_GAP = 10;

export const erLinkKey = (from: string, to: string) => `${from}\u0001${to}`;

interface Placed {
  pos: Map<string, { x: number; y: number }>;
  routes: Map<string, ErWaypoint[]>;
  width: number;
  height: number;
}

/** Nachbar in der Schicht links bzw. rechts, mit den Anschlusshöhen in beiden Kästen */
interface Nb {
  n: string;
  mine: number;
  theirs: number;
}

/** höchstens so viele Zwischenschichten bekommt eine Verbindung eigene Durchgänge, und so viele Durchgänge insgesamt */
const MAX_LANE_SPAN = 8;
const MAX_LANES = 5000;

/** Minimum/Maximum per Schleife: Math.min(...liste) wirft ab etwa 120 000 Werten „Maximum call stack size exceeded“ */
function minOf(values: Iterable<number>): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

function maxOf(values: Iterable<number>, init: number): number {
  let m = init;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function layoutEr(boxes: ErBox[], links: ErLink[], options: Partial<ErLayoutOptions> = {}): ErLayout {
  const o = { ...DEFAULTS, ...options };
  const byKey = new Map(boxes.map((b) => [b.key, b]));
  // je Paar eine Verbindung (die erste bestimmt die Anschlüsse); ohne Selbstbezüge und Verweise ins Leere
  const pairs = new Map<string, ErLink>();
  for (const l of links) {
    if (l.from === l.to || !byKey.has(l.from) || !byKey.has(l.to)) continue;
    const k = erLinkKey(l.from, l.to);
    if (!pairs.has(k)) pairs.set(k, l);
  }
  const near = new Map<string, Set<string>>([...byKey.keys()].map((k) => [k, new Set<string>()]));
  for (const p of pairs.values()) {
    near.get(p.from)!.add(p.to);
    near.get(p.to)!.add(p.from);
  }

  // zusammenhängende Gruppen
  const seen = new Set<string>();
  const groups: string[][] = [];
  const single: string[] = [];
  for (const k of [...byKey.keys()].sort(cmp)) {
    if (seen.has(k)) continue;
    const g: string[] = [];
    const queue = [k];
    seen.add(k);
    while (queue.length) {
      const c = queue.shift()!;
      g.push(c);
      for (const n of [...near.get(c)!].sort(cmp)) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    if (g.length > 1) groups.push(g);
    else single.push(k);
  }
  groups.sort((a, b) => b.length - a.length || cmp(a[0], b[0]));

  const placed = groups.map((g) => {
    const inside = new Set(g);
    const own = [...pairs.values()].filter((p) => inside.has(p.from)).sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
    return placeGroup(g, own, byKey, o);
  });
  const rowWidth = Math.max(o.rowWidth, ...placed.map((p) => p.width));
  const pos = new Map<string, { x: number; y: number }>();
  const routes = new Map<string, ErWaypoint[]>();
  let top = o.margin;

  // Gruppen reihenweise
  let x = 0;
  let rowHeight = 0;
  for (const p of placed) {
    if (x > 0 && x + p.width > rowWidth) {
      top += rowHeight + o.gapY * 2;
      x = 0;
      rowHeight = 0;
    }
    const dx = o.margin + x;
    for (const [k, q] of p.pos) pos.set(k, { x: dx + q.x, y: top + q.y });
    for (const [k, r] of p.routes) routes.set(k, r.map((w) => ({ x1: dx + w.x1, x2: dx + w.x2, y: top + w.y })));
    x += p.width + o.gapX;
    rowHeight = Math.max(rowHeight, p.height);
  }
  if (placed.length) top += rowHeight + o.gapY * 2;

  // Einzeltabellen als Raster
  x = 0;
  rowHeight = 0;
  for (const k of single) {
    const b = byKey.get(k)!;
    if (x > 0 && x + b.width > rowWidth) {
      top += rowHeight + o.gapY;
      x = 0;
      rowHeight = 0;
    }
    pos.set(k, { x: o.margin + x, y: top });
    x += b.width + o.gapY;
    rowHeight = Math.max(rowHeight, b.height);
  }

  let width = 0;
  let height = 0;
  for (const [k, p] of pos) {
    const b = byKey.get(k)!;
    width = Math.max(width, p.x + b.width);
    height = Math.max(height, p.y + b.height);
  }
  return { pos, routes, width: width + o.margin, height: height + o.margin };
}

/** Sortierung unabhängig von der Spracheinstellung, damit gleiche Daten gleich angeordnet werden */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const isLane = (k: string) => k.charCodeAt(0) === 2;

function placeGroup(keys: string[], pairs: ErLink[], byKey: Map<string, ErBox>, o: ErLayoutOptions): Placed {
  const sorted = [...keys].sort(cmp);
  const parents = new Map(sorted.map((k) => [k, [] as string[]]));
  const children = new Map(sorted.map((k) => [k, [] as string[]]));
  for (const p of pairs) {
    parents.get(p.from)!.push(p.to);
    children.get(p.to)!.push(p.from);
  }

  // 1. Schicht = längster Weg zu einer Tabelle ohne Eltern; Kreise werden beim Suchen aufgebrochen
  const layer = new Map<string, number>();
  const busy = new Set<string>();
  const depth = (k: string): number => {
    const known = layer.get(k);
    if (known !== undefined) return known;
    busy.add(k);
    let d = 0;
    for (const p of parents.get(k)!) {
      if (busy.has(p)) continue;
      d = Math.max(d, depth(p) + 1);
    }
    busy.delete(k);
    layer.set(k, d);
    return d;
  };
  for (const k of sorted) depth(k);
  // Tabellen ohne Eltern direkt vor ihre Kinder (kürzere Linien)
  for (const k of sorted) {
    if (parents.get(k)!.length || !children.get(k)!.length) continue;
    const before = minOf(children.get(k)!.map((c) => layer.get(c)!)) - 1;
    if (before > layer.get(k)!) layer.set(k, before);
  }

  // 2. zu hohe Schichten auf mehrere verteilen: Blätter zuerst (Geschwister beisammen), Tabellen mit Kindern zuletzt
  const stack = (ks: string[]) => ks.reduce((h, k) => h + byKey.get(k)!.height, 0) + Math.max(0, ks.length - 1) * o.gapY;
  const maxLayer = maxOf(sorted.map((k) => layer.get(k)!), 0);
  const byLayer: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const k of sorted) byLayer[layer.get(k)!].push(k);
  let shift = 0;
  byLayer.forEach((l, i) => {
    const total = stack(l);
    const parts = Math.min(l.length, Math.max(1, Math.ceil(total / o.maxColumnHeight)));
    if (parts === 1) {
      for (const k of l) layer.set(k, i + shift);
      return;
    }
    const first = (k: string) => parents.get(k)![0] ?? '';
    const list = [...l].sort((a, b) => Number(children.get(a)!.length > 0) - Number(children.get(b)!.length > 0) || cmp(first(a), first(b)) || cmp(a, b));
    const target = total / parts;
    let part = 0;
    let h = 0;
    list.forEach((k, j) => {
      const bh = byKey.get(k)!.height;
      if (h > 0 && part < parts - 1 && (h + bh > target || list.length - j <= parts - 1 - part)) {
        part++;
        h = 0;
      }
      layer.set(k, i + shift + part);
      h += bh + o.gapY;
    });
    shift += parts - 1;
  });

  // 3. Verbindungen über mehrere Schichten: je Zwischenschicht ein Durchgang
  const count = maxOf(sorted.map((k) => layer.get(k)!), 0) + 1;
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const k of sorted) layers[layer.get(k)!].push(k);
  const height = new Map(sorted.map((k) => [k, byKey.get(k)!.height]));
  const left = new Map<string, Nb[]>();
  const right = new Map<string, Nb[]>();
  const add = (m: Map<string, Nb[]>, k: string, nb: Nb) => {
    const l = m.get(k);
    if (l) l.push(nb);
    else m.set(k, [nb]);
  };
  const lanes = new Map<string, string[]>();
  let laneCount = 0;
  for (const p of pairs) {
    const lf = layer.get(p.from)!;
    const lt = layer.get(p.to)!;
    if (lf === lt) continue;
    // Durchgänge deckeln: eine Nabentabelle mit vielen Verweisern über viele Schichten brächte sonst Knoten in der Größen-
    // ordnung Verbindungen × Spalten – Sortieren und Kreuzungen zählen stünden still. Darüber geht die Linie direkt.
    const span = Math.abs(lf - lt) - 1;
    const withLanes = span <= MAX_LANE_SPAN && laneCount + span <= MAX_LANES;
    if (withLanes) laneCount += span;
    const fromY = p.fromY ?? height.get(p.from)! / 2;
    const toY = p.toY ?? height.get(p.to)! / 2;
    const [a, ay, b, by] = lf < lt ? [p.from, fromY, p.to, toY] : [p.to, toY, p.from, fromY];
    const pk = erLinkKey(p.from, p.to);
    const chain: string[] = [];
    let prev = a;
    let prevY = ay;
    for (let l = Math.min(lf, lt) + 1; withLanes && l < Math.max(lf, lt); l++) {
      const d = `\u0002${pk}\u0002${l}`;
      layers[l].push(d);
      layer.set(d, l);
      height.set(d, LANE);
      add(right, prev, { n: d, mine: prevY, theirs: LANE / 2 });
      add(left, d, { n: prev, mine: LANE / 2, theirs: prevY });
      chain.push(d);
      prev = d;
      prevY = LANE / 2;
    }
    add(right, prev, { n: b, mine: prevY, theirs: by });
    add(left, b, { n: prev, mine: by, theirs: prevY });
    // Reihenfolge von from nach to
    if (chain.length) lanes.set(pk, lf < lt ? chain : chain.reverse());
  }

  // 4. Reihenfolge je Schicht: Schwerpunkt der Nachbarn, abwechselnd von links und von rechts; die Reihenfolge mit den
  //    wenigsten Kreuzungen gewinnt
  const idx = new Map<string, number>();
  const remember = (l: string[]) => l.forEach((k, i) => idx.set(k, i));
  layers.forEach(remember);
  const rel = (k: string) => (idx.get(k)! + 0.5) / layers[layer.get(k)!].length;
  const sortBy = (l: string[], side: Map<string, Nb[]>) => {
    const bary = new Map<string, number>();
    for (const k of l) {
      const ns = side.get(k);
      bary.set(k, ns?.length ? ns.reduce((s, x) => s + rel(x.n), 0) / ns.length : rel(k));
    }
    l.sort((a, b) => bary.get(a)! - bary.get(b)! || idx.get(a)! - idx.get(b)!);
    remember(l);
  };
  const crossings = () => {
    let c = 0;
    for (let i = 0; i + 1 < count; i++) c += crossingsBetween(layers[i], layers[i + 1].length, right, idx);
    return c;
  };
  // bei Gleichstand gewinnt die spätere: Durchgänge rücken neben die Kästen, zu denen sie führen
  let best = layers.map((l) => [...l]);
  let fewest = crossings();
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 1; i < count; i++) sortBy(layers[i], left);
    let c = crossings();
    if (c <= fewest) [fewest, best] = [c, layers.map((l) => [...l])];
    for (let i = count - 2; i >= 0; i--) sortBy(layers[i], right);
    c = crossings();
    if (c <= fewest) [fewest, best] = [c, layers.map((l) => [...l])];
  }
  best.forEach((l, i) => (layers[i] = l));
  layers.forEach(remember);

  // 5. waagrecht: eine Spalte je Schicht, so breit wie ihr breitester Kasten
  const colX: number[] = [];
  const colW: number[] = [];
  let x = 0;
  for (const l of layers) {
    const w = maxOf(l.filter((k) => !isLane(k)).map((k) => byKey.get(k)!.width), 0);
    colX.push(x);
    colW.push(w);
    x += Math.max(w, 20) + o.gapX;
  }

  // 6. senkrecht: Kästen und Durchgänge möglichst auf der Höhe ihrer Anschlüsse, ohne Überlappung (Reihenfolge bleibt)
  const gap = (a: string, b: string) => (isLane(a) || isLane(b) ? LANE_GAP : o.gapY);
  const y = new Map<string, number>();
  for (const l of layers) {
    let cur = 0;
    l.forEach((k, i) => {
      y.set(k, cur);
      if (i + 1 < l.length) cur += height.get(k)! + gap(k, l[i + 1]);
    });
  }
  const settle = (l: string[], sides: Map<string, Nb[]>[]) => {
    const off: number[] = [];
    let acc = 0;
    l.forEach((k, i) => {
      off.push(acc);
      if (i + 1 < l.length) acc += height.get(k)! + gap(k, l[i + 1]);
    });
    const wish = l.map((k, i) => {
      const ns = sides.flatMap((s) => s.get(k) ?? []);
      // ohne Nachbarn auf dieser Seite: bleiben, wo sie sind (gibt nach, wenn andere Platz brauchen)
      if (!ns.length) return { v: y.get(k)! - off[i], w: 0.01 };
      const t = ns.reduce((s, x) => s + y.get(x.n)! + x.theirs - x.mine, 0) / ns.length;
      return { v: t - off[i], w: isLane(k) ? 2 : ns.length };
    });
    isotonic(wish).forEach((z, i) => y.set(l[i], z + off[i]));
  };
  for (let pass = 0; pass < 12; pass++) {
    if (pass % 2 === 0) for (let i = 1; i < count; i++) settle(layers[i], [left]);
    else for (let i = count - 2; i >= 0; i--) settle(layers[i], [right]);
  }
  for (let i = 0; i < count; i++) settle(layers[i], [left, right]);

  const top = minOf(y.values());
  let bottom = 0;
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((l, i) => {
    for (const k of l) {
      const yy = Math.round(y.get(k)! - top);
      bottom = Math.max(bottom, yy + height.get(k)!);
      if (!isLane(k)) pos.set(k, { x: colX[i], y: yy });
    }
  });
  const routes = new Map<string, ErWaypoint[]>();
  for (const [pk, chain] of lanes) {
    routes.set(
      pk,
      chain.map((d) => {
        const i = layer.get(d)!;
        return { x1: colX[i], x2: colX[i] + colW[i], y: Math.round(y.get(d)! - top) + LANE / 2 };
      }),
    );
  }
  return { pos, routes, width: Math.max(0, x - o.gapX), height: bottom };
}

/** Kreuzungen zwischen zwei benachbarten Schichten: Fehlstände der rechten Enden, nach den linken sortiert */
function crossingsBetween(upper: string[], lowerLength: number, right: Map<string, Nb[]>, idx: Map<string, number>): number {
  const seq: number[] = [];
  for (const k of upper) seq.push(...(right.get(k) ?? []).map((x) => idx.get(x.n)!).sort((a, b) => a - b));
  const tree = new Array<number>(lowerLength + 1).fill(0);
  let n = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    for (let j = seq[i]; j > 0; j -= j & -j) n += tree[j];
    for (let j = seq[i] + 1; j <= lowerLength; j += j & -j) tree[j]++;
  }
  return n;
}

/** gewichtete Ausgleichsrechnung mit aufsteigender Lösung (pool adjacent violators) */
function isotonic(items: { v: number; w: number }[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  for (const it of items) {
    let b = { v: it.v, w: it.w, n: 1 };
    while (blocks.length && blocks[blocks.length - 1].v > b.v) {
      const p = blocks.pop()!;
      const w = p.w + b.w;
      b = { v: (p.v * p.w + b.v * b.w) / w, w, n: p.n + b.n };
    }
    blocks.push(b);
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.v));
}
