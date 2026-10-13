/* Elasticsearch: Zerleger und Nur-lesen-Prüfung ohne Server; der Treiber gegen jede laufende Test-Version (7.17, 8.10,
   9.5 mit HTTPS und Anmeldung), Client-Zertifikat über HAProxy und SSH-Tunnel, wenn die Container laufen.
   Vorher: bash dev/make-certs.sh; npm run testdb:es -- es8 (bzw. es7, es9 – einzeln, sie brauchen je ~1 GB);
   für HAProxy/SSH: docker compose -f dev/docker-compose.yml --profile tls up -d --no-deps haproxy ssh
   Aufruf: npm run test:elastic */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, ConnectionOptions, TableDataRequest } from '../../shared/api-types';
import { esReadOnlyViolation, isConsoleRequest, kibanaToJson, parseRequest, splitEs } from '../../shared/es-console';
import { ConnectionStore } from '../connection-store';
import type { DriverConfig } from '../drivers/common';
import { consoleResultSets, ElasticDriver, EsClient, flattenMapping, parseJson, sourceValue } from '../drivers/elasticsearch';
import { Manager } from '../manager';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const cert = (f: string) => path.join(root, 'dev/certs', f);
const CA = readFileSync(cert('ca.crt'), 'utf8');

let failed = 0;
let skipped = 0;
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

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    assert.match((e as Error).message, pattern);
    return;
  }
  throw new Error(`hätte scheitern müssen (${pattern})`);
}

// ---------- ohne Server ----------

