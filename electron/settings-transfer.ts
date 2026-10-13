/*
 * Einstellungen als eine JSON-Datei: Verbindungen (mit Farben, TLS-/SSH-Einstellungen), gespeicherte Abfragen, wahlweise
 * der Verlauf. Passwörter sind über Windows (DPAPI) an Benutzer und Rechner gebunden – sie gehen nur mit, wenn sie mit
 * einem Export-Passwort verschlüsselt werden (scrypt + AES-256-GCM). Zertifikats- und Schlüsseldateien nur als Pfad.
 * Import führt zusammen: gleiche Verbindung erkennen (ID, Name, Server) und nachfragen statt überschreiben.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  ConnectionOptions,
  Dialect,
  HistoryEntry,
  SavedConnection,
  SavedQuery,
  SettingsExportOptions,
  SettingsImportRequest,
  SettingsImportResult,
  SettingsPreview,
} from '../shared/api-types';
import type { ConnectionStore } from './connection-store';
import type { QueryHistory, SavedQueries } from './history';

const FORMAT = 'owlyndb-settings';
/** Kennung der Exporte aus der Zeit als „AtlasDB“ – der Import liest sie weiter, geschrieben wird nur FORMAT */
const LEGACY_FORMATS: readonly string[] = ['atlasdb-settings'];
const VERSION = 1;
/** Mindestlänge des Export-Passworts */
export const MIN_PASSWORD = 8;
/** Verbindungs-IDs vergibt OwlynDB als UUID */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExportedConnection = Omit<SavedConnection, 'hasPassword' | 'hasKeyPassphrase' | 'hasSshSecret'>;
interface Secrets {
  password?: string;
  keyPassphrase?: string;
  sshSecret?: string;
}
interface Sealed {
  /** an die Verbindungsdaten gebunden (AAD) */
  bound?: boolean;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}
interface SettingsFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  connections: ExportedConnection[];
  savedQueries?: SavedQuery[];
  history?: HistoryEntry[];
  /** Passwörter je Verbindungs-ID, verschlüsselt */
  secrets?: Sealed;
}

// ---------- Verschlüsselung ----------

const SCRYPT = { n: 1 << 15, r: 8, p: 1 };
/** höchstens das Vierfache der eigenen Arbeit (n·r·p) – eine manipulierte Datei soll den Hauptprozess nicht sekundenlang beschäftigen */
const MAX_SCRYPT_WORK = SCRYPT.n * SCRYPT.r * SCRYPT.p * 4;

/** asynchron (Thread-Pool): scryptSync hielte alle IPC-Aufrufe und Auftragsfortschritte an */
function deriveKey(password: string, salt: Buffer, s: { n: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, 32, { N: s.n, r: s.r, p: s.p, maxmem: 128 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

/**
 * Verschlüsseln; binding bindet die Nutzlast an die Verbindungsdaten der Datei (AAD): wer host, port oder user austauscht,
 * bekommt beim Import nicht das echte Passwort fürs fremde Ziel
 */
export async function seal(value: unknown, password: string, binding?: string): Promise<Sealed> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await deriveKey(password, salt, SCRYPT), iv);
  if (binding !== undefined) c.setAAD(Buffer.from(binding, 'utf8'));
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return {
    kdf: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    ...(binding !== undefined ? { bound: true } : {}),
  };
}

export async function unseal(s: Sealed, password: string, binding?: string): Promise<unknown> {
  // Grenzen, damit eine manipulierte Datei nicht beliebig viel Speicher oder Zeit verlangt
  if (s.kdf !== 'scrypt' || !(s.n >= 1024 && s.n <= 1 << 20) || !(s.r >= 1 && s.r <= 32) || !(s.p >= 1 && s.p <= 16) || s.n * s.r * s.p > MAX_SCRYPT_WORK) {
    throw new Error('Die verschlüsselten Passwörter in der Datei haben ein unbekanntes Format.');
  }
  const key = await deriveKey(password, Buffer.from(s.salt, 'base64'), s);
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
    if (s.bound && binding !== undefined) d.setAAD(Buffer.from(binding, 'utf8'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error(
      s.bound
        ? 'Das Export-Passwort passt nicht zu dieser Datei – oder die Verbindungsdaten in der Datei wurden verändert (dann werden die Passwörter nicht übernommen).'
        : 'Das Export-Passwort passt nicht zu dieser Datei.',
    );
  }
}

/** Verbindungsdaten, an die die Passwörter gebunden sind (Reihenfolge wie in der Datei) */
function bindingOf(connections: { id: string; dialect: string; host: string; port: number; user: string; options?: { sshHost?: string; sshUser?: string } }[]): string {
  return JSON.stringify(connections.map((c) => [c.id, c.dialect, c.host, c.port, c.user, c.options?.sshHost ?? '', c.options?.sshUser ?? '']));
}

// ---------- Datei prüfen (sie kann von Hand geändert sein) ----------

const DIALECTS = new Set<Dialect>(['mysql', 'mssql', 'postgres', 'elasticsearch']);
const BOOL_OPTIONS = ['readOnly', 'encrypt', 'trustServerCertificate', 'ssl', 'tunnel', 'verifyServer', 'verifyHostname', 'ssh', 'apiKey'] as const;
const TEXT_OPTIONS = ['caFile', 'certFile', 'keyFile', 'servername', 'sshHost', 'sshUser', 'sshKeyFile'] as const;
/** Pfade in den Optionen (fehlen sie auf diesem PC, gibt es einen Hinweis) */
const FILE_OPTIONS = ['caFile', 'certFile', 'keyFile', 'sshKeyFile'] as const;

const isText = (v: unknown): v is string => typeof v === 'string';
const optText = (v: unknown) => (isText(v) ? v : undefined);

function cleanOptions(raw: unknown): ConnectionOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const o: ConnectionOptions = {};
  for (const k of BOOL_OPTIONS) if (typeof r[k] === 'boolean') o[k] = r[k] as boolean;
  for (const k of TEXT_OPTIONS) if (isText(r[k])) o[k] = r[k] as string;
  if (Number.isInteger(r.sshPort) && (r.sshPort as number) > 0 && (r.sshPort as number) < 65536) o.sshPort = r.sshPort as number;
  return o;
}

function cleanConnection(raw: unknown): ExportedConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isText(r.id) || !isText(r.name) || !r.name.trim() || !DIALECTS.has(r.dialect as Dialect) || !isText(r.host) || !isText(r.user)) return null;
  if (!Number.isInteger(r.port) || (r.port as number) <= 0 || (r.port as number) >= 65536) return null;
  return {
    id: r.id,
    name: r.name.trim(),
    dialect: r.dialect as Dialect,
    host: r.host,
    port: r.port as number,
    user: r.user,
    database: optText(r.database),
    options: cleanOptions(r.options),
    color: optText(r.color),
  };
}

