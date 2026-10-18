/* Reine Logik ohne Datenbank (npm run test:unit): Stelle eines Fehlers in der Anweisung für die Markierung im Editor –
   statt die ganze Anweisung rot zu unterstreichen nur den Namen bzw. die Stelle, die der Server meldet */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorRanges } from '../../../shared/error-location';

/** markierte Texte statt Zahlen – lesbarer */
const marked = (sql: string, ranges: [number, number][]) => ranges.map(([a, b]) => sql.slice(a, b));

const SQL = `SELECT
    all_usr_id AS usr_id,
    inb_name AS project
FROM allocations
-- inb_name stand früher hier
WHERE x = 'inb_name'
GROUP BY all_usr_id, inb_name`;

test('SQL Server: ungültiger Spaltenname – in der gemeldeten Zeile, ohne Zeile überall, nie in Kommentar oder Zeichenkette', () => {
  const msg = "Invalid column name 'inb_name'.";
  const inLine3 = errorRanges('mssql', SQL, msg, { line: 3 });
  assert.deepEqual(inLine3, [[SQL.indexOf('inb_name AS'), SQL.indexOf('inb_name AS') + 8]]);
  assert.deepEqual(errorRanges('mssql', SQL, msg, { line: 7 }), [[SQL.lastIndexOf('inb_name'), SQL.lastIndexOf('inb_name') + 8]]);
  // ohne Zeile: beide echten Stellen, nicht im Kommentar (Zeile 5) und nicht in der Zeichenkette (Zeile 6)
  const all = errorRanges('mssql', SQL, msg);
  assert.equal(all.length, 2);
  assert.deepEqual(marked(SQL, all), ['inb_name', 'inb_name']);
  // Zeile ohne den Namen (Meldung zu einer anderen Stelle): dann alle Stellen
  assert.equal(errorRanges('mssql', SQL, msg, { line: 1 }).length, 2);
});

test('SQL Server: Objekt, Variable, mehrteiliger Name, Syntax „near“', () => {
  const sql = 'SELECT k.name, @wert\nFROM dbo.kundn k\nWHERE k.id = 1\nGROUP BY';
  assert.deepEqual(marked(sql, errorRanges('mssql', sql, "Invalid object name 'dbo.kundn'.", { line: 2 })), ['dbo.kundn']);
  assert.deepEqual(marked(sql, errorRanges('mssql', sql, 'Must declare the scalar variable "@wert".', { line: 1 })), ['@wert']);
  assert.deepEqual(marked(sql, errorRanges('mssql', sql, 'The multi-part identifier "k.name" could not be bound.', { line: 1 })), ['k.name']);
  assert.deepEqual(marked(sql, errorRanges('mssql', sql, "Incorrect syntax near 'GROUP'.", { line: 4 })), ['GROUP']);
  // Name in eckigen Klammern: markiert wird der Name
  const br = 'SELECT [inb name] FROM t';
  assert.deepEqual(marked(br, errorRanges('mssql', br, "Invalid column name 'inb name'.", { line: 1 })), ['inb name']);
  // nichts zu finden, aber die Zeile ist bekannt: die Zeile ohne Einrückung
  const sql2 = 'SELECT 1\n   RAISERROR  \nSELECT 2';
  assert.deepEqual(marked(sql2, errorRanges('mssql', sql2, 'Fehler 50000', { line: 2 })), ['RAISERROR']);
  assert.deepEqual(errorRanges('mssql', sql2, 'Fehler 50000'), []);
});

test('MySQL: Spalte, Tabelle mit Datenbank davor, Syntax mit Zeile, Fehler am Ende', () => {
  const sql = "SELECT name, inb_name\nFORM kunden\nWHERE note = 'inb_name'";
  assert.deepEqual(marked(sql, errorRanges('mysql', sql, "Unknown column 'inb_name' in 'field list'")), ['inb_name']);
  assert.deepEqual(
    marked(sql, errorRanges('mysql', sql, "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM kunden\nWHERE note = 'inb_name'' at line 2")),
    ['FORM'],
  );
  const t = 'SELECT * FROM kundn';
  assert.deepEqual(marked(t, errorRanges('mysql', t, "Table 'shop.kundn' doesn't exist")), ['kundn']);
  const end = 'SELECT * FROM kunden WHERE';
  assert.deepEqual(marked(end, errorRanges('mysql', end, "You have an error in your SQL syntax; check the manual ... near '' at line 1")), ['WHERE']);
  // # ist bei MySQL ein Kommentar
  const hash = 'SELECT inb_name # inb_name\nFROM t';
  assert.equal(errorRanges('mysql', hash, "Unknown column 'inb_name' in 'field list'").length, 1);
});

test('PostgreSQL: Position des Servers, sonst der Name aus der Meldung', () => {
  const sql = 'SELECT k.name, inb_name\nFROM kunden k';
  // Position zählt ab 1
  assert.deepEqual(marked(sql, errorRanges('postgres', sql, 'column "inb_name" does not exist', { position: sql.indexOf('inb_name') + 1 })), ['inb_name']);
  const q = 'SELECT * FROM "Kunden Alt" k';
  assert.deepEqual(marked(q, errorRanges('postgres', q, 'relation "Kunden Alt" does not exist', { position: q.indexOf('"') + 1 })), ['"Kunden Alt"']);
  assert.deepEqual(marked(sql, errorRanges('postgres', sql, 'relation "kunden" does not exist')), ['kunden']);
  // Position hinter dem Ende (Fehler am Ende der Eingabe): das letzte Wort
  const end = 'SELECT * FROM';
  assert.deepEqual(marked(end, errorRanges('postgres', end, 'syntax error at end of input', { position: end.length + 1 })), ['FROM']);
});
