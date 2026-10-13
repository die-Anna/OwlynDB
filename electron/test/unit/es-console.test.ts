/* Reine Logik ohne Datenbank (npm run test:unit): Elasticsearch-Konsole (shared/es-console.ts) – Nur-lesen-Prüfung und Formatieren */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esReadOnlyViolation, formatRequest, isConsoleRequest, kibanaToJson, parseRequest, splitEs } from '../../../shared/es-console';

const ok = (method: string, path: string, body?: string) => assert.equal(esReadOnlyViolation(method, path, body), null, `${method} ${path}`);
const no = (method: string, path: string, body?: string) => assert.ok(esReadOnlyViolation(method, path, body), `${method} ${path} müsste abgelehnt werden`);

test('erlaubte Lese-Anfragen', () => {
  ok('GET', 'kunden/_search');
  ok('GET', '_cat/indices?v');
  ok('GET', 'kunden/_doc/1');
  ok('HEAD', 'kunden');
  ok('POST', 'kunden/_search');
  ok('POST', '_search');
  ok('POST', '/kunden/_search?size=0');
  ok('POST', '_sql?format=json');
  ok('POST', '_sql/translate');
  ok('POST', 'kunden,logs-*/_search');
  ok('POST', '_all/_search');
  ok('POST', 'kunden/_count');
  ok('POST', '_msearch');
  ok('POST', 'kunden/_explain/1');
  ok('POST', 'kunden/_termvectors/7');
  ok('POST', 'kunden/_termvectors');
  ok('POST', '_search/scroll');
  ok('POST', 'kunden/_pit?keep_alive=1m');
  ok('DELETE', '_search/scroll', '{"scroll_id": "abc"}');
  ok('DELETE', '_pit', '{"id": "abc"}');
  ok('DELETE', '_async_search/FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc=');
});

test('F021: der Endpunkt muss das erste Segment hinter dem Index-Ziel sein – nichts dahinter', () => {
  no('POST', '_search/_bulk');
  no('POST', 'kunden/_search/_bulk');
  no('POST', '_count/_bulk');
  no('POST', '_all/_search/_bulk');
  no('POST', 'kunden/_search/scroll/_bulk');
  no('POST', '_explain/1/_bulk');
  no('POST', 'kunden/_explain/_doc');
});

test('schreibende Anfragen werden abgelehnt', () => {
  no('POST', 'kunden/_doc');
  no('POST', 'kunden/_doc/1');
  no('PUT', 'kunden/_doc/1');
  no('POST', 'kunden/_update/1');
  no('POST', '_bulk');
  no('POST', 'kunden/_delete_by_query');
  no('DELETE', 'kunden');
  no('DELETE', 'kunden/_doc/1');
  no('POST', 'kunden/_refresh');
  no('PUT', '_cluster/settings');
  no('POST', 'kunden');
});

test('F306: GET/HEAD an Endpunkte, die den Index ändern, und DELETE scroll _all', () => {
  no('GET', 'kunden/_refresh');
  no('GET', 'kunden/_flush');
  no('GET', 'kunden/_cache/clear');
  no('GET', '_forcemerge');
  no('HEAD', 'kunden/_refresh');
  no('DELETE', '_search/scroll', '{"scroll_id": "_all"}');
  no('DELETE', '_search/scroll', '{ "scroll_id" : ["_all"] }');
  ok('GET', 'kunden/_settings');
});

test('F305/F307: Pfade mit ;, ../, //, kodierten Schrägstrichen; _all als Index-Ziel', () => {
  no('POST', 'kunden/_search;x=y');
  no('POST', '_search/..;/_bulk');
  no('POST', '../_bulk');
  no('POST', 'kunden//_search');
  no('POST', 'kunden%2f_search');
  ok('POST', '_all/_count');
  ok('GET', '_all/_search');
});

// ---------- F292: Formatieren (Umschalt+Alt+F) schreibt den Text des Benutzers um – die Werte dürfen sich nicht ändern ----------

