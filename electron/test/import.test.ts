/* Einspielen fremder Dateien gegen die Test-Datenbanken: Kodierungen (latin1-Dump, ANSI ohne Deklaration, UTF-16BE),
   Rohbytes (_binary) abgelehnt, DROP/CREATE/ALTER DATABASE und USE übersprungen (auch ohne GO), Server-Warnungen gezählt,
   COPY-Fehler mitten im Strom, große Anweisung über mehrere Blöcke, Archive abgelehnt.
   Aufruf: npm run testdb:up, dann npm run test:import [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Dialect, JobStatus } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const TARGETS: Record<Target, { dialect: Dialect; port: number; user: string; password: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1' },
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-import-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const manager = new Manager(store, { pickFile: async () => null, saveFile: async () => null, showInFolder: () => undefined }, 0);

let failed = 0;
async function step(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).stack?.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fileNo = 0;
function file(content: Buffer | string, encoding: BufferEncoding = 'utf8'): string {
  const f = path.join(dir, `f${++fileNo}.sql`);
  writeFileSync(f, typeof content === 'string' ? Buffer.from(content, encoding) : content);
  return f;
}

async function connect(t: Target): Promise<string> {
  const c = TARGETS[t];
  const saved = await store.save({
    name: t,
    dialect: c.dialect,
    host: '127.0.0.1',
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.dialect === 'mssql' ? 'master' : c.dialect === 'postgres' ? 'postgres' : '',
    options: c.dialect === 'mssql' ? { trustServerCertificate: true } : {},
  });
  return saved.id;
}

/** eine Anweisung in der Datenbank ausführen, erste Zelle zurück */
async function scalar(id: string, db: string | undefined, sql: string): Promise<unknown> {
  const { sessionId } = await manager.openSession(id, db);
  try {
    const r = await manager.runQuery(sessionId, [{ sql, offset: 0 }], 10);
    const bad = r.statements.find((s) => s.error);
    if (bad) throw new Error(`${bad.error}\n       bei: ${sql.slice(0, 120)}`);
    return r.results[0]?.rows[0]?.[0];
  } finally {
    await manager.closeSession(sessionId);
  }
}

