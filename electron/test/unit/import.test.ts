/* Reine Logik ohne Datenbank (npm run test:unit): Kodierung und Format einer SQL-Datei (electron/import.ts, inspectFile) */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertRowCount, inspectFile, skippedSummary } from '../../import';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-import-unit-'));
let n = 0;
function file(content: Buffer | string, encoding: BufferEncoding = 'utf8'): string {
  const f = path.join(dir, `f${++n}.sql`);
  writeFileSync(f, typeof content === 'string' ? Buffer.from(content, encoding) : content);
  return f;
}

test('inspectFile: BOM und UTF-16 (auch ohne BOM, SSMS)', async () => {
  assert.equal((await inspectFile(file(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('SELECT 1')])), 'mssql')).encoding, 'utf-8');
  assert.equal((await inspectFile(file(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT 1', 'utf16le')])), 'mssql')).encoding, 'utf-16le');
  assert.equal((await inspectFile(file('SELECT 1', 'utf16le'), 'mssql')).encoding, 'utf-16le');
  const be = Buffer.from('SELECT 1', 'utf16le').swap16();
  assert.equal((await inspectFile(file(be), 'mssql')).encoding, 'utf-16be');
  assert.equal((await inspectFile(file(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'mssql')).encoding, 'utf-16be');
});

test('inspectFile: Archive und Binärformate werden mit Hinweis abgelehnt', async () => {
  await assert.rejects(inspectFile(file(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00])), 'mysql'), /gzip/);
  await assert.rejects(inspectFile(file(Buffer.from('PK\x03\x04rest', 'latin1')), 'mysql'), /ZIP/);
  await assert.rejects(inspectFile(file(Buffer.from('PGDMP\x01\x0e', 'latin1')), 'postgres'), /pg_restore/);
  await assert.rejects(inspectFile(file(Buffer.from([0xff, 0xfe, 0, 0, 0x53, 0, 0, 0])), 'mssql'), /UTF-32/);
});

test('inspectFile: deklarierte Kodierung im Kopf (SET NAMES, client_encoding)', async () => {
  const my = await inspectFile(file("/*!40101 SET NAMES latin1 */;\nINSERT INTO t VALUES ('M\xfcller');\n", 'latin1'), 'mysql');
  assert.equal(my.encoding, 'windows-1252');
  assert.match(my.note ?? '', /latin1/);
  const pg = await inspectFile(file("SET client_encoding = 'WIN1250';\nSELECT 1;\n"), 'postgres');
  assert.equal(pg.encoding, 'windows-1250');
  // utf8mb4 deklariert: kein Hinweis nötig
  const u = await inspectFile(file('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;\n'), 'mysql');
  assert.equal(u.encoding, 'utf-8');
  assert.equal(u.note, undefined);
  // die Variablen-Sicherung von mysqldump ist keine Deklaration
  const saved = await inspectFile(file('/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nSELECT 1;\n'), 'mysql');
  assert.equal(saved.encoding, 'utf-8');
  await assert.rejects(inspectFile(file('SET NAMES klingon;\n'), 'mysql'), /klingon/);
});

test('inspectFile: kein gültiges UTF-8 ohne Deklaration → Windows-1252 mit Hinweis; Rohbytes (_binary) → Abbruch', async () => {
  const ansi = await inspectFile(file("INSERT INTO t VALUES ('M\xfcller');\n", 'latin1'), 'mssql');
  assert.equal(ansi.encoding, 'windows-1252');
  assert.match(ansi.note ?? '', /Windows-1252/);
  await assert.rejects(inspectFile(file(Buffer.concat([Buffer.from("INSERT INTO b VALUES (_binary '"), Buffer.from([0xff, 0xfe]), Buffer.from("');\n")])), 'mysql'), /hex-blob/);
  // gültiges UTF-8 mit Umlauten bleibt UTF-8
  const ok = await inspectFile(file("INSERT INTO t VALUES ('Müller ✓');\n"), 'mysql');
  assert.equal(ok.encoding, 'utf-8');
  assert.equal(ok.note, undefined);
});

test('insertRowCount: Zeilen eines Mehrzeilen-INSERTs, Zeichenketten mit „),(“ zählen nicht (F335)', () => {
  assert.equal(insertRowCount("INSERT INTO `kunde` (`id`, `name`) VALUES\n(1, 'a'),\n(2, 'b),(c'),\n(3, NULL);", 'mysql'), 3);
  // mysqldump: \-Escapes in Zeichenketten
  assert.equal(insertRowCount("INSERT INTO `t` VALUES (1,'it\\'s (x)'),(2,'\\\\'),(3,'');", 'mysql'), 3);
  // PostgreSQL: verdoppelte Anführungszeichen, ON CONFLICT (…) ist kein Tupel
  assert.equal(insertRowCount('INSERT INTO "T" ("a b") VALUES (\'x\'\'),(\'), (2) ON CONFLICT (id) DO NOTHING', 'postgres'), 2);
  assert.equal(insertRowCount("INSERT INTO [t] ([v]) VALUES (N'('), (N')');", 'mssql'), 2);
  assert.equal(insertRowCount("UPDATE t SET a = 1", 'mysql'), 0);
  assert.equal(insertRowCount("INSERT INTO t SELECT * FROM u", 'mysql'), 0);
});

test('skippedSummary: übersprungene Anweisungen, verlorene Zeilen, fehlende Indizes', () => {
  const p = { bytes: 0, total: 0, statements: 10, errors: 3, skipped: 0, warnings: 0, lostRows: 750, missingObjects: 1, line: 0, log: [] };
  assert.equal(skippedSummary(p), '3 Anweisung(en) mit Fehler übersprungen – 750 Zeile(n) nicht eingefügt – 1 Index/Schlüssel fehlen im Ziel.');
  assert.equal(skippedSummary({ ...p, lostRows: 0, missingObjects: 0 }), '3 Anweisung(en) mit Fehler übersprungen.');
});
