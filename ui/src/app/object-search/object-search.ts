import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injectable, signal, untracked, viewChild } from '@angular/core';
import type { SearchHit, SearchResult } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { AppState } from '../core/state';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

@Injectable({ providedIn: 'root' })
export class ObjectSearchService {
  /** Verbindung, in der gesucht wird; null = Dialog zu */
  readonly connectionId = signal<string | null>(null);

  open(connectionId: string): void {
    this.connectionId.set(connectionId);
  }
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  table: 'Tabelle',
  view: 'View',
  column: 'Spalte',
  procedure: 'Prozedur',
  function: 'Funktion',
  trigger: 'Trigger',
};
const KIND_ICON: Record<SearchHit['kind'], string> = {
  table: 'table',
  view: 'view',
  column: 'columns',
  procedure: 'proc',
  function: 'func',
  trigger: 'trigger',
};

/** Suche nach Tabellen, Views, Spalten und Routinen in allen Datenbanken einer Verbindung (Strg+Umschalt+F) */
@Component({
  selector: 'app-object-search',
  imports: [Icon, Modal],
  template: `
    @if (svc.connectionId(); as id) {
      <div class="backdrop" (mousedown)="onBackdrop($event)">
        <div class="dialog" appModal aria-label="Objektsuche" (dismiss)="close()" (keydown)="onKey($event)">
          <div class="search">
            <app-icon name="search" [size]="15" />
            <input
              #input
              autofocus
              type="text"
              placeholder="Tabelle, Spalte, Prozedur … (mindestens 2 Zeichen)"
              [value]="text()"
              (input)="onInput($any($event.target).value)"
            />
            <span class="dim conn">{{ state.connection(id)?.name }}</span>
          </div>
          @if (error()) {
            <div class="error">{{ error() }}</div>
          }
          <div class="list" [class.stale]="stale()">
            @for (h of hits(); track $index) {
              <div class="hit" [class.on]="$index === index()" (mouseenter)="index.set($index)" (click)="open(h)">
                <span class="ic k-{{ h.kind }}"><app-icon [name]="icon(h)" [size]="14" /></span>
                <span class="main">
                  @for (p of parts(label(h)); track $index) {
                    <span [class.m]="p.match">{{ p.text }}</span>
                  }
                </span>
                <span class="dim where">{{ where(h) }}</span>
                <span class="dim kind">{{ kindLabel(h) }}</span>
              </div>
            } @empty {
              <div class="empty dim">
                @if (loading()) {
                  sucht …
                } @else if (text().trim().length >= 2 && result()) {
                  Nichts gefunden.
                } @else {
                  Sucht in allen Datenbanken der Verbindung nach Namen von Tabellen, Views, Spalten, Prozeduren, Funktionen und Triggern.
                }
              </div>
            }
          </div>
          @if (result(); as r) {
            <div class="foot dim">
              {{ r.hits.length }} Treffer{{ r.truncated ? ' (es gibt mehr – Suche genauer fassen)' : '' }}
              @if (r.skipped.length) {
                · nicht durchsucht: {{ r.skipped.join(', ') }}
              }
              <span class="grow"></span>
              <span>↑↓ wählen · Enter öffnen · Esc schließen</span>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 820;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding-top: 9vh;
      background: rgba(0, 0, 0, 0.35);
    }
    .dialog {
      outline: none;
      width: min(720px, calc(100vw - 32px));
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      color: var(--fg-faint);
      input {
        flex: 1;
        min-width: 0;
        border: 0 !important;
        padding: 0;
        background: transparent;
        color: var(--fg);
        font-size: 15px;
        outline: none;
      }
    }
    .conn {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dim {
      color: var(--fg-dim);
    }
    .error {
      padding: 8px 14px;
      color: var(--danger);
    }
    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      &.stale {
        opacity: 0.55;
      }
    }
    .hit {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 14px;
      cursor: pointer;
      white-space: nowrap;
      &.on {
        background: var(--sel);
      }
      .main {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .m {
        color: var(--accent);
        font-weight: 600;
      }
      .where {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 12px;
      }
      .kind {
        font-size: 11px;
      }
    }
    .ic {
      display: inline-flex;
      color: var(--fg-dim);
      &.k-table {
        color: #3d8fd1;
      }
      &.k-view {
        color: #3aa57a;
      }
      &.k-procedure {
        color: #d6763a;
      }
      &.k-function {
        color: #b05ec9;
      }
      &.k-trigger {
        color: #d6b11f;
      }
    }
    .empty {
      padding: 16px 14px;
      line-height: 1.5;
    }
    .foot {
      display: flex;
      gap: 8px;
      padding: 6px 14px;
      border-top: 1px solid var(--border);
      font-size: 12px;
    }
    .grow {
      flex: 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObjectSearch {
  protected svc = inject(ObjectSearchService);
  protected state = inject(AppState);
  protected text = signal('');
  protected result = signal<SearchResult | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected index = signal(0);
  private input = viewChild<ElementRef<HTMLInputElement>>('input');
  private timer?: ReturnType<typeof setTimeout>;
  private seq = 0;
  /** Suchtext, zu dem result() gehört */
  private resultFor = signal('');
  /** Enter, während die Liste noch nicht zum Suchtext passt: öffnet den ersten neuen Treffer, sobald er da ist */
  private pendingEnter = false;
  /** zählt jedes Öffnen und Schließen; eine Routine, deren DDL nach dem Schließen ankommt, öffnet keinen Tab mehr */
  private generation = 0;
  /** in dieser Generation wird gerade eine Routine geladen (zweites Enter oder zweiter Klick: kein zweiter Tab) */
  private opening: number | null = null;
  /** Kennzeichen der Suche, die im Hauptprozess läuft – eine neuere Eingabe bricht sie ab (sonst liefe sie über alle Datenbanken weiter) */
  private running: string | null = null;
  private searchCount = 0;

  protected readonly hits = computed(() => this.result()?.hits ?? []);
  /** Liste gehört (noch) nicht zum Suchtext: Suche läuft oder ist noch nicht gestartet – grau, Enter wartet */
  protected readonly stale = computed(() => {
    const t = this.text().trim();
    return this.loading() || (t.length >= 2 && this.resultFor() !== t);
  });

  constructor() {
    // beim Öffnen: Fokus ins Feld (wie autofocus über appModal), alten Text markieren – Tippen ersetzt ihn
    effect(() => {
      const id = this.svc.connectionId();
      untracked(() => {
        this.generation++;
        this.pendingEnter = false;
        this.result.set(null);
        this.resultFor.set('');
        this.error.set(null);
        this.index.set(0);
        if (id)
          setTimeout(() => {
            const el = this.input()?.nativeElement;
            el?.focus();
            el?.select();
          }, 0);
      });
    });
    // leicht verzögert suchen; nur das Ergebnis der letzten Eingabe zählt
    effect(() => {
      const t = this.text().trim();
      const id = this.svc.connectionId();
      untracked(() => {
        clearTimeout(this.timer);
        // jede Änderung (auch Kürzen, Schließen, andere Verbindung) macht laufende Suchen ungültig – sonst überschriebe
        // eine späte Antwort das Ergebnis für einen Text, der nicht mehr im Feld steht
        const my = ++this.seq;
        this.cancelRunning();
        if (!id || t.length < 2) {
          this.result.set(null);
          this.loading.set(false);
          return;
        }
        this.loading.set(true);
        this.timer = setTimeout(() => void this.search(id, t, my), 250);
      });
    });
  }

  private async search(id: string, t: string, my: number) {
    if (my !== this.seq) return;
    try {
      await this.state.ensureConnected(id);
      if (my !== this.seq) return;
      const token = `suche-${++this.searchCount}`;
      this.running = token;
      const r = await api.searchObjects(id, t, token).finally(() => {
        if (this.running === token) this.running = null;
      });
      if (my !== this.seq) return;
      this.result.set(r);
      this.resultFor.set(t);
      this.error.set(null);
      this.index.set(0);
      if (this.pendingEnter) {
        this.pendingEnter = false;
        if (r.hits.length) void this.open(r.hits[0]);
      }
    } catch (e) {
      this.state.noteError(id, e);
      if (my === this.seq) {
        this.error.set(message(e));
        this.pendingEnter = false;
      }
    } finally {
      if (my === this.seq) this.loading.set(false);
    }
  }

  private cancelRunning() {
    if (this.running) void api.cancelSearch(this.running).catch(() => undefined);
    this.running = null;
  }

  protected label(h: SearchHit): string {
    if (h.kind === 'column') return `${h.name}.${h.column}`;
    if (h.args !== undefined) return `${h.name}(${h.args})`;
    return h.name;
  }

  protected where(h: SearchHit): string {
    const place = h.schema ? `${h.database} · ${h.schema}` : h.database;
    if (h.kind === 'column') return `${place}${h.dataType ? ' · ' + h.dataType : ''}`;
    if (h.kind === 'trigger' && h.table) return `${place} · auf ${h.table}`;
    return place;
  }

  protected kindLabel(h: SearchHit): string {
    return h.kind === 'column' && h.objectKind === 'view' ? 'Spalte (View)' : KIND_LABEL[h.kind];
  }

  protected icon(h: SearchHit): string {
    return KIND_ICON[h.kind];
  }

  /** Suchtext im Namen hervorheben */
  protected parts(s: string): { text: string; match: boolean }[] {
    const q = this.text().trim().toLowerCase();
    const i = q ? s.toLowerCase().indexOf(q) : -1;
    if (i < 0) return [{ text: s, match: false }];
    return [
      { text: s.slice(0, i), match: false },
      { text: s.slice(i, i + q.length), match: true },
      { text: s.slice(i + q.length), match: false },
    ].filter((p) => p.text);
  }

  /** Tippen nach einem wartenden Enter: das Enter galt dem alten Text */
  protected onInput(value: string) {
    this.pendingEnter = false;
    this.text.set(value);
  }

  protected onKey(ev: KeyboardEvent) {
    const n = this.hits().length;
    if (ev.key === 'ArrowDown' && n) {
      this.pendingEnter = false;
      this.index.set((this.index() + 1) % n);
      ev.preventDefault();
    } else if (ev.key === 'ArrowUp' && n) {
      this.pendingEnter = false;
      this.index.set((this.index() - 1 + n) % n);
      ev.preventDefault();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      // die sichtbare Liste gehört zu einem älteren Text (z. B. „kun“ statt „kunde“): auf die neue warten
      if (this.stale()) this.pendingEnter = true;
      else if (n) void this.open(this.hits()[this.index()]);
    }
    // Liste mitscrollen
    setTimeout(() => document.querySelector('app-object-search .hit.on')?.scrollIntoView({ block: 'nearest' }), 0);
  }

  protected async open(h: SearchHit) {
    const id = this.svc.connectionId();
    if (!id || this.opening === this.generation) return;
    if (h.kind === 'table' || h.kind === 'view' || h.kind === 'column') {
      this.close();
      this.state.openTable({ connectionId: id, database: h.database, schema: h.schema, name: h.name, kind: h.kind === 'column' ? (h.objectKind ?? 'table') : h.kind });
      return;
    }
    const my = (this.opening = this.generation);
    try {
      const script = await api.getRoutineDdl({ connectionId: id, database: h.database, schema: h.schema, name: h.name, kind: h.kind, table: h.table, args: h.args });
      // inzwischen geschlossen (oder neu geöffnet): kein Tab, der unerwartet aufspringt
      if (my !== this.generation) return;
      this.close();
      this.state.openQuery(id, h.database, script);
    } catch (e) {
      if (my === this.generation) this.error.set(message(e));
    } finally {
      if (this.opening === my) this.opening = null;
    }
  }

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }

  protected close() {
    clearTimeout(this.timer);
    this.svc.connectionId.set(null);
  }
}