async function dropDb(d: Dialect, id: string, db: string) {
  if (d === 'mysql') await scalar(id, undefined, `DROP DATABASE IF EXISTS ${db}`);
  else if (d === 'postgres') await scalar(id, undefined, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  else await scalar(id, undefined, `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE ${db} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${db}; END`);
}

async function waitJob(jobId: string, limitMs = 90_000): Promise<JobStatus> {
  const t0 = Date.now();
  for (;;) {
    const s = await manager.jobStatus(jobId);
    if (s.state !== 'running') return s;
    if (Date.now() - t0 > limitMs) {
      await manager.cancelJob(jobId);
      throw new Error(`Auftrag hängt (${s.current})`);
    }
    await sleep(100);
  }
}

async function load(id: string, db: string, f: string, opts: { stopOnError?: boolean; skipUse?: boolean; createDatabase?: boolean } = {}): Promise<JobStatus> {
  let jobId: string;
  try {
    jobId = await manager.startImport({
      connectionId: id,
      database: db,
      createDatabase: opts.createDatabase ?? true,
      file: f,
      stopOnError: opts.stopOnError ?? true,
      transaction: false,
      skipUse: opts.skipUse ?? true,
    });
  } catch (e) {
    // vor dem Start abgelehnt (Datei fehlt, Archiv, Rohbytes): wie ein gescheiterter Auftrag – es lief nichts, keine Datenbank angelegt
    return { id: '', kind: 'import', state: 'error', error: (e as Error).message, done: 0, statements: 0, current: '', log: [], durationMs: 0 };
  }
  return waitJob(jobId);
}

const ok = (s: JobStatus) => assert.equal(s.state, 'done', `${s.error ?? ''}\n       ${s.log.join('\n       ')}`);

async function mysqlTests(t: Target) {
  const d: Dialect = 'mysql';
  console.log(`\n${t}`);
  const id = await connect(t);
  const T = 'imp_t';

  await step('latin1-Dump (SET NAMES latin1, Byte 0xFC): richtig gelesen, SET NAMES nicht an den Server', async () => {
    await dropDb(d, id, T);
    const f = file("/*!40101 SET NAMES latin1 */;\nCREATE TABLE t (id int PRIMARY KEY, name varchar(20));\nINSERT INTO t VALUES (1, 'M\xfcller');\n/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n", 'latin1');
    const s = await load(id, T, f);
    ok(s);
    assert.equal(await scalar(id, T, 'SELECT name FROM t WHERE id = 1'), 'Müller');
    assert.ok(s.log.some((l) => /latin1/i.test(l) && /WINDOWS-1252/.test(l)), s.log.join(' | '));
    assert.ok(s.log.some((l) => /SET NAMES latin1.*übersprungen/.test(l)), s.log.join(' | '));
  });

  await step('ANSI-Datei ohne Deklaration: als Windows-1252 gelesen, Hinweis im Protokoll', async () => {
    await dropDb(d, id, T);
    const s = await load(id, T, file("CREATE TABLE t (id int PRIMARY KEY, name varchar(20));\nINSERT INTO t VALUES (1, 'M\xfcller');\n", 'latin1'));
    ok(s);
    assert.equal(await scalar(id, T, 'SELECT name FROM t WHERE id = 1'), 'Müller');
    assert.ok(s.log.some((l) => /Windows-1252/.test(l)), s.log.join(' | '));
  });

  await step('UTF-8-Dump mit Umlauten: unverändert (kein Hinweis)', async () => {
    await dropDb(d, id, T);
    const s = await load(id, T, file("/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE t (id int PRIMARY KEY, name varchar(20));\nINSERT INTO t VALUES (1, 'Müller ✓ 😀');\n"));
    ok(s);
    assert.equal(await scalar(id, T, 'SELECT name FROM t WHERE id = 1'), 'Müller ✓ 😀');
    assert.ok(!s.log.some((l) => /Windows-1252|gelesen/.test(l)), s.log.join(' | '));
  });

  await step('Rohbytes (_binary ohne --hex-blob): Abbruch mit Hinweis, nichts ausgeführt', async () => {
    await dropDb(d, id, T);
    const f = file(Buffer.concat([Buffer.from("/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE b (id int, v varbinary(4));\nINSERT INTO b VALUES (1, _binary '"), Buffer.from([0xff, 0xfe]), Buffer.from("');\n")]));
    const s = await load(id, T, f);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /hex-blob/);
    // geprüft wird vor dem Anlegen: weder Tabelle noch Datenbank
    assert.equal(Number(await scalar(id, undefined, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'imp_t' AND TABLE_NAME = 'b'")), 0);
    assert.equal(Number(await scalar(id, undefined, "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'imp_t'")), 0);
  });

  await step('ungültige Bytes später in der Datei: Fehler mit Zeile statt stiller Ersatzzeichen', async () => {
    await dropDb(d, id, T);
    // Füllung über die Blockgröße (4 MB) hinaus: der erste Block ist gültig und wird ausgeführt, der zweite nicht
    const f = file(Buffer.concat([Buffer.from("/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE t (id int, name varchar(20));\nINSERT INTO t VALUES (1, 'ok');\n"), Buffer.alloc(5 * 1024 * 1024, '-- Füllung\n'), Buffer.from("INSERT INTO t VALUES (2, 'M"), Buffer.from([0xfc]), Buffer.from("ller');\n")]));
    const s = await load(id, T, f);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /ungültige Bytefolge/);
    // der erste Block lief (die letzte Anweisung darin gilt bis zum nächsten Block als unvollständig), die kaputte Zeile nie
    assert.ok(Number(await scalar(id, T, 'SELECT COUNT(*) FROM t')) <= 1);
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM t WHERE id = 2')), 0);
  });

  await step('DROP/CREATE DATABASE und USE mit festem Namen werden übersprungen (Quelle bleibt)', async () => {
    await dropDb(d, id, 'imp_src');
    await dropDb(d, id, T);
    await scalar(id, undefined, 'CREATE DATABASE imp_src');
    await scalar(id, 'imp_src', 'CREATE TABLE marker (id int)');
    const f = file('/*!40000 DROP DATABASE IF EXISTS `imp_src`*/;\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ `imp_src` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\nUSE `imp_src`;\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n');
    const s = await load(id, T, f);
    ok(s);
    assert.match(s.current, /3 USE\/DATABASE übersprungen/);
    assert.equal(Number(await scalar(id, 'imp_src', 'SELECT COUNT(*) FROM marker')), 0, 'Quell-Datenbank wurde angefasst');
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM t')), 1);
    await dropDb(d, id, 'imp_src');
  });

  await step('mysqldump-Kopf: Kommentarzeilen vor /*!40000 DROP DATABASE */ – trotzdem übersprungen', async () => {
    await dropDb(d, id, 'imp_src');
    await dropDb(d, id, T);
    await scalar(id, undefined, 'CREATE DATABASE imp_src');
    await scalar(id, 'imp_src', 'CREATE TABLE marker (id int)');
    const f = file(
      '-- MySQL dump 10.13  Distrib 8.4.11, for Linux (x86_64)\n--\n-- Host: localhost    Database: imp_src\n-- ------------------------------------------------------\n\n' +
        '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n/*!40101 SET NAMES utf8mb4 */;\n\n--\n-- Current Database: `imp_src`\n--\n\n' +
        '/*!40000 DROP DATABASE IF EXISTS `imp_src`*/;\n\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ `imp_src` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n\nUSE `imp_src`;\n\n' +
        '--\n-- Table structure for table `t`\n--\n\nCREATE TABLE `t` (`id` int);\n/*!40101 SET character_set_client = utf8mb4 */;\nINSERT INTO `t` VALUES (1);\n/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n',
    );
    const s = await load(id, T, f);
    ok(s);
    assert.match(s.current, /3 USE\/DATABASE übersprungen/);
    assert.equal(Number(await scalar(id, 'imp_src', 'SELECT COUNT(*) FROM marker')), 0, 'Quell-Datenbank wurde gelöscht');
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM t')), 1);
    await dropDb(d, id, 'imp_src');
  });

  await step('ohne skipUse laufen DATABASE-Anweisungen wie bisher', async () => {
    await dropDb(d, id, 'imp_src2');
    await dropDb(d, id, T);
    const s = await load(id, T, file('CREATE DATABASE imp_src2;\nUSE imp_src2;\nCREATE TABLE t (id int);\n'), { skipUse: false });
    ok(s);
    assert.equal(Number(await scalar(id, 'imp_src2', 'SELECT COUNT(*) FROM t')), 0);
    await dropDb(d, id, 'imp_src2');
  });

  await step('Warnungen des Servers (nicht strikter Modus, gekürzter Wert) werden gezählt', async () => {
    await dropDb(d, id, T);
    const s = await load(id, T, file("SET SESSION sql_mode = '';\nCREATE TABLE w (s varchar(3));\nINSERT INTO w VALUES ('abcdef');\nINSERT INTO w VALUES ('xyzxyz'), ('q');\n"));
    ok(s);
    assert.match(s.current, /2 Warnungen/);
    assert.match(s.log[0] ?? '', /2 Warnung/);
    assert.equal(await scalar(id, T, 'SELECT s FROM w LIMIT 1'), 'abc');
  });

  await step('eine Anweisung über mehrere Leseblöcke (12 MB)', async () => {
    await dropDb(d, id, T);
    const rows: string[] = [];
    const pad = 'x'.repeat(1000);
    for (let i = 0; i < 12000; i++) rows.push(`(${i}, '${pad}')`);
    const s = await load(id, T, file(`CREATE TABLE big (id int PRIMARY KEY, s text);\nINSERT INTO big VALUES\n${rows.join(',\n')};\nINSERT INTO big VALUES (99999, 'danach');\n`));
    ok(s);
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM big')), 12001);
  });

  await step('gzip-Datei wird abgelehnt', async () => {
    const s = await load(id, T, file(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])), { createDatabase: false });
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /gzip/);
  });

  await dropDb(d, id, T);
}

