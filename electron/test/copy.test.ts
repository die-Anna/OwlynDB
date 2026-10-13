/* Direkt kopieren (Dump und Einspielen in einem Schritt, ohne Datei): auf demselben Server, MySQL → MariaDB,
   über Typgrenzen, in eine vorhandene Datenbank, Schutzregeln, Fehler im Ziel, Abbrechen.
   Vorher: npm run testdb:up; npm run test:drivers (Datenbank shop). Aufruf: npm run test:copy */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, CopyRequest, Dialect, JobStatus } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-copy-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const m = new Manager(store, undefined, 0);

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

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const targets: Record<Target, { dialect: Dialect; port: number; user: string; password: string; schema: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test', schema: '' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test', schema: '' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test', schema: 'public' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1', schema: 'dbo' },
};
const ids = {} as Record<Target, string>;

function input(t: Target, extra: Partial<ConnectionInput> = {}): ConnectionInput {
  const x = targets[t];
  return {
    name: t,
    dialect: x.dialect,
    host: '127.0.0.1',
    port: x.port,
    user: x.user,
    password: x.password,
    database: x.dialect === 'postgres' ? 'postgres' : undefined,
    options: x.dialect === 'mssql' ? { trustServerCertificate: true } : {},
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

async function run(t: Target, db: string | undefined, sql: string): Promise<unknown> {
  const { sessionId } = await m.openSession(ids[t], db);
  try {
    const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
    if (r.statements[0]?.error) throw new Error(`${sql.slice(0, 80)}: ${r.statements[0].error}`);
    return r.results[0]?.rows[0]?.[0];
  } finally {
    await m.closeSession(sessionId);
  }
}

const num = async (t: Target, db: string, sql: string) => Number(await run(t, db, sql));

async function dropDb(t: Target, db: string) {
  const d = targets[t].dialect;
  if (d === 'mysql') await run(t, undefined, `DROP DATABASE IF EXISTS \`${db}\``);
  if (d === 'postgres') await run(t, 'postgres', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  if (d === 'mssql') await run(t, 'master', `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`);
}

const table = (t: Target, name: string, schema?: string) => {
  const d = targets[t].dialect;
  return d === 'mysql' ? `\`${name}\`` : `${schema ?? targets[t].schema}.${name}`;
};

/** Kunden, Bestellungen und die View aus shop; extra = weitere Tabellen */
function request(src: Target, dst: Target, db: string, opts: Partial<CopyRequest> & { views?: boolean; extra?: { schema: string; name: string }[]; data?: boolean; structure?: boolean } = {}): CopyRequest {
  const schema = targets[src].schema;
  return {
    source: {
      connectionId: ids[src],
      database: 'shop',
      tables: [{ schema, name: 'kunden' }, { schema, name: 'bestellungen' }, ...(opts.extra ?? [])],
      views: opts.views ? [{ schema, name: 'v_umsatz' }] : [],
      structure: opts.structure ?? true,
      data: opts.data ?? true,
      dropFirst: true,
      routines: false,
      rowsPerInsert: 250,
    },
    targetConnectionId: ids[dst],
    targetDatabase: db,
    createDatabase: opts.createDatabase ?? true,
    stopOnError: opts.stopOnError ?? true,
    transaction: opts.transaction ?? false,
  };
}

async function copy(req: CopyRequest): Promise<JobStatus> {
  const s = await waitJob(await m.startCopy(req));
  if (s.log.length) console.log('       Protokoll: ' + s.log.join(' | ').slice(0, 300));
  return s;
}

/** Zeilen, Summe, Sonderzeichen und Fremdschlüssel wie in der Quelle */
async function same(src: Target, dst: Target, db: string) {
  for (const tb of ['kunden', 'bestellungen']) {
    assert.equal(await num(dst, db, `SELECT COUNT(*) FROM ${table(dst, tb)}`), await num(src, 'shop', `SELECT COUNT(*) FROM ${table(src, tb)}`), `Zeilen ${tb}`);
  }
  const sum = (t: Target, d: string) => num(t, d, `SELECT SUM(betrag) FROM ${table(t, 'bestellungen')}`);
  assert.equal(await sum(dst, db), await sum(src, 'shop'), 'Summe betrag');
  const notiz = (t: Target, d: string) => run(t, d, `SELECT notiz FROM ${table(t, 'kunden')} WHERE id = 42`);
  assert.equal(await notiz(dst, db), await notiz(src, 'shop'), 'Text mit % und _');
  await assert.rejects(
    run(dst, db, `INSERT INTO ${table(dst, 'bestellungen')} (kunde_id, datum, betrag, status) VALUES (999999, '2025-01-01', 1, 'offen')`),
    /foreign|FOREIGN|REFERENCE|Fremd/i,
    'Fremdschlüssel',
  );
}

async function main() {
  const all = Object.keys(targets) as Target[];
  assertTestContainers(all.map((t) => ({ name: t, host: '127.0.0.1', port: targets[t].port })));
  for (const t of all) ids[t] = (await store.save(input(t))).id;

  console.log('\nKopieren');
  await step('MySQL → neue Datenbank auf demselben Server (mit View)', async () => {
    await dropDb('mysql', 'copy_my');
    const s = await copy(request('mysql', 'mysql', 'copy_my', { views: true }));
    assert.equal(s.state, 'done', s.error);
    assert.equal(s.kind, 'copy');
    assert.ok(s.done >= 8500 && s.statements > 10, `Zeilen ${s.done}, Anweisungen ${s.statements}`);
    await same('mysql', 'mysql', 'copy_my');
    assert.ok((await num('mysql', 'copy_my', 'SELECT COUNT(*) FROM v_umsatz')) > 0, 'View');
  });
  await step('MySQL → MariaDB (anderer Server, gleicher Typ)', async () => {
    await dropDb('mariadb', 'copy_from_mysql');
    const s = await copy(request('mysql', 'mariadb', 'copy_from_mysql', { views: true }));
    assert.equal(s.state, 'done', s.error);
    await same('mysql', 'mariadb', 'copy_from_mysql');
    assert.equal(await num('mariadb', 'copy_from_mysql', 'SELECT COUNT(*) FROM v_umsatz'), await num('mysql', 'shop', 'SELECT COUNT(*) FROM v_umsatz'), 'View');
  });
  await step('PostgreSQL → SQL Server (Typen übersetzt, eigenes Schema, Transaktion)', async () => {
    await dropDb('mssql', 'copy_pg_ms');
    const s = await copy(request('postgres', 'mssql', 'copy_pg_ms', { transaction: true, extra: [{ schema: 'verkauf', name: 'regionen' }] }));
    assert.equal(s.state, 'done', s.error);
    await same('postgres', 'mssql', 'copy_pg_ms');
    assert.equal(await num('mssql', 'copy_pg_ms', 'SELECT COUNT(*) FROM verkauf.regionen'), 2, 'Schema verkauf');
  });
  await step('SQL Server → PostgreSQL, dann noch einmal in die vorhandene Datenbank (vorher löschen)', async () => {
    await dropDb('postgres', 'copy_ms_pg');
    let s = await copy(request('mssql', 'postgres', 'copy_ms_pg', { transaction: true }));
    assert.equal(s.state, 'done', s.error);
    await same('mssql', 'postgres', 'copy_ms_pg');
    s = await copy(request('mssql', 'postgres', 'copy_ms_pg', { createDatabase: false, transaction: true }));
    assert.equal(s.state, 'done', s.error);
    await same('mssql', 'postgres', 'copy_ms_pg');
  });

  console.log('\nSchutz, Fehler, Abbrechen');
  await step('Quelle = Ziel: abgelehnt (gleiche Verbindung)', async () => {
    await assert.rejects(m.startCopy(request('mysql', 'mysql', 'shop', { createDatabase: false })), /dieselbe Datenbank/);
  });
  await step('Quelle = Ziel: abgelehnt (andere Verbindung, gleicher Server)', async () => {
    const twin = await store.save(input('mysql', { name: 'zwilling' }));
    await assert.rejects(m.startCopy({ ...request('mysql', 'mysql', 'SHOP', { createDatabase: false }), targetConnectionId: twin.id }), /dieselbe Datenbank/);
  });
  await step('Ziel auf „Nur lesen“: abgelehnt', async () => {
    const ro = await store.save(input('postgres', { name: 'nur lesen', options: { readOnly: true } }));
    await assert.rejects(m.startCopy({ ...request('mysql', 'postgres', 'copy_ro'), targetConnectionId: ro.id }), /Nur lesen/);
  });
  await step('Fehler im Ziel mit Transaktion: Meldung, nichts übernommen, Quelle hört auf', async () => {
    // nur Daten, aber im leeren Ziel fehlen die Tabellen
    await dropDb('mssql', 'copy_err');
    const s = await copy(request('postgres', 'mssql', 'copy_err', { structure: false, transaction: true }));
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /^Im Ziel: .*kunden/s);
    assert.ok(s.durationMs < 5000, `Auftrag lief noch ${s.durationMs} ms`);
    assert.ok(s.log.some((l) => /zurückgerollt/.test(l)), s.log.join(' | '));
    assert.equal(await num('mssql', 'copy_err', 'SELECT COUNT(*) FROM sys.tables'), 0);
  });
  await step('Abbrechen bei großer Tabelle (300 000 Zeilen)', async () => {
    await dropDb('mysql', 'copy_big_src');
    await run('mysql', undefined, 'CREATE DATABASE copy_big_src');
    await run('mysql', 'copy_big_src', 'CREATE TABLE gross (id INT PRIMARY KEY, txt VARCHAR(60))');
    const digits = '(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
    await run(
      'mysql',
      'copy_big_src',
      `INSERT INTO gross SELECT a.d + 10*b.d + 100*c.d + 1000*e.d + 10000*f.d + 100000*g.d, CONCAT('Zeile ', a.d, b.d, c.d) FROM ${digits} a, ${digits} b, ${digits} c, ${digits} e, ${digits} f, (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2) g`,
    );
    await dropDb('mariadb', 'copy_big');
    const req = request('mysql', 'mariadb', 'copy_big');
    req.source.database = 'copy_big_src';
    req.source.tables = [{ schema: '', name: 'gross' }];
    const id = await m.startCopy(req);
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    await m.cancelJob(id);
    const s = await waitJob(id);
    assert.equal(s.state, 'cancelled', s.error);
    assert.ok(Date.now() - t0 < 10_000, 'Abbrechen dauerte zu lange');
    const copied = await num('mariadb', 'copy_big', 'SELECT COUNT(*) FROM gross');
    assert.ok(copied < 300_000, `${copied} Zeilen im Ziel`);
  });

  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
