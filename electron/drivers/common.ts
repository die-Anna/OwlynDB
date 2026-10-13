import type {
  Cell,
  ColumnInfo,
  CompletionInfo,
  DbObject,
  ErModel,
  IncomingKey,
  RoutineInfo,
  SearchHit,
  ServerSession,
  ObjectKind,
  QueryPlan,
  QueryRun,
  ResultColumn,
  StatementPlan,
  ServerInfo,
  StatementInput,
  StatementOutcome,
  QueryResultSet,
  TableDataRequest,
  TableDataResult,
  TableInfo,
  Dialect,
} from '../../shared/api-types';
import { readOnlyViolation } from '../../shared/sql-guard';
import { checkWhere } from '../../shared/sql-util';
import type { ExportCell } from '../export';

/** Zeile der Suchabfragen in einen Treffer übersetzen (extra: Spalte, Trigger-Tabelle oder Argumente) */
export function searchHit(
  database: string,
  schema: string,
  kind: string,
  name: string,
  extra: string | null,
  dataType: string | null,
  objectKind: string | null,
): SearchHit {
  const k = kind as SearchHit['kind'];
  const hit: SearchHit = { database, schema, kind: k, name };
  if (k === 'column') {
    hit.column = extra ?? '';
    if (dataType) hit.dataType = dataType;
    hit.objectKind = objectKind === 'view' ? 'view' : 'table';
  } else if (k === 'trigger' && extra) {
    hit.table = extra;
  } else if ((k === 'function' || k === 'procedure') && extra !== null) {
    hit.args = extra;
  }
  return hit;
}

/** ER-Diagramm: Zeilen der Katalog-Abfragen (je Spalte bzw. je Fremdschlüssel-Spalte, sortiert) zusammenfassen */
export function erModelFrom(
  tables: { schema: string; name: string; rows?: number }[],
  columns: { schema: string; table: string; name: string; type: string; nullable: boolean; pk: boolean }[],
  fkColumns: { name: string; schema: string; table: string; column: string; refSchema: string; refTable: string; refColumn: string }[],
): ErModel {
  const key = (schema: string, name: string) => `${schema}\u0000${name}`;
  const byKey = new Map<string, ErModel['tables'][number]>();
  for (const t of tables) {
    byKey.set(key(t.schema, t.name), { schema: t.schema, name: t.name, columns: [], ...(t.rows != null && t.rows >= 0 ? { rows: t.rows } : {}) });
  }
  for (const c of columns) byKey.get(key(c.schema, c.table))?.columns.push({ name: c.name, type: c.type, nullable: c.nullable, pk: c.pk });
  const fks = new Map<string, ErModel['foreignKeys'][number]>();
  for (const f of fkColumns) {
    if (!byKey.has(key(f.schema, f.table))) continue;
    const k = `${key(f.schema, f.table)}\u0000${f.name}`;
    let fk = fks.get(k);
    if (!fk) {
      fk = { name: f.name, schema: f.schema, table: f.table, columns: [], refSchema: f.refSchema, refTable: f.refTable, refColumns: [] };
      fks.set(k, fk);
    }
    fk.columns.push(f.column);
    fk.refColumns.push(f.refColumn);
  }
  return { tables: [...byKey.values()], foreignKeys: [...fks.values()] };
}

/** eingehende Fremdschlüssel aus einer Zeile je Spalte zusammenfassen (MySQL, SQL Server) */
export function groupIncoming(rows: { name: string; sch: string; tbl: string; col: string; refCol: string }[]): IncomingKey[] {
  const map = new Map<string, IncomingKey>();
  for (const r of rows) {
    const key = `${r.sch}\u0000${r.tbl}\u0000${r.name}`;
    let k = map.get(key);
    if (!k) {
      k = { name: r.name, schema: r.sch, table: r.tbl, columns: [], refColumns: [] };
      map.set(key, k);
    }
    k.columns.push(r.col);
    k.refColumns.push(r.refCol);
  }
  return [...map.values()];
}

/** Zugangsdaten, wie sie die Treiber brauchen (mit Klartext-Passwort). */
export interface DriverConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  /** ganze Verbindung in TLS tunneln (Proxy); tls gilt dann für den Tunnel */
  tunnel?: boolean;
  /** SNI-Name für den TLS-Tunnel (sonst der Host) */
  servername?: string;
  tls?: TlsMaterial;
  /** Abfrage-Tabs nur lesend (Sicherheitsmodus) */
  readOnly?: boolean;
  /** über SSH weiterleiten; host/port sind dann das Ziel aus Sicht des SSH-Servers */
  ssh?: SshSettings;
  /** Elasticsearch: das Passwort ist ein API-Key */
  apiKey?: boolean;
  /** über den SSH-Tunnel: das eigentliche Ziel (host/port zeigen dann auf den Tunnel) – für Zertifikat und Host-Kopf */
  target?: { host: string; port: number };
}

