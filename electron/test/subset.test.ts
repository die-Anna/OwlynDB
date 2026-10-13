/* Test-Datenbank aus Prod: Teilmenge je Tabelle (letzte N, WHERE, keine, abhängige) samt allen Zeilen, auf die verwiesen wird
   (Selbstbezug über mehrere Stufen, Fremdschlüssel auf eindeutige Nicht-Schlüssel-Spalte, Tabelle ohne Schlüssel,
   zusammengesetzter Schlüssel), fehlende Tabellen ergänzen, Anonymisieren (gleichbleibend, über Fremdschlüssel
   ausgedehnt, Formate). Die Kopie legt die Fremdschlüssel am Ende an – fehlt eine Zeile, schlägt sie fehl.
   Vorher: npm run testdb:up. Aufruf: npm run test:subset [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnonRule, CopyRequest, SqlDialect, DumpRequest, JobStatus, QueryRun, RowRule } from '../../shared/api-types';
import { ibanCheck } from '../anonymize';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-sub-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
let dumpFile = '';
const m = new Manager(store, { pickFile: async () => null, saveFile: async () => dumpFile, showInFolder: () => undefined }, 0);

let failed = 0;
async function step(name: string, fn: () => Promise<unknown> | unknown) {
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

// ---------- Testdaten (Formeln, damit die erwarteten Mengen nachrechenbar sind) ----------

const KUNDEN = 60;
const BESTELLUNGEN = 200;
/** Werber: Ketten 52 → 51 usw., an jeder Zehnerstelle +1 beginnt eine neue */
const werber = (k: number) => (k >= 2 && k % 10 !== 1 ? k - 1 : null);
const kundeVon = (b: number) => 1 + ((b * 7) % KUNDEN);
const artikelVon = (b: number, nr: number) => 1 + ((b * 3 + nr) % 30);
const protokollKunde = (i: number) => 1 + ((i * 11) % KUNDEN);
const email = (k: number) => `kunde${k}@firma${k % 3}.ch`;

