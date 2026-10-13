import { computed, effect, Injectable, signal, untracked } from '@angular/core';
import type { CompareSide, DataCompareSide, Dialect, ObjectRef, SavedConnection, ServerInfo } from '../../../../shared/api-types';
import { api, message } from './api';

export interface TableTab {
  kind: 'table';
  id: string;
  ref: ObjectRef;
  /** WHERE beim Öffnen (z. B. beim Folgen eines Fremdschlüssels) */
  where?: string;
  /** Kurzform des Filters für den Tab-Titel, z. B. "kunde_id = 1" */
  label?: string;
}

export interface QueryTab {
  kind: 'query';
  id: string;
  connectionId: string;
  database?: string;
  /** Text beim Öffnen */
  initialSql: string;
  number: number;
}

/** Schema-Vergleich zweier Datenbanken/Schemas */
export interface CompareTab {
  kind: 'compare';
  id: string;
  source: CompareSide;
  number: number;
}

/** laufende Abfragen und Sitzungen des Servers einer Verbindung */
export interface SessionsTab {
  kind: 'sessions';
  id: string;
  connectionId: string;
}

/** ER-Diagramm eines Schemas (MySQL: der Datenbank), wahlweise nur die Nachbarschaft einer Tabelle */
export interface ErTab {
  kind: 'er';
  id: string;
  connectionId: string;
  database: string;
  schema: string;
  /** nur Tabellen, die von hier aus über Fremdschlüssel erreichbar sind */
  focus?: string;
  /** so viele Schritte ab focus, 0 = alle verbundenen */
  depth?: number;
}

/** Datenvergleich zweier Tabellen bzw. aller Tabellen eines Schemas; source = wovon aus geöffnet wurde */
export interface DataCompareTab {
  kind: 'datacompare';
  id: string;
  source: DataCompareSide;
  number: number;
  /** ganzes Schema statt einer Tabelle */
  all?: boolean;
  /** Ziel schon bekannt (aus dem Schema-Vergleich) */
  target?: DataCompareSide;
}

export type Tab = TableTab | QueryTab | CompareTab | SessionsTab | ErTab | DataCompareTab;

/** Verbindung, zu der ein Tab gehört (Vergleich: die Quelle) */
export function tabConnection(t: Tab): string {
  switch (t.kind) {
    case 'table':
      return t.ref.connectionId;
    case 'compare':
    case 'datacompare':
      return t.source.connectionId;
    default:
      return t.connectionId;
  }
}

/** Datenbank des Tabs (für neue Abfragen „hier“) */
export function tabDatabase(t: Tab): string | undefined {
  switch (t.kind) {
    case 'table':
      return t.ref.database;
    case 'query':
      return t.database;
    case 'compare':
    case 'datacompare':
      return t.source.database;
    case 'er':
      return t.database;
    default:
      return undefined;
  }
}

export type ConnStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; info: ServerInfo }
  /** lost: die Verbindung bestand und ist unterbrochen (Server neu gestartet, Netz weg) – Verbinden baut den Treiber neu auf */
  | { state: 'error'; error: string; lost?: boolean };

/** Fehlertexte der Treiber, wenn die Verbindung selbst weg ist (nicht: Syntax, Rechte, fehlende Tabelle) */
const CONNECTION_LOST =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|PROTOCOL_CONNECTION_LOST|connection lost|connection is closed|closed state|connection terminated|terminating connection|not queryable|socket hang up|could not connect|server has gone away|lost connection|Final state|Verbindung (zum Server )?(unterbrochen|getrennt|verloren)/i;

const QUERY_STORE = 'dbv.queryTabs';

/** gesicherter Abfrage-Tab (number und active seit 08.10.2026; ältere Einträge haben sie nicht) */
interface StoredQueryTab {
  connectionId: string;
  database?: string;
  sql: string;
  number?: number;
  active?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AppState {
  readonly connections = signal<SavedConnection[]>([]);
  /** Verbindungen für Kopieren, Vergleich usw. – Elasticsearch liest OwlynDB nur */
  readonly sqlConnections = computed(() => this.connections().filter((c) => c.dialect !== 'elasticsearch'));
  readonly status = signal<Record<string, ConnStatus>>({});
  readonly tabs = signal<Tab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? null);
  /** Verbindung, die im Baum zuletzt angeklickt wurde (für "Neue Abfrage") */
  readonly currentConnection = signal<string | null>(null);
  /** Dialog zum Anlegen/Bearbeiten: null = zu, '' = neu, sonst id */
  readonly editing = signal<string | null>(null);