export interface SshSettings {
  host: string;
  port: number;
  username: string;
  /** gelesener privater Schlüssel (OpenSSH/PEM) */
  privateKey?: string;
  /** Schlüssel stammt aus ~/.ssh (nicht ausdrücklich gewählt) */
  defaultKey?: boolean;
  /** Passwort bzw. Passwort des Schlüssels */
  secret?: string;
  /** SSH läuft im TLS-Tunnel (Zertifikate aus DriverConfig.tls) */
  tls?: boolean;
  servername?: string;
}

/** Bereits gelesene Zertifikatsdateien */
export interface TlsMaterial {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  verifyServer: boolean;
  verifyHostname: boolean;
}

/** Verbindung für Objektbaum, Tabellenansicht und Metadaten. */
export interface MetaDriver {
  serverInfo(): Promise<ServerInfo>;
  listDatabases(): Promise<string[]>;
  listSchemas(database: string): Promise<string[]>;
  listObjects(database: string, schema: string): Promise<DbObject[]>;
  listRoutines(database: string, schema: string): Promise<RoutineInfo[]>;
  /**
   * Objekte nach Namen suchen; pattern ist ein LIKE-Muster (\\ als Escape), Groß-/Kleinschreibung egal.
   * MySQL: database null = alle Datenbanken in einer Abfrage.
   */
  searchObjects(database: string | null, pattern: string, limit: number): Promise<SearchHit[]>;
  /** CREATE-Anweisung der Routine, wie die Datenbank sie liefert (ohne Trennzeichen am Ende) */
  routineDdl(database: string, schema: string, r: RoutineInfo): Promise<string>;
  describeTable(database: string, schema: string, name: string): Promise<TableInfo>;
  /** Tabellen (ohne Views) mit Spalten und Fremdschlüsseln – in wenigen Katalog-Abfragen statt je Tabelle */
  erModel(database: string, schema: string): Promise<ErModel>;
  getDdl(database: string, schema: string, name: string, kind: ObjectKind): Promise<string>;
  fetchTable(req: TableDataRequest): Promise<TableDataResult>;
  countTable(req: TableDataRequest): Promise<number>;
  completionInfo(database: string): Promise<CompletionInfo>;
  /**
   * ganze Tabelle (Filter/Sortierung aus req, ohne Seiten) häppchenweise an sink geben. signal bricht die Abfrage
   * auch dann ab, wenn der Server noch keine Zeile geliefert hat (serverseitig, dann Verbindung verwerfen).
   */
  streamTable(req: TableDataRequest, sink: RowSink, signal?: AbortSignal): Promise<void>;
  openSession(database?: string): Promise<Session>;
  /** Änderungen aus der Tabellenansicht in einer Transaktion; Abweichung von expect = alles zurückrollen */
  applyWrites(database: string, ops: WriteOp[]): Promise<number[]>;
  /** Sitzungen des Servers (soweit die Rechte reichen) samt Kennung des Servers */
  listServerSessions(): Promise<ServerSessions>;
  /**
   * Kennung des Servers hinter der Verbindung (Hostname bzw. Port und Startzeit, Prozess-ID …): zwei Verbindungen mit
   * gleicher Kennung landen auf demselben Server, auch wenn sie ihn anders nennen (localhost / IP / FQDN, Tunnel)
   */
  serverIdentity?(): Promise<string>;
  /**
   * Benutzerdefinierte Typen (PostgreSQL ENUM/DOMAIN, SQL-Server-Aliastypen), die Spalten der genannten Tabellen benutzen –
   * für den Dump im selben Datenbanktyp. Typen, die sich nicht anlegen lassen (Erweiterung, zusammengesetzt, CLR), nur als Hinweis.
   */
  typeDdl?(database: string, schema: string, tables: string[]): Promise<TypeDdl[]>;
  /**
   * Abfrage abbrechen bzw. Sitzung beenden – nur wenn die Verbindung beim selben Server landet wie die Liste
   * (server) und die Sitzung noch dieselbe ist (started, wo der Server ein Startdatum kennt).
   */
  killServerSession(id: string, started: string | undefined, server: string, mode: 'query' | 'session'): Promise<void>;
  close(): Promise<void>;
}

/** benutzerdefinierter Typ für den Dump */
export interface TypeDdl {
  schema: string;
  name: string;
  /** Schlüsselwort für DROP … IF EXISTS */
  kind: 'TYPE' | 'DOMAIN';
  /** CREATE-Anweisung ohne Trennzeichen; fehlt, wenn der Typ nur als Hinweis erscheint */
  ddl?: string;
  /** warum der Typ nicht angelegt wird (muss im Ziel vorhanden sein) */
  note?: string;
}

export interface ServerSessions {
  server: string;
  /** Sitzung, über die die Liste geholt wurde */
  self?: string;
  sessions: ServerSession[];
  canCancelQuery: boolean;
}

