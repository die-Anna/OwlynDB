import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  ApplyChangesRequest,
  ApplyChangesResult,
  Cell,
  CompareRequest,
  CompareResult,
  ConnectionInput,
  CopyRequest,
  DataCompareAllRequest,
  DataCompareAllResult,
  DataCompareRequest,
  DataCompareResult,
  DataCompareScriptRequest,
  DbvApi,
  Dialect,
  DumpRequest,
  ExportFormat,
  ExportOptions,
  ExportResult,
  HistoryQuery,
  ImportRequest,
  JobStatus,
  ObjectRef,
  QueryRun,
  ResultColumn,
  RoutineRef,
  SavedConnection,
  SearchHit,
  SearchResult,
  ServerSessionList,
  SettingsExportOptions,
  SettingsImportRequest,
  SettingsImportResult,
  TableDataRequest,
  ThemeMode,
} from '../shared/api-types';
import { rerunBlocker } from '../shared/sql-guard';
import { quoteIdent } from '../shared/sql-util';
import type { ConnectionStore } from './connection-store';
import { createDriver, DriverConfig, MetaDriver, Session } from './drivers';
import { ABORTED, errorText, escapeLike, withTimeout, type CancelCheck, type RowSink } from './drivers/common';
import { SshForward } from './drivers/ssh';
import { compareSchemas } from './compare';
import { compareData, compareSchemaData, tablePairs, writeDataScript, type DataCompareProgress, type ScriptTable } from './data-compare';
import {
  exportSettings as exportSettingsFile,
  importSettings as importSettingsFile,
  previewSettings as previewSettingsFile,
} from './settings-transfer';
import { writeDump, type DumpProgress } from './dump';
import { buildWrites } from './edit';
import { editorScript } from './routines';
import { createWriter, partFile, replaceWith, type ExportWriter } from './export';
import { QueryHistory, SavedQueries } from './history';
import { inspectFile, runImport, skippedSummary, type ImportProgress } from './import';

/** Betriebssystem-Dialoge; kommen aus main.ts, damit der Manager ohne Electron testbar bleibt */
export interface Host {
  pickFile: DbvApi['pickFile'];
  /** Speichern-Dialog; null = abgebrochen */
  saveFile(baseName: string, format: ExportFormat | 'svg'): Promise<string | null>;
  showInFolder(file: string): void;
  /** Darstellung für Titelleiste und native Dialoge übernehmen */
  setTheme?(mode: ThemeMode): boolean;
  /** unbekannten (previous leer) oder geänderten SSH-Hostschlüssel bestätigen lassen */
  confirmHostKey?(hostId: string, keyType: string, fingerprint: string, previous?: string): Promise<boolean>;
}

const noHost: Host = { pickFile: async () => null, saveFile: async () => null, showInFolder: () => undefined };

/** Text beginnt bewusst mit "Die Verbindung war unterbrochen" – daran erkennt die Oberfläche den Hinweis */
const RECONNECTED =
  'Die Verbindung war unterbrochen (z. B. Leerlauf-Timeout eines Proxys) und wurde neu aufgebaut. ' +
  'Es wurde NICHTS ausgeführt. Eine offene Transaktion hat der Server dabei zurückgerollt; temporäre Tabellen und ' +
  'Sitzungseinstellungen sind verloren. Bitte prüfen und dann erneut ausführen.';
const LOST_DURING_RUN =
  'Die Verbindung wurde während der Ausführung getrennt. Folgende Anweisungen wurden nicht ausgeführt, eine offene ' +
  'Transaktion hat der Server zurückgerollt. Beim nächsten Ausführen wird zuerst nur neu verbunden.';

/** Hält offene Verbindungen und Abfrage-Sitzungen; implementiert die API für das Fenster. */
export class Manager implements DbvApi {
  private drivers = new Map<string, MetaDriver>();
  private sessions = new Map<string, { connectionId: string; session: Session }>();
  /** laufende Objektsuchen nach dem Kennzeichen der Oberfläche */
  private searches = new Map<string, { cancelled: boolean }>();
  /** SSH-Tunnel je Verbindung; der letzte ist der aktuelle, ältere tragen noch Sitzungen mit alten Einstellungen */
  private forwards = new Map<string, { key: string; fwd: SshForward }[]>();
  /** Dumps, Importe, Kopien und Vergleiche im Hintergrund; die Oberfläche fragt den Stand ab */
  private jobs = new Map<string, { status: () => JobStatus; cancel: () => void; running: () => boolean; done: Promise<void>; connections: string[] }>();
  /** Ergebnisse der Datenvergleiche je Auftrag */
  private dataResults = new Map<string, { result?: DataCompareResult }>();
  private dataAllResults = new Map<string, { result?: DataCompareAllResult }>();
  private history: QueryHistory;
  private saved: SavedQueries;

  constructor(
    private store: ConnectionStore,
    private host: Host = noHost,
    /** Abstand der Lebenszeichen an offene Verbindungen in ms; 0 = aus */
    keepAliveMs = 20_000,
  ) {
    this.history = new QueryHistory(path.join(store.dir, 'history.jsonl'));
    this.saved = new SavedQueries(path.join(store.dir, 'saved-queries.json'));
    if (keepAliveMs > 0) {
      this.keepAliveTimer = setInterval(() => void this.keepAlive(), keepAliveMs);
      // hält den Prozess nicht am Leben (Tests, Beenden)
      this.keepAliveTimer.unref();
    }
  }

  private keepAliveTimer?: NodeJS.Timeout;
  /** Sitzungen, deren Lebenszeichen noch läuft – je Sitzung: ein hängender Ping hält die übrigen nicht auf */
  private pinging = new Set<Session>();

  /** offene Abfrage-Sitzungen anpingen, damit ein Proxy sie im Leerlauf nicht schließt */
  private keepAlive() {
    for (const { session } of this.sessions.values()) {
      if (this.pinging.has(session)) continue;
      this.pinging.add(session);
      void session
        .ping()
        .catch(() => undefined)
        .finally(() => this.pinging.delete(session));
    }
  }

  pickFile: DbvApi['pickFile'] = (kind, current) => this.host.pickFile(kind, current);

  showInFolder = async (file: string) => this.host.showInFolder(file);
  setTheme = async (mode: ThemeMode) => this.host.setTheme?.(mode) ?? false;

