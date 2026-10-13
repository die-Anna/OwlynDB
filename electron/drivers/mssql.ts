import { randomBytes } from 'node:crypto';
import sql from 'mssql';
import type {
  Cell,
  CheckInfo,
  ColumnInfo,
  CompletionInfo,
  DbObject,
  ErModel,
  ForeignKeyInfo,
  IndexInfo,
  ObjectKind,
  ResultColumn,
  ServerInfo,
  TableDataRequest,
  TableDataResult,
  TableInfo,
  RoutineInfo,
  SearchHit,
  StatementInput,
  StatementPlan,
  ServerSession,
} from '../../shared/api-types';
import { readOnlyViolation, stoppableResults } from '../../shared/sql-guard';
import { mssqlPlans } from '../plan';
import {
  ABORTED,
  BaseSession,
  buildTableQuery,
  checkAffected,
  searchHit,
  DriverConfig,
  ExecResult,
  erModelFrom,
  errorText,
  exportCell,
  formatDate,
  KILL_TEXT,
  groupIncoming,
  MetaDriver,
  normalizeCell,
  NUMERIC_TYPE,
  ResultCollector,
  RowSink,
  RunKind,
  Session,
  ServerSessions,
  SinkQueue,
  STREAM_BATCH,
  STREAM_BYTES,
  rowBytes,
  TableSqlDialect,
  TypeDdl,
  withTimeout,
  WriteOp,
} from './common';
import type { ExportCell } from '../export';
import { connectTunnel } from './tunnel';

const quote = (s: string) => '[' + s.replace(/]/g, ']]') + ']';

const TOKEN_KEY = 'owlyndb.sitzung';

const NOT_SEARCHABLE = /^(image|varbinary|binary|timestamp|rowversion|geography|geometry|hierarchyid|sql_variant)\b/i;

/**
 * Spalten, die tedious nur verlustbehaftet liefert, als Text lesen: decimal/numeric über 15 Stellen und money (JS-Double),
 * datetime2/time/datetimeoffset (nur Millisekunden, Zeitzone verloren). Stil 121 = yyyy-mm-dd hh:mi:ss.nnnnnnn [+hh:mm].
 */
