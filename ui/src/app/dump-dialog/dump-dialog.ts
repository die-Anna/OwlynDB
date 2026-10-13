import { ChangeDetectionStrategy, Component, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALECT_LABEL, type AnonRule, type Dialect, type DumpRequest, type JobStatus, type RowRule, type TableInfo } from '../../../../shared/api-types';
import { ANON_RULES, suggestAnonRule } from '../../../../shared/anonymize-rules';
import { keyColumns } from '../../../../shared/sql-util';
import { api, message } from '../core/api';
import { AppState } from '../core/state';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

export interface DumpTarget {
  /** copy = Dump und Einspielen in einem Schritt, ohne Datei */
  mode: 'dump' | 'import' | 'copy';
  connectionId: string;
  database: string;
  /** Vorauswahl beim Dump bzw. Kopieren: nur dieses Schema bzw. diese Tabelle */
  schema?: string;
  table?: string;
  /** Einspielen: diese Datei schon gewählt (z. B. das Abgleich-Skript des Datenvergleichs) */
  file?: string;
}

@Injectable({ providedIn: 'root' })
export class DumpService {
  readonly target = signal<DumpTarget | null>(null);
  /** nach dem Einspielen: Baum dieser Verbindung neu laden */
  readonly imported = signal<{ connectionId: string; at: number } | null>(null);

  open(t: DumpTarget): void {
    this.target.set(t);
  }
}

interface Item {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  rows?: number;
  on: boolean;
  /** Teilmenge (nur Tabellen, nur mit Daten) */
  rule: 'all' | 'none' | 'last' | 'where' | 'dependent';
  count: number;
  column: string;
  where: string;
}

interface AnonItem {
  schema: string;
  table: string;
  column: string;
  type: string;
  rule: AnonRule;
}

const fmt = new Intl.NumberFormat('de-CH');

