import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { SHORT_MAX, type ConnectionInput, type ConnectionOptions, type SavedConnection } from '../shared/api-types';
import type { DriverConfig } from './drivers';
import type { SshSettings, TlsMaterial } from './drivers/common';

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(enc: string): string;
}

interface StoredConnection extends Omit<SavedConnection, 'hasPassword' | 'hasKeyPassphrase' | 'hasSshSecret'> {
  /** verschlüsselt (Windows: DPAPI über Electron safeStorage), Base64 */
  passwordEnc?: string;
  /** Passwort des Client-Schlüssels, ebenso verschlüsselt */
  keyPassphraseEnc?: string;
  /** SSH-Passwort bzw. Passwort des SSH-Schlüssels, ebenso verschlüsselt */
  sshSecretEnc?: string;
}

/** Verbindungen als JSON im Benutzerprofil; Passwörter nur verschlüsselt. */
export class ConnectionStore {
  private cache?: StoredConnection[];
  private loading?: Promise<StoredConnection[]>;
  /** schreibende Aufrufe nacheinander – sonst läse ein zweites save() den Stand vor dem ersten und überschriebe ihn */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private file: string,
    private box: SecretBox,
  ) {}

  /** Ordner im Profil, in dem auch Verlauf und gespeicherte Abfragen liegen */
  get dir(): string {
    return path.dirname(this.file);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writing.then(fn, fn);
    this.writing = run.catch(() => undefined);
    return run;
  }

  /**
   * Liste lesen. Leer oder beschädigt (z. B. Stromausfall kurz nach dem Speichern): den vorigen Stand aus der Sicherung
   * (.bak) nehmen und die kaputte Datei daneben aufheben; ohne Sicherung eine klare Meldung statt eines SyntaxError bei
   * jedem Aufruf. Eine leere Datei ohne Sicherung gilt als leer – sonst ließe sich nie mehr etwas anlegen.
   */
  private load(): Promise<StoredConnection[]> {
    if (this.cache) return Promise.resolve(this.cache);
    // gleichzeitige erste Aufrufe lesen (und reparieren) nur einmal
    return (this.loading ??= this.loadNow().finally(() => (this.loading = undefined)));
  }

  private async loadNow(): Promise<StoredConnection[]> {
    const main = await readJson(this.file, Array.isArray);
    if (main.ok) return (this.cache = (main.value as StoredConnection[] | undefined) ?? []);
    const bak = await readJson(this.file + '.bak', Array.isArray);
    // eine leere Sicherung ersetzt keine beschädigte Datei mit Inhalt
    if (bak.ok && Array.isArray(bak.value) && (bak.value.length || !main.text.trim())) {
      if (main.text.trim()) await fs.rename(this.file, `${this.file}.defekt-${Date.now()}`);
      await this.persist(bak.value as StoredConnection[]);
      return this.cache!;
    }
    if (!main.text.trim()) return (this.cache = []);
    throw new Error(
      `Die gespeicherten Verbindungen sind beschädigt: ${this.file} (${main.error}). Bitte die Datei reparieren oder umbenennen – OwlynDB legt dann eine neue an.`,
    );
  }

  private async persist(list: StoredConnection[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // voriger, gültig gelesener Stand als Sicherung
    if (this.cache) await fs.copyFile(this.file, this.file + '.bak').catch(() => undefined);
    await writeAtomic(this.file, JSON.stringify(list, null, 2));
    this.cache = list;
  }

  /** gespeichertes Geheimnis entschlüsseln; auf einem anderen PC bzw. für einen anderen Benutzer geht das nicht (DPAPI) */
  private open(enc: string, what: string): string {
    try {
      return this.box.decrypt(enc);
    } catch {
      throw new Error(`${what} lässt sich auf diesem PC nicht entschlüsseln (Profil von einem anderen PC oder Benutzer?) – bitte in der Verbindung neu eingeben.`);
    }
  }

  private toPublic({ passwordEnc, keyPassphraseEnc, sshSecretEnc, ...c }: StoredConnection): SavedConnection {
    return { ...c, hasPassword: !!passwordEnc, hasKeyPassphrase: !!keyPassphraseEnc, hasSshSecret: !!sshSecretEnc };
  }

  /** undefined = alten Wert behalten, '' = löschen, sonst neu verschlüsseln */
  private secret(input: string | undefined, prev: string | undefined): string | undefined {
    if (input === undefined) return prev;
    return input === '' ? undefined : this.box.encrypt(input);
  }

  async list(): Promise<SavedConnection[]> {
    return (await this.load()).map((c) => this.toPublic(c));
  }

  /** keepId: neue Verbindung bekommt input.id (Import von einem anderen PC – der Verlauf verweist darauf) */
  save(input: ConnectionInput, keepId = false): Promise<SavedConnection> {
    return this.serial(() => this.saveNow(input, keepId));
  }

  private async saveNow(input: ConnectionInput, keepId: boolean): Promise<SavedConnection> {
    const list = [...(await this.load())];
    const idx = input.id ? list.findIndex((c) => c.id === input.id) : -1;
    const prev = idx >= 0 ? list[idx] : undefined;
    const { password, keyPassphrase, sshSecret, ...rest } = input;
    // aus einer Mail kopiert: ein Leerzeichen oder Zeilenende am Rand liefe sonst bis zum Server („ENOTFOUND“, „Access denied for 'root '“)
    rest.host = rest.host.trim();
    rest.user = rest.user.trim();
    if (rest.database !== undefined) rest.database = rest.database.trim();
    // Kürzel für die Tabs: kurz und ohne Rand, leer = keins
    if (rest.short !== undefined) rest.short = rest.short.trim().slice(0, SHORT_MAX) || undefined;
    if (!rest.host) throw new Error('Bitte einen Server angeben.');
    const stored: StoredConnection = {
      ...rest,
      id: prev?.id ?? (keepId && input.id ? input.id : randomUUID()),
      passwordEnc: this.secret(password, prev?.passwordEnc),
      keyPassphraseEnc: this.secret(keyPassphrase, prev?.keyPassphraseEnc),
      sshSecretEnc: this.secret(sshSecret, prev?.sshSecretEnc),
    };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    await this.persist(list);
    return this.toPublic(stored);
  }

  /**
   * Kopie einer gespeicherten Verbindung: alle Einstellungen und die verschlüsselten Geheimnisse unverändert (gleicher
   * Benutzer, gleicher PC – DPAPI entschlüsselt sie auch für die Kopie), neue ID, Name „… (Kopie)“ bzw. „… (Kopie 2)“ usw.
   * Sie steht direkt hinter dem Original. Verlauf und gespeicherte Abfragen gehören zur ID und bleiben beim Original.
   */
  duplicate(id: string): Promise<SavedConnection> {
    return this.serial(async () => {
      const list = [...(await this.load())];
      const idx = list.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error('Verbindung nicht gefunden.');
      const orig = list[idx];
      // eine Kopie der Kopie heißt „… (Kopie 2)“ statt „… (Kopie) (Kopie)“
      const base = orig.name.replace(/ \(Kopie(?: \d+)?\)$/, '');
      const taken = new Set(list.map((c) => c.name));
      let name = `${base} (Kopie)`;
      for (let i = 2; taken.has(name); i++) name = `${base} (Kopie ${i})`;
      const copy: StoredConnection = { ...structuredClone(orig), id: randomUUID(), name };
      list.splice(idx + 1, 0, copy);
      await this.persist(list);
      return this.toPublic(copy);
    });
  }

  /** gespeicherte Passwörter im Klartext (nur für den verschlüsselten Export) */
  async secretsOf(id: string): Promise<{ password?: string; keyPassphrase?: string; sshSecret?: string }> {
    const c = (await this.load()).find((x) => x.id === id);
    if (!c) throw new Error('Verbindung nicht gefunden.');
    const out: { password?: string; keyPassphrase?: string; sshSecret?: string } = {};
    if (c.passwordEnc) out.password = this.open(c.passwordEnc, 'Das gespeicherte Passwort');
    if (c.keyPassphraseEnc) out.keyPassphrase = this.open(c.keyPassphraseEnc, 'Das gespeicherte Schlüssel-Passwort');
    if (c.sshSecretEnc) out.sshSecret = this.open(c.sshSecretEnc, 'Das gespeicherte SSH-Passwort');
    return out;
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => this.persist((await this.load()).filter((c) => c.id !== id)));
  }

  async get(id: string): Promise<SavedConnection> {
    const c = (await this.load()).find((x) => x.id === id);
    if (!c) throw new Error('Verbindung nicht gefunden.');
    return this.toPublic(c);
  }

  /** Zugangsdaten für den Treiber; bei input mit id ohne Passwort zählt das gespeicherte */
  async driverConfig(input: ConnectionInput | string): Promise<DriverConfig> {
    const stored = typeof input === 'string' ? (await this.load()).find((x) => x.id === input) : input.id ? (await this.load()).find((x) => x.id === input.id) : undefined;
    if (typeof input === 'string' && !stored) throw new Error('Verbindung nicht gefunden.');
    const c: ConnectionInput = typeof input === 'string' ? stored! : input;
    // eingegeben vor gespeichert; entschlüsselt wird erst, was die Verbindung braucht (ein nicht lesbares SSH-Passwort
    // stört eine Verbindung ohne SSH nicht)
    const typed = typeof input === 'string' ? undefined : input;
    const secret = (v: string | undefined, enc: string | undefined, what: string) => () => (v !== undefined ? v : enc ? this.open(enc, what) : '');
    const password = secret(typed?.password, stored?.passwordEnc, 'Das gespeicherte Passwort')();
    const passphrase = secret(typed?.keyPassphrase, stored?.keyPassphraseEnc, 'Das gespeicherte Schlüssel-Passwort');
    const sshSecret = secret(typed?.sshSecret, stored?.sshSecretEnc, 'Das gespeicherte SSH-Passwort');
    const o = c.options ?? {};
    const ssh = o.ssh ? await readSsh(o, sshSecret()) : undefined;
    return {
      host: c.host.trim(),
      port: c.port,
      user: c.user.trim(),
      password,
      database: c.database?.trim() || undefined,
      encrypt: o.encrypt,
      trustServerCertificate: o.trustServerCertificate,
      ssl: o.ssl,
      readOnly: !!o.readOnly,
      // mit SSH gilt der TLS-Tunnel für den Weg zum SSH-Server, nicht für die Datenbank; Elasticsearch kennt ihn nur so
      tunnel: ssh || c.dialect === 'elasticsearch' ? false : o.tunnel,
      servername: o.servername?.trim() || undefined,
      tls: await readTls(c.dialect, o, passphrase),
      ssh,
      apiKey: c.dialect === 'elasticsearch' && !!o.apiKey,
    };
  }

  /** bestätigte SSH-Hostschlüssel, wie known_hosts; eigene Datei neben den Verbindungen */
  private hostKeysFile() {
    return path.join(path.dirname(this.file), 'ssh-host-keys.json');
  }

  /**
   * Alle bestätigten Hostschlüssel. Beschädigt: klare Meldung, nicht still leer – sonst fragte jede Verbindung wie beim
   * ersten Kontakt, und ein geänderter Schlüssel (möglicher Angriff) fiele nicht mehr auf.
   */
  private async hostKeys(): Promise<Record<string, string>> {
    const r = await readJson(this.hostKeysFile(), (v) => !!v && typeof v === 'object' && !Array.isArray(v));
    if (r.ok) return (r.value as Record<string, string> | undefined) ?? {};
    if (!r.text.trim()) return {};
    throw new Error(`Die bestätigten SSH-Hostschlüssel sind beschädigt: ${this.hostKeysFile()} (${r.error}). Bitte die Datei reparieren oder entfernen.`);
  }

  async hostKey(hostId: string): Promise<string | undefined> {
    return (await this.hostKeys())[hostId];
  }

  setHostKey(hostId: string, fingerprint: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.hostKeys();
      all[hostId] = fingerprint;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomic(this.hostKeysFile(), JSON.stringify(all, null, 2));
    });
  }
}

