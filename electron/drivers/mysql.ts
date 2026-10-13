import net from 'node:net';
import mysql from 'mysql2/promise';
import { Types } from 'mysql2';
import type {
  CheckInfo,
  ColumnInfo,
  CompletionInfo,
  DbObject,
  ErModel,
  IndexInfo,
  ForeignKeyInfo,
  ObjectKind,
  ResultColumn,
  ServerInfo,
  TableDataRequest,
  TableDataResult,
  TableInfo,
  StatementInput,
  StatementPlan,
  RoutineInfo,
  SearchHit,
  ServerSession,
} from '../../shared/api-types';
import { literal } from '../../shared/sql-util';
import { mysqlJsonPlan, mysqlTreePlan } from '../plan';
import {
  ABORTED,
  BaseSession,
  buildTableQuery,
  checkAffected,
  searchHit,
  DriverConfig,
  ExecResult,
  erModelFrom,
  KILL_TEXT,
  groupIncoming,
  MetaDriver,
  exportCell,
  normalizeCell,
  NUMERIC_TYPE,
  ResultCollector,
  RowSink,
  RunKind,
  Session,
  ServerSessions,
  SinkQueue,
  TableSqlDialect,
  withTimeout,
  WriteOp,
} from './common';
import { openTunnel } from './tunnel';

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Types as unknown as Record<string, number>).map(([k, v]) => [v, k.toLowerCase()]),
);
const NUMERIC_CODES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

/** Kern-Verbindung hinter der Promise-Hülle: Ereignisse je Zeile, Pausieren, der Socket */
interface CoreConnection extends NodeJS.EventEmitter {
  query(o: { sql: string; values?: unknown[]; rowsAsArray: boolean }): NodeJS.EventEmitter;
  pause(): void;
  resume(): void;
  stream: { destroy(): void };
}

/**
 * Verbindung hart trennen: den Socket zerstören. conn.destroy() wäre nur ein halbes Schließen (stream.end), das auf
 * die Antwort des Servers wartet – eine laufende Abfrage liefe weiter, bis der Server sie beendet. So dagegen meldet
 * mysql2 sofort PROTOCOL_CONNECTION_LOST, und eventQuery endet.
 */
function destroySocket(core: CoreConnection): void {
  core.stream.destroy();
}

/**
 * Abfrage über die Kern-Verbindung, Zeile für Zeile. Ein Verbindungsabbruch erreicht die laufende Abfrage dort nicht
 * (mysql2 meldet ihn nur an der Verbindung) – deshalb hier beides abhören, sonst wartete der Aufrufer ewig.
 * fields: Spalten einer Ergebnismenge bzw. undefined vor einem OK-Paket; result: Zeile (Array) oder OK-Paket.
 */
function eventQuery(
  core: CoreConnection,
  sql: string,
  values: unknown[] | undefined,
  on: { fields(f: mysql.FieldPacket[] | undefined): void; result(row: unknown): void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let failure: unknown;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      core.removeListener('error', onLost);
      core.removeListener('end', onEnd);
      if (failure !== undefined) reject(failure);
      else resolve();
    };
    const onLost = (e: unknown) => {
      failure ??= e;
      finish();
    };
    const onEnd = () => onLost(Object.assign(new Error('Die Verbindung zum Server wurde getrennt.'), { fatal: true }));
    core.on('error', onLost);
    core.on('end', onEnd);
    const q = core.query({ sql, ...(values ? { values } : {}), rowsAsArray: true });
    q.on('fields', (f: mysql.FieldPacket[] | undefined) => {
      if (failure === undefined) on.fields(f);
    });
    q.on('result', (row: unknown) => {
      if (failure !== undefined) return;
      try {
        on.result(row);
      } catch (e) {
        failure = e;
      }
    });
    q.on('error', (e: unknown) => {
      failure ??= e;
    });
    q.on('end', finish);
  });
}

