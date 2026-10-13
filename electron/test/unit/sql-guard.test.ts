/* Reine Logik ohne Datenbank (npm run test:unit): SQL-Wächter in shared/sql-guard.ts – Nur-lesen je Wortliste und
   Dialekt, Rückfrage vor riskanten Anweisungen, mehrere Anweisungen im Batch, erneutes Ausführen, stoppableResults */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dialect } from '../../../shared/api-types';
import { batchHasSeveralStatements, readOnlyViolation, rerunBlocker, riskyStatements, stoppableResults } from '../../../shared/sql-guard';

const allowed = (d: Dialect, list: string[]) => {
  for (const sql of list) assert.equal(readOnlyViolation(sql, d), null, `${d}: ${sql}`);
};
const refused = (d: Dialect, list: string[], re?: RegExp) => {
  for (const sql of list) {
    const why = readOnlyViolation(sql, d);
    assert.ok(why, `${d}: müsste abgelehnt werden: ${sql}`);
    if (re) assert.match(why, re, `${d}: ${sql}`);
  }
};

test('Nur lesen: jede erlaubte Anfangsform je Dialekt', () => {
  allowed('mysql', [
    'SELECT 1',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    'SHOW TABLES',
    'EXPLAIN SELECT * FROM t',
    'DESCRIBE t',
    'DESC t',
    'USE shop',
    'TABLE t',
    'VALUES ROW(1), ROW(2)',
    'SET @a = 1',
    '(SELECT 1) UNION (SELECT 2)',
    'select 1;',
    'SELECT 1;;',
    '  -- Kommentar\nSELECT 1',
  ]);
  allowed('postgres', ['SELECT 1', 'WITH c AS (SELECT 1) SELECT * FROM c', 'SHOW search_path', 'EXPLAIN SELECT 1', 'TABLE t', 'VALUES (1), (2)', 'SELECT 1;;']);
  allowed('mssql', ['SELECT 1', 'WITH c AS (SELECT 1) SELECT * FROM c', 'USE shop', 'DECLARE @x int', 'SET @x = 1', 'SELECT 1;']);
  allowed('elasticsearch', ['SELECT * FROM idx', 'SHOW TABLES', 'DESCRIBE idx', 'DESC idx', 'SYS COLUMNS']);
  // leer bzw. nur Kommentare: nichts zu prüfen
  for (const d of ['mysql', 'postgres', 'mssql'] as const) allowed(d, ['', '  ', ';', '/* nur Kommentar */', '-- x\n']);
});

