/* Objektsuche über alle Datenbanken einer Verbindung. Vorher: npm run testdb:up und einmal npm run test:drivers.
   Aufruf: npm run test:search */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqlDialect, SearchHit } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-search-')), 'c.json'), {
  encrypt: (s) => 'x' + s,
  decrypt: (s) => s.slice(1),
});

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

const targets: Record<SqlDialect, { port: number; user: string; password: string; schema: string }> = {
  mysql: { port: 15306, user: 'root', password: 'dbviewer-test', schema: '' },
  postgres: { port: 15432, user: 'postgres', password: 'dbviewer-test', schema: 'public' },
  mssql: { port: 15433, user: 'sa', password: 'Dbviewer-Test1', schema: 'dbo' },
};

const show = (h: SearchHit) => `${h.kind}:${h.database}.${h.schema ? h.schema + '.' : ''}${h.name}${h.column ? '.' + h.column : ''}`;

async function main() {
  assertTestContainers(Object.entries(targets).map(([name, t]) => ({ name, host: '127.0.0.1', port: t.port })));
  const m = new Manager(store, undefined, 0);
  for (const dialect of ['mysql', 'postgres', 'mssql'] as const) {
    console.log(`\n${dialect}`);
    const t = targets[dialect];
    const c = await store.save({
      name: dialect,
      dialect,
      host: '127.0.0.1',
      port: t.port,
      user: t.user,
      password: t.password,
      database: 'shop',
      options: dialect === 'mssql' ? { trustServerCertificate: true } : {},
    });
    const { sessionId } = await m.openSession(c.id, 'shop');
    const run = async (sql: string) => {
      const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
      if (r.statements[0]?.error) throw new Error(r.statements[0].error);
    };
    const tbl = dialect === 'mssql' ? 'dbo.SuchZiel_X' : dialect === 'postgres' ? 'public."SuchZiel_X"' : 'SuchZiel_X';
    await run(dialect === 'mssql' ? "IF OBJECT_ID('dbo.SuchZiel_X') IS NOT NULL DROP TABLE dbo.SuchZiel_X" : `DROP TABLE IF EXISTS ${tbl}`);
    await run(`CREATE TABLE ${tbl} (id int PRIMARY KEY, ${dialect === 'postgres' ? '"Such_Spalte"' : 'Such_Spalte'} int)`);
    await m.closeSession(sessionId);

    await step('Tabelle und Spalte, Groß-/Kleinschreibung egal', async () => {
      const r = await m.searchObjects(c.id, 'suchziel');
      const hits = r.hits.filter((h) => h.database === 'shop').map(show);
      assert.ok(hits.includes(`table:shop.${t.schema ? t.schema + '.' : ''}SuchZiel_X`), hits.join(' | '));
      const col = (await m.searchObjects(c.id, 'SUCH_spalte')).hits.find((h) => h.kind === 'column' && h.database === 'shop');
      assert.equal(col?.name, 'SuchZiel_X');
      assert.equal(col?.column, 'Such_Spalte');
      assert.equal(col?.objectKind, 'table');
      assert.ok(col?.dataType, 'Spaltentyp');
    });
    await step('„_“ gilt wörtlich (kein LIKE-Platzhalter)', async () => {
      const r = await m.searchObjects(c.id, 'kunde_');
      assert.ok(r.hits.length > 0);
      assert.ok(r.hits.every((h) => (h.column ?? h.name).toLowerCase().includes('kunde_')), r.hits.map(show).join(' | '));
    });
    await step('Routine aus den Seeds; View-Spalte als View erkannt', async () => {
      const proc = dialect === 'postgres' ? 'kunden_anzahl' : 'kunden_von';
      const r = await m.searchObjects(c.id, proc);
      assert.ok(r.hits.some((h) => h.database === 'shop' && h.name === proc && (h.kind === 'procedure' || h.kind === 'function')), r.hits.map(show).join(' | '));
      const v = (await m.searchObjects(c.id, 'summe')).hits.find((h) => h.database === 'shop' && h.name === 'v_umsatz');
      assert.equal(v?.objectKind, 'view');
    });
    await step('zu kurzer Suchtext: nichts', async () => {
      assert.equal((await m.searchObjects(c.id, ' k ')).hits.length, 0);
    });
    await step('mehrere Datenbanken: Standard-Datenbank zuerst; Obergrenze 300', async () => {
      const r = await m.searchObjects(c.id, 'id');
      assert.ok(r.hits.length > 0 && r.hits.length <= 300);
      if (dialect !== 'mysql') assert.equal(r.hits[0].database, 'shop');
    });
  }
  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
