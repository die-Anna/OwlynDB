/* Reine Logik ohne Datenbank (npm run test:unit): Rest Hauptprozess – Vergleichsform (values.ts), Bearbeiten (edit.ts),
   versiegelte Passwörter (settings-transfer.ts), Verlauf und gemerkte Abfragen (history.ts), CSV-Formelschutz (export.ts),
   ER-Layout bei großen Diagrammen (shared/er-layout.ts), Plan-Hinweise (plan.ts) */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ColumnInfo, TableInfo } from '../../../shared/api-types';
import { layoutEr } from '../../../shared/er-layout';
import { buildWrites } from '../../edit';
import { createWriter } from '../../export';
import { QueryHistory, SavedQueries } from '../../history';
import { postgresPlan } from '../../plan';
import { seal, unseal } from '../../settings-transfer';
import { canon } from '../../values';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-rest-'));
const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({ name, dataType, nullable: true, defaultValue: null, primaryKey: false, autoIncrement: false, ...extra });
const info = (columns: ColumnInfo[]): TableInfo => ({ columns, indexes: [{ name: 'pk', columns: ['id'], unique: true, primary: true }], foreignKeys: [], referencedBy: [] });
const o = { ignoreCase: false, trailing: false };

test('F170/F171: Vergleichsform – MySQL-BIT als Zahl, große Ganzzahlen im JSON bleiben exakt', () => {
  assert.equal(canon(Buffer.from([1]), 'num', o), '1');
  assert.equal(canon(Buffer.from([0]), 'num', o), '0');
  assert.equal(canon(Buffer.from([1, 0]), 'num', o), '256');
  assert.equal(canon(true, 'num', o), '1');
  // Binärwerte bleiben Bytes
  assert.equal(canon(Buffer.from([1]), 'other', o), '\\x01');
  assert.notEqual(canon('{"id": 12345678901234567891}', 'json', o), canon('{"id": 12345678901234567890}', 'json', o));
  assert.equal(canon('{"b": 1.50, "a": 2}', 'json', o), '{"a":2,"b":1.5}');
  assert.equal(canon('[1e3, "x"]', 'json', o), '[1e3,"x"]');
});

test('F124/F125/F126/F127/F273: Bearbeiten – Typprüfung am Typnamen, Binärschlüssel als Bytes, leer = NULL, BIT als Zahl, SQL Server mit T', () => {
  const ref = { connectionId: '', database: 'db', schema: '', name: 't', kind: 'table' as const };
  // enum('realtime') ist vergleichbar (der Wert „realtime“ sagt nichts), MySQL bit und point nicht
  const my = info([col('id', 'int', { primaryKey: true }), col('status', "enum('realtime','json')"), col('flag', 'bit(1)'), col('p', 'point'), col('n', 'int'), col('bin', 'varbinary(16)', { primaryKey: true })]);
  const r = buildWrites('mysql', ref, { ...my, indexes: [{ name: 'pk', columns: ['id'], unique: true, primary: true }] }, [
    { kind: 'update', key: { id: 1 }, values: { n: '' }, original: { status: 'realtime', flag: '0x01', p: '0x00' } },
    { kind: 'insert', values: { flag: '1', n: '5' } },
  ]);
  assert.match(r.ops[0].sql, /WHERE `id` = \? AND `status` = \?$/);
  assert.deepEqual(r.ops[0].params, [null, 1, 'realtime']);
  assert.equal(r.ops[1].params[0], 1);
  assert.match(r.preview[1], /VALUES \(1, 5\)/);
  // Binärschlüssel: 0x… wird zu Bytes, gekürzt geht nicht; leer in NOT NULL ohne Standard: Meldung
  const bin = info([col('id', 'varbinary(16)', { primaryKey: true, nullable: false }), col('n', 'int', { nullable: false })]);
  const b = buildWrites('mssql', ref, bin, [{ kind: 'update', key: { id: '0xDEADBEEF' }, values: { n: '7' } }]);
  assert.ok(Buffer.isBuffer(b.ops[0].params[1]));
  assert.equal((b.ops[0].params[1] as Buffer).toString('hex'), 'deadbeef');
  assert.match(b.preview[0], /= 0xDEADBEEF;$/);
  assert.throws(() => buildWrites('mssql', ref, bin, [{ kind: 'update', key: { id: '0xDEAD… (2000 Bytes)' }, values: { n: '7' } }]), /gekürzt/);
  assert.throws(() => buildWrites('mssql', ref, bin, [{ kind: 'update', key: { id: '0x01' }, values: { n: '' } }]), /NOT NULL/);
  // SQL Server: Datum mit T
  const ms = info([col('id', 'int', { primaryKey: true }), col('am', 'datetime')]);
  const d = buildWrites('mssql', ref, ms, [{ kind: 'update', key: { id: 1 }, values: { am: '2024-02-03 10:00:00' } }]);
  assert.equal(d.ops[0].params[0], '2024-02-03T10:00:00');
  // datetimeoffset aus der Anzeige ('… +00:00'): ohne Leerzeichen vor der Zone, sonst „Conversion failed“
  const z = info([col('id', 'int', { primaryKey: true }), col('am', 'datetimeoffset(0)')]);
  const dz = buildWrites('mssql', ref, z, [{ kind: 'update', key: { id: 1 }, values: { am: '2024-02-03 10:00:00 +00:00' } }]);
  assert.equal(dz.ops[0].params[0], '2024-02-03T10:00:00+00:00');
});