async function offline() {
  console.log('\nOhne Server');
  await step('Zerleger: Anfragen mit Body, NDJSON, SQL dazwischen, Kommentare', () => {
    const text = [
      '# Kommentar',
      'GET kunden/_search',
      '{',
      '  "query": { "match": { "ort": "Bern; Thun" } }',
      '}',
      '',
      'SELECT * FROM "kunden" LIMIT 5;',
      'SELECT 1',
      'GET _cat/indices?v',
      'POST kunden/_msearch',
      '{}',
      '{"query": {"match_all": {}}}',
      '',
      '// noch ein Kommentar',
      'GET _cluster/health',
    ].join('\n');
    const s = splitEs(text);
    assert.deepEqual(
      s.map((x) => x.sql.split('\n')[0]),
      ['GET kunden/_search', 'SELECT * FROM "kunden" LIMIT 5', 'SELECT 1', 'GET _cat/indices?v', 'POST kunden/_msearch', 'GET _cluster/health'],
    );
    assert.equal(s[0].sql.split('\n').length, 4, 'Body bis zur schließenden Klammer');
    assert.equal(s[4].sql.split('\n').length, 3, 'NDJSON: zwei Werte');
    for (const x of s) assert.equal(text.slice(x.start, x.end), x.sql);
  });

  await step('Zerleger: Anfrage ohne Body, offener Body bis zur nächsten Anfrage, Windows-Zeilenenden', () => {
    const s = splitEs('GET kunden\r\n\r\nGET a/_search\r\n{ "query": {\r\nGET b/_count\r\n');
    assert.deepEqual(s.map((x) => x.sql.split(/\r?\n/)[0]), ['GET kunden', 'GET a/_search', 'GET b/_count']);
    assert.ok(s[1].sql.includes('"query"'));
    assert.ok(isConsoleRequest('  GET x') && !isConsoleRequest('SELECT 1') && !isConsoleRequest('DELETE FROM x WHERE a = 1'));
  });

  await step('Anfrage lesen: Pfad, Body kompakt, Kibana-Dreifach-Anführungszeichen, Fehler im JSON', () => {
    const r = parseRequest('GET /kunden/_search\n{\n  // Kommentar\n  "query": { "query_string": { "query": """ort:"Bern" """ } }\n}');
    assert.equal(r.method, 'GET');
    assert.equal(r.path, 'kunden/_search');
    assert.deepEqual(JSON.parse(r.body!), { query: { query_string: { query: 'ort:"Bern" ' } } });
    assert.equal(parseRequest('POST _msearch\n{}\n{"size": 1}').body, '{}\n{"size":1}\n');
    assert.throws(() => parseRequest('GET x/_search\n{ "a": }'), /JSON-Body ist ungültig/);
    assert.throws(() => parseRequest('GET x/_search\n{ "a": 1 }\nnoch was'), /nach dem JSON noch Text/);
    assert.equal(kibanaToJson('{"a": """x\n"y" """}'), '{"a": "x\\n\\"y\\" "}');
  });

  await step('F174: Body wird nicht neu aufgebaut – große Ganzzahlen und Schlüsselreihenfolge bleiben', () => {
    const r = parseRequest('GET x/_search\n{"size": 12345678901234567890, "aggs": {"2": {"terms": {"field": "a"}}, "1": {"terms": {"field": "b"}}}}');
    assert.equal(r.body, '{"size":12345678901234567890,"aggs":{"2":{"terms":{"field":"a"}},"1":{"terms":{"field":"b"}}}}');
    assert.throws(() => parseRequest('GET x/_search\n{"a": }'), /ungültig/);
  });

  await step('Nur lesen: GET/HEAD und Such-Endpunkte erlaubt, alles Schreibende abgelehnt', () => {
    const ok: [string, string][] = [
      ['GET', 'kunden/_doc/1'],
      ['HEAD', 'kunden'],
      ['POST', 'kunden/_search?scroll=1m'],
      ['POST', '_search/scroll'],
      ['POST', '_sql?format=txt'],
      ['POST', '_sql/translate'],
      ['POST', 'kunden/_count'],
      ['POST', 'kunden/_explain/1'],
      ['POST', '_msearch'],
      ['POST', 'kunden/_field_caps?fields=*'],
      ['DELETE', '_search/scroll'],
      ['DELETE', '_pit'],
      ['POST', 'remote:kunden/_search'],
      // F292: _all, Index-Listen und Platzhalter als Ziel
      ['POST', '_all/_search'],
      ['POST', 'kunden,logs-*/_search'],
      ['POST', 'logs-*/_count'],
      ['POST', '_all/_field_caps?fields=*'],
      ['POST', 'kunden,logs-*/_msearch'],
      ['POST', '*:kunden/_search'],
      ['GET', '_all/_settings'],
      ['GET', 'logs-*/_search?q=ort:Bern'],
      // F292: Suchvorlagen und asynchrone Suchen (eine gespeicherte Suche löschen räumt nur auf, wie Scroll und PIT)
      ['POST', '_search/template'],
      ['POST', 'kunden,logs-*/_search/template?explain=true'],
      ['POST', '_msearch/template'],
      ['POST', '_render/template'],
      ['POST', 'kunden/_async_search?wait_for_completion_timeout=1s'],
      ['POST', 'logs-*/_async_search'],
      ['GET', '_async_search/FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc='],
      ['GET', '_async_search/status/FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc='],
      ['DELETE', '_async_search/FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc='],
      // F292: _all als Anfang einer Index-Liste; echte %-Kodierung (Umlaut, Leerzeichen) bleibt lesbar
      ['POST', '_all,kunden/_search'],
      ['POST', 'kunden,_all/_search'],
      ['GET', '_all,kunden/_settings'],
      ['GET', 'kunden/_doc/M%C3%BCller'],
      // F292: mit Index-Ziel hat Elasticsearch keine Route für das Aufräumen (7.17: 400 „Invalid type“, 8.10/9.5: kein Handler) – die Prüfung lässt es durch
      ['DELETE', 'kunden/_async_search/FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc='],
      ['DELETE', 'kunden/_search/scroll'],
    ];
    for (const [m, p] of ok) assert.equal(esReadOnlyViolation(m, p), null, `${m} ${p}`);
    const bad: [string, string][] = [
      ['PUT', 'kunden'],
      ['PUT', 'kunden/_doc/1'],
      ['POST', 'kunden/_doc'],
      ['POST', 'kunden/_update/1'],
      ['POST', '_bulk'],
      ['POST', 'kunden/_delete_by_query'],
      ['POST', 'kunden/_update_by_query'],
      ['POST', '_reindex'],
      ['DELETE', 'kunden'],
      ['DELETE', 'kunden/_doc/1'],
      ['POST', 'kunden/_close'],
      ['PUT', '_cluster/settings'],
      ['POST', '_security/api_key'],
      ['PATCH', 'kunden'],
      // F292: dieselben Ziele (_all, Index-Listen, Platzhalter) mit schreibenden Endpunkten
      ['POST', '_all/_delete_by_query'],
      ['POST', '_all/_update_by_query'],
      ['POST', 'kunden,logs-*/_update_by_query'],
      ['POST', 'logs-*/_delete_by_query?conflicts=proceed'],
      ['POST', '_all/_bulk'],
      ['POST', 'kunden,logs-*/_doc/1'],
      ['POST', 'logs-*/_close'],
      ['POST', '_all'],
      ['POST', '*'],
      ['PUT', '_all/_settings'],
      ['PUT', 'logs-*/_mapping'],
      ['DELETE', '_all'],
      ['DELETE', 'logs-*'],
      ['DELETE', 'kunden,logs-*'],
      ['GET', '_all/_refresh'],
      ['GET', 'logs-*/_flush'],
      ['GET', 'kunden,logs-*/_forcemerge'],
      ['HEAD', '_all/_refresh'],
      // F292: Suchvorlagen speichern/löschen, asynchrone Suchen nur mit genau einer ID löschen, nichts dahinter
      ['POST', '_scripts/meine-vorlage'],
      ['PUT', '_scripts/meine-vorlage'],
      ['DELETE', '_scripts/meine-vorlage'],
      ['PUT', '_search/template'],
      ['DELETE', '_search/template'],
      ['POST', '_search/template/_bulk'],
      ['POST', 'kunden/_search/template/_bulk'],
      ['DELETE', '_async_search'],
      ['DELETE', '_async_search/abc/def'],
      ['DELETE', '_async_search/_status'],
      ['PUT', '_async_search/abc'],
      ['POST', '_async_search/abc'],
      ['POST', '_async_search/_bulk'],
      ['POST', 'kunden/_async_search/abc/_bulk'],
      // F292: _all als Anfang einer Index-Liste gilt als Ziel – GET auf refresh/flush bleibt abgelehnt
      ['GET', '_all,kunden/_refresh'],
      ['GET', 'kunden,_all/_refresh'],
      ['HEAD', '_all,-logs/_flush'],
      ['POST', '_all,kunden/_delete_by_query'],
      ['POST', '_all,kunden'],
      // F292: %-kodiert aufgelöst wäre es _refresh/_flush; in der Positivliste von POST kommt Kodiertes nicht weiter
      ['GET', 'kunden/_%72efresh'],
      ['GET', 'kunden/%5Frefresh'],
      ['HEAD', 'kunden/_%66lush'],
      ['GET', '_all%2Ckunden/_refresh'],
      ['POST', 'kunden/%5Fsearch'],
    ];
    for (const [m, p] of bad) {
      const v = esReadOnlyViolation(m, p);
      assert.ok(v, `${m} ${p} hätte abgelehnt werden müssen`);
      // die Meldung nennt genau diese Anfrage (Nur lesen) – nicht die Pfad-Prüfung und nicht irgendeinen Fehler
      assert.ok(v.startsWith(`Nur lesen: „${m} ${p}“ würde Elasticsearch ändern`), `${m} ${p}: ${v}`);
    }
    // die Pfad-Prüfung (./, ../, //, ;, kodierte Schrägstriche und Punkte – auch doppelt kodiert –, kaputte %-Kodierung) meldet den Pfad
    const badPath: [string, string][] = [
      ['POST', 'kunden/_search/../_doc/1'],
      ['GET', 'kunden/../_doc'],
      ['POST', 'kunden%2F_doc'],
      ['POST', 'kunden//_doc'],
      ['POST', 'kunden%5C_doc'],
      ['GET', 'kunden/%252e%252e/_doc'],
      ['GET', 'kunden/_search%3Bx=y'],
      ['GET', 'kunden/_doc/100%'],
    ];
    for (const [m, p] of badPath) {
      const v = esReadOnlyViolation(m, p);
      assert.ok(v, `${m} ${p} hätte abgelehnt werden müssen`);
      assert.ok(v.startsWith(`Ungültiger Pfad „${p}“`), `${m} ${p}: ${v}`);
    }
  });

  await step('Antworten als Tabellen: Treffer, Aggregationen, große Zahlen exakt, Text', () => {
    const body =
      '{"took":3,"hits":{"total":{"value":2,"relation":"eq"},"hits":[' +
      '{"_index":"k","_id":"1","_score":1.0,"_source":{"name":"A","adresse":{"plz":"3000"},"nr":9007199254740993,"tags":["x","y"]}},' +
      '{"_index":"k","_id":"2","_score":1.0,"_source":{"name":"B","neu":true}}]},' +
      '"aggregations":{"orte":{"buckets":[{"key":"Bern","doc_count":2,"summe":{"value":10.5}}]},"schnitt":{"value":3.5}}}';
    const { sets, note } = consoleResultSets(body, 'application/json', 100);
    assert.deepEqual(sets.map((s) => s.label), ['Treffer', 'Aggregation orte', 'Aggregation schnitt', 'JSON']);
    assert.deepEqual(sets[0].columns.map((c) => c.name), ['_index', '_id', '_score', 'name', 'adresse.plz', 'nr', 'tags', 'neu']);
    assert.deepEqual(sets[0].rows[0], ['k', '1', 1, 'A', '3000', '9007199254740993', '["x","y"]', null]);
    assert.deepEqual(sets[1].rows, [['Bern', 2, 10.5]]);
    assert.equal(sets[3].textFormat, 'json');
    assert.match(note!, /^2 Treffer insgesamt, 2 geliefert, Elasticsearch 3 ms$/);
    assert.equal(consoleResultSets('health status index\ngreen open kunden\n', 'text/plain; charset=UTF-8', 10).sets[0].text, 'health status index\ngreen open kunden\n');
    // "size": 0 mit Aggregation: keine leere Treffer-Tabelle; ohne Aggregation bleibt sie (zeigt: nichts gefunden)
    const agg = consoleResultSets('{"hits":{"total":{"value":30,"relation":"eq"},"hits":[]},"aggregations":{"n":{"value":3}}}', 'application/json', 10);
    assert.deepEqual(agg.sets.map((s) => s.label), ['Aggregation n', 'JSON']);
    assert.deepEqual(consoleResultSets('{"hits":{"hits":[]}}', 'application/json', 10).sets.map((s) => s.label), ['Treffer', 'JSON']);
    assert.equal((parseJson('{"a":12345678901234567890,"b":1.5}') as { a: string }).a, '12345678901234567890');
  });

  await step('Mapping flach, Werte aus _source (Objekte, flache Schlüssel, Listen von Objekten)', () => {
    const f = flattenMapping({ a: { properties: { b: { type: 'keyword' } } }, n: { type: 'nested', properties: { x: { type: 'long' } } }, t: { type: 'text', fields: { keyword: { type: 'keyword' } } } });
    assert.deepEqual(f.map((x) => `${x.path}:${x.type}`), ['a.b:keyword', 'n:nested', 't:text']);
    assert.deepEqual(f[2].subfields, [{ name: 'keyword', type: 'keyword' }]);
    assert.equal(sourceValue({ a: { b: 1 } }, 'a.b'), 1);
    assert.equal(sourceValue({ 'a.b': 2 }, 'a.b'), 2);
    assert.deepEqual(sourceValue({ a: [{ b: 1 }, { b: 2 }] }, 'a.b'), [1, 2]);
    assert.equal(sourceValue({ a: null }, 'a.b'), undefined);
  });
}

