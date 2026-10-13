/* SSH-Tunnel gegen einen echten sshd, direkt und im TLS-Tunnel durch HAProxy (SNI + Client-Zertifikat).
   Vorher: bash dev/make-certs.sh; npm run testdb:up; docker compose -f dev/docker-compose.yml --profile tls up -d --build ssh haproxy
   Aufruf: npm run test:ssh */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, ConnectionOptions, SqlDialect } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { SshForward } from '../drivers/ssh';
import { utils as sshUtils } from 'ssh2';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const cert = (f: string) => path.join(root, 'dev/certs', f);
const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-ssh-')), 'c.json'), {
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

/** Datenbanken aus Sicht des SSH-Servers (Docker-Netz) */
const targets = {
  mysql: { host: 'mysql', port: 3306, user: 'root', password: 'dbviewer-test', sql: 'SELECT COUNT(*) FROM kunden' },
  postgres: { host: 'postgres', port: 5432, user: 'postgres', password: 'dbviewer-test', sql: 'SELECT COUNT(*) FROM public.kunden' },
  mssql: { host: 'mssql', port: 1433, user: 'sa', password: 'Dbviewer-Test1', sql: 'SELECT COUNT(*) FROM dbo.kunden' },
} as const;

const tempTable: Record<SqlDialect, [string, string]> = {
  mysql: ['CREATE TEMPORARY TABLE merk (x int)', 'SELECT COUNT(*) FROM merk'],
  postgres: ['CREATE TEMP TABLE merk (x int)', 'SELECT COUNT(*) FROM merk'],
  mssql: ['CREATE TABLE #merk (x int)', 'SELECT COUNT(*) FROM #merk'],
};

/** wie der Alias: ssh -o ProxyCommand="openssl s_client -connect … -servername … -cert <pem>" */
const viaProxy: ConnectionOptions = {
  ssh: true,
  sshHost: '127.0.0.1',
  sshPort: 15422,
  sshUser: 'tunnel',
  sshKeyFile: cert('ssh_client'),
  tunnel: true,
  servername: 'ssh-test',
  verifyServer: true,
  caFile: cert('ca.crt'),
  // Zertifikat und Schlüssel in einer Datei, kein keyFile
  certFile: cert('client-combined.pem'),
};

const direct: ConnectionOptions = { ssh: true, sshHost: '127.0.0.1', sshPort: 15022, sshUser: 'tunnel', sshKeyFile: cert('ssh_client') };

function input(dialect: SqlDialect, o: ConnectionOptions, extra: Partial<ConnectionInput> = {}): ConnectionInput {
  const t = targets[dialect];
  const options = dialect === 'mssql' ? { trustServerCertificate: true, ...o } : o;
  return { name: 'ssh', dialect, host: t.host, port: t.port, user: t.user, password: t.password, database: 'shop', options, ...extra };
}

/** Bestätigungen des Hostschlüssels zählen; answer bestimmt die Antwort */
const prompts: { hostId: string; previous?: string }[] = [];
let answer = true;
const host = {
  pickFile: async () => null,
  saveFile: async () => null,
  showInFolder: () => undefined,
  confirmHostKey: async (hostId: string, _t: string, _fp: string, previous?: string) => {
    prompts.push({ hostId, previous });
    return answer;
  },
};

async function count(m: Manager, connectionId: string): Promise<number> {
  const dialect = (await store.get(connectionId)).dialect as SqlDialect;
  assert.ok((await m.listDatabases(connectionId)).includes('shop'));
  const { sessionId } = await m.openSession(connectionId, 'shop');
  try {
    const r = await m.runQuery(sessionId, [{ sql: targets[dialect].sql, offset: 0 }], 1);
    if (r.statements[0].error) throw new Error(r.statements[0].error);
    return Number(r.results[0].rows[0][0]);
  } finally {
    await m.closeSession(sessionId);
  }
}

async function withManager<T>(fn: (m: Manager) => Promise<T>, keepAliveMs = 0): Promise<T> {
  const m = new Manager(store, host, keepAliveMs);
  try {
    return await fn(m);
  } finally {
    await m.shutdown();
  }
}

/** SSH-Verbindungen des Benutzers tunnel auf dem Server kappen (wie ein Abbruch durch den Proxy) */
function killSshSessions() {
  execFileSync('docker', ['exec', 'dbviewer-test-ssh-1', 'pkill', '-f', 'sshd-session: tunnel'], { stdio: 'ignore' });
}