test('Nur lesen: alles andere am Anfang wird abgelehnt', () => {
  refused(
    'mysql',
    ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'CREATE TABLE t (a int)', 'DROP TABLE t', 'ALTER TABLE t ADD c int']
      .concat(['TRUNCATE t', 'RENAME TABLE a TO b', 'GRANT SELECT ON *.* TO x', 'CALL p()', 'DO SLEEP(1)', "LOAD DATA INFILE 'x' INTO TABLE t", 'HANDLER t OPEN'])
      .concat(['LOCK TABLES t WRITE', 'FLUSH TABLES', 'KILL 5', 'START TRANSACTION', 'BEGIN', 'COMMIT', 'PREPARE s FROM @q', 'EXECUTE s', 'ANALYZE TABLE t'])
      .concat(['OPTIMIZE TABLE t', "SET NAMES 'latin1'", 'SET sql_mode = 0', 'SET GLOBAL x = 1', 'SET @@x = 1', 'XA START 1', 'INSTALL PLUGIN p SONAME "x"']),
    /erlaubt|SET/,
  );
  refused(
    'postgres',
    ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE', 'CREATE TABLE t (a int)']
      .concat(['DROP TABLE t', 'ALTER TABLE t ADD c int', 'TRUNCATE t', "COPY t TO '/tmp/x'", 'CALL p()', 'DO $$ BEGIN END $$', 'LOCK TABLE t'])
      .concat(['VACUUM t', 'ANALYZE t', 'CLUSTER t', 'REINDEX TABLE t', 'REFRESH MATERIALIZED VIEW v', "COMMENT ON TABLE t IS 'x'", 'GRANT SELECT ON t TO x'])
      .concat(['LISTEN c', "NOTIFY c, 'x'", 'PREPARE s AS SELECT 1', 'EXECUTE s', 'DISCARD ALL', 'RESET ALL', 'SET search_path = x', 'BEGIN', 'CHECKPOINT'])
      .concat(['DECLARE c CURSOR FOR SELECT 1', 'FETCH c', "IMPORT FOREIGN SCHEMA s FROM SERVER x INTO y", 'SECURITY LABEL ON TABLE t IS NULL']),
    /erlaubt|SET/,
  );
  refused(
    'mssql',
    ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'MERGE t USING u ON 1 = 1 WHEN MATCHED THEN DELETE;', 'CREATE TABLE t (a int)']
      .concat(['DROP TABLE t', 'ALTER TABLE t ADD c int', 'TRUNCATE TABLE t', 'EXEC sp_who', 'EXECUTE sp_who', 'sp_who', 'GRANT SELECT ON t TO x'])
      .concat(['DENY SELECT ON t TO x', "BACKUP DATABASE d TO DISK = 'x'", 'DBCC CHECKDB', 'KILL 55', 'SHUTDOWN', 'CHECKPOINT', 'RECONFIGURE', 'BEGIN TRAN'])
      .concat(['COMMIT', "BULK INSERT t FROM 'x'", "PRINT 'x'", "WAITFOR DELAY '00:00:01'", 'SET NOCOUNT ON', 'UPDATE STATISTICS t', 'OPEN c']),
    /erlaubt|SET/,
  );
  refused('elasticsearch', ['DELETE FROM idx', 'INSERT INTO idx VALUES (1)', 'UPDATE idx SET a = 1', 'DROP TABLE idx']);
});

