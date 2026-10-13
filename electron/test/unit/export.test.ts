/* Reine Logik ohne Datenbank (npm run test:unit): Export-Dateien – Fehler beim Schreiben, Ersetzen am Ende, Excel-Grenzen */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import type { ExportFormat, ExportOptions, ResultColumn } from '../../../shared/api-types';
import { valueConverter } from '../../dump';
import { createWriter, partFile, type ExportCell, type ExportWriter } from '../../export';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-export-unit-'));
const opts = (format: ExportFormat, p: Partial<ExportOptions> = {}): ExportOptions => ({ format, baseName: 'x', ...p });
const col = (name: string, typeName = 'varchar', numeric = false): ResultColumn => ({ name, typeName, numeric });

/** schreiben wie Manager.export: bei Fehler abort, sonst end; Frist gegen Hängen */
async function write(w: ExportWriter, columns: ResultColumn[], rows: ExportCell[][]): Promise<void> {
  const work = (async () => {
    try {
      await w.begin(columns);
      await w.rows(rows);
      await w.end();
    } catch (e) {
      await w.abort();
      throw e;
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Export hängt')), 8000)));
  try {
    await Promise.race([work, hang]);
  } finally {
    clearTimeout(timer);
  }
}

for (const format of ['csv', 'json', 'sql', 'xlsx'] as ExportFormat[]) {
  test(`F015/F128 ${format}: Zielordner fehlt – Fehler statt Absturz oder Hängen`, async () => {
    const file = path.join(dir, 'gibt-es-nicht', `x.${format}`);
    await assert.rejects(write(createWriter(file, opts(format, { dialect: 'mysql' })), [col('a')], [['1']]), /ENOENT|no such file/i);
    assert.ok(!existsSync(partFile(file)));
  });
}

test('F129/F148: vorhandene Datei bleibt bei Fehler, wird erst am Ende ersetzt', async () => {
  const file = path.join(dir, 'kunden.csv');
  writeFileSync(file, 'alt');
  const w = createWriter(file, opts('csv'));
  await w.begin([col('a')]);
  await w.rows([['neu']]);
  // mitten im Export: die alte Datei ist noch da, geschrieben wird nebenan
  assert.equal(readFileSync(file, 'utf8'), 'alt');
  await w.abort();
  assert.equal(readFileSync(file, 'utf8'), 'alt');
  assert.ok(!existsSync(partFile(file)));
  await write(createWriter(file, opts('csv', { bom: false })), [col('a')], [['neu']]);
  assert.equal(readFileSync(file, 'utf8'), 'a\r\nneu\r\n');
  assert.ok(!existsSync(partFile(file)));
  // sofort abgebrochen, noch bevor die Nachbardatei offen ist: sie darf danach nicht doch entstehen
  for (const format of ['csv', 'xlsx'] as ExportFormat[]) {
    const early = path.join(dir, `frueh.${format}`);
    await createWriter(early, opts(format)).abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!existsSync(partFile(early)), format);
  }
});

test('F015: Zieldatei gesperrt (wie in Excel geöffnet) – klare Meldung, alte Datei bleibt', { skip: process.platform !== 'win32' }, async () => {
  for (const format of ['xlsx', 'csv'] as ExportFormat[]) {
    const file = path.join(dir, `gesperrt.${format}`);
    writeFileSync(file, 'alt');
    // eine andere Anwendung hält die Datei ohne Freigabe offen (FileShare.None) – so sperrt Excel
    const holder = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${file}','Open','ReadWrite','None'); 'offen'; Start-Sleep -Seconds 30`]);
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', () => resolve());
        holder.once('exit', () => reject(new Error('Sperre ließ sich nicht setzen')));
      });
      await assert.rejects(write(createWriter(file, opts(format)), [col('a')], [['neu']]), /gesperrt/);
    } finally {
      holder.kill();
      await new Promise((r) => holder.once('exit', r));
    }
    assert.equal(readFileSync(file, 'utf8'), 'alt');
    assert.ok(!existsSync(partFile(file)));
  }
});

test('F131/F132: Excel – Zellen über 32 767 Zeichen gekürzt und gemeldet, ungültige Datumswerte bleiben Text', async () => {
  const file = path.join(dir, 'grenzen.xlsx');
  const w = createWriter(file, opts('xlsx'));
  const long = 'x'.repeat(40_000);
  await write(w, [col('txt', 'text'), col('d', 'date'), col('ts', 'timestamp'), col('b', 'varbinary')], [
    [long, '0001-01-01', '2024-00-00 10:00:00', Buffer.alloc(20_000, 0xab)],
    ['kurz', '1999-12-31', '2024-02-30 08:00:00', Buffer.from([1, 2])],
    ['', '0099-05-05', '2024-02-29 08:00:00', null],
  ]);
  assert.equal(w.notes().length, 1);
  assert.match(w.notes()[0], /^2 Zelle\(n\) mit mehr als .* Zeichen gekürzt/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const v = (r: number, c: number) => ws.getRow(r).getCell(c).value;
  assert.ok(String(v(2, 1)).length <= 32_767 && /gekürzt/.test(String(v(2, 1))), String(v(2, 1)).slice(-40));
  assert.ok(String(v(2, 4)).length <= 32_767);
  assert.equal(v(2, 2), '0001-01-01');
  assert.equal(v(2, 3), '2024-00-00 10:00:00');
  assert.equal(v(4, 2), '0099-05-05');
  assert.ok(v(3, 2) instanceof Date && (v(3, 2) as Date).toISOString().startsWith('1999-12-31'));
  assert.equal(v(3, 3), '2024-02-30 08:00:00', '30. Februar bleibt Text');
  assert.ok(v(4, 3) instanceof Date, '29.02.2024 ist ein Datum');
});

test('F130: leerer Binärwert – MySQL X\'\', SQL Server 0x, PostgreSQL leeres bytea (Export und Dump)', async () => {
  const sql = async (dialect: 'mysql' | 'mssql' | 'postgres') => {
    const file = path.join(dir, `leer-${dialect}.sql`);
    await write(createWriter(file, opts('sql', { dialect, sqlTable: 't' })), [col('id', 'int', true), col('b', 'varbinary')], [[1, Buffer.alloc(0)], [2, Buffer.from([0xde, 0xad])]]);
    return readFileSync(file, 'utf8');
  };
  assert.match(await sql('mysql'), /\(1, X''\),\n {2}\(2, 0xDEAD\)/);
  assert.match(await sql('mssql'), /\(1, 0x\),\n {2}\(2, 0xDEAD\)/);
  assert.match(await sql('postgres'), /\(1, '\\x'\),\n {2}\(2, '\\xdead'\)/);
  assert.equal(valueConverter('mysql', 'varbinary(10)', 'varbinary(10)', false)(Buffer.alloc(0)), "X''");
  assert.equal(valueConverter('mysql', 'varbinary(10)', 'varbinary(10)', false)(Buffer.from([1, 2])), '0x0102');
  assert.equal(valueConverter('mssql', 'varbinary(10)', 'varbinary(10)', false)(Buffer.alloc(0)), '0x');
});
