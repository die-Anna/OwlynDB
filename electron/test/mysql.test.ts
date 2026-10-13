/* MySQL- und MariaDB-Treiber gegen die Test-Container: Geometrie und JSON roh, Suche mit ? in der WHERE-Bedingung,
   Sequenzen (MariaDB) keine Tabellen, Parameter trotz NO_BACKSLASH_ESCAPES, Export bricht bei Schreibfehler ab.
   Vorher: npm run testdb:up. Aufruf: npm run test:mysql */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, JobStatus } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-my-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
let nextFile = '';
const m = new Manager(store, { pickFile: async () => null, saveFile: async () => nextFile, showInFolder: () => undefined }, 0);

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

const servers = {
  mysql: { port: 15306 },
  mariadb: { port: 15307 },
} as const;
type Server = keyof typeof servers;

function input(server: Server, name: string = server): ConnectionInput {
  return { name, dialect: 'mysql', host: '127.0.0.1', port: servers[server].port, user: 'root', password: 'dbviewer-test', options: {} };
}

async function waitJob(id: string): Promise<JobStatus> {
  for (;;) {
    const s = await m.jobStatus(id);
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(connectionId: string, db: string | undefined, sqls: string[]): Promise<unknown[][]> {
  const { sessionId } = await m.openSession(connectionId, db);
  try {
    const out: unknown[][] = [];
    for (const sql of sqls) {
      const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 100);
      if (r.statements[0]?.error) throw new Error(`${sql.slice(0, 100)}: ${r.statements[0].error}`);
      out.push(r.results[0]?.rows[0] ?? []);
    }
    return out;
  } finally {
    await m.closeSession(sessionId);
  }
}
const scalar = async (id: string, db: string, sql: string) => (await run(id, db, [sql]))[0][0];

async function main() {
  assertTestContainers(Object.entries(servers).map(([name, x]) => ({ name, host: '127.0.0.1', port: x.port })));
  for (const server of ['mysql', 'mariadb'] as const) {
    console.log(`\n${server}`);
    const id = (await store.save(input(server))).id;
    const db = `${server}_x`;
    const obj = (name: string) => ({ connectionId: id, database: db, schema: '', name, kind: 'table' as const });

    await step('Testdatenbank anlegen', async () => {
      await run(id, undefined, [`DROP DATABASE IF EXISTS \`${db}\``, `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`]);
      await run(id, db, [
        'CREATE TABLE g (id int PRIMARY KEY, p POINT NULL, j JSON NULL, t TEXT NULL)',
        "INSERT INTO g VALUES (1, ST_GeomFromText('POINT(8.5 47.3)'), 'null', 'abc'), (2, NULL, '\"abc\"', 'was?'), (3, NULL, '12345678901234567890', NULL), (4, NULL, 'true', 'x'), (5, NULL, '{\"a\": 1}', 'y')",
      ]);
    });

    await step('F076/F077: Geometrie als Rohbytes (0x…), JSON wie gespeichert', async () => {
      const r = await m.fetchTable({ object: obj('g'), limit: 100, offset: 0, sort: [{ column: 'id', dir: 'asc' }] });
      const col = (n: string) => r.columns.findIndex((c) => c.name === n);
      assert.match(String(r.rows[0][col('p')]), /^0x[0-9A-F]+$/, 'POINT als Hex');
      assert.equal(r.rows[1][col('p')], null);
      assert.deepEqual(
        r.rows.slice(0, 4).map((x) => x[col('j')]),
        ['null', '"abc"', '12345678901234567890', 'true'],
      );
      assert.match(String(r.rows[4][col('j')]), /^\{"a":\s?1\}$/);
    });

    await step('F233: Suchtext und ? in der WHERE-Bedingung vertragen sich', async () => {
      const r = await m.fetchTable({ object: obj('g'), limit: 100, offset: 0, sort: [], where: "t = 'was?'", search: 'abc' });
      assert.equal(r.rows.length, 1);
      assert.equal(await m.countTable({ object: obj('g'), limit: 0, offset: 0, sort: [], where: "t = 'was?'", search: 'abc' }), 1);
    });

    await step('F076: Dump und Einspielen im selben Typ – Geometrie und JSON kommen unverändert an', async () => {
      const file = path.join(dir, `${db}.sql`);
      nextFile = file;
      const dumpId = await m.startDump({ connectionId: id, database: db, tables: [{ schema: '', name: 'g' }], views: [], structure: true, data: true, dropFirst: true, targetDialect: 'mysql', rowsPerInsert: 100, baseName: 'x' });
      const s = await waitJob(dumpId!);
      assert.equal(s.state, 'done', s.error);
      const y = `${server}_y`;
      await run(id, undefined, [`DROP DATABASE IF EXISTS \`${y}\``]);
      const imp = await waitJob(await m.startImport({ connectionId: id, database: y, createDatabase: true, file, stopOnError: true, transaction: false, skipUse: true }));
      assert.equal(imp.state, 'done', imp.error);
      assert.equal(await scalar(id, y, 'SELECT ST_AsText(p) FROM g WHERE id = 1'), await scalar(id, db, 'SELECT ST_AsText(p) FROM g WHERE id = 1'));
      assert.equal(await scalar(id, y, 'SELECT ST_SRID(p) FROM g WHERE id = 1'), await scalar(id, db, 'SELECT ST_SRID(p) FROM g WHERE id = 1'));
      for (const k of [1, 2, 3, 4, 5]) {
        assert.equal(await scalar(id, y, `SELECT CAST(j AS CHAR) FROM g WHERE id = ${k}`), await scalar(id, db, `SELECT CAST(j AS CHAR) FROM g WHERE id = ${k}`), `JSON Zeile ${k}`);
      }
      assert.equal(Number(await scalar(id, y, "SELECT COUNT(*) FROM g WHERE CAST(j AS CHAR) = 'null'")), 1, 'JSON-null bleibt JSON-null (kein SQL-NULL)');
    });

    if (server === 'mariadb') {
      await step('F079: Sequenz ist keine Tabelle (Baum, Suche, Vervollständigung)', async () => {
        await run(id, db, ['CREATE SEQUENCE seq_x START WITH 10']);
        const objects = await m.listObjects(id, db, '');
        assert.ok(!objects.some((o) => o.name === 'seq_x'), objects.map((o) => o.name).join(', '));
        const hits = await m.searchObjects(id, 'seq_x');
        assert.ok(!hits.hits.some((h) => h.kind === 'table' && h.name === 'seq_x'), JSON.stringify(hits.hits));
        const info = await m.completionInfo(id, db);
        assert.ok(!info.tables.some((t) => t.name === 'seq_x'));
      });
    }

    await step('F086: Parameter bleiben im Literal, auch wenn der Server NO_BACKSLASH_ESCAPES setzt', async () => {
      const [[before]] = await run(id, undefined, ['SELECT @@GLOBAL.sql_mode']);
      await run(id, undefined, ["SET GLOBAL sql_mode = CONCAT(@@GLOBAL.sql_mode, ',NO_BACKSLASH_ESCAPES')"]);
      try {
        // neue Verbindung = neuer Pool: seine Verbindungen entstehen mit dem geänderten Modus
        const fresh = (await store.save(input(server, `${server} frisch`))).id;
        const o = { ...obj('g'), connectionId: fresh };
        const value = "a\\'b\\\\c";
        const r = await m.applyChanges({ object: o, changes: [{ kind: 'insert', values: { id: 9, t: value } }], preview: false });
        assert.equal(r.applied, 1);
        assert.equal(await scalar(fresh, db, 'SELECT t FROM g WHERE id = 9'), value, 'Wert wie eingegeben');
        // Suche mit Backslash und Apostroph
        const found = await m.fetchTable({ object: o, limit: 10, offset: 0, sort: [], search: "\\'b" });
        assert.equal(found.rows.length, 1);
        await m.applyChanges({ object: o, changes: [{ kind: 'delete', key: { id: 9 } }], preview: false });
      } finally {
        await run(id, undefined, [`SET GLOBAL sql_mode = '${String(before).replace(/'/g, "''")}'`]);
      }
    });

    await step('F089/F084: Export bricht bei Schreibfehler ab, Abfrage wird beendet; net_write_timeout hoch', async () => {
      await run(id, db, ['CREATE TABLE n (i int PRIMARY KEY)', 'INSERT INTO n SELECT seq FROM (SELECT 1 AS seq UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) s']);
      // 10^4 Zeilen à 10 ms Schlaf: ohne Abbruch liefe die Abfrage 100 s. Breite Zeilen, damit der Server seinen
      // Netzpuffer (16 KB) früh leert – schmale Zeilen kämen erst nach Sekunden beim Client an
      const slow = "SELECT a.i, SLEEP(0.01) AS s, REPEAT('x', 4000) AS pad FROM n a, n b, n c, n d";
      const { sessionId } = await m.openSession(id, db);
      try {
        nextFile = path.join(dir, 'gibt-es-nicht', 'x.csv'); // Ordner fehlt: die Datei lässt sich nicht anlegen
        const t0 = Date.now();
        await assert.rejects(m.exportQuery(sessionId, { sql: slow, offset: 0 }, 0, { format: 'csv', baseName: 'x' }));
        assert.ok(Date.now() - t0 < 15_000, `Export brauchte ${Date.now() - t0} ms`);
        const r = await m.runQuery(sessionId, [{ sql: 'SELECT @@SESSION.net_write_timeout', offset: 0 }], 10);
        assert.equal(Number(r.results[0].rows[0][0]), 3600);
      } finally {
        await m.closeSession(sessionId);
      }
      await new Promise((r) => setTimeout(r, 500));
      const running = await scalar(id, db, "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT a.i, SLEEP%'");
      assert.equal(Number(running), 0, 'Abfrage läuft auf dem Server weiter');
    });
  }
  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