test('Nur lesen: was in einer erlaubten Anweisung noch schreibt oder sperrt (WRITE_WORDS)', () => {
  refused('mysql', ['WITH c AS (SELECT 1) DELETE FROM t', 'WITH c AS (SELECT 1) UPDATE t SET a = 1', 'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR UPDATE SKIP LOCKED']);
  refused('mysql', ['SELECT * FROM t FOR SHARE', 'SELECT * FROM t LOCK IN SHARE MODE', 'SELECT 1 INTO @x', "SELECT * FROM t INTO OUTFILE '/tmp/x'"]);
  refused('mysql', ["SELECT * INTO DUMPFILE '/tmp/x' FROM t", 'EXPLAIN DELETE FROM t', "TABLE t INTO OUTFILE '/tmp/x'", 'SET @a = (SELECT a FROM t FOR UPDATE)']);
  // F176: MySQL führt /*! … */ aus
  refused('mysql', ["SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", "SELECT /*!50000 GET_LOCK('x', 1) */ 1", 'SELECT * FROM t WHERE 1 /*! FOR UPDATE */']);
  refused('postgres', ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT 1']);
  refused('postgres', ['WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1', 'WITH x AS (SELECT 1) MERGE INTO t USING x ON true WHEN MATCHED THEN DELETE']);
  refused('postgres', ['SELECT * INTO neu FROM t', 'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR NO KEY UPDATE', 'SELECT * FROM t FOR SHARE']);
  refused('postgres', ['SELECT * FROM t FOR KEY SHARE', 'EXPLAIN ANALYZE DELETE FROM t', 'SELECT 1; DELETE FROM t', 'SELECT 1; SELECT 2']);
  // SQL Server: ein Batch kann weitere Anweisungen ohne ";" enthalten – jedes Wort der Liste einzeln
  const mssql = ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'MERGE t USING u ON 1 = 1 WHEN MATCHED THEN DELETE;', 'SELECT * INTO #x FROM t']
    .concat(['DROP TABLE t', 'TRUNCATE TABLE t', 'ALTER TABLE t ADD c int', 'CREATE TABLE #t (a int)', 'EXEC sp_who', 'EXECUTE sp_who', 'GRANT SELECT ON t TO x'])
    .concat(['REVOKE SELECT ON t FROM x', 'DENY SELECT ON t TO x', 'COMMIT', 'ROLLBACK', 'KILL 55', 'SHUTDOWN', "BACKUP DATABASE d TO DISK = 'x'"])
    .concat(["RESTORE DATABASE d FROM DISK = 'x'", 'DBCC FREEPROCCACHE', "BULK INSERT t FROM 'x'", 'RECONFIGURE', "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')"])
    .concat(["SELECT * FROM OPENDATASOURCE('SQLNCLI', 'x').d.dbo.t", "SELECT * FROM OPENQUERY(srv, 'SELECT 1')", 'CHECKPOINT', 'UPDATETEXT t.c @p 0 NULL'])
    .concat(["WRITETEXT t.c @p 'x'", 'BEGIN TRAN', 'BEGIN TRANSACTION', 'BEGIN DISTRIBUTED TRANSACTION', 'SAVE TRAN s', 'SAVE TRANSACTION s'])
    .concat(['ENABLE TRIGGER tr ON t', 'DISABLE TRIGGER tr ON t', 'SEND ON CONVERSATION @h', 'RECEIVE * FROM q']);
  refused('mssql', mssql.map((s) => `DECLARE @h int\nSELECT 1\n${s}`), /erlaubt/);
  // Sperrhinweise halten Sperren bis zum Ende der Transaktion – wie FOR UPDATE/FOR SHARE bei MySQL und PostgreSQL
  refused('mssql', ['SELECT * FROM t WITH (UPDLOCK)', 'SELECT * FROM t WITH (XLOCK, ROWLOCK)', 'SELECT * FROM t (TABLOCKX)', 'SELECT * FROM t WITH (HOLDLOCK)']);
  refused('mssql', ['SELECT * FROM t WITH (SERIALIZABLE)', 'SELECT * FROM t WITH (REPEATABLEREAD)'], /erlaubt/);
  allowed('mssql', ['SELECT * FROM t WITH (NOLOCK)', 'SELECT * FROM t WITH (READPAST)', 'SELECT * FROM t (NOLOCK)']);
  refused('elasticsearch', ['SELECT * FROM idx WHERE a IN (SELECT 1) INTO x']);
});

test('Nur lesen: jede Funktion mit Nebenwirkung (SIDE_EFFECT_FUNCTIONS)', () => {
  const pg = ['pg_terminate_backend(1)', 'pg_cancel_backend(1)', 'pg_reload_conf()', 'pg_rotate_logfile()', 'pg_switch_wal()', 'pg_promote()']
    .concat(["pg_create_restore_point('x')", "pg_drop_replication_slot('s')", "pg_file_write('x', 'y', false)", 'pg_advisory_lock(1)', 'pg_try_advisory_lock(1)'])
    .concat(["pg_replication_origin_create('o')", "pg_notify('c', 'x')", "pg_logical_slot_get_changes('s', NULL, NULL)", 'pg_stat_reset()'])
    .concat(["pg_backup_start('x')", "pg_start_backup('x')", 'pg_stop_backup()', 'pg_import_system_collations(1)', "pg_copy_physical_replication_slot('a', 'b')"])
    .concat(['pg_wal_replay_pause()', 'pg_xlog_replay_pause()', "brin_summarize_new_values('i')", "brin_desummarize_range('i', 1)", "gin_clean_pending_list('i')"])
    .concat(["set_config('a', 'b', false)", "nextval('s')", "setval('s', 1)", "lo_import('/x')", "lo_unlink(1)", "dblink_exec('x', 'DELETE FROM t')", 'pg_catalog.pg_cancel_backend(1)']);
  refused('postgres', pg.map((f) => `SELECT ${f}`), /Nebenwirkungen/);
  refused('mysql', ["SELECT GET_LOCK('a', 1)", "SELECT RELEASE_LOCK('a')", 'SELECT RELEASE_ALL_LOCKS()', 'SELECT NEXTVAL(s)', 'SELECT SETVAL(s, 1)'], /Nebenwirkungen/);
  refused('mysql', ['SELECT NEXT VALUE FOR s'], /Nebenwirkungen/);
  refused('mssql', ['SELECT NEXT VALUE FOR s'], /Nebenwirkungen/);
  // lesen allein ist erlaubt (auch Funktionen mit ähnlichem Namen)
  allowed('postgres', ["SELECT currval('s')", 'SELECT pg_sleep(0)', 'SELECT pg_backend_pid()', 'SELECT pg_is_in_recovery()', 'SELECT pg_size_pretty(1)', "SELECT pg_get_functiondef('f'::regproc)"]);
  allowed('mysql', ["SELECT IS_FREE_LOCK('a')", 'SELECT SLEEP(0)', 'SELECT LASTVAL(s)']);
});

