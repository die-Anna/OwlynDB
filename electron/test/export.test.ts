/* Export gegen die Test-Datenbanken (npm run testdb:up; Seed aus test:drivers muss schon eingespielt sein).
   Aufruf: npm run test:export [mysql|postgres|mssql] */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Dialect, ExportFormat, ExportOptions, ObjectRef, SqlDialect, TableDataRequest } from '../../shared/api-types';
import { splitSql } from '../../shared/sql-splitter';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const testdb = JSON.parse(readFileSync(path.join(root, 'dev/testdb.json'), 'utf8')) as Record<Dialect, { host: string; port: number; user: string; password: string }>;
const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-export-'));
let nextFile: string | null = null;

const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const manager = new Manager(store, {
  pickFile: async () => null,
  saveFile: async (base, format) => {
    const f = nextFile ?? path.join(dir, `${base}.${format}`);
    nextFile = null;
    return f;
  },
  showInFolder: () => undefined,
});

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).stack?.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

async function testDialect(dialect: Dialect) {
  console.log(`\n${dialect}`);
  const c = testdb[dialect];
  const conn = await store.save({
    name: dialect,
    dialect,
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: dialect === 'postgres' ? 'shop' : '',
    options: dialect === 'mssql' ? { trustServerCertificate: true } : {},
  });
  const schema = dialect === 'mysql' ? '' : dialect === 'mssql' ? 'dbo' : 'public';
  const ref = (name: string): ObjectRef => ({ connectionId: conn.id, database: 'shop', schema, name, kind: 'table' });
  const req = (name: string, p: Partial<TableDataRequest> = {}): TableDataRequest => ({ object: ref(name), limit: 500, offset: 0, sort: [], ...p });
  const opts = (format: ExportFormat, p: Partial<ExportOptions> = {}): ExportOptions => ({ format, baseName: `${dialect}-${format}`, dialect, ...p });

  await step('CSV: ganze Tabelle, BOM, Trennzeichen, NULL, Binär vollständig', async () => {
    const r = (await manager.exportTable(req('kunden', { sort: [{ column: 'id', dir: 'asc' }] }), opts('csv')))!;
    assert.equal(r.rows, 2500);
    const text = readFileSync(r.file, 'utf8');
    assert.ok(text.startsWith('﻿'), 'BOM');
    const lines = text.slice(1).split('\r\n');
    assert.equal(lines.length, 2502); // Kopf + 2500 + leere letzte
    assert.match(lines[0], /^id;name;ort;erstellt;aktiv;guthaben;notiz;avatar/);
    const r11 = lines[11].split(';'); // id 11: guthaben NULL
    assert.equal(r11[0], '11');
    assert.equal(r11[5], '');
    assert.match(lines[100], /0xDEADBEEF/);
    assert.match(lines[42], /Sonderfall: 100% Rabatt_test/);
  });

  await step('CSV: Komma, ohne Kopf, Filter und Suche, Felder mit Trennzeichen gequotet', async () => {
    const r = (await manager.exportTable(req('kunden', { search: 'Rabatt' }), opts('csv', { delimiter: ',', header: false, bom: false })))!;
    assert.equal(r.rows, 1);
    const text = readFileSync(r.file, 'utf8');
    assert.ok(!text.startsWith('﻿'));
    assert.match(text, /^42,Kunde 0042,/);
    const w = dialect === 'postgres' ? 'NOT aktiv' : 'aktiv = 0';
    const r2 = (await manager.exportTable(req('kunden', { where: w }), opts('csv')))!;
    assert.equal(r2.rows, 357);
  });

  await step('Stream über mehrere Häppchen (6000 Zeilen, sortiert)', async () => {
    const r = (await manager.exportTable(req('bestellungen', { sort: [{ column: 'id', dir: 'desc' }] }), opts('csv', { bom: false })))!;
    assert.equal(r.rows, 6000);
    const lines = readFileSync(r.file, 'utf8').split('\r\n');
    assert.match(lines[1], /^6000;/);
    assert.match(lines[6000], /^1;/);
  });

  await step('JSON: Zahlen, NULL, Binär', async () => {
    const r = (await manager.exportTable(req('kunden', { sort: [{ column: 'id', dir: 'asc' }] }), opts('json')))!;
    const data = JSON.parse(readFileSync(r.file, 'utf8')) as Record<string, unknown>[];
    assert.equal(data.length, 2500);
    assert.equal(data[0].id, 1);
    assert.equal(data[0].guthaben, 1.37);
    assert.equal(data[10].guthaben, null);
    assert.equal(String(data[99].avatar).toUpperCase(), '0xDEADBEEF'.toUpperCase());
  });

  await step('Excel: Zahlen, Datum, NULL, Kopf fett, Autofilter', async () => {
    const r = (await manager.exportTable(req('kunden', { sort: [{ column: 'id', dir: 'asc' }] }), opts('xlsx')))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.file);
    const ws = wb.worksheets[0];
    assert.equal(ws.rowCount, 2501);
    assert.equal(ws.getRow(1).getCell(1).value, 'id');
    assert.ok(ws.getRow(1).font?.bold || ws.getRow(1).getCell(1).font?.bold, 'Kopf fett');
    assert.ok(ws.autoFilter, 'Autofilter');
    assert.equal(ws.views[0]?.state, 'frozen', 'Kopfzeile fixiert');
    assert.equal(ws.views[0]?.ySplit, 1);
    const row2 = ws.getRow(2);
    assert.equal(row2.getCell(1).value, 1);
    assert.equal(row2.getCell(6).value, 1.37);
    const d = row2.getCell(4).value;
    assert.ok(d instanceof Date, 'erstellt als Datum: ' + String(d));
    assert.equal((d as Date).toISOString(), '2024-01-01T09:00:00.000Z');
    assert.equal(ws.getRow(12).getCell(6).value, null);
  });

  await step('SQL: INSERTs zurückspielen ergibt dieselben Daten', async () => {
    const r = (await manager.exportTable(req('kunden'), opts('sql', { sqlTable: dialect === 'mysql' ? 'kunden_copy' : `${schema}.kunden_copy`, rowsPerInsert: 250 })))!;
    assert.equal(r.rows, 2500);
    const prepare =
      dialect === 'mysql'
        ? ['DROP TABLE IF EXISTS kunden_copy', 'CREATE TABLE kunden_copy LIKE kunden']
        : dialect === 'postgres'
          ? ['DROP TABLE IF EXISTS public.kunden_copy', 'CREATE TABLE public.kunden_copy (LIKE public.kunden INCLUDING ALL)']
          : ["IF OBJECT_ID('dbo.kunden_copy') IS NOT NULL DROP TABLE dbo.kunden_copy", 'SELECT TOP 0 * INTO dbo.kunden_copy FROM dbo.kunden'];
    const script = readFileSync(r.file, 'utf8');
    const stmts = splitSql(script, dialect).map((s) => s.sql);
    assert.equal(stmts.length, 10);
    const all = [...prepare, ...(dialect === 'mssql' ? stmts.map((s) => `SET IDENTITY_INSERT dbo.kunden_copy ON;\n${s};\nSET IDENTITY_INSERT dbo.kunden_copy OFF`) : stmts)];
    const { sessionId } = await manager.openSession(conn.id, 'shop');
    try {
      const run = await manager.runQuery(sessionId, all.map((sql) => ({ sql, offset: 0 })), 10);
      const err = run.statements.find((s) => s.error);
      assert.ok(!err, err?.error);
      const t = (n: string) => (dialect === 'mysql' ? n : `${schema}.${n}`);
      const cmp = `SELECT COUNT(*), SUM(guthaben), COUNT(avatar), MAX(notiz), MAX(erstellt) FROM ${t('kunden')}
                   UNION ALL SELECT COUNT(*), SUM(guthaben), COUNT(avatar), MAX(notiz), MAX(erstellt) FROM ${t('kunden_copy')}`;
      const check = await manager.runQuery(sessionId, [{ sql: cmp, offset: 0 }], 10);
      assert.ok(!check.statements[0].error, check.statements[0].error);
      const [a, b] = check.results[0].rows;
      assert.deepEqual(b, a);
      const bin = await manager.runQuery(sessionId, [{ sql: `SELECT avatar FROM ${t('kunden_copy')} WHERE id = 100`, offset: 0 }], 1);
      assert.match(String(bin.results[0].rows[0][0]).toUpperCase(), /DEADBEEF/);
    } finally {
      await manager.closeSession(sessionId);
    }
  });

  await step('Fehler mitten im Export: keine halbe Datei, eine vorhandene bleibt (F129/F148)', async () => {
    const file = path.join(dir, `${dialect}-kaputt.csv`);
    nextFile = file;
    await assert.rejects(manager.exportTable(req('kunden', { where: 'gibt_es_nicht = 1' }), opts('csv')));
    assert.ok(!existsSync(file) && !existsSync(`${file}.part`), 'keine Datei');
    writeFileSync(file, 'alt');
    nextFile = file;
    await assert.rejects(manager.exportTable(req('kunden', { where: 'gibt_es_nicht = 1' }), opts('xlsx')));
    assert.equal(readFileSync(file, 'utf8'), 'alt');
    assert.ok(!existsSync(`${file}.part`));
  });

  await step('Tabellen-Export abbrechen (F149): Abgebrochen, vorhandene Datei bleibt', async () => {
    const file = path.join(dir, `${dialect}-abbruch.csv`);
    writeFileSync(file, 'alt');
    nextFile = file;
    const token = `abbruch-${dialect}`;
    const running = manager.exportTable(req('bestellungen', { sort: [{ column: 'betrag', dir: 'desc' }] }), opts('csv', { cancelToken: token }));
    await manager.cancelExport(token);
    await assert.rejects(running, /Abgebrochen/);
    assert.equal(readFileSync(file, 'utf8'), 'alt');
    assert.ok(!existsSync(`${file}.part`));
    // danach geht es normal weiter
    assert.equal((await manager.exportTable(req('kunden'), opts('csv')))!.rows, 2500);
  });

  await step('Dump abgebrochen: vorhandene Datei bleibt (F148)', async () => {
    const file = path.join(dir, `${dialect}-dump.sql`);
    writeFileSync(file, 'alt');
    nextFile = file;
    const tables = ['kunden', 'bestellungen'].map((name) => ({ schema, name }));
    const id = (await manager.startDump({ connectionId: conn.id, database: 'shop', tables, views: [], structure: true, data: true, dropFirst: true, targetDialect: dialect as SqlDialect, rowsPerInsert: 100, baseName: 'x' }))!;
    await manager.cancelJob(id);
    let s = await manager.jobStatus(id);
    while (s.state === 'running') s = (await new Promise((r) => setTimeout(r, 50)), await manager.jobStatus(id));
    assert.equal(s.state, 'cancelled');
    assert.equal(readFileSync(file, 'utf8'), 'alt');
    assert.ok(!existsSync(`${file}.part`));
  });

  await step('Speichern abgebrochen: null', async () => {
    const m = new Manager(store, { pickFile: async () => null, saveFile: async () => null, showInFolder: () => undefined });
    assert.equal(await m.exportTable(req('kunden'), opts('csv')), null);
  });

  await manager.disconnect(conn.id);
}