/** Meldungen beim Abbrechen/Beenden fremder Sitzungen */
export const KILL_TEXT = {
  otherServer: 'Die Verbindung landet inzwischen auf einem anderen Server (Load-Balancer, Failover) – bitte die Liste neu laden.',
  gone: 'Diese Sitzung gibt es nicht mehr, oder ihre ID gehört inzwischen zu einer anderen – bitte die Liste neu laden.',
  self: 'Das ist die Verbindung, über die OwlynDB die Liste holt.',
};

/** eine Anweisung mit Parametern; expect = so viele Zeilen müssen betroffen sein */
export interface WriteOp {
  sql: string;
  /** Werte, Binärwerte als Buffer */
  params: ExportCell[];
  /** Spaltentyp je Parameter (SQL Server bindet (var)char dann nicht als nvarchar) */
  types?: (string | undefined)[];
  expect?: number;
  /** für Meldungen, z. B. "Ändern (id = 5)" */
  label: string;
}

/** wirft, wenn eine Anweisung nicht genau die erwartete Zahl Zeilen trifft (der Aufrufer rollt dann zurück) */
export function checkAffected(op: WriteOp, n: number): void {
  if (op.expect === undefined || n === op.expect) return;
  if (n === 0) {
    throw new Error(`${op.label}: keine Zeile getroffen – sie wurde inzwischen geändert oder gelöscht. Es wurde nichts gespeichert.`);
  }
  throw new Error(`${op.label}: ${n} Zeilen getroffen statt ${op.expect} – der Schlüssel ist nicht eindeutig. Es wurde nichts gespeichert.`);
}

export interface RowSink {
  begin(columns: ResultColumn[]): Promise<void>;
  rows(batch: ExportCell[][]): Promise<void>;
  /** Hinweis zum Ergebnis (z. B. Felder, die in der Datei fehlen) – Schreiber, die ihn anzeigen können, nehmen ihn an */
  note?(text: string): void;
}

export const STREAM_BATCH = 2000;
/** … und höchstens so viele Bytes: 2000 Zeilen mit Dokumenten oder Bildern hielten sonst hunderte MB im Speicher */
export const STREAM_BYTES = 8 * 1024 * 1024;

/** grobe Größe einer Zeile im Speicher (für die Stapelgrenze) */
export function rowBytes(row: ExportCell[]): number {
  let n = 16;
  for (const v of row) n += Buffer.isBuffer(v) ? v.length : typeof v === 'string' ? v.length * 2 : 8;
  return n;
}

/**
 * Abbruch-Prüfung für lange Aufträge (Dump, Kopie, Vergleich): true = aufhören. signal bricht zusätzlich wartende
 * Server-Anfragen ab (streamTable) – die Prüfung allein greift erst, wenn der Server Zeilen liefert.
 */
export interface CancelCheck {
  (): boolean;
  signal?: AbortSignal;
}

export const ABORTED = 'Abgebrochen.';

