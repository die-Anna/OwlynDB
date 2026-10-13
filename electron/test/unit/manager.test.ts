/* Reine Logik ohne Datenbank (npm run test:unit): Manager – Treiberaufbau nur einmal, auch bei gleichzeitigen Aufrufen */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectionStore } from '../../connection-store';
import type { MetaDriver } from '../../drivers/common';
import { Manager } from '../../manager';

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-manager-unit-'));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Manager mit erfundener Verbindung; openDriver zählt und liefert nach einer Weile einen Treiber, der nur serverInfo und close kennt */
function setup(opts: { fail?: boolean } = {}) {
  const store = { dir, get: async (id: string) => ({ id, name: id, dialect: 'mysql' }), driverConfig: async () => ({}) };
  const m = new Manager(store as unknown as ConnectionStore, undefined, 0);
  const n = { starts: 0, closed: 0 };
  (m as unknown as { openDriver: () => Promise<MetaDriver> }).openDriver = async () => {
    n.starts++;
    await delay(30);
    if (opts.fail) throw new Error('kein Server');
    return { serverInfo: async () => ({ version: 'test' }), close: async () => void n.closed++ } as unknown as MetaDriver;
  };
  return { m, n };
}

test('gleichzeitige connect-Aufrufe teilen sich einen Treiber (F191)', async () => {
  const { m, n } = setup();
  await Promise.all([m.connect('a'), m.connect('a'), m.connect('a')]);
  assert.equal(n.starts, 1);
  await m.connect('a');
  assert.equal(n.starts, 1, 'fertiger Treiber wird wiederverwendet');
  await m.connect('b');
  assert.equal(n.starts, 2, 'andere Verbindung: eigener Treiber');
});

test('Trennen während des Aufbaus schließt den entstehenden Treiber', async () => {
  const { m, n } = setup();
  const p = m.connect('a');
  await m.disconnect('a');
  await p;
  assert.equal(n.closed, 1);
  await m.connect('a');
  assert.equal(n.starts, 2, 'danach neuer Aufbau statt des geschlossenen Treibers');
});

test('fehlgeschlagener Aufbau: alle Wartenden bekommen den Fehler, der nächste Versuch baut neu auf', async () => {
  const { m, n } = setup({ fail: true });
  const r = await Promise.allSettled([m.connect('a'), m.connect('a')]);
  assert.deepEqual(r.map((x) => x.status), ['rejected', 'rejected']);
  assert.equal(n.starts, 1);
  await assert.rejects(m.connect('a'), /kein Server/);
  assert.equal(n.starts, 2);
});

test('openWork meldet die von der Oberfläche gemeldeten ungespeicherten Tabellen (F189)', async () => {
  const { m } = setup();
  assert.deepEqual(m.openWork().unsaved, []);
  await m.setUnsavedTables(['kunde', 'artikel']);
  assert.deepEqual(m.openWork().unsaved, ['kunde', 'artikel']);
  await m.setUnsavedTables('kaputt' as unknown as string[]);
  assert.deepEqual(m.openWork().unsaved, [], 'keine Liste: nichts');
});

test('Neu laden bzw. Absturz der Oberfläche: Sitzungen zu, Aufträge und Exporte abgebrochen, Treiber bleibt (F142–F144, F152)', async () => {
  const { m, n } = setup();
  let sessionsClosed = 0;
  const session = { database: 'db', busy: false, inTransaction: true, broken: false, close: async () => void sessionsClosed++ };
  (m as unknown as { openDriver: () => Promise<MetaDriver> }).openDriver = async () =>
    ({ serverInfo: async () => ({ version: 't' }), close: async () => void n.closed++, openSession: async () => session }) as unknown as MetaDriver;
  await m.openSession('a', 'db');
  await m.openSession('a', 'db');
  // ein laufender Auftrag und ein laufender Export
  let jobCancelled = false;
  const job = (m as unknown as { job: (...a: unknown[]) => string }).job(
    'dump',
    'x.sql',
    undefined,
    () => ({ done: 0, statements: 0, current: '', log: [] }),
    (cancelled: { signal: AbortSignal }) => new Promise<void>((_, reject) => cancelled.signal.addEventListener('abort', () => reject(new Error('abgebrochen')))),
    () => void (jobCancelled = true),
  );
  const exportAc = new AbortController();
  (m as unknown as { exportCancels: Map<string, AbortController> }).exportCancels.set('t1', exportAc);
  await m.setUnsavedTables(['kunde']);
  assert.deepEqual(m.openWork(), { busy: 0, inTransaction: 2, jobs: 1, exports: 1, unsaved: ['kunde'] });
  await m.releaseUi();
  assert.equal(sessionsClosed, 2);
  assert.ok(jobCancelled);
  assert.ok(exportAc.signal.aborted);
  await new Promise((r) => setImmediate(r));
  assert.equal((await m.jobStatus(job)).state, 'cancelled');
  assert.deepEqual(m.openWork().unsaved, []);
  assert.equal(n.closed, 0, 'Treiber bleibt offen – die neue Oberfläche verbindet gleich wieder');
});

