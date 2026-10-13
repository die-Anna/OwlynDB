/* Reine Logik ohne Datenbank (npm run test:unit): Filter und Fremdschlüssel-Sprung auf Binärspalten – der angezeigte
   Wert '0x…' wird als Literal der Bytes eingesetzt, nicht als Zeichenkette (F187) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseType, condition, hexLiteral, isBinaryType } from '../../../shared/sql-util';

test('hexLiteral: Bytes je Dialekt, leerer Wert, gekürzte und andere Werte nicht', () => {
  assert.equal(hexLiteral('mysql', '0x1F2E'), '0x1F2E');
  assert.equal(hexLiteral('mssql', '0x1F2E'), '0x1F2E');
  assert.equal(hexLiteral('postgres', '0x1F2E'), "decode('1F2E', 'hex')");
  assert.equal(hexLiteral('mysql', '0xab'), '0xAB');
  // leer: MySQL kennt „0x“ allein nicht
  assert.equal(hexLiteral('mysql', '0x'), "X''");
  assert.equal(hexLiteral('mssql', '0x'), '0x');
  assert.equal(hexLiteral('postgres', '0x'), "decode('', 'hex')");
  for (const v of ['0x1F2E… (5000 Bytes)', '0x1', '0xZZ', 'abc', '', 12, true, null]) assert.equal(hexLiteral('mysql', v as never), null, String(v));
  assert.equal(hexLiteral('elasticsearch', '0x1F'), null);
});

test('condition: Binärspalte mit Literal der Bytes, sonst wie bisher', () => {
  assert.equal(condition('mysql', 'id', '0x1F2E', '=', false, true), '`id` = 0x1F2E');
  assert.equal(condition('mssql', 'id', '0x1F2E', '<>', false, true), '[id] <> 0x1F2E');
  assert.equal(condition('postgres', 'id', '0x1F2E', '=', false, true), "id = decode('1F2E', 'hex')");
  // ohne Binärspalte: Text bleibt Text (eine varchar-Spalte mit „0x1F“ als Inhalt)
  assert.equal(condition('mysql', 'code', '0x1F', '=', false), "`code` = '0x1F'");
  assert.equal(condition('mysql', 'id', null, '=', false, true), '`id` IS NULL');
  // SQL Server bit kommt als Wahrheitswert: bleibt 1/0
  assert.equal(condition('mssql', 'aktiv', true, '=', false, true), '[aktiv] = 1');
});

test('isBinaryType: Typen, deren Zellen als 0x… erscheinen', () => {
  for (const t of ['binary(16)', 'varbinary(255)', 'VARBINARY(MAX)', 'tinyblob', 'longblob', 'bytea', 'image', 'bit(1)', 'BIT']) assert.ok(isBinaryType(t), t);
  for (const t of ['varchar(10)', 'text', 'bigint', 'imagename', 'nvarchar(max)', 'uniqueidentifier', 'json']) assert.ok(!isBinaryType(t), t);
  // nur der Typname zählt, nicht die Werteliste eines ENUM/SET (F368)
  for (const t of ["enum('image','blob','binary')", "set('bytea','bit')", 'image_ref']) assert.ok(!isBinaryType(t), t);
});

test('baseType: ohne Länge, Genauigkeit und Werteliste', () => {
  assert.equal(baseType("enum('image','video')"), 'enum');
  assert.equal(baseType('VARBINARY(MAX)'), 'varbinary');
  assert.equal(baseType('int(10) unsigned'), 'int');
  assert.equal(baseType('character varying(20)'), 'character varying');
  assert.equal(baseType('geometry(Point,4326)'), 'geometry');
  assert.equal(baseType("set('a\nb')"), 'set');
  assert.equal(baseType(' Text '), 'text');
});
