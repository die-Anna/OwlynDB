import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DEFAULT_PORT, DIALECT_LABEL, SHORT_MAX, type ConnectionInput, type ConnectionOptions, type Dialect } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { AppState } from '../core/state';
import { badgeInk } from '../ui/conn-badge';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

const COLORS = ['', '#d64545', '#e08a1e', '#d6b11f', '#3aa57a', '#3d8fd1', '#8a7bd0'];

function blank(): ConnectionInput {
  return { name: '', dialect: 'mysql', host: 'localhost', port: 3306, user: '', password: '', database: '', options: {}, color: '' };
}

@Component({
  selector: 'app-connection-dialog',
  imports: [FormsModule, Icon, Modal],
  templateUrl: './connection-dialog.html',
  styleUrl: './connection-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionDialog {
  protected state = inject(AppState);
  protected readonly dialects = Object.entries(DIALECT_LABEL) as [Dialect, string][];
  protected readonly colors = COLORS;
  protected readonly defaultPort = DEFAULT_PORT;
  protected readonly shortMax = SHORT_MAX;
  protected readonly ink = badgeInk;

  protected form = signal<ConnectionInput>(blank());
  /** beim Bearbeiten: Passwort nur ändern, wenn das Feld angefasst wurde */
  protected passwordTouched = signal(false);
  protected hasStoredPassword = signal(false);
  protected passphraseTouched = signal(false);
  protected hasStoredPassphrase = signal(false);
  protected sshSecretTouched = signal(false);
  protected hasStoredSshSecret = signal(false);
  protected busy = signal(false);
  protected result = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly isNew = computed(() => this.state.editing() === '');
  /** Elasticsearch: HTTPS statt TLS/SSL, wahlweise API-Key, keine Datenbank, immer nur lesen */
  protected readonly es = computed(() => this.form().dialect === 'elasticsearch');
  protected readonly apiKey = computed(() => this.es() && !!this.form().options?.apiKey);
  /** Name ohne Eingabe: wie der Platzhalter – ohne Benutzer (Elasticsearch ohne Anmeldung, API-Key) nur der Server */
  protected readonly defaultName = computed(() => {
    const f = this.form();
    const user = this.apiKey() ? '' : f.user.trim();
    const host = f.host.trim() || 'server';
    return user ? `${user}@${host}` : host;
  });
  /** SQL Server ohne Verschlüsselung: Passwort (nur verschleiert) und Daten gehen im Klartext über das Netz */
  protected readonly plainMssql = computed(() => this.form().dialect === 'mssql' && !this.form().options?.encrypt && !this.form().options?.tunnel);
  /** Laufnummer von Testen und Speichern: eine späte Antwort trifft nicht den inzwischen neu geöffneten Dialog */
  private seq = 0;

  constructor() {
    effect(() => {
      const id = this.state.editing();
      untracked(() => {
        this.seq++;
        this.busy.set(false);
        this.result.set(null);
        this.passwordTouched.set(false);
        this.passphraseTouched.set(false);
        this.sshSecretTouched.set(false);
        if (id === null) {
          // geschlossen: getippte Passwörter nicht bis zum nächsten Öffnen im Speicher halten
          this.form.set(blank());
          this.hasStoredPassword.set(false);
          this.hasStoredPassphrase.set(false);
          this.hasStoredSshSecret.set(false);
          return;
        }
        const c = id ? this.state.connection(id) : undefined;
        if (c) {
          const { hasPassword, hasKeyPassphrase, hasSshSecret, ...rest } = c;
          this.form.set({ ...rest, options: { ...c.options }, password: '', keyPassphrase: '', sshSecret: '' });
          this.hasStoredPassword.set(hasPassword);
          this.hasStoredPassphrase.set(!!hasKeyPassphrase);
          this.hasStoredSshSecret.set(!!hasSshSecret);
        } else {
          this.form.set(blank());
          this.hasStoredPassword.set(false);
          this.hasStoredPassphrase.set(false);
          this.hasStoredSshSecret.set(false);
        }
      });
    });
  }

  protected patch(p: Partial<ConnectionInput>) {
    this.form.update((f) => ({ ...f, ...p }));
    this.result.set(null);
  }

  protected setDialect(d: Dialect) {
    const f = this.form();
    const port = f.port === DEFAULT_PORT[f.dialect] || !f.port ? DEFAULT_PORT[d] : f.port;
    // Elasticsearch: ohne SSH ersetzt HTTPS den TLS-Tunnel (sonst blieben dessen Einstellungen unsichtbar wirksam); mit SSH
    // bleibt er – dann läuft SSH durch den TLS-Proxy
    // SQL Server: verschlüsselt (sonst ginge das Passwort im Klartext über das Netz); selbst signierte Zertifikate
    // akzeptiert, wie sie in Firmennetzen üblich sind – abschaltbar
    const options =
      d === 'mssql'
        ? { encrypt: true, trustServerCertificate: true, ...f.options }
        : d === 'elasticsearch'
          ? { ...f.options, tunnel: !!f.options?.ssh && !!f.options?.tunnel }
          : f.options;
    this.patch({ dialect: d, port, options });
  }

  protected setOption<K extends keyof ConnectionOptions>(k: K, v: ConnectionOptions[K]) {
    this.patch({ options: { ...this.form().options, [k]: v } });
  }

  /** SSH an/aus; bei Elasticsearch gibt es den TLS-Tunnel nur für SSH (ohne SSH: HTTPS) – mit SSH fällt er weg */
  protected setSsh(on: boolean) {
    const o = this.form().options;
    this.patch({ options: { ...o, ssh: on, ...(this.es() && !on ? { tunnel: false } : {}) } });
  }

  /** TLS-Einstellungen anzeigen: Tunnel, MySQL/PostgreSQL mit SSL, SQL Server mit Verschlüsselung */
  protected readonly tlsOn = computed(() => {
    const f = this.form();
    return !!f.options?.tunnel || (f.dialect === 'mssql' ? !!f.options?.encrypt : !!f.options?.ssl);
  });
  /** Client-Zertifikat möglich: immer im Tunnel, sonst nur MySQL/PostgreSQL */
  protected readonly certPossible = computed(() => !!this.form().options?.tunnel || this.form().dialect !== 'mssql');
  /** Client-Zertifikat als PKCS#12 (.p12/.pfx): Schlüssel steckt darin, das Schlüssel-Passwort ist das der Datei */
  protected readonly p12 = computed(() => /\.(p12|pfx)$/i.test((this.form().options?.certFile ?? '').trim()));

  protected async pick(field: 'caFile' | 'certFile' | 'keyFile' | 'sshKeyFile') {
    const kind = field === 'sshKeyFile' ? 'ssh' : field === 'keyFile' ? 'key' : field === 'certFile' ? 'clientCert' : 'cert';
    const file = await api.pickFile(kind, this.form().options?.[field]);
    if (file) this.setOption(field, file);
  }

  private payload(): ConnectionInput {
    const f = this.form();
    // leeres Feld = Standardport des Typs; sonst eine ganze Zahl von 1 bis 65535 (Port 0 verwarf der Import still)
    const port = f.port === null || f.port === undefined || String(f.port).trim() === '' ? DEFAULT_PORT[f.dialect] : Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Der Port muss eine ganze Zahl von 1 bis 65535 sein.');
    const p: ConnectionInput = { ...f, name: f.name.trim() || this.defaultName(), port };
    // unverändertes Passwortfeld beim Bearbeiten: gespeichertes behalten
    if (!this.isNew() && !this.passwordTouched()) delete p.password;
    if (!this.isNew() && !this.passphraseTouched()) delete p.keyPassphrase;
    if (!this.isNew() && !this.sshSecretTouched()) delete p.sshSecret;
    if (p.options?.ssh) p.options = { ...p.options, sshPort: Number(p.options.sshPort) || 22 };
    // PKCS#12: der Schlüssel steckt in der Datei – ein früher gewählter PEM-Schlüssel gälte sonst zusätzlich (Feld gesperrt)
    if (this.p12() && p.options?.keyFile) p.options = { ...p.options, keyFile: '' };
    // Elasticsearch hat keine Datenbank (das Feld ist ausgeblendet, ein Wert vom vorherigen Typ bliebe sonst hängen)
    if (p.dialect === 'elasticsearch') p.database = '';
    return p;
  }

  protected async test() {
    const my = ++this.seq;
    this.busy.set(true);
    this.result.set(null);
    try {
      const info = await api.testConnection(this.payload());
      if (my === this.seq) this.result.set({ ok: true, text: 'Verbindung klappt: ' + info.version.split('\n')[0] });
    } catch (e) {
      if (my === this.seq) this.result.set({ ok: false, text: message(e) });
    } finally {
      if (my === this.seq) this.busy.set(false);
    }
  }

  protected async save() {
    const my = ++this.seq;
    this.busy.set(true);
    try {
      const saved = await api.saveConnection(this.payload());
      this.state.connections.set(await api.listConnections());
      // Zugangsdaten geändert: Status zurücksetzen, Baum lädt neu
      this.state.resetConnection(saved.id);
      // inzwischen ein anderer Dialog offen: den nicht schließen
      if (my === this.seq) this.state.editing.set(null);
    } catch (e) {
      if (my === this.seq) this.result.set({ ok: false, text: message(e) });
    } finally {
      if (my === this.seq) this.busy.set(false);
    }
  }

  /**
   * Beim Bearbeiten: die Eingaben als neue Verbindung speichern, die bisherige bleibt unverändert. Die Kopie übernimmt die
   * gespeicherten Passwörter des Originals (ein unangefasstes Passwortfeld lässt payload() weg) und bekommt den Namen
   * „… (Kopie)“, wenn der Name nicht geändert wurde.
   */
  protected async saveAsCopy() {
    // zoneless: der Knopf wird erst beim nächsten Rendern gesperrt – ein zweiter Aufruf legte sonst eine zweite Kopie an
    if (this.busy()) return;
    const original = this.state.connection(this.state.editing() ?? '');
    if (!original) return;
    const my = ++this.seq;
    this.busy.set(true);
    let copyId: string | undefined;
    try {
      const p = this.payload();
      const copy = await api.duplicateConnection(original.id);
      copyId = copy.id;
      const saved = await api.saveConnection({ ...p, id: copy.id, name: p.name === original.name ? copy.name : p.name });
      copyId = undefined;
      this.state.connections.set(await api.listConnections());
      this.state.resetConnection(saved.id);
      this.state.currentConnection.set(saved.id);
      if (my === this.seq) this.state.editing.set(null);
    } catch (e) {
      // Kopie schon angelegt, Speichern gescheitert (z. B. Server nur aus Leerzeichen): nichts Halbes zurücklassen
      if (copyId) await api.deleteConnection(copyId).catch(() => undefined);
      if (my === this.seq) this.result.set({ ok: false, text: message(e) });
    } finally {
      if (my === this.seq) this.busy.set(false);
    }
  }

  /** nur Klick auf den Hintergrund schließt (kein Rückgabewert: false würde Angular als preventDefault werten) */
  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }

  protected close() {
    this.state.editing.set(null);
  }
}