@Component({
  selector: 'app-dump-dialog',
  imports: [FormsModule, Icon, Modal],
  templateUrl: './dump-dialog.html',
  styleUrls: ['../export-dialog/export-dialog.scss', './dump-dialog.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DumpDialog {
  protected svc = inject(DumpService);
  protected state = inject(AppState);
  protected readonly dialects = (Object.entries(DIALECT_LABEL) as [Dialect, string][]).filter(([d]) => d !== 'elasticsearch');

  // Dump
  protected items = signal<Item[]>([]);
  protected loading = signal(false);
  protected content = signal<'both' | 'structure' | 'data'>('both');
  protected dropFirst = signal(true);
  protected routines = signal(true);
  protected targetDialect = signal<Dialect>('mysql');
  protected rowsPerInsert = signal(250);

  // Einspielen
  protected file = signal('');
  protected database = signal('');
  protected createDatabase = signal(false);
  protected stopOnError = signal(true);
  protected transaction = signal(true);
  protected skipUse = signal(true);

  // Kopieren: Ziel (Verbindung, Datenbank); Objekte und Inhalt wie beim Dump
  protected targetId = signal('');
  protected targetDbs = signal<string[] | null>(null);
  protected targetDb = signal('');
  protected createTarget = signal(true);

  // Test-Datenbank aus Prod: Teilmenge je Tabelle und Anonymisieren
  protected addReferenced = signal(true);
  /** Struktur je Tabelle (Spalten für „die letzten N nach …“ und das Anonymisieren), bei Bedarf geladen */
  protected infos = signal<ReadonlyMap<string, TableInfo>>(new Map());
  protected anonOn = signal(false);
  protected anonLoading = signal(false);
  protected anonItems = signal<AnonItem[]>([]);
  /** Tabellen, die beim Dump bzw. Kopieren per Fremdschlüssel ergänzt würden – auch dort Personendaten ersetzen */
  protected extraTables = signal<{ schema: string; name: string }[]>([]);
  private extraRun = 0;
  protected addTable = signal('');
  protected addColumn = signal('');
  protected addRule = signal<AnonRule>('name');
  protected readonly anonRules = ANON_RULES;

  protected error = signal<string | null>(null);
  protected job = signal<JobStatus | null>(null);
  /** zwischen Klick und erstem Status: Knopf gesperrt, sonst startete ein zweiter Klick (oder Enter) einen zweiten Auftrag */
  protected starting = signal(false);
  private timer?: ReturnType<typeof setInterval>;

  protected readonly conn = computed(() => {
    const t = this.svc.target();
    return t ? this.state.connection(t.connectionId) : undefined;
  });
  protected readonly dialect = computed(() => this.conn()?.dialect ?? 'mysql');
  protected readonly readOnly = computed(() => !!this.conn()?.options?.readOnly);
  protected readonly running = computed(() => this.job()?.state === 'running');
  protected readonly selected = computed(() => this.items().filter((i) => i.on));
  protected readonly selectedTables = computed(() => this.selected().filter((i) => i.kind === 'table'));
  /** mindestens eine Tabelle nur teilweise */
  protected readonly partial = computed(() => this.content() !== 'structure' && this.selectedTables().some((i) => i.rule !== 'all'));
  protected readonly addColumns = computed(() => this.infos().get(this.addTable())?.columns ?? []);
  /** fürs Anonymisieren wählbar: die gewählten Tabellen und die, die ergänzt würden */
  protected readonly anonTables = computed(() => [
    ...this.selectedTables().map((i) => ({ schema: i.schema, name: i.name, added: false })),
    ...(this.partial() && this.addReferenced() ? this.extraTables().map((t) => ({ ...t, added: true })) : []),
  ]);
  protected readonly schemas = computed(() => [...new Set(this.items().map((i) => i.schema))]);
  protected readonly percent = computed(() => {
    const j = this.job();
    if (!j?.total) return null;
    return Math.min(100, Math.round((j.done / j.total) * 100));
  });
  protected readonly targetConn = computed(() => this.state.connection(this.targetId()));
  /** beim Kopieren bestimmt die Zielverbindung den Datenbanktyp */
  protected readonly copyDialect = computed(() => this.targetConn()?.dialect ?? this.dialect());
  /** warum Kopieren (noch) nicht geht; null = startklar */
  protected readonly copyProblem = computed(() => {
    const t = this.svc.target();
    const target = this.targetConn();
    const db = this.targetDb().trim();
    if (!t || !target) return 'Bitte eine Zielverbindung wählen.';
    if (target.options?.readOnly) return `Die Zielverbindung „${target.name}“ steht auf „Nur lesen“ – dorthin lässt sich nicht kopieren.`;
    if (!db) return 'Bitte eine Zieldatenbank angeben.';
    if (target.id === t.connectionId && db.toLowerCase() === t.database.toLowerCase()) return 'Quelle und Ziel sind dieselbe Datenbank.';
    if (this.createTarget() && this.targetDbs()?.some((d) => d.toLowerCase() === db.toLowerCase())) {
      return `Die Datenbank ${db} gibt es schon – zum Hineinkopieren „neu anlegen“ ausschalten.`;
    }
    return null;
  });

  constructor() {
    effect(() => {
      const t = this.svc.target();
      untracked(() => {
        this.stopTimer();
        this.job.set(null);
        this.error.set(null);
        // Ladevorgänge für ein früheres Ziel enden still (stale) – ihre Anzeige „lädt …“ nicht stehen lassen
        this.loading.set(false);
        this.anonLoading.set(false);
        this.starting.set(false);
        if (!t) return;
        const d = this.state.dialect(t.connectionId);
        this.targetDialect.set(d);
        this.database.set(t.database);
        this.createDatabase.set(false);
        this.file.set(t.file ?? '');
        this.transaction.set(d !== 'mysql');
        this.addReferenced.set(true);
        this.infos.set(new Map());
        this.anonOn.set(false);
        this.anonItems.set([]);
        this.addTable.set('');
        this.addColumn.set('');
        if (t.mode !== 'import') void this.loadItems(t);
        if (t.mode === 'copy') {
          // Vorschlag: neue Datenbank auf demselben Server – überschreibt nichts
          this.createTarget.set(true);
          this.targetDb.set(t.database + '_kopie');
          void this.chooseTarget(t.connectionId);
        }
      });
    });
    // ergänzte Tabellen fürs Anonymisieren nachführen, wenn sich Auswahl, Teilmenge oder „Tabellen ergänzen“ ändern
    effect(() => {
      const on = this.anonOn() && this.partial() && this.addReferenced();
      this.selectedTables();
      untracked(() => {
        const run = ++this.extraRun;
        if (!on) return this.extraTables.set([]);
        void this.referencedTables().then((list) => {
          if (run === this.extraRun) this.extraTables.set(list);
        });
      });
    });
  }

  /** Zielverbindung wählen: verbinden und ihre Datenbanken laden */
  protected async chooseTarget(id: string) {
    this.targetId.set(id);
    this.targetDbs.set(null);
    this.transaction.set(this.state.dialect(id) !== 'mysql');
    try {
      await this.state.ensureConnected(id);
      const dbs = await api.listDatabases(id);
      if (this.targetId() !== id) return;
      this.targetDbs.set(dbs);
      if (!this.createTarget() && !dbs.includes(this.targetDb())) this.targetDb.set(this.otherDatabase(dbs));
    } catch (e) {
      if (this.targetId() !== id) return;
      this.targetDbs.set([]);
      this.error.set(message(e));
    }
  }

  protected setCreateTarget(on: boolean) {
    this.createTarget.set(on);
    const t = this.svc.target();
    if (on) this.targetDb.set((t?.database ?? 'db') + '_kopie');
    else this.targetDb.set(this.otherDatabase(this.targetDbs() ?? []));
  }

  /** vorhandene Zieldatenbank vorschlagen – auf derselben Verbindung nicht die Quelle */
  private otherDatabase(dbs: string[]): string {
    const t = this.svc.target();
    const same = t && this.targetId() === t.connectionId;
    return dbs.find((d) => !same || d !== t.database) ?? '';
  }

  protected dialectLabel(d: Dialect): string {
    return DIALECT_LABEL[d];
  }

  /** Antworten für ein früheres Ziel verwerfen (Dialog zu und für eine andere Datenbank wieder offen) */
  private stale(t: DumpTarget): boolean {
    return this.svc.target() !== t;
  }

  private async loadItems(t: DumpTarget) {
    this.loading.set(true);
    this.items.set([]);
    try {
      const d = this.state.dialect(t.connectionId);
      const schemas = d === 'mysql' ? [''] : await api.listSchemas(t.connectionId, t.database);
      const list: Item[] = [];
      for (const schema of schemas) {
        const objects = await api.listObjects(t.connectionId, t.database, schema);
        if (this.stale(t)) return;
        for (const o of objects) {
          const on = t.table ? o.name === t.table && schema === (t.schema ?? '') : t.schema !== undefined ? schema === t.schema : true;
          list.push({ schema, name: o.name, kind: o.kind, rows: o.rows, on, rule: 'all', count: 1000, column: '', where: '' });
        }
      }
      if (this.stale(t)) return;
      this.items.set(list);
    } catch (e) {
      if (!this.stale(t)) this.error.set(message(e));
    } finally {
      if (!this.stale(t)) this.loading.set(false);
    }
  }

  protected label(i: { schema: string; name: string }): string {
    return i.schema ? `${i.schema}.${i.name}` : i.name;
  }

  protected rows(n?: number): string {
    return n == null ? '' : fmt.format(n);
  }

  protected toggle(i: Item, on: boolean) {
    this.items.update((list) => list.map((x) => (x === i ? { ...x, on } : x)));
  }

  protected setAll(on: boolean, schema?: string) {
    this.items.update((list) => list.map((x) => (schema === undefined || x.schema === schema ? { ...x, on } : x)));
  }

  // ---------- Teilmenge ----------

  protected itemKey(i: { schema: string; name: string }): string {
    return `${i.schema}\u0000${i.name}`;
  }

  /** Struktur einer Tabelle (einmal laden) */
  private async loadInfo(schema: string, name: string): Promise<TableInfo | undefined> {
    const t = this.svc.target();
    if (!t) return undefined;
    const k = `${schema}\u0000${name}`;
    const known = this.infos().get(k);
    if (known) return known;
    try {
      const info = await api.describeTable({ connectionId: t.connectionId, database: t.database, schema, name, kind: 'table' });
      // inzwischen ein anderes Ziel: nicht unter dem Namen einer gleichnamigen Tabelle dort ablegen
      if (this.stale(t)) return undefined;
      this.infos.update((m) => new Map(m).set(k, info));
      return info;
    } catch (e) {
      if (!this.stale(t)) this.error.set(message(e));
      return undefined;
    }
  }

  protected columnsOf(i: Item): string[] {
    return this.infos().get(this.itemKey(i))?.columns.map((c) => c.name) ?? [];
  }

  private patchItem(i: Item, patch: Partial<Item>) {
    this.items.update((list) => list.map((x) => (x.schema === i.schema && x.name === i.name ? { ...x, ...patch } : x)));
  }

  protected async setRule(i: Item, rule: Item['rule']) {
    this.patchItem(i, { rule });
    if (rule !== 'last') return;
    const info = await this.loadInfo(i.schema, i.name);
    const cur = this.items().find((x) => x.schema === i.schema && x.name === i.name);
    if (info && cur && !cur.column) {
      // Vorschlag: Schlüssel, sonst eine Datumsspalte, sonst die erste Spalte
      const date = info.columns.find((c) => /date|time/i.test(c.dataType))?.name;
      this.patchItem(i, { column: keyColumns(info)?.[0] ?? date ?? info.columns[0]?.name ?? '' });
    }
  }

  protected setCount(i: Item, n: number) {
    this.patchItem(i, { count: Math.max(1, Math.floor(Number(n) || 1)) });
  }

  protected setColumn(i: Item, column: string) {
    this.patchItem(i, { column });
  }

  protected setWhere(i: Item, where: string) {
    this.patchItem(i, { where });
  }

  private rowRule(i: Item): RowRule {
    if (i.rule === 'none') return { kind: 'none' };
    if (i.rule === 'last') return { kind: 'last', count: i.count, column: i.column };
    if (i.rule === 'where') return { kind: 'where', where: i.where.trim() };
    if (i.rule === 'dependent') return { kind: 'dependent' };
    return { kind: 'all' };
  }

  /** Teilmenge und Anonymisieren für Dump und Kopieren; wirft bei unvollständigen Angaben */
  private extras(): Pick<DumpRequest, 'subset' | 'addReferenced' | 'anonymize'> {
    if (this.content() === 'structure') return {};
    const out: Pick<DumpRequest, 'subset' | 'addReferenced' | 'anonymize'> = {};
    const parts = this.selectedTables().filter((i) => i.rule !== 'all');
    for (const i of parts) {
      if (i.rule === 'last' && !i.column) throw new Error(`${i.name}: bitte die Spalte für „die letzten ${i.count}“ wählen.`);
      if (i.rule === 'where' && !i.where.trim()) throw new Error(`${i.name}: bitte eine WHERE-Bedingung eingeben.`);
    }
    if (parts.length) {
      out.subset = parts.map((i) => ({ schema: i.schema, name: i.name, rule: this.rowRule(i) }));
      out.addReferenced = this.addReferenced();
    }
    if (this.anonOn() && this.anonItems().length) {
      out.anonymize = this.anonItems().map(({ schema, table, column, rule }) => ({ schema, table, column, rule }));
    }
    return out;
  }

  // ---------- Anonymisieren ----------

  protected async toggleAnon(on: boolean) {
    this.anonOn.set(on);
    if (on && !this.anonItems().length) await this.suggest();
  }

  /**
   * Tabellen, auf die die gewählten verweisen (über alle Stufen) und die nicht gewählt sind – so, wie writeDump sie bei einer
   * Teilmenge mit „Tabellen ergänzen“ dazunimmt (MySQL: nur aus derselben Datenbank)
   */
  private async referencedTables(): Promise<{ schema: string; name: string }[]> {
    const t = this.svc.target();
    if (!t || !this.partial() || !this.addReferenced()) return [];
    const mysql = this.dialect() === 'mysql';
    const queue = this.selectedTables().map((i) => ({ schema: i.schema, name: i.name }));
    const seen = new Set(queue.map((i) => this.itemKey(i)));
    const out: { schema: string; name: string }[] = [];
    for (let k = 0; k < queue.length; k++) {
      const info = await this.loadInfo(queue[k].schema, queue[k].name);
      for (const fk of info?.foreignKeys ?? []) {
        if (mysql && fk.refSchema && fk.refSchema !== t.database) continue;
        const ref = { schema: mysql ? '' : fk.refSchema, name: fk.refTable };
        if (seen.has(this.itemKey(ref))) continue;
        seen.add(this.itemKey(ref));
        queue.push(ref);
        out.push(ref);
      }
    }
    return out;
  }

  /** gehört der Eintrag zu einer Tabelle, die nur ergänzt wird? */
  protected isAdded(a: AnonItem): boolean {
    return this.anonTables().some((t) => t.added && t.schema === a.schema && t.name === a.table);
  }

  /** Vorschläge anhand der Spaltennamen für die gewählten und die ergänzten Tabellen; vorhandene Einträge bleiben */
  protected async suggest() {
    const target = this.svc.target();
    if (!target) return;
    this.anonLoading.set(true);
    try {
      const have = new Set(this.anonItems().map((a) => `${a.schema}\u0000${a.table}\u0000${a.column}`));
      const found: AnonItem[] = [];
      const extra = await this.referencedTables();
      if (this.stale(target)) return;
      this.extraTables.set(extra);
      for (const t of [...this.selectedTables(), ...extra]) {
        const info = await this.loadInfo(t.schema, t.name);
        if (this.stale(target)) return;
        for (const c of info?.columns ?? []) {
          const rule = suggestAnonRule(t.name, c.name, c.dataType);
          if (rule && !have.has(`${t.schema}\u0000${t.name}\u0000${c.name}`)) found.push({ schema: t.schema, table: t.name, column: c.name, type: c.dataType, rule });
        }
      }
      this.anonItems.update((l) => [...l, ...found]);
    } finally {
      if (!this.stale(target)) this.anonLoading.set(false);
    }
  }

  protected setAnonRule(ix: number, rule: AnonRule) {
    this.anonItems.update((l) => l.map((a, i) => (i === ix ? { ...a, rule } : a)));
  }

  protected removeAnon(ix: number) {
    this.anonItems.update((l) => l.filter((_, i) => i !== ix));
  }

  protected async pickAddTable(k: string) {
    this.addTable.set(k);
    this.addColumn.set('');
    const t = this.anonTables().find((i) => this.itemKey(i) === k);
    if (t) await this.loadInfo(t.schema, t.name);
  }

  protected addAnon() {
    const t = this.anonTables().find((i) => this.itemKey(i) === this.addTable());
    const c = this.addColumns().find((x) => x.name === this.addColumn());
    if (!t || !c) return;
    const rest = this.anonItems().filter((a) => !(a.schema === t.schema && a.table === t.name && a.column === c.name));
    this.anonItems.set([...rest, { schema: t.schema, table: t.name, column: c.name, type: c.dataType, rule: this.addRule() }]);
    this.addColumn.set('');
  }

  protected async pickFile() {
    const f = await api.pickFile('sql', this.file() || undefined);
    if (f) this.file.set(f);
  }

  protected async start() {
    const t = this.svc.target();
    if (!t || this.starting() || this.running()) return;
    this.error.set(null);
    this.starting.set(true);
    try {
      let id: string | null;
      if (t.mode === 'dump') {
        const sel = this.selected();
        if (!sel.length) throw new Error('Bitte mindestens eine Tabelle wählen.');
        const c = this.content();
        const extras = this.extras();
        id = await api.startDump({
          ...extras,
          connectionId: t.connectionId,
          database: t.database,
          tables: sel.filter((i) => i.kind === 'table').map(({ schema, name }) => ({ schema, name })),
          views: sel.filter((i) => i.kind === 'view').map(({ schema, name }) => ({ schema, name })),
          structure: c !== 'data',
          data: c !== 'structure',
          dropFirst: this.dropFirst() && c !== 'data',
          // für einen anderen Datenbanktyp ist die Option aus und gesperrt – dann auch nicht verlangen
          routines: this.routines() && c !== 'data' && this.targetDialect() === this.dialect(),
          targetDialect: this.targetDialect(),
          rowsPerInsert: this.rowsPerInsert(),
          baseName: sel.length === 1 ? `${t.database}-${sel[0].name}` : `${t.database}-${new Date().toISOString().slice(0, 10)}`,
        });
        if (!id) return;
      } else if (t.mode === 'copy') {
        const problem = this.copyProblem();
        if (problem) throw new Error(problem);
        const sel = this.selected();
        if (!sel.length) throw new Error('Bitte mindestens eine Tabelle wählen.');
        const c = this.content();
        const target = this.targetConn()!;
        const db = this.targetDb().trim();
        const tx = this.transaction() && this.copyDialect() !== 'mysql';
        const extras = this.extras();
        const lines = [
          `Quelle: ${this.conn()?.name ?? ''} · ${t.database} (${sel.length} Objekt${sel.length === 1 ? '' : 'e'}${c === 'structure' ? ', nur Struktur' : c === 'data' ? ', nur Daten' : ''})`,
          `Ziel: ${target.name} · ${db}${this.createTarget() ? ' (wird neu angelegt)' : ''}`,
        ];
        if (extras.subset) lines.push('', `Teilmenge: ${extras.subset.length} Tabelle(n) nur teilweise – dazu alle Zeilen, auf die verwiesen wird.`);
        if (extras.anonymize) lines.push(`Anonymisiert: ${extras.anonymize.length} Spalte(n) und per Fremdschlüssel verbundene.`);
        if (!this.createTarget() && this.dropFirst() && c !== 'data') lines.push('', 'Im Ziel werden vorhandene Tabellen und Views mit gleichem Namen vorher gelöscht.');
        if (this.copyDialect() !== this.dialect()) lines.push('', `Typen werden von ${DIALECT_LABEL[this.dialect()]} nach ${DIALECT_LABEL[this.copyDialect()]} übersetzt.`);
        if (!confirm(`Wirklich kopieren?\n\n${lines.join('\n')}`)) return;
        id = await api.startCopy({
          source: {
            ...extras,
            connectionId: t.connectionId,
            database: t.database,
            tables: sel.filter((i) => i.kind === 'table').map(({ schema, name }) => ({ schema, name })),
            views: sel.filter((i) => i.kind === 'view').map(({ schema, name }) => ({ schema, name })),
            structure: c !== 'data',
            data: c !== 'structure',
            dropFirst: this.dropFirst() && c !== 'data',
            routines: this.routines() && c !== 'data' && this.copyDialect() === this.dialect(),
            rowsPerInsert: this.rowsPerInsert(),
          },
          targetConnectionId: target.id,
          targetDatabase: db,
          createDatabase: this.createTarget(),
          stopOnError: this.stopOnError() || tx,
          transaction: tx,
        });
      } else {
        if (!this.file()) throw new Error('Bitte eine SQL-Datei wählen.');
        const db = this.database().trim();
        const name = this.conn()?.name ?? '';
        const ok = confirm(
          `SQL-Datei wirklich einspielen?\n\nZiel: ${name} · ${db}${this.createDatabase() ? ' (wird neu angelegt)' : ''}\nDatei: ${this.file()}\n\n` +
            'Die Anweisungen der Datei werden ausgeführt – vorhandene Tabellen können dabei gelöscht oder überschrieben werden.',
        );
        if (!ok) return;
        id = await api.startImport({
          connectionId: t.connectionId,
          database: db,
          createDatabase: this.createDatabase(),
          file: this.file(),
          stopOnError: this.stopOnError() || this.transaction(),
          transaction: this.transaction() && this.dialect() !== 'mysql',
          skipUse: this.skipUse(),
        });
      }
      this.watch(id, t.mode);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.starting.set(false);
    }
  }

  private watch(id: string, kind: DumpTarget['mode']) {
    // gleich als laufend zeigen (sperrt den Knopf bis zum ersten Status) und einen alten Abfrage-Takt beenden
    this.stopTimer();
    this.job.set({ id, kind, state: 'running', done: 0, statements: 0, current: 'startet …', log: [], durationMs: 0 });
    const poll = async () => {
      try {
        const s = await api.jobStatus(id);
        this.job.set(s);
        if (s.state !== 'running') {
          this.stopTimer();
          const t = this.svc.target();
          // Baum der Zielverbindung neu laden (neue Datenbank, neue Tabellen)
          if (t && t.mode !== 'dump' && s.statements > 0) {
            this.svc.imported.set({ connectionId: t.mode === 'copy' ? this.targetId() : t.connectionId, at: Date.now() });
          }
        }
      } catch (e) {
        this.stopTimer();
        this.error.set(message(e));
      }
    };
    void poll();
    this.timer = setInterval(() => void poll(), 300);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  protected cancel() {
    const j = this.job();
    if (j) void api.cancelJob(j.id);
  }

  protected showFile() {
    const f = this.job()?.file;
    if (f) void api.showInFolder(f);
  }

  protected fmtNum(n: number): string {
    return fmt.format(n);
  }

  protected bytes(n: number): string {
    return n < 1024 * 1024 ? `${fmt.format(Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  protected secs(ms: number): string {
    return (ms / 1000).toFixed(1) + ' s';
  }

  /** nur Klick auf den Hintergrund schließt (nicht während ein Auftrag läuft) */
  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget && !this.running()) this.close();
  }

  protected close() {
    if (this.running()) return;
    this.stopTimer();
    this.svc.target.set(null);
  }
}