function exactExpr(c: ColumnInfo): string | undefined {
  const t = c.dataType.toLowerCase();
  const m = /^(decimal|numeric)\((\d+),(\d+)\)$/.exec(t);
  if (m && Number(m[2]) > 15) return `CONVERT(varchar(50), ${quote(c.name)})`;
  if (t === 'money' || t === 'smallmoney') return `CONVERT(varchar(50), ${quote(c.name)}, 2)`;
  if (/^(datetime2|time|datetimeoffset)\(/.test(t)) return `CONVERT(varchar(40), ${quote(c.name)}, 121)`;
  return undefined;
}

const dialect: TableSqlDialect = {
  name: 'mssql',
  quote,
  qualified: (db, schema, name) => `${quote(db)}.${quote(schema)}.${quote(name)}`,
  searchExpr: (c) => (NOT_SEARCHABLE.test(c.dataType) ? null : `CAST(${quote(c.name)} AS NVARCHAR(MAX))`),
  selectExpr: exactExpr,
  likeOperator: 'LIKE',
  likeEscape: " ESCAPE '\\'",
  param: (n) => '@p' + n,
  literal: (s) => "N'" + s.replace(/'/g, "''") + "'",
  page: (select, limit, offset, hasOrder) => {
    if (!hasOrder && offset === 0) return select.replace(/^SELECT (DISTINCT )?/, `SELECT $1TOP (${limit}) `);
    const order = hasOrder ? '' : '\nORDER BY (SELECT NULL)';
    return `${select}${order}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  },
};

interface MssqlColumn {
  name: string;
  type?: { declaration?: string };
  precision?: number;
  scale?: number;
}

function columnsOf(cols: MssqlColumn[]): ResultColumn[] {
  return cols.map((c) => {
    const t = c.type?.declaration ?? '';
    // Nachkommastellen bzw. Genauigkeit im Typnamen mitführen: 346 erscheint als 346.00, datetime2(7) mit allen Stellen
    const typeName =
      (t === 'decimal' || t === 'numeric') && c.scale != null
        ? `${t}(${c.precision},${c.scale})`
        : (t === 'datetime2' || t === 'time' || t === 'datetimeoffset') && c.scale != null
          ? `${t}(${c.scale})`
          : t;
    return { name: c.name, typeName, numeric: NUMERIC_TYPE.test(t) && t !== 'bit' };
  });
}

/**
 * Spalten, die als Text gelesen wurden (exactExpr), bekommen Typ und Zahl-Kennzeichen der Tabelle zurück – so bleibt die
 * Anzeige (rechtsbündig, Typ in der Spaltenliste) wie bei einer Zahl
 */
function restoreTypes(cols: ResultColumn[], info: ColumnInfo[]): ResultColumn[] {
  const byName = new Map(info.filter((c) => exactExpr(c)).map((c) => [c.name, c]));
  return cols.map((c) => {
    const i = byName.get(c.name);
    return i ? { ...c, typeName: i.dataType, numeric: NUMERIC_TYPE.test(i.dataType) } : c;
  });
}

/** kürzeste Dezimaldarstellung, die als float32 rundläuft (tedious erweitert real auf double: 3.14 wäre sonst 3.140000104904175) */
function shortestReal(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return String(s);
  }
  return String(v);
}

/** Zeitstempel mit den Stellen unter der Millisekunde (tedious hängt sie als nanosecondsDelta an die Date) */
function dateText(v: Date, scale: number): string {
  const base = formatDate(v).slice(0, 19);
  if (scale <= 0) return base;
  const nd = (v as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0;
  const frac = (v.getUTCMilliseconds() / 1000 + nd).toFixed(scale).slice(2);
  return `${base}.${frac}`;
}

/** date/time-Spalten nicht als volle Zeitstempel zeigen; Genauigkeit von datetime2/time/datetimeoffset und real erhalten */
function cellFor(typeName: string) {
  if (typeName === 'date') return (v: unknown): Cell => (v instanceof Date ? (normalizeCell(v) as string).slice(0, 10) : normalizeCell(v));
  const dt = /^(datetime2|time|datetimeoffset)(?:\((\d)\))?$/.exec(typeName);
  if (dt) {
    const scale = dt[2] === undefined ? 7 : Number(dt[2]);
    // datetimeoffset: tedious liefert den UTC-Zeitpunkt, die ursprüngliche Zone ist weg – als UTC kennzeichnen
    const tail = dt[1] === 'datetimeoffset' ? ' +00:00' : '';
    return (v: unknown): Cell => (v instanceof Date ? (dt[1] === 'time' ? dateText(v, scale).slice(11) : dateText(v, scale)) + tail : normalizeCell(v));
  }
  if (typeName === 'real') return (v: unknown): Cell => (typeof v === 'number' && Number.isFinite(v) ? shortestReal(v) : normalizeCell(v));
  const m = /^(?:decimal|numeric)\(\d+,(\d+)\)$/.exec(typeName);
  const scale = m ? Number(m[1]) : /money$/.test(typeName) ? 4 : -1;
  // Dezimalwerte kommen als JS-Zahl; als Text mit fester Stellenzahl wie in SSMS
  if (scale >= 0) return (v: unknown): Cell => (typeof v === 'number' ? v.toFixed(scale) : normalizeCell(v));
  return normalizeCell;
}

/** Dezimalspalten, die tedious nur gerundet liefert (freie Abfragen; die Tabellenansicht liest sie exakt) */
function lossyDecimals(cols: ResultColumn[]): string[] {
  return cols.filter((c) => /^(decimal|numeric)\((\d+),/.test(c.typeName) && Number(/\((\d+),/.exec(c.typeName)![1]) > 15).map((c) => `${c.name} (${c.typeName})`);
}

function convertRows(rows: unknown[][], cols: ResultColumn[]): Cell[][] {
  const conv = cols.map((c) => cellFor(c.typeName));
  return rows.map((r) => r.map((v, i) => (conv[i] ?? normalizeCell)(v)));
}

function formatType(t: string, maxLength: number, precision: number, scale: number): string {
  switch (t) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${t}(${maxLength === -1 ? 'max' : maxLength})`;
    case 'nvarchar':
    case 'nchar':
      return `${t}(${maxLength === -1 ? 'max' : maxLength / 2})`;
    case 'decimal':
    case 'numeric':
      return `${t}(${precision},${scale})`;
    case 'datetime2':
    case 'time':
    case 'datetimeoffset':
      return `${t}(${scale})`;
    default:
      return t;
  }
}

function poolConfig(cfg: DriverConfig, database: string | undefined, max: number, requestTimeout: number): sql.config {
  return {
    server: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: database || undefined,
    connectionTimeout: 10000,
    requestTimeout,
    pool: { max, min: 0, idleTimeoutMillis: max === 1 ? 2_147_483_647 : 60000 },
    options: {
      // Vorgabe verschlüsselt (sonst ginge das Passwort nur XOR-verschleiert über die Leitung) und geprüft – passend zum
      // Häkchen im Dialog, das ohne gespeicherten Wert „aus“ zeigt. Im TLS-Tunnel gehört das Zertifikat zum Tunnel: innen
      // ohne Verschlüsselung bzw. ungeprüft. Über eine SSH-Weiterleitung (target) gilt eine CA dem Proxy davor, nicht SQL Server.
      encrypt: cfg.encrypt ?? !cfg.tunnel,
      trustServerCertificate: cfg.tunnel ? (cfg.trustServerCertificate ?? true) : cfg.tls?.ca && !cfg.target ? false : (cfg.trustServerCertificate ?? false),
      // SSH-Weiterleitung oder Tunnel: Zertifikat gegen den echten Servernamen prüfen (tedious nimmt sonst 127.0.0.1)
      ...(cfg.servername || cfg.target?.host ? { serverName: cfg.servername || cfg.target?.host } : {}),
      // eigene CA zum Prüfen des Serverzertifikats (SQL Server kennt keine Client-Zertifikate)
      ...(cfg.tunnel
        ? {
            // tedious ruft den Connector mit (opts, lookup, signal) auf – die Typdefinition von mssql kennt die Argumente nicht
            connector: ((_opts: unknown, _lookup: unknown, signal?: AbortSignal) => connectTunnel(cfg, signal, 10000)) as unknown as () => ReturnType<typeof connectTunnel>,
          }
        : cfg.tls?.ca
          ? { cryptoCredentialsDetails: { ca: cfg.tls.ca } }
          : {}),
      useUTC: true,
      enableArithAbort: true,
      appName: 'OwlynDB',
    },
  };
}

export class MssqlDriver implements MetaDriver {
  private pool?: sql.ConnectionPool;
  private ready?: Promise<sql.ConnectionPool>;
  /** laufende Tabellen-Ströme (Export, Dump, Kopie, Vergleich): close() bricht sie ab, statt auf sie zu warten */
  private streams = new Set<() => void>();
  /** sys.tables.temporal_type gibt es ab SQL Server 2016; davor ohne den Filter auf History-Tabellen */
  private temporal = true;

  constructor(private cfg: DriverConfig) {}

  /**
   * Pool beim ersten Bedarf aufbauen. Scheitert der Aufbau (Server weg, Anmeldung), bleibt der Treiber nicht vergiftet:
   * der nächste Aufruf versucht es neu.
   */
  private connected(): Promise<sql.ConnectionPool> {
    if (!this.ready) {
      const pool = new sql.ConnectionPool(poolConfig(this.cfg, this.cfg.database, 4, 60000));
      pool.on('error', () => undefined);
      this.ready = pool.connect().then(
        () => {
          this.pool = pool;
          return pool;
        },
        (e: unknown) => {
          this.ready = undefined;
          throw e;
        },
      );
    }
    return this.ready;
  }

  /** Katalogabfrage mit dem Filter gegen History-Tabellen (frag); vor SQL Server 2016 ohne ihn */
  private async catalog<T>(fn: (historyFree: string) => Promise<T>): Promise<T> {
    const db = quote(this.cfg.database ?? 'master');
    void db;
    try {
      return await fn(this.temporal ? 'AND NOT EXISTS (SELECT 1 FROM sys.tables ht WHERE ht.object_id = o.object_id AND ht.temporal_type = 1)' : '');
    } catch (e) {
      if (!this.temporal || !/temporal_type/i.test(errorText(e))) throw e;
      this.temporal = false;
      return fn('');
    }
  }

  private async q<T>(text: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const pool = await this.connected();
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) req.input(k, v);
    const r = await req.query(text);
    return r.recordset as unknown as T[];
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; db: string }>(
      "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) + ' ' + CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS v, DB_NAME() AS db",
    );
    return { version: 'SQL Server ' + r.v, currentDatabase: r.db };
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.q<{ name: string }>('SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name');
    return rows.map((r) => r.name);
  }

  async listSchemas(database: string): Promise<string[]> {
    const db = quote(database);
    // auch Schemas, die nur Prozeduren, Funktionen oder Trigger enthalten (der Baum lädt sie unter dem Schema)
    const rows = await this.q<{ name: string }>(
      `SELECT s.name FROM ${db}.sys.schemas s
        WHERE s.name = 'dbo' OR EXISTS (SELECT 1 FROM ${db}.sys.objects o
                                         WHERE o.schema_id = s.schema_id AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR') AND o.is_ms_shipped = 0)
        ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name`,
    );
    return rows.map((r) => r.name);
  }

  async listObjects(database: string, schema: string): Promise<DbObject[]> {
    const db = quote(database);
    // ohne History-Tabellen der Systemversionierung: sie gehören zu ihrer Haupttabelle (DROP/Vergleich scheiterten daran)
    const rows = await this.catalog((historyFree) =>
      this.q<{ name: string; type: string; rows: number | string | null }>(
        `SELECT o.name, RTRIM(o.type) AS type,
                (SELECT SUM(p.rows) FROM ${db}.sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rows
           FROM ${db}.sys.objects o JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ${historyFree.replace('sys.tables', `${db}.sys.tables`)}
          ORDER BY o.name`,
        { schema },
      ),
    );
    return rows.map((r) => ({ name: r.name, kind: r.type === 'V' ? 'view' : 'table', rows: r.rows == null ? undefined : Number(r.rows) }));
  }

  private async columns(database: string, schema: string, table: string): Promise<(ColumnInfo & { seed?: string; incr?: string })[]> {
    const db = quote(database);
    const rows = await this.q<{
      name: string;
      type: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
      is_identity: boolean;
      def: string | null;
      pk: boolean;
      comment: string | null;
      seed: string | null;
      incr: string | null;
      computed: string | null;
      persisted: boolean | null;
      hidden: boolean | null;
    }>(
      `SELECT c.name, t.name AS type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
              dc.definition AS def, ${this.temporal ? 'c.is_hidden' : 'CAST(0 AS bit)'} AS hidden,
              CAST(CASE WHEN EXISTS (SELECT 1 FROM ${db}.sys.index_columns ic
                                       JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                      WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id)
                        THEN 1 ELSE 0 END AS bit) AS pk,
              CAST(ep.value AS nvarchar(4000)) AS comment,
              CAST(idc.seed_value AS nvarchar(50)) AS seed, CAST(idc.increment_value AS nvarchar(50)) AS incr,
              cc.definition AS computed, cc.is_persisted AS persisted
         FROM ${db}.sys.columns c
         JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id
         JOIN ${db}.sys.objects o ON o.object_id = c.object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
         LEFT JOIN ${db}.sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
         LEFT JOIN ${db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
         LEFT JOIN ${db}.sys.extended_properties ep
                ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
        WHERE s.name = @schema AND o.name = @name
        ORDER BY c.column_id`,
      { schema, name: table },
    );
    return rows.map((r) => ({
      name: r.name,
      dataType: formatType(r.type, r.max_length, r.precision, r.scale),
      nullable: r.is_nullable,
      defaultValue: r.computed ? null : r.def,
      primaryKey: r.pk,
      autoIncrement: r.is_identity,
      comment: r.comment ?? undefined,
      seed: r.seed ?? undefined,
      incr: r.incr ?? undefined,
      // berechnete Spalte: Ausdruck statt Standardwert; rowversion (Katalogname timestamp) setzt der Server selbst
      ...(r.computed ? { generated: r.computed, stored: !!r.persisted } : {}),
      ...(r.type === 'timestamp' ? { rowversion: true } : {}),
      // HIDDEN-Periodenspalten (Systemversionierung): SELECT * ließe sie aus, der Dump braucht sie
      ...(r.hidden ? { hidden: true } : {}),
    }));
  }

  /** ER-Diagramm: Tabellen, Spalten und Fremdschlüssel des Schemas in drei Abfragen */
  async erModel(database: string, schema: string): Promise<ErModel> {
    const db = quote(database);
    const tables = await this.catalog((historyFree) =>
      this.q<{ name: string; est: number | null }>(
        `SELECT t.name, SUM(p.rows) AS est
           FROM ${db}.sys.tables t JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
           LEFT JOIN ${db}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
          WHERE s.name = @schema ${historyFree ? 'AND t.temporal_type <> 1' : ''} GROUP BY t.name ORDER BY t.name`,
        { schema },
      ),
    );
    const cols = await this.q<{ t: string; c: string; type: string; max_length: number; precision: number; scale: number; nullable: boolean; pk: boolean }>(
      `SELECT t.name AS t, c.name AS c, ty.name AS type, c.max_length, c.precision, c.scale, c.is_nullable AS nullable,
              CAST(CASE WHEN EXISTS (SELECT 1 FROM ${db}.sys.index_columns ic
                                       JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                      WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id)
                        THEN 1 ELSE 0 END AS bit) AS pk
         FROM ${db}.sys.columns c
         JOIN ${db}.sys.tables t ON t.object_id = c.object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
         JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE s.name = @schema ORDER BY t.name, c.column_id`,
      { schema },
    );
    const fks = await this.q<{ name: string; t: string; c: string; rs: string; rt: string; rc: string }>(
      `SELECT fk.name, t.name AS t, pc.name AS c, rs.name AS rs, rt.name AS rt, rc.name AS rc
         FROM ${db}.sys.foreign_keys fk
         JOIN ${db}.sys.tables t ON t.object_id = fk.parent_object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
         JOIN ${db}.sys.objects rt ON rt.object_id = fk.referenced_object_id
         JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE s.name = @schema ORDER BY t.name, fk.name, fkc.constraint_column_id`,
      { schema },
    );
    return erModelFrom(
      tables.map((t) => ({ schema, name: t.name, rows: t.est == null ? undefined : Number(t.est) })),
      cols.map((c) => ({ schema, table: c.t, name: c.c, type: formatType(c.type, c.max_length, c.precision, c.scale), nullable: c.nullable, pk: c.pk })),
      fks.map((f) => ({ name: f.name, schema, table: f.t, column: f.c, refSchema: f.rs, refTable: f.rt, refColumn: f.rc })),
    );
  }

  async describeTable(database: string, schema: string, name: string): Promise<TableInfo> {
    const db = quote(database);
    const columns = (await this.columns(database, schema, name)).map(({ seed: _s, incr: _i, ...c }) => c);
    const idx = await this.q<{ name: string; is_unique: boolean; is_primary_key: boolean; is_unique_constraint: boolean; type_desc: string; filter: string | null; col: string; desc: boolean; included: boolean }>(
      `SELECT i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc, i.filter_definition AS filter,
              col.name AS col, ic.is_descending_key AS [desc], ic.is_included_column AS included
         FROM ${db}.sys.indexes i
         JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${db}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
         JOIN ${db}.sys.objects o ON o.object_id = i.object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name AND i.type > 0
        ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id`,
      { schema, name },
    );
    const indexes = new Map<string, IndexInfo & { keys: string[]; incl: string[] }>();
    for (const r of idx) {
      let i = indexes.get(r.name);
      if (!i) {
        i = { name: r.name, columns: [], unique: r.is_unique, primary: r.is_primary_key, keys: [], incl: [] };
        if (r.is_unique_constraint) i.constraint = true;
        // gewöhnlich ist NONCLUSTERED (und CLUSTERED für den Primärschlüssel); CLUSTERED ohne Primärschlüssel, XML, SPATIAL, COLUMNSTORE … sind etwas anderes
        if (r.type_desc !== 'NONCLUSTERED' && !(r.type_desc === 'CLUSTERED' && r.is_primary_key)) i.kind = r.type_desc;
        if (r.filter) i.where = r.filter;
        indexes.set(r.name, i);
      }
      if (r.included) i.incl.push(quote(r.col));
      else {
        i.columns.push(r.col);
        i.keys.push(`${quote(r.col)}${r.desc ? ' DESC' : ''}`);
      }
    }
    const list: IndexInfo[] = [...indexes.values()].map(({ keys, incl, ...i }) => ({
      ...i,
      definition: `(${keys.join(', ')})${incl.length ? ` INCLUDE (${incl.join(', ')})` : ''}${i.where ? ` WHERE ${i.where}` : ''}`,
    }));
    const fk = await this.q<{ name: string; col: string; refSchema: string; refTable: string; refCol: string; del: string; upd: string }>(
      `SELECT fk.name, pc.name AS col, rs.name AS refSchema, ro.name AS refTable, rc.name AS refCol,
              fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd
         FROM ${db}.sys.foreign_keys fk
         JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${db}.sys.objects ro ON ro.object_id = fkc.referenced_object_id
         JOIN ${db}.sys.schemas rs ON rs.schema_id = ro.schema_id
         JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         JOIN ${db}.sys.objects o ON o.object_id = fk.parent_object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name
        ORDER BY fk.name, fkc.constraint_column_id`,
      { schema, name },
    );
    const rule = (r: string | null) => (r && r !== 'NO_ACTION' ? r.replace(/_/g, ' ') : undefined);
    const fks = new Map<string, ForeignKeyInfo>();
    for (const r of fk) {
      let f = fks.get(r.name);
      if (!f) {
        f = { name: r.name, columns: [], refSchema: r.refSchema, refTable: r.refTable, refColumns: [] };
        const onDelete = rule(r.del);
        const onUpdate = rule(r.upd);
        if (onDelete) f.onDelete = onDelete;
        if (onUpdate) f.onUpdate = onUpdate;
        fks.set(r.name, f);
      }
      f.columns.push(r.col);
      f.refColumns.push(r.refCol);
    }
    const inc = await this.q<{ name: string; sch: string; tbl: string; col: string; refCol: string }>(
      `SELECT fk.name, s.name AS sch, o.name AS tbl, pc.name AS col, rc.name AS refCol
         FROM ${db}.sys.foreign_keys fk
         JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         JOIN ${db}.sys.objects o ON o.object_id = fk.parent_object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         JOIN ${db}.sys.objects ro ON ro.object_id = fk.referenced_object_id
         JOIN ${db}.sys.schemas rs ON rs.schema_id = ro.schema_id
        WHERE rs.name = @schema AND ro.name = @name
        ORDER BY s.name, o.name, fk.name, fkc.constraint_column_id`,
      { schema, name },
    );
    const ck = await this.q<{ name: string; def: string }>(
      `SELECT cc.name, cc.definition AS def FROM ${db}.sys.check_constraints cc
         JOIN ${db}.sys.objects o ON o.object_id = cc.parent_object_id JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name ORDER BY cc.name`,
      { schema, name },
    );
    const checks: CheckInfo[] = ck.map((c) => ({ name: c.name, expression: c.def }));
    // Besonderheiten, die ein CREATE TABLE aus Spalten verliert (die Spalten gibt es erst ab SQL Server 2014/2016)
    let special: string | undefined;
    try {
      const [meta] = await this.q<{ temporal: number; mem: boolean; parts: number }>(
        `SELECT t.temporal_type AS temporal, t.is_memory_optimized AS mem,
                (SELECT COUNT(*) FROM ${db}.sys.indexes i JOIN ${db}.sys.partition_schemes ps ON ps.data_space_id = i.data_space_id WHERE i.object_id = t.object_id) AS parts
           FROM ${db}.sys.tables t JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @schema AND t.name = @name`,
        { schema, name },
      );
      special = Number(meta?.temporal) === 2 ? 'versioniert (SYSTEM_VERSIONING)' : Number(meta?.parts) > 0 ? 'partitioniert' : meta?.mem ? 'speicheroptimiert (MEMORY_OPTIMIZED)' : undefined;
    } catch {
      // älterer Server
    }
    return { columns, indexes: list, foreignKeys: [...fks.values()], referencedBy: groupIncoming(inc), checks, ...(special ? { special } : {}) };
  }

  /** Aliastypen (CREATE TYPE … FROM), die Spalten der Tabellen benutzen; CLR-Typen nur als Hinweis */
  async typeDdl(database: string, schema: string, tables: string[]): Promise<TypeDdl[]> {
    if (!tables.length) return [];
    const db = quote(database);
    const rows = await this.q<{ schema: string; name: string; base: string; max_length: number; precision: number; scale: number; is_nullable: boolean; clr: boolean }>(
      `SELECT DISTINCT ts.name AS [schema], t.name, bt.name AS base, t.max_length, t.precision, t.scale, t.is_nullable, t.is_assembly_type AS clr
         FROM ${db}.sys.columns c
         JOIN ${db}.sys.objects o ON o.object_id = c.object_id
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id AND t.is_user_defined = 1
         JOIN ${db}.sys.schemas ts ON ts.schema_id = t.schema_id
         JOIN ${db}.sys.types bt ON bt.user_type_id = t.system_type_id
        WHERE s.name = @schema AND o.name IN (${tables.map((_, i) => `@t${i}`).join(', ')})
        ORDER BY ts.name, t.name`,
      { schema, ...Object.fromEntries(tables.map((t, i) => [`t${i}`, t])) },
    );
    return rows.map(
      (r): TypeDdl =>
        r.clr
          ? { schema: r.schema, name: r.name, kind: 'TYPE', note: `Der CLR-Typ ${r.name} wird nicht mitgenommen – er muss im Ziel vorhanden sein.` }
          : {
              schema: r.schema,
              name: r.name,
              kind: 'TYPE',
              ddl: `CREATE TYPE ${quote(r.schema)}.${quote(r.name)} FROM ${formatType(r.base, r.max_length, r.precision, r.scale)} ${r.is_nullable ? 'NULL' : 'NOT NULL'}`,
            },
    );
  }

  async listRoutines(database: string, schema: string): Promise<RoutineInfo[]> {
    const db = quote(database);
    const rows = await this.q<{ name: string; type: string; tbl: string | null }>(
      `SELECT o.name, RTRIM(o.type) AS type, p.name AS tbl
         FROM ${db}.sys.objects o
         JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
         LEFT JOIN ${db}.sys.objects p ON p.object_id = o.parent_object_id
        WHERE s.name = @schema AND o.type IN ('P', 'FN', 'IF', 'TF', 'TR') AND o.is_ms_shipped = 0
        ORDER BY o.name`,
      { schema },
    );
    return rows.map(
      (r): RoutineInfo => ({ name: r.name, kind: r.type === 'P' ? 'procedure' : r.type === 'TR' ? 'trigger' : 'function', ...(r.tbl ? { table: r.tbl } : {}) }),
    );
  }

  async searchObjects(database: string | null, pattern: string, limit: number): Promise<SearchHit[]> {
    const name = database ?? this.cfg.database ?? 'master';
    const db = quote(name);
    const rows = await this.q<{ sch: string; name: string; kind: string; extra: string | null; type: string | null; okind: string | null }>(
      `SELECT TOP (@limit) * FROM (
         SELECT s.name AS sch, o.name,
                CASE RTRIM(o.type) WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure' WHEN 'TR' THEN 'trigger' ELSE 'function' END AS kind,
                p.name AS extra, CAST(NULL AS nvarchar(128)) AS type, CAST(NULL AS nvarchar(10)) AS okind
           FROM ${db}.sys.objects o
           JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN ${db}.sys.objects p ON p.object_id = o.parent_object_id
          WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR') AND o.is_ms_shipped = 0 AND LOWER(o.name) LIKE LOWER(@pattern) ESCAPE '\\'
         UNION ALL
         SELECT s.name, o.name, 'column', c.name, ty.name, CASE RTRIM(o.type) WHEN 'V' THEN 'view' ELSE 'table' END
           FROM ${db}.sys.columns c
           JOIN ${db}.sys.objects o ON o.object_id = c.object_id
           JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
           -- Typname aus derselben Datenbank (TYPE_NAME() löste Aliastypen in der Verbindungsdatenbank auf)
           JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
          WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND LOWER(c.name) LIKE LOWER(@pattern) ESCAPE '\\'
       ) x ORDER BY sch, name`,
      { pattern, limit: Math.max(1, Math.floor(limit)) },
    );
    return rows.map((r) => searchHit(name, r.sch, r.kind, r.name, r.extra, r.type, r.okind));
  }

  async routineDdl(database: string, schema: string, r: RoutineInfo): Promise<string> {
    const db = quote(database);
    const [x] = await this.q<{ def: string | null }>(
      `SELECT m.definition AS def FROM ${db}.sys.sql_modules m
         JOIN ${db}.sys.objects o ON o.object_id = m.object_id JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @name`,
      { schema, name: r.name },
    );
    if (!x) throw new Error(`${r.name} nicht gefunden.`);
    if (x.def == null) throw new Error(`Der Text von ${r.name} ist nicht lesbar (WITH ENCRYPTION oder fehlende Berechtigung VIEW DEFINITION).`);
    return x.def.trim();
  }

  async getDdl(database: string, schema: string, name: string, kind: ObjectKind): Promise<string> {
    const db = quote(database);
    const target = `${quote(schema)}.${quote(name)}`;
    if (kind === 'view') {
      const [r] = await this.q<{ def: string | null }>(
        `SELECT m.definition AS def FROM ${db}.sys.sql_modules m
           JOIN ${db}.sys.objects o ON o.object_id = m.object_id JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema AND o.name = @name`,
        { schema, name },
      );
      if (!r) throw new Error(`${name} nicht gefunden.`);
      if (r.def == null) throw new Error(`Der Text von ${name} ist nicht lesbar (WITH ENCRYPTION oder fehlende Berechtigung VIEW DEFINITION).`);
      // indizierte Sicht: ihre Indizes (die Materialisierung) gehören dazu – ALTER VIEW entfernte sie sonst für immer
      const idx = await this.q<{ name: string; is_unique: boolean; type_desc: string; cols: string }>(
        `SELECT i.name, i.is_unique, i.type_desc,
                STUFF((SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
                         FROM ${db}.sys.index_columns ic JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                        ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS cols
           FROM ${db}.sys.indexes i JOIN ${db}.sys.objects o ON o.object_id = i.object_id JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema AND o.name = @name AND i.type > 0
          ORDER BY i.index_id`,
        { schema, name },
      );
      let ddl = r.def.trim();
      for (const i of idx) ddl += `;\nGO\nCREATE ${i.is_unique ? 'UNIQUE ' : ''}${i.type_desc === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${quote(i.name)} ON ${target} (${i.cols})`;
      return ddl;
    }
    // SQL Server hat kein SHOW CREATE TABLE: aus dem Katalog zusammensetzen
    const cols = await this.columns(database, schema, name);
    const info = await this.describeTable(database, schema, name);
    const lines = cols.map((c) => {
      if (c.generated !== undefined) return `  ${quote(c.name)} AS ${c.generated}${c.stored ? ' PERSISTED' : ''}`;
      let l = `  ${quote(c.name)} ${c.dataType}`;
      if (c.autoIncrement) l += ` IDENTITY(${c.seed ?? 1},${c.incr ?? 1})`;
      l += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.defaultValue != null) l += ` DEFAULT ${c.defaultValue}`;
      return l;
    });
    for (const i of info.indexes) {
      const cl = i.columns.map(quote).join(', ');
      if (i.primary) lines.push(`  CONSTRAINT ${quote(i.name)} PRIMARY KEY (${cl})`);
      else if (i.constraint) lines.push(`  CONSTRAINT ${quote(i.name)} UNIQUE (${cl})`);
    }
    for (const f of info.foreignKeys) {
      lines.push(
        `  CONSTRAINT ${quote(f.name)} FOREIGN KEY (${f.columns.map(quote).join(', ')}) REFERENCES ${quote(f.refSchema)}.${quote(f.refTable)} (${f.refColumns.map(quote).join(', ')})` +
          `${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}${f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''}`,
      );
    }
    for (const c of info.checks ?? []) lines.push(`  CONSTRAINT ${quote(c.name)} CHECK ${c.expression}`);
    let ddl = `CREATE TABLE ${target} (\n${lines.join(',\n')}\n);`;
    for (const i of info.indexes) {
      if (i.primary || i.constraint) continue;
      ddl += `\n\nCREATE ${i.unique ? 'UNIQUE ' : ''}${i.kind === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${quote(i.name)} ON ${target} ${i.definition ?? `(${i.columns.map(quote).join(', ')})`};`;
    }
    return ddl;
  }

  /**
   * Tabellenansicht und Export lesen nur. SQL Server kennt keine READ-ONLY-Transaktion: in einer Transaktion
   * ausführen und immer zurückrollen (die WHERE-Prüfung in buildTableQuery verhindert zusätzlich angehängte Anweisungen).
   */
  private async inRollback<T>(fn: (tx: sql.Transaction) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(await this.connected());
    try {
      // begin() im try: scheitert es, gibt erst das rollback() die geliehene Verbindung an den Pool zurück
      await tx.begin();
      return await fn(tx);
    } finally {
      await tx.rollback().catch(() => undefined);
    }
  }

  async fetchTable(req: TableDataRequest): Promise<TableDataResult> {
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql: text, params } = buildTableQuery(dialect, req, columns, false);
    const t0 = performance.now();
    const res = await this.inRollback(async (tx) => {
      const r = new sql.Request(tx);
      r.arrayRowMode = true;
      params.forEach((p, i) => r.input('p' + (i + 1), sql.NVarChar(sql.MAX), p));
      return (await r.query(text)) as sql.IResult<unknown> & { columns?: MssqlColumn[][] };
    });
    const cols = restoreTypes(columnsOf(res.columns?.[0] ?? []), columns);
    return {
      columns: cols,
      rows: convertRows((res.recordset ?? []) as unknown as unknown[][], cols),
      sql: buildTableQuery(dialect, req, columns, false, true).sql,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  async countTable(req: TableDataRequest): Promise<number> {
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql: text, params } = buildTableQuery(dialect, req, columns, true);
    const res = await this.inRollback((tx) => {
      const r = new sql.Request(tx);
      params.forEach((p, i) => r.input('p' + (i + 1), sql.NVarChar(sql.MAX), p));
      return r.query<{ cnt: number }>(text.replace('COUNT(*)', 'COUNT_BIG(*)'));
    });
    return Number(res.recordset[0].cnt);
  }

  async streamTable(req: TableDataRequest, sink: RowSink, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(ABORTED);
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql: text, params } = buildTableQuery(dialect, { ...req, limit: req.top ?? 0, offset: 0 }, columns, false);
    await this.inRollback((tx) => this.streamIn(tx, text, params, sink, signal, columns));
  }

  private async streamIn(tx: sql.Transaction, text: string, params: unknown[], sink: RowSink, signal?: AbortSignal, info: ColumnInfo[] = []): Promise<void> {
    // Export ohne Zeitgrenze (Anzeige und Zählung: 60 s aus der Pool-Konfiguration)
    // (die Typdefinitionen kennen den zweiten Parameter noch nicht, mssql selbst schon)
    const RequestWithOptions = sql.Request as unknown as new (parent: sql.Transaction, overrides: { requestTimeout: number }) => sql.Request;
    const r = new RequestWithOptions(tx, { requestTimeout: 0 });
    r.stream = true;
    r.arrayRowMode = true;
    params.forEach((p, i) => r.input('p' + (i + 1), sql.NVarChar(sql.MAX), p));
    /** Abbruch von außen (Auftrag abgebrochen, Verbindung wird getrennt): Attention an den Server, wie bei einem Schreibfehler */
    let failNow: (e: unknown) => void = () => undefined;
    const stop = (): void => failNow(new Error(ABORTED));
    this.streams.add(stop);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw new Error(ABORTED);
      await new Promise<void>((resolve, reject) => {
        let conv: ((v: unknown) => Cell)[] = [];
        let batch: ExportCell[][] = [];
        let bytes = 0;
        let chain = Promise.resolve();
        let failure: unknown;
        let ended = false;
        // mssql meldet im Stream-Modus nach 'error' immer noch 'done'. Erst danach ist die Verbindung frei –
        // vorher zurückzurollen scheitert ("request in progress") und die Verbindung bliebe belegt.
        let markEnded!: () => void;
        const endedPromise = new Promise<void>((r) => (markEnded = r));
        const fail = (e: unknown, fromRequest = false) => {
          if (failure !== undefined) return;
          failure = e ?? new Error('Export abgebrochen');
          if (!fromRequest && !ended) r.cancel();
          const timeout = new Promise<void>((r) => setTimeout(r, 10000));
          void Promise.race([endedPromise, timeout]).then(() => reject(failure));
        };
        failNow = (e) => fail(e);
        r.on('recordset', (cols: MssqlColumn[]) => {
          const rc = restoreTypes(columnsOf(cols), info);
          conv = columnsOf(cols).map((c) => cellFor(c.typeName));
          chain = chain.then(() => sink.begin(rc));
          chain.catch(fail);
        });
        r.on('row', (row: unknown[]) => {
          const cells = row.map((v, i) => (v instanceof Uint8Array ? Buffer.from(v) : (conv[i] ?? normalizeCell)(v)));
          batch.push(cells);
          bytes += rowBytes(cells);
          if (batch.length < STREAM_BATCH && bytes < STREAM_BYTES) return;
          const b = batch;
          batch = [];
          bytes = 0;
          r.pause();
          chain = chain.then(() => sink.rows(b)).then(() => {
            r.resume();
          });
          chain.catch(fail);
        });
        r.on('error', (e: unknown) => fail(e, true));
        r.on('done', () => {
          ended = true;
          markEnded();
          if (failure !== undefined) return;
          const b = batch;
          chain.then(() => (b.length ? sink.rows(b) : undefined)).then(resolve, (e) => fail(e, true));
        });
        void r.query(text);
      });
    } finally {
      signal?.removeEventListener('abort', stop);
      this.streams.delete(stop);
    }
  }

  async completionInfo(database: string): Promise<CompletionInfo> {
    const db = quote(database);
    const rows = await this.catalog((historyFree) =>
      this.q<{ s: string; t: string; type: string; c: string }>(
        `SELECT s.name AS s, o.name AS t, RTRIM(o.type) AS type, c.name AS c
           FROM ${db}.sys.objects o
           JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
           JOIN ${db}.sys.columns c ON c.object_id = o.object_id
          WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ${historyFree.replace('sys.tables', `${db}.sys.tables`)}
          ORDER BY s.name, o.name, c.column_id`,
      ),
    );
    const tables = new Map<string, CompletionInfo['tables'][number]>();
    for (const r of rows) {
      const key = r.s + '.' + r.t;
      let t = tables.get(key);
      if (!t) {
        t = { schema: r.s, name: r.t, kind: r.type === 'V' ? 'view' : 'table', columns: [] };
        tables.set(key, t);
      }
      t.columns.push(r.c);
    }
    // Namen ohne Schema: erst das Standardschema des Benutzers in dieser Datenbank, dann dbo (sp_executesql mit
    // Datenbank davor läuft dort; SCHEMA_NAME() gilt für die aktuelle Datenbank)
    let searchPath: string[] | undefined;
    try {
      const [d] = await this.q<{ s: string | null }>(`EXEC ${db}.sys.sp_executesql N'SELECT SCHEMA_NAME() AS s'`);
      searchPath = [...new Set([d?.s || 'dbo', 'dbo'])];
    } catch {
      // ohne Suchpfad nimmt die Oberfläche dbo an
    }
    return { tables: [...tables.values()], searchPath };
  }

  async applyWrites(_database: string, ops: WriteOp[]): Promise<number[]> {
    const tx = new sql.Transaction(await this.connected());
    try {
      await tx.begin();
      const counts: number[] = [];
      for (const op of ops) {
        const r = new sql.Request(tx);
        op.params.forEach((p, i) => {
          const type = paramType(op.types?.[i], p);
          if (type) r.input('p' + (i + 1), type, p);
          else r.input('p' + (i + 1), p);
        });
        const res = await r.query(op.sql);
        // nur der Zähler der eigenen Anweisung (der letzte): Trigger ohne SET NOCOUNT ON melden ihre Zeilen davor mit
        const n = res.rowsAffected.at(-1) ?? 0;
        checkAffected(op, n);
        counts.push(n);
      }
      await tx.commit();
      return counts;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  /**
   * Benutzersitzungen samt laufender Anfrage; Kennung des Servers im selben Batch (gleiche Verbindung).
   * Ohne VIEW SERVER STATE sieht man nur die eigenen Sitzungen.
   */
  /** Server hinter der Verbindung (Name, Rechner, Prozess-ID der Instanz) – erkennt eine zweite Verbindung zum selben Server */
  async serverIdentity(): Promise<string> {
    const [r] = await this.q<{ ident: string }>(`SELECT ${MSSQL_IDENT_EXPR} + N'|' + CAST(SERVERPROPERTY('ProcessID') AS nvarchar(20)) AS ident`);
    return r?.ident ?? '';
  }

  async listServerSessions(): Promise<ServerSessions> {
    const pool = await this.connected();
    const r = await pool.request().query(`${MSSQL_IDENT};\n${MSSQL_SESSIONS}`);
    const sets = r.recordsets as unknown as Record<string, unknown>[][];
    const me = sets[0][0];
    const num = (v: unknown) => (v == null ? undefined : Number(v));
    const sessions: ServerSession[] = (sets[1] ?? []).map((x) => {
      const running = x.r_status != null;
      return {
        id: String(x.id),
        started: String(x.started),
        user: (x.login_name as string | null) ?? undefined,
        client: [x.client_net_address, x.host_name].filter(Boolean).join(' · ') || undefined,
        program: (x.program_name as string | null) || undefined,
        database: (x.db as string | null) ?? undefined,
        state: running ? `${x.r_status}${x.command ? ' – ' + x.command : ''}` : String(x.s_status ?? ''),
        active: running,
        seconds: num(x.secs),
        txSeconds: num(x.tx_secs),
        wait: x.wait_type ? `${x.wait_type}${x.wait_resource ? ' (' + x.wait_resource + ')' : ''}` : undefined,
        blockedBy: x.blocked_by != null ? [String(x.blocked_by)] : [],
        query: userSql(x.query as string | null),
      };
    });
    return { server: String(me.ident), self: String(me.self), sessions, canCancelQuery: false };
  }

  /** SQL Server kennt nur KILL (ganze Sitzung, offene Transaktion wird zurückgerollt); Prüfungen und KILL in einem Batch */
  async killServerSession(id: string, started: string | undefined, server: string, mode: 'query' | 'session'): Promise<void> {
    if (mode === 'query') throw new Error('SQL Server kann eine Abfrage nicht einzeln abbrechen – nur die ganze Sitzung beenden.');
    const n = Number(id);
    const pool = await this.connected();
    const req = pool.request();
    req.input('server', sql.NVarChar(400), server);
    req.input('started', sql.VarChar(40), started ?? '');
    try {
      await req.batch(
        `IF ${MSSQL_IDENT_EXPR} <> @server THROW 51001, N'anderer Server', 1;\n` +
          `IF @@SPID = ${n} THROW 51003, N'eigene Sitzung', 1;\n` +
          `IF NOT EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE session_id = ${n} AND CONVERT(varchar(30), login_time, 126) = @started) THROW 51002, N'weg', 1;\n` +
          `KILL ${n};`,
      );
    } catch (e) {
      const no = (e as { number?: number }).number;
      if (no === 51001) throw new Error(KILL_TEXT.otherServer);
      if (no === 51002) throw new Error(KILL_TEXT.gone);
      if (no === 51003) throw new Error(KILL_TEXT.self);
      throw e;
    }
  }

  async openSession(database?: string): Promise<Session> {
    const pool = new sql.ConnectionPool(poolConfig(this.cfg, database || this.cfg.database, 1, 0));
    pool.on('error', () => undefined);
    await pool.connect();
    const s = new MssqlSession(pool);
    s.readOnly = !!this.cfg.readOnly;
    try {
      await s.init();
    } catch (e) {
      await pool.close().catch(() => undefined);
      throw e;
    }
    return s;
  }

  /** laufende Ströme abbrechen, dann den Pool schließen – mit Frist: pool.close() wartete sonst auf belegte Verbindungen */
  async close(): Promise<void> {
    for (const stop of [...this.streams]) stop();
    const pool = this.pool;
    this.pool = undefined;
    this.ready = undefined;
    // nach dem Abbrechen braucht tedious bis zu 5 s (cancelTimeout), bis die Verbindung frei ist
    if (pool) await withTimeout(pool.close(), 10_000, 'Das Trennen').catch(() => undefined);
  }
}

/**
 * Parametertyp passend zur Spalte: (var)char-Spalten als VarChar – als NVarChar gebunden müsste der Server die Spalte
 * umwandeln (SQL-Kollationen), ein Index-Seek ginge verloren und UPDATE/DELETE der Tabellenansicht läsen die ganze Tabelle
 */
function paramType(dataType: string | undefined, value: unknown): sql.ISqlType | undefined {
  if (typeof value !== 'string' || !dataType) return undefined;
  const m = /^(var)?char\((\d+|max)\)$/i.exec(dataType);
  if (!m) return undefined;
  const len = m[2].toLowerCase() === 'max' ? sql.MAX : Math.max(Number(m[2]), value.length);
  return m[1] ? sql.VarChar(len) : sql.Char(len);
}

/** Server-Kennung: Instanz und Rechner (nach einem Failover ein anderer) */
const MSSQL_IDENT_EXPR = "(@@SERVERNAME + N'|' + CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)))";
const MSSQL_IDENT = `SELECT ${MSSQL_IDENT_EXPR} AS ident, @@SPID AS self`;
/** Sekunden seit t: unter einem Tag auf Millisekunden genau, darüber ganze Sekunden (DATEDIFF in ms liefe sonst über) */
const secsSince = (t: string) =>
  `CASE WHEN DATEDIFF(SECOND, ${t}, SYSDATETIME()) < 86400 THEN DATEDIFF(MILLISECOND, ${t}, SYSDATETIME()) / 1000.0 ELSE DATEDIFF(SECOND, ${t}, SYSDATETIME()) END`;
const MSSQL_SESSIONS = `SELECT s.session_id AS id, CONVERT(varchar(30), s.login_time, 126) AS started, s.login_name, s.host_name, s.program_name,
       c.client_net_address, DB_NAME(COALESCE(r.database_id, s.database_id)) AS db, s.status AS s_status, r.status AS r_status, r.command,
       CASE WHEN r.session_id IS NOT NULL THEN ${secsSince('r.start_time')} ELSE ${secsSince('s.last_request_end_time')} END AS secs,
       (SELECT ${secsSince('MIN(t.transaction_begin_time)')}
          FROM sys.dm_tran_session_transactions st JOIN sys.dm_tran_active_transactions t ON t.transaction_id = st.transaction_id
         WHERE st.session_id = s.session_id) AS tx_secs,
       r.wait_type, NULLIF(r.wait_resource, '') AS wait_resource, NULLIF(r.blocking_session_id, 0) AS blocked_by, q.text AS query
  FROM sys.dm_exec_sessions s
  LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
  LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
  OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) q
 WHERE s.is_user_process = 1`;

/**
 * Abfragetext anderer OwlynDB-Sitzungen ohne deren Prüfungen: vorangestellte Kennzeichen-Prüfung weg,
 * reine Statusabfrage (läuft nach jeder Ausführung) gar nicht zeigen.
 */
function userSql(text: string | null): string | undefined {
  if (!text) return undefined;
  // Fremdtext (andere Anmeldungen bestimmen ihn): kein Muster mit Backtracking, nur Anfang und erste Zeile prüfen
  const t = text.length > 65536 ? text.slice(0, 65536) : text;
  if (t.startsWith('SELECT DB_NAME() AS db, @@TRANCOUNT AS tc, ')) return undefined;
  if (t.startsWith('IF UPPER(ISNULL(CAST(SESSION_CONTEXT') || t.startsWith('IF UPPER(ISNULL(CONVERT(varchar(64), SUBSTRING(CONTEXT_INFO')) {
    const nl = t.indexOf('\n');
    if (nl > 0 && t.slice(0, nl).endsWith(`', 1;`) && t.slice(0, nl).includes('THROW 51999, N')) return t.slice(nl + 1);
  }
  return t;
}

/** Pool mit genau einer Verbindung: Sitzungszustand (USE, Transaktion, #temp) bleibt erhalten. */
/** Diese Anweisungen müssen die ersten im Batch sein – dort lässt sich keine Prüfung voranstellen */
const MUST_BE_FIRST = /^(?:CREATE\s+OR\s+ALTER|CREATE|ALTER)\s+(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW|SCHEMA|DEFAULT|RULE)\b|^SET\s+SHOWPLAN_/i;
/** schalten in der Sitzung zusätzliche Ergebnismengen ein (Profil bzw. Plan nach jeder Anweisung) */
const EXTRA_SETS = /\b(STATISTICS\s+(PROFILE|XML)|SHOWPLAN_\w+)\b/i;
const LOST_NUMBER = 51999;
const LOST_TEXT = 'Die Verbindung wurde zwischenzeitlich neu aufgebaut (Sitzungszustand verloren). Diese Anweisung wurde nicht ausgeführt.';
const CONNECTION_ERRORS = new Set(['ECONNCLOSED', 'ESOCKET', 'ETIMEOUT', 'ENOTOPEN', 'ECONNRESET', 'ENOCONN']);

function stripLeadingComments(t: string): string {
  let s = t;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) return s;
  }
}

