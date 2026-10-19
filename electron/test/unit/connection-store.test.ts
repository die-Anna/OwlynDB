/* Reine Logik ohne Datenbank (npm run test:unit): Verbindungsspeicher – Passwörter behalten/löschen/ersetzen, Import mit
   fester ID, beschädigte oder leere Dateien, nicht entschlüsselbare Passwörter, Zertifikats- und SSH-Meldungen,
   gleichzeitiges Speichern, Duplizieren */
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectionInput } from '../../../shared/api-types';
import { ConnectionStore, type SecretBox } from '../../connection-store';

const root = mkdtempSync(path.join(os.tmpdir(), 'dbv-store-unit-'));
let n = 0;
/** eigener Ordner je Test */
const dir = () => {
  const d = path.join(root, String(++n));
  return fs.mkdir(d, { recursive: true }).then(() => d);
};
/** „verschlüsselt“ umkehrbar, ohne den Klartext in der Datei */
const box: SecretBox = {
  encrypt: (s) => 'x' + Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (s) => {
    if (!s.startsWith('x')) throw new Error('kaputt');
    return Buffer.from(s.slice(1), 'base64').toString('utf8');
  },
};
/** wie DPAPI mit einem Profil von einem anderen PC */
const foreign: SecretBox = {
  encrypt: box.encrypt,
  decrypt: () => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
  },
};
const conn = (p: Partial<ConnectionInput> = {}): ConnectionInput => ({ name: 'Test', dialect: 'mysql', host: 'localhost', port: 3306, user: 'u', ...p });

test('Passwörter: neu verschlüsselt, undefined behält, leer löscht, Text ersetzt – für alle drei Geheimnisse', async () => {
  const file = path.join(await dir(), 'connections.json');
  const s = new ConnectionStore(file, box);
  const c = await s.save(conn({ password: 'geheim1', keyPassphrase: 'kp', sshSecret: 'ssh' }));
  assert.deepEqual([c.hasPassword, c.hasKeyPassphrase, c.hasSshSecret], [true, true, true]);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('geheim1') && !raw.includes('"password"'), 'kein Klartext in der Datei');
  assert.equal((await s.driverConfig(c.id)).password, 'geheim1');
  // behalten
  await s.save({ ...conn(), id: c.id, name: 'Umbenannt' });
  const kept = await s.get(c.id);
  assert.equal(kept.name, 'Umbenannt');
  assert.deepEqual([kept.hasPassword, kept.hasKeyPassphrase, kept.hasSshSecret], [true, true, true]);
  assert.deepEqual(await s.secretsOf(c.id), { password: 'geheim1', keyPassphrase: 'kp', sshSecret: 'ssh' });
  // ersetzen und löschen
  await s.save({ ...conn(), id: c.id, password: 'neu', keyPassphrase: '', sshSecret: '' });
  assert.deepEqual(await s.secretsOf(c.id), { password: 'neu' });
  assert.equal((await s.get(c.id)).hasKeyPassphrase, false);
  // Eingabe ohne Passwort bei bekannter ID: das gespeicherte zählt (Testen im Dialog); mit Passwort: das eingegebene
  assert.equal((await s.driverConfig({ ...conn(), id: c.id })).password, 'neu');
  assert.equal((await s.driverConfig({ ...conn(), id: c.id, password: 'anders' })).password, 'anders');
  assert.equal((await s.driverConfig(conn())).password, '');
});

test('IDs: neue Verbindung bekommt eine neue ID, mit keepId (Import) die mitgebrachte; entfernen', async () => {
  const s = new ConnectionStore(path.join(await dir(), 'connections.json'), box);
  const a = await s.save(conn({ id: 'fremd' }));
  assert.notEqual(a.id, 'fremd');
  const b = await s.save(conn({ id: 'mitgebracht' }), true);
  assert.equal(b.id, 'mitgebracht');
  assert.equal((await s.list()).length, 2);
  await s.remove(a.id);
  assert.deepEqual(
    (await s.list()).map((c) => c.id),
    ['mitgebracht'],
  );
  await assert.rejects(s.get(a.id), /nicht gefunden/);
  await assert.rejects(s.driverConfig(a.id), /nicht gefunden/);
});

