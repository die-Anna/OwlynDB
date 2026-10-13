// Gemeinsame Typen für Electron-Hauptprozess und Angular-Oberfläche.
// Die Oberfläche importiert hier nur Typen (import type), der Hauptprozess kompiliert die Datei mit.

export type Dialect = 'mysql' | 'mssql' | 'postgres' | 'elasticsearch';
/** die SQL-Datenbanken – Dump, Vergleich, Bearbeiten usw. gibt es für Elasticsearch nicht */
export type SqlDialect = Exclude<Dialect, 'elasticsearch'>;

export const DIALECT_LABEL: Record<Dialect, string> = {
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
  postgres: 'PostgreSQL',
  elasticsearch: 'Elasticsearch',
};

export const DEFAULT_PORT: Record<Dialect, number> = {
  mysql: 3306,
  mssql: 1433,
  postgres: 5432,
  elasticsearch: 9200,
};

export interface ConnectionOptions {
  /** Sicherheitsmodus: Abfrage-Tabs führen nur lesende Anweisungen aus, jede Ausführung wird zurückgerollt */
  readOnly?: boolean;
  /** SQL Server: Verbindung verschlüsseln */
  encrypt?: boolean;
  /** SQL Server: selbstsigniertes Zertifikat akzeptieren */
  trustServerCertificate?: boolean;
  /** MySQL/PostgreSQL: TLS verwenden */
  ssl?: boolean;
  /**
   * TLS-Tunnel: die ganze Verbindung von Anfang an per TLS (für Proxys wie nginx/HAProxy/stunnel,
   * die das Client-Zertifikat prüfen). Zertifikate und Prüfungen gelten dann für den Tunnel.
   */
  tunnel?: boolean;
  /** MySQL/PostgreSQL bzw. Tunnel: Serverzertifikat gegen CA prüfen (sonst nur verschlüsseln) */
  verifyServer?: boolean;
  /** MySQL/PostgreSQL: zusätzlich prüfen, ob das Zertifikat zum Hostnamen passt */
  verifyHostname?: boolean;
  /** PEM-Datei der Zertifizierungsstelle (alle drei; SQL Server: zum Prüfen des Serverzertifikats) */
  caFile?: string;
  /** MySQL/PostgreSQL: Client-Zertifikat (PEM) */
  certFile?: string;
  /** MySQL/PostgreSQL: privater Schlüssel zum Client-Zertifikat (PEM, ggf. mit Passwort) */
  keyFile?: string;
  /** SNI-Name für den TLS-Tunnel, wenn er vom Server abweicht (z. B. Proxy per IP-Adresse) */
  servername?: string;
  /**
   * SSH-Tunnel (wie ssh -L): Server/Port der Verbindung sind dann das Ziel aus Sicht des SSH-Servers.
   * Mit tunnel läuft SSH selbst im TLS-Tunnel (wie ProxyCommand openssl s_client -cert …).
   */
  ssh?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  /** privater Schlüssel; leer = ~/.ssh/id_ed25519, id_ecdsa, id_rsa */
  sshKeyFile?: string;
  /** Elasticsearch: das Passwortfeld enthält einen API-Key (Base64, wie ihn Elasticsearch als „encoded“ liefert) */
  apiKey?: boolean;
}

/** Eine gespeicherte Verbindung, wie die Oberfläche sie sieht (ohne Passwort). */
export interface SavedConnection {
  id: string;
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  user: string;
  /** Standard-Datenbank; bei PostgreSQL auch die Datenbank für die erste Verbindung */
  database?: string;
  options?: ConnectionOptions;
  /** Farbmarkierung, z. B. rot für Produktion */
  color?: string;
  hasPassword: boolean;
  /** Passwort für den Client-Schlüssel ist gespeichert */
  hasKeyPassphrase?: boolean;
  /** SSH-Passwort bzw. Passwort des SSH-Schlüssels ist gespeichert */
  hasSshSecret?: boolean;
}

/** Eingabe beim Anlegen/Ändern. password/keyPassphrase/sshSecret undefined = gespeicherten Wert behalten. */
export interface ConnectionInput extends Omit<SavedConnection, 'id' | 'hasPassword' | 'hasKeyPassphrase' | 'hasSshSecret'> {
  id?: string;
  password?: string;
  keyPassphrase?: string;
  sshSecret?: string;
}

/** Darstellung der Oberfläche */
export type ThemeMode = 'system' | 'light' | 'dark';

/** cert: CA bzw. Zertifikat als PEM; clientCert: Client-Zertifikat, auch PKCS#12 (.p12/.pfx) */
export type FileKind = 'cert' | 'clientCert' | 'key' | 'ssh' | 'sql' | 'settings';

/** Einstellungen exportieren */
export interface SettingsExportOptions {
  connectionIds: string[];
  savedQueries: boolean;
  history: boolean;
  /** Passwörter mitnehmen, mit diesem Export-Passwort verschlüsselt; leer = ohne Passwörter */
  password?: string;
}

