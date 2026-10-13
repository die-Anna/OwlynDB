/* Große Abfrage-Ergebnisse: Zeilengrenze am Server, Zählen statt Sammeln, Export mit erneuter Ausführung.
   Aufruf: npm run testdb:up, dann npm run test:stream [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import type { Dialect, ExportOptions, QueryRun } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const TARGETS: Record<Target, { dialect: Dialect; port: number; user: string; password: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1' },
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-stream-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const manager = new Manager(
  store,
  {
    pickFile: async () => null,
    saveFile: async (base, format) => path.join(dir, `${base}.${format}`),
    showInFolder: () => undefined,
  },
  0,
);

let failed = 0;
async function step(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).stack?.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anweisungen ausführen (je Eintrag eine), Fehler werfen; ms = Dauer */
async function run(sid: string, sql: string | string[], maxRows = 1000): Promise<QueryRun & { ms: number }> {
  const t0 = Date.now();
  const r = await manager.runQuery(sid, (Array.isArray(sql) ? sql : [sql]).map((s) => ({ sql: s, offset: 0 })), maxRows);
  const bad = r.statements.find((s) => s.error);
  if (bad) throw new Error(`${bad.error}\n       bei: ${bad.sql.slice(0, 120)}`);
  return { ...r, ms: Date.now() - t0 };
}

async function runError(sid: string, sql: string, maxRows = 1000): Promise<string> {
  const r = await manager.runQuery(sid, [{ sql, offset: 0 }], maxRows);
  const bad = r.statements.find((s) => s.error);
  assert.ok(bad, 'Fehler erwartet: ' + sql);
  return bad.error!;
}

function csvLines(file: string): string[] {
  return readFileSync(file, 'utf8').replace(/^﻿/, '').split('\r\n').filter((l) => l);
}

const csv = (baseName: string, dialect: Dialect): ExportOptions => ({ format: 'csv', baseName, dialect, bom: false, header: true, delimiter: ';' });

async function connect(t: Target, readOnly = false): Promise<{ id: string; sid: string }> {
  const c = TARGETS[t];
  const saved = await store.save({
    name: t + (readOnly ? ' (nur lesen)' : ''),
    dialect: c.dialect,
    host: '127.0.0.1',
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.dialect === 'mssql' ? 'master' : c.dialect === 'postgres' ? 'postgres' : '',
    options: { ...(c.dialect === 'mssql' ? { trustServerCertificate: true } : {}), ...(readOnly ? { readOnly: true } : {}) },
  });
  const { sessionId } = await manager.openSession(saved.id);
  return { id: saved.id, sid: sessionId };
}

