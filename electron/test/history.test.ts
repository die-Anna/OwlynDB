/* Abfrage-Verlauf und gespeicherte Abfragen (gegen die MySQL-Test-Datenbank).
   Vorher: npm run testdb:up. Aufruf: npm run test:history */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionStore } from '../connection-store';
import { QueryHistory } from '../history';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-hist-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });

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

async function main() {
  assertTestContainers([{ name: 'mysql', host: '127.0.0.1', port: 15306 }]);
  const c = await store.save({ name: 'Verlauf-Test', dialect: 'mysql', host: '127.0.0.1', port: 15306, user: 'root', password: 'dbviewer-test', database: 'shop' });
  const other = await store.save({ name: 'Andere', dialect: 'mysql', host: '127.0.0.1', port: 15306, user: 'root', password: 'dbviewer-test', database: 'shop' });
  const m = new Manager(store, undefined, 0);

  console.log('\nVerlauf');
  await step('jede ausgeführte Anweisung landet im Verlauf, neueste zuerst', async () => {
    const { sessionId } = await m.openSession(c.id, 'shop');
    await m.runQuery(sessionId, [{ sql: 'SELECT id FROM kunden LIMIT 3', offset: 0 }], 100);
    await m.runQuery(
      sessionId,
      [
        { sql: 'SELECT COUNT(*) FROM bestellungen', offset: 0 },
        { sql: 'SELECT * FROM gibtsnicht', offset: 40 },
        { sql: 'SELECT 3', offset: 70 },
      ],
      100,
    );
    const h = await m.listHistory({ connectionId: c.id });
    // die dritte Anweisung lief nach dem Fehler nicht mehr
    assert.deepEqual(
      h.map((e) => e.sql),
      ['SELECT * FROM gibtsnicht', 'SELECT COUNT(*) FROM bestellungen', 'SELECT id FROM kunden LIMIT 3'],
    );
    assert.equal(h[0].ok, false);
    assert.match(h[0].error ?? '', /gibtsnicht/);
    assert.equal(h[2].info, '3 Zeilen');
    assert.equal(h[2].database, 'shop');
    assert.equal(h[2].connection, 'Verlauf-Test');
    await m.closeSession(sessionId);
  });
  await step('UPDATE: betroffene Zeilen', async () => {
    const { sessionId } = await m.openSession(c.id, 'shop');
    await m.runQuery(sessionId, [{ sql: "UPDATE kunden SET ort = ort WHERE id = 1", offset: 0 }], 100);
    const [e] = await m.listHistory({ connectionId: c.id, limit: 1 });
    assert.match(e.info ?? '', /betroffen/);
    await m.closeSession(sessionId);
  });
  await step('großes Skript (> 20 Anweisungen) als ein Eintrag', async () => {
    const { sessionId } = await m.openSession(c.id, 'shop');
    const stmts = Array.from({ length: 25 }, (_, i) => ({ sql: `SELECT ${i}`, offset: i * 10 }));
    await m.runQuery(sessionId, stmts, 10);
    const [e] = await m.listHistory({ connectionId: c.id, limit: 1 });
    assert.equal(e.info, '25 Anweisungen');
    assert.ok(e.sql.startsWith('SELECT 0;\nSELECT 1'));
    await m.closeSession(sessionId);
  });
  await step('Suche (alle Wörter) und Filter nach Verbindung', async () => {
    const { sessionId } = await m.openSession(other.id, 'shop');
    await m.runQuery(sessionId, [{ sql: 'SELECT name FROM kunden WHERE ort = \'Basel\'', offset: 0 }], 10);
    await m.closeSession(sessionId);
    assert.equal((await m.listHistory({ connectionId: other.id })).length, 1);
    const found = await m.listHistory({ search: 'kunden basel' });
    assert.equal(found.length, 1);
    assert.equal(found[0].connection, 'Andere');
    assert.equal((await m.listHistory({ search: 'kunden limit' })).length, 1);
  });
  await step('bleibt nach Neustart erhalten', async () => {
    const m2 = new Manager(store, undefined, 0);
    assert.equal((await m2.listHistory({})).length, (await m.listHistory({})).length);
    await m2.shutdown();
  });
  await step('Verlauf einer Verbindung löschen', async () => {
    await m.clearHistory(other.id);
    assert.equal((await m.listHistory({ connectionId: other.id })).length, 0);
    assert.ok((await m.listHistory({ connectionId: c.id })).length > 0);
    const m2 = new Manager(store, undefined, 0);
    assert.equal((await m2.listHistory({ connectionId: other.id })).length, 0, 'auch in der Datei');
    await m2.shutdown();
  });
  await step('Obergrenze: Datei wird gekürzt', async () => {
    const file = path.join(dir, 'kurz.jsonl');
    const h = new QueryHistory(file, 10);
    for (let i = 0; i < 15; i++) await h.add([{ at: '', connectionId: 'x', connection: 'x', sql: `SELECT ${i}`, durationMs: 1, ok: true }]);
    const list = await h.list({});
    assert.equal(list.length, 10);
    assert.equal(list[0].sql, 'SELECT 14');
    const lines = readFileSync(file, 'utf8').trim().split('\n').length;
    assert.ok(lines <= 12, `Zeilen in der Datei: ${lines}`);
    assert.equal((await new QueryHistory(file, 10).list({})).length, 10);
  });

  console.log('\nGespeicherte Abfragen');
  await step('speichern, sortiert auflisten, gleicher Name überschreibt', async () => {
    await m.saveQuery({ name: 'Umsatz je Ort', sql: 'SELECT * FROM v_umsatz', dialect: 'mysql' });
    await m.saveQuery({ name: 'Aktive Kunden', sql: 'SELECT * FROM kunden WHERE aktiv = 1', dialect: 'mysql' });
    await m.saveQuery({ name: 'umsatz je ort', sql: 'SELECT ort, summe FROM v_umsatz' });
    const list = await m.listSavedQueries();
    assert.deepEqual(
      list.map((q) => q.name),
      ['Aktive Kunden', 'umsatz je ort'],
    );
    assert.equal(list[1].sql, 'SELECT ort, summe FROM v_umsatz');
  });
  await step('leerer Name oder leerer Text: Meldung', async () => {
    await assert.rejects(m.saveQuery({ name: ' ', sql: 'SELECT 1' }), /Namen/);
    await assert.rejects(m.saveQuery({ name: 'x', sql: '  ' }), /leer/);
  });
  await step('löschen; bleibt nach Neustart', async () => {
    const [first] = await m.listSavedQueries();
    await m.deleteSavedQuery(first.id);
    const m2 = new Manager(store, undefined, 0);
    assert.deepEqual(
      (await m2.listSavedQueries()).map((q) => q.name),
      ['umsatz je ort'],
    );
    await m2.shutdown();
  });

  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
