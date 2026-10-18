/* Reine Logik ohne Datenbank (npm run test:unit): Tabellen aus der Vervollständigung mit Schema einsetzen, wo der Server sie
   ohne nicht fände – Fehler „Invalid object name 'MITARBEITER'“ bei einer Tabelle spx.MITARBEITER und Standardschema dbo */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsSchema, openIdentQuote, schemaNeeded } from '../../../shared/sql-util';

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

/** die frühere Prüfung: je Tabelle alle anderen durchsuchen (quadratisch) – als Maßstab für den Index */
function naive(dialect: 'mssql' | 'postgres', tb: { schema: string; name: string }, all: { schema: string; name: string }[], searchPath?: string[]): boolean {
  if (!tb.schema) return false;
  const path = searchPath ?? (dialect === 'mssql' ? ['dbo'] : ['public']);
  const norm = (s: string) => (dialect === 'mssql' ? s.toLowerCase() : s);
  const at = (schema: string) => path.findIndex((p) => norm(p) === norm(schema));
  const mine = at(tb.schema);
  if (mine < 0) return true;
  return all.some((o) => o !== tb && norm(o.name) === norm(tb.name) && at(o.schema) >= 0 && at(o.schema) < mine);
}

test('schemaNeeded: gleiches Ergebnis wie die Prüfung je Tabelle (Zufallsdaten, beide Dialekte)', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const schemas = ['dbo', 'DBO', 'spx', 'Spx', 'audit', 'public', 'app', ''];
  const names = ['kunden', 'KUNDEN', 'personal', 'Personal', 'artikel', 'log_2026', 'x'];
  for (const dialect of ['mssql', 'postgres'] as const) {
    for (let round = 0; round < 50; round++) {
      const seen = new Set<string>();
      const all = Array.from({ length: 30 }, () => t(schemas[rnd(schemas.length)], names[rnd(names.length)])).filter((x) => {
        const k = dialect === 'mssql' ? (x.schema + '.' + x.name).toLowerCase() : x.schema + '.' + x.name;
        return !seen.has(k) && seen.add(k);
      });
      const path = [undefined, ['dbo'], ['spx', 'dbo'], ['app', 'public'], ['audit', 'spx', 'public']][rnd(5)];
      const needs = schemaNeeded(dialect, all, path);
      for (const x of all) assert.equal(needs(x), naive(dialect, x, all, path), `${dialect} ${x.schema}.${x.name} im Pfad ${path}`);
    }
  }
});

test('schemaNeeded: 30 000 Tabellen in Sekundenbruchteilen (früher hing der Editor bei jedem Tastendruck)', () => {
  const all = Array.from({ length: 30_000 }, (_, i) => t(i % 10 === 0 ? 'archiv' : 'dbo', `k${String(Math.floor(i / 3)).padStart(5, '0')}_${['adr', 'data', 'stat'][i % 3]}`));
  const start = performance.now();
  const needs = schemaNeeded('mssql', all, ['dbo']);
  const count = all.filter(needs).length;
  const ms = performance.now() - start;
  assert.equal(count, 3000);
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

test('openIdentQuote: angefangener Name in Anführungszeichen je Dialekt', () => {
  assert.deepEqual(openIdentQuote('mssql', 'select * from [Order De'), { open: '[', close: ']', at: 14 });
  assert.deepEqual(openIdentQuote('mssql', 'select * from ['), { open: '[', close: ']', at: 14 });
  assert.equal(openIdentQuote('mssql', 'select * from [Order Details] o'), null);
  // verdoppelter Schließer gehört zum Namen, der danach noch offen ist
  assert.deepEqual(openIdentQuote('mssql', 'select * from [a]]b'), { open: '[', close: ']', at: 14 });
  // [ in einer Zeichenkette zählt nicht, auch nicht nach verdoppeltem Hochkomma
  assert.equal(openIdentQuote('mssql', "select 'it''s [x' "), null);
  assert.deepEqual(openIdentQuote('mssql', "select 'it''s [x', [y"), { open: '[', close: ']', at: 19 });
  // schon vorher geschlossene Namen, dann ein neuer: [spx].[MIT
  assert.deepEqual(openIdentQuote('mssql', 'select * from [spx].[MIT'), { open: '[', close: ']', at: 20 });
  assert.deepEqual(openIdentQuote('mssql', 'select "Na'), { open: '"', close: '"', at: 7 });
  assert.deepEqual(openIdentQuote('postgres', 'select * from "Kun'), { open: '"', close: '"', at: 14 });
  assert.equal(openIdentQuote('postgres', 'select * from "Kunden" k'), null);
  assert.deepEqual(openIdentQuote('mysql', 'select * from `lo'), { open: '`', close: '`', at: 14 });
  // MySQL: " beginnt eine Zeichenkette, keinen Namen; Elasticsearch: keine Vervollständigung in Anführungszeichen
  assert.equal(openIdentQuote('mysql', 'select "ab'), null);
  assert.equal(openIdentQuote('elasticsearch', 'select * from "logs'), null);
});
