/* Schließen, Abbrechen, Beenden: eine laufende Anweisung wird beim Schließen der Sitzung abgebrochen, ein stummer Server
   hält weder Abbrechen noch Trennen noch Beenden auf, Abbrechen eines Auftrags erreicht die Quelle vor der ersten Zeile.
   Aufruf: npm run testdb:up, dann npm run test:close [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Dialect, DumpRequest, ExportOptions, QueryRun, TableDataRequest } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import type { Session } from '../drivers';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const TARGETS: Record<Target, { dialect: Dialect; port: number; user: string; password: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1' },
};

const DB = 'close_test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-close-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const manager = new Manager(
  store,
  {
    pickFile: async () => null,
    saveFile: async (base, format) => path.join(dir, `${base}-${Date.now()}.${format}`),
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

async function run(sid: string, sql: string | string[], maxRows = 100): Promise<QueryRun> {
  const r = await manager.runQuery(sid, (Array.isArray(sql) ? sql : [sql]).map((s) => ({ sql: s, offset: 0 })), maxRows);
  const bad = r.statements.find((s) => s.error);
  if (bad) throw new Error(`${bad.error}\n       bei: ${bad.sql.slice(0, 120)}`);
  return r;
}

async function connect(t: Target): Promise<{ id: string; sid: string }> {
  const c = TARGETS[t];
  const saved = await store.save({
    name: t,
    dialect: c.dialect,
    host: '127.0.0.1',
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.dialect === 'mssql' ? 'master' : c.dialect === 'postgres' ? 'postgres' : '',
    options: c.dialect === 'mssql' ? { trustServerCertificate: true } : {},
  });
  const { sessionId } = await manager.openSession(saved.id);
  return { id: saved.id, sid: sessionId };
}

/** Text, der nur in den langen Abfragen dieses Tests vorkommt */
const MARK = 'close_marker';

/** 20 s warten – in der Sitzung; mark: woran die Anweisung auf dem Server zu erkennen ist */
function sleepSql(d: Dialect, mark = MARK): string {
  if (d === 'mysql') return `SELECT SLEEP(20) AS ${mark}`;
  if (d === 'postgres') return `SELECT pg_sleep(20) AS ${mark}`;
  return `WAITFOR DELAY '00:00:20' -- ${mark}`;
}

/** WHERE-Bedingung, mit der das Lesen der Tabelle lange keine Zeile liefert (die Teilmengen- und Export-Pfade) */
function slowWhere(d: Dialect): string {
  if (d === 'mysql') return `SLEEP(20) = 0 AND 'x' <> '${MARK}'`;
  if (d === 'postgres') return `(SELECT COUNT(*) FROM generate_series(1, 400000000) AS ${MARK}) > 0`;
  // SQL Server kürzt Zählungen und Summen über Kreuzprodukte ab (EXISTS, Aggregat-Umformung): eine Schleife in einer Funktion nicht
  return `${DB}.dbo.slow() = 1 AND 'x' <> '${MARK}'`;
}

/** läuft auf dem Server noch etwas mit der Marke? (über eine eigene Sitzung) */
async function runningOnServer(d: Dialect, id: string): Promise<number> {
  const { sessionId } = await manager.openSession(id);
  try {
    const sql =
      d === 'mysql'
        ? `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE '%${MARK}%' AND INFO NOT LIKE '%PROCESSLIST%'`
        : d === 'postgres'
          ? `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%${MARK}%' AND query NOT LIKE '%pg_stat_activity%'`
          : `SELECT COUNT(*) AS n FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) q WHERE q.text LIKE '%${MARK}%' AND q.text NOT LIKE '%dm_exec_requests%'`;
    return Number((await run(sessionId, sql)).results[0].rows[0][0]);
  } finally {
    await manager.closeSession(sessionId);
  }
}

function schemaOf(d: Dialect): string {
  return d === 'mysql' ? '' : d === 'postgres' ? 'public' : 'dbo';
}

const csv = (baseName: string, dialect: Dialect): ExportOptions => ({ format: 'csv', baseName, dialect, bom: false, header: true, delimiter: ';' });

