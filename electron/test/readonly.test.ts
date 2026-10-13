/* Nur-lesen-Modus gegen die Test-Datenbanken (npm run testdb:up, Seeds aus npm run test:drivers).
   Aufruf: npm run test:readonly */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, SqlDialect } from '../../shared/api-types';
import { readOnlyViolation } from '../../shared/sql-guard';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-ro-')), 'c.json'), {
  encrypt: (s) => 'x' + s,
  decrypt: (s) => s.slice(1),
});

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

const targets: Record<SqlDialect, { port: number; user: string; password: string; t: string; begin: string }> = {
  mysql: { port: 15306, user: 'root', password: 'dbviewer-test', t: 'ro_test', begin: 'START TRANSACTION' },
  postgres: { port: 15432, user: 'postgres', password: 'dbviewer-test', t: 'public.ro_test', begin: 'BEGIN' },
  mssql: { port: 15433, user: 'sa', password: 'Dbviewer-Test1', t: 'dbo.ro_test', begin: 'BEGIN TRANSACTION' },
};

function input(dialect: SqlDialect, readOnly: boolean): ConnectionInput {
  const t = targets[dialect];
  return {
    name: `${dialect}${readOnly ? ' ro' : ''}`,
    dialect,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    password: t.password,
    database: 'shop',
    options: { readOnly, ...(dialect === 'mssql' ? { trustServerCertificate: true } : {}) },
  };
}

const m = new Manager(store, undefined, 0);

async function run(sessionId: string, sql: string) {
  return m.runQuery(sessionId, [{ sql, offset: 0 }], 100);
}
async function value(sessionId: string, sql: string): Promise<unknown> {
  const r = await run(sessionId, sql);
  if (r.statements[0]?.error) throw new Error(r.statements[0].error);
  return r.results[0].rows[0][0];
}
async function refused(sessionId: string, sql: string, pattern = /Nur lesen|read.only|READ ONLY/i) {
  const r = await run(sessionId, sql);
  const err = r.statements[0]?.error;
  assert.ok(err, `hätte abgelehnt werden müssen: ${sql}`);
  assert.match(err, pattern);
  assert.equal(r.inTransaction, false, 'danach keine offene Transaktion');
}