/** Promise mit Frist: danach wird mit Fehler abgelehnt (das Promise selbst läuft weiter) */
export function withTimeout<T>(p: Promise<T>, ms: number, what = 'Der Vorgang'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} hat nach ${ms / 1000} s nicht geantwortet.`)), ms);
    timer.unref();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Wert für den Export: wie normalizeCell, aber Binärdaten vollständig */
export function exportCell(v: unknown): ExportCell {
  if (v instanceof Uint8Array) return Buffer.from(v);
  return normalizeCell(v);
}

/** Eigene Verbindung pro Abfrage-Tab: USE, Transaktionen und temporäre Tabellen bleiben erhalten. */
export interface Session {
  readonly database: string | undefined;
  setDatabase(database: string): Promise<void>;
  run(statements: StatementInput[], maxRows: number): Promise<QueryRun>;
  /** Ausführungsplan; analyze = mit Laufzeit (führt die Anweisungen aus) */
  explain(statements: StatementInput[], analyze: boolean): Promise<QueryPlan>;
  /**
   * Anweisung noch einmal ausführen und ihr Ergebnis Nr. resultIndex vollständig an sink geben (Export über
   * „max. Zeilen“ hinaus); wirft bei Fehler oder Abbruch. Ob die Anweisung nur liest, prüft der Aufrufer.
   */
  streamResult(statement: StatementInput, resultIndex: number, sink: RowSink): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  /** Verbindung ist getrennt (z. B. Leerlauf-Timeout eines Proxys) */
  readonly broken: boolean;
  /** in dieser Sitzung ist eine Transaktion offen (MySQL: nach bestem Wissen aus den Statusmeldungen) */
  readonly inTransaction: boolean;
  /**
   * MySQL: Autocommit ist an und keine Transaktion offen (Status der letzten OK-Antwort) – dann darf das Einspielen
   * Schreib-Anweisungen selbst in Transaktionen bündeln
   */
  readonly autocommitIdle?: boolean;
  /** ID der Verbindung auf dem Server (MySQL Thread-ID, PostgreSQL pid, SQL Server session_id) */
  readonly serverId?: string;
  /** zuletzt gestartete Anweisung (für die Sitzungsliste – der Server sähe dort OwlynDBs eigene Prüfabfragen) */
  readonly lastSql?: string;
  /** läuft gerade eine Abfrage? */
  readonly busy: boolean;
  /** Sicherheitsmodus: nur lesende Anweisungen, jede Ausführung wird zurückgerollt */
  readOnly: boolean;
  /** Lebenszeichen im Leerlauf, damit ein Proxy die Verbindung nicht schließt */
  ping(): Promise<void>;
  /** vor dem Ausführen: ist es noch dieselbe Verbindung? false = neu aufbauen */
  check(): Promise<boolean>;
  /** PostgreSQL: COPY … FROM STDIN mit Daten aus einer Datei (pg_dump) */
  copyIn?(sql: string): Promise<CopyTarget>;
}

export interface CopyTarget {
  write(chunk: string): Promise<void>;
  /** Rückgabe: Anzahl Zeilen */
  end(): Promise<number>;
  abort(): void;
}

export interface ExecResult {
  sets: { columns: ResultColumn[]; rows: Cell[][]; truncated: boolean; totalRows?: number; binaryCut?: boolean }[];
  rowsAffected?: number;
}

/**
 * Eine Ergebnismenge für die Anzeige: bis max Zeilen behalten, weitere nur zählen. So landet ein riesiges Ergebnis
 * nicht im Speicher, auch wenn der Server alles schickt.
 */
export class ResultCollector {
  readonly rows: Cell[][] = [];
  count = 0;
  private binaryCut = false;

  constructor(
    readonly columns: ResultColumn[],
    private readonly max: number,
    private readonly convert: (row: unknown[]) => Cell[],
  ) {}

  add(row: unknown[]): void {
    this.count++;
    if (this.rows.length >= this.max) return;
    if (!this.binaryCut) this.binaryCut = row.some((v) => v instanceof Uint8Array && v.length > HEX_LIMIT);
    this.rows.push(this.convert(row));
  }

  /** stoppedAt: nach so vielen Zeilen hört der Server von sich aus auf bzw. wurde aufgehört – dann ist die Gesamtzahl offen */
  result(stoppedAt?: number): ExecResult['sets'][number] {
    const truncated = this.count > this.max;
    const known = truncated && (stoppedAt === undefined || this.count > stoppedAt);
    return {
      columns: this.columns,
      rows: this.rows,
      truncated,
      ...(known ? { totalRows: this.count } : {}),
      ...(this.binaryCut ? { binaryCut: true } : {}),
    };
  }
}

/** Abfrage-Arten für BaseSession.prepare */
export type RunKind = 'run' | 'explain' | 'export';

/**
 * Zeilen aus einem Ereignis-Strom gebündelt und der Reihe nach in einen RowSink schreiben. Scheitert das Schreiben,
 * wird der Fehler gemerkt und alles Weitere verworfen; end() wirft ihn.
 */
export class SinkQueue {
  started = false;
  private batch: ExportCell[][] = [];
  private bytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private problem: { error: unknown } | null = null;

  constructor(private readonly sink: RowSink) {}

  get failed(): boolean {
    return this.problem !== null;
  }

  /** Fehler beim Schreiben (für Aufrufer, die daraufhin die Abfrage abbrechen) */
  get failure(): unknown {
    return this.problem?.error;
  }

  begin(columns: ResultColumn[]): void {
    this.started = true;
    this.enqueue(() => this.sink.begin(columns));
  }

  /** true = ein voller Stapel ist unterwegs: der Aufrufer soll das Lesen bis idle() anhalten */
  push(row: ExportCell[]): boolean {
    if (this.problem) return false;
    this.batch.push(row);
    this.bytes += rowBytes(row);
    if (this.batch.length < STREAM_BATCH && this.bytes < STREAM_BYTES) return false;
    this.flush();
    return true;
  }

  flush(): void {
    if (!this.batch.length) return;
    const b = this.batch;
    this.batch = [];
    this.bytes = 0;
    this.enqueue(() => this.sink.rows(b));
  }

  /** alles bisher Eingereihte ist geschrieben (oder gescheitert) – wird nie abgelehnt */
  idle(): Promise<void> {
    return this.chain;
  }

  async end(): Promise<void> {
    this.flush();
    await this.chain;
    if (this.problem) throw this.problem.error;
  }

  private enqueue(write: () => Promise<void>): void {
    this.chain = this.chain
      .then(async () => {
        if (!this.problem) await write();
      })
      .catch((e: unknown) => {
        this.problem ??= { error: e };
      });
  }
}

/** so lange darf ein Lebenszeichen (Ping im Leerlauf) ausbleiben, bevor die Verbindung als hängend gilt */
const PING_TIMEOUT_MS = 30_000;
/** so lange darf das serverseitige Abbrechen (eigene Verbindung, KILL QUERY …) dauern */
const CANCEL_TIMEOUT_MS = 15_000;
/** nach dem Abbrechen: so lange auf das Ende der Anweisung warten, dann die Verbindung hart trennen */
const CANCEL_GRACE_MS = 5_000;
/** so lange darf das ordentliche Trennen dauern, danach hart */
const CLOSE_TIMEOUT_MS = 3_000;

/** Gemeinsamer Ablauf: Anweisungen nacheinander, beim ersten Fehler oder Abbruch stoppen. */
export abstract class BaseSession implements Session {
  abstract readonly database: string | undefined;
  protected messages: string[] = [];
  /** Abbruch angefordert – Unterklassen prüfen es zwischen Cursor-Stapeln, wo ein serverseitiger Abbruch nicht greift */
  protected cancelRequested = false;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  broken = false;
  readOnly = false;
  lastSql?: string;
  abstract readonly inTransaction: boolean;
  protected abstract readonly dialect: Dialect;

  get busy(): boolean {
    return this.running;
  }

  abstract setDatabase(database: string): Promise<void>;
  /** ordentlich trennen (wartet, bis der Server die Verabschiedung bestätigt) */
  protected abstract closeConnection(): Promise<void>;
  /** hart trennen: Socket zerstören, eine laufende Anweisung endet beim Client sofort mit Verbindungsfehler */
  protected abstract destroyConnection(): void;
  protected abstract execOne(sql: string, maxRows: number): Promise<ExecResult>;
  /** Anweisung ausführen, Ergebnis Nr. resultIndex vollständig an sink, die übrigen verwerfen; false = so viele Ergebnisse gab es nicht */
  protected abstract streamOne(sql: string, resultIndex: number, sink: RowSink): Promise<boolean>;
  protected abstract cancelCurrent(): Promise<void>;
  /**
   * vor einer Ausführung (die Sitzung ist dann schon als beschäftigt markiert), z. B. MySQL: Zeilengrenze
   * des Servers setzen bzw. für Plan und Export aufheben
   */
  protected async prepare(_kind: RunKind, _statements: StatementInput[], _maxRows: number): Promise<void> {}
  /** Zustand nach der Ausführung nachführen (Datenbank nach USE, offene Transaktion) */
  protected abstract refreshDatabase(statements: StatementInput[]): Promise<void>;
  /** kleinste Abfrage an den Server */
  protected abstract pingOnce(): Promise<void>;
  /** ist der Fehler ein Verbindungsabbruch (und nicht z. B. eine abgebrochene Transaktion)? */
  protected abstract isConnectionLoss(e: unknown): boolean;
  /** Nur-lesen-Modus: Transaktion öffnen (MySQL/PostgreSQL READ ONLY) … */
  protected abstract beginReadOnly(): Promise<void>;
  /** … und immer zurückrollen */
  protected abstract endReadOnly(): Promise<void>;

  /**
   * Lebenszeichen im Leerlauf. Nicht bei offener Transaktion: sonst hielte der Ping eine vergessene
   * Transaktion samt Sperren am Leben und umginge Timeouts des Servers (z. B. idle_in_transaction_session_timeout).
   */
  async ping(): Promise<void> {
    if (this.running || this.broken || this.inTransaction) return;
    try {
      // mit Frist: eine stumme Verbindung (Proxy, Netz weg ohne RST) hielte sonst Schließen und Trennen auf
      await withTimeout(this.pingOnce(), PING_TIMEOUT_MS, 'Das Lebenszeichen');
    } catch (e) {
      if (this.isConnectionLoss(e)) this.broken = true;
      else if (/Lebenszeichen/.test(errorText(e))) {
        // hängt: Verbindung verwerfen, das nächste Ausführen im Tab baut neu auf („Verbindung war unterbrochen“)
        this.broken = true;
        this.destroyConnection();
      }
    }
  }

  async check(): Promise<boolean> {
    return !this.broken;
  }

  run(statements: StatementInput[], maxRows: number): Promise<QueryRun> {
    return this.execute(statements, (sql) => this.execOne(sql, maxRows), false, () => this.prepare('run', statements, maxRows));
  }

  async streamResult(statement: StatementInput, resultIndex: number, sink: RowSink): Promise<void> {
    let found = false;
    const r = await this.execute(
      [statement],
      async (sql) => {
        found = await this.streamOne(sql, resultIndex, sink);
        return { sets: [] };
      },
      false,
      () => this.prepare('export', [statement], 0),
    );
    const o = r.statements[0];
    if (o?.error) throw new Error(o.error);
    if (r.cancelled) throw new Error('Abgebrochen.');
    if (!found) throw new Error('Die Anweisung hat diesmal kein passendes Ergebnis geliefert – bitte neu ausführen und dann exportieren.');
  }

  /**
   * Ausführungsplan je Anweisung. Mit analyze laufen die Anweisungen dabei wirklich; „Nur lesen“ prüft und rollt
   * zurück wie bei run.
   */
  async explain(statements: StatementInput[], analyze: boolean): Promise<QueryPlan> {
    const plans = new Map<number, StatementPlan[]>();
    const r = await this.execute(
      statements,
      async (sql, idx) => {
        plans.set(idx, await this.explainOne(sql, analyze));
        return { sets: [] };
      },
      // ohne Laufzeit wird nichts ausgeführt: nach einem Fehler mit der nächsten Anweisung weitermachen
      !analyze,
      () => this.prepare('explain', statements, 0),
    );
    const out: StatementPlan[] = [];
    for (const o of r.statements) {
      if (o.error) out.push({ sql: o.sql, error: o.error, notes: [] });
      else out.push(...(plans.get(o.statementIndex) ?? []));
    }
    return {
      analyzed: analyze,
      statements: out,
      messages: r.messages,
      currentDatabase: r.currentDatabase,
      inTransaction: r.inTransaction,
      cancelled: r.cancelled,
      durationMs: r.durationMs,
    };
  }

  /** Plan einer Anweisung (SQL Server: eines Batches, daher evtl. mehrere) */
  protected abstract explainOne(sql: string, analyze: boolean): Promise<StatementPlan[]>;

  /**
   * Ablauf für run, explain und streamResult; keepGoing = nach einem Fehler mit der nächsten Anweisung weitermachen,
   * prepare läuft vorab (schlägt es fehl, wird nichts ausgeführt)
   */
  protected async execute(
    statements: StatementInput[],
    exec: (sql: string, index: number) => Promise<ExecResult>,
    keepGoing: boolean,
    prepare?: () => Promise<void>,
  ): Promise<QueryRun> {
    if (this.running) throw new Error('In diesem Tab läuft bereits eine Abfrage.');
    this.running = true;
    this.cancelRequested = false;
    this.messages = [];
    const results: QueryResultSet[] = [];
    const outcomes: StatementOutcome[] = [];
    const t0 = performance.now();
    const done = (): QueryRun => ({
      results,
      statements: outcomes,
      messages: this.messages,
      currentDatabase: this.database,
      inTransaction: this.inTransaction,
      cancelled: this.cancelRequested,
      durationMs: Math.round(performance.now() - t0),
    });
    // Nur lesen: erst alles prüfen, dann in einer Transaktion ausführen, die zurückgerollt wird
    let wrapped = false;
    /** Verbindung aufgeben (Rollback unklar) – erst nach dem Lauf, sonst wartete close() auf sich selbst */
    let abandon = false;
    try {
      if (prepare) {
        try {
          await prepare();
        } catch (e) {
          if (this.isConnectionLoss(e)) this.broken = true;
          outcomes.push({ statementIndex: 0, sql: statements[0]?.sql ?? '', durationMs: 0, resultSets: 0, error: errorText(e) });
          return done();
        }
      }
      if (this.readOnly) {
        // vor dem Umschalten begonnene Transaktion: nur ROLLBACK zulassen (START TRANSACTION würde sie bei MySQL festschreiben) –
        // und zwar die ganze Anweisung, nicht nur ihr Anfang (SQL Server: ein Batch kann dahinter weitergehen)
        const onlyRollback = statements.every((s) => /^\s*ROLLBACK(\s+(WORK|TRAN|TRANSACTION))?(\s+TO\s+(SAVEPOINT\s+)?[\w"`[\]@#.]+)?\s*;?\s*$/i.test(s.sql));
        if (this.inTransaction && !onlyRollback) {
          outcomes.push({
            statementIndex: 0,
            sql: statements[0]?.sql ?? '',
            durationMs: 0,
            resultSets: 0,
            error: 'Nur lesen: in diesem Tab ist noch eine Transaktion von vorher offen. Erlaubt ist nur ROLLBACK.',
          });
          return done();
        }
        if (!this.inTransaction) {
          for (let idx = 0; idx < statements.length; idx++) {
            const why = readOnlyViolation(statements[idx].sql, this.dialect);
            if (why) {
              outcomes.push({ statementIndex: idx, sql: statements[idx].sql, durationMs: 0, resultSets: 0, error: why + ' Es wurde nichts ausgeführt.' });
              return done();
            }
          }
          try {
            await this.beginReadOnly();
            wrapped = true;
          } catch (e) {
            if (this.isConnectionLoss(e)) this.broken = true;
            outcomes.push({ statementIndex: 0, sql: statements[0]?.sql ?? '', durationMs: 0, resultSets: 0, error: errorText(e) });
            return done();
          }
        }
      }
      for (let idx = 0; idx < statements.length; idx++) {
        if (this.cancelRequested) break;
        const st = statements[idx];
        this.lastSql = st.sql;
        const s0 = performance.now();
        try {
          const r = await exec(st.sql, idx);
          for (const set of r.sets) results.push({ statementIndex: idx, ...set });
          outcomes.push({
            statementIndex: idx,
            sql: st.sql,
            durationMs: Math.round(performance.now() - s0),
            resultSets: r.sets.length,
            rowsAffected: r.rowsAffected,
          });
        } catch (e) {
          outcomes.push({
            statementIndex: idx,
            sql: st.sql,
            durationMs: Math.round(performance.now() - s0),
            resultSets: 0,
            error: this.cancelRequested ? 'Abgebrochen.' : errorText(e),
          });
          if (!keepGoing || this.broken) break;
        }
      }
      if (wrapped) {
        wrapped = false;
        try {
          await this.endReadOnly();
        } catch {
          // Rollback unklar: Verbindung aufgeben, der Server rollt beim Trennen zurück
          abandon = true;
        }
      }
      if (!abandon) {
        try {
          await this.refreshDatabase(statements);
        } catch (e) {
          if (this.isConnectionLoss(e)) this.broken = true;
        }
      }
      return done();
    } finally {
      if (wrapped || abandon) this.broken = true;
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const wake of waiters) wake();
      if (wrapped || abandon) await this.close().catch(() => undefined);
    }
  }

  /** wartet, bis keine Anweisung mehr läuft; false = Frist abgelaufen */
  protected waitIdle(ms: number): Promise<boolean> {
    if (!this.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== wake);
        resolve(false);
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(wake);
    });
  }

  /**
   * Laufende Anweisung serverseitig abbrechen. Endet sie danach nicht (die Antwort kommt nie, weil ein Proxy oder NAT
   * die Verbindung still verworfen hat), wird die Verbindung nach einer Frist hart getrennt: die Ausführung endet mit
   * Verbindungsfehler, und der Tab baut beim nächsten Ausführen neu auf, statt für immer „läuft“ zu zeigen.
   */
  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelRequested = true;
    try {
      await withTimeout(this.cancelCurrent(), CANCEL_TIMEOUT_MS, 'Das Abbrechen');
    } catch (e) {
      this.messages.push(`Abbrechen: ${errorText(e)}`);
    }
    if (await this.waitIdle(CANCEL_GRACE_MS)) return;
    this.messages.push('Der Server hat das Abbrechen nicht bestätigt – die Verbindung wurde getrennt.');
    this.broken = true;
    this.destroyConnection();
    await this.waitIdle(1000);
  }

  /**
   * Sitzung schließen: eine laufende Anweisung wird vorher abgebrochen (sonst liefe ein UPDATE zu Ende und würde
   * festgeschrieben, obwohl „abgebrochen“ angekündigt war), das Trennen hat eine Frist – ein toter Server hält das
   * Beenden nicht auf.
   */
  async close(): Promise<void> {
    if (this.running) await this.cancel().catch(() => undefined);
    try {
      await withTimeout(this.closeConnection(), CLOSE_TIMEOUT_MS, 'Das Trennen');
    } catch {
      this.destroyConnection();
    }
  }
}

