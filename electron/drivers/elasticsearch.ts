/*
 * Elasticsearch: Indizes und Data Streams als Tabellen, Aliase als Views, das Mapping als Spalten. Nur lesen
 * (Entscheid 07.10.2026). Eigener HTTP-Client ohne Bibliothek: die offiziellen Clients sind an eine Hauptversion
 * gebunden, OwlynDB soll aber 7.x bis 9.x gleich behandeln. Version wird beim Verbinden gelesen.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type {
  Cell,
  ColumnInfo,
  CompletionInfo,
  DbObject,
  ErModel,
  ObjectKind,
  QueryPlan,
  QueryResultSet,
  QueryRun,
  ResultColumn,
  RoutineInfo,
  SearchHit,
  ServerInfo,
  SortSpec,
  StatementInput,
  StatementOutcome,
  TableDataRequest,
  TableDataResult,
  TableInfo,
} from '../../shared/api-types';
import { esReadOnlyViolation, isConsoleRequest, parseRequest, type EsRequest } from '../../shared/es-console';
import { checkWhere, quoteIdent } from '../../shared/sql-util';
import { ABORTED, errorText, normalizeCell, STREAM_BATCH, type DriverConfig, type MetaDriver, type RowSink, type ServerSessions, type Session } from './common';

/** größte Antwort, die OwlynDB annimmt (eine Suche mit size 10 000 und großen Dokumenten kommt auf einige 10 MB) */
const MAX_RESPONSE = 256 * 1024 * 1024;
/** JSON-Anzeige im Abfrage-Tab höchstens so lang */
const MAX_TEXT = 20 * 1024 * 1024;
const NUMERIC = new Set(['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'token_count']);
const NOT_HERE = 'Für Elasticsearch gibt es das nicht – OwlynDB liest dort nur Indizes, Mappings und Dokumente.';
const READ_ONLY = 'Elasticsearch-Verbindungen sind in OwlynDB nur zum Lesen.';

interface EsResponse {
  status: number;
  contentType: string;
  text: string;
  /** Location-Kopf einer Umleitung */
  location?: string;
}

/** Nicht-ASCII-Zeichen im Pfad als UTF-8 prozentkodieren (Node lehnt sie ab, Latin-1 ginge als Einzelbyte hinaus); vorhandene %XX bleiben */
export function encodePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));
}

function redirectText(r: EsResponse): string {
  return `Umleitung (HTTP ${r.status})${r.location ? ` nach ${r.location}` : ''} – HTTPS bzw. Pfadpräfix der Verbindung prüfen.`;
}

/** ein Feld aus dem Mapping, Objekte aufgelöst (adresse.plz) */
export interface EsField {
  path: string;
  type: string;
  format?: string;
  /** Unterfelder (multi-fields), z. B. keyword */
  subfields: { name: string; type: string }[];
  /** index: false im Mapping */
  notIndexed?: boolean;
}

// ---------- HTTP ----------

/** JSON lesen; Ganzzahlen jenseits von 2^53 (lange IDs, unsigned_long) als Text, sonst würden sie verfälscht */
export function parseJson(text: string): unknown {
  const reviver = (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source) ? ctx.source : v;
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/** Meldung aus einer Fehlerantwort von Elasticsearch */
export function esErrorMessage(status: number, text: string): string {
  let j: { error?: unknown } | undefined;
  try {
    j = JSON.parse(text) as { error?: unknown };
  } catch {
    return `HTTP ${status}${text.trim() ? ': ' + text.trim().slice(0, 300) : ''}`;
  }
  const err = j?.error as
    | string
    | { type?: string; reason?: string; root_cause?: { reason?: string }[]; caused_by?: { reason?: string }; failed_shards?: { reason?: { reason?: string; caused_by?: { reason?: string } } }[] }
    | undefined;
  const prefix = status === 401 ? 'Anmeldung abgelehnt (401) – Benutzer/Passwort bzw. API-Key prüfen. ' : status === 403 ? 'Keine Berechtigung (403): ' : '';
  if (!err) return `${prefix}HTTP ${status}`;
  if (typeof err === 'string') return prefix + err;
  // „closed“ allein sagt nichts
  if (err.type === 'index_closed_exception' || err.root_cause?.some((x) => (x as { type?: string }).type === 'index_closed_exception')) {
    return 'Der Index ist geschlossen (index_closed_exception) – mit POST <index>/_open lässt er sich öffnen.';
  }
  let reason = err.reason ?? err.type ?? `HTTP ${status}`;
  // „all shards failed“ sagt nichts – der Grund steckt beim ersten Shard
  if (/all shards failed/i.test(reason)) {
    const shard = err.failed_shards?.[0]?.reason;
    reason = shard?.caused_by?.reason ?? shard?.reason ?? err.root_cause?.[0]?.reason ?? reason;
  }
  const m = /Result window is too large, from \+ size must be less than or equal to: \[(\d+)\]/.exec(reason);
  if (m) {
    return `Elasticsearch blättert höchstens bis Treffer ${Number(m[1]).toLocaleString('de-CH')} (index.max_result_window) – bitte mit Suche, WHERE oder Sortierung eingrenzen. Der Export holt trotzdem alles.`;
  }
  if (/Fielddata access on the _id field is disallowed/.test(reason)) return 'Nach _id kann Elasticsearch nicht sortieren – bitte eine andere Spalte wählen.';
  const caused = err.caused_by?.reason && err.caused_by.reason !== reason ? ` – ${err.caused_by.reason}` : '';
  return prefix + reason + caused;
}

export class EsClient {
  private agent: http.Agent;
  private readonly secure: boolean;
  private readonly auth?: string;
  /** Name für Zertifikatsprüfung, SNI und Host-Kopf: das eigentliche Ziel (über SSH ist host 127.0.0.1) */
  private readonly targetHost: string;
  private readonly targetPort: number;

  constructor(private cfg: DriverConfig) {
    this.secure = !!cfg.ssl;
    this.targetHost = cfg.target?.host ?? cfg.host;
    this.targetPort = cfg.target?.port ?? cfg.port;
    const name = cfg.servername || this.targetHost;
    if (this.secure) {
      const t = cfg.tls;
      this.agent = new https.Agent({
        keepAlive: true,
        maxSockets: 8,
        ca: t?.ca,
        cert: t?.cert,
        key: t?.key,
        passphrase: t?.passphrase,
        rejectUnauthorized: !!t?.verifyServer,
        servername: net.isIP(name) ? undefined : name,
        checkServerIdentity: t?.verifyHostname ? (_host, cert) => tls.checkServerIdentity(name, cert) : () => undefined,
      });
    } else {
      this.agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    }
    if (cfg.apiKey) {
      const k = cfg.password.trim();
      // „id:schlüssel“ wie aus der Antwort von _security/api_key – sonst schon Base64 („encoded“)
      if (k) this.auth = 'ApiKey ' + (k.includes(':') ? Buffer.from(k).toString('base64') : k);
    } else if (cfg.user) {
      this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    }
  }

  private netError(e: NodeJS.ErrnoException): Error {
    const where = `${this.targetHost}:${this.targetPort}`;
    const code = e.code ?? '';
    if (e.name === 'AbortError' || code === 'ABORT_ERR') return new Error('Abgebrochen.');
    if (code === 'ECONNREFUSED') return new Error(`Keine Verbindung zu ${where} (ECONNREFUSED) – läuft Elasticsearch dort?`);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`Server „${this.targetHost}“ nicht gefunden (${code}).`);
    if (code === 'ETIMEDOUT') return new Error(`Zeitüberschreitung beim Verbinden mit ${where}.`);
    if (/SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED/.test(code)) {
      return new Error(`Serverzertifikat nicht vertrauenswürdig (${code}) – CA-Datei angeben oder die Prüfung des Serverzertifikats ausschalten.`);
    }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new Error(`Das Serverzertifikat passt nicht zum Namen „${this.cfg.servername || this.targetHost}“ – SNI-Name angeben oder die Prüfung des Hostnamens ausschalten.`);
    if (code === 'CERT_HAS_EXPIRED') return new Error('Das Serverzertifikat ist abgelaufen.');
    if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong version number|packet length too long/i.test(e.message)) {
      return new Error(`${where} spricht kein TLS – „HTTPS“ ausschalten?`);
    }
    if ((code === 'ECONNRESET' || /socket hang up/i.test(e.message)) && !this.secure) {
      return new Error(`${where} hat die Verbindung getrennt – erwartet der Server HTTPS? Dann „HTTPS“ einschalten.`);
    }
    return new Error(`${where}: ${e.message || code}`);
  }

  /** eine Anfrage; Pfad ohne führenden Schrägstrich. timeoutMs = Leerlauf-Zeit des Sockets (0 = keine) */
  request(method: string, path: string, body?: string, opts: { signal?: AbortSignal; ndjson?: boolean; timeoutMs?: number } = {}): Promise<EsResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: net.isIPv6(this.targetHost) ? `[${this.targetHost}]:${this.targetPort}` : `${this.targetHost}:${this.targetPort}` };
      if (this.auth) headers.authorization = this.auth;
      if (body !== undefined) {
        headers['content-type'] = opts.ndjson ? 'application/x-ndjson' : 'application/json';
        // selbst setzen: bei GET und DELETE schickt Node den Body sonst ohne Länge – Elasticsearch läse ihn als
        // Anfang der nächsten Anfrage auf derselben Verbindung
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      let settled = false;
      const req = (this.secure ? https : http).request(
        { host: this.cfg.host, port: this.cfg.port, method, path: '/' + encodePath(path.replace(/^\/+/, '')), agent: this.agent, headers, signal: opts.signal },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE) {
              settled = true;
              req.destroy();
              reject(new Error('Die Antwort ist größer als 256 MB – bitte mit size, _source oder einem Filter eingrenzen.'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              text: Buffer.concat(chunks).toString('utf8'),
              ...(res.headers.location ? { location: String(res.headers.location) } : {}),
            });
          });
          res.on('error', (e) => {
            if (settled) return;
            settled = true;
            reject(this.netError(e));
          });
        },
      );
      const timeout = opts.timeoutMs ?? 60_000;
      if (timeout > 0) req.setTimeout(timeout, () => req.destroy(Object.assign(new Error(`Keine Antwort innerhalb von ${timeout / 1000} s.`), { code: 'TIMEOUT' })));
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        reject(e.code === 'TIMEOUT' ? e : this.netError(e));
      });
      req.end(body);
    });
  }

  /** Anfrage mit JSON-Antwort; Fehlerantworten als Error mit der Meldung von Elasticsearch */
  async json<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const r = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body), opts);
    if (r.status >= 400) throw new EsHttpError(r.status, esErrorMessage(r.status, r.text));
    // Umleitung (Reverse-Proxy, HTTP→HTTPS): der Body wäre kein JSON, Status und Ziel sagen mehr
    if (r.status >= 300) throw new EsHttpError(r.status, redirectText(r));
    try {
      return parseJson(r.text) as T;
    } catch {
      throw new Error(`Antwort ist kein JSON: ${r.text.slice(0, 200)}`);
    }
  }

  close(): void {
    this.agent.destroy();
  }
}