/**
 * Pool mit genau einer Verbindung: Sitzungszustand (USE, Transaktion, #temp) bleibt erhalten.
 * Aber: der mssql-Pool baut eine abgerissene Verbindung still neu auf. Damit dann nichts auf einer fremden,
 * frischen Verbindung läuft (z. B. ein UPDATE, das man in einer offenen Transaktion wähnt), trägt die Sitzung ein
 * Kennzeichen, und jeder Batch prüft es zuerst serverseitig.
 */
class MssqlSession extends BaseSession {
  protected readonly dialect = 'mssql';
  database: string | undefined;
  inTransaction = false;
  /** session_id auf dem Server (@@SPID) */
  serverId?: string;
  private current?: sql.Request;
  private readonly token = randomBytes(12).toString('hex').toUpperCase();
  /** SESSION_CONTEXT ab SQL Server 2016, sonst CONTEXT_INFO */
  private mode: 'ctx' | 'info' = 'ctx';
  /** in diesem Lauf darf die letzte Ergebnismenge eines lesenden Batches nach max. Zeilen abgebrochen werden (siehe prepare) */
  private stopEarly = false;
  /** SET STATISTICS PROFILE/XML bzw. SHOWPLAN in dieser Sitzung: dann kommen mehr Ergebnismengen, als im Text stehen */
  private extraSets = false;
  /** geschätzter Plan läuft (SHOWPLAN an): keine Prüfabfrage vorab, sie würde nur geplant und sähe wie ein Verlust aus */
  private planning = false;

