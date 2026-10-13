/* Reine Logik ohne Datenbank (npm run test:unit): freie WHERE-Bedingung der Tabellenansicht (shared/sql-util.ts, checkWhere) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWhere, quoteIdent } from '../../../shared/sql-util';

test('checkWhere: erlaubt bleibt erlaubt', () => {
  for (const [w, d] of [
    ["name = 'Müller' AND id > 3", 'mysql'],
    ['(a = 1 OR b = 2) AND c IN (1, 2)', 'postgres'],
    ["[Name] = N'x' AND x = ']'", 'mssql'],
    ["name = 'O''Brien'", 'postgres'],
    ["name = 'a\\'b'", 'mysql'],
    ["`col` = 'x'", 'mysql'],
    ["note = E'Zeile\\nUmbruch'", 'postgres'],
    ["name LIKE 'e%'", 'postgres'],
  ] as const) {
    assert.equal(checkWhere(w, d), null, w);
  }
});

test('checkWhere: Ausbruch aus der Klammer wird erkannt', () => {
  assert.ok(checkWhere('1=1) DELETE FROM t WHERE (1=1', 'mssql'));
  assert.ok(checkWhere('1=1; DELETE FROM t', 'mysql'));
  assert.ok(checkWhere("x = 'a' -- b", 'postgres'));
  assert.ok(checkWhere("x = 'a' /* b */", 'mysql'));
  assert.ok(checkWhere('x = $$a$$', 'postgres'));
  assert.ok(checkWhere("x = 'offen", 'mysql'));
  assert.ok(checkWhere('(a = 1', 'postgres'));
});

test("F022: PostgreSQL E'\\'' schließt die Zeichenkette nicht – Prüfer und Server bleiben beieinander", () => {
  // E'\'' ist eine Zeichenkette mit einem Apostroph; danach steht Code
  assert.ok(checkWhere("x = E'\\'' ) ; COMMIT ; DELETE FROM t WHERE (1=1 AND c2 = E'a\\'b'", 'postgres'), 'Ausbruch über E-String');
  assert.ok(checkWhere("true OR E'\\'' IS NULL) ; COMMIT ; DELETE FROM t ; SELECT * FROM t WHERE (true OR E'\\'' IS NULL", 'postgres'));
  // Backslash-Escape nur hinter einem alleinstehenden E: name'…' ist kein E-String, dort schließt '' nicht
  assert.equal(checkWhere("name'x\\' = 1", 'postgres'), null);
  assert.ok(checkWhere("name'x\\'' = 1", 'postgres'), 'nicht geschlossen');
  assert.equal(checkWhere("x = e'a\\'b'", 'postgres'), null);
});

test('F186: quoteIdent (PostgreSQL) quotet alle reservierten Wörter', () => {
  for (const w of ['left', 'window', 'only', 'fetch', 'user', 'order', 'cast', 'lateral', 'returning', 'ilike', 'tablesample']) {
    assert.equal(quoteIdent('postgres', w), `"${w}"`, w);
  }
  assert.equal(quoteIdent('postgres', 'kunden'), 'kunden');
  assert.equal(quoteIdent('postgres', 'Kunden'), '"Kunden"');
  assert.equal(quoteIdent('postgres', 'a"b'), '"a""b"');
});
