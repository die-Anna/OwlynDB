import net from 'node:net';
import tls from 'node:tls';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { from as copyFrom } from 'pg-copy-streams';
import type {
  CheckInfo,
  ColumnInfo,
  CompletionInfo,
  DbObject,
  ErModel,
  ForeignKeyInfo,
  IndexInfo,
  ObjectKind,
  ResultColumn,
  RoutineInfo,
  SearchHit,
  ServerInfo,
  ServerSession,
  StatementPlan,
  TableDataRequest,
  TableDataResult,
  TableInfo,
} from '../../shared/api-types';
import { postgresPlan } from '../plan';
import {
  ABORTED,
  BaseSession,
  checkAffected,
  CopyTarget,
  searchHit,
  errorText,
  buildTableQuery,
  DriverConfig,
  ExecResult,
  erModelFrom,
  KILL_TEXT,
  MetaDriver,
  exportCell,
  normalizeCell,
  ResultCollector,
  RowSink,
  Session,
  ServerSessions,
  STREAM_BATCH,
  TableSqlDialect,
  TypeDdl,
  withTimeout,
  WriteOp,
} from './common';
import { splitSql } from '../../shared/sql-splitter';
import type { ExportCell } from '../export';
import { openTunnelForPg } from './tunnel';

// Werte als Text lassen, wie psql sie zeigt – außer bool und kleinen Zahlen.
const KEEP_PARSED = new Set([16, 21, 23, 26, 700, 701]);
const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (KEEP_PARSED.has(oid)) return pg.types.getTypeParser(oid, format as 'text');
    return (v: string) => v;
  },
} as pg.CustomTypesConfig;

const TYPE_NAMES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 790: 'money', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
};
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);

const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

const dialect: TableSqlDialect = {
  name: 'postgres',
  quote,
  qualified: (_db, schema, name) => `${quote(schema)}.${quote(name)}`,
  searchExpr: (c) => (/^bytea/i.test(c.dataType) ? null : `${quote(c.name)}::text`),
  likeOperator: 'ILIKE',
  likeEscape: '',
  param: (n) => '$' + n,
  literal: (s) => "'" + s.replace(/'/g, "''") + "'",
  page: (sql, limit, offset) => `${sql}\nLIMIT ${limit} OFFSET ${offset}`,
};

function columnsOf(fields: pg.FieldDef[]): ResultColumn[] {
  return fields.map((f) => ({ name: f.name, typeName: TYPE_NAMES[f.dataTypeID] ?? String(f.dataTypeID), numeric: NUMERIC_OIDS.has(f.dataTypeID) }));
}

/**
 * pg-cursor kennt die COPY-Antworten nicht – ein COPY über den Cursor brächte den ganzen Prozess zum Absturz.
 * COPY läuft deshalb ohnehin als einfache Abfrage; das hier ist nur die Absicherung.
 */
class SafeCursor extends Cursor {
  handleCopyInResponse(connection: { sendCopyFail(msg: string): void }): void {
    connection.sendCopyFail('COPY FROM STDIN geht hier nicht.');
  }

  handleCopyData(): void {
    // Daten von COPY TO STDOUT verwerfen
  }
}

function cursorFor(sql: string, params?: unknown[]): SafeCursor {
  return new SafeCursor(sql, params, { rowMode: 'array', types: pgTypes } as ConstructorParameters<typeof Cursor>[2]);
}

/**
 * Nicht über den Cursor: COPY (Datenstrom) und Sperren – FOR UPDATE/SHARE sperrte sonst nur die tatsächlich
 * gelesenen Zeilen. (Prüft nach führenden Kommentaren; ein Treffer im Text schadet nicht, er kostet nur die Grenze.)
 */
const SIMPLE_ONLY = /^COPY\b|\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;
/**
 * Anweisungen, die Zeilen liefern – nur sie über den Cursor. Alles andere (INSERT, UPDATE, DDL) als einfache Abfrage:
 * ein Weg zum Server statt drei (zählt beim Einspielen tausender Anweisungen).
 */
const RETURNS_ROWS = /^(?:\(|SELECT\b|WITH\b|VALUES\b|TABLE\b|SHOW\b|EXPLAIN\b|FETCH\b|EXECUTE\b)/i;

function withoutLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}

/** bis zu n Zeilen vom Cursor; [] = keine mehr */
function readCursor(cursor: Cursor, n: number): Promise<unknown[][]> {
  return new Promise<unknown[][]>((resolve, reject) => cursor.read(n, (e: Error | undefined, rows: unknown[]) => (e ? reject(e) : resolve(rows as unknown[][]))));
}

/** Spalten, Befehl und Zeilenzahl stehen am Cursor (am Ende reicht read sie nicht mehr mit) */
function cursorResult(cursor: Cursor): pg.QueryResult {
  return (cursor as unknown as { _result: pg.QueryResult })._result;
}

/**
 * Cursor vorzeitig schließen (nur wenn er noch Zeilen hätte; nach Ende oder Fehler ist er schon zu). Bricht die
 * Verbindung dabei ab, kommt keine Bestätigung mehr – dann nicht ewig warten.
 */
function closeCursor(client: pg.Client, cursor: Cursor): Promise<void> {
  if ((cursor as unknown as { state: string }).state !== 'idle') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      client.removeListener('end', done);
      client.removeListener('error', done);
      resolve();
    };
    client.once('end', done);
    client.once('error', done);
    cursor.close(() => done());
  });
}

/** Prozess-ID und Startzeit der eigenen Verbindung: Abbrechen nur, wenn beides passt (pids werden wiederverwendet) */
const BACKEND_SQL = 'SELECT pid, backend_start::text AS start FROM pg_stat_activity WHERE pid = pg_backend_pid()';

/** Socket zerstören: pg beendet damit alle wartenden Abfragen (auch Cursor) sofort mit Verbindungsfehler */
function destroyStream(client: pg.Client | pg.PoolClient | undefined): void {
  (client as unknown as { connection?: { stream?: { destroy(): void } } } | undefined)?.connection?.stream?.destroy();
}

/** bytea kommt als Text '\x…' (Text-Parser): für den Export als Binärdaten */
function byteaCell(v: unknown, bytea: boolean | undefined): ExportCell {
  return bytea && typeof v === 'string' && v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : exportCell(v);
}

/** welche Spalten bytea sind (OID 17) */
const byteaFlags = (fields: pg.FieldDef[] | undefined): boolean[] => (fields ?? []).map((f) => f.dataTypeID === 17);

/**
 * Zeile für die Anzeige: bytea als Buffer, damit normalizeCell/ResultCollector wie bei den anderen Treibern auf 1 KB kürzen
 * und binaryCut setzen – als Hex-Text ginge der ganze Blob (doppelt so groß) ungekürzt ans Grid
 */
