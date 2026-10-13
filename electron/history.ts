import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryEntry, HistoryQuery, SavedQuery, SavedQueryInput } from '../shared/api-types';

/** längerer SQL-Text wird gekürzt gespeichert */
const MAX_SQL = 50_000;

/**
 * Abfrage-Verlauf als JSON-Zeilen im Profil: neue Einträge werden angehängt, die Datei wird gelegentlich
 * auf die letzten max Einträge gekürzt. Bleibt lokal (enthält SQL samt Werten, wie sie ausgeführt wurden).
 */
export class QueryHistory {
  private entries?: HistoryEntry[];
  /** gleichzeitige erste Aufrufe lesen die Datei nur einmal (sonst überschrieb die zweite Liste die erste samt Einträgen) */
  private loading?: Promise<HistoryEntry[]>;
  /** Zeilen in der Datei (auch die, die schon über der Grenze liegen) */
  private fileLines = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private file: string,
    private max = 5000,
  ) {}

  private load(): Promise<HistoryEntry[]> {
    if (this.entries) return Promise.resolve(this.entries);
    return (this.loading ??= this.readAll().finally(() => (this.loading = undefined)));
  }

  /** Schreiben einreihen: nacheinander, Fehler an den Aufrufer (die Kette läuft trotzdem weiter) */
  private enqueue(write: () => Promise<void>): Promise<void> {
    const p = this.writing.then(write);
    this.writing = p.catch(() => undefined);
    return p;
  }

  private async readAll(): Promise<HistoryEntry[]> {
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const list: HistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.fileLines++;
      try {
        list.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // halb geschriebene Zeile (Absturz) überspringen
      }
    }
    this.entries = list.slice(-this.max);
    return this.entries;
  }

  async add(items: Omit<HistoryEntry, 'id'>[]): Promise<void> {
    if (!items.length) return;
    const list = await this.load();
    const added = items.map((i) => ({ ...i, id: randomUUID(), sql: i.sql.length > MAX_SQL ? i.sql.slice(0, MAX_SQL) + '\n-- … gekürzt' : i.sql }));
    list.push(...added);
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.fileLines += added.length;
    // Datei erst neu schreiben, wenn sie deutlich über der Grenze liegt (sonst nur anhängen)
    const rewrite = this.fileLines > this.max * 1.2;
    if (rewrite) this.fileLines = list.length;
    // Text jetzt bilden, nicht erst beim Schreiben: ein später eingereihtes Anhängen brächte seine Einträge sonst doppelt
    const text = (rewrite ? list : added).map((e) => JSON.stringify(e)).join('\n') + '\n';
    // nacheinander schreiben, damit sich Anhängen und Kürzen nicht überholen; ein Fehler stört das Ausführen nicht
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      if (rewrite) await fs.writeFile(this.file, text, 'utf8');
      else await fs.appendFile(this.file, text, 'utf8');
    }).catch(() => undefined);
  }

  /** neueste zuerst */
  async list(q: HistoryQuery = {}): Promise<HistoryEntry[]> {
    const list = await this.load();
    const words = (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const out: HistoryEntry[] = [];
    for (let i = list.length - 1; i >= 0 && out.length < (q.limit ?? 200); i--) {
      const e = list[i];
      if (q.connectionId && e.connectionId !== q.connectionId) continue;
      if (words.length) {
        const hay = (e.sql + ' ' + (e.database ?? '') + ' ' + e.connection).toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      out.push(e);
    }
    return out;
  }

  /** alle Einträge, älteste zuerst (Export) */
  async all(): Promise<HistoryEntry[]> {
    return [...(await this.load())];
  }

  /** Einträge eines anderen PCs übernehmen (ohne doppelte, nach Zeit eingeordnet); Rückgabe: wie viele neu */
  async merge(items: HistoryEntry[]): Promise<number> {
    const list = await this.load();
    const have = new Set(list.map((e) => e.id));
    const add = items.filter((e) => !have.has(e.id));
    if (!add.length) return 0;
    list.push(...add);
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.fileLines = list.length;
    const text = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
    // Fehler beim Schreiben (Platte voll, gesperrt) sollen beim Import nicht untergehen
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, text, 'utf8');
    });
    return add.length;
  }

  /** löschen – und ein Fehler beim Schreiben ist ein Fehler: der Verlauf enthält SQL samt Werten, das Löschen muss stimmen */
  async clear(connectionId?: string): Promise<void> {
    const list = await this.load();
    const keep = connectionId ? list.filter((e) => e.connectionId !== connectionId) : [];
    list.splice(0, list.length, ...keep);
    this.fileLines = keep.length;
    const text = keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : '');
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, text, 'utf8');
    });
  }
}