async function tests(t: Target) {
  const d = TARGETS[t].dialect;
  console.log(`\n${t}`);
  let { id, sid } = await connect(t);
  const schema = schemaOf(d);
  const tableReq = (where: string): TableDataRequest => ({
    object: { connectionId: id, database: DB, schema, name: 't', kind: 'table' },
    limit: 0,
    offset: 0,
    sort: [],
    where,
  });

  await step('Testdatenbank anlegen', async () => {
    if (d === 'mysql') await run(sid, [`DROP DATABASE IF EXISTS ${DB}`, `CREATE DATABASE ${DB}`, `USE ${DB}`]);
    else if (d === 'postgres') {
      await run(sid, [`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `CREATE DATABASE ${DB}`]);
      await manager.setSessionDatabase(sid, DB);
    } else {
      await run(sid, [`IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DB}; END`, `CREATE DATABASE ${DB}`, `USE ${DB}`]);
    }
    await run(sid, ['CREATE TABLE t (id int PRIMARY KEY, name varchar(20))', "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"]);
    // SQL Server: eine Funktion, die lange rechnet (Minuten) – Abbrechen (Attention) unterbricht auch sie
    if (d === 'mssql') await run(sid, 'CREATE FUNCTION dbo.slow() RETURNS int AS BEGIN DECLARE @i bigint = 0; WHILE @i < 2000000000 SET @i += 1; RETURN 1; END');
  });

  await step('Sitzung schließen bricht die laufende Anweisung ab (unter 4 s, Server ist frei)', async () => {
    const pending = manager.runQuery(sid, [{ sql: sleepSql(d), offset: 0 }], 10);
    await sleep(500);
    const t0 = Date.now();
    await manager.closeSession(sid);
    const closeMs = Date.now() - t0;
    const r = await Promise.race([pending, sleep(3000).then(() => null)]);
    await sleep(1500);
    const still = await runningOnServer(d, id);
    sid = (await manager.openSession(id, d === 'mysql' ? DB : undefined)).sessionId;
    assert.ok(closeMs < 4000, `closeSession brauchte ${closeMs} ms`);
    assert.ok(r, 'die Ausführung hängt nach dem Schließen');
    // MySQL: ein unterbrochenes SLEEP() liefert 1 statt eines Fehlers – dann steht der Abbruch im Lauf
    assert.ok(r.cancelled || r.statements[0]?.error, 'Abbruch erwartet');
    assert.equal(still, 0, 'die Anweisung läuft auf dem Server weiter');
  });

  await step('Abbrechen ohne Antwort vom Server: nach der Frist hart getrennt, Tab bleibt benutzbar', async () => {
    const entry = (manager as unknown as { sessions: Map<string, { session: Session }> }).sessions.get(sid)!;
    // als wäre der Server stumm: das serverseitige Abbrechen tut nichts
    (entry.session as unknown as { cancelCurrent(): Promise<void> }).cancelCurrent = async () => undefined;
    // eigene Marke: diese Anweisung läuft auf dem Server zu Ende (bis 20 s) und darf die späteren Prüfungen nicht stören
    const pending = manager.runQuery(sid, [{ sql: sleepSql(d, 'close_mute'), offset: 0 }], 10);
    await sleep(300);
    const t0 = Date.now();
    await manager.cancelQuery(sid);
    const ms = Date.now() - t0;
    assert.ok(ms >= 4500 && ms < 9000, `Abbrechen brauchte ${ms} ms (erwartet: Frist von 5 s, dann hart trennen)`);
    const r = await Promise.race([pending, sleep(2000).then(() => null)]);
    assert.ok(r, 'die Ausführung hängt nach dem harten Trennen');
    assert.ok(r.statements[0]?.error, 'Fehler erwartet');
    assert.equal(entry.session.broken, true);
    const again = await manager.runQuery(sid, [{ sql: 'SELECT 1', offset: 0 }], 10);
    assert.equal(again.reconnected, true);
    assert.equal(Number((await run(sid, 'SELECT 1 AS x')).results[0].rows[0][0]), 1);
    // der Server beendet die alte Anweisung von sich aus, sobald er die tote Verbindung bemerkt – hier nur aufräumen
    await sleep(500);
  });

  await step('Auftrag abbrechen, bevor die Quelle eine Zeile liefert (Teil-Dump mit WHERE)', async () => {
    const req: DumpRequest = {
      connectionId: id,
      database: DB,
      tables: [{ schema, name: 't' }],
      views: [],
      structure: false,
      data: true,
      dropFirst: false,
      targetDialect: d,
      rowsPerInsert: 100,
      baseName: 'teil',
      subset: [{ schema, name: 't', rule: { kind: 'where', where: slowWhere(d) } }],
    };
    const jobId = (await manager.startDump(req))!;
    await sleep(800);
    assert.equal((await manager.jobStatus(jobId)).state, 'running');
    const t0 = Date.now();
    await manager.cancelJob(jobId);
    let st = await manager.jobStatus(jobId);
    while (st.state === 'running' && Date.now() - t0 < 8000) {
      await sleep(100);
      st = await manager.jobStatus(jobId);
    }
    assert.equal(st.state, 'cancelled', `Auftrag nach ${Date.now() - t0} ms: ${st.state} ${st.error ?? ''}`);
    assert.ok(Date.now() - t0 < 8000, 'Abbrechen hat zu lange gedauert');
    await sleep(1500);
    assert.equal(await runningOnServer(d, id), 0, 'die Quellabfrage läuft auf dem Server weiter');
  });

  await step('Trennen während eines Tabellen-Exports: wartet nicht auf den Export, Verbindung danach wieder nutzbar', async () => {
    // Ausgang sofort abfangen: die Ablehnung kommt während disconnect() (sonst „unhandled rejection“ im Test)
    const pending = manager.exportTable(tableReq(slowWhere(d)), csv('export', d)).then(
      () => 'fertig',
      (e: Error) => `Fehler: ${e.message}`,
    );
    await sleep(800);
    const t0 = Date.now();
    await manager.disconnect(id);
    const ms = Date.now() - t0;
    const outcome = await Promise.race([pending, sleep(3000).then(() => 'hängt')]);
    await sleep(1500);
    const still = await runningOnServer(d, id);
    sid = (await manager.openSession(id, d === 'mysql' ? DB : undefined)).sessionId;
    assert.ok(ms < 9000, `disconnect brauchte ${ms} ms`);
    assert.ok(outcome.startsWith('Fehler:'), `Export: ${outcome}`);
    assert.equal(still, 0, 'die Export-Abfrage läuft auf dem Server weiter');
    assert.equal(Number((await run(sid, 'SELECT 2 AS x')).results[0].rows[0][0]), 2);
  });

  await step('Testdatenbank entfernen', async () => {
    if (d === 'mysql') await run(sid, `DROP DATABASE ${DB}`);
    else if (d === 'postgres') {
      await manager.setSessionDatabase(sid, 'postgres');
      await run(sid, `DROP DATABASE ${DB} WITH (FORCE)`);
    } else await run(sid, ['USE master', `ALTER DATABASE ${DB} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, `DROP DATABASE ${DB}`]);
    await manager.closeSession(sid);
  });
}

async function shutdownTest(t: Target) {
  const d = TARGETS[t].dialect;
  console.log(`\nBeenden (${t})`);
  await step('shutdown() mit laufender Abfrage: bricht ab und kommt in unter 8 s zurück', async () => {
    const { id, sid } = await connect(t);
    const pending = manager.runQuery(sid, [{ sql: sleepSql(d), offset: 0 }], 10);
    await sleep(500);
    const t0 = Date.now();
    await manager.shutdown();
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `shutdown brauchte ${ms} ms`);
    const r = await Promise.race([pending, sleep(3000).then(() => null)]);
    assert.ok(r, 'die Ausführung hängt nach dem Beenden');
    await sleep(1500);
    // nach shutdown() gibt es keine Treiber mehr; eine neue Sitzung baut einen neuen auf
    assert.equal(await runningOnServer(d, id), 0, 'die Anweisung läuft auf dem Server weiter');
    await manager.shutdown();
  });
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
  for (const t of list) await tests(t);
  await shutdownTest(list[0]);
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
