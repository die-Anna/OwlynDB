/* Reine Logik ohne Datenbank (npm run test:unit): Wächter- und Zerleger-Korrekturen aus der Review (Thema 5):
   shared/sql-guard.ts (readOnlyViolation, riskyStatements, batchHasSeveralStatements) und shared/sql-splitter.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchHasSeveralStatements, readOnlyViolation, riskyStatements } from '../../../shared/sql-guard';
import { splitSql } from '../../../shared/sql-splitter';

const allowed = (sql: string, d: 'mysql' | 'postgres' | 'mssql') => assert.equal(readOnlyViolation(sql, d), null, sql);
const refused = (sql: string, d: 'mysql' | 'postgres' | 'mssql', re?: RegExp) => {
  const why = readOnlyViolation(sql, d);
  assert.ok(why, `müsste abgelehnt werden: ${sql}`);
  if (re) assert.match(why, re, sql);
};

test('Nur lesen: Grundfälle bleiben', () => {
  allowed('SELECT * FROM t', 'mysql');
  allowed("SELECT 1 -- DELETE FROM t\n", 'postgres');
  allowed("SELECT 'DELETE FROM t' AS s", 'mssql');
  allowed('WITH c AS (SELECT 1) SELECT * FROM c', 'postgres');
  refused('DELETE FROM t', 'mysql');
  refused('SELECT * FROM t FOR UPDATE', 'postgres', /UPDATE/);
  refused('SELECT * INTO x FROM t', 'mssql', /INTO/);
  refused("SELECT nextval('s')", 'postgres', /nextval/);
});

test('F175: MySQL führt /*! … */ und /*M! … */ aus – der Inhalt wird geprüft', () => {
  refused('/*!50000 INSERT INTO t VALUES (1) */', 'mysql', /INSERT|erlaubt/);
  refused('SELECT 1 /*! INTO OUTFILE "/tmp/x" */ FROM t', 'mysql', /INTO/);
  refused('/*M!100000 DELETE FROM t */', 'mysql');
  refused("SELECT /*! GET_LOCK('a', 10) */", 'mysql', /get_lock/);
  // ein gewöhnlicher Kommentar bleibt ein Kommentar
  allowed('SELECT 1 /* INSERT INTO t */ FROM t', 'mysql');
});

test("F177/F308: PostgreSQL E'…' mit Backslash, $tag$ nur frei stehend; MySQL-Backticks ohne Backslash-Escape", () => {
  refused("SELECT E'\\'' , nextval('s')", 'postgres', /nextval/);
  refused("SELECT E'a\\'b', 1 FROM t FOR UPDATE", 'postgres', /UPDATE/);
  allowed("SELECT E'Zeile\\nUmbruch' FROM t", 'postgres');
  // a$q$ ist ein Bezeichner, kein Dollar-Quote
  refused('SELECT a$q$ FROM t FOR UPDATE', 'postgres', /UPDATE/);
  // Bezeichner `a\` endet am Backtick: was danach kommt, wird geprüft
  refused('SELECT `a\\` FROM t INTO OUTFILE "x"', 'mysql', /INTO/);
});

test('F178: Funktionen mit Nebenwirkung auch in Anführungszeichen und schemaqualifiziert', () => {
  refused('SELECT "pg_terminate_backend"(123)', 'postgres', /pg_terminate_backend/);
  refused('SELECT pg_catalog."set_config"(\'x\', \'y\', false)', 'postgres', /set_config/);
  refused('SELECT "NEXTVAL"(\'s\')', 'postgres');
  // eine Spalte, die nur so heißt, ist kein Aufruf
  allowed('SELECT "nextval" FROM t', 'postgres');
});

test('F181: SQL Server liest Schlüsselwörter direkt hinter einer Zahl als eigenes Token', () => {
  refused('SELECT 1DELETE FROM t', 'mssql', /DELETE/);
  refused('SELECT 1KILL 55', 'mssql', /KILL/);
  refused('SELECT 1 WHERE 1=1DBCC FREEPROCCACHE', 'mssql', /DBCC/);
  allowed('SELECT 1AS x', 'mssql');
});

test('F182/F313: SET nur für eigene Variablen – jede Zuweisung der Liste; CHARACTER SET ist keine Zuweisung', () => {
  allowed('SET @a = 1', 'mysql');
  allowed('SET @a = 1, @b := (SELECT COUNT(*) FROM t)', 'mysql');
  refused('SET @a = 1, GLOBAL max_connections = 1', 'mysql', /SET/);
  refused('SET @a = 1, @@session.sql_mode = \'\'', 'mysql', /SET/);
  refused('SET @a = 1, sql_mode = \'\'', 'mysql', /SET/);
  refused('SET GLOBAL x = 1', 'mysql');
  refused('SET @@x = 1', 'mysql');
  allowed('SHOW CHARACTER SET', 'mysql');
  allowed("SELECT CAST(name AS CHAR CHARACTER SET utf8mb4) FROM t", 'mysql');
  allowed('DECLARE @x int\nSET @x = 1\nSELECT @x', 'mssql');
  refused('DECLARE @x int\nSET NOCOUNT ON\nSELECT 1', 'mssql', /SET/);
});

test('F312: weitere pg_*-Funktionen mit Nebenwirkung', () => {
  refused('SELECT pg_try_advisory_lock(1)', 'postgres', /pg_try_advisory_lock/);
  refused('SELECT pg_try_advisory_xact_lock(1)', 'postgres');
  refused('SELECT pg_stat_reset()', 'postgres', /pg_stat_reset/);
  refused('SELECT pg_stat_reset_shared(\'bgwriter\')', 'postgres');
  allowed('SELECT pg_sleep(1)', 'postgres');
  allowed('SELECT pg_advisory_lock_count FROM t', 'postgres');
});