export class EsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Mapping und Werte ----------

type MappingProps = Record<string, { type?: string; format?: string; index?: boolean; properties?: MappingProps; fields?: Record<string, { type?: string }> }>;

/** Mapping-Eigenschaften flach: Objekte aufgelöst, nested als ein Feld (Werte als JSON) */
export function flattenMapping(props: MappingProps | undefined, prefix = '', out: EsField[] = []): EsField[] {
  for (const [name, def] of Object.entries(props ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    const type = def.type ?? 'object';
    if (def.properties && type !== 'nested') {
      flattenMapping(def.properties, path, out);
      continue;
    }
    out.push({
      path,
      type,
      format: def.format,
      subfields: Object.entries(def.fields ?? {}).map(([k, v]) => ({ name: k, type: v.type ?? '?' })),
      notIndexed: def.index === false || undefined,
    });
  }
  return out;
}

/** Felder mehrerer Indizes (Alias, Data Stream) zusammenführen; abweichende Typen „long | keyword“ */
function mergeFields(lists: EsField[][]): EsField[] {
  const map = new Map<string, EsField>();
  for (const list of lists) {
    for (const f of list) {
      const have = map.get(f.path);
      if (!have) map.set(f.path, { ...f, subfields: [...f.subfields] });
      else if (!have.type.split(' | ').includes(f.type)) have.type += ' | ' + f.type;
    }
  }
  return [...map.values()];
}

/** Wert unter einem Feldpfad aus _source: flache Schlüssel („a.b“), Objekte und Listen von Objekten */
export function sourceValue(src: unknown, path: string): unknown {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return undefined;
  const o = src as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(o, path)) return o[path];
  for (let k = path.indexOf('.'); k >= 0; k = path.indexOf('.', k + 1)) {
    const head = path.slice(0, k);
    if (!Object.prototype.hasOwnProperty.call(o, head)) continue;
    const v = o[head];
    const rest = path.slice(k + 1);
    if (Array.isArray(v)) {
      const vals = v.map((x) => sourceValue(x, rest)).filter((x) => x !== undefined);
      if (vals.length) return vals.length === 1 && v.length === 1 ? vals[0] : vals;
    } else {
      const r = sourceValue(v, rest);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Zelle: Listen und Objekte als JSON */
export function esCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return normalizeCell(v);
}

/** alle Schlüssel eines Dokuments flach (Objekte aufgelöst, Listen als ein Wert) */
function flatKeys(o: unknown, prefix: string, out: Set<string>): void {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatKeys(v, key, out);
    else out.add(key);
  }
}

type Hit = { _index?: string; _id?: string; _score?: number | null; _source?: unknown; fields?: Record<string, unknown>; sort?: unknown[] };
type Set0 = Omit<QueryResultSet, 'statementIndex'>;

const col = (name: string, typeName: string, numeric = false): ResultColumn => ({ name, typeName, numeric });

/** Treffer einer Suche als Tabelle: _index, _id, _score, dann die Felder aus _source (bzw. fields) */
export function hitsTable(hits: Hit[], maxRows: number): Set0 {
  const keys = new Set<string>();
  const useFields = hits.length > 0 && hits.every((h) => h._source === undefined && h.fields);
  for (const h of hits) {
    if (useFields) for (const k of Object.keys(h.fields ?? {})) keys.add(k);
    else flatKeys(h._source, '', keys);
  }
  const withScore = hits.some((h) => typeof h._score === 'number');
  const fieldCols = [...keys];
  const columns = [col('_index', 'keyword'), col('_id', 'keyword'), ...(withScore ? [col('_score', 'float', true)] : []), ...fieldCols.map((k) => col(k, ''))];
  const rows = hits.slice(0, maxRows).map((h) => {
    const vals = fieldCols.map((k) => {
      if (useFields) {
        const v = h.fields?.[k];
        return esCell(Array.isArray(v) && v.length === 1 ? v[0] : v);
      }
      return esCell(sourceValue(h._source, k));
    });
    return [esCell(h._index), esCell(h._id), ...(withScore ? [esCell(h._score)] : []), ...vals];
  });
  // Zahlen-Spalten erkennen (für Ausrichtung und Export)
  fieldCols.forEach((k, i) => {
    const idx = columns.length - fieldCols.length + i;
    const vals = rows.map((r) => r[idx]).filter((v) => v !== null);
    if (vals.length && vals.every((v) => typeof v === 'number')) columns[idx] = col(k, 'number', true);
  });
  return { columns, rows, truncated: hits.length > maxRows, label: 'Treffer' };
}

const BUCKET_META = new Set(['key', 'key_as_string', 'doc_count', 'from', 'from_as_string', 'to', 'to_as_string']);

/** Wert einer Unter-Aggregation in einer Bucket-Zeile */
function metricValue(x: unknown): Cell {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'object') return esCell(x);
  const o = x as Record<string, unknown>;
  if ('value' in o) return esCell(o.value_as_string ?? o.value);
  if ('doc_count' in o && !('buckets' in o)) return esCell(o.doc_count);
  return esCell(o);
}

/** Aggregationen als Tabellen: Buckets je Zeile (Schlüssel, Anzahl, Unter-Aggregationen), Kennzahlen als eine Zeile */
export function aggregationTables(aggs: Record<string, unknown>, maxRows: number): Set0[] {
  const out: Set0[] = [];
  for (const [name, raw] of Object.entries(aggs ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const label = `Aggregation ${name}`;
    if (a.buckets && typeof a.buckets === 'object') {
      // keyed: true liefert ein Objekt statt einer Liste
      const buckets: Record<string, unknown>[] = Array.isArray(a.buckets)
        ? (a.buckets as Record<string, unknown>[])
        : Object.entries(a.buckets as Record<string, Record<string, unknown>>).map(([k, b]) => ({ key: k, ...b }));
      const subs: string[] = [];
      for (const b of buckets) for (const k of Object.keys(b)) if (!BUCKET_META.has(k) && !subs.includes(k)) subs.push(k);
      const ranges = buckets.some((b) => 'from' in b || 'to' in b);
      const columns = [col('key', ''), col('doc_count', 'long', true), ...(ranges ? [col('from', ''), col('to', '')] : []), ...subs.map((s) => col(s, ''))];
      const rows = buckets.slice(0, maxRows).map((b) => [
        esCell(b.key_as_string ?? b.key),
        esCell(b.doc_count),
        ...(ranges ? [esCell(b.from_as_string ?? b.from), esCell(b.to_as_string ?? b.to)] : []),
        ...subs.map((s) => metricValue(b[s])),
      ]);
      subs.forEach((s, i) => {
        const idx = columns.length - subs.length + i;
        if (rows.length && rows.every((r) => r[idx] === null || typeof r[idx] === 'number')) columns[idx] = col(s, 'number', true);
      });
      out.push({ columns, rows, truncated: buckets.length > maxRows, label });
    } else if ('value' in a) {
      const v = esCell(a.value_as_string ?? a.value);
      out.push({ columns: [col(name, '', typeof v === 'number')], rows: [[v]], truncated: false, label });
    } else {
      // stats, extended_stats, percentiles, single-bucket (filter) …: eine Zeile mit allen Kennzahlen
      const flat: [string, Cell][] = [];
      for (const [k, v] of Object.entries(a)) {
        if (k === 'meta') continue;
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && k === 'values') {
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) flat.push([`${k}.${pk}`, esCell(pv)]);
        } else flat.push([k, metricValue(v)]);
      }
      if (flat.length) out.push({ columns: flat.map(([k, v]) => col(k, '', typeof v === 'number')), rows: [flat.map(([, v]) => v)], truncated: false, label });
    }
  }
  return out;
}

