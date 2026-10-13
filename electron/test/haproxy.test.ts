/* TLS-Tunnel gegen einen echten HAProxy mit Client-Zertifikatspflicht (dev/tls/haproxy.cfg).
   Vorher: bash dev/make-certs.sh; npm run testdb:up; docker compose -f dev/docker-compose.yml --profile tls up -d haproxy
   Braucht die Datenbank shop mit 2500 Kunden aus dem Seed (dev/seed/*.sql) – den spielt npm run test:drivers ein.
   Aufruf: npm run test:haproxy */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, ConnectionOptions, SqlDialect } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { createDriver } from '../drivers';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const cert = (f: string) => path.join(root, 'dev/certs', f);
const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-hap-')), 'c.json'), {
  encrypt: (s) => 'x' + s,
  decrypt: (s) => s.slice(1),
});

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

async function rejects(p: Promise<unknown>, pattern?: RegExp) {
  try {
    await p;
  } catch (e) {
    if (pattern) assert.match((e as Error).message, pattern);
    return;
  }
  throw new Error('Verbindung hätte scheitern müssen');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anweisung in einer Sitzung des Managers; Fehler der Anweisung werfen (stünden sonst nur in statements[].error) */
async function exec(m: Manager, sessionId: string, sql: string) {
  const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 1);
  const bad = r.statements.find((x) => x.error);
  if (bad) throw new Error(`${sql}: ${bad.error}`);
  return r;
}

/** direkte Ports der Server (ohne Proxy) – für Prüfungen am Proxy vorbei */
const directPort = { mysql: 15306, postgres: 15432, mssql: 15433 } as const;

