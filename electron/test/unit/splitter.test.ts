/* Reine Logik ohne Datenbank (npm run test:unit): SQL-Zerleger (shared/sql-splitter.ts) – Optionen, Zeilenenden,
   offene Zeichenketten, Anweisung unter dem Cursor und das Einspielen in beliebig kleinen Blöcken */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { Dialect, ImportRequest, QueryRun, StatementInput } from '../../../shared/api-types';
import { splitSql, statementAt, withoutLeadingComments } from '../../../shared/sql-splitter';
import type { Session } from '../../drivers/common';
import { runImport, type ImportProgress } from '../../import';

const parts = (text: string, d: Dialect, delimiter?: string, goOnly?: boolean) => splitSql(text, d, delimiter, goOnly).map((s) => s.sql);

test('Offsets: start/end zeigen auf genau den Text der Anweisung', () => {
  const texts: [string, Dialect][] = [
    ['  SELECT 1;\n\n  -- Kommentar\nSELECT 2 ;  SELECT 3', 'mysql'],
    ["SELECT $$a;b$$;\r\nSELECT E'x\\';y';", 'postgres'],
    ['SELECT 1\r\nGO\r\n  SELECT [a;b]\r\nGO 2\r\n', 'mssql'],
  ];
  for (const [text, d] of texts) {
    const s = splitSql(text, d);
    assert.ok(s.length >= 2, text);
    for (const x of s) assert.equal(text.slice(x.start, x.end), x.sql, `${d}: ${x.sql}`);
  }
});

test('MySQL: DELIMITER wie im mysql-Client, Trennzeichen je Anweisung; Startwert als Parameter', () => {
  const text = 'SELECT 1;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nSELECT 3;';
  const s = splitSql(text, 'mysql');
  assert.deepEqual(
    s.map((x) => [x.sql, x.delimiter]),
    [
      ['SELECT 1', ';'],
      ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', '//'],
      ['SELECT 3', ';'],
    ],
  );
  // Einspielen setzt nach einem Block mit dem dort gültigen Trennzeichen fort
  assert.deepEqual(parts('SELECT 1$$ SELECT 2; SELECT 3$$', 'mysql', '$$'), ['SELECT 1', 'SELECT 2; SELECT 3']);
  // DELIMITER mit CRLF
  assert.deepEqual(parts('DELIMITER $$\r\nSELECT 1; SELECT 2$$\r\nDELIMITER ;\r\nSELECT 3;\r\n', 'mysql'), ['SELECT 1; SELECT 2', 'SELECT 3']);
});

