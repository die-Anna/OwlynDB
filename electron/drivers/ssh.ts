import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Client, utils, type ConnectConfig } from 'ssh2';
import type { DriverConfig, SshSettings } from './common';
import { tunnelOptions } from './tunnel';

/** Hostschlüssel prüfen: true = bekannt oder bestätigt, false = abgelehnt; Fehler = Abbruch mit dieser Meldung */
export type HostKeyCheck = (hostId: string, keyType: string, fingerprint: string) => Promise<boolean>;

/** Name des SSH-Servers für die Hostschlüssel-Liste; der SNI-Name unterscheidet Ziele hinter demselben Proxy */
export function sshHostId(s: SshSettings): string {
  return `${s.tls && s.servername ? s.servername + '@' : ''}${s.host}:${s.port}`;
}

/** wie ssh: SHA256:<Base64 ohne => */
export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function keyType(key: Buffer): string {
  const n = key.length >= 4 ? key.readUInt32BE(0) : 0;
  return n > 0 && n < 64 && key.length >= 4 + n ? key.subarray(4, 4 + n).toString('latin1') : 'unbekannt';
}

/**
 * Wie `ssh -L`: lokaler Port auf 127.0.0.1, jede Verbindung dorthin geht über SSH an das Ziel
 * (Datenbank aus Sicht des SSH-Servers). Optional läuft SSH selbst in einem TLS-Tunnel
 * (wie `ProxyCommand openssl s_client -cert …`). Bricht SSH ab, baut die nächste Verbindung es neu auf.
 */
/** so alt darf ein gemerkter Tunnelfehler sein, um noch als Grund des aktuellen Verbindungsversuchs zu gelten */
const ERROR_FRESH_MS = 30_000;
/** Zeit für SSH-Handshake und Anmeldung – die Hostschlüssel-Rückfrage zählt nicht mit */
const READY_TIMEOUT_MS = 20_000;

export class SshForward {
  private server = net.createServer((sock) => void this.forward(sock).catch(() => sock.destroy()));
  private client?: Client;
  /** Client im Aufbau (noch nicht ready): close() muss auch ihn beenden */
  private pending?: Client;
  private connecting?: Promise<Client>;
  private sockets = new Set<net.Socket>();
  /** letzter Fehler beim Weiterleiten; der Treiber sieht nur einen abgerissenen Socket */
  private lastError?: { at: number; error: Error };
  closed = false;
  port = 0;

  private constructor(
    private cfg: DriverConfig,
    private ssh: SshSettings,
    private checkHostKey: HostKeyCheck,
  ) {}