  constructor(private pool: sql.ConnectionPool) {
    super();
  }

  private get tokenExpr(): string {
    return this.mode === 'ctx'
      ? `CAST(SESSION_CONTEXT(N'${TOKEN_KEY}') AS nvarchar(64))`
      : 'CONVERT(varchar(64), SUBSTRING(CONTEXT_INFO(), 1, 12), 2)';
  }

  async init(): Promise<void> {
    try {
      await this.pool.request().batch(`EXEC sp_set_session_context @key = N'${TOKEN_KEY}', @value = N'${this.token}', @read_only = 1`);
    } catch {
      // vor SQL Server 2016
      this.mode = 'info';
      await this.pool.request().batch(`SET CONTEXT_INFO 0x${this.token}`);
    }
    if (!(await this.refreshState())) throw new Error('Sitzungskennzeichen ließ sich nicht setzen.');
  }

  /** Datenbank und offene Transaktion nachführen; false = andere Verbindung als beim Öffnen */
  private async refreshState(): Promise<boolean> {
    const r = await this.pool.request().query<{ db: string; tc: number; t: string | null; spid: number }>(
      `SELECT DB_NAME() AS db, @@TRANCOUNT AS tc, ${this.tokenExpr} AS t, @@SPID AS spid`,
    );
    const row = r.recordset[0];
    // unter SHOWPLAN (auch vom Nutzer gesetzt) kommt statt der Zeile ein Plan: dann ist nichts verloren, nur nichts zu lesen
    if (!row || !('t' in row)) return true;
    if (String(row.t ?? '').toUpperCase() !== this.token) {
      this.broken = true;
      return false;
    }
    this.database = row.db;
    this.inTransaction = row.tc > 0;
    this.serverId = String(row.spid);
    return true;
  }

