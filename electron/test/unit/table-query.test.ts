/* Reine Logik ohne Datenbank (npm run test:unit): Tabellenabfrage und Zellen der Treiber (electron/drivers/common.ts, mysql.ts) –
   Review: MySQL-Treiber und gemeinsame Treiberlogik */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColumnInfo, TableDataRequest } from '../../../shared/api-types';
import { buildTableQuery, escapeLike, normalizeCell, TEXT_LIMIT } from '../../drivers/common';
import { isUseStatement, mysqlDialect } from '../../drivers/mysql';

const col = (name: string, dataType: string): ColumnInfo => ({ name, dataType, nullable: true, defaultValue: null, primaryKey: false, autoIncrement: false });
const req = (extra: Partial<TableDataRequest> = {}): TableDataRequest => ({
  object: { connectionId: '', database: 'db', schema: '', name: 't', kind: 'table' },
  limit: 0,
  offset: 0,
  sort: [],
  ...extra,
});

test('F051/F234: escapeLike maskiert auch [ und ] (SQL Server: Zeichenklassen)', () => {
  assert.equal(escapeLike('a[b]c%d_e\\f'), 'a\\[b\\]c\\%d\\_e\\\\f');
});

test('F233: MySQL setzt den Suchtext als Literal ein, nicht als ?-Platzhalter', () => {
  const r = buildTableQuery(mysqlDialect, req({ search: "O'x", where: "note = 'was?'" }), [col('a', 'varchar(10)'), col('b', 'int')], false);
  assert.deepEqual(r.params, []);
  assert.match(r.sql, /LIKE '%O''x%'/);
  assert.match(r.sql, /note = 'was\?'/);
  assert.equal((r.sql.match(/LIKE/g) ?? []).length, 2);
});

test('F259: searchExpr prüft nur den Typnamen – enum(\'endpoint\') wird durchsucht, blob nicht', () => {
  assert.ok(mysqlDialect.searchExpr(col('s', "enum('start','endpoint')")));
  assert.ok(mysqlDialect.searchExpr(col('s', "set('binary','text')")));
  assert.equal(mysqlDialect.searchExpr(col('b', 'blob')), null);
  assert.equal(mysqlDialect.searchExpr(col('b', 'varbinary(16)')), null);
  assert.equal(mysqlDialect.searchExpr(col('g', 'point')), null);
  assert.equal(mysqlDialect.searchExpr(col('g', 'multipolygon')), null);
});

test('F050/F049: PostgreSQL – NULLS LAST und FROM ONLY nur auf Wunsch', () => {
  const pg = { ...mysqlDialect, name: 'postgres' as const, quote: (s: string) => `"${s}"`, qualified: (_d: string, sch: string, n: string) => `"${sch}"."${n}"`, param: (n: number) => `$${n}` };
  const r = buildTableQuery(pg, req({ object: { connectionId: '', database: 'db', schema: 'public', name: 't', kind: 'table' }, sort: [{ column: 'a', dir: 'desc', nulls: 'last' }], only: true }), [col('a', 'int')], false);
  assert.match(r.sql, /FROM ONLY "public"\."t"/);
  assert.match(r.sql, /ORDER BY "a" DESC NULLS LAST/);
  // MySQL: beides ohne Wirkung
  const m = buildTableQuery(mysqlDialect, req({ sort: [{ column: 'a', dir: 'desc', nulls: 'last' }], only: true }), [col('a', 'int')], false);
  assert.match(m.sql, /FROM `db`\.`t`/);
  assert.match(m.sql, /ORDER BY `a` DESC$/m);
  assert.ok(!/NULLS/.test(m.sql));
});

test('F047: riesige Texte werden für die Anzeige gekürzt und markiert', () => {
  const big = 'x'.repeat(TEXT_LIMIT + 1000);
  const v = normalizeCell(big) as string;
  assert.ok(v.length < big.length && v.length < TEXT_LIMIT + 100, String(v.length));
  assert.match(v, /… \(\d+ Zeichen\)$/);
  assert.equal(normalizeCell('kurz'), 'kurz');
});

test('F088: USE hinter vielen Blockkommentaren in konstanter Zeit', () => {
  const comments = Array.from({ length: 40 }, () => '/* x */').join(' ');
  const t0 = Date.now();
  assert.equal(isUseStatement(`${comments} SELECT 1`), false);
  assert.equal(isUseStatement(`${comments}\nuse shop`), true);
  assert.equal(isUseStatement('-- k\n# k\nUSE `shop`'), true);
  assert.equal(isUseStatement('SELECT 1; USE shop'), false);
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
});