  /** ER-Diagramm als SVG-Datei: Speichern-Dialog, dann schreiben; null = abgebrochen */
  saveSvg = async (baseName: string, svg: string): Promise<string | null> => {
    if (typeof svg !== 'string' || !svg.startsWith('<svg')) throw new Error('Kein SVG-Bild');
    const file = await this.host.saveFile(baseName, 'svg');
    if (!file) return null;
    await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`, 'utf8');
    return file;
  };

  /**
   * Datei wählen und schreiben – in eine Nachbardatei, die erst am Ende die gewählte ersetzt. Bei Fehler oder Abbruch
   * verschwindet nur die Nachbardatei; eine vorhandene Datei gleichen Namens bleibt, wie sie war.
   */
  private async export(opts: ExportOptions, fill: (w: ExportWriter) => Promise<void>): Promise<ExportResult | null> {
    const file = await this.host.saveFile(opts.baseName, opts.format);
    if (!file) return null;
    const t0 = performance.now();
    const w = createWriter(file, opts);
    try {
      await fill(w);
      await w.end();
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    const notes = w.notes();
    return { file, rows: w.count, durationMs: Math.round(performance.now() - t0), ...(notes.length ? { notes } : {}) };
  }

  /** laufende Tabellen-Exporte, abbrechbar über das Kennzeichen aus den Optionen (cancelExport) */
  private exportCancels = new Map<string, AbortController>();
  /** laufende Tabellen-Exporte (auch ohne Kennzeichen): ein abgelöster Treiber schließt erst nach ihrem Ende */
  private exportRuns = new Set<Promise<unknown>>();

  exportRows = (columns: ResultColumn[], rows: Cell[][], opts: ExportOptions) =>
    this.export(opts, async (w) => {
      await w.begin(columns);
      for (let i = 0; i < rows.length; i += 2000) await w.rows(rows.slice(i, i + 2000));
    });

  /** ganze Tabelle streamen; mit opts.cancelToken lässt sich das per cancelExport abbrechen (auch eine lange Sortierung am Server) */
  exportTable = async (req: TableDataRequest, opts: ExportOptions) => {
    // vor dem ersten await anmelden: ein Abbruch gleich nach dem Start geht so nicht verloren
    const ac = new AbortController();
    const token = opts.cancelToken;
    if (token) this.exportCancels.set(token, ac);
    const run = (async () => {
      const d = await this.driver(req.object.connectionId);
      return await this.export(opts, (w) => d.streamTable(req, abortable(w, ac.signal), ac.signal));
    })();
    this.exportRuns.add(run);
    try {
      return await run;
    } finally {
      this.exportRuns.delete(run);
      if (token) this.exportCancels.delete(token);
    }
  };

  cancelExport = async (token: string) => {
    this.exportCancels.get(token)?.abort();
  };

  /**
   * Abfrage-Ergebnis vollständig: die Anweisung läuft im Tab noch einmal – deshalb nur, wenn sie nur liest (ein
   * INSERT oder eine Prozedur liefe sonst ein zweites Mal). Steht als „Export“ im Verlauf.
   */
  exportQuery: DbvApi['exportQuery'] = async (sessionId, statement, resultIndex, opts) => {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Sitzung ist nicht mehr offen. Bitte den Tab neu verbinden.');
    const c = await this.store.get(entry.connectionId);
    const why = rerunBlocker(statement.sql, c.dialect);
    if (why) throw new Error(why);
    const s = entry.session;
    if (!(await s.check())) throw new Error('Die Verbindung dieses Tabs war unterbrochen – bitte die Abfrage neu ausführen und dann exportieren.');
    let t0 = 0;
    let error: string | undefined;
    try {
      return await this.export(opts, (w) => {
        t0 = performance.now();
        return s.streamResult(statement, Math.max(0, Math.floor(Number(resultIndex) || 0)), w);
      });
    } catch (e) {
      error = errorText(e);
      throw e;
    } finally {
      // nur, wenn wirklich ausgeführt wurde (nicht beim Abbrechen des Speichern-Dialogs)
      if (t0) {
        await this.history
          .add([{ at: new Date().toISOString(), connectionId: entry.connectionId, connection: c.name, database: s.database, sql: statement.sql, durationMs: Math.round(performance.now() - t0), ok: !error, error, info: 'Export aller Zeilen' }])
          .catch(() => undefined);
      }
    }
  };

  /** Treiber im Aufbau: gleichzeitige erste Aufrufe teilen sich einen (sonst zwei Pools bzw. SSH-Tunnel, einer verwaist) */
  private driverStarts = new Map<string, Promise<MetaDriver>>();

  private async driver(connectionId: string): Promise<MetaDriver> {
    const d = this.drivers.get(connectionId);
    if (d) return d;
    let p = this.driverStarts.get(connectionId);
    if (!p) {
      const gen = this.driverGen.get(connectionId) ?? 0;
      p = (async () => {
        const c = await this.store.get(connectionId);
        const nd = await this.openDriver(c.dialect, await this.store.driverConfig(connectionId), connectionId);
        if ((this.driverGen.get(connectionId) ?? 0) === gen) this.drivers.set(connectionId, nd);
        // Zugangsdaten inzwischen geändert: der Aufrufer bekommt ihn noch, danach wird er geschlossen
        else this.closeWhenIdle(nd);
        return nd;
      })();
      const started = p;
      this.driverStarts.set(connectionId, started);
      void started
        .catch(() => undefined)
        .finally(() => {
          if (this.driverStarts.get(connectionId) === started) this.driverStarts.delete(connectionId);
        });
    }
    return p;
  }

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('Sitzung ist nicht mehr offen. Bitte den Tab neu verbinden.');
    return s.session;
  }

  listConnections = () => this.store.list();

  saveConnection = async (input: ConnectionInput) => {
    // nur geänderte Zugangsdaten brauchen eine neue Verbindung – Name oder Farbe nicht (ein laufender Dump liefe sonst in
    // einen geschlossenen Pool)
    const before = input.id ? await this.configKey(input.id) : undefined;
    const saved = await this.store.save(input);
    this.applyReadOnly(saved.id, !!saved.options?.readOnly);
    if (before === undefined || before !== (await this.configKey(saved.id))) this.retireDriver(saved.id);
    return saved;
  };

  /** Kopie einer gespeicherten Verbindung mit allen Einstellungen und Passwörtern; baut keine Verbindung auf */
  duplicateConnection = (id: string) => this.store.duplicate(id);

  /** Zugangsdaten als Vergleichswert; nicht lesbar (z. B. Zertifikatsdatei fehlt) = jedes Mal anders */
  private async configKey(id: string): Promise<string> {
    try {
      return JSON.stringify(await this.store.driverConfig(id));
    } catch {
      return `nicht lesbar ${randomUUID()}`;
    }
  }

  /** „Nur lesen“ gilt sofort auch in offenen Abfrage-Tabs (die übrigen Einstellungen erst nach neuem Verbinden) */
  private applyReadOnly(connectionId: string, readOnly: boolean): void {
    for (const s of this.sessions.values()) if (s.connectionId === connectionId) s.session.readOnly = readOnly;
  }

  /** steigt, wenn die Zugangsdaten sich ändern: ein Aufbau mit den alten Daten kommt danach nicht mehr in den Bestand */
  private driverGen = new Map<string, number>();

  /**
   * Zugangsdaten geändert: neue Aufrufe bauen eine neue Verbindung auf. Die alte schließt erst, wenn die gerade
   * laufenden Aufträge und Exporte fertig sind – sie holen sich je Tabelle Verbindungen aus ihrem Pool.
   */
  private retireDriver(connectionId: string): void {
    this.driverGen.set(connectionId, (this.driverGen.get(connectionId) ?? 0) + 1);
    this.driverStarts.delete(connectionId);
    const d = this.drivers.get(connectionId);
    this.drivers.delete(connectionId);
    if (d) this.closeWhenIdle(d);
  }

  private closeWhenIdle(d: MetaDriver): void {
    const busy = [...this.jobs.values()].filter((j) => j.running()).map((j) => j.done);
    void Promise.allSettled([...busy, ...this.exportRuns]).then(() => d.close().catch(() => undefined));
  }

  /** laufende Aufträge auf dieser Verbindung abbrechen und kurz auf ihr Aufräumen warten (vor dem Schließen des Treibers) */
  private async cancelJobsOf(connectionId: string): Promise<void> {
    const own = [...this.jobs.values()].filter((j) => j.running() && j.connections.includes(connectionId));
    for (const j of own) j.cancel();
    await withTimeout(Promise.allSettled(own.map((j) => j.done)), 5000, 'Das Abbrechen der Aufträge').catch(() => undefined);
  }

  deleteConnection = async (id: string) => {
    await this.disconnect(id);
    await this.store.remove(id);
  };

  testConnection = async (input: ConnectionInput) => {
    const cfg = await this.store.driverConfig(input);
    const fwd = cfg.ssh ? await SshForward.open(cfg, this.checkHostKey) : undefined;
    const d = createDriver(input.dialect, fwd ? viaForward(cfg, fwd) : cfg);
    try {
      return await d.serverInfo();
    } catch (e) {
      throw fwd?.takeError() ?? e;
    } finally {
      await d.close().catch(() => undefined);
      await fwd?.close();
    }
  };

  /** Treiber anlegen; mit SSH über den Tunnel der Verbindung (gleiche Einstellungen: derselbe Tunnel) */
  private async openDriver(dialect: Dialect, cfg: DriverConfig, connectionId: string): Promise<MetaDriver> {
    if (!cfg.ssh) return createDriver(dialect, cfg);
    const key = JSON.stringify([cfg.host, cfg.port, cfg.ssh, cfg.tls]);
    const list = this.forwards.get(connectionId) ?? [];
    let cur = list.at(-1);
    if (!cur || cur.key !== key || cur.fwd.closed) {
      cur = { key, fwd: await SshForward.open(cfg, this.checkHostKey) };
      this.forwards.set(connectionId, [...list, cur]);
    }
    return createDriver(dialect, viaForward(cfg, cur.fwd));
  }

  /** wie known_hosts: erster Kontakt und geänderter Schlüssel nur mit Bestätigung */
  private checkHostKey = async (hostId: string, keyType: string, fp: string): Promise<boolean> => {
    const known = await this.store.hostKey(hostId);
    if (known === fp) return true;
    if (!(await this.host.confirmHostKey?.(hostId, keyType, fp, known))) return false;
    await this.store.setHostKey(hostId, fp);
    return true;
  };

  private async closeForwards(connectionId: string) {
    const list = this.forwards.get(connectionId) ?? [];
    this.forwards.delete(connectionId);
    for (const f of list) await f.fwd.close().catch(() => undefined);
  }

  connect = async (connectionId: string) => {
    const d = await this.driver(connectionId);
    try {
      return await d.serverInfo();
    } catch (e) {
      await this.closeDriver(connectionId);
      // über SSH: der eigentliche Grund (z. B. Ziel nicht erreichbar) steckt im Tunnel
      throw this.forwards.get(connectionId)?.at(-1)?.fwd.takeError() ?? e;
    }
  };

  /** Neu verbinden (Server neu gestartet, Netz weg gewesen): neuer Treiber statt des vielleicht toten; die Sitzungen der
   *  Abfrage-Tabs und laufende Aufträge bleiben (der alte Treiber schließt, sobald sie fertig sind) */
  reconnect = async (connectionId: string) => {
    this.retireDriver(connectionId);
    return this.connect(connectionId);
  };

  disconnect = async (connectionId: string) => {
    // Aufträge auf dieser Verbindung zuerst abbrechen – sonst wartete das Schließen ihres Pools bis zum Ende der Tabelle
    await this.cancelJobsOf(connectionId);
    // nebeneinander: jede Sitzung bricht ihre Abfrage ab und hat eine Frist – nacheinander summierte sich das
    const own = [...this.sessions].filter(([, s]) => s.connectionId === connectionId).map(([id]) => id);
    await Promise.all(own.map((id) => this.closeSession(id)));
    await this.closeDriver(connectionId);
    await this.closeForwards(connectionId);
  };

  private async closeDriver(connectionId: string) {
    // ein Aufbau läuft noch: erst fertig werden lassen, dann schließen (sonst bliebe sein Pool bzw. Tunnel offen)
    await this.driverStarts.get(connectionId)?.catch(() => undefined);
    const d = this.drivers.get(connectionId);
    this.drivers.delete(connectionId);
    await d?.close().catch(() => undefined);
  }

  listDatabases = async (connectionId: string) => (await this.driver(connectionId)).listDatabases();
  listSchemas = async (connectionId: string, database: string) => (await this.driver(connectionId)).listSchemas(database);
  listObjects = async (connectionId: string, database: string, schema: string) =>
    (await this.driver(connectionId)).listObjects(database, schema);
  listRoutines = async (connectionId: string, database: string, schema: string) => (await this.driver(connectionId)).listRoutines(database, schema);
  getRoutineDdl = async (ref: RoutineRef) => {
    const { connectionId, database, schema, ...r } = ref;
    const c = await this.store.get(connectionId);
    const ddl = await (await this.driver(connectionId)).routineDdl(database, schema, r);
    return editorScript(c.dialect, schema, r, ddl);
  };
  /**
   * Objektsuche über alle Datenbanken der Verbindung (MySQL in einer Abfrage, sonst Datenbank für Datenbank,
   * die Standard-Datenbank zuerst). Höchstens 300 Treffer und 50 Datenbanken.
   */
  searchObjects = async (connectionId: string, text: string, token?: string): Promise<SearchResult> => {
    const t = text.trim();
    if (t.length < 2) return { hits: [], truncated: false, skipped: [] };
    // veraltete Suche (weitergetippt, Dialog zu): zwischen den Datenbanken aufhören statt alle weiter abzufragen
    const run = { cancelled: false };
    if (token) this.searches.set(token, run);
    try {
      return await this.searchAll(connectionId, t, run);
    } finally {
      if (token) this.searches.delete(token);
    }
  };

  cancelSearch = async (token: string) => {
    const run = this.searches.get(token);
    if (run) run.cancelled = true;
  };

  private async searchAll(connectionId: string, t: string, run: { cancelled: boolean }): Promise<SearchResult> {
    const stop = () => {
      if (run.cancelled) throw new Error('Suche abgebrochen.');
    };
    const LIMIT = 300;
    const MAX_DBS = 50;
    const c = await this.store.get(connectionId);
    const d = await this.driver(connectionId);
    const pattern = '%' + escapeLike(t) + '%';
    if (c.dialect === 'mysql') {
      // Standard-Datenbank zuerst: ihre Treffer vorab, sonst füllten alphabetisch frühere Datenbanken die 300 Plätze
      const own = c.database ? await d.searchObjects(c.database, pattern, LIMIT + 1) : [];
      stop();
      const rest = own.length > LIMIT ? [] : (await d.searchObjects(null, pattern, LIMIT + 1 + own.length)).filter((h) => h.database !== c.database);
      const hits = [...own, ...rest];
      return { hits: hits.slice(0, LIMIT), truncated: hits.length > LIMIT, skipped: [] };
    }
    const system = c.dialect === 'mssql' ? ['master', 'model', 'msdb', 'tempdb'] : [];
    const dbs = (await d.listDatabases()).filter((x) => !system.includes(x));
    if (c.database && dbs.includes(c.database)) dbs.sort((a, b) => (a === c.database ? -1 : b === c.database ? 1 : 0));
    const hits: SearchHit[] = [];
    const skipped: string[] = [];
    for (const db of dbs.slice(0, MAX_DBS)) {
      if (hits.length > LIMIT) break;
      stop();
      try {
        hits.push(...(await d.searchObjects(db, pattern, LIMIT + 1 - hits.length)));
      } catch {
        skipped.push(db);
      }
    }
    if (dbs.length > MAX_DBS) skipped.push(`${dbs.length - MAX_DBS} weitere Datenbanken`);
    return { hits: hits.slice(0, LIMIT), truncated: hits.length > LIMIT, skipped };
  }
  /** Struktur vergleichen (gleicher Datenbanktyp); liefert Unterschiede samt Abgleich-Skript, führt nichts aus */
  compareSchemas = async (req: CompareRequest): Promise<CompareResult> => {
    const [cs, ct] = await Promise.all([this.store.get(req.source.connectionId), this.store.get(req.target.connectionId)]);
    sqlOnly([cs, ct], 'Den Schema-Vergleich');
    if (cs.dialect !== ct.dialect) throw new Error('Vergleichen lassen sich nur Datenbanken desselben Typs.');
    const [ds, dt] = await Promise.all([this.driver(req.source.connectionId), this.driver(req.target.connectionId)]);
    return compareSchemas(cs.dialect, { driver: ds, database: req.source.database, schema: req.source.schema }, { driver: dt, database: req.target.database, schema: req.target.schema });
  };
  describeTable = async (ref: ObjectRef) => (await this.driver(ref.connectionId)).describeTable(ref.database, ref.schema, ref.name);
  erModel = async (connectionId: string, database: string, schema: string) => (await this.driver(connectionId)).erModel(database, schema);
  getDdl = async (ref: ObjectRef) => (await this.driver(ref.connectionId)).getDdl(ref.database, ref.schema, ref.name, ref.kind);
  fetchTable = async (req: TableDataRequest) => (await this.driver(req.object.connectionId)).fetchTable(req);
  countTable = async (req: TableDataRequest) => (await this.driver(req.object.connectionId)).countTable(req);
  completionInfo = async (connectionId: string, database: string) => (await this.driver(connectionId)).completionInfo(database);

  openSession = async (connectionId: string, database?: string) => {
    const session = await (await this.driver(connectionId)).openSession(database);
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { connectionId, session });
    return { sessionId, database: session.database };
  };

  closeSession = async (sessionId: string) => {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    await s?.session.close().catch(() => undefined);
  };

  /** laufende Neuaufbauten je Sitzung: ein zweiter gleichzeitiger Aufruf wartet auf denselben */
  private reopening = new Map<string, Promise<Session>>();

  /** getrennte Sitzung unter derselben id neu aufbauen (Datenbank wie zuletzt) */
  private reopen(sessionId: string): Promise<Session> {
    let p = this.reopening.get(sessionId);
    if (!p) {
      p = this.reopenNow(sessionId).finally(() => this.reopening.delete(sessionId));
      this.reopening.set(sessionId, p);
    }
    return p;
  }

  private async reopenNow(sessionId: string): Promise<Session> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Sitzung ist nicht mehr offen. Bitte den Tab neu verbinden.');
    const old = entry.session;
    await old.close().catch(() => undefined);
    const fresh = await (await this.driver(entry.connectionId)).openSession(old.database);
    // Tab inzwischen geschlossen: die neue Verbindung nicht verwaisen lassen
    if (this.sessions.get(sessionId) !== entry) {
      await fresh.close().catch(() => undefined);
      throw new Error('Sitzung ist nicht mehr offen. Bitte den Tab neu verbinden.');
    }
    fresh.readOnly = old.readOnly;
    entry.session = fresh;
    return fresh;
  }

  setSessionDatabase = async (sessionId: string, database: string): Promise<string | null> => {
    let s = this.session(sessionId);
    let note: string | null = null;
    if (!(await s.check())) {
      s = await this.reopen(sessionId);
      note = RECONNECTED;
    }
    await s.setDatabase(database);
    return note;
  };

  /** Sitzungen des Servers; eigene Abfrage-Tabs dieser Verbindung werden zugeordnet */
  listServerSessions = async (connectionId: string): Promise<ServerSessionList> => {
    const c = await this.store.get(connectionId);
    const d = await this.driver(connectionId);
    const t0 = performance.now();
    const r = await d.listServerSessions();
    const own: Record<string, string> = {};
    const lastSql = new Map<string, string>();
    for (const [sid, s] of this.sessions) {
      if (s.connectionId !== connectionId || !s.session.serverId || s.session.broken) continue;
      own[s.session.serverId] = sid;
      if (s.session.lastSql) lastSql.set(s.session.serverId, s.session.lastSql);
    }
    // eigene Tabs: das SQL der Nutzerin statt OwlynDBs Prüfabfragen davor bzw. danach
    for (const x of r.sessions) x.query = lastSql.get(x.id) ?? x.query;
    return { ...r, own, readOnly: !!c.options?.readOnly, durationMs: Math.round(performance.now() - t0) };
  };

  /** Abfrage abbrechen bzw. Sitzung beenden; bei „Nur lesen“ gesperrt (nur Anzeige) */
  killServerSession: DbvApi['killServerSession'] = async (connectionId, target, mode) => {
    const c = await this.store.get(connectionId);
    if (c.options?.readOnly) throw new Error('Die Verbindung steht auf „Nur lesen“ – Sitzungen lassen sich hier nur ansehen.');
    if (!/^\d+$/.test(target.id)) throw new Error('Ungültige Sitzungs-ID.');
    const d = await this.driver(connectionId);
    await d.killServerSession(target.id, target.started, target.server, mode);
  };

  /** von der Oberfläche gemeldet: Tabellen mit ungespeicherten Änderungen (Bearbeiten-Modus) */
  private unsavedTables: string[] = [];

  setUnsavedTables = async (names: string[]) => {
    this.unsavedTables = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 50) : [];
  };

  /**
   * für die Rückfrage beim Beenden bzw. Neu laden (synchron: aus dem zuletzt bekannten Zustand); jobs = laufende Aufträge,
   * exports = laufende Tabellen-Exporte, unsaved = Tabellen mit ungespeicherten Änderungen
   */
  openWork(): { busy: number; inTransaction: number; jobs: number; exports: number; unsaved: string[] } {
    let busy = 0;
    let inTransaction = 0;
    for (const { session } of this.sessions.values()) {
      if (session.busy) busy++;
      else if (!session.broken && session.inTransaction) inTransaction++;
    }
    let jobs = 0;
    for (const j of this.jobs.values()) if (j.running()) jobs++;
    return { busy, inTransaction, jobs, exports: this.exportCancels.size, unsaved: this.unsavedTables };
  }

  sessionState = async (sessionId: string) => {
    const s = this.sessions.get(sessionId)?.session;
    return { busy: !!s?.busy, inTransaction: !!s && !s.broken && s.inTransaction };
  };

  /**
   * War die Sitzung getrennt, wird sie nur neu aufgebaut und NICHTS ausgeführt: sonst liefe z. B. ein UPDATE,
   * das die Nutzerin in einer offenen Transaktion wähnt, auf der neuen Verbindung sofort mit Autocommit.
   */
  runQuery: DbvApi['runQuery'] = async (sessionId, statements, maxRows) => {
    let s = this.session(sessionId);
    if (!(await s.check())) {
      s = await this.reopen(sessionId);
      return { results: [], statements: [], messages: [RECONNECTED], currentDatabase: s.database, inTransaction: false, reconnected: true, cancelled: false, durationMs: 0 };
    }
    const r = await s.run(statements, maxRows);
    if (s.broken) r.messages.push(LOST_DURING_RUN);
    r.inTransaction = !s.broken && s.inTransaction;
    await this.record(sessionId, s.database, r).catch(() => undefined);
    return r;
  };

  /** wie runQuery; mit analyze laufen die Anweisungen dabei wirklich und kommen deshalb in den Verlauf */
  explainQuery: DbvApi['explainQuery'] = async (sessionId, statements, analyze) => {
    let s = this.session(sessionId);
    if (!(await s.check())) {
      s = await this.reopen(sessionId);
      return { analyzed: analyze, statements: [], messages: [RECONNECTED], currentDatabase: s.database, inTransaction: false, reconnected: true, cancelled: false, durationMs: 0 };
    }
    const p = await s.explain(statements, analyze);
    if (s.broken) p.messages.push(LOST_DURING_RUN);
    p.inTransaction = !s.broken && s.inTransaction;
    if (analyze && statements.length) {
      const connectionId = this.sessions.get(sessionId)?.connectionId;
      const failed = p.statements.find((x) => x.error);
      if (connectionId) {
        const connection = (await this.store.get(connectionId).catch(() => undefined))?.name ?? '';
        await this.history
          .add([
            {
              at: new Date().toISOString(),
              connectionId,
              connection,
              database: s.database,
              sql: statements.map((x) => x.sql).join(';\n'),
              durationMs: p.durationMs,
              ok: !failed,
              error: failed?.error,
              info: 'Plan mit Laufzeit',
            },
          ])
          .catch(() => undefined);
      }
    }
    return p;
  };

  /** Ausgeführtes in den Verlauf; große Skripte als ein Eintrag */
  private async record(sessionId: string, database: string | undefined, r: QueryRun) {
    const connectionId = this.sessions.get(sessionId)?.connectionId;
    if (!connectionId || !r.statements.length) return;
    const connection = (await this.store.get(connectionId).catch(() => undefined))?.name ?? '';
    const at = new Date().toISOString();
    const base = { at, connectionId, connection, database };
    if (r.statements.length > 20) {
      const failed = r.statements.find((s) => s.error);
      await this.history.add([
        {
          ...base,
          sql: r.statements.map((s) => s.sql).join(';\n'),
          durationMs: r.durationMs,
          ok: !failed,
          error: failed?.error,
          info: `${r.statements.length} Anweisungen`,
        },
      ]);
      return;
    }
    await this.history.add(
      r.statements.map((s) => {
        const sets = r.results.filter((x) => x.statementIndex === s.statementIndex);
        const rows = sets.reduce((n, x) => n + x.rows.length, 0);
        const info = s.error
          ? undefined
          : sets.length
            ? `${rows}${sets.some((x) => x.truncated) ? '+' : ''} Zeile${rows === 1 ? '' : 'n'}`
            : s.rowsAffected !== undefined
              ? `${s.rowsAffected} Zeile${s.rowsAffected === 1 ? '' : 'n'} betroffen`
              : undefined;
        return { ...base, sql: s.sql, durationMs: s.durationMs, ok: !s.error, error: s.error, info };
      }),
    );
  }

  /**
   * Änderungen aus der Tabellenansicht. Die Anweisungen baut der Hauptprozess aus der Tabellenstruktur (nicht die
   * Oberfläche); ausgeführt wird in einer Transaktion, jede Anweisung muss genau eine Zeile treffen.
   */
  applyChanges = async (req: ApplyChangesRequest): Promise<ApplyChangesResult> => {
    const { object } = req;
    const c = await this.store.get(object.connectionId);
    sqlOnly([c], 'Bearbeiten');
    if (c.options?.readOnly) throw new Error('Die Verbindung steht auf „Nur lesen“ – Ändern ist nicht möglich.');
    if (object.kind !== 'table') throw new Error('Views lassen sich hier nicht bearbeiten.');
    if (!req.changes.length) return { statements: [], applied: 0 };
    const d = await this.driver(object.connectionId);
    const info = await d.describeTable(object.database, object.schema, object.name);
    const { ops, preview } = buildWrites(c.dialect, object, info, req.changes);
    if (req.preview) return { statements: preview, applied: 0 };
    const counts = await d.applyWrites(object.database, ops);
    return { statements: preview, applied: counts.length };
  };

  /** Einstellungen in eine Datei (Speichern-Dialog); null = abgebrochen */
  exportSettings = async (opts: SettingsExportOptions): Promise<string | null> => {
    // zuerst zusammenstellen: ein zu kurzes Passwort soll vor dem Dialog auffallen
    const data = await exportSettingsFile(this.store, this.saved, this.history, opts);
    const file = await this.host.saveFile(`owlyndb-einstellungen-${new Date().toISOString().slice(0, 10)}`, 'json');
    if (!file) return null;
    await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return file;
  };

  previewSettings = (file: string, password?: string) => previewSettingsFile(this.store, this.saved, this.history, file, password);

  importSettings = async (req: SettingsImportRequest): Promise<SettingsImportResult> => {
    const { replacedIds, ...result } = await importSettingsFile(this.store, this.saved, this.history, req);
    // ersetzte Verbindungen wie beim Bearbeiten: „Nur lesen“ sofort auch in offenen Tabs, neue Zugangsdaten für neue Aufrufe
    for (const id of replacedIds) {
      const c = await this.store.get(id).catch(() => undefined);
      if (c) this.applyReadOnly(id, !!c.options?.readOnly);
      this.retireDriver(id);
    }
    return result;
  };

  listHistory = (q: HistoryQuery) => this.history.list(q);
  /** Verlaufseinträge je Verbindung – der Einstellungs-Export zählt nur und holt dafür nicht den ganzen SQL-Text */
  historyCounts = async (): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const e of await this.history.all()) counts[e.connectionId] = (counts[e.connectionId] ?? 0) + 1;
    return counts;
  };
  clearHistory = (connectionId?: string) => this.history.clear(connectionId);
  listSavedQueries = () => this.saved.list();
  saveQuery: DbvApi['saveQuery'] = (q) => this.saved.save(q);
  deleteSavedQuery = (id: string) => this.saved.remove(id);
  cancelQuery = (sessionId: string) => this.session(sessionId).cancel();

  startDump = async (req: DumpRequest): Promise<string | null> => {
    sqlOnly([await this.store.get(req.connectionId)], 'Einen Dump');
    const file = await this.host.saveFile(req.baseName, 'sql');
    if (!file) return null;
    const c = await this.store.get(req.connectionId);
    const d = await this.driver(req.connectionId);
    // Teilmenge: wie viele Zeilen es werden, steht erst nach der Planung fest
    const total = req.data && !partial(req) ? await estimateRows(d, req.database, req.tables) : 0;
    const p: DumpProgress = { rows: 0, table: '', warnings: [] };
    return this.job('dump', file, total || undefined, () => ({ done: p.rows, statements: 0, current: p.table, log: p.warnings }), async (cancelled) => {
      // in eine Nachbardatei: erst der fertige Dump ersetzt die gewählte Datei, bei Fehler bleibt eine vorhandene erhalten
      const part = partFile(file);
      await writeDump(d, c.dialect, req, part, p, cancelled);
      await replaceWith(part, file);
    }, undefined, [req.connectionId]);
  };

  /**
   * Objekte direkt in eine andere Datenbank kopieren: Dump und Einspielen laufen gleichzeitig, verbunden über einen
   * Datenstrom mit Gegendruck – ohne Datei, auch für große Tabellen. Zieltyp = Typ der Zielverbindung (Typen werden
   * übersetzt wie beim Dump). Die Quelle darf auf „Nur lesen“ stehen, das Ziel nicht.
   */
  startCopy = async (req: CopyRequest): Promise<string> => {
    const { source } = req;
    const src = await this.store.get(source.connectionId);
    const dst = await this.store.get(req.targetConnectionId);
    sqlOnly([src, dst], 'Kopieren');
    if (dst.options?.readOnly) throw new Error(`Die Zielverbindung „${dst.name}“ steht auf „Nur lesen“ – Kopieren dorthin ist nicht möglich.`);
    const db = req.targetDatabase.trim();
    if (!db) throw new Error('Bitte eine Zieldatenbank angeben.');
    if (!source.tables.length && !source.views.length) throw new Error('Bitte mindestens eine Tabelle wählen.');
    const sameDb = 'Quelle und Ziel sind dieselbe Datenbank – bitte eine andere Zieldatenbank wählen oder eine neue anlegen.';
    if (sameDatabase(src, source.database, dst, db)) throw new Error(sameDb);
    const sd = await this.driver(source.connectionId);
    const td = await this.driver(req.targetConnectionId);
    // zwei Verbindungen zum selben Server unter verschiedenen Namen (localhost/IP/FQDN, Tunnel): die Server selbst fragen
    if (src.id !== dst.id && src.dialect === dst.dialect && sameName(src.dialect, source.database, db) && sd.serverIdentity && td.serverIdentity) {
      const [a, b] = await Promise.all([sd.serverIdentity().catch(() => ''), td.serverIdentity().catch(() => '')]);
      if (a && a === b) throw new Error(sameDb);
    }
    if (req.createDatabase) await this.createDatabase(td, dst.dialect, db);
    const session = await td.openSession(db);
    session.readOnly = false;
    const total = source.data && !partial(source) ? await estimateRows(sd, source.database, source.tables) : 0;
    const dp: DumpProgress = { rows: 0, table: '', warnings: [] };
    const ip: ImportProgress = { bytes: 0, total: 0, statements: 0, errors: 0, skipped: 0, warnings: 0, lostRows: 0, missingObjects: 0, line: 0, log: [] };
    const tx = req.transaction && dst.dialect !== 'mysql';
    const begin = dst.dialect === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN';
    /** der Datenstrom des laufenden Auftrags – Abbrechen schließt ihn, damit beide Seiten sofort aufhören */
    const link: { pipe?: PassThrough } = {};
    return this.job(
      'copy',
      '',
      total || undefined,
      () => ({
        done: dp.rows,
        statements: ip.statements,
        current: dp.table + (ip.errors ? ` · ${ip.errors} Fehler` : '') + (ip.warnings ? ` · ${ip.warnings} Warnungen` : ''),
        log: [...ip.log, ...dp.warnings],
      }),
      async (cancelled) => {
        const pipe = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
        link.pipe = pipe;
        // die erste Störung gewinnt; der Datenstrom wird mit ihr geschlossen, damit die andere Seite aufhört
        let failure: unknown;
        const fail = (e: unknown) => {
          if (failure === undefined) failure = e;
          if (!pipe.destroyed) pipe.destroy(e instanceof Error ? e : new Error(String(e)));
        };
        const stop = () => cancelled() || failure !== undefined;
        try {
          if (tx) await mustRun(session, begin);
          const importReq: ImportRequest = {
            connectionId: req.targetConnectionId,
            database: db,
            createDatabase: false,
            file: '',
            stopOnError: req.stopOnError || tx,
            transaction: tx,
            skipUse: true,
          };
          await Promise.all([
            writeDump(sd, src.dialect, { ...source, targetDialect: dst.dialect, baseName: '' }, pipe, dp, stop).catch(fail),
            runImport(session, dst.dialect, importReq, ip, stop, pipe).catch(fail),
          ]);
          if (failure !== undefined) throw failure;
          if (tx) await mustRun(session, 'COMMIT');
          if (ip.errors) ip.log.unshift(skippedSummary(ip));
        } catch (e) {
          if (tx && !session.broken) await session.run([{ sql: 'ROLLBACK', offset: 0 }], 0).catch(() => undefined);
          if (tx) ip.log.unshift('Transaktion zurückgerollt – im Ziel wurde nichts übernommen.');
          else if (ip.statements) ip.log.unshift(`${ip.statements} Anweisung(en) waren bereits ausgeführt und bleiben im Ziel bestehen.`);
          throw e;
        } finally {
          await session.close().catch(() => undefined);
        }
      },
      () => {
        // Ziel: laufende Anweisung abbrechen; Quelle: über cancelled.signal (streamTable); Strom: beide Seiten wecken
        void session.cancel().catch(() => undefined);
        link.pipe?.destroy(new Error(ABORTED));
      },
      [source.connectionId, req.targetConnectionId],
    );
  };

  /** neue Datenbank in UTF-8 – die Vorgabe des Servers wäre auf älteren MySQL/MariaDB latin1, bei PostgreSQL die Locale des Systems */
  private async createDatabase(d: MetaDriver, dialect: Dialect, db: string): Promise<void> {
    const s = await d.openSession();
    try {
      const name = quoteIdent(dialect, db);
      const sqls =
        dialect === 'mysql'
          ? [`CREATE DATABASE ${name} CHARACTER SET utf8mb4`]
          : dialect === 'postgres'
            // template0: nur so darf die Kodierung von der Vorlage abweichen; passt die Locale nicht zu UTF-8, ohne Vorgabe
            ? [`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`, `CREATE DATABASE ${name}`]
            : [`CREATE DATABASE ${name}`];
      let error = '';
      for (const sql of sqls) {
        const r = await s.run([{ sql, offset: 0 }], 0);
        error = r.statements[0]?.error ?? '';
        if (!error) return;
      }
      throw new Error(`Datenbank ${db} anlegen: ${error}`);
    } finally {
      await s.close().catch(() => undefined);
    }
  }

  startImport = async (req: ImportRequest): Promise<string> => {
    const c = await this.store.get(req.connectionId);
    sqlOnly([c], 'Einspielen');
    if (c.options?.readOnly) throw new Error('Die Verbindung steht auf „Nur lesen“ – Einspielen ist nicht möglich.');
    const d = await this.driver(req.connectionId);
    const db = req.database.trim();
    if (!db) throw new Error('Bitte eine Zieldatenbank angeben.');
    // Datei zuerst prüfen (Pfad, Rechte, Archiv, Kodierung): ein Tippfehler hinterließe sonst eine leere neue Datenbank
    await inspectFile(req.file, c.dialect).catch((e: NodeJS.ErrnoException) => {
      throw e.code ? new Error(`Datei nicht lesbar: ${req.file} (${e.code})`) : e;
    });
    if (req.createDatabase) await this.createDatabase(d, c.dialect, db);
    const session = await d.openSession(db);
    session.readOnly = false;
    const p: ImportProgress = { bytes: 0, total: 0, statements: 0, errors: 0, skipped: 0, warnings: 0, lostRows: 0, missingObjects: 0, line: 0, log: [] };
    const tx = req.transaction && c.dialect !== 'mysql';
    const begin = c.dialect === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN';
    return this.job(
      'import',
      req.file,
      undefined,
      () => ({
        done: p.bytes,
        total: p.total || undefined,
        statements: p.statements,
        current:
          `Zeile ${p.line}${p.errors ? ` · ${p.errors} Fehler` : ''}${p.warnings ? ` · ${p.warnings} Warnungen` : ''}` +
          `${p.skipped ? ` · ${p.skipped} USE/DATABASE übersprungen` : ''}`,
        log: p.log,
      }),
      async (cancelled) => {
        try {
          if (tx) await mustRun(session, begin);
          await runImport(session, c.dialect, { ...req, database: db, stopOnError: req.stopOnError || tx }, p, cancelled);
          if (tx) await mustRun(session, 'COMMIT');
          if (p.errors) p.log.unshift(skippedSummary(p));
        } catch (e) {
          // alles oder nichts: zurückrollen (ohne Transaktion bleibt, was schon lief)
          if (tx && !session.broken) await session.run([{ sql: 'ROLLBACK', offset: 0 }], 0).catch(() => undefined);
          if (tx) p.log.unshift('Transaktion zurückgerollt – es wurde nichts übernommen.');
          else if (p.statements) p.log.unshift(`${p.statements} Anweisung(en) waren bereits ausgeführt und bleiben bestehen.`);
          throw e;
        } finally {
          await session.close().catch(() => undefined);
        }
      },
      () => void session.cancel().catch(() => undefined),
      [req.connectionId],
    );
  };

  /**
   * Daten zweier Tabellen vergleichen (auch über Verbindungen und Datenbanktypen hinweg). Liest nur; das Abgleich-Skript
   * entsteht als Text und wird nicht ausgeführt.
   */
  startDataCompare = async (req: DataCompareRequest): Promise<string> => {
    const { source: s, target: t } = req;
    sqlOnly(await Promise.all([this.store.get(s.connectionId), this.store.get(t.connectionId)]), 'Den Datenvergleich');
    if (!s.table || !t.table) throw new Error('Bitte Quell- und Zieltabelle wählen.');
    if (s.connectionId === t.connectionId && s.database === t.database && s.schema === t.schema && s.table === t.table) {
      throw new Error('Quelle und Ziel sind dieselbe Tabelle.');
    }
    const [cs, ct] = await Promise.all([this.store.get(s.connectionId), this.store.get(t.connectionId)]);
    const [ds, dt] = await Promise.all([this.driver(s.connectionId), this.driver(t.connectionId)]);
    // Fortschritt grob: Ziel bis zu zweimal, Quelle einmal
    const [ns, nt] = await Promise.all([
      estimateRows(ds, s.database, [{ schema: s.schema, name: s.table }]),
      estimateRows(dt, t.database, [{ schema: t.schema, name: t.table }]),
    ]);
    const p: DataCompareProgress = { phase: '', rows: 0 };
    const holder: { result?: DataCompareResult } = {};
    const id = this.job(
      'datacompare',
      '',
      ns + nt > 0 ? ns + 2 * nt : undefined,
      () => ({ done: p.rows, statements: 0, current: p.phase, log: [] }),
      async (cancelled) => {
        holder.result = await compareData({ driver: ds, dialect: cs.dialect, ...s }, { driver: dt, dialect: ct.dialect, ...t }, req, p, cancelled);
      },
      undefined,
      [s.connectionId, t.connectionId],
    );
    this.dataResults.set(id, holder);
    this.trimResults(this.dataResults);
    return id;
  };

  /** nicht abgeholte Ergebnisse (bis zu einigen Tausend Zeilen samt Werten): höchstens 5 beendete, laufende nie verdrängt */
  private trimResults(m: Map<string, unknown>): void {
    for (const id of [...m.keys()]) {
      if (m.size <= 5) break;
      if (!this.jobs.get(id)?.running()) m.delete(id);
    }
  }

  /** Ergebnis abholen – danach freigegeben (die Oberfläche holt jedes einmal) */
  dataCompareResult = async (jobId: string): Promise<DataCompareResult> => {
    const r = this.dataResults.get(jobId)?.result;
    if (!r) throw new Error('Für diesen Vergleich gibt es kein Ergebnis (noch nicht fertig oder schon verworfen).');
    this.dataResults.delete(jobId);
    return r;
  };

  /** alle Tabellen eines Schemas vergleichen, eine nach der anderen, nur zählen */
  startDataCompareAll = async (req: DataCompareAllRequest): Promise<string> => {
    const { source: s, target: t } = req;
    const [cs, ct] = await Promise.all([this.store.get(s.connectionId), this.store.get(t.connectionId)]);
    sqlOnly([cs, ct], 'Den Datenvergleich');
    if (s.connectionId === t.connectionId && s.database === t.database && s.schema === t.schema) throw new Error('Quelle und Ziel sind dasselbe Schema.');
    const [ds, dt] = await Promise.all([this.driver(s.connectionId), this.driver(t.connectionId)]);
    const p: DataCompareProgress = { phase: '', rows: 0 };
    const holder: { result?: DataCompareAllResult } = {};
    const id = this.job(
      'datacompare',
      '',
      undefined,
      () => ({ done: p.rows, statements: 0, current: p.phase, log: [] }),
      async (cancelled) => {
        holder.result = await compareSchemaData({ driver: ds, dialect: cs.dialect, ...s }, { driver: dt, dialect: ct.dialect, ...t }, req, p, cancelled);
      },
      undefined,
      [s.connectionId, t.connectionId],
    );
    this.dataAllResults.set(id, holder);
    this.trimResults(this.dataAllResults);
    return id;
  };

  dataCompareAllResult = async (jobId: string): Promise<DataCompareAllResult> => {
    const r = this.dataAllResults.get(jobId)?.result;
    if (!r) throw new Error('Für diesen Vergleich gibt es kein Ergebnis (noch nicht fertig oder schon verworfen).');
    this.dataAllResults.delete(jobId);
    return r;
  };

  /**
   * Abgleich-Skript ohne Obergrenze: erst die Datei wählen, dann im Hintergrund schreiben (eine Tabelle oder alle eines
   * Schemas, in der Reihenfolge der Fremdschlüssel). Ausgeführt wird nichts – die Datei lässt sich danach im Ziel einspielen.
   */
  startDataCompareScript = async (req: DataCompareScriptRequest): Promise<string | null> => {
    const one = req.table;
    const all = req.all;
    if (!one === !all) throw new Error('Bitte eine Tabelle oder ein Schema angeben.');
    const s = one ? one.source : all!.source;
    const t = one ? one.target : all!.target;
    const [cs, ct] = await Promise.all([this.store.get(s.connectionId), this.store.get(t.connectionId)]);
    sqlOnly([cs, ct], 'Den Datenvergleich');
    if (one) {
      if (!one.source.table || !one.target.table) throw new Error('Bitte Quell- und Zieltabelle wählen.');
      if (s.connectionId === t.connectionId && s.database === t.database && s.schema === t.schema && one.source.table === one.target.table) {
        throw new Error('Quelle und Ziel sind dieselbe Tabelle.');
      }
    } else if (s.connectionId === t.connectionId && s.database === t.database && s.schema === t.schema) {
      throw new Error('Quelle und Ziel sind dasselbe Schema.');
    }
    const [ds, dt] = await Promise.all([this.driver(s.connectionId), this.driver(t.connectionId)]);
    const src = { driver: ds, dialect: cs.dialect, database: s.database, schema: s.schema };
    const dst = { driver: dt, dialect: ct.dialect, database: t.database, schema: t.schema };
    const file = await this.host.saveFile(one ? `abgleich-${one.target.table}` : `abgleich-${[t.database, t.schema].filter(Boolean).join('-')}`, 'sql');
    if (!file) return null;
    const p: DataCompareProgress = { phase: '', rows: 0, statements: 0 };
    const log: string[] = [];
    const place = (name: string, x: { database: string; schema: string }, table?: string) => `${name} · ${[x.database, x.schema, table].filter(Boolean).join('.')}`;
    const header = [
      `Datenabgleich: Ziel ${place(ct.name, t, one?.target.table)} an Quelle ${place(cs.name, s, one?.source.table)} angleichen`,
      `erstellt ${new Date().toLocaleString('de-CH')} mit OwlynDB${one?.where ? ` · WHERE ${one.where}` : ''}`,
      'vor dem Ausführen prüfen; im Ziel ausführen, am besten in einer Transaktion',
    ];
    return this.job(
      'datacompare',
      file,
      undefined,
      () => ({ done: p.rows, statements: p.statements ?? 0, current: p.phase, log }),
      async (cancelled) => {
        let list: ScriptTable[];
        if (one) {
          list = [{ src: { ...src, table: one.source.table }, dst: { ...dst, table: one.target.table }, req: one }];
        } else {
          p.phase = 'Tabellen lesen';
          const { pairs } = await tablePairs(src, dst, all!.tables);
          list = pairs.map((x) => ({
            src: { ...src, table: x.source },
            dst: { ...dst, table: x.target },
            req: {
              source: { ...s, table: x.source },
              target: { ...t, table: x.target },
              // nur eigene Einträge: eine Tabelle „constructor“ träfe sonst Object.prototype
              key: all!.keys && Object.hasOwn(all!.keys, x.source) ? all!.keys[x.source] : undefined,
              ignoreCase: all!.ignoreCase,
              ignoreTrailingSpaces: all!.ignoreTrailingSpaces,
            },
          }));
        }
        // in eine Nachbardatei: erst das fertige Skript ersetzt die gewählte Datei, bei Fehler bleibt eine vorhandene erhalten
        const part = partFile(file);
        try {
          const sum = await writeDataScript(list, part, { includeDeletes: req.includeDeletes, header }, p, cancelled);
          await replaceWith(part, file);
          for (const x of sum.tables) {
            if (x.error) log.push(`${x.table}: übersprungen – ${x.error}`);
            else if (x.inserts + x.updates + x.deletes) log.push(`${x.table}: ${x.deletes} löschen, ${x.updates} ändern, ${x.inserts} einfügen`);
          }
        } catch (e) {
          await rm(part, { force: true }).catch(() => undefined);
          throw e;
        }
      },
      undefined,
      [s.connectionId, t.connectionId],
    );
  };

  jobStatus = async (jobId: string): Promise<JobStatus> => {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error('Auftrag nicht gefunden.');
    return j.status();
  };

  cancelJob = async (jobId: string): Promise<void> => {
    this.jobs.get(jobId)?.cancel();
  };

  private job(
    kind: JobStatus['kind'],
    file: string,
    total: number | undefined,
    progress: () => Pick<JobStatus, 'done' | 'statements' | 'current' | 'log'> & { total?: number },
    work: (cancelled: CancelCheck) => Promise<void>,
    onCancel?: () => void,
    connections: string[] = [],
  ): string {
    const id = randomUUID();
    const t0 = performance.now();
    let state: JobStatus['state'] = 'running';
    let error: string | undefined;
    let cancel = false;
    let durationMs: number | undefined;
    // das Signal bricht wartende Server-Anfragen des Auftrags ab (streamTable) – die Prüfung allein griffe erst bei der nächsten Zeile
    const ac = new AbortController();
    const cancelled: CancelCheck = Object.assign(() => cancel, { signal: ac.signal });
    const entry = {
      status: () => ({ id, kind, state, file, error, total, ...progress(), durationMs: durationMs ?? Math.round(performance.now() - t0) }),
      cancel: () => {
        cancel = true;
        ac.abort();
        onCancel?.();
      },
      running: () => state === 'running',
      done: Promise.resolve(),
      connections,
    };
    this.jobs.set(id, entry);
    entry.done = work(cancelled)
      .then(
        () => {
          state = 'done';
          durationMs = Math.round(performance.now() - t0);
        },
        (e: unknown) => {
          state = cancel ? 'cancelled' : 'error';
          error = cancel ? ABORTED : errorText(e);
          durationMs = Math.round(performance.now() - t0);
        },
      )
      .finally(() => {
        // beendet: nichts mehr abzubrechen – die Sitzung des Auftrags nicht weiter festhalten
        entry.cancel = () => undefined;
        this.pruneJobs();
      });
    return id;
  }

  /** beendete Aufträge: die letzten 20 bleiben abrufbar (Status, Protokoll), ältere fallen samt Ergebnis weg */
  private pruneJobs(): void {
    const finished = [...this.jobs].filter(([, j]) => !j.running());
    for (const [id] of finished.slice(0, Math.max(0, finished.length - 20))) {
      this.jobs.delete(id);
      this.dataResults.delete(id);
      this.dataAllResults.delete(id);
    }
  }

  /**
   * Beenden: Aufträge abbrechen und kurz auf ihr Aufräumen warten (Rollback, halbe Datei löschen), dann Sitzungen,
   * Treiber und Tunnel nebeneinander schließen. Jede Sitzung bricht ihre Abfrage ab und hat eine Frist – ein toter
   * Server hält das Beenden nicht auf; main.ts begrenzt das Ganze zusätzlich.
   */
  /**
   * Die Oberfläche lädt neu bzw. ist abgestürzt: ihre Sitzungen (offene Transaktionen werden zurückgerollt), Aufträge und
   * Tabellen-Exporte gehören niemandem mehr – abbrechen und schließen. Treiber und Tunnel bleiben, die neue Oberfläche
   * verbindet sich gleich wieder.
   */
  async releaseUi(): Promise<void> {
    this.unsavedTables = [];
    for (const ac of this.exportCancels.values()) ac.abort();
    for (const j of this.jobs.values()) if (j.running()) j.cancel();
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  async shutdown(): Promise<void> {
    clearInterval(this.keepAliveTimer);
    for (const ac of this.exportCancels.values()) ac.abort();
    const jobs = [...this.jobs.values()].filter((j) => j.running());
    for (const j of jobs) j.cancel();
    await withTimeout(Promise.allSettled(jobs.map((j) => j.done)), 5000, 'Das Abbrechen der Aufträge').catch(() => undefined);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
    await Promise.allSettled([...this.drivers.keys()].map((id) => this.closeDriver(id)));
    await Promise.allSettled([...this.forwards.keys()].map((id) => this.closeForwards(id)));
  }
}

/** Treiber spricht mit dem lokalen Ende des SSH-Tunnels */
/** Dump, Vergleich, Bearbeiten usw. gibt es nur für die SQL-Datenbanken (Elasticsearch: nur lesen) */
function sqlOnly(conns: SavedConnection[], what: string): void {
  if (conns.some((c) => c.dialect === 'elasticsearch')) throw new Error(`${what} gibt es für Elasticsearch nicht – dort liest OwlynDB nur Indizes, Mappings und Dokumente.`);
}

function viaForward(cfg: DriverConfig, fwd: SshForward): DriverConfig {
  return { ...cfg, host: '127.0.0.1', port: fwd.port, tunnel: false, ssh: undefined, target: { host: cfg.host, port: cfg.port } };
}

async function mustRun(s: Session, sql: string) {
  const r = await s.run([{ sql, offset: 0 }], 0);
  if (r.statements[0]?.error) throw new Error(`${sql}: ${r.statements[0].error}`);
}

/** Teil-Dump: mindestens eine Tabelle nicht ganz */
function partial(req: Pick<DumpRequest, 'subset'>): boolean {
  return !!req.subset?.some((s) => s.rule.kind !== 'all');
}

/** Gesamtzahl der Zeilen (Schätzung aus dem Katalog) für den Fortschritt */
async function estimateRows(d: MetaDriver, database: string, tables: { schema: string; name: string }[]): Promise<number> {
  let total = 0;
  for (const schema of new Set(tables.map((t) => t.schema))) {
    const objs = await d.listObjects(database, schema).catch(() => []);
    for (const o of objs) if (tables.some((t) => t.schema === schema && t.name === o.name)) total += o.rows ?? 0;
  }
  return total;
}

/**
 * Zeigen beide auf dieselbe Datenbank? Gleiche Verbindung oder gleicher Server (Host, Port, ggf. SSH-Server) –
 * Kopieren auf sich selbst würde mit „vorher löschen“ die Quelle zerstören. Groß/klein zählt nicht (lieber einmal zu oft).
 */
function sameDatabase(a: SavedConnection, aDb: string, b: SavedConnection, bDb: string): boolean {
  if (!sameName(a.dialect, aDb, bDb)) return false;
  if (a.id === b.id) return true;
  const where = (c: SavedConnection) =>
    `${c.options?.ssh ? `${(c.options.sshHost ?? '').toLowerCase()}:${c.options.sshPort ?? 22}>` : ''}${c.host.toLowerCase()}:${c.port}`;
  return a.dialect === b.dialect && where(a) === where(b);
}

/** derselbe Datenbankname? PostgreSQL unterscheidet Groß/klein, die anderen nicht (lieber einmal zu oft) */
function sameName(dialect: Dialect, a: string, b: string): boolean {
  return dialect === 'postgres' ? a.trim() === b.trim() : a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Schreiber, der nach dem Abbrechen keine Zeilen mehr annimmt (falls der Treiber das Signal erst spät prüft) */
function abortable(w: ExportWriter, signal: AbortSignal): RowSink {
  const check = () => {
    if (signal.aborted) throw new Error(ABORTED);
  };
  return {
    begin: async (columns) => {
      check();
      await w.begin(columns);
    },
    rows: async (batch) => {
      check();
      await w.rows(batch);
    },
  };
}
