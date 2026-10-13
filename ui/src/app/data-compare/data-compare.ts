import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  Cell,
  ColumnInfo,
  DataCompareAllRequest,
  DataCompareAllResult,
  DataCompareRequest,
  DataCompareResult,
  DataCompareSide,
  DataDiffStatus,
  JobStatus,
  ResultColumn,
  SqlDialect,
  TableInfo,
} from '../../../../shared/api-types';
import { commentOut, commentText, keyColumns, objectName } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { AppState, DataCompareTab } from '../core/state';
import { DumpService } from '../dump-dialog/dump-dialog';
import { SqlEditor } from '../editor/sql-editor';
import { ExportService } from '../export-dialog/export-dialog';
import { Icon } from '../ui/icon';
import { GridMarks, ResultGrid, Row } from '../ui/result-grid';

interface SideState {
  side: DataCompareSide;
  databases: string[];
  schemas: string[];
  tables: string[];
}

type Which = 'src' | 'dst';
type Filter = 'all' | DataDiffStatus;

const STATUS_TEXT: Record<DataDiffStatus, string> = { onlySource: 'fehlt im Ziel', onlyTarget: 'nur im Ziel', different: 'unterschiedlich' };
const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'master', 'model', 'msdb', 'tempdb']);
const emptySide = (): SideState => ({ side: { connectionId: '', database: '', schema: '', table: '' }, databases: [], schemas: [], tables: [] });

type AllTable = DataCompareAllResult['tables'][number];