async function main() {
  // eigenes, leeres Profil: die echten Schlüssel in ~/.ssh bleiben aus dem Spiel
  process.env.USERPROFILE = process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'dbv-home-'));
  assertTestContainers([
    { name: 'ssh', host: '127.0.0.1', port: 15022 },
    { name: 'haproxy ssh', host: '127.0.0.1', port: 15422 },
    { name: 'haproxy ssh kurz', host: '127.0.0.1', port: 15423 },
  ]);

  console.log('\nHostschlüssel');
  await step('erster Kontakt: Rückfrage, danach gespeichert und keine Rückfrage mehr', async () => {
    const c = await store.save(input('mysql', direct));
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].hostId, '127.0.0.1:15022');
    assert.equal(prompts[0].previous, undefined);
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
    assert.equal(prompts.length, 1, 'zweite Verbindung ohne Rückfrage');
  });
  await step('abgelehnt: keine Verbindung', async () => {
    answer = false;
    try {
      const c = await store.save(input('mysql', { ...viaProxy, sshPort: 15423 }));
      await withManager((m) => rejects(m.connect(c.id), /nicht bestätigt/));
      assert.equal(await store.hostKey('ssh-test@127.0.0.1:15423'), undefined);
    } finally {
      answer = true;
    }
  });
  await step('geänderter Schlüssel: Warnung mit bisherigem Wert, abgelehnt = Abbruch', async () => {
    const id = '127.0.0.1:15022';
    const real = await store.hostKey(id);
    await store.setHostKey(id, 'SHA256:falsch');
    answer = false;
    try {
      const c = await store.save(input('mysql', direct));
      await withManager((m) => rejects(m.connect(c.id), /nicht bestätigt/));
      assert.equal(prompts.at(-1)?.previous, 'SHA256:falsch');
    } finally {
      answer = true;
      await store.setHostKey(id, real!);
    }
  });

  for (const dialect of ['mssql', 'mysql', 'postgres'] as const) {
    console.log(`\nTLS (HAProxy, SNI, Client-Zertifikat) → SSH → ${dialect}`);
    await step('Abfrage über den Tunnel', async () => {
      const c = await store.save(input(dialect, viaProxy));
      await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
    });
    await step('Verbindung testen (Dialog) räumt den Tunnel wieder ab', async () => {
      const m = new Manager(store, host, 0);
      // den Tunnel des Tests abfangen: SshForward.open liefert ihn, danach muss sein lokaler Port zu sein
      const orig = SshForward.open;
      let opened: SshForward | undefined;
      SshForward.open = async (...a: Parameters<typeof SshForward.open>) => (opened = await orig(...a));
      let info;
      try {
        info = await m.testConnection(input(dialect, viaProxy));
      } finally {
        SshForward.open = orig;
      }
      assert.ok(info.version);
      assert.ok(opened, 'kein Tunnel geöffnet?');
      assert.equal(opened.closed, true, 'Tunnel nicht geschlossen');
      await rejects(
        new Promise<void>((resolve, reject) => {
          const s = net.connect(opened!.port, '127.0.0.1', () => {
            s.destroy();
            resolve();
          });
          s.once('error', reject);
        }),
      );
      await m.shutdown();
    });
  }

  console.log('\nAnmeldung und Proxy-Prüfung');
  await step('Schlüssel mit Passwort', async () => {
    const c = await store.save(input('postgres', { ...viaProxy, sshKeyFile: cert('ssh_client_enc') }, { sshSecret: 'sshpass' }));
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
  });
  await step('Schlüssel mit Passwort, Passwort fehlt: verständliche Meldung', async () => {
    const c = await store.save(input('postgres', { ...viaProxy, sshKeyFile: cert('ssh_client_enc') }, { sshSecret: '' }));
    await withManager((m) => rejects(m.connect(c.id), /mit einem Passwort geschützt/));
  });
  // Standardschlüssel aus ~/.ssh: der Test benutzt einen eigenen Ordner (DBV_SSH_DIR), nicht die Schlüssel des Benutzers
  const sshDir = mkdtempSync(path.join(os.tmpdir(), 'dbv-sshdir-'));
  process.env.DBV_SSH_DIR = sshDir;
  await step('nur Passwort (ohne Schlüssel in ~/.ssh)', async () => {
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: '' }, { sshSecret: 'tunnel-test' }));
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
  });
  await step('kein Schlüssel, kein Passwort: verständliche Meldung', async () => {
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: '' }, { sshSecret: '' }));
    await withManager((m) => rejects(m.connect(c.id), /Schlüssel.*oder ein SSH-Passwort/));
  });
  await step('Standardschlüssel in ~/.ssh, den der Server nicht kennt: das SSH-Passwort greift trotzdem (wie bei ssh)', async () => {
    // Regression vom 08.10.2026: mit einem id_ed25519 in ~/.ssh ging das Passwort nicht mehr mit, jede Passwort-Verbindung scheiterte
    writeFileSync(path.join(sshDir, 'id_ed25519'), sshUtils.generateKeyPairSync('ed25519').private);
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: '' }, { sshSecret: 'tunnel-test' }));
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
  });
  await step('Standardschlüssel in ~/.ssh, den der Server nicht kennt, ohne Passwort: abgelehnt', async () => {
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: '' }, { sshSecret: '' }));
    await withManager((m) => rejects(m.connect(c.id), /abgelehnt/));
  });
  await step('Standardschlüssel in ~/.ssh, den der Server kennt: ohne Passwort verbunden', async () => {
    copyFileSync(cert('ssh_client'), path.join(sshDir, 'id_ed25519'));
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: '' }, { sshSecret: '' }));
    await withManager(async (m) => assert.equal(await count(m, c.id), 2500));
    rmSync(path.join(sshDir, 'id_ed25519'));
  });
  await step('falsches Passwort: Anmeldung abgelehnt', async () => {
    const c = await store.save(input('mysql', { ...direct, sshKeyFile: cert('ssh_client_enc') }, { sshSecret: 'falsch' }));
    await withManager((m) => rejects(m.connect(c.id), /Passwort des SSH-Schlüssels ist falsch/));
  });
  await step('falscher SNI-Name: HAProxy lehnt ab', async () => {
    const c = await store.save(input('mysql', { ...viaProxy, servername: 'anderes-ziel' }));
    await withManager((m) => rejects(m.connect(c.id), /vor dem SSH-Handshake getrennt/));
  });
  await step('ohne Client-Zertifikat: HAProxy lehnt ab', async () => {
    const c = await store.save(input('mysql', { ...viaProxy, certFile: undefined }));
    await withManager((m) => rejects(m.connect(c.id), /verlangt ein Client-Zertifikat/));
  });
  await step('Ziel aus Sicht des SSH-Servers falsch: Meldung nennt das Ziel', async () => {
    const c = await store.save(input('mysql', viaProxy, { host: 'gibtsnicht' }));
    await withManager((m) => rejects(m.connect(c.id), /erreicht das Ziel gibtsnicht:3306 nicht/));
  });

  console.log('\nAbbrüche');
  for (const dialect of ['mssql', 'mysql', 'postgres'] as const) {
    await step(`${dialect}: SSH gekappt → beim nächsten Ausführen nur neu verbinden, danach läuft es`, async () => {
      const c = await store.save(input(dialect, viaProxy));
      await withManager(async (m) => {
        const { sessionId } = await m.openSession(c.id, 'shop');
        await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 1);
        killSshSessions();
        await sleep(1500);
        const r = await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 1);
        assert.ok(r.reconnected, 'reconnected');
        assert.equal(r.statements.length, 0, 'es darf nichts ausgeführt worden sein');
        const again = await m.runQuery(sessionId, [{ sql: 'SELECT 1', offset: 0 }], 1);
        assert.ok(!again.reconnected && !again.statements[0].error, again.statements[0]?.error);
        // Metadaten-Verbindung kommt ebenfalls wieder
        assert.ok((await m.listDatabases(c.id)).includes('shop'));
      });
    });
  }

  await step('Trennen schließt den lokalen Port', async () => {
    const c = await store.save(input('mysql', direct));
    const m = new Manager(store, host, 0);
    await m.connect(c.id);
    const fwd = (m as unknown as { forwards: Map<string, { fwd: { port: number } }[]> }).forwards.get(c.id)!;
    const port = fwd[0].fwd.port;
    await m.disconnect(c.id);
    await rejects(
      new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.destroy();
          resolve();
        });
        s.once('error', reject);
      }),
    );
    await m.shutdown();
  });

  console.log('\nHAProxy mit 20 s Leerlauf-Timeout, ohne OwlynDB-Ping (nur SSH-Keepalive alle 15 s)');
  for (const dialect of ['mssql', 'postgres'] as const) {
    await step(`${dialect}: Sitzung und temporäre Tabelle überstehen 45 s Leerlauf`, async () => {
      const c = await store.save(input(dialect, { ...viaProxy, sshPort: 15423 }));
      await withManager(async (m) => {
        const { sessionId } = await m.openSession(c.id, 'shop');
        const t = await m.runQuery(sessionId, [{ sql: tempTable[dialect][0], offset: 0 }], 1);
        assert.ok(!t.statements[0].error, t.statements[0].error);
        await sleep(45_000);
        const r = await m.runQuery(sessionId, [{ sql: tempTable[dialect][1], offset: 0 }], 1);
        assert.ok(!r.reconnected, 'Verbindung wurde neu aufgebaut: ' + r.messages.join(' | '));
        assert.ok(!r.statements[0].error, r.statements[0].error);
      });
    });
  }

  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