const withBytea = (row: unknown[], flags: boolean[]): unknown[] => (flags.some(Boolean) ? row.map((v, i) => (flags[i] ? byteaCell(v, true) : v)) : row);

/** Stapel beim Lesen: erst klein, dann nach Bytes – 2000 breite Zeilen (bytea, lange Texte) lägen sonst ganz im Speicher */
const FIRST_BATCH = 200;
const BATCH_BYTES = 8 * 1024 * 1024;
function nextBatch(n: number, rows: unknown[][]): number {
  if (!rows.length) return n;
  let bytes = 0;
  for (const r of rows) for (const v of r) if (typeof v === 'string') bytes += v.length;
  const perRow = bytes / rows.length;
  return perRow ? Math.max(50, Math.min(STREAM_BATCH, Math.floor(BATCH_BYTES / perRow))) : STREAM_BATCH;
}

function clientConfig(cfg: DriverConfig, database: string): pg.ClientConfig {
  // Name für SNI und Zertifikatsprüfung: das eigentliche Ziel (über SSH ist host 127.0.0.1), aber keine IP-Adresse
  const name = cfg.servername || cfg.target?.host || cfg.host;
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database,
    ...(cfg.tunnel ? { stream: () => openTunnelForPg(cfg) } : {}),
    ssl: cfg.tunnel
      ? cfg.ssl
        ? { rejectUnauthorized: false }
        : false
      : cfg.ssl
      ? {
          ca: cfg.tls?.ca,
          cert: cfg.tls?.cert,
          key: cfg.tls?.key,
          passphrase: cfg.tls?.passphrase,
          rejectUnauthorized: !!cfg.tls?.verifyServer,
          servername: net.isIP(name) ? undefined : name,
          // ohne Hostnamen-Prüfung: Zertifikatskette ja, Name egal; mit: gegen das Ziel, nicht gegen das Tunnelende
          checkServerIdentity: cfg.tls?.verifyHostname ? (_host, cert) => tls.checkServerIdentity(name, cert) : () => undefined,
        }
      : undefined,
    connectionTimeoutMillis: 10000,
    // still verworfene Verbindungen (NAT, Load-Balancer) nach einer halben Minute Leerlauf bemerken, nicht erst nach Stunden
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    types: pgTypes,
    application_name: 'OwlynDB',
  };
}

export class PostgresDriver implements MetaDriver {
  /** PostgreSQL kann nicht über Datenbanken hinweg abfragen: ein Pool je Datenbank */
  private pools = new Map<string, pg.Pool>();
  private readonly defaultDb: string;
  /** laufende Tabellen-Ströme (Export, Dump, Kopie, Vergleich): close() bricht sie ab, statt auf sie zu warten */
  private streams = new Set<() => void>();
  /** nach close(): kein neuer Pool mehr (ein verspäteter Aufruf legte sonst einen an, den niemand schließt) */
  private closed = false;

  constructor(private cfg: DriverConfig) {
    this.defaultDb = cfg.database || 'postgres';
  }

  private pool(database?: string): pg.Pool {
    if (this.closed) throw new Error('Die Verbindung wurde geschlossen.');
    const db = database || this.defaultDb;
    let p = this.pools.get(db);
    if (!p) {
      p = new pg.Pool({ ...clientConfig(this.cfg, db), max: 3, idleTimeoutMillis: 60000 });
      p.on('error', () => {
        // Leerlauf-Verbindung abgebrochen; der Pool baut neu auf
      });
      this.pools.set(db, p);
    }
    return p;
  }

  private async q<T>(database: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool(database).query(sql, params);
    return r.rows as T[];
  }

