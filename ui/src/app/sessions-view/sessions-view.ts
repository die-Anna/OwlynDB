import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ServerSession, ServerSessionList } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { AppState, SessionsTab } from '../core/state';
import { Icon } from '../ui/icon';

/** so oft lädt die Liste neu, solange der Tab sichtbar ist */
const REFRESH_MS = 3000;

interface Row {
  s: ServerSession;
  /** Abfrage-Tab dieses Programms, z. B. "Abfrage 3" */
  tab?: string;
  tabId?: string;
  /** so viele andere Sitzungen warten auf diese */
  blocking: number;
  rank: number;
}

/** Sitzungen und laufende Abfragen des Servers: wer läuft, wer wartet, wer hält Sperren; Abbrechen und Beenden */
@Component({
  selector: 'app-sessions-view',
  imports: [FormsModule, Icon],
  templateUrl: './sessions-view.html',
  styleUrl: './sessions-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionsView {
  readonly tab = input.required<SessionsTab>();
  readonly active = input(false);
  protected state = inject(AppState);

  protected list = signal<ServerSessionList | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);
  protected notice = signal<string | null>(null);
  protected at = signal<Date | null>(null);
  protected auto = signal(true);
  protected hideIdle = signal(true);
  protected showSystem = signal(false);
  protected search = signal('');
  protected selectedId = signal<string | null>(null);
  private timer?: ReturnType<typeof setInterval>;

  protected readonly conn = computed(() => this.state.connection(this.tab().connectionId));
  protected readonly rows = computed<Row[]>(() => {
    const l = this.list();
    if (!l) return [];
    const waitingFor = new Map<string, number>();
    for (const s of l.sessions) for (const b of s.blockedBy) waitingFor.set(b, (waitingFor.get(b) ?? 0) + 1);
    return l.sessions
      .filter((s) => s.id !== l.self)
      .map((s) => {
        const sid = l.own[s.id];
        const t = sid ? this.state.tabOfSession(sid) : undefined;
        const blocking = waitingFor.get(s.id) ?? 0;
        const rank = s.system ? 5 : blocking ? 0 : s.blockedBy.length ? 1 : s.active ? 2 : s.txSeconds !== undefined ? 3 : 4;
        return { s, tab: t ? `Abfrage ${t.number}` : sid ? 'Abfrage-Tab' : undefined, tabId: t?.id, blocking, rank };
      })
      .sort((a, b) => a.rank - b.rank || (b.s.txSeconds ?? b.s.seconds ?? 0) - (a.s.txSeconds ?? a.s.seconds ?? 0) || Number(a.s.id) - Number(b.s.id));
  });
  protected readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.rows().filter((r) => this.why(r, q) === null);
  });
  /** ausgeblendet nach Grund: Systemprozesse, Leerlauf, Filter (die Meldungen unterscheiden das) */
  protected readonly hidden = computed(() => {
    const q = this.search().trim().toLowerCase();
    const n = { system: 0, idle: 0, filter: 0, all: 0 };
    for (const r of this.rows()) {
      const w = this.why(r, q);
      if (w) {
        n[w]++;
        n.all++;
      }
    }
    return n;
  });
  protected readonly hiddenText = computed(() => {
    const h = this.hidden();
    const parts = [h.idle ? `${h.idle} im Leerlauf` : '', h.system ? `${h.system} System` : '', h.filter ? `${h.filter} per Filter` : ''].filter(Boolean);
    return parts.length ? ` (${parts.join(', ')} ausgeblendet)` : '';
  });
  /** laufend aktualisieren ist an, die Verbindung aber nicht (mehr) verbunden: kein neues Anmelden im Takt */
  protected readonly paused = computed(() => this.auto() && this.active() && this.state.status()[this.tab().connectionId]?.state !== 'connected');
  protected readonly selected = computed(() => this.rows().find((r) => r.s.id === this.selectedId()) ?? null);
  protected readonly readOnly = computed(() => this.list()?.readOnly ?? !!this.conn()?.options?.readOnly);

  constructor() {
    // nur laden, solange der Tab sichtbar ist
    effect(() => {
      const on = this.active() && this.auto();
      untracked(() => {
        clearInterval(this.timer);
        this.timer = undefined;
        if (this.active() && !this.list()) void this.load();
        // im Takt nur bei bestehender Verbindung: sonst meldete sich der Tab alle 3 s neu an – nach einem falsch
        // gespeicherten Passwort bis zur Kontosperre; neu verbinden nur über „Aktualisieren“
        if (on) this.timer = setInterval(() => this.state.status()[this.tab().connectionId]?.state === 'connected' && void this.load(), REFRESH_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  protected async load() {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      await this.state.ensureConnected(this.tab().connectionId);
      this.list.set(await api.listServerSessions(this.tab().connectionId));
      this.at.set(new Date());
      this.error.set(null);
    } catch (e) {
      this.error.set(message(e));
      this.state.noteError(this.tab().connectionId, e);
    } finally {
      this.loading.set(false);
    }
  }

  /** warum eine Zeile nicht zu sehen ist; null = sichtbar */
  private why(r: Row, q: string): 'system' | 'idle' | 'filter' | null {
    if (r.rank === 5 && !this.showSystem()) return 'system';
    if (r.rank === 4 && this.hideIdle()) return 'idle';
    if (!q) return null;
    const s = r.s;
    return [s.id, s.user, s.database, s.program, s.client, s.state, s.query, r.tab].some((v) => v?.toLowerCase().includes(q)) ? null : 'filter';
  }

  protected select(r: Row) {
    this.selectedId.set(this.selectedId() === r.s.id ? null : r.s.id);
  }

  /** Abfrage abbrechen (Sitzung bleibt) bzw. Sitzung beenden (offene Transaktion wird zurückgerollt) */
  protected async kill(r: Row, mode: 'query' | 'session') {
    const l = this.list();
    if (!l) return;
    const s = r.s;
    const who = [s.user, s.client, s.program].filter(Boolean).join(' · ');
    const head = mode === 'query' ? `Abfrage von Sitzung ${s.id} abbrechen?` : `Sitzung ${s.id} beenden?`;
    const lines = [
      `${this.conn()?.name ?? ''}${s.database ? ' · ' + s.database : ''}`,
      who,
      ...(r.tab ? [`(${r.tab} in diesem Programm)`] : []),
      '',
      mode === 'query'
        ? 'Die laufende Abfrage wird abgebrochen, die Verbindung bleibt bestehen.'
        : 'Die Verbindung wird getrennt' +
          (s.txSeconds !== undefined ? `; ihre offene Transaktion (seit ${this.duration(s.txSeconds)}) wird zurückgerollt.` : '.'),
      ...(s.query ? ['', s.query.replace(/\s+/g, ' ').trim().slice(0, 200)] : []),
    ];
    if (!confirm(`${head}\n\n${lines.join('\n')}`)) return;
    try {
      await api.killServerSession(this.tab().connectionId, { id: s.id, started: s.started, server: l.server }, mode);
      this.notice.set(mode === 'query' ? `Abfrage von Sitzung ${s.id} abgebrochen.` : `Sitzung ${s.id} beendet.`);
      this.error.set(null);
    } catch (e) {
      this.error.set(message(e));
    }
    await this.load();
  }

  protected openQuery(r: Row) {
    if (r.s.query) this.state.openQuery(this.tab().connectionId, r.s.database, r.s.query);
  }

  protected goToTab(r: Row) {
    if (r.tabId) this.state.activeId.set(r.tabId);
  }

  protected duration(sec: number | undefined): string {
    if (sec === undefined || !Number.isFinite(sec)) return '';
    if (sec < 10) return `${(Math.round(sec * 10) / 10).toFixed(1)} s`;
    if (sec < 60) return `${Math.round(sec)} s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} min ${Math.round(sec % 60)} s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ${m % 60} min`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  /** lange Läufe und lange offene Transaktionen hervorheben */
  protected level(sec: number | undefined): string {
    if (sec === undefined) return '';
    return sec >= 600 ? 'bad' : sec >= 60 ? 'warn' : '';
  }

  protected time(d: Date | null): string {
    return d ? d.toLocaleTimeString('de-CH') : '';
  }

  protected oneLine(q: string | undefined): string {
    return q ? q.replace(/\s+/g, ' ').trim() : '';
  }
}