// ---------- gegen einen Server ----------

interface Target {
  label: string;
  port: number;
  major: number;
  secure?: boolean;
  user?: string;
  password?: string;
}

const TARGETS: Target[] = [
  { label: '7.17', port: 15920, major: 7 },
  { label: '8.10', port: 15921, major: 8 },
  { label: '9.5 (HTTPS, Passwort)', port: 15922, major: 9, secure: true, user: 'elastic', password: 'dbviewer-test' },
];

function cfgOf(t: Target, extra: Partial<DriverConfig> = {}): DriverConfig {
  return {
    host: '127.0.0.1',
    port: t.port,
    user: t.user ?? '',
    password: t.password ?? '',
    ssl: !!t.secure,
    tls: t.secure ? { ca: CA, verifyServer: true, verifyHostname: true } : undefined,
    ...extra,
  };
}

async function reachable(t: Target): Promise<boolean> {
  const c = new EsClient(cfgOf(t));
  try {
    await c.json('GET', '', undefined, { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

const ORTE = ['Bern', 'Zürich', 'Basel'];
const BIG = 9007199254740993n;

/** Testdaten: kunden (30, mit Objekt, nested, Liste, großer Zahl), logs-2026.10 (12 000), Alias, versteckter Index, Data Stream */
async function seed(c: EsClient) {
  const ok = async (method: string, p: string, body?: unknown, ndjson = false) => {
    const r = await c.request(method, p, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), { ndjson, timeoutMs: 120_000 });
    if (r.status >= 400 && !(method === 'DELETE' && r.status === 404)) throw new Error(`${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`);
    return r;
  };
  await ok('DELETE', '_data_stream/owlyn-ds');
  await ok('DELETE', '_index_template/owlyn-ds');
  await ok('DELETE', 'kunden,logs-2026.10,versteckt,tief?ignore_unavailable=true');
  await ok('PUT', 'kunden', {
    mappings: {
      properties: {
        name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        ort: { type: 'keyword' },
        guthaben: { type: 'double' },
        geboren: { type: 'date', format: 'yyyy-MM-dd' },
        aktiv: { type: 'boolean' },
        adresse: { properties: { strasse: { type: 'text' }, plz: { type: 'keyword' } } },
        tags: { type: 'keyword' },
        notiz: { type: 'text' },
        kundennr: { type: 'long' },
        positionen: { type: 'nested', properties: { artikel: { type: 'keyword' }, menge: { type: 'integer' } } },
      },
    },
  });
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const doc: Record<string, unknown> = {
      name: `Kunde ${String(i).padStart(2, '0')}`,
      ort: ORTE[i % 3],
      guthaben: i * 10.5,
      geboren: `${1980 + (i % 20)}-01-15`,
      aktiv: i % 2 === 0,
      adresse: { strasse: `Weg ${i}`, plz: String(3000 + i) },
      tags: i % 4 === 0 ? ['a', 'b'] : ['a'],
      notiz: i % 5 === 0 ? 'Text mit Fehler' : 'alles gut',
      kundennr: 'BIG',
    };
    if (i <= 3) doc.positionen = [{ artikel: 'A-1', menge: i }, { artikel: 'B-2', menge: 1 }];
    lines.push(JSON.stringify({ index: { _id: `k${i}` } }), JSON.stringify(doc).replace('"BIG"', (BIG + BigInt(i)).toString()));
  }
  await ok('POST', 'kunden/_bulk?refresh=true', lines.join('\n') + '\n', true);
  await ok('PUT', 'logs-2026.10', { mappings: { properties: { '@timestamp': { type: 'date' }, level: { type: 'keyword' }, msg: { type: 'text' } } } });
  for (let from = 0; from < 12_000; from += 3000) {
    const l: string[] = [];
    for (let i = from; i < from + 3000; i++) {
      l.push('{"index":{}}', JSON.stringify({ '@timestamp': new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), level: i % 100 === 0 ? 'error' : 'info', msg: `Zeile ${i}` }));
    }
    await ok('POST', 'logs-2026.10/_bulk', l.join('\n') + '\n', true);
  }
  await ok('POST', 'logs-2026.10/_refresh');
  await ok('POST', '_aliases', { actions: [{ add: { index: 'kunden', alias: 'kunden_alias' } }] });
  await ok('PUT', 'tief', { settings: { 'index.max_result_window': 50 }, mappings: { properties: { n: { type: 'integer' } } } });
  await ok('POST', 'tief/_bulk?refresh=true', Array.from({ length: 300 }, (_, i) => `{"index":{}}\n{"n":${i + 1}}`).join('\n') + '\n', true);
  await ok('PUT', 'versteckt', { settings: { 'index.hidden': true } });
  await ok('PUT', '_index_template/owlyn-ds', { index_patterns: ['owlyn-ds*'], data_stream: {}, priority: 500 });
  await ok('POST', 'owlyn-ds/_doc?refresh=true', { '@timestamp': '2026-10-07T12:00:00Z', x: 1 });
}

const req = (name: string, extra: Partial<TableDataRequest> = {}): TableDataRequest => ({
  object: { connectionId: 'x', database: 'docker-cluster', schema: '', name, kind: 'table' },
  limit: 10,
  offset: 0,
  sort: [],
  ...extra,
});

async function openContexts(c: EsClient): Promise<number> {
  const r = await c.json<{ nodes: Record<string, { indices: { search: { open_contexts: number } } }> }>('GET', '_nodes/stats/indices/search');
  return Object.values(r.nodes).reduce((a, n) => a + n.indices.search.open_contexts, 0);
}

async function server(t: Target) {
  console.log(`\nElasticsearch ${t.label} (127.0.0.1:${t.port})`);
  const admin = new EsClient(cfgOf(t));
  const d = new ElasticDriver(cfgOf(t));
  try {
    await step('Testdaten anlegen', () => seed(admin));

    await step('Version, Cluster als einzige „Datenbank“', async () => {
      const info = await d.serverInfo();
      assert.match(info.version, new RegExp(`^Elasticsearch ${t.major}\\.`));
      assert.deepEqual(await d.listDatabases(), [info.currentDatabase]);
    });

    await step('Indizes, Data Stream, Alias als View; versteckte und Systemindizes nicht', async () => {
      const objs = await d.listObjects();
      const by = new Map(objs.map((o) => [o.name, o]));
      assert.equal(by.get('kunden')?.kind, 'table');
      // genau wie eine Suche zählt: ohne die 6 verschachtelten Positionen, die _cat/indices mitzählt
      assert.equal(by.get('kunden')?.rows, 30);
      const cat = await admin.json<{ 'docs.count': string }[]>('GET', '_cat/indices/kunden?format=json&h=docs.count');
      assert.equal(Number(cat[0]['docs.count']), 36);
      assert.equal(by.get('logs-2026.10')?.rows, 12_000);
      assert.equal(by.get('kunden_alias')?.kind, 'view');
      assert.equal(by.get('owlyn-ds')?.kind, 'table');
      assert.equal(by.get('owlyn-ds')?.rows, 1);
      assert.equal(by.get('tief')?.rows, 300);
      assert.ok(!by.has('versteckt'));
      assert.ok(objs.every((o) => !o.name.startsWith('.')));
    });

    await step('Struktur: Felder aus dem Mapping, _id als Schlüssel, Unterfelder, nested', async () => {
      const info = await d.describeTable('', '', 'kunden');
      const c = new Map(info.columns.map((x) => [x.name, x]));
      assert.equal(info.columns[0].name, '_id');
      assert.ok(info.columns[0].primaryKey);
      assert.equal(c.get('adresse.plz')?.dataType, 'keyword');
      assert.equal(c.get('geboren')?.dataType, 'date (yyyy-MM-dd)');
      assert.equal(c.get('positionen')?.dataType, 'nested');
      assert.match(c.get('name')?.comment ?? '', /name\.keyword \(keyword\)/);
      assert.match(await d.getDdl('', '', 'kunden'), /"mappings"/);
    });

    await step('Tabellenansicht: Spalten, Werte (Objekt, Liste, nested, große Zahl exakt), Sortieren über keyword', async () => {
      const r = await d.fetchTable(req('kunden', { sort: [{ column: 'name', dir: 'asc' }], limit: 3 }));
      const ix = (n: string) => r.columns.findIndex((x) => x.name === n);
      assert.equal(r.columns[0].name, '_id');
      assert.deepEqual(r.rows.map((x) => x[0]), ['k1', 'k2', 'k3']);
      const k1 = r.rows[0];
      assert.equal(k1[ix('adresse.plz')], '3001');
      assert.equal(k1[ix('tags')], '["a"]');
      assert.equal(k1[ix('kundennr')], '9007199254740994');
      assert.equal(k1[ix('aktiv')], false);
      assert.equal(k1[ix('guthaben')], 10.5);
      assert.match(String(k1[ix('positionen')]), /"artikel":"A-1"/);
      assert.ok(r.columns[ix('guthaben')].numeric);
      assert.match(r.sql, /^GET kunden\/_search\n\{/);
      const desc = await d.fetchTable(req('kunden', { sort: [{ column: 'guthaben', dir: 'desc' }], limit: 1, offset: 1 }));
      assert.equal(desc.rows[0][0], 'k29');
    });

    await step('Sortieren: Textfeld ohne keyword und _id mit klarer Meldung', async () => {
      await rejects(d.fetchTable(req('kunden', { sort: [{ column: 'notiz', dir: 'asc' }] })), /Textfeld ohne keyword-Unterfeld/);
      await rejects(d.fetchTable(req('kunden', { sort: [{ column: '_id', dir: 'asc' }] })), /Nach _id kann Elasticsearch nicht sortieren/);
    });

    await step('WHERE in SQL (über _sql/translate), Suche, Zählen', async () => {
      assert.equal(await d.countTable(req('kunden', { where: "ort = 'Bern' AND guthaben > 100" })), 7);
      assert.equal(await d.countTable(req('kunden', { where: `"adresse.plz" = '3005'` })), 1);
      assert.equal(await d.countTable(req('kunden', { where: "MATCH(notiz, 'Fehler')" })), 6);
      assert.equal(await d.countTable(req('kunden', { search: 'Zürich' })), 10);
      assert.equal(await d.countTable(req('kunden', { search: 'Zürich', where: 'aktiv = true' })), 5);
      const r = await d.fetchTable(req('kunden', { where: "ort = 'Basel'", limit: 50 }));
      assert.equal(r.rows.length, 10);
      await rejects(d.countTable(req('kunden', { where: 'gibtsnicht = 1' })), /^WHERE: Unknown column \[gibtsnicht\]$/);
      await rejects(d.countTable(req('kunden', { where: '1 = 1; DELETE' })), /Semikolon/);
    });

    const msgs = async (r: Promise<{ columns: { name: string }[]; rows: unknown[][] }>) => {
      const x = await r;
      const i = x.columns.findIndex((c) => c.name === 'msg');
      return x.rows.map((row) => row[i]);
    };
    const zeilen = (from: number, n: number) => Array.from({ length: n }, (_, k) => `Zeile ${from + k}`);
    const byTime = (dir: 'asc' | 'desc') => [{ column: '@timestamp', dir }];

    await step('Blättern über 10 000 hinaus (Point-in-Time): über die Grenze, weiter, zurück, letzte Seite, absteigend', async () => {
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 9995, limit: 10 }))), zeilen(9995, 10));
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 10_500, limit: 5 }))), zeilen(10_500, 5));
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 10_005, limit: 5 }))), zeilen(10_005, 5));
      // letzte Seite (kürzer) kommt von hinten
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 11_995, limit: 10 }))), zeilen(11_995, 5));
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 12_000, limit: 10 }))), []);
      assert.deepEqual(await msgs(d.fetchTable(req('logs-2026.10', { sort: byTime('desc'), offset: 10_000, limit: 3 }))), ['Zeile 1999', 'Zeile 1998', 'Zeile 1997']);
      const r = await d.fetchTable(req('logs-2026.10', { sort: byTime('asc'), offset: 10_000, limit: 1 }));
      assert.match(r.sql, /^# ab Treffer 10.000 blättert OwlynDB mit Point-in-Time/);
    });

    await step('Blättern ohne Sortierung: alle 12 000 Seite für Seite, keine doppelt, keine fehlt', async () => {
      const ids = new Set<unknown>();
      for (let offset = 0; offset < 12_000; offset += 1000) {
        const p = await d.fetchTable(req('logs-2026.10', { offset, limit: 1000 }));
        assert.equal(p.rows.length, 1000, `Seite ab ${offset}`);
        for (const row of p.rows) ids.add(row[0]);
      }
      assert.equal(ids.size, 12_000);
    });

    await step('Blättern mit Filter und kleinem max_result_window (mehrere Schritte, Merkpunkte)', async () => {
      const n = async (offset: number, limit: number, extra: Partial<TableDataRequest> = {}) => {
        const x = await d.fetchTable(req('tief', { sort: [{ column: 'n', dir: 'asc' }], offset, limit, ...extra }));
        const i = x.columns.findIndex((c) => c.name === 'n');
        return x.rows.map((row) => row[i]);
      };
      assert.deepEqual(await n(120, 5), [121, 122, 123, 124, 125]);
      assert.deepEqual(await n(95, 3), [96, 97, 98]);
      assert.deepEqual(await n(260, 3), [261, 262, 263]);
      assert.deepEqual(await n(60, 3, { where: 'n % 2 = 0' }), [122, 124, 126]);
      // mit Filter 150 Treffer: die letzte (kürzere) Seite kommt von hinten
      assert.deepEqual(await n(148, 5, { where: 'n % 2 = 0' }), [298, 300]);
      assert.equal(await d.countTable(req('logs-2026.10')), 12_000);
      assert.equal(await d.countTable(req('tief')), 300);
      // nach dem Zählen (Neu laden) sind die Point-in-Times wieder zu
      let open = -1;
      for (let i = 0; i < 20 && open !== 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        open = await openContexts(admin);
      }
      assert.equal(open, 0);
    });

    await step('Alias: zusätzlich _index', async () => {
      const r = await d.fetchTable({ ...req('kunden_alias'), object: { ...req('kunden_alias').object, kind: 'view' } });
      assert.deepEqual(r.columns.slice(0, 2).map((x) => x.name), ['_id', '_index']);
      assert.equal(r.rows[0][1], 'kunden');
    });

    await step('Export: alle 12 000 per Scroll, mit Filter, Scroll danach freigegeben', async () => {
      let n = 0;
      let cols = 0;
      await d.streamTable(req('logs-2026.10'), { begin: async (c) => void (cols = c.length), rows: async (b) => void (n += b.length) });
      assert.equal(n, 12_000);
      assert.equal(cols, 4);
      let errors = 0;
      await d.streamTable(req('logs-2026.10', { where: "level = 'error'" }), { begin: async () => undefined, rows: async (b) => void (errors += b.length) });
      assert.equal(errors, 120);
      assert.equal(await openContexts(admin), 0);
    });

    const s = await d.openSession();
    const run = (sql: string, maxRows = 1000) => s.run(splitEs(sql).map((x) => ({ sql: x.sql, offset: x.start })), maxRows);

    await step('Abfrage-Tab, SQL: GROUP BY, abgeschnitten nach max. Zeilen (Cursor geschlossen)', async () => {
      const r = await run('SELECT ort, COUNT(*) AS n FROM kunden GROUP BY ort ORDER BY ort;');
      assert.equal(r.statements[0].error, undefined);
      assert.deepEqual(r.results[0].rows, [['Basel', 10], ['Bern', 10], ['Zürich', 10]]);
      const big = await run('SELECT "@timestamp", msg FROM "logs-2026.10"', 2500);
      assert.equal(big.results[0].rows.length, 2500);
      assert.ok(big.results[0].truncated);
    });

    await step('Export eines SQL-Ergebnisses über max. Zeilen hinaus (Cursor bis zum Ende); Konsole nicht', async () => {
      let n = 0;
      let cols: string[] = [];
      await s.streamResult({ sql: 'SELECT "@timestamp", msg FROM "logs-2026.10"', offset: 0 }, 0, {
        begin: async (c) => void (cols = c.map((x) => x.name)),
        rows: async (b) => void (n += b.length),
      });
      assert.equal(n, 12_000);
      assert.deepEqual(cols, ['@timestamp', 'msg']);
      await rejects(s.streamResult({ sql: 'GET kunden/_search', offset: 0 }, 0, { begin: async () => undefined, rows: async () => undefined }), /nur SQL/);
    });

    await step('Abfrage-Tab, Konsole: Treffer, Aggregation, JSON, Meldung; _cat als Text; HEAD', async () => {
      const r = await run(
        [
          'GET kunden/_search',
          '{ "size": 5, "sort": [{ "kundennr": "asc" }],',
          '  "aggs": { "orte": { "terms": { "field": "ort" }, "aggs": { "summe": { "sum": { "field": "guthaben" } } } } } }',
          'GET _cat/indices/kunden?v',
          'HEAD kunden',
        ].join('\n'),
      );
      assert.deepEqual(r.statements.map((x) => x.error ?? 'ok'), ['ok', 'ok', 'ok']);
      assert.deepEqual(r.results.map((x) => x.label), ['1 · Treffer', '1 · Aggregation orte', '1 · JSON', '2 · Antwort']);
      assert.equal(r.results[0].rows.length, 5);
      const nr = r.results[0].columns.findIndex((c) => c.name === 'kundennr');
      assert.equal(r.results[0].rows[0][nr], '9007199254740994');
      assert.equal(r.results[1].rows.length, 3);
      assert.match(r.results[2].text ?? '', /"took"/);
      assert.match(r.results[3].text ?? '', /kunden/);
      assert.ok(r.messages.some((m) => /^GET kunden\/_search: 30 Treffer insgesamt, 5 geliefert/.test(m)), r.messages.join(' | '));
    });

    await step('Konsole: _msearch (NDJSON), Kibana-Dreifach-Anführungszeichen, Fehler mit Grund', async () => {
      const r = await run('GET kunden/_msearch\n{}\n{"size": 1}\nGET kunden/_count\n{"query": {"query_string": {"query": """ort:Bern"""}}}');
      assert.deepEqual(r.statements.map((x) => x.error ?? 'ok'), ['ok', 'ok']);
      assert.match(r.results.at(-1)?.text ?? '', /"count" : 10/);
      const bad = await run('GET kunden/_search\n{"query": {"gibtsnicht": {}}}');
      assert.match(bad.statements[0].error ?? '', /gibtsnicht/);
      const json = await run('GET kunden/_search\n{"size": }');
      assert.match(json.statements[0].error ?? '', /JSON-Body ist ungültig/);
    });

    await step('F236/F249: Konsole – Nicht-ASCII im Pfad, 404 mit Inhalt (found: false) als Antwort statt Fehler', async () => {
      const r = await d.consoleRequest(parseRequest('GET kunden/_doc/äöü-ß'), 10, new AbortController().signal);
      assert.match(r.note ?? '', /HTTP 404/);
      assert.ok(r.sets.some((x) => x.text?.includes('"found"')), JSON.stringify(r.sets.map((x) => x.label)));
      // echte Fehler bleiben Fehler
      await rejects(d.consoleRequest(parseRequest('GET gibt_es_nicht/_search'), 10, new AbortController().signal), /index_not_found|no such index/);
    });

    await step('F235: geschlossener Index – klare Meldung', async () => {
      await admin.request('DELETE', 'zu?ignore_unavailable=true');
      await admin.json('PUT', 'zu', { mappings: { properties: { n: { type: 'integer' } } } });
      await admin.json('POST', 'zu/_close');
      try {
        assert.ok((await d.listObjects()).some((o) => o.name === 'zu'));
        await rejects(d.fetchTable(req('zu')), /geschlossen/);
      } finally {
        await admin.request('DELETE', 'zu');
      }
    });

    await step('F056/F238: Sortierung mit mode, Suche ohne Groß/klein auf keyword-Feldern', async () => {
      const r = await d.fetchTable(req('kunden', { sort: [{ column: 'ort', dir: 'desc' }] }));
      assert.match(r.sql, /"mode": "max"/);
      const lower = await d.fetchTable(req('kunden', { search: 'bern', limit: 100 }));
      assert.equal(lower.rows.length, 10, 'bern (klein) findet Bern');
      const upper = await d.fetchTable(req('kunden', { search: 'Bern', limit: 100 }));
      assert.equal(upper.rows.length, 10);
      assert.equal(await d.countTable(req('kunden', { search: 'bern' })), 10);
    });

    await step('F241: Objektfelder (geo_point) ergeben keine Zusatzspalten', async () => {
      await admin.request('DELETE', 'geo?ignore_unavailable=true');
      await admin.json('PUT', 'geo', { mappings: { properties: { ort: { type: 'geo_point' }, name: { type: 'keyword' } } } });
      await admin.json('POST', 'geo/_doc?refresh=true', { ort: { lat: 47.3, lon: 8.5 }, name: 'x' });
      try {
        const r = await d.fetchTable(req('geo'));
        assert.deepEqual(r.columns.map((c) => c.name).sort(), ['_id', 'name', 'ort']);
      } finally {
        await admin.request('DELETE', 'geo');
      }
    });

    await step('F059: Export – Felder, die erst nach dem ersten Stapel auftauchen, werden gemeldet', async () => {
      await admin.request('DELETE', 'dyn?ignore_unavailable=true');
      await admin.json('PUT', 'dyn', { mappings: { dynamic: false, properties: { a: { type: 'keyword' } } } });
      const lines: string[] = [];
      for (let i = 0; i < 2100; i++) {
        const a = `v${String(i).padStart(4, '0')}`;
        lines.push('{"index":{}}', JSON.stringify(i < 2050 ? { a } : { a, spaet: i }));
      }
      await admin.request('POST', 'dyn/_bulk?refresh=true', lines.join('\n') + '\n', { ndjson: true, timeoutMs: 120_000 });
      try {
        const notes: string[] = [];
        let cols: string[] = [];
        let n = 0;
        await d.streamTable(req('dyn', { sort: [{ column: 'a', dir: 'asc' }] }), {
          begin: async (c) => {
            cols = c.map((x) => x.name);
          },
          rows: async (b) => {
            n += b.length;
          },
          note: (t) => notes.push(t),
        });
        assert.equal(n, 2100);
        assert.ok(!cols.includes('spaet'));
        assert.equal(notes.length, 1, notes.join(' | '));
        assert.match(notes[0], /spaet/);
      } finally {
        await admin.request('DELETE', 'dyn');
      }
    });

    await step('F244/F058: zwei gleichzeitige tiefe Seiten teilen sich einen Point-in-Time; nach close() keiner offen', async () => {
      const before = await openContexts(admin);
      const [a, b] = await Promise.all([d.fetchTable(req('logs-2026.10', { offset: 11_000, limit: 5 })), d.fetchTable(req('logs-2026.10', { offset: 11_005, limit: 5 }))]);
      assert.equal(a.rows.length, 5);
      assert.equal(b.rows.length, 5);
      assert.notDeepEqual(a.rows[0], b.rows[0]);
      // ein Point-in-Time je Richtung (die Seiten nahe am Ende laufen von hinten), nicht einer je Aufruf
      const during = await openContexts(admin);
      assert.ok(during - before <= 2, `offene Kontexte: ${during - before}`);
    });

    await step('Nur lesen: schreibende Anfrage – nichts läuft, auch nicht die Anfrage davor', async () => {
      for (const w of ['PUT kunden/_doc/x\n{"a": 1}', 'POST kunden/_delete_by_query\n{"query": {"match_all": {}}}', 'DELETE kunden', 'POST kunden/_doc\n{"a": 1}', 'PUT kunden/_settings\n{"index": {"number_of_replicas": 0}}']) {
        const r = await run(`GET kunden/_count\n${w}`);
        assert.equal(r.results.length, 0, w);
        assert.equal(r.statements.length, 1, w);
        assert.match(r.statements[0].error ?? '', /^Nur lesen: /, w);
      }
      assert.equal((await admin.json<{ count: number }>('GET', 'kunden/_count')).count, 30);
      await rejects(s.explain([], false), /keinen Ausführungsplan/);
    });
    await s.close();
  } finally {
    await d.close();
    admin.close();
  }
}