test('MySQL: Kommentare – „--“ nur mit Leerraum dahinter, # bis Zeilenende, /*! … */ und /*M! … */ werden ausgeführt', () => {
  assert.deepEqual(parts('SELECT 5--3;\nSELECT 2', 'mysql'), ['SELECT 5--3', 'SELECT 2']);
  assert.deepEqual(parts('SELECT 1; -- nur Kommentar\n# auch das\n;SELECT 2', 'mysql'), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(parts('/*!40101 SET NAMES utf8mb4 */;\n/* nur Kommentar */;\nSELECT 1', 'mysql'), ['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1']);
  // MariaDB-Dumps: /*M!100616 SET … */ führt der Server aus – darf nicht als Kommentar wegfallen
  assert.deepEqual(parts('/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;\nSELECT 1', 'mysql'), [
    '/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */',
    'SELECT 1',
  ]);
  // Backslash in Zeichenketten, nicht in Backticks
  assert.deepEqual(parts("SELECT 'a\\';b'; SELECT `c\\`; SELECT 3", 'mysql'), ["SELECT 'a\\';b'", 'SELECT `c\\`', 'SELECT 3']);
});

test('PostgreSQL: Dollar-Quoting mit Tag, E- und U&-Zeichenketten, verschachtelte Kommentare', () => {
  const fn = 'CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT $$x;y$$; $body$ LANGUAGE sql';
  assert.deepEqual(parts(`${fn};\nSELECT 2`, 'postgres'), [fn, 'SELECT 2']);
  assert.deepEqual(parts("SELECT U&'d\\0061t\\+000061;' AS x; SELECT 2", 'postgres'), ["SELECT U&'d\\0061t\\+000061;' AS x", 'SELECT 2']);
  assert.deepEqual(parts('/* a /* b; */ c; */ SELECT 1; SELECT "x;y"', 'postgres'), ['/* a /* b; */ c; */ SELECT 1', 'SELECT "x;y"']);
  // $1 ist ein Parameter, kein Dollar-Quote
  assert.deepEqual(parts('SELECT $1; SELECT 2', 'postgres'), ['SELECT $1', 'SELECT 2']);
});

test('SQL Server: Blöcke, Routinen, BEGIN TRAN; mssqlGoOnly trennt nur an GO', () => {
  assert.deepEqual(parts('BEGIN TRY SELECT 1; SELECT 2; END TRY BEGIN CATCH SELECT 3; END CATCH; SELECT 4', 'mssql'), [
    'BEGIN TRY SELECT 1; SELECT 2; END TRY BEGIN CATCH SELECT 3; END CATCH',
    'SELECT 4',
  ]);
  assert.deepEqual(parts('BEGIN TRAN; UPDATE t SET a = 1; COMMIT;', 'mssql'), ['BEGIN TRAN', 'UPDATE t SET a = 1', 'COMMIT']);
  assert.deepEqual(parts('SELECT CASE WHEN a = 1 THEN 1 END AS x FROM t; SELECT 2', 'mssql'), ['SELECT CASE WHEN a = 1 THEN 1 END AS x FROM t', 'SELECT 2']);
  // Routine: „;“ trennt bis zum nächsten GO nicht (wie SSMS)
  assert.deepEqual(parts('CREATE OR ALTER PROCEDURE p AS SELECT 1; SELECT 2;\nGO\nEXEC p;', 'mssql'), ['CREATE OR ALTER PROCEDURE p AS SELECT 1; SELECT 2;', 'EXEC p']);
  // Einspielen: Batch bis GO, Variablen bleiben erhalten
  const batch = 'DECLARE @x int = 1;\nSELECT @x;\nGO\r\nSELECT 2';
  assert.deepEqual(parts(batch, 'mssql'), ['DECLARE @x int = 1', 'SELECT @x', 'SELECT 2']);
  assert.deepEqual(parts(batch, 'mssql', ';', true), ['DECLARE @x int = 1;\nSELECT @x;', 'SELECT 2']);
  // GO nur allein auf der Zeile; „GOTO“ und „go“ in einer Anweisung trennen nicht
  assert.deepEqual(parts('SELECT 1 AS go\nGOTO marke\ngo\nSELECT 2', 'mssql', ';', true), ['SELECT 1 AS go\nGOTO marke', 'SELECT 2']);
});

test('offene Zeichenkette, offener Kommentar und offenes Dollar-Quote am Ende: kein Absturz, Rest gehört dazu', () => {
  assert.deepEqual(parts("SELECT 1; SELECT 'abc; SELECT 2", 'mysql'), ['SELECT 1', "SELECT 'abc; SELECT 2"]);
  assert.deepEqual(parts('SELECT 1; /* offen; SELECT 2', 'postgres'), ['SELECT 1']);
  assert.deepEqual(parts('SELECT 1; SELECT $$ offen; SELECT 2', 'postgres'), ['SELECT 1', 'SELECT $$ offen; SELECT 2']);
  assert.deepEqual(parts('SELECT [offen; SELECT 2', 'mssql'), ['SELECT [offen; SELECT 2']);
  assert.deepEqual(parts('', 'mysql'), []);
  assert.deepEqual(parts(' ;; \n ; ', 'postgres'), []);
});

test('statementAt: Cursor in, am Ende und hinter einer Anweisung; Leerzeile führt nichts aus', () => {
  const text = 'SELECT 1; SELECT 2;\n\nDELETE FROM t;  \nSELECT 4';
  const s = splitSql(text, 'mysql');
  const at = (offset: number) => statementAt(s, text, offset)?.sql;
  assert.equal(at(0), 'SELECT 1');
  assert.equal(at(text.indexOf('1;')), 'SELECT 1');
  assert.equal(at(text.indexOf('1;') + 1), 'SELECT 1', 'am Ende (vor dem ;)');
  assert.equal(at(text.indexOf('1;') + 2), 'SELECT 1', 'hinter dem ; auf derselben Zeile');
  assert.equal(at(text.indexOf('SELECT 2')), 'SELECT 2');
  assert.equal(at(text.indexOf('\n\n') + 1), undefined, 'Leerzeile');
  assert.equal(at(text.indexOf('t;') + 4), 'DELETE FROM t', 'Leerzeichen hinter dem ; zählen zur Zeile');
  assert.equal(at(text.length), 'SELECT 4');
  assert.equal(statementAt([], '', 0), undefined);
});

// ---------- Einspielen in Blöcken ----------

/** Sitzung, die nur mitschreibt, was ausgeführt würde */
function fakeSession() {
  const ran: string[] = [];
  const session = {
    database: undefined,
    broken: false,
    inTransaction: false,
    autocommitIdle: false,
    busy: false,
    readOnly: false,
    run: async (input: StatementInput[]): Promise<QueryRun> => {
      ran.push(...input.map((x) => x.sql));
      return {
        results: [],
        statements: input.map((x, i) => ({ statementIndex: i, sql: x.sql, durationMs: 0, resultSets: 0 })),
        messages: [],
        cancelled: false,
        durationMs: 0,
      };
    },
  } as unknown as Session;
  return { session, ran };
}

async function importChunked(text: string, dialect: Dialect, size: number): Promise<string[]> {
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  const { session, ran } = fakeSession();
  const req = { connectionId: 'x', database: 'd', createDatabase: false, file: '', stopOnError: true, transaction: false, skipUse: false } as ImportRequest;
  const p: ImportProgress = { bytes: 0, total: bytes.length, statements: 0, errors: 0, skipped: 0, warnings: 0, lostRows: 0, missingObjects: 0, line: 0, log: [] };
  await runImport(session, dialect, req, p, () => false, Readable.from(chunks));
  return ran;
}

const SCRIPTS: Record<'mysql' | 'postgres' | 'mssql', string> = {
  mysql: [
    '-- Kopf; mit Semikolon',
    "INSERT INTO t VALUES (1, 'a;b', 'Grüße – ä');",
    '/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */;',
    'DELIMITER //',
    'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT "x//y"; END//',
    'DELIMITER ;',
    "SELECT 'it''s', `a;b`, 5--3 # Kommentar;",
    ';',
    'SELECT 2',
  ].join('\n'),
  postgres: [
    "INSERT INTO t VALUES (1, E'a\\';b', 'Grüße');",
    'CREATE FUNCTION f() RETURNS int AS $f$ SELECT 1; $f$ LANGUAGE sql;',
    'CREATE FUNCTION g(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a; SELECT CASE WHEN a > 1 THEN 1 END; END;',
    '/* verschachtelt /* ; */ */ SELECT (SELECT 1; );',
    '-- Zeilenkommentar',
    'SELECT "a;b" FROM t',
  ].join('\r\n'),
  mssql: [
    'SET NOCOUNT ON;',
    "INSERT INTO t VALUES (N'Grüße;', 1)",
    'GO',
    'CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT [x;y]; END',
    'GO 2',
    'SELECT 3 -- GO',
    'GO -- Ende',
    '/* a /* b */ */ SELECT 4',
  ].join('\r\n'),
};

for (const d of ['mysql', 'postgres', 'mssql'] as const) {
  test(`Einspielen ${d}: in beliebigen Blockgrößen eingelesen, dieselben Anweisungen wie das Ganze zerlegt`, async () => {
    // das Einspielen lässt Kommentare vor der Anweisung weg
    const whole = splitSql(SCRIPTS[d], d, ';', true).flatMap((s) => Array(s.repeat ?? 1).fill(withoutLeadingComments(s.sql, d)));
    assert.ok(whole.length >= 3, `${d}: ${whole.length}`);
    for (const size of [1, 2, 3, 5, 7, 13, 64, 4096]) {
      assert.deepEqual(await importChunked(SCRIPTS[d], d, size), whole, `${d}, Blockgröße ${size}`);
    }
  });
}

test('Einspielen: Kommentare vor einer Anweisung fallen ganz weg (auch verschachtelte), /*! … */ und /*M! … */ bleiben', async () => {
  assert.deepEqual(await importChunked('/* a /* ; */ */ SELECT 2;\nSELECT 3', 'postgres', 4096), ['SELECT 2', 'SELECT 3']);
  assert.deepEqual(await importChunked('/* a /* b */ */ SELECT 2\nGO\n-- x\nSELECT 3', 'mssql', 4096), ['SELECT 2', 'SELECT 3']);
  assert.deepEqual(await importChunked('-- x\n/*!40101 SET @a=1 */;\n/*M!100616 SET @b=2 */;\n# y\n/* z */ SELECT 3', 'mysql', 4096), [
    '/*!40101 SET @a=1 */',
    '/*M!100616 SET @b=2 */',
    'SELECT 3',
  ]);
});

test('SQL Server „GO n“: jede Anweisung des Batches trägt seine Nummer und die Zahl – auch nach einem „;“ am Ende', () => {
  const s = splitSql('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);\nGO 3\nSELECT 1\nGO', 'mssql');
  assert.deepEqual(
    s.map((x) => [x.sql, x.batch, x.repeat ?? 1]),
    [
      ['INSERT INTO t VALUES (1)', 0, 3],
      ['INSERT INTO t VALUES (2)', 0, 3],
      ['SELECT 1', 1, 1],
    ],
  );
  // Einspielen (nur GO trennt): der Batch ist eine Anweisung
  assert.deepEqual(
    splitSql('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);\nGO 3', 'mssql', ';', true).map((x) => [x.sql, x.repeat]),
    [['INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);', 3]],
  );
  assert.equal(splitSql('SELECT 1; SELECT 2', 'mysql')[0].batch, undefined);
});