  constructor() {
    // gelöschte Verbindung (Baum, Einstellungs-Import): nicht mehr für Strg+T und die Objektsuche, Status weg
    effect(() => {
      const ids = new Set(this.connections().map((c) => c.id));
      untracked(() => {
        const cur = this.currentConnection();
        if (cur && !ids.has(cur)) this.currentConnection.set(null);
        const st = this.status();
        if (Object.keys(st).some((id) => !ids.has(id))) this.status.set(Object.fromEntries(Object.entries(st).filter(([id]) => ids.has(id))));
      });
    });
  }

  private queryCounter = 0;
  private compareCounter = 0;
  private dataCompareCounter = 0;
  /** Vergleichs-Tabs: auch die Zielverbindung zählt (Schließen beim Trennen) */
  private compareTargets = new Map<string, string>();

  setCompareTarget(tabId: string, connectionId: string | null): void {
    if (connectionId) this.compareTargets.set(tabId, connectionId);
    else this.compareTargets.delete(tabId);
  }
  /** Abfrage-Tab -> Sitzung, für die Rückfrage beim Schließen */
  private tabSessions = new Map<string, string>();

  /** false = den Tab gibt es nicht mehr (während des Verbindens geschlossen) – dann die Sitzung gleich wieder schließen */
  registerSession(tabId: string, sessionId: string): boolean {
    if (!this.tabs().some((t) => t.id === tabId)) return false;
    this.tabSessions.set(tabId, sessionId);
    return true;
  }

  /** Abfrage-Tab zu einer Sitzung (für die Sitzungsliste des Servers) */
  tabOfSession(sessionId: string): QueryTab | undefined {
    for (const [tabId, sid] of this.tabSessions) {
      if (sid !== sessionId) continue;
      const t = this.tabs().find((x) => x.id === tabId);
      if (t?.kind === 'query') return t;
    }
    return undefined;
  }

  /** Tabellen-Tabs mit ungespeicherten Änderungen (Bearbeiten-Modus) */
  private dirty = new Set<string>();
  /** zuletzt dem Hauptprozess gemeldet (JSON der Namen) */
  private unsavedSent = '[]';

  setDirty(tabId: string, dirty: boolean): void {
    if (dirty) this.dirty.add(tabId);
    else this.dirty.delete(tabId);
    this.reportUnsaved();
  }

  /** Hauptprozess: Beenden (Fensterkreuz, Alt+F4, Datei > Beenden) und Neu laden fragen bei ungespeicherten Änderungen nach */
  private reportUnsaved(): void {
    const names = this.tabs().flatMap((t) => (t.kind === 'table' && this.dirty.has(t.id) ? [t.ref.name] : []));
    const key = JSON.stringify(names);
    if (key === this.unsavedSent) return;
    this.unsavedSent = key;
    void api.setUnsavedTables(names).catch(() => undefined);
  }