function sourceSql(d: SqlDialect): string[] {
  const ts = d === 'mssql' ? 'datetime2' : d === 'postgres' ? 'timestamp' : 'datetime';
  const n = (s: string) => (d === 'mssql' ? "N'" : "'") + s.replace(/'/g, "''") + "'";
  const rows = <T>(count: number, f: (i: number) => T) => Array.from({ length: count }, (_, i) => f(i + 1));
  const insert = (table: string, values: string[]) => {
    const out: string[] = [];
    // SQL Server: höchstens 1000 Zeilen je VALUES
    for (let i = 0; i < values.length; i += 500) out.push(`INSERT INTO ${table} VALUES ${values.slice(i, i + 500).join(', ')}`);
    return out;
  };
  return [
    'CREATE TABLE land (code char(2) PRIMARY KEY, name varchar(40) NOT NULL)',
    `CREATE TABLE kunde (id int PRIMARY KEY, name varchar(60) NOT NULL, email varchar(80) NOT NULL UNIQUE, telefon varchar(30) NULL,
       iban varchar(34) NULL, strasse varchar(80) NULL, geburt date NULL, land_code char(2) NOT NULL, werber_id int NULL,
       CONSTRAINT fk_kunde_land FOREIGN KEY (land_code) REFERENCES land (code), CONSTRAINT fk_kunde_werber FOREIGN KEY (werber_id) REFERENCES kunde (id))`,
    'CREATE TABLE artikel (id int PRIMARY KEY, name varchar(60) NOT NULL)',
    `CREATE TABLE bestellung (id int PRIMARY KEY, kunde_id int NOT NULL, datum date NOT NULL, CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))`,
    `CREATE TABLE bestellposition (bestellung_id int NOT NULL, nr int NOT NULL, artikel_id int NOT NULL, menge int NOT NULL, PRIMARY KEY (bestellung_id, nr),
       CONSTRAINT fk_pos_best FOREIGN KEY (bestellung_id) REFERENCES bestellung (id), CONSTRAINT fk_pos_art FOREIGN KEY (artikel_id) REFERENCES artikel (id))`,
    `CREATE TABLE kontakt (id int PRIMARY KEY, kunde_email varchar(80) NOT NULL, text varchar(100) NULL,
       CONSTRAINT fk_kontakt_mail FOREIGN KEY (kunde_email) REFERENCES kunde (email))`,
    `CREATE TABLE protokoll (zeit ${ts} NOT NULL, text varchar(100) NULL, kunde_id int NULL, CONSTRAINT fk_prot_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))`,
    ...insert('land', [`('CH', 'Schweiz')`, `('DE', 'Deutschland')`, `('AT', 'Österreich')`, `('FR', 'Frankreich')`, `('IT', 'Italien')`]),
    ...insert(
      'kunde',
      rows(KUNDEN, (k) => {
        const land = ['CH', 'DE', 'AT'][k % 3];
        const w = werber(k);
        return `(${k}, ${n(`Kunde${k} Echt`)}, ${n(email(k))}, ${n(`+41 44 000 ${String(k).padStart(2, '0')} 00`)}, ${n(`CH93 0076 2011 6238 5295 ${k % 10}`)}, ${n(`Echtgasse ${k}, 8000 Zürich`)}, '${1950 + k}-0${1 + (k % 9)}-1${k % 10}', '${land}', ${w ?? 'NULL'})`;
      }),
    ),
    ...insert('artikel', rows(30, (a) => `(${a}, ${n(`Artikel ${a}`)})`)),
    ...insert('bestellung', rows(BESTELLUNGEN, (b) => `(${b}, ${kundeVon(b)}, '2026-0${1 + (b % 9)}-0${1 + (b % 9)}')`)),
    ...insert('bestellposition', rows(BESTELLUNGEN * 3, (i) => {
      const b = Math.ceil(i / 3);
      const nr = ((i - 1) % 3) + 1;
      return `(${b}, ${nr}, ${artikelVon(b, nr)}, ${nr * 2})`;
    })),
    ...insert('kontakt', rows(20, (i) => `(${i}, ${n(email(i))}, ${n(`Kontakt ${i}`)})`)),
    ...insert('protokoll', rows(50, (i) => `('2026-10-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00', ${n(`Ereignis ${i}`)}, ${protokollKunde(i)})`)),
  ];
}

// ---------- erwartete Mengen ----------

const B = [100, 101, 102, ...Array.from({ length: 10 }, (_, i) => 191 + i)];
function expectedKunden(withKontakt: boolean): number[] {
  const k = new Set<number>([...B.map(kundeVon), ...[46, 47, 48, 49, 50].map(protokollKunde)]);
  if (withKontakt) for (let i = 1; i <= 20; i++) k.add(i);
  for (const x of [...k]) for (let w = werber(x); w !== null; w = werber(w)) k.add(w);
  return [...k].sort((a, b) => a - b);
}
const expectedArtikel = () => [...new Set([100, 101, 102].flatMap((b) => [1, 2, 3].map((nr) => artikelVon(b, nr))))].sort((a, b) => a - b);

// ---------- Hilfen ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitJob(id: string): Promise<JobStatus> {
  for (;;) {
    const s = await m.jobStatus(id);
    if (s.state !== 'running') return s;
    await sleep(40);
  }
}

async function run(connectionId: string, db: string, sqls: string[]): Promise<QueryRun[]> {
  const { sessionId } = await m.openSession(connectionId, db);
  const out: QueryRun[] = [];
  try {
    for (const sql of sqls) {
      const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 100000);
      const err = r.statements.find((s) => s.error);
      if (err) throw new Error(`${sql.slice(0, 160)}: ${err.error}`);
      out.push(r);
    }
  } finally {
    await m.closeSession(sessionId);
  }
  return out;
}

async function column(connectionId: string, db: string, sql: string): Promise<(string | number | boolean | null)[]> {
  const [r] = await run(connectionId, db, [sql]);
  return r.results[0].rows.map((x) => x[0]);
}