test('Nur lesen: Bezeichner, Zeichenketten und Kommentare, die nur so heißen', () => {
  allowed('mysql', ['SELECT updated_at, deleted, insert_id FROM t', 'SELECT `update`, `into` FROM t', "SELECT 'DELETE FROM t'", "SELECT 'a\\'; DELETE FROM t'"]);
  allowed('mysql', ['SELECT 1 -- ; DELETE FROM t', 'SELECT 1 # DELETE FROM t', 'SELECT 1 /* INTO OUTFILE */', 'SELECT "into" FROM t']);
  allowed('postgres', ['SELECT "update", "into" FROM t', "SELECT E'it\\'s INSERT done'", "SELECT $$ DELETE FROM t $$", "SELECT $x$ UPDATE $x$"]);
  allowed('postgres', ['/* DELETE /* verschachtelt */ UPDATE */ SELECT 1', 'SELECT nextval_x FROM t', 'SELECT 1 AS "nextval"']);
  allowed('mssql', ['SELECT [update], [into], [delete] FROM t', "SELECT N'DELETE FROM t'", 'SELECT 1 /* DROP /* x */ TABLE */', 'SELECT drop_date FROM t']);
  // ein Wort in Klammern-Bezeichnern einer anderen Datenbank zählt nicht, das Schlüsselwort selbst schon
  refused('mssql', ['SELECT [a] FROM t\nDROP TABLE t']);
});

