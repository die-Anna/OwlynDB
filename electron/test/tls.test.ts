/* TLS/Client-Zertifikat gegen die Testserver mysql-tls und postgres-tls.
   Vorher: bash dev/make-certs.sh; docker compose -f dev/docker-compose.yml --profile tls up -d
   Aufruf: npm run test:tls */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, ConnectionOptions, SqlDialect } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { createDriver } from '../drivers';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const cert = (f: string) => path.join(root, 'dev/certs', f);
// Testlauf ohne Electron: "Verschlüsselung" ist hier nur eine Markierung
const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-')), 'c.json'), {
  encrypt: (s) => 'x' + s,
  decrypt: (s) => s.slice(1),
});

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

const SERVERS: Record<'mysql' | 'postgres', { port: number; database: string; probe: string }> = {
  mysql: { port: 15316, database: 'certdb', probe: 'SELECT text FROM geheim' },
  postgres: { port: 15442, database: 'postgres', probe: 'SELECT text FROM public.geheim' },
};

function input(dialect: SqlDialect, o: ConnectionOptions, extra: Partial<ConnectionInput> = {}): ConnectionInput {
  const s = SERVERS[dialect as 'mysql' | 'postgres'];
  return { name: 't', dialect, host: '127.0.0.1', port: s?.port ?? 15433, user: 'certuser', password: 'certpass', database: s?.database, options: o, ...extra };
}

const full: ConnectionOptions = {
  ssl: true,
  verifyServer: true,
  verifyHostname: true,
  caFile: cert('ca.crt'),
  certFile: cert('client.crt'),
  keyFile: cert('client.key'),
};

/** Verbindung aufbauen, Probeabfrage ausführen, Ergebnistext zurückgeben */
async function probe(i: ConnectionInput): Promise<string> {
  const d = createDriver(i.dialect, await store.driverConfig(i));
  try {
    const s = await d.openSession(i.database);
    try {
      const r = await s.run([{ sql: SERVERS[i.dialect as 'mysql' | 'postgres'].probe, offset: 0 }], 10);
      if (r.statements[0].error) throw new Error(r.statements[0].error);
      return String(r.results[0].rows[0][0]);
    } finally {
      await s.close();
    }
  } finally {
    await d.close();
  }
}

async function rejects(p: Promise<unknown>, pattern?: RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    // ein nicht gestarteter Container oder ein Prüffehler des Tests selbst ist kein „Server lehnt ab“
    assert.ok(!/ECONNREFUSED/.test(msg), `Verbindung verweigert statt abgelehnt: ${msg}`);
    assert.ok(!(e instanceof assert.AssertionError), `Prüffehler statt Ablehnung: ${msg}`);
    if (pattern) assert.match(msg, pattern);
    return;
  }
  assert.fail('hätte scheitern müssen');
}

