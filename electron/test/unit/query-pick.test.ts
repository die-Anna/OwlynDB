/* Reine Logik ohne Datenbank (npm run test:unit): Abfrage-Tab – welche Anweisungen laufen (Markierung, Cursor, alles)
   und wann vorher nachgefragt wird (shared/query-pick.ts) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dialect } from '../../../shared/api-types';
import { executeWarnings, pickStatements, SEVERAL_IN_BATCH, type PickRequest } from '../../../shared/query-pick';

const pick = (text: string, mode: 'current' | 'all', cursor: number, dialect: Dialect = 'mysql', selection?: PickRequest['selection']) =>
  pickStatements({ text, mode, cursor, dialect, selection });
const sqls = (p: ReturnType<typeof pick>) => p?.input.map((s) => s.sql) ?? null;

test('alles (F5): jede Anweisung mit ihrem Offset im Text', () => {
  const text = 'SELECT 1;\nSELECT 2';
  const p = pick(text, 'all', 0);
  assert.deepEqual(p?.input, [
    { sql: 'SELECT 1', offset: 0 },
    { sql: 'SELECT 2', offset: 10 },
  ]);
  assert.deepEqual(p?.ranges, [
    [0, 8],
    [10, 18],
  ]);
  assert.equal(p?.single, false);
  assert.equal(pick('  \n -- nur Kommentar\n', 'all', 0), null);
});

test('Anweisung unter dem Cursor (Strg+Enter): darin, dahinter auf derselben Zeile, Leerzeile, CRLF', () => {
  const text = 'SELECT 1;\n\nSELECT 2;  ';
  assert.deepEqual(sqls(pick(text, 'current', 3)), ['SELECT 1']);
  assert.equal(pick(text, 'current', 3)?.single, true);
  assert.equal(pick(text, 'current', 10), null, 'Leerzeile: nichts ausführen');
  assert.deepEqual(sqls(pick(text, 'current', text.length)), ['SELECT 2'], 'Cursor am Ende hinter dem ;');
  const crlf = 'SELECT 1;\r\nSELECT 2';
  assert.deepEqual(pick(crlf, 'current', crlf.length)?.input, [{ sql: 'SELECT 2', offset: 11 }]);
});

test('Markierung hat Vorrang – auch bei Strg+Enter; Offsets bleiben die des ganzen Texts', () => {
  const text = 'SELECT 1; SELECT 2; SELECT 3';
  const from = text.indexOf('SELECT 2');
  const p = pick(text, 'current', 0, 'mysql', { start: from, end: text.length });
  assert.deepEqual(p?.input, [
    { sql: 'SELECT 2', offset: from },
    { sql: 'SELECT 3', offset: text.indexOf('SELECT 3') },
  ]);
  assert.equal(p?.single, false);
  // Teil einer Anweisung markiert: genau das läuft
  assert.deepEqual(sqls(pick('SELECT a, b FROM t', 'all', 0, 'mysql', { start: 7, end: 11 })), ['a, b']);
  // leere Markierung zählt nicht
  assert.deepEqual(sqls(pick(text, 'current', 0, 'mysql', { start: 5, end: 5 })), ['SELECT 1']);
});

test('Elasticsearch: Konsolen-Anfragen und SQL nebeneinander', () => {
  const text = 'GET /idx/_search\n{\n  "query": { "match_all": {} }\n}\n\nGET /idx/_count\n\nSELECT * FROM idx';
  const all = pick(text, 'all', 0, 'elasticsearch');
  assert.equal(all?.input.length, 3);
  assert.match(all!.input[0].sql, /^GET \/idx\/_search\n\{[\s\S]*\}$/);
  assert.deepEqual(sqls(pick(text, 'current', text.indexOf('_count'), 'elasticsearch')), ['GET /idx/_count']);
  assert.deepEqual(sqls(pick(text, 'current', text.length, 'elasticsearch')), ['SELECT * FROM idx']);
});

test('Rückfrage: riskante Anweisungen, SQL Server ohne „;“ bei Strg+Enter, nicht bei Nur lesen und Elasticsearch', () => {
  const w = (text: string, mode: 'current' | 'all', d: Dialect, opts = { readOnly: false }) => executeWarnings(pick(text, mode, 0, d)!, d, opts);
  // F5 mit zwei Zeilen ohne ";" (SQL Server: ein Batch): das DELETE ohne WHERE fällt trotzdem auf
  assert.deepEqual(w('SELECT * FROM region\nDELETE FROM kunden', 'all', 'mssql'), ['DELETE ohne WHERE: SELECT * FROM region DELETE FROM kunden']);
  // Strg+Enter in der ersten Zeile: beide Zeilen laufen zusammen – das wird gesagt
  assert.deepEqual(w('SELECT 1\nUPDATE t SET a = 1 WHERE id = 1', 'current', 'mssql'), [SEVERAL_IN_BATCH]);
  assert.deepEqual(w('SELECT 1\nUPDATE t SET a = 1 WHERE id = 1', 'all', 'mssql'), [], 'F5: alles soll laufen');
  assert.deepEqual(w('SELECT 1\nDELETE FROM t', 'current', 'mssql'), [SEVERAL_IN_BATCH, 'DELETE ohne WHERE: SELECT 1 DELETE FROM t']);
  assert.deepEqual(w('DELETE FROM t; DROP TABLE u', 'all', 'postgres'), ['DELETE ohne WHERE: DELETE FROM t', 'DROP: DROP TABLE u']);
  assert.deepEqual(w('SELECT 1', 'all', 'mysql'), []);
  assert.deepEqual(w('DELETE FROM t', 'all', 'mysql', { readOnly: true }), [], 'Nur lesen: der Hauptprozess lehnt ab');
  assert.deepEqual(w('GET /idx/_search', 'all', 'elasticsearch'), []);
});

test('Plan mit Laufzeit: schreibende Anweisung wird genannt, lesende nicht', () => {
  const p = pick('UPDATE t SET a = 1 WHERE id = 1', 'current', 0, 'postgres')!;
  const w = executeWarnings(p, 'postgres', { readOnly: false, analyze: true });
  assert.equal(w.length, 1);
  assert.match(w[0], /^Mit Laufzeit wird die Anweisung wirklich ausgeführt.*UPDATE t SET a = 1 WHERE id = 1$/);
  assert.deepEqual(executeWarnings(pick('SELECT 1', 'current', 0, 'postgres')!, 'postgres', { readOnly: false, analyze: true }), []);
  // ohne WHERE: zuerst der Hinweis auf das Ausführen, dann der auf das fehlende WHERE
  const both = executeWarnings(pick('DELETE FROM t', 'current', 0, 'mysql')!, 'mysql', { readOnly: false, analyze: true });
  assert.equal(both.length, 2);
  assert.match(both[0], /^Mit Laufzeit/);
  assert.match(both[1], /^DELETE ohne WHERE/);
});

test('SQL Server „GO n“: die Anweisungen des Batches laufen als Gruppe n-mal (wie in SSMS)', () => {
  const text = 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);\nGO 2\nSELECT 1';
  assert.deepEqual(sqls(pick(text, 'all', 0, 'mssql')), [
    'INSERT INTO t VALUES (1)',
    'INSERT INTO t VALUES (2)',
    'INSERT INTO t VALUES (1)',
    'INSERT INTO t VALUES (2)',
    'SELECT 1',
  ]);
  // Strg+Enter auf der zweiten: sie allein, mit der Zahl ihres Batches; Offsets bleiben die der Anweisung
  const at = text.indexOf('INSERT INTO t VALUES (2)');
  assert.deepEqual(pick(text, 'current', at + 3, 'mssql')?.input, [
    { sql: 'INSERT INTO t VALUES (2)', offset: at },
    { sql: 'INSERT INTO t VALUES (2)', offset: at },
  ]);
  // markiert ohne GO-Zeile: einmal
  assert.deepEqual(sqls(pick(text, 'current', 0, 'mssql', { start: 0, end: text.indexOf('\nGO') })), ['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)']);
});