function cleanQuery(raw: unknown): SavedQuery | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isText(r.id) || !isText(r.name) || !r.name.trim() || !isText(r.sql)) return null;
  return { id: r.id, name: r.name.trim(), sql: r.sql, dialect: DIALECTS.has(r.dialect as Dialect) ? (r.dialect as Dialect) : undefined, updated: optText(r.updated) ?? new Date().toISOString() };
}

function cleanHistory(raw: unknown): HistoryEntry | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isText(r.id) || !isText(r.at) || !isText(r.connectionId) || !isText(r.sql)) return null;
  return {
    id: r.id,
    at: r.at,
    connectionId: r.connectionId,
    connection: optText(r.connection) ?? '',
    database: optText(r.database),
    sql: r.sql,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
    ok: r.ok !== false,
    error: optText(r.error),
    info: optText(r.info),
  };
}

function cleanSecrets(raw: unknown): Record<string, Secrets> {
  // ohne Prototyp: IDs wie „__proto__“ oder „toString“ bleiben gewöhnliche Schlüssel
  const out = Object.create(null) as Record<string, Secrets>;
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = (v ?? {}) as Record<string, unknown>;
    out[id] = { password: optText(s.password), keyPassphrase: optText(s.keyPassphrase), sshSecret: optText(s.sshSecret) };
  }
  return out;
}