// ---------- Anmeldung, TLS, Proxy, SSH ----------

async function security(t: Target, plain?: Target) {
  console.log('\nAnmeldung und TLS (9.5)');
  const info = (cfg: DriverConfig) => {
    const d = new ElasticDriver(cfg);
    return d.serverInfo().finally(() => d.close());
  };
  await step('ohne Anmeldung bzw. mit falschem Passwort: 401 mit Hinweis', async () => {
    await rejects(info(cfgOf(t, { user: '', password: '' })), /Anmeldung abgelehnt \(401\)/);
    await rejects(info(cfgOf(t, { password: 'falsch' })), /Anmeldung abgelehnt \(401\)/);
  });
  await step('API-Key: Base64 („encoded“) und „id:schlüssel“', async () => {
    const admin = new EsClient(cfgOf(t));
    const k = await admin.json<{ id: string; api_key: string; encoded: string }>('POST', '_security/api_key', { name: 'owlyndb-test', expiration: '1h' });
    admin.close();
    assert.match((await info(cfgOf(t, { user: '', password: k.encoded, apiKey: true }))).version, /^Elasticsearch 9\./);
    assert.match((await info(cfgOf(t, { user: 'egal', password: `${k.id}:${k.api_key}`, apiKey: true }))).version, /^Elasticsearch 9\./);
    await rejects(info(cfgOf(t, { user: '', password: 'Zm9vOmJhcg==', apiKey: true })), /401/);
  });
  await step('TLS: ohne CA bei Prüfung abgelehnt, ohne Prüfung verschlüsselt, falscher Name erkannt', async () => {
    await rejects(info(cfgOf(t, { tls: { verifyServer: true, verifyHostname: true } })), /Serverzertifikat nicht vertrauenswürdig/);
    assert.match((await info(cfgOf(t, { tls: { verifyServer: false, verifyHostname: false } }))).version, /^Elasticsearch 9\./);
    await rejects(info(cfgOf(t, { servername: 'falsch.example' })), /passt nicht zum Namen „falsch\.example“/);
  });
  await step(`HTTP gegen HTTPS${plain ? ' und umgekehrt' : ''}: verständliche Meldung`, async () => {
    await rejects(info(cfgOf(t, { ssl: false, tls: undefined })), /erwartet der Server HTTPS/);
    // umgekehrt braucht einen Server ohne TLS (7.17 oder 8.10)
    if (plain) await rejects(info({ host: '127.0.0.1', port: plain.port, user: '', password: '', ssl: true, tls: { verifyServer: false, verifyHostname: false } }), /spricht kein TLS/);
  });
}

