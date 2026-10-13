/* ER-Diagramm: Anordnung (ohne Überlappung, verwiesene Tabellen links, Kreise, hohe Schichten, stabil) und das Modell
   aus den Katalogen (Spalten, zusammengesetzte Fremdschlüssel, Selbstbezug, anderes Schema bzw. andere Datenbank,
   Partitionen, Views nicht dabei); dazu SVG speichern.
   Vorher: npm run testdb:up. Aufruf: npm run test:er [mysql|mariadb|postgres|mssql] */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Dialect, ErModel } from '../../shared/api-types';
import { layoutEr, type ErBox, type ErLayout, type ErLink } from '../../shared/er-layout';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-er-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });

let failed = 0;
async function step(name: string, fn: () => unknown) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

// ---------- Anordnung ----------

/** kleiner Zufallsgenerator mit festem Startwert, damit Fehler nachvollziehbar bleiben */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function overlaps(l: ErLayout, boxes: ErBox[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const p = l.pos.get(a.key)!;
      const q = l.pos.get(b.key)!;
      if (p.x < q.x + b.width && q.x < p.x + a.width && p.y < q.y + b.height && q.y < p.y + a.height) out.push(`${a.key}/${b.key}`);
    }
  }
  return out;
}

function inside(l: ErLayout, boxes: ErBox[]) {
  for (const b of boxes) {
    const p = l.pos.get(b.key);
    assert.ok(p, `${b.key} ohne Platz`);
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + b.width <= l.width && p.y + b.height <= l.height, `${b.key} außerhalb: ${JSON.stringify(p)} in ${l.width}×${l.height}`);
  }
}