function guardChecks() {
  console.log('\nPrüfung vor dem Senden');
  const allow: [SqlDialect, string][] = [
    ['mysql', 'SELECT id, created_at, comment, start FROM t WHERE x = \'DELETE FROM y\''],
    ['mysql', 'SHOW TABLES'],
    ['mysql', '  -- Kommentar\n  (SELECT 1) UNION (SELECT 2)'],
    ['mysql', 'SET @x = 5'],
    ['postgres', 'WITH a AS (SELECT 1) SELECT * FROM a'],
    ['postgres', 'EXPLAIN ANALYZE SELECT * FROM t'],
    ['postgres', "SELECT $$ DROP TABLE x $$, 'INSERT'"],
    ['mssql', 'DECLARE @n int = 3\nSELECT TOP (@n) start, [update] FROM t'],
    ['mssql', 'SELECT * FROM t; SELECT 2'],
  ];
  const deny: [SqlDialect, string][] = [
    ['mysql', 'INSERT INTO t VALUES (1)'],
    ['mysql', 'SELECT * INTO OUTFILE \'/tmp/x\' FROM t'],
    ['mysql', 'SELECT * FROM t FOR UPDATE'],
    ['mysql', 'SET SESSION transaction_read_only = 0'],
    ['mysql', 'SET @@session.sql_mode = \'\''],
    ['mysql', 'SELECT GET_LOCK(\'x\', 1)'],
    ['mysql', 'CALL p()'],
    ['mysql', 'COMMIT'],
    ['postgres', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
    ['postgres', 'SELECT * INTO neu FROM t'],
    ['postgres', 'SELECT nextval(\'s\')'],
    ['postgres', 'SELECT pg_terminate_backend(123)'],
    ['postgres', 'SELECT set_config(\'default_transaction_read_only\', \'off\', false)'],
    ['postgres', 'SELECT 1; DELETE FROM t'],
    ['postgres', 'SET default_transaction_read_only = off'],
    ['postgres', 'COPY t TO \'/tmp/x\''],
    ['mssql', 'SELECT 1\nDELETE FROM t'],
    ['mssql', 'SELECT * INTO #neu FROM t'],
    ['mssql', 'EXEC sp_who'],
    ['mssql', 'sp_configure'],
    ['mssql', 'SELECT 1 COMMIT'],
    ['mssql', 'SELECT * FROM OPENROWSET(\'SQLNCLI\', \'x\', \'SELECT 1\')'],
    ['mssql', 'SET NOCOUNT ON'],
    ['mssql', 'SELECT NEXT VALUE FOR s'],
  ];
  return Promise.all([
    step(`${allow.length} lesende Anweisungen erlaubt`, () => {
      for (const [d, sql] of allow) assert.equal(readOnlyViolation(sql, d), null, `${d}: ${sql}`);
    }),
    step(`${deny.length} schreibende/steuernde Anweisungen abgelehnt`, () => {
      for (const [d, sql] of deny) assert.ok(readOnlyViolation(sql, d), `${d}: ${sql} wurde nicht abgelehnt`);
    }),
  ]);
}

async function main() {
  assertTestContainers(Object.entries(targets).map(([name, t]) => ({ name, host: '127.0.0.1', port: t.port })));
  await guardChecks();

  for (const dialect of ['mysql', 'postgres', 'mssql'] as const) {
    console.log(`\n${dialect}`);
    const { t, begin } = targets[dialect];
    const rw = await store.save(input(dialect, false));
    const ro = await store.save(input(dialect, true));
    const { sessionId: w } = await m.openSession(rw.id, 'shop');
    const { sessionId: r } = await m.openSession(ro.id, 'shop');
    // eigene Probetabelle
    for (const sql of [
      dialect === 'mssql' ? `IF OBJECT_ID('${t}') IS NOT NULL DROP TABLE ${t}` : `DROP TABLE IF EXISTS ${t}`,
      `CREATE TABLE ${t} (id int PRIMARY KEY, notiz varchar(50))`,
      `INSERT INTO ${t} (id) VALUES (1), (2), (3)`,
    ]) {
      const p = await run(w, sql);
      if (p.statements[0].error) throw new Error(p.statements[0].error);
    }
    const count = Number(await value(w, `SELECT COUNT(*) FROM ${t}`));

    await step('SELECT läuft, danach keine offene Transaktion', async () => {
      assert.equal(Number(await value(r, `SELECT COUNT(*) FROM ${t}`)), count);
      assert.equal((await m.sessionState(r)).inTransaction, false);
    });
    await step('INSERT/UPDATE/DELETE: abgelehnt, nichts ausgeführt', async () => {
      await refused(r, `DELETE FROM ${t}`);
      await refused(r, `UPDATE ${t} SET notiz = 'ro' WHERE id = 3`);
      await refused(r, `INSERT INTO ${t} (id, notiz) VALUES (999999, 'ro')`);
      assert.equal(Number(await value(w, `SELECT COUNT(*) FROM ${t}`)), count);
    });
    await step('mehrere Anweisungen: eine verbotene stoppt alle, auch die erlaubten davor', async () => {
      const res = await m.runQuery(
        r,
        [
          { sql: `SELECT 1`, offset: 0 },
          { sql: `DELETE FROM ${t} WHERE id = 3`, offset: 10 },
        ],
        10,
      );
      assert.equal(res.results.length, 0);
      assert.equal(res.statements.length, 1);
      assert.equal(res.statements[0].statementIndex, 1);
    });

    if (dialect === 'mysql') {
      await step('Server-Schicht: Funktion, die schreibt, scheitert an READ ONLY', async () => {
        await run(w, 'DROP FUNCTION IF EXISTS ro_probe');
        const c = await run(
          w,
          `CREATE FUNCTION ro_probe() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE ro_test SET notiz = 'ro' WHERE id = 3; RETURN 1; END`,
        );
        assert.ok(!c.statements[0].error, c.statements[0].error);
        await refused(r, 'SELECT ro_probe()', /read.only|READ ONLY/i);
        assert.equal(await value(w, `SELECT notiz FROM ${t} WHERE id = 3`), null);
      });
      await step('eigene Variablen gehen', async () => {
        await run(r, 'SET @x = 41');
        assert.equal(Number(await value(r, 'SELECT @x + 1')), 42);
      });
    }
    if (dialect === 'postgres') {
      await step('Server-Schicht: Funktion, die schreibt, scheitert an READ ONLY', async () => {
        const c = await run(
          w,
          `CREATE OR REPLACE FUNCTION ro_probe() RETURNS int LANGUAGE sql AS $$ UPDATE public.ro_test SET notiz = 'ro' WHERE id = 3 RETURNING 1 $$`,
        );
        assert.ok(!c.statements[0].error, c.statements[0].error);
        await refused(r, 'SELECT ro_probe()', /read-only/i);
        assert.equal(await value(w, `SELECT notiz FROM ${t} WHERE id = 3`), null);
        // Sitzung danach weiter nutzbar (abgebrochene Transaktion wurde zurückgerollt)
        assert.equal(Number(await value(r, 'SELECT 1')), 1);
      });
    }
    if (dialect === 'mssql') {
      await step('Server-Schicht: jede Ausführung läuft in einer Transaktion, danach @@TRANCOUNT = 0', async () => {
        assert.equal(Number(await value(r, 'SELECT @@TRANCOUNT')), 1);
        assert.equal((await m.sessionState(r)).inTransaction, false);
      });
    }

    await step('Umschalten mit offenem Tab: gilt sofort; alte Transaktion nur per ROLLBACK', async () => {
      await run(w, begin);
      const u = await run(w, `UPDATE ${t} SET notiz = 'vor dem Umschalten' WHERE id = 3`);
      assert.ok(u.inTransaction, 'Transaktion offen');
      await m.saveConnection({ ...input(dialect, true), id: rw.id });
      const blocked = await run(w, 'SELECT 1');
      assert.match(blocked.statements[0].error ?? '', /nur ROLLBACK/);
      // COMMIT ist nicht erlaubt (Änderung bleibt unbestätigt)
      assert.match((await run(w, 'COMMIT')).statements[0].error ?? '', /nur ROLLBACK/);
      const rb = await run(w, 'ROLLBACK');
      assert.ok(!rb.statements[0].error && !rb.inTransaction, rb.statements[0].error);
      assert.equal(Number(await value(w, 'SELECT 1')), 1);
      await refused(w, `UPDATE ${t} SET notiz = 'x' WHERE id = 3`);
      await m.saveConnection({ ...input(dialect, false), id: rw.id });
      assert.equal(await value(w, `SELECT notiz FROM ${t} WHERE id = 3`), null);
    });

    await m.closeSession(w);
    await m.closeSession(r);
  }

  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