/** HAProxy-Log seit dem Zeitpunkt */
function haproxyLog(since: Date): string {
  return execFileSync('docker', ['logs', '--since', since.toISOString(), 'dbviewer-test-haproxy-1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const targets = {
  mysql: { port: 15336, short: 15473, user: 'root', password: 'dbviewer-test', sql: 'SELECT COUNT(*) FROM kunden' },
  postgres: { port: 15462, short: 15472, user: 'postgres', password: 'dbviewer-test', sql: 'SELECT COUNT(*) FROM public.kunden' },
  mssql: { port: 15463, short: 15474, user: 'sa', password: 'Dbviewer-Test1', sql: 'SELECT COUNT(*) FROM dbo.kunden' },
} as const;

/** temporäre Tabelle anlegen / lesen: zeigt, ob die Sitzung dieselbe geblieben ist */
const tempTable: Record<SqlDialect, [string, string]> = {
  mysql: ['CREATE TEMPORARY TABLE merk (x int)', 'SELECT COUNT(*) FROM merk'],
  postgres: ['CREATE TEMP TABLE merk (x int)', 'SELECT COUNT(*) FROM merk'],
  mssql: ['CREATE TABLE #merk (x int)', 'SELECT COUNT(*) FROM #merk'],
};

const tunnel: ConnectionOptions = {
  tunnel: true,
  verifyServer: true,
  verifyHostname: true,
  caFile: cert('ca.crt'),
  certFile: cert('client.crt'),
  keyFile: cert('client.key'),
};

function input(dialect: SqlDialect, o: ConnectionOptions, extra: Partial<ConnectionInput> = {}): ConnectionInput {
  const t = targets[dialect];
  return { name: 'hap', dialect, host: '127.0.0.1', port: t.port, user: t.user, password: t.password, database: 'shop', options: o, ...extra };
}

/** Metadaten (Pool) und Abfrage (eigene Sitzung) über den Proxy */
async function count(i: ConnectionInput): Promise<number> {
  const d = createDriver(i.dialect, await store.driverConfig(i));
  try {
    assert.ok((await d.listDatabases()).includes('shop'));
    const s = await d.openSession('shop');
    try {
      const r = await s.run([{ sql: targets[i.dialect as SqlDialect].sql, offset: 0 }], 1);
      if (r.statements[0].error) throw new Error(r.statements[0].error);
      return Number(r.results[0].rows[0][0]);
    } finally {
      await s.close();
    }
  } finally {
    await d.close();
  }
}

async function main() {
  assertTestContainers(
    Object.entries(targets).flatMap(([name, t]) => [
      { name, host: '127.0.0.1', port: t.port },
      { name: name + ' (kurz)', host: '127.0.0.1', port: t.short },
      { name: name + ' (direkt)', host: '127.0.0.1', port: directPort[name as SqlDialect] },
    ]),
  );
  for (const dialect of ['mysql', 'postgres', 'mssql'] as const) {
    console.log(`\nHAProxy → ${dialect}`);
    await step('mit Client-Zertifikat, Server und Hostname geprüft', async () => {
      const t0 = new Date(Date.now() - 1000);
      assert.equal(await count(input(dialect, tunnel)), 2500);
      await sleep(300);
      const log = haproxyLog(t0);
      assert.match(log, /cn=certuser/, log);
      assert.match(log, /verify=0/, log);
    });
    await step('Hostname statt IP: SNI kommt beim Proxy an', async () => {
      const t0 = new Date(Date.now() - 1000);
      assert.equal(await count(input(dialect, tunnel, { host: 'localhost' })), 2500);
      await sleep(300);
      assert.match(haproxyLog(t0), /sni=localhost/);
    });
    await step('ohne Client-Zertifikat: HAProxy lehnt ab', () => rejects(count(input(dialect, { ...tunnel, certFile: undefined, keyFile: undefined }))));
    await step('Zertifikat einer fremden CA: HAProxy lehnt ab', () =>
      rejects(count(input(dialect, { ...tunnel, certFile: cert('other-client.crt'), keyFile: cert('other-client.key') }))),
    );
    await step('Proxy-Zertifikat passt nicht zur CA: Client lehnt ab', () =>
      rejects(count(input(dialect, { ...tunnel, caFile: cert('other-ca.crt') })), /certificate|self.signed|verify/i),
    );
  }

  for (const dialect of ['mysql', 'postgres', 'mssql'] as const) {
    console.log(`\nHAProxy mit Leerlauf-Timeout 3 s → ${dialect}`);
    const saved = await store.save(input(dialect, tunnel, { port: targets[dialect].short }));

    await step('ohne Ping: nach dem Abbruch wird nur neu verbunden, NICHTS ausgeführt', async () => {
      const m = new Manager(store, undefined, 0);
      try {
        const { sessionId } = await m.openSession(saved.id, 'shop');
        await sleep(5000);
        const r = await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 1);
        assert.ok(r.reconnected, 'reconnected');
        assert.equal(r.statements.length, 0, 'es darf nichts ausgeführt worden sein');
        assert.ok(r.messages.some((x) => /NICHTS ausgeführt/.test(x)), 'Meldungen: ' + r.messages.join(' | '));
        const again = await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 1);
        assert.ok(!again.reconnected && !again.statements[0].error, again.statements[0]?.error);
      } finally {
        await m.shutdown();
      }
    });

    await step('offene Transaktion, Proxy trennt: das nächste UPDATE läuft NICHT mit Autocommit', async () => {
      const m = new Manager(store, undefined, 0);
      // eigene Tabelle – nicht von einem anderen Test abhängig
      const t = dialect === 'mysql' ? 'haproxy_probe' : dialect === 'mssql' ? 'dbo.haproxy_probe' : 'public.haproxy_probe';
      // Prüfung über eine direkte Verbindung ohne Proxy
      const direct = await store.save(input(dialect, {}, { port: directPort[dialect], options: dialect === 'mssql' ? { trustServerCertificate: true } : {} }));
      let ds: string | undefined;
      try {
        ds = (await m.openSession(direct.id, 'shop')).sessionId;
        await exec(m, ds, `DROP TABLE IF EXISTS ${t}`);
        await exec(m, ds, `CREATE TABLE ${t} (id int NOT NULL PRIMARY KEY, notiz varchar(50))`);
        await exec(m, ds, `INSERT INTO ${t} (id, notiz) VALUES (1, NULL), (2, NULL)`);
        const { sessionId } = await m.openSession(saved.id, 'shop');
        await exec(m, sessionId, dialect === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN');
        const u1 = await exec(m, sessionId, `UPDATE ${t} SET notiz = 'in Transaktion' WHERE id = 1`);
        assert.ok(u1.inTransaction, 'Transaktion offen erkannt');
        await sleep(5000);
        const r = await m.runQuery(sessionId, [{ sql: `UPDATE ${t} SET notiz = 'nach Abbruch' WHERE id = 2`, offset: 0 }], 1);
        assert.ok(r.reconnected && r.statements.length === 0, 'UPDATE darf nicht laufen');
        // nur Zeile 2: Zeile 1 sperrte bei SQL Server noch, falls der Server den Abbruch erst später bemerkt
        const check = await exec(m, ds, `SELECT notiz FROM ${t} WHERE id = 2`);
        assert.deepEqual(check.results[0].rows, [[null]], 'das UPDATE nach dem Abbruch darf nicht gelaufen sein');
      } finally {
        if (ds) await m.runQuery(ds, [{ sql: `DROP TABLE IF EXISTS ${t}`, offset: 0 }], 1).catch(() => undefined);
        await m.shutdown();
      }
    });

    await step('mit Ping: Sitzung und temporäre Tabelle bleiben erhalten', async () => {
      const m = new Manager(store, undefined, 1000);
      try {
        const { sessionId } = await m.openSession(saved.id, 'shop');
        const c = await m.runQuery(sessionId, [{ sql: tempTable[dialect][0], offset: 0 }], 1);
        assert.ok(!c.statements[0].error, c.statements[0].error);
        await sleep(6000);
        const r = await m.runQuery(sessionId, [{ sql: tempTable[dialect][1], offset: 0 }], 1);
        assert.ok(!r.statements[0].error, r.statements[0].error);
        assert.ok(!r.messages.some((x) => /neu aufgebaut/.test(x)), 'Meldungen: ' + r.messages.join(' | '));
      } finally {
        await m.shutdown();
      }
    });

    await step('Objektbaum und Tabellenansicht nach 5 s Leerlauf', async () => {
      const m = new Manager(store, undefined, 0);
      try {
        await m.listDatabases(saved.id);
        await sleep(5000);
        assert.ok((await m.listDatabases(saved.id)).includes('shop'));
        const schema = dialect === 'mysql' ? '' : dialect === 'mssql' ? 'dbo' : 'public';
        const n = await m.countTable({ object: { connectionId: saved.id, database: 'shop', schema, name: 'kunden', kind: 'table' }, limit: 10, offset: 0, sort: [] });
        assert.equal(n, 2500);
      } finally {
        await m.shutdown();
      }
    });
  }

  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
