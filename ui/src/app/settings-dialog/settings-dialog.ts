import { ChangeDetectionStrategy, Component, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALECT_LABEL, type SettingsImportResult, type SettingsPreview } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { secretStore } from '../core/platform';
import { AppState } from '../core/state';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly mode = signal<'export' | 'import' | null>(null);

  open(mode: 'export' | 'import'): void {
    this.mode.set(mode);
  }
}

type Action = 'new' | 'replace' | 'skip';
type PreviewConnection = SettingsPreview['connections'][number];

/** Mindestlänge des Export-Passworts (wie im Hauptprozess) */
const MIN_PASSWORD = 8;
const fmt = new Intl.NumberFormat('de-CH');

/** Einstellungen als Datei: Verbindungen, gespeicherte Abfragen, wahlweise Verlauf; Import mit Vorschau und Abgleich */
@Component({
  selector: 'app-settings-dialog',
  imports: [FormsModule, Icon, Modal],
  templateUrl: './settings-dialog.html',
  styleUrls: ['../export-dialog/export-dialog.scss', './settings-dialog.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsDialog {
  protected svc = inject(SettingsService);
  protected state = inject(AppState);
  protected readonly dialectLabel = DIALECT_LABEL;
  protected readonly secretStore = secretStore;
  protected readonly minPassword = MIN_PASSWORD;

  // Export
  protected chosen = signal<ReadonlySet<string>>(new Set());
  protected withQueries = signal(true);
  protected withHistory = signal(false);
  protected withPasswords = signal(false);
  protected password = signal('');
  protected password2 = signal('');
  protected queryCount = signal<number | null>(null);
  /** Verlaufseinträge je Verbindung (nur Anzahlen, nicht der SQL-Text) */
  private historyCounts = signal<Record<string, number>>({});
  protected savedFile = signal<string | null>(null);

  // Import
  protected file = signal('');
  protected preview = signal<SettingsPreview | null>(null);
  protected importPassword = signal('');
  protected actions = signal<Record<number, Action>>({});
  protected importQueries = signal(true);
  protected importHistory = signal(true);
  protected result = signal<SettingsImportResult | null>(null);

  protected busy = signal(false);
  protected error = signal<string | null>(null);

  protected readonly historyCount = computed(() => {
    const counts = this.historyCounts();
    return [...this.chosen()].reduce((n, id) => n + (counts[id] ?? 0), 0);
  });
  protected readonly passwordProblem = computed(() => {
    if (!this.withPasswords()) return null;
    if (this.password().length < MIN_PASSWORD) return `Das Export-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`;
    if (this.password() !== this.password2()) return 'Die beiden Passwörter stimmen nicht überein.';
    return null;
  });
  /** wie viel der Import übernehmen würde */
  protected readonly importCount = computed(() => {
    const p = this.preview();
    if (!p) return 0;
    const conns = p.connections.filter((c) => (this.actions()[c.index] ?? 'skip') !== 'skip').length;
    return conns + (this.importQueries() ? p.savedQueries.fresh : 0) + (this.importHistory() ? p.history.fresh : 0);
  });

  constructor() {
    effect(() => {
      const mode = this.svc.mode();
      untracked(() => {
        this.error.set(null);
        this.busy.set(false);
        this.savedFile.set(null);
        this.withPasswords.set(false);
        this.password.set('');
        this.password2.set('');
        this.file.set('');
        this.preview.set(null);
        this.importPassword.set('');
        this.actions.set({});
        this.result.set(null);
        this.historyCounts.set({});
        if (mode === 'export') void this.initExport();
      });
    });
  }

  private async initExport() {
    this.chosen.set(new Set(this.state.connections().map((c) => c.id)));
    this.queryCount.set(null);
    try {
      const [queries, counts] = await Promise.all([api.listSavedQueries(), api.historyCounts()]);
      this.queryCount.set(queries.length);
      this.historyCounts.set(counts);
    } catch (e) {
      this.error.set(message(e));
    }
  }

  protected fmtNum(n: number): string {
    return fmt.format(n);
  }

  // ---------- Export ----------

  protected toggle(id: string, on: boolean) {
    const s = new Set(this.chosen());
    if (on) s.add(id);
    else s.delete(id);
    this.chosen.set(s);
  }

  protected setAll(on: boolean) {
    this.chosen.set(new Set(on ? this.state.connections().map((c) => c.id) : []));
  }

  protected async doExport() {
    if (this.passwordProblem() || !this.chosen().size) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const file = await api.exportSettings({
        connectionIds: [...this.chosen()],
        savedQueries: this.withQueries(),
        history: this.withHistory(),
        password: this.withPasswords() ? this.password() : undefined,
      });
      if (file) this.savedFile.set(file);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected showFile(f: string) {
    void api.showInFolder(f);
  }

  // ---------- Import ----------

  protected async pick() {
    const f = await api.pickFile('settings', this.file() || undefined);
    if (!f) return;
    this.file.set(f);
    this.preview.set(null);
    this.importPassword.set('');
    this.actions.set({});
    this.result.set(null);
    await this.load();
  }

  private async load(password?: string) {
    this.busy.set(true);
    this.error.set(null);
    try {
      const p = await api.previewSettings(this.file(), password || undefined);
      const before = this.actions();
      // Vorschlag: anlegen, wenn es nichts Passendes gibt, sonst überspringen – ersetzt wird nur auf Wunsch
      this.actions.set(Object.fromEntries(p.connections.map((c) => [c.index, before[c.index] ?? (c.match ? 'skip' : 'new')])));
      if (!this.preview()) {
        this.importQueries.set(p.savedQueries.fresh > 0);
        this.importHistory.set(p.history.fresh > 0);
      }
      this.preview.set(p);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected unlock() {
    if (this.importPassword()) void this.load(this.importPassword());
  }

  protected setAction(index: number, action: Action) {
    this.actions.update((a) => ({ ...a, [index]: action }));
  }

  protected statusText(c: PreviewConnection): string {
    if (!c.match) return 'neu';
    const how = c.match.by === 'id' ? 'dieselbe Verbindung' : c.match.by === 'name' ? 'gleicher Name wie' : 'gleicher Server wie';
    const which = c.match.by === 'id' && c.match.name === c.name ? '' : ` „${c.match.name}“`;
    return c.match.differences.length ? `${how}${which}, aber anders: ${c.match.differences.join(', ')}` : `${how}${which}, unverändert`;
  }

  protected async doImport() {
    const p = this.preview();
    if (!p || !this.importCount()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api.importSettings({
        file: p.file,
        password: p.secretsOpen ? this.importPassword() : undefined,
        connections: p.connections.map((c) => ({ index: c.index, action: this.actions()[c.index] ?? 'skip' })),
        savedQueries: this.importQueries() && p.savedQueries.fresh > 0,
        history: this.importHistory() && p.history.fresh > 0,
      });
      this.result.set(r);
      await this.state.reloadConnections();
      // ersetzte Verbindungen: Baum und Status zeigten sonst weiter den alten Server
      for (const c of p.connections) if (this.actions()[c.index] === 'replace' && c.match) this.state.resetConnection(c.match.id);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected resultText(r: SettingsImportResult): string {
    const parts = [
      `${r.created} Verbindung${r.created === 1 ? '' : 'en'} angelegt`,
      ...(r.replaced ? [`${r.replaced} ersetzt`] : []),
      ...(r.skipped ? [`${r.skipped} übersprungen`] : []),
      ...(r.failed ? [`${r.failed} fehlgeschlagen`] : []),
      ...(r.savedQueries ? [`${r.savedQueries} gespeicherte Abfrage${r.savedQueries === 1 ? '' : 'n'}`] : []),
      ...(r.history ? [`${fmt.format(r.history)} Verlaufseinträge`] : []),
    ];
    return parts.join(' · ') + '.';
  }

  // ---------- Dialog ----------

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget && !this.busy()) this.close();
  }

  protected close() {
    if (this.busy()) return;
    this.svc.mode.set(null);
  }
}