test('F286/F287: versiegelte Passwörter – gebunden an die Verbindungsdaten, Arbeit begrenzt', async () => {
  const s = await seal({ a: { password: 'p' } }, 'geheim123', 'bindung-1');
  assert.deepEqual(await unseal(s, 'geheim123', 'bindung-1'), { a: { password: 'p' } });
  await assert.rejects(unseal(s, 'geheim123', 'bindung-2'), /verändert|passt nicht/);
  await assert.rejects(unseal(s, 'falsch', 'bindung-1'), /passt nicht/);
  // alte Dateien ohne Bindung bleiben lesbar
  const plain = await seal({ a: { password: 'p' } }, 'geheim123');
  assert.deepEqual(await unseal(plain, 'geheim123', 'egal'), { a: { password: 'p' } });
  await assert.rejects(unseal({ ...s, n: 1 << 20, r: 32, p: 16 }, 'geheim123', 'bindung-1'), /unbekanntes Format/);
});

test('F276/F133: Verlauf – gleichzeitige Erstaufrufe lesen einmal, Löschen meldet Schreibfehler', async () => {
  const file = path.join(dir, 'history.jsonl');
  const h = new QueryHistory(file, 100);
  const e = (sql: string) => ({ at: new Date().toISOString(), connectionId: 'c', connection: 'x', sql, durationMs: 1, ok: true });
  await Promise.all([h.add([e('a')]), h.add([e('b')]), h.list()]);
  assert.deepEqual((await h.list()).map((x) => x.sql).sort(), ['a', 'b']);
  const h2 = new QueryHistory(file, 100);
  await Promise.all([h2.add([e('c')]), h2.list()]);
  assert.deepEqual((await h2.list()).map((x) => x.sql).sort(), ['a', 'b', 'c']);
  // Löschen in einen Pfad, der nicht anlegbar ist (unter einer Datei): der Fehler kommt an
  writeFileSync(path.join(dir, 'datei.txt'), 'x');
  const bad = new QueryHistory(path.join(dir, 'datei.txt', 'history.jsonl'), 100);
  await assert.rejects(bad.clear());
  const q = new SavedQueries(path.join(dir, 'saved.json'));
  await Promise.all([q.save({ name: 'eins', sql: 'SELECT 1' }), q.save({ name: 'zwei', sql: 'SELECT 2' }), q.save({ name: 'drei', sql: 'SELECT 3' })]);
  assert.deepEqual((await q.list()).map((x) => x.name).sort(), ['drei', 'eins', 'zwei']);
  assert.equal((JSON.parse(readFileSync(path.join(dir, 'saved.json'), 'utf8')) as unknown[]).length, 3);
});

test('F275: CSV – Textzellen mit =, +, -, @ bekommen einen Apostroph, Zahlen nicht', async () => {
  const file = path.join(dir, 'x.csv');
  const w = createWriter(file, { format: 'csv', baseName: 'x', bom: false });
  await w.begin([
    { name: 'n', typeName: 'int', numeric: true },
    { name: 't', typeName: 'text', numeric: false },
  ]);
  await w.rows([
    [-5, '=1+1'],
    [7, '-7'],
    [8, '@x'],
    [9, 'ok'],
  ]);
  await w.end();
  assert.equal(readFileSync(file, 'utf8'), "n;t\r\n-5;'=1+1\r\n7;'-7\r\n8;'@x\r\n9;ok\r\n");
  const off = createWriter(path.join(dir, 'y.csv'), { format: 'csv', baseName: 'y', bom: false, protectFormulas: false });
  await off.begin([{ name: 't', typeName: 'text', numeric: false }]);
  await off.rows([['=1+1']]);
  await off.end();
  assert.equal(readFileSync(path.join(dir, 'y.csv'), 'utf8'), 't\r\n=1+1\r\n');
});