/** Liste von Objekten (z. B. _cat mit format=json) als Tabelle */
function objectListTable(list: Record<string, unknown>[], maxRows: number, label: string): Set0 {
  const keys: string[] = [];
  for (const o of list) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  return { columns: keys.map((k) => col(k, '')), rows: list.slice(0, maxRows).map((o) => keys.map((k) => esCell(o[k]))), truncated: list.length > maxRows, label };
}

function textSet(text: string, format: 'json' | 'text', label: string): Set0 {
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n… (gekürzt, ${Math.round(text.length / 1024 / 1024)} MB insgesamt)` : text;
  return { columns: [], rows: [], truncated: text.length > MAX_TEXT, label, text: t, textFormat: format };
}

/** Antwort einer Konsolen-Anfrage als Ergebnisse: Tabellen, wo es passt, dazu immer die Antwort selbst */
export function consoleResultSets(body: string, contentType: string, maxRows: number): { sets: Set0[]; note?: string } {
  if (!/json/i.test(contentType)) return { sets: [textSet(body, 'text', 'Antwort')] };
  let j: unknown;
  try {
    j = parseJson(body);
  } catch {
    return { sets: [textSet(body, 'text', 'Antwort')] };
  }
  const sets: Set0[] = [];
  let note: string | undefined;
  if (Array.isArray(j)) {
    if (j.length && j.every((x) => x && typeof x === 'object' && !Array.isArray(x))) sets.push(objectListTable(j as Record<string, unknown>[], maxRows, 'Tabelle'));
  } else if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    const hits = (o.hits as { hits?: Hit[]; total?: number | { value: number; relation: string } } | undefined) ?? undefined;
    if (hits && Array.isArray(hits.hits)) {
      // "size": 0 mit Aggregationen: die leere Treffer-Tabelle wäre nur Rauschen
      if (hits.hits.length || !o.aggregations) sets.push(hitsTable(hits.hits, maxRows));
      const t = hits.total;
      const total = typeof t === 'number' ? `${t}` : t ? `${t.relation === 'gte' ? 'mindestens ' : ''}${t.value}` : undefined;
      note = `${total !== undefined ? total + ' Treffer insgesamt, ' : ''}${hits.hits.length} geliefert${typeof o.took === 'number' ? `, Elasticsearch ${o.took} ms` : ''}`;
    }
    if (o.aggregations && typeof o.aggregations === 'object') sets.push(...aggregationTables(o.aggregations as Record<string, unknown>, maxRows));
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) sets.push(sqlTable(o as unknown as SqlPage, maxRows));
  }
  // Antwort wie geliefert (mit „pretty“ schon eingerückt, Zahlen exakt); nur einzeilige selbst einrücken
  sets.push(textSet(body.includes('\n') ? body.trimEnd() : JSON.stringify(j, null, 2), 'json', 'JSON'));
  return { sets, note };
}

interface SqlPage {
  columns?: { name: string; type: string }[];
  rows: unknown[][];
  cursor?: string;
}

function sqlColumns(cols: { name: string; type: string }[]): ResultColumn[] {
  return cols.map((c) => col(c.name, c.type, NUMERIC.has(c.type)));
}

function sqlTable(p: SqlPage, maxRows: number): Set0 {
  return { columns: sqlColumns(p.columns ?? []), rows: p.rows.slice(0, maxRows).map((r) => r.map(esCell)), truncated: p.rows.length > maxRows || !!p.cursor };
}

/** höchstens so viele keyword-Felder bekommen je Wort eine eigene wildcard-Abfrage ohne Groß/klein */
const SEARCH_KEYWORD_FIELDS = 50;

/**
 * Suchbegriff: Sonderzeichen maskiert, Wörter als Teilstück (*wort*) über query_string. Bei keyword-Feldern unterscheidet
 * das Groß und Kleinschreibung (kein Analyzer) – deshalb je Wort zusätzlich wildcard-Abfragen mit case_insensitive auf
 * den keyword-Feldern (auch den keyword-Unterfeldern von Textfeldern), wie LOWER(…) LIKE bei den anderen Treibern
 */
export function searchQuery(text: string, keywordFields: string[] = []): object | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  const esc = (w: string) => w.replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, (c) => '\\' + c);
  const kw = keywordFields.slice(0, SEARCH_KEYWORD_FIELDS);
  const perWord = (w: string): object => {
    const qs = { query_string: { query: `*${esc(w)}*`, lenient: true, analyze_wildcard: true, default_operator: 'AND' } };
    if (!kw.length) return qs;
    // * und ? im Wort wörtlich (wildcard kennt kein Maskieren mit Backslash für Zeichenklassen – nur diese beiden)
    const value = `*${w.replace(/[*?\\]/g, (c) => '\\' + c)}*`;
    return { bool: { should: [qs, ...kw.map((f) => ({ wildcard: { [f]: { value, case_insensitive: true } } }))], minimum_should_match: 1 } };
  };
  return words.length === 1 ? perWord(words[0]) : { bool: { must: words.map(perWord) } };
}

/** keyword-Felder samt keyword-Unterfeldern (name.keyword) – für die Suche ohne Groß/klein */
export function keywordFields(fields: EsField[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.type === 'keyword' || f.type === 'constant_keyword' || f.type === 'wildcard') out.push(f.path);
    for (const sub of f.subfields) if (sub.type === 'keyword' || sub.type === 'wildcard') out.push(`${f.path}.${sub.name}`);
  }
  return out;
}

function likeToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

const enc = (name: string) => encodeURIComponent(name);

// ---------- Treiber ----------

/** tiefes Blättern: Point-in-Time einer Suche und Merkpunkte (search_after je Position) */
interface DeepCursor {
  pit: string;
  used: number;
  marks: Map<number, unknown[]>;
  /** Treffer insgesamt – gezählt im selben Point-in-Time, damit „von hinten“ zum Datenstand passt */
  total: number;
  /** laufende walk()-Aufrufe: solange einer läuft, wird der Point-in-Time nicht geschlossen */
  active: number;
  /** zum Schließen vorgemerkt (Neu laden, Fehler), sobald kein Aufruf mehr läuft */
  stale?: boolean;
}

/** so lange bleibt ein Point-in-Time ohne Benutzung offen (Elasticsearch und eigener Merker) */
const PIT_KEEP_ALIVE = '2m';
/** Aufräumen (Scroll, PIT freigeben) wartet höchstens so lange – Trennen und Beenden sollen nicht an einem toten Cluster hängen */
const CLEANUP_TIMEOUT_MS = 3000;
const DEEP_TTL_MS = 100_000;
const DEEP_MAX = 8;

/**
 * Sortierung umdrehen (für die Seiten am Ende): Richtung tauschen, fehlende Werte bleiben am selben Ende; der mode
 * (min/max bei Listenfeldern) bleibt der der Vorwärtsrichtung – sonst sortierte die Rückrichtung nach einem anderen Wert
 */
function reverseSort(order: object[]): object[] {
  return order.map((o) => {
    const [field, spec] = Object.entries(o)[0] as [string, string | { order?: string; missing?: string; mode?: string }];
    const dir = (typeof spec === 'string' ? spec : spec.order) === 'desc' ? 'asc' : 'desc';
    // _score und _shard_doc kennen keinen mode; Feldsortierungen bringen ihn aus sort() mit und behalten ihn
    if (typeof spec === 'string') return { [field]: dir };
    return { [field]: { ...spec, order: dir, ...(spec.missing ? { missing: spec.missing === '_last' ? '_first' : '_last' } : {}) } };
  });
}

/** Antworten mit ausgefallenen Shards (roter Index) wären stillschweigend unvollständig */
function checkShards(r: { _shards?: { failed?: number; total?: number }; timed_out?: boolean }): void {
  const failed = r._shards?.failed ?? 0;
  if (failed > 0) throw new Error(`${failed} von ${r._shards?.total ?? '?'} Shards haben nicht geantwortet – das Ergebnis wäre unvollständig (Zustand des Index prüfen).`);
  if (r.timed_out) throw new Error('Die Suche hat die Zeitgrenze des Servers überschritten – das Ergebnis wäre unvollständig.');
}

/** Elasticsearch 7.x übergeht gefrorene Indizes (ignore_throttled=true als Vorgabe); 8 kennt den Parameter nicht mehr */
function withThrottled(path: string, major: number): string {
  if (major !== 7) return path;
  return path + (path.includes('?') ? '&' : '?') + 'ignore_throttled=false';
}

/** so lange gilt ein geholtes Mapping bzw. die Zuordnung Alias/Data Stream → Indizes (Objektsuche, Vervollständigung) */
const MAPPING_CACHE_MS = 30_000;
/** so viele Objekte bekommen in Objektsuche und Vervollständigung Felder */
const FIELD_OBJECTS = 500;

export class ElasticDriver implements MetaDriver {
  readonly client: EsClient;
  private info?: { version: string; cluster: string; major: number };
  private mappings = new Map<string, { at: number; fields: EsField[] }>();
  private windows = new Map<string, { at: number; window: number }>();
  private deep = new Map<string, Promise<DeepCursor>>();
  /** Mapping aller sichtbaren Indizes (Objektsuche, Vervollständigung), kurz zwischengespeichert */
  private allMappings?: { at: number; byIndex: Promise<Map<string, EsField[]>> };
  private members?: { at: number; of: Promise<Map<string, string[]>> };

  constructor(private cfg: DriverConfig) {
    this.client = new EsClient(cfg);
  }

  private async root(): Promise<{ version: string; cluster: string; major: number }> {
    if (this.info) return this.info;
    let r: { cluster_name?: string; version?: { number?: string; distribution?: string; build_flavor?: string } };
    try {
      r = await this.client.json('GET', '', undefined, { timeoutMs: 30_000 });
    } catch (e) {
      // GET / braucht das Cluster-Recht monitor; ohne das (nur Indexrechte) bzw. hinter einem Proxy, der / nicht kennt,
      // geht es ohne Name und Version weiter – Suchen auf den erlaubten Indizes funktionieren trotzdem
      if (e instanceof EsHttpError && (e.status === 403 || e.status === 404)) {
        this.info = { version: 'Elasticsearch (Version unbekannt – kein Recht auf GET /)', cluster: this.cfg.target?.host ?? this.cfg.host, major: 0 };
        return this.info;
      }
      throw e;
    }
    const number = r.version?.number ?? '?';
    const opensearch = r.version?.distribution === 'opensearch';
    const product = opensearch ? 'OpenSearch' : 'Elasticsearch';
    const major = parseInt(number, 10) || 0;
    const minor = Number(/^\d+\.(\d+)/.exec(number)?.[1] ?? 0);
    let version = `${product} ${number}${r.version?.build_flavor === 'oss' ? ' (OSS)' : ''}`;
    // gebaut und geprüft für Elasticsearch 7.17 bis 9.x: Blättern über max_result_window (Point-in-Time) ab 7.12, SQL nur in der Standard-Distribution
    if (opensearch) version += ' – nicht geprüft (OwlynDB ist für Elasticsearch 7.17 bis 9 gebaut; Blättern über 10 000 und SQL weichen ab)';
    else if (major < 7 || (major === 7 && minor < 12)) version += ' – nicht geprüft (ab 7.12: Blättern über 10 000 per Point-in-Time)';
    this.info = { version, cluster: r.cluster_name || 'elasticsearch', major };
    return this.info;
  }

  /** Hauptversion, 0 = unbekannt */
  private async major(): Promise<number> {
    return (await this.root().catch(() => ({ major: 0 }))).major;
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.root();
    return { version: `${r.version} · Cluster „${r.cluster}“`, currentDatabase: r.cluster };
  }

  /** eine Ebene „Datenbank“ wie bei MySQL: der Cluster */
  async listDatabases(): Promise<string[]> {
    return [(await this.root()).cluster];
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listObjects(): Promise<DbObject[]> {
    return this.objects(true);
  }

  /** Indizes, Data Streams, Aliase; counts = genaue Dokumentzahlen (eine Suche mehr – Suche und Vervollständigung brauchen sie nicht) */
  private async objects(counts: boolean): Promise<DbObject[]> {
    const [indices, aliases, streams, exact] = await Promise.all([
      // ohne versteckte Indizes (Data-Stream-Backing, Systemindizes)
      this.client
        .json<{ index: string; 'docs.count'?: string | null; status?: string }[]>('GET', '_cat/indices?format=json&h=index,docs.count,status&expand_wildcards=open,closed')
        .catch(async (e: unknown): Promise<{ index: string; 'docs.count'?: string | null; status?: string }[]> => {
          // _cat braucht das Recht monitor; mit view_index_metadata geht _resolve (ohne Dokumentzahl)
          if (!(e instanceof EsHttpError) || e.status !== 403) throw e;
          const r = await this.client.json<{ indices?: { name: string; attributes?: string[] }[] }>('GET', '_resolve/index/*?expand_wildcards=open,closed').catch(() => {
            throw new Error(`${e.message} – für die Indexliste braucht der Benutzer monitor oder view_index_metadata auf den Indizes.`);
          });
          return (r.indices ?? []).filter((i) => !i.attributes?.includes('hidden')).map((i) => ({ index: i.name, status: i.attributes?.includes('closed') ? 'close' : 'open' }));
        }),
      this.client.json<{ alias: string }[]>('GET', '_cat/aliases?format=json&h=alias').catch(() => []),
      this.client.json<{ data_streams?: { name: string; indices?: { index_name: string }[] }[] }>('GET', '_data_stream').catch(() => ({ data_streams: [] })),
      counts ? this.docCounts() : Promise.resolve(null),
    ]);
    const out: DbObject[] = [];
    const seen = new Set<string>();
    const add = (name: string, kind: ObjectKind, rows?: number) => {
      if (name.startsWith('.') || seen.has(name)) return;
      seen.add(name);
      out.push({ name, kind, rows });
    };
    for (const i of indices) {
      // _cat zählt verschachtelte (nested) Dokumente mit – die Suche nicht; geschlossene Indizes kennt nur _cat
      const cat = i['docs.count'] != null && i['docs.count'] !== '' ? Number(i['docs.count']) : undefined;
      add(i.index, 'table', exact ? (exact.get(i.index) ?? (i.status === 'close' ? cat : 0)) : cat);
    }
    for (const s of streams.data_streams ?? []) {
      add(s.name, 'table', exact ? (s.indices ?? []).reduce((n, x) => n + (exact.get(x.index_name) ?? 0), 0) : undefined);
    }
    for (const a of aliases) add(a.alias, 'view');
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Dokumente je Index, wie eine Suche sie zählt (ohne die verschachtelten, die _cat/indices mitzählt): eine Suche
   * ohne Treffer über alle Indizes mit Aggregation nach _index – billig, weil _index je Shard feststeht.
   * null = ging nicht (Rechte, Zeit), dann bleibt die Zahl aus _cat.
   */
  private async docCounts(): Promise<Map<string, number> | null> {
    try {
      const r = await this.client.json<{ aggregations?: { i?: { buckets?: { key: string; doc_count: number }[] } } }>(
        'POST',
        withThrottled('*/_search?ignore_unavailable=true&allow_no_indices=true&filter_path=aggregations', await this.major()),
        { size: 0, track_total_hits: false, aggs: { i: { terms: { field: '_index', size: 10_000 } } } },
        { timeoutMs: 10_000 },
      );
      const buckets = r.aggregations?.i?.buckets ?? [];
      // mehr Indizes als Buckets: fehlende wären fälschlich 0
      return buckets.length >= 10_000 ? null : new Map(buckets.map((b) => [b.key, b.doc_count]));
    } catch {
      return null;
    }
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return [];
  }

  async routineDdl(): Promise<string> {
    throw new Error(NOT_HERE);
  }

  /** Felder eines Index (bzw. aller Indizes hinter Alias/Data Stream); kurz zwischengespeichert fürs Blättern */
  async fields(name: string, fresh = false): Promise<EsField[]> {
    const c = this.mappings.get(name);
    if (c && !fresh && Date.now() - c.at < 30_000) return c.fields;
    let fields: EsField[];
    try {
      const r = await this.client.json<Record<string, { mappings?: { properties?: MappingProps } }>>('GET', `${enc(name)}/_mapping`);
      fields = mergeFields(Object.values(r).map((x) => flattenMapping(x.mappings?.properties)));
    } catch (e) {
      // das Mapping braucht view_index_metadata; mit nur read bleibt _field_caps (Typen ohne Format)
      if (!(e instanceof EsHttpError) || e.status !== 403) throw e;
      fields = fieldsFromCaps(await this.client.json('GET', `${enc(name)}/_field_caps?fields=*`));
    }
    this.mappings.set(name, { at: Date.now(), fields });
    return fields;
  }

  /** Mapping aller sichtbaren Indizes, einmal geholt und kurz behalten (Objektsuche tippt, Vervollständigung lädt oft) */
  private mappingsOfAll(): Promise<Map<string, EsField[]>> {
    if (!this.allMappings || Date.now() - this.allMappings.at > MAPPING_CACHE_MS) {
      const byIndex = this.client
        .json<Record<string, { mappings?: { properties?: MappingProps } }>>('GET', '_mapping?filter_path=*.mappings.properties', undefined, { timeoutMs: 30_000 })
        .then((all) => new Map(Object.entries(all).map(([k, m]) => [k, flattenMapping(m.mappings?.properties)])));
      byIndex.catch(() => (this.allMappings = undefined));
      this.allMappings = { at: Date.now(), byIndex };
    }
    return this.allMappings.byIndex;
  }

  /** Alias bzw. Data Stream → Indizes dahinter */
  private membership(): Promise<Map<string, string[]>> {
    if (!this.members || Date.now() - this.members.at > MAPPING_CACHE_MS) {
      const of = Promise.all([
        this.client.json<{ alias: string; index: string }[]>('GET', '_cat/aliases?format=json&h=alias,index').catch(() => []),
        this.client.json<{ data_streams?: { name: string; indices?: { index_name: string }[] }[] }>('GET', '_data_stream').catch(() => ({ data_streams: [] })),
      ]).then(([aliases, streams]) => {
        const m = new Map<string, string[]>();
        for (const a of aliases) m.set(a.alias, [...(m.get(a.alias) ?? []), a.index]);
        for (const d of streams.data_streams ?? []) m.set(d.name, (d.indices ?? []).map((x) => x.index_name));
        return m;
      });
      this.members = { at: Date.now(), of };
    }
    return this.members.of;
  }

  /** Felder eines Objekts aus dem Gesamt-Mapping: Index direkt, Alias und Data Stream über ihre Indizes */
  private fieldsFromAll(byIndex: Map<string, EsField[]>, members: Map<string, string[]>, name: string): EsField[] {
    const direct = byIndex.get(name);
    if (direct) return direct;
    return mergeFields((members.get(name) ?? []).map((i) => byIndex.get(i) ?? []));
  }

  async searchObjects(database: string | null, pattern: string, limit: number): Promise<SearchHit[]> {
    const re = likeToRegex(pattern);
    const db = database ?? (await this.root()).cluster;
    const objs = await this.objects(false);
    const hits: SearchHit[] = objs.filter((o) => re.test(o.name)).map((o) => ({ database: db, schema: '', kind: o.kind, name: o.name }));
    if (hits.length >= limit) return hits.slice(0, limit);
    // Felder: das Mapping aller Indizes (zwischengespeichert); ein Fehler (zu groß, Rechte) soll nicht wie „nichts gefunden“ aussehen
    const [byIndex, members] = await Promise.all([this.mappingsOfAll(), this.membership()]);
    for (const o of objs.slice(0, FIELD_OBJECTS)) {
      for (const f of this.fieldsFromAll(byIndex, members, o.name)) {
        if (!re.test(f.path)) continue;
        hits.push({ database: db, schema: '', kind: 'column', name: o.name, column: f.path, dataType: f.type, objectKind: o.kind });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  async describeTable(_database: string, _schema: string, name: string): Promise<TableInfo> {
    const fields = await this.fields(name, true);
    const columns: ColumnInfo[] = [
      { name: '_id', dataType: 'keyword', nullable: false, defaultValue: null, primaryKey: true, autoIncrement: false, comment: 'Dokument-ID' },
      ...fields.map((f) => ({
        name: f.path,
        dataType: f.type + (f.format ? ` (${f.format})` : ''),
        nullable: true,
        defaultValue: null,
        primaryKey: false,
        autoIncrement: false,
        comment:
          [f.subfields.length ? 'Unterfelder: ' + f.subfields.map((s) => `${f.path}.${s.name} (${s.type})`).join(', ') : '', f.notIndexed ? 'nicht durchsuchbar (index: false)' : '']
            .filter(Boolean)
            .join(' · ') || undefined,
      })),
    ];
    return { columns, indexes: [], foreignKeys: [], referencedBy: [] };
  }

  async erModel(): Promise<ErModel> {
    throw new Error(NOT_HERE);
  }

  /** Mapping, Einstellungen und Aliase, wie Elasticsearch sie liefert */
  async getDdl(_database: string, _schema: string, name: string): Promise<string> {
    const r = await this.client.json<unknown>('GET', enc(name));
    return JSON.stringify(r, null, 2);
  }

  /** WHERE (SQL von Elasticsearch, über _sql/translate) und Suche als Query DSL */
  private async query(index: string, req: TableDataRequest, fields?: EsField[]): Promise<object | undefined> {
    const must: object[] = [];
    const where = req.where?.trim();
    if (where) {
      const bad = checkWhere(where, 'elasticsearch');
      if (bad) throw new Error(bad);
      let r: { query?: object };
      try {
        r = await this.client.json('POST', '_sql/translate', { query: `SELECT * FROM ${quoteIdent('elasticsearch', index)} WHERE ${where}` });
      } catch (e) {
        // OSS-Distribution: _sql gibt es nicht („no handler found for uri …“)
        if (e instanceof EsHttpError && /no handler found|Incorrect HTTP method/i.test(e.message)) {
          throw new Error('Die WHERE-Bedingung braucht die SQL-Funktion von Elasticsearch (Standard-Distribution, nicht OSS) – die Suche links geht trotzdem.');
        }
        // „Found 1 problem / line 1:30:“ bezieht sich auf das zusammengesetzte SELECT, nicht auf das Eingabefeld
        throw new Error('WHERE: ' + errorText(e).replace(/^Found \d+ problems?\s*/, '').replace(/line \d+:\d+: /g, ''));
      }
      if (r.query) must.push(r.query);
    }
    const s = req.search ? searchQuery(req.search, keywordFields(fields ?? (await this.fields(index)))) : undefined;
    if (s) must.push(s);
    if (!must.length) return undefined;
    return must.length === 1 ? must[0] : { bool: { must } };
  }

  private sort(fields: EsField[], sort: SortSpec[]): object[] | undefined {
    if (!sort.length) return undefined;
    return sort.map((s) => {
      if (s.column === '_id') throw new Error('Nach _id kann Elasticsearch nicht sortieren – bitte eine andere Spalte wählen.');
      if (s.column === '_index') return { _index: { order: s.dir } };
      const f = fields.find((x) => x.path === s.column);
      let field = s.column;
      if (f && (f.type === 'text' || f.type.startsWith('text '))) {
        const kw = f.subfields.find((x) => x.type === 'keyword');
        if (!kw) throw new Error(`Nach „${f.path}“ lässt sich nicht sortieren: Textfeld ohne keyword-Unterfeld.`);
        field = `${f.path}.${kw.name}`;
      } else if (f && (f.type === 'object' || f.type === 'nested')) {
        throw new Error(`Nach „${f.path}“ lässt sich nicht sortieren (${f.type}).`);
      }
      // missing und mode ausdrücklich (sind ohnehin die Vorgabe): fürs Umdrehen beim tiefen Blättern, das denselben Wert nehmen muss
      return { [field]: { order: s.dir, mode: s.dir === 'desc' ? 'max' : 'min', unmapped_type: 'keyword', missing: '_last' } };
    });
  }

  /** Spalten der Tabellenansicht: _id, bei Aliasen _index, dann die Felder (ohne Feld-Aliase) */
  private tableColumns(fields: EsField[], view: boolean): { columns: ResultColumn[]; paths: string[] } {
    const paths = fields.filter((f) => f.type !== 'alias').map((f) => f.path);
    const type = new Map(fields.map((f) => [f.path, f.type]));
    return {
      paths,
      columns: [col('_id', 'keyword'), ...(view ? [col('_index', 'keyword')] : []), ...paths.map((p) => col(p, type.get(p) ?? '', NUMERIC.has(type.get(p) ?? '')))],
    };
  }

  private rowsOf(hits: Hit[], paths: string[], extra: string[], view: boolean): Cell[][] {
    return hits.map((h) => [esCell(h._id), ...(view ? [esCell(h._index)] : []), ...paths.map((p) => esCell(sourceValue(h._source, p))), ...extra.map((p) => esCell(sourceValue(h._source, p)))]);
  }

  /** Felder in _source, die das Mapping nicht kennt (dynamic: false) – hinten anhängen */
  private extraKeys(hits: Hit[], paths: string[]): string[] {
    const keys = new Set<string>();
    for (const h of hits) flatKeys(h._source, '', keys);
    const known = new Set(paths);
    // ein Feld, das im Mapping ein Pfad ist, in _source aber ein Objekt (geo_point {lat, lon}, range {gte, lte}, flattened …):
    // seine Teilschlüssel sind nichts Unbekanntes
    const underKnown = (k: string) => {
      for (let i = k.indexOf('.'); i > 0; i = k.indexOf('.', i + 1)) if (known.has(k.slice(0, i))) return true;
      return false;
    };
    // Listen von Objekten: Pfad im Mapping ist „liste.feld“, in _source „liste“
    return [...keys].filter((k) => !known.has(k) && !underKnown(k) && !paths.some((p) => p.startsWith(k + '.'))).sort();
  }

  async fetchTable(req: TableDataRequest): Promise<TableDataResult> {
    const t0 = performance.now();
    const index = req.object.name;
    const fields = await this.fields(index);
    const view = req.object.kind === 'view';
    const body: Record<string, unknown> = { from: req.offset, size: req.limit, track_total_hits: false };
    const q = await this.query(index, req, fields);
    if (q) body.query = q;
    const sort = this.sort(fields, req.sort);
    if (sort) body.sort = sort;
    const window = await this.resultWindow(index);
    let hits: Hit[];
    let note = '';
    if (req.offset + req.limit <= window) {
      // allow_partial_search_results=false: ausgefallene Shards sind ein Fehler, kein stilles Teilergebnis
      const r = await this.client.json<{ hits: { hits: Hit[] }; _shards?: { failed?: number; total?: number }; timed_out?: boolean }>('POST', await this.searchPath(index), body);
      checkShards(r);
      hits = r.hits.hits;
    } else {
      hits = await this.deepPage(index, q, sort, req.offset, req.limit, window);
      note = `# ab Treffer ${window.toLocaleString('de-CH')} blättert OwlynDB mit Point-in-Time und search_after – from/size geht dort nicht\n`;
    }
    const { columns, paths } = this.tableColumns(fields, view);
    const extra = this.extraKeys(hits, paths);
    return {
      columns: [...columns, ...extra.map((k) => col(k, ''))],
      rows: this.rowsOf(hits, paths, extra, view),
      // für „Als Abfrage“: dieselbe Suche als Anfrage im Abfrage-Tab (Name kodiert: ein + im Namen würde sonst zum Leerzeichen)
      sql: `${note}GET ${enc(index)}/_search\n${JSON.stringify(body, null, 2)}`,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  /** <index>/_search mit den Schaltern, die ein ehrliches Ergebnis erzwingen (ausgefallene Shards, gefrorene Indizes in 7.x) */
  private async searchPath(index: string, extra = ''): Promise<string> {
    return withThrottled(`${enc(index)}/_search?allow_partial_search_results=false${extra}`, await this.major());
  }

  /** index.max_result_window (bei Alias/Data Stream das kleinste der Indizes dahinter); kurz zwischengespeichert */
  private async resultWindow(index: string): Promise<number> {
    const c = this.windows.get(index);
    if (c && Date.now() - c.at < 60_000) return c.window;
    let window = 10_000;
    try {
      const r = await this.client.json<Record<string, { settings?: Record<string, string>; defaults?: Record<string, string> }>>(
        'GET',
        `${enc(index)}/_settings/index.max_result_window?include_defaults=true&flat_settings=true`,
      );
      const values = Object.values(r).map((x) => Number(x.settings?.['index.max_result_window'] ?? x.defaults?.['index.max_result_window'] ?? 10_000));
      if (values.length) window = Math.max(1, Math.min(...values));
    } catch {
      // ohne Rechte auf die Einstellungen: Vorgabe
    }
    this.windows.set(index, { at: Date.now(), window });
    return window;
  }

  /**
   * Seite jenseits von max_result_window: Point-in-Time (fester Stand der Daten) und search_after. Gesucht wird in
   * Schritten von höchstens window Treffern, die nur die Sortierwerte liefern; Merkpunkte je Position machen das
   * Weiter- und Zurückblättern billig. Liegt die Seite näher am Ende, läuft dasselbe mit umgedrehter Sortierung von
   * hinten. Reihenfolge wie bei from/size: Sortierung bzw. Relevanz, bei Gleichstand Shard und Dokument.
   */
  private async deepPage(index: string, query: object | undefined, sort: object[] | undefined, offset: number, limit: number, window: number): Promise<Hit[]> {
    const order = [...(sort ?? [{ _score: 'desc' }]), { _shard_doc: 'asc' }];
    // Gesamtzahl aus demselben Point-in-Time wie die Seite – ein _count daneben sähe neuere Daten als der Cursor
    const total = (await this.cursor(index, query, order)).total;
    if (offset >= total) return [];
    // näher am Ende: von hinten zählen (die letzte Seite kann kürzer sein)
    if (total - offset < offset) {
      const end = Math.min(total, offset + limit);
      const back = await this.walk(index, query, reverseSort(order), total - end, end - offset, window);
      return back.reverse();
    }
    return this.walk(index, query, order, offset, limit, window);
  }

  /**
   * Cursor einer Suche (Index, Filter, Sortierung): vorhandener, solange er benutzt wird, sonst ein neuer mit frischem
   * Point-in-Time. Das Promise liegt schon vor dem Öffnen in der Tabelle – gleichzeitige Erstaufrufe teilen sich so einen
   * Cursor, statt je einen Point-in-Time zu öffnen, von denen einer nie wieder geschlossen würde.
   */
  private async cursor(index: string, query: object | undefined, order: object[]): Promise<DeepCursor> {
    const key = JSON.stringify([index, query ?? null, order]);
    // kein await, solange es keinen Eintrag gibt: zwischen Prüfen und Eintragen darf kein zweiter Aufruf dazwischenkommen
    const existing = this.deep.get(key);
    const have = existing ? await existing.catch(() => undefined) : undefined;
    if (have && !have.stale && (have.active > 0 || Date.now() - have.used < DEEP_TTL_MS)) return have;
    if (have) this.dropDeep(key);
    const p = (async (): Promise<DeepCursor> => {
      const pit = await this.openPit(index);
      try {
        const body: Record<string, unknown> = { pit: { id: pit, keep_alive: PIT_KEEP_ALIVE }, size: 0, track_total_hits: true };
        if (query) body.query = query;
        // ohne ignore_throttled: mit Point-in-Time verträgt 7.x keine indicesOptions (der PIT bestimmt die Indizes)
        const r = await this.client.json<{ pit_id?: string; hits?: { total?: { value: number } }; _shards?: { failed?: number; total?: number } }>(
          'POST',
          '_search?filter_path=pit_id,hits.total,_shards',
          body,
        );
        checkShards(r);
        return { pit: r.pit_id ?? pit, used: Date.now(), marks: new Map([[0, []]]), total: r.hits?.total?.value ?? 0, active: 0 };
      } catch (e) {
        void this.client.json('DELETE', '_pit', { id: pit }).catch(() => undefined);
        throw e;
      }
    })();
    this.deep.set(key, p);
    p.catch(() => {
      if (this.deep.get(key) === p) this.deep.delete(key);
    });
    const c = await p;
    // nur die zuletzt benutzten Suchen behalten – keine, in der gerade geblättert wird
    const all = await Promise.all([...this.deep.entries()].map(async ([k, cp]) => [k, await cp.catch(() => undefined)] as const));
    const idle = all.filter(([, x]) => x && !x.active && x !== c).sort((a, b) => a[1]!.used - b[1]!.used);
    for (const [k] of idle.slice(0, Math.max(0, all.length - DEEP_MAX))) this.dropDeep(k);
    return c;
  }

  private async walk(index: string, query: object | undefined, order: object[], offset: number, limit: number, window: number, retry = true): Promise<Hit[]> {
    const key = JSON.stringify([index, query ?? null, order]);
    const cur = await this.cursor(index, query, order);
    cur.active++;
    cur.used = Date.now();
    try {
      let pos = 0;
      let after: unknown[] = [];
      for (const [p, a] of cur.marks) {
        if (p <= offset && p >= pos) {
          pos = p;
          after = a;
        }
      }
      const search = async (size: number, light: boolean): Promise<Hit[]> => {
        const body: Record<string, unknown> = { pit: { id: cur.pit, keep_alive: PIT_KEEP_ALIVE }, size, sort: order, track_total_hits: false };
        if (query) body.query = query;
        if (after.length) body.search_after = after;
        if (light) body._source = false;
        // nur die Sortierwerte: aus 10 000 Treffern werden so wenige Kilobyte
        const r = await this.client.json<{ pit_id?: string; hits?: { hits?: Hit[] }; _shards?: { failed?: number; total?: number } }>(
          'POST',
          light ? '_search?filter_path=pit_id,hits.hits.sort,_shards&allow_partial_search_results=false' : '_search?allow_partial_search_results=false',
          body,
        );
        checkShards(r);
        if (r.pit_id) cur.pit = r.pit_id;
        // benutzt = zuletzt gesucht, nicht zuletzt begonnen: ein langer Lauf wird nicht unter sich weggeräumt
        cur.used = Date.now();
        return r.hits?.hits ?? [];
      };
      while (pos < offset) {
        const step = Math.min(window, offset - pos);
        const hits = await search(step, true);
        if (!hits.length) return [];
        pos += hits.length;
        after = hits[hits.length - 1].sort ?? [];
        cur.marks.set(pos, after);
        if (hits.length < step) return [];
      }
      const page = await search(limit, false);
      if (page.length) cur.marks.set(offset + page.length, page[page.length - 1].sort ?? []);
      return page;
    } catch (e) {
      // Point-in-Time weg (Knoten neu gestartet, Shard umgezogen): Cursor verwerfen und einmal frisch beginnen
      if (retry && e instanceof EsHttpError && (e.status === 404 || e.status === 400)) {
        cur.stale = true;
        if (cur.active <= 1) this.dropDeep(key);
        return this.walk(index, query, order, offset, limit, window, false);
      }
      throw e;
    } finally {
      cur.active--;
      if (cur.stale && !cur.active) this.dropDeep(key);
    }
  }

  private async openPit(index: string): Promise<string> {
    try {
      return (await this.client.json<{ id: string }>('POST', `${enc(index)}/_pit?keep_alive=${PIT_KEEP_ALIVE}`)).id;
    } catch (e) {
      throw new Error(`Über Treffer ${(await this.resultWindow(index)).toLocaleString('de-CH')} hinaus blättert OwlynDB mit Point-in-Time (ab Elasticsearch 7.12) – das ging hier nicht: ${errorText(e)}`);
    }
  }

  /** Merkpunkte einer Suche verwerfen, Point-in-Time schließen (nebenher); läuft noch ein Aufruf, erst danach */
  private dropDeep(key: string): void {
    const p = this.deep.get(key);
    if (!p) return;
    this.deep.delete(key);
    void p.then(
      (c) => {
        if (c.active > 0) {
          c.stale = true;
          return;
        }
        void this.client.json('DELETE', '_pit', { id: c.pit }).catch(() => undefined);
      },
      () => undefined,
    );
  }

  async countTable(req: TableDataRequest): Promise<number> {
    // Neu laden bzw. neuer Filter: tiefes Blättern beginnt mit frischem Stand (ein laufender Aufruf behält seinen bis zum Ende)
    for (const key of [...this.deep.keys()]) if (JSON.parse(key)[0] === req.object.name) this.dropDeep(key);
    const q = await this.query(req.object.name, req);
    const r = await this.client.json<{ count: number; _shards?: { failed?: number; total?: number } }>(
      'POST',
      withThrottled(`${enc(req.object.name)}/_count`, await this.major()),
      q ? { query: q } : undefined,
    );
    checkShards(r);
    return r.count;
  }

  /** alle Treffer per Scroll (2000 je Abruf), danach Scroll freigeben; signal bricht die laufende Suche ab */
  async streamTable(req: TableDataRequest, sink: RowSink, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error(ABORTED);
    const index = req.object.name;
    const fields = await this.fields(index);
    const view = req.object.kind === 'view';
    const q = await this.query(index, req, fields);
    const body: Record<string, unknown> = { size: STREAM_BATCH, sort: this.sort(fields, req.sort) ?? ['_doc'] };
    if (q) body.query = q;
    type Page = { _scroll_id?: string; hits: { hits: Hit[] }; _shards?: { failed?: number; total?: number }; timed_out?: boolean };
    let r = await this.client.json<Page>('POST', await this.searchPath(index, '&scroll=2m'), body, { timeoutMs: 0, signal });
    // Scroll-Kennung sofort merken: scheitert das Anlegen der Datei, wird der Kontext trotzdem freigegeben
    const scrollIds = new Set<string>();
    if (r._scroll_id) scrollIds.add(r._scroll_id);
    try {
      checkShards(r);
      const { columns, paths } = this.tableColumns(fields, view);
      const extra = this.extraKeys(r.hits.hits, paths);
      await sink.begin([...columns, ...extra.map((k) => col(k, ''))]);
      // Spalten stehen fest: Schlüssel, die das Mapping nicht kennt und erst in späteren Stapeln auftauchen, fehlen – das wird gemeldet
      const headed = new Set([...paths, ...extra]);
      const missing = new Set<string>();
      let sent = 0;
      while (r.hits.hits.length) {
        if (r._scroll_id) scrollIds.add(r._scroll_id);
        let batch = this.rowsOf(r.hits.hits, paths, extra, view);
        if (req.top !== undefined && sent + batch.length > req.top) batch = batch.slice(0, req.top - sent);
        if (sent > 0) for (const k of this.extraKeys(r.hits.hits, [...headed])) missing.add(k);
        await sink.rows(batch);
        sent += batch.length;
        if ((req.top !== undefined && sent >= req.top) || !r._scroll_id) break;
        r = await this.client.json<Page>('POST', '_search/scroll', { scroll: '2m', scroll_id: r._scroll_id }, { timeoutMs: 0, signal });
        checkShards(r);
      }
      if (r._scroll_id) scrollIds.add(r._scroll_id);
      if (missing.size) {
        sink.note?.(`${missing.size} Feld(er) kamen erst nach den ersten ${STREAM_BATCH} Treffern vor und fehlen in der Datei (nicht im Mapping): ${[...missing].slice(0, 10).join(', ')}${missing.size > 10 ? ', …' : ''}.`);
      }
    } finally {
      // Aufräumen mit kurzer Frist: ein nicht mehr erreichbarer Cluster soll die Fehlermeldung nicht um 60 s verzögern
      if (scrollIds.size) await this.client.json('DELETE', '_search/scroll', { scroll_id: [...scrollIds] }, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async completionInfo(): Promise<CompletionInfo> {
    const objs = await this.objects(false).catch(() => [] as DbObject[]);
    const [byIndex, members] = await Promise.all([this.mappingsOfAll().catch(() => new Map<string, EsField[]>()), this.membership()]);
    // Aliase und Data Streams bekommen die Felder ihrer Indizes
    const tables = objs.slice(0, FIELD_OBJECTS).map((o) => ({ schema: '', name: o.name, kind: o.kind, columns: this.fieldsFromAll(byIndex, members, o.name).map((f) => f.path).slice(0, 1000) }));
    return { tables };
  }

  async openSession(database?: string): Promise<Session> {
    return new EsSession(this, database ?? (await this.root()).cluster);
  }

  async applyWrites(): Promise<number[]> {
    throw new Error(READ_ONLY);
  }

  async listServerSessions(): Promise<ServerSessions> {
    throw new Error(NOT_HERE);
  }

  async killServerSession(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async close(): Promise<void> {
    const cursors = await Promise.all([...this.deep.values()].map((p) => p.catch(() => undefined)));
    const pits = cursors.filter((c): c is DeepCursor => !!c).map((c) => c.pit);
    this.deep.clear();
    await Promise.all(pits.map((id) => this.client.json('DELETE', '_pit', { id }, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined)));
    this.client.close();
  }

  /** SQL über POST _sql: Seiten per Cursor bis maxRows, übriger Cursor wird geschlossen */
  async sql(statement: string, maxRows: number, signal: AbortSignal): Promise<Set0> {
    const fetch = Math.max(1, Math.min(maxRows, 1000));
    let page = await this.client.json<SqlPage>('POST', '_sql?format=json', { query: statement, fetch_size: fetch, field_multi_value_leniency: true }, { signal, timeoutMs: 0 });
    const columns = sqlColumns(page.columns ?? []);
    const rows: Cell[][] = page.rows.map((r) => r.map(esCell));
    try {
      while (page.cursor && rows.length < maxRows) {
        page = await this.client.json<SqlPage>('POST', '_sql?format=json', { cursor: page.cursor }, { signal, timeoutMs: 0 });
        rows.push(...page.rows.map((r) => r.map(esCell)));
      }
    } catch (e) {
      // Abbruch oder Fehler mitten im Blättern: den Cursor nicht offen lassen
      if (page.cursor) await this.client.json('POST', '_sql/close', { cursor: page.cursor }, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
      throw e;
    }
    if (page.cursor) await this.client.json('POST', '_sql/close', { cursor: page.cursor }).catch(() => undefined);
    return { columns, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows || !!page.cursor, label: 'SQL' };
  }

  /** SQL-Ergebnis vollständig (Export): Seite für Seite über den Cursor */
  async sqlStream(statement: string, sink: RowSink, signal: AbortSignal): Promise<void> {
    let page = await this.client.json<SqlPage>('POST', '_sql?format=json', { query: statement, fetch_size: 1000, field_multi_value_leniency: true }, { signal, timeoutMs: 0 });
    try {
      await sink.begin(sqlColumns(page.columns ?? []));
      for (;;) {
        if (page.rows.length) await sink.rows(page.rows.map((r) => r.map(esCell)));
        if (!page.cursor) return;
        page = await this.client.json<SqlPage>('POST', '_sql?format=json', { cursor: page.cursor }, { signal, timeoutMs: 0 });
      }
    } catch (e) {
      if (page.cursor) await this.client.json('POST', '_sql/close', { cursor: page.cursor }).catch(() => undefined);
      throw e;
    }
  }

  /** Anfrage aus der Konsole (schon geprüft: nur lesend) */
  async consoleRequest(req: EsRequest, maxRows: number, signal: AbortSignal): Promise<{ sets: Set0[]; note?: string }> {
    // eingerückte Antwort für die JSON-Ansicht (ändert an der Anfrage sonst nichts)
    const path = /[?&]pretty(=|&|$)/.test(req.path) ? req.path : req.path + (req.path.includes('?') ? '&' : '?') + 'pretty';
    const r = await this.client.request(req.method, path, req.body, { signal, ndjson: req.ndjson, timeoutMs: 0 });
    if (r.status >= 400) {
      // eine Antwort mit Inhalt, aber ohne Fehlerobjekt (GET idx/_doc/x → {found: false}) ist eine Antwort, kein Fehler
      if (req.method !== 'HEAD' && hasErrorObject(r.text)) throw new EsHttpError(r.status, esErrorMessage(r.status, r.text));
      if (req.method === 'HEAD' || !r.text.trim()) throw new EsHttpError(r.status, esErrorMessage(r.status, r.text));
      const out = consoleResultSets(r.text, r.contentType, maxRows);
      return { ...out, note: `HTTP ${r.status}${out.note ? ' · ' + out.note : ''}` };
    }
    if (r.status >= 300) throw new EsHttpError(r.status, redirectText(r));
    if (req.method === 'HEAD') return { sets: [], note: `HTTP ${r.status}` };
    return consoleResultSets(r.text, r.contentType, maxRows);
  }
}

/** Fehlerantwort von Elasticsearch (Objekt mit error) – im Gegensatz zu einer Antwort mit 404 und Inhalt */
function hasErrorObject(text: string): boolean {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return !!j && typeof j === 'object' && 'error' in j && j.error !== undefined;
  } catch {
    return true;
  }
}

/** Felder aus _field_caps (ohne Recht auf das Mapping): Unterfelder (name.keyword) zum Feld, Objekte selbst nicht */
export function fieldsFromCaps(caps: { fields?: Record<string, Record<string, { type?: string; metadata_field?: boolean }>> }): EsField[] {
  const entries = Object.entries(caps.fields ?? {}).filter(([k, v]) => !k.startsWith('_') && !Object.values(v).some((x) => x.metadata_field));
  const typeOf = new Map(entries.map(([k, v]) => [k, Object.keys(v).join(' | ')]));
  const out = new Map<string, EsField>();
  for (const [k, type] of typeOf) {
    if (type === 'object') continue;
    const dot = k.lastIndexOf('.');
    const parentType = dot > 0 ? typeOf.get(k.slice(0, dot)) : undefined;
    // Unterfeld eines Text-/keyword-Feldes
    if (parentType && parentType !== 'object' && parentType !== 'nested') continue;
    out.set(k, { path: k, type, subfields: [] });
  }
  for (const [k, type] of typeOf) {
    const dot = k.lastIndexOf('.');
    const parent = dot > 0 ? out.get(k.slice(0, dot)) : undefined;
    if (parent && parent.type !== 'nested') parent.subfields.push({ name: k.slice(dot + 1), type });
  }
  return [...out.values()];
}

/**
 * Abfrage-Tab auf Elasticsearch: zustandslos (HTTP), jede Anweisung ist eine Konsolen-Anfrage oder SQL. Vor dem
 * Ausführen wird alles auf „nur lesen“ geprüft – ist eine Anfrage schreibend, läuft keine.
 */
class EsSession implements Session {
  readonly inTransaction = false;
  readonly broken = false;
  lastSql?: string;
  private running = false;
  private abort?: AbortController;
  private cancelRequested = false;

  constructor(
    private driver: ElasticDriver,
    readonly database: string | undefined,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  /** immer nur lesen, unabhängig vom Schalter der Verbindung */
  get readOnly(): boolean {
    return true;
  }

  set readOnly(_v: boolean) {}

  async setDatabase(): Promise<void> {}

  async run(statements: StatementInput[], maxRows: number): Promise<QueryRun> {
    if (this.running) throw new Error('In diesem Tab läuft bereits eine Abfrage.');
    this.running = true;
    this.cancelRequested = false;
    const results: QueryResultSet[] = [];
    const outcomes: StatementOutcome[] = [];
    const messages: string[] = [];
    const t0 = performance.now();
    try {
      // erst alles prüfen: eine schreibende Anfrage, und nichts läuft
      for (let idx = 0; idx < statements.length; idx++) {
        const sql = statements[idx].sql;
        if (!isConsoleRequest(sql)) continue;
        const head = sql.trimStart().split('\n', 1)[0].trim().split(/\s+/);
        const why = esReadOnlyViolation(head[0], head[1] ?? '', sql);
        if (why) {
          outcomes.push({ statementIndex: idx, sql, durationMs: 0, resultSets: 0, error: why });
          return this.done(results, outcomes, messages, t0);
        }
      }
      for (let idx = 0; idx < statements.length; idx++) {
        if (this.cancelRequested) break;
        const st = statements[idx];
        this.lastSql = st.sql;
        this.abort = new AbortController();
        const s0 = performance.now();
        try {
          let sets: Set0[];
          if (isConsoleRequest(st.sql)) {
            const req = parseRequest(st.sql);
            const r = await this.driver.consoleRequest(req, maxRows, this.abort.signal);
            sets = r.sets;
            if (r.note) messages.push(`${req.method} ${req.path}: ${r.note}`);
          } else {
            sets = [await this.driver.sql(st.sql, maxRows, this.abort.signal)];
          }
          // mehrere Anweisungen: Reiter nach Anweisung nummerieren („2 · SQL“), sonst sind sie kaum zuzuordnen
          for (const set of sets) results.push({ statementIndex: idx, ...set, label: statements.length > 1 ? `${idx + 1} · ${set.label ?? 'Ergebnis'}` : set.label });
          outcomes.push({ statementIndex: idx, sql: st.sql, durationMs: Math.round(performance.now() - s0), resultSets: sets.length });
        } catch (e) {
          outcomes.push({ statementIndex: idx, sql: st.sql, durationMs: Math.round(performance.now() - s0), resultSets: 0, error: this.cancelRequested ? 'Abgebrochen.' : errorText(e) });
          break;
        }
      }
      return this.done(results, outcomes, messages, t0);
    } finally {
      this.abort = undefined;
      this.running = false;
    }
  }

  private done(results: QueryResultSet[], statements: StatementOutcome[], messages: string[], t0: number): QueryRun {
    return { results, statements, messages, currentDatabase: this.database, inTransaction: false, cancelled: this.cancelRequested, durationMs: Math.round(performance.now() - t0) };
  }

  async explain(): Promise<QueryPlan> {
    throw new Error('Für Elasticsearch gibt es keinen Ausführungsplan – "profile": true im Such-Body zeigt, wo die Zeit hingeht.');
  }

  /** Export über „max. Zeilen“ hinaus: nur SQL (bei Konsolen-Anfragen bestimmt "size" die Treffer) */
  async streamResult(statement: StatementInput, resultIndex: number, sink: RowSink): Promise<void> {
    if (isConsoleRequest(statement.sql) || resultIndex !== 0) {
      throw new Error('Erneut ausführen lässt sich hier nur SQL – bei Konsolen-Anfragen bestimmt "size" im Such-Body, wie viele Treffer kommen.');
    }
    if (this.running) throw new Error('In diesem Tab läuft bereits eine Abfrage.');
    this.running = true;
    this.cancelRequested = false;
    this.lastSql = statement.sql;
    this.abort = new AbortController();
    try {
      await this.driver.sqlStream(statement.sql, sink, this.abort.signal);
    } catch (e) {
      throw this.cancelRequested ? new Error('Abgebrochen.') : e;
    } finally {
      this.abort = undefined;
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelRequested = true;
    // Elasticsearch bricht die Suche ab, wenn der Client die Verbindung schließt
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.abort?.abort();
  }

  async ping(): Promise<void> {}

  async check(): Promise<boolean> {
    return true;
  }
}