/** Vorschau vor dem Import: was in der Datei steht und was es hier schon gibt */
export interface SettingsPreview {
  file: string;
  exportedAt: string;
  /** die Datei enthält (verschlüsselte) Passwörter */
  hasSecrets: boolean;
  /** mit dem angegebenen Export-Passwort geöffnet */
  secretsOpen: boolean;
  connections: {
    index: number;
    name: string;
    dialect: Dialect;
    host: string;
    port: number;
    user: string;
    database?: string;
    color?: string;
    /** Passwort o. Ä. in der Datei (nur bekannt, wenn geöffnet) */
    hasSecret: boolean;
    /** schon vorhandene Verbindung (gleiche ID, gleicher Name oder gleicher Server) */
    match?: { id: string; name: string; by: 'id' | 'name' | 'server'; differences: string[] };
    /** Zertifikats- oder Schlüsseldateien, die es auf diesem PC nicht gibt */
    missingFiles: string[];
  }[];
  savedQueries: { total: number; fresh: number };
  history: { total: number; fresh: number };
}

export interface SettingsImportRequest {
  file: string;
  password?: string;
  connections: { index: number; action: 'new' | 'replace' | 'skip' }[];
  savedQueries: boolean;
  history: boolean;
}

export interface SettingsImportResult {
  created: number;
  replaced: number;
  skipped: number;
  savedQueries: number;
  history: number;
  notes: string[];
  /** Verbindungen, die sich nicht übernehmen ließen (Grund in notes) */
  failed?: number;
}

/** Dump einer Datenbank als SQL-Datei */
export interface DumpRequest {
  connectionId: string;
  database: string;
  tables: { schema: string; name: string }[];
  views: { schema: string; name: string }[];
  structure: boolean;
  data: boolean;
  /** vorher DROP … IF EXISTS */
  dropFirst: boolean;
  /** Prozeduren, Funktionen und Trigger mitnehmen (nur gleicher Datenbanktyp) */
  routines?: boolean;
  /** Datenbanktyp, für den das SQL geschrieben wird */
  targetDialect: Dialect;
  rowsPerInsert: number;
  /** Vorschlag für den Dateinamen */
  baseName: string;
  /**
   * Test-Datenbank aus Prod: je Tabelle nur ein Teil der Zeilen (fehlt = alle). Zeilen, auf die per Fremdschlüssel
   * verwiesen wird, kommen immer mit – sonst passt die Kopie nicht zusammen.
   */
  subset?: { schema: string; name: string; rule: RowRule }[];
  /** Tabellen, auf die verwiesen wird, die aber nicht gewählt sind, mitnehmen (nur die nötigen Zeilen) */
  addReferenced?: boolean;
  /** Personendaten ersetzen: je Spalte eine Regel; gleicher Wert → gleicher Ersatz */
  anonymize?: { schema: string; table: string; column: string; rule: AnonRule }[];
}

/** Teilmenge einer Tabelle */
export type RowRule =
  | { kind: 'all' }
  | { kind: 'none' }
  /** die letzten count Zeilen nach column (absteigend) */
  | { kind: 'last'; count: number; column: string }
  | { kind: 'where'; where: string }
  /**
   * Zeilen, die per Fremdschlüssel auf mitkommende Zeilen einer Tabelle mit eigener Auswahl (die letzten …, WHERE,
   * selbst abhängig) verweisen – z. B. die Positionen der gewählten Bestellungen
   */
  | { kind: 'dependent' };

/** Ersatz für Personendaten */
export type AnonRule = 'name' | 'firstname' | 'lastname' | 'email' | 'phone' | 'iban' | 'street' | 'birthdate' | 'pseudonym' | 'empty';

/** SQL-Datei in eine Datenbank einspielen */
export interface ImportRequest {
  connectionId: string;
  /** Zieldatenbank (bei createDatabase: wird angelegt) */
  database: string;
  createDatabase: boolean;
  file: string;
  /** beim ersten Fehler aufhören (sonst Fehler sammeln und weitermachen) */
  stopOnError: boolean;
  /** alles in einer Transaktion (PostgreSQL, SQL Server): Fehler = nichts eingespielt */
  transaction: boolean;
  /** USE-Anweisungen der Datei überspringen (sie würden auf die Quell-Datenbank wechseln) */
  skipUse: boolean;
}

/** Objekte direkt in eine andere Datenbank kopieren (Dump und Einspielen in einem Schritt, ohne Datei) */
export interface CopyRequest {
  /** Quelle: Objekte und Inhalt wie beim Dump (Zieltyp = Typ der Zielverbindung) */
  source: Omit<DumpRequest, 'targetDialect' | 'baseName'>;
  targetConnectionId: string;
  /** Zieldatenbank (bei createDatabase: wird angelegt) */
  targetDatabase: string;
  createDatabase: boolean;
  /** beim ersten Fehler aufhören (sonst Fehler sammeln und weitermachen) */
  stopOnError: boolean;
  /** alles in einer Transaktion (PostgreSQL, SQL Server): Fehler = nichts übernommen */
  transaction: boolean;
}

/** eine Änderung aus der Tabellenansicht (Bearbeiten-Modus) */
export interface RowChange {
  kind: 'update' | 'insert' | 'delete';
  /** update/delete: Schlüsselspalten mit ihrem ursprünglichen Wert */
  key?: Record<string, Cell>;
  /** update: geänderte Spalten mit neuem Wert; insert: gesetzte Spalten (der Rest bekommt den Standardwert) */
  values?: Record<string, Cell>;
  /** update: ursprüngliche Werte der geänderten Spalten (erkennt Änderungen durch andere in der Zwischenzeit) */
  original?: Record<string, Cell>;
}