test('beschädigte Datei: klare Meldung mit Pfad, Datei bleibt unangetastet; leere Datei gilt als leer', async () => {
  const d = await dir();
  const file = path.join(d, 'connections.json');
  await fs.writeFile(file, '[{"id": "a", "name": ');
  const s = new ConnectionStore(file, box);
  await assert.rejects(s.list(), (e: Error) => /beschädigt/.test(e.message) && e.message.includes(file));
  await assert.rejects(s.save(conn()), /beschädigt/);
  assert.equal(await fs.readFile(file, 'utf8'), '[{"id": "a", "name": ');
  await fs.writeFile(file, '{"kein": "Array"}');
  await assert.rejects(new ConnectionStore(file, box).list(), /beschädigt.*unerwarteter Inhalt/);
  // leer (Absturz beim Schreiben) ohne Sicherung: leer, Anlegen geht wieder
  await fs.writeFile(file, '');
  const e = new ConnectionStore(file, box);
  assert.deepEqual(await e.list(), []);
  await e.save(conn());
  assert.equal((await new ConnectionStore(file, box).list()).length, 1);
});

test('beschädigte Datei mit Sicherung: voriger Stand kommt zurück, die kaputte Datei wird aufgehoben', async () => {
  const d = await dir();
  const file = path.join(d, 'connections.json');
  const s = new ConnectionStore(file, box);
  const a = await s.save(conn({ name: 'A', password: 'pa' }));
  await s.save(conn({ name: 'B' }));
  // Stromausfall nach dem Speichern: die Datei ist leer bzw. halb
  for (const broken of ['', '[{"id": "x"']) {
    await fs.writeFile(file, broken);
    const fresh = new ConnectionStore(file, box);
    const [l1, l2] = await Promise.all([fresh.list(), fresh.list()]);
    assert.deepEqual(
      l1.map((c) => c.name),
      ['A'],
      'Stand vor dem letzten Speichern',
    );
    assert.deepEqual(l2, l1);
    assert.equal((await fresh.driverConfig(a.id)).password, 'pa');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).length, 1, 'wieder eine gültige Datei');
    await fresh.save(conn({ name: 'B' }));
  }
  const kept = readdirSync(d).filter((f) => f.startsWith('connections.json.defekt-'));
  assert.equal(kept.length, 1, 'nur die Datei mit Inhalt wird aufgehoben');
  assert.equal(await fs.readFile(path.join(d, kept[0]), 'utf8'), '[{"id": "x"');
  assert.ok(!readdirSync(d).some((f) => f.endsWith('.tmp')), 'keine Reste vom Schreiben');
});

test('nicht entschlüsselbares Passwort (Profil von einem anderen PC): klare Meldung statt der rohen von Electron', async () => {
  const file = path.join(await dir(), 'connections.json');
  const c = await new ConnectionStore(file, box).save(conn({ password: 'pw', sshSecret: 's' }));
  const s = new ConnectionStore(file, foreign);
  await assert.rejects(s.driverConfig(c.id), /Das gespeicherte Passwort lässt sich auf diesem PC nicht entschlüsseln.*neu eingeben/);
  await assert.rejects(s.secretsOf(c.id), /nicht entschlüsseln/);
  // neu eingegeben: kein Entschlüsseln nötig
  assert.equal((await s.driverConfig({ ...conn(), id: c.id, password: 'frisch' })).password, 'frisch');
  await s.save({ ...conn(), id: c.id, password: 'frisch', sshSecret: '' });
  assert.equal((await s.get(c.id)).hasSshSecret, false);
});

test('gleichzeitiges Speichern geht nicht verloren', async () => {
  const file = path.join(await dir(), 'connections.json');
  const s = new ConnectionStore(file, box);
  await Promise.all(Array.from({ length: 8 }, (_, i) => s.save(conn({ name: `C${i}` }))));
  assert.equal((await s.list()).length, 8);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).length, 8);
  const ids = (await s.list()).map((c) => c.id);
  await Promise.all([s.remove(ids[0]), s.save(conn({ name: 'neu' })), s.remove(ids[1])]);
  assert.equal((await new ConnectionStore(file, box).list()).length, 7);
});