/** gespeicherte Abfragen (Snippets) als JSON im Profil */
export class SavedQueries {
  private cache?: SavedQuery[];
  private loading?: Promise<SavedQuery[]>;
  private writing: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(private file: string) {}

  private load(): Promise<SavedQuery[]> {
    if (this.cache) return Promise.resolve(this.cache);
    return (this.loading ??= this.readAll().finally(() => (this.loading = undefined)));
  }

  private async readAll(): Promise<SavedQuery[]> {
    try {
      // ein BOM (Editor, PowerShell) wäre für JSON.parse ein Fehler
      this.cache = JSON.parse((await fs.readFile(this.file, 'utf8')).replace(/^﻿/, '')) as SavedQuery[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.cache = [];
    }
    return this.cache;
  }

  /**
   * Lesen, Ändern und Schreiben als ein Schritt nacheinander: zwei überlappende Aufrufe gingen sonst beide vom alten
   * Stand aus, und der zweite überschrieb die Änderung des ersten. Geschrieben wird atomar über eine eigene Zwischendatei.
   */
  private change<T>(fn: (list: SavedQuery[]) => { list: SavedQuery[]; result: T; changed: boolean }): Promise<T> {
    const p = this.writing.then(async () => {
      const r = fn([...(await this.load())]);
      if (r.changed) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.${++this.seq}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(r.list, null, 2), 'utf8');
        await fs.rename(tmp, this.file);
        this.cache = r.list;
      }
      return r.result;
    });
    this.writing = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async list(): Promise<SavedQuery[]> {
    return [...(await this.load())].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** mit id: überschreiben; gleicher Name ohne id: ebenfalls überschreiben (statt doppelt) */
  async save(input: SavedQueryInput): Promise<SavedQuery> {
    const name = input.name.trim();
    if (!name) throw new Error('Bitte einen Namen angeben.');
    if (!input.sql.trim()) throw new Error('Der Editor ist leer – nichts zu speichern.');
    return this.change((list) => {
      const idx = input.id ? list.findIndex((q) => q.id === input.id) : list.findIndex((q) => q.name.toLowerCase() === name.toLowerCase());
      const q: SavedQuery = {
        id: idx >= 0 ? list[idx].id : randomUUID(),
        name,
        sql: input.sql,
        dialect: input.dialect,
        updated: new Date().toISOString(),
      };
      if (idx >= 0) list[idx] = q;
      else list.push(q);
      return { list, result: q, changed: true };
    });
  }

  async remove(id: string): Promise<void> {
    await this.change((list) => ({ list: list.filter((q) => q.id !== id), result: undefined, changed: list.some((q) => q.id === id) }));
  }

  /** Abfragen eines anderen PCs übernehmen: gleiche (ID oder Name und Text) überspringen, gleicher Name mit anderem Text als „Name (2)“ */
  async merge(items: SavedQuery[]): Promise<number> {
    return this.change((list) => {
      let added = 0;
      for (const q of items) {
        if (list.some((l) => l.id === q.id || (l.name === q.name && l.sql === q.sql))) continue;
        let name = q.name;
        for (let i = 2; list.some((l) => l.name.toLowerCase() === name.toLowerCase()); i++) name = `${q.name} (${i})`;
        list.push({ ...q, name });
        added++;
      }
      return { list, result: added, changed: added > 0 };
    });
  }
}