  /**
   * Client aus dem Pool leihen – mit eigenem 'error'-Listener: pg-pool hängt seinen nur an Leerlauf-Clients. Ein
   * Verbindungsabbruch während einer Abfrage (Server-Neustart, Proxy-Timeout, hartes Trennen) wäre sonst ein
   * unbehandeltes 'error' und damit ein Absturz des Hauptprozesses. Ein so verlorener Client wird beim Zurückgeben verworfen.
   */
  private async lease(database: string | undefined): Promise<{ client: pg.PoolClient; release(destroy?: boolean): void }> {
    const client = await this.pool(database).connect();
    let lost = false;
    const onError = () => {
      lost = true;
    };
    client.on('error', onError);
    return {
      client,
      release: (destroy = false) => {
        client.removeListener('error', onError);
        client.release(destroy || lost);
      },
    };
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; db: string }>(undefined, 'SELECT version() AS v, current_database() AS db');
    return { version: r.v, currentDatabase: r.db };
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.q<{ name: string }>(
      undefined,
      `SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datallowconn
        AND has_database_privilege(datname, 'CONNECT') ORDER BY datname`,
    );
    return rows.map((r) => r.name);
  }

  async listSchemas(database: string): Promise<string[]> {
    const rows = await this.q<{ name: string }>(
      database,
      `SELECT nspname AS name FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          AND has_schema_privilege(oid, 'USAGE')
        ORDER BY nspname = 'public' DESC, nspname`,
    );
    return rows.map((r) => r.name);
  }

  async listObjects(database: string, schema: string): Promise<DbObject[]> {
    const rows = await this.q<{ name: string; kind: string; rows: number }>(
      database,
      `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::float8 AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT c.relispartition
        ORDER BY c.relname`,
      [schema],
    );
    return rows.map((r) => ({
      name: r.name,
      kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table',
      rows: r.rows >= 0 && (r.kind === 'r' || r.kind === 'p') ? Math.round(r.rows) : undefined,
    }));
  }

  private async columns(database: string, schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.q<{ name: string; type: string; notnull: boolean; def: string | null; pk: boolean; identity: string; generated: string; comment: string | null }>(
      database,
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
              col_description(c.oid, a.attnum) AS comment,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type,
      nullable: !r.notnull,
      // bei berechneten Spalten steht in pg_attrdef der Ausdruck, kein Standardwert
      defaultValue: r.generated ? null : r.def,
      primaryKey: r.pk,
      autoIncrement: r.identity !== '' || /^nextval\(/.test(r.def ?? ''),
      comment: r.comment ?? undefined,
      ...(r.generated ? { generated: r.def ?? '' } : {}),
      ...(r.identity === 'a' ? { identity: 'always' as const } : r.identity === 'd' ? { identity: 'default' as const } : {}),
    }));
  }

  /** ER-Diagramm: Tabellen (ohne Partitionen), Spalten und Fremdschlüssel des Schemas in drei Abfragen */
  async erModel(database: string, schema: string): Promise<ErModel> {
    const tables = await this.q<{ name: string; est: string | number }>(
      database,
      `SELECT c.relname AS name, c.reltuples::bigint AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`,
      [schema],
    );
    const cols = await this.q<{ t: string; c: string; type: string; nullable: boolean; pk: boolean }>(
      database,
      `SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
      [schema],
    );
    const fks = await this.q<{ name: string; t: string; c: string; rs: string; rt: string; rc: string }>(
      database,
      `SELECT con.conname AS name, c.relname AS t, a.attname AS c, rn.nspname AS rs, rc.relname AS rt, ra.attname AS rc
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
        WHERE con.contype = 'f' AND n.nspname = $1
          -- Kopien der Fremdschlüssel auf Partitionen (verweisend wie verwiesen) nicht doppelt
          AND NOT c.relispartition AND NOT rc.relispartition
        ORDER BY c.relname, con.conname, k.ord`,
      [schema],
    );
    return erModelFrom(
      tables.map((t) => ({ schema, name: t.name, rows: Number(t.est) })),
      cols.map((c) => ({ schema, table: c.t, name: c.c, type: c.type, nullable: c.nullable, pk: c.pk })),
      fks.map((f) => ({ name: f.name, schema, table: f.t, column: f.c, refSchema: f.rs, refTable: f.rt, refColumn: f.rc })),
    );
  }

  async describeTable(database: string, schema: string, name: string): Promise<TableInfo> {
    const columns = await this.columns(database, schema, name);
    const idx = await this.q<{ name: string; unique: boolean; primary: boolean; columns: string[]; con: boolean; method: string; pred: string | null; def: string }>(
      database,
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
              -- Spaltennamen roh (pg_get_indexdef quotet sie: "Id" passte dann zu keiner Spalte), Ausdrücke als Text
              ARRAY(SELECT CASE WHEN u.attnum = 0 THEN pg_get_indexdef(ix.indexrelid, u.ord::int, true) ELSE a.attname::text END
                      FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS u(attnum, ord)
                      LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = u.attnum
                     ORDER BY u.ord) AS columns,
              -- Index einer Einschränkung (PRIMARY KEY, UNIQUE, EXCLUDE): nur über ALTER TABLE zu löschen
              EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid AND k.conrelid = ix.indrelid AND k.contype IN ('p', 'u', 'x')) AS con,
              am.amname AS method, pg_get_expr(ix.indpred, ix.indrelid, true) AS pred, pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY ix.indisprimary DESC, i.relname`,
      [schema, name],
    );
    const fk = await this.q<{ name: string; cols: string[]; refschema: string; reftable: string; refcols: string[]; del: string; upd: string }>(
      database,
      `SELECT con.conname AS name,
              ARRAY(SELECT attname FROM unnest(con.conkey) WITH ORDINALITY u(n, o)
                      JOIN pg_attribute ON attrelid = con.conrelid AND attnum = u.n ORDER BY o) AS cols,
              rn.nspname AS refschema, rc.relname AS reftable,
              ARRAY(SELECT attname FROM unnest(con.confkey) WITH ORDINALITY u(n, o)
                      JOIN pg_attribute ON attrelid = con.confrelid AND attnum = u.n ORDER BY o) AS refcols,
              con.confdeltype AS del, con.confupdtype AS upd
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
          -- ohne die Kopien, die PostgreSQL je Partition anlegt
          AND con.conparentid = 0
        ORDER BY con.conname`,
      [schema, name],
    );
    const indexes: IndexInfo[] = idx.map((r) => {
      const i: IndexInfo = { name: r.name, columns: parseArray(r.columns), unique: r.unique, primary: r.primary };
      if (r.con && !r.primary) i.constraint = true;
      if (r.method !== 'btree') i.kind = r.method;
      if (r.pred) i.where = r.pred;
      // ab USING: Methode, Spalten mit Richtung und Operatorklasse, INCLUDE, WITH, WHERE – im Wortlaut des Servers
      const at = r.def.indexOf(' USING ');
      if (at > 0) i.definition = r.def.slice(at + 1);
      return i;
    });
    const RULES: Record<string, string> = { r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
    const foreignKeys: ForeignKeyInfo[] = fk.map((r) => ({
      name: r.name,
      columns: parseArray(r.cols),
      refSchema: r.refschema,
      refTable: r.reftable,
      refColumns: parseArray(r.refcols),
      ...(RULES[r.del] ? { onDelete: RULES[r.del] } : {}),
      ...(RULES[r.upd] ? { onUpdate: RULES[r.upd] } : {}),
    }));
    const inc = await this.q<{ name: string; schema: string; table: string; cols: string[]; refcols: string[] }>(
      database,
      `SELECT con.conname AS name, n.nspname AS schema, c.relname AS table,
              ARRAY(SELECT attname FROM unnest(con.conkey) WITH ORDINALITY u(n, o)
                      JOIN pg_attribute ON attrelid = con.conrelid AND attnum = u.n ORDER BY o) AS cols,
              ARRAY(SELECT attname FROM unnest(con.confkey) WITH ORDINALITY u(n, o)
                      JOIN pg_attribute ON attrelid = con.confrelid AND attnum = u.n ORDER BY o) AS refcols
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.contype = 'f' AND rn.nspname = $1 AND rc.relname = $2
          AND con.conparentid = 0
        ORDER BY n.nspname, c.relname, con.conname`,
      [schema, name],
    );
    const referencedBy = inc.map((r) => ({ name: r.name, schema: r.schema, table: r.table, columns: parseArray(r.cols), refColumns: parseArray(r.refcols) }));
    // Art der Relation (partitioniert, Fremdtabelle) und CHECK-Einschränkungen (ohne die geerbten je Partition)
    const [rel] = await this.q<{ kind: string; partkey: string | null; checks: string }>(
      database,
      `SELECT c.relkind AS kind, CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey,
              COALESCE((SELECT json_agg(json_build_object('name', k.conname, 'def', pg_get_constraintdef(k.oid, true)) ORDER BY k.conname)
                          FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c' AND k.conparentid = 0), '[]'::json)::text AS checks
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    const checks: CheckInfo[] = (JSON.parse(rel?.checks ?? '[]') as { name: string; def: string }[]).map((k) => ({ name: k.name, expression: k.def.replace(/^CHECK\s*/i, '') }));
    const special = rel?.kind === 'p' ? `partitioniert (PARTITION BY ${rel.partkey ?? ''})` : rel?.kind === 'f' ? 'Fremdtabelle (FOREIGN TABLE)' : undefined;
    return { columns, indexes, foreignKeys, referencedBy, checks, ...(special ? { special } : {}) };
  }

  /** ENUM- und DOMAIN-Typen, die Spalten der Tabellen benutzen (auch als Array); andere Arten nur als Hinweis */
  async typeDdl(database: string, schema: string, tables: string[]): Promise<TypeDdl[]> {
    if (!tables.length) return [];
    const rows = await this.q<{ schema: string; name: string; kind: string; labels: string | null; base: string | null; notnull: boolean; def: string | null; checks: string | null; ext: boolean }>(
      database,
      `SELECT DISTINCT tn.nspname AS schema, t.typname AS name, t.typtype AS kind, CASE t.typtype WHEN 'e' THEN 0 WHEN 'd' THEN 1 ELSE 2 END AS ord,
              CASE WHEN t.typtype = 'e' THEN (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) END AS labels,
              CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base,
              t.typnotnull AS notnull, t.typdefault AS def,
              CASE WHEN t.typtype = 'd' THEN (SELECT string_agg(pg_get_constraintdef(k.oid, true), ' ' ORDER BY k.conname) FROM pg_constraint k WHERE k.contypid = t.oid) END AS checks,
              EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') AS ext
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t0 ON t0.oid = a.atttypid
         -- Array-Spalte: der Elementtyp
         JOIN pg_type t ON t.oid = CASE WHEN t0.typelem <> 0 AND t0.typlen = -1 THEN t0.typelem ELSE t0.oid END
         JOIN pg_namespace tn ON tn.oid = t.typnamespace
        WHERE n.nspname = $1 AND c.relname = ANY ($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
          AND tn.nspname NOT IN ('pg_catalog', 'information_schema') AND t.typtype IN ('e', 'd', 'c', 'r', 'b')
        ORDER BY ord, schema, name`,
      [schema, tables],
    );
    return rows.map((r): TypeDdl => {
      const full = `${quote(r.schema)}.${quote(r.name)}`;
      if (r.ext) return { schema: r.schema, name: r.name, kind: 'TYPE', note: `Typ ${r.name} kommt aus einer Erweiterung – sie muss im Ziel installiert sein.` };
      if (r.kind === 'e') return { schema: r.schema, name: r.name, kind: 'TYPE', ddl: `CREATE TYPE ${full} AS ENUM (${r.labels ?? ''})` };
      if (r.kind === 'd') {
        let ddl = `CREATE DOMAIN ${full} AS ${r.base ?? 'text'}`;
        if (r.def != null) ddl += ` DEFAULT ${r.def}`;
        if (r.notnull) ddl += ' NOT NULL';
        if (r.checks) ddl += ` ${r.checks}`;
        return { schema: r.schema, name: r.name, kind: 'DOMAIN', ddl };
      }
      const what = r.kind === 'c' ? 'Der zusammengesetzte Typ' : r.kind === 'r' ? 'Der Bereichstyp' : 'Der Basistyp';
      return { schema: r.schema, name: r.name, kind: 'TYPE', note: `${what} ${r.name} wird nicht mitgenommen – er muss im Ziel vorhanden sein.` };
    });
  }

  async listRoutines(database: string, schema: string): Promise<RoutineInfo[]> {
    // ohne Funktionen aus Erweiterungen (pg_depend 'e') und ohne Aggregate
    const p = await this.q<{ name: string; kind: string; args: string }>(
      database,
      `SELECT p.proname AS name, p.prokind AS kind, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname, 3`,
      [schema],
    );
    const t = await this.q<{ name: string; tbl: string }>(
      database,
      `SELECT t.tgname AS name, c.relname AS tbl
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`,
      [schema],
    );
    return [
      ...p.map((x): RoutineInfo => ({ name: x.name, kind: x.kind === 'p' ? 'procedure' : 'function', args: x.args })),
      ...t.map((x): RoutineInfo => ({ name: x.name, kind: 'trigger', table: x.tbl })),
    ];
  }

  async searchObjects(database: string | null, pattern: string, limit: number): Promise<SearchHit[]> {
    const db = database ?? this.defaultDb;
    const user = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`;
    const relkind = `CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END`;
    const rows = await this.q<{ schema: string; name: string; kind: string; extra: string | null; type: string | null; okind: string | null }>(
      db,
      `SELECT * FROM (
         SELECT n.nspname AS schema, c.relname AS name, ${relkind} AS kind, NULL::text AS extra, NULL::text AS type, NULL::text AS okind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND ${user} AND c.relname ILIKE $1
         UNION ALL
         SELECT n.nspname, c.relname, 'column', a.attname, format_type(a.atttypid, a.atttypmod), ${relkind}
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND ${user} AND a.attname ILIKE $1
         UNION ALL
         SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, pg_get_function_identity_arguments(p.oid), NULL, NULL
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prokind IN ('f', 'p') AND ${user} AND p.proname ILIKE $1
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         UNION ALL
         SELECT n.nspname, t.tgname, 'trigger', c.relname, NULL, NULL
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND ${user} AND t.tgname ILIKE $1
       ) x ORDER BY schema, name LIMIT $2`,
      [pattern, Math.max(1, Math.floor(limit))],
    );
    return rows.map((r) => searchHit(db, r.schema, r.kind, r.name, r.extra, r.type, r.okind));
  }

  async routineDdl(database: string, schema: string, r: RoutineInfo): Promise<string> {
    if (r.kind === 'trigger') {
      const [x] = await this.q<{ def: string }>(
        database,
        `SELECT pg_get_triggerdef(t.oid, true) AS def
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`,
        [schema, r.table ?? '', r.name],
      );
      if (!x) throw new Error(`Trigger ${r.name} nicht gefunden.`);
      return x.def;
    }
    const [x] = await this.q<{ def: string }>(
      database,
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3`,
      [schema, r.name, r.args ?? ''],
    );
    if (!x) throw new Error(`${r.name} nicht gefunden.`);
    return x.def.trimEnd();
  }

  async getDdl(database: string, schema: string, name: string, kind: ObjectKind): Promise<string> {
    const target = `${quote(schema)}.${quote(name)}`;
    if (kind === 'view') {
      const [r] = await this.q<{ def: string; kind: string; reloptions: unknown; populated: boolean; idx: unknown }>(
        database,
        `SELECT pg_get_viewdef(c.oid, true) AS def, c.relkind AS kind, c.reloptions, c.relispopulated AS populated,
                ARRAY(SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix WHERE ix.indrelid = c.oid ORDER BY 1) AS idx
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, name],
      );
      if (!r) throw new Error(`${name} nicht gefunden.`);
      const mat = r.kind === 'm';
      // Optionen (security_invoker, security_barrier …) und CHECK OPTION stehen in reloptions
      const options = parseArray(r.reloptions);
      const check = options.find((o) => /^check_option=/i.test(o))?.split('=')[1];
      const withOptions = options.filter((o) => !/^check_option=/i.test(o));
      let ddl = `CREATE ${mat ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${target}${withOptions.length ? ` WITH (${withOptions.join(', ')})` : ''} AS\n${r.def.trimEnd().replace(/;$/, '')}`;
      if (!mat && check) ddl += `\nWITH ${check.toUpperCase()} CHECK OPTION`;
      if (mat && r.populated === false) ddl += '\nWITH NO DATA';
      ddl += ';';
      // Matview: ihre Indizes (z. B. der UNIQUE-Index für REFRESH … CONCURRENTLY)
      if (mat) for (const i of parseArray(r.idx)) ddl += `\n\n${i};`;
      return ddl;
    }
    // PostgreSQL hat kein SHOW CREATE TABLE: aus dem Katalog zusammensetzen
    const [rel] = await this.q<{ kind: string; partkey: string | null; server: string | null; ftoptions: unknown }>(
      database,
      `SELECT c.relkind AS kind, CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey, fs.srvname AS server, ft.ftoptions
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_foreign_table ft ON ft.ftrelid = c.oid
         LEFT JOIN pg_foreign_server fs ON fs.oid = ft.ftserver
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    if (!rel) throw new Error(`${name} nicht gefunden.`);
    const cols = await this.columns(database, schema, name);
    const cons = await this.q<{ name: string; def: string }>(
      database,
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND con.conparentid = 0
        ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname`,
      [schema, name],
    );
    // Indizes, die nicht schon als Constraint dieser Tabelle (PK, UNIQUE, EXCLUDE) ausgegeben werden – conindid eines
    // fremden Fremdschlüssels zeigt auf den Index hier, der zählt nicht
    const idx = await this.q<{ def: string }>(
      database,
      `SELECT pg_get_indexdef(ix.indexrelid) AS def
         FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2
          AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x'))
        ORDER BY 1`,
      [schema, name],
    );
    // pg_get_expr liefert den Ausdruck meist schon in Klammern – keine zweiten darum
    const wrapped = (e: string) => {
      if (!e.startsWith('(') || !e.endsWith(')')) return `(${e})`;
      let depth = 0;
      for (let i = 0; i < e.length; i++) {
        if (e[i] === '(') depth++;
        else if (e[i] === ')' && --depth === 0 && i < e.length - 1) return `(${e})`;
      }
      return e;
    };
    const lines = cols.map((c) => {
      let l = `  ${quote(c.name)} ${c.dataType}`;
      if (c.generated !== undefined) l += ` GENERATED ALWAYS AS ${wrapped(c.generated)} STORED`;
      else if (c.identity) l += ` GENERATED ${c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      else if (c.defaultValue != null) l += ` DEFAULT ${c.defaultValue}`;
      if (!c.nullable) l += ' NOT NULL';
      return l;
    });
    for (const k of cons) lines.push(`  CONSTRAINT ${quote(k.name)} ${k.def}`);
    if (rel.kind === 'f') {
      // Fremdtabelle: Server und Optionen statt Indizes
      const opts = parseArray(rel.ftoptions).map((o) => {
        const eq = o.indexOf('=');
        return `${o.slice(0, eq)} '${o.slice(eq + 1).replace(/'/g, "''")}'`;
      });
      return `CREATE FOREIGN TABLE ${target} (\n${lines.join(',\n')}\n) SERVER ${quote(rel.server ?? '')}${opts.length ? ` OPTIONS (${opts.join(', ')})` : ''};`;
    }
    let ddl = `CREATE TABLE ${target} (\n${lines.join(',\n')}\n)${rel.partkey ? ` PARTITION BY ${rel.partkey}` : ''};`;
    for (const i of idx) ddl += `\n\n${i.def};`;
    return ddl;
  }

  /**
   * Tabellenansicht und Export lesen nur: eigene Verbindung in einer READ-ONLY-Transaktion, danach ROLLBACK.
   * So kann auch eine Funktion mit Nebenwirkung in der freien WHERE-Bedingung nichts verändern.
   */
  private async readOnly<T>(database: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const { client, release } = await this.lease(database);
    let ok = false;
    try {
      await client.query('BEGIN READ ONLY');
      // höchstens 60 s (gilt nur in dieser Transaktion)
      await client.query("SET LOCAL statement_timeout = '60s'");
      const r = await fn(client);
      ok = true;
      return r;
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        ok = false;
      }
      release(!ok);
    }
  }

  async fetchTable(req: TableDataRequest): Promise<TableDataResult> {
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql, params } = buildTableQuery(dialect, req, columns, false);
    const t0 = performance.now();
    // erweitertes Protokoll auch ohne Parameter: im einfachen ließe der Server mehrere Anweisungen in einem Text zu
    const r = await this.readOnly(database, (c) => c.query({ text: sql, values: params, rowMode: 'array', queryMode: 'extended' } as pg.QueryConfig));
    const bytea = byteaFlags(r.fields);
    return {
      columns: columnsOf(r.fields),
      rows: (r.rows as unknown[][]).map((row) => withBytea(row, bytea).map(normalizeCell)),
      sql: buildTableQuery(dialect, req, columns, false, true).sql,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  async countTable(req: TableDataRequest): Promise<number> {
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql, params } = buildTableQuery(dialect, req, columns, true);
    const r = await this.readOnly(database, (c) => c.query<{ cnt: string }>({ text: sql, values: params, queryMode: 'extended' } as pg.QueryConfig));
    return Number(r.rows[0].cnt);
  }

  async streamTable(req: TableDataRequest, sink: RowSink, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(ABORTED);
    const { database, schema, name } = req.object;
    const columns = await this.columns(database, schema, name);
    const { sql, params } = buildTableQuery(dialect, { ...req, limit: req.top ?? 0, offset: 0 }, columns, false);
    const { client, release } = await this.lease(database);
    let ok = false;
    let backend: { pid: number; start: string } | undefined;
    let stopped = false;
    /**
     * Abbruch (Auftrag abgebrochen, Verbindung wird getrennt): Anweisung auf dem Server beenden – ein zerstörter Socket
     * allein ließe sie zu Ende laufen – und den Socket verwerfen, damit das Lesen sofort endet
     */
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (backend) void this.cancelBackend(database, backend);
      destroyStream(client);
    };
    this.streams.add(stop);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      backend = (await client.query<{ pid: number; start: string }>(BACKEND_SQL)).rows[0];
      // nur lesen (siehe readOnly)
      await client.query('BEGIN READ ONLY');
      // Dump: timestamptz in UTC (+00), unabhängig von der Zeitzone dieser Sitzung; gilt nur in dieser Transaktion
      if (req.utc) await client.query("SET LOCAL TIME ZONE 'UTC'");
      if (signal?.aborted) throw new Error(ABORTED);
      const cursor = client.query(cursorFor(sql, params));
      let first = true;
      let bytea: boolean[] = [];
      let n = FIRST_BATCH;
      for (;;) {
        const rows = await readCursor(cursor, n);
        if (first) {
          first = false;
          const fields = cursorResult(cursor).fields;
          bytea = byteaFlags(fields);
          await sink.begin(columnsOf(fields));
        }
        if (!rows.length) break;
        n = nextBatch(n, rows);
        await sink.rows(rows.map((r) => r.map((v, i) => byteaCell(v, bytea[i]))));
      }
      await closeCursor(client, cursor);
      await client.query('ROLLBACK');
      ok = true;
    } catch (e) {
      throw signal?.aborted || stopped ? new Error(ABORTED) : e;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.streams.delete(stop);
      // bei Fehler Verbindung verwerfen (Cursor evtl. offen)
      release(!ok);
    }
  }

  /** pg_cancel_backend über eine andere Pool-Verbindung – nur die eigene Sitzung (pid und Startzeit) */
  private async cancelBackend(database: string, b: { pid: number; start: string }): Promise<void> {
    const pool = this.pools.get(database || this.defaultDb);
    if (!pool) return;
    try {
      await pool.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2', [b.pid, b.start]);
    } catch {
      // Server weg oder Pool schon geschlossen: die Verbindung wird ohnehin verworfen
    }
  }

  async completionInfo(database: string): Promise<CompletionInfo> {
    const rows = await this.q<{ s: string; t: string; kind: string; c: string }>(
      database,
      `SELECT n.nspname AS s, c.relname AS t, c.relkind AS kind, a.attname AS c
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        ORDER BY n.nspname, c.relname, a.attnum`,
    );
    const tables = new Map<string, CompletionInfo['tables'][number]>();
    for (const r of rows) {
      const key = r.s + '.' + r.t;
      let t = tables.get(key);
      if (!t) {
        t = { schema: r.s, name: r.t, kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table', columns: [] };
        tables.set(key, t);
      }
      t.columns.push(r.c);
    }
    // Namen ohne Schema: search_path, nur vorhandene Schemas, ohne pg_catalog (current_schemas(false))
    let searchPath: string[] | undefined;
    try {
      // als Zeilen in der Reihenfolge des Pfads (Arrays kämen hier als Text '{public}')
      const rows = await this.q<{ s: string }>(database, 'SELECT s FROM unnest(current_schemas(false)) WITH ORDINALITY AS u(s, i) ORDER BY i');
      searchPath = rows.map((r) => r.s);
    } catch {
      // ohne Suchpfad nimmt die Oberfläche public an
    }
    return { tables: [...tables.values()], searchPath };
  }

  async applyWrites(database: string, ops: WriteOp[]): Promise<number[]> {
    const { client, release } = await this.lease(database);
    try {
      await client.query('BEGIN');
      // nicht unbegrenzt auf Zeilensperren warten (MySQL und SQL Server brechen nach einer Frist ab, PostgreSQL nicht)
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const counts: number[] = [];
      for (const op of ops) {
        const r = await client.query(op.sql, op.params);
        const n = r.rowCount ?? 0;
        checkAffected(op, n);
        counts.push(n);
      }
      await client.query('COMMIT');
      return counts;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code === '55P03') throw new Error('Eine andere Sitzung hält die Zeile gesperrt (10 s gewartet) – es wurde nichts gespeichert. Bitte später noch einmal versuchen.');
      if (code === '57014') throw new Error('Das Speichern hat länger als 60 s gedauert und wurde abgebrochen – es wurde nichts gespeichert.');
      throw e;
    } finally {
      release();
    }
  }

  /** pg_stat_activity (alle Datenbanken des Servers); ohne Rechte sieht man nur die Abfragen eigener Sitzungen */
  /** Server hinter der Verbindung: Port und Startzeit des Postmasters – erkennt eine zweite Verbindung zum selben Server */
  async serverIdentity(): Promise<string> {
    const [r] = await this.q<{ ident: string }>(undefined, "SELECT COALESCE(inet_server_port()::text, '') || '|' || pg_postmaster_start_time()::text AS ident");
    return r?.ident ?? '';
  }

  async listServerSessions(): Promise<ServerSessions> {
    const { client, release } = await this.lease(undefined);
    try {
      const me = (await client.query<{ ident: string; self: number }>(PG_IDENT)).rows[0];
      let rows: Record<string, unknown>[];
      try {
        rows = (await client.query(PG_SESSIONS)).rows;
      } catch (e) {
        // vor PostgreSQL 10 ohne backend_type
        if (!/backend_type/.test(errorText(e))) throw e;
        rows = (await client.query(PG_SESSIONS.replace('backend_type', "'client backend' AS backend_type"))).rows;
      }
      const num = (v: unknown) => (v == null ? undefined : Number(v));
      const sessions: ServerSession[] = rows.map((r) => {
        const state = String(r.state ?? '');
        const system = r.backend_type !== 'client backend';
        return {
          id: String(r.id),
          started: String(r.started),
          user: (r.usename as string | null) ?? undefined,
          client: (r.client as string | null) ?? undefined,
          program: (r.application_name as string | null) || undefined,
          database: (r.datname as string | null) ?? undefined,
          state: system ? String(r.backend_type) : state,
          active: state === 'active',
          seconds: num(r.secs),
          txSeconds: num(r.tx_secs),
          // Warten auf den Client (ClientRead) ist bei Leerlauf normal
          wait: state === 'active' && r.wait ? String(r.wait) : undefined,
          blockedBy: parseArray(r.blocked_by),
          query: (r.query as string | null) || undefined,
          system,
        };
      });
      return { server: me.ident, self: String(me.self), sessions, canCancelQuery: true };
    } finally {
      release();
    }
  }

  /** pg_cancel_backend bzw. pg_terminate_backend – nur wenn pid UND Startzeit noch passen (pids werden wiederverwendet) */
  async killServerSession(id: string, started: string | undefined, server: string, mode: 'query' | 'session'): Promise<void> {
    const { client, release } = await this.lease(undefined);
    try {
      const me = (await client.query<{ ident: string; self: number }>(PG_IDENT)).rows[0];
      if (me.ident !== server) throw new Error(KILL_TEXT.otherServer);
      if (String(me.self) === id) throw new Error(KILL_TEXT.self);
      const fn = mode === 'query' ? 'pg_cancel_backend' : 'pg_terminate_backend';
      const r = await client.query<{ ok: boolean }>(`SELECT ${fn}(pid) AS ok FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2`, [
        Number(id),
        started ?? '',
      ]);
      if (!r.rows.length) throw new Error(KILL_TEXT.gone);
      if (r.rows[0].ok !== true) throw new Error('PostgreSQL hat das Signal nicht zugestellt – die Sitzung ist vermutlich schon beendet.');
    } finally {
      release();
    }
  }

  async openSession(database?: string): Promise<Session> {
    const s = new PostgresSession(this.cfg, database || this.defaultDb);
    s.readOnly = !!this.cfg.readOnly;
    await s.connect();
    return s;
  }

  /** laufende Ströme abbrechen, dann die Pools schließen – mit Frist: pool.end() wartete sonst auf ausgeliehene Clients */
  async close(): Promise<void> {
    this.closed = true;
    for (const stop of [...this.streams]) stop();
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => withTimeout(p.end(), 5000, 'Das Trennen').catch(() => undefined)));
  }
}