async function layoutTests() {
  console.log('\nAnordnung');
  const box = (key: string, height = 80, width = 160): ErBox => ({ key, width, height });

  await step('Kette: verwiesene Tabellen stehen links', () => {
    const boxes = [box('a'), box('b'), box('c')];
    const l = layoutEr(boxes, [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }]);
    const x = (k: string) => l.pos.get(k)!.x;
    assert.ok(x('a') + 160 <= x('b') && x('b') + 160 <= x('c'), JSON.stringify([...l.pos]));
    inside(l, boxes);
  });

  await step('zufällige Schemas (ohne Kreise): keine Überlappung, jeder Verweis zeigt nach links', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rnd(seed);
      const n = 5 + Math.floor(r() * 60);
      const boxes = Array.from({ length: n }, (_, i) => box(`t${i}`, 26 + 18 * (1 + Math.floor(r() * 30)), 150 + Math.floor(r() * 200)));
      const links: ErLink[] = [];
      for (let i = 1; i < n; i++) {
        const k = Math.floor(r() * 3);
        for (let j = 0; j < k; j++) links.push({ from: `t${i}`, to: `t${Math.floor(r() * i)}` });
      }
      const l = layoutEr(boxes, links);
      assert.deepEqual(overlaps(l, boxes), [], `Startwert ${seed}`);
      inside(l, boxes);
      for (const ln of links) {
        const a = l.pos.get(ln.from)!;
        const b = l.pos.get(ln.to)!;
        assert.ok(b.x + boxes.find((x) => x.key === ln.to)!.width <= a.x, `Startwert ${seed}: ${ln.to} nicht links von ${ln.from}`);
      }
    }
  });

  await step('lange Verbindungen: Durchgänge liegen in Lücken, nicht hinter Kästen', () => {
    let lanes = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rnd(seed * 31);
      const n = 8 + Math.floor(r() * 50);
      const boxes = Array.from({ length: n }, (_, i) => box(`t${i}`, 26 + 18 * (1 + Math.floor(r() * 20)), 150 + Math.floor(r() * 150)));
      const links: ErLink[] = [];
      for (let i = 1; i < n; i++) for (let j = 0; j < 1 + Math.floor(r() * 2); j++) links.push({ from: `t${i}`, to: `t${Math.floor(r() * i)}` });
      const l = layoutEr(boxes, links);
      for (const [pair, route] of l.routes) {
        const [from, to] = pair.split('\u0001');
        assert.ok(links.some((x) => x.from === from && x.to === to), `Durchgang ohne Verbindung: ${pair}`);
        for (const w of route) {
          lanes++;
          for (const b of boxes) {
            const p = l.pos.get(b.key)!;
            const hit = p.x < w.x2 && w.x1 < p.x + b.width && p.y - 4 <= w.y && w.y <= p.y + b.height + 4;
            assert.ok(!hit, `Startwert ${seed}: Durchgang ${pair} bei y=${w.y} durch ${b.key} (${p.y}–${p.y + b.height})`);
          }
        }
        // der Reihe nach von from (rechts) nach to (links)
        const xs = route.map((w) => w.x1);
        assert.deepEqual(xs, [...xs].sort((a, b) => b - a), `Reihenfolge ${pair}`);
      }
    }
    assert.ok(lanes > 20, `nur ${lanes} Durchgänge geprüft`);
  });

  await step('Anschlüsse waagrecht: Fremdschlüssel-Zeile auf Höhe der verwiesenen Zeile', () => {
    const boxes = [box('kunde', 120), box('bestellung', 200)];
    const l = layoutEr(boxes, [{ from: 'bestellung', to: 'kunde', fromY: 71, toY: 35 }]);
    assert.equal(l.pos.get('bestellung')!.y + 71, l.pos.get('kunde')!.y + 35);
  });

  await step('Kreuzungen werden aufgelöst', () => {
    // alphabetisch stünden a_kind/b_kind und p1/p2 über Kreuz
    const boxes = ['p1', 'p2', 'a_kind', 'b_kind'].map((k) => box(k));
    const l = layoutEr(boxes, [{ from: 'a_kind', to: 'p2' }, { from: 'b_kind', to: 'p1' }, { from: 'a_kind', to: 'p1' }]);
    const y = (k: string) => l.pos.get(k)!.y;
    assert.equal(y('a_kind') < y('b_kind'), y('p2') < y('p1'), JSON.stringify([...l.pos]));
  });

  await step('Tabellen ohne Eltern stehen direkt vor ihren Kindern', () => {
    const boxes = ['a', 'b', 'c', 'd', 'wurzel'].map((k) => box(k));
    const l = layoutEr(boxes, [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }, { from: 'd', to: 'c' }, { from: 'd', to: 'wurzel' }]);
    assert.equal(l.pos.get('wurzel')!.x, l.pos.get('c')!.x);
    assert.equal(l.routes.size, 0);
  });

  await step('Kreise und Selbstbezüge: alles angeordnet, keine Überlappung', () => {
    const boxes = ['a', 'b', 'c', 'd', 'e'].map((k) => box(k));
    const links = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'd', to: 'd' },
      { from: 'e', to: 'a' },
      { from: 'a', to: 'fehlt' },
    ];
    const l = layoutEr(boxes, links);
    assert.equal(l.pos.size, 5);
    assert.deepEqual(overlaps(l, boxes), []);
    inside(l, boxes);
  });

  await step('sehr hohe Schicht: auf mehrere Spalten verteilt', () => {
    const boxes = [box('kunde'), ...Array.from({ length: 80 }, (_, i) => box(`kind${String(i).padStart(2, '0')}`, 100))];
    const links = boxes.slice(1).map((b) => ({ from: b.key, to: 'kunde' }));
    const l = layoutEr(boxes, links, { maxColumnHeight: 1800 });
    assert.deepEqual(overlaps(l, boxes), []);
    const cols = new Set(boxes.slice(1).map((b) => l.pos.get(b.key)!.x));
    assert.ok(cols.size >= 5, `nur ${cols.size} Spalten`);
    assert.ok(l.height < 3200, `Höhe ${l.height} (untereinander wären es über 10000)`);
    for (const b of boxes.slice(1)) assert.ok(l.pos.get('kunde')!.x + 160 <= l.pos.get(b.key)!.x);
  });

  await step('Einzeltabellen als Raster unter den Gruppen, Gruppen nebeneinander', () => {
    const boxes = [box('a'), box('b'), box('c'), box('d'), ...Array.from({ length: 12 }, (_, i) => box(`solo${i}`, 60))];
    const l = layoutEr(boxes, [{ from: 'b', to: 'a' }, { from: 'd', to: 'c' }]);
    assert.deepEqual(overlaps(l, boxes), []);
    const groupBottom = Math.max(...['a', 'b', 'c', 'd'].map((k) => l.pos.get(k)!.y + 80));
    for (let i = 0; i < 12; i++) assert.ok(l.pos.get(`solo${i}`)!.y >= groupBottom, `solo${i} nicht darunter`);
    // zwei kleine Gruppen in einer Reihe
    assert.equal(l.pos.get('a')!.y, l.pos.get('c')!.y);
    assert.ok(l.width <= 1600 + 2 * 30 + 1, `Breite ${l.width}`);
  });

  await step('gleiche Daten in anderer Reihenfolge: gleiche Anordnung', () => {
    const r = rnd(7);
    const boxes = Array.from({ length: 30 }, (_, i) => box(`t${i}`, 26 + 18 * (1 + Math.floor(r() * 10))));
    const links: ErLink[] = [];
    for (let i = 1; i < 30; i++) links.push({ from: `t${i}`, to: `t${Math.floor(r() * i)}` });
    const a = layoutEr(boxes, links);
    const b = layoutEr([...boxes].reverse(), [...links].reverse());
    assert.deepEqual([...b.pos].sort(), [...a.pos].sort());
  });

  await step('leer', () => {
    const l = layoutEr([], []);
    assert.equal(l.pos.size, 0);
  });
}

