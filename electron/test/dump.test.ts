/* Dump und Einspielen gegen die Test-Datenbanken: alle Paare von Quell- und Zieltyp, besondere Objekte (berechnete Spalten,
   Fremdschlüssel-Regeln, CHECK, Teilindizes, Typen, Matview, Views in Abhängigkeit), native Dumps
   (mysqldump, pg_dump), UTF-16 mit GO, Fehler, Transaktion, Abbruch, MySQL gebündelt festgeschrieben.
   Vorher: npm run testdb:up; npm run test:drivers (Seeds). Aufruf: npm run test:dump */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { ConnectionInput, SqlDialect, JobStatus } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-dump-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
let nextFile = '';
const m = new Manager(store, { pickFile: async () => null, saveFile: async () => nextFile, showInFolder: () => undefined }, 0);

let failed = 0;
async function step(name: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

const targets: Record<SqlDialect, { port: number; user: string; password: string; schema: string }> = {
  mysql: { port: 15306, user: 'root', password: 'dbviewer-test', schema: '' },
  postgres: { port: 15432, user: 'postgres', password: 'dbviewer-test', schema: 'public' },
  mssql: { port: 15433, user: 'sa', password: 'Dbviewer-Test1', schema: 'dbo' },
};
const ids = {} as Record<SqlDialect, string>;

function input(dialect: SqlDialect, extra: Partial<ConnectionInput> = {}): ConnectionInput {
  const t = targets[dialect];
  return {
    name: dialect,
    dialect,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    password: t.password,
    database: dialect === 'postgres' ? 'postgres' : undefined,
    options: dialect === 'mssql' ? { trustServerCertificate: true } : {},
    ...extra,
  };
}

async function waitJob(id: string): Promise<JobStatus> {
  for (;;) {
    const s = await m.jobStatus(id);
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Abfrage auf einer Datenbank; erste Zelle */
async function scalar(dialect: SqlDialect, db: string, sql: string): Promise<unknown> {
  const { sessionId } = await m.openSession(ids[dialect], db);
  try {
    const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
    if (r.statements[0].error) throw new Error(`${sql}: ${r.statements[0].error}`);
    return r.results[0]?.rows[0]?.[0];
  } finally {
    await m.closeSession(sessionId);
  }
}

async function exec(dialect: SqlDialect, db: string | undefined, sql: string) {
  const { sessionId } = await m.openSession(ids[dialect], db);
  try {
    const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
    if (r.statements[0]?.error) throw new Error(`${sql}: ${r.statements[0].error}`);
  } finally {
    await m.closeSession(sessionId);
  }
}

async function dropDb(dialect: SqlDialect, db: string) {
  if (dialect === 'mysql') await exec(dialect, undefined, `DROP DATABASE IF EXISTS \`${db}\``);
  if (dialect === 'postgres') await exec(dialect, 'postgres', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  if (dialect === 'mssql') {
    await exec(dialect, 'master', `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`);
  }
}

/** alle Tabellen und Views der Test-Datenbank shop */
async function everything(dialect: SqlDialect) {
  const schemas = dialect === 'mysql' ? [''] : await m.listSchemas(ids[dialect], 'shop');
  const tables: { schema: string; name: string }[] = [];
  const views: { schema: string; name: string }[] = [];
  for (const schema of schemas) {
    for (const o of await m.listObjects(ids[dialect], 'shop', schema)) {
      if (['kunden_copy', 'ro_test'].includes(o.name)) continue;
      (o.kind === 'view' ? views : tables).push({ schema, name: o.name });
    }
  }
  return { tables, views };
}

async function dump(src: SqlDialect, dst: SqlDialect, file: string) {
  nextFile = file;
  const { tables, views } = await everything(src);
  const id = await m.startDump({
    connectionId: ids[src],
    database: 'shop',
    tables,
    views,
    structure: true,
    data: true,
    dropFirst: true,
    targetDialect: dst,
    rowsPerInsert: 250,
    baseName: 'x',
  });
  const s = await waitJob(id!);
  if (s.state !== 'done') throw new Error(`Dump: ${s.error}`);
  return s;
}

async function load(dst: SqlDialect, db: string, file: string, opts: { createDatabase?: boolean; stopOnError?: boolean; transaction?: boolean; skipUse?: boolean } = {}): Promise<JobStatus> {
  let id: string;
  try {
    id = await m.startImport({
      connectionId: ids[dst],
      database: db,
      createDatabase: opts.createDatabase ?? true,
      file,
      stopOnError: opts.stopOnError ?? true,
      transaction: opts.transaction ?? false,
      skipUse: opts.skipUse ?? true,
    });
  } catch (e) {
    // startImport prüft die Datei vor dem Anlegen der Datenbank (Rohbytes, gz): wie ein gescheiterter Auftrag behandeln
    return { id: '', kind: 'import', state: 'error', error: (e as Error).message, done: 0, statements: 0, current: '', log: [], durationMs: 0 } as unknown as JobStatus;
  }
  return waitJob(id);
}

const t = (d: SqlDialect, name: string, schema?: string) =>
  d === 'mysql' ? `\`${name}\`` : d === 'mssql' ? `${schema ?? 'dbo'}.${name}` : `${schema ?? 'public'}.${name}`;

async function compare(src: SqlDialect, dst: SqlDialect, db: string) {
  const n = (sql: string, d: SqlDialect, database: string) => scalar(d, database, sql).then(Number);
  for (const tb of ['kunden', 'bestellungen']) {
    assert.equal(await n(`SELECT COUNT(*) FROM ${t(dst, tb)}`, dst, db), await n(`SELECT COUNT(*) FROM ${t(src, tb)}`, src, 'shop'), `Zeilen ${tb}`);
  }
  const sum = (d: SqlDialect, database: string) => n(`SELECT SUM(betrag) FROM ${t(d, 'bestellungen')}`, d, database);
  assert.equal(await sum(dst, db), await sum(src, 'shop'), 'Summe betrag');
  const notiz = (d: SqlDialect, database: string) => scalar(d, database, `SELECT notiz FROM ${t(d, 'kunden')} WHERE id = 42`);
  assert.equal(await notiz(dst, db), await notiz(src, 'shop'), 'Text mit % und _');
  const aktiv = (d: SqlDialect, database: string) =>
    n(`SELECT COUNT(*) FROM ${t(d, 'kunden')} WHERE aktiv = ${d === 'postgres' ? 'true' : '1'}`, d, database);
  assert.equal(await aktiv(dst, db), await aktiv(src, 'shop'), 'Wahrheitswerte');
  const bin = (d: SqlDialect, database: string) => n(`SELECT COUNT(*) FROM ${t(d, 'kunden')} WHERE avatar IS NOT NULL`, d, database);
  assert.equal(await bin(dst, db), await bin(src, 'shop'), 'Binärdaten');
  const erstellt = (d: SqlDialect, database: string) => scalar(d, database, `SELECT erstellt FROM ${t(d, 'kunden')} WHERE id = 7`);
  assert.equal(String(await erstellt(dst, db)).slice(0, 19), String(await erstellt(src, 'shop')).slice(0, 19), 'Zeitstempel');
  // Identität läuft hinter dem höchsten Wert weiter
  const ins =
    dst === 'mysql'
      ? `INSERT INTO kunden (name, erstellt, aktiv) VALUES ('neu', '2025-01-01 00:00:00', 1)`
      : dst === 'postgres'
        ? `INSERT INTO public.kunden (name, erstellt, aktiv) VALUES ('neu', '2025-01-01', true)`
        : `INSERT INTO dbo.kunden (name, erstellt, aktiv) VALUES ('neu', '2025-01-01', 1)`;
  await exec(dst, db, ins);
  assert.equal(await n(`SELECT MAX(id) FROM ${t(dst, 'kunden')}`, dst, db), (await n(`SELECT MAX(id) FROM ${t(src, 'kunden')}`, src, 'shop')) + 1, 'Identität');
  // Fremdschlüssel greift
  const fk = dst === 'mysql' ? 'INSERT INTO bestellungen (kunde_id, datum, betrag, status) VALUES (999999, \'2025-01-01\', 1, \'offen\')'
    : `INSERT INTO ${t(dst, 'bestellungen')} (kunde_id, datum, betrag, status) VALUES (999999, '2025-01-01', 1, 'offen')`;
  await assert.rejects(exec(dst, db, fk), /foreign|FOREIGN|REFERENCE|Fremd/i, 'Fremdschlüssel');
  // eindeutiger Index
  await assert.rejects(exec(dst, db, ins.replace("'neu'", "'Kunde 0001'")), /duplicate|unique|UNIQUE|eindeutig/i, 'eindeutiger Index');
}

/** MySQL: einzelne INSERT/UPDATE/DELETE gebündelt festgeschrieben – nach außen wie einzeln */
async function mysqlGrouping() {
  console.log('\nMySQL: einzelne Schreib-Anweisungen gebündelt festgeschrieben');
  const file = path.join(dir, 'einzeln.sql');
  const create = 'CREATE TABLE e (id int PRIMARY KEY, t varchar(40));';
  const rows = (n: number, from = 1) => Array.from({ length: n }, (_, k) => `INSERT INTO e VALUES (${from + k}, 'Zeile ${from + k}');`).join('\n');
  const count = async () => Number(await scalar('mysql', 'imp_group', 'SELECT COUNT(*) FROM e'));
  const fresh = async (text: string) => {
    writeFileSync(file, text);
    await dropDb('mysql', 'imp_group');
  };

  await step('5000 einzelne INSERTs: alle da, schnell (einzeln festgeschrieben dauerte es hier ~1 min)', async () => {
    await fresh(`${create}\n${rows(5000)}\n`);
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'done', s.error);
    assert.equal(s.statements, 5001);
    assert.equal(await count(), 5000);
    assert.ok(s.durationMs < 20000, `${s.durationMs} ms`);
  });
  const withDuplicate = `${create}\n${rows(50)}\nINSERT INTO e VALUES (7, 'doppelt');\n${rows(50, 51)}\n`;
  await step('Fehler mitten im Block: davor festgeschrieben, Fehler mit Zeile im Protokoll, Rest läuft', async () => {
    await fresh(withDuplicate);
    const s = await load('mysql', 'imp_group', file, { stopOnError: false });
    assert.equal(s.state, 'done', s.error);
    assert.equal(await count(), 100);
    assert.equal(s.statements, 101);
    assert.ok(s.log.some((l) => /Zeile 52/.test(l) && /Duplicate/i.test(l)), s.log.join(' | '));
  });
  await step('beim ersten Fehler aufhören: was davor lief, bleibt (wie ohne Bündeln)', async () => {
    await fresh(withDuplicate);
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /Zeile 52/);
    assert.equal(await count(), 50);
  });
  await step('eigene Transaktion des Skripts bleibt unangetastet: ROLLBACK nimmt alles zurück', async () => {
    await fresh(`${create}\nSTART TRANSACTION;\n${rows(300)}\nROLLBACK;\n${rows(2, 1000)}\n`);
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'done', s.error);
    assert.equal(await count(), 2);
  });
  await step('SET autocommit = 0 im Skript: dazwischen wird nichts festgeschrieben', async () => {
    await fresh(`${create}\nSET autocommit = 0;\n${rows(300)}\nROLLBACK;\nSET autocommit = 1;\n${rows(2, 1000)}\n`);
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'done', s.error);
    assert.equal(await count(), 2);
  });
  await step('ROW_COUNT() der Anweisung davor stimmt (auch an der Grenze eines Blocks)', async () => {
    await fresh(
      `${create}\n${rows(199)}\nUPDATE e SET t = 'x' WHERE id <= 3;\nINSERT INTO e VALUES (1000, ROW_COUNT());\n` +
        `UPDATE e SET t = 'y' WHERE id <= 2;\nSET @n = ROW_COUNT();\nINSERT INTO e VALUES (1001, @n);\n`,
    );
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'done', s.error);
    assert.equal(await scalar('mysql', 'imp_group', 'SELECT t FROM e WHERE id = 1000'), '3');
    assert.equal(await scalar('mysql', 'imp_group', 'SELECT t FROM e WHERE id = 1001'), '2');
  });
  await step('LOCK TABLES … UNLOCK TABLES (wie mysqldump)', async () => {
    await fresh(`${create}\nLOCK TABLES e WRITE;\n${rows(300)}\nUNLOCK TABLES;\n${rows(300, 301)}\n`);
    const s = await load('mysql', 'imp_group', file);
    assert.equal(s.state, 'done', s.error);
    assert.equal(await count(), 600);
  });
  await step('Abbrechen: gezählte Anweisungen = eingespielte Zeilen', async () => {
    await fresh(`${create}\n${rows(200000)}\n`);
    const id = await m.startImport({ connectionId: ids.mysql, database: 'imp_group', createDatabase: true, file, stopOnError: true, transaction: false, skipUse: true });
    await new Promise((r) => setTimeout(r, 1500));
    await m.cancelJob(id);
    const s = await waitJob(id);
    assert.equal(s.state, 'cancelled');
    const n = await count();
    assert.ok(n > 0 && n < 200000, `${n} Zeilen`);
    assert.equal(s.statements, n + 1);
  });
  await step('Deadlock mitten im Block: der Server rollt alles zurück – Abbruch mit klarer Meldung', async () => {
    await dropDb('mysql', 'imp_group');
    await exec('mysql', undefined, 'CREATE DATABASE imp_group');
    await exec('mysql', 'imp_group', 'CREATE TABLE d (id int PRIMARY KEY, v int NOT NULL)');
    await exec('mysql', 'imp_group', 'INSERT INTO d VALUES (1, 0), (2, 0)');
    await exec('mysql', 'imp_group', 'CREATE TABLE schwer (id int PRIMARY KEY)');
    writeFileSync(file, 'UPDATE d SET v = v + 1 WHERE id = 1;\nUPDATE d SET v = v + 1 WHERE id = 2;\nUPDATE d SET v = v + 1 WHERE id = 1;\nUPDATE d SET v = v + 1 WHERE id = 2;\n');
    const other = await mysql.createConnection({ host: '127.0.0.1', port: targets.mysql.port, user: 'root', password: targets.mysql.password, database: 'imp_group' });
    try {
      // die andere Transaktion ist schwerer (viele Zeilen) – InnoDB rollt bei einem Deadlock die leichtere zurück
      await other.query('START TRANSACTION');
      await other.query(`INSERT INTO schwer VALUES ${Array.from({ length: 2000 }, (_, k) => `(${k + 1})`).join(',')}`);
      await other.query('UPDATE d SET v = v + 10 WHERE id = 2');
      const id = await m.startImport({ connectionId: ids.mysql, database: 'imp_group', createDatabase: false, file, stopOnError: false, transaction: false, skipUse: true });
      // warten, bis das Einspielen an Zeile 2 auf die Sperre der anderen Transaktion wartet
      for (let k = 0; k < 100; k++) {
        const [w] = await other.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'UPDATE d SET v = v + 1 WHERE id = 2%'");
        if (Number(w[0].n)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // schließt den Kreis: Zeile 1 hält das Einspielen
      await other.query('UPDATE d SET v = v + 10 WHERE id = 1');
      const s = await waitJob(id);
      assert.equal(s.state, 'error');
      assert.match(s.error ?? '', /^Zeile 2: Deadlock/);
      assert.match(s.error ?? '', /ganze Transaktion zurückgerollt: die 1 Anweisung\(en\) davor ab Zeile 1/);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
    assert.equal(Number(await scalar('mysql', 'imp_group', 'SELECT v FROM d WHERE id = 1')), 0, 'Zeile 1 zurückgerollt');
  });
}

/** Objekte, die ein schlichtes CREATE TABLE aus Spalten verliert: je Datenbanktyp eine kleine Datenbank dump_x_<typ> */
const special: Record<SqlDialect, string[]> = {
  mysql: [
    "CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY, n int NOT NULL DEFAULT 0, doppelt int AS (n * 2) STORED, status enum('neu','alt') NOT NULL DEFAULT 'neu', " +
      "email varchar(100) NULL, ort varchar(60) NOT NULL DEFAULT 'Bern', geaendert datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
      'ts timestamp NULL, flag tinyint(1) NOT NULL DEFAULT 0, UNIQUE KEY uq_email (email), FULLTEXT KEY ft_ort (ort), CONSTRAINT ck_n CHECK (n >= 0))',
    'CREATE TABLE b (id int PRIMARY KEY, a_id int NULL, CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES a (id) ON DELETE CASCADE ON UPDATE SET NULL)',
    "INSERT INTO a (n, status, email, flag, ts) VALUES (1, 'neu', 'x@example.com', 2, '2024-06-01 10:00:00'), (2, 'alt', NULL, 0, NULL), (3, 'neu', NULL, 1, NULL)",
    'INSERT INTO b VALUES (1, 1), (2, 2)',
    // v_a benutzt v_z, steht aber alphabetisch davor
    'CREATE VIEW v_z AS SELECT id, n FROM a',
    'CREATE VIEW v_a AS SELECT * FROM v_z WHERE n > 1',
  ],
  postgres: [
    "CREATE TYPE bestell_status AS ENUM ('neu', 'alt')",
    "CREATE DOMAIN plz AS varchar(10) CHECK (VALUE ~ '^[0-9]+$')",
    'CREATE TABLE a (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, n int NOT NULL DEFAULT 0, doppelt int GENERATED ALWAYS AS (n * 2) STORED, ' +
      "status bestell_status NOT NULL DEFAULT 'neu', email varchar(100) NULL CONSTRAINT uq_email UNIQUE, ort varchar(60) NOT NULL DEFAULT 'Bern', code plz NULL, " +
      'ts timestamptz NULL, preis numeric NULL, flag boolean NOT NULL DEFAULT false, CONSTRAINT ck_n CHECK (n >= 0))',
    'CREATE INDEX ix_a_lower ON a (lower(ort)) WHERE n > 0',
    'CREATE TABLE b (id int PRIMARY KEY, a_id int NULL, CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES a (id) ON DELETE CASCADE ON UPDATE SET NULL)',
    "INSERT INTO a (n, status, email, code, ts, preis, flag) VALUES (1, 'neu', 'x@example.com', '8000', '2024-06-01 10:00:00+00', 12.345, true), (2, 'alt', NULL, NULL, NULL, NULL, false), (3, 'neu', NULL, NULL, NULL, 0.075, true)",
    'INSERT INTO b VALUES (1, 1), (2, 2)',
    'CREATE VIEW v_z AS SELECT id, n FROM a',
    'CREATE VIEW v_a AS SELECT * FROM v_z WHERE n > 1',
    'CREATE MATERIALIZED VIEW mv_a AS SELECT count(*) AS anzahl FROM a',
  ],
  mssql: [
    'CREATE TYPE dbo.plz FROM varchar(10) NULL',
    'CREATE TABLE dbo.a (id int IDENTITY(1,1) PRIMARY KEY, n int NOT NULL CONSTRAINT df_a_n DEFAULT 0, doppelt AS (n * 2) PERSISTED, ' +
      "status varchar(10) NOT NULL CONSTRAINT df_a_status DEFAULT 'neu', email nvarchar(100) NULL, ort nvarchar(60) NOT NULL CONSTRAINT df_a_ort DEFAULT N'Bern', code dbo.plz NULL, " +
      'ver rowversion NOT NULL, ts datetimeoffset(0) NULL, flag bit NOT NULL CONSTRAINT df_a_flag DEFAULT 0, CONSTRAINT ck_n CHECK (n >= 0))',
    // eindeutig trotz mehrerer NULL: nur gefiltert
    'CREATE UNIQUE INDEX uq_email ON dbo.a (email) WHERE email IS NOT NULL',
    'CREATE TABLE dbo.b (id int PRIMARY KEY, a_id int NULL, CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES dbo.a (id) ON DELETE CASCADE ON UPDATE SET NULL)',
    "INSERT INTO dbo.a (n, status, email, code, ts, flag) VALUES (1, 'neu', N'x@example.com', '8000', '2024-06-01 10:00:00 +00:00', 1), (2, 'alt', NULL, NULL, NULL, 0), (3, 'neu', NULL, NULL, NULL, 1)",
    'INSERT INTO dbo.b VALUES (1, 1), (2, 2)',
    'CREATE VIEW dbo.v_z AS SELECT id, n FROM dbo.a',
    'CREATE VIEW dbo.v_a AS SELECT * FROM dbo.v_z WHERE n > 1',
    // gespeichert wird der Text der letzten Anweisung – hier ein ALTER
    'ALTER VIEW dbo.v_a AS SELECT id, n FROM dbo.v_z WHERE n > 1',
    'CREATE PROCEDURE dbo.p_x AS SELECT 1',
    'ALTER PROCEDURE dbo.p_x AS SELECT 2',
  ],
};

async function createDb(dialect: SqlDialect, db: string) {
  await dropDb(dialect, db);
  if (dialect === 'mysql') await exec(dialect, undefined, `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`);
  if (dialect === 'postgres') await exec(dialect, 'postgres', `CREATE DATABASE "${db}"`);
  if (dialect === 'mssql') await exec(dialect, 'master', `CREATE DATABASE [${db}]`);
}

async function dumpDb(src: SqlDialect, dst: SqlDialect, db: string, file: string, routines: boolean) {
  nextFile = file;
  const schemas = src === 'mysql' ? [''] : [targets[src].schema];
  const tables: { schema: string; name: string }[] = [];
  const views: { schema: string; name: string }[] = [];
  for (const schema of schemas) {
    for (const o of await m.listObjects(ids[src], db, schema)) (o.kind === 'view' ? views : tables).push({ schema, name: o.name });
  }
  const id = await m.startDump({ connectionId: ids[src], database: db, tables, views, structure: true, data: true, dropFirst: true, targetDialect: dst, rowsPerInsert: 250, baseName: 'x', routines });
  const s = await waitJob(id!);
  if (s.state !== 'done') throw new Error(`Dump: ${s.error}`);
  return s;
}

/** berechnete Spalten, Fremdschlüssel-Regeln, CHECK, Teil-/Funktionsindizes, Typen, Matview, Views in Abhängigkeit, Zeitzone */
async function specialObjects() {
  for (const d of ['mysql', 'postgres', 'mssql'] as const) {
    console.log(`\nBesondere Objekte: ${d}`);
    const x = `dump_x_${d}`;
    const y = `dump_y_${d}`;
    const file = path.join(dir, `${x}.sql`);
    const schema = targets[d].schema;
    await step('Quelle anlegen', async () => {
      await createDb(d, x);
      for (const sql of special[d]) await exec(d, x, sql);
    });
    await step('Dump im selben Typ, in neue Datenbank einspielen: Struktur und Werte vollständig', async () => {
      const s = await dumpDb(d, d, x, file, true);
      const skipped = s.log.filter((l) => /übersprungen|nicht übernommen/.test(l));
      assert.deepEqual(skipped, [], s.log.join(' | '));
      await dropDb(d, y);
      const r = await load(d, y, file, { transaction: d !== 'mysql' });
      if (r.state !== 'done') throw new Error(r.error);
      assert.equal(Number(await scalar(d, y, `SELECT COUNT(*) FROM ${t(d, 'a')}`)), 3);
      assert.equal(Number(await scalar(d, y, `SELECT COUNT(*) FROM ${t(d, 'b')}`)), 2);
      // berechnete Spalte rechnet im Ziel selbst
      assert.equal(Number(await scalar(d, y, `SELECT doppelt FROM ${t(d, 'a')} WHERE n = 3`)), 6);
      const ref = (name: string) => ({ connectionId: ids[d], database: y, schema, name, kind: 'table' as const });
      const a = await m.describeTable(ref('a'));
      const b = await m.describeTable(ref('b'));
      assert.ok(a.columns.find((c) => c.name === 'doppelt')?.generated, 'berechnete Spalte');
      assert.deepEqual([b.foreignKeys[0]?.onDelete, b.foreignKeys[0]?.onUpdate], ['CASCADE', 'SET NULL'], 'Fremdschlüssel-Regeln');
      assert.ok(a.checks?.some((k) => k.name === 'ck_n'), `CHECK: ${JSON.stringify(a.checks)}`);
      const uq = a.indexes.find((i) => i.name === 'uq_email');
      assert.ok(uq?.unique, 'eindeutiger Index');
      if (d === 'mysql') {
        // tinyint(1) ist eine Zahl: 2 bleibt 2; ON UPDATE bleibt; FULLTEXT bleibt
        assert.equal(Number(await scalar(d, y, 'SELECT flag FROM a WHERE n = 1')), 2);
        assert.equal(a.columns.find((c) => c.name === 'geaendert')?.onUpdate?.toUpperCase().replace(/\(\)$/, ''), 'CURRENT_TIMESTAMP');
        assert.equal(a.indexes.find((i) => i.name === 'ft_ort')?.kind, 'FULLTEXT');
        assert.match(String(await scalar(d, y, "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'dump_y_mysql' AND TABLE_NAME = 'a' AND COLUMN_NAME = 'ort'")), /^'?Bern'?$/);
      }
      if (d === 'postgres') {
        assert.equal(await scalar(d, y, "SELECT typtype FROM pg_type WHERE typname = 'bestell_status'"), 'e', 'ENUM-Typ');
        assert.equal(await scalar(d, y, "SELECT typtype FROM pg_type WHERE typname = 'plz'"), 'd', 'DOMAIN');
        assert.equal(await scalar(d, y, "SELECT relkind FROM pg_class WHERE relname = 'mv_a'"), 'm', 'Matview');
        assert.equal(a.indexes.find((i) => i.name === 'ix_a_lower')?.where, 'n > 0', 'Teilindex');
        assert.equal(a.columns.find((c) => c.name === 'preis')?.dataType, 'numeric');
        assert.equal(String(await scalar(d, y, 'SELECT preis FROM public.a WHERE n = 3')), '0.075');
        assert.equal(uq?.constraint, true, 'UNIQUE-Einschränkung');
      }
      if (d === 'mssql') {
        assert.ok(a.columns.find((c) => c.name === 'ver')?.rowversion, 'rowversion');
        assert.ok(a.columns.find((c) => c.name === 'doppelt')?.stored, 'PERSISTED');
        assert.equal(uq?.where, '([email] IS NOT NULL)', 'gefilterter Index');
        assert.equal(a.columns.find((c) => c.name === 'code')?.dataType, 'plz', 'Aliastyp');
        assert.equal(Number(await scalar(d, y, 'SELECT COUNT(*) FROM sys.procedures WHERE name = \'p_x\'')), 1, 'Prozedur trotz gespeichertem ALTER');
      }
      // Zeitpunkt unverändert
      assert.equal(String(await scalar(d, y, `SELECT ts FROM ${t(d, 'a')} WHERE n = 1`)).slice(0, 19), String(await scalar(d, x, `SELECT ts FROM ${t(d, 'a')} WHERE n = 1`)).slice(0, 19));
    });
    await step('noch einmal in dieselbe Datenbank (DROP vorab: Matview, Typen, Fremdschlüssel untereinander)', async () => {
      const r = await load(d, y, file, { createDatabase: false, transaction: d !== 'mysql' });
      if (r.state !== 'done') throw new Error(r.error);
      assert.equal(Number(await scalar(d, y, `SELECT COUNT(*) FROM ${t(d, 'a')}`)), 3);
    });
    for (const o of (['mysql', 'postgres', 'mssql'] as const).filter((o) => o !== d)) {
      await step(`Dump nach ${o}: einspielbar, Werte da`, async () => {
        const f = path.join(dir, `${x}_${o}.sql`);
        const s = await dumpDb(d, o, x, f, false);
        if (s.log.length) console.log('       Hinweise: ' + s.log.join(' | '));
        const z = `dump_z_${d}_${o}`;
        await dropDb(o, z);
        const r = await load(o, z, f, { transaction: o !== 'mysql' });
        if (r.state !== 'done') throw new Error(r.error);
        assert.equal(Number(await scalar(o, z, `SELECT COUNT(*) FROM ${t(o, 'a')}`)), 3);
        assert.equal(Number(await scalar(o, z, `SELECT doppelt FROM ${t(o, 'a')} WHERE n = 3`)), 6, 'berechnete Spalte als Werte');
        const b = await m.describeTable({ connectionId: ids[o], database: z, schema: targets[o].schema, name: 'b', kind: 'table' });
        assert.deepEqual([b.foreignKeys[0]?.onDelete, b.foreignKeys[0]?.onUpdate], ['CASCADE', 'SET NULL'], 'Fremdschlüssel-Regeln');
        const flag = (dd: SqlDialect, db: string) => scalar(dd, db, `SELECT COUNT(*) FROM ${t(dd, 'a')} WHERE flag ${dd === 'postgres' ? '= true' : '<> 0'}`).then(Number);
        assert.equal(await flag(o, z), await flag(d, x), 'Wahrheitswerte (2 zählt als wahr)');
        assert.equal(String(await scalar(o, z, `SELECT ts FROM ${t(o, 'a')} WHERE n = 1`)).slice(0, 19), String(await scalar(d, x, `SELECT ts FROM ${t(d, 'a')} WHERE n = 1`)).slice(0, 19), 'Zeitpunkt in UTC');
      });
    }
  }
}

async function main() {
  assertTestContainers(Object.entries(targets).map(([name, x]) => ({ name, host: '127.0.0.1', port: x.port })));
  for (const d of Object.keys(targets) as SqlDialect[]) ids[d] = (await store.save(input(d))).id;

  for (const src of ['mysql', 'postgres', 'mssql'] as const) {
    for (const dst of ['mysql', 'postgres', 'mssql'] as const) {
      console.log(`\n${src} → ${dst}`);
      const db = `dump_${src}_${dst}`;
      const file = path.join(dir, `${db}.sql`);
      await step('Dump schreiben', async () => {
        const s = await dump(src, dst, file);
        assert.ok(s.done > 8000, `Zeilen ${s.done}`);
        if (s.log.length) console.log('       Hinweise: ' + s.log.join(' | '));
      });
      await step('in neue Datenbank einspielen und vergleichen', async () => {
        await dropDb(dst, db);
        const s = await load(dst, db, file, { transaction: dst !== 'mysql' });
        if (s.state !== 'done') throw new Error(s.error);
        await compare(src, dst, db);
      });
      if (src === dst) {
        await step('noch einmal in dieselbe Datenbank (DROP vorab)', async () => {
          const s = await load(dst, db, file, { createDatabase: false });
          if (s.state !== 'done') throw new Error(s.error);
          assert.equal(Number(await scalar(dst, db, `SELECT COUNT(*) FROM ${t(dst, 'kunden')}`)), 2500);
        });
      }
    }
  }

  await specialObjects();

  console.log('\nFremde Dumps');
  const mysqldump = (...extra: string[]) =>
    execFileSync('docker', ['exec', 'dbviewer-test-mysql-1', 'mysqldump', '-uroot', '-pdbviewer-test', '--routines', '--databases', ...extra, 'shop'], {
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  await step('mysqldump --hex-blob (mit Prozedur, DELIMITER, /*! */-Kommentaren, DROP/CREATE DATABASE)', async () => {
    const file = path.join(dir, 'mysqldump.sql');
    writeFileSync(file, mysqldump('--hex-blob', '--add-drop-database'));
    await dropDb('mysql', 'from_mysqldump');
    const s = await load('mysql', 'from_mysqldump', file, { skipUse: true });
    if (s.state !== 'done') throw new Error(s.error);
    assert.equal(Number(await scalar('mysql', 'from_mysqldump', 'SELECT COUNT(*) FROM bestellungen')), 6000);
    // mit --databases und --add-drop-database stehen DROP/CREATE DATABASE shop und USE shop drin (USE mit --routines zweimal):
    // alle übersprungen, shop bleibt
    const skipped = Number(/(\d+) USE\/DATABASE übersprungen/.exec(s.current)?.[1]);
    assert.ok(skipped >= 3, s.current);
    assert.equal(Number(await scalar('mysql', 'shop', 'SELECT COUNT(*) FROM bestellungen')), 6000, 'Quell-Datenbank angefasst');
    // Binärwerte kommen unverändert an
    const hex = (db: string) => scalar('mysql', db, 'SELECT HEX(avatar) FROM kunden WHERE avatar IS NOT NULL ORDER BY id LIMIT 1');
    assert.equal(await hex('from_mysqldump'), await hex('shop'), 'Binärwert');
  });
  await step('mysqldump ohne --hex-blob (Rohbytes): abgelehnt mit Hinweis statt still beschädigt', async () => {
    const file = path.join(dir, 'mysqldump-raw.sql');
    writeFileSync(file, mysqldump());
    await dropDb('mysql', 'from_mysqldump_raw');
    const s = await load('mysql', 'from_mysqldump_raw', file, { skipUse: true });
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /hex-blob/);
  });
  await step('pg_dump (COPY FROM stdin, \\restrict, Sequenzen)', async () => {
    const out = execFileSync('docker', ['exec', 'dbviewer-test-postgres-1', 'pg_dump', '-U', 'postgres', '--no-owner', 'shop'], {
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const file = path.join(dir, 'pgdump.sql');
    writeFileSync(file, out);
    await dropDb('postgres', 'from_pgdump');
    const s = await load('postgres', 'from_pgdump', file, { transaction: true });
    if (s.state !== 'done') throw new Error(s.error);
    assert.equal(Number(await scalar('postgres', 'from_pgdump', 'SELECT COUNT(*) FROM public.kunden')), 2500);
    assert.equal(Number(await scalar('postgres', 'from_pgdump', 'SELECT COUNT(*) FROM verkauf.regionen')), 2);
    assert.equal(await scalar('postgres', 'from_pgdump', "SELECT tags::text FROM public.kunden WHERE tags IS NOT NULL ORDER BY id LIMIT 1"), await scalar('postgres', 'shop', "SELECT tags::text FROM public.kunden WHERE tags IS NOT NULL ORDER BY id LIMIT 1"));
  });
  await step('SSMS-Skript: UTF-16 mit BOM, GO, USE [shop]', async () => {
    const text = '﻿USE [shop]\r\nGO\r\nCREATE TABLE dbo.t16 (id int PRIMARY KEY, txt nvarchar(20))\r\nGO\r\nINSERT INTO dbo.t16 VALUES (1, N\'Grüße ✓\')\r\nINSERT INTO dbo.t16 VALUES (2, N\'zwei\')\r\nGO\r\n';
    const file = path.join(dir, 'ssms.sql');
    writeFileSync(file, Buffer.from(text, 'utf16le'));
    await dropDb('mssql', 'from_ssms');
    const s = await load('mssql', 'from_ssms', file);
    if (s.state !== 'done') throw new Error(s.error);
    assert.equal(await scalar('mssql', 'from_ssms', 'SELECT txt FROM dbo.t16 WHERE id = 1'), 'Grüße ✓');
    assert.equal(Number(await scalar('mssql', 'from_ssms', 'SELECT COUNT(*) FROM dbo.t16')), 2);
  });

  console.log('\nFehler, Transaktion, Abbruch, Nur lesen');
  const bad = path.join(dir, 'bad.sql');
  writeFileSync(bad, 'CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\n\nINSERT INTO gibtsnicht VALUES (1);\nINSERT INTO a VALUES (2);\n');
  await step('beim ersten Fehler aufhören: Meldung mit Zeilennummer', async () => {
    await dropDb('postgres', 'imp_err');
    const s = await load('postgres', 'imp_err', bad);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /Zeile 4/);
    assert.equal(Number(await scalar('postgres', 'imp_err', 'SELECT COUNT(*) FROM a')), 1);
  });
  await step('Fehler überspringen: Rest läuft, Fehler im Protokoll', async () => {
    await dropDb('postgres', 'imp_err');
    const s = await load('postgres', 'imp_err', bad, { stopOnError: false });
    assert.equal(s.state, 'done', s.error);
    assert.ok(s.log.some((l) => /Zeile 4/.test(l)), s.log.join(' | '));
    assert.equal(Number(await scalar('postgres', 'imp_err', 'SELECT COUNT(*) FROM a')), 2);
  });
  await step('als Transaktion: Fehler = nichts übernommen', async () => {
    await dropDb('mssql', 'imp_err');
    const s = await load('mssql', 'imp_err', bad, { transaction: true });
    assert.equal(s.state, 'error');
    assert.equal(Number(await scalar('mssql', 'imp_err', "SELECT COUNT(*) FROM sys.tables WHERE name = 'a'")), 0);
  });
  await step('Abbrechen', async () => {
    const big = path.join(dir, 'big.sql');
    const row = "INSERT INTO b VALUES (1, 'x');\n";
    writeFileSync(big, 'CREATE TABLE b (id int, t text);\n' + row.repeat(200000));
    await dropDb('postgres', 'imp_cancel');
    const id = await m.startImport({ connectionId: ids.postgres, database: 'imp_cancel', createDatabase: true, file: big, stopOnError: true, transaction: false, skipUse: true });
    await new Promise((r) => setTimeout(r, 1500));
    await m.cancelJob(id);
    const s = await waitJob(id);
    assert.equal(s.state, 'cancelled');
    assert.ok(Number(await scalar('postgres', 'imp_cancel', 'SELECT COUNT(*) FROM b')) < 200000);
  });
  await step('Verbindung mit „Nur lesen“: Einspielen abgelehnt', async () => {
    const ro = await store.save(input('postgres', { name: 'ro', options: { readOnly: true } }));
    await assert.rejects(
      m.startImport({ connectionId: ro.id, database: 'imp_err', createDatabase: false, file: bad, stopOnError: true, transaction: false, skipUse: true }),
      /Nur lesen/,
    );
  });

  await mysqlGrouping();

  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