/** Server (Adresse, Port, Startzeit) und pid der Verbindung, über die abgefragt wird */
const PG_IDENT = `SELECT COALESCE(host(inet_server_addr()), 'lokal') || ':' || COALESCE(inet_server_port()::text, '') || '|' || pg_postmaster_start_time()::text AS ident,
       pg_backend_pid() AS self`;
const PG_SESSIONS = `SELECT pid AS id, backend_start::text AS started, usename, application_name, datname, state, backend_type,
       CASE WHEN client_addr IS NOT NULL THEN host(client_addr) || ':' || client_port WHEN client_port = -1 THEN 'Unix-Socket' END AS client,
       EXTRACT(EPOCH FROM now() - CASE WHEN state = 'active' THEN query_start ELSE state_change END) AS secs,
       EXTRACT(EPOCH FROM now() - xact_start) AS tx_secs,
       CASE WHEN wait_event IS NOT NULL THEN wait_event_type || ': ' || wait_event END AS wait,
       pg_blocking_pids(pid)::text AS blocked_by, query
  FROM pg_stat_activity`;

/** Arrays kommen wegen der Text-Parser als '{a,b}' zurück. */
function parseArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  const inner = v.replace(/^\{|\}$/g, '');
  if (!inner) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '\\') cur += inner[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

class PostgresSession extends BaseSession {
  protected readonly dialect = 'postgres';
  private client!: pg.Client;
  /** Prozess-ID und Startzeit des Server-Prozesses: Abbrechen nur, wenn beides passt (Proxy/Load-Balancer) */
  private backend?: { pid: number; start: string };

  constructor(
    private cfg: DriverConfig,
    public database: string,
  ) {
    super();
  }

  get serverId(): string | undefined {
    return this.backend ? String(this.backend.pid) : undefined;
  }

  /** exakt aus dem Protokoll: T = Transaktion offen, E = Transaktion nach Fehler abgebrochen (wartet auf ROLLBACK) */
  get inTransaction(): boolean {
    const st = this.client?.getTransactionStatus?.();
    return st === 'T' || st === 'E';
  }

  async connect(): Promise<void> {
    const c = new pg.Client(clientConfig(this.cfg, this.database));
    c.on('notice', (n) => this.messages.push(`${n.severity ?? 'NOTICE'}: ${n.message}`));
    // getrennt (z. B. Proxy-Timeout): beim nächsten Ausführen neu verbinden; alte Clients nach Datenbankwechsel zählen nicht
    c.on('error', () => this.client === c && (this.broken = true));
    c.on('end', () => this.client === c && (this.broken = true));
    await c.connect();
    const r = await c.query<{ pid: number; start: string }>(
      'SELECT pid, backend_start::text AS start FROM pg_stat_activity WHERE pid = pg_backend_pid()',
    );
    this.client = c;
    this.backend = r.rows[0];
    this.broken = false;
  }

  /** Datenbankwechsel heißt bei PostgreSQL: neu verbinden – eine offene Transaktion ginge dabei verloren */
  async setDatabase(database: string): Promise<void> {
    if (database === this.database) return;
    if (this.inTransaction) {
      throw new Error('In diesem Tab ist eine Transaktion offen. Bitte zuerst COMMIT oder ROLLBACK – der Datenbankwechsel würde sie bei PostgreSQL verwerfen.');
    }
    const old = this.client;
    const prev = this.database;
    const prevBackend = this.backend;
    this.database = database;
    try {
      await this.connect();
    } catch (e) {
      this.database = prev;
      this.client = old;
      this.backend = prevBackend;
      throw e;
    }
    await old.end().catch(() => undefined);
  }

  protected async refreshDatabase(): Promise<void> {
    // bleibt pro Verbindung fest
  }

  protected async pingOnce(): Promise<void> {
    await this.client.query('SELECT 1');
  }

  protected async beginReadOnly(): Promise<void> {
    await this.client.query('BEGIN READ ONLY');
  }

  async copyIn(sql: string): Promise<CopyTarget> {
    if (this.readOnly) throw new Error('Nur lesen: COPY ist in diesem Modus nicht erlaubt.');
    const stream = this.client.query(copyFrom(sql));
    let failure: Error | undefined;
    const finished = new Promise<number>((resolve, reject) => {
      stream.on('finish', () => resolve(Number(stream.rowCount ?? 0)));
      stream.on('error', (e: Error) => {
        failure = e;
        reject(e);
      });
    });
    finished.catch(() => undefined);
    return {
      // neben 'drain' auch auf 'error'/'close' warten: scheitert COPY vor der ersten Bestätigung (Tabelle fehlt) oder
      // bricht die Verbindung ab, kommt kein 'drain' mehr – write() hinge sonst für immer
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          if (failure) return reject(failure);
          if (stream.write(chunk)) return resolve();
          const done = (e?: Error) => {
            stream.off('drain', onDrain);
            stream.off('error', onError);
            stream.off('close', onClose);
            if (e) reject(e);
            else resolve();
          };
          const onDrain = () => done();
          const onError = (e: Error) => done(e);
          const onClose = () => done(failure ?? new Error('COPY: der Datenstrom wurde geschlossen.'));
          stream.once('drain', onDrain);
          stream.once('error', onError);
          stream.once('close', onClose);
        }),
      end: () => {
        stream.end();
        return finished;
      },
      abort: () => stream.destroy(new Error('Abgebrochen.')),
    };
  }

  protected async endReadOnly(): Promise<void> {
    await this.client.query('ROLLBACK');
  }

  /**
   * EXPLAIN mit FORMAT JSON; ANALYZE führt die Anweisung aus (BUFFERS: gelesene/gefundene Blöcke je Schritt).
   * In einer offenen Transaktion mit Savepoint: ein Fehler (z. B. EXPLAIN vor SHOW) würde sie sonst abbrechen.
   */
  protected async explainOne(sql: string, analyze: boolean): Promise<StatementPlan[]> {
    const savepoint = this.client.getTransactionStatus?.() === 'T';
    if (savepoint) await this.client.query('SAVEPOINT owlyndb_plan');
    let cell: unknown;
    try {
      const r = await this.client.query({ text: `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${sql}`, rowMode: 'array' });
      cell = (r.rows as unknown[][])[0]?.[0];
    } catch (e) {
      if (savepoint) await this.client.query('ROLLBACK TO SAVEPOINT owlyndb_plan').catch(() => undefined);
      throw e;
    } finally {
      if (savepoint) await this.client.query('RELEASE SAVEPOINT owlyndb_plan').catch(() => undefined);
    }
    if (cell === undefined) throw new Error('PostgreSQL hat keinen Plan geliefert.');
    return [postgresPlan(sql, typeof cell === 'string' ? JSON.parse(cell) : cell, analyze)];
  }

  /** nur echte Verbindungsabbrüche (die melden sich auch über 'end'/'error'), nicht z. B. eine abgebrochene Transaktion */
  protected isConnectionLoss(e: unknown): boolean {
    return this.broken || /Connection terminated|not queryable|ECONNRESET|EPIPE|socket hang up/i.test(errorText(e));
  }

  /**
   * Eine Abfrage läuft über einen Cursor (erweitertes Protokoll): PostgreSQL liefert nur max. Zeilen + 1 und hört
   * dann auf, statt ein riesiges Ergebnis zu schicken (wie pgJDBC bei setMaxRows). Mehrere Anweisungen in einem Text
   * und alles, was keine Zeilen liefert, laufen wie bisher als einfache Abfrage, über max. Zeilen hinaus nur gezählt.
   */
  protected async execOne(sql: string, maxRows: number): Promise<ExecResult> {
    const code = withoutLeadingComments(sql);
    // maxRows 0 = alle Zeilen (Einspielen, Kopieren): dann keine Zeilengrenze über den Cursor
    if (maxRows <= 0 || !RETURNS_ROWS.test(code) || SIMPLE_ONLY.test(code) || splitSql(sql, 'postgres').length > 1) return this.execSimple(sql, maxRows);
    const limit = maxRows + 1;
    const cursor = this.client.query(cursorFor(sql));
    const rows = await readCursor(cursor, limit);
    await closeCursor(this.client, cursor);
    const res = cursorResult(cursor);
    const out: ExecResult = { sets: [] };
    if (res.fields?.length) {
      const bytea = byteaFlags(res.fields);
      const set = new ResultCollector(columnsOf(res.fields), maxRows, (row) => row.map(normalizeCell));
      for (const row of rows) set.add(withBytea(row, bytea));
      out.sets.push(set.result(limit));
    } else if (res.rowCount != null && res.command !== 'SELECT') {
      out.rowsAffected = res.rowCount;
    }
    return out;
  }

  /** mehrere Anweisungen in einem Text: einfache Abfrage, Zeilen einzeln (über max. Zeilen hinaus nur gezählt) */
  private execSimple(sql: string, maxRows: number): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const q = new pg.Query({ text: sql, rowMode: 'array' } as pg.QueryConfig);
      const sets = new Map<pg.QueryResult, { set: ResultCollector; bytea: boolean[] }>();
      const collector = (res: pg.QueryResult) => {
        let c = sets.get(res);
        if (!c) {
          c = { set: new ResultCollector(columnsOf(res.fields), maxRows, (row) => row.map(normalizeCell)), bytea: byteaFlags(res.fields) };
          sets.set(res, c);
        }
        return c;
      };
      // mit eigenem 'row'-Empfänger sammelt pg die Zeilen nicht selbst
      q.on('row', (row: unknown[], res?: pg.QueryResult) => {
        if (res) {
          const c = collector(res);
          c.set.add(withBytea(row, c.bytea));
        }
      });
      q.on('error', reject);
      // bei mehreren Anweisungen eine Liste (die Typen kennen nur den Einzelfall)
      q.on('end', (end: pg.QueryResult) => {
        const r = end as pg.QueryResult | pg.QueryResult[];
        const out: ExecResult = { sets: [] };
        for (const res of Array.isArray(r) ? r : [r]) {
          if (res.fields?.length) out.sets.push(collector(res).set.result());
          else if (res.rowCount != null && res.command !== 'SELECT') out.rowsAffected = (out.rowsAffected ?? 0) + res.rowCount;
        }
        resolve(out);
      });
      this.client.query(q);
    });
  }

  /** Export: über den Cursor häppchenweise, bytea als Binärdaten */
  protected async streamOne(sql: string, resultIndex: number, sink: RowSink): Promise<boolean> {
    if (splitSql(sql, 'postgres').length > 1) throw new Error('Für den Export bitte nur eine Anweisung markieren (hier stehen mehrere in einem Abschnitt).');
    const cursor = this.client.query(cursorFor(sql));
    let started = false;
    let bytea: boolean[] = [];
    let n = FIRST_BATCH;
    try {
      for (;;) {
        const rows = await readCursor(cursor, n);
        // zwischen zwei Stapeln läuft auf dem Server nichts, pg_cancel_backend griffe dort nicht: selbst prüfen
        if (this.cancelRequested) throw new Error(ABORTED);
        const fields = cursorResult(cursor).fields ?? [];
        if (!fields.length || resultIndex !== 0) break;
        if (!started) {
          started = true;
          bytea = byteaFlags(fields);
          await sink.begin(columnsOf(fields));
        }
        if (!rows.length) break;
        n = nextBatch(n, rows);
        await sink.rows(rows.map((r) => r.map((v, i) => byteaCell(v, bytea[i]))));
        if (this.cancelRequested) throw new Error(ABORTED);
      }
    } finally {
      await closeCursor(this.client, cursor);
    }
    return started;
  }

  /**
   * pg_cancel_backend nur, wenn Prozess-ID UND Startzeit stimmen: hinter einem Proxy oder Load-Balancer
   * könnte dieselbe PID sonst zu einer fremden Sitzung auf einem anderen Server gehören.
   */
  protected async cancelCurrent(): Promise<void> {
    const b = this.backend;
    if (!b) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = new pg.Client(clientConfig(this.cfg, this.database));
      c.on('error', () => undefined);
      try {
        await c.connect();
        const r = await c.query<{ ok: boolean }>(
          'SELECT pg_cancel_backend(pid) AS ok FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2',
          [b.pid, b.start],
        );
        if (r.rows.length) return;
      } finally {
        await c.end().catch(() => undefined);
      }
    }
    this.messages.push('Abbrechen nicht möglich: die eigene Sitzung war über die Abbruch-Verbindung nicht zu finden (Proxy/Load-Balancer).');
  }

  protected async closeConnection(): Promise<void> {
    await this.client?.end();
  }

  protected destroyConnection(): void {
    destroyStream(this.client);
  }
}