async function main() {
  assertTestContainers(Object.entries(testdb).map(([name, c]) => ({ name, host: c.host, port: c.port })));
  console.log('Ziel: ' + dir);
  await step('exportRows: geladene Zeilen, doppelte Spaltennamen, Quoting', async () => {
    const cols = [
      { name: 'a', typeName: 'int', numeric: true },
      { name: 'a', typeName: 'varchar', numeric: false },
      { name: 'b', typeName: 'text', numeric: false },
    ];
    const rows = [
      [1, 'x', 'mit; Semikolon'],
      [2, null, 'Zeile\numbruch "zitat"'],
    ];
    const r = (await manager.exportRows(cols, rows, { format: 'csv', baseName: 'rows' }))!;
    assert.equal(readFileSync(r.file, 'utf8'), '﻿a;a;b\r\n1;x;"mit; Semikolon"\r\n2;;"Zeile\numbruch ""zitat"""\r\n');
    const j = (await manager.exportRows(cols, rows, { format: 'json', baseName: 'rows' }))!;
    assert.deepEqual(JSON.parse(readFileSync(j.file, 'utf8')), [
      { a: 1, a_2: 'x', b: 'mit; Semikolon' },
      { a: 2, a_2: null, b: 'Zeile\numbruch "zitat"' },
    ]);
  });
  const only = process.argv[2] as Dialect | undefined;
  for (const d of (['mysql', 'postgres', 'mssql'] as Dialect[]).filter((x) => !only || x === only)) {
    try {
      await testDialect(d);
    } catch (e) {
      failed++;
      console.log(`  FEHL ${d}: ${(e as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