/** JSON-Datei; fehlt sie, ok ohne Wert. text = Inhalt (für „leer“), error = warum nicht lesbar */
async function readJson(file: string, valid: (v: unknown) => boolean): Promise<{ ok: true; value?: unknown } | { ok: false; text: string; error: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
    throw e;
  }
  if (!text.trim()) return { ok: false, text, error: 'Datei ist leer' };
  try {
    // ein BOM (von Hand bearbeitet: PowerShell 5, ältere Editoren) wäre für JSON.parse ein Fehler
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return valid(value) ? { ok: true, value } : { ok: false, text, error: 'unerwarteter Inhalt' };
  } catch (e) {
    return { ok: false, text, error: (e as Error).message };
  }
}

let tmpSeq = 0;

/** erst in eine eigene .tmp-Datei (auf die Platte gebracht), dann umbenennen: ein Absturz hinterlässt keine halbe Datei */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}-${++tmpSeq}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Datei für Zertifikat oder Schlüssel lesen – aber keine Netzwerkpfade (\\server\…, //server/…) und keine Gerätepfade
 * (\\?\…, \\.\…): Beim Lesen meldet sich Windows mit dem Konto des Benutzers am Server an, und ein Pfad aus einer
 * weitergegebenen Einstellungsdatei könnte so dessen Anmeldedaten (NetNTLM) an einen fremden Rechner schicken.
 */
async function readLocal(file: string, what: string): Promise<string>;
async function readLocal(file: string, what: string, bytes: true): Promise<Buffer>;
async function readLocal(file: string, what: string, bytes?: true): Promise<string | Buffer> {
  if (/^[\\/]{2}/.test(file)) {
    throw new Error(`${what}: Netzwerkpfade werden nicht gelesen (${file}) – Windows meldete sich dabei mit deinem Konto am Server an. Bitte die Datei lokal ablegen oder über ein verbundenes Laufwerk (z. B. Z:\\…) wählen.`);
  }
  try {
    return bytes ? await fs.readFile(file) : await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`${what} nicht lesbar: ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
}

/** PKCS#12 (.p12/.pfx) am Namen oder am Inhalt (ASN.1-SEQUENCE am Anfang, kein PEM) erkennen */
function isPkcs12(file: string | undefined, head?: Buffer): boolean {
  const f = file?.trim() ?? '';
  if (/\.(p12|pfx)$/i.test(f)) return true;
  return !!head && head.length > 2 && head[0] === 0x30 && !head.subarray(0, 64).toString('latin1').includes('-----BEGIN');
}

/**
 * PKCS#12 (.p12/.pfx) in PEM: die Treiber kennen nur Zertifikat und Schlüssel als PEM (mysql2 baut seinen TLS-Kontext selbst
 * daraus). node-forge öffnet den Container (MAC, verschlüsselte Beutel); Schlüssel und Zertifikate wandelt Node um, damit
 * auch EC-Schlüssel gehen, die forge nicht lesen kann. Das Zertifikat zum Schlüssel steht vorn, die mitgelieferte Kette dahinter.
 */
function pkcs12ToPem(bytes: Buffer, password: string, file: string): { cert: string; key: string } {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bytes.toString('binary'))), false, password);
  } catch (e) {
    const msg = (e as Error).message;
    const wrongPassword = /mac|password|decrypt|integrity/i.test(msg);
    if (wrongPassword && !password) throw new Error('Die PKCS#12-Datei ist mit einem Passwort geschützt; bitte P12-Passwort angeben.');
    if (wrongPassword) throw new Error('Das Passwort der PKCS#12-Datei ist falsch.');
    throw new Error(`PKCS#12-Datei nicht lesbar: ${file} (${msg})`);
  }
  const bagsOf = (type: string) => p12.getBags({ bagType: type })[type] ?? [];
  const der = (a: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(a).getBytes(), 'binary');
  // forge liefert RSA-Schlüssel fertig (key), andere Typen nur als entschlüsselten PrivateKeyInfo (asn1)
  const keyBag = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)].find((b) => b.key || b.asn1);
  if (!keyBag) throw new Error(`Die PKCS#12-Datei enthält keinen privaten Schlüssel: ${file}`);
  let keyObject;
  try {
    keyObject = keyBag.key ? createPrivateKey(forge.pki.privateKeyToPem(keyBag.key)) : createPrivateKey({ key: der(keyBag.asn1!), format: 'der', type: 'pkcs8' });
  } catch (e) {
    throw new Error(`Der Schlüssel in der PKCS#12-Datei ist nicht lesbar: ${file} (${(e as Error).message})`);
  }
  const certs: X509Certificate[] = [];
  for (const b of bagsOf(forge.pki.oids.certBag)) {
    try {
      if (b.asn1) certs.push(new X509Certificate(der(b.asn1)));
      else if (b.cert) certs.push(new X509Certificate(forge.pki.certificateToPem(b.cert)));
    } catch {
      // ein Beutel ohne X.509-Zertifikat (z. B. SDSI) wird übersprungen
    }
  }
  if (!certs.length) throw new Error(`Die PKCS#12-Datei enthält kein Zertifikat: ${file}`);
  const mine = certs.find((c) => c.checkPrivateKey(keyObject));
  if (!mine) throw new Error(`In der PKCS#12-Datei passt kein Zertifikat zum Schlüssel: ${file}`);
  return {
    cert: [mine, ...certs.filter((c) => c !== mine)].map((c) => c.toString()).join(''),
    key: keyObject.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

/** SSH-Zugang: Schlüsseldatei lesen, ohne Angabe die üblichen Dateien in ~/.ssh */
async function readSsh(o: ConnectionOptions, secret: string): Promise<SshSettings> {
  const host = o.sshHost?.trim();
  if (!host) throw new Error('Für den SSH-Tunnel fehlt der SSH-Server.');
  if (!o.sshUser?.trim()) throw new Error('Für den SSH-Tunnel fehlt der SSH-Benutzer.');
  let privateKey: string | undefined;
  const file = o.sshKeyFile?.trim();
  if (file) {
    privateKey = await readLocal(file, 'SSH-Schlüssel');
    if (/PuTTY-User-Key-File-3/.test(privateKey)) {
      throw new Error('PuTTY-Schlüssel (.ppk) Version 3 wird nicht unterstützt; bitte in PuTTYgen als OpenSSH-Schlüssel exportieren.');
    }
  } else {
    // DBV_SSH_DIR: nur für Tests, damit sie nicht von den Schlüsseln des angemeldeten Benutzers abhängen
    const sshDir = process.env.DBV_SSH_DIR || path.join(os.homedir(), '.ssh');
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      privateKey = await fs.readFile(path.join(sshDir, name), 'utf8').catch(() => undefined);
      if (privateKey) break;
    }
  }
  if (!privateKey && !secret) throw new Error('Für den SSH-Tunnel braucht es einen Schlüssel (keiner in ~/.ssh gefunden) oder ein SSH-Passwort.');
  return {
    host,
    port: Number(o.sshPort) || 22,
    username: o.sshUser.trim(),
    privateKey,
    defaultKey: !file && !!privateKey,
    secret: secret || undefined,
    tls: !!o.tunnel,
    servername: o.servername?.trim() || undefined,
  };
}

