import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  CellContextMenuEvent,
  CellKeyDownEvent,
  FullWidthCellKeyDownEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  ModuleRegistry,
  RowClassParams,
  SortChangedEvent,
  ValueFormatterParams,
} from 'ag-grid-community';
import type { Cell, ForeignKeyInfo, IncomingKey, ResultColumn, SortSpec } from '../../../../shared/api-types';
import { compareNumeric, formatJson, keepLineEndings } from '../../../../shared/grid-values';
import { keys } from '../core/platform';
import { ContextMenuService, MenuItem } from './context-menu';
import { Icon } from './icon';
import { Theme } from './theme';

ModuleRegistry.registerModules([AllCommunityModule]);

/** eine Zeile; undefined = noch nicht gesetzt (neue Zeile: Standardwert der Datenbank) */
export type Row = (Cell | undefined)[];

/** Bearbeiten-Modus: was darf geändert werden, was ist geändert */
export interface GridEditing {
  editable(row: Row, col: number): boolean;
  isChanged(row: Row, col: number): boolean;
  rowState(row: Row): 'new' | 'deleted' | 'changed' | null;
}

/** Hervorhebung ohne Bearbeiten: Klasse je Zeile (z. B. row-new) und geänderte Zellen */
export interface GridMarks {
  rowClass(row: Row): string | undefined;
  isChanged(row: Row, col: number): boolean;
}

export interface CellEdit {
  row: Row;
  col: number;
  value: Cell;
  previous: Cell | undefined;
}

export type EditAction = { kind: 'null'; row: Row; col: number } | { kind: 'delete'; rows: Row[] } | { kind: 'revert'; rows: Row[] };

export interface FilterRequest {
  column: string;
  value: Cell;
  op: '=' | '<>';
  numeric: boolean;
}

/** Fremdschlüssel der angezeigten Tabelle: ausgehend (diese → andere) und eingehend (andere → diese) */
export interface GridLinks {
  outgoing: ForeignKeyInfo[];
  incoming: IncomingKey[];
}

/** Zieltabelle öffnen mit Spalte = Wert (aus der angeklickten Zeile) */
export interface FollowRequest {
  schema: string;
  table: string;
  /** column = Spalte der Zieltabelle, source = Spalte dieser Tabelle (ihr Typ entscheidet z. B. über Binärwerte) */
  pairs: { column: string; value: Cell; numeric: boolean; source: string }[];
}