export interface ApplyChangesRequest {
  object: ObjectRef;
  changes: RowChange[];
  /** nur die Anweisungen zeigen, nichts ausführen */
  preview: boolean;
}

export interface ApplyChangesResult {
  /** die Anweisungen mit eingesetzten Werten (zur Anzeige) */
  statements: string[];
  /** ausgeführte Anweisungen (0 bei preview) */
  applied: number;
}

/** Spalte im ER-Diagramm */
export interface ErColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

/** Tabelle im ER-Diagramm; schema leer bei MySQL */
export interface ErTable {
  schema: string;
  name: string;
  columns: ErColumn[];
  /** geschätzte Zeilenzahl aus dem Katalog */
  rows?: number;
}

/** Fremdschlüssel; refSchema bei MySQL: '' = gleiche Datenbank, sonst die andere Datenbank */
export interface ErForeignKey {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

/** alle Tabellen eines Schemas (MySQL: einer Datenbank) mit Spalten und Fremdschlüsseln */
export interface ErModel {
  tables: ErTable[];
  foreignKeys: ErForeignKey[];
}

/** eine Sitzung (Verbindung) auf dem Server */
export interface ServerSession {
  /** MySQL Thread-ID, PostgreSQL pid, SQL Server session_id */
  id: string;
  /** Beginn der Sitzung (PostgreSQL, SQL Server) – schützt das Beenden vor wiederverwendeten IDs */
  started?: string;
  user?: string;
  /** Adresse des Clients bzw. Rechnername */
  client?: string;
  program?: string;
  database?: string;
  /** Zustand in den Worten des Servers, z. B. "active", "idle in transaction", "Sleep", "running" */
  state: string;
  /** führt gerade eine Abfrage aus */
  active: boolean;
  /** Sekunden: Laufzeit der aktuellen Abfrage bzw. Dauer des Zustands */
  seconds?: number;
  /** Sekunden seit Beginn der offenen Transaktion */
  txSeconds?: number;
  /** worauf die Sitzung wartet, z. B. "Lock: transactionid" oder "LCK_M_X" */
  wait?: string;
  /** Sitzungen, die diese blockieren */
  blockedBy: string[];
  /** aktuelle bzw. letzte Abfrage */
  query?: string;
  /** Hintergrundprozess des Servers (z. B. autovacuum, event_scheduler) */
  system?: boolean;
}

export interface ServerSessionList {
  sessions: ServerSession[];
  /** Kennung des Servers, auf dem die Liste entstand – Abbrechen/Beenden nur auf genau diesem */
  server: string;
  /** Sitzung, über die OwlynDB die Liste holt */
  self?: string;
  /** Abfrage-Tabs dieses Programms: ID auf dem Server → Sitzung der Oberfläche */
  own: Record<string, string>;
  /** eine Abfrage abbrechen, ohne die Sitzung zu beenden (SQL Server kann das nicht) */
  canCancelQuery: boolean;
  /** Verbindung steht auf „Nur lesen“: nur Anzeige */
  readOnly: boolean;
  durationMs: number;
}

/** ein ausgeführter Abfrage-Teil im Verlauf */
export interface HistoryEntry {
  id: string;
  /** ISO-Zeitpunkt */
  at: string;
  connectionId: string;
  /** Name der Verbindung zum Zeitpunkt der Ausführung */
  connection: string;
  database?: string;
  sql: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** z. B. "120 Zeilen" oder "3 Zeilen betroffen" */
  info?: string;
}

export interface HistoryQuery {
  connectionId?: string;
  /** alle Wörter müssen vorkommen (SQL, Datenbank, Verbindung) */
  search?: string;
  limit?: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  /** Datenbanktyp, für den die Abfrage geschrieben wurde */
  dialect?: Dialect;
  updated: string;
}

export interface SavedQueryInput {
  id?: string;
  name: string;
  sql: string;
  dialect?: Dialect;
}

/** eine Seite des Datenvergleichs; schema leer bei MySQL */
export interface DataCompareSide {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
}

export interface DataCompareRequest {
  /** so soll es sein */
  source: DataCompareSide;
  /** wird angeglichen */
  target: DataCompareSide;
  /** Spalten, über die Zeilen einander zugeordnet werden (Namen der Quelle); leer = Primärschlüssel bzw. eindeutiger Index */
  key?: string[];
  /** verglichene Spalten; leer = alle, die es auf beiden Seiten gibt */
  columns?: string[];
  /** Bedingung für beide Seiten (ohne das Wort WHERE) */
  where?: string;
  ignoreCase?: boolean;
  ignoreTrailingSpaces?: boolean;
}

export type DataDiffStatus = 'onlySource' | 'onlyTarget' | 'different';

export interface DataDiffRow {
  status: DataDiffStatus;
  /** Werte der verglichenen Spalten (wie columns) in der Quelle bzw. im Ziel */
  source?: Cell[];
  target?: Cell[];
  /** unterschiedliche Spalten (Index in columns) */
  changed?: number[];
  /** Anweisung, die das Ziel angleicht (INSERT, UPDATE bzw. DELETE, mit Semikolon) */
  sql: string;
}

export interface DataCompareResult {
  /** Datenbanktyp des Ziels (Skript) */
  dialect: Dialect;
  /** verglichene Spalten, Schlüssel zuerst (Namen der Quelle) */
  columns: ResultColumn[];
  key: string[];
  counts: Record<DataDiffStatus | 'same', number>;
  /** nach Schlüssel sortiert, höchstens limit je Art */
  rows: DataDiffRow[];
  limit: number;
  /** vor bzw. nach den Einfügungen (SQL Server IDENTITY_INSERT, PostgreSQL Sequenz nachziehen) */
  insertBefore: string[];
  insertAfter: string[];
  warnings: string[];
  durationMs: number;
}

/** Datenvergleich aller Tabellen eines Schemas (MySQL: einer Datenbank): je Tabelle nur die Zahlen */
export interface DataCompareAllRequest {
  source: Omit<DataCompareSide, 'table'>;
  target: Omit<DataCompareSide, 'table'>;
  /** nur diese Tabellen (Namen der Quelle); leer = alle, die es auf beiden Seiten gibt */
  tables?: string[];
  /** eigene Schlüsselspalten je Tabelle (Name der Quelle → Spalten); sonst Primärschlüssel bzw. eindeutiger Index */
  keys?: Record<string, string[]>;
  ignoreCase?: boolean;
  ignoreTrailingSpaces?: boolean;
}

export interface DataCompareAllResult {
  /** Datenbanktyp des Ziels */
  dialect: Dialect;
  tables: {
    source: string;
    target: string;
    key?: string[];
    counts?: Record<DataDiffStatus | 'same', number>;
    /** z. B. kein Schlüssel – die übrigen Tabellen wurden trotzdem verglichen */
    error?: string;
    /** weder Primärschlüssel noch eindeutiger Index ohne NULL: Schlüsselspalten wählen (keys) */
    noKey?: boolean;
    warnings: string[];
    durationMs: number;
  }[];
  /** Tabellen nur auf einer Seite (nicht verglichen) */
  onlySource: string[];
  onlyTarget: string[];
  durationMs: number;
}

/** Abgleich-Skript ohne Obergrenze direkt als Datei (Speichern-Dialog, dann Auftrag) */
export interface DataCompareScriptRequest {
  /** eine Tabelle … */
  table?: DataCompareRequest;
  /** … oder alle (bzw. die gewählten) Tabellen eines Schemas */
  all?: DataCompareAllRequest;
  /** DELETE für Zeilen, die es nur im Ziel gibt; sonst auskommentiert */
  includeDeletes: boolean;
}

export interface JobStatus {
  id: string;
  kind: 'dump' | 'import' | 'copy' | 'datacompare';
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** Dump und Kopieren: Zeilen; Import: gelesene Bytes */
  done: number;
  total?: number;
  /** Import: ausgeführte Anweisungen */
  statements: number;
  /** was gerade läuft (Tabelle, Zeile) */
  current: string;
  file?: string;
  error?: string;
  /** Hinweise (übersprungene Objekte) und gesammelte Fehler */
  log: string[];
  durationMs: number;
}

export interface ServerInfo {
  version: string;
  /** Datenbank, die beim Verbinden aktiv ist */
  currentDatabase?: string;
}

export type ObjectKind = 'table' | 'view';

export interface DbObject {
  name: string;
  kind: ObjectKind;
  /** geschätzte Zeilenzahl, falls die Datenbank sie billig liefert */
  rows?: number;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment?: string;
  /** berechnete Spalte: der Ausdruck (PostgreSQL GENERATED … AS (…) STORED, MySQL GENERATED, SQL Server AS …; dann kein defaultValue) */
  generated?: string;
  /** berechnete Spalte wird gespeichert (STORED/PERSISTED) statt beim Lesen gerechnet */
  stored?: boolean;
  /** PostgreSQL: GENERATED ALWAYS | BY DEFAULT AS IDENTITY (autoIncrement ist dann auch gesetzt) */
  identity?: 'always' | 'default';
  /** MySQL: ON UPDATE CURRENT_TIMESTAMP(n) – der Ausdruck */
  onUpdate?: string;
  /** SQL Server rowversion/timestamp: der Server setzt den Wert, einfügen lässt er sich nicht */
  rowversion?: boolean;
  /** SQL Server HIDDEN (Periodenspalten der Systemversionierung): SELECT * lässt sie aus */
  hidden?: boolean;
}

export interface IndexInfo {
  name: string;
  /** Spaltennamen; Ausdrücke als Text (keine Spalte der Tabelle) */
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** gehört zu einer UNIQUE-Einschränkung (PostgreSQL, SQL Server): löschen und anlegen über ALTER TABLE … CONSTRAINT */
  constraint?: boolean;
  /** Art außer dem gewöhnlichen B-Baum (FULLTEXT, SPATIAL, gin, gist, hash, CLUSTERED …) */
  kind?: string;
  /** Bedingung eines Teilindex (PostgreSQL WHERE, SQL Server Filter) */
  where?: string;
  /**
   * Spaltenliste und Eigenschaften im Wortlaut des Servers – für denselben Datenbanktyp: Präfixlängen, Sortierrichtung,
   * Ausdrücke, INCLUDE, WHERE (PostgreSQL ab USING …, MySQL und SQL Server ab der Klammer)
   */
  definition?: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** ON DELETE: CASCADE, SET NULL, SET DEFAULT, RESTRICT; fehlt = NO ACTION */
  onDelete?: string;
  /** ON UPDATE: wie onDelete */
  onUpdate?: string;
}

/** CHECK-Einschränkung einer Tabelle */
export interface CheckInfo {
  name: string;
  /** Ausdruck in Klammern, wie der Server ihn liefert */
  expression: string;
  /** MariaDB: CHECK direkt an der Spalte (heißt wie sie) – im Ziel ohne Namen anlegen */
  column?: boolean;
}

export interface TableInfo {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** Fremdschlüssel anderer Tabellen, die auf diese zeigen */
  referencedBy: IncomingKey[];
  checks?: CheckInfo[];
  /** MySQL: Kollation der Tabelle (Zeichensatz = Teil vor dem ersten _) */
  collation?: string;
  /** Besonderheit, die ein CREATE TABLE aus Spalten nicht abbildet: partitioniert, Fremdtabelle, versioniert */
  special?: string;
}

/** Fremdschlüssel einer anderen Tabelle, der auf diese Tabelle zeigt (MySQL: schema = Datenbank) */
export interface IncomingKey {
  name: string;
  schema: string;
  table: string;
  /** Spalten in der verweisenden Tabelle */
  columns: string[];
  /** Spalten in dieser Tabelle */
  refColumns: string[];
}

export type RoutineKind = 'procedure' | 'function' | 'trigger';

/** Prozedur, Funktion oder Trigger im Objektbaum */
export interface RoutineInfo {
  name: string;
  kind: RoutineKind;
  /** Trigger: Tabelle, zu der er gehört */
  table?: string;
  /** PostgreSQL: Argumente (unterscheidet überladene Funktionen) */
  args?: string;
}

export type SearchKind = 'table' | 'view' | 'column' | RoutineKind;

/** Treffer der Objektsuche */
export interface SearchHit {
  database: string;
  /** leer bei MySQL */
  schema: string;
  kind: SearchKind;
  /** Tabelle, View oder Routine; bei Spalten die Tabelle bzw. View */
  name: string;
  /** Spalte */
  column?: string;
  /** Spaltentyp */
  dataType?: string;
  /** bei Spalten: Tabelle oder View */
  objectKind?: ObjectKind;
  /** Trigger: Tabelle */
  table?: string;
  /** PostgreSQL-Routinen: Argumente */
  args?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** mehr Treffer als angezeigt */
  truncated: boolean;
  /** Datenbanken, die sich nicht durchsuchen ließen (z. B. keine Berechtigung) */
  skipped: string[];
}

/** eine Seite des Schema-Vergleichs; schema leer bei MySQL */
export interface CompareSide {
  connectionId: string;
  database: string;
  schema: string;
}

export interface CompareRequest {
  /** so soll es sein */
  source: CompareSide;
  /** wird angeglichen */
  target: CompareSide;
}

/**
 * Phasen des Abgleich-Skripts: alte Fremdschlüssel/Indizes weg, Tabellen anlegen/ändern, neue Indizes/Fremdschlüssel,
 * Views, Routinen; 'drop' = Löschungen (Spalten und Objekte, die es nur im Ziel gibt) – standardmäßig auskommentiert.
 */
export type ComparePhase = 'pre' | 'tables' | 'post' | 'views' | 'routines' | 'drop';

export interface CompareItem {
  kind: 'table' | 'view' | RoutineKind;
  name: string;
  /** Trigger: Tabelle */
  table?: string;
  /** PostgreSQL-Routinen: Argumente */
  args?: string;
  status: 'onlySource' | 'onlyTarget' | 'different';
  /** Unterschiede in Worten */
  details: string[];
  /** fertige Anweisungen (mit Trennzeichen) je Phase */
  script: Partial<Record<ComparePhase, string[]>>;
}

export interface CompareResult {
  dialect: Dialect;
  items: CompareItem[];
  /** gleiche Objekte (nicht aufgeführt) */
  same: number;
  warnings: string[];
}

export interface RoutineRef extends RoutineInfo {
  connectionId: string;
  database: string;
  schema: string;
}

/** Adresse eines Objekts. schema ist bei MySQL leer (Datenbank = Schema). */
export interface ObjectRef {
  connectionId: string;
  database: string;
  schema: string;
  name: string;
  kind: ObjectKind;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
  /** PostgreSQL: wohin NULL sortiert (sonst bei DESC an den Anfang) */
  nulls?: 'first' | 'last';
}

export interface TableDataRequest {
  object: ObjectRef;
  limit: number;
  offset: number;
  sort: SortSpec[];
  /** freie WHERE-Bedingung (ohne das Wort WHERE) */
  where?: string;
  /** Text, der in irgendeiner Spalte vorkommen soll */
  search?: string;
  /** intern (Teil-Dump): nur diese Spalten statt aller */
  columns?: string[];
  /** intern: DISTINCT */
  distinct?: boolean;
  /** intern: beim Streamen höchstens so viele Zeilen (die ersten nach sort) */
  top?: number;
  /** intern (Dump): Sitzung auf UTC, damit TIMESTAMP-Werte unabhängig von der Zeitzone des Servers herauskommen */
  utc?: boolean;
  /** intern (Dump, Teilmenge): PostgreSQL FROM ONLY – ohne die Zeilen von Kindtabellen (Vererbung) */
  only?: boolean;
}

export type Cell = string | number | boolean | null;

export interface ResultColumn {
  name: string;
  typeName: string;
  numeric: boolean;
}

export interface TableDataResult {
  columns: ResultColumn[];
  rows: Cell[][];
  /** die tatsächlich ausgeführte Abfrage (zum Übernehmen in ein Abfrage-Fenster) */
  sql: string;
  durationMs: number;
}

export interface StatementInput {
  sql: string;
  /** Position der Anweisung im Editor-Text, für Fehlermarkierung */
  offset: number;
}

export interface QueryResultSet {
  statementIndex: number;
  columns: ResultColumn[];
  rows: Cell[][];
  /** es gab mehr Zeilen als maxRows */
  truncated: boolean;
  /** abgeschnitten, aber die Zahl aller Zeilen ist bekannt (der Server hat sie geschickt, sie wurden nur gezählt) */
  totalRows?: number;
  /** mindestens ein Binärwert ist in der Anzeige gekürzt (über 1 KB) – vollständig nur über den Export mit erneuter Ausführung */
  binaryCut?: boolean;
  /** Name des Reiters (Elasticsearch: „Treffer“, „Aggregation …“, „JSON“); fehlt = „Ergebnis n“ */
  label?: string;
  /** Elasticsearch: Antwort als Text statt Tabelle (JSON bzw. die Textausgabe von _cat) */
  text?: string;
  textFormat?: 'json' | 'text';
}

export interface StatementOutcome {
  statementIndex: number;
  sql: string;
  durationMs: number;
  /** Anzahl Ergebnismengen dieser Anweisung */
  resultSets: number;
  rowsAffected?: number;
  error?: string;
}

export interface QueryRun {
  results: QueryResultSet[];
  statements: StatementOutcome[];
  /** Meldungen des Servers (PRINT, NOTICE, Warnungen) */
  messages: string[];
  /** Datenbank nach der Ausführung (z. B. nach USE) */
  currentDatabase?: string;
  /** nach der Ausführung ist eine Transaktion offen */
  inTransaction?: boolean;
  /** Sitzung war getrennt und wurde neu aufgebaut; es wurde nichts ausgeführt */
  reconnected?: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** ein Schritt im Ausführungsplan */
export interface PlanNode {
  /** Operation, z. B. "Seq Scan", "Nested loop inner join", "Clustered Index Seek" */
  op: string;
  /** Objekt und Bedingung in Kurzform, z. B. "on kunden k · (ort = 'Bern')" */
  detail?: string;
  /** geschätzte Zeilen je Durchlauf */
  rows?: number;
  /** tatsächliche Zeilen je Durchlauf (Durchschnitt) */
  actualRows?: number;
  /** tatsächliche Durchläufe */
  loops?: number;
  /** geschätzte Kosten, wie die Datenbank sie meldet (mit den Schritten darunter; Einheit je Datenbank) */
  cost?: number;
  /** tatsächliche Zeit in ms mit den Schritten darunter, über alle Durchläufe */
  timeMs?: number;
  /** tatsächliche Zeit in ms nur dieses Schritts */
  selfMs?: number;
  /** Anteil nur dieses Schritts an der ganzen Anweisung (0–1): nach Zeit, sonst nach geschätzten Kosten */
  share?: number;
  /** Auffälligkeiten, z. B. "Schätzung zu niedrig: 10 statt 9 000 Zeilen" */
  warnings: string[];
  /** alle Angaben der Datenbank zu diesem Schritt */
  props: [string, string][];
  children: PlanNode[];
}

/** Plan einer Anweisung (SQL Server: einer Anweisung im Batch) */
export interface StatementPlan {
  sql: string;
  root?: PlanNode;
  /** kein Plan: Fehlermeldung */
  error?: string;
  /** Hinweise zur ganzen Anweisung, z. B. fehlender Index (SQL Server) */
  notes: string[];
  /** worauf sich share bezieht; fehlt = weder Zeiten noch Kosten bekannt */
  shareBy?: 'time' | 'cost';
  totalCost?: number;
  planningMs?: number;
  executionMs?: number;
  /** Ausgabe der Datenbank zum Weitergeben (JSON, XML oder Text) */
  raw?: string;
  rawFormat?: 'json' | 'xml' | 'text';
}

export interface QueryPlan {
  /** mit Laufzeit: die Anweisungen wurden dabei ausgeführt */
  analyzed: boolean;
  statements: StatementPlan[];
  messages: string[];
  currentDatabase?: string;
  inTransaction?: boolean;
  /** Sitzung war getrennt und wurde neu aufgebaut; es wurde nichts ausgeführt */
  reconnected?: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface CompletionTable {
  schema: string;
  name: string;
  kind: ObjectKind;
  columns: string[];
}

export interface CompletionInfo {
  tables: CompletionTable[];
  /**
   * Wo der Server Namen ohne Schema sucht, in dieser Reihenfolge: SQL Server das Standardschema des Benutzers, dann dbo;
   * PostgreSQL der search_path. Fehlt bei MySQL (ein Schema je Datenbank) und Elasticsearch.
   */
  searchPath?: string[];
}

export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'sql';

export const EXPORT_EXT: Record<ExportFormat, string> = { csv: 'csv', xlsx: 'xlsx', json: 'json', sql: 'sql' };

export interface ExportOptions {
  format: ExportFormat;
  /** CSV: Trennzeichen */
  delimiter?: ';' | ',' | '\t';
  /** CSV: Spaltennamen in der ersten Zeile */
  header?: boolean;
  /** CSV: UTF-8 mit BOM, damit Excel Umlaute richtig liest */
  bom?: boolean;
  /** SQL: Tabellenname im INSERT (wird nicht gequotet, darf Schema enthalten) */
  sqlTable?: string;
  /** SQL: Dialekt für Quoting und Literale */
  dialect?: Dialect;
  /** SQL: Zeilen pro INSERT */
  rowsPerInsert?: number;
  /** Vorschlag für den Dateinamen (ohne Endung) */
  baseName: string;
  /** Tabellen-Export: Kennzeichen, mit dem cancelExport ihn abbricht */
  cancelToken?: string;
  /** CSV: Textzellen, die mit =, +, -, @ beginnen, mit Apostroph schützen (Excel wertete sie sonst als Formel aus); Vorgabe an */
  protectFormulas?: boolean;
}

/** mehr Datenzeilen fasst ein Excel-Blatt nicht (plus Kopfzeile) */
export const EXCEL_MAX_ROWS = 1_048_575;

export interface ExportResult {
  file: string;
  rows: number;
  durationMs: number;
  /** Hinweise, z. B. in Excel gekürzte Zellen */
  notes?: string[];
}

/** Alle Aufrufe vom Fenster in den Hauptprozess. */
export interface DbvApi {
  listConnections(): Promise<SavedConnection[]>;
  saveConnection(input: ConnectionInput): Promise<SavedConnection>;
  /** Kopie mit allen Einstellungen und den gespeicherten Passwörtern, Name „… (Kopie)“, direkt hinter dem Original */
  duplicateConnection(id: string): Promise<SavedConnection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(input: ConnectionInput): Promise<ServerInfo>;
  /** Datei-Auswahl des Betriebssystems; null = abgebrochen */
  pickFile(kind: FileKind, current?: string): Promise<string | null>;
  /** Darstellung (wie Windows, hell, dunkel): Titelleiste und native Dialoge folgen, gilt auch beim nächsten Start;
   *  Rückgabe: dunkel ja/nein danach (bei „wie Windows“ die Windows-Einstellung) */
  setTheme(mode: ThemeMode): Promise<boolean>;