async function postgresTests() {
  const d: Dialect = 'postgres';
  console.log('\npostgres');
  const id = await connect('postgres');
  const T = 'imp_t';
  const copyLines = (n: number, from = 2) => Array.from({ length: n }, (_, i) => `${i + from}\tzeile ${i}`).join('\n') + '\n';

  await step("pg_dump mit client_encoding = 'LATIN1': richtig gelesen, SET nicht an den Server", async () => {
    await dropDb(d, id, T);
    const f = file("SET client_encoding = 'LATIN1';\nCREATE TABLE t (id int, name text);\nINSERT INTO t VALUES (1, 'M\xfcller');\n", 'latin1');
    const s = await load(id, T, f);
    ok(s);
    assert.equal(await scalar(id, T, 'SELECT name FROM t WHERE id = 1'), 'Müller');
    assert.ok(s.log.some((l) => /LATIN1/.test(l)), s.log.join(' | '));
    assert.ok(s.log.some((l) => /client_encoding.*übersprungen/.test(l)), s.log.join(' | '));
  });

  await step('COPY in fehlende Tabelle mit großem Block: kein Hängen, Fehler im Protokoll, Rest läuft', async () => {
    await dropDb(d, id, T);
    const f = file(`COPY public.nix (id, s) FROM stdin;\n${copyLines(100_000)}\\.\nCREATE TABLE after1 (id int);\n`);
    const s = await waitJob(
      await manager.startImport({ connectionId: id, database: T, createDatabase: true, file: f, stopOnError: false, transaction: false, skipUse: true }),
      30_000,
    );
    ok(s);
    assert.equal(s.log.filter((l) => /nix/.test(l)).length, 1, s.log.join(' | '));
    assert.equal(Number(await scalar(id, T, "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'after1'")), 1);
  });

  await step('COPY-Datenfehler mitten im Strom (Schlüssel doppelt): Fehler überspringen geht weiter', async () => {
    await dropDb(d, id, T);
    const f = file(`CREATE TABLE c (id int PRIMARY KEY, s text);\nCOPY public.c (id, s) FROM stdin;\n1\teins\n1\tdoppelt\n${copyLines(300_000)}\\.\nCREATE TABLE after2 (id int);\n`);
    const s = await waitJob(
      await manager.startImport({ connectionId: id, database: T, createDatabase: true, file: f, stopOnError: false, transaction: false, skipUse: true }),
      60_000,
    );
    ok(s);
    assert.ok(s.log.some((l) => /duplicate key|doppelt|already exists/i.test(l)), s.log.join(' | '));
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM c')), 0);
    assert.equal(Number(await scalar(id, T, "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'after2'")), 1);
  });

  await step('COPY-Fehler mit „beim ersten Fehler aufhören“: Abbruch mit Meldung, kein Hängen', async () => {
    await dropDb(d, id, T);
    const f = file(`COPY public.nix (id, s) FROM stdin;\n${copyLines(100_000)}\\.\nCREATE TABLE after3 (id int);\n`);
    const s = await waitJob(await manager.startImport({ connectionId: id, database: T, createDatabase: true, file: f, stopOnError: true, transaction: false, skipUse: true }), 30_000);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /nix/);
    assert.equal(Number(await scalar(id, T, "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'after3'")), 0);
  });

  await step('pg_dump -C: CREATE/ALTER DATABASE mit festem Namen übersprungen', async () => {
    await dropDb(d, id, T);
    const s = await load(id, T, file("CREATE DATABASE shop WITH TEMPLATE = template0 ENCODING = 'UTF8';\nALTER DATABASE shop OWNER TO postgres;\n\\connect shop\n\nCREATE TABLE t (id int);\n"));
    ok(s);
    assert.match(s.current, /2 USE\/DATABASE übersprungen/);
    assert.equal(Number(await scalar(id, T, "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 't'")), 1);
  });

  await dropDb(d, id, T);
}