// ---------- Speichern, Trennen, Neuaufbau, Aufträge (F147, F151, F153/F154, F279–F283) ----------

/** Manager mit kleinem Speicher im Arbeitsspeicher; Treiber zählen Aufbau, Schließen, Sitzungen und Suche */
function rich() {
  type Conn = { id: string; name: string; dialect: string; host: string; password?: string; database?: string; options?: { readOnly?: boolean } };
  const conns = new Map<string, Conn>();
  const store = {
    dir,
    get: async (id: string) => {
      const c = conns.get(id);
      if (!c) throw new Error('Verbindung nicht gefunden.');
      return c;
    },
    save: async (input: Partial<Conn> & { name: string; host: string }) => {
      const id = input.id ?? `c${conns.size + 1}`;
      const prev = conns.get(id);
      const c: Conn = { ...prev, ...input, id, dialect: 'mysql', password: input.password ?? prev?.password };
      conns.set(id, c);
      return c;
    },
    driverConfig: async (id: string) => {
      const c = conns.get(id)!;
      return { host: c.host, password: c.password ?? '', readOnly: !!c.options?.readOnly };
    },
  };
  const m = new Manager(store as unknown as ConnectionStore, undefined, 0);
  const n = { starts: 0, closed: 0, sessions: 0, sessionsClosed: 0, closedIds: new Set<number>(), searches: [] as (string | null)[] };
  (m as unknown as { openDriver: () => Promise<MetaDriver> }).openDriver = async () => {
    n.starts++;
    return {
      serverInfo: async () => ({ version: 't' }),
      close: async () => void n.closed++,
      openSession: async (database?: string) => {
        const no = ++n.sessions;
        return {
          database,
          readOnly: false,
          busy: false,
          inTransaction: false,
          broken: false,
          close: async () => {
            n.sessionsClosed++;
            n.closedIds.add(no);
          },
          ping: () => new Promise(() => undefined),
        };
      },
      searchObjects: async (db: string | null, _p: string, limit: number) => {
        n.searches.push(db);
        const all = ['archiv1', 'archiv2', 'shop'].flatMap((d) => Array.from({ length: 200 }, (_, i) => ({ kind: 'table', database: d, name: `kunde_${i}` })));
        return all.filter((h) => db === null || h.database === db).slice(0, limit);
      },
    } as unknown as MetaDriver;
  };
  const job = (connections: string[], work: Promise<void>) =>
    (m as unknown as { job: (...a: unknown[]) => string }).job('dump', '', undefined, () => ({ done: 0, statements: 0, current: '', log: [] }), () => work, undefined, connections);
  return { m, n, store, job };
}