test('von Hand mit BOM gespeichert (PowerShell 5, ältere Editoren): Verbindungen und Hostschlüssel lesbar (F288)', async () => {
  const d = await dir();
  const file = path.join(d, 'connections.json');
  await new ConnectionStore(file, box).save(conn({ name: 'mit BOM' }));
  await fs.writeFile(file, '\uFEFF' + (await fs.readFile(file, 'utf8')));
  const s = new ConnectionStore(file, box);
  assert.deepEqual((await s.list()).map((c) => c.name), ['mit BOM']);
  await s.save(conn({ name: 'dazu' }));
  assert.equal((await new ConnectionStore(file, box).list()).length, 2);
  await fs.writeFile(path.join(d, 'ssh-host-keys.json'), '\uFEFF{"h:22": "SHA256:x"}');
  assert.equal(await new ConnectionStore(file, box).hostKey('h:22'), 'SHA256:x');
});

test('SSH-Hostschlüssel: speichern und lesen, gleichzeitig, beschädigte Datei mit Meldung, leere gilt als leer', async () => {
  const d = await dir();
  const s = new ConnectionStore(path.join(d, 'connections.json'), box);
  assert.equal(await s.hostKey('h:22'), undefined);
  await Promise.all([s.setHostKey('a:22', 'SHA256:a'), s.setHostKey('b:22', 'SHA256:b')]);
  assert.equal(await s.hostKey('a:22'), 'SHA256:a');
  assert.equal(await s.hostKey('b:22'), 'SHA256:b');
  await fs.writeFile(path.join(d, 'ssh-host-keys.json'), '{"a:22": ');
  await assert.rejects(s.hostKey('a:22'), /Hostschlüssel sind beschädigt/);
  await assert.rejects(s.setHostKey('c:22', 'x'), /beschädigt/);
  await fs.writeFile(path.join(d, 'ssh-host-keys.json'), '');
  assert.equal(await s.hostKey('a:22'), undefined);
});

test('Zertifikate und SSH: Meldungen nennen, was in welcher Datei fehlt', async () => {
  const d = await dir();
  const s = new ConnectionStore(path.join(d, 'connections.json'), box);
  const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const key = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';
  const files: Record<string, string> = { 'c.pem': cert, 'k.pem': key, 'both.pem': key + cert, 'p12.bin': 'binär', 'enc.pem': '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n' };
  for (const [f, t] of Object.entries(files)) await fs.writeFile(path.join(d, f), t);
  const p = (f: string) => path.join(d, f);
  const tls = (o: ConnectionInput['options'], extra: Partial<ConnectionInput> = {}) => s.driverConfig(conn({ options: { ssl: true, ...o }, ...extra }));
  await assert.rejects(tls({ certFile: p('fehlt.pem') }), /Client-Zertifikat nicht lesbar: .*fehlt\.pem \(ENOENT\)/);
  await assert.rejects(tls({ caFile: p('p12.bin') }), /CA-Zertifikat ist keine PEM-Datei[\s\S]*openssl pkcs12/);
  await assert.rejects(tls({ certFile: p('c.pem') }), /fehlt der private Schlüssel/);
  await assert.rejects(tls({ keyFile: p('k.pem') }), /nur ein Client-Schlüssel/);
  await assert.rejects(tls({ certFile: p('k.pem'), keyFile: p('k.pem') }), /enthält kein Zertifikat/);
  await assert.rejects(tls({ certFile: p('c.pem'), keyFile: p('enc.pem') }), /mit einem Passwort geschützt/);
  const both = (await tls({ certFile: p('both.pem') })).tls;
  assert.equal(both?.key, both?.cert, 'Schlüssel aus derselben Datei');
  assert.equal((await tls({ certFile: p('c.pem'), keyFile: p('enc.pem') }, { keyPassphrase: 'pw' })).tls?.passphrase, 'pw');
  // SQL Server prüft Client-Zertifikate nicht selbst – nur mit Tunnel
  assert.equal((await s.driverConfig(conn({ dialect: 'mssql', options: { encrypt: true, certFile: p('c.pem') } }))).tls?.cert, undefined);
  // ohne TLS wird nichts gelesen
  assert.equal((await s.driverConfig(conn({ options: { certFile: p('fehlt.pem') } }))).tls, undefined);
  const ssh = (o: ConnectionInput['options']) => s.driverConfig(conn({ options: { ssh: true, sshHost: 'jump', sshUser: 'me', ...o } }));
  await assert.rejects(ssh({ sshHost: ' ' }), /fehlt der SSH-Server/);
  await assert.rejects(ssh({ sshUser: '' }), /fehlt der SSH-Benutzer/);
  await assert.rejects(ssh({ sshKeyFile: p('fehlt') }), /SSH-Schlüssel nicht lesbar/);
  await fs.writeFile(p('k.ppk'), 'PuTTY-User-Key-File-3: ssh-ed25519\n');
  await assert.rejects(ssh({ sshKeyFile: p('k.ppk') }), /PuTTY-Schlüssel \(\.ppk\) Version 3/);
  const ok = (await ssh({ sshKeyFile: p('k.pem'), sshPort: 2222, tunnel: true })).ssh;
  assert.deepEqual([ok?.host, ok?.port, ok?.username, ok?.defaultKey, ok?.tls], ['jump', 2222, 'me', false, true]);
});