async function limitedUsers(t: Target) {
  console.log('\nBenutzer mit wenig Rechten (9.5)');
  const admin = new EsClient(cfgOf(t));
  const ensure = async (role: string, privileges: string[], user: string) => {
    await admin.json('PUT', `_security/role/${role}`, { indices: [{ names: ['kunden*'], privileges }] });
    await admin.json('PUT', `_security/user/${user}`, { password: 'dbviewer-test', roles: [role] });
  };
  try {
    await ensure('owlyn_meta', ['read', 'view_index_metadata'], 'meta');
    await ensure('owlyn_read', ['read'], 'leser');
    await step('F052/F053: ohne Cluster-Recht monitor – verbinden, Indexliste über _resolve, lesen', async () => {
      const d = new ElasticDriver(cfgOf(t, { user: 'meta', password: 'dbviewer-test' }));
      try {
        assert.match((await d.serverInfo()).version, /Version unbekannt/);
        const objs = await d.listObjects();
        assert.ok(objs.some((o) => o.name === 'kunden'), objs.map((o) => o.name).join(', '));
        assert.ok(objs.some((o) => o.name === 'kunden_alias' && o.kind === 'view'));
        assert.equal((await d.fetchTable(req('kunden', { limit: 5 }))).rows.length, 5);
      } finally {
        await d.close();
      }
    });
    await step('F240: nur read – Felder über _field_caps, Tabelle lesbar', async () => {
      const d = new ElasticDriver(cfgOf(t, { user: 'leser', password: 'dbviewer-test' }));
      try {
        const info = await d.describeTable('', '', 'kunden');
        const names = info.columns.map((c) => c.name);
        for (const n of ['_id', 'name', 'ort', 'adresse.plz', 'positionen']) assert.ok(names.includes(n), `${n} fehlt: ${names.join(', ')}`);
        assert.ok(!names.includes('name.keyword'), 'Unterfeld als Spalte');
        assert.deepEqual(info.columns.find((c) => c.name === 'name')?.comment, 'Unterfelder: name.keyword (keyword)');
        const r = await d.fetchTable(req('kunden', { limit: 3, sort: [{ column: 'name', dir: 'asc' }] }));
        assert.equal(r.rows.length, 3);
      } finally {
        await d.close();
      }
    });
  } finally {
    for (const u of ['meta', 'leser']) await admin.request('DELETE', `_security/user/${u}`);
    for (const r of ['owlyn_meta', 'owlyn_read']) await admin.request('DELETE', `_security/role/${r}`);
    admin.close();
  }
}

