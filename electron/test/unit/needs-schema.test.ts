/* Reine Logik ohne Datenbank (npm run test:unit): Tabellen aus der Vervollständigung mit Schema einsetzen, wo der Server sie
   ohne nicht fände – Fehler „Invalid object name 'MITARBEITER'“ bei einer Tabelle spx.MITARBEITER und Standardschema dbo */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsSchema } from '../../../shared/sql-util';

const t = (schema: string, name: string) => ({ schema, name });

test('needsSchema SQL Server: Standardschema und dbo ohne, andere Schemas mit Schema', () => {
  const mitarbeiter = t('spx', 'MITARBEITER');
  const kunden = t('dbo', 'kunden');
  const all = [mitarbeiter, kunden];
  assert.equal(needsSchema('mssql', mitarbeiter, all, ['dbo']), true);
  assert.equal(needsSchema('mssql', kunden, all, ['dbo']), false);
  // Standardschema spx: Suche erst in spx, dann in dbo
  assert.equal(needsSchema('mssql', mitarbeiter, all, ['spx', 'dbo']), false);
  assert.equal(needsSchema('mssql', kunden, all, ['spx', 'dbo']), false);
  // ohne Suchpfad (älterer Stand): nur dbo ohne Schema; Groß-/Kleinschreibung egal
  assert.equal(needsSchema('mssql', mitarbeiter, all), true);
  assert.equal(needsSchema('mssql', t('DBO', 'x'), [t('DBO', 'x')]), false);
});

test('needsSchema: gleichnamige Tabelle weiter vorn im Suchpfad verdeckt', () => {
  const vorn = t('spx', 'personal');
  const hinten = t('dbo', 'PERSONAL');
  const all = [vorn, hinten];
  assert.equal(needsSchema('mssql', vorn, all, ['spx', 'dbo']), false);
  assert.equal(needsSchema('mssql', hinten, all, ['spx', 'dbo']), true);
  // PostgreSQL unterscheidet Groß-/Kleinschreibung: "PERSONAL" ist eine andere Tabelle als personal
  const pVorn = t('app', 'personal');
  const pHinten = t('public', 'PERSONAL');
  assert.equal(needsSchema('postgres', pHinten, [pVorn, pHinten], ['app', 'public']), false);
  assert.equal(needsSchema('postgres', t('public', 'personal'), [pVorn, t('public', 'personal')], ['app', 'public']), true);
});

test('needsSchema PostgreSQL, MySQL, Elasticsearch', () => {
  assert.equal(needsSchema('postgres', t('public', 'kunden'), [t('public', 'kunden')], ['public']), false);
  assert.equal(needsSchema('postgres', t('lager', 'artikel'), [t('lager', 'artikel')], ['public']), true);
  assert.equal(needsSchema('postgres', t('lager', 'artikel'), [t('lager', 'artikel')]), true);
  assert.equal(needsSchema('mysql', t('', 'kunden'), [t('', 'kunden')]), false);
  assert.equal(needsSchema('elasticsearch', t('', 'logs-2026'), [t('', 'logs-2026')]), false);
});