test('Netzwerk- und Gerätepfade werden nicht gelesen – Windows meldete sich sonst am fremden Server an (F039)', async () => {
  const s = new ConnectionStore(path.join(await dir(), 'connections.json'), box);
  for (const file of ['\\\\angreifer.example\\x\\ca.pem', '//10.0.0.99/share/ca.pem', '\\\\?\\C:\\ca.pem', '\\\\.\\pipe\\x']) {
    await assert.rejects(s.driverConfig(conn({ options: { ssl: true, caFile: file } })), /CA-Zertifikat: Netzwerkpfade werden nicht gelesen/, file);
    await assert.rejects(s.driverConfig(conn({ options: { ssh: true, sshHost: 'jump', sshUser: 'me', sshKeyFile: file } })), /SSH-Schlüssel: Netzwerkpfade/, file);
  }
});

test('Server, Benutzer und Datenbank ohne Leerzeichen am Rand (F227)', async () => {
  const file = path.join(await dir(), 'connections.json');
  const s = new ConnectionStore(file, box);
  const c = await s.save(conn({ host: ' db.example.com \n', user: 'root ', database: ' shop ' }));
  assert.deepEqual([c.host, c.user, c.database], ['db.example.com', 'root', 'shop']);
  await assert.rejects(s.save(conn({ host: '   ' })), /Bitte einen Server angeben/);
  // schon so gespeichert (ältere Version): beim Verbinden getrimmt
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw[0].host = 'alt.example.com ';
  raw[0].user = ' admin';
  await fs.writeFile(file, JSON.stringify(raw));
  const cfg = await new ConnectionStore(file, box).driverConfig(c.id);
  assert.deepEqual([cfg.host, cfg.user, cfg.database], ['alt.example.com', 'admin', 'shop']);
});

test('Kürzel für die Tabs: ohne Rand, höchstens 8 Zeichen, leer = keins; bleibt beim Duplizieren', async () => {
  const file = path.join(await dir(), 'connections.json');
  const s = new ConnectionStore(file, box);
  const c = await s.save(conn({ short: '  GP  ' }));
  assert.equal(c.short, 'GP');
  assert.equal((await s.save(conn({ id: c.id, short: 'ZuLangesKuerzel' }))).short, 'ZuLanges');
  assert.equal((await s.duplicate(c.id)).short, 'ZuLanges');
  const cleared = await s.save(conn({ id: c.id, short: '   ' }));
  assert.equal(cleared.short, undefined);
  assert.ok(!('short' in JSON.parse(await fs.readFile(file, 'utf8'))[0]), 'leeres Kürzel nicht gespeichert');
});