test('riskyStatements: DELETE/UPDATE ohne WHERE, DROP, TRUNCATE – je Dialekt, mit Unterabfragen, CTE und Batches', () => {
  const risky = (sql: string, d: Dialect) => riskyStatements([sql], d).length;
  for (const d of ['mysql', 'postgres', 'mssql'] as const) {
    assert.equal(risky('DELETE FROM t', d), 1, d);
    assert.equal(risky('UPDATE t SET a = 1', d), 1, d);
    assert.equal(risky('DELETE FROM t WHERE id = 1', d), 0, d);
    assert.equal(risky('UPDATE t SET a = 1 WHERE id = 1', d), 0, d);
    assert.equal(risky('DROP TABLE t', d), 1, d);
    assert.equal(risky('ALTER TABLE t DROP COLUMN c', d), 1, `${d}: Spalte löschen`);
    assert.equal(risky('TRUNCATE TABLE t', d), 1, d);
    assert.equal(risky('UPDATE t SET a = 1 -- WHERE id = 1', d), 1, `${d}: WHERE nur im Kommentar`);
    assert.equal(risky("UPDATE t SET a = 'WHERE'", d), 1, `${d}: WHERE nur in der Zeichenkette`);
    assert.equal(risky('UPDATE t SET a = (SELECT MAX(x) FROM u WHERE u.id = t.id) WHERE id = 1', d), 0, d);
    assert.equal(risky('UPDATE t SET a = (SELECT MAX(x) FROM u WHERE u.id = t.id)', d), 1, `${d}: WHERE nur in der Unterabfrage`);
    assert.equal(risky('WITH x AS (SELECT 1 AS id) DELETE FROM t', d), 1, `${d}: CTE`);
    assert.equal(risky('WITH x AS (SELECT 1 AS id) DELETE FROM t WHERE id IN (SELECT id FROM x)', d), 0, `${d}: CTE mit WHERE`);
    assert.equal(risky('CREATE TABLE t (a int REFERENCES u (id) ON UPDATE CASCADE ON DELETE SET NULL)', d), 0, `${d}: Fremdschlüssel-Regeln`);
    assert.equal(risky('ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id) ON DELETE CASCADE', d), 0, d);
    assert.equal(risky('SELECT * FROM t; INSERT INTO t VALUES (1); CREATE INDEX i ON t (a)', d), 0, d);
    assert.equal(risky('GRANT UPDATE, DELETE ON t TO x', d), 0, d);
    assert.equal(risky("SELECT 'DROP TABLE t' AS x -- TRUNCATE t", d), 0, d);
  }
  // MySQL: Mehrtabellen-DELETE/UPDATE
  assert.equal(risky('DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id', 'mysql'), 1);
  assert.equal(risky('DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id WHERE t2.x = 1', 'mysql'), 0);
  assert.equal(risky('UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.a = t2.a', 'mysql'), 1);
  assert.equal(risky('CREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW SET NEW.a = 1', 'mysql'), 0, 'Trigger-Kopf');
  // PostgreSQL: Trigger-Kopf, DELETE … USING
  assert.equal(risky('CREATE TRIGGER tr BEFORE INSERT OR UPDATE OR DELETE ON t FOR EACH ROW EXECUTE FUNCTION f()', 'postgres'), 0);
  assert.equal(risky('CREATE TRIGGER tr AFTER UPDATE OF a ON t FOR EACH ROW EXECUTE FUNCTION f()', 'postgres'), 0);
  assert.equal(risky('DELETE FROM t USING u WHERE t.id = u.id', 'postgres'), 0);
  assert.equal(risky('UPDATE t SET a = u.a FROM u WHERE t.id = u.id', 'postgres'), 0);
  // SQL Server: Batch ohne ";", Mehrtabellen-DELETE mit abgeleiteter Tabelle, Trigger-Kopf
  assert.equal(risky('SELECT * FROM region\nDELETE FROM kunden', 'mssql'), 1);
  assert.equal(risky('SELECT * FROM t\nUPDATE t SET a = 1\nWHERE id = 1', 'mssql'), 0);
  assert.equal(risky('DELETE t FROM t JOIN (SELECT id FROM u) s ON s.id = t.id WHERE s.id > 1', 'mssql'), 0);
  assert.equal(risky('UPDATE t SET a = 1 FROM t JOIN u ON u.id = t.id WHERE u.x = 1', 'mssql'), 0);
  assert.equal(risky('DELETE FROM t OUTPUT deleted.* WHERE id = 1', 'mssql'), 0);
  assert.equal(risky('CREATE TRIGGER tr ON t INSTEAD OF DELETE AS SELECT 1', 'mssql'), 0);
  assert.equal(risky('CREATE TRIGGER tr ON t AFTER INSERT, UPDATE AS SELECT 1', 'mssql'), 0);
  assert.equal(risky('MERGE t USING u ON t.id = u.id WHEN NOT MATCHED BY SOURCE THEN DELETE;', 'mssql'), 0);
  // mehrere riskante in einer Liste: jede einmal genannt
  assert.deepEqual(riskyStatements(['DELETE FROM a', 'DROP TABLE b', 'SELECT 1'], 'mysql'), ['DELETE ohne WHERE: DELETE FROM a', 'DROP: DROP TABLE b']);
});

test('batchHasSeveralStatements: nur SQL Server, Kommentare und Zeichenketten zählen nicht', () => {
  assert.equal(batchHasSeveralStatements('SELECT 1\nDELETE FROM t', 'mysql'), false);
  assert.equal(batchHasSeveralStatements('SELECT 1\nDELETE FROM t', 'postgres'), false);
  assert.equal(batchHasSeveralStatements('SELECT 1\n-- DELETE FROM t', 'mssql'), false);
  assert.equal(batchHasSeveralStatements("SELECT 1, '\nDELETE FROM t'", 'mssql'), false);
  assert.equal(batchHasSeveralStatements('UPDATE t SET a = 1\nWHERE id = 1', 'mssql'), false);
  assert.equal(batchHasSeveralStatements('SELECT 1\nUPDATE t SET a = 1\nWHERE id = 1', 'mssql'), true);
  assert.equal(batchHasSeveralStatements('EXEC p\nSELECT 1', 'mssql'), true);
});