  connect(connectionId: string): Promise<ServerInfo>;
  /** neuer Treiber (der alte schließt, sobald laufende Aufträge fertig sind); Abfrage-Tabs bleiben offen */
  reconnect(connectionId: string): Promise<ServerInfo>;
  disconnect(connectionId: string): Promise<void>;
  listDatabases(connectionId: string): Promise<string[]>;
  /** leer bei MySQL */
  listSchemas(connectionId: string, database: string): Promise<string[]>;
  listObjects(connectionId: string, database: string, schema: string): Promise<DbObject[]>;
  /** Prozeduren, Funktionen, Trigger */
  listRoutines(connectionId: string, database: string, schema: string): Promise<RoutineInfo[]>;
  /** Text der Routine als Skript zum Ansehen/Ändern im Abfrage-Tab */
  getRoutineDdl(ref: RoutineRef): Promise<string>;
  /** Tabellen, Views, Spalten, Routinen nach Namen suchen (alle Datenbanken der Verbindung) */
  /** token: Kennzeichen für cancelSearch (eine neuere Eingabe bricht die ältere Suche ab) */
  searchObjects(connectionId: string, text: string, token?: string): Promise<SearchResult>;
  /** laufende Objektsuche abbrechen: sie fragt keine weitere Datenbank mehr ab */
  cancelSearch(token: string): Promise<void>;
  /** Struktur zweier Datenbanken/Schemas vergleichen (gleicher Datenbanktyp), mit Abgleich-Skript */
  compareSchemas(req: CompareRequest): Promise<CompareResult>;
  describeTable(ref: ObjectRef): Promise<TableInfo>;
  /** Tabellen mit Spalten und Fremdschlüsseln eines Schemas (MySQL: der Datenbank) für das ER-Diagramm */
  erModel(connectionId: string, database: string, schema: string): Promise<ErModel>;
  getDdl(ref: ObjectRef): Promise<string>;
  fetchTable(req: TableDataRequest): Promise<TableDataResult>;
  countTable(req: TableDataRequest): Promise<number>;
  completionInfo(connectionId: string, database: string): Promise<CompletionInfo>;