  /**
   * Tabs schließen – mit Rückfrage, wenn darin eine Abfrage läuft oder eine Transaktion offen ist
   * (Schließen rollt die Transaktion zurück). Laufende Abfragen werden vorher abgebrochen.
   * textLost: auch Abfrage-Tabs mit Text nennen (Trennen/Löschen der Verbindung – sonst wären die Entwürfe still weg)
   */
  async requestClose(ids: string[], opts: { textLost?: boolean } = {}): Promise<boolean> {
    const busy: string[] = [];
    const tx: string[] = [];
    const unsaved: string[] = [];
    const texts: string[] = [];
    for (const id of ids) {
      const t = this.tabs().find((x) => x.id === id);
      if (t?.kind === 'table' && this.dirty.has(id)) unsaved.push(t.ref.name);
      if (opts.textLost && t?.kind === 'query' && (this.queryText.get(id) ?? t.initialSql).trim()) texts.push(`Abfrage ${t.number}`);
      const sid = this.tabSessions.get(id);
      if (!t || t.kind !== 'query' || !sid) continue;
      const st = await api.sessionState(sid).catch(() => ({ busy: false, inTransaction: false }));
      if (st.busy) busy.push(`Abfrage ${t.number}`);
      else if (st.inTransaction) tx.push(`Abfrage ${t.number}`);
    }
    if (busy.length || tx.length || unsaved.length || texts.length) {
      const lines = [
        ...(texts.length ? [`Abfrage-Tabs mit Text: ${texts.join(', ')} – der Text geht verloren (auch beim nächsten Start).`] : []),
        ...(unsaved.length ? [`Ungespeicherte Änderungen: ${unsaved.join(', ')} – gehen verloren.`] : []),
        ...(busy.length ? [`Läuft gerade: ${busy.join(', ')} – wird abgebrochen.`] : []),
        ...(tx.length ? [`Offene Transaktion: ${tx.join(', ')} – nicht festgeschriebene Änderungen werden zurückgerollt.`] : []),
      ];
      if (!confirm(`Trotzdem schließen?\n\n${lines.join('\n')}`)) return false;
      // alle zugleich abbrechen, höchstens 3 s warten (bei weggebrochenem Netz hinge jeder Abbruch bis zu 10 s) – schließen
      // wird danach in jedem Fall; die Sitzung selbst schließt der Tab beim Zerstören
      const cancels = ids.flatMap((id) => {
        const sid = this.tabSessions.get(id);
        return sid ? [api.cancelQuery(sid).catch(() => undefined)] : [];
      });
      await Promise.race([Promise.all(cancels), new Promise((r) => setTimeout(r, 3000))]);
    }
    for (const id of ids) this.closeTab(id);
    return true;
  }
  /** letzter Editor-Text je Abfrage-Tab, wird beim Beenden gesichert */
  private queryText = new Map<string, string>();

  async load(): Promise<void> {
    try {
      this.connections.set(await api.listConnections());
    } finally {
      // auch wenn die Liste nicht lesbar war: die gesicherten Tabs bleiben dann im Speicher (geparkt) statt überschrieben
      this.restoreQueryTabs();
    }
  }

  /** Verbindungsliste neu laden (nach dem Import von Einstellungen); geparkte Tabs wiederkehrender Verbindungen öffnen */
  async reloadConnections(): Promise<void> {
    this.connections.set(await api.listConnections());
    this.openParked();
  }

  connection(id: string): SavedConnection | undefined {
    return this.connections().find((c) => c.id === id);
  }

  dialect(id: string): Dialect {
    return this.connection(id)?.dialect ?? 'mysql';
  }

  /** laufende Verbindungsaufbauten: weitere Aufrufer warten auf denselben, statt einen zweiten zu starten */
  private connecting = new Map<string, Promise<ServerInfo>>();

  ensureConnected(id: string): Promise<ServerInfo> {
    const s = this.status()[id];
    if (s?.state === 'connected') return Promise.resolve(s.info);
    const running = this.connecting.get(id);
    if (running) return running;
    // unterbrochen: Treiber neu aufbauen – der alte (toter Pool) scheiterte sonst beim ersten Versuch noch einmal
    const lost = s?.state === 'error' && !!s.lost;
    this.setStatus(id, { state: 'connecting' });
    const p = (async () => {
      try {
        const info = await (lost ? api.reconnect(id) : api.connect(id));
        this.setStatus(id, { state: 'connected', info });
        return info;
      } catch (e) {
        this.setStatus(id, { state: 'error', error: message(e) });
        throw e;
      } finally {
        this.connecting.delete(id);
      }
    })();
    this.connecting.set(id, p);
    return p;
  }

  /** Neu verbinden, ohne Tabs zu schließen (Baum: „Neu verbinden“) */
  reconnect(id: string): Promise<ServerInfo> {
    const running = this.connecting.get(id);
    if (running) return running;
    this.setStatus(id, { state: 'connecting' });
    const p = (async () => {
      try {
        const info = await api.reconnect(id);
        this.setStatus(id, { state: 'connected', info });
        return info;
      } catch (e) {
        this.setStatus(id, { state: 'error', error: message(e), lost: true });
        throw e;
      } finally {
        this.connecting.delete(id);
      }
    })();
    this.connecting.set(id, p);
    return p;
  }