  protected async refreshDatabase(): Promise<void> {
    await this.refreshState();
  }

  protected async pingOnce(): Promise<void> {
    await this.refreshState();
  }

  /** SQL Server kennt keine Nur-lesen-Transaktion: alles, was doch schreibt, nimmt das ROLLBACK zurück */
  protected async beginReadOnly(): Promise<void> {
    await this.execOne('BEGIN TRANSACTION', 0);
  }

  protected async endReadOnly(): Promise<void> {
    await this.execOne('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION', 0);
    this.inTransaction = false;
  }

  protected isConnectionLoss(e: unknown): boolean {
    return this.broken || CONNECTION_ERRORS.has(String((e as { code?: string })?.code));
  }

  override async check(): Promise<boolean> {
    if (this.broken) return false;
    try {
      return await this.refreshState();
    } catch (e) {
      if (this.isConnectionLoss(e)) this.broken = true;
      return !this.broken;
    }
  }

  async setDatabase(database: string): Promise<void> {
    await this.pool.request().batch(`USE ${quote(database)}`);
    this.database = database;
  }

  /** Batch mit vorangestellter Prüfung des Sitzungskennzeichens */
  private async guarded(text: string): Promise<string> {
    if (MUST_BE_FIRST.test(stripLeadingComments(text))) {
      // kann nicht vorangestellt werden: vorher prüfen (kleines Restfenster bis zur Ausführung) – beim geschätzten Plan
      // schon vor SET SHOWPLAN geschehen
      if (!this.planning && !(await this.refreshState())) throw new Error(LOST_TEXT);
      return text;
    }
    return `IF UPPER(ISNULL(${this.tokenExpr}, '')) <> '${this.token}' THROW ${LOST_NUMBER}, N'${LOST_TEXT}', 1;\n` + text;
  }