  /** schon geladene Zeilen (Abfrage-Ergebnis, aktuelle Seite) speichern; null = Speichern abgebrochen */
  exportRows(columns: ResultColumn[], rows: Cell[][], opts: ExportOptions): Promise<ExportResult | null>;
  /** ganze Tabelle mit Filter/Sortierung aus req (limit/offset werden ignoriert) als Stream speichern */
  exportTable(req: TableDataRequest, opts: ExportOptions): Promise<ExportResult | null>;
  /** laufenden Tabellen-Export mit diesem Kennzeichen (ExportOptions.cancelToken) abbrechen */
  cancelExport(token: string): Promise<void>;
  /**
   * Abfrage-Ergebnis vollständig speichern: die (nur lesende) Anweisung läuft im Tab noch einmal, ihr Ergebnis Nr.
   * resultIndex (0 = erstes dieser Anweisung) geht als Stream in die Datei – über „max. Zeilen“ hinaus, Binärwerte ganz.
   */
  exportQuery(sessionId: string, statement: StatementInput, resultIndex: number, opts: ExportOptions): Promise<ExportResult | null>;
  showInFolder(file: string): Promise<void>;
  /** ER-Diagramm als SVG-Datei speichern (Dialog); null = abgebrochen */
  saveSvg(baseName: string, svg: string): Promise<string | null>;