export function errorText(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length) return errorText(e.errors[0]);
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** Binärwerte bis zu dieser Länge erscheinen ganz (Schlüssel, Hashes, kleine Dateien), längere gekürzt */
export const HEX_LIMIT = 1024;
/** Texte in der Anzeige höchstens so lang (Zeichen): ein riesiger Wert ginge sonst ungekürzt an die Oberfläche */
export const TEXT_LIMIT = 1024 * 1024;

/** Werte so umwandeln, dass sie über IPC gehen und im Grid lesbar sind. */
export function normalizeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
      return v.length > TEXT_LIMIT ? `${v.slice(0, TEXT_LIMIT)}… (${v.length} Zeichen)` : v;
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
  }
  if (v instanceof Date) return formatDate(v);
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, HEX_LIMIT)).toString('hex').toUpperCase();
    return '0x' + hex + (v.length > HEX_LIMIT ? `… (${v.length} Bytes)` : '');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Datum in UTC-Bestandteilen ausgeben (Treiber liefern lokale DB-Zeit als UTC). */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  const iso = d.toISOString(); // 2024-01-02T03:04:05.678Z
  const ms = iso.slice(20, 23);
  const base = iso.slice(0, 10) + ' ' + iso.slice(11, 19);
  return ms === '000' ? base : base + '.' + ms;
}