  /**
   * Batch im Stream-Modus: Ergebnismengen und Zeilen gehen einzeln an den Empfänger, gesammelt wird nichts. Gibt er
   * ein Promise zurück (Datei schreibt), wird so lange nicht weitergelesen; 'stop' bricht den Rest des Batches ab
   * (nur in der letzten Ergebnismenge eines lesenden Batches). Fehler: wie bisher der letzte des Batches.
   */
  private async streamBatch(
    text: string,
    on: { set(meta: MssqlColumn[]): void | Promise<void>; row(row: unknown[]): void | 'stop' | Promise<void> },
  ): Promise<{ rowsAffected: number[]; stopped: boolean }> {
    const batch = await this.guarded(text);
    const req = this.pool.request();
    req.arrayRowMode = true;
    req.stream = true;
    req.on('info', (m: { message: string }) => this.messages.push(m.message));
    this.current = req;
    /** Fehler des Empfängers (z. B. beim Schreiben) – geht vor einem Fehler des Servers */
    let handlerError: unknown;
    try {
      return await new Promise((resolve, reject) => {
        const errors: unknown[] = [];
        const rowsAffected: number[] = [];
        let stopped = false;
        let waiting = 0;
        const handle = (r: void | 'stop' | Promise<void>) => {
          if (r === 'stop') {
            stopped = true;
            req.cancel();
          } else if (r instanceof Promise) {
            // Gegendruck: erst weiterlesen, wenn alles Geschriebene durch ist
            if (waiting++ === 0) req.pause();
            void r.then(
              () => {
                if (--waiting === 0) req.resume();
              },
              (e: unknown) => {
                handlerError ??= e;
                if (--waiting === 0) req.resume();
              },
            );
          }
        };
        req.on('recordset', (cols: MssqlColumn[]) => {
          if (!stopped) handle(on.set(cols));
        });
        req.on('row', (row: unknown) => {
          if (stopped || handlerError !== undefined) return;
          // FOR JSON/FOR XML: die zusammengesetzte Zeile kommt als Objekt statt als Array
          handle(on.row(Array.isArray(row) ? row : Object.values(row as object)));
        });
        req.on('rowsaffected', (n: number) => rowsAffected.push(n));
        req.on('error', (e: unknown) => {
          // der eigene Abbruch nach max. Zeilen ist kein Fehler
          if (stopped && (e as { code?: string }).code === 'ECANCEL') return;
          errors.push(e);
        });
        req.on('done', () => {
          const last = errors.at(-1);
          if (last === undefined) return resolve({ rowsAffected, stopped });
          if ((last as { number?: number }).number === LOST_NUMBER || errors.some((e) => (e as { number?: number }).number === LOST_NUMBER)) {
            this.broken = true;
            return reject(new Error(LOST_TEXT));
          }
          reject(last);
        });
        // batch() statt query(): kein sp_executesql, damit CREATE PROCEDURE & Co. funktionieren
        void req.batch(batch).catch(() => undefined);
      }).then(
        (r) => {
          if (handlerError !== undefined) throw handlerError;
          return r as { rowsAffected: number[]; stopped: boolean };
        },
        (e: unknown) => {
          throw handlerError ?? e;
        },
      );
    } finally {
      this.current = undefined;
    }
  }

