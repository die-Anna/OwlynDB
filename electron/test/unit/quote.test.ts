/* Reine Logik ohne Datenbank (npm run test:unit): Bezeichner in Anführungszeichen je Dialekt – PostgreSQL quotet jedes
   Wort, das der Server reserviert (pg_get_keywords, Kategorie R und T), dazu Großschreibung, Umlaute, Sonderzeichen (F188) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectName, quoteIdent } from '../../../shared/sql-util';

/** pg_get_keywords() WHERE catcode IN ('R', 'T') von PostgreSQL 17 */
const PG17_RESERVED =
  'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently ' +
  'constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default ' +
  'deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner ' +
  'intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order ' +
  'outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample ' +
  'then to trailing true union unique user using variadic verbose when where window with';

test('PostgreSQL: jedes reservierte Wort in Anführungszeichen, gewöhnliche Namen ohne', () => {
  for (const w of PG17_RESERVED.split(' ')) assert.equal(quoteIdent('postgres', w), `"${w}"`, w);
  for (const w of ['kunde', 'name', 'id', 'value', 'type', 'year', 'text', 'data', '_x1']) assert.equal(quoteIdent('postgres', w), w, w);
});

test('Großschreibung, Umlaute, Ziffer am Anfang, Anführungszeichen – je Dialekt richtig verdoppelt', () => {
  assert.equal(quoteIdent('postgres', 'Kunde'), '"Kunde"');
  assert.equal(quoteIdent('postgres', 'größe'), '"größe"');
  assert.equal(quoteIdent('postgres', '1a'), '"1a"');
  assert.equal(quoteIdent('postgres', 'a"b'), '"a""b"');
  assert.equal(quoteIdent('mysql', 'a`b'), '`a``b`');
  assert.equal(quoteIdent('mssql', 'a]b'), '[a]]b]');
  assert.equal(quoteIdent('elasticsearch', 'log-2026.10'), '"log-2026.10"');
  assert.equal(objectName('postgres', { schema: 'public', name: 'order' }), 'public."order"');
  assert.equal(objectName('mysql', { schema: '', name: 'order' }), '`order`');
  assert.equal(objectName('mssql', { schema: 'dbo', name: 'user' }), '[dbo].[user]');
});
