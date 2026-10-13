/* Laufende Abfragen und Sitzungen des Servers: Liste mit eigenen Tabs, Sperren und Transaktionen; Abfrage abbrechen,
   Sitzung beenden, Schutz (anderer Server, wiederverwendete ID, eigene Listen-Verbindung, „Nur lesen“).
   Vorher: npm run testdb:up. Aufruf: npm run test:sessions [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, SqlDialect, QueryRun, ServerSession, ServerSessionList } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-sess-'));
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
const targets: Record<Target, { dialect: SqlDialect; port: number; user: string; password: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1' },
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stmts = (...sql: string[]) => sql.map((s) => ({ sql: s, offset: 0 }));

async function exec(sessionId: string, ...sql: string[]): Promise<QueryRun> {
  const r = await m.runQuery(sessionId, stmts(...sql), 10);
  const err = r.statements.find((s) => s.error);
  if (err) throw new Error(`${err.sql.slice(0, 80)}: ${err.error}`);
  return r;
}

/** Zeile der Liste zur Sitzung eines Abfrage-Tabs */
function rowOf(list: ServerSessionList, sessionId: string): ServerSession {
  const serverId = Object.entries(list.own).find(([, sid]) => sid === sessionId)?.[0];
  assert.ok(serverId, 'Abfrage-Tab nicht zugeordnet: ' + JSON.stringify(list.own));
  const row = list.sessions.find((s) => s.id === serverId);
  assert.ok(row, `Sitzung ${serverId} fehlt in der Liste`);
  return row;
}

/** in die Liste: mit Wiederholung, bis die Bedingung gilt (der Server meldet Sperren mit kurzer Verzögerung) */
async function listUntil(connectionId: string, ok: (l: ServerSessionList) => boolean): Promise<ServerSessionList> {
  let last: ServerSessionList | undefined;
  for (let i = 0; i < 20; i++) {
    last = await m.listServerSessions(connectionId);
    if (ok(last)) return last;
    await sleep(250);
  }
  return last!;
}

const SETUP: Record<SqlDialect, { db: string; prepare: string[]; table: string; begin: string; sleepSql: string }> = {
  mysql: {
    db: 'sesstest',
    prepare: ['CREATE TABLE IF NOT EXISTS st_t (id INT PRIMARY KEY, x INT)', 'INSERT IGNORE INTO st_t VALUES (1, 0)'],
    table: 'st_t',
    begin: 'START TRANSACTION',
    sleepSql: 'SELECT SLEEP(20)',
  },
  postgres: {
    db: 'postgres',
    prepare: ['CREATE TABLE IF NOT EXISTS public.st_t (id int PRIMARY KEY, x int)', 'INSERT INTO public.st_t VALUES (1, 0) ON CONFLICT DO NOTHING'],
    table: 'public.st_t',
    begin: 'BEGIN',
    sleepSql: 'SELECT pg_sleep(20)',
  },
  mssql: {
    db: 'sesstest',
    prepare: [
      "IF OBJECT_ID('dbo.st_t') IS NULL CREATE TABLE dbo.st_t (id int PRIMARY KEY, x int)",
      'IF NOT EXISTS (SELECT 1 FROM dbo.st_t) INSERT INTO dbo.st_t VALUES (1, 0)',
    ],
    table: 'dbo.st_t',
    begin: 'BEGIN TRANSACTION',
    sleepSql: "WAITFOR DELAY '00:00:20'",
  },
};