/** gekürzter Binärwert („0x1F2E…… (5000 Bytes)“): danach lässt sich weder filtern noch springen */
const TRUNCATED_HEX = /^0x[0-9A-F]*… \(/;

const MAX_SHOWN = 300;
/** so viele eingehende Verweise zeigt das Kontextmenü höchstens */
const MAX_INCOMING = 12;
/** sichtbare Texte von AG Grid auf Deutsch (Filter und Spaltenmenüs sind ausgeschaltet, mehr Texte gibt es nicht) */
const LOCALE_TEXT: Record<string, string> = {
  noRowsToShow: 'Keine Zeilen',
  loadingOoo: 'Lädt …',
  loadingError: 'Fehler beim Laden',
};

function display(v: Cell | undefined): string {
  if (v === undefined) return '(Standard)';
  if (v === null) return 'NULL';
  const s = String(v);
  if (s.length <= MAX_SHOWN) return s.replace(/\r?\n/g, ' ↵ ');
  return s.slice(0, MAX_SHOWN).replace(/\r?\n/g, ' ↵ ') + ' …';
}

function tsvValue(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

@Component({
  selector: 'app-result-grid',
  imports: [AgGridAngular, Icon],
  template: `
    <ag-grid-angular
      class="grid"
      [theme]="theme.grid()"
      [columnDefs]="colDefs()"
      [rowData]="rows()"
      [defaultColDef]="defaultColDef"
      [localeText]="localeText"
      [rowSelection]="rowSelection"
      [autoSizeStrategy]="autoSize"
      [preventDefaultOnContextMenu]="true"
      [suppressDragLeaveHidesColumns]="true"
      [enableCellSpan]="false"
      [animateRows]="false"
      [tooltipShowDelay]="400"
      [getRowClass]="rowClass"
      [stopEditingWhenCellsLoseFocus]="true"
      (gridReady)="onReady($event)"
      (sortChanged)="onSort($event)"
      (cellKeyDown)="onKey($event)"
      (cellContextMenu)="onContext($event)"
      (cellDoubleClicked)="onDouble($event)"
      (cellClicked)="onClick($event)"
    />
    @if (viewer(); as v) {
      <div class="viewer-backdrop" (mousedown)="onViewerBackdrop($event)">
        <div class="viewer" (keydown.escape)="closeViewer()">
          <header>
            <b>{{ v.column }}</b>
            <span class="dim">{{ v.text.length }} Zeichen</span>
            <span class="grow"></span>
            <button type="button" class="btn" (click)="copy(v.text)"><app-icon name="copy" /> Kopieren</button>
            @if (v.json) {
              <button type="button" class="btn" (click)="viewer.set({ column: v.column, text: v.json, json: null })">JSON formatieren</button>
            }
            <button type="button" class="btn icon" (click)="closeViewer()"><app-icon name="close" /></button>
          </header>
          <textarea #viewerText readonly class="mono" [value]="v.text"></textarea>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      min-height: 0;
    }
    .grid {
      width: 100%;
      height: 100%;
    }
    .viewer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 850;
      background: rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .viewer {
      width: min(900px, 90vw);
      height: min(600px, 80vh);
      display: flex;
      flex-direction: column;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
      }
      .grow {
        flex: 1;
      }
      .dim {
        color: var(--fg-dim);
      }
      textarea {
        flex: 1;
        margin: 0 10px 10px;
        resize: none;
        font-size: 12px;
        white-space: pre;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultGrid {
  readonly columns = input.required<ResultColumn[]>();
  readonly rows = input.required<Row[]>();
  /** Zeilennummer beginnt bei offset + 1 (Tabellenansicht mit Seiten) */
  readonly rowOffset = input(0);
  /** gesetzt = Sortierung macht der Server (Tabellenansicht) */
  readonly serverSort = input<SortSpec[] | null>(null);
  /** Kontextmenü bietet "Filtern nach …" an */
  readonly filterable = input(false);
  /** Fremdschlüssel: Kontextmenü „→ Tabelle öffnen“, Strg+Klick auf eine Verweis-Spalte */
  readonly links = input<GridLinks | null>(null);
  readonly follow = output<FollowRequest>();
  /** Bearbeiten-Modus der Tabellenansicht; null = nur lesen */
  readonly editing = input<GridEditing | null>(null);
  /** nur Anzeige: Zeilen und Zellen hervorheben (Datenvergleich) */
  readonly marks = input<GridMarks | null>(null);
  /** aus, solange ungespeicherte Änderungen da sind (Sortieren lädt neu) */
  readonly sortable = input(true);
  readonly cellEdit = output<CellEdit>();
  readonly editAction = output<EditAction>();
  readonly sortChange = output<SortSpec[]>();
  readonly filterRequest = output<FilterRequest>();
  readonly exportRequest = output<void>();

  protected theme = inject(Theme);
  private menu = inject(ContextMenuService);
  private api?: GridApi<Row>;
  private ready = signal(false);
  protected viewer = signal<{ column: string; text: string; json: string | null } | null>(null);
  private viewerText = viewChild<ElementRef<HTMLTextAreaElement>>('viewerText');
  /** Element mit dem Fokus vor dem Öffnen des Betrachters (meist die Zelle): bekommt ihn beim Schließen zurück */
  private returnFocus: HTMLElement | null = null;

  constructor() {
    // Wertbetrachter: Fokus hinein (autofocus greift bei nachträglich erzeugtem Inhalt nicht) – sonst gingen Esc, Pfeile
    // und Strg+C an das Grid dahinter
    effect(() => {
      const el = this.viewerText()?.nativeElement;
      if (el) setTimeout(() => el.focus(), 0);
    });
    // Sortierung von außen (z. B. zurückgenommen, weil der Server sie ablehnt): Pfeile im Kopf nachziehen.
    // Die Spalten werden dafür nicht neu gebaut (Breiten blieben sonst nicht erhalten); Quelle „api“ meldet onSort nicht weiter.
    effect(() => {
      const s = this.serverSort();
      if (!s || !this.ready()) return;
      const cols = untracked(() => this.columns());
      this.api?.applyColumnState({
        state: cols.map((c, i) => {
          const k = s.findIndex((x) => x.column === c.name);
          return { colId: 'c' + i, sort: k >= 0 ? s[k].dir : null, sortIndex: k >= 0 ? k : null };
        }),
      });
    });
  }

  protected readonly defaultColDef: ColDef<Row> = {
    resizable: true,
    sortable: true,
    minWidth: 50,
    maxWidth: 420,
    suppressHeaderMenuButton: true,
    suppressMovable: false,
  };
  protected readonly localeText = LOCALE_TEXT;
  protected readonly rowSelection = { mode: 'multiRow' as const, checkboxes: false, headerCheckbox: false, enableClickSelection: true };
  protected readonly autoSize = { type: 'fitCellContents' as const };

  private colKey = '';
  private colCache: ColDef<Row>[] = [];

  /** Spaltendefinitionen nur bei geänderten Spalten neu bauen, sonst geht Breite/Sortierung verloren */
  protected readonly colDefs = computed(() => {
    const cols = this.columns();
    const server = this.serverSort() !== null;
    const out = this.links()?.outgoing ?? [];
    const edit = this.editing();
    const marks = this.marks();
    const sortable = this.sortable();
    const key =
      (server ? 's|' : 'c|') +
      cols.map((c) => c.name + ':' + c.typeName).join('|') +
      '|fk:' +
      out.map((f) => f.name).join(',') +
      `|e:${!!edit}|m:${!!marks}|s:${sortable}`;
    if (key === this.colKey) return this.colCache;
    this.colKey = key;
    const offset = () => this.rowOffset();
    const defs: ColDef<Row>[] = [
      {
        colId: '#',
        headerName: '',
        valueGetter: (p) => offset() + (p.node?.rowIndex ?? 0) + 1,
        width: 56,
        minWidth: 40,
        maxWidth: 90,
        pinned: 'left',
        sortable: false,
        resizable: true,
        cellClass: 'rownum',
        suppressNavigable: true,
      },
      ...cols.map((c, i): ColDef<Row> => {
        const fk = out.find((f) => f.columns.includes(c.name));
        const target = fk ? ` → ${fk.refTable} (${fk.refColumns.join(', ')}) · ${keys('Strg+Klick')} öffnet` : '';
        return {
          colId: 'c' + i,
          headerName: c.name,
          headerTooltip: (c.typeName ? `${c.name} · ${c.typeName}` : c.name) + target,
          headerClass: fk ? 'fk-head' : undefined,
          sortable,
          valueGetter: (p) => (p.data ? p.data[i] : null),
          valueFormatter: (p: ValueFormatterParams<Row, Cell | undefined>) => display(p.value),
          cellClass: (p) =>
            [
              c.numeric ? 'num' : '',
              p.value === null ? 'is-null' : p.value === undefined ? 'is-default' : fk ? 'fk' : '',
              p.data && (edit?.isChanged(p.data, i) || marks?.isChanged(p.data, i)) ? 'changed' : '',
            ].filter(Boolean),
          editable: edit ? (p) => !!p.data && edit.editable(p.data, i) : false,
          valueSetter: edit ? (p) => this.setValue(p.data, i, p.newValue) : undefined,
          // langer oder mehrzeiliger Text: großes Eingabefeld
          cellEditorSelector: (p) =>
            typeof p.value === 'string' && (p.value.length > 60 || p.value.includes('\n'))
              ? { component: 'agLargeTextCellEditor', popup: true, params: { maxLength: 100_000_000, rows: 12, cols: 70 } }
              : { component: 'agTextCellEditor' },
          // ohne Server-Sortierung: Zahlen als Text (BIGINT, DECIMAL, numeric) numerisch, nicht zeichenweise
          comparator: server ? () => 0 : c.numeric ? compareNumeric : undefined,
          sort: server ? (this.serverSort()!.find((s) => s.column === c.name)?.dir ?? null) : undefined,
        };
      }),
    ];
    this.colCache = defs;
    return defs;
  });

  protected readonly rowClass = (p: RowClassParams<Row>): string | undefined => {
    if (!p.data) return undefined;
    const s = this.editing()?.rowState(p.data);
    return s ? 'row-' + s : this.marks()?.rowClass(p.data);
  };

  /** Eingabe übernehmen; unverändert (auch 12 ↔ "12", leeres Feld auf NULL) = keine Änderung */
  private setValue(row: Row | undefined, i: number, raw: unknown): boolean {
    if (!row) return false;
    const old = row[i];
    let v: Cell = raw === undefined || raw === null ? null : typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : String(raw);
    // das große Eingabefeld macht aus CRLF ein LF: sonst änderte ein einzelnes Wort alle Zeilenenden des Felds
    if (typeof v === 'string') v = keepLineEndings(old, v);
    if (v === old) return false;
    if (old !== null && old !== undefined && v !== null && String(v) === String(old)) return false;
    if ((old === null || old === undefined) && v === '') return false;
    row[i] = v;
    this.cellEdit.emit({ row, col: i, value: v, previous: old });
    return true;
  }

  /** nach Änderungen außerhalb des Grids (NULL setzen, löschen, verwerfen) neu zeichnen */
  refresh(): void {
    this.api?.refreshCells({ force: true });
    this.api?.redrawRows();
  }

  /** eine Zelle sofort bearbeiten (neue Zeile) */
  startEditing(rowIndex: number, col: number): void {
    if (!this.api) return;
    this.api.ensureIndexVisible(rowIndex);
    this.api.setFocusedCell(rowIndex, 'c' + col);
    this.api.startEditingCell({ rowIndex, colKey: 'c' + col });
  }

  /** nur Klick auf den Hintergrund schließt (kein Rückgabewert: false würde Angular als preventDefault werten) */
  protected onViewerBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closeViewer();
  }

  /** Betrachter zu, Fokus zurück auf die Zelle (Pfeiltasten gehen weiter im Grid) */
  protected closeViewer(): void {
    this.viewer.set(null);
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus();
    else {
      const fc = this.api?.getFocusedCell();
      if (fc) this.api!.setFocusedCell(fc.rowIndex, fc.column, fc.rowPinned);
    }
  }

  protected onReady(e: GridReadyEvent<Row>) {
    this.api = e.api;
    this.ready.set(true);
  }

  protected onSort(e: SortChangedEvent<Row>) {
    if (this.serverSort() === null || e.source === 'api') return;
    const cols = this.columns();
    const specs = e.api
      .getColumnState()
      .filter((s) => s.sort && s.colId.startsWith('c'))
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map((s) => ({ column: cols[Number(s.colId.slice(1))].name, dir: s.sort as 'asc' | 'desc' }));
    this.sortChange.emit(specs);
  }

  private colIndex(colId: string | undefined): number {
    return colId && colId.startsWith('c') ? Number(colId.slice(1)) : -1;
  }

  /** markierte Zeilen in Anzeigereihenfolge */
  selectedRows(): Row[] {
    const out: Row[] = [];
    this.api?.forEachNodeAfterFilterAndSort((n) => n.isSelected() && n.data && out.push(n.data));
    return out;
  }

  protected copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  private selectedOrRow(row: Row | undefined): Row[] {
    const sel = this.selectedRows();
    if (row && !sel.includes(row)) return [row];
    return sel.length ? sel : row ? [row] : [];
  }

  private rowsAsTsv(rows: Row[], header: boolean): string {
    const lines = rows.map((r) => r.map(tsvValue).join('\t'));
    if (header) lines.unshift(this.columns().map((c) => tsvValue(c.name)).join('\t'));
    return lines.join('\r\n');
  }

  protected onKey(e: CellKeyDownEvent<Row> | FullWidthCellKeyDownEvent<Row>) {
    const ev = e.event as KeyboardEvent | null;
    if (!('column' in e)) return;
    if (!ev || !(ev.ctrlKey || ev.metaKey)) return;
    // im geöffneten Zelleditor gelten die Tasten des Eingabefelds (Text markieren, kopieren), nicht die des Grids
    const target = ev.target as HTMLElement | null;
    if ((this.api?.getEditingCells().length ?? 0) > 0 || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    const edit = this.editing();
    const col = this.colIndex(e.column.getColId());
    // Strg+0: auf NULL setzen (wie in dbForge)
    if (ev.key === '0' && edit && e.data && col >= 0 && edit.editable(e.data, col)) {
      this.editAction.emit({ kind: 'null', row: e.data, col });
      ev.preventDefault();
      return;
    }
    if (ev.key === 'c' || ev.key === 'C') {
      const sel = this.selectedRows();
      if (sel.length > 1) this.copy(this.rowsAsTsv(sel, ev.shiftKey));
      else {
        const i = this.colIndex(e.column.getColId());
        const v = e.data?.[i];
        // Standardwert einer neuen Zeile (undefined) wie NULL: leer, nicht „undefined“
        if (i >= 0 && e.data) this.copy(v === null || v === undefined ? '' : String(v));
      }
      ev.preventDefault();
    } else if (ev.key === 'a' || ev.key === 'A') {
      this.api?.selectAll();
      ev.preventDefault();
    }
  }

  protected onDouble(e: { column: { getColId(): string }; data?: Row }) {
    const i = this.colIndex(e.column.getColId());
    if (i < 0 || !e.data) return;
    // im Bearbeiten-Modus öffnet der Doppelklick das Eingabefeld
    if (this.editing()?.editable(e.data, i)) return;
    const v = e.data[i];
    if (typeof v === 'string' && (v.length > 60 || v.includes('\n'))) this.showValue(i, v);
  }

  private showValue(i: number, v: Cell | undefined) {
    const text = v === null || v === undefined ? '' : String(v);
    let json: string | null = null;
    // nur einrücken: JSON.parse/stringify rundete große Zahlen und änderte Schlüsselreihenfolge und Dubletten
    if (/^\s*[[{]/.test(text)) json = formatJson(text);
    this.returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    this.viewer.set({ column: this.columns()[i].name, text, json });
  }

  /** Werte der Spalten aus der Zeile; null, wenn einer fehlt (NULL oder gekürzte Binärdaten) */
  private pairs(row: Row, names: string[], targets: string[]): FollowRequest['pairs'] | null {
    const cols = this.columns();
    const out: FollowRequest['pairs'] = [];
    for (let k = 0; k < names.length; k++) {
      const i = cols.findIndex((c) => c.name === names[k]);
      if (i < 0) return null;
      const v = row[i];
      if (v === null || v === undefined || (typeof v === 'string' && TRUNCATED_HEX.test(v))) return null;
      out.push({ column: targets[k], value: v, numeric: cols[i].numeric, source: names[k] });
    }
    return out;
  }

  private outgoingFor(colName: string | undefined, row: Row | undefined): (FollowRequest & { fk: ForeignKeyInfo })[] {
    if (!row) return [];
    const res: (FollowRequest & { fk: ForeignKeyInfo })[] = [];
    for (const fk of this.links()?.outgoing ?? []) {
      if (colName && !fk.columns.includes(colName)) continue;
      const pairs = this.pairs(row, fk.columns, fk.refColumns);
      if (pairs) res.push({ schema: fk.refSchema, table: fk.refTable, pairs, fk });
    }
    return res;
  }

  /** Strg+Klick auf eine Verweis-Spalte: Zieltabelle öffnen */
  protected onClick(e: { event?: Event | null; column: { getColId(): string }; data?: Row }) {
    const ev = e.event as MouseEvent | null | undefined;
    if (!ev || !(ev.ctrlKey || ev.metaKey)) return;
    const i = this.colIndex(e.column.getColId());
    if (i < 0) return;
    const [first] = this.outgoingFor(this.columns()[i].name, e.data);
    if (first) this.follow.emit({ schema: first.schema, table: first.table, pairs: first.pairs });
  }

  private short(v: Cell | undefined): string {
    const s = display(v);
    return s.length > 24 ? s.slice(0, 23) + '…' : s;
  }

  protected onContext(e: CellContextMenuEvent<Row>) {
    const ev = e.event as MouseEvent | null;
    if (!ev) return;
    const i = this.colIndex(e.column.getColId());
    const row = e.data;
    if (row && e.node && !e.node.isSelected()) {
      e.node.setSelected(true, true);
    }
    const rows = this.selectedOrRow(row);
    const col = i >= 0 ? this.columns()[i] : undefined;
    const v = i >= 0 && row ? row[i] : undefined;
    const items: MenuItem[] = [];
    // Bearbeiten: NULL setzen, Zeilen löschen, Änderungen verwerfen
    const edit = this.editing();
    if (edit && row) {
      if (col && v !== null && edit.editable(row, i)) items.push({ label: 'Auf NULL setzen', hint: keys('Strg+0'), action: () => this.editAction.emit({ kind: 'null', row, col: i }) });
      const live = rows.filter((r) => edit.rowState(r) !== 'deleted');
      if (live.length) items.push({ label: live.length > 1 ? `${live.length} Zeilen löschen` : 'Zeile löschen', icon: 'trash', action: () => this.editAction.emit({ kind: 'delete', rows: live }) });
      const touched = rows.filter((r) => edit.rowState(r) !== null);
      if (touched.length) items.push({ label: touched.length > 1 ? `Änderungen an ${touched.length} Zeilen verwerfen` : 'Änderungen an dieser Zeile verwerfen', action: () => this.editAction.emit({ kind: 'revert', rows: touched }) });
      if (items.length) items.push({ separator: true });
    }
    if (col && v !== undefined) {
      items.push(
        { label: 'Wert kopieren', icon: 'copy', hint: keys('Strg+C'), action: () => this.copy(v === null ? '' : String(v)) },
        { label: 'Wert anzeigen …', action: () => this.showValue(i, v) },
      );
    }
    items.push(
      { label: rows.length > 1 ? `${rows.length} Zeilen kopieren` : 'Zeile kopieren', action: () => this.copy(this.rowsAsTsv(rows, false)) },
      { label: rows.length > 1 ? `${rows.length} Zeilen mit Spaltennamen kopieren` : 'Zeile mit Spaltennamen kopieren', action: () => this.copy(this.rowsAsTsv(rows, true)) },
    );
    if (col) {
      items.push({
        label: `Spalte „${col.name}" kopieren`,
        action: () => {
          const all: string[] = [];
          this.api?.forEachNodeAfterFilterAndSort((n) => n.data && all.push(tsvValue(n.data[i])));
          this.copy(all.join('\r\n'));
        },
      });
    }
    items.push({ separator: true }, { label: 'Exportieren …', icon: 'download', action: () => this.exportRequest.emit() });
    // Fremdschlüssel: zur verwiesenen Zeile bzw. zu den Zeilen, die auf diese verweisen
    if (this.links() && row && rows.length === 1) {
      const nav: MenuItem[] = [];
      const outs = this.outgoingFor(col?.name, row);
      for (const o of outs.length ? outs : this.outgoingFor(undefined, row)) {
        const cond = o.pairs.map((p) => `${p.column} = ${this.short(p.value)}`).join(', ');
        nav.push({ label: `→ ${o.table} öffnen (${cond})`, icon: 'link', hint: outs.length && col ? keys('Strg+Klick') : undefined, action: () => this.follow.emit(o) });
      }
      const inc = this.links()!.incoming;
      for (const k of inc.slice(0, MAX_INCOMING)) {
        const pairs = this.pairs(row, k.refColumns, k.columns);
        if (!pairs) continue;
        const cond = pairs.map((p) => `${p.column} = ${this.short(p.value)}`).join(', ');
        nav.push({ label: `← ${k.table} mit ${cond}`, action: () => this.follow.emit({ schema: k.schema, table: k.table, pairs }) });
      }
      if (inc.length > MAX_INCOMING) nav.push({ label: `… ${inc.length - MAX_INCOMING} weitere Verweise (siehe Struktur)`, disabled: true });
      if (nav.length) items.push({ separator: true }, ...nav);
    }
    if (this.filterable() && col && v !== undefined && typeof v === 'string' && TRUNCATED_HEX.test(v)) {
      items.push({ separator: true }, { label: 'Filtern: der Binärwert ist gekürzt – nur über WHERE möglich', icon: 'filter', disabled: true });
    } else if (this.filterable() && col && v !== undefined) {
      const shown = v === null ? 'NULL' : display(v).slice(0, 40);
      items.push(
        { separator: true },
        { label: v === null ? `Filtern: ${col.name} IS NULL` : `Filtern: ${col.name} = ${shown}`, icon: 'filter', action: () => this.filterRequest.emit({ column: col.name, value: v, op: '=', numeric: col.numeric }) },
        { label: v === null ? `Filtern: ${col.name} IS NOT NULL` : `Filtern: ${col.name} ≠ ${shown}`, action: () => this.filterRequest.emit({ column: col.name, value: v, op: '<>', numeric: col.numeric }) },
      );
    }
    this.menu.open(ev, items);
  }
}