async function proxy() {
  console.log('\nHAProxy mit Client-Zertifikat vor 8.10');
  const base: DriverConfig = { host: '127.0.0.1', port: 15925, user: '', password: '', ssl: true, tls: { ca: CA, verifyServer: true, verifyHostname: true } };
  const info = (cfg: DriverConfig) => {
    const d = new ElasticDriver(cfg);
    return d.serverInfo().finally(() => d.close());
  };
  await step('mit Client-Zertifikat: verbunden; ohne: abgelehnt', async () => {
    const tlsWith = { ...base.tls!, cert: readFileSync(cert('client.crt'), 'utf8'), key: readFileSync(cert('client.key'), 'utf8') };
    assert.match((await info({ ...base, tls: tlsWith })).version, /^Elasticsearch 8\.10/);
    await rejects(info(base), /./);
  });
}

async function viaManager(withSsh: boolean) {
  console.log('\nÜber den Manager (wie die Oberfläche)');
  const store = new ConnectionStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'dbv-es-')), 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
  const host = { pickFile: async () => null, saveFile: async () => null, showInFolder: () => undefined, confirmHostKey: async () => true };
  const m = new Manager(store, host, 0);
  const input = (o: ConnectionOptions = {}, extra: Partial<ConnectionInput> = {}): ConnectionInput => ({ name: 'es', dialect: 'elasticsearch', host: '127.0.0.1', port: 15921, user: '', password: '', options: o, ...extra });
  try {
    const c = await store.save(input());
    await step('verbinden, Objekte, Tabelle, Abfrage samt Verlauf, Objektsuche', async () => {
      const info = await m.connect(c.id);
      assert.match(info.version, /^Elasticsearch 8\.10/);
      const db = (await m.listDatabases(c.id))[0];
      assert.ok((await m.listObjects(c.id, db, '')).some((o) => o.name === 'kunden'));
      const r = await m.fetchTable({ ...req('kunden'), object: { connectionId: c.id, database: db, schema: '', name: 'kunden', kind: 'table' } });
      assert.equal(r.rows.length, 10);
      const { sessionId } = await m.openSession(c.id, db);
      const q = await m.runQuery(sessionId, [{ sql: 'GET kunden/_count', offset: 0 }], 100);
      assert.equal(q.statements[0].error, undefined);
      assert.ok((await m.listHistory({ connectionId: c.id })).some((h) => h.sql === 'GET kunden/_count'));
      const found = await m.searchObjects(c.id, 'plz');
      assert.ok(found.hits.some((h) => h.kind === 'column' && h.name === 'kunden' && h.column === 'adresse.plz'));
    });
    await step('Dump, Kopieren, Vergleich, Bearbeiten: gesperrt mit Hinweis', async () => {
      const no = /gibt es für Elasticsearch nicht/;
      await rejects(m.startDump({ connectionId: c.id, database: 'x', tables: [], structure: true, data: true, targetDialect: 'mysql', baseName: 'x' } as never), no);
      await rejects(m.applyChanges({ object: { connectionId: c.id, database: 'x', schema: '', name: 'kunden', kind: 'table' }, changes: [], preview: true }), no);
      await rejects(m.compareSchemas({ source: { connectionId: c.id, database: 'x', schema: '' }, target: { connectionId: c.id, database: 'x', schema: '' } } as never), no);
      await rejects(m.startDataCompare({ source: { connectionId: c.id, database: 'x', schema: '', table: 'kunden' }, target: { connectionId: c.id, database: 'x', schema: '', table: 'kunden' } } as never), no);
    });
    if (withSsh) {
      await step('SSH-Tunnel: es8 aus Sicht des SSH-Servers', async () => {
        const viaSsh = await store.save(input({ ssh: true, sshHost: '127.0.0.1', sshPort: 15022, sshUser: 'tunnel', sshKeyFile: cert('ssh_client') }, { host: 'es8', port: 9200, name: 'es-ssh' }));
        assert.match((await m.connect(viaSsh.id)).version, /^Elasticsearch 8\.10/);
        const db = (await m.listDatabases(viaSsh.id))[0];
        assert.ok((await m.listObjects(viaSsh.id, db, '')).some((o) => o.name === 'kunden'));
      });
    }
  } finally {
    await m.shutdown();
  }
}