async function mssqlTests() {
  const d: Dialect = 'mssql';
  console.log('\nmssql');
  const id = await connect('mssql');
  const T = 'imp_t';

  await step('USE ohne GO: nur die USE-Zeile fällt weg, der Rest des Batches läuft', async () => {
    await dropDb(d, id, T);
    const s = await load(id, T, file('USE imp_src;\r\nCREATE TABLE dbo.a (id int);\r\nINSERT INTO dbo.a VALUES (1);\r\n'));
    ok(s);
    assert.match(s.current, /1 USE\/DATABASE übersprungen/);
    assert.equal(Number(await scalar(id, T, 'SELECT COUNT(*) FROM dbo.a')), 1);
  });

  await step('ALTER/DROP DATABASE [quelle] werden übersprungen, die Quelle bleibt', async () => {
    await dropDb(d, id, 'imp_src');
    await dropDb(d, id, T);
    await scalar(id, undefined, 'CREATE DATABASE imp_src');
    const s = await load(id, T, file('USE [imp_src]\r\nGO\r\nALTER DATABASE [imp_src] SET RECOVERY SIMPLE\r\nGO\r\nDROP DATABASE [imp_src]\r\nGO\r\nCREATE TABLE dbo.b (id int)\r\nGO\r\n'));
    ok(s);
    assert.match(s.current, /3 USE\/DATABASE übersprungen/);
    assert.equal(Number(await scalar(id, undefined, "SELECT COUNT(*) FROM sys.databases WHERE name = 'imp_src'")), 1, 'Quell-Datenbank gelöscht');
    assert.equal(Number(await scalar(id, T, "SELECT COUNT(*) FROM sys.tables WHERE name = 'b'")), 1);
    await dropDb(d, id, 'imp_src');
  });

  await step('UTF-16BE ohne BOM und ANSI (Windows-1252) werden erkannt', async () => {
    await dropDb(d, id, T);
    const be = Buffer.from("CREATE TABLE dbo.u (id int, txt nvarchar(20));\r\nINSERT INTO dbo.u VALUES (1, N'Grüße ✓');\r\n", 'utf16le').swap16();
    ok(await load(id, T, file(be)));
    assert.equal(await scalar(id, T, 'SELECT txt FROM dbo.u WHERE id = 1'), 'Grüße ✓');
    const s = await load(id, T, file("INSERT INTO dbo.u VALUES (2, N'M\xfcller');\r\n", 'latin1'), { createDatabase: false });
    ok(s);
    assert.equal(await scalar(id, T, 'SELECT txt FROM dbo.u WHERE id = 2'), 'Müller');
    assert.ok(s.log.some((l) => /Windows-1252/.test(l)), s.log.join(' | '));
  });

  await dropDb(d, id, T);
}

(async () => {
  const only = process.argv[2] as Target | undefined;
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in TARGETS)) {
    console.error(`Unbekannter Datenbanktyp „${only}“ – möglich: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  const list = (Object.keys(TARGETS) as Target[]).filter((t) => !only || t === only);
  assertTestContainers(list.map((t) => ({ name: t, host: '127.0.0.1', port: TARGETS[t].port })));
  for (const t of list) {
    if (t === 'mysql' || t === 'mariadb') await mysqlTests(t);
    else if (t === 'postgres') await postgresTests();
    else await mssqlTests();
  }
  await manager.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
