import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { Cell, ResultColumn, RowChange, SortSpec, TableDataRequest, TableInfo } from '../../../../shared/api-types';
import { EditState } from '../../../../shared/edit-state';
import { baseType, condition, isBinaryType, keyColumns, objectName } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { AppState, TableTab } from '../core/state';
import { SqlEditor } from '../editor/sql-editor';
import { Icon } from '../ui/icon';
import { KeysPipe } from '../ui/keys.pipe';
import { Modal, overlayOpen } from '../ui/modal';
import { CellEdit, EditAction, FilterRequest, FollowRequest, GridEditing, GridLinks, ResultGrid, Row } from '../ui/result-grid';
import { ExportService } from '../export-dialog/export-dialog';

type Sub = 'data' | 'structure' | 'ddl';
const fmt = new Intl.NumberFormat('de-CH');

@Component({
  selector: 'app-table-view',
  imports: [Icon, Modal, ResultGrid, SqlEditor, KeysPipe],
  templateUrl: './table-view.html',
  styleUrl: './table-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TableView {
  readonly tab = input.required<TableTab>();
  readonly active = input(false);
  protected state = inject(AppState);
  private exporter = inject(ExportService);

  protected sub = signal<Sub>('data');
  protected readonly pageSizes = [100, 500, 1000, 5000];

  // Daten
  protected columns = signal<ResultColumn[]>([]);
  protected rows = signal<Row[]>([]);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected sql = signal('');
  protected durationMs = signal(0);
  protected total = signal<number | null>(null);
  protected counting = signal(false);
  protected limit = signal(500);
  protected offset = signal(0);
  protected sort = signal<SortSpec[]>([]);
  protected where = signal('');
  protected whereDraft = signal('');
  protected search = signal('');
  protected searchDraft = signal('');

  // Struktur / DDL
  protected info = signal<TableInfo | null>(null);
  protected infoError = signal<string | null>(null);
  protected ddl = signal<string | null>(null);
  protected ddlError = signal<string | null>(null);

  private started = false;
  private seq = 0;
  /** eigene Laufnummer der Zählung: ein Seitenwechsel oder Sortieren (reload(false)) überholt sie, macht sie aber nicht ungültig */
  private countSeq = 0;

  // Bearbeiten (nur nach ausdrücklichem Einschalten; gespeichert wird erst nach Vorschau)
  protected editMode = signal(false);
  /** geänderte, neue und gelöschte Zeilen */
  protected pending = signal(0);
  protected editError = signal<string | null>(null);
  protected preview = signal<string[] | null>(null);
  protected saving = signal(false);
  /** geänderte, neue und gelöschte Zeilen samt Ausgangswerten (shared/edit-state.ts, mit Tests) */
  private edit = new EditState();
  private grid = viewChild(ResultGrid);

  protected readonly dialect = computed(() => this.state.dialect(this.tab().ref.connectionId));
  /** Elasticsearch: nur lesen, WHERE in SQL von Elasticsearch, Struktur = Felder, DDL = Mapping */
  protected readonly es = computed(() => this.dialect() === 'elasticsearch');
  protected readonly title = computed(() => (this.es() ? this.tab().ref.name : objectName(this.dialect(), this.tab().ref)));
  protected readonly wherePlaceholder = computed(() =>
    this.es() ? "z. B. ort = 'Bern' AND MATCH(notiz, 'Fehler')   (Enter)" : "z. B. ort = 'Bern' AND guthaben > 100   (Enter)",
  );
  protected readonly pageText = computed(() => {
    const n = this.rows().length;
    const from = n ? this.offset() + 1 : 0;
    const to = this.offset() + n;
    const total = this.total();
    return `${fmt.format(from)}–${fmt.format(to)}` + (total !== null ? ` von ${fmt.format(total)}` : this.counting() ? ' von …' : '');
  });
  protected readonly canNext = computed(() => {
    const t = this.total();
    return t === null ? this.rows().length === this.limit() : this.offset() + this.limit() < t;
  });
  protected readonly filtered = computed(() => !!this.where().trim() || !!this.search().trim());
  protected readonly readOnly = computed(() => !!this.state.connection(this.tab().ref.connectionId)?.options?.readOnly);
  protected readonly keyCols = computed(() => {
    const i = this.info();
    return i ? keyColumns(i) : null;
  });
  /** warum Bearbeiten nicht geht; null = geht */
  protected readonly editBlock = computed(() => {
    if (this.es()) return 'Elasticsearch-Verbindungen sind in OwlynDB nur zum Lesen.';
    if (this.tab().ref.kind === 'view') return 'Views lassen sich nicht bearbeiten.';
    if (this.readOnly()) return 'Die Verbindung steht auf „Nur lesen“.';
    if (!this.info()) return this.infoError() ? `Struktur nicht lesbar: ${this.infoError()} – „Neu laden“ versucht es noch einmal.` : 'Struktur wird noch geladen …';
    if (!this.keyCols()) return 'Die Tabelle hat keinen Primärschlüssel – Zeilen lassen sich nicht eindeutig ändern.';
    return null;
  });
  /** solange Änderungen offen sind: kein Seitenwechsel, Sortieren oder Filtern (das lädt neu) */
  protected readonly locked = computed(() => this.pending() > 0);
  private readonly editing: GridEditing = {
    editable: (row, col) => this.cellEditable(row, col),
    isChanged: (row, col) => this.edit.isChanged(row, col),
    rowState: (row) => this.edit.rowState(row),
  };
  protected readonly gridEditing = computed<GridEditing | null>(() => (this.editMode() ? this.editing : null));
  protected readonly previewText = computed(() => (this.preview() ?? []).join('\n'));

  /** Fremdschlüssel in beide Richtungen fürs Grid (Kontextmenü, Strg+Klick) */
  protected readonly links = computed<GridLinks | null>(() => {
    const i = this.info();
    return i ? { outgoing: i.foreignKeys, incoming: i.referencedBy } : null;
  });

  constructor() {
    // erst laden, wenn der Tab zum ersten Mal sichtbar ist
    effect(() => {
      if (this.active() && !this.started) {
        this.started = true;
        untracked(() => {
          // geöffnet über einen Fremdschlüssel: mit diesem Filter starten
          const w = this.tab().where ?? '';
          this.where.set(w);
          this.whereDraft.set(w);
          void this.reload(true);
          // Fremdschlüssel für die Navigation im Grid
          void this.loadInfo();
        });
      }
    });
    effect(() => {
      const s = this.sub();
      untracked(() => {
        if (s === 'structure' && !this.info()) void this.loadInfo();
        if (s === 'ddl' && this.ddl() === null) void this.loadDdl();
      });
    });
    // Schließen des Tabs mit offenen Änderungen fragt nach
    effect(() => {
      const dirty = this.pending() > 0;
      untracked(() => this.state.setDirty(this.tab().id, dirty));
    });
  }

  // --- Bearbeiten ---------------------------------------------------------------------------------

  private colInfo(col: number) {
    const name = this.columns()[col]?.name;
    return this.info()?.columns.find((c) => c.name === name);
  }

  private cellEditable(row: Row, col: number): boolean {
    if (this.edit.isDeleted(row)) return false;
    const c = this.colInfo(col);
    if (!c) return false;
    const t = baseType(c.dataType);
    // Binärdaten werden gekürzt angezeigt, Arrays als JSON, MySQL-Geometrie als Text – nicht zurückschreibbar. Nur der
    // Typname zählt: enum('image','video') oder eine Domäne image_ref sperrten die Spalte sonst ohne Hinweis
    if (c.dataType.includes('[]') || /binary|blob|bytea|^image$|geometry|geography|hierarchyid|rowversion/.test(t)) return false;
    if (this.dialect() === 'mysql' && /^(point|linestring|polygon|multipoint|multilinestring|multipolygon|geomcollection)$/.test(t)) return false;
    if (this.dialect() === 'mssql' && t === 'timestamp') return false;
    // Zähler-Spalten nur in neuen Zeilen (SQL Server gar nicht: IDENTITY_INSERT)
    if (c.autoIncrement) return this.edit.isAdded(row) && this.dialect() !== 'mssql';
    return true;
  }

  protected onCellEdit(e: CellEdit) {
    this.edit.cellEdited(e.row, e.col, e.value, e.previous);
    this.afterEdit();
  }

  protected onEditAction(a: EditAction) {
    if (a.kind === 'null') {
      if (this.edit.setNull(a.row, a.col)) this.afterEdit();
      return;
    }
    this.dropRows(a.kind === 'delete' ? this.edit.delete(a.rows) : this.edit.revert(a.rows));
    this.afterEdit();
  }

  /** neue Zeilen, die wegfallen (gelöscht oder verworfen), aus dem Grid nehmen */
  private dropRows(gone: Row[]) {
    if (!gone.length) return;
    const set = new Set(gone);
    this.rows.update((list) => list.filter((r) => !set.has(r)));
  }

  private afterEdit() {
    this.pending.set(this.edit.pending);
    this.editError.set(null);
    this.grid()?.refresh();
  }

  protected addRow() {
    const r: Row = this.columns().map(() => undefined);
    this.edit.add(r);
    this.rows.update((list) => [r, ...list]);
    this.afterEdit();
    // erste bearbeitbare Spalte gleich öffnen
    const first = this.columns().findIndex((_, i) => this.cellEditable(r, i));
    if (first >= 0) setTimeout(() => this.grid()?.startEditing(0, first), 0);
  }

  protected deleteSelected() {
    const rows = (this.grid()?.selectedRows() ?? []).filter((r) => !this.edit.isDeleted(r));
    if (rows.length) this.onEditAction({ kind: 'delete', rows });
  }

  protected discardEdits() {
    this.dropRows(this.edit.discard());
    this.afterEdit();
  }

  /** vor Neuladen: offene Änderungen verwerfen? */
  private confirmDiscard(): boolean {
    if (!this.pending()) return true;
    if (!confirm(`${this.pending()} ungespeicherte Änderung(en) verwerfen?`)) return false;
    this.discardEdits();
    return true;
  }

  protected toggleEdit() {
    if (this.editMode()) {
      if (!this.confirmDiscard()) return;
      this.editMode.set(false);
    } else if (!this.editBlock()) {
      this.editMode.set(true);
    }
  }

  private changes(): RowChange[] {
    return this.edit.changes(
      this.columns().map((c) => c.name),
      this.keyCols() ?? [],
    );
  }

  /** erst die Anweisungen zeigen; ausgeführt wird erst mit „Ausführen“ */
  protected async showPreview() {
    this.editError.set(null);
    try {
      const r = await api.applyChanges({ object: this.tab().ref, changes: this.changes(), preview: true });
      this.preview.set(r.statements);
    } catch (e) {
      this.editError.set(message(e));
    }
  }

  protected async save() {
    this.saving.set(true);
    this.editError.set(null);
    try {
      await api.applyChanges({ object: this.tab().ref, changes: this.changes(), preview: false });
      this.preview.set(null);
      this.edit.clear();
      this.pending.set(0);
      await this.reload(true);
    } catch (e) {
      this.preview.set(null);
      this.editError.set(message(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected onPreviewBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closePreview();
  }

  /** Vorschau zu (Abbrechen, Esc, Hintergrund) – nicht, während gespeichert wird */
  protected closePreview(): void {
    if (!this.saving()) this.preview.set(null);
  }

  private request(): TableDataRequest {
    return { object: this.tab().ref, limit: this.limit(), offset: this.offset(), sort: this.sort(), where: this.where(), search: this.search() };
  }

  /** withCount: Filter geändert -> Gesamtzahl neu ermitteln */
  protected async reload(withCount: boolean) {
    const my = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const req = this.request();
    if (withCount) {
      const mine = ++this.countSeq;
      this.total.set(null);
      this.counting.set(true);
      api
        .countTable(req)
        .then((n) => mine === this.countSeq && this.total.set(n))
        .catch(() => undefined)
        .finally(() => mine === this.countSeq && this.counting.set(false));
    }
    try {
      const r = await api.fetchTable(req);
      if (my !== this.seq) return;
      this.columns.set(r.columns);
      this.rows.set(r.rows);
      // neue Zeilen-Objekte: alte Änderungsstände gelten nicht mehr
      this.edit.clear();
      this.pending.set(0);
      this.sql.set(r.sql);
      this.durationMs.set(r.durationMs);
    } catch (e) {
      if (my !== this.seq) return;
      this.error.set(message(e));
      this.state.noteError(this.tab().ref.connectionId, e);
      this.rows.set([]);
      this.counting.set(false);
    } finally {
      if (my === this.seq) this.loading.set(false);
    }
  }

  protected applyWhere() {
    if (!this.confirmDiscard()) return;
    this.where.set(this.whereDraft());
    this.offset.set(0);
    void this.reload(true);
  }

  /** Suche erst auf Enter: sie durchsucht alle Spalten (voller Scan) – nicht bei jedem Tastendruck auf den Server */
  protected onSearchInput(v: string) {
    this.searchDraft.set(v);
  }

  protected applySearch() {
    if (this.searchDraft() === this.search()) return;
    if (!this.confirmDiscard()) return;
    this.search.set(this.searchDraft());
    this.offset.set(0);
    void this.reload(true);
  }

  protected clearFilters() {
    if (!this.confirmDiscard()) return;
    this.where.set('');
    this.whereDraft.set('');
    this.search.set('');
    this.searchDraft.set('');
    this.offset.set(0);
    void this.reload(true);
  }

  protected async onSort(s: SortSpec[]) {
    if (!this.confirmDiscard()) return;
    const prev = this.sort();
    this.sort.set(s);
    this.offset.set(0);
    await this.reload(false);
    // Sortierung, die der Server ablehnt (Elasticsearch: Textfeld, SQL Server: text/ntext), zurücknehmen –
    // sonst bliebe die Ansicht leer und auch Neu laden scheiterte immer wieder; die Meldung bleibt stehen
    const msg = this.error();
    if (msg && s.length && JSON.stringify(prev) !== JSON.stringify(s)) {
      this.sort.set(prev);
      await this.reload(false);
      if (!this.error()) this.error.set(msg);
    }
  }

  /** Spalte dieser Tabelle mit Bytes: ihre Zellen ('0x…') gehen als Literal der Bytes in Filter und Sprung, nicht als Text */
  private isBinary(column: string): boolean {
    const t = this.info()?.columns.find((c) => c.name === column)?.dataType;
    return !!t && isBinaryType(t);
  }

  protected onFilter(f: FilterRequest) {
    const cond = condition(this.dialect(), f.column, f.value, f.op, f.numeric, this.isBinary(f.column));
    const w = this.where().trim();
    // bestehende Bedingung klammern: "a OR b" + Filter darf nicht zu "a OR b AND c" werden
    this.whereDraft.set(w ? `(${w}) AND ${cond}` : cond);
    this.applyWhere();
  }

  protected page(dir: 'first' | 'prev' | 'next' | 'last') {
    const lim = this.limit();
    const total = this.total();
    let o = this.offset();
    if (dir === 'first') o = 0;
    else if (dir === 'prev') o = Math.max(0, o - lim);
    else if (dir === 'next') o = o + lim;
    else if (total !== null) o = Math.max(0, Math.floor((total - 1) / lim) * lim);
    if (o === this.offset()) return;
    if (!this.confirmDiscard()) return;
    this.offset.set(o);
    void this.reload(false);
  }

  protected setLimit(v: string) {
    if (!this.confirmDiscard()) return;
    this.limit.set(Number(v));
    this.offset.set(0);
    void this.reload(false);
  }

  protected exportData() {
    const ref = this.tab().ref;
    this.exporter.open({
      kind: 'table',
      req: this.request(),
      // nur gespeicherte Zeilen (neue, noch nicht gespeicherte haben Lücken)
      page: { columns: this.columns(), rows: this.rows().filter((r) => !this.edit.isAdded(r)) as Cell[][] },
      total: this.total(),
      baseName: ref.name,
      dialect: this.dialect(),
      sqlTable: objectName(this.dialect(), ref),
    });
  }

  protected openAsQuery() {
    const t = this.tab().ref;
    // Elasticsearch: die Suche als Konsolen-Anfrage (ohne „;“)
    this.state.openQuery(t.connectionId, t.database, this.es() ? this.sql() + '\n' : this.sql() + ';');
  }

  /** DDL im Abfrage-Tab; Elasticsearch: die Anfrage, die das Mapping liefert */
  protected openDdlAsQuery() {
    const t = this.tab().ref;
    this.state.openQuery(t.connectionId, t.database, this.es() ? `GET ${encodeURIComponent(t.name)}\n` : (this.ddl() ?? ''));
  }

  protected async loadInfo() {
    this.infoError.set(null);
    try {
      this.info.set(await api.describeTable(this.tab().ref));
    } catch (e) {
      this.infoError.set(message(e));
    }
  }

  protected async loadDdl() {
    this.ddlError.set(null);
    try {
      this.ddl.set(await api.getDdl(this.tab().ref));
    } catch (e) {
      this.ddlError.set(message(e));
    }
  }

  /** Tabelle öffnen; MySQL: schema ist die Datenbank (Verweis in eine andere Datenbank möglich) */
  protected openRef(schema: string, table: string, where?: string, label?: string) {
    const t = this.tab().ref;
    const mysql = this.dialect() === 'mysql';
    this.state.openTable(
      { connectionId: t.connectionId, database: mysql ? schema || t.database : t.database, schema: mysql ? '' : schema, name: table, kind: 'table' },
      where,
      label,
    );
  }

  /** einem Fremdschlüssel folgen: Zieltabelle mit WHERE auf die Werte dieser Zeile */
  protected onFollow(f: FollowRequest) {
    // Fremdschlüssel: Ziel- und Quellspalte haben denselben Typ – der der Quelle steht hier schon fest
    const where = f.pairs.map((p) => condition(this.dialect(), p.column, p.value, '=', p.numeric, this.isBinary(p.source))).join(' AND ');
    const label = f.pairs.map((p) => `${p.column} = ${p.value}`).join(', ');
    this.openRef(f.schema, f.table, where, label);
  }

  protected copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  /** F5 wie der Knopf „Neu laden“: nur im sichtbaren Tab und nicht hinter einem Dialog */
  @HostListener('window:keydown', ['$event'])
  protected onWindowKey(ev: KeyboardEvent) {
    if (ev.key !== 'F5' || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey || ev.defaultPrevented || !this.active() || overlayOpen()) return;
    ev.preventDefault();
    if (!ev.repeat) this.refreshAll();
  }

  protected refreshAll() {
    if (!this.confirmDiscard()) return;
    // Struktur immer neu laden – auch im Reiter Daten brauchen Bearbeiten und Fremdschlüssel sie; die alte gilt bis dahin
    void this.loadInfo();
    this.ddl.set(null);
    if (this.sub() === 'ddl') void this.loadDdl();
    void this.reload(true);
  }
}