// ---------- Modell aus den Katalogen ----------

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const targets: Record<Target, { dialect: Dialect; port: number; user: string; password: string; admin: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test', admin: 'mysql' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test', admin: 'mysql' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test', admin: 'postgres' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1', admin: 'master' },
};

/** Stammdaten (land) liegen bei MySQL in einer anderen Datenbank, sonst in einem anderen Schema */
function ddl(dialect: Dialect): { setup: string[]; stamm: string[]; main: string[] } {
  if (dialect === 'mysql') {
    return {
      setup: ['DROP DATABASE IF EXISTS er_test', 'DROP DATABASE IF EXISTS er_stamm', 'CREATE DATABASE er_stamm', 'CREATE DATABASE er_test'],
      stamm: ['CREATE TABLE land (code char(2) PRIMARY KEY, name varchar(50) NOT NULL)'],
      main: [
        'CREATE TABLE kunde (id int PRIMARY KEY, name varchar(50) NOT NULL, land_code char(2) NULL, CONSTRAINT fk_kunde_land FOREIGN KEY (land_code) REFERENCES er_stamm.land (code))',
        'CREATE TABLE kunde_profil (kunde_id int PRIMARY KEY, notiz text NULL, CONSTRAINT fk_profil_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))',
        "CREATE TABLE bestellung (id int PRIMARY KEY, kunde_id int NOT NULL, status enum('offen','bezahlt') NOT NULL, CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))",
        'CREATE TABLE bestellposition (bestellung_id int NOT NULL, nr int NOT NULL, menge decimal(10,2) NULL, PRIMARY KEY (bestellung_id, nr), CONSTRAINT fk_pos_best FOREIGN KEY (bestellung_id) REFERENCES bestellung (id))',
        'CREATE TABLE lieferung (id int PRIMARY KEY, bestellung_id int NOT NULL, pos_nr int NOT NULL, CONSTRAINT fk_lief_pos FOREIGN KEY (bestellung_id, pos_nr) REFERENCES bestellposition (bestellung_id, nr))',
        'CREATE TABLE mitarbeiter (id int PRIMARY KEY, chef_id int NULL, CONSTRAINT fk_ma_chef FOREIGN KEY (chef_id) REFERENCES mitarbeiter (id))',
        'CREATE TABLE notiz (id int PRIMARY KEY, text varchar(200) NULL)',
        'CREATE VIEW v_kunde AS SELECT id, name FROM kunde',
        "INSERT INTO kunde (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        'ANALYZE TABLE kunde',
      ],
    };
  }
  if (dialect === 'postgres') {
    return {
      setup: ['DROP DATABASE IF EXISTS er_test WITH (FORCE)', 'CREATE DATABASE er_test'],
      stamm: [],
      main: [
        'CREATE SCHEMA stamm',
        'CREATE TABLE stamm.land (code char(2) PRIMARY KEY, name varchar(50) NOT NULL)',
        'CREATE TABLE kunde (id int PRIMARY KEY, name varchar(50) NOT NULL, land_code char(2) NULL, CONSTRAINT fk_kunde_land FOREIGN KEY (land_code) REFERENCES stamm.land (code))',
        'CREATE TABLE kunde_profil (kunde_id int PRIMARY KEY, notiz text NULL, CONSTRAINT fk_profil_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))',
        "CREATE TABLE bestellung (id int PRIMARY KEY, kunde_id int NOT NULL, status varchar(10) NOT NULL DEFAULT 'offen', CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id))",
        'CREATE TABLE bestellposition (bestellung_id int NOT NULL, nr int NOT NULL, menge numeric(10,2) NULL, PRIMARY KEY (bestellung_id, nr), CONSTRAINT fk_pos_best FOREIGN KEY (bestellung_id) REFERENCES bestellung (id))',
        'CREATE TABLE lieferung (id int PRIMARY KEY, bestellung_id int NOT NULL, pos_nr int NOT NULL, CONSTRAINT fk_lief_pos FOREIGN KEY (bestellung_id, pos_nr) REFERENCES bestellposition (bestellung_id, nr))',
        'CREATE TABLE mitarbeiter (id int PRIMARY KEY, chef_id int NULL, CONSTRAINT fk_ma_chef FOREIGN KEY (chef_id) REFERENCES mitarbeiter (id))',
        'CREATE TABLE notiz (id int PRIMARY KEY, text varchar(200) NULL)',
        'CREATE VIEW v_kunde AS SELECT id, name FROM kunde',
        // Partitionen: nur die Haupttabelle, Fremdschlüssel nicht je Partition doppelt (in beide Richtungen)
        'CREATE TABLE ereignis (id int NOT NULL, am date NOT NULL, kunde_id int NULL, PRIMARY KEY (id, am), CONSTRAINT fk_ereignis_kunde FOREIGN KEY (kunde_id) REFERENCES kunde (id)) PARTITION BY RANGE (am)',
        "CREATE TABLE ereignis_2025 PARTITION OF ereignis FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
        "CREATE TABLE ereignis_2026 PARTITION OF ereignis FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        'CREATE TABLE ereignis_notiz (id int PRIMARY KEY, ereignis_id int NOT NULL, ereignis_am date NOT NULL, CONSTRAINT fk_notiz_ereignis FOREIGN KEY (ereignis_id, ereignis_am) REFERENCES ereignis (id, am))',
        "INSERT INTO kunde (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
        'ANALYZE kunde',
      ],
    };
  }
  return {
    setup: [
      "IF DB_ID('er_test') IS NOT NULL BEGIN ALTER DATABASE [er_test] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [er_test]; END",
      'CREATE DATABASE [er_test]',
    ],
    stamm: [],
    main: [
      'CREATE SCHEMA stamm',
      'CREATE TABLE stamm.land (code char(2) PRIMARY KEY, name nvarchar(50) NOT NULL)',
      'CREATE TABLE dbo.kunde (id int PRIMARY KEY, name nvarchar(50) NOT NULL, land_code char(2) NULL, CONSTRAINT fk_kunde_land FOREIGN KEY (land_code) REFERENCES stamm.land (code))',
      'CREATE TABLE dbo.kunde_profil (kunde_id int PRIMARY KEY, notiz nvarchar(max) NULL, CONSTRAINT fk_profil_kunde FOREIGN KEY (kunde_id) REFERENCES dbo.kunde (id))',
      "CREATE TABLE dbo.bestellung (id int PRIMARY KEY, kunde_id int NOT NULL, status varchar(10) NOT NULL DEFAULT 'offen', CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id) REFERENCES dbo.kunde (id))",
      'CREATE TABLE dbo.bestellposition (bestellung_id int NOT NULL, nr int NOT NULL, menge decimal(10,2) NULL, PRIMARY KEY (bestellung_id, nr), CONSTRAINT fk_pos_best FOREIGN KEY (bestellung_id) REFERENCES dbo.bestellung (id))',
      'CREATE TABLE dbo.lieferung (id int PRIMARY KEY, bestellung_id int NOT NULL, pos_nr int NOT NULL, CONSTRAINT fk_lief_pos FOREIGN KEY (bestellung_id, pos_nr) REFERENCES dbo.bestellposition (bestellung_id, nr))',
      'CREATE TABLE dbo.mitarbeiter (id int PRIMARY KEY, chef_id int NULL, CONSTRAINT fk_ma_chef FOREIGN KEY (chef_id) REFERENCES dbo.mitarbeiter (id))',
      'CREATE TABLE dbo.notiz (id int PRIMARY KEY, text nvarchar(200) NULL)',
      'CREATE VIEW dbo.v_kunde AS SELECT id, name FROM dbo.kunde',
      "INSERT INTO dbo.kunde (id, name) VALUES (1, N'a'), (2, N'b'), (3, N'c')",
    ],
  };
}