/** Leerraum außerhalb von Zeichenketten entfernen – bewusst unabhängig von reflowJson, damit Zahlen und Texte Zeichen für Zeichen vergleichbar sind */
function ohneLeerraum(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

/** Body einer formatierten Anfrage: alles nach der Kopfzeile */
const bodyOf = (request: string) => request.slice(request.indexOf('\n') + 1);

/** formatRequest mit den beiden Zusagen: nachher liest parseRequest dasselbe wie vorher (Methode, Pfad, Body ohne Kommentare), ein zweiter Durchgang ändert nichts */
function formatiert(vorher: string): string {
  const nachher = formatRequest(vorher);
  assert.deepEqual(parseRequest(nachher), parseRequest(vorher), `gleiche Anfrage nach dem Formatieren:\n${nachher}`);
  assert.equal(formatRequest(nachher), nachher, 'zweites Formatieren ändert nichts (idempotent)');
  return nachher;
}

test('F292: formatRequest rückt den Body ein; Kopfzeile, Schlüsselreihenfolge und Werte bleiben', () => {
  const out = formatiert(
    '  GET /kunden/_search?size=0  \n\n  {"size":10,"query":{"bool":{"must":[{"match":{"ort":"Bern"}}],"filter":[]}},"sort":[{"id":"asc"},"_score"],"aggs":{"2":{"terms":{"field":"a"}},"1":{}}}  \n',
  );
  assert.equal(
    out,
    [
      'GET /kunden/_search?size=0',
      '{',
      '  "size": 10,',
      '  "query": {',
      '    "bool": {',
      '      "must": [',
      '        {',
      '          "match": {',
      '            "ort": "Bern"',
      '          }',
      '        }',
      '      ],',
      '      "filter": []',
      '    }',
      '  },',
      '  "sort": [',
      '    {',
      '      "id": "asc"',
      '    },',
      '    "_score"',
      '  ],',
      '  "aggs": {',
      '    "2": {',
      '      "terms": {',
      '        "field": "a"',
      '      }',
      '    },',
      '    "1": {}',
      '  }',
      '}',
    ].join('\n'),
  );
});

test('F292: formatRequest – das Ergebnis hängt nicht vom Layout der Eingabe ab (kompakt, 2, 4, Tabulator, Windows)', () => {
  const obj = { size: 3, query: { bool: { must: [{ term: { 'ort.keyword': 'Bern' } }], must_not: [], filter: {} } }, _source: ['a', 'b'], aggs: { 2: { max: { field: 'x' } }, 1: { min: { field: 'x' } } } };
  const soll = formatRequest(`GET kunden/_search\n${JSON.stringify(obj)}`);
  // die Ausgabe gibt die Eingabe richtig wieder (die Varianten unten werden nur mit ihr verglichen, sie müssen also stimmen)
  assert.deepEqual(JSON.parse(bodyOf(soll)), obj);
  assert.ok(soll.startsWith('GET kunden/_search\n{\n  "size": 3,\n  "query": {\n    "bool": {\n      "must": ['), soll);
  assert.ok(soll.includes('"must_not": [],') && soll.includes('"filter": {}'), 'leere Container bleiben in einer Zeile');
  for (const einzug of [2, 4, '\t']) assert.equal(formatRequest(`GET kunden/_search\n${JSON.stringify(obj, null, einzug)}`), soll, `Einzug ${JSON.stringify(einzug)}`);
  assert.equal(formatRequest(`GET kunden/_search\r\n${JSON.stringify(obj, null, 2).replace(/\n/g, '\r\n')}\r\n`), soll, 'Windows-Zeilenenden');
  // auch bei großen Zahlen und Exponenten, die JSON.stringify nicht mehr treffen würde
  const kompakt = formatRequest('GET k/_search\n{"a":12345678901234567890,"b":[1.5e3,2E-2]}');
  const locker = formatRequest('GET k/_search\n{\n\t"a" : 12345678901234567890 ,\n\t"b" : [ 1.5e3 , 2E-2 ]\n}');
  assert.equal(kompakt, locker);
  assert.equal(kompakt, 'GET k/_search\n{\n  "a": 12345678901234567890,\n  "b": [\n    1.5e3,\n    2E-2\n  ]\n}');
});

test('F292: formatRequest – Zahlen bleiben Zeichen für Zeichen (1.5e3, Ganzzahlen über 2^53, -0, 1.0)', () => {
  const zahlen = '{"a":1.5e3,"b":12345678901234567890,"c":9007199254740993,"d":-0,"e":1E+10,"f":0.10,"g":1.0,"h":-1.5e-3,"i":[1e2,2E-2,0.5],"j":-9223372036854775809}';
  const out = formatiert(`GET k/_search\n${zahlen}`);
  assert.equal(ohneLeerraum(bodyOf(out)), zahlen);
  const lines = out.split('\n');
  for (const l of ['  "a": 1.5e3,', '  "b": 12345678901234567890,', '  "c": 9007199254740993,', '  "d": -0,', '  "e": 1E+10,', '  "f": 0.10,', '  "g": 1.0,', '  "h": -1.5e-3,'])
    assert.ok(lines.includes(l), `Zeile fehlt: ${l}`);
  // über JSON.parse wäre aus 9007199254740993 die Zahl 9007199254740992 geworden und aus 1.5e3 die 1500
  assert.ok(bodyOf(out).includes('9007199254740993') && !bodyOf(out).includes('9007199254740992') && !bodyOf(out).includes('1500'));
  // NDJSON (eine Zeile je Wert) verändert die Zahlen ebenso wenig
  assert.equal(formatiert(`POST _bulk\n{"index":{"_id":"1"}}\n${zahlen}`), `POST _bulk\n{"index":{"_id":"1"}}\n${zahlen}`);
});

test('F292: formatRequest – Unicode, Escape-Folgen und Zeichen, die wie JSON-Syntax oder Kommentare aussehen, in Zeichenketten bleiben unberührt', () => {
  const text =
    '{"name":"Zürich ✓ 😀 日本語 \u00a0 \u2028","pfad":"a//b /* c */ {[,:]}","esc":"a\\"b\\\\c\\u00e4\\n\\t\\/","leer":"","url":"http://x.ch/a?b=c#d","": 1}';
  const out = formatiert(`GET kunden/_search\n${text}`);
  assert.equal(ohneLeerraum(bodyOf(out)), ohneLeerraum(text));
  const parsed = JSON.parse(bodyOf(out));
  assert.deepEqual(parsed, JSON.parse(text));
  assert.equal(parsed.name, 'Zürich ✓ 😀 日本語 \u00a0 \u2028');
  assert.equal(parsed.pfad, 'a//b /* c */ {[,:]}');
  assert.equal(parsed.esc, 'a"b\\cä\n\t/');
  assert.ok(bodyOf(out).includes('"esc": "a\\"b\\\\c\\u00e4\\n\\t\\/"'), 'Escape-Folgen nicht aufgelöst');
  // dasselbe als NDJSON: eine Zeile, Leerraum nur außerhalb der Zeichenketten weg
  assert.equal(formatiert(`POST _bulk\n{"index":{}}\n${text}`), `POST _bulk\n{"index":{}}\n${ohneLeerraum(text)}`);
  assert.ok(ohneLeerraum(text).includes('"":1}') && ohneLeerraum(text).includes('日本語 \u00a0 \u2028'));
});

test('F292: formatRequest – Zeichenketten, die auf einen escapten Backslash enden, schließen richtig ab (der Rest wird nicht verschluckt)', () => {
  const text = String.raw`{"p":"C:\\","q":"\\\\","r":"a\\\"b\\","s":1}`;
  const out = formatiert(`GET k/_search\n${text}`);
  assert.equal(out, 'GET k/_search\n' + ['{', String.raw`  "p": "C:\\",`, String.raw`  "q": "\\\\",`, String.raw`  "r": "a\\\"b\\",`, '  "s": 1', '}'].join('\n'));
  assert.deepEqual(JSON.parse(bodyOf(out)), { p: 'C:\\', q: '\\\\', r: 'a\\"b\\', s: 1 });
  assert.equal(formatiert(`POST _bulk\n{"index":{}}\n${text}`), `POST _bulk\n{"index":{}}\n${text}`);
});

test('F292: formatRequest – NBSP und Zeilentrenner U+2028 zwischen den JSON-Teilen (Copy-and-paste) werden entfernt; vorher ungültig, nachher gültig', () => {
  // Entscheid F292: das ist erwünscht, kein Verlust – außerhalb von Zeichenketten tragen die Zeichen keinen Wert, und Elasticsearch lehnte den Text sonst ab
  const vorher = 'GET k/_search\n{"a":\u00a01,\u2028"b":\u00a0[2]}';
  assert.throws(() => parseRequest(vorher), /Der JSON-Body ist ungültig/);
  const out = formatRequest(vorher);
  assert.equal(out, 'GET k/_search\n{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(parseRequest(out).body, '{"a":1,"b":[2]}');
  assert.equal(formatRequest(out), out, 'idempotent');
  // in Zeichenketten bleiben sie dagegen, wie sie sind
  assert.ok(formatRequest('GET k/_search\n{"a":"x\u00a0y\u2028z"}').includes('"x\u00a0y\u2028z"'));
});

test('F292: formatRequest – NDJSON: „eine Zeile je Wert“ gilt, solange kein Umbruch in einem Blockkommentar oder in """ steckt (der bleibt, wie er ist)', () => {
  // Blockkommentar mit Umbruch: der Wert geht über zwei Zeilen; gleich bleibt, was parseRequest daraus macht (Kommentare fallen weg)
  const kommentar = formatiert('POST _bulk\n{ "index" : { /* a\n b */ "_id" : "1" } }\n{ "a" : 1 }');
  assert.equal(kommentar, 'POST _bulk\n{"index":{/* a\n b */"_id":"1"}}\n{"a":1}');
  assert.equal(parseRequest(kommentar).body, '{"index":{"_id":"1"}}\n{"a":1}\n');
  // """ mit Umbruch: wie oben, parseRequest macht daraus eine JSON-Zeichenkette mit \n
  const dreifach = formatiert('POST _bulk\n{ "index" : { } }\n{ "t" : """x\ny""" }');
  assert.equal(dreifach, 'POST _bulk\n{"index":{}}\n{"t":"""x\ny"""}');
  assert.equal(parseRequest(dreifach).body, '{"index":{}}\n{"t":"x\\ny"}\n');
  // splitEs liest beide Anfragen als je eine Anweisung (die Umbrüche im Wert trennen nichts)
  assert.equal(splitEs(kommentar).length, 1);
  assert.equal(splitEs(dreifach).length, 1);
});

test('F292: formatRequest – Kommentare (// und /* */) bleiben in Text und Reihenfolge, die Werte ebenso', () => {
  const vorher = [
    'GET kunden/_search',
    '{',
    '  // Kopfkommentar',
    '  "size": 5, // hinter dem Wert',
    '  "query": { /* Block */ "match_all": {} },',
    '  /* mehrzeiliger',
    '     Block */',
    '  "sort": ["_doc"] // am Ende',
    '}',
  ].join('\n');
  const out = formatiert(vorher);
  // Ist-Verhalten, vollständig festgehalten: ein Zeilenkommentar hinter einem Wert rutscht in die nächste Zeile (das Komma bleibt vorn),
  // ein Blockkommentar klebt ohne Leerzeichen am folgenden Schlüssel, ein Kommentar hinter „]“ am „]“ – unschön, aber ohne Verlust an Text und Werten
  assert.equal(
    out,
    [
      'GET kunden/_search',
      '{',
      '  // Kopfkommentar',
      '  "size": 5,',
      '  // hinter dem Wert',
      '  "query": {',
      '    /* Block */"match_all": {}',
      '  },',
      '  /* mehrzeiliger',
      '     Block */"sort": [',
      '    "_doc"',
      '  ]// am Ende',
      '}',
    ].join('\n'),
  );
  const kommentare = (s: string) => s.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g);
  assert.deepEqual(kommentare(out), ['// Kopfkommentar', '// hinter dem Wert', '/* Block */', '/* mehrzeiliger\n     Block */', '// am Ende']);
  assert.deepEqual(kommentare(out), kommentare(vorher));
  // ohne die Kommentare ist es derselbe JSON-Body wie vorher
  assert.deepEqual(JSON.parse(kibanaToJson(bodyOf(out))), { size: 5, query: { match_all: {} }, sort: ['_doc'] });
  assert.equal(parseRequest(out).body, '{"size":5,"query":{"match_all":{}},"sort":["_doc"]}');
  // Zeichen, die wie Kommentare aussehen, gehören in Zeichenketten zum Wert
  assert.equal(formatRequest('GET k/_search\n{"u":"http://x/y","c":"/* nein */"} '), 'GET k/_search\n{\n  "u": "http://x/y",\n  "c": "/* nein */"\n}');
});

test('F292: formatRequest – Kibana-""" bleibt """ (Umbrüche, Anführungszeichen, // und Klammern im Text); parseRequest macht daraus dieselbe JSON-Zeichenkette', () => {
  const vorher = 'GET kunden/_search\n{"query":{"query_string":{"query":"""ort:"Bern"\n  AND // kein Kommentar\n  {x} [y] "z" """},"size":1}}';
  const out = formatiert(vorher);
  assert.equal(
    out,
    [
      'GET kunden/_search',
      '{',
      '  "query": {',
      '    "query_string": {',
      '      "query": """ort:"Bern"',
      '  AND // kein Kommentar',
      '  {x} [y] "z" """',
      '    },',
      '    "size": 1',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(JSON.parse(parseRequest(out).body!).query.query_string.query, 'ort:"Bern"\n  AND // kein Kommentar\n  {x} [y] "z" ');
  // als NDJSON bleibt es in einer Zeile und dreifach in Anführungszeichen
  const nd = formatiert('POST _msearch\n{}\n{ "query" : { "query_string" : { "query" : """a "b" c""" } } }');
  assert.equal(nd, 'POST _msearch\n{}\n{"query":{"query_string":{"query":"""a "b" c"""}}}');
  assert.equal(parseRequest(nd).body, '{}\n{"query":{"query_string":{"query":"a \\"b\\" c"}}}\n');
});

test('F292: formatRequest – NDJSON: _bulk, _msearch und mehrere Werte je Zeile, ohne abschließenden Umbruch', () => {
  const bulk = formatiert(
    'POST _bulk?refresh=true\n{ "index" : { "_index" : "kunden", "_id" : "1" } }\n{ "name" : "Müller",\n  "tags" : [ "a", "b" ] }\n{ "delete" : { "_index" : "kunden", "_id" : "2" } }\n\n',
  );
  assert.equal(bulk, 'POST _bulk?refresh=true\n{"index":{"_index":"kunden","_id":"1"}}\n{"name":"Müller","tags":["a","b"]}\n{"delete":{"_index":"kunden","_id":"2"}}');
  assert.equal(
    formatiert('POST kunden/_msearch\n{ }\n{ "query" : { "match_all" : { } } }\n{"index":"logs-*"}\n{"size":0}'),
    'POST kunden/_msearch\n{}\n{"query":{"match_all":{}}}\n{"index":"logs-*"}\n{"size":0}',
  );
  assert.equal(formatiert('POST _msearch/template\n{}\n{ "id" : "v1", "params" : { "ort" : "Bern" } }'), 'POST _msearch/template\n{}\n{"id":"v1","params":{"ort":"Bern"}}');
  // mehr als ein Wert ist auch ohne _bulk/_msearch NDJSON
  assert.equal(formatiert('GET kunden/_search\n{ "a" : 1 }\n{ "b" : 2 }'), 'GET kunden/_search\n{"a":1}\n{"b":2}');
});

test('F292: formatRequest – _bulk/_msearch mit nur einem Wert ist in jeder Schreibweise des Pfads NDJSON (ohne Schrägstrich davor wurde es mehrzeilig)', () => {
  for (const kopf of ['POST _bulk', 'POST /_bulk', 'POST kunden/_bulk', 'POST _bulk?refresh=true', 'POST _msearch', 'POST kunden,logs-*/_msearch?max_concurrent_searches=2', 'POST\t_bulk']) {
    const text = `${kopf}\n{ "delete" : { "_id" : "1" } }`;
    assert.equal(formatiert(text), `${kopf}\n{"delete":{"_id":"1"}}`, kopf);
    assert.equal(parseRequest(text).ndjson, true, `${kopf}: parseRequest liest es als NDJSON`);
  }
  // Pfade, die nur ähnlich heißen, sind kein NDJSON – auch nicht, wenn _bulk/_msearch erst im Query-String steht (formatRequest und parseRequest sehen nur den Pfad vor dem ?)
  for (const kopf of ['POST bulk/_search', 'POST kunden/_bulk_x', 'POST _msearchx', 'GET kunden/_search?x=_bulk', 'GET k/_search?x=/_bulk', 'GET k/_search?x=/_msearch/y', 'GET k/_search?x=a%20b&z=/_bulk']) {
    assert.equal(formatiert(`${kopf}\n{"a":1}`), `${kopf}\n{\n  "a": 1\n}`, kopf);
    assert.equal(parseRequest(`${kopf}\n{"a":1}`).ndjson, false, `${kopf}: parseRequest liest es nicht als NDJSON`);
  }
  // …und umgekehrt: steht _bulk im Pfad, ändert ein Query-String mit anderen Pfaden daran nichts
  assert.equal(formatiert('POST _bulk?pipeline=a/_search\n{ "delete" : { "_id" : "1" } }'), 'POST _bulk?pipeline=a/_search\n{"delete":{"_id":"1"}}');
});

test('F292: formatRequest – ein Zeilenkommentar mit „*/“ im NDJSON bricht den Blockkommentar nicht vorzeitig ab', () => {
  // im NDJSON wird // zu /* … */ (alles in einer Zeile) – ein „*/“ im Text ließ vorher Reste im JSON stehen und machte die Anfrage ungültig
  const out = formatiert('POST _bulk\n{"index":{ // alt: /* x */ y\n "_id":"1"}}\n{"a":1}');
  assert.equal(out, 'POST _bulk\n{"index":{/* alt: /* x * / y */"_id":"1"}}\n{"a":1}');
  assert.equal(parseRequest(out).body, '{"index":{"_id":"1"}}\n{"a":1}\n');
  assert.equal(formatiert('POST _msearch\n{"index":"x" // Ende */\n}\n{"size":1}'), 'POST _msearch\n{"index":"x"/* Ende * / */}\n{"size":1}');
  // ohne „*/“ bleibt der Kommentartext, wie er ist
  assert.equal(formatiert('POST _msearch\n{"index":"x" // nur Text\n}\n{"size":1}'), 'POST _msearch\n{"index":"x"/* nur Text */}\n{"size":1}');
});

test('F292: formatRequest – leere Objekte und Arrays bleiben in einer Zeile, auch mit Leerraum dazwischen', () => {
  const out = formatiert('GET k/_search\n{"a":{},"b":[],"c":[{}],"d":{"e":[[]]},"f":{ },"g":[\n ],"h":{\t\n}}');
  assert.equal(
    out,
    ['GET k/_search', '{', '  "a": {},', '  "b": [],', '  "c": [', '    {}', '  ],', '  "d": {', '    "e": [', '      []', '    ]', '  },', '  "f": {},', '  "g": [],', '  "h": {}', '}'].join('\n'),
  );
  assert.equal(formatiert('GET k/_search\n{ }'), 'GET k/_search\n{}');
  assert.equal(formatiert('GET k/_search\n[ ]'), 'GET k/_search\n[]');
  assert.equal(formatiert('GET k/_search\n{ /* leer */ }'), 'GET k/_search\n{\n  /* leer */\n}');
  assert.equal(formatiert('POST _bulk\n{}\n{ }\n[ ]'), 'POST _bulk\n{}\n{}\n[]');
});

test('F292: formatRequest – Windows-Zeilenenden: Ausgabe mit \\n, der Text in """ bleibt wie er ist', () => {
  const vorher = 'GET k/_search\r\n{\r\n  // Kommentar\r\n  "a": 1,\r\n  "b": """x\r\ny"""\r\n}\r\n';
  const out = formatiert(vorher);
  assert.equal(out, 'GET k/_search\n{\n  // Kommentar\n  "a": 1,\n  "b": """x\r\ny"""\n}');
  assert.equal(JSON.parse(parseRequest(out).body!).b, 'x\r\ny');
  assert.equal(formatRequest('POST _bulk\r\n{"index":{}}\r\n{"a":1}\r\n'), 'POST _bulk\n{"index":{}}\n{"a":1}');
});

test('F292: formatRequest – nur Kopfzeile, Fehler bei offenem Body, Text nach dem JSON und mehreren Anfragen', () => {
  assert.equal(formatRequest('  GET _cat/indices?v  \n\n'), 'GET _cat/indices?v');
  assert.equal(formatRequest('GET _cluster/health'), 'GET _cluster/health');
  assert.throws(() => formatRequest('GET a/_search\n{"query": {'), /nicht geschlossen/);
  assert.throws(() => formatRequest('GET a/_search\n{"q":1}\nnoch Text'), /noch Text: „noch Text“/);
  // formatRequest nimmt genau eine Anfrage – mehrere zerlegt vorher splitEs (siehe nächster Test)
  assert.throws(() => formatRequest('GET a/_search\n{"q":1}\nGET b/_count'), /noch Text: „GET b\/_count“/);
});

/**
 * Spiegel von formatSql in ui/src/app/editor/format.ts für Elasticsearch, nur ohne SQL-Formatierer (sql-formatter liegt in der UI): Konsolen-Anfragen
 * formatieren, eine nicht lesbare bleibt unverändert und wird gezählt, alles dazwischen und SQL bleibt. Ändert sich format.ts, hier mitziehen.
 */
function formatAlle(text: string): { text: string; skipped: number } {
  let out = '';
  let pos = 0;
  let skipped = 0;
  for (const st of splitEs(text)) {
    const between = text.slice(pos, st.start);
    out += pos > 0 && !between.includes('\n') ? between.trimEnd() + '\n' : between;
    let formatted = st.sql;
    if (isConsoleRequest(st.sql)) {
      try {
        formatted = formatRequest(st.sql);
      } catch {
        skipped++;
      }
    }
    out += formatted;
    pos = st.end;
  }
  return { text: out + text.slice(pos), skipped };
}

test('F292: mehrere Anfragen und SQL in einem Text – jede Anfrage wird für sich formatiert, der Rest bleibt', () => {
  const vorher = [
    '# Vorbereitung',
    'GET kunden/_search',
    '{"query":{"match":{"ort":"Bern; Thun"}}}',
    '',
    'SELECT * FROM "kunden" LIMIT 5;',
    'POST _msearch',
    '{"index":"kunden"}',
    '{"size":1}',
    '{"index":"logs-*"}',
    '{"size":2}',
    '',
    'GET _cat/indices?v',
    'POST _bulk',
    '{"delete":{"_id":"1"}}',
  ].join('\n');
  const { text: nachher, skipped } = formatAlle(vorher);
  assert.equal(skipped, 0);
  assert.equal(
    nachher,
    [
      '# Vorbereitung',
      'GET kunden/_search',
      '{',
      '  "query": {',
      '    "match": {',
      '      "ort": "Bern; Thun"',
      '    }',
      '  }',
      '}',
      '',
      'SELECT * FROM "kunden" LIMIT 5;',
      'POST _msearch',
      '{"index":"kunden"}',
      '{"size":1}',
      '{"index":"logs-*"}',
      '{"size":2}',
      '',
      'GET _cat/indices?v',
      'POST _bulk',
      '{"delete":{"_id":"1"}}',
    ].join('\n'),
  );
  assert.deepEqual(formatAlle(nachher), { text: nachher, skipped: 0 }, 'idempotent');
  // dieselben Anfragen vorher und nachher, in gleicher Reihenfolge und mit gleichem Inhalt
  const vor = splitEs(vorher);
  const nach = splitEs(nachher);
  assert.equal(vor.length, 5);
  assert.equal(nach.length, 5);
  vor.forEach((st, k) => {
    if (isConsoleRequest(st.sql)) assert.deepEqual(parseRequest(nach[k].sql), parseRequest(st.sql), `Anfrage ${k + 1}`);
    else assert.equal(nach[k].sql, st.sql, `SQL ${k + 1}`);
  });
});

test('F292: eine nicht lesbare Anfrage (offener Body) bleibt unverändert und wird gezählt – die Nachbarn werden trotzdem formatiert', () => {
  const vorher = ['GET a/_search', '{"q":{"match_all":{}}}', '', 'GET b/_search', '{"query": {', '', 'GET c/_count', '{"x":[1,2]}'].join('\n');
  const { text, skipped } = formatAlle(vorher);
  assert.equal(skipped, 1);
  assert.equal(
    text,
    ['GET a/_search', '{', '  "q": {', '    "match_all": {}', '  }', '}', '', 'GET b/_search', '{"query": {', '', 'GET c/_count', '{', '  "x": [', '    1,', '    2', '  ]', '}'].join('\n'),
  );
  // ein zweiter Durchgang ändert nichts und zählt dieselbe Anfrage wieder
  assert.deepEqual(formatAlle(text), { text, skipped: 1 });
  assert.throws(() => formatRequest('GET b/_search\n{"query": {'), /nicht geschlossen/);
});

// ---------- F292: Nur-lesen-Prüfung für Index-Listen, Wildcards, _all, Suchvorlagen und asynchrone Suchen ----------

/** abgelehnt, und zwar mit der Nur-lesen-Meldung zu genau dieser Anfrage – nicht mit der Pfad-Meldung und nicht mit irgendeinem anderen Fehler */
const nein = (method: string, path: string, body?: string) => {
  const v = esReadOnlyViolation(method, path, body);
  assert.ok(v, `${method} ${path} müsste abgelehnt werden`);
  assert.ok(v!.startsWith(`Nur lesen: „${method} ${path}“ würde Elasticsearch ändern`), `Meldung zu ${method} ${path}: ${v}`);
};
/** abgelehnt von der Pfad-Prüfung (./, ../, //, ;, kodierte Schrägstriche, fehlerhafte %-Kodierung), mit der Meldung zu genau diesem Pfad */
const neinPfad = (method: string, path: string) => {
  const v = esReadOnlyViolation(method, path);
  assert.ok(v, `${method} ${path} müsste abgelehnt werden`);
  assert.ok(v!.startsWith(`Ungültiger Pfad „${path}“`), `Meldung zu ${method} ${path}: ${v}`);
};

test('F292: Index-Listen, Wildcards und _all als Ziel – Lesen erlaubt, das schreibende Gegenstück abgelehnt', () => {
  for (const p of [
    '_all/_search',
    'kunden,logs-*/_search',
    'logs-*/_search',
    '*/_search',
    '*,-logs-*/_search',
    '/kunden,logs-*/_search?size=0&filter_path=hits/hits',
    'remote:kunden,logs-*/_search',
    '*:kunden/_search',
    '_all/_count',
    'kunden,logs-*/_count',
    '_all/_field_caps?fields=*',
    'kunden,logs-*/_msearch',
    'logs-*/_validate/query',
    '_all/_mget',
    'kunden,logs-*/_pit?keep_alive=1m',
    'logs-*/_eql/search',
    // _all am Anfang oder mitten in der Liste ist ebenso ein Ziel
    '_all,kunden/_search',
    '_all,-logs-*/_count',
    'kunden,_all/_search',
  ])
    ok('POST', p);
  for (const p of ['_all', '_all/_settings', 'kunden,logs-*', 'logs-*/_mapping', '*/_stats', '_all/_search?q=ort:Bern', '_all,kunden/_settings']) ok('GET', p);
  ok('HEAD', 'logs-*');
  for (const p of [
    '_all/_delete_by_query',
    '_all/_update_by_query',
    'kunden,logs-*/_update_by_query',
    'logs-*/_delete_by_query?conflicts=proceed',
    '_all/_bulk',
    'kunden,logs-*/_bulk',
    '_all/_doc',
    'kunden,logs-*/_doc/1',
    'logs-*/_refresh',
    '_all/_close',
    'logs-*/_forcemerge',
    '_all',
    'logs-*',
    '*',
    'kunden,logs-*',
    '_all,kunden/_delete_by_query',
    '_all,kunden/_doc/1',
    '_all,kunden',
    // nur genau _all (oder _all, am Anfang einer Liste) ist ein Ziel – „_allx“ ist ein unbekannter Endpunkt
    '_allx/_search',
  ])
    nein('POST', p);
  for (const p of ['_all/_doc/1', '_all/_settings', 'logs-*/_mapping', 'kunden,logs-*/_doc', '_all,kunden/_settings']) nein('PUT', p);
  for (const p of ['_all', 'logs-*', 'kunden,logs-*', '*', 'logs-*/_doc/1', '_all,kunden']) nein('DELETE', p);
  // GET/HEAD, die etwas ändern, bleiben auch mit Index-Liste oder Platzhalter abgelehnt – auch wenn _all die Liste anführt
  for (const p of ['_all/_refresh', 'logs-*/_flush', 'kunden,logs-*/_forcemerge', 'logs-*/_cache/clear', '*/_close', '_all/_open', '_all,kunden/_refresh', 'kunden,_all/_refresh'])
    nein('GET', p);
  nein('HEAD', '_all/_refresh');
  nein('HEAD', '_all,-logs/_flush');
  // was hinter dem ? steht, ist kein Endpunkt
  ok('POST', 'kunden/_search?x=/_doc/1');
  nein('POST', 'kunden/_doc?routing=_search');
});

test('F292: %-kodierte Zeichen – für GET/HEAD zählt auch der aufgelöste Endpunkt, POST/DELETE lesen den Pfad wie er dasteht, kodierte Schrägstriche und Punkte sind ungültig', () => {
  // Elasticsearch bzw. ein Proxy davor kann %XX auflösen: „_%72efresh“ und „%5Frefresh“ sind dann „_refresh“
  for (const p of ['kunden/_%72efresh', 'kunden/%5Frefresh', 'kunden/%5frefresh', 'kunden/_%66lush', '_all%2Ckunden/_refresh', '_all%2c-logs/_refresh', 'kunden/_refresh%3Fx', 'kunden/_refresh%23x'])
    nein('GET', p);
  nein('HEAD', 'kunden/_%72efresh');
  // wer kodiert, kommt in der Positivliste nicht weiter (auch nicht zum erlaubten Endpunkt)
  nein('POST', 'kunden/%5Fsearch');
  nein('POST', 'kunden/_%64oc');
  nein('POST', '_all%2Ckunden/_search');
  nein('DELETE', '%5Fpit');
  // echte Kodierung (Umlaute, Leerzeichen in einer Dokument-ID, im Query-String) bleibt lesbar
  ok('GET', 'kunden/_doc/M%C3%BCller');
  ok('GET', 'kunden/_doc/a%20b');
  ok('GET', 'kunden/_search?q=ort:B%C3%A4rn&x=100%');
  ok('POST', 'kunden/_explain/a%20b');
  // Pfad-Prüfung: kodierte Schrägstriche, Backslashes, Punkte, Strichpunkte – auch zweimal kodiert – und eine kaputte Kodierung
  for (const p of ['kunden%2F_doc', 'kunden%5C_doc', 'kunden/%2e%2e/_doc', 'kunden/%252e%252e/_doc', 'kunden/%252f_doc', 'kunden/_search%3Bx=y', 'kunden/%3B', 'kunden/_doc/100%', 'kunden/_doc/%zz'])
    neinPfad('GET', p);
  neinPfad('POST', 'kunden/_search%2F..%2F_doc');
  neinPfad('DELETE', 'kunden/_doc/%E0%A4%A');
});

test('F292: Suchvorlagen und asynchrone Suchen – Suchen erlaubt, Vorlagen speichern/löschen und alles Schreibende abgelehnt', () => {
  const id = 'FmRldE8zREVEUzA2ZVpUeGs2ejJFUFEaMkZ5QTVrSTZSaVN3WlNFVmtlWHJsdzoxMDc=';
  for (const p of [
    '_search/template',
    'kunden/_search/template',
    'kunden,logs-*/_search/template?explain=true',
    '_all/_search/template',
    '_msearch/template',
    'logs-*/_msearch/template',
    '_render/template',
    '_async_search',
    'kunden/_async_search?wait_for_completion_timeout=1s',
    'kunden,logs-*/_async_search',
  ])
    ok('POST', p);
  ok('GET', `_async_search/${id}`);
  ok('GET', `_async_search/status/${id}`);
  // Entscheid F292: eine gespeicherte asynchrone Suche löschen ist Aufräumen wie DELETE _search/scroll und DELETE _pit – es gehen keine Daten verloren
  ok('DELETE', `_async_search/${id}`);
  ok('DELETE', '_search/scroll', `{"scroll_id":"${id}"}`);
  ok('DELETE', '_pit', `{"id":"${id}"}`);
  // …aber nur mit genau einer ID dahinter
  for (const p of ['_async_search', '_async_search/', `_async_search/${id}/extra`, '_async_search/_status', `_async_search/status/${id}`, 'kunden', 'kunden/_doc/1']) nein('DELETE', p);
  // Mit Index-Ziel davor lässt die Prüfung auch das Aufräumen durch (sie sieht nur den Endpunkt hinter dem Ziel). Elasticsearch hat dafür keine Route und
  // löscht nichts (am 08.10.2026 gegen 7.17 mit einem Dokument namens „scroll“ geprüft: 400 „Invalid type: expecting [_doc] but got [_search]“, das
  // Dokument blieb; 8.10 und 9.5: „no handler found“). Wer die Prüfung auf „DELETE nur ohne Index-Ziel“ verschärft, ändert diese Zeilen in nein(...).
  ok('DELETE', `kunden/_async_search/${id}`);
  ok('DELETE', 'kunden/_search/scroll', '{"scroll_id":"abc"}');
  nein('DELETE', 'kunden/_search/scroll', '{"scroll_id":"_all"}');
  for (const [m, p] of [
    ['PUT', `_async_search/${id}`],
    ['POST', `_async_search/${id}`],
    ['POST', `_async_search/status/${id}`],
    ['POST', '_async_search/_bulk'],
    ['POST', `kunden/_async_search/${id}/_bulk`],
    ['PUT', '_async_search'],
    ['PUT', '_search/template'],
    ['DELETE', '_search/template'],
    ['POST', '_search/template/_bulk'],
    ['POST', 'kunden/_search/template/_bulk'],
    ['POST', '_msearch/template/_bulk'],
    // eine Suchvorlage speichern oder löschen ändert den Cluster
    ['POST', '_scripts/meine-vorlage'],
    ['PUT', '_scripts/meine-vorlage'],
    ['DELETE', '_scripts/meine-vorlage'],
  ] as const)
    nein(m, p);
});

test('F292: Formatieren großer Bodys bleibt schnell (Glätten vor schließenden Klammern war quadratisch)', () => {
  const body = (n: number) => '{"hits":[' + Array.from({ length: n }, (_, i) => `{"_id":"${i}","_source":{"name":"Kunde ${i}","ort":"Bern","tags":["a","b"],"n":${i}}}`).join(',') + ']}';
  const time = (n: number) => {
    const t0 = process.hrtime.bigint();
    const out = formatRequest('GET kunden/_search\n' + body(n));
    assert.equal(parseRequest(out).body, parseRequest('GET kunden/_search\n' + body(n)).body);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(200); // warmlaufen
  const small = time(1000);
  const large = time(4000);
  // 4-mal so viel Text darf nicht mehr als etwa 12-mal so lange dauern (quadratisch wären 16-mal und mehr; vorher 15 s für 2 000 Objekte)
  assert.ok(large < 3000, `4 000 Objekte: ${large.toFixed(0)} ms`);
  assert.ok(large < Math.max(12 * small, 200), `1 000 Objekte ${small.toFixed(1)} ms, 4 000 Objekte ${large.toFixed(1)} ms`);
});