test('rerunBlocker: erneut ausführen nur, wenn die Anweisung nur liest', () => {
  assert.equal(rerunBlocker('SELECT * FROM t', 'mysql'), null);
  assert.equal(rerunBlocker('WITH c AS (SELECT 1) SELECT * FROM c', 'postgres'), null);
  assert.equal(rerunBlocker('SELECT * FROM t', 'mssql'), null);
  assert.match(rerunBlocker('DELETE FROM t', 'mysql') ?? '', /nur lesen/);
  assert.match(rerunBlocker('EXEC p', 'mssql') ?? '', /nur lesen/);
  assert.match(rerunBlocker('SELECT * FROM t FOR UPDATE', 'postgres') ?? '', /nur lesen/);
  assert.match(rerunBlocker("SELECT nextval('s')", 'postgres') ?? '', /nur lesen/);
  // Elasticsearch: SQL ja, Konsolen-Anfragen nicht (dort bestimmt "size" die Trefferzahl)
  assert.equal(rerunBlocker('SELECT * FROM idx', 'elasticsearch'), null);
  assert.match(rerunBlocker('GET /idx/_search\n{"query": {"match_all": {}}}', 'elasticsearch') ?? '', /size/);
});

test('stoppableResults: so viele Ergebnismengen liefert der SQL-Server-Batch, die letzte darf abgebrochen werden', () => {
  const cases: [string, number][] = [
    ['SELECT * FROM t', 1],
    ['select a from t where x in (select y from u)', 1],
    ['WITH c AS (SELECT 1 AS a) SELECT * FROM c', 1],
    ['SELECT 1 UNION ALL SELECT 2', 1],
    ["SELECT 'SELECT' AS x -- SELECT\n", 1],
    ['SELECT * FROM (SELECT 1 AS a) d', 1],
    ['SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END AS x FROM t', 1],
    ['SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY', 1],
    ['DECLARE @d date = GETDATE()\nSELECT * FROM t WHERE d > @d', 1],
    ['DECLARE @x int\nSELECT @x = COUNT(*) FROM t\nSELECT * FROM u WHERE n > @x', 1],
    ['SELECT TOP 1 @x = a FROM t\nSELECT 2', 1],
    ['SELECT 1\nSELECT 2', 2],
    ['DECLARE @a int = 1\nBEGIN SELECT 1; SELECT 2; END', 2],
    ['SELECT@x AS a, b FROM t\nSELECT 1', 2],
    // nur eine Seite läuft: die Zahl wird nie erreicht, abgebrochen wird nichts
    ['DECLARE @a int = 1\nIF @a = 1 SELECT 1 ELSE SELECT 2', 2],
    ['SELECT * INTO #t FROM u', 0],
    ['EXEC p', 0],
    ['UPDATE t SET a = 1', 0],
    ['SELECT 1\nINSERT INTO t VALUES (1)', 0],
    ['SELECT @x = 1', 0],
    ['DECLARE @i int = 0\nWHILE @i < 3 BEGIN SELECT @i SET @i += 1 END', 0],
    ['DECLARE c CURSOR FOR SELECT 1', 0],
    ['SELECT 1\nFETCH NEXT FROM c', 0],
    ['SELECT * FROM t\nPRINT 1', 0],
    ["SELECT * FROM t\nRAISERROR(N'x', 10, 1)", 0],
    ["SELECT a FROM t WHERE x = 1\nIF @@ROWCOUNT = 0 THROW 50000, N'leer', 1", 0],
    ['SELECT 1\nSELECT @x = 2', 0],
    ['(SELECT 1)\nSELECT 2', 0],
  ];
  for (const [s, n] of cases) assert.equal(stoppableResults(s), n, s);
});