async function mysqlTests(t: 'mysql' | 'mariadb') {
  console.log(`\n${t}`);
  const { sid } = await connect(t);
  await run(sid, [
    'DROP DATABASE IF EXISTS stream_test',
    'CREATE DATABASE stream_test',
    'USE stream_test',
    'CREATE TABLE d (x INT)',
    'INSERT INTO d VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)',
    'CREATE TABLE nums (n INT PRIMARY KEY)',
    'INSERT INTO nums SELECT a.x * 100 + b.x * 10 + c.x + 1 FROM d a, d b, d c',
    'CREATE PROCEDURE many() SELECT a.n FROM nums a, nums b LIMIT 30000',
  ]);

  await step('riesiges Ergebnis (10⁹ Zeilen): der Server hört nach max. Zeilen auf', async () => {
    const r = await run(sid, 'SELECT a.n AS a, b.n AS b, c.n AS c FROM nums a, nums b, nums c');
    const s = r.results[0];
    assert.equal(s.rows.length, 1000);
    assert.equal(s.truncated, true);
    assert.equal(s.totalRows, undefined, 'Gesamtzahl ist offen');
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });

  await step('eigenes LIMIT über max. Zeilen: Rest nur gezählt', async () => {
    const s = (await run(sid, 'SELECT a.n FROM nums a, nums b LIMIT 50000')).results[0];
    assert.equal(s.rows.length, 1000);
    assert.equal(s.totalRows, 50000);
  });

  await step('CALL: Prozeduren gelten nicht als begrenzt, gezählt', async () => {
    const r = await run(sid, 'CALL many()');
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[0].totalRows, 30000);
  });

  await step('INSERT … SELECT, CREATE … SELECT und Unterabfragen bleiben vollständig', async () => {
    const r = await run(
      sid,
      [
        'CREATE TEMPORARY TABLE tmp AS SELECT a.n FROM nums a, nums b WHERE b.n <= 5',
        'INSERT INTO tmp SELECT n FROM nums',
        'SELECT COUNT(*) AS n FROM tmp',
        'SELECT COUNT(*) AS n FROM (SELECT a.n FROM nums a, nums b WHERE b.n <= 5) x',
      ],
      100,
    );
    assert.equal(Number(r.results[0].rows[0][0]), 6000);
    assert.equal(Number(r.results[1].rows[0][0]), 5000);
  });

  await step('Plan ohne die Zeilengrenze', async () => {
    await run(sid, 'SELECT 1');
    const p = await manager.explainQuery(sid, [{ sql: 'SELECT * FROM nums ORDER BY n', offset: 0 }], false);
    assert.ok(!p.statements[0].error, p.statements[0].error);
    assert.doesNotMatch(JSON.stringify(p.statements), /1001/);
  });

  await step('FOR UPDATE: Grenze aufgehoben (sonst wären nur die ersten Zeilen gesperrt)', async () => {
    const s = (await run(sid, 'SELECT n FROM nums FOR UPDATE', 10)).results[0];
    assert.equal(s.rows.length, 10);
    assert.equal(s.totalRows, 1000);
  });

  await step('ROW_COUNT() und Warnungen überstehen den nächsten Lauf', async () => {
    await run(sid, ['CREATE TEMPORARY TABLE w (x INT)', 'SELECT 1']);
    await run(sid, 'INSERT INTO w VALUES (1),(2),(3)');
    assert.equal(Number((await run(sid, 'SELECT ROW_COUNT() AS rc')).results[0].rows[0][0]), 3);
    await run(sid, "SELECT CAST('abc' AS SIGNED) AS v");
    const w = await run(sid, 'SHOW WARNINGS');
    assert.ok(w.results[0].rows.length >= 1, 'Warnung fehlt');
  });

  await step('Binärwerte über 1 KB: Anzeige gekürzt, Export holt alles noch einmal', async () => {
    const sql = "SELECT a.n, UNHEX(REPEAT('AB', 1500)) AS b, UNHEX('0102') AS small FROM nums a, nums b WHERE b.n <= 3";
    const s = (await run(sid, sql)).results[0];
    assert.equal(s.truncated, true);
    assert.equal(s.binaryCut, true);
    assert.match(String(s.rows[0][1]), /… \(1500 Bytes\)$/);
    assert.equal(s.rows[0][2], '0x0102');
    const e = (await manager.exportQuery(sid, { sql, offset: 0 }, 0, csv(t + '-bin', 'mysql')))!;
    assert.equal(e.rows, 3000);
    const lines = csvLines(e.file);
    assert.equal(lines.length, 3001);
    assert.ok(lines[1].includes('AB'.repeat(1500)), 'Binärwert vollständig');
  });

  await step('Export: nur lesende Anweisungen werden erneut ausgeführt', async () => {
    await assert.rejects(manager.exportQuery(sid, { sql: 'INSERT INTO w VALUES (9)', offset: 0 }, 0, csv('x', 'mysql')), /nur lesen/);
    await assert.rejects(manager.exportQuery(sid, { sql: 'CALL many()', offset: 0 }, 0, csv('x', 'mysql')), /nur lesen/);
    assert.equal(Number((await run(sid, 'SELECT COUNT(*) FROM w')).results[0].rows[0][0]), 3);
  });

  await step('Verbindungsabbruch während der Abfrage: kein Hängen, danach neu verbunden', async () => {
    const pending = manager.runQuery(sid, [{ sql: 'SELECT SLEEP(20) AS s', offset: 0 }], 1000);
    await sleep(500);
    const c = await mysql.createConnection({ host: '127.0.0.1', port: TARGETS[t].port, user: 'root', password: 'dbviewer-test' });
    try {
      const [rows] = await c.query<mysql.RowDataPacket[]>("SELECT ID AS id FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(20)%'");
      assert.equal(rows.length, 1, 'Abfrage nicht gefunden');
      await c.query(`KILL ${Number(rows[0].id)}`);
    } finally {
      await c.end();
    }
    const t0 = Date.now();
    const r = await Promise.race([pending, sleep(8000).then(() => null)]);
    assert.ok(r, 'Abfrage hängt nach dem Verbindungsabbruch');
    assert.ok(r.statements[0].error, 'Fehler erwartet');
    assert.ok(Date.now() - t0 < 8000);
    const again = await manager.runQuery(sid, [{ sql: 'SELECT 1', offset: 0 }], 10);
    assert.equal(again.reconnected, true);
    assert.equal((await run(sid, 'SELECT 1 AS x')).results[0].rows.length, 1);
  });

  await run(sid, 'DROP DATABASE stream_test');
  await manager.closeSession(sid);
}