test('Duplizieren: alle Einstellungen und die verschlüsselten Geheimnisse übernommen, neue ID, Name mit (Kopie), Reihenfolge hinter dem Original, zweite Kopie (Kopie 2); unbekannte ID: Fehler', async () => {
  const file = path.join(await dir(), 'connections.json');
  const s = new ConnectionStore(file, box);
  const a = await s.save(
    conn({
      name: 'prod',
      dialect: 'postgres',
      host: 'db.example.com',
      port: 5433,
      user: 'admin',
      database: 'shop',
      color: '#e53935',
      password: 'geheim1',
      keyPassphrase: 'kp',
      sshSecret: 'ssh',
      options: { ssl: true, readOnly: true, caFile: 'C:\ca.pem', ssh: true, sshHost: 'jump', sshUser: 'me' },
    }),
  );
  const b = await s.save(conn({ name: 'andere' }));

  const c1 = await s.duplicate(a.id);
  assert.notEqual(c1.id, a.id);
  assert.equal(c1.name, 'prod (Kopie)');
  // alles außer ID und Name wie das Original, die Geheimnisse als vorhanden gekennzeichnet
  const { id: _i1, name: _n1, ...rest1 } = c1;
  const { id: _i0, name: _n0, ...rest0 } = a;
  assert.deepEqual(rest1, rest0);
  assert.deepEqual([c1.hasPassword, c1.hasKeyPassphrase, c1.hasSshSecret], [true, true, true]);
  assert.deepEqual(await s.secretsOf(c1.id), { password: 'geheim1', keyPassphrase: 'kp', sshSecret: 'ssh' });
  // in der Datei dieselben verschlüsselten Werte, kein Klartext
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
  const [o, k] = [raw.find((x) => x.id === a.id)!, raw.find((x) => x.id === c1.id)!];
  for (const f of ['passwordEnc', 'keyPassphraseEnc', 'sshSecretEnc']) {
    assert.ok(typeof o[f] === 'string' && o[f] === k[f], f);
  }
  assert.ok(!JSON.stringify(raw).includes('geheim1'));

  // direkt hinter dem Original, vor der nächsten Verbindung
  assert.deepEqual(
    (await s.list()).map((c) => c.name),
    ['prod', 'prod (Kopie)', 'andere'],
  );
  // zweite Kopie: (Kopie 2); eine Kopie der Kopie zählt weiter statt „(Kopie) (Kopie)“
  const c2 = await s.duplicate(a.id);
  assert.equal(c2.name, 'prod (Kopie 2)');
  const c3 = await s.duplicate(c1.id);
  assert.equal(c3.name, 'prod (Kopie 3)');
  assert.deepEqual(
    (await s.list()).map((c) => c.name),
    ['prod', 'prod (Kopie 2)', 'prod (Kopie)', 'prod (Kopie 3)', 'andere'],
  );
  assert.equal(new Set((await s.list()).map((c) => c.id)).size, 5);

  // Kopie und Original sind unabhängig: Passwort der Kopie ändern, Original behält seins; Optionen nicht geteilt
  await s.save({ ...conn({ name: 'prod (Kopie)', dialect: 'postgres', options: { ssl: false } }), id: c1.id, password: 'anders' });
  assert.equal((await s.secretsOf(c1.id)).password, 'anders');
  assert.equal((await s.secretsOf(a.id)).password, 'geheim1');
  assert.equal((await s.get(a.id)).options?.ssl, true);

  // echte Tiefenkopie: Optionen einer frischen Kopie ändern, das Original bleibt unberührt
  const deep = await s.duplicate(a.id);
  (await s.get(deep.id)).options!.readOnly = false;
  assert.equal((await s.get(a.id)).options?.readOnly, true);
  await s.remove(deep.id);

  // gleichzeitig: jeder Aufruf bekommt einen eigenen Namen
  const [p, q] = await Promise.all([s.duplicate(b.id), s.duplicate(b.id)]);
  assert.deepEqual([p.name, q.name].sort(), ['andere (Kopie 2)', 'andere (Kopie)']);

  // auf der Platte gespeichert
  assert.equal((await new ConnectionStore(file, box).list()).length, 7);

  // unbekannte ID: Fehler, nichts geändert; der Speicher bleibt danach benutzbar
  await assert.rejects(s.duplicate('gibt-es-nicht'), /nicht gefunden/);
  assert.equal((await s.list()).length, 7);
  assert.equal((await s.duplicate(b.id)).name, 'andere (Kopie 3)');
});