/** Gemeinsame Bausteine für SELECT auf eine Tabelle. */
export interface TableSqlDialect {
  name: Dialect;
  quote(ident: string): string;
  /** voll qualifizierter Name */
  qualified(database: string, schema: string, name: string): string;
  /** Ausdruck, der eine Spalte als Text für LIKE liefert, oder null, wenn die Spalte nicht durchsucht wird */
  searchExpr(column: ColumnInfo): string | null;
  /** Ausdruck statt der nackten Spalte im SELECT (z. B. als Text, wo der Treiber Genauigkeit verlöre); undefined = die Spalte selbst */
  selectExpr?(column: ColumnInfo): string | undefined;
  /** z. B. "LIKE" oder "ILIKE" */
  likeOperator: string;
  /** Zusatz hinter dem Muster, z. B. " ESCAPE '\'" */
  likeEscape: string;
  /** Platzhalter für den n-ten Parameter (1-basiert) */
  param(n: number): string;
  /** Zeichenkette als SQL-Literal (nur für die angezeigte Abfrage) */
  literal(s: string): string;
  page(selectWithoutPaging: string, limit: number, offset: number, hasOrder: boolean): string;
}

/**
 * SELECT bzw. COUNT für die Tabellenansicht.
 * inline = Suchtext als Literal einsetzen (für die angezeigte, kopierbare Abfrage).
 */