async function postgresTests() {
  console.log('\npostgres');
  const { sid } = await connect('postgres');

  await step('riesiges Ergebnis (10⁸ Zeilen): Cursor holt nur max. Zeilen + 1', async () => {
    const r = await run(sid, 'SELECT generate_series(1, 100000000) AS g');
    const s = r.results[0];
    assert.equal(s.rows.length, 1000);
    assert.equal(s.truncated, true);
    assert.equal(s.totalRows, undefined);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });

  await step('mehrere Anweisungen in einem Abschnitt: wie bisher, über max. Zeilen nur gezählt', async () => {
    const r = await run(sid, 'SELECT generate_series(1, 5000) AS g; SELECT 2 AS x');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[0].totalRows, 5000);
    assert.deepEqual(r.results[1].rows, [[2]]);
  });

  await step('DML, leere Anweisung, SHOW über den Cursor', async () => {
    const r = await run(sid, ['CREATE TEMP TABLE t AS SELECT generate_series(1, 3000) AS n', 'UPDATE t SET n = n WHERE n <= 7', '-- nur Kommentar', 'SHOW search_path']);
    assert.equal(r.statements[1].rowsAffected, 7);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].columns[0].name, 'search_path');
  });

  await step('COPY TO STDOUT bringt den Prozess nicht zum Absturz', async () => {
    const r = await manager.runQuery(sid, [{ sql: 'COPY (SELECT 1) TO STDOUT', offset: 0 }], 10);
    assert.ok(r.statements.length === 1);
    assert.equal((await run(sid, 'SELECT 3 AS x')).results[0].rows[0][0], 3);
  });

  await step('offene Transaktion: vorzeitig geschlossener Cursor stört nicht', async () => {
    await run(sid, 'BEGIN');
    const r = await run(sid, ['SELECT generate_series(1, 10000000) AS g', 'SELECT 42 AS x']);
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[1].rows[0][0], 42);
    assert.equal(r.inTransaction, true);
    await run(sid, 'ROLLBACK');
  });

  await step('FOR UPDATE: alle Zeilen gelesen (sonst wären nur die ersten gesperrt)', async () => {
    const s = (await run(sid, 'SELECT n FROM t FOR UPDATE', 100)).results[0];
    assert.equal(s.rows.length, 100);
    assert.equal(s.totalRows, 3000);
  });

  await step('Export: alles noch einmal, bytea vollständig', async () => {
    const sql = "SELECT g, decode(repeat('ab', 1500), 'hex') AS b FROM generate_series(1, 3000) g";
    const s = (await run(sid, sql)).results[0];
    assert.equal(s.truncated, true);
    const e = (await manager.exportQuery(sid, { sql, offset: 0 }, 0, csv('pg-bin', 'postgres')))!;
    assert.equal(e.rows, 3000);
    const lines = csvLines(e.file);
    assert.equal(lines.length, 3001);
    assert.ok(lines[1].toUpperCase().includes('AB'.repeat(1500)), 'bytea vollständig');
  });

  await step('Abbrechen während einer Abfrage, danach geht es weiter', async () => {
    const pending = manager.runQuery(sid, [{ sql: 'SELECT pg_sleep(20)', offset: 0 }], 10);
    await sleep(400);
    await manager.cancelQuery(sid);
    const r = await Promise.race([pending, sleep(8000).then(() => null)]);
    assert.ok(r, 'hängt');
    assert.equal(r.statements[0].error, 'Abgebrochen.');
    assert.equal((await run(sid, 'SELECT 5 AS x')).results[0].rows[0][0], 5);
  });

  await step('Nur lesen: großes Ergebnis wird ebenfalls begrenzt', async () => {
    const ro = await connect('postgres', true);
    const r = await run(ro.sid, 'SELECT generate_series(1, 100000000) AS g');
    assert.equal(r.results[0].rows.length, 1000);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
    await manager.closeSession(ro.sid);
  });

  await manager.closeSession(sid);
}

