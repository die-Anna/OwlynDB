/* Treiber-Test gegen die Test-Datenbanken aus dev/docker-compose.yml.
   Aufruf: npm run testdb:up, dann npm run test:drivers [mysql|postgres|mssql] */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Dialect, ObjectRef, TableDataRequest } from '../../shared/api-types';
import { splitSql, statementAt } from '../../shared/sql-splitter';
import { checkWhere, condition, needsSchema } from '../../shared/sql-util';
import { assertTestContainers } from './guard';
import { createDriver, DriverConfig, MetaDriver, Session } from '../drivers';

const root = path.resolve(__dirname, '../../..');
const testdb = JSON.parse(readFileSync(path.join(root, 'dev/testdb.json'), 'utf8')) as Record<Dialect, DriverConfig>;

let failed = 0;
async function step(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).stack?.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

async function waitForServer(d: MetaDriver, dialect: Dialect) {
  for (let i = 0; i < 60; i++) {
    try {
      return await d.serverInfo();
    } catch (e) {
      if (i === 59) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`${dialect} nicht erreichbar`);
}

async function runScript(s: Session, dialect: Dialect, file: string) {
  const text = readFileSync(path.join(root, 'dev/seed', file), 'utf8');
  const stmts = splitSql(text, dialect).map((x) => ({ sql: x.sql, offset: x.start }));
  const run = await s.run(stmts, 10);
  const err = run.statements.find((x) => x.error);
  if (err) throw new Error(`Seed-Anweisung ${err.statementIndex + 1} fehlgeschlagen: ${err.error}\n${err.sql.slice(0, 200)}`);
  assert.equal(run.statements.length, stmts.length);
}

function splitterTests() {
  console.log('\nsplitSql');
  return Promise.all([
    step('MySQL: Strings, Kommentare, DELIMITER', () => {
      const s = splitSql("SELECT ';' AS a; -- x;\nSELECT 'it''s', \"b;\" # c;\n;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END //\nDELIMITER ;\nSELECT `x;y`", 'mysql');
      assert.deepEqual(s.map((x) => x.sql), [
        "SELECT ';' AS a",
        "-- x;\nSELECT 'it''s', \"b;\" # c;",
        'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
        'SELECT `x;y`',
      ]);
    }),
    step('PostgreSQL: Dollar-Quoting', () => {
      const s = splitSql("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT $tag$a;b$tag$, E'x\\';y';", 'postgres');
      assert.equal(s.length, 2);
      assert.match(s[0].sql, /END; \$\$ LANGUAGE plpgsql$/);
      assert.equal(s[1].sql, "SELECT $tag$a;b$tag$, E'x\\';y'");
    }),
    step('SQL Server: GO, BEGIN/END, Prozedur', () => {
      const s = splitSql("SELECT 1; SELECT [a;b];\nIF 1=1\nBEGIN\n  SELECT 2; SELECT CASE WHEN 1=1 THEN 3 END;\nEND;\nBEGIN TRAN; SELECT 4;\ngo\nCREATE PROC p AS SELECT 5; SELECT 6;\nGO 2\nSELECT 7", 'mssql');
      assert.deepEqual(s.map((x) => x.sql), [
        'SELECT 1',
        'SELECT [a;b]',
        'IF 1=1\nBEGIN\n  SELECT 2; SELECT CASE WHEN 1=1 THEN 3 END;\nEND',
        'BEGIN TRAN',
        'SELECT 4',
        'CREATE PROC p AS SELECT 5; SELECT 6;',
        'SELECT 7',
      ]);
    }),
    step('verschachtelte Blockkommentare (PostgreSQL, SQL Server)', () => {
      const t = '/* alt /* x */ DELETE FROM t; */ SELECT 1;';
      assert.deepEqual(splitSql(t, 'postgres').map((x) => x.sql), ['/* alt /* x */ DELETE FROM t; */ SELECT 1']);
      assert.deepEqual(splitSql(t, 'mssql').map((x) => x.sql), ['/* alt /* x */ DELETE FROM t; */ SELECT 1']);
    }),
    step('Strg+Enter auf Leerzeile führt nichts aus', () => {
      const t = 'SELECT 1;\n\nDELETE FROM x;';
      assert.equal(statementAt(splitSql(t, 'mysql'), t, t.indexOf('\n\n') + 1), undefined);
    }),
    step('MySQL: "--" ohne Leerzeichen ist kein Kommentar', () => {
      assert.deepEqual(splitSql('SELECT 5--3;\nSELECT 2;', 'mysql').map((x) => x.sql), ['SELECT 5--3', 'SELECT 2']);
    }),
    step('WHERE-Prüfung: kein Ausbruch aus der Klammer', () => {
      for (const d of ['mysql', 'postgres', 'mssql'] as const) {
        assert.equal(checkWhere("ort = 'Bern' AND (a > 1 OR b < 2)", d), null);
        assert.equal(checkWhere("name = 'a)b; --c'", d), null);
        assert.ok(checkWhere('1=1) DELETE FROM t WHERE (1=1', d));
        assert.ok(checkWhere('1=1; DELETE FROM t', d));
        assert.ok(checkWhere('1=1 -- )', d));
        assert.ok(checkWhere('1=1 /* x */', d));
        assert.ok(checkWhere("name = 'offen", d));
        assert.ok(checkWhere('(1=1', d));
      }
      assert.ok(checkWhere('[a)b', 'mssql'));
      assert.ok(checkWhere('x = $$a$$', 'postgres'));
    }),
    step('Offsets zeigen auf den Anweisungsbeginn', () => {
      const text = '  SELECT 1;\n\n  SELECT 2';
      const s = splitSql(text, 'postgres');
      assert.equal(text.slice(s[1].start, s[1].end), 'SELECT 2');
    }),
  ]);
}

async function testDialect(dialect: Dialect) {
  console.log(`\n${dialect}`);
  const base = testdb[dialect];
  const admin = createDriver(dialect, base);
  const info = await waitForServer(admin, dialect);
  console.log(`  Server: ${info.version.split('\n')[0].slice(0, 80)}`);

  // Seed einspielen
  if (dialect === 'postgres') {
    const s = await admin.openSession('postgres');
    const r = await s.run([{ sql: "SELECT 1 FROM pg_database WHERE datname = 'shop'", offset: 0 }], 1);
    if (!r.results[0].rows.length) await s.run([{ sql: 'CREATE DATABASE shop', offset: 0 }], 1);
    await s.close();
  }
  const seedSession = await admin.openSession(dialect === 'postgres' ? 'shop' : undefined);
  await step('Seed einspielen', () => runScript(seedSession, dialect, `${dialect}.sql`));
  await seedSession.close();
  await admin.close();

  const d = createDriver(dialect, { ...base, database: dialect === 'postgres' ? 'shop' : undefined });
  const schema = dialect === 'mysql' ? '' : dialect === 'mssql' ? 'dbo' : 'public';
  const ref: ObjectRef = { connectionId: 'test', database: 'shop', schema, name: 'kunden', kind: 'table' };

  await step('Datenbanken', async () => {
    assert.ok((await d.listDatabases()).includes('shop'));
  });
  await step('Schemas', async () => {
    const s = await d.listSchemas('shop');
    if (dialect === 'mysql') assert.deepEqual(s, []);
    else assert.ok(s.includes(schema) && s.includes('verkauf'), s.join(','));
  });
  await step('Objekte', async () => {
    const o = await d.listObjects('shop', schema);
    const names = o.map((x) => `${x.name}:${x.kind}`);
    assert.ok(names.includes('kunden:table') && names.includes('bestellungen:table') && names.includes('v_umsatz:view'), names.join(','));
  });
  await step('Tabellenstruktur', async () => {
    const t = await d.describeTable('shop', schema, 'kunden');
    assert.deepEqual(t.columns.slice(0, 3).map((c) => c.name), ['id', 'name', 'ort']);
    const id = t.columns[0];
    assert.ok(id.primaryKey && id.autoIncrement && !id.nullable);
    assert.ok(t.columns.find((c) => c.name === 'ort')!.nullable);
    assert.ok(t.indexes.some((i) => i.primary && i.columns[0] === 'id'));
    assert.ok(t.indexes.some((i) => i.unique && !i.primary && i.columns[0] === 'name'));
    const b = await d.describeTable('shop', schema, 'bestellungen');
    assert.equal(b.foreignKeys.length, 1);
    assert.deepEqual([b.foreignKeys[0].refTable, b.foreignKeys[0].columns[0], b.foreignKeys[0].refColumns[0]], ['kunden', 'kunde_id', 'id']);
  });
  await step('DDL Tabelle und View', async () => {
    const t = await d.getDdl('shop', schema, 'bestellungen', 'table');
    assert.match(t, /CREATE TABLE/i);
    assert.match(t, /REFERENCES/i);
    const v = await d.getDdl('shop', schema, 'v_umsatz', 'view');
    assert.match(v, /VIEW/i);
  });

  const req = (p: Partial<TableDataRequest>): TableDataRequest => ({ object: ref, limit: 100, offset: 0, sort: [], ...p });
  await step('Tabellendaten: Seite, Sortierung, NULL', async () => {
    const r = await d.fetchTable(req({ sort: [{ column: 'id', dir: 'desc' }], limit: 50, offset: 10 }));
    assert.equal(r.rows.length, 50);
    assert.equal(Number(r.rows[0][0]), 2490);
    assert.ok(r.columns[0].numeric, 'id numerisch');
    const g = r.columns.findIndex((c) => c.name === 'guthaben');
    // Kunde 2486 = 11 * 226 -> guthaben NULL; Reihenfolge 2490..2441
    assert.equal(r.rows[2490 - 2486][g], null);
    const e = r.columns.findIndex((c) => c.name === 'erstellt');
    assert.match(String(r.rows[0][e]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  await step('Tabellendaten: Suche mit % und _ im Text', async () => {
    const r = await d.fetchTable(req({ search: '100% Rabatt_' }));
    assert.equal(r.rows.length, 1);
    assert.equal(Number(r.rows[0][0]), 42);
    assert.equal(await d.countTable(req({ search: 'Kunde 00' })), 99);
    assert.match(r.sql, /100\\{1,2}% Rabatt\\{1,2}_/);
  });
  await step('Tabellendaten: WHERE und Zählung', async () => {
    assert.equal(await d.countTable(req({})), 2500);
    const w = dialect === 'mssql' ? 'aktiv = 0' : dialect === 'mysql' ? 'aktiv = 0' : 'NOT aktiv';
    assert.equal(await d.countTable(req({ where: w })), 357);
    const r = await d.fetchTable(req({ where: w, sort: [{ column: 'name', dir: 'asc' }], limit: 3 }));
    assert.equal(r.rows[0][1], 'Kunde 0007');
  });
  await step('Tabellenansicht liest nur: angehängte Anweisung wird abgelehnt', async () => {
    await assert.rejects(d.fetchTable(req({ where: '1=1) DELETE FROM kunden WHERE (1=1' })), /Klammern/);
    await assert.rejects(d.countTable(req({ where: '1=1; DELETE FROM kunden' })), /Semikolon/);
    assert.equal(await d.countTable(req({})), 2500);
  });
  if (dialect === 'postgres') {
    await step('Tabellenansicht liest nur: schreibende Funktion im Filter scheitert (READ ONLY)', async () => {
      await assert.rejects(d.fetchTable(req({ where: "nextval('public.kunden_id_seq') > 0" })), /read-only/);
    });
  }
  await step('Binärwerte als Hex', async () => {
    const r = await d.fetchTable(req({ where: 'id = 100' }));
    const a = r.columns.findIndex((c) => c.name === 'avatar');
    assert.match(String(r.rows[0][a]).toUpperCase(), /DEADBEEF/);
  });
  await step('Filter auf Binärspalte: der angezeigte Wert 0x… trifft die Zeilen (Kontextmenü, Fremdschlüssel-Sprung)', async () => {
    const r = await d.fetchTable(req({ where: 'id = 100' }));
    const shown = r.rows[0][r.columns.findIndex((c) => c.name === 'avatar')];
    // jeder 100. Kunde hat 0xDEADBEEF, die übrigen NULL
    assert.equal(await d.countTable(req({ where: condition(dialect, 'avatar', shown, '=', false, true) })), 25);
    assert.equal(await d.countTable(req({ where: condition(dialect, 'avatar', shown, '<>', false, true) })), 0);
  });
  await step('Autovervollständigung', async () => {
    const c = await d.completionInfo('shop');
    const k = c.tables.find((t) => t.name === 'kunden' && (dialect === 'mysql' || t.schema === schema));
    assert.ok(k && k.columns.includes('guthaben'));
    // Suchpfad für Namen ohne Schema (Standardschema von sa ist dbo, search_path von postgres ist public)
    assert.deepEqual(c.searchPath, dialect === 'mysql' ? undefined : [schema]);
    assert.equal(needsSchema(dialect, k, c.tables, c.searchPath), false);
  });

  const s = await d.openSession('shop');
  await step('Sitzung: Datenbank', () => assert.equal(s.database, 'shop'));
  await step('Sitzung: mehrere Anweisungen, Zeilenlimit', async () => {
    const sel = dialect === 'mssql' ? 'SELECT TOP (10) id FROM dbo.kunden ORDER BY id' : `SELECT id FROM ${dialect === 'mysql' ? '' : 'public.'}kunden ORDER BY id LIMIT 10`;
    const r = await s.run(
      [
        { sql: sel, offset: 0 },
        { sql: dialect === 'mssql' ? "UPDATE dbo.kunden SET notiz = 'x' WHERE id <= 3" : `UPDATE ${dialect === 'mysql' ? '' : 'public.'}kunden SET notiz = 'x' WHERE id <= 3`, offset: 0 },
      ],
      4,
    );
    assert.equal(r.statements.length, 2);
    assert.ok(!r.statements.some((x) => x.error));
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].rows.length, 4);
    assert.deepEqual(r.results[0].columns.map((c) => c.name), ['id']);
    assert.ok(r.results[0].columns[0].numeric, 'id numerisch');
    assert.ok(r.results[0].truncated);
    assert.equal(r.statements[1].rowsAffected, 3);
  });
  await step('Sitzung: Fehler stoppt die Folge', async () => {
    const r = await s.run(
      [
        { sql: 'SELECT 1 AS a', offset: 0 },
        { sql: 'SELECT * FROM gibt_es_nicht', offset: 20 },
        { sql: 'SELECT 2', offset: 40 },
      ],
      100,
    );
    assert.equal(r.statements.length, 2);
    assert.ok(r.statements[1].error);
    assert.equal(r.results.length, 1);
  });
  await step('Sitzung: Prozedur mit mehreren Ergebnissen und Meldungen', async () => {
    const call =
      dialect === 'mysql' ? "CALL kunden_von('Bern')" : dialect === 'mssql' ? "EXEC dbo.kunden_von N'Bern'" : "SELECT public.kunden_anzahl('Bern') AS n";
    const r = await s.run([{ sql: call, offset: 0 }], 100);
    assert.ok(!r.statements[0].error, r.statements[0].error);
    if (dialect === 'postgres') {
      assert.equal(Number(r.results[0].rows[0][0]), 500);
      assert.ok(r.messages.some((m) => m.includes('Bern')), r.messages.join('|'));
    } else {
      assert.equal(r.results.length, 2);
      assert.equal(Number(r.results[1].rows[0][0]), 500);
      if (dialect === 'mssql') assert.ok(r.messages.some((m) => m.includes('Bern')), r.messages.join('|'));
    }
  });
  await step('Sitzung: Transaktion bleibt über Läufe erhalten', async () => {
    // eine Zeile ohne abhängige Daten – ein Kunde scheiterte am Fremdschlüssel, und der Test bewiese nichts
    const t = dialect === 'mssql' ? 'dbo.bestellungen' : dialect === 'mysql' ? 'bestellungen' : 'public.bestellungen';
    const begin = dialect === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN';
    const orders = req({ object: { ...ref, name: 'bestellungen' } });
    const before = await d.countTable(orders);
    const r = await s.run([{ sql: begin, offset: 0 }, { sql: `DELETE FROM ${t} WHERE id = 6000`, offset: 0 }], 1);
    assert.equal(r.statements[1]?.error, undefined, r.statements[1]?.error);
    assert.equal(r.statements[1]?.rowsAffected, 1);
    assert.equal(r.inTransaction, true, 'nach BEGIN und DELETE ist die Transaktion offen');
    // gezählt wird erst danach: SQL Server wartete sonst auf die Sperre der offenen Transaktion
    const back = await s.run([{ sql: 'ROLLBACK', offset: 0 }], 1);
    assert.equal(back.statements[0]?.error, undefined, back.statements[0]?.error);
    assert.equal(back.inTransaction, false);
    assert.equal(await d.countTable(orders), before, 'ROLLBACK im zweiten Lauf nimmt das DELETE des ersten zurück');
  });
  await step('Sitzung: Datenbank wechseln', async () => {
    const other = dialect === 'mssql' ? 'master' : dialect === 'mysql' ? 'mysql' : 'postgres';
    await s.setDatabase(other);
    assert.equal(s.database, other);
    await s.setDatabase('shop');
  });
  await step('Sitzung: Abbrechen', async () => {
    const sleep = dialect === 'mysql' ? 'SELECT SLEEP(20)' : dialect === 'mssql' ? "WAITFOR DELAY '00:00:20'" : 'SELECT pg_sleep(20)';
    const t0 = Date.now();
    const p = s.run([{ sql: sleep, offset: 0 }, { sql: 'SELECT 1', offset: 0 }], 1);
    await new Promise((r) => setTimeout(r, 700));
    await s.cancel();
    const r = await p;
    assert.ok(Date.now() - t0 < 8000, 'Abbruch dauerte zu lange');
    assert.ok(r.cancelled);
    assert.equal(r.statements.length, 1);
    // Sitzung bleibt nutzbar
    const again = await s.run([{ sql: 'SELECT 1 AS x', offset: 0 }], 1);
    assert.ok(!again.statements[0].error, again.statements[0].error);
  });
  await s.close();

  if (dialect === 'mssql') {
    await step('SQL Server: nach stiller Neuverbindung läuft kein Batch (Sitzungskennzeichen)', async () => {
      const sess = await d.openSession('shop');
      try {
        const spid = Number((await sess.run([{ sql: 'SELECT @@SPID', offset: 0 }], 1)).results[0].rows[0][0]);
        await sess.run([{ sql: "UPDATE dbo.kunden SET notiz = NULL WHERE id = 7", offset: 0 }], 1);
        await sess.run([{ sql: 'BEGIN TRANSACTION', offset: 0 }], 1);
        // Verbindung serverseitig beenden: der mssql-Pool baut beim nächsten Mal still eine neue auf
        const admin = await d.openSession('master');
        await admin.run([{ sql: `KILL ${spid}`, offset: 0 }], 1);
        await admin.close();
        await new Promise((r) => setTimeout(r, 500));
        const r = await sess.run([{ sql: "UPDATE dbo.kunden SET notiz = 'ohne Transaktion' WHERE id = 7", offset: 0 }], 1);
        assert.match(r.statements[0].error ?? '', /nicht ausgeführt/, 'Batch muss abgelehnt werden: ' + (r.statements[0].error ?? 'lief'));
        assert.ok(sess.broken);
        const n = await d.countTable(req({ where: "notiz = 'ohne Transaktion'" }));
        assert.equal(n, 0);
      } finally {
        await sess.close();
      }
    });
  }
  await d.close();
}

async function main() {
  assertTestContainers(Object.entries(testdb).map(([name, c]) => ({ name, host: c.host, port: c.port })));
  await splitterTests();
  const only = process.argv[2] as Dialect | undefined;
  for (const dialect of (['mysql', 'postgres', 'mssql'] as Dialect[]).filter((x) => !only || x === only)) {
    try {
      await testDialect(dialect);
    } catch (e) {
      failed++;
      console.log(`  FEHL ${dialect}: ${(e as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