test('Speichern ohne geänderte Zugangsdaten behält die Verbindung; geänderte lösen sie erst nach laufenden Aufträgen ab (F151)', async () => {
  const { m, n, store, job } = rich();
  const c = await store.save({ name: 'A', host: 'h', password: 'p' });
  await m.connect(c.id);
  await m.saveConnection({ ...c, name: 'A neu', color: '#f00' } as never);
  await m.connect(c.id);
  assert.deepEqual([n.starts, n.closed], [1, 0], 'nur Name und Farbe: derselbe Treiber');
  // ein laufender Auftrag nutzt den Pool: neues Passwort – neue Aufrufe bekommen einen neuen Treiber, der alte schließt nach dem Auftrag
  let finish!: () => void;
  job([c.id], new Promise<void>((r) => (finish = r)));
  await m.saveConnection({ ...c, password: 'neu' } as never);
  await m.connect(c.id);
  assert.deepEqual([n.starts, n.closed], [2, 0], 'alter Treiber noch offen, solange der Auftrag läuft');
  finish();
  await delay(10);
  assert.equal(n.closed, 1);
});

test('„Nur lesen“ beim Speichern sofort auch in offenen Sitzungen (F153/F154: derselbe Weg beim Import)', async () => {
  const { m, store } = rich();
  const c = await store.save({ name: 'Prod', host: 'h' });
  const { sessionId } = await m.openSession(c.id, 'db');
  const session = (m as unknown as { sessions: Map<string, { session: { readOnly: boolean } }> }).sessions.get(sessionId)!.session;
  await m.saveConnection({ ...c, options: { readOnly: true } } as never);
  assert.equal(session.readOnly, true);
  (m as unknown as { applyReadOnly: (id: string, ro: boolean) => void }).applyReadOnly(c.id, false);
  assert.equal(session.readOnly, false);
});

test('Trennen bricht nur die Aufträge dieser Verbindung ab (F151)', async () => {
  const { m, store, job } = rich();
  const a = await store.save({ name: 'A', host: 'a' });
  const b = await store.save({ name: 'B', host: 'b' });
  let releaseA!: () => void;
  let releaseB!: () => void;
  const ja = job([a.id], new Promise<void>((_, reject) => (releaseA = () => reject(new Error('abgebrochen')))));
  const jb = job([b.id], new Promise<void>((r) => (releaseB = r)));
  // Abbrechen beendet den Auftrag (wie ein echter, der auf sein Signal hört)
  const jobs = (m as unknown as { jobs: Map<string, { cancel: () => void }> }).jobs;
  const orig = jobs.get(ja)!.cancel;
  jobs.get(ja)!.cancel = () => {
    orig();
    releaseA();
  };
  await m.disconnect(a.id);
  assert.equal((await m.jobStatus(ja)).state, 'cancelled');
  assert.equal((await m.jobStatus(jb)).state, 'running');
  releaseB();
});

test('Neuaufbau einer Sitzung: nur einer gleichzeitig, und keiner für einen inzwischen geschlossenen Tab (F280)', async () => {
  const { m, n, store } = rich();
  const c = await store.save({ name: 'A', host: 'h' });
  const { sessionId } = await m.openSession(c.id, 'db');
  const reopen = (id: string) => (m as unknown as { reopen: (id: string) => Promise<unknown> }).reopen(id);
  await Promise.all([reopen(sessionId), reopen(sessionId)]);
  assert.equal(n.sessions, 2, 'eine alte, eine neue – nicht zwei neue');
  // Tab schließt, während der Neuaufbau läuft
  const p = reopen(sessionId);
  await m.closeSession(sessionId);
  await assert.rejects(p, /nicht mehr offen/);
  assert.equal(n.sessions, 3);
  assert.ok(n.closedIds.has(3), 'auch die gerade neu geöffnete Sitzung ist zu');
});

test('Lebenszeichen: eine hängende Sitzung hält die anderen nicht auf (F147)', async () => {
  const { m, store } = rich();
  const c = await store.save({ name: 'A', host: 'h' });
  const s1 = await m.openSession(c.id, 'db');
  const s2 = await m.openSession(c.id, 'db');
  const sessions = (m as unknown as { sessions: Map<string, { session: { ping: () => Promise<void> } }> }).sessions;
  let pings = 0;
  sessions.get(s2.sessionId)!.session.ping = async () => void pings++;
  const keepAlive = () => (m as unknown as { keepAlive: () => void }).keepAlive();
  keepAlive();
  await delay(2);
  keepAlive();
  await delay(2);
  assert.equal(pings, 2, 'die zweite Sitzung bekommt jedes Lebenszeichen, obwohl die erste nie antwortet');
  assert.ok((m as unknown as { pinging: Set<unknown> }).pinging.has(sessions.get(s1.sessionId)!.session), 'die hängende wird nicht doppelt angepingt');
});