async function readFile(file: string): Promise<SettingsFile> {
  let raw: Record<string, unknown>;
  try {
    // ein BOM (PowerShell 5, ältere Editoren) wäre für JSON.parse ein Fehler
    raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Datei nicht gefunden: ${file}`);
    throw new Error('Die Datei ist keine OwlynDB-Einstellungsdatei (kein gültiges JSON).');
  }
  if (!raw || (raw.format !== FORMAT && !LEGACY_FORMATS.includes(raw.format as string)) || !Array.isArray(raw.connections)) throw new Error('Die Datei ist keine OwlynDB-Einstellungsdatei.');
  if (typeof raw.version !== 'number' || raw.version > VERSION) throw new Error('Die Datei stammt von einer neueren OwlynDB-Version – bitte OwlynDB aktualisieren.');
  const keep = <T>(list: unknown, f: (x: unknown) => T | null): T[] | undefined =>
    Array.isArray(list) ? list.map(f).filter((x): x is T => x !== null) : undefined;
  const s = raw.secrets as Sealed | undefined;
  return {
    // alte Kennung (AtlasDB) gilt als die heutige: die Datei hat denselben Aufbau
    format: FORMAT,
    version: raw.version,
    exportedAt: optText(raw.exportedAt) ?? '',
    connections: keep(raw.connections, cleanConnection) ?? [],
    savedQueries: keep(raw.savedQueries, cleanQuery),
    history: keep(raw.history, cleanHistory),
    secrets: s && typeof s === 'object' && isText(s.data) && isText(s.salt) && isText(s.iv) && isText(s.tag) ? s : undefined,
  };
}

// ---------- Abgleich mit dem, was es hier schon gibt ----------

/** Vergleichsform der Optionen: nur gesetzte Werte, sortiert */
function optionsKey(o: ConnectionOptions | undefined): string {
  const e = Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== false && v !== '');
  return JSON.stringify(e.sort(([a], [b]) => (a < b ? -1 : 1)));
}

function differences(a: ExportedConnection, b: SavedConnection): string[] {
  const d: string[] = [];
  if (a.name !== b.name) d.push('Name');
  if (a.dialect !== b.dialect) d.push('Typ');
  if (a.host !== b.host) d.push('Server');
  if (a.port !== b.port) d.push('Port');
  if (a.user !== b.user) d.push('Benutzer');
  if ((a.database ?? '') !== (b.database ?? '')) d.push('Datenbank');
  if ((a.color ?? '') !== (b.color ?? '')) d.push('Farbe');
  if (optionsKey(a.options) !== optionsKey(b.options)) d.push('Optionen');
  return d;
}

function findMatch(c: ExportedConnection, local: SavedConnection[]): { conn: SavedConnection; by: 'id' | 'name' | 'server' } | undefined {
  const byId = local.find((l) => l.id === c.id);
  if (byId) return { conn: byId, by: 'id' };
  const byName = local.find((l) => l.name.trim().toLowerCase() === c.name.toLowerCase());
  if (byName) return { conn: byName, by: 'name' };
  const byServer = local.find(
    (l) => l.dialect === c.dialect && l.host.toLowerCase() === c.host.toLowerCase() && l.port === c.port && l.user === c.user && (l.database ?? '') === (c.database ?? ''),
  );
  return byServer ? { conn: byServer, by: 'server' } : undefined;
}

/** Netzwerkpfad (\\server\freigabe\…): schon die Prüfung meldet Windows beim Server an – bei einer fremden Datei in der Vorschau nicht */
const isNetworkPath = (p: string) => /^[\\/]{2}/.test(p);

async function missingFiles(o: ConnectionOptions | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const k of FILE_OPTIONS) {
    const p = o?.[k]?.trim();
    if (!p || isNetworkPath(p)) continue;
    try {
      await fs.access(p);
    } catch {
      out.push(p);
    }
  }
  return out;
}

const fields = (c: ExportedConnection) => ({ name: c.name, dialect: c.dialect, host: c.host, port: c.port, user: c.user, database: c.database, options: c.options, color: c.color });

// ---------- Export, Vorschau, Import ----------

export async function exportSettings(store: ConnectionStore, saved: SavedQueries, history: QueryHistory, opts: SettingsExportOptions): Promise<object> {
  const wanted = new Set(opts.connectionIds);
  const pick = (await store.list()).filter((c) => wanted.has(c.id));
  const file: SettingsFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    connections: pick.map(({ hasPassword: _p, hasKeyPassphrase: _k, hasSshSecret: _s, ...c }) => c),
  };
  if (opts.savedQueries) file.savedQueries = await saved.list();
  // Verlauf nur zu den exportierten Verbindungen
  if (opts.history) file.history = (await history.all()).filter((e) => wanted.has(e.connectionId));
  if (opts.password) {
    if (opts.password.length < MIN_PASSWORD) throw new Error(`Das Export-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
    const map: Record<string, Secrets> = {};
    for (const c of pick) {
      let s: Secrets;
      try {
        s = await store.secretsOf(c.id);
      } catch {
        // z. B. von Hand von einem anderen PC kopiertes Profil
        throw new Error(`Das gespeicherte Passwort von „${c.name}“ lässt sich auf diesem PC nicht entschlüsseln – in der Verbindung neu eingeben oder ohne Passwörter exportieren.`);
      }
      if (s.password !== undefined || s.keyPassphrase !== undefined || s.sshSecret !== undefined) map[c.id] = s;
    }
    // ohne gespeicherte Passwörter nichts verschlüsseln – sonst fragte der Import nach einem Passwort für nichts
    if (Object.keys(map).length) file.secrets = await seal(map, opts.password, bindingOf(file.connections));
  }
  return file;
}