/** Zertifikatsdateien lesen; Fehler mit verständlicher Meldung */
async function readTls(dialect: ConnectionInput['dialect'], o: ConnectionOptions, passphrase: () => string): Promise<TlsMaterial | undefined> {
  // Elasticsearch: TLS-Tunnel nur für SSH durch einen TLS-Proxy (ohne SSH: HTTPS)
  const tunnel = !!o.tunnel && (dialect !== 'elasticsearch' || !!o.ssh);
  const usesTls = tunnel || (dialect === 'mssql' ? !!o.encrypt : !!o.ssl);
  if (!usesTls) return undefined;
  const read = async (file: string | undefined, what: string) => {
    if (!file?.trim()) return undefined;
    const text = await readLocal(file.trim(), what);
    if (!text.includes('-----BEGIN')) {
      throw new Error(
        `${what} ist keine PEM-Datei: ${file}\n` +
          'PFX/P12 bitte umwandeln, z. B.:\n' +
          '  openssl pkcs12 -in datei.p12 -clcerts -nokeys -out client.crt\n' +
          '  openssl pkcs12 -in datei.p12 -nocerts -nodes -out client.key',
      );
    }
    return text;
  };
  const tls: TlsMaterial = {
    ca: await read(o.caFile, 'CA-Zertifikat'),
    verifyServer: !!o.verifyServer,
    verifyHostname: !!o.verifyHostname,
  };
  // SQL Server selbst kennt keine Client-Zertifikate, ein Proxy davor (Tunnel) schon
  if (dialect !== 'mssql' || o.tunnel) {
    // PKCS#12 (.p12/.pfx): Zertifikat und Schlüssel in einer Datei, das Schlüssel-Passwort ist das Passwort der Datei
    const certFile = o.certFile?.trim();
    const bytes = certFile ? await readLocal(certFile, 'Client-Zertifikat', true) : undefined;
    if (certFile && bytes && isPkcs12(certFile, bytes)) {
      if (o.keyFile?.trim()) throw new Error('Bei einer PKCS#12-Datei (.p12/.pfx) steckt der Schlüssel schon im Client-Zertifikat – bitte das Feld „Schlüssel“ leer lassen.');
      const pem = pkcs12ToPem(bytes, passphrase(), certFile);
      tls.cert = pem.cert;
      tls.key = pem.key;
      return tls;
    }
    tls.cert = await read(o.certFile, 'Client-Zertifikat');
    tls.key = await read(o.keyFile, 'Client-Schlüssel');
    if (tls.cert && !/-----BEGIN CERTIFICATE-----/.test(tls.cert)) {
      throw new Error(`Die Datei unter „Client-Zertifikat“ enthält kein Zertifikat (BEGIN CERTIFICATE): ${o.certFile}`);
    }
    // Schlüssel in der Zertifikatsdatei (wie bei openssl s_client -cert ohne -key)
    if (tls.cert && !tls.key && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(tls.cert)) tls.key = tls.cert;
    if (tls.cert && !tls.key) {
      throw new Error(
        `Zum Client-Zertifikat fehlt der private Schlüssel: ${o.certFile} enthält nur das Zertifikat.\n` +
          'Bitte unter „Schlüssel“ die Schlüsseldatei wählen – oder als Client-Zertifikat eine PEM-Datei, die beides enthält ' +
          '(BEGIN PRIVATE KEY und BEGIN CERTIFICATE, z. B. aus der .p12 umgewandelt).',
      );
    }
    if (tls.key && !tls.cert) throw new Error('Es ist nur ein Client-Schlüssel gewählt – bitte auch das Client-Zertifikat wählen (eine PEM-Datei mit beidem genügt).');
    if (tls.key && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(tls.key)) {
      throw new Error(`Die Datei unter „Schlüssel“ enthält keinen privaten Schlüssel (BEGIN … PRIVATE KEY): ${o.keyFile}`);
    }
    // Schlüssel-Passwort nur mit Schlüssel (sonst wird es gar nicht entschlüsselt)
    const pp = tls.key ? passphrase() : '';
    if (tls.key && /ENCRYPTED/.test(tls.key) && !pp) throw new Error('Der Client-Schlüssel ist mit einem Passwort geschützt; bitte Schlüssel-Passwort angeben.');
    if (pp) tls.passphrase = pp;
  }
  return tls;
}
