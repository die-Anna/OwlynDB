/* Datenvergleich: fehlende, überzählige und geänderte Zeilen (Text, NULL, Binär, Datum, nur Groß/klein, nur Leerzeichen),
   zusammengesetzter Schlüssel, Identitätsspalte, Tabelle ohne Primärschlüssel, doppelte Schlüssel, WHERE, Spaltenauswahl,
   Abbrechen; danach das Abgleich-Skript im Ziel ausführen – ein neuer Vergleich muss leer sein; Skript als Datei (ohne
   Obergrenze, auch für ein ganzes Schema in Fremdschlüssel-Reihenfolge) einspielen. Dazu MySQL → PostgreSQL und
   PostgreSQL → SQL Server (Werte über Datenbanktypen hinweg).
   Vorher: npm run testdb:up. Aufruf: npm run test:datacompare [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataCompareAllRequest, DataCompareAllResult, DataCompareRequest, DataCompareResult, DataCompareSide, JobStatus, SqlDialect } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-dc-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
/** Skript als Datei: der Speichern-Dialog liefert diesen Pfad */
let saveAs = '';
const m = new Manager(store, { pickFile: async () => null, saveFile: async () => saveAs || null, showInFolder: () => undefined }, 0);

let failed = 0;
async function step(name: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const targets: Record<Target, { dialect: SqlDialect; port: number; user: string; password: string; admin: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test', admin: 'mysql' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test', admin: 'mysql' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test', admin: 'postgres' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1', admin: 'master' },
};
const SCHEMA: Record<SqlDialect, string> = { mysql: '', postgres: 'public', mssql: 'dbo' };

const TYPES: Record<SqlDialect, Record<'name' | 'dec' | 'bool' | 'ts' | 'text' | 'bin' | 'ident', string>> = {
  mysql: { name: 'varchar(50)', dec: 'decimal(10,2)', bool: 'tinyint(1)', ts: 'datetime(3)', text: 'text', bin: 'varbinary(20)', ident: 'int AUTO_INCREMENT PRIMARY KEY' },
  postgres: { name: 'varchar(50)', dec: 'numeric(10,2)', bool: 'boolean', ts: 'timestamp(3)', text: 'text', bin: 'bytea', ident: 'int GENERATED ALWAYS AS IDENTITY PRIMARY KEY' },
  mssql: { name: 'nvarchar(50)', dec: 'decimal(10,2)', bool: 'bit', ts: 'datetime2(3)', text: 'nvarchar(max)', bin: 'varbinary(20)', ident: 'int IDENTITY(1,1) PRIMARY KEY' },
};

/** id, name, betrag, aktiv, geburt, geaendert, notiz, daten (hex), code */
type Row = [number, string, string | null, boolean, string | null, string | null, string | null, string | null, string | null];
const BASE: Row[] = [
  [1, 'Anna', '10.50', true, '1980-01-02', '2024-01-02 03:04:05.678', 'eins', '0102', 'ab'],
  [2, 'Zoë', '0.00', false, null, null, null, null, null],
  [3, 'Ärger', '-1.25', true, '2000-02-29', '2024-02-29 23:59:59.999', "it's", '', 'abcde'],
  [4, 'Bea', null, false, '1970-01-01', '1970-01-01 00:00:00.000', 'vier', 'ff', 'x'],
  [5, 'Carl', '99999999.99', true, '2099-12-31', '2099-12-31 23:59:59.000', '', '00', ''],
];
const row = (id: number, name: string, over: Partial<Record<6 | 7 | 4, string | null>> = {}): Row => {
  const r: Row = [id, name, '1.00', false, '1990-01-01', '2020-01-01 00:00:00.000', 'n', '01', 'c'];
  for (const [i, v] of Object.entries(over)) (r as unknown[])[Number(i)] = v;
  return r;
};
const SOURCE: Row[] = [
  ...BASE,
  row(6, 'Nur Quelle'),
  row(8, 'Neu'),
  row(9, 'Neun', { 6: null }),
  row(10, 'Zehn', { 7: '0a0b' }),
  row(11, 'Elf', { 4: '1990-05-05' }),
  row(12, 'Meier'),
  row(13, 'Huber'),
];
const TARGET: Row[] = [
  ...BASE,
  row(7, 'Nur Ziel'),
  row(8, 'Alt'),
  row(9, 'Neun', { 6: 'x' }),
  row(10, 'Zehn', { 7: '0a0c' }),
  row(11, 'Elf', { 4: '1990-05-06' }),
  row(12, 'meier'),
  row(13, 'Huber  '),
];