async function dbTests(t: Target) {
  const x = targets[t];
  const setup = SETUP[x.dialect];
  console.log(`\n${t}`);
  const c = await store.save(input(t));
  // Testdatenbank
  if (setup.db !== 'postgres') {
    const s0 = await m.openSession(c.id);
    await exec(s0.sessionId, x.dialect === 'mssql' ? "IF DB_ID('sesstest') IS NULL CREATE DATABASE sesstest" : 'CREATE DATABASE IF NOT EXISTS sesstest');
    await m.closeSession(s0.sessionId);
  }
  const a = (await m.openSession(c.id, setup.db)).sessionId;
  const b = (await m.openSession(c.id, setup.db)).sessionId;
  await exec(a, ...setup.prepare);

  let blocked: Promise<QueryRun> | undefined;
  let list: ServerSessionList | undefined;
  await step('Liste: eigene Tabs, offene Transaktion, wer blockiert wen', async () => {
    await exec(a, setup.begin, `UPDATE ${setup.table} SET x = x + 1 WHERE id = 1`);
    blocked = m.runQuery(b, stmts(`UPDATE ${setup.table} SET x = x + 2 WHERE id = 1`), 10);
    list = await listUntil(c.id, (l) => {
      try {
        return rowOf(l, b).blockedBy.length > 0;
      } catch {
        return false;
      }
    });
    const ra = rowOf(list, a);
    const rb = rowOf(list, b);
    assert.ok(list.server, 'Server-Kennung');
    assert.ok(list.self && list.self !== ra.id && list.self !== rb.id, 'Listen-Verbindung');
    assert.ok(ra.txSeconds !== undefined && ra.txSeconds >= 0, 'Transaktion von A');
    // ruhende Sitzung: letzte Anweisung (MariaDB ohne performance_schema: keine)
    if (t !== 'mariadb') assert.match(ra.query ?? '', /UPDATE/i, 'letzte Anweisung von A');
    assert.equal(rb.active, true, 'B läuft');
    assert.deepEqual(rb.blockedBy, [ra.id], 'B wartet auf A');
    assert.match(rb.query ?? '', /UPDATE/i);
    assert.equal(list.canCancelQuery, x.dialect !== 'mssql');
    assert.equal(list.readOnly, false);
  });

  await step('Schutz: anderer Server, eigene Listen-Verbindung, wiederverwendete ID', async () => {
    const ra = rowOf(list!, a);
    await assert.rejects(m.killServerSession(c.id, { id: ra.id, started: ra.started, server: 'gibts-nicht|1' }, 'session'), /anderen Server/);
    await assert.rejects(m.killServerSession(c.id, { id: list!.self!, started: undefined, server: list!.server }, 'session'), /Liste holt|gibt es nicht/);
    if (x.dialect !== 'mysql') {
      await assert.rejects(m.killServerSession(c.id, { id: ra.id, started: '2001-01-01 00:00:00', server: list!.server }, 'session'), /gibt es nicht mehr/);
    }
    if (x.dialect === 'mssql') {
      await assert.rejects(m.killServerSession(c.id, { id: ra.id, started: ra.started, server: list!.server }, 'query'), /nicht einzeln/);
    }
  });

  await step('Sitzung A beenden: Sperre weg, B läuft durch', async () => {
    const ra = rowOf(list!, a);
    await m.killServerSession(c.id, { id: ra.id, started: ra.started, server: list!.server }, 'session');
    const r = await Promise.race([blocked!, sleep(10_000).then(() => null)]);
    assert.ok(r, 'B wartet weiter');
    assert.equal(r.statements[0]?.error, undefined, r.statements[0]?.error);
    const after = await m.listServerSessions(c.id);
    assert.ok(!after.sessions.some((s) => s.id === ra.id), 'A ist noch in der Liste');
  });
  await m.closeSession(a);

  if (x.dialect !== 'mssql') {
    await step('Abfrage abbrechen: Sitzung bleibt bestehen', async () => {
      const run = m.runQuery(b, stmts(setup.sleepSql), 10);
      const l = await listUntil(c.id, (x2) => {
        try {
          return rowOf(x2, b).active;
        } catch {
          return false;
        }
      });
      const rb = rowOf(l, b);
      const t0 = Date.now();
      await m.killServerSession(c.id, { id: rb.id, started: rb.started, server: l.server }, 'query');
      await run;
      assert.ok(Date.now() - t0 < 10_000, 'Abbrechen wirkte nicht');
      const r = await exec(b, 'SELECT 1');
      assert.equal(Number(r.results[0].rows[0][0]), 1);
    });
  }
  await m.closeSession(b);

  // Nur lesen: Liste ja, Beenden nein
  const ro = await store.save(input(t, { name: t + ' (nur lesen)', options: { ...input(t).options, readOnly: true } }));
  await step('Nur lesen: Liste geht, Beenden abgelehnt', async () => {
    const l = await m.listServerSessions(ro.id);
    assert.equal(l.readOnly, true);
    assert.ok(l.sessions.length > 0);
    await assert.rejects(m.killServerSession(ro.id, { id: l.sessions[0].id, started: l.sessions[0].started, server: l.server }, 'session'), /Nur lesen/);
  });
}

async function main() {
  const only = process.argv[2] as Target | undefined;
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in targets)) {
    console.error(`Unbekannter Datenbanktyp „${only}“ – möglich: ${Object.keys(targets).join(', ')}`);
    process.exit(1);
  }
  const list = (Object.keys(targets) as Target[]).filter((t) => !only || t === only);
  assertTestContainers(list.map((t) => ({ name: t, host: '127.0.0.1', port: targets[t].port })));
  for (const t of list) {
    try {
      await dbTests(t);
    } catch (e) {
      failed++;
      console.log(`  FEHL ${t}: ${(e as Error).message}`);
    }
  }
  await m.shutdown();
  console.log(failed ? `\n${failed} fehlgeschlagen` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