/** TLS-Tunnel über einen Proxy, der das Client-Zertifikat prüft und dann zur normalen Test-DB weiterreicht */
async function tunnelTests() {
  const { pathToFileURL } = await import('node:url');
  const { startProxy } = (await import(pathToFileURL(path.join(root, 'dev/tls-proxy.mjs')).href)) as {
    startProxy: (listen: number, host: string, port: number, seen: string[]) => Promise<{ close(): void }>;
  };
  const targets = {
    mysql: { proxy: 15326, port: 15306, user: 'root', password: 'dbviewer-test', database: 'shop', sql: 'SELECT COUNT(*) FROM kunden' },
    postgres: { proxy: 15452, port: 15432, user: 'postgres', password: 'dbviewer-test', database: 'shop', sql: 'SELECT COUNT(*) FROM public.kunden' },
    mssql: { proxy: 15453, port: 15433, user: 'sa', password: 'Dbviewer-Test1', database: 'shop', sql: 'SELECT COUNT(*) FROM dbo.kunden' },
  } as const;
  const servers: { close(): void }[] = [];
  const seen: string[] = [];
  for (const t of Object.values(targets)) servers.push(await startProxy(t.proxy, '127.0.0.1', t.port, seen));

  const tunnel: ConnectionOptions = {
    tunnel: true,
    verifyServer: true,
    verifyHostname: true,
    caFile: cert('ca.crt'),
    certFile: cert('client.crt'),
    keyFile: cert('client.key'),
  };
  const count = async (dialect: SqlDialect, o: ConnectionOptions, extra: Partial<ConnectionInput> = {}): Promise<number> => {
    const t = targets[dialect];
    const i: ConnectionInput = { name: 't', dialect, host: '127.0.0.1', port: t.proxy, user: t.user, password: t.password, database: t.database, options: o, ...extra };
    const d = createDriver(dialect, await store.driverConfig(i));
    try {
      const s = await d.openSession(t.database);
      try {
        const r = await s.run([{ sql: t.sql, offset: 0 }], 1);
        if (r.statements[0].error) throw new Error(r.statements[0].error);
        // Metadaten laufen über den Pool, also eigene Tunnel-Verbindungen
        assert.ok((await d.listDatabases()).includes('shop'));
        return Number(r.results[0].rows[0][0]);
      } finally {
        await s.close();
      }
    } finally {
      await d.close();
    }
  };
  const inner: Record<SqlDialect, ConnectionOptions> = {
    mysql: { ssl: true },
    postgres: { ssl: true },
    mssql: { encrypt: true, trustServerCertificate: true },
  };

  try {
    for (const dialect of ['mysql', 'postgres', 'mssql'] as const) {
      console.log(`\nTunnel ${dialect}`);
      await step('mit Client-Zertifikat: Proxy sieht CN=certuser, Abfrage klappt', async () => {
        seen.length = 0;
        assert.equal(await count(dialect, tunnel), 2500);
        assert.ok(seen.length > 0 && seen.every((cn) => cn === 'certuser'), seen.join(','));
      });
      await step('mit PKCS#12 und Passwort: Proxy sieht CN=certuser, Abfrage klappt', async () => {
        seen.length = 0;
        assert.ok((await count(dialect, { ...tunnel, certFile: cert('client.p12'), keyFile: undefined }, { keyPassphrase: 'keypass' })) > 0);
        assert.ok(seen.length > 0 && seen.every((cn) => cn === 'certuser'), `Proxy sah: ${seen.join(', ')}`);
      });
      await step('ohne Client-Zertifikat: Proxy lehnt ab', () => rejects(count(dialect, { ...tunnel, certFile: undefined, keyFile: undefined }), /certificate|handshake|alert|X509|verlangt|abgelehnt|abgewiesen|ssl|tls|socket hang up|ECONNRESET|EPIPE|closed|Access denied|terminated/i));
      await step('Zertifikat einer fremden CA: Proxy lehnt ab', () =>
        rejects(count(dialect, { ...tunnel, certFile: cert('other-client.crt'), keyFile: cert('other-client.key') }), /certificate|handshake|alert|X509|verlangt|abgelehnt|abgewiesen|ssl|tls|socket hang up|ECONNRESET|EPIPE|closed|Access denied|terminated/i),
      );
      await step('Proxy-Zertifikat passt nicht zur CA: abgelehnt', () => rejects(count(dialect, { ...tunnel, caFile: cert('other-ca.crt') }), /certificate|self.signed|verify/i));
      if (dialect === 'postgres') {
        // die Test-DB hinter dem Proxy hat kein SSL: die Meldung des Servers muss durchkommen
        await step('inneres TLS ohne Server-SSL: klare Meldung', () => rejects(count(dialect, { ...tunnel, ...inner[dialect] }), /does not support SSL/));
      } else {
        await step('zusätzlich TLS im Datenbank-Protokoll (doppelt verschlüsselt)', async () => {
          assert.equal(await count(dialect, { ...tunnel, ...inner[dialect] }), 2500);
        });
      }
    }
  } finally {
    for (const s of servers) s.close();
  }
}