  /**
   * Fehler eines Aufrufs auf einer Verbindung (Baum, Tabelle, Suche, Sitzungen): ist die Verbindung selbst weg, steht sie
   * danach nicht mehr als verbunden da – der Baum bietet „Verbinden“ an, und der nächste Zugriff baut neu auf
   */
  noteError(connectionId: string, e: unknown): void {
    const text = message(e);
    if (this.status()[connectionId]?.state === 'connected' && CONNECTION_LOST.test(text)) this.setStatus(connectionId, { state: 'error', error: text, lost: true });
  }

  async disconnect(id: string): Promise<void> {
    await api.disconnect(id);
    this.setStatus(id, { state: 'idle' });
  }

  /** Zugangsdaten ersetzt (Bearbeiten, Import): Status zurück auf „nicht verbunden“, der Baum lädt beim Aufklappen neu */
  resetConnection(id: string): void {
    this.setStatus(id, { state: 'idle' });
  }

  private setStatus(id: string, s: ConnStatus) {
    this.status.update((m) => ({ ...m, [id]: s }));
  }

  /** ohne where: vorhandenen Tab der Tabelle wiederverwenden; mit where: eigener Tab je Filter */
  openTable(ref: ObjectRef, where?: string, label?: string): void {
    const same = (t: Tab): t is TableTab =>
      t.kind === 'table' && t.ref.connectionId === ref.connectionId && t.ref.database === ref.database && t.ref.schema === ref.schema && t.ref.name === ref.name;
    const list = this.tabs().filter(same);
    const existing = where ? list.find((t) => t.where === where) : (list.find((t) => !t.where) ?? list[0]);
    if (existing) {
      this.activeId.set(existing.id);
      return;
    }
    const tab: TableTab = { kind: 'table', id: crypto.randomUUID(), ref, ...(where ? { where, label } : {}) };
    this.insertTab(tab);
  }

  openCompare(source: CompareSide): void {
    const tab: CompareTab = { kind: 'compare', id: crypto.randomUUID(), source, number: ++this.compareCounter };
    this.insertTab(tab);
  }

  openDataCompare(source: DataCompareSide, opts: { all?: boolean; target?: DataCompareSide } = {}): void {
    this.insertTab({ kind: 'datacompare', id: crypto.randomUUID(), source, number: ++this.dataCompareCounter, ...opts });
  }

  /** je Verbindung ein Sitzungs-Tab (vorhandenen wiederverwenden) */
  openSessions(connectionId: string): void {
    const existing = this.tabs().find((t) => t.kind === 'sessions' && t.connectionId === connectionId);
    if (existing) {
      this.activeId.set(existing.id);
      return;
    }
    this.insertTab({ kind: 'sessions', id: crypto.randomUUID(), connectionId });
  }

  /** je Schema ein ER-Tab (vorhandenen wiederverwenden, dabei focus übernehmen) */
  openEr(connectionId: string, database: string, schema: string, focus?: string): void {
    const existing = this.tabs().find(
      (t): t is ErTab => t.kind === 'er' && t.connectionId === connectionId && t.database === database && t.schema === schema,
    );
    if (existing) {
      this.updateEr(existing.id, { focus, depth: focus ? 1 : existing.depth });
      this.activeId.set(existing.id);
      return;
    }
    this.insertTab({ kind: 'er', id: crypto.randomUUID(), connectionId, database, schema, focus, depth: 1 });
  }

  updateEr(tabId: string, patch: Partial<Pick<ErTab, 'schema' | 'focus' | 'depth'>>): void {
    this.tabs.update((l) => l.map((t) => (t.id === tabId && t.kind === 'er' ? { ...t, ...patch } : t)));
  }

