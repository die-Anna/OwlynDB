import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ErForeignKey, ErModel, ObjectRef } from '../../../../shared/api-types';
import { erLinkKey, layoutEr, type ErWaypoint } from '../../../../shared/er-layout';
import { objectName, quoteIdent, selectTop } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { AppState, ErTab } from '../core/state';
import { ContextMenuService, MenuItem } from '../ui/context-menu';
import { Icon } from '../ui/icon';
import { KeysPipe } from '../ui/keys.pipe';

const HEAD = 26;
const ROW = 18;
const PAD = 8;
/** Spaltenname beginnt hier (links davon das Schlüssel-Zeichen) */
const NAME_X = 24;
const MIN_W = 150;
const MAX_W = 420;
/** so viele Spalten zeigt ein Kasten, bis er aufgeklappt wird (Schlüsselspalten immer) */
const MAX_COLS = 24;
/** ab so vielen Tabellen zunächst nur Schlüsselspalten */
const KEYS_ONLY_FROM = 30;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 3;

/** Schlüssel und Verweis (Lucide, 24er Raster, im Diagramm auf 12 px verkleinert) */
const KEY_PATH = 'M3.5 15a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M11.2 11.8 20 3M16 7l2.5 2.5M18.5 4.5 21 7';
const LINK_PATH = 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7';

