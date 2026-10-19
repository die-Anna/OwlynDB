/* Einstellungen exportieren/importieren: zwei Profile mit verschiedener „DPAPI“ wie zwei PCs. Passwörter nur mit
   Export-Passwort (nicht im Klartext in der Datei), Vorschau mit Abgleich (ID, Name, Server) und Unterschieden,
   Ersetzen nur auf Wunsch, Namenskonflikte, fehlende Zertifikatsdateien, Verlauf und gespeicherte Abfragen ohne
   Doppel, kaputte oder fremde Dateien. Keine Datenbank nötig. Aufruf: npm run test:settings */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, SettingsImportRequest, SettingsPreview } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { QueryHistory, SavedQueries } from '../history';
import { Manager } from '../manager';
import { seal } from '../settings-transfer';

const root = mkdtempSync(path.join(os.tmpdir(), 'dbv-settings-'));
let failed = 0;
async function step(name: string, fn: () => Promise<unknown> | unknown) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

/** ein Profil: eigener Ordner, eigene „DPAPI“ (Präfix), eigener Manager; Speichern-Dialog schreibt nach saveAs */
function profile(name: string) {
  const dir = path.join(root, name);
  const store = new ConnectionStore(path.join(dir, 'connections.json'), {
    encrypt: (s) => `${name}:` + Buffer.from(s).toString('base64'),
    decrypt: (s) => {
      if (!s.startsWith(`${name}:`)) throw new Error('auf diesem PC nicht entschlüsselbar');
      return Buffer.from(s.slice(name.length + 1), 'base64').toString();
    },
  });
  const p = { dir, store, saveAs: path.join(root, `${name}-export.json`), m: undefined as unknown as Manager };
  p.m = new Manager(store, { pickFile: async () => null, saveFile: async () => p.saveAs, showInFolder: () => undefined }, 0);
  return p;
}