const fkText = (m: ErModel) =>
  m.foreignKeys
    .map((f) => `${f.table}(${f.columns.join(',')})->${f.refSchema ? f.refSchema + '.' : ''}${f.refTable}(${f.refColumns.join(',')})`)
    .sort();

async function modelTests(m: Manager, name: Target) {
  const t = targets[name];
  const dialect = t.dialect;
  console.log(`\n${name}`);
  const c = await store.save({
    name,
    dialect,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.admin,
    options: dialect === 'mssql' ? { trustServerCertificate: true } : {},
  });
  const run = async (db: string, sqls: string[]) => {
    const { sessionId } = await m.openSession(c.id, db);
    try {
      for (const sql of sqls) {
        const r = await m.runQuery(sessionId, [{ sql, offset: 0 }], 10);
        const err = r.statements.find((s) => s.error);
        if (err) throw new Error(`${sql.slice(0, 120)}: ${err.error}`);
      }
    } finally {
      await m.closeSession(sessionId);
    }
  };
  const d = ddl(dialect);
  await run(t.admin, d.setup);
  if (d.stamm.length) await run('er_stamm', d.stamm);
  await run('er_test', d.main);
  const own = dialect === 'mysql' ? '' : dialect === 'mssql' ? 'dbo' : 'public';
  const stamm = dialect === 'mysql' ? 'er_stamm' : 'stamm';
  let model: ErModel = { tables: [], foreignKeys: [] };

  await step('Tabellen ohne Views (und ohne Partitionen)', async () => {
    model = await m.erModel(c.id, 'er_test', own);
    const expected = ['bestellposition', 'bestellung', 'kunde', 'kunde_profil', 'lieferung', 'mitarbeiter', 'notiz'];
    if (dialect === 'postgres') expected.push('ereignis', 'ereignis_notiz');
    assert.deepEqual(model.tables.map((x) => x.name).sort(), expected.sort());
    assert.ok(model.tables.every((x) => x.schema === own), JSON.stringify(model.tables.map((x) => x.schema)));
  });

  await step('Spalten: Reihenfolge, Typ, NULL, Primärschlüssel (auch zusammengesetzt)', () => {
    const pos = model.tables.find((x) => x.name === 'bestellposition')!;
    assert.deepEqual(
      pos.columns.map((x) => `${x.name}:${x.pk ? 'pk' : ''}:${x.nullable ? 'null' : 'nn'}`),
      ['bestellung_id:pk:nn', 'nr:pk:nn', 'menge::null'],
    );
    const typ = pos.columns.find((x) => x.name === 'menge')!.type;
    assert.match(typ, /^(decimal|numeric)\(10,\s?2\)$/, typ);
    const k = model.tables.find((x) => x.name === 'kunde')!;
    assert.match(k.columns.find((x) => x.name === 'name')!.type, /^(n?varchar|character varying)\(50\)$/);
    if (dialect === 'mysql') assert.equal(model.tables.find((x) => x.name === 'bestellung')!.columns.find((x) => x.name === 'status')!.type, "enum('offen','bezahlt')");
  });

  await step('Fremdschlüssel: zusammengesetzt in Spaltenreihenfolge, Selbstbezug, anderes Schema bzw. andere Datenbank', () => {
    const own2 = dialect === 'mysql' ? '' : `${own}.`;
    const expected = [
      `bestellposition(bestellung_id)->${own2}bestellung(id)`,
      `bestellung(kunde_id)->${own2}kunde(id)`,
      `kunde(land_code)->${stamm}.land(code)`,
      `kunde_profil(kunde_id)->${own2}kunde(id)`,
      `lieferung(bestellung_id,pos_nr)->${own2}bestellposition(bestellung_id,nr)`,
      `mitarbeiter(chef_id)->${own2}mitarbeiter(id)`,
    ];
    if (dialect === 'postgres') expected.push('ereignis(kunde_id)->public.kunde(id)', 'ereignis_notiz(ereignis_id,ereignis_am)->public.ereignis(id,am)');
    assert.deepEqual(fkText(model), expected.sort());
    assert.equal(model.foreignKeys.find((f) => f.table === 'lieferung')!.name, 'fk_lief_pos');
  });

  await step('geschätzte Zeilenzahl', () => {
    const k = model.tables.find((x) => x.name === 'kunde')!;
    if (dialect === 'mysql') assert.ok(k.rows === undefined || (k.rows >= 0 && k.rows <= 10), String(k.rows));
    else assert.equal(k.rows, 3);
  });

  await step('anderes Schema bzw. andere Datenbank einzeln', async () => {
    const s = await m.erModel(c.id, dialect === 'mysql' ? 'er_stamm' : 'er_test', dialect === 'mysql' ? '' : stamm);
    assert.deepEqual(s.tables.map((x) => x.name), ['land']);
    assert.deepEqual(s.foreignKeys, []);
  });

  await step('unbekanntes Schema bzw. unbekannte Datenbank: leer, kein Fehler', async () => {
    const s = dialect === 'mysql' ? await m.erModel(c.id, 'gibt_es_nicht', '') : await m.erModel(c.id, 'er_test', 'gibt_es_nicht');
    assert.deepEqual(s, { tables: [], foreignKeys: [] });
  });

  await run(t.admin, dialect === 'mssql'
    ? ["ALTER DATABASE [er_test] SET SINGLE_USER WITH ROLLBACK IMMEDIATE", 'DROP DATABASE [er_test]']
    : dialect === 'postgres'
      ? ['DROP DATABASE er_test WITH (FORCE)']
      : ['DROP DATABASE er_test', 'DROP DATABASE er_stamm']);
}