async function main() {
  // nur gegen die Test-Container: Zugangsdaten gehen an jeden Prozess auf diesen Ports
  // (die TLS-Proxys 15326/15452/15453 startet der Test selbst im eigenen Prozess und leitet auf 15306/15432/15433 weiter)
  assertTestContainers([15316, 15442, 15306, 15432, 15433].map((port) => ({ name: `Port ${port}`, host: '127.0.0.1', port })));
  for (const dialect of ['mysql', 'postgres'] as const) {
    console.log(`\n${dialect}`);
    await step('ohne Client-Zertifikat abgelehnt', () => rejects(probe(input(dialect, { ssl: true })), /certificate|handshake|alert|X509|verlangt|abgelehnt|abgewiesen|ssl|tls|socket hang up|ECONNRESET|EPIPE|closed|Access denied|terminated/i));
    await step('mit Client-Zertifikat, Server und Hostname geprüft', async () => {
      assert.equal(await probe(input(dialect, full)), 'nur mit Zertifikat');
    });
    await step('Hostname localhost statt IP', async () => {
      assert.equal(await probe(input(dialect, full, { host: 'localhost' })), 'nur mit Zertifikat');
    });
    await step('Client-Zertifikat einer fremden CA abgelehnt', () =>
      rejects(probe(input(dialect, { ...full, certFile: cert('other-client.crt'), keyFile: cert('other-client.key') })), /certificate|handshake|alert|X509|verlangt|abgelehnt|abgewiesen|ssl|tls|socket hang up|ECONNRESET|EPIPE|closed|Access denied|terminated/i),
    );
    await step('falsche CA: Serverzertifikat wird abgelehnt', () => rejects(probe(input(dialect, { ...full, caFile: cert('other-ca.crt') })), /certificate|self.signed|verify/i));
    await step('falsche CA, aber Prüfung aus: geht', async () => {
      assert.equal(await probe(input(dialect, { ...full, caFile: cert('other-ca.crt'), verifyServer: false })), 'nur mit Zertifikat');
    });
    await step('verschlüsselter Schlüssel ohne Passwort: klare Meldung', () =>
      rejects(probe(input(dialect, { ...full, keyFile: cert('client-enc.key') })), /Schlüssel-Passwort/),
    );
    await step('verschlüsselter Schlüssel mit Passwort', async () => {
      assert.equal(await probe(input(dialect, { ...full, keyFile: cert('client-enc.key') }, { keyPassphrase: 'keypass' })), 'nur mit Zertifikat');
    });
    // PKCS#12 (.p12/.pfx): Zertifikat und Schlüssel in einer Datei, das Schlüssel-Passwort ist das Passwort der Datei
    await step('PKCS#12 ohne Passwort: klare Meldung', () =>
      rejects(probe(input(dialect, { ...full, certFile: cert('client.p12'), keyFile: undefined })), /PKCS#12-Datei ist mit einem Passwort geschützt; bitte P12-Passwort/),
    );
    await step('PKCS#12 mit falschem Passwort: klare Meldung', () =>
      rejects(probe(input(dialect, { ...full, certFile: cert('client.p12'), keyFile: undefined }, { keyPassphrase: 'falsch' })), /Passwort der PKCS#12-Datei ist falsch/),
    );
    await step('PKCS#12 mit Passwort: verbunden', async () => {
      assert.equal(await probe(input(dialect, { ...full, certFile: cert('client.p12'), keyFile: undefined }, { keyPassphrase: 'keypass' })), 'nur mit Zertifikat');
    });
    await step('PKCS#12 mit EC-Schlüssel: verbunden (Umwandlung über Node, nicht forge)', async () => {
      assert.equal(await probe(input(dialect, { ...full, certFile: cert('client-ec.p12'), keyFile: undefined }, { keyPassphrase: 'keypass' })), 'nur mit Zertifikat');
    });
    await step('PKCS#12 und zusätzlich eine Schlüsseldatei: Meldung', () =>
      rejects(probe(input(dialect, { ...full, certFile: cert('client.p12') }, { keyPassphrase: 'keypass' })), /Feld „Schlüssel“ leer lassen/),
    );
    await step('fehlende Datei: Meldung mit Pfad', () => rejects(probe(input(dialect, { ...full, keyFile: cert('gibts-nicht.key') })), /Client-Schlüssel nicht lesbar: .*gibts-nicht/));
    await step('nur Zertifikat ohne Schlüssel: Meldung nennt den fehlenden Schlüssel', () =>
      rejects(probe(input(dialect, { ...full, keyFile: undefined })), /fehlt der private Schlüssel: .*client\.crt enthält nur das Zertifikat/),
    );
    await step('Schlüssel und Zertifikat vertauscht: Meldung nennt die Datei', () =>
      rejects(probe(input(dialect, { ...full, certFile: cert('client.key'), keyFile: cert('client.crt') })), /enthält kein Zertifikat.*client\.key/),
    );
  }

  await tunnelTests();

  console.log('\nGespeicherte Verbindung');
  await step('Schlüssel-Passwort wird gespeichert und beim Verbinden genutzt', async () => {
    const saved = await store.save(input('postgres', { ...full, keyFile: cert('client-enc.key') }, { keyPassphrase: 'keypass' }));
    assert.ok(saved.hasKeyPassphrase);
    // ohne Passwort in der Eingabe: das gespeicherte zählt
    const again = await store.save({ ...input('postgres', { ...full, keyFile: cert('client-enc.key') }), id: saved.id, password: undefined, keyPassphrase: undefined });
    assert.ok(again.hasKeyPassphrase && again.hasPassword);
    const d = createDriver('postgres', await store.driverConfig(saved.id));
    try {
      assert.match((await d.serverInfo()).version, /PostgreSQL/);
    } finally {
      await d.close();
    }
  });

  console.log('\nmssql');
  const sqlTest = { name: 't', dialect: 'mssql' as const, host: '127.0.0.1', port: 15433, user: 'sa', password: 'Dbviewer-Test1' };
  await step('eigene CA wird zum Prüfen genutzt (Server hat fremdes Zertifikat → Fehler)', () =>
    rejects(
      (async () => {
        const d = createDriver('mssql', await store.driverConfig({ ...sqlTest, options: { encrypt: true, trustServerCertificate: false, caFile: cert('ca.crt') } }));
        try {
          await d.serverInfo();
        } finally {
          await d.close();
        }
      })(),
      /certificate|self.signed|verify/i,
    ),
  );
  await step('verschlüsselt mit „Serverzertifikat vertrauen“', async () => {
    const d = createDriver('mssql', await store.driverConfig({ ...sqlTest, options: { encrypt: true, trustServerCertificate: true } }));
    try {
      assert.match((await d.serverInfo()).version, /SQL Server/);
    } finally {
      await d.close();
    }
  });

  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