test('Objektsuche MySQL: Treffer der Standard-Datenbank zuerst (F279)', async () => {
  const { m, n, store } = rich();
  const c = await store.save({ name: 'A', host: 'h', database: 'shop' });
  const r = await m.searchObjects(c.id, 'kunde');
  assert.equal(r.hits[0].database, 'shop');
  assert.equal(r.hits.filter((h) => h.database === 'shop').length, 200, 'alle Treffer aus shop, obwohl archiv1/archiv2 alphabetisch davor liegen');
  assert.ok(r.truncated);
  assert.deepEqual(n.searches, ['shop', null]);
});

test('Ergebnisse und Aufträge: abgeholt wird freigegeben, laufende nicht verdrängt, alte beendete fallen weg (F282, F283)', async () => {
  const { m, job } = rich();
  const results = (m as unknown as { dataResults: Map<string, { result?: unknown }> }).dataResults;
  const trim = (map: Map<string, unknown>) => (m as unknown as { trimResults: (x: Map<string, unknown>) => void }).trimResults(map);
  let finish!: () => void;
  const long = job(['a'], new Promise<void>((r) => (finish = r)));
  results.set(long, {});
  for (let i = 0; i < 7; i++) {
    const id = job(['a'], Promise.resolve());
    await delay(1);
    results.set(id, { result: { rows: [] } });
    trim(results);
  }
  assert.ok(results.has(long), 'der laufende Vergleich wird nicht verdrängt');
  assert.equal(results.size, 5);
  const last = [...results.keys()].at(-1)!;
  await m.dataCompareResult(last);
  assert.ok(!results.has(last), 'abgeholt = freigegeben');
  finish();
  // viele beendete Aufträge: die letzten 20 bleiben
  for (let i = 0; i < 30; i++) job(['a'], Promise.resolve());
  await delay(10);
  assert.equal((m as unknown as { jobs: Map<string, unknown> }).jobs.size, 20);
});

test('historyCounts: Verlaufseinträge je Verbindung, ohne den SQL-Text zu liefern (F359)', async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'dbv-manager-hist-'));
  const store = { dir: d, get: async () => undefined, driverConfig: async () => ({}) };
  const m = new Manager(store as unknown as ConnectionStore, undefined, 0);
  const e = (connectionId: string) => ({ at: new Date().toISOString(), connectionId, connection: connectionId, sql: 'SELECT 1', durationMs: 1, ok: true });
  await (m as unknown as { history: { add(items: unknown[]): Promise<void> } }).history.add([e('a'), e('b'), e('a')]);
  assert.deepEqual(await m.historyCounts(), { a: 2, b: 1 });
});

test('cancelSearch: eine veraltete Objektsuche fragt keine weitere Datenbank mehr ab (F055)', async () => {
  const store = { dir, get: async (id: string) => ({ id, name: id, dialect: 'postgres', database: '' }), driverConfig: async () => ({}) };
  const m = new Manager(store as unknown as ConnectionStore, undefined, 0);
  const asked: string[] = [];
  (m as unknown as { openDriver: () => Promise<MetaDriver> }).openDriver = async () =>
    ({
      serverInfo: async () => ({ version: 'test' }),
      close: async () => undefined,
      listDatabases: async () => ['a', 'b', 'c', 'd', 'e'],
      searchObjects: async (db: string) => {
        asked.push(db);
        await delay(30);
        return [];
      },
    }) as unknown as MetaDriver;
  const p = m.searchObjects('x', 'kunde', 't1');
  await delay(45);
  await m.cancelSearch('t1');
  await assert.rejects(p, /abgebrochen/);
  assert.ok(asked.length <= 2, asked.join(','));
  // ohne Abbruch: alle Datenbanken; unbekanntes Kennzeichen stört nicht
  asked.length = 0;
  await m.cancelSearch('gibt-es-nicht');
  await m.searchObjects('x', 'kunde', 't2');
  assert.equal(asked.length, 5);
});