/** läuft der Container (HAProxy, sshd)? */
function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      res(true);
    });
    sock.once('error', () => res(false));
  });
}

async function main() {
  await offline();
  const up: Target[] = [];
  for (const t of TARGETS) {
    if (await reachable(t)) up.push(t);
    else {
      skipped++;
      console.log(`\nElasticsearch ${t.label}: nicht erreichbar auf ${t.port} – übersprungen`);
    }
  }
  // nur gegen die Test-Container: seed() löscht und füllt Indizes, „Nur lesen“ schickt absichtlich DELETE
  assertTestContainers(up.map((t) => ({ name: `Elasticsearch ${t.label}`, host: '127.0.0.1', port: t.port })));
  for (const t of up) await server(t);
  const es9 = up.find((t) => t.major === 9);
  if (es9) {
    await security(es9, up.find((t) => !t.secure));
    await limitedUsers(es9);
  }
  const es8 = up.find((t) => t.major === 8);
  if (es8) {
    if (await portOpen(15925)) {
      assertTestContainers([{ name: 'HAProxy vor Elasticsearch', host: '127.0.0.1', port: 15925 }]);
      await proxy();
    } else {
      skipped++;
      console.log('\nHAProxy 15925 nicht erreichbar – Client-Zertifikat übersprungen');
    }
    const sshUp = await portOpen(15022);
    if (sshUp) assertTestContainers([{ name: 'SSH-Container', host: '127.0.0.1', port: 15022 }]);
    else {
      skipped++;
      console.log('\nSSH-Container 15022 nicht erreichbar – SSH-Tunnel übersprungen');
    }
    await viaManager(sshUp);
  }
  console.log(failed ? `\n${failed} Fehler` : `\nalles ok${skipped ? ` (${skipped} Teil(e) übersprungen)` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