const tkey = (schema: string, name: string) => `${schema}\u0000${name}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** PostgreSQL: gängige Kurzformen statt der langen Namen aus format_type (gleichwertig) */
function shortPgType(t: string): string {
  return t
    .replace(/^character varying/, 'varchar')
    .replace(/^character\b/, 'char')
    .replace(/^bit varying/, 'varbit')
    .replace(/^(timestamp|time)(\(\d+\))? without time zone((?:\[\])*)$/, '$1$2$3')
    .replace(/^(timestamp|time)(\(\d+\))? with time zone((?:\[\])*)$/, '$1tz$2$3')
    .replace(/^double precision((?:\[\])*)$/, 'float8$1');
}

interface ViewCol {
  name: string;
  label: string;
  typeLabel: string;
  pk: boolean;
  fk: boolean;
  nullable: boolean;
  /** Oberkante der Zeile im Kasten */
  y: number;
  tip: string;
}

interface ViewBox {
  key: string;
  /** MySQL: '' bzw. die andere Datenbank */
  schema: string;
  name: string;
  /** voller Name für Suche und Tooltip (fremdes Schema mit Präfix) */
  fullTitle: string;
  title: string;
  rowsLabel: string;
  cols: ViewCol[];
  pkCols: string[];
  /** Zeile zum Auf-/Zuklappen: Text, leer = keine */
  more: string;
  moreY: number;
  /** verwiesene Tabelle aus einem anderen Schema bzw. einer anderen Datenbank (nicht geladen) */
  external: boolean;
  tip: string;
  head: string;
  w: number;
  h: number;
}

interface PlacedBox extends ViewBox {
  x: number;
  y: number;
}

interface ViewEdge {
  key: string;
  from: string;
  to: string;
  line: string;
  ends: string;
  dots: string;
  tip: string;
}

/** ER-Diagramm eines Schemas (MySQL: der Datenbank): Tabellen mit Spalten, Fremdschlüssel als Linien, automatisch angeordnet */
@Component({
  selector: 'app-er-view',
  imports: [FormsModule, Icon, KeysPipe],
  templateUrl: './er-view.html',
  styleUrl: './er-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErView {
  readonly tab = input.required<ErTab>();
  readonly active = input(false);
  protected state = inject(AppState);
  private menu = inject(ContextMenuService);
  private injector = inject(Injector);

  protected readonly KEY_PATH = KEY_PATH;
  protected readonly LINK_PATH = LINK_PATH;

  private canvas = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
  private world = viewChild.required<ElementRef<SVGGElement>>('world');
  private zoomText = viewChild.required<ElementRef<HTMLSpanElement>>('zoomText');

  protected model = signal<ErModel | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected notice = signal<{ text: string; file?: string } | null>(null);
  protected schemas = signal<string[]>([]);
  /** null = automatisch (ab KEYS_ONLY_FROM Tabellen nur Schlüsselspalten) */
  protected keysOnly = signal<boolean | null>(null);
  /** aufgeklappte lange Tabellen */
  protected expanded = signal<ReadonlySet<string>>(new Set());
  /** von Hand verschobene Tabellen */
  protected moved = signal<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  protected selected = signal<string | null>(null);
  protected search = signal('');
  /** Suchtreffer, zu dem zuletzt gesprungen wurde */
  protected current = signal<string | null>(null);

  /** Schema/Datenbank, für die geladen wurde bzw. wird */
  private loadedFor = '';
  private loadToken = 0;
  // Verschiebung und Maßstab: direkt am SVG gesetzt, ohne die Ansicht neu aufzubauen
  private tx = 0;
  private ty = 0;
  private k = 1;
  private fitPending = true;
  private measureCtx?: CanvasRenderingContext2D;
  private fonts = { title: '', col: '', colBold: '', type: '', small: '' };
  /** laufendes Ziehen beenden (Listener weg), z. B. wenn der Tab mitten im Ziehen schließt */
  private stopDrag: (() => void) | null = null;
  /** Zeitpunkt des letzten Auf- bzw. Zuklappens („+ n weitere Spalten“) */
  private toggledAt = -Infinity;

  protected readonly dialect = computed(() => this.state.dialect(this.tab().connectionId));
  protected readonly conn = computed(() => this.state.connection(this.tab().connectionId));
  /** Schema der eigenen Tabellen im Modell (MySQL: leer) */
  private readonly ownSchema = computed(() => (this.dialect() === 'mysql' ? '' : this.tab().schema));
  protected readonly depth = computed(() => this.tab().depth ?? 1);
  private readonly focusKey = computed(() => {
    const f = this.tab().focus;
    return f ? tkey(this.ownSchema(), f) : null;
  });

  /** Nachbarn je Tabelle über Fremdschlüssel, in beide Richtungen */
  private readonly graph = computed(() => {
    const g = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let s = g.get(a);
      if (!s) g.set(a, (s = new Set()));
      s.add(b);
    };
    for (const f of this.model()?.foreignKeys ?? []) {
      const a = tkey(f.schema, f.table);
      const b = tkey(f.refSchema, f.refTable);
      add(a, b);
      add(b, a);
    }
    return g;
  });

  protected readonly focusMissing = computed(() => {
    const f = this.focusKey();
    const m = this.model();
    return !!f && !!m && !m.tables.some((t) => tkey(t.schema, t.name) === f);
  });

  /** sichtbare Tabellen; null = alle */
  private readonly visible = computed<Set<string> | null>(() => {
    const f = this.focusKey();
    if (!f || this.focusMissing()) return null;
    const g = this.graph();
    const depth = this.depth();
    const seen = new Set([f]);
    let frontier = [f];
    for (let d = 0; frontier.length && (depth === 0 || d < depth); d++) {
      const next: string[] = [];
      for (const k of frontier) {
        for (const n of g.get(k) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      frontier = next;
    }
    return seen;
  });

  protected readonly keysOnlyOn = computed(() => {
    const k = this.keysOnly();
    if (k !== null) return k;
    // ab (nicht über) KEYS_ONLY_FROM Tabellen; nur geladene zählen, nicht die Platzhalter fremder Schemas
    const m = this.model();
    const vis = this.visible();
    const n = !m ? 0 : vis ? m.tables.filter((t) => vis.has(tkey(t.schema, t.name))).length : m.tables.length;
    return n >= KEYS_ONLY_FROM;
  });

  protected readonly boxes = computed<ViewBox[]>(() => {
    const m = this.model();
    if (!m) return [];
    const vis = this.visible();
    const keysOnly = this.keysOnlyOn();
    const open = this.expanded();
    // Spalten mit Fremdschlüssel (wohin) bzw. Ziel von Fremdschlüsseln (woher), für Anzeige und Tooltip
    const fkTo = new Map<string, Map<string, string[]>>();
    const refFrom = new Map<string, Map<string, string[]>>();
    const note = (m: Map<string, Map<string, string[]>>, table: string, col: string, text: string) => {
      let t = m.get(table);
      if (!t) m.set(table, (t = new Map()));
      t.set(col, [...(t.get(col) ?? []), text]);
    };
    for (const f of m.foreignKeys) {
      const a = tkey(f.schema, f.table);
      const b = tkey(f.refSchema, f.refTable);
      f.columns.forEach((c, i) => {
        note(fkTo, a, c, `${this.qualified(f.refSchema, f.refTable)}.${f.refColumns[i]}`);
        note(refFrom, b, f.refColumns[i], `${this.qualified(f.schema, f.table)}.${c}`);
      });
    }
    const out: ViewBox[] = [];
    const known = new Set<string>();
    for (const t of m.tables) {
      const key = tkey(t.schema, t.name);
      known.add(key);
      if (vis && !vis.has(key)) continue;
      out.push(this.makeBox(key, t.schema, t.name, t.columns, t.rows, false, fkTo.get(key), refFrom.get(key), keysOnly, open.has(key)));
    }
    // verwiesene Tabellen außerhalb des Schemas: nur mit den verwiesenen Spalten
    const ext = new Map<string, { schema: string; name: string; cols: string[] }>();
    for (const f of m.foreignKeys) {
      const key = tkey(f.refSchema, f.refTable);
      if (known.has(key) || (vis && !vis.has(key))) continue;
      let e = ext.get(key);
      if (!e) ext.set(key, (e = { schema: f.refSchema, name: f.refTable, cols: [] }));
      for (const c of f.refColumns) if (!e.cols.includes(c)) e.cols.push(c);
    }
    for (const [key, e] of ext) {
      const cols = e.cols.map((name) => ({ name, type: '', nullable: false, pk: false }));
      out.push(this.makeBox(key, e.schema, e.name, cols, undefined, true, undefined, refFrom.get(key), false, true));
    }
    return out;
  });

  private readonly layout = computed(() => {
    const boxes = this.boxes();
    const byKey = new Map(boxes.map((b) => [b.key, b]));
    // Anschluss = Mitte der Spaltenzeile, damit die Anordnung die Linien möglichst waagrecht legt
    const anchor = (b: ViewBox | undefined, col: string) => {
      const c = b?.cols.find((x) => x.name === col);
      return c ? c.y + ROW / 2 : HEAD / 2;
    };
    const links = (this.model()?.foreignKeys ?? []).map((f) => {
      const from = tkey(f.schema, f.table);
      const to = tkey(f.refSchema, f.refTable);
      return { from, to, fromY: anchor(byKey.get(from), f.columns[0]), toY: anchor(byKey.get(to), f.refColumns[0]) };
    });
    return layoutEr(
      boxes.map((b) => ({ key: b.key, width: b.w, height: b.h })),
      links,
    );
  });

  protected readonly placed = computed<PlacedBox[]>(() => {
    const pos = this.layout().pos;
    const moved = this.moved();
    return this.boxes().map((b) => ({ ...b, ...(moved.get(b.key) ?? pos.get(b.key) ?? { x: 0, y: 0 }) }));
  });

  protected readonly edges = computed<ViewEdge[]>(() => {
    const at = new Map(this.placed().map((b) => [b.key, b]));
    const routes = this.layout().routes;
    const moved = this.moved();
    const out: ViewEdge[] = [];
    (this.model()?.foreignKeys ?? []).forEach((f, i) => {
      const a = at.get(tkey(f.schema, f.table));
      const b = at.get(tkey(f.refSchema, f.refTable));
      if (!a || !b) return;
      const cols = (l: string[]) => (l.length === 1 ? l[0] : `(${l.join(', ')})`);
      const tip = `${a.fullTitle}.${cols(f.columns)} → ${b.fullTitle}.${cols(f.refColumns)}\n${f.name}`;
      // Durchgänge zwischen den Kästen gelten nur, solange keine der beiden Tabellen verschoben wurde
      const route = moved.has(a.key) || moved.has(b.key) ? undefined : routes.get(erLinkKey(a.key, b.key));
      out.push({ key: `${i}\u0000${f.name}`, from: a.key, to: b.key, tip, ...this.geometry(f, a, b, route) });
    });
    return out;
  });

  protected readonly matches = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return [];
    return this.placed()
      .filter((b) => b.fullTitle.toLowerCase().includes(q))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((b) => b.key);
  });

  /** Hervorhebung: gewählte Tabelle mit ihren Nachbarn, sonst die Suchtreffer */
  protected readonly boxState = computed(() => {
    const st = new Map<string, string>();
    const sel = this.selected();
    if (sel) {
      const near = this.graph().get(sel) ?? new Set<string>();
      for (const b of this.placed()) st.set(b.key, b.key === sel ? 'sel' : near.has(b.key) ? 'near' : 'dim');
    } else if (this.search().trim()) {
      const hit = new Set(this.matches());
      const cur = this.current();
      for (const b of this.placed()) st.set(b.key, b.key === cur ? 'match cur' : hit.has(b.key) ? 'match' : 'dim');
    }
    return st;
  });

  protected readonly edgeState = computed(() => {
    const st = new Map<string, string>();
    const sel = this.selected();
    const searching = !!this.search().trim();
    for (const e of this.edges()) {
      if (sel) st.set(e.key, e.from === sel || e.to === sel ? 'hl' : 'dim');
      else if (searching) st.set(e.key, 'dim');
    }
    return st;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopDrag?.());
    // laden, sobald der Tab sichtbar ist, und wenn Schema oder Datenbank wechseln
    effect(() => {
      const t = this.tab();
      const on = this.active();
      const id = [t.connectionId, t.database, t.schema].join('\u0000');
      untracked(() => {
        if (on && id !== this.loadedFor) void this.load();
      });
    });
    // anderer Ausschnitt: von vorn anordnen und einpassen
    effect(() => {
      this.focusKey();
      this.depth();
      untracked(() => {
        this.fitPending = true;
        this.moved.set(new Map());
        this.selected.set(null);
      });
    });
    // einpassen, sobald etwas zu sehen ist und der Tab Platz hat
    afterRenderEffect(() => {
      const on = this.active();
      const n = this.placed().length;
      if (on && n && this.fitPending) untracked(() => this.fit());
    });
  }

  protected async load() {
    const t = this.tab();
    const id = [t.connectionId, t.database, t.schema].join('\u0000');
    const token = ++this.loadToken;
    this.loadedFor = id;
    this.loading.set(true);
    try {
      await this.state.ensureConnected(t.connectionId);
      const needSchemas = this.dialect() !== 'mysql' && !this.schemas().length;
      const [m, schemas] = await Promise.all([
        api.erModel(t.connectionId, t.database, t.schema),
        needSchemas ? api.listSchemas(t.connectionId, t.database).catch(() => [] as string[]) : Promise.resolve(this.schemas()),
      ]);
      if (token !== this.loadToken) return;
      this.schemas.set(schemas);
      this.model.set(m);
      this.error.set(null);
      this.fitPending = true;
      this.moved.set(new Map());
      this.expanded.set(new Set());
      this.selected.set(null);
    } catch (e) {
      if (token === this.loadToken) this.error.set(message(e));
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  protected setSchema(schema: string) {
    this.keysOnly.set(null);
    this.state.updateEr(this.tab().id, { schema, focus: undefined });
  }

  protected setFocus(name: string | undefined) {
    this.state.updateEr(this.tab().id, { focus: name, depth: name ? 1 : this.tab().depth });
  }

  protected setDepth(depth: number) {
    this.state.updateEr(this.tab().id, { depth });
  }

  protected setKeysOnly(on: boolean) {
    this.keysOnly.set(on);
    this.fitPending = true;
  }

  protected setSearch(text: string) {
    this.search.set(text);
    this.current.set(null);
  }

  /** zum nächsten Suchtreffer springen */
  protected nextMatch() {
    const list = this.matches();
    if (!list.length) return;
    const i = (list.indexOf(this.current() ?? '') + 1) % list.length;
    this.current.set(list[i]);
    this.centerOn(list[i]);
  }

  // ---------- Kästen und Linien ----------

  /** Name mit Schema bzw. Datenbank, wenn nicht die eigene */
  private qualified(schema: string, name: string): string {
    return schema && schema !== this.ownSchema() ? `${schema}.${name}` : name;
  }

  private makeBox(
    key: string,
    schema: string,
    name: string,
    columns: { name: string; type: string; nullable: boolean; pk: boolean }[],
    rows: number | undefined,
    external: boolean,
    fkTo: Map<string, string[]> | undefined,
    refFrom: Map<string, string[]> | undefined,
    keysOnly: boolean,
    open: boolean,
  ): ViewBox {
    this.ensureFonts();
    const f = this.fonts;
    const isKey = (c: { name: string; pk: boolean }) => c.pk || !!fkTo?.has(c.name) || !!refFrom?.has(c.name);
    const short = keysOnly ? columns.filter(isKey) : columns.filter((c, i) => i < MAX_COLS || isKey(c));
    const shown = open ? columns : short;
    const more =
      shown.length < columns.length
        ? `+ ${columns.length - shown.length} weitere Spalte${columns.length - shown.length === 1 ? '' : 'n'}`
        : open && short.length < columns.length
          ? '− weniger Spalten'
          : '';

    const inner = MAX_W - NAME_X - PAD;
    let need = 0;
    const cols: ViewCol[] = shown.map((c, i) => {
      const font = c.pk ? f.colBold : f.col;
      const type = this.dialect() === 'postgres' ? shortPgType(c.type) : c.type;
      let typeLabel = type.length > 30 ? type.slice(0, 29) + '…' : type;
      let label = c.name;
      let nw = this.textWidth(label, font);
      let tw = this.textWidth(typeLabel, f.type);
      if (nw + 14 + tw > inner) {
        // zuerst den Typ kürzen (höchstens bis auf 40 % der Breite), dann den Namen
        typeLabel = this.fitText(typeLabel, f.type, Math.max(inner * 0.4, inner - nw - 14));
        tw = this.textWidth(typeLabel, f.type);
        label = this.fitText(label, font, inner - 14 - tw);
        nw = this.textWidth(label, font);
      }
      need = Math.max(need, NAME_X + nw + (tw ? 14 + tw : 0) + PAD);
      const to = fkTo?.get(c.name) ?? [];
      const from = refFrom?.get(c.name) ?? [];
      const tip = [
        `${c.name}${c.type ? '  ' + c.type : ''}${external ? '' : c.nullable ? '  NULL' : '  NOT NULL'}`,
        ...(c.pk ? ['Primärschlüssel'] : []),
        ...to.map((x) => `→ ${x}`),
        ...from.map((x) => `← ${x}`),
      ].join('\n');
      return { name: c.name, label, typeLabel, pk: c.pk, fk: to.length > 0, nullable: c.nullable, y: HEAD + i * ROW, tip };
    });

    const fullTitle = this.qualified(schema, name);
    const rowsLabel = rows == null || rows < 0 ? '' : this.rowsText(rows);
    const rw = rowsLabel ? this.textWidth(rowsLabel, f.small) + 10 : 0;
    const title = this.fitText(fullTitle, f.title, MAX_W - 2 * PAD - rw);
    need = Math.max(need, PAD + this.textWidth(title, f.title) + rw + PAD);
    if (more) need = Math.max(need, NAME_X + this.textWidth(more, f.small) + PAD);
    const w = Math.ceil(clamp(need, MIN_W, MAX_W));
    const h = HEAD + (cols.length + (more ? 1 : 0)) * ROW + 5;
    const where = this.dialect() === 'mysql' ? 'einer anderen Datenbank' : 'einem anderen Schema';
    const tip = external
      ? `${fullTitle}\nTabelle in ${where} – hier nur die verwiesenen Spalten`
      : `${fullTitle}${rowsLabel ? `\netwa ${rows!.toLocaleString('de-CH')} Zeilen (Schätzung)` : ''}\n${columns.length} Spalten · Doppelklick: Daten anzeigen`;
    return {
      key,
      schema,
      name,
      fullTitle,
      title,
      rowsLabel,
      cols,
      pkCols: columns.filter((c) => c.pk).map((c) => c.name),
      more,
      moreY: HEAD + cols.length * ROW,
      external,
      tip,
      head: `M0 5a5 5 0 0 1 5-5H${w - 5}a5 5 0 0 1 5 5V${HEAD}H0Z`,
      w,
      h,
    };
  }

  private rowsText(r: number): string {
    if (r < 1000) return String(Math.round(r));
    if (r < 1_000_000) return (r / 1000).toFixed(r < 10_000 ? 1 : 0) + 'k';
    return (r / 1_000_000).toFixed(1) + 'M';
  }

  /** Linie von der Fremdschlüssel-Spalte zur verwiesenen Spalte; Krähenfuß = viele, Strich = eine, Kreis = optional */
  private geometry(f: ErForeignKey, a: PlacedBox, b: PlacedBox, route?: ErWaypoint[]): { line: string; ends: string; dots: string } {
    const y1 = this.rowY(a, f.columns[0]);
    const y2 = this.rowY(b, f.refColumns[0]);
    let x1: number, s1: number, x2: number, s2: number;
    if (a.key !== b.key && a.x >= b.x + b.w) [x1, s1, x2, s2] = [a.x, -1, b.x + b.w, 1];
    else if (a.key !== b.key && a.x + a.w <= b.x) [x1, s1, x2, s2] = [a.x + a.w, 1, b.x, -1];
    // übereinander oder Selbstbezug: Bogen rechts herum
    else [x1, s1, x2, s2] = [a.x + a.w, 1, b.x + b.w, 1];
    // waagrechte Tangenten an beiden Enden
    const curve = (ax: number, ay: number, bx: number, by: number) => {
      const c = Math.max(20, Math.abs(bx - ax) / 2);
      const s = bx >= ax ? 1 : -1;
      return `C${ax + s * c} ${ay} ${bx - s * c} ${by} ${bx} ${by}`;
    };
    let line: string;
    if (s1 === s2) {
      const cx = Math.max(x1, x2) + 40 + Math.min(80, Math.abs(y2 - y1) / 6);
      line = `M${x1} ${y1}C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
    } else if (route?.length) {
      // lange Verbindung: durch die Lücken zwischen den Kästen der Spalten dazwischen
      line = `M${x1} ${y1}`;
      let px = x1;
      let py = y1;
      for (const w of route) {
        const [enter, leave] = s1 < 0 ? [w.x2, w.x1] : [w.x1, w.x2];
        line += curve(px, py, enter, w.y) + `L${leave} ${w.y}`;
        px = leave;
        py = w.y;
      }
      line += curve(px, py, x2, y2);
    } else {
      line = `M${x1} ${y1}` + curve(x1, y1, x2, y2);
    }
    const bar = (x: number, y: number) => `M${x} ${y - 5}V${y + 5}`;
    const dot = (x: number, y: number) => `M${x + 3.5} ${y}a3.5 3.5 0 1 0-7 0a3.5 3.5 0 1 0 7 0`;
    const optional = f.columns.some((c) => a.cols.find((x) => x.name === c)?.nullable);
    // Fremdschlüssel = ganzer Primärschlüssel: höchstens eine Zeile je verwiesener Zeile
    const oneToOne = a.pkCols.length === f.columns.length && f.columns.every((c) => a.pkCols.includes(c));
    let ends = oneToOne ? bar(x1 + s1 * 8, y1) : `M${x1} ${y1 - 5}L${x1 + s1 * 10} ${y1}L${x1} ${y1 + 5}`;
    let dots = oneToOne ? dot(x1 + s1 * 15, y1) : '';
    ends += bar(x2 + s2 * 8, y2);
    if (optional) dots += dot(x2 + s2 * 15, y2);
    else ends += bar(x2 + s2 * 12, y2);
    return { line, ends, dots };
  }

  private rowY(b: PlacedBox, col: string): number {
    const c = b.cols.find((x) => x.name === col);
    return b.y + (c ? c.y + ROW / 2 : HEAD / 2);
  }

  private ensureFonts() {
    if (this.measureCtx) return;
    this.measureCtx = document.createElement('canvas').getContext('2d')!;
    const cs = getComputedStyle(document.documentElement);
    const sans = cs.getPropertyValue('--font').trim() || 'sans-serif';
    const mono = cs.getPropertyValue('--mono').trim() || 'monospace';
    this.fonts = { title: `600 12px ${sans}`, col: `12px ${sans}`, colBold: `600 12px ${sans}`, type: `11px ${mono}`, small: `11px ${sans}` };
  }

  private textWidth(text: string, font: string): number {
    if (!text) return 0;
    this.measureCtx!.font = font;
    return this.measureCtx!.measureText(text).width;
  }

  /** Text mit … kürzen, bis er in max passt */
  private fitText(text: string, font: string, max: number): string {
    if (this.textWidth(text, font) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.textWidth(text.slice(0, mid) + '…', font) <= max) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // ---------- Ansicht: verschieben, zoomen, einpassen ----------

  private apply() {
    this.world().nativeElement.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.k})`);
    this.zoomText().nativeElement.textContent = `${Math.round(this.k * 100)} %`;
  }

  /** Bereich aller Kästen (Bögen rechts eingerechnet) */
  private bounds(margin: number): { x: number; y: number; w: number; h: number } | null {
    const list = this.placed();
    if (!list.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of list) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    x1 += 50;
    return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
  }

  protected fit() {
    const el = this.canvas().nativeElement;
    const b = this.bounds(12);
    if (!b) return;
    if (!el.clientWidth || !el.clientHeight) {
      this.fitPending = true;
      return;
    }
    this.fitPending = false;
    this.k = clamp(Math.min(el.clientWidth / b.w, el.clientHeight / b.h, 1), MIN_ZOOM, MAX_ZOOM);
    this.tx = Math.round((el.clientWidth - b.w * this.k) / 2 - b.x * this.k);
    this.ty = Math.round(Math.max(0, (el.clientHeight - b.h * this.k) / 2) - b.y * this.k);
    this.apply();
  }

  private zoomAt(factor: number, cx: number, cy: number) {
    const k = clamp(this.k * factor, MIN_ZOOM, MAX_ZOOM);
    // der Punkt unter dem Mauszeiger bleibt stehen
    this.tx = cx - (cx - this.tx) * (k / this.k);
    this.ty = cy - (cy - this.ty) * (k / this.k);
    this.k = k;
    this.apply();
  }

  protected zoomBy(factor: number) {
    const el = this.canvas().nativeElement;
    this.zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  }

  private centerOn(key: string) {
    const b = this.placed().find((x) => x.key === key);
    if (!b) return;
    const el = this.canvas().nativeElement;
    this.k = Math.max(this.k, 0.8);
    this.tx = Math.round(el.clientWidth / 2 - (b.x + b.w / 2) * this.k);
    this.ty = Math.round(el.clientHeight / 2 - (b.y + Math.min(b.h, el.clientHeight / this.k - 40) / 2) * this.k);
    this.apply();
  }

  /** Mausrad verschiebt, mit Strg (bzw. Zwei-Finger-Zoom) wird gezoomt */
  protected wheel(ev: WheelEvent) {
    ev.preventDefault();
    const lines = ev.deltaMode === 1 ? 16 : 1;
    if (ev.ctrlKey || ev.metaKey) {
      const r = this.canvas().nativeElement.getBoundingClientRect();
      this.zoomAt(Math.exp(-ev.deltaY * lines * 0.0025), ev.clientX - r.left, ev.clientY - r.top);
      return;
    }
    this.tx -= (ev.shiftKey ? ev.deltaY : ev.deltaX) * lines;
    this.ty -= (ev.shiftKey ? 0 : ev.deltaY) * lines;
    this.apply();
  }

  protected key(ev: KeyboardEvent) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const step = 60;
    switch (ev.key) {
      case '+':
      case '=':
        this.zoomBy(1.25);
        break;
      case '-':
        this.zoomBy(0.8);
        break;
      case '0':
        this.fit();
        break;
      case 'Escape':
        this.selected.set(null);
        break;
      case 'ArrowLeft':
        this.tx += step;
        this.apply();
        break;
      case 'ArrowRight':
        this.tx -= step;
        this.apply();
        break;
      case 'ArrowUp':
        this.ty += step;
        this.apply();
        break;
      case 'ArrowDown':
        this.ty -= step;
        this.apply();
        break;
      default:
        return;
    }
    ev.preventDefault();
  }

  private drag(move: (e: MouseEvent) => void, up: (e: MouseEvent) => void) {
    this.stopDrag?.();
    let prev: MouseEvent | null = null;
    const stop = () => {
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      if (this.stopDrag === stop) this.stopDrag = null;
    };
    const mm = (e: MouseEvent) => {
      // Taste woanders losgelassen (Alt+Tab, Fenster ohne Fokus): das mouseup kam nie an – an der letzten Stelle
      // beenden, statt den Kasten bzw. die Ansicht weiter am Zeiger zu führen
      if ((e.buttons & 1) === 0) {
        stop();
        up(prev ?? e);
        return;
      }
      prev = e;
      move(e);
    };
    const mu = (e: MouseEvent) => {
      stop();
      up(e);
    };
    this.stopDrag = stop;
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  }

  /** Doppelklick auf einen Kasten öffnet die Daten – nicht, wenn er auf „+ n weitere Spalten“ begann (der erste Klick
   *  klappt um, die Zeile wandert, der zweite trifft eine Spaltenzeile desselben Kastens) */
  protected dblBox(b: PlacedBox) {
    if (performance.now() - this.toggledAt < 700) return;
    this.openData(b);
  }

  /** Hintergrund ziehen = Ansicht verschieben, Klick = Auswahl aufheben */
  protected downCanvas(ev: MouseEvent) {
    if (ev.button !== 0) return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    const tx = this.tx;
    const ty = this.ty;
    let far = false;
    this.drag(
      (e) => {
        if (!far && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        far = true;
        this.tx = tx + e.clientX - sx;
        this.ty = ty + e.clientY - sy;
        this.apply();
      },
      () => {
        if (!far) this.selected.set(null);
      },
    );
  }

  /** Kasten ziehen = Tabelle verschieben, Klick = auswählen (mit Nachbarn hervorheben) */
  protected downBox(ev: MouseEvent, b: PlacedBox) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    this.canvas().nativeElement.focus({ preventScroll: true });
    const sx = ev.clientX;
    const sy = ev.clientY;
    let far = false;
    let frame = 0;
    let last = ev;
    const place = () => {
      frame = 0;
      const m = new Map(this.moved());
      m.set(b.key, { x: Math.round(b.x + (last.clientX - sx) / this.k), y: Math.round(b.y + (last.clientY - sy) / this.k) });
      this.moved.set(m);
    };
    this.drag(
      (e) => {
        if (!far && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        far = true;
        last = e;
        if (!frame) frame = requestAnimationFrame(place);
      },
      (e) => {
        cancelAnimationFrame(frame);
        if (far) {
          last = e;
          place();
        } else this.selected.set(b.key);
      },
    );
  }

  protected toggleOpen(b: PlacedBox, ev: MouseEvent) {
    ev.stopPropagation();
    this.toggledAt = performance.now();
    // der Kasten bleibt an seiner Stelle auf dem Bildschirm, auch wenn sich die Anordnung ändert
    const sx = b.x * this.k + this.tx;
    const sy = b.y * this.k + this.ty;
    const s = new Set(this.expanded());
    if (s.has(b.key)) s.delete(b.key);
    else s.add(b.key);
    this.expanded.set(s);
    afterNextRender(
      () => {
        const nb = this.placed().find((x) => x.key === b.key);
        if (!nb) return;
        this.tx = sx - nb.x * this.k;
        this.ty = sy - nb.y * this.k;
        this.apply();
      },
      { injector: this.injector },
    );
  }

  protected relayout() {
    this.moved.set(new Map());
    afterNextRender(() => this.fit(), { injector: this.injector });
  }

  // ---------- Menüs ----------

  private refOf(b: PlacedBox): ObjectRef {
    const t = this.tab();
    if (this.dialect() === 'mysql') return { connectionId: t.connectionId, database: b.schema || t.database, schema: '', name: b.name, kind: 'table' };
    return { connectionId: t.connectionId, database: t.database, schema: b.schema, name: b.name, kind: 'table' };
  }

  protected openData(b: PlacedBox) {
    this.state.openTable(this.refOf(b));
  }

  protected boxMenu(ev: MouseEvent, b: PlacedBox) {
    this.selected.set(b.key);
    const t = this.tab();
    const d = this.dialect();
    const ref = this.refOf(b);
    const name = d === 'mysql' && b.schema ? `${quoteIdent(d, b.schema)}.${quoteIdent(d, b.name)}` : objectName(d, ref);
    const items: MenuItem[] = [
      { label: 'Daten anzeigen', icon: 'table', hint: 'Doppelklick', action: () => this.openData(b) },
      { label: 'SELECT in neuer Abfrage', icon: 'query', action: () => this.state.openQuery(t.connectionId, ref.database, selectTop(d, ref, 100)) },
      { separator: true },
      b.external
        ? {
            label: d === 'mysql' ? 'Diagramm dieser Datenbank' : 'Diagramm dieses Schemas',
            icon: 'diagram',
            action: () => this.state.openEr(t.connectionId, ref.database, ref.schema),
          }
        : { label: 'Nur diese Tabelle und ihre Nachbarn', icon: 'diagram', action: () => this.setFocus(b.name) },
      ...(t.focus ? [{ label: 'Alle Tabellen', action: () => this.setFocus(undefined) }] : []),
      { separator: true },
      { label: 'Namen kopieren', icon: 'copy', action: () => void navigator.clipboard.writeText(name) },
    ];
    this.menu.open(ev, items);
  }

  protected canvasMenu(ev: MouseEvent) {
    const has = this.placed().length > 0;
    this.menu.open(ev, [
      { label: 'Einpassen', icon: 'fit', hint: '0', disabled: !has, action: () => this.fit() },
      { label: 'Neu anordnen', icon: 'refresh', disabled: !this.moved().size, action: () => this.relayout() },
      ...(this.tab().focus ? [{ label: 'Alle Tabellen', icon: 'diagram', action: () => this.setFocus(undefined) }] : []),
      { separator: true },
      { label: 'Bild kopieren', icon: 'image', disabled: !has, action: () => void this.copyImage() },
      { label: 'Als SVG speichern …', icon: 'download', disabled: !has, action: () => void this.saveSvg() },
    ]);
  }

  // ---------- Export ----------

  protected exportMenu(ev: MouseEvent) {
    this.menu.openBelow(ev.currentTarget as Element, [
      { label: 'Bild kopieren (PNG)', icon: 'image', action: () => void this.copyImage() },
      { label: 'Als SVG speichern …', icon: 'download', action: () => void this.saveSvg() },
    ]);
  }

  private baseName(): string {
    const t = this.tab();
    return `ER ${t.database}${t.schema ? '.' + t.schema : ''}${t.focus ? ' ab ' + t.focus : ''}`;
  }

  /** eigenständiges SVG wie angezeigt (ohne Abdunkeln), Farben und Schriften fest eingetragen */
  private standaloneSvg(): { svg: string; width: number; height: number } | null {
    const b = this.bounds(20);
    if (!b) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const src = this.world().nativeElement;
    const copy = src.cloneNode(true) as SVGGElement;
    copy.removeAttribute('transform');
    const from = [src, ...Array.from(src.querySelectorAll('*'))];
    const to = [copy, ...Array.from(copy.querySelectorAll('*'))];
    const shapeProps = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'];
    const textProps = ['fill', 'font-family', 'font-size', 'font-weight', 'font-style'];
    from.forEach((el, i) => {
      const out = to[i];
      for (const a of Array.from(out.attributes)) if (a.name.startsWith('_ng')) out.removeAttribute(a.name);
      if (!(el instanceof SVGGraphicsElement) || el instanceof SVGGElement) return;
      const cs = getComputedStyle(el);
      const props = el instanceof SVGTextElement ? textProps : shapeProps;
      out.setAttribute('style', props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
    copy.querySelectorAll('.hit').forEach((x) => x.remove());
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('width', String(Math.ceil(b.w)));
    svg.setAttribute('height', String(Math.ceil(b.h)));
    svg.setAttribute('viewBox', `${Math.floor(b.x)} ${Math.floor(b.y)} ${Math.ceil(b.w)} ${Math.ceil(b.h)}`);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', String(Math.floor(b.x)));
    bg.setAttribute('y', String(Math.floor(b.y)));
    bg.setAttribute('width', String(Math.ceil(b.w)));
    bg.setAttribute('height', String(Math.ceil(b.h)));
    bg.setAttribute('fill', getComputedStyle(this.canvas().nativeElement).backgroundColor);
    svg.append(bg, copy);
    const text = new XMLSerializer().serializeToString(svg).replace(/<!--[\s\S]*?-->/g, '');
    return { svg: text, width: Math.ceil(b.w), height: Math.ceil(b.h) };
  }

  protected async copyImage() {
    const s = this.standaloneSvg();
    if (!s) return;
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svg);
      await img.decode();
      // doppelte Auflösung, solange das Bild nicht zu groß wird
      const scale = Math.max(0.2, Math.min(2, 16000 / s.width, 16000 / s.height, Math.sqrt(120e6 / (s.width * s.height))));
      const c = document.createElement('canvas');
      c.width = Math.round(s.width * scale);
      c.height = Math.round(s.height * scale);
      const g = c.getContext('2d')!;
      g.scale(scale, scale);
      g.drawImage(img, 0, 0, s.width, s.height);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('Das Bild ist zu groß.');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.notice.set({ text: `Bild in der Zwischenablage (${c.width} × ${c.height} Pixel).` });
      this.error.set(null);
    } catch (e) {
      this.error.set(`Bild kopieren: ${message(e)}`);
    }
  }

  protected async saveSvg() {
    const s = this.standaloneSvg();
    if (!s) return;
    try {
      const file = await api.saveSvg(this.baseName(), s.svg);
      if (file) this.notice.set({ text: `Gespeichert: ${file}`, file });
      this.error.set(null);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected showFile(file: string) {
    void api.showInFolder(file);
  }
}