const str = (d: SqlDialect, v: string | null) => (v === null ? 'NULL' : (d === 'mssql' ? "N'" : "'") + v.replace(/'/g, "''") + "'");
const bin = (d: SqlDialect, hex: string | null) => (hex === null ? 'NULL' : d === 'mysql' ? `X'${hex}'` : d === 'postgres' ? `'\\x${hex}'::bytea` : `0x${hex}`);
const bool = (d: SqlDialect, v: boolean) => (d === 'postgres' ? String(v) : v ? '1' : '0');

function kundeSql(d: SqlDialect, table: string, rows: Row[]): string[] {
  const t = TYPES[d];
  return [
    `CREATE TABLE ${table} (id int PRIMARY KEY, name ${t.name} NOT NULL, betrag ${t.dec} NULL, aktiv ${t.bool} NOT NULL, geburt date NULL,
       geaendert ${t.ts} NULL, notiz ${t.text} NULL, daten ${t.bin} NULL, code char(5) NULL)`,
    `INSERT INTO ${table} (id, name, betrag, aktiv, geburt, geaendert, notiz, daten, code) VALUES ` +
      rows.map((r) => `(${r[0]}, ${str(d, r[1])}, ${r[2] ?? 'NULL'}, ${bool(d, r[3])}, ${str(d, r[4])}, ${str(d, r[5])}, ${str(d, r[6])}, ${bin(d, r[7])}, ${str(d, r[8])})`).join(', '),
  ];
}

function otherSql(d: SqlDialect, side: 'src' | 'dst'): string[] {
  const t = TYPES[d];
  const src = side === 'src';
  return [
    'CREATE TABLE pos (bestellung int NOT NULL, nr int NOT NULL, menge int NOT NULL, PRIMARY KEY (bestellung, nr))',
    `INSERT INTO pos VALUES ${src ? '(1, 1, 5), (1, 2, 3), (2, 1, 1)' : '(1, 1, 5), (1, 2, 4)'}`,
    `CREATE TABLE logbuch (id ${t.ident}, text ${t.name} NOT NULL)`,
    `INSERT INTO logbuch (text) VALUES ${src ? "('a'), ('b'), ('c')" : "('a'), ('b')"}`,
    `CREATE TABLE ohne_pk (code ${t.name} NOT NULL, wert int NULL)`,
    `INSERT INTO ohne_pk VALUES ${src ? "('a', 1), ('b', 2), ('c', 1)" : "('a', 1), ('b', 3)"}`,
    ...(src ? ['CREATE TABLE gross (id int PRIMARY KEY, txt varchar(20))', 'CREATE TABLE ziffer (i int)', 'INSERT INTO ziffer VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)'] : []),
    ...(src
      ? [`INSERT INTO gross SELECT a.i * 10000 + b.i * 1000 + c.i * 100 + e.i * 10 + f.i, 'zeile' FROM ziffer a, ziffer b, ziffer c, ziffer e, ziffer f`]
      : []),
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function compare(req: DataCompareRequest): Promise<DataCompareResult> {
  const id = await m.startDataCompare(req);
  for (;;) {
    const s = await m.jobStatus(id);
    if (s.state === 'done') return m.dataCompareResult(id);
    if (s.state !== 'running') throw new Error(s.error ?? s.state);
    await sleep(30);
  }
}

/** Abgleich-Skript in der Reihenfolge der Oberfläche: löschen, ändern, einfügen */
function script(r: DataCompareResult): string[] {
  const of = (s: string) => r.rows.filter((x) => x.status === s).map((x) => x.sql);
  return [...of('onlyTarget'), ...of('different'), ...(of('onlySource').length ? [...r.insertBefore, ...of('onlySource'), ...r.insertAfter] : [])];
}

const summary = (r: DataCompareResult) => `+${r.counts.onlySource} -${r.counts.onlyTarget} ≠${r.counts.different} =${r.counts.same}`;
const byStatus = (r: DataCompareResult) =>
  r.rows.map((x) => `${x.status}:${(x.source ?? x.target)![0]}${x.changed ? ':' + x.changed.map((i) => r.columns[i].name).join(',') : ''}`);

async function connection(name: Target) {
  const t = targets[name];
  return store.save({
    name,
    dialect: t.dialect,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.admin,
    options: t.dialect === 'mssql' ? { trustServerCertificate: true } : {},
  });
}

async function run(connectionId: string, db: string, sqls: string[]) {
  const { sessionId } = await m.openSession(connectionId, db);
  try {
    for (const sql of sqls) {
      const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
      const err = r.statements.find((s) => s.error);
      if (err) throw new Error(`${sql.slice(0, 160)}: ${err.error}`);
    }
  } finally {
    await m.closeSession(sessionId);
  }
}

async function recreate(name: Target, connectionId: string, dbs: string[]) {
  const t = targets[name];
  for (const db of dbs) {
    if (t.dialect === 'mysql') await run(connectionId, t.admin, [`DROP DATABASE IF EXISTS ${db}`, `CREATE DATABASE ${db}`]);
    if (t.dialect === 'postgres') await run(connectionId, t.admin, [`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, `CREATE DATABASE ${db}`]);
    if (t.dialect === 'mssql') {
      await run(connectionId, t.admin, [
        `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`,
        `CREATE DATABASE [${db}]`,
      ]);
    }
  }
}

const ids = new Map<Target, string>();

async function single(name: Target) {
  const t = targets[name];
  const d = t.dialect;
  console.log(`\n${name}`);
  const id = (await connection(name)).id;
  ids.set(name, id);
  await recreate(name, id, ['dc_src', 'dc_dst']);
  await run(id, 'dc_src', [...kundeSql(d, 'kunde', SOURCE), ...otherSql(d, 'src')]);
  await run(id, 'dc_dst', [...kundeSql(d, 'kunde', TARGET), ...otherSql(d, 'dst')]);
  const side = (db: string, table: string): DataCompareSide => ({ connectionId: id, database: db, schema: SCHEMA[d], table });
  const kunde = { source: side('dc_src', 'kunde'), target: side('dc_dst', 'kunde') };

  await step('Unterschiede erkannt: fehlt, nur im Ziel, geändert (Text, NULL, Binär, Datum, Groß/klein, Leerzeichen)', async () => {
    const r = await compare(kunde);
    assert.equal(summary(r), '+1 -1 ≠6 =5');
    assert.deepEqual(byStatus(r), [
      'onlySource:6',
      'onlyTarget:7',
      'different:8:name',
      'different:9:notiz',
      'different:10:daten',
      'different:11:geburt',
      'different:12:name',
      'different:13:name',
    ]);
    assert.deepEqual(r.key, ['id']);
    assert.equal(r.columns[0].name, 'id');
    const nine = r.rows.find((x) => x.source?.[0] === 9)!;
    assert.equal(nine.source![6], null);
    assert.equal(nine.target![6], 'x');
    assert.match(r.rows.find((x) => x.status === 'onlyTarget')!.sql, /^DELETE FROM .*kunde.* WHERE .*id.* = 7;$/);
    assert.match(nine.sql, /^UPDATE .*kunde.* SET .*notiz.* = NULL WHERE .*id.* = 9;$/);
  });

  await step('Optionen: Groß-/Kleinschreibung und Leerzeichen am Ende ignorieren', async () => {
    assert.equal(summary(await compare({ ...kunde, ignoreCase: true })), '+1 -1 ≠5 =6');
    assert.equal(summary(await compare({ ...kunde, ignoreTrailingSpaces: true })), '+1 -1 ≠5 =6');
    assert.equal(summary(await compare({ ...kunde, ignoreCase: true, ignoreTrailingSpaces: true })), '+1 -1 ≠4 =7');
  });

  await step('WHERE für beide Seiten und Spaltenauswahl', async () => {
    assert.equal(summary(await compare({ ...kunde, where: 'id <= 5' })), '+0 -0 ≠0 =5');
    const r = await compare({ ...kunde, columns: ['name'] });
    // 11 Zeilen auf beiden Seiten, 3 davon mit anderem Namen
    assert.equal(summary(r), '+1 -1 ≠3 =8');
    assert.deepEqual(r.columns.map((c) => c.name), ['id', 'name']);
  });

  await step('zusammengesetzter Schlüssel', async () => {
    const r = await compare({ source: side('dc_src', 'pos'), target: side('dc_dst', 'pos') });
    assert.equal(summary(r), '+1 -0 ≠1 =1');
    assert.deepEqual(r.key, ['bestellung', 'nr']);
    assert.match(r.rows.find((x) => x.status === 'different')!.sql, /WHERE .*bestellung.* = 1 AND .*nr.* = 2;$/);
  });

  await step('ohne Primärschlüssel: klare Meldung; mit gewähltem Schlüssel geht es, doppelte Werte werden erkannt', async () => {
    const req = { source: side('dc_src', 'ohne_pk'), target: side('dc_dst', 'ohne_pk') };
    await assert.rejects(compare(req), /weder Primärschlüssel noch einen eindeutigen Index/);
    assert.equal(summary(await compare({ ...req, key: ['code'] })), '+1 -0 ≠1 =1');
    await assert.rejects(compare({ ...req, key: ['wert'] }), /in der Quelle nicht eindeutig: 1 doppelte Werte, z\. B\. wert = 1/);
  });

  await step('Schutz: dieselbe Tabelle, unbekannte Tabelle, unbekannte Schlüsselspalte', async () => {
    await assert.rejects(compare({ source: kunde.source, target: kunde.source }), /dieselbe Tabelle/);
    await assert.rejects(compare({ ...kunde, target: side('dc_dst', 'gibt_es_nicht') }), /nicht gefunden/);
    await assert.rejects(compare({ ...kunde, key: ['fehlt'] }), /Schlüsselspalte fehlt gibt es in der Quelle nicht/);
  });

  await step('Abgleich-Skript im Ziel ausführen → danach gleich (auch Identitätsspalte, Sequenz läuft weiter)', async () => {
    for (const table of ['kunde', 'pos', 'logbuch']) {
      const req = { source: side('dc_src', table), target: side('dc_dst', table) };
      await run(id, 'dc_dst', script(await compare(req)));
      const again = await compare(req);
      assert.equal(summary(again), `+0 -0 ≠0 =${table === 'kunde' ? 12 : 3}`, table);
    }
    const ohne = { source: side('dc_src', 'ohne_pk'), target: side('dc_dst', 'ohne_pk'), key: ['code'] };
    await run(id, 'dc_dst', script(await compare(ohne)));
    assert.equal(summary(await compare(ohne)), '+0 -0 ≠0 =3');
    // nach dem eingefügten Wert 3 vergibt die Identitätsspalte 4
    await run(id, 'dc_dst', ["INSERT INTO logbuch (text) VALUES ('d')"]);
    const r = await compare({ source: side('dc_dst', 'logbuch'), target: side('dc_src', 'logbuch') });
    assert.deepEqual(byStatus(r), ['onlySource:4']);
  });

  await step('100 000 Zeilen: schnell genug; Abbrechen beendet den Auftrag', async () => {
    await run(id, 'dc_dst', ['CREATE TABLE gross (id int PRIMARY KEY, txt varchar(20))']);
    const req = { source: side('dc_src', 'gross'), target: side('dc_dst', 'gross') };
    const t0 = Date.now();
    const r = await compare(req);
    assert.equal(summary(r), '+100000 -0 ≠0 =0');
    assert.equal(r.rows.length, r.limit);
    assert.ok(r.warnings.some((w) => /100.000 Zeilen fehlen im Ziel – Liste und Skript zeigen die ersten 5.000/.test(w)), r.warnings.join(' | '));
    console.log(`       (Vergleich 100 000 Zeilen: ${Date.now() - t0} ms)`);
    const job = await m.startDataCompare(req);
    await m.cancelJob(job);
    let s = await m.jobStatus(job);
    for (let i = 0; i < 200 && s.state === 'running'; i++) s = (await sleep(25), await m.jobStatus(job));
    assert.equal(s.state, 'cancelled');
    await assert.rejects(m.dataCompareResult(job), /kein Ergebnis/);
    // Verbindungen danach weiter benutzbar
    assert.equal(summary(await compare({ ...kunde, where: 'id <= 5' })), '+0 -0 ≠0 =5');
  });

  await step('Skript als Datei: alle 20 000 statt der ersten 5 000, im Ziel eingespielt → danach gleich', async () => {
    const req = { source: side('dc_src', 'gross'), target: side('dc_dst', 'gross'), where: 'id < 20000' };
    saveAs = path.join(dir, `${name}-gross.sql`);
    const s = await job((await m.startDataCompareScript({ table: req, includeDeletes: true }))!);
    assert.equal(s.statements, 20_000);
    assert.equal(s.file, saveAs);
    const text = readFileSync(saveAs, 'utf8');
    assert.equal(text.match(/^INSERT INTO /gm)?.length, 20_000);
    assert.match(text, /^-- 0 löschen, 0 ändern, 20000 einfügen$/m);
    await importFile(id, 'dc_dst', saveAs, d);
    assert.equal(summary(await compare(req)), '+0 -0 ≠0 =20000');
    // abgebrochener Speichern-Dialog: kein Auftrag
    saveAs = '';
    assert.equal(await m.startDataCompareScript({ table: req, includeDeletes: true }), null);
  });

  await step('Skript als Datei: Textschlüssel mit Zeilenumbruch bleibt ganz auskommentiert, Umlaute über 64 KiB unversehrt', async () => {
    const text = d === 'mssql' ? 'nvarchar(200)' : d === 'mysql' ? 'varchar(200) CHARACTER SET utf8mb4' : 'varchar(200)';
    const mk = [`CREATE TABLE nl (k varchar(60) PRIMARY KEY, v varchar(60))`, `CREATE TABLE um (id int PRIMARY KEY, t ${text})`];
    await run(id, 'dc_src', mk);
    await run(id, 'dc_dst', mk);
    // nur im Ziel: ein Schlüsselwert, der nach einem Zeilenumbruch wie SQL aussieht
    await run(id, 'dc_dst', [`INSERT INTO nl VALUES ('x''\nDROP TABLE nl; --', 'ziel')`]);
    const rows = Array.from({ length: 3000 }, (_, i) => `(${i}, ${d === 'mssql' ? 'N' : ''}'Müller Straße äöü € ✓ Nr. ${i}')`);
    for (let i = 0; i < rows.length; i += 500) await run(id, 'dc_src', [`INSERT INTO um VALUES ${rows.slice(i, i + 500).join(', ')}`]);
    saveAs = path.join(dir, `${name}-nl.sql`);
    let s = await job((await m.startDataCompareScript({ table: { source: side('dc_src', 'nl'), target: side('dc_dst', 'nl') }, includeDeletes: false }))!);
    assert.equal(s.statements, 1);
    const nl = readFileSync(saveAs, 'utf8');
    assert.ok(nl.includes('DROP TABLE nl'), 'DELETE fehlt');
    for (const l of nl.split('\n')) assert.ok(!l || l.startsWith('-- ') || /^\s*$/.test(l) || !/DROP|DELETE/.test(l), `lebendiges SQL: ${l}`);
    // Umlaute: die Datei wird aus Zwischendateien zusammengesetzt – Blockgrenzen dürfen kein Zeichen zerreißen
    saveAs = path.join(dir, `${name}-um.sql`);
    s = await job((await m.startDataCompareScript({ table: { source: side('dc_src', 'um'), target: side('dc_dst', 'um') }, includeDeletes: true }))!);
    assert.equal(s.statements, 3000);
    const um = readFileSync(saveAs, 'utf8');
    assert.ok(um.length > 64 * 1024, `Datei nur ${um.length} Zeichen`);
    assert.ok(!um.includes('�'), 'Ersatzzeichen in der Datei');
    assert.equal(um.match(/Müller Straße äöü € ✓/g)?.length, 3000);
    await importFile(id, 'dc_dst', saveAs, d);
    assert.equal(summary(await compare({ source: side('dc_src', 'um'), target: side('dc_dst', 'um') })), '+0 -0 ≠0 =3000');
    // die Schema-Schritte danach erwarten die ursprünglichen Tabellen
    await run(id, 'dc_src', ['DROP TABLE nl', 'DROP TABLE um']);
    await run(id, 'dc_dst', ['DROP TABLE nl', 'DROP TABLE um']);
  });

  await step('ganzes Schema: je Tabelle gezählt, Tabelle ohne Schlüssel mit Hinweis, Tabellen nur auf einer Seite', async () => {
    const r = await compareAll({ source: { connectionId: id, database: 'dc_src', schema: SCHEMA[d] }, target: { connectionId: id, database: 'dc_dst', schema: SCHEMA[d] } });
    const by = new Map(r.tables.map((x) => [x.source.toLowerCase(), x]));
    assert.deepEqual([...by.keys()].sort(), ['gross', 'kunde', 'logbuch', 'ohne_pk', 'pos']);
    const c = (t: string) => {
      const x = by.get(t)!.counts!;
      return `+${x.onlySource} -${x.onlyTarget} ≠${x.different} =${x.same}`;
    };
    assert.equal(c('gross'), '+80000 -0 ≠0 =20000');
    assert.equal(c('kunde'), '+0 -0 ≠0 =12');
    assert.equal(c('logbuch'), '+0 -1 ≠0 =3');
    assert.match(by.get('ohne_pk')!.error ?? '', /weder Primärschlüssel noch einen eindeutigen Index/);
    assert.equal(by.get('ohne_pk')!.noKey, true);
    assert.equal(by.get('kunde')!.noKey, undefined);
    assert.deepEqual(r.onlySource.map((x) => x.toLowerCase()), ['ziffer']);
    assert.deepEqual(r.onlyTarget, []);
  });

  await step('ganzes Schema, Tabelle ohne Schlüssel: Schlüssel gewählt → verglichen, im Skript, eingespielt → gleich', async () => {
    const base = { source: { connectionId: id, database: 'dc_src', schema: SCHEMA[d] }, target: { connectionId: id, database: 'dc_dst', schema: SCHEMA[d] } };
    const ohne = (await compareAll(base)).tables.find((x) => x.source.toLowerCase() === 'ohne_pk')!;
    const keys = { [ohne.source]: ['code'] };
    await run(id, 'dc_dst', ["INSERT INTO ohne_pk VALUES ('z', 9)"]);
    const one = await compareAll({ ...base, tables: [ohne.source], keys });
    assert.equal(one.tables.length, 1);
    assert.deepEqual(one.tables[0].key, ['code']);
    const c = one.tables[0].counts!;
    assert.equal(`+${c.onlySource} -${c.onlyTarget} ≠${c.different} =${c.same}`, '+0 -1 ≠0 =3');
    const dup = (await compareAll({ ...base, tables: [ohne.source], keys: { [ohne.source]: ['wert'] } })).tables[0];
    assert.match(dup.error ?? '', /nicht eindeutig/);
    assert.ok(!dup.noKey);
    // im Skript: ohne gewählten Schlüssel übersprungen, mit ihm dabei
    saveAs = path.join(dir, `${name}-ohne-pk.sql`);
    let s = await job((await m.startDataCompareScript({ all: { ...base, tables: [ohne.source] }, includeDeletes: true }))!);
    assert.equal(s.statements, 0);
    assert.ok(s.log.some((l) => /übersprungen – .*weder Primärschlüssel/.test(l)), s.log.join(' | '));
    s = await job((await m.startDataCompareScript({ all: { ...base, tables: [ohne.source], keys }, includeDeletes: true }))!);
    assert.equal(s.statements, 1);
    await importFile(id, 'dc_dst', saveAs, d);
    const after = (await compareAll({ ...base, tables: [ohne.source], keys })).tables[0].counts!;
    assert.equal(after.onlySource + after.onlyTarget + after.different, 0);
    saveAs = '';
  });

  await step('ganzes Schema als Skript: Fremdschlüssel-Reihenfolge (löschen von unten, einfügen von oben), eingespielt → gleich', async () => {
    const tables = (land: string, orte: string) => [
      'CREATE TABLE land (code char(2) PRIMARY KEY, name varchar(20) NOT NULL)',
      'CREATE TABLE ort (id int PRIMARY KEY, name varchar(20) NOT NULL, land_code char(2) NOT NULL, CONSTRAINT fk_ort_land FOREIGN KEY (land_code) REFERENCES land (code))',
      `INSERT INTO land VALUES ${land}`,
      `INSERT INTO ort VALUES ${orte}`,
    ];
    await run(id, 'dc_src', tables("('CH', 'Schweiz'), ('DE', 'Deutschland')", "(1, 'Bern', 'CH'), (2, 'Berlin', 'DE')"));
    await run(id, 'dc_dst', tables("('CH', 'Schweiz'), ('AT', 'Österreich')", "(1, 'Bern', 'CH'), (3, 'Wien', 'AT')"));
    const all: DataCompareAllRequest = {
      source: { connectionId: id, database: 'dc_src', schema: SCHEMA[d] },
      target: { connectionId: id, database: 'dc_dst', schema: SCHEMA[d] },
      tables: ['ort', 'land'],
    };
    saveAs = path.join(dir, `${name}-schema.sql`);
    const s = await job((await m.startDataCompareScript({ all, includeDeletes: true }))!);
    assert.equal(s.statements, 4);
    const text = readFileSync(saveAs, 'utf8');
    const at = (re: RegExp) => text.search(re);
    assert.ok(at(/^-- Löschen: ort/m) < at(/^-- Löschen: land/m), text);
    assert.ok(at(/^-- Einfügen: land/m) < at(/^-- Einfügen: ort/m), text);
    assert.ok(s.log.some((l) => /^land: 1 löschen, 0 ändern, 1 einfügen$/.test(l)), s.log.join(' | '));
    await importFile(id, 'dc_dst', saveAs, d);
    const r = await compareAll(all);
    assert.deepEqual(r.tables.map((x) => `${x.source}:${x.counts?.onlySource}${x.counts?.onlyTarget}${x.counts?.different}`), ['land:000', 'ort:000']);
    // ohne „Löschungen aktivieren“ stehen die DELETE nur als Kommentar in der Datei
    await run(id, 'dc_dst', ["INSERT INTO land VALUES ('IT', 'Italien')"]);
    saveAs = path.join(dir, `${name}-schema2.sql`);
    await job((await m.startDataCompareScript({ all, includeDeletes: false }))!);
    assert.match(readFileSync(saveAs, 'utf8'), /^-- DELETE FROM .*land.* = N?'IT';$/m);
    saveAs = '';
  });
}

async function job(jobId: string): Promise<JobStatus> {
  for (;;) {
    const s = await m.jobStatus(jobId);
    if (s.state === 'done') return s;
    if (s.state !== 'running') throw new Error(s.error ?? s.state);
    await sleep(30);
  }
}

async function compareAll(req: DataCompareAllRequest): Promise<DataCompareAllResult> {
  const jobId = await m.startDataCompareAll(req);
  await job(jobId);
  return m.dataCompareAllResult(jobId);
}

/** Datei im Ziel einspielen wie in der Oberfläche */
async function importFile(connectionId: string, database: string, file: string, d: SqlDialect) {
  const s = await job(await m.startImport({ connectionId, database, createDatabase: false, file, stopOnError: true, transaction: d !== 'mysql', skipUse: true }));
  assert.equal(s.state, 'done', s.error);
}

/** über Datenbanktypen hinweg: Quelle dc_src.kunde des einen, Ziel kunde_x des anderen Servers */
async function cross(from: Target, to: Target) {
  console.log(`\n${from} → ${to}`);
  const fd = targets[from].dialect;
  const td = targets[to].dialect;
  const fid = ids.get(from)!;
  const tid = ids.get(to)!;
  await run(tid, 'dc_dst', [`DROP TABLE IF EXISTS kunde_x`, ...kundeSql(td, 'kunde_x', TARGET)]);
  const req: DataCompareRequest = {
    source: { connectionId: fid, database: 'dc_src', schema: SCHEMA[fd], table: 'kunde' },
    target: { connectionId: tid, database: 'dc_dst', schema: SCHEMA[td], table: 'kunde_x' },
    // char(5) füllen PostgreSQL und SQL Server mit Leerzeichen auf, MySQL nicht
    ignoreTrailingSpaces: true,
  };
  await step('gleiche Werte gelten als gleich (Zahl, Boolean, Datum, Zeit, Binär, Unicode)', async () => {
    const r = await compare(req);
    assert.equal(summary(r), '+1 -1 ≠5 =6');
    assert.deepEqual(byStatus(r).filter((x) => x.startsWith('different')), [
      'different:8:name',
      'different:9:notiz',
      'different:10:daten',
      'different:11:geburt',
      'different:12:name',
    ]);
  });
  await step('Skript im Ziel ausführen → danach gleich', async () => {
    await run(tid, 'dc_dst', script(await compare(req)));
    assert.equal(summary(await compare(req)), '+0 -0 ≠0 =12');
  });
}

async function main() {
  const only = process.argv[2] as Target | undefined;
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in targets)) {
    console.error(`Unbekannter Datenbanktyp „${only}“ – möglich: ${Object.keys(targets).join(', ')}`);
    process.exit(1);
  }
  const names = (only ? [only] : (Object.keys(targets) as Target[])).filter((n) => n in targets);
  assertTestContainers(names.map((n) => ({ name: n, host: '127.0.0.1', port: targets[n].port })));
  for (const n of names) await single(n);
  if (ids.has('mysql') && ids.has('postgres')) await cross('mysql', 'postgres');
  if (ids.has('postgres') && ids.has('mssql')) await cross('postgres', 'mssql');
  for (const [name, id] of ids) await cleanup(name, id);
  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

async function cleanup(name: Target, id: string) {
  const t = targets[name];
  const drop =
    t.dialect === 'mssql'
      ? (db: string) => [`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`]
      : t.dialect === 'postgres'
        ? (db: string) => [`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`]
        : (db: string) => [`DROP DATABASE IF EXISTS ${db}`];
  await run(id, t.admin, [...drop('dc_src'), ...drop('dc_dst')]).catch(() => undefined);
}

void main();
