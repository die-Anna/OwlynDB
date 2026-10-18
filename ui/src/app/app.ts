import { afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, HostListener, inject, Injector, OnInit, signal } from '@angular/core';
import { message } from './core/api';
import { isMac, keys } from './core/platform';
import { AppState, Tab, tabConnection } from './core/state';
import { ConnectionDialog } from './connection-dialog/connection-dialog';
import { ExportDialog } from './export-dialog/export-dialog';
import { DumpDialog } from './dump-dialog/dump-dialog';
import { ObjectSearch, ObjectSearchService } from './object-search/object-search';
import { SchemaCompare } from './schema-compare/schema-compare';
import { SessionsView } from './sessions-view/sessions-view';
import { ErView } from './er-view/er-view';
import { DataCompare } from './data-compare/data-compare';
import { SettingsDialog } from './settings-dialog/settings-dialog';
import { QueryView } from './query-view/query-view';
import { Tree } from './sidebar/tree';
import { TableView } from './table-view/table-view';
import { ContextMenu, ContextMenuService } from './ui/context-menu';
import { Icon } from './ui/icon';
import { KeysPipe } from './ui/keys.pipe';
import { overlayOpen } from './ui/modal';

@Component({
  selector: 'app-root',
  imports: [Tree, ConnectionDialog, ExportDialog, DumpDialog, ObjectSearch, ContextMenu, Icon, TableView, QueryView, SchemaCompare, SessionsView, ErView, DataCompare, SettingsDialog, KeysPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private search = inject(ObjectSearchService);
  private injector = inject(Injector);
  protected state = inject(AppState);
  private menu = inject(ContextMenuService);
  protected sidebarWidth = signal(Number(localStorage.getItem('dbv.sidebar')) || 280);
  protected loadError = signal<string | null>(null);

  constructor() {
    // aktiver Tab immer im sichtbaren Teil der Leiste: neuer Tab, Strg+Tab, Schließen, Wiederherstellen beim Start
    afterRenderEffect(() => {
      if (this.state.activeId()) this.revealActiveTab();
    });
    // ebenso, wenn die Leiste schmaler wird (Seitenleiste breiter gezogen, Fenster verkleinert)
    afterNextRender(() => {
      const nav = document.querySelector('nav.tabs');
      if (nav) new ResizeObserver(() => this.revealActiveTab()).observe(nav);
    });
  }

  private revealActiveTab(): void {
    document.querySelector('nav.tabs .tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  async ngOnInit() {
    try {
      await this.state.load();
    } catch (e) {
      this.loadError.set(message(e));
    }
  }

  protected tabTitle(t: Tab): string {
    if (t.kind === 'query') return `Abfrage ${t.number}`;
    if (t.kind === 'compare') return `Vergleich ${t.number}`;
    if (t.kind === 'sessions') return 'Sitzungen';
    if (t.kind === 'er') return `ER · ${t.focus ?? (t.schema && t.schema !== 'dbo' && t.schema !== 'public' ? t.schema : t.database)}`;
    if (t.kind === 'datacompare') return `Datenvergleich ${t.number}`;
    if (!t.where) return t.ref.name;
    const f = t.label ?? t.where;
    const w = f.length > 32 ? f.slice(0, 31) + '…' : f;
    return `${t.ref.name} · ${w}`;
  }

  protected tabTooltip(t: Tab): string {
    const c = this.state.connection(tabConnection(t))?.name ?? '';
    if (t.kind === 'compare') return `Schema-Vergleich · Quelle: ${c} · ${t.source.database}${t.source.schema ? '.' + t.source.schema : ''}`;
    if (t.kind === 'sessions') return `Sitzungen und laufende Abfragen · ${c}`;
    if (t.kind === 'er') return `ER-Diagramm · ${c} · ${t.database}${t.schema ? '.' + t.schema : ''}${t.focus ? '\nab ' + t.focus : ''}`;
    if (t.kind === 'datacompare') return `Datenvergleich · geöffnet ab ${c} · ${[t.source.database, t.source.schema, t.source.table].filter(Boolean).join('.')}`;
    if (t.kind === 'table') return `${c} · ${t.ref.database}${t.ref.schema ? '.' + t.ref.schema : ''}.${t.ref.name}${t.where ? '\nWHERE ' + t.where : ''}`;
    return `${c}${t.database ? ' · ' + t.database : ''}`;
  }

  protected tabColor(t: Tab): string {
    return this.state.connection(tabConnection(t))?.color || 'transparent';
  }

  /** Neue Abfrage (+, Strg+T): auf der Auswahl im Baum, wenn dort zuletzt gewählt wurde, sonst wie der aktive Tab */
  protected newQuery() {
    const target = this.state.contextTarget();
    if (!target) {
      this.state.editing.set('');
      return;
    }
    this.state.openQuery(target.connectionId, target.database);
  }

  protected tabMenu(ev: MouseEvent, t: Tab) {
    this.menu.open(ev, [
      { label: 'Schließen', icon: 'close', hint: keys('Strg+W'), action: () => void this.state.requestClose([t.id]) },
      {
        label: 'Andere schließen',
        action: () => void this.state.requestClose(this.state.tabs().filter((x) => x.id !== t.id).map((x) => x.id)),
      },
      { label: 'Alle schließen', action: () => void this.state.requestClose(this.state.tabs().map((x) => x.id)) },
    ]);
  }

  /** Tab-Leiste mit der Tastatur: Pfeile bzw. Pos1/Ende wählen (und aktivieren) den Nachbarn, Entf (Mac: ⌫) schließt */
  protected onTabKey(ev: KeyboardEvent, t: Tab) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const list = this.state.tabs();
    const i = list.findIndex((x) => x.id === t.id);
    let next: Tab | undefined;
    if (ev.key === 'ArrowRight') next = list[(i + 1) % list.length];
    else if (ev.key === 'ArrowLeft') next = list[(i - 1 + list.length) % list.length];
    else if (ev.key === 'Home') next = list[0];
    else if (ev.key === 'End') next = list[list.length - 1];
    else if (ev.key === 'Enter' || ev.key === ' ') next = t;
    else if (ev.key === 'Delete' || (isMac && ev.key === 'Backspace')) {
      ev.preventDefault();
      void this.state.requestClose([t.id]).then(() => afterNextRender(() => document.querySelector<HTMLElement>('nav.tabs .tab.on')?.focus(), { injector: this.injector }));
      return;
    } else return;
    ev.preventDefault();
    this.state.activeId.set(next.id);
    afterNextRender(() => document.getElementById('tab-' + next.id)?.focus(), { injector: this.injector });
  }

  protected onTabMouseDown(ev: MouseEvent, t: Tab) {
    if (ev.button === 1) {
      ev.preventDefault();
      void this.state.requestClose([t.id]);
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent) {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    // bei offenem Dialog nicht: Strg+W schlösse sonst den Tab dahinter (samt Sitzung eines laufenden Exports), Strg+T
    // bzw. Strg+Tab holten den Fokus in einen Editor hinter dem Dialog, die Objektsuche läge unsichtbar darunter
    if (overlayOpen()) return;
    const k = ev.key.toLowerCase();
    if (k === 'f' && ev.shiftKey) {
      // Objektsuche in derselben Verbindung wie eine neue Abfrage: im Baum gewählt bzw. die des aktiven Tabs
      ev.preventDefault();
      const id = this.state.contextTarget()?.connectionId;
      if (id) this.search.open(id);
    } else if (k === 't') {
      ev.preventDefault();
      // gehaltene Taste: die Tastenwiederholung legte sonst Dutzende Tabs samt Serversitzung an
      if (!ev.repeat) this.newQuery();
    } else if (k === 'w') {
      ev.preventDefault();
      // ebenso: nicht Tab um Tab schließen
      if (ev.repeat) return;
      const id = this.state.activeId();
      if (id) void this.state.requestClose([id]);
    } else if (k === 'tab') {
      ev.preventDefault();
      const list = this.state.tabs();
      if (!list.length) return;
      const i = list.findIndex((x) => x.id === this.state.activeId());
      const n = (i + (ev.shiftKey ? -1 : 1) + list.length) % list.length;
      this.state.activeId.set(list[n].id);
    }
  }

  @HostListener('window:beforeunload')
  onUnload() {
    this.state.saveQueryTabs();
  }

  protected startResize(ev: MouseEvent) {
    ev.preventDefault();
    const move = (e: MouseEvent) => this.sidebarWidth.set(Math.min(600, Math.max(180, e.clientX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('dbv.sidebar', String(this.sidebarWidth()));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