/** „alle Spalten“ als Schlüssel ohne diese Typen: im WHERE nicht mit = vergleichbar bzw. auf jeder Seite anders (rowversion) */
const NOT_KEYABLE: Record<SqlDialect, RegExp> = {
  mysql: /^(json|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i,
  postgres: /^(json|xml|point|line|lseg|box|path|polygon|circle)\b/i,
  mssql: /^(text|ntext|image|xml|geography|geometry|hierarchyid|sql_variant|timestamp|rowversion)\b/i,
};

/** Übersicht: Schlüsselspalten einer Tabelle wählen (Spalten der Quelle; null = werden geladen) */
interface KeyPick {
  table: string;
  columns: ColumnInfo[] | null;
  /** Primärschlüssel bzw. eindeutiger Index der Quelle */
  auto: string[] | null;
  chosen: string[];
}

/**
 * Daten zweier Tabellen vergleichen bzw. aller Tabellen eines Schemas (Übersicht, Klick öffnet die Einzelheiten). Das
 * Abgleich-Skript wird nur angezeigt, im Abfrage-Tab geöffnet oder – ohne Obergrenze – als Datei geschrieben, die sich
 * danach im Ziel einspielen lässt.
 */
@Component({
  selector: 'app-data-compare',
  imports: [FormsModule, Icon, ResultGrid, SqlEditor],
  templateUrl: './data-compare.html',
  styleUrl: './data-compare.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataCompare {
  readonly tab = input.required<DataCompareTab>();
  protected state = inject(AppState);
  private exporter = inject(ExportService);
  private dumps = inject(DumpService);
  protected readonly statusText = STATUS_TEXT;

  /** eine Tabelle oder alle Tabellen des Schemas */
  protected mode = signal<'table' | 'schema'>('table');
  protected allResult = signal<DataCompareAllResult | null>(null);
  /** Anfrage, zu der allResult gehört */
  protected allReq = signal<DataCompareAllRequest | null>(null);
  /** ganzes Schema: selbst gewählte Schlüssel je Tabelle (Name der Quelle) */
  protected schemaKeys = signal<Record<string, string[]>>({});
  protected keyPick = signal<KeyPick | null>(null);
  /** Abgleich-Skript als Datei (eigener Auftrag neben dem Vergleich) */
  protected fileJob = signal<JobStatus | null>(null);
  /** Ziel, für das die Datei geschrieben wurde – „Im Ziel einspielen“ nimmt dieses, nicht das inzwischen gewählte */
  protected fileTarget = signal<{ connectionId: string; database: string } | null>(null);
  private fileTimer?: ReturnType<typeof setInterval>;

  protected src = signal<SideState>(emptySide());
  protected dst = signal<SideState>(emptySide());
  /** Struktur der Quelltabelle (Auswahl von Schlüssel und Spalten) */
  protected srcInfo = signal<TableInfo | null>(null);
  /** null = automatisch (Primärschlüssel bzw. eindeutiger Index der Quelle) */
  protected key = signal<string[] | null>(null);
  /** null = alle Spalten, die es auf beiden Seiten gibt */
  protected columns = signal<string[] | null>(null);
  protected where = signal('');
  protected ignoreCase = signal(false);
  protected ignoreTrailing = signal(false);
  protected panel = signal<'key' | 'cols' | null>(null);

  protected job = signal<JobStatus | null>(null);
  protected result = signal<DataCompareResult | null>(null);
  /** Anfrage, zu der result gehört */
  protected resultReq = signal<DataCompareRequest | null>(null);
  protected error = signal<string | null>(null);
  protected filter = signal<Filter>('all');
  protected includeDeletes = signal(false);
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private started = false;
  /** zwischen Klick und Auftragsstart (Treiber laden, Zeilen schätzen): kein zweiter Auftrag per Doppelklick oder Enter */
  protected starting = signal(false);
  protected fileStarting = signal(false);
  /** Start des laufenden Auftrags: „Abbrechen“ erscheint an der Stelle von „Vergleichen“ */
  private startedAt = 0;
  /** spätere Auswahl gewinnt: Antworten älterer Ladevorgänge verwerfen */
  private tokens: Record<Which, number> = { src: 0, dst: 0 };
  /** Laufnummer der Strukturabfrage der Quelltabelle (jede neue Wahl auf der Quellseite macht ältere ungültig) */
  private describeSeq = 0;
  /** zuletzt gewählte Auswahl je Seite, auch solange sie noch lädt – Tauschen nimmt diese, nicht den halb geladenen Zustand */
  private wanted: Record<Which, DataCompareSide> = { src: emptySide().side, dst: emptySide().side };
  /** zählt das Tauschen: der Aufbau beim Öffnen wählt danach kein Ziel mehr selbst */
  private swaps = 0;

  protected readonly running = computed(() => this.job()?.state === 'running');
  protected readonly busy = computed(() => this.running() || this.starting());
  protected readonly autoKey = computed(() => {
    const info = this.srcInfo();
    return info ? keyColumns(info) : null;
  });
  protected readonly effectiveKey = computed(() => this.key() ?? this.autoKey() ?? []);
  protected readonly keyLabel = computed(() => {
    if (!this.srcInfo()) return '–';
    const k = this.key();
    if (k) return k.join(', ');
    const a = this.autoKey();
    return a ? `${a.join(', ')} (automatisch)` : 'bitte wählen';
  });
  protected readonly colsLabel = computed(() => {
    const c = this.columns();
    const n = this.srcInfo()?.columns.length ?? 0;
    return !this.srcInfo() ? '–' : c ? `${c.length} von ${n}` : `alle ${n}`;
  });
  protected readonly request = computed<DataCompareRequest>(() => ({
    source: this.src().side,
    target: this.dst().side,
    key: this.key() ?? undefined,
    columns: this.columns() ?? undefined,
    where: this.where().trim() || undefined,
    ignoreCase: this.ignoreCase(),
    ignoreTrailingSpaces: this.ignoreTrailing(),
  }));
  protected readonly requestAll = computed<DataCompareAllRequest>(() => {
    const { table: _s, ...source } = this.src().side;
    const { table: _t, ...target } = this.dst().side;
    const keys = this.schemaKeys();
    return { source, target, ...(Object.keys(keys).length ? { keys } : {}), ignoreCase: this.ignoreCase(), ignoreTrailingSpaces: this.ignoreTrailing() };
  });
  protected readonly ready = computed(() =>
    this.mode() === 'schema' ? !!this.src().side.database && !!this.dst().side.database : !!this.src().side.table && !!this.dst().side.table,
  );
  protected readonly sameTable = computed(() => {
    const s = this.src().side;
    const d = this.dst().side;
    return s.connectionId === d.connectionId && s.database === d.database && s.schema === d.schema && (this.mode() === 'schema' || s.table === d.table);
  });
  /** Auswahl geändert, seit verglichen wurde */
  protected readonly stale = computed(() =>
    this.mode() === 'schema'
      ? !!this.allReq() && JSON.stringify(this.requestAll()) !== JSON.stringify(this.allReq())
      : !!this.resultReq() && JSON.stringify(this.request()) !== JSON.stringify(this.resultReq()),
  );
  /** Übersicht: so viele Tabellen haben Unterschiede */
  protected readonly allDiffTables = computed(() => (this.allResult()?.tables ?? []).filter((t) => t.counts && t.counts.onlySource + t.counts.onlyTarget + t.counts.different).length);
  protected readonly fileRunning = computed(() => this.fileJob()?.state === 'running');
  protected readonly fileBusy = computed(() => this.fileRunning() || this.fileStarting());
  protected readonly percent = computed(() => {
    const j = this.job();
    return j?.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : null;
  });

  // ---------- Ergebnis als Grid ----------

  /** Zeilen-Metadaten fürs Hervorheben (Klasse, geänderte Spalten) */
  private meta = new WeakMap<Row, { cls?: string; changed?: Set<number> }>();
  protected readonly marks: GridMarks = {
    rowClass: (row) => this.meta.get(row)?.cls,
    isChanged: (row, col) => !!this.meta.get(row)?.changed?.has(col),
  };
  protected readonly gridColumns = computed<ResultColumn[]>(() => {
    const r = this.result();
    if (!r) return [];
    return [{ name: 'Unterschied', typeName: '', numeric: false }, { name: 'Seite', typeName: '', numeric: false }, ...r.columns];
  });
  protected readonly gridRows = computed<Row[]>(() => {
    const r = this.result();
    if (!r) return [];
    const f = this.filter();
    const out: Row[] = [];
    const push = (row: Row, m: { cls?: string; changed?: Set<number> }) => {
      this.meta.set(row, m);
      out.push(row);
    };
    for (const d of r.rows) {
      if (f !== 'all' && d.status !== f) continue;
      if (d.status === 'onlySource') push([STATUS_TEXT.onlySource, 'Quelle', ...d.source!], { cls: 'row-new' });
      else if (d.status === 'onlyTarget') push([STATUS_TEXT.onlyTarget, 'Ziel', ...d.target!], { cls: 'row-deleted' });
      else {
        // unter der Zeile der Quelle der bisherige Stand im Ziel; geänderte Zellen in beiden markiert
        const changed = new Set((d.changed ?? []).map((i) => i + 2));
        push([STATUS_TEXT.different, 'Quelle', ...d.source!], { changed });
        push(['', 'Ziel (bisher)', ...d.target!], { cls: 'row-old', changed });
      }
    }
    return out;
  });
  protected readonly shown = computed(() => {
    const r = this.result();
    const n = { onlySource: 0, onlyTarget: 0, different: 0 };
    for (const x of r?.rows ?? []) n[x.status]++;
    return n;
  });
  protected readonly diffTotal = computed(() => {
    const c = this.result()?.counts;
    return c ? c.onlySource + c.onlyTarget + c.different : 0;
  });

  // ---------- Abgleich-Skript ----------

  protected readonly script = computed(() => {
    const r = this.result();
    const req = this.resultReq();
    if (!r || !req) return '';
    const where = (s: DataCompareSide) => `${this.connName(s.connectionId)} · ${[s.database, s.schema, s.table].filter(Boolean).join('.')}`;
    const of = (s: DataDiffStatus) => r.rows.filter((x) => x.status === s).map((x) => x.sql);
    const del = of('onlyTarget');
    const upd = of('different');
    const ins = of('onlySource');
    // Namen und Hinweise aus der Datenbank in Kommentarzeilen: ohne Zeilenumbrüche, sonst wäre der Rest SQL
    const lines = [
      `-- ${commentText(`Datenabgleich: Ziel ${where(req.target)} an Quelle ${where(req.source)} angleichen`)}`,
      `-- ${commentText(`Schlüssel: ${r.key.join(', ')}${req.where ? ` · WHERE ${req.where}` : ''}`)} · erstellt ${new Date().toLocaleString('de-CH')}`,
      '-- vor dem Ausführen prüfen; im Ziel ausführen, am besten in einer Transaktion',
      ...r.warnings.map((w) => `-- Hinweis: ${commentText(w)}`),
    ];
    if (del.length) {
      lines.push('', `-- Löschen: ${del.length} Zeile(n), die es nur im Ziel gibt${this.includeDeletes() ? '' : ' – auskommentiert, „Löschungen aktivieren“ schaltet sie ein'}`);
      // auskommentiert: jede Zeile einzeln – ein Schlüsselwert mit Zeilenumbruch machte sonst den Rest zu lebendigem SQL
      lines.push(...(this.includeDeletes() ? del : del.map(commentOut)));
    }
    if (upd.length) lines.push('', `-- Ändern: ${upd.length} Zeile(n)`, ...upd);
    if (ins.length) lines.push('', `-- Einfügen: ${ins.length} Zeile(n), die im Ziel fehlen`, ...r.insertBefore, ...ins, ...r.insertAfter);
    if (!del.length && !upd.length && !ins.length) lines.push('', '-- keine Unterschiede');
    return lines.join('\n') + '\n';
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
    inject(DestroyRef).onDestroy(() => {
      clearInterval(this.timer);
      clearInterval(this.fileTimer);
      // Tab zu: der Vergleich liefe sonst ohne Oberfläche weiter (Vollscans auf Quelle und Ziel, Ergebnis unerreichbar);
      // das Schreiben einer Skript-Datei darf zu Ende laufen – die Datei war ausdrücklich gewünscht
      const j = this.job();
      if (j?.state === 'running') void api.cancelJob(j.id).catch(() => undefined);
    });
  }

  /** Banner „Skript gespeichert“ gehört zum damaligen Ziel: bei neuem Vergleich oder anderem Ziel weg (läuft es noch, bleibt es) */
  private clearFileBanner() {
    if (this.fileRunning()) return;
    this.fileJob.set(null);
    this.fileTarget.set(null);
  }

  private async init(t: DataCompareTab) {
    const s = t.source;
    if (t.all) this.mode.set('schema');
    const swaps = this.swaps;
    await this.setConnection('src', s.connectionId, s.database, s.schema, s.table);
    // während des Aufbaus getauscht: die Seiten stehen schon, nichts überschreiben
    if (swaps !== this.swaps) return;
    if (t.target) {
      await this.setConnection('dst', t.target.connectionId, t.target.database, t.target.schema, t.target.table);
      return;
    }
    // Ziel: dieselbe Verbindung, eine Datenbank mit ähnlichem Namen (z. B. shop_test zu shop), sonst wählen lassen
    const name = s.database.toLowerCase();
    const other = this.src().databases.find((d) => {
      const x = d.toLowerCase();
      return x !== name && !SYSTEM_DBS.has(x) && (x.includes(name) || name.includes(x));
    });
    await this.setConnection('dst', s.connectionId, other ?? '', s.schema, s.table);
  }

  protected setMode(m: 'table' | 'schema') {
    if (this.busy()) return;
    this.mode.set(m);
    this.panel.set(null);
    this.error.set(null);
    this.clearFileBanner();
  }

  private side(which: Which) {
    return which === 'src' ? this.src : this.dst;
  }

  protected async setConnection(which: Which, connectionId: string, database = '', schema = '', table = '') {
    const target = this.side(which);
    const token = ++this.tokens[which];
    this.wanted[which] = { connectionId, database, schema, table };
    target.set({ ...emptySide(), side: { connectionId, database: '', schema: '', table: '' } });
    if (which === 'src') this.srcInfo.set(null);
    else this.clearFileBanner();
    if (!connectionId) return;
    try {
      await this.state.ensureConnected(connectionId);
      const dbs = await api.listDatabases(connectionId);
      if (token !== this.tokens[which]) return;
      target.update((s) => ({ ...s, databases: dbs }));
      if (database && dbs.includes(database)) await this.setDatabase(which, database, schema, table);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async setDatabase(which: Which, database: string, schema = '', table = '') {
    const target = this.side(which);
    const token = ++this.tokens[which];
    this.wanted[which] = { ...this.wanted[which], database, schema, table };
    target.update((s) => ({ ...s, side: { ...s.side, database, schema: '', table: '' }, schemas: [], tables: [] }));
    if (which === 'src') this.srcInfo.set(null);
    else this.clearFileBanner();
    if (!database) return;
    try {
      const id = target().side.connectionId;
      if (this.state.dialect(id) === 'mysql') return await this.setSchema(which, '', table, token);
      const schemas = await api.listSchemas(id, database);
      if (token !== this.tokens[which]) return;
      const pick = schema && schemas.includes(schema) ? schema : schemas.includes('dbo') ? 'dbo' : schemas.includes('public') ? 'public' : (schemas[0] ?? '');
      target.update((s) => ({ ...s, schemas }));
      await this.setSchema(which, pick, table, token);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async setSchema(which: Which, schema: string, table = '', token = ++this.tokens[which]) {
    const target = this.side(which);
    this.wanted[which] = { ...this.wanted[which], schema, table };
    target.update((s) => ({ ...s, side: { ...s.side, schema, table: '' }, tables: [] }));
    if (which === 'src') {
      this.srcInfo.set(null);
      // gewählte Schlüssel gehören zu den Tabellen der bisherigen Quelle
      this.schemaKeys.set({});
      this.keyPick.set(null);
    } else this.clearFileBanner();
    const s = target().side;
    if (!s.database) return;
    try {
      const objs = await api.listObjects(s.connectionId, s.database, schema);
      if (token !== this.tokens[which]) return;
      const tables = objs
        .filter((o) => o.kind === 'table')
        .map((o) => o.name)
        .sort((a, b) => a.localeCompare(b, 'de'));
      target.update((x) => ({ ...x, tables }));
      // Ziel: gleichnamige Tabelle vorschlagen
      const want = table || (which === 'dst' ? this.src().side.table : '');
      const pick = tables.find((t) => t === want) ?? tables.find((t) => t.toLowerCase() === want.toLowerCase());
      if (pick) await this.setTable(which, pick);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async setTable(which: Which, table: string) {
    this.side(which).update((s) => ({ ...s, side: { ...s.side, table } }));
    this.wanted[which] = { ...this.wanted[which], table };
    if (which !== 'src') return this.clearFileBanner();
    this.key.set(null);
    this.columns.set(null);
    this.srcInfo.set(null);
    const my = ++this.describeSeq;
    if (!table) return;
    const s = this.src().side;
    try {
      const info = await api.describeTable({ connectionId: s.connectionId, database: s.database, schema: s.schema, name: table, kind: 'table' });
      // nur, wenn die Quelle noch genau diese Tabelle ist (gleichnamige Tabelle einer anderen Datenbank: deren Spalten)
      const now = this.src().side;
      if (my !== this.describeSeq || now.connectionId !== s.connectionId || now.database !== s.database || now.schema !== s.schema || now.table !== table) return;
      this.srcInfo.set(info);
    } catch (e) {
      if (my === this.describeSeq) this.error.set(message(e));
    }
    const d = this.dst();
    if (!d.side.table && d.tables.includes(table)) await this.setTable('dst', table);
  }

  protected swap() {
    const s = this.wanted.src;
    const d = this.wanted.dst;
    this.swaps++;
    // Struktur, Schlüssel und Spalten gelten für die Quelle: neu laden
    this.schemaKeys.set({});
    this.keyPick.set(null);
    this.clearFileBanner();
    // beide Seiten mit der Auswahl der anderen neu aufbauen, statt die Zustände zu tauschen: noch laufende Ladevorgänge
    // (Datenbanken, Schemas, Tabellen) gehörten sonst zur falschen Seite bzw. ließen die Listen leer
    void this.setConnection('src', d.connectionId, d.database, d.schema, d.table);
    void this.setConnection('dst', s.connectionId, s.database, s.schema, s.table);
  }

  // ---------- Schlüssel und Spalten ----------

  protected keyHas(name: string): boolean {
    return this.effectiveKey().includes(name);
  }

  protected toggleKey(name: string, on: boolean) {
    const cur = this.effectiveKey().filter((k) => k !== name);
    const next = on ? [...cur, name] : cur;
    // Reihenfolge wie in der Tabelle
    const order = this.srcInfo()?.columns.map((c) => c.name) ?? [];
    next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const auto = this.autoKey();
    this.key.set(!next.length || (auto && auto.join('\u0000') === next.join('\u0000')) ? null : next);
  }

  protected colHas(name: string): boolean {
    const c = this.columns();
    return !c || c.includes(name);
  }

  protected toggleCol(name: string, on: boolean) {
    const all = this.srcInfo()?.columns.map((c) => c.name) ?? [];
    const cur = this.columns() ?? all;
    const next = on ? all.filter((n) => n === name || cur.includes(n)) : cur.filter((n) => n !== name);
    this.columns.set(next.length === all.length ? null : next);
  }

  // ---------- Vergleich ----------

  protected async run() {
    if (!this.ready() || this.busy() || this.sameTable()) return;
    this.starting.set(true);
    this.panel.set(null);
    this.keyPick.set(null);
    this.error.set(null);
    this.clearFileBanner();
    try {
      if (this.mode() === 'schema') {
        const req = this.requestAll();
        const id = await api.startDataCompareAll(req);
        this.allResult.set(null);
        this.allReq.set(null);
        this.startPoll(id, async () => {
          this.allResult.set(await api.dataCompareAllResult(id));
          this.allReq.set(req);
          this.includeDeletes.set(false);
        });
        return;
      }
      const req = this.request();
      const id = await api.startDataCompare(req);
      this.result.set(null);
      this.resultReq.set(null);
      this.startPoll(id, async () => {
        this.result.set(await api.dataCompareResult(id));
        this.resultReq.set(req);
        this.filter.set('all');
        this.includeDeletes.set(false);
      });
    } catch (e) {
      this.error.set(message(e));
    } finally {
      // startPoll hat den Auftrag schon gesetzt: running übernimmt ohne Lücke
      this.starting.set(false);
    }
  }

  private startPoll(id: string, onDone: () => Promise<void>) {
    this.job.set({ id, kind: 'datacompare', state: 'running', done: 0, statements: 0, current: 'startet …', log: [], durationMs: 0 });
    this.startedAt = Date.now();
    clearInterval(this.timer);
    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const s = await api.jobStatus(id);
        this.job.set(s);
        if (s.state === 'running') return;
        clearInterval(this.timer);
        if (s.state === 'done') await onDone();
        else this.error.set(s.error ?? 'Abgebrochen.');
      } catch (e) {
        clearInterval(this.timer);
        this.error.set(message(e));
      } finally {
        this.polling = false;
      }
    };
    this.timer = setInterval(() => void tick(), 300);
    void tick();
  }

  /** Übersicht: Einzelheiten einer Tabelle (gleiche Seiten, diese Tabelle, gewählter Schlüssel); ohne Schlüssel erst wählen */
  protected async openTable(t: AllTable) {
    if (this.busy()) return;
    const chosen = this.keyOf(t.source);
    if (t.noKey && !chosen) return this.pickKey(t);
    this.mode.set('table');
    // die Übersicht verglich ohne WHERE: eine Bedingung aus dem Tabellenmodus (dort unsichtbar) gälte sonst mit
    this.where.set('');
    await this.setTable('src', t.source);
    await this.setTable('dst', t.target);
    if (chosen) this.key.set(chosen);
    if (!t.error) await this.run();
  }

  /** gewählter Schlüssel einer Tabelle – nur eigene Einträge (eine Tabelle „constructor“ träfe sonst Object.prototype) */
  private keyOf(table: string): string[] | undefined {
    const keys = this.schemaKeys();
    return Object.hasOwn(keys, table) ? keys[table] : undefined;
  }

  // ---------- Übersicht: Schlüssel je Tabelle ----------

  protected chosenKey(t: AllTable): string[] | undefined {
    return this.keyOf(t.source);
  }

  /** Spalten der Quelltabelle laden und unter ihrer Zeile zur Wahl stellen */
  protected async pickKey(t: AllTable) {
    if (this.busy()) return;
    if (this.keyPick()?.table === t.source) return this.keyPick.set(null);
    const s = (this.allReq() ?? this.requestAll()).source;
    const chosen = this.keyOf(t.source) ?? (t.noKey ? [] : (t.key ?? []));
    this.keyPick.set({ table: t.source, columns: null, auto: null, chosen });
    try {
      const info = await api.describeTable({ connectionId: s.connectionId, database: s.database, schema: s.schema, name: t.source, kind: 'table' });
      this.keyPick.update((k) => (k?.table === t.source ? { ...k, columns: info.columns, auto: keyColumns(info) } : k));
    } catch (e) {
      this.keyPick.set(null);
      this.error.set(message(e));
    }
  }

  protected togglePick(name: string, on: boolean) {
    this.keyPick.update((k) => {
      if (!k?.columns) return k;
      const next = new Set(k.chosen.filter((c) => c !== name));
      if (on) next.add(name);
      // Reihenfolge wie in der Tabelle
      return { ...k, chosen: k.columns.map((c) => c.name).filter((c) => next.has(c)) };
    });
  }

  /** ganze Zeile als Schlüssel (ohne Spalten, die sich nicht mit = vergleichen lassen) */
  protected pickAll() {
    const skip = NOT_KEYABLE[this.state.dialect(this.src().side.connectionId) as SqlDialect] ?? NOT_KEYABLE.mysql;
    this.keyPick.update((k) => (k?.columns ? { ...k, chosen: k.columns.filter((c) => !skip.test(c.dataType)).map((c) => c.name) } : k));
  }

  /** gewählten Schlüssel übernehmen und nur diese Tabelle neu vergleichen (passt der Rest nicht mehr zur Auswahl: alles) */
  protected async applyKey() {
    const k = this.keyPick();
    if (!k?.chosen.length || this.busy()) return;
    // als eigene Einträge neu aufbauen: keys['__proto__'] = … setzte sonst den Prototyp statt eines Schlüssels
    const rest = Object.entries(this.schemaKeys()).filter(([name]) => name !== k.table);
    const auto = k.auto && k.auto.join('\u0000') === k.chosen.join('\u0000');
    this.schemaKeys.set(Object.fromEntries(auto ? rest : [...rest, [k.table, k.chosen]]));
    this.keyPick.set(null);
    const before = this.allReq();
    const full = this.requestAll();
    const { keys: _a, ...now } = full;
    const { keys: _b, ...was } = before ?? full;
    if (!this.allResult() || !before || JSON.stringify(was) !== JSON.stringify(now)) return this.run();
    this.starting.set(true);
    this.error.set(null);
    try {
      const id = await api.startDataCompareAll({ ...full, tables: [k.table] });
      this.startPoll(id, async () => {
        const row = (await api.dataCompareAllResult(id)).tables[0];
        this.allResult.update((a) => a && { ...a, tables: a.tables.map((x) => (x.source === k.table && row ? row : x)) });
        this.allReq.set(full);
      });
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.starting.set(false);
    }
  }

  // ---------- Abgleich-Skript als Datei ----------

  /** ohne Obergrenze direkt in eine Datei (Speichern-Dialog, dann Auftrag); danach im Ziel einspielbar */
  protected async saveScript() {
    if (this.fileBusy()) return;
    // bis der Auftrag läuft (Speichern-Dialog, Treiber): ein zweiter Klick öffnete sonst einen zweiten Dialog und Auftrag
    this.fileStarting.set(true);
    this.error.set(null);
    try {
      // das Ziel dieser Anfrage merken: „Im Ziel einspielen“ muss dorthin, auch wenn inzwischen ein anderes gewählt ist
      const target = this.mode() === 'schema' ? (this.allReq() ?? this.requestAll()).target : (this.resultReq() ?? this.request()).target;
      const id =
        this.mode() === 'schema'
          ? await api.startDataCompareScript({ all: this.allReq() ?? this.requestAll(), includeDeletes: this.includeDeletes() })
          : await api.startDataCompareScript({ table: this.resultReq() ?? this.request(), includeDeletes: this.includeDeletes() });
      if (!id) return;
      this.fileTarget.set({ connectionId: target.connectionId, database: target.database });
      this.fileJob.set({ id, kind: 'datacompare', state: 'running', done: 0, statements: 0, current: 'startet …', log: [], durationMs: 0 });
      clearInterval(this.fileTimer);
      const tick = async () => {
        try {
          const s = await api.jobStatus(id);
          this.fileJob.set(s);
          if (s.state !== 'running') clearInterval(this.fileTimer);
        } catch (e) {
          clearInterval(this.fileTimer);
          this.error.set(message(e));
        }
      };
      this.fileTimer = setInterval(() => void tick(), 400);
      void tick();
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.fileStarting.set(false);
    }
  }

  protected cancelFile() {
    const j = this.fileJob();
    if (j?.state === 'running') void api.cancelJob(j.id);
  }

  protected showFile(file: string) {
    void api.showInFolder(file);
  }

  /** gespeichertes Skript im Ziel einspielen: der bekannte Dialog, Datei und das Ziel, für das die Datei geschrieben wurde */
  protected importScript(file: string) {
    const t = this.fileTarget();
    if (!t) return;
    this.dumps.open({ mode: 'import', connectionId: t.connectionId, database: t.database, file });
  }

  /** der zweite Klick eines Doppelklicks auf „Vergleichen“ (bzw. ein Klick in den ersten 600 ms) bricht nicht gleich wieder ab */
  protected cancel(ev?: MouseEvent) {
    if (ev && (ev.detail > 1 || Date.now() - this.startedAt < 600)) return;
    const j = this.job();
    if (j?.state === 'running') void api.cancelJob(j.id);
  }

  // ---------- Anzeige und Aktionen ----------

  protected connName(id: string): string {
    return this.state.connection(id)?.name ?? '';
  }

  protected fmt(n: number): string {
    return n.toLocaleString('de-CH');
  }

  protected secs(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  protected openScript() {
    const t = this.resultReq()?.target;
    if (t) this.state.openQuery(t.connectionId, t.database, this.script());
  }

  protected copyScript() {
    void navigator.clipboard.writeText(this.script());
  }

  protected exportRows() {
    const r = this.result();
    const req = this.resultReq();
    if (!r || !req) return;
    this.exporter.open({
      kind: 'rows',
      columns: this.gridColumns(),
      rows: this.gridRows() as Cell[][],
      selected: [],
      truncated: false,
      baseName: `datenvergleich-${req.source.table}`,
      dialect: r.dialect,
      // wie in der Tabellenansicht: gequotet und mit Schema (sonst faltete PostgreSQL "Orders" auf orders, „order“ wäre ein Syntaxfehler)
      sqlTable: objectName(r.dialect, { schema: req.target.schema, name: req.target.table }),
    });
  }
}