const BIG = 'SELECT TOP (3000000) a.object_id AS a, b.object_id AS b FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c';

async function mssqlTests() {
  console.log('\nmssql');
  const { sid } = await connect('mssql');

  await step('einzelne lesende Abfrage: Abbruch nach max. Zeilen + 1', async () => {
    const r = await run(sid, BIG);
    const s = r.results[0];
    assert.equal(s.rows.length, 1000);
    assert.equal(s.truncated, true);
    assert.equal(s.totalRows, undefined);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
    assert.equal((await run(sid, 'SELECT 7 AS x')).results[0].rows[0][0], 7);
  });

  await step('Batch mit zwei Abfragen: die erste kommt ganz (gezählt), danach die zweite', async () => {
    const r = await run(sid, 'SELECT TOP (20000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b\nSELECT 1 AS x');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[0].totalRows, 20000);
    assert.deepEqual(r.results[1].rows, [[1]]);
  });

  await step('Batch mit DECLARE: Abbruch in der (einzigen) Ergebnismenge', async () => {
    const r = await run(sid, `DECLARE @n int = 3000000\n${BIG.replace('TOP (3000000)', 'TOP (@n)')}`);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].rows.length, 1000);
    assert.equal(r.results[0].totalRows, undefined);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });

  await step('Batch mit zwei Abfragen, die große zuletzt: dort abgebrochen, die erste vollständig', async () => {
    const r = await run(sid, `SELECT TOP (5000) a.object_id AS a FROM sys.all_objects a CROSS JOIN sys.all_objects b\n${BIG}`);
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].totalRows, 5000);
    assert.equal(r.results[1].rows.length, 1000);
    assert.equal(r.results[1].totalRows, undefined);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
    assert.equal((await run(sid, 'SELECT 6 AS x')).results[0].rows[0][0], 6);
  });

  await step('danach noch eine Anweisung (PRINT): nichts abgebrochen, Meldung kommt', async () => {
    const r = await run(sid, "SELECT TOP (20000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b\nPRINT 'fertig'");
    assert.equal(r.results[0].totalRows, 20000);
    assert.ok(r.messages.includes('fertig'), r.messages.join(' | '));
  });

  await step('offene Transaktion: kein Abbruch (XACT_ABORT rollte sie sonst zurück)', async () => {
    await run(sid, 'BEGIN TRANSACTION');
    const s = (await run(sid, 'SELECT TOP (20000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b')).results[0];
    assert.equal(s.totalRows, 20000);
    const r = await run(sid, 'SELECT @@TRANCOUNT AS tc');
    assert.equal(r.results[0].rows[0][0], 1);
    await run(sid, 'ROLLBACK');
  });

  await step('FOR JSON und FOR XML (Zeile kommt als Objekt)', async () => {
    const r = await run(sid, ["SELECT TOP (3) name FROM sys.objects ORDER BY name FOR JSON PATH", "SELECT 1 AS a FOR XML PATH('r')"]);
    assert.match(String(r.results[0].rows[0][0]), /^\[\{"name":/);
    assert.equal(r.results[1].rows[0][0], '<r><a>1</a></r>');
  });

  await step('Fehler im Batch wie bisher', async () => {
    assert.match(await runError(sid, 'SELECT 1 AS a\nSELECT 1/0 AS b'), /Divide by zero/);
    assert.equal((await run(sid, 'SELECT 8 AS x')).results[0].rows[0][0], 8);
  });

  await step('Plan mit Laufzeit: das Ergebnis wird nur durchgereicht', async () => {
    const p = await manager.explainQuery(sid, [{ sql: 'SELECT TOP (300000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b', offset: 0 }], true);
    assert.ok(!p.statements[0].error, p.statements[0].error);
    assert.ok(p.statements.length >= 1);
    assert.equal((await run(sid, 'SELECT 9 AS x')).results[0].rows[0][0], 9);
  });

  await step('Export: zweites Ergebnis des Batches, vollständig', async () => {
    const sql = 'SELECT 1 AS a\nSELECT TOP (5000) a.object_id AS id FROM sys.all_objects a CROSS JOIN sys.all_objects b';
    const e = (await manager.exportQuery(sid, { sql, offset: 0 }, 1, csv('mssql-zwei', 'mssql')))!;
    assert.equal(e.rows, 5000);
    assert.equal(csvLines(e.file)[0], 'id');
  });

  await step('Binärwerte über 1 KB: Anzeige gekürzt, Export vollständig', async () => {
    const sql = "SELECT TOP (3) CAST(REPLICATE(CAST('A' AS varchar(max)), 2000) AS varbinary(max)) AS b FROM sys.objects";
    const s = (await run(sid, sql)).results[0];
    assert.equal(s.binaryCut, true);
    const e = (await manager.exportQuery(sid, { sql, offset: 0 }, 0, csv('mssql-bin', 'mssql')))!;
    assert.equal(e.rows, 3);
    assert.ok(csvLines(e.file)[1].includes('41'.repeat(2000)));
  });

  await step('Abbrechen während einer Abfrage, danach geht es weiter', async () => {
    const pending = manager.runQuery(sid, [{ sql: "WAITFOR DELAY '00:00:20'", offset: 0 }], 10);
    await sleep(400);
    await manager.cancelQuery(sid);
    const r = await Promise.race([pending, sleep(8000).then(() => null)]);
    assert.ok(r, 'hängt');
    assert.equal(r.statements[0].error, 'Abgebrochen.');
    assert.equal((await run(sid, 'SELECT 10 AS x')).results[0].rows[0][0], 10);
  });

  await step('SET STATISTICS PROFILE in der Sitzung: nichts mehr abgebrochen (sonst fehlte das Profil)', async () => {
    const x = await connect('mssql');
    await run(x.sid, 'SET STATISTICS PROFILE ON');
    const r = await run(x.sid, 'SELECT TOP (20000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b');
    assert.equal(r.results[0].totalRows, 20000);
    assert.ok(r.results.length >= 2, 'Profil fehlt');
    await manager.closeSession(x.sid);
  });

  await manager.closeSession(sid);
}

(async () => {
  const only = process.argv[2] as Target | undefined;
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in TARGETS)) {
    console.error(`Unbekannter Datenbanktyp „${only}“ – möglich: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  const list = (Object.keys(TARGETS) as Target[]).filter((t) => !only || t === only);
  assertTestContainers(list.map((t) => ({ name: t, host: '127.0.0.1', port: TARGETS[t].port })));
  for (const t of list) {
    if (t === 'mysql' || t === 'mariadb') await mysqlTests(t);
    else if (t === 'postgres') await postgresTests();
    else await mssqlTests();
  }
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