  /**
   * Zeile für Zeile: über max. Zeilen hinaus wird nur gezählt. In der letzten Ergebnismenge eines lesenden Batches (keine
   * Transaktion offen, danach keine Anweisung mehr) wird stattdessen nach max. Zeilen + 1 abgebrochen – der Server muss
   * den Rest nicht schicken. Frühere Ergebnismengen kommen ganz: ein Abbruch beendete den ganzen Batch.
   */
  protected async execOne(text: string, maxRows: number): Promise<ExecResult> {
    const sets: ResultCollector[] = [];
    let cur: ResultCollector | undefined;
    /** Nummer der Ergebnismenge (ab 1), die abgebrochen werden darf; 0 = keine */
    const last = this.stopEarly && maxRows > 0 ? stoppableResults(text) : 0;
    const res = await this.streamBatch(text, {
      set: (meta) => {
        const cols = columnsOf(meta);
        const conv = cols.map((c) => cellFor(c.typeName));
        const lossy = lossyDecimals(cols);
        if (lossy.length) this.messages.push(`Gerundet: ${lossy.join(', ')} – tedious liefert Dezimalzahlen über 15 Stellen als Gleitkommazahl. Die Tabellenansicht und der Export der Tabelle lesen sie exakt.`);
        cur = new ResultCollector(cols, maxRows, (r) => r.map((v, i) => (conv[i] ?? normalizeCell)(v)));
        sets.push(cur);
      },
      row: (row) => {
        cur?.add(row);
        if (last && sets.length === last && cur && cur.count > maxRows) return 'stop';
      },
    });
    const out: ExecResult = { sets: sets.map((s, i) => s.result(res.stopped && i === sets.length - 1 ? maxRows + 1 : undefined)) };
    // rowsAffected zählt auch gelesene Zeilen mit; nur ohne Ergebnismenge aussagekräftig
    if (!out.sets.length) out.rowsAffected = res.rowsAffected.reduce((a, b) => a + b, 0);
    return out;
  }