/** Anweisungen, die eine Zeilengrenze des Servers verfälschen würde: Pläne, Sperren (FOR UPDATE sperrt sonst nur die ersten Zeilen) */
const NEEDS_ALL_ROWS = /^(?:EXPLAIN|DESCRIBE|DESC|ANALYZE)\b|\bFOR\s+(?:UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i;
/** Anweisungen mit Ergebnis-Zeilen, die sql_select_limit begrenzt */
const RETURNS_ROWS = /^(?:\(|SELECT\b|WITH\b|TABLE\b|VALUES\b)/i;

function withoutLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}

const quote = (s: string) => '`' + s.replace(/`/g, '``') + '`';

/** Typen, die sich nicht als Text durchsuchen lassen – nur der Typname zählt, nicht die Werteliste eines enum('…')/set('…') */
const NOT_SEARCHABLE = /^((tiny|medium|long)?blob|(var)?binary|geometry|geomcollection|geometrycollection|point|multipoint|polygon|multipolygon|linestring|multilinestring)$/i;

export const mysqlDialect: TableSqlDialect = {
  name: 'mysql',
  quote,
  qualified: (db, _schema, name) => `${quote(db)}.${quote(name)}`,
  searchExpr: (c) => (NOT_SEARCHABLE.test(/^(\w+)/.exec(c.dataType)?.[1] ?? '') ? null : `CAST(${quote(c.name)} AS CHAR)`),
  likeOperator: 'LIKE',
  likeEscape: '',
  param: () => '?',
  literal: (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'",
  page: (sql, limit, offset) => `${sql}\nLIMIT ${limit} OFFSET ${offset}`,
};
const dialect = mysqlDialect;

function baseOptions(cfg: DriverConfig): mysql.ConnectionOptions {
  return {
    // SSH-Weiterleitung: verbunden wird mit dem lokalen Ende (stream), geprüft wird das TLS-Zertifikat gegen den echten Namen
    host: cfg.target?.host ?? cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    // Tunnel: Zertifikate gehören zum Tunnel, ein inneres TLS bleibt ungeprüft
    ...(cfg.tunnel ? { stream: () => openTunnel(cfg) } : cfg.target ? { stream: () => net.connect(cfg.port, cfg.host) } : {}),
    ssl: cfg.tunnel
      ? cfg.ssl
        ? { rejectUnauthorized: false }
        : undefined
      : cfg.ssl
      ? ({
          ca: cfg.tls?.ca,
          cert: cfg.tls?.cert,
          key: cfg.tls?.key,
          passphrase: cfg.tls?.passphrase,
          rejectUnauthorized: !!cfg.tls?.verifyServer,
          verifyIdentity: !!cfg.tls?.verifyServer && !!cfg.tls?.verifyHostname,
        } as mysql.SslOptions)
      : undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    // JSON so, wie es in der Datenbank steht (geparst gingen null, "abc", true und lange Zahlen verloren)
    jsonStrings: true,
    // GEOMETRY roh (SRID + WKB) statt als {x, y}: Anzeige als 0x…, Dump als Hex-Literal, das MySQL wieder annimmt
    typeCast: (field, next) => (field.type === 'GEOMETRY' ? field.buffer() : next()),
    charset: 'utf8mb4',
    connectTimeout: 10000,
    // still verworfene Verbindungen (NAT, Load-Balancer) nach einer halben Minute Leerlauf bemerken, nicht erst nach Stunden
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    // erscheint in performance_schema.session_connect_attrs (Sitzungsliste)
    connectAttributes: { program_name: 'OwlynDB' },
  };
}

function columnsOf(fields: mysql.FieldPacket[]): ResultColumn[] {
  return fields.map((f) => {
    const code = (f as unknown as { columnType?: number; type?: number }).columnType ?? f.type ?? -1;
    return { name: f.name, typeName: TYPE_NAMES[code] ?? '', numeric: NUMERIC_CODES.has(code) };
  });
}

export class MysqlDriver implements MetaDriver {
  private pool: mysql.Pool;
  /** laufende Tabellen-Ströme (Export, Dump, Kopie, Vergleich): close() bricht sie ab, statt auf sie zu warten */
  private streams = new Set<() => Promise<void>>();
  private mariadb?: Promise<boolean>;

  constructor(private cfg: DriverConfig) {
    this.pool = mysql.createPool({ ...baseOptions(cfg), connectionLimit: POOL_SIZE, waitForConnections: true });
    // mysql2 setzt Parameter clientseitig mit Backslash-Maskierung ein; bei sql_mode NO_BACKSLASH_ESCAPES wäre das ein
    // Ausbruch aus dem Literal. Jede neue Pool-Verbindung (Metadaten, Tabellenansicht, Schreiben) legt den Modus ab –
    // die eigene Sitzung des Abfrage-Tabs bleibt, wie der Server sie liefert.
    this.pool.pool.on('connection', (c) => {
      c.query("SET SESSION sql_mode = REPLACE(REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', ''), ',,', ',')", () => undefined);
    });
  }

  /** Verbindung aus dem Pool, mit Frist: eine Warteschlange ohne Ende ließe die Oberfläche still hängen */
  private async acquire(): Promise<mysql.PoolConnection> {
    const p = this.pool.getConnection();
    try {
      return await withTimeout(p, ACQUIRE_TIMEOUT_MS, 'Das Warten auf eine freie Verbindung');
    } catch (e) {
      // kommt die Verbindung später doch, gehört sie wieder dem Pool
      void p.then((c) => c.release(), () => undefined);
      throw e;
    }
  }

  private async q<T = mysql.RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T;
  }

  async serverInfo(): Promise<ServerInfo> {
    const rows = await this.q<{ v: string; db: string | null }[]>('SELECT VERSION() AS v, DATABASE() AS db');
    return { version: rows[0].v, currentDatabase: rows[0].db ?? undefined };
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.q<{ name: string }[]>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    return rows.map((r) => r.name);
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listObjects(database: string): Promise<DbObject[]> {
    const rows = await this.q<{ name: string; type: string; rows: string | null }[]>(
      // MariaDB-Sequenzen sind keine Tabellen (ein Dump machte sonst eine Tabelle mit einer Zeile daraus)
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS \`rows\`
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE NOT IN ('SEQUENCE', 'SYSTEM VIEW') ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((r) => ({
      name: r.name,
      kind: r.type === 'VIEW' ? 'view' : 'table',
      rows: r.rows == null ? undefined : Number(r.rows),
    }));
  }

  /** MariaDB? (liefert Standardwerte anders als MySQL, siehe mysqlDefault; CHECK-Einschränkungen in anderer Tabelle) */
  private isMariaDb(): Promise<boolean> {
    this.mariadb ??= this.q<{ v: string }[]>('SELECT VERSION() AS v').then(
      (r) => /mariadb/i.test(String(r[0]?.v ?? '')),
      () => false,
    );
    return this.mariadb;
  }

  private async columns(database: string, table: string): Promise<ColumnInfo[]> {
    const [rows, mariadb] = await Promise.all([
      this.q<{ name: string; type: string; nullable: string; def: string | null; ckey: string; extra: string; comment: string; expr: string | null }[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
                COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS expr
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, table],
      ),
      this.isMariaDb(),
    ]);
    return rows.map((r) => {
      // VIRTUAL GENERATED / STORED GENERATED (nicht DEFAULT_GENERATED: das ist ein Ausdruck als Standardwert)
      const generated = /\bGENERATED\b/i.test(r.extra) && !/DEFAULT_GENERATED/i.test(r.extra);
      const onUpdate = /on update (\S+)/i.exec(r.extra)?.[1];
      return {
        name: r.name,
        dataType: r.type,
        nullable: r.nullable === 'YES',
        defaultValue: generated ? null : mysqlDefault(r.def, r.extra, r.type, mariadb),
        primaryKey: r.ckey === 'PRI',
        autoIncrement: /auto_increment/i.test(r.extra),
        comment: r.comment || undefined,
        ...(generated ? { generated: r.expr ?? '', stored: /STORED/i.test(r.extra) } : {}),
        ...(onUpdate ? { onUpdate } : {}),
      };
    });
  }

  /** ER-Diagramm: Tabellen, Spalten und Fremdschlüssel der Datenbank in drei Abfragen */
  async erModel(database: string): Promise<ErModel> {
    const tables = await this.q<{ name: string; est: string | number | null }[]>(
      // auch MariaDB-Tabellen mit Systemversionierung
      "SELECT TABLE_NAME AS name, TABLE_ROWS AS est FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') ORDER BY TABLE_NAME",
      [database],
    );
    const cols = await this.q<{ t: string; c: string; type: string; nullable: number | string; pk: number | string }[]>(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY = 'PRI' AS pk
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    );
    const fks = await this.q<{ name: string; t: string; c: string; rs: string; rt: string; rc: string }[]>(
      `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rt,
              REFERENCED_COLUMN_NAME AS rc
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [database],
    );
    return erModelFrom(
      tables.map((t) => ({ schema: '', name: t.name, rows: t.est == null ? undefined : Number(t.est) })),
      cols.map((c) => ({ schema: '', table: c.t, name: c.c, type: c.type, nullable: Number(c.nullable) === 1, pk: Number(c.pk) === 1 })),
      // andere Datenbank: als Schema des Ziels
      fks.map((f) => ({ name: f.name, schema: '', table: f.t, column: f.c, refSchema: f.rs === database ? '' : f.rs, refTable: f.rt, refColumn: f.rc })),
    );
  }

  async describeTable(database: string, _schema: string, name: string): Promise<TableInfo> {
    const [columns, mariadb] = await Promise.all([this.columns(database, name), this.isMariaDb()]);
    // unbekannte Tabelle: ohne Spalten (die Aufrufer melden „nicht gefunden“; SHOW INDEX schlüge mit Fehler fehl)
    if (!columns.length) return { columns, indexes: [], foreignKeys: [], referencedBy: [], checks: [] };
    // SHOW INDEX statt information_schema.STATISTICS: MySQL 8 nennt dort auch den Ausdruck eines Funktionsindex
    // (die Spalte EXPRESSION fehlt in MariaDB – eine Abfrage darauf scheiterte dort)
    const idx = await this.q<Record<string, unknown>[]>(`SHOW INDEX FROM ${quote(database)}.${quote(name)}`);
    const rank = (k: unknown) => (k === 'PRIMARY' ? 0 : 1);
    idx.sort((a, b) => rank(a.Key_name) - rank(b.Key_name) || String(a.Key_name).localeCompare(String(b.Key_name)) || Number(a.Seq_in_index) - Number(b.Seq_in_index));
    const indexes = new Map<string, IndexInfo & { parts: string[] }>();
    for (const r of idx) {
      const key = String(r.Key_name);
      let i = indexes.get(key);
      if (!i) {
        const type = String(r.Index_type ?? '').toUpperCase();
        i = { name: key, columns: [], unique: Number(r.Non_unique) === 0, primary: key === 'PRIMARY', parts: [], ...(type === 'FULLTEXT' || type === 'SPATIAL' ? { kind: type } : {}) };
        indexes.set(key, i);
      }
      const col = r.Column_name == null ? null : String(r.Column_name);
      const expr = r.Expression == null ? null : String(r.Expression);
      i.columns.push(col ?? (expr ? `(${expr})` : '(Ausdruck)'));
      // im Wortlaut für denselben Datenbanktyp: Präfixlänge und Sortierrichtung bleiben erhalten
      if (col) i.parts.push(`${quote(col)}${r.Sub_part != null ? `(${Number(r.Sub_part)})` : ''}${String(r.Collation) === 'D' ? ' DESC' : ''}`);
      else if (expr) i.parts.push(`(${expr})`);
    }
    const list: IndexInfo[] = [...indexes.values()].map(({ parts, ...i }) => (parts.length === i.columns.length ? { ...i, definition: `(${parts.join(', ')})` } : i));
    const fk = await this.q<{ name: string; col: string; refSchema: string; refTable: string; refCol: string; del: string; upd: string }[]>(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refSchema,
              k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, rc.DELETE_RULE AS del, rc.UPDATE_RULE AS upd
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND rc.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [database, name],
    );
    // InnoDB behandelt RESTRICT wie NO ACTION – beides ist die Vorgabe
    const rule = (r: string | null) => (r && !/^(NO ACTION|RESTRICT)$/i.test(r) ? r.toUpperCase() : undefined);
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
    const inc = await this.q<{ name: string; sch: string; tbl: string; col: string; refCol: string }[]>(
      `SELECT CONSTRAINT_NAME AS name, TABLE_SCHEMA AS sch, TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_COLUMN_NAME AS refCol
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
        ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [database, name],
    );
    // CHECK-Einschränkungen (MySQL ab 8.0.16, MariaDB ab 10.2; davor gibt es die Tabelle nicht)
    let checks: CheckInfo[] = [];
    try {
      const rows = mariadb
        ? await this.q<Record<string, unknown>[]>(
            'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_NAME',
            [database, name],
          )
        : await this.q<Record<string, unknown>[]>(
            `SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
               FROM information_schema.TABLE_CONSTRAINTS tc
               JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
              ORDER BY tc.CONSTRAINT_NAME`,
            [database, name],
          );
      const colNames = new Set(columns.map((c) => c.name));
      checks = rows.map((r) => {
        const n = String(r.CONSTRAINT_NAME);
        const e = String(r.CHECK_CLAUSE ?? '');
        // MariaDB: ein CHECK direkt an der Spalte heißt wie die Spalte – im Ziel ohne Namen (MySQL 8 verlangt schemaweit eindeutige Namen)
        return { name: n, expression: /^\(.*\)$/s.test(e) ? e : `(${e})`, ...(mariadb && colNames.has(n) ? { column: true } : {}) };
      });
    } catch {
      // MySQL 5.7: keine CHECK_CONSTRAINTS
    }
    const [meta] = await this.q<{ collation: string | null; type: string; options: string | null }[]>(
      'SELECT TABLE_COLLATION AS collation, TABLE_TYPE AS type, CREATE_OPTIONS AS options FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, name],
    );
    const special = /partitioned/i.test(meta?.options ?? '') ? 'partitioniert' : /SYSTEM VERSIONED/i.test(meta?.type ?? '') ? 'versioniert (WITH SYSTEM VERSIONING)' : undefined;
    return {
      columns,
      indexes: list,
      foreignKeys: [...fks.values()],
      referencedBy: groupIncoming(inc),
      checks,
      ...(meta?.collation ? { collation: meta.collation } : {}),
      ...(special ? { special } : {}),
    };
  }

  async listRoutines(database: string): Promise<RoutineInfo[]> {
    const r = await this.q<{ name: string; type: string }[]>(
      'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
      [database],
    );
    const t = await this.q<{ name: string; tbl: string }[]>(
      'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [database],
    );
    return [
      ...r.map((x): RoutineInfo => ({ name: x.name, kind: x.type === 'FUNCTION' ? 'function' : 'procedure' })),
      ...t.map((x): RoutineInfo => ({ name: x.name, kind: 'trigger', table: x.tbl })),
    ];
  }

  async searchObjects(database: string | null, pattern: string, limit: number): Promise<SearchHit[]> {
    const sys = `('information_schema', 'performance_schema', 'mysql', 'sys')`;
    const where = (col: string, schemaCol: string) =>
      `${database === null ? `${schemaCol} NOT IN ${sys}` : `${schemaCol} = ?`} AND LOWER(${col}) LIKE LOWER(?)`;
    const args = (n: number) => Array.from({ length: n }, () => (database === null ? [pattern] : [database, pattern])).flat();
    const rows = await this.q<{ db: string; name: string; kind: string; extra: string | null; type: string | null; okind: string | null }[]>(
      `SELECT * FROM (
         SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS kind, NULL AS extra, NULL AS type, NULL AS okind
           FROM information_schema.TABLES WHERE ${where('TABLE_NAME', 'TABLE_SCHEMA')} AND TABLE_TYPE NOT IN ('SEQUENCE', 'SYSTEM VIEW')
         UNION ALL
         SELECT c.TABLE_SCHEMA, c.TABLE_NAME, 'column', c.COLUMN_NAME, c.COLUMN_TYPE,
                (SELECT IF(t.TABLE_TYPE = 'VIEW', 'view', 'table') FROM information_schema.TABLES t
                  WHERE t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME)
           FROM information_schema.COLUMNS c WHERE ${where('c.COLUMN_NAME', 'c.TABLE_SCHEMA')}
         UNION ALL
         SELECT ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE), NULL, NULL, NULL
           FROM information_schema.ROUTINES WHERE ${where('ROUTINE_NAME', 'ROUTINE_SCHEMA')}
         UNION ALL
         SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'trigger', EVENT_OBJECT_TABLE, NULL, NULL
           FROM information_schema.TRIGGERS WHERE ${where('TRIGGER_NAME', 'TRIGGER_SCHEMA')}
       ) x ORDER BY db, name LIMIT ${Math.max(1, Math.floor(limit))}`,
      args(4),
    );
    return rows.map((r) => searchHit(r.db, '', r.kind, r.name, r.extra, r.type, r.okind));
  }

  async routineDdl(database: string, _schema: string, r: RoutineInfo): Promise<string> {
    const what = r.kind === 'function' ? 'FUNCTION' : r.kind === 'trigger' ? 'TRIGGER' : 'PROCEDURE';
    const col = r.kind === 'function' ? 'Create Function' : r.kind === 'trigger' ? 'SQL Original Statement' : 'Create Procedure';
    const rows = await this.q<Record<string, string | null>[]>(`SHOW CREATE ${what} ${quote(database)}.${quote(r.name)}`);
    const ddl = rows[0]?.[col];
    if (!ddl) throw new Error(`Der Text von ${r.name} ist nicht lesbar (fehlende Berechtigung – nötig ist z. B. SHOW_ROUTINE).`);
    return ddl;
  }

  async getDdl(database: string, _schema: string, name: string, kind: ObjectKind): Promise<string> {
    const target = `${quote(database)}.${quote(name)}`;
    if (kind === 'view') {
      const rows = await this.q<Record<string, string>[]>(`SHOW CREATE VIEW ${target}`);
      return rows[0]['Create View'] + ';';
    }
    const rows = await this.q<Record<string, string>[]>(`SHOW CREATE TABLE ${target}`);
    return rows[0]['Create Table'] + ';';
  }

  /**
   * Tabellenansicht und Export lesen nur: eigene Verbindung in einer READ-ONLY-Transaktion, danach ROLLBACK.
   * So kann auch eine Funktion mit Nebenwirkung in der freien WHERE-Bedingung nichts verändern.
   */
  private async readOnly<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    let ok = false;
    try {
      // höchstens 60 s pro Abfrage (MySQL: max_execution_time in ms, MariaDB: max_statement_time in s)
      await conn.query('SET SESSION max_execution_time = 60000').catch(() => conn.query('SET SESSION max_statement_time = 60').catch(() => undefined));
      await conn.query('START TRANSACTION READ ONLY');
      const r = await fn(conn);
      ok = true;
      return r;
    } finally {
      try {
        await conn.query('ROLLBACK');
      } catch {
        ok = false;
      }
      if (ok) conn.release();
      else conn.destroy();
    }
  }

  async fetchTable(req: TableDataRequest): Promise<TableDataResult> {
    const columns = await this.columns(req.object.database, req.object.name);
    const { sql, params } = buildTableQuery(dialect, req, columns, false);
    const t0 = performance.now();
    const [rows, fields] = await this.readOnly((c) => c.query({ sql, values: params, rowsAsArray: true }));
    return {
      columns: columnsOf(fields as mysql.FieldPacket[]),
      rows: (rows as unknown[][]).map((r) => r.map(normalizeCell)),
      sql: buildTableQuery(dialect, req, columns, false, true).sql,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  async countTable(req: TableDataRequest): Promise<number> {
    const columns = await this.columns(req.object.database, req.object.name);
    const { sql, params } = buildTableQuery(dialect, req, columns, true);
    const [rows] = await this.readOnly((c) => c.query<mysql.RowDataPacket[]>(sql, params));
    return Number(rows[0].cnt);
  }

  async streamTable(req: TableDataRequest, sink: RowSink, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(ABORTED);
    const columns = await this.columns(req.object.database, req.object.name);
    const { sql, params } = buildTableQuery(dialect, { ...req, limit: req.top ?? 0, offset: 0 }, columns, false);
    const conn = await this.acquire();
    // die Promise-Hülle kann nicht pausieren: auf die Kern-Verbindung durchgreifen
    const core = (conn as unknown as { connection: CoreConnection }).connection;
    let dropped = false;
    let kill: Promise<void> = Promise.resolve();
    /** Abbruch (Auftrag abgebrochen, Verbindung wird getrennt): Abfrage auf dem Server beenden, Verbindung verwerfen */
    const stop = (): Promise<void> => {
      if (dropped) return kill;
      dropped = true;
      kill = this.killQuery(conn.threadId, identity);
      destroySocket(core);
      return kill;
    };
    let identity = '';
    this.streams.add(stop);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const [[me]] = await conn.query<mysql.RowDataPacket[]>(IDENT_SQL);
      identity = String(me.ident);
      // nur lesen (siehe readOnly); Export ohne Zeitgrenze – auch nicht beim Schreiben: Gegendruck hält den Socket an, und
      // der Server bräche die Abfrage sonst nach net_write_timeout (60 s) ab (mysqldump setzt ihn ebenso hoch)
      await conn.query('SET SESSION max_execution_time = 0').catch(() => conn.query('SET SESSION max_statement_time = 0').catch(() => undefined));
      await conn.query(`SET SESSION net_write_timeout = ${NET_WRITE_TIMEOUT_S}`).catch(() => undefined);
      // Dump: TIMESTAMP-Werte in UTC, unabhängig von der Zeitzone dieses Servers (wie mysqldump)
      if (req.utc) await conn.query("SET SESSION time_zone = '+00:00'");
      await conn.query('START TRANSACTION READ ONLY');
      if (signal?.aborted) throw new Error(ABORTED);
      const out = new SinkQueue(sink);
      await eventQuery(core, sql, params, {
        fields: (f) => {
          if (f) out.begin(columnsOf(f));
        },
        result: (row) => {
          if (!Array.isArray(row)) return;
          // Datei lässt sich nicht schreiben: Abfrage abbrechen (die Verbindung wird ohnehin verworfen)
          if (out.failed) {
            void stop();
            return;
          }
          if (!out.push(row.map(exportCell))) return;
          core.pause();
          void out.idle().then(() => core.resume());
        },
      }).catch(async (e) => {
        await out.idle();
        throw out.failure ?? e;
      });
      await out.end();
      if (dropped) throw new Error(ABORTED);
      await conn.query('ROLLBACK');
      // die Verbindung geht zurück in den Pool: Zeitzone wieder wie der Server
      if (req.utc) await conn.query('SET SESSION time_zone = DEFAULT');
      conn.release();
    } catch (e) {
      // Abfrage läuft evtl. noch: Verbindung verwerfen statt zurückgeben
      conn.destroy();
      throw signal?.aborted || dropped ? new Error(ABORTED) : e;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.streams.delete(stop);
    }
  }

  /**
   * KILL QUERY über eine eigene, neue Verbindung (nicht aus dem Pool: der wird beim Trennen gerade geschlossen) –
   * nur, wenn sie beim selben Server landet (Load-Balancer)
   */
  private async killQuery(threadId: number, identity: string): Promise<void> {
    if (!identity) return;
    try {
      const c = await mysql.createConnection(baseOptions(this.cfg));
      try {
        const [[me]] = await c.query<mysql.RowDataPacket[]>(IDENT_SQL);
        if (String(me.ident) === identity) await c.query(`KILL QUERY ${Number(threadId)}`);
      } finally {
        await c.end().catch(() => c.destroy());
      }
    } catch {
      // Server weg: die Verbindung wird ohnehin verworfen
    }
  }

  async completionInfo(database: string): Promise<CompletionInfo> {
    const rows = await this.q<{ t: string; type: string; c: string }[]>(
      `SELECT c.TABLE_NAME AS t, t.TABLE_TYPE AS type, c.COLUMN_NAME AS c
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE NOT IN ('SEQUENCE', 'SYSTEM VIEW') ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      [database],
    );
    const tables = new Map<string, CompletionInfo['tables'][number]>();
    for (const r of rows) {
      let t = tables.get(r.t);
      if (!t) {
        t = { schema: '', name: r.t, kind: r.type === 'VIEW' ? 'view' : 'table', columns: [] };
        tables.set(r.t, t);
      }
      t.columns.push(r.c);
    }
    return { tables: [...tables.values()] };
  }

  async applyWrites(_database: string, ops: WriteOp[]): Promise<number[]> {
    const conn = await this.acquire();
    try {
      await conn.beginTransaction();
      const counts: number[] = [];
      for (const op of ops) {
        const [r] = await conn.query(op.sql, op.params);
        const h = r as mysql.ResultSetHeader;
        // UPDATE zählt sonst nur tatsächlich geänderte Zeilen (gleicher Wert = 0): "Rows matched" ist die Trefferzahl
        const matched = /Rows matched:\s*(\d+)/.exec(h.info ?? '');
        const n = matched ? Number(matched[1]) : h.affectedRows;
        checkAffected(op, n);
        counts.push(n);
      }
      await conn.commit();
      return counts;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Prozessliste; offene Transaktionen, Sperren und Programmnamen nur, soweit Server und Rechte sie zeigen */
  async listServerSessions(): Promise<ServerSessions> {
    const conn = await this.acquire();
    try {
      const [[me]] = await conn.query<mysql.RowDataPacket[]>(IDENT_SQL);
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT * FROM information_schema.PROCESSLIST');
      // erste Abfrage, die klappt (MySQL 8 und MariaDB haben verschiedene Tabellen; ohne Recht PROCESS: leer)
      const first = async (...queries: string[]): Promise<mysql.RowDataPacket[]> => {
        for (const q of queries) {
          try {
            const [r] = await conn.query<mysql.RowDataPacket[]>(q);
            return r;
          } catch {
            // Tabelle fehlt oder kein Recht
          }
        }
        return [];
      };
      const trx = new Map(
        (await first('SELECT trx_mysql_thread_id AS id, trx_state AS st, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS secs FROM information_schema.INNODB_TRX')).map(
          (r) => [String(r.id), { secs: Number(r.secs), waiting: r.st === 'LOCK WAIT' }],
        ),
      );
      const blocked = new Map<string, Set<string>>();
      for (const w of await first(LOCK_WAITS_MYSQL8, LOCK_WAITS_INNODB)) {
        const k = String(w.waiting);
        blocked.set(k, (blocked.get(k) ?? new Set()).add(String(w.blocking)));
      }
      const programs = new Map(
        (await first("SELECT PROCESSLIST_ID AS id, ATTR_VALUE AS v FROM performance_schema.session_connect_attrs WHERE ATTR_NAME = 'program_name'")).map((r) => [
          String(r.id),
          String(r.v),
        ]),
      );
      // letzte Anweisung ruhender Sitzungen (die Prozessliste zeigt nur laufende) – wichtig bei offenen Transaktionen
      const lastSql = new Map(
        (
          await first(`SELECT t.PROCESSLIST_ID AS id, s.SQL_TEXT AS q FROM performance_schema.threads t
            JOIN performance_schema.events_statements_current s ON s.THREAD_ID = t.THREAD_ID WHERE t.PROCESSLIST_ID IS NOT NULL`)
        ).map((r) => [String(r.id), r.q == null ? undefined : String(r.q)]),
      );
      const sessions: ServerSession[] = rows.map((r) => {
        const id = String(r.ID);
        const cmd = String(r.COMMAND ?? '');
        const state = String(r.STATE ?? '');
        const system = cmd === 'Daemon' || r.USER === 'system user' || r.USER === 'event_scheduler';
        const t = trx.get(id);
        return {
          id,
          user: r.USER ?? undefined,
          client: r.HOST ?? undefined,
          program: programs.get(id),
          database: r.DB ?? undefined,
          state: state ? `${cmd} – ${state}` : cmd,
          active: !system && cmd !== 'Sleep',
          // MariaDB: TIME_MS mit Millisekunden
          seconds: r.TIME_MS != null ? Number(r.TIME_MS) / 1000 : Number(r.TIME ?? 0),
          txSeconds: t?.secs,
          wait: t?.waiting ? 'Zeilensperre (InnoDB)' : /lock|waiting/i.test(state) ? state : undefined,
          blockedBy: [...(blocked.get(id) ?? [])],
          query: r.INFO == null ? lastSql.get(id) : String(r.INFO),
          system,
        };
      });
      return { server: String(me.ident), self: String(me.self), sessions, canCancelQuery: true };
    } finally {
      conn.release();
    }
  }

  async killServerSession(id: string, _started: string | undefined, server: string, mode: 'query' | 'session'): Promise<void> {
    const conn = await this.acquire();
    try {
      const [[me]] = await conn.query<mysql.RowDataPacket[]>(IDENT_SQL);
      if (String(me.ident) !== server) throw new Error(KILL_TEXT.otherServer);
      if (String(me.self) === id) throw new Error(KILL_TEXT.self);
      // Thread-IDs zählen bei MySQL nur hoch, eine Prüfung auf Wiederverwendung braucht es nicht
      await conn.query(`KILL ${mode === 'query' ? 'QUERY ' : ''}${Number(id)}`);
    } catch (e) {
      // 1094: Unknown thread id
      if ((e as { errno?: number }).errno === 1094) throw new Error(KILL_TEXT.gone);
      throw e;
    } finally {
      conn.release();
    }
  }

  async openSession(database?: string): Promise<Session> {
    const conn = await mysql.createConnection({ ...baseOptions(this.cfg), database: database || this.cfg.database || undefined });
    const s = new MysqlSession(conn, this.cfg);
    s.readOnly = !!this.cfg.readOnly;
    try {
      await s.init();
    } catch (e) {
      // sonst bliebe die Verbindung offen, ohne dass sie jemand schließen könnte
      conn.destroy();
      throw e;
    }
    return s;
  }

  /** Server hinter der Verbindung (Hostname, Port, server_id) – erkennt eine zweite Verbindung zum selben Server */
  async serverIdentity(): Promise<string> {
    const [me] = await this.q<{ ident: string }[]>(IDENT_SQL);
    return String(me?.ident ?? '');
  }

  /** laufende Ströme abbrechen (KILL QUERY abwarten), dann den Pool schließen – mit Frist: pool.end() reihte QUIT sonst hinter laufende Abfragen */
  async close(): Promise<void> {
    const stops = [...this.streams].map((stop) => stop());
    if (stops.length) await withTimeout(Promise.allSettled(stops), 5000, 'Das Abbrechen').catch(() => undefined);
    await withTimeout(this.pool.end(), 5000, 'Das Trennen').catch(() => undefined);
  }
}

/** MySQL setzt dieses Bit im Status jeder OK-Antwort, solange eine Transaktion offen ist … */
const SERVER_STATUS_IN_TRANS = 1;
/** … und dieses, solange Autocommit an ist */
const SERVER_STATUS_AUTOCOMMIT = 2;

const CURRENT_TS = /^(CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|NOW)(\(\d*\))?$/i;

/**
 * Standardwert in SQL-Form: 'Text', Zahl, NULL, CURRENT_TIMESTAMP(n), b'1' oder (Ausdruck). MySQL liefert in COLUMN_DEFAULT
 * Zeichenketten ohne Anführungszeichen und Ausdrücke mit EXTRA DEFAULT_GENERATED; MariaDB (ab 10.2.7) Literale mit
 * Anführungszeichen, NULL als Wort und Ausdrücke bloß. So kommt in beiden Fällen heraus, was hinter DEFAULT stehen darf.
 */
export function mysqlDefault(raw: string | null, extra: string, type: string, mariadb: boolean): string | null {
  if (raw === null) return null;
  const expr = (e: string) => (/^\(.*\)$/s.test(e) ? e : `(${e})`);
  if (mariadb) {
    if (raw === 'NULL' || raw.startsWith("'") || /^b'[01]*'$/i.test(raw) || /^-?\d/.test(raw) || CURRENT_TS.test(raw)) return raw;
    return expr(raw);
  }
  if (/DEFAULT_GENERATED/i.test(extra)) return CURRENT_TS.test(raw) ? raw : expr(raw);
  // MySQL 5.7: CURRENT_TIMESTAMP ohne das Merkmal
  if (CURRENT_TS.test(raw) && /timestamp|datetime/i.test(type)) return raw;
  if (/^bit\b/i.test(type) && /^b'[01]*'$/i.test(raw)) return raw;
  if (NUMERIC_TYPE.test(type) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return raw;
  return literal('mysql', raw);
}

/** Server, auf dem eine Verbindung landet (hinter einem Load-Balancer nicht immer derselbe), und ihre Thread-ID */
const IDENT_SQL = "SELECT CONCAT_WS('|', @@hostname, @@port, @@server_id) AS ident, CONNECTION_ID() AS self";
/** wer wartet auf wen: MySQL 8 … */
const LOCK_WAITS_MYSQL8 = `SELECT r.trx_mysql_thread_id AS waiting, b.trx_mysql_thread_id AS blocking
  FROM performance_schema.data_lock_waits w
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID`;
/** … MariaDB und MySQL 5.7 */
const LOCK_WAITS_INNODB = `SELECT r.trx_mysql_thread_id AS waiting, b.trx_mysql_thread_id AS blocking
  FROM information_schema.INNODB_LOCK_WAITS w
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id`;

/** "8.0.36-log" ≥ [8, 0, 18]? */
function versionAtLeast(version: string, min: number[]): boolean {
  const v = (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  for (let i = 0; i < min.length; i++) {
    const x = v[i] ?? 0;
    if (x !== min[i]) return x > min[i];
  }
  return true;
}
/** USE … (hinter Kommentaren)? Die Kommentare vorher eindeutig entfernen – ein Muster, das sie selbst überliest, verzweigte sich bei vielen Blockkommentaren exponentiell */
export function isUseStatement(sql: string): boolean {
  return /^use\s/i.test(withoutLeadingComments(sql));
}
/** Pool-Größe: Metadaten, Tabellenansicht, Schreiben, Sitzungsliste und Ströme teilen sie sich */
const POOL_SIZE = 6;
const ACQUIRE_TIMEOUT_MS = 30_000;
/** so lange darf der Server beim Senden auf den Client warten (Gegendruck beim Export) */
const NET_WRITE_TIMEOUT_S = 3600;

class MysqlSession extends BaseSession {
  protected readonly dialect = 'mysql';
  database: string | undefined;
  /** nach bestem Wissen: aus dem Status der letzten OK-Antwort (SELECT liefert keinen) */
  inTransaction = false;
  /** ebenso; anfangs @@autocommit */
  private autocommit = false;
  /** Server, auf dem diese Sitzung läuft – KILL QUERY nur auf genau diesem (Load-Balancer!) */
  private serverIdentity = '';
  /** VERSION(), z. B. "8.4.11" oder "11.8.9-MariaDB-ubu2404" – bestimmt das Format des Ausführungsplans */
  private version = '';
  /** zuletzt gesetztes sql_select_limit; null = Server-Vorgabe */
  private selectLimit: number | null = null;
  private selectLimitFailed = false;
  private exportPrepared = false;

  constructor(
    private conn: mysql.Connection,
    private cfg: DriverConfig,
  ) {
    super();
    // getrennt (z. B. Proxy-Timeout): beim nächsten Ausführen neu verbinden
    conn.on('error', () => (this.broken = true));
    conn.on('end', () => (this.broken = true));
  }

  get serverId(): string {
    return String(this.conn.threadId);
  }

  get autocommitIdle(): boolean {
    return this.autocommit && !this.inTransaction;
  }

  protected async pingOnce(): Promise<void> {
    await this.conn.query('SELECT 1');
  }

  protected async beginReadOnly(): Promise<void> {
    await this.conn.query('START TRANSACTION READ ONLY');
  }

  protected async endReadOnly(): Promise<void> {
    await this.conn.query('ROLLBACK');
    this.inTransaction = false;
  }

  protected isConnectionLoss(e: unknown): boolean {
    return this.broken || (e as { fatal?: boolean })?.fatal === true;
  }

  async init(): Promise<void> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      "SELECT DATABASE() AS db, CONCAT_WS('|', @@hostname, @@port, @@server_id) AS ident, VERSION() AS v, @@autocommit AS ac",
    );
    this.database = rows[0].db ?? undefined;
    this.serverIdentity = rows[0].ident;
    this.version = String(rows[0].v ?? '');
    this.autocommit = Number(rows[0].ac) === 1;
  }

  /**
   * MySQL ab 8.0.16: FORMAT=TREE (ab 8.0.18 auch EXPLAIN ANALYZE), sonst und für einfache UPDATE/DELETE FORMAT=JSON.
   * MariaDB: EXPLAIN bzw. ANALYZE FORMAT=JSON (ANALYZE führt auch UPDATE/DELETE wirklich aus).
   */
  protected async explainOne(sql: string, analyze: boolean): Promise<StatementPlan[]> {
    if (/mariadb/i.test(this.version)) {
      return [mysqlJsonPlan(sql, await this.planText(`${analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON ${sql}`), analyze)];
    }
    const notIterator = /not executable by iterator executor/i;
    if (analyze) {
      if (!versionAtLeast(this.version, [8, 0, 18])) {
        throw new Error(`Einen Plan mit Laufzeit (EXPLAIN ANALYZE) gibt es erst ab MySQL 8.0.18 – dieser Server hat ${this.version}.`);
      }
      const text = await this.planText('EXPLAIN ANALYZE ' + sql);
      if (notIterator.test(text)) throw new Error('Für diese Anweisung liefert MySQL keinen Plan mit Laufzeit – ohne Laufzeit geht es.');
      return [mysqlTreePlan(sql, text, true)];
    }
    if (versionAtLeast(this.version, [8, 0, 16])) {
      const text = await this.planText('EXPLAIN FORMAT=TREE ' + sql);
      if (!notIterator.test(text)) return [mysqlTreePlan(sql, text, false)];
    }
    return [mysqlJsonPlan(sql, await this.planText('EXPLAIN FORMAT=JSON ' + sql), false)];
  }

  /** erste Zelle der Antwort (der Plan als Text) */
  private async planText(q: string): Promise<string> {
    const [rows] = await this.conn.query({ sql: q, rowsAsArray: true });
    const first = Array.isArray(rows) ? (rows as unknown[][])[0] : undefined;
    if (!first) throw new Error('Der Server hat keinen Plan geliefert.');
    return String(first[0]);
  }

  /** nur nach USE nachfragen: jede eigene Abfrage verändert ROW_COUNT() & Co. */
  protected async refreshDatabase(statements: StatementInput[]): Promise<void> {
    if (!statements.some((s) => isUseStatement(s.sql))) return;
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
    this.database = rows[0].db ?? undefined;
  }

  async setDatabase(database: string): Promise<void> {
    await this.conn.query(`USE ${quote(database)}`);
    this.database = database;
  }

  private noteStatus(h: mysql.ResultSetHeader) {
    this.inTransaction = (h.serverStatus & SERVER_STATUS_IN_TRANS) !== 0;
    this.autocommit = (h.serverStatus & SERVER_STATUS_AUTOCOMMIT) !== 0;
    // Warnungen nur zählen: ein eigenes SHOW WARNINGS würde ROW_COUNT() der Nutzerin überschreiben
    if (h.warningStatus) this.messages.push(`${h.warningStatus} Warnung${h.warningStatus === 1 ? '' : 'en'} – Details mit SHOW WARNINGS`);
  }

  private get core(): CoreConnection {
    return (this.conn as unknown as { connection: CoreConnection }).connection;
  }

  /**
   * Zeilengrenze des Servers (sql_select_limit, wie Connector/J bei setMaxRows): MySQL hört nach max. Zeilen + 1
   * von selbst auf, statt ein riesiges Ergebnis zu schicken. Sie gilt nur für Ergebnisse an den Client – nicht für
   * INSERT … SELECT, CREATE … SELECT, Unterabfragen oder Prozeduren. Gesetzt wird nur, wenn sich der Wert ändert
   * (jedes eigene SET überschriebe ROW_COUNT() und die Warnungen der Nutzerin); für Pläne, Sperren und den Export
   * gilt wieder die Server-Vorgabe.
   */
  protected override async prepare(kind: RunKind, statements: StatementInput[], maxRows: number): Promise<void> {
    if (kind === 'export' && !this.exportPrepared) {
      // Gegendruck hält den Socket an: der Server soll nicht nach net_write_timeout (60 s) abbrechen
      this.exportPrepared = true;
      await this.conn.query(`SET SESSION net_write_timeout = ${NET_WRITE_TIMEOUT_S}`).catch(() => undefined);
    }
    let want: number | null | undefined;
    if (kind !== 'run') want = null;
    else if (maxRows > 0) {
      const code = statements.map((s) => withoutLeadingComments(s.sql));
      if (code.some((c) => NEEDS_ALL_ROWS.test(c))) want = null;
      else if (code.some((c) => RETURNS_ROWS.test(c))) want = maxRows + 1;
    }
    if (want === undefined || want === this.selectLimit || this.selectLimitFailed) return;
    try {
      await this.conn.query(`SET SESSION sql_select_limit = ${want ?? 'DEFAULT'}`);
      this.selectLimit = want;
    } catch (e) {
      if (this.isConnectionLoss(e)) throw e;
      // z. B. ein Proxy, der die Variable nicht kennt: dann eben ohne Grenze (die Anzeige behält trotzdem nur max. Zeilen)
      this.selectLimitFailed = true;
    }
  }

  /** Zeile für Zeile: über max. Zeilen hinaus wird nur noch gezählt (CALL, eigenes LIMIT) */
  protected async execOne(sql: string, maxRows: number): Promise<ExecResult> {
    const out: ExecResult = { sets: [] };
    const sets: ResultCollector[] = [];
    let cur: ResultCollector | undefined;
    await eventQuery(this.core, sql, undefined, {
      fields: (f) => {
        cur = f ? new ResultCollector(columnsOf(f), maxRows, (r) => r.map(normalizeCell)) : undefined;
        if (cur) sets.push(cur);
      },
      result: (row) => {
        if (Array.isArray(row)) {
          cur?.add(row);
          return;
        }
        // OK-Paket: Anweisung ohne Ergebnis bzw. Abschluss eines CALL
        const h = row as mysql.ResultSetHeader;
        if (!h || typeof h !== 'object' || !('affectedRows' in h)) return;
        out.rowsAffected = h.affectedRows;
        if (h.info && !sets.length) this.messages.push(h.info);
        this.noteStatus(h);
      },
    });
    out.sets = sets.map((s) => s.result(this.selectLimit ?? undefined));
    return out;
  }

  /** Export: alles holen (sql_select_limit ist dann aufgehoben), mit Gegendruck über Pausieren der Verbindung */
  protected async streamOne(sql: string, resultIndex: number, sink: RowSink): Promise<boolean> {
    const core = this.core;
    const out = new SinkQueue(sink);
    let setNo = -1;
    let active = false;
    let killed = false;
    await eventQuery(core, sql, undefined, {
      fields: (f) => {
        if (active) out.flush();
        active = false;
        if (!f || ++setNo !== resultIndex) return;
        active = true;
        out.begin(columnsOf(f));
      },
      result: (row) => {
        if (!active || !Array.isArray(row)) return;
        if (out.failed) {
          // Datei nicht schreibbar, Abbruch: die Abfrage auf dem Server beenden, statt den Rest zu lesen und wegzuwerfen
          if (!killed) {
            killed = true;
            void this.cancelCurrent().catch(() => undefined);
          }
          return;
        }
        if (!out.push(row.map(exportCell))) return;
        // Datei schreibt: so lange nichts mehr lesen
        core.pause();
        void out.idle().then(() => core.resume());
      },
    }).catch(async (e) => {
      await out.idle();
      throw out.failure ?? e;
    });
    await out.end();
    return out.started;
  }

  /**
   * KILL QUERY über eine eigene, neue Verbindung – aber nur, wenn sie beim selben Server landet.
   * Hinter einem Load-Balancer könnte dieselbe Thread-ID sonst eine fremde Abfrage auf einem anderen Server treffen.
   */
  protected async cancelCurrent(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = await mysql.createConnection(baseOptions(this.cfg));
      try {
        const [rows] = await c.query<mysql.RowDataPacket[]>("SELECT CONCAT_WS('|', @@hostname, @@port, @@server_id) AS ident");
        if (rows[0].ident === this.serverIdentity) {
          await c.query(`KILL QUERY ${Number(this.conn.threadId)}`);
          return;
        }
      } finally {
        await c.end().catch(() => c.destroy());
      }
    }
    this.messages.push('Abbrechen nicht möglich: die Abbruch-Verbindung landete auf einem anderen Server (Load-Balancer).');
  }

  protected async closeConnection(): Promise<void> {
    await this.conn.end();
  }

  protected destroyConnection(): void {
    destroySocket(this.core);
  }
}