  openSession(connectionId: string, database?: string): Promise<{ sessionId: string; database?: string }>;
  closeSession(sessionId: string): Promise<void>;
  /** Sitzungen und laufende Abfragen des Servers (soweit die Rechte reichen) */
  listServerSessions(connectionId: string): Promise<ServerSessionList>;
  /** Abfrage abbrechen (query) bzw. Sitzung beenden (session) – nicht bei „Nur lesen“, nur auf dem Server der Liste */
  killServerSession(connectionId: string, target: { id: string; started?: string; server: string }, mode: 'query' | 'session'): Promise<void>;
  /** Rückgabe: Hinweis, falls die Sitzung dabei neu aufgebaut werden musste */
  setSessionDatabase(sessionId: string, database: string): Promise<string | null>;
  /** Abfrage-Tabs, die gerade laufen oder eine offene Transaktion haben (Rückfrage beim Schließen) */
  sessionState(sessionId: string): Promise<{ busy: boolean; inTransaction: boolean }>;
  runQuery(sessionId: string, statements: StatementInput[], maxRows: number): Promise<QueryRun>;
  /** Ausführungsplan; analyze = mit Laufzeit, dabei werden die Anweisungen wirklich ausgeführt */
  explainQuery(sessionId: string, statements: StatementInput[], analyze: boolean): Promise<QueryPlan>;
  cancelQuery(sessionId: string): Promise<void>;