async function svgTest() {
  console.log('\nSVG speichern');
  const file = path.join(dir, 'diagramm.svg');
  let asked: unknown[] = [];
  const m = new Manager(store, {
    pickFile: async () => null,
    saveFile: async (...a) => {
      asked = a;
      return file;
    },
    showInFolder: () => undefined,
  }, 0);
  await step('Datei mit XML-Kopf, Dialog mit Format svg', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    assert.equal(await m.saveSvg('ER shop', svg), file);
    assert.deepEqual(asked, ['ER shop', 'svg']);
    assert.equal(readFileSync(file, 'utf8'), `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
  });
  await step('kein SVG: abgelehnt', async () => {
    await assert.rejects(m.saveSvg('x', '<html></html>'), /Kein SVG/);
  });
  await m.shutdown();
}

async function main() {
  await layoutTests();
  await svgTest();
  const only = process.argv[2] as Target | undefined;
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in targets)) {
    console.error(`Unbekannter Datenbanktyp „${only}“ – möglich: ${Object.keys(targets).join(', ')}`);
    process.exit(1);
  }
  const names = (only ? [only] : (Object.keys(targets) as Target[])).filter((n) => n in targets);
  assertTestContainers(names.map((n) => ({ name: n, host: '127.0.0.1', port: targets[n].port })));
  const m = new Manager(store, undefined, 0);
  for (const n of names) await modelTests(m, n);
  await m.shutdown();
  console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
