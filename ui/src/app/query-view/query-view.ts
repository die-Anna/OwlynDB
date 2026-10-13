import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, HostListener, inject, input, signal, untracked, viewChild } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import type { Cell, CompletionInfo, QueryPlan, QueryRun } from '../../../../shared/api-types';
import { isConsoleRequest } from '../../../../shared/es-console';
import { executeWarnings, pickStatements, type Picked } from '../../../../shared/query-pick';
import { rerunBlocker } from '../../../../shared/sql-guard';
import { api, message } from '../core/api';
import { AppState, QueryTab } from '../core/state';
import { CompletionSource, MonacoApi } from '../editor/monaco';
import { SqlEditor } from '../editor/sql-editor';
import { LibraryMode, QueryLibrary } from './query-library';
import { PlanView } from '../plan-view/plan-view';
import { Icon } from '../ui/icon';
import { KeysPipe } from '../ui/keys.pipe';
import { ResultGrid } from '../ui/result-grid';
import { ExportService } from '../export-dialog/export-dialog';

const fmt = new Intl.NumberFormat('de-CH');

@Component({
  selector: 'app-query-view',
  imports: [Icon, SqlEditor, ResultGrid, QueryLibrary, PlanView, KeysPipe],
  templateUrl: './query-view.html',
  styleUrl: './query-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryView {
  readonly tab = input.required<QueryTab>();
  readonly active = input(false);
  protected state = inject(AppState);
  private exporter = inject(ExportService);
  private grid = viewChild(ResultGrid);

  protected readonly maxRowOptions = [1000, 5000, 20000, 100000];
  protected maxRows = signal(5000);
  protected sessionId = signal<string | null>(null);
  protected sessionError = signal<string | null>(null);
  protected connecting = signal(false);
  protected databases = signal<string[]>([]);
  protected database = signal<string | undefined>(undefined);
  protected completion = signal<CompletionInfo | undefined>(undefined);

  protected running = signal(false);
  protected elapsed = signal(0);
  protected run = signal<QueryRun | null>(null);
  /** Zeile je Anweisung (statementIndex) zum Zeitpunkt des Laufs – einmal aus den Offsets berechnet, nicht bei jedem Zeichnen */
  protected stmtLines = signal<Map<number, number>>(new Map());
  /** Meldungsliste: bei sehr vielen Anweisungen die ersten 500 und jeden Fehler (sonst stünde die Oberfläche) */
  protected readonly shownStatements = computed(() => {
    const st = this.run()?.statements ?? [];
    return st.length <= 500 ? st : st.filter((s, i) => i < 500 || s.error);
  });
  private completionSeq = 0;
  /** zuletzt angeforderter Ausführungsplan (bleibt neben den Ergebnissen, bis er geschlossen oder ersetzt wird) */
  protected plan = signal<QueryPlan | null>(null);
  /** Hinweis, wenn die Verbindung unterbrochen war (z. B. Proxy-Timeout) – sonst geht er im Reiter Meldungen unter */
  /** gelbe Leiste: Verbindung unterbrochen, Datenbankwechsel abgelehnt usw. – geht sonst im Reiter Meldungen unter */
  protected notice = signal<string | null>(null);
  /** nach dem letzten Lauf ist eine Transaktion offen */
  protected inTransaction = signal(false);
  protected resultIndex = signal(0);
  /** gewünschte Ansicht unten; was es nicht gibt, ersetzt view() */
  protected pane = signal<'result' | 'messages' | 'plan'>('result');
  protected editorPct = signal(45);
  /** Seitenleiste Verlauf / gespeicherte Abfragen */
  protected panel = signal<LibraryMode | null>(null);
  protected historyTick = signal(0);
  protected saveTick = signal(0);
  /** Markierung bzw. ganzer Editor-Text (zum Speichern) */
  protected readonly currentSql = () => {
    const ed = this.editor;
    const sel = ed?.getSelection();
    const model = ed?.getModel();
    if (!ed || !model) return '';
    return sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue();
  };

  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private monaco?: MonacoApi;
  private decorations?: Monaco.editor.IEditorDecorationsCollection;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  /** Kürzel dieses Editors: beim Schließen abmelden – sonst hielten sie die ganze Ansicht samt Ergebnissen im Speicher */
  private keys: Monaco.IDisposable[] = [];
  private destroyed = false;
  /** Start der laufenden Ausführung: „Abbrechen“ erscheint an der Stelle von „Ausführen“ */
  private startedAt = 0;

  protected readonly dialect = computed(() => this.state.dialect(this.tab().connectionId));
  /** Elasticsearch: Konsolen-Anfragen und SQL, nur lesen, kein Plan, keine Datenbankauswahl */
  protected readonly es = computed(() => this.dialect() === 'elasticsearch');
  /** Sicherheitsmodus der Verbindung (wird auch im Hauptprozess durchgesetzt) */
  protected readonly readOnly = computed(() => !!this.state.connection(this.tab().connectionId)?.options?.readOnly);
  protected readonly completionSource: CompletionSource = ((self: QueryView) => ({
    get dialect() {
      return self.dialect();
    },
    info: () => self.completion(),
  }))(this);
  protected readonly results = computed(() => this.run()?.results ?? []);
  protected readonly failed = computed(() => this.run()?.statements.find((s) => s.error));
  protected readonly planFailed = computed(() => !!this.plan()?.statements.some((s) => s.error));
  protected readonly view = computed(() => {
    const p = this.pane();
    if (p === 'plan') return this.plan() ? 'plan' : 'result';
    return this.run() ? p : this.plan() ? 'plan' : p;
  });
  protected readonly summary = computed(() => {
    const r = this.run();
    if (!r) return '';
    const n = r.statements.length;
    const affected = r.statements.reduce((a, s) => a + (s.rowsAffected ?? 0), 0);
    const parts = [`${n} Anweisung${n === 1 ? '' : 'en'}`];
    const set = this.results()[this.resultIndex()];
    if (set && this.view() === 'result' && set.text === undefined) {
      const n = fmt.format(set.rows.length);
      parts.push(set.totalRows !== undefined ? `${n} von ${fmt.format(set.totalRows)} Zeilen` : `${n} Zeilen${set.truncated ? ' (abgeschnitten)' : ''}`);
    }
    if (affected) parts.push(`${fmt.format(affected)} betroffen`);
    parts.push(`${fmt.format(r.durationMs)} ms`);
    if (r.cancelled) parts.push('abgebrochen');
    return parts.join(' · ');
  });

  constructor() {
    effect(() => {
      if (this.active() && !this.started) {
        this.started = true;
        untracked(() => void this.connect());
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearInterval(this.timer);
      for (const k of this.keys) k.dispose();
      this.keys = [];
      const id = this.sessionId();
      if (id) void api.closeSession(id);
    });
  }

  protected async connect() {
    const t = this.tab();
    this.connecting.set(true);
    this.sessionError.set(null);
    try {
      await this.state.ensureConnected(t.connectionId);
      const old = this.sessionId();
      if (old) void api.closeSession(old);
      const wanted = this.database() ?? t.database;
      let s: { sessionId: string; database?: string };
      let fallback: string | null = null;
      try {
        s = await api.openSession(t.connectionId, wanted);
      } catch (e) {
        if (!wanted) throw e;
        // Datenbank gibt es nicht mehr (gelöscht, umbenannt, anderer Server): mit der Standard-Datenbank der Verbindung,
        // sonst ließe sich der Tab nie mehr verbinden (die Auswahl ist ohne Sitzung gesperrt)
        s = await api.openSession(t.connectionId);
        fallback = `Datenbank „${wanted}“ ließ sich nicht öffnen (${message(e)}) – verbunden mit der Standard-Datenbank der Verbindung.`;
      }
      // während des Verbindens geschlossen: Sitzung gleich wieder zu (sie bliebe sonst ohne Tab offen, ggf. mit Sperren)
      if (this.destroyed || !this.state.registerSession(this.tab().id, s.sessionId)) {
        void api.closeSession(s.sessionId);
        return;
      }
      this.sessionId.set(s.sessionId);
      this.inTransaction.set(false);
      this.database.set(s.database);
      if (fallback) {
        this.notice.set(fallback);
        this.state.setQueryText(this.tab().id, this.editor?.getValue() ?? t.initialSql, s.database ?? '');
      }
      void this.loadDatabases();
      void this.loadCompletion();
    } catch (e) {
      this.sessionError.set(message(e));
    } finally {
      this.connecting.set(false);
    }
  }

  private async loadDatabases() {
    try {
      this.databases.set(await api.listDatabases(this.tab().connectionId));
    } catch {
      this.databases.set([]);
    }
  }

  private async loadCompletion() {
    const db = this.database();
    const my = ++this.completionSeq;
    if (!db) return;
    try {
      const c = await api.completionInfo(this.tab().connectionId, db);
      // inzwischen andere Datenbank (oder neuerer Aufruf): eine langsame ältere Antwort überschriebe sonst die neuere
      if (my === this.completionSeq && db === this.database()) this.completion.set(c);
    } catch {
      if (my === this.completionSeq) this.completion.set(undefined);
    }
  }

  protected async changeDatabase(db: string, select?: HTMLSelectElement) {
    const id = this.sessionId();
    if (!id) return;
    try {
      const note = await api.setSessionDatabase(id, db);
      this.notice.set(note);
      if (note) this.inTransaction.set(false);
      this.database.set(db);
      this.state.setQueryText(this.tab().id, this.editor?.getValue() ?? '', db);
      void this.loadCompletion();
    } catch (e) {
      // z. B. PostgreSQL mit offener Transaktion, keine Berechtigung: Auswahl zurückstellen – direkt am Element, das Signal
      // ändert sich ja nicht (die Sitzung ist noch in der alten Datenbank) und Angular zeichnete die Liste nicht neu
      this.notice.set(message(e));
      if (select) select.value = this.database() ?? '';
    }
  }

  protected onEditorReady(e: { editor: Monaco.editor.IStandaloneCodeEditor; monaco: MonacoApi }) {
    this.editor = e.editor;
    this.monaco = e.monaco;
    this.decorations = e.editor.createDecorationsCollection();
    const { KeyMod, KeyCode } = e.monaco;
    // Monaco führt Kürzel für alle Editoren gemeinsam, der zuletzt angelegte gewinnt: ohne eigenen Kontextschlüssel und
    // eigene Kennung liefe Strg+Enter im sichtbaren Tab im Editor eines anderen Tabs – auf dessen Verbindung. addAction
    // statt addCommand: liefert etwas zum Abmelden (onDestroy)
    const own = 'owlynQuery' + this.tab().id.replace(/[^A-Za-z0-9]/g, '');
    e.editor.createContextKey(own, true);
    const bind = (name: string, label: string, keys: number, run: () => void) =>
      this.keys.push(e.editor.addAction({ id: `${own}.${name}`, label, keybindings: [keys], precondition: own, run: () => run() }));
    bind('current', 'Anweisung ausführen', KeyMod.CtrlCmd | KeyCode.Enter, () => void this.execute('current'));
    bind('all', 'Alles ausführen', KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () => void this.execute('all'));
    bind('f5', 'Alles ausführen (F5)', KeyCode.F5, () => void this.execute('all'));
    bind('f9', 'Anweisung ausführen (F9)', KeyCode.F9, () => void this.execute('current'));
    bind('format', 'SQL formatieren', KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF, () => this.format());
    // wie SQL Server Management Studio: Strg+L geschätzter Plan, Strg+M mit Laufzeit
    bind('plan', 'Ausführungsplan', KeyMod.CtrlCmd | KeyCode.KeyL, () => void this.explain(false));
    bind('analyze', 'Ausführungsplan mit Laufzeit', KeyMod.CtrlCmd | KeyCode.KeyM, () => void this.explain(true));
    bind('save', 'Abfrage speichern', KeyMod.CtrlCmd | KeyCode.KeyS, () => {
      this.panel.set('saved');
      this.saveTick.update((n) => n + 1);
    });
    e.editor.onDidChangeModelContent(() => this.clearMarkers());
  }

  /** dieselben Kürzel außerhalb des Editors, solange der Fokus in diesem Tab liegt (z. B. im Ergebnis) */
  @HostListener('keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent) {
    // im Eingabe-Editor gelten seine eigenen Kürzel (der schreibgeschützte Antwort-Editor von Elasticsearch hat keine)
    if (this.editor?.getDomNode()?.contains(ev.target as Node)) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    let act: (() => void) | undefined;
    if (ev.key === 'F5' && !ctrl) act = () => void this.execute('all');
    else if (ev.key === 'F9' && !ctrl) act = () => void this.execute('current');
    else if (ev.key === 'Enter' && ctrl) act = () => void this.execute(ev.shiftKey ? 'all' : 'current');
    else if (ctrl && !ev.shiftKey && !ev.altKey && key === 'l') act = () => void this.explain(false);
    else if (ctrl && !ev.shiftKey && !ev.altKey && key === 'm') act = () => void this.explain(true);
    if (!act) return;
    ev.preventDefault();
    act();
  }

  protected togglePanel(m: LibraryMode) {
    this.panel.set(this.panel() === m ? null : m);
  }

  /** aus Verlauf/Gespeichert einfügen: Markierung ersetzen, sonst an der Cursor-Position (auf eigener Zeile) */
  protected insertSql(sql: string) {
    const ed = this.editor;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) return;
    let range: Monaco.IRange = sel;
    // neben anderem Text mit Abschluss, sonst verschmilzt die Anweisung mit der nächsten Zeile
    // (Konsolen-Anfragen von Elasticsearch enden ohne „;“ – sie trennt die nächste Kopfzeile)
    const consoleReq = this.es() && isConsoleRequest(sql);
    // endet die letzte Zeile in einem Zeilenkommentar, stünde das „;“ darin: dann auf eigener Zeile
    const end = /(--|#)[^\n]*$/.test(sql.trimEnd()) ? '\n;' : ';';
    let text = model.getValueLength() > 0 && !consoleReq && !/;\s*$/.test(sql) ? sql.trimEnd() + end : sql;
    const line = sel.startLineNumber;
    if (sel.isEmpty() && model.getLineContent(line).trim()) {
      // nicht mitten in eine Zeile: ans Zeilenende und auf eine neue Zeile
      const end = model.getLineMaxColumn(line);
      range = { startLineNumber: line, startColumn: end, endLineNumber: line, endColumn: end };
      text = '\n' + text;
    }
    ed.pushUndoStop();
    ed.executeEdits('bibliothek', [{ range, text, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  }

  protected openFromLibrary(e: { sql: string; connectionId?: string; database?: string }) {
    const known = e.connectionId && this.state.connection(e.connectionId);
    this.state.openQuery(known ? e.connectionId! : this.tab().connectionId, known ? e.database : this.database(), e.sql);
  }

  /** Markierung bzw. ganzen Text formatieren (über die Formatierer im Editor, damit Strg+Z es zurücknimmt) */
  protected format() {
    const ed = this.editor;
    if (!ed) return;
    const sel = ed.getSelection();
    void ed.getAction(sel && !sel.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument')?.run();
    ed.focus();
  }

  protected onText(text: string) {
    this.state.setQueryText(this.tab().id, text);
  }

  /**
   * Anweisungen für Ausführen bzw. Plan: eine Markierung hat immer Vorrang, sonst alles (all) bzw. die Anweisung unter
   * dem Cursor (current). Markiert sie kurz im Editor; null = nichts gefunden (Hinweis empty).
   */
  private pick(mode: 'current' | 'all', empty: string): (Picked & { text: string }) | null {
    const ed = this.editor;
    const model = ed?.getModel();
    if (!ed || !model) return null;
    const text = model.getValue();
    const sel = ed.getSelection();
    // Auswahl und Zerlegen ohne Editor (shared/query-pick.ts, mit Tests); hier nur die Offsets aus Monaco
    const picked = pickStatements({
      text,
      selection: sel && !sel.isEmpty() ? { start: model.getOffsetAt(sel.getStartPosition()), end: model.getOffsetAt(sel.getEndPosition()) } : undefined,
      cursor: model.getOffsetAt(ed.getPosition()!),
      mode,
      dialect: this.dialect(),
    });
    if (!picked) {
      if (mode === 'current') this.notice.set(empty);
      return null;
    }
    this.flash(picked.ranges);
    this.clearMarkers();
    return { ...picked, text };
  }

  /** Sicherheitsnetz gegen Versehen: bei Warnungen nachfragen; true = ausführen */
  private confirmRisks(warnings: string[], question: string): boolean {
    if (!warnings.length) return true;
    const conn = this.state.connection(this.tab().connectionId)?.name ?? '';
    return confirm(`${question} (${conn}${this.database() ? ' · ' + this.database() : ''})\n\n- ${warnings.join('\n- ')}`);
  }

  /** current = Anweisung unter dem Cursor; all = alles. Eine Markierung hat immer Vorrang. */
  protected async execute(mode: 'current' | 'all') {
    const id = this.sessionId();
    if (!id || this.running()) return;
    const picked = this.pick(mode, 'Der Cursor steht in keiner Anweisung – es wurde nichts ausgeführt.');
    if (!picked) return;
    const { input, text } = picked;

    // vor DELETE/UPDATE ohne WHERE, DROP, TRUNCATE nachfragen (Elasticsearch: der Hauptprozess lässt nur Lesendes durch)
    if (!this.confirmRisks(executeWarnings(picked, this.dialect(), { readOnly: this.readOnly() }), 'Wirklich ausführen?')) return;
    this.notice.set(null);

    this.running.set(true);
    this.startedAt = Date.now();
    this.elapsed.set(0);
    const t0 = Date.now();
    this.timer = setInterval(() => this.elapsed.set(Date.now() - t0), 100);
    try {
      const r = await api.runQuery(id, input, this.maxRows());
      this.run.set(r);
      this.stmtLines.set(new Map(r.statements.map((s) => [s.statementIndex, this.lineOf(input[s.statementIndex]?.offset ?? -1)])));
      this.resultIndex.set(0);
      this.pane.set(!r.results.length || r.statements.some((s) => s.error) ? 'messages' : 'result');
      this.inTransaction.set(!!r.inTransaction);
      this.notice.set(r.messages.find((m) => /^Die Verbindung (war unterbrochen|wurde während)/.test(m)) ?? null);
      if (r.currentDatabase && r.currentDatabase !== this.database()) {
        this.database.set(r.currentDatabase);
        // der aktuelle Text – während des Laufs Getipptes nicht mit dem Stand von vorher überschreiben
        this.state.setQueryText(this.tab().id, this.editor?.getValue() ?? text, r.currentDatabase);
        void this.loadCompletion();
      }
      const err = r.statements.find((s) => s.error);
      if (err) this.markError(input[err.statementIndex].offset, err.sql, err.error!);
      // DDL im Skript: Autovervollständigung auffrischen
      if (r.statements.some((s) => /^\s*(create|alter|drop)\b/i.test(s.sql))) void this.loadCompletion();
    } catch (e) {
      const msg = message(e);
      this.run.set({ results: [], statements: [], messages: [msg], cancelled: false, durationMs: Date.now() - t0 });
      this.pane.set('messages');
      if (/Sitzung ist nicht mehr offen/.test(msg)) this.sessionId.set(null);
    } finally {
      clearInterval(this.timer);
      this.running.set(false);
      this.historyTick.update((n) => n + 1);
    }
  }

  /**
   * Ausführungsplan der Markierung bzw. der Anweisung unter dem Cursor. analyze = mit Laufzeit: die Anweisung läuft
   * dabei wirklich, deshalb bei allem, was nicht nur liest, nachfragen.
   */
  protected async explain(analyze: boolean) {
    const id = this.sessionId();
    if (!id || this.running()) return;
    if (this.es()) {
      this.notice.set('Für Elasticsearch gibt es keinen Ausführungsplan – "profile": true im Such-Body zeigt, wo die Zeit hingeht.');
      return;
    }
    const picked = this.pick('current', 'Der Cursor steht in keiner Anweisung – für einen Plan bitte hineinklicken oder sie markieren.');
    if (!picked) return;
    const { input, text } = picked;
    if (analyze && !this.confirmRisks(executeWarnings(picked, this.dialect(), { readOnly: this.readOnly(), analyze }), 'Plan mit Laufzeit – Anweisung wirklich ausführen?')) {
      return;
    }
    this.notice.set(null);

    this.running.set(true);
    this.startedAt = Date.now();
    this.elapsed.set(0);
    const t0 = Date.now();
    this.timer = setInterval(() => this.elapsed.set(Date.now() - t0), 100);
    try {
      const p = await api.explainQuery(id, input, analyze);
      this.inTransaction.set(!!p.inTransaction);
      if (p.reconnected) {
        this.notice.set(p.messages[0] ?? null);
        return;
      }
      this.plan.set(p);
      this.pane.set('plan');
      this.notice.set(p.messages.find((m) => /^Die Verbindung (war unterbrochen|wurde während)/.test(m)) ?? null);
      if (p.currentDatabase && p.currentDatabase !== this.database()) {
        this.database.set(p.currentDatabase);
        this.state.setQueryText(this.tab().id, this.editor?.getValue() ?? text, p.currentDatabase);
        void this.loadCompletion();
      }
    } catch (e) {
      const msg = message(e);
      this.plan.set({ analyzed: analyze, statements: [{ sql: input.map((s) => s.sql).join(';\n'), error: msg, notes: [] }], messages: [], cancelled: false, durationMs: Date.now() - t0 });
      this.pane.set('plan');
      if (/Sitzung ist nicht mehr offen/.test(msg)) this.sessionId.set(null);
    } finally {
      clearInterval(this.timer);
      this.running.set(false);
      // mit Laufzeit steht die Ausführung im Verlauf
      if (analyze) this.historyTick.update((n) => n + 1);
    }
  }

  /**
   * „Abbrechen“ steht dort, wo eben noch „Ausführen“ war: der zweite Klick eines Doppelklicks (bzw. ein Klick in den
   * ersten 600 ms) bricht nicht ab – sonst lief ein halbes Skript (die ersten Anweisungen schon festgeschrieben)
   */
  protected async cancel(ev?: MouseEvent) {
    if (ev && (ev.detail > 1 || Date.now() - this.startedAt < 600)) return;
    const id = this.sessionId();
    if (id) await api.cancelQuery(id).catch(() => undefined);
  }

  private flash(ranges: [number, number][]) {
    const model = this.editor?.getModel();
    if (!model || !this.decorations || !this.monaco) return;
    const m = this.monaco;
    this.decorations.set(
      ranges.map(([a, b]) => {
        const s = model.getPositionAt(a);
        const e = model.getPositionAt(b);
        return { range: new m.Range(s.lineNumber, s.column, e.lineNumber, e.column), options: { className: 'executed-stmt' } };
      }),
    );
    setTimeout(() => this.decorations?.clear(), 600);
  }

  private markError(offset: number, sql: string, msg: string) {
    const model = this.editor?.getModel();
    if (!model || !this.monaco) return;
    const s = model.getPositionAt(offset);
    const e = model.getPositionAt(offset + sql.length);
    this.monaco.editor.setModelMarkers(model, 'run', [
      { severity: this.monaco.MarkerSeverity.Error, message: msg, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column },
    ]);
  }

  private clearMarkers() {
    const model = this.editor?.getModel();
    if (model && this.monaco) this.monaco.editor.setModelMarkers(model, 'run', []);
  }

  protected lineOf(offset: number): number {
    if (offset < 0) return 0;
    return this.editor?.getModel()?.getPositionAt(offset).lineNumber ?? 0;
  }

  /** Reitername: Elasticsearch benennt seine Ergebnisse (Treffer, Aggregation …, JSON) */
  protected resultLabel(set: { label?: string }, i: number): string {
    return set.label ?? `Ergebnis ${i + 1}`;
  }

  protected exportResult() {
    const set = this.results()[this.resultIndex()];
    if (!set || set.text !== undefined) return;
    const n = this.results().length;
    // vollständig: die Anweisung, aus der das Ergebnis stammt, läuft noch einmal (das wievielte Ergebnis von ihr?)
    const st = this.run()?.statements.find((s) => s.statementIndex === set.statementIndex);
    const nth = this.results().slice(0, this.resultIndex()).filter((x) => x.statementIndex === set.statementIndex).length;
    const sessionId = this.sessionId();
    const blocker = st ? rerunBlocker(st.sql, this.dialect()) : 'Die Anweisung zu diesem Ergebnis ist nicht mehr bekannt.';
    this.exporter.open({
      kind: 'rows',
      columns: set.columns,
      rows: set.rows,
      // Abfrage-Ergebnisse haben keine leeren (neuen) Zellen
      selected: (this.grid()?.selectedRows() ?? []) as Cell[][],
      truncated: set.truncated,
      totalRows: set.totalRows,
      binaryCut: set.binaryCut,
      rerun: st && sessionId && !blocker ? { sessionId, statement: { sql: st.sql, offset: 0 }, resultIndex: nth } : undefined,
      rerunBlocker: blocker ?? undefined,
      baseName: `abfrage-${this.tab().number}` + (n > 1 ? `-ergebnis-${this.resultIndex() + 1}` : ''),
      dialect: this.dialect(),
      sqlTable: 'ergebnis',
    });
  }

  protected selectResult(i: number) {
    this.resultIndex.set(i);
    this.pane.set('result');
  }

  protected closePlan(ev: Event) {
    ev.stopPropagation();
    this.plan.set(null);
    if (this.pane() === 'plan') this.pane.set('result');
  }

  protected fmtNum(n: number) {
    return fmt.format(n);
  }

  protected setMaxRows(v: string) {
    this.maxRows.set(Number(v));
  }

  protected startDrag(ev: MouseEvent) {
    ev.preventDefault();
    const host = (ev.target as HTMLElement).parentElement!;
    const rect = host.getBoundingClientRect();
    const move = (e: MouseEvent) => {
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      this.editorPct.set(Math.min(85, Math.max(12, pct)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