const certFile = path.join(root, 'client.pem');
writeFileSync(certFile, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
const missingCa = path.join(root, 'gibt-es-nicht', 'ca.pem');

const PROD: ConnectionInput = { name: 'Prod MySQL', dialect: 'mysql', host: 'prod.example', port: 3306, user: 'app', password: 'pw-prod-123', color: '#e5484d', short: 'PRD', options: { readOnly: true } };
const DM: ConnectionInput = {
  name: 'DM SQL Server',
  dialect: 'mssql',
  host: 'localhost',
  port: 1433,
  user: 'sa',
  password: 'pw-dm-456',
  keyPassphrase: 'schluessel-789',
  sshSecret: 'ssh-geheim-0',
  options: { tunnel: true, ssh: true, sshHost: 'proxy.example', sshPort: 443, sshUser: 'anna', certFile, servername: 'dm.example' },
};
const LOCAL: ConnectionInput = { name: 'Lokal Postgres', dialect: 'postgres', host: 'localhost', port: 5432, user: 'postgres', options: { ssl: true, caFile: missingCa } };

const all = (p: SettingsPreview, action: 'new' | 'replace' | 'skip'): SettingsImportRequest['connections'] => p.connections.map((c) => ({ index: c.index, action }));

async function main() {
  console.log('\nExport');
  const a = profile('A');
  const prod = await a.store.save(PROD);
  const dm = await a.store.save(DM);
  const local = await a.store.save(LOCAL);
  // Verlauf und gespeicherte Abfragen liegen neben den Verbindungen; vor dem ersten Zugriff des Managers schreiben
  await new QueryHistory(path.join(a.dir, 'history.jsonl')).add([
    { at: '2026-10-07T08:00:00.000Z', connectionId: prod.id, connection: prod.name, sql: 'SELECT 1', durationMs: 3, ok: true },
    { at: '2026-10-07T09:00:00.000Z', connectionId: dm.id, connection: dm.name, sql: "SELECT * FROM kunde WHERE email = 'x@y.ch'", durationMs: 9, ok: true },
    { at: '2026-10-07T10:00:00.000Z', connectionId: local.id, connection: local.name, sql: 'SELECT now()', durationMs: 1, ok: true },
  ]);
  const savedA = new SavedQueries(path.join(a.dir, 'saved-queries.json'));
  await savedA.save({ name: 'Kunden zählen', sql: 'SELECT COUNT(*) FROM kunde' });
  await savedA.save({ name: 'Offene Rechnungen', sql: 'SELECT * FROM rechnung WHERE bezahlt = 0' });
  const ids = [prod.id, dm.id, local.id];

  await step('mit Export-Passwort: Passwörter verschlüsselt, nichts im Klartext; zu kurzes Passwort abgelehnt', async () => {
    await assert.rejects(a.m.exportSettings({ connectionIds: ids, savedQueries: true, history: true, password: 'kurz' }), /mindestens 8 Zeichen/);
    assert.equal(await a.m.exportSettings({ connectionIds: ids, savedQueries: true, history: true, password: 'geheim123' }), a.saveAs);
    const text = readFileSync(a.saveAs, 'utf8');
    for (const s of ['pw-prod-123', 'pw-dm-456', 'schluessel-789', 'ssh-geheim-0']) assert.ok(!text.includes(s), `${s} im Klartext`);
    const json = JSON.parse(text);
    assert.equal(json.format, 'owlyndb-settings');
    assert.equal(json.connections.length, 3);
    assert.equal(json.savedQueries.length, 2);
    assert.equal(json.history.length, 3);
    assert.equal(json.secrets.kdf, 'scrypt');
    assert.equal(json.connections[1].options.certFile, certFile);
    assert.ok(!('hasPassword' in json.connections[0]));
  });

  console.log('\nImport auf einem anderen PC');
  const b = profile('B');
  let pre: SettingsPreview;
  await step('Vorschau ohne Passwort: alles neu, Passwörter noch zu, fehlende Datei erkannt', async () => {
    pre = await b.m.previewSettings(a.saveAs);
    assert.equal(pre.hasSecrets, true);
    assert.equal(pre.secretsOpen, false);
    assert.deepEqual(pre.connections.map((c) => c.match), [undefined, undefined, undefined]);
    assert.deepEqual(pre.connections.map((c) => c.missingFiles), [[], [], [missingCa]]);
    assert.deepEqual(pre.savedQueries, { total: 2, fresh: 2 });
    assert.deepEqual(pre.history, { total: 3, fresh: 3 });
  });

  await step('falsches Export-Passwort: klare Meldung; richtiges öffnet die Passwörter', async () => {
    await assert.rejects(b.m.previewSettings(a.saveAs, 'falsch1234'), /passt nicht/);
    pre = await b.m.previewSettings(a.saveAs, 'geheim123');
    assert.equal(pre.secretsOpen, true);
    assert.deepEqual(pre.connections.map((c) => c.hasSecret), [true, true, false]);
  });

  await step('Export aus der Zeit als „AtlasDB“ (alte Kennung, mit verschlüsselten Passwörtern): bleibt les- und importierbar', async () => {
    const old = JSON.parse(readFileSync(a.saveAs, 'utf8'));
    old.format = 'atlasdb-settings';
    const file = path.join(root, 'alt-atlasdb.json');
    writeFileSync(file, JSON.stringify(old));
    const p = await b.m.previewSettings(file, 'geheim123');
    assert.equal(p.secretsOpen, true);
    assert.equal(p.connections.length, 3);
    assert.deepEqual(p.connections.map((c) => c.hasSecret), [true, true, false]);
  });

  await step('Import: gleiche IDs, Passwörter neu verschlüsselt, Verlauf und Abfragen übernommen', async () => {
    const r = await b.m.importSettings({ file: a.saveAs, password: 'geheim123', connections: all(pre, 'new'), savedQueries: true, history: true });
    assert.deepEqual([r.created, r.replaced, r.skipped, r.savedQueries, r.history], [3, 0, 0, 2, 3]);
    assert.ok(r.notes.some((n) => n.includes(missingCa)), r.notes.join(' | '));
    const list = await b.store.list();
    assert.deepEqual(list.map((c) => c.id), ids);
    assert.deepEqual(await b.store.secretsOf(prod.id), { password: 'pw-prod-123' });
    assert.deepEqual(await b.store.secretsOf(dm.id), { password: 'pw-dm-456', keyPassphrase: 'schluessel-789', sshSecret: 'ssh-geheim-0' });
    assert.deepEqual(await b.store.secretsOf(local.id), {});
    const raw = readFileSync(path.join(b.dir, 'connections.json'), 'utf8');
    assert.ok(raw.includes('"passwordEnc": "B:') && !raw.includes('pw-prod-123'), 'auf B mit Bs Verschlüsselung gespeichert');
    assert.equal(list.find((c) => c.id === dm.id)?.options?.sshHost, 'proxy.example');
    assert.equal(list.find((c) => c.id === prod.id)?.color, '#e5484d');
    assert.equal(list.find((c) => c.id === prod.id)?.short, 'PRD');
    const hist = await b.m.listHistory({});
    assert.deepEqual(hist.map((h) => h.sql).reverse(), ['SELECT 1', "SELECT * FROM kunde WHERE email = 'x@y.ch'", 'SELECT now()']);
    assert.deepEqual((await b.m.listSavedQueries()).map((q) => q.name), ['Kunden zählen', 'Offene Rechnungen']);
  });

  await step('noch einmal importieren: alles erkannt (gleiche ID, keine Unterschiede), nichts doppelt', async () => {
    const again = await b.m.previewSettings(a.saveAs);
    assert.deepEqual(again.connections.map((c) => [c.match?.by, c.match?.differences.length]), [['id', 0], ['id', 0], ['id', 0]]);
    assert.deepEqual([again.savedQueries.fresh, again.history.fresh], [0, 0]);
    const r = await b.m.importSettings({ file: a.saveAs, connections: all(again, 'skip'), savedQueries: true, history: true });
    assert.deepEqual([r.created, r.skipped, r.savedQueries, r.history], [0, 3, 0, 0]);
    assert.equal((await b.store.list()).length, 3);
  });

  await step('geändert: Unterschiede genannt, ersetzt nur auf Wunsch; ohne Passwort bleibt das hiesige', async () => {
    await b.store.save({ ...PROD, id: prod.id, host: 'anderer.host', password: 'hier-neu-1' });
    const p = await b.m.previewSettings(a.saveAs);
    assert.deepEqual(p.connections[0].match, { id: prod.id, name: 'Prod MySQL', by: 'id', differences: ['Server'] });
    await b.m.importSettings({ file: a.saveAs, connections: [{ index: 0, action: 'skip' }], savedQueries: false, history: false });
    assert.equal((await b.store.get(prod.id)).host, 'anderer.host');
    await b.m.importSettings({ file: a.saveAs, connections: [{ index: 0, action: 'replace' }], savedQueries: false, history: false });
    assert.equal((await b.store.get(prod.id)).host, 'prod.example');
    assert.deepEqual(await b.store.secretsOf(prod.id), { password: 'hier-neu-1' });
    await b.m.importSettings({ file: a.saveAs, password: 'geheim123', connections: [{ index: 0, action: 'replace' }], savedQueries: false, history: false });
    assert.deepEqual(await b.store.secretsOf(prod.id), { password: 'pw-prod-123' });
  });

  await step('gleicher Name bzw. gleicher Server erkannt; neu anlegen trotz gleichem Namen → „Name (2)“', async () => {
    const c = profile('C');
    const other = await c.store.save({ ...PROD, host: 'woanders.example', color: undefined, short: undefined });
    const same = await c.store.save({ ...LOCAL, name: 'Mein Postgres' });
    const p = await c.m.previewSettings(a.saveAs);
    assert.deepEqual(p.connections[0].match, { id: other.id, name: 'Prod MySQL', by: 'name', differences: ['Server', 'Farbe', 'Kürzel'] });
    assert.deepEqual(p.connections[2].match, { id: same.id, name: 'Mein Postgres', by: 'server', differences: ['Name'] });
    const r = await c.m.importSettings({ file: a.saveAs, connections: [{ index: 0, action: 'new' }], savedQueries: false, history: false });
    assert.equal(r.created, 1);
    assert.ok(r.notes.some((n) => n.includes('„Prod MySQL (2)“')), r.notes.join(' | '));
    assert.deepEqual((await c.store.list()).map((x) => x.name).sort(), ['Mein Postgres', 'Prod MySQL', 'Prod MySQL (2)']);
  });

  await step('ohne Export-Passwort: keine Passwörter in der Datei, Import ohne Passwörter', async () => {
    a.saveAs = path.join(root, 'A-ohne.json');
    await a.m.exportSettings({ connectionIds: [prod.id], savedQueries: false, history: false });
    const json = JSON.parse(readFileSync(a.saveAs, 'utf8'));
    assert.equal(json.secrets, undefined);
    assert.equal(json.savedQueries, undefined);
    const e = profile('E');
    const p = await e.m.previewSettings(a.saveAs);
    assert.equal(p.hasSecrets, false);
    await e.m.importSettings({ file: a.saveAs, connections: all(p, 'new'), savedQueries: true, history: true });
    assert.deepEqual(await e.store.secretsOf(prod.id), {});
    assert.equal((await e.store.list())[0].hasPassword, false);
  });

  await step('gespeicherte Abfrage mit gleichem Namen, anderem Text → „Name (2)“', async () => {
    const d = profile('D');
    await new SavedQueries(path.join(d.dir, 'saved-queries.json')).save({ name: 'Kunden zählen', sql: 'SELECT 42' });
    const p = await d.m.previewSettings(path.join(root, 'A-export.json'));
    assert.deepEqual(p.savedQueries, { total: 2, fresh: 2 });
    await d.m.importSettings({ file: path.join(root, 'A-export.json'), connections: [], savedQueries: true, history: false });
    assert.deepEqual((await d.m.listSavedQueries()).map((q) => q.name), ['Kunden zählen', 'Kunden zählen (2)', 'Offene Rechnungen']);
  });

  await step('kaputte, fremde und neuere Dateien: klare Meldung; ungültige Einträge werden übergangen', async () => {
    const f = (name: string, text: string) => {
      const p = path.join(root, name);
      writeFileSync(p, text);
      return p;
    };
    await assert.rejects(b.m.previewSettings(f('kaputt.json', '{ nein')), /kein gültiges JSON/);
    await assert.rejects(b.m.previewSettings(f('fremd.json', '{"foo": 1}')), /keine OwlynDB-Einstellungsdatei/);
    await assert.rejects(b.m.previewSettings(f('neu.json', '{"format":"owlyndb-settings","version":99,"connections":[]}')), /neueren OwlynDB-Version/);
    await assert.rejects(b.m.previewSettings(path.join(root, 'fehlt.json')), /Datei nicht gefunden/);
    const mixed = f(
      'gemischt.json',
      JSON.stringify({
        // alte Kennung aus der Zeit als „AtlasDB“: solche Exporte bleiben lesbar
        format: 'atlasdb-settings',
        version: 1,
        connections: [
          { id: 'x1', name: 'gut', dialect: 'postgres', host: 'h', port: 5432, user: 'u', options: { ssl: true, evil: '1', sshPort: 'nein' } },
          { id: 'x2', name: 'falscher Typ', dialect: 'oracle', host: 'h', port: 1521, user: 'u' },
          { id: 'x3', name: 'falscher Port', dialect: 'mysql', host: 'h', port: 99999, user: 'u' },
        ],
      }),
    );
    const p = await b.m.previewSettings(mixed);
    assert.deepEqual(p.connections.map((c) => c.name), ['gut']);
    const g = profile('G');
    await g.m.importSettings({ file: mixed, connections: [{ index: 0, action: 'new' }], savedQueries: false, history: false });
    assert.deepEqual((await g.store.list())[0].options, { ssl: true });
  });

  await step('präparierte Datei: nur UUIDs als ID übernommen, keine geerbten Schlüssel, Netzwerkpfade nicht angefasst', async () => {
    const file = path.join(root, 'praepariert.json');
    writeFileSync(
      file,
      JSON.stringify({
        format: 'owlyndb-settings',
        version: 1,
        connections: [
          { id: 'constructor', name: 'Präpariert', dialect: 'mysql', host: 'h', port: 3306, user: 'u', options: { ssl: true, caFile: '\\\\nirgends.invalid\\freigabe\\ca.pem' } },
          { id: '../x', name: 'Pfad als ID', dialect: 'postgres', host: 'h', port: 5432, user: 'u' },
        ],
        secrets: await seal({}, 'geheim123'),
      }),
    );
    const h = profile('H');
    const p = await h.m.previewSettings(file, 'geheim123');
    assert.deepEqual(p.connections.map((c) => [c.hasSecret, c.missingFiles]), [[false, []], [false, []]]);
    const r = await h.m.importSettings({ file, password: 'geheim123', connections: all(p, 'new'), savedQueries: false, history: false });
    assert.deepEqual(r.notes, []);
    const list = await h.store.list();
    assert.equal(list.length, 2);
    assert.ok(list.every((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.id) && !c.hasPassword), list.map((c) => c.id).join(', '));
    // Export mit Export-Passwort, aber ohne gespeicherte Passwörter: kein verschlüsselter Teil, der Import fragt nicht
    await h.m.exportSettings({ connectionIds: list.map((c) => c.id), savedQueries: false, history: false, password: 'geheim123' });
    assert.equal('secrets' in JSON.parse(readFileSync(h.saveAs, 'utf8')), false);
    assert.equal((await h.m.previewSettings(h.saveAs)).hasSecrets, false);
  });

  await step('von Hand kopiertes Profil: Export mit Passwort nennt die Verbindung, ohne Passwörter geht er', async () => {
    const i = profile('I');
    mkdirSync(i.dir, { recursive: true });
    copyFileSync(path.join(a.dir, 'connections.json'), path.join(i.dir, 'connections.json'));
    await assert.rejects(
      i.m.exportSettings({ connectionIds: ids, savedQueries: false, history: false, password: 'geheim123' }),
      /„Prod MySQL“ lässt sich auf diesem PC nicht entschlüsseln/,
    );
    assert.equal(await i.m.exportSettings({ connectionIds: ids, savedQueries: false, history: false }), i.saveAs);
    assert.equal(JSON.parse(readFileSync(i.saveAs, 'utf8')).connections.length, 3);
  });

  await Promise.all([a, b].map((p) => p.m.shutdown()));
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
