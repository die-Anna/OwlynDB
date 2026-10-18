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
  /** nebeneinander: Breite der linken Seite in Prozent */
  protected splitPct = signal(Math.min(80, Math.max(20, Number(localStorage.getItem('dbv.split')) || 50)));
  /** gezogener Tab: Ablage in der Leiste (vor dem Tab an Stelle index, Länge = ans Ende) oder links/rechts daneben */
  protected drag = signal<{ index: number | null; zone: 'left' | 'right' | null } | null>(null);

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
    const sp = this.state.split();
    const single = this.state.tabs().length < 2;
    this.menu.open(ev, [
      { label: 'Schließen', icon: 'close', hint: keys('Strg+W'), action: () => void this.state.requestClose([t.id]) },
      {
        label: 'Andere schließen',
        action: () => void this.state.requestClose(this.state.tabs().filter((x) => x.id !== t.id).map((x) => x.id)),
      },
      { label: 'Alle schließen', action: () => void this.state.requestClose(this.state.tabs().map((x) => x.id)) },
      { separator: true },
      { label: 'Rechts daneben anzeigen', icon: 'columns', disabled: single || sp?.right === t.id, action: () => this.state.showBeside(t.id, 'right') },
      { label: 'Links daneben anzeigen', disabled: single || sp?.left === t.id, action: () => this.state.showBeside(t.id, 'left') },
      ...(sp ? [{ label: 'Nebeneinander beenden', action: () => this.state.split.set(null) }] : []),
    ]);
  }

  /** sichtbar: der aktive Tab, nebeneinander beide */
  protected visible(t: Tab): boolean {
    const sp = this.state.split();
    return sp ? t.id === sp.left || t.id === sp.right : t.id === this.state.activeId();
  }

  protected side(t: Tab): 'left' | 'right' | null {
    const sp = this.state.split();
    return !sp ? null : t.id === sp.left ? 'left' : t.id === sp.right ? 'right' : null;
  }

  /** nebeneinander, aber nicht der aktive: in der Leiste markiert */
  protected beside(t: Tab): boolean {
    return this.side(t) !== null && t.id !== this.state.activeId();
  }

  /** Klick oder Fokus in eine der beiden Seiten: dort wird gearbeitet */
  protected focusPane(t: Tab) {
    if (this.side(t) && this.state.activeId() !== t.id) this.state.activeId.set(t.id);
  }

  /** Trenner zwischen den beiden Seiten ziehen (20–80 %) */
  protected startSplitResize(ev: MouseEvent) {
    ev.preventDefault();
    const box = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const move = (e: MouseEvent) => this.splitPct.set(Math.min(80, Math.max(20, ((e.clientX - box.left) / box.width) * 100)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('dbv.split', String(Math.round(this.splitPct())));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  protected resetSplit() {
    this.splitPct.set(50);
    localStorage.setItem('dbv.split', '50');
  }

  /**
   * Tab ziehen: in der Leiste an eine andere Stelle, in den Inhalt links bzw. rechts neben den aktiven Tab. Erst ab ein paar
   * Pixeln Weg – ein Klick bleibt ein Klick (aktiviert den Tab).
   */
  protected tabPointerDown(ev: PointerEvent, t: Tab) {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest('.x')) return;
    const el = ev.currentTarget as HTMLElement;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let moving = false;
    el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      if (!moving && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
      moving = true;
      this.drag.set(this.dropTarget(e.clientX, e.clientY));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const d = this.drag();
      this.drag.set(null);
      if (!moving || !d) return;
      if (d.zone) this.state.showBeside(t.id, d.zone);
      else if (d.index !== null) this.state.moveTab(t.id, d.index);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Ablageziel unter dem Zeiger: Stelle in der Leiste (vor der Mitte eines Tabs) oder Hälfte des Inhalts */
  private dropTarget(x: number, y: number): { index: number | null; zone: 'left' | 'right' | null } {
    const nav = document.querySelector('nav.tabs')?.getBoundingClientRect();
    const content = document.querySelector('section.content')?.getBoundingClientRect();
    if (content && this.state.tabs().length > 1 && x >= content.left && x <= content.right && y >= content.top && y <= content.bottom) {
      return { index: null, zone: x < content.left + content.width / 2 ? 'left' : 'right' };
    }
    if (nav && y >= nav.top - 24 && y <= nav.bottom + 24) {
      const tabs = [...document.querySelectorAll('nav.tabs .tab')];
      const i = tabs.findIndex((tab) => {
        const r = tab.getBoundingClientRect();
        return x < r.left + r.width / 2;
      });
      return { index: i < 0 ? tabs.length : i, zone: null };
    }
    return { index: null, zone: null };
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