export function buildTableQuery(
  d: TableSqlDialect,
  req: TableDataRequest,
  columns: ColumnInfo[],
  count: boolean,
  inline = false,
): { sql: string; params: unknown[] } {
  const { object } = req;
  // PostgreSQL-Vererbung: ohne ONLY lieferte die Elterntabelle auch die Zeilen ihrer Kinder (Dump, Teilmenge doppelt)
  const from = `${req.only && d.name === 'postgres' ? 'ONLY ' : ''}${d.qualified(object.database, object.schema, object.name)}`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.where?.trim()) {
    // die Bedingung darf die Klammer nicht verlassen (sonst ließe sich eine zweite Anweisung anhängen)
    const problem = checkWhere(req.where, d.name);
    if (problem) throw new Error(problem);
    where.push(`(${req.where.trim()})`);
  }
  if (req.search?.trim()) {
    const pattern = '%' + escapeLike(req.search.trim()) + '%';
    // MySQL: als Literal statt ?-Platzhalter – mysql2 ersetzt sonst der Reihe nach jedes ?, auch eines in der WHERE-Bedingung
    const asLiteral = inline || d.param(1) === '?';
    const p = asLiteral ? d.literal(pattern) : d.param(1);
    const parts: string[] = [];
    for (const c of columns) {
      const expr = d.searchExpr(c);
      if (expr) parts.push(`${expr} ${d.likeOperator} ${p}${d.likeEscape}`);
    }
    if (parts.length) {
      where.push('(' + parts.join('\n    OR ') + ')');
      if (!asLiteral) params.push(pattern);
    }
  }
  const whereSql = where.length ? '\nWHERE ' + where.join('\n  AND ') : '';
  if (count) return { sql: `SELECT COUNT(*) AS cnt FROM ${from}${whereSql}`, params };
  const known = new Set(columns.map((c) => c.name));
  // NULLS LAST nur, wo es nötig ist: PostgreSQL stellt NULL bei DESC an den Anfang, MySQL und SQL Server ans Ende
  const order = req.sort
    .filter((s) => known.has(s.column))
    .map((s) => `${d.quote(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}${s.nulls && d.name === 'postgres' ? ` NULLS ${s.nulls.toUpperCase()}` : ''}`);
  const orderSql = order.length ? '\nORDER BY ' + order.join(', ') : '';
  // Teil-Dump: nur bestimmte Spalten (Schlüssel, Fremdschlüssel), nur bekannte Namen
  for (const c of req.columns ?? []) if (!known.has(c)) throw new Error(`Spalte ${c} gibt es in ${object.name} nicht.`);
  const byName = new Map(columns.map((c) => [c.name, c]));
  const expr = (name: string) => {
    const c = byName.get(name);
    const e = c && d.selectExpr?.(c);
    return e ? `${e} AS ${d.quote(name)}` : d.quote(name);
  };
  // ausdrücklich statt *, wenn eine Spalte als Ausdruck gelesen wird oder versteckt ist (SELECT * ließe sie aus)
  const explicit = req.columns?.length ? req.columns : columns.some((c) => c.hidden || d.selectExpr?.(c)) ? columns.map((c) => c.name) : null;
  const list = explicit ? explicit.map(expr).join(', ') : '*';
  const select = `SELECT ${req.distinct ? 'DISTINCT ' : ''}${list}\nFROM ${from}${whereSql}${orderSql}`;
  // limit 0 = alle Zeilen (Export)
  // nur ganze Zahlen in LIMIT/OFFSET; limit 0 = alle Zeilen (Export)
  const limit = Math.max(0, Math.floor(Number(req.limit) || 0));
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const sql = limit > 0 ? d.page(select, limit, offset, order.length > 0) : select;
  return { sql, params };
}

export function escapeLike(s: string): string {
  // auch [ und ]: in SQL Server leiten sie im LIKE-Muster eine Zeichenklasse ein; in MySQL und PostgreSQL ist \[ ein wörtliches [
  return s.replace(/[\\%_[\]]/g, (m) => '\\' + m);
}

/** Datentyp-Namen, deren Werte im Grid rechtsbündig stehen */
export const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|money|smallmoney|int2|int4|int8|float4|float8|serial|bigserial|smallserial|year|bit)\b/i;
