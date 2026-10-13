/* Reine Logik ohne Datenbank (npm run test:unit): Schema-Vergleich – Schema im Kopf, Textvergleich ohne Schema, Reihenfolge
   der Löschungen und Kopfzeilen im Abgleich-Skript (electron/compare.ts, shared/compare-script.ts) – Review Thema 6 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompareItem } from '../../../shared/api-types';
import { compareScript } from '../../../shared/compare-script';
import { rewriteHead, rewriteTrigger, withoutSchema } from '../../compare';

test('F037: PostgreSQL – Funktion und Trigger auf das Ziel-Schema', () => {
  assert.equal(rewriteHead('postgres', 'CREATE OR REPLACE FUNCTION public.f_x()\n RETURNS integer', 'public', 'staging'), 'CREATE OR REPLACE FUNCTION staging.f_x()\n RETURNS integer');
  assert.equal(rewriteHead('postgres', 'CREATE OR REPLACE FUNCTION "Public"."F"(a int)', 'Public', 'test'), 'CREATE OR REPLACE FUNCTION test."F"(a int)');
  assert.equal(rewriteHead('postgres', 'CREATE PROCEDURE f(a int)', 'public', 'test'), 'CREATE PROCEDURE test.f(a int)');
  // ein anderes Schema bleibt
  assert.equal(rewriteHead('postgres', 'CREATE OR REPLACE FUNCTION util.f()', 'public', 'test'), 'CREATE OR REPLACE FUNCTION util.f()');
  assert.equal(
    rewriteTrigger('CREATE TRIGGER tg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.fn()', 'public', 'test'),
    'CREATE TRIGGER tg BEFORE INSERT ON test.t FOR EACH ROW EXECUTE FUNCTION test.fn()',
  );
});

test('F036/F037: SQL Server – ALTER wird CREATE OR ALTER, Schema im Kopf aufs Ziel', () => {
  assert.equal(rewriteHead('mssql', 'CREATE OR ALTER PROCEDURE dbo.p_x AS SELECT 1', 'dbo', 'staging'), 'CREATE OR ALTER PROCEDURE [staging].p_x AS SELECT 1');
  assert.equal(rewriteHead('mssql', 'CREATE OR ALTER VIEW [dbo].[v] AS SELECT 1', 'dbo', 'staging'), 'CREATE OR ALTER VIEW [staging].[v] AS SELECT 1');
  assert.equal(rewriteHead('mssql', '-- Kopf\nCREATE OR ALTER PROC p AS SELECT 1', 'dbo', 'staging'), '-- Kopf\nCREATE OR ALTER PROC [staging].p AS SELECT 1');
  assert.equal(rewriteHead('mssql', 'CREATE OR ALTER PROCEDURE other.p AS SELECT 1', 'dbo', 'staging'), 'CREATE OR ALTER PROCEDURE other.p AS SELECT 1');
});

test('F037: Textvergleich ohne Schema-Qualifizierung', () => {
  assert.equal(withoutSchema('postgres', 'CREATE FUNCTION public.f() … FROM public.t JOIN "public".u', 'public'), 'CREATE FUNCTION f() … FROM t JOIN u');
  assert.equal(withoutSchema('mssql', 'SELECT * FROM [dbo].[t] JOIN dbo.u', 'dbo'), 'SELECT * FROM [t] JOIN u');
  // nicht mitten in Namen
  assert.equal(withoutSchema('postgres', 'SELECT * FROM notpublic.t', 'public'), 'SELECT * FROM notpublic.t');
});

test('F035/F303: Löschphase in verträglicher Reihenfolge, Kopfzeilen ohne Zeilenumbruch', () => {
  const items: CompareItem[] = [
    { kind: 'table', name: 'nur_ziel', status: 'onlyTarget', details: [], script: { drop: ['DROP TABLE nur_ziel;'] } },
    { kind: 'table', name: 't', status: 'different', details: [], script: { drop: ['ALTER TABLE t DROP COLUMN c;'] } },
    { kind: 'view', name: 'v_base', status: 'onlyTarget', details: [], script: { drop: ['DROP VIEW v_base;'] } },
    { kind: 'view', name: 'v_top', status: 'onlyTarget', details: [], script: { drop: ['DROP VIEW v_top;'] } },
    { kind: 'procedure', name: 'p', status: 'onlyTarget', details: [], script: { drop: ['DROP PROCEDURE p;'] } },
  ];
  const s = compareScript('mysql', items, true, 'Abgleich: Ziel Prod\nDROP DATABASE shop;-- an Quelle');
  const lines = s.split('\n');
  assert.equal(lines[0], '-- Abgleich: Ziel Prod');
  assert.equal(lines[1], '-- DROP DATABASE shop;-- an Quelle');
  const order = ['ALTER TABLE t DROP COLUMN c;', 'DROP PROCEDURE p;', 'DROP VIEW v_top;', 'DROP VIEW v_base;', 'DROP TABLE nur_ziel;'].map((x) => lines.indexOf(x));
  assert.ok(order.every((x) => x >= 0), s);
  assert.deepEqual([...order].sort((a, b) => a - b), order, s);
  // auskommentiert: jede Zeile
  const c = compareScript('mysql', items, false, '-- schon mit Strichen');
  assert.equal(c.split('\n')[0], '-- schon mit Strichen');
  assert.ok(!/^DROP /m.test(c));
});