const ids = async (cid: string, db: string, table: string, col = 'id') => (await column(cid, db, `SELECT ${col} FROM ${table} ORDER BY ${col}`)).map(Number);

function dropDb(d: SqlDialect, db: string): string {
  if (d === 'mssql') return `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`;
  return d === 'postgres' ? `DROP DATABASE IF EXISTS ${db} WITH (FORCE)` : `DROP DATABASE IF EXISTS ${db}`;
}

const ALL_TABLES = ['land', 'kunde', 'artikel', 'bestellung', 'bestellposition', 'kontakt', 'protokoll'];

// ---------- gegen die Test-Server ----------

async function server(name: Target) {
  const t = targets[name];
  const d = t.dialect;
  console.log(`\n${name}`);
  const c = await store.save({
    name,
    dialect: d,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.admin,
    options: d === 'mssql' ? { trustServerCertificate: true } : {},
  });
  await run(c.id, t.admin, [dropDb(d, 'sub_src'), dropDb(d, 'sub_dst'), dropDb(d, 'sub_dst2'), dropDb(d, 'sub_dst3'), d === 'mssql' ? 'CREATE DATABASE [sub_src]' : 'CREATE DATABASE sub_src']);
  await run(c.id, 'sub_src', sourceSql(d));
  const schema = SCHEMA[d];
  const tbl = (n: string) => ({ schema, name: n });
  const rule = (n: string, r: RowRule) => ({ schema, name: n, rule: r });
  const anon = (table: string, column: string, r: AnonRule) => ({ schema, table, column, rule: r });

  const source: CopyRequest['source'] = {
    connectionId: c.id,
    database: 'sub_src',
    tables: ALL_TABLES.map(tbl),
    views: [],
    structure: true,
    data: true,
    dropFirst: false,
    routines: false,
    rowsPerInsert: 100,
    subset: [
      rule('bestellung', { kind: 'last', count: 10, column: 'id' }),
      rule('bestellposition', { kind: 'where', where: 'bestellung_id BETWEEN 100 AND 102' }),
      rule('kunde', { kind: 'none' }),
      rule('artikel', { kind: 'none' }),
      rule('land', { kind: 'all' }),
      rule('kontakt', { kind: 'all' }),
      rule('protokoll', { kind: 'last', count: 5, column: 'zeit' }),
    ],
    anonymize: [
      anon('kunde', 'name', 'name'),
      anon('kunde', 'email', 'email'),
      anon('kunde', 'telefon', 'phone'),
      anon('kunde', 'iban', 'iban'),
      anon('kunde', 'strasse', 'street'),
      anon('kunde', 'geburt', 'birthdate'),
    ],
  };

  let job: JobStatus | undefined;
  await step('Teil-Kopie: Fremdschlüssel lassen sich am Ende anlegen (alle verwiesenen Zeilen da)', async () => {
    job = await waitJob(await m.startCopy({ source, targetConnectionId: c.id, targetDatabase: 'sub_dst', createDatabase: true, stopOnError: true, transaction: d !== 'mysql' }));
    assert.equal(job.state, 'done', `${job.error ?? ''}\n${job.log.join('\n')}`);
  });

  await step('Mengen: letzte N, WHERE, Selbstbezug-Ketten, Verweis über E-Mail, Tabelle ohne Schlüssel', async () => {
    assert.deepEqual(await ids(c.id, 'sub_dst', 'bestellung'), B);
    assert.equal((await ids(c.id, 'sub_dst', 'bestellposition', 'bestellung_id')).length, 9);
    assert.deepEqual(await ids(c.id, 'sub_dst', 'artikel'), expectedArtikel());
    assert.deepEqual(await ids(c.id, 'sub_dst', 'kunde'), expectedKunden(true));
    assert.equal((await column(c.id, 'sub_dst', 'SELECT code FROM land')).length, 5);
    assert.equal((await column(c.id, 'sub_dst', 'SELECT id FROM kontakt')).length, 20);
    assert.deepEqual((await column(c.id, 'sub_dst', 'SELECT text FROM protokoll ORDER BY zeit')), [46, 47, 48, 49, 50].map((i) => `Ereignis ${i}`));
  });

  await step('Anonymisiert: nichts Echtes übrig, Formate stimmen, Geburtsjahr bleibt, E-Mail im Kontakt passt dazu', async () => {
    const [r] = await run(c.id, 'sub_dst', ['SELECT id, name, email, telefon, iban, strasse, geburt FROM kunde ORDER BY id']);
    const real = new Set(Array.from({ length: KUNDEN }, (_, i) => email(i + 1)));
    for (const row of r.results[0].rows) {
      const [id, nm, mail, tel, iban, str, geb] = row.map((x) => (x === null ? '' : String(x)));
      assert.ok(!nm.includes('Echt'), `Name ${nm}`);
      assert.ok(!real.has(mail) && /@example\.invalid$/.test(mail), `E-Mail ${mail}`);
      assert.match(tel, /^\+41 \d{2} \d{3} \d{2} \d{2}$/);
      assert.notEqual(tel, `+41 44 000 ${String(id).padStart(2, '0')} 00`, tel);
      const plain = iban.replace(/\s/g, '');
      assert.equal(ibanCheck('CH', plain.slice(4)), plain.slice(2, 4), iban);
      assert.match(str, /, 8000 Zürich$/);
      assert.ok(!str.startsWith('Echtgasse'), str);
      assert.equal(geb.slice(0, 4), String(1950 + Number(id)), geb);
    }
    // Fremdschlüssel kontakt.kunde_email → kunde.email: gleicher Ersatz auf beiden Seiten
    const orphans = await column(c.id, 'sub_dst', 'SELECT COUNT(*) FROM kontakt k LEFT JOIN kunde u ON u.email = k.kunde_email WHERE u.id IS NULL');
    assert.equal(Number(orphans[0]), 0);
    assert.ok(job!.log.some((l) => /kontakt\.kunde_email: E-Mail wie kunde\.email/.test(l)), job!.log.join(' | '));
    assert.ok(job!.log.some((l) => /^Anonymisiert: .*kunde\.email → E-Mail/.test(l)), job!.log.join(' | '));
  });

  await step('nur Bestellungen gewählt: Kunde, Land, Artikel werden ergänzt (nur die nötigen Zeilen), Regeln gelten auch dort', async () => {
    const r = await waitJob(
      await m.startCopy({
        source: {
          ...source,
          tables: ['bestellung', 'bestellposition'].map(tbl),
          subset: [rule('bestellung', { kind: 'last', count: 10, column: 'id' }), rule('bestellposition', { kind: 'where', where: 'bestellung_id BETWEEN 100 AND 102' })],
          addReferenced: true,
          // Regel für eine ergänzte Tabelle; die übrigen Personenspalten dort werden gemeldet (F023)
          anonymize: [anon('kunde', 'name', 'name')],
        },
        targetConnectionId: c.id,
        targetDatabase: 'sub_dst2',
        createDatabase: true,
        stopOnError: true,
        transaction: d !== 'mysql',
      }),
    );
    assert.equal(r.state, 'done', `${r.error ?? ''}\n${r.log.join('\n')}`);
    assert.ok(r.log.some((l) => /^kunde ergänzt/.test(l)) && r.log.some((l) => /^artikel ergänzt/.test(l)) && r.log.some((l) => /^land ergänzt/.test(l)), r.log.join(' | '));
    assert.deepEqual(await ids(c.id, 'sub_dst2', 'kunde'), (() => {
      const k = new Set(B.map(kundeVon));
      for (const x of [...k]) for (let w = werber(x); w !== null; w = werber(w)) k.add(w);
      return [...k].sort((a, b) => a - b);
    })());
    assert.equal((await column(c.id, 'sub_dst2', 'SELECT code FROM land')).length, 3);
    const names = await column(c.id, 'sub_dst2', 'SELECT name FROM kunde');
    assert.ok(names.length > 0 && names.every((x) => !String(x).includes('Echt')), names.join(', '));
    assert.ok(
      r.log.some((l) => /^kunde \(ergänzt\): email, telefon, iban, strasse, geburt sehen nach Personendaten aus, haben aber keine Regel/.test(l)),
      r.log.join(' | '),
    );
  });

  await step('abhängige Zeilen: Positionen der gewählten Bestellungen, Protokoll (ohne Schlüssel) der mitkommenden Kunden', async () => {
    const r = await waitJob(
      await m.startCopy({
        source: {
          ...source,
          tables: ['land', 'kunde', 'artikel', 'bestellung', 'bestellposition', 'protokoll'].map(tbl),
          subset: [
            rule('bestellung', { kind: 'last', count: 10, column: 'id' }),
            rule('bestellposition', { kind: 'dependent' }),
            rule('artikel', { kind: 'none' }),
            rule('kunde', { kind: 'where', where: 'id <= 5' }),
            rule('land', { kind: 'all' }),
            rule('protokoll', { kind: 'dependent' }),
          ],
          addReferenced: false,
          anonymize: [],
        },
        targetConnectionId: c.id,
        targetDatabase: 'sub_dst3',
        createDatabase: true,
        stopOnError: true,
        transaction: d !== 'mysql',
      }),
    );
    assert.equal(r.state, 'done', `${r.error ?? ''}\n${r.log.join('\n')}`);
    const last10 = Array.from({ length: 10 }, (_, i) => 191 + i);
    assert.deepEqual(await ids(c.id, 'sub_dst3', 'bestellung'), last10);
    // genau die 30 Positionen dieser Bestellungen – nicht die anderer Bestellungen mit denselben Artikeln
    const pos = await column(c.id, 'sub_dst3', 'SELECT bestellung_id FROM bestellposition ORDER BY bestellung_id');
    assert.equal(pos.length, 30);
    assert.ok(pos.every((b) => Number(b) >= 191 && Number(b) <= 200), pos.join(','));
    const artikel = [...new Set(last10.flatMap((b) => [1, 2, 3].map((nr) => artikelVon(b, nr))))].sort((a, b) => a - b);
    assert.deepEqual(await ids(c.id, 'sub_dst3', 'artikel'), artikel);
    const kunden = new Set([1, 2, 3, 4, 5, ...last10.map(kundeVon)]);
    for (const x of [...kunden]) for (let w = werber(x); w !== null; w = werber(w)) kunden.add(w);
    assert.deepEqual(await ids(c.id, 'sub_dst3', 'kunde'), [...kunden].sort((a, b) => a - b));
    const prot = Array.from({ length: 50 }, (_, i) => i + 1).filter((i) => kunden.has(protokollKunde(i)));
    assert.equal((await column(c.id, 'sub_dst3', 'SELECT kunde_id FROM protokoll')).length, prot.length);
  });

  if (name === 'mysql') {
    await step('Dump-Datei mit Teilmenge und Anonymisierung: keine echten E-Mail-Adressen', async () => {
      dumpFile = path.join(dir, 'teil.sql');
      const req: DumpRequest = { ...source, targetDialect: d, baseName: 'teil' };
      const id = await m.startDump(req);
      const s = await waitJob(id!);
      assert.equal(s.state, 'done', s.error);
      const text = readFileSync(dumpFile, 'utf8');
      assert.match(text, /-- Teilmenge: nicht alle Zeilen/);
      assert.match(text, /-- Daten bestellung \(Teilmenge: 13 Zeilen\)/);
      // auch kontakt.kunde_email (folgt kunde.email über den Fremdschlüssel)
      assert.ok(!/kunde\d+@firma\d\.ch/.test(text), 'echte E-Mail im Dump');
      assert.match(text, /@example\.invalid/);
    });
  }

  await run(c.id, t.admin, [dropDb(d, 'sub_src'), dropDb(d, 'sub_dst'), dropDb(d, 'sub_dst2'), dropDb(d, 'sub_dst3')]);
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
  for (const n of names) await server(n);
  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