  static async open(cfg: DriverConfig, checkHostKey: HostKeyCheck): Promise<SshForward> {
    const f = new SshForward(cfg, cfg.ssh!, checkHostKey);
    try {
      // erst SSH aufbauen: Anmelde- und Zertifikatsfehler kommen so verständlich beim Verbinden
      await f.ensure();
      await new Promise<void>((resolve, reject) => {
        f.server.once('error', reject);
        f.server.listen(0, '127.0.0.1', () => {
          f.server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      // sonst bliebe eine angemeldete SSH-Sitzung samt Keepalive ohne Besitzer offen
      await f.close().catch(() => undefined);
      throw e;
    }
    f.port = (f.server.address() as net.AddressInfo).port;
    return f;
  }

  private ensure(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    if (this.closed) throw new Error('SSH-Tunnel ist geschlossen.');
    const s = this.ssh;
    const privateKey = this.usableKey();
    const passwordAuth = !!s.secret && (!privateKey || !!s.defaultKey);
    const sock = s.tls ? await this.openTls() : undefined;
    const c = new Client();
    this.pending = c;
    let refused: Error | undefined;
    const hostId = sshHostId(s);
    // eigene Frist statt readyTimeout: die läuft in ssh2 auch während der Hostschlüssel-Rückfrage, und der Vergleich des
    // Fingerabdrucks dauert länger als 20 s
    let timer: NodeJS.Timeout | undefined;
    let fail: (e: Error) => void = () => undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`SSH-Server ${hostId} antwortet nicht (Zeitüberschreitung).`)), READY_TIMEOUT_MS);
    };
    const opts: ConnectConfig = {
      host: s.host,
      port: s.port,
      sock,
      username: s.username,
      privateKey,
      passphrase: privateKey && s.secret ? s.secret : undefined,
      // mit angegebenem Schlüssel ist das Geheimnis dessen Passwort – es ginge sonst als Benutzerpasswort an den Server;
      // bei einem Standardschlüssel aus ~/.ssh ist es das Benutzerpasswort und bleibt der Rückfall, wenn der Server den
      // Schlüssel nicht kennt (wie bei ssh selbst) – sonst scheiterte jede Passwort-Verbindung, sobald ein id_* in ~/.ssh liegt
      password: passwordAuth ? s.secret : undefined,
      tryKeyboard: passwordAuth,
      readyTimeout: 0,
      // hält auch einen Proxy davor im Leerlauf offen
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        // Rückfrage läuft: die Frist pausiert
        clearTimeout(timer);
        this.checkHostKey(hostId, keyType(key), fingerprint(key)).then(
          (ok) => {
            if (!ok) refused = new Error(`Hostschlüssel von ${hostId} nicht bestätigt – Verbindung abgebrochen.`);
            else arm();
            verify(ok);
          },
          (e: Error) => {
            refused = e;
            verify(false);
          },
        );
      },
    };
    if (passwordAuth) {
      // Tastatur-Abfrage (manche Server fragen das Passwort nur so ab) – nur auf Fragen nach dem Passwort antworten
      c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map((p) => (/pass|kennwort/i.test(p.prompt) ? s.secret! : ''))));
    }
    return new Promise<Client>((resolve, reject) => {
      let ready = false;
      const done = () => {
        clearTimeout(timer);
        if (this.pending === c) this.pending = undefined;
      };
      fail = (e) => {
        if (ready) return;
        ready = true;
        done();
        c.end();
        sock?.destroy();
        reject(e);
      };
      c.once('ready', () => {
        if (ready) return;
        ready = true;
        done();
        if (this.closed) {
          // close() kam während des Aufbaus
          c.end();
          reject(new Error('SSH-Tunnel ist geschlossen.'));
          return;
        }
        this.client = c;
        resolve(c);
      });
      c.on('error', (e) => {
        if (!ready) {
          done();
          sock?.destroy();
          reject(refused ?? sshError(e, hostId, !!s.tls));
        } else {
          // Keepalive-Timeout, Socketfehler: Grund für die nächste Meldung merken
          this.noteError(sshError(e, hostId, !!s.tls));
        }
      });
      c.once('close', () => {
        if (this.client === c) this.client = undefined;
        if (!ready) {
          done();
          reject(refused ?? new Error(`SSH-Verbindung zu ${hostId} wurde geschlossen.`));
        }
      });
      arm();
      try {
        c.connect(opts);
      } catch (e) {
        // ssh2 wirft synchron (z. B. Schlüsseldatei ohne privaten Schlüssel)
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private noteError(e: Error): void {
    this.lastError = { at: Date.now(), error: e };
  }

  /** Schlüssel vorab prüfen: verständliche Meldung statt „Cannot parse privateKey“ */
  private usableKey(): string | undefined {
    const s = this.ssh;
    if (!s.privateKey) return undefined;
    const k = utils.parseKey(s.privateKey, s.secret);
    if (!(k instanceof Error)) {
      // ein öffentlicher Schlüssel (id_ed25519.pub) parst fehlerfrei – ssh2 würfe erst beim Verbinden
      const key = Array.isArray(k) ? k[0] : k;
      if (!key || !key.getPrivatePEM()) throw new Error('Die SSH-Schlüsseldatei enthält keinen privaten Schlüssel (nur den öffentlichen?).');
      return s.privateKey;
    }
    // Standardschlüssel aus ~/.ssh passt nicht (z. B. anderes Passwort): wie ssh mit dem Passwort weiter
    if (s.defaultKey && s.secret) return undefined;
    if (/no passphrase/i.test(k.message)) throw new Error('Der SSH-Schlüssel ist mit einem Passwort geschützt; bitte SSH-Passwort angeben.');
    if (/passphrase/i.test(k.message)) throw new Error('Das Passwort des SSH-Schlüssels ist falsch.');
    throw new Error(`SSH-Schlüssel nicht lesbar (${k.message}). Erwartet wird ein OpenSSH- oder PEM-Schlüssel.`);
  }

  /** Fehler der letzten Weiterleitung abholen (und löschen) – nur einen frischen, kein alter Grund aus einer früheren Störung */
  takeError(): Error | undefined {
    const e = this.lastError;
    this.lastError = undefined;
    return e && Date.now() - e.at < ERROR_FRESH_MS ? e.error : undefined;
  }

  private openTls(): Promise<tls.TLSSocket> {
    const s = this.ssh;
    return new Promise((resolve, reject) => {
      const t = tls.connect(tunnelOptions(s.host, s.port, this.cfg.tls, s.servername));
      let timer: NodeJS.Timeout | undefined;
      const fail = (e: Error) => {
        clearTimeout(timer);
        t.destroy();
        reject(tlsError(e, `${s.host}:${s.port}`));
      };
      // ein Handshake, der nie fertig wird, blockierte sonst für immer (readyTimeout von ssh2 gilt hier noch nicht)
      timer = setTimeout(() => fail(Object.assign(new Error('TLS-Handshake nicht abgeschlossen (Zeitüberschreitung).'), { code: 'ETIMEDOUT' })), READY_TIMEOUT_MS);
      t.once('error', fail);
      t.once('secureConnect', () => {
        clearTimeout(timer);
        t.off('error', fail);
        resolve(t);
      });
    });
  }

  private async forward(sock: net.Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => undefined);
    // bis der Kanal steht, puffert der Socket die Daten des Treibers
    sock.pause();
    let client: Client;
    try {
      client = await this.ensure();
    } catch (e) {
      this.noteError(e as Error);
      sock.destroy();
      return;
    }
    if (sock.destroyed) return;
    try {
      client.forwardOut('127.0.0.1', sock.remotePort ?? 0, this.cfg.host, this.cfg.port, (err, ch) => {
        if (err) {
          // „Not connected“/„No response“: der SSH-Client selbst ist weg, nicht das Ziel
          const dead = /not connected|no response|closed/i.test(err.message);
          this.noteError(dead ? new Error(`SSH-Verbindung zu ${sshHostId(this.ssh)} verloren (${err.message}) – sie wird beim nächsten Versuch neu aufgebaut.`) : new Error(`Der SSH-Server erreicht das Ziel ${this.cfg.host}:${this.cfg.port} nicht (${err.message}).`));
          if (dead && this.client === client) this.client = undefined;
          sock.destroy();
          return;
        }
        if (sock.destroyed) {
          // der Treiber hat inzwischen aufgegeben: Kanal nicht an einen toten Socket hängen
          ch.close();
          return;
        }
        this.lastError = undefined;
        ch.on('error', () => sock.destroy());
        ch.on('close', () => sock.destroy());
        sock.on('close', () => ch.close());
        sock.pipe(ch).pipe(sock);
        sock.resume();
      });
    } catch (e) {
      // ssh2 wirft synchron, wenn der SSH-Socket schon nicht mehr beschreibbar ist (vor dem 'close'): neu aufbauen lassen
      this.noteError(new Error(`SSH-Verbindung zu ${sshHostId(this.ssh)} verloren (${(e as Error).message}) – sie wird beim nächsten Versuch neu aufgebaut.`));
      if (this.client === client) this.client = undefined;
      sock.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    this.client?.end();
    this.client = undefined;
    // ein Client im Aufbau (Hostschlüssel-Dialog offen, langsamer Server) bliebe sonst mit Keepalive für immer verbunden
    this.pending?.end();
    this.pending = undefined;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function tlsError(e: Error & { code?: string }, where: string): Error {
  const m = e.message;
  if (/certificate required/i.test(m)) return new Error(`Der TLS-Proxy ${where} verlangt ein Client-Zertifikat – keins angegeben oder nicht angenommen.`);
  if (/alert.*(certificate|unknown ca)/i.test(m)) return new Error(`Der TLS-Proxy ${where} hat das Client-Zertifikat abgelehnt.`);
  if (e.code === 'ECONNREFUSED') return new Error(`TLS-Proxy ${where} nicht erreichbar (Verbindung abgelehnt).`);
  if (e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') return new Error(`TLS-Proxy ${where} nicht erreichbar (${e.code}).`);
  return new Error(`TLS zu ${where}: ${m}`);
}

function sshError(e: Error & { level?: string }, hostId: string, viaTls: boolean): Error {
  // TLS-Alarm des Proxys nach dem Handshake (TLS 1.3 meldet ein fehlendes Zertifikat erst dann)
  if (/SSL alert|ssl3_read_bytes/i.test(e.message)) return tlsError(e, hostId);
  if (/before handshake/i.test(e.message)) {
    return new Error(`Verbindung zu ${hostId} vor dem SSH-Handshake getrennt${viaTls ? ' – der Proxy hat sie wohl abgewiesen (SNI-Name, Client-Zertifikat?)' : ''}.`);
  }
  if (e.level === 'client-authentication') {
    return new Error(`SSH-Anmeldung an ${hostId} abgelehnt: Benutzer, Schlüssel oder Passwort prüfen.`);
  }
  if (e.level === 'client-timeout') return new Error(`SSH-Server ${hostId} antwortet nicht (Zeitüberschreitung).`);
  return new Error(`SSH zu ${hostId}: ${e.message}`);
}