test('F179/F309/F310: riskyStatements – Wortgrenzen, WHERE hinter Unterabfragen, Upserts und TRUNCATE()', () => {
  const risky = (sql: string, d: 'mysql' | 'postgres' | 'mssql' = 'mssql') => riskyStatements([sql], d);
  // nach einem Wort, das auf ON/FOR endet, ist DELETE trotzdem eine Anweisung
  assert.equal(risky('SELECT * FROM region\nDELETE FROM t').length, 1);
  assert.equal(risky("SELECT 1 AS person\nUPDATE t SET a = 1").length, 1);
  // WHERE der äußeren Anweisung hinter einer Unterabfrage
  assert.equal(risky('UPDATE t SET a = (SELECT MAX(x) FROM u) WHERE id = 1').length, 0);
  assert.equal(risky('DELETE FROM t WHERE id IN (SELECT id FROM u)').length, 0);
  assert.equal(risky('UPDATE t SET a = (SELECT MAX(x) FROM u WHERE u.y = 1)').length, 1, 'WHERE nur in der Unterabfrage');
  // keine Fehlalarme
  assert.equal(risky("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1", 'mysql').length, 0);
  assert.equal(risky('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1', 'postgres').length, 0);
  assert.equal(risky('MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN UPDATE SET a = 1 WHEN NOT MATCHED THEN DELETE').length, 0);
  assert.equal(risky('GRANT UPDATE, DELETE ON t TO x').length, 0);
  assert.equal(risky('SELECT TRUNCATE(1.234, 2)', 'mysql').length, 0);
  assert.equal(risky('TRUNCATE TABLE t', 'mysql').length, 1);
  assert.equal(risky('SELECT * FROM t FOR UPDATE', 'postgres').length, 0);
  assert.equal(risky("SELECT 'DROP TABLE t'", 'mysql').length, 0);
});

test('F311: batchHasSeveralStatements – INSERT … SELECT und CREATE VIEW AS SELECT sind eine Anweisung', () => {
  assert.equal(batchHasSeveralStatements('INSERT INTO t (a)\nSELECT a FROM u', 'mssql'), false);
  assert.equal(batchHasSeveralStatements('CREATE VIEW v AS\nSELECT a FROM u', 'mssql'), false);
  assert.equal(batchHasSeveralStatements('SELECT 1\nUNION ALL\nSELECT 2', 'mssql'), false);
  assert.equal(batchHasSeveralStatements('SELECT a FROM (\nSELECT 1 AS a\n) x', 'mssql'), false);
  assert.equal(batchHasSeveralStatements('SELECT 1\nDELETE FROM t', 'mssql'), true);
  assert.equal(batchHasSeveralStatements('DELETE FROM t\nSELECT 1', 'mssql'), true);
  assert.equal(batchHasSeveralStatements('SELECT 1\nSELECT 2', 'mssql'), false);
});

test('F183: GO mit Kommentar trennt, GO n liefert die Wiederholung', () => {
  const s = splitSql('SELECT 1\nGO -- erster\nSELECT 2\nGO 3\nSELECT 3\nGO /* x */\n', 'mssql');
  assert.deepEqual(
    s.map((x) => [x.sql, x.repeat ?? 1]),
    [
      ['SELECT 1', 1],
      ['SELECT 2', 3],
      ['SELECT 3', 1],
    ],
  );
});

test('F185: PostgreSQL – „;“ in Klammern und in BEGIN ATOMIC … END trennt nicht', () => {
  const fn = 'CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a; SELECT CASE WHEN a > 1 THEN 1 ELSE 0 END; END;';
  assert.deepEqual(
    splitSql(`${fn}\nSELECT f(1);`, 'postgres').map((x) => x.sql),
    [fn.replace(/;$/, ''), 'SELECT f(1)'],
  );
  assert.deepEqual(
    splitSql("SELECT (SELECT 'a;b' AS x);\nSELECT 2", 'postgres').map((x) => x.sql),
    ["SELECT (SELECT 'a;b' AS x)", 'SELECT 2'],
  );
  // BEGIN allein ist der Transaktionsbeginn
  assert.deepEqual(splitSql('BEGIN; SELECT 1; COMMIT;', 'postgres').map((x) => x.sql), ['BEGIN', 'SELECT 1', 'COMMIT']);
});

test("F314: E-Präfix nur, wenn das E allein steht; MySQL-Backticks ohne Backslash", () => {
  assert.deepEqual(splitSql("SELECT name'x\\'; SELECT 2", 'postgres').map((x) => x.sql), ["SELECT name'x\\'", 'SELECT 2']);
  assert.deepEqual(splitSql("SELECT E'a\\'b;c'; SELECT 2", 'postgres').map((x) => x.sql), ["SELECT E'a\\'b;c'", 'SELECT 2']);
  assert.deepEqual(splitSql('SELECT `a\\`; SELECT 2', 'mysql').map((x) => x.sql), ['SELECT `a\\`', 'SELECT 2']);
});

test('F186: isOnlyComments ohne Zeichenkettenaufbau – große Dateien zerlegen in akzeptabler Zeit', () => {
  const big = Array.from({ length: 20000 }, (_, i) => `INSERT INTO t VALUES (${i}, '${'x'.repeat(200)}');`).join('\n');
  const t0 = Date.now();
  const s = splitSql(big, 'mysql');
  assert.equal(s.length, 20000);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});
