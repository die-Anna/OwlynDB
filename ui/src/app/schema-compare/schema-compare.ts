import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { CompareItem, CompareResult, CompareSide } from '../../../../shared/api-types';
import { compareScript } from '../../../../shared/compare-script';
import { commentText } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { AppState, CompareTab } from '../core/state';
import { SqlEditor } from '../editor/sql-editor';
import { Icon } from '../ui/icon';

interface SideState {
  side: CompareSide;
  databases: string[];
  schemas: string[];
}

const GROUPS: { title: string; kinds: CompareItem['kind'][] }[] = [
  { title: 'Tabellen', kinds: ['table'] },
  { title: 'Views', kinds: ['view'] },
  { title: 'Prozeduren, Funktionen, Trigger', kinds: ['function', 'procedure', 'trigger'] },
];

/** Struktur zweier Datenbanken vergleichen; das Abgleich-Skript wird nur angezeigt bzw. im Abfrage-Tab geöffnet */
@Component({
  selector: 'app-schema-compare',
  imports: [Icon, SqlEditor],
  templateUrl: './schema-compare.html',
  styleUrl: './schema-compare.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchemaCompare {
  readonly tab = input.required<CompareTab>();
  protected state = inject(AppState);
  protected readonly groups = GROUPS;

  protected src = signal<SideState>({ side: { connectionId: '', database: '', schema: '' }, databases: [], schemas: [] });
  protected dst = signal<SideState>({ side: { connectionId: '', database: '', schema: '' }, databases: [], schemas: [] });
  protected result = signal<CompareResult | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected selected = signal<Set<CompareItem>>(new Set());
  protected open = signal<Set<CompareItem>>(new Set());
  protected includeDrops = signal(false);
  /** Anfrage, zu der result gehört: Skript, Abfrage-Tab und Datenvergleich nehmen deren Seiten, nicht die aktuelle Auswahl */
  protected resultReq = signal<{ source: CompareSide; target: CompareSide } | null>(null);
  private started = false;
  /** spätere Auswahl gewinnt: Antworten älterer Ladevorgänge bzw. Vergleiche verwerfen */
  private tokens: Record<'src' | 'dst', number> = { src: 0, dst: 0 };
  private runSeq = 0;

  protected readonly dialect = computed(() => this.state.dialect(this.src().side.connectionId));
  /** Ziel: nur Verbindungen desselben Typs */
  protected readonly targets = computed(() => this.state.connections().filter((c) => c.dialect === this.dialect()));
  protected readonly ready = computed(() => {
    const s = this.src().side;
    const d = this.dst().side;
    const schemaOk = this.dialect() === 'mysql' || (!!s.schema && !!d.schema);
    const sameType = this.state.dialect(d.connectionId) === this.dialect();
    return !!s.connectionId && !!s.database && !!d.connectionId && !!d.database && schemaOk && sameType;
  });
  protected readonly sameSide = computed(() => {
    const s = this.src().side;
    const d = this.dst().side;
    return s.connectionId === d.connectionId && s.database === d.database && s.schema === d.schema;
  });
  protected readonly script = computed(() => {
    const r = this.result();
    const req = this.resultReq();
    if (!r || !req) return '';
    const s = req.source;
    const d = req.target;
    const name = (id: string) => this.state.connection(id)?.name ?? '';
    // Namen aus der Datenbank auf eine Zeile: ein Zeilenumbruch darin machte den Rest der Kopfzeile zu ausführbarem SQL
    const where = (x: CompareSide) => commentText(`${name(x.connectionId)} · ${x.database}${x.schema ? '.' + x.schema : ''}`);
    const header =
      `-- Abgleich: Ziel ${where(d)} an Quelle ${where(s)} angleichen\n` +
      `-- erstellt ${new Date().toLocaleString('de-CH')} – vor dem Ausführen prüfen; im Ziel ausführen`;
    return compareScript(r.dialect, r.items.filter((i) => this.selected().has(i)), this.includeDrops(), header);
  });

  constructor() {
    effect(() => {
      const t = this.tab();
      if (this.started) return;
      this.started = true;
      untracked(() => void this.init(t));
    });
    // Zielverbindung beim Trennen mitschließen
    effect(() => {
      const id = this.dst().side.connectionId;
      untracked(() => this.state.setCompareTarget(this.tab().id, id || null));
    });
  }

  private async init(t: CompareTab) {
    await this.setConnection('src', t.source.connectionId, t.source.database, t.source.schema);
    // Ziel: dieselbe Verbindung, eine andere Datenbank (falls es eine gibt)
    const other = this.src().databases.find((d) => d !== t.source.database) ?? t.source.database;
    await this.setConnection('dst', t.source.connectionId, other, t.source.schema);
  }

  /** Auswahl geändert: Ergebnis verwerfen, ein laufender Vergleich zählt nicht mehr */
  private clearResult() {
    this.runSeq++;
    this.result.set(null);
    this.resultReq.set(null);
    this.loading.set(false);
  }

  protected async setConnection(which: 'src' | 'dst', connectionId: string, database = '', schema = '') {
    const target = which === 'src' ? this.src : this.dst;
    const token = ++this.tokens[which];
    this.clearResult();
    target.set({ side: { connectionId, database: '', schema: '' }, databases: [], schemas: [] });
    // Quelle eines anderen Datenbanktyps: das bisherige Ziel passt nicht mehr (die Auswahl bot es nicht mehr an, der
    // Zustand behielt es) – neu wählen lassen
    const dst = this.dst().side.connectionId;
    if (which === 'src' && connectionId && dst && this.state.dialect(dst) !== this.state.dialect(connectionId)) void this.setConnection('dst', '');
    if (!connectionId) return;
    try {
      await this.state.ensureConnected(connectionId);
      const dbs = await api.listDatabases(connectionId);
      if (token !== this.tokens[which]) return;
      const db = database && dbs.includes(database) ? database : (this.state.connection(connectionId)?.database ?? '');
      target.set({ side: { connectionId, database: '', schema: '' }, databases: dbs, schemas: [] });
      if (db) await this.setDatabase(which, db, schema, token);
    } catch (e) {
      if (token === this.tokens[which]) this.error.set(message(e));
    }
  }

  protected async setDatabase(which: 'src' | 'dst', database: string, schema = '', token = ++this.tokens[which]) {
    const target = which === 'src' ? this.src : this.dst;
    this.clearResult();
    const cur = target();
    target.set({ ...cur, side: { ...cur.side, database, schema: '' }, schemas: [] });
    if (!database || this.dialect() === 'mysql') return;
    try {
      const schemas = await api.listSchemas(cur.side.connectionId, database);
      if (token !== this.tokens[which]) return;
      const pick = schema && schemas.includes(schema) ? schema : schemas.includes('dbo') ? 'dbo' : schemas.includes('public') ? 'public' : (schemas[0] ?? '');
      target.set({ ...target(), side: { ...target().side, schema: pick }, schemas });
    } catch (e) {
      if (token === this.tokens[which]) this.error.set(message(e));
    }
  }

  protected setSchema(which: 'src' | 'dst', schema: string) {
    const target = which === 'src' ? this.src : this.dst;
    this.tokens[which]++;
    this.clearResult();
    target.set({ ...target(), side: { ...target().side, schema } });
  }

  protected swap() {
    const s = this.src();
    this.tokens.src++;
    this.tokens.dst++;
    this.src.set(this.dst());
    this.dst.set(s);
    this.clearResult();
  }

  protected async run() {
    if (!this.ready() || this.loading()) return;
    const my = ++this.runSeq;
    const req = { source: this.src().side, target: this.dst().side };
    this.loading.set(true);
    this.error.set(null);
    this.result.set(null);
    this.resultReq.set(null);
    try {
      const r = await api.compareSchemas(req);
      if (my !== this.runSeq) return;
      this.result.set(r);
      this.resultReq.set(req);
      this.selected.set(new Set(r.items));
      this.open.set(new Set());
    } catch (e) {
      if (my === this.runSeq) this.error.set(message(e));
    } finally {
      if (my === this.runSeq) this.loading.set(false);
    }
  }

  /** Daten aller Tabellen beider Seiten vergleichen (eigener Tab; die Seiten des Ergebnisses, sonst die Auswahl) */
  protected compareData() {
    const s = this.resultReq()?.source ?? this.src().side;
    const d = this.resultReq()?.target ?? this.dst().side;
    this.state.openDataCompare({ ...s, table: '' }, { all: true, target: { ...d, table: '' } });
  }

  protected itemsOf(kinds: CompareItem['kind'][]): CompareItem[] {
    return (this.result()?.items ?? []).filter((i) => kinds.includes(i.kind));
  }

  protected toggle(i: CompareItem, on: boolean) {
    const s = new Set(this.selected());
    if (on) s.add(i);
    else s.delete(i);
    this.selected.set(s);
  }

  protected toggleOpen(i: CompareItem) {
    const s = new Set(this.open());
    if (s.has(i)) s.delete(i);
    else s.add(i);
    this.open.set(s);
  }

  protected setAll(on: boolean) {
    this.selected.set(on ? new Set(this.result()?.items ?? []) : new Set());
  }

  protected statusText(i: CompareItem): string {
    return i.status === 'onlySource' ? 'fehlt im Ziel' : i.status === 'onlyTarget' ? 'nur im Ziel' : 'unterschiedlich';
  }

  protected icon(i: CompareItem): string {
    return i.kind === 'table' ? 'table' : i.kind === 'view' ? 'view' : i.kind === 'procedure' ? 'proc' : i.kind === 'function' ? 'func' : 'trigger';
  }

  protected label(i: CompareItem): string {
    if (i.kind === 'trigger' && i.table) return `${i.name} (auf ${i.table})`;
    if (i.args !== undefined) return `${i.name}(${i.args})`;
    return i.name;
  }

  protected connName(id: string): string {
    return this.state.connection(id)?.name ?? '';
  }

  /** Skript im Abfrage-Tab auf dem Ziel des Ergebnisses – nicht auf einem inzwischen anders gewählten */
  protected openScript() {
    const d = this.resultReq()?.target;
    if (d) this.state.openQuery(d.connectionId, d.database, this.script());
  }

  protected copyScript() {
    void navigator.clipboard.writeText(this.script());
  }
}
