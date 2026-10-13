/* SQL-Server-Treiber gegen den Test-Container: Genauigkeit (decimal, datetime2, datetimeoffset, real), Systemversionierung
   (History-Tabelle, versteckte Periodenspalten), Schemas nur mit Routinen, indizierte und verschlüsselte Views, Trigger-Zähler
   beim Speichern, Aliastypen in der Suche, FOR JSON-Hinweis, Plan für CREATE PROCEDURE, Export-Abbruch.
   Vorher: npm run testdb:up. Aufruf: npm run test:mssql */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, JobStatus } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-ms-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
let nextFile = '';
const m = new Manager(store, { pickFile: async () => null, saveFile: async () => nextFile, showInFolder: () => undefined }, 0);

let failed = 0;
async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

const PORT = 15433;
const input: ConnectionInput = { name: 'mssql', dialect: 'mssql', host: '127.0.0.1', port: PORT, user: 'sa', password: 'Dbviewer-Test1', options: { trustServerCertificate: true } };

async function waitJob(id: string): Promise<JobStatus> {
  for (;;) {
    const s = await m.jobStatus(id);
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(connectionId: string, db: string | undefined, sqls: string[]): Promise<{ rows: unknown[][]; messages: string[] }[]> {
  const { sessionId } = await m.openSession(connectionId, db);
  try {
    const out: { rows: unknown[][]; messages: string[] }[] = [];
    for (const sql of sqls) {
      const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 100);
      if (r.statements[0]?.error) throw new Error(`${sql.slice(0, 100)}: ${r.statements[0].error}`);
      out.push({ rows: r.results[0]?.rows ?? [], messages: r.messages });
    }
    return out;
  } finally {
    await m.closeSession(sessionId);
  }
}
const scalar = async (id: string, db: string, sql: string) => (await run(id, db, [sql]))[0].rows[0]?.[0];

async function main() {
  assertTestContainers([{ name: 'mssql', host: '127.0.0.1', port: PORT }]);
  const id = (await store.save(input)).id;
  const db = 'mssql_x';
  const obj = (name: string, schema = 'dbo') => ({ connectionId: id, database: db, schema, name, kind: 'table' as const });
  console.log('\nSQL Server');

  await step('Testdatenbank anlegen', async () => {
    await run(id, 'master', [`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`, `CREATE DATABASE [${db}]`]);
    await run(id, db, [
      'CREATE TABLE p (id int IDENTITY(1,1) PRIMARY KEY, d decimal(38,10) NULL, m money NULL, dt datetime2(7) NULL, t time(7) NULL, dto datetimeoffset(7) NULL, r real NULL, c varchar(20) NULL, n nvarchar(20) NULL)',
      "INSERT INTO p (d, m, dt, t, dto, r, c, n) VALUES (12345678901234567890.1234567890, 123456.7890, '2024-06-01 10:00:00.1234567', '10:00:00.1234567', '2024-06-01 10:00:00.1234567 +02:00', 3.14, 'abc', N'Öl')",
    ]);
  });

  await step('F061/F062/F250: Tabellenansicht liest decimal, datetime2, datetimeoffset und real exakt', async () => {
    const r = await m.fetchTable({ object: obj('p'), limit: 10, offset: 0, sort: [] });
    const col = (n: string) => r.columns.findIndex((c) => c.name === n);
    const row = r.rows[0];
    assert.equal(row[col('d')], '12345678901234567890.1234567890');
    assert.equal(row[col('m')], '123456.7890');
    assert.equal(row[col('dt')], '2024-06-01 10:00:00.1234567');
    assert.equal(row[col('t')], '10:00:00.1234567');
    assert.equal(row[col('dto')], '2024-06-01 10:00:00.1234567 +02:00');
    assert.equal(row[col('r')], '3.14');
    // Typ und Zahl-Kennzeichen wie in der Tabelle, obwohl als Text gelesen
    assert.equal(r.columns[col('d')].typeName, 'decimal(38,10)');
    assert.equal(r.columns[col('d')].numeric, true);
    assert.match(r.sql, /CONVERT\(varchar\(50\), \[d\]\) AS \[d\]/);
  });

  await step('F062/F250/F061: freie Abfrage – Nachkommastellen bis 100 ns, real kurz, Hinweis bei gerundeten Dezimalzahlen', async () => {
    const [{ rows, messages }] = await run(id, db, ['SELECT d, dt, t, dto, r FROM p']);
    assert.equal(rows[0][1], '2024-06-01 10:00:00.1234567');
    assert.equal(rows[0][2], '10:00:00.1234567');
    assert.equal(rows[0][3], '2024-06-01 08:00:00.1234567 +00:00');
    assert.equal(rows[0][4], '3.14');
    assert.ok(messages.some((x) => /Gerundet: d \(decimal\(38,10\)\)/.test(x)), messages.join(' | '));
  });

  await step('F061: Dump und Einspielen – Werte kommen exakt an', async () => {
    const file = path.join(dir, 'p.sql');
    nextFile = file;
    const dumpId = await m.startDump({ connectionId: id, database: db, tables: [{ schema: 'dbo', name: 'p' }], views: [], structure: true, data: true, dropFirst: true, targetDialect: 'mssql', rowsPerInsert: 100, baseName: 'x' });
    const s = await waitJob(dumpId!);
    assert.equal(s.state, 'done', s.error);
    await run(id, 'master', ["IF DB_ID('mssql_y') IS NOT NULL BEGIN ALTER DATABASE [mssql_y] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [mssql_y]; END"]);
    const imp = await waitJob(await m.startImport({ connectionId: id, database: 'mssql_y', createDatabase: true, file, stopOnError: true, transaction: true, skipUse: true }));
    assert.equal(imp.state, 'done', imp.error);
    for (const c of ['d', 'm', 'dt', 't', 'dto', 'r']) {
      assert.equal(await scalar(id, 'mssql_y', `SELECT CONVERT(varchar(50), ${c}, 121) FROM p`), await scalar(id, db, `SELECT CONVERT(varchar(50), ${c}, 121) FROM p`), c);
    }
  });

  await step('F065/F066: Systemversionierung – History-Tabelle unsichtbar, versteckte Periodenspalten im Dump', async () => {
    await run(id, db, [
      'CREATE TABLE tv (id int PRIMARY KEY, v int NULL, vf datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL, vt datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL, PERIOD FOR SYSTEM_TIME (vf, vt)) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.tv_hist))',
      'INSERT INTO tv (id, v) VALUES (1, 10), (2, 20)',
      'UPDATE tv SET v = 11 WHERE id = 1',
    ]);
    const objects = await m.listObjects(id, db, 'dbo');
    assert.ok(objects.some((o) => o.name === 'tv'));
    assert.ok(!objects.some((o) => o.name === 'tv_hist'), 'History-Tabelle sichtbar');
    const er = await m.erModel(id, db, 'dbo');
    assert.ok(!er.tables.some((t) => t.name === 'tv_hist'));
    const info = await m.describeTable(obj('tv'));
    assert.match(info.special ?? '', /versioniert/);
    assert.ok(info.columns.find((c) => c.name === 'vf')?.hidden, 'versteckte Spalte');
    // Tabellenansicht zeigt die versteckten Spalten mit
    const r = await m.fetchTable({ object: obj('tv'), limit: 10, offset: 0, sort: [] });
    assert.ok(r.columns.some((c) => c.name === 'vf'));
    const file = path.join(dir, 'tv.sql');
    nextFile = file;
    const s = await waitJob((await m.startDump({ connectionId: id, database: db, tables: [{ schema: 'dbo', name: 'tv' }], views: [], structure: true, data: true, dropFirst: false, targetDialect: 'mssql', rowsPerInsert: 100, baseName: 'x' }))!);
    assert.equal(s.state, 'done', s.error);
    assert.ok(s.log.some((l) => /versioniert/.test(l)), s.log.join(' | '));
    const imp = await waitJob(await m.startImport({ connectionId: id, database: 'mssql_y', createDatabase: false, file, stopOnError: true, transaction: true, skipUse: true }));
    assert.equal(imp.state, 'done', imp.error);
    assert.equal(Number(await scalar(id, 'mssql_y', 'SELECT COUNT(*) FROM tv WHERE vf IS NOT NULL')), 2);
  });

  await step('F064: Schema nur mit einer Prozedur erscheint', async () => {
    await run(id, db, ['CREATE SCHEMA nurproc']);
    await run(id, db, ['CREATE PROCEDURE nurproc.p AS SELECT 1']);
    assert.ok((await m.listSchemas(id, db)).includes('nurproc'));
  });

  await step('F068/F069: verschlüsselte View wirft, indizierte View bringt ihre Indizes mit', async () => {
    await run(id, db, ['CREATE VIEW v_enc WITH ENCRYPTION AS SELECT 1 AS x']);
    await assert.rejects(m.getDdl({ connectionId: id, database: db, schema: 'dbo', name: 'v_enc', kind: 'view' }), /nicht lesbar/);
    await run(id, db, ['CREATE TABLE base (id int NOT NULL PRIMARY KEY, v int NOT NULL)', 'INSERT INTO base VALUES (1, 1)']);
    await run(id, db, ['CREATE VIEW dbo.v_ix WITH SCHEMABINDING AS SELECT id, v FROM dbo.base', 'CREATE UNIQUE CLUSTERED INDEX ix_v_ix ON dbo.v_ix (id)']);
    const ddl = await m.getDdl({ connectionId: id, database: db, schema: 'dbo', name: 'v_ix', kind: 'view' });
    assert.match(ddl, /CREATE UNIQUE CLUSTERED INDEX \[ix_v_ix\] ON \[dbo\]\.\[v_ix\] \(\[id\]\)/);
    const file = path.join(dir, 'vix.sql');
    nextFile = file;
    const s = await waitJob((await m.startDump({ connectionId: id, database: db, tables: [{ schema: 'dbo', name: 'base' }], views: [{ schema: 'dbo', name: 'v_ix' }, { schema: 'dbo', name: 'v_enc' }], structure: true, data: true, dropFirst: true, targetDialect: 'mssql', rowsPerInsert: 100, baseName: 'x' }))!);
    assert.equal(s.state, 'done', s.error);
    assert.ok(s.log.some((l) => /v_enc übersprungen/.test(l)), s.log.join(' | '));
    const imp = await waitJob(await m.startImport({ connectionId: id, database: 'mssql_y', createDatabase: false, file, stopOnError: true, transaction: true, skipUse: true }));
    assert.equal(imp.state, 'done', imp.error);
    assert.equal(Number(await scalar(id, 'mssql_y', "SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.v_ix') AND type > 0")), 1, 'Index der View im Ziel');
  });

  await step('F071: Speichern mit Trigger ohne SET NOCOUNT ON', async () => {
    await run(id, db, ['CREATE TABLE tr (id int PRIMARY KEY, n int NULL)', 'CREATE TABLE tr_log (id int IDENTITY PRIMARY KEY, msg varchar(20))', 'INSERT INTO tr VALUES (1, 1)']);
    await run(id, db, ["CREATE TRIGGER tr_upd ON tr AFTER UPDATE AS INSERT INTO tr_log (msg) VALUES ('a'), ('b')"]);
    const r = await m.applyChanges({ object: obj('tr'), changes: [{ kind: 'update', key: { id: 1 }, values: { n: 2 }, original: { n: 1 } }], preview: false });
    assert.equal(r.applied, 1);
    assert.equal(Number(await scalar(id, db, 'SELECT n FROM tr WHERE id = 1')), 2);
  });

  await step('F255: Spaltensuche nennt Aliastypen der Zieldatenbank', async () => {
    await run(id, db, ['CREATE TYPE dbo.plz2 FROM varchar(10)', 'CREATE TABLE adr (id int PRIMARY KEY, plz_code dbo.plz2 NULL)']);
    const hits = await m.searchObjects(id, 'plz_code');
    const hit = hits.hits.find((h) => h.kind === 'column' && h.column === 'plz_code');
    assert.ok(hit, JSON.stringify(hits.hits));
    assert.equal(hit.dataType, 'plz2');
  });

  await step('F258: FOR JSON – Hinweis in den Meldungen', async () => {
    const [{ messages }] = await run(id, db, ['SELECT id FROM p FOR JSON PATH']);
    assert.ok(messages.some((x) => /FOR JSON/.test(x)), messages.join(' | '));
  });

  await step('F074: geschätzter Plan für CREATE OR ALTER PROCEDURE – Sitzung bleibt', async () => {
    const { sessionId } = await m.openSession(id, db);
    try {
      const plan = await m.explainQuery(sessionId, [{ sql: 'CREATE OR ALTER PROCEDURE dbo.p_plan AS SELECT COUNT(*) FROM p', offset: 0 }], false);
      assert.ok(!plan.statements.some((s) => /Sitzungszustand verloren/.test(s.error ?? '')), JSON.stringify(plan.statements.map((s) => s.error)));
      const r = await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 10);
      assert.ok(!r.statements[0].error, r.statements[0].error);
      // vom Nutzer gesetztes SHOWPLAN: kein „Verbindung verloren“
      const r2 = await m.runQuery(sessionId, [{ sql: 'SET SHOWPLAN_XML ON', offset: 0 }], 10);
      assert.ok(!r2.statements[0].error, r2.statements[0].error);
      const r3 = await m.runQuery(sessionId, [{ sql: 'SELECT 2', offset: 0 }], 10);
      assert.ok(!r3.statements[0].error, r3.statements[0].error);
      await m.runQuery(sessionId, [{ sql: 'SET SHOWPLAN_XML OFF', offset: 0 }], 10);
    } finally {
      await m.closeSession(sessionId);
    }
  });

  await step('F075: Export bricht bei Schreibfehler ab, Anfrage beendet', async () => {
    const { sessionId } = await m.openSession(id, db);
    try {
      nextFile = path.join(dir, 'gibt-es-nicht', 'x.csv');
      const t0 = Date.now();
      await assert.rejects(m.exportQuery(sessionId, { sql: "SELECT TOP (2000000) REPLICATE('x', 2000) AS pad FROM sys.all_objects a CROSS JOIN sys.all_objects b", offset: 0 }, 0, { format: 'csv', baseName: 'x' }));
      assert.ok(Date.now() - t0 < 15_000, `Export brauchte ${Date.now() - t0} ms`);
    } finally {
      await m.closeSession(sessionId);
    }
    await new Promise((r) => setTimeout(r, 500));
    const running = await scalar(id, db, "SELECT COUNT(*) FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE t.text LIKE '%REPLICATE(''x'', 2000) AS pad%' AND r.session_id <> @@SPID");
    assert.equal(Number(running), 0, 'Anfrage läuft auf dem Server weiter');
  });

  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
