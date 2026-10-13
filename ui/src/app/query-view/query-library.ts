import { ChangeDetectionStrategy, Component, effect, ElementRef, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { DIALECT_LABEL, type Dialect, type HistoryEntry, type SavedQuery } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { Icon } from '../ui/icon';
import { KeysPipe } from '../ui/keys.pipe';

export type LibraryMode = 'history' | 'saved';

/** Abfrage-Verlauf und gespeicherte Abfragen als Seitenleiste im Abfrage-Tab */
@Component({
  selector: 'app-query-library',
  imports: [Icon, KeysPipe],
  template: `
    <header>
      <button type="button" [class.on]="mode() === 'history'" (click)="mode.set('history')"><app-icon name="history" [size]="13" /> Verlauf</button>
      <button type="button" [class.on]="mode() === 'saved'" (click)="mode.set('saved')"><app-icon name="star" [size]="13" /> Gespeichert</button>
      <span class="grow"></span>
      <button type="button" class="btn icon" title="Schließen" (click)="close.emit()"><app-icon name="close" [size]="13" /></button>
    </header>

    <div class="search">
      <app-icon name="search" [size]="13" />
      <input type="text" [placeholder]="mode() === 'history' ? 'Verlauf durchsuchen' : 'Gespeicherte durchsuchen'" [value]="search()" (input)="search.set($any($event.target).value)" />
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    @if (mode() === 'history') {
      <label class="only">
        <input type="checkbox" [checked]="onlyThis()" (change)="onlyThis.set($any($event.target).checked)" /> nur diese Verbindung
      </label>
      <div class="list">
        @for (e of history(); track e.id) {
          <div class="item" [class.bad]="!e.ok" (click)="insert.emit(e.sql)" title="Klick: in den Editor einfügen">
            <div class="meta">
              <span>{{ when(e.at) }}</span>
              @if (!onlyThis()) {
                <span class="dim">{{ e.connection }}</span>
              }
              @if (e.database) {
                <span class="dim">· {{ e.database }}</span>
              }
              <span class="grow"></span>
              <span class="dim">{{ e.ok ? (e.info ?? '') : 'Fehler' }}</span>
              <span class="dim">{{ e.durationMs }} ms</span>
              <button type="button" class="btn icon act" title="In neuem Tab öffnen" (click)="$event.stopPropagation(); openNew.emit({ sql: e.sql, connectionId: e.connectionId, database: e.database })">
                <app-icon name="plus" [size]="12" />
              </button>
            </div>
            <pre class="sql">{{ preview(e.sql) }}</pre>
            @if (!e.ok && e.error) {
              <div class="err">{{ e.error }}</div>
            }
          </div>
        } @empty {
          <div class="empty dim">{{ search() ? 'Nichts gefunden.' : 'Noch nichts ausgeführt.' }}</div>
        }
      </div>
      <footer>
        <button type="button" class="link" (click)="clearHistory()">{{ onlyThis() ? 'Verlauf dieser Verbindung löschen' : 'Ganzen Verlauf löschen' }}</button>
      </footer>
    } @else {
      <form class="save" (submit)="$event.preventDefault(); save()">
        <input #name type="text" placeholder="Name für die aktuelle Abfrage" [value]="newName()" (input)="newName.set($any($event.target).value)" />
        <button type="submit" class="btn" [disabled]="!newName().trim()" [title]="'Markierung bzw. ganzen Editor-Text speichern (Strg+S)' | keys">Speichern</button>
      </form>
      <div class="list">
        @for (q of saved(); track q.id) {
          <div class="item" (click)="insert.emit(q.sql)" title="Klick: in den Editor einfügen">
            <div class="meta">
              <b class="name">{{ q.name }}</b>
              @if (q.dialect && q.dialect !== dialect()) {
                <span class="tag">{{ label(q.dialect) }}</span>
              }
              <span class="grow"></span>
              <button type="button" class="btn icon act" title="In neuem Tab öffnen" (click)="$event.stopPropagation(); openNew.emit({ sql: q.sql })"><app-icon name="plus" [size]="12" /></button>
              <button type="button" class="btn icon act" title="Mit dem aktuellen Editor-Text überschreiben" (click)="$event.stopPropagation(); overwrite(q)"><app-icon name="edit" [size]="12" /></button>
              <button type="button" class="btn icon act" title="Löschen" (click)="$event.stopPropagation(); remove(q)"><app-icon name="trash" [size]="12" /></button>
            </div>
            <pre class="sql">{{ preview(q.sql) }}</pre>
          </div>
        } @empty {
          <div class="empty dim">{{ (search() ? 'Nichts gefunden.' : 'Noch keine gespeicherten Abfragen. Name eingeben und Speichern (Strg+S im Editor).') | keys }}</div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: 340px;
      min-width: 260px;
      border-left: 1px solid var(--border);
      background: var(--bg);
      min-height: 0;
    }
    header {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 6px 0 8px;
      border-bottom: 1px solid var(--border);
      > button:not(.btn) {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 9px 6px;
        border: 0;
        border-bottom: 2px solid transparent;
        background: none;
        color: var(--fg-dim);
        cursor: pointer;
        &.on {
          color: var(--fg);
          border-bottom-color: var(--accent);
        }
      }
    }
    .grow {
      flex: 1;
    }
    .dim {
      color: var(--fg-dim);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 8px 8px 4px;
      padding: 0 7px;
      height: 26px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--fg-faint);
      &:focus-within {
        border-color: var(--accent);
      }
      input {
        flex: 1;
        min-width: 0;
        border: 0 !important;
        padding: 0;
        background: transparent;
        color: var(--fg);
      }
    }
    .only {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px 6px;
      font-size: 12px;
      color: var(--fg-dim);
    }
    .save {
      display: flex;
      gap: 6px;
      padding: 2px 8px 8px;
      input {
        flex: 1;
        min-width: 0;
      }
    }
    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      border-top: 1px solid var(--border);
    }
    .item {
      padding: 6px 10px 7px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      &:hover {
        background: var(--sel);
        .act {
          visibility: visible;
        }
      }
      &.bad .meta > span:first-child {
        color: var(--danger);
      }
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      .name {
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    .act {
      visibility: hidden;
      width: 20px;
      height: 20px;
    }
    .tag {
      padding: 0 5px;
      border-radius: 8px;
      background: var(--bg-2);
      color: var(--fg-dim);
      font-size: 11px;
    }
    .sql {
      margin: 3px 0 0;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--fg);
      max-height: 5.2em;
      overflow: hidden;
    }
    .err {
      margin-top: 2px;
      font-size: 11px;
      color: var(--danger);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .error {
      margin: 4px 8px;
      color: var(--danger);
      font-size: 12px;
    }
    .empty {
      padding: 14px 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    footer {
      padding: 6px 10px;
      border-top: 1px solid var(--border);
    }
    .link {
      border: 0;
      padding: 0;
      background: none;
      color: var(--fg-dim);
      cursor: pointer;
      font-size: 12px;
      &:hover {
        color: var(--danger);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueryLibrary {
  readonly connectionId = input.required<string>();
  readonly dialect = input.required<Dialect>();
  readonly mode = model<LibraryMode>('history');
  /** liefert Markierung bzw. ganzen Editor-Text zum Speichern */
  readonly currentSql = input<() => string>(() => '');
  /** erhöht sich nach jeder Ausführung: Verlauf neu laden */
  readonly refresh = input(0);
  /** erhöht sich bei Strg+S: Namensfeld fokussieren */
  readonly saveRequest = input(0);
  readonly insert = output<string>();
  readonly openNew = output<{ sql: string; connectionId?: string; database?: string }>();
  readonly close = output<void>();

  protected search = signal('');
  protected onlyThis = signal(true);
  protected history = signal<HistoryEntry[]>([]);
  protected allSaved = signal<SavedQuery[]>([]);
  protected saved = signal<SavedQuery[]>([]);
  protected newName = signal('');
  protected error = signal<string | null>(null);
  private nameInput = viewChild<ElementRef<HTMLInputElement>>('name');
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Verlauf: bei Suche, Verbindungsfilter und nach jeder Ausführung neu laden (Suche leicht verzögert)
    effect(() => {
      const q = { connectionId: this.onlyThis() ? this.connectionId() : undefined, search: this.search(), limit: 300 };
      this.refresh();
      if (this.mode() !== 'history') return;
      untracked(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          api
            .listHistory(q)
            .then((h) => {
              this.history.set(h);
              this.error.set(null);
            })
            .catch((e) => this.error.set(message(e)));
        }, 150);
      });
    });
    effect(() => {
      if (this.mode() === 'saved') untracked(() => void this.loadSaved());
    });
    effect(() => {
      const s = this.search().toLowerCase();
      const all = this.allSaved();
      this.saved.set(s ? all.filter((q) => (q.name + ' ' + q.sql).toLowerCase().includes(s)) : all);
    });
    effect(() => {
      if (!this.saveRequest()) return;
      untracked(() => setTimeout(() => this.nameInput()?.nativeElement.focus(), 0));
    });
  }

  private async loadSaved() {
    try {
      this.allSaved.set(await api.listSavedQueries());
      this.error.set(null);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async save() {
    this.error.set(null);
    try {
      // gleicher Name (ohne Groß/klein): der Speicher ersetzt sonst still das gespeicherte SQL – erst fragen
      const name = this.newName().trim();
      const same = (await api.listSavedQueries()).find((q) => q.name.toLowerCase() === name.toLowerCase());
      if (same && !confirm(`Es gibt schon eine gespeicherte Abfrage „${same.name}“. Ihr SQL durch den aktuellen Editor-Text ersetzen?`)) return;
      await api.saveQuery({ id: same?.id, name, sql: this.currentSql()(), dialect: this.dialect() });
      this.newName.set('');
      await this.loadSaved();
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async overwrite(q: SavedQuery) {
    if (!confirm(`„${q.name}“ mit dem aktuellen Editor-Text überschreiben?`)) return;
    this.error.set(null);
    try {
      await api.saveQuery({ id: q.id, name: q.name, sql: this.currentSql()(), dialect: this.dialect() });
      await this.loadSaved();
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected async remove(q: SavedQuery) {
    if (!confirm(`Gespeicherte Abfrage „${q.name}“ löschen?`)) return;
    try {
      await api.deleteSavedQuery(q.id);
      await this.loadSaved();
    } catch (e) {
      // z. B. Datei gesperrt: sagen, statt still nichts zu tun
      this.error.set(message(e));
    }
  }

  protected async clearHistory() {
    const only = this.onlyThis();
    if (!confirm(only ? 'Verlauf dieser Verbindung löschen?' : 'Ganzen Abfrage-Verlauf (alle Verbindungen) löschen?')) return;
    try {
      await api.clearHistory(only ? this.connectionId() : undefined);
      this.history.set([]);
      this.error.set(null);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected preview(sql: string): string {
    const lines = sql.trim().split('\n');
    return lines.length > 4 ? lines.slice(0, 4).join('\n') + '\n…' : lines.join('\n');
  }

  protected label(d: Dialect): string {
    return DIALECT_LABEL[d];
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    const date = d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    return `${date} ${time}`;
  }
}