  openQuery(connectionId: string, database?: string, sql = '', number?: number): QueryTab {
    if (number !== undefined) this.queryCounter = Math.max(this.queryCounter, number);
    const tab: QueryTab = { kind: 'query', id: crypto.randomUUID(), connectionId, database, initialSql: sql, number: number ?? ++this.queryCounter };
    this.insertTab(tab);
    return tab;
  }

  /** neben dem aktiven Tab einfügen */
  private insertTab(tab: Tab) {
    this.tabs.update((list) => {
      const i = list.findIndex((t) => t.id === this.activeId());
      const copy = [...list];
      copy.splice(i < 0 ? copy.length : i + 1, 0, tab);
      return copy;
    });
    this.activeId.set(tab.id);
    this.saveQueryTabs();
  }

  closeTab(id: string): void {
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const next = list.filter((t) => t.id !== id);
    this.tabs.set(next);
    this.queryText.delete(id);
    this.dirty.delete(id);
    this.reportUnsaved();
    this.compareTargets.delete(id);
    this.tabSessions.delete(id);
    if (this.activeId() === id) this.activeId.set(next[Math.min(i, next.length - 1)]?.id ?? null);
    this.saveQueryTabs();
  }

  closeTabsOf(connectionId: string): Promise<boolean> {
    const ids = this.tabs()
      .filter((t) => tabConnection(t) === connectionId || this.compareTargets.get(t.id) === connectionId)
      .map((t) => t.id);
    return this.requestClose(ids, { textLost: true });
  }

  setQueryText(tabId: string, text: string, database?: string): void {
    this.queryText.set(tabId, text);
    if (database !== undefined) {
      this.tabs.update((l) => l.map((t) => (t.id === tabId && t.kind === 'query' ? { ...t, database } : t)));
    }
    this.saveQueryTabsSoon();
  }

  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveQueryTabsSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveQueryTabs(), 500);
  }

  /** gesicherte Tabs, deren Verbindung es (gerade) nicht gibt: bleiben im Speicher, bis sie wiederkommt */
  private parked: StoredQueryTab[] = [];
  /** erst nach dem Wiederherstellen speichern – sonst überschriebe ein früher Aufruf den Speicher mit einem leeren Stand */
  private restored = false;

  /** Abfrage-Tabs samt Text, Nummer und dem aktiven Tab überleben einen Neustart */
  saveQueryTabs(): void {
    if (!this.restored) return;
    const open: StoredQueryTab[] = this.tabs()
      .filter((t): t is QueryTab => t.kind === 'query')
      .map((t) => ({ connectionId: t.connectionId, database: t.database, sql: this.queryText.get(t.id) ?? t.initialSql, number: t.number, active: t.id === this.activeId() }));
    try {
      localStorage.setItem(QUERY_STORE, JSON.stringify([...open, ...this.parked.map((p) => ({ ...p, active: false }))]));
    } catch {
      // nur Komfort
    }
  }

  private restoreQueryTabs() {
    let data: StoredQueryTab[] = [];
    try {
      const v: unknown = JSON.parse(localStorage.getItem(QUERY_STORE) ?? '[]');
      data = Array.isArray(v) ? v.filter((d): d is StoredQueryTab => !!d && typeof d.connectionId === 'string' && typeof d.sql === 'string') : [];
    } catch {
      data = [];
    }
    this.parked = data;
    // neue Tabs nicht unter der Nummer eines geparkten (der käme später doppelt)
    this.queryCounter = Math.max(0, ...data.map((d) => (typeof d.number === 'number' ? d.number : 0)));
    this.openParked();
    this.restored = true;
    this.saveQueryTabs();
  }

  /** geparkte Tabs öffnen, deren Verbindung es jetzt gibt; der zuletzt aktive wird wieder aktiv (verbindet sich als erster) */
  private openParked() {
    const ready = this.parked.filter((d) => this.connection(d.connectionId));
    if (!ready.length) return;
    this.parked = this.parked.filter((d) => !ready.includes(d));
    let active: string | undefined;
    for (const d of ready) {
      const tab = this.openQuery(d.connectionId, d.database, d.sql, typeof d.number === 'number' ? d.number : undefined);
      if (d.active) active = tab.id;
    }
    if (active) this.activeId.set(active);
    this.saveQueryTabs();
  }
}