export async function previewSettings(store: ConnectionStore, saved: SavedQueries, history: QueryHistory, path: string, password?: string): Promise<SettingsPreview> {
  const file = await readFile(path);
  const secrets = file.secrets && password ? cleanSecrets(await unseal(file.secrets, password, bindingOf(file.connections))) : null;
  const local = await store.list();
  const connections: SettingsPreview['connections'] = [];
  for (const [index, c] of file.connections.entries()) {
    const m = findMatch(c, local);
    connections.push({
      index,
      name: c.name,
      dialect: c.dialect,
      host: c.host,
      port: c.port,
      user: c.user,
      database: c.database,
      color: c.color,
      hasSecret: !!secrets?.[c.id],
      match: m ? { id: m.conn.id, name: m.conn.name, by: m.by, differences: differences(c, m.conn) } : undefined,
      missingFiles: await missingFiles(c.options),
    });
  }
  const queries = await saved.list();
  const freshQueries = (file.savedQueries ?? []).filter((q) => !queries.some((l) => l.id === q.id || (l.name === q.name && l.sql === q.sql)));
  const ids = new Set((await history.all()).map((e) => e.id));
  return {
    file: path,
    exportedAt: file.exportedAt,
    hasSecrets: !!file.secrets,
    secretsOpen: !!secrets,
    connections,
    savedQueries: { total: file.savedQueries?.length ?? 0, fresh: freshQueries.length },
    history: { total: file.history?.length ?? 0, fresh: (file.history ?? []).filter((e) => !ids.has(e.id)).length },
  };
}

/** Rückgabe zusätzlich: IDs der ersetzten Verbindungen (deren offene Verbindung muss neu aufgebaut werden) */
export async function importSettings(
  store: ConnectionStore,
  saved: SavedQueries,
  history: QueryHistory,
  req: SettingsImportRequest,
): Promise<SettingsImportResult & { replacedIds: string[] }> {
  const file = await readFile(req.file);
  const secrets = file.secrets && req.password ? cleanSecrets(await unseal(file.secrets, req.password, bindingOf(file.connections))) : {};
  const local = await store.list();
  /** ID in der Datei → ID hier (für den Verlauf) */
  const idMap = new Map<string, string>();
  const result: SettingsImportResult & { replacedIds: string[] } = { created: 0, replaced: 0, skipped: 0, savedQueries: 0, history: 0, notes: [], replacedIds: [] };
  // je Verbindung einzeln: ein Fehler bei einer (keine passende zum Ersetzen, Schreibfehler) lässt die anderen durch und
  // wird gemeldet – die schon ersetzten bleiben als replacedIds bekannt, damit ihre Treiber neu aufgebaut werden
  for (const choice of req.connections) {
    const c = file.connections[choice.index];
    if (!c) continue;
    const s = secrets[c.id] ?? {};
    const m = findMatch(c, local);
    if (choice.action === 'skip') {
      result.skipped++;
      if (m) idMap.set(c.id, m.conn.id);
      continue;
    }
    try {
      if (choice.action === 'replace') {
        if (!m) throw new Error('hier gibt es keine passende Verbindung zum Ersetzen.');
        // ohne Passwörter in der Datei bleiben die hier gespeicherten
        await store.save({ ...fields(c), id: m.conn.id, password: s.password, keyPassphrase: s.keyPassphrase, sshSecret: s.sshSecret });
        result.replaced++;
        result.replacedIds.push(m.conn.id);
        idMap.set(c.id, m.conn.id);
        continue;
      }
      let name = c.name;
      for (let i = 2; local.some((l) => l.name.toLowerCase() === name.toLowerCase()); i++) name = `${c.name} (${i})`;
      if (name !== c.name) result.notes.push(`„${c.name}“ heißt hier „${name}“ (der Name war schon vergeben).`);
      // ID behalten (der Verlauf verweist darauf), wenn sie frei ist und wie eine von OwlynDB vergebene aussieht
      const keepId = UUID.test(c.id) && !local.some((l) => l.id === c.id);
      const created = await store.save({ ...fields(c), name, id: keepId ? c.id : undefined, password: s.password, keyPassphrase: s.keyPassphrase, sshSecret: s.sshSecret }, keepId);
      local.push(created);
      idMap.set(c.id, created.id);
      result.created++;
      const missing = await missingFiles(c.options);
      if (missing.length) result.notes.push(`${name}: Datei fehlt auf diesem PC: ${missing.join(', ')}`);
    } catch (e) {
      result.failed = (result.failed ?? 0) + 1;
      result.notes.push(`${c.name}: nicht übernommen – ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (req.savedQueries && file.savedQueries?.length) result.savedQueries = await saved.merge(file.savedQueries);
  if (req.history && file.history?.length) {
    result.history = await history.merge(file.history.map((e) => ({ ...e, connectionId: idMap.get(e.connectionId) ?? e.connectionId })));
  }
  return result;
}