test('F172/F173: ER-Layout mit vielen Verweisern auf eine Tabelle über mehrere Schichten bleibt schnell und wirft nicht', () => {
  const boxes = [{ key: 'hub', width: 100, height: 40 }];
  const links: { from: string; to: string }[] = [];
  // Ketten a_i → b_i → c_i → hub: die Verbindung a_i → hub überbrückt zwei Schichten
  for (let i = 0; i < 1500; i++) {
    boxes.push({ key: `a${i}`, width: 100, height: 40 }, { key: `b${i}`, width: 100, height: 40 }, { key: `c${i}`, width: 100, height: 40 });
    links.push({ from: `a${i}`, to: `b${i}` }, { from: `b${i}`, to: `c${i}` }, { from: `c${i}`, to: 'hub' }, { from: `a${i}`, to: 'hub' });
  }
  const t0 = Date.now();
  const l = layoutEr(boxes, links);
  assert.ok(l.pos.size >= 4501);
  assert.ok(Date.now() - t0 < 20_000, `${Date.now() - t0} ms`);
});

test('F164/F165/F166/F284: PostgreSQL-Plan – parallele Zeiten, CTE einmal, gehashter SubPlan einmal, Limit ohne „zu hoch“', () => {
  const node = (type: string, extra: Record<string, unknown> = {}, plans: Record<string, unknown>[] = []) => ({
    'Node Type': type,
    'Plan Rows': 1000,
    'Total Cost': 10,
    'Actual Loops': 1,
    'Actual Rows': 1000,
    'Actual Total Time': 100,
    ...extra,
    ...(plans.length ? { Plans: plans } : {}),
  });
  // Gather mit 2 Workern: der Scan darunter meldet je Teilnehmer 100 ms bei 3 Loops – Wanduhr 100, nicht 300
  const gather = node('Gather', { 'Workers Launched': 2, 'Actual Total Time': 120 }, [node('Seq Scan', { 'Parent Relationship': 'Outer', 'Actual Loops': 3, 'Actual Rows': 300, 'Actual Total Time': 100, 'Rows Removed by Filter': 0 })]);
  const g = postgresPlan('SELECT 1', [{ Plan: gather }], true);
  const scan = g.root!.children[0];
  assert.equal(scan.timeMs, 100);
  assert.equal(g.root!.selfMs, 20);
  // CTE: Scan 150 ms enthält die 100 ms des InitPlans – die Zeit zählt einmal
  const cte = node('Aggregate', { 'Actual Total Time': 160 }, [
    node('Seq Scan', { 'Parent Relationship': 'InitPlan', 'Subplan Name': 'CTE x', 'Actual Total Time': 100 }),
    node('CTE Scan', { 'Parent Relationship': 'Outer', 'CTE Name': 'x', 'Actual Total Time': 150 }),
  ]);
  const c = postgresPlan('SELECT 1', [{ Plan: cte }], true);
  assert.equal(c.root!.children[1].timeMs, 50);
  assert.equal(c.root!.selfMs, 10);
  // hashed SubPlan: einmal statt je Zeile – sein Anteil an den Kosten bleibt klein (10 von 100), nicht 1000 × 10
  const subPlan = (filter: string) => node('Seq Scan', { Filter: filter, 'Total Cost': 100 }, [node('Seq Scan', { 'Parent Relationship': 'SubPlan', 'Subplan Name': 'SubPlan 1' })]);
  const hashed = postgresPlan('SELECT 1', [{ Plan: subPlan('(NOT (hashed SubPlan 1))') }], false);
  assert.ok((hashed.root!.children[0].share ?? 0) < 0.2, String(hashed.root!.children[0].share));
  const perRow = postgresPlan('SELECT 1', [{ Plan: subPlan('(NOT (SubPlan 1))') }], false);
  assert.ok((perRow.root!.children[0].share ?? 0) > 0.9, String(perRow.root!.children[0].share));
  // Limit: das Kind liefert 10 statt 1000 geschätzter Zeilen – kein „zu hoch“
  const limit = node('Limit', { 'Plan Rows': 10, 'Actual Rows': 10 }, [node('Seq Scan', { 'Parent Relationship': 'Outer', 'Actual Rows': 10 })]);
  const l = postgresPlan('SELECT 1', [{ Plan: limit }], true);
  assert.ok(!l.root!.children[0].warnings.some((w) => /zu hoch/.test(w)), l.root!.children[0].warnings.join(' | '));
  const low = node('Seq Scan', { 'Plan Rows': 10, 'Actual Rows': 5000 });
  assert.ok(postgresPlan('SELECT 1', [{ Plan: low }], true).root!.warnings.some((w) => /zu niedrig/.test(w)));
});