  /** Speichern-Dialog, dann Dump im Hintergrund; null = abgebrochen */
  startDump(req: DumpRequest): Promise<string | null>;
  startImport(req: ImportRequest): Promise<string>;
  /** Objekte direkt in eine andere Datenbank kopieren (Hintergrund-Auftrag) */
  startCopy(req: CopyRequest): Promise<string>;
  /** Daten zweier Tabellen vergleichen (Hintergrund-Auftrag); das Ergebnis danach mit dataCompareResult holen */
  startDataCompare(req: DataCompareRequest): Promise<string>;
  dataCompareResult(jobId: string): Promise<DataCompareResult>;
  /** alle Tabellen eines Schemas vergleichen (nur zählen); Ergebnis mit dataCompareAllResult */
  startDataCompareAll(req: DataCompareAllRequest): Promise<string>;
  dataCompareAllResult(jobId: string): Promise<DataCompareAllResult>;
  /** Speichern-Dialog, dann das ganze Abgleich-Skript als Datei (Auftrag); null = abgebrochen */
  startDataCompareScript(req: DataCompareScriptRequest): Promise<string | null>;
  jobStatus(jobId: string): Promise<JobStatus>;
  cancelJob(jobId: string): Promise<void>;

  /** Einstellungen als Datei speichern (Dialog); null = abgebrochen */
  exportSettings(opts: SettingsExportOptions): Promise<string | null>;
  previewSettings(file: string, password?: string): Promise<SettingsPreview>;
  importSettings(req: SettingsImportRequest): Promise<SettingsImportResult>;

  /** Abfrage-Verlauf, neueste zuerst */
  listHistory(q: HistoryQuery): Promise<HistoryEntry[]>;
  /** Anzahl der Verlaufseinträge je Verbindung (ohne SQL-Text) */
  historyCounts(): Promise<Record<string, number>>;
  /** ohne connectionId: ganzer Verlauf */
  clearHistory(connectionId?: string): Promise<void>;
  listSavedQueries(): Promise<SavedQuery[]>;
  saveQuery(q: SavedQueryInput): Promise<SavedQuery>;
  deleteSavedQuery(id: string): Promise<void>;

  /** Änderungen aus der Tabellenansicht: Vorschau oder in einer Transaktion ausführen */
  applyChanges(req: ApplyChangesRequest): Promise<ApplyChangesResult>;
  /** Tabellen mit ungespeicherten Änderungen (Namen): Beenden und Neu laden fragen dann nach */
  setUnsavedTables(names: string[]): Promise<void>;
}

export type DbvMethod = keyof DbvApi;

/** Antwortform über IPC, damit Fehlermeldungen ohne Electron-Präfix ankommen. */
export type IpcReply<T> = { ok: true; value: T } | { ok: false; error: string };