  /** Export: Ergebnis Nr. resultIndex des Batches als Stream, alle übrigen werden verworfen */
  protected async streamOne(text: string, resultIndex: number, sink: RowSink): Promise<boolean> {
    const out = new SinkQueue(sink);
    let setNo = -1;
    let active = false;
    let conv: ((v: unknown) => ExportCell)[] = [];
    await this.streamBatch(text, {
      set: (meta) => {
        if (active) out.flush();
        active = ++setNo === resultIndex;
        if (!active) return;
        const cols = columnsOf(meta);
        conv = cols.map((c) => {
          const f = cellFor(c.typeName);
          return (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v) : f(v));
        });
        out.begin(cols);
      },
      row: (row) => {
        if (!active) return;
        // Datei nicht schreibbar, Abbruch: die Anfrage beenden, statt den Rest zu lesen und wegzuwerfen
        if (out.failed) return 'stop';
        if (out.push(row.map((v, i) => (conv[i] ?? exportCell)(v)))) return out.idle();
      },
    }).catch(async (e) => {
      await out.idle();
      throw out.failure ?? e;
    });
    await out.end();
    return out.started;
  }

  /** lesende Batches dürfen in ihrer letzten Ergebnismenge nach max. Zeilen abgebrochen werden – nur ohne offene Transaktion */
  protected override async prepare(kind: RunKind, statements: StatementInput[]): Promise<void> {
    if (statements.some((s) => EXTRA_SETS.test(s.sql))) this.extraSets = true;
    // FOR JSON/XML kommt vom Treiber als ein einziger Wert: die Zeilengrenze greift nicht, ein riesiges Ergebnis liegt ganz im Speicher
    if (kind !== 'explain' && statements.some((s) => /\bFOR\s+(JSON|XML)\b/i.test(s.sql))) {
      this.messages.push('FOR JSON/FOR XML: SQL Server liefert das Ergebnis als einen Wert – die Zeilengrenze greift nicht; bei sehr großen Ergebnissen vorher mit TOP begrenzen.');
    }
    // XACT_ABORT ON rollte eine offene Transaktion beim Abbruch zurück; schreibende Anweisungen könnten eine öffnen
    this.stopEarly = kind === 'run' && !this.inTransaction && !this.extraSets && statements.every((s) => !readOnlyViolation(s.sql, 'mssql'));
  }

  /**
   * Geschätzt: SHOWPLAN_XML – der Batch wird nur übersetzt, nicht ausgeführt. Mit Laufzeit: STATISTICS XML – der Batch
   * läuft wirklich, nach jeder Anweisung kommt ihr Plan als eigene Ergebnismenge; die Daten werden nur durchgereicht,
   * nicht gesammelt (auch ein riesiges Ergebnis belegt keinen Speicher).
   * Die vorangestellte Kennzeichen-Prüfung erscheint im Plan und wird herausgefiltert; sie schützt weiterhin: auf einer
   * still neu aufgebauten Verbindung ist SHOWPLAN aus, die Prüfung läuft und bricht ab.
   */
  protected async explainOne(text: string, analyze: boolean): Promise<StatementPlan[]> {
    const mode = analyze ? 'STATISTICS XML' : 'SHOWPLAN_XML';
    // Kennzeichen vor dem Planmodus prüfen: unter SHOWPLAN würde die Prüfabfrage nur geplant
    if (!analyze && !(await this.refreshState())) throw new Error(LOST_TEXT);
    await this.execOne(`SET ${mode} ON`, 0);
    const xmls: string[] = [];
    let isPlan = false;
    this.planning = !analyze;
    try {
      await this.streamBatch(text, {
        set: (meta) => {
          isPlan = meta.length === 1 && /XML Showplan/i.test(meta[0].name);
        },
        row: (row) => {
          if (isPlan) xmls.push(String(row[0]));
        },
      });
    } finally {
      this.planning = false;
      // direkt, ohne Prüfabfrage vorab – die würde bei eingeschaltetem SHOWPLAN_XML auch nur geplant
      await this.pool
        .request()
        .batch(`SET ${mode} OFF`)
        .catch(() => {
          // Plan-Modus womöglich noch an: beim nächsten Ausführen neu verbinden
          this.broken = true;
        });
    }
    const plans = mssqlPlans(xmls, analyze, (t) => t.includes(this.token));
    if (!plans.length) throw new Error('Für diese Anweisung liefert SQL Server keinen Plan (z. B. bei SET, DECLARE oder USE).');
    return plans;
  }

  protected async cancelCurrent(): Promise<void> {
    this.current?.cancel();
  }

  protected async closeConnection(): Promise<void> {
    await this.pool.close();
  }

  /** die einzige Verbindung des Pools hart schließen (tedious) – tarn wartete sonst auf das Ende der Anfrage */
  protected destroyConnection(): void {
    try {
      this.current?.cancel();
      type Held = { resource?: { close?(): void } };
      const tarn = (this.pool as unknown as { pool?: { used?: Held[]; free?: Held[] } }).pool;
      for (const h of [...(tarn?.used ?? []), ...(tarn?.free ?? [])]) h.resource?.close?.();
    } catch {
      // Pool schon geschlossen
    }
  }
}
