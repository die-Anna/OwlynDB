/*
 * Personendaten ersetzen (Test-Datenbank aus Prod). Der Ersatz hängt nur vom Wert, der Regel und einem zufälligen
 * Schlüssel je Lauf ab (HMAC): gleicher Wert → gleicher Ersatz, auch in anderen Tabellen – Verknüpfungen und Suchen
 * passen weiter, zurückrechnen lässt sich ohne den Schlüssel nichts. E-Mails gehen an example.invalid (nie zustellbar).
 * Die Form je Regel gilt für den ganzen Lauf (prepare), nicht je Spalte: ist eine Spalte mit der Regel eindeutig, bekommen
 * alle einen Prüfsummen-Anhang; ist eine zu schmal für die Langform, nehmen alle die Kurzform. Zahlen, Telefonnummern und
 * Ziffernfolgen werden umkehrbar eindeutig vertauscht (gleich viele Ziffern, keine Dubletten).
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AnonRule, ColumnInfo, TableInfo } from '../shared/api-types';
import { ANON_SHORT, NUMERIC_COLUMN } from '../shared/anonymize-rules';
import type { ExportCell } from './export';

const FIRST = [
  'Lea', 'Noah', 'Mia', 'Luca', 'Emma', 'Liam', 'Sofia', 'Elias', 'Lina', 'Leon', 'Laura', 'David', 'Anna', 'Jonas', 'Sara', 'Tim',
  'Nina', 'Jan', 'Julia', 'Fabian', 'Lara', 'Nico', 'Elena', 'Simon', 'Chiara', 'Marco', 'Alina', 'Matteo', 'Zoe', 'Levin', 'Aline',
  'Samuel', 'Livia', 'Robin', 'Selina', 'Dario', 'Ronja', 'Luis', 'Jana', 'Gian',
];
const LAST = [
  'Müller', 'Meier', 'Schmid', 'Keller', 'Weber', 'Huber', 'Schneider', 'Meyer', 'Steiner', 'Fischer', 'Gerber', 'Brunner', 'Baumann',
  'Frei', 'Zimmermann', 'Moser', 'Widmer', 'Wyss', 'Graf', 'Roth', 'Suter', 'Baumgartner', 'Bachmann', 'Kunz', 'Lehmann', 'Bühler',
  'Marti', 'Studer', 'Kaufmann', 'Hofmann', 'Bucher', 'Frey', 'Berger', 'Kälin', 'Lüthi', 'Egli', 'Arnold', 'Wenger', 'Bieri', 'Hess',
];
const STREETS = [
  'Bahnhofstrasse', 'Hauptstrasse', 'Dorfstrasse', 'Lindenweg', 'Kirchweg', 'Schulstrasse', 'Seestrasse', 'Gartenstrasse', 'Birkenweg',
  'Rosenweg', 'Bergstrasse', 'Feldstrasse', 'Mühleweg', 'Sonnenweg', 'Industriestrasse', 'Poststrasse', 'Waldweg', 'Ahornweg',
  'Bachstrasse', 'Wiesenstrasse',
];

/** Gleitkomma-Spalten: wie Zahlenspalten (Ziffern ersetzen), aber ohne Typgrenze */
const FLOAT_COLUMN = /^(float|double|real|float4|float8|binary_float|binary_double)\b/i;
/** Binärspalten: Werte kommen als Buffer; Text-Regeln ersetzen den Inhalt als UTF-8 */
const BINARY_COLUMN = /^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bytea|image|raw|long raw)\b/i;
/** Prüfsummen-Anhang für eindeutige Spalten: 10 Hex-Ziffern (40 Bit, dazu der Name) */
const TAG = 10;
/** Pseudonym und E-Mail: 12 Hex-Ziffern (48 Bit) – bei einer Million Werten im Mittel unter 0,01 Dubletten */
const HASH = 12;

/** für E-Mail-Adressen: Umlaute ausschreiben, nur a–z */
function ascii(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[^a-z]/g, '');
}

const DOMAIN = '@example.invalid';
/** längste Langform einer E-Mail: vorname.nachname.<12 Hex>@example.invalid */
const EMAIL_LONG = Math.max(...FIRST.map((f) => ascii(f).length)) + Math.max(...LAST.map((l) => ascii(l).length)) + 2 + HASH + DOMAIN.length;
/** Kurzform u<12 Hex>@example.invalid */
const EMAIL_SHORT = 1 + HASH + DOMAIN.length;
/** Langform eines Pseudonyms: p_<12 Hex> */
const PSEUDONYM = 2 + HASH;

/** IBAN-Prüfziffern (mod 97) für Land und BBAN */
export function ibanCheck(country: string, bban: string): string {
  const digits = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return String(98 - rest).padStart(2, '0');
}

/** höchste Länge einer Textspalte aus dem Typ, z. B. varchar(50); undefined = ohne Grenze */
export function maxLength(dataType: string): number | undefined {
  const m = /char[^(]*\((\d+)\)|varying\((\d+)\)/i.exec(dataType);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** höchste Länge einer Binärspalte in Bytes, z. B. varbinary(255); undefined = ohne Grenze */
function binaryLength(dataType: string): number | undefined {
  const n = Number(/^(?:var)?binary\s*\((\d+)\)/i.exec(dataType)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** größter Betrag, den eine Zahlenspalte fasst (ganzzahliger Teil); undefined = unbekannt */
export function numericMax(dataType: string): bigint | undefined {
  const t = dataType.toLowerCase();
  const unsigned = /unsigned/.test(t);
  if (/^tinyint\b/.test(t)) return unsigned ? 255n : 127n;
  if (/^(smallint|int2|smallserial)\b/.test(t)) return unsigned ? 65_535n : 32_767n;
  if (/^mediumint\b/.test(t)) return unsigned ? 16_777_215n : 8_388_607n;
  if (/^(int|integer|int4|serial)\b/.test(t)) return unsigned ? 4_294_967_295n : 2_147_483_647n;
  if (/^(bigint|int8|bigserial)\b/.test(t)) return unsigned ? 18_446_744_073_709_551_615n : 9_223_372_036_854_775_807n;
  const d = /^(?:decimal|numeric|number)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(t);
  if (d) return 10n ** BigInt(Math.max(1, Number(d[1]) - Number(d[2] ?? 0))) - 1n;
  return undefined;
}

/** Spalte, die ersetzt wird; label für Hinweise („tabelle.spalte“) */
export interface AnonTarget {
  nullable: boolean;
  dataType: string;
  label?: string;
}

/** fürs Planen der Formen (prepare): Regel und ob der Ersatz in dieser Spalte eindeutig bleiben muss */
export interface AnonColumn extends AnonTarget {
  rule: AnonRule;
  /** Primärschlüssel oder eindeutiger Index */
  unique?: boolean;
}

/** Form einer Regel für den ganzen Lauf */
interface Form {
  /** Prüfsummen-Anhang (Name, Strasse), weil eine Spalte mit dieser Regel eindeutig ist */
  unique: boolean;
  /** E-Mail in Kurzform u…@example.invalid, weil eine Spalte für die Langform zu schmal ist */
  short?: boolean;
  /** Pseudonym nur aus so vielen Hex-Ziffern, weil eine Spalte schmaler ist als p_<12 Hex> */
  width?: number;
}

/**
 * Umkehrbar eindeutige Abbildung von [0, n) auf sich selbst: Feistel-Netz mit HMAC als Rundenfunktion auf der
 * nächsten Zweierpotenz, Werte außerhalb wandern weiter, bis sie in [0, n) landen. Keine zwei Eingaben ergeben dieselbe
 * Ausgabe – anders als Hash mod n.
 */
function permute(key: Buffer, tweak: string, x: bigint, n: bigint): bigint {
  if (n <= 1n) return 0n;
  const half = BigInt(Math.ceil((n - 1n).toString(2).length / 2));
  const mask = (1n << half) - 1n;
  const round = (i: number, r: bigint) => BigInt('0x' + createHmac('sha256', key).update(`${tweak}\u0000${i}\u0000${r}`).digest('hex')) & mask;
  let v = x;
  do {
    let l = v >> half;
    let r = v & mask;
    for (let i = 0; i < 6; i++) [l, r] = [r, l ^ round(i, r)];
    v = (l << half) | r;
  } while (v >= n);
  return v;
}

export class Anonymizer {
  private key: Buffer;
  private forms = new Map<AnonRule, Form>();
  /** je Spalte: Werte in unbekanntem Format (geleert) und gekürzte Ersatzwerte */
  private counts = new Map<string, { unknown: number; cut: number }>();

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  private hash(rule: AnonRule, value: string): Buffer {
    return createHmac('sha256', this.key).update(`${rule}\u0000${value}`).digest();
  }

  private note(label: string | undefined, what: 'unknown' | 'cut') {
    if (!label) return;
    const c = this.counts.get(label) ?? { unknown: 0, cut: 0 };
    c[what]++;
    this.counts.set(label, c);
  }

  /**
   * Formen für den ganzen Lauf aus allen Spalten bestimmen, die ersetzt werden (vor dem ersten fn). Rückgabe: Hinweise
   * fürs Protokoll – z. B. eindeutige Spalten mit Prüfsummen-Anhang oder Kurzform wegen einer schmalen Spalte.
   */
  prepare(columns: AnonColumn[]): string[] {
    const notes: string[] = [];
    const labels = (cs: AnonColumn[]) => cs.map((c) => c.label ?? '?').join(', ');
    const byRule = new Map<AnonRule, AnonColumn[]>();
    for (const c of columns) byRule.set(c.rule, [...(byRule.get(c.rule) ?? []), c]);
    for (const [rule, cols] of byRule) {
      const unique = cols.filter((c) => c.unique);
      const form: Form = { unique: unique.length > 0 };
      // schmalste Textspalte (Zahlen- und Binärspalten haben eigene Formen)
      let narrow: AnonColumn | undefined;
      for (const c of cols) {
        const w = maxLength(c.dataType);
        if (w !== undefined && (!narrow || w < maxLength(narrow.dataType)!)) narrow = c;
      }
      const width = narrow ? maxLength(narrow.dataType)! : undefined;
      if (rule === 'email' && width !== undefined && width < EMAIL_LONG) {
        form.short = true;
        // auch die Kurzform passt nicht: gekürzt, und in eindeutigen Spalten können Dubletten entstehen
        const cut = width < EMAIL_SHORT ? `; auch die braucht ${EMAIL_SHORT} Zeichen, dort wird gekürzt${form.unique ? ` – in ${labels(unique)} sind Dubletten möglich` : ''}` : '';
        notes.push(`E-Mail: ${narrow!.label} fasst nur ${width} Zeichen – alle E-Mails dieses Laufs in Kurzform u…@example.invalid${cut}.`);
      }
      if (rule === 'pseudonym' && width !== undefined && width < PSEUDONYM) {
        form.width = width;
        notes.push(
          `Pseudonym: ${narrow!.label} fasst nur ${width} Zeichen – alle Pseudonyme dieses Laufs aus ${width} Hex-Ziffern` +
            (form.unique && width < 10 ? `; in ${labels(unique)} sind Dubletten möglich.` : '.'),
        );
      }
      if (form.unique && (rule === 'name' || rule === 'firstname' || rule === 'lastname' || rule === 'street')) {
        notes.push(
          `${ANON_SHORT[rule]}: ${labels(unique)} ${unique.length === 1 ? 'ist' : 'sind'} eindeutig (Primärschlüssel bzw. Index) – ` +
            `der Ersatz bekommt in allen Spalten mit dieser Regel einen Prüfsummen-Anhang, damit keine Dubletten entstehen.`,
        );
      }
      if (form.unique && rule === 'birthdate') {
        notes.push(`Geburtsdatum: ${labels(unique)} ist eindeutig – ersetzt werden nur Tag und Monat, Dubletten sind möglich.`);
      }
      this.forms.set(rule, form);
    }
    return notes;
  }

  /** Hinweise nach dem Lauf: Werte in unbekanntem Format (geleert) und gekürzte Ersatzwerte je Spalte */
  report(): string[] {
    const out: string[] = [];
    for (const [label, c] of this.counts) {
      if (c.unknown) out.push(`${label}: ${c.unknown} Wert(e) in unbekanntem Format – geleert statt unverändert übernommen.`);
      if (c.cut) out.push(`${label}: ${c.cut} Ersatzwert(e) auf die Spaltenbreite gekürzt – dort nicht mehr gleich wie in anderen Spalten, Dubletten möglich.`);
    }
    return out;
  }

  /**
   * Ersatzfunktion für eine Spalte. Text (auch der Inhalt von Binärspalten) nach der Regel; in Zahlenspalten werden die
   * Ziffern ersetzt (jede Regel außer „leeren“; Geburtsdatum als JJJJMMTT behält das Jahr). Was sich nicht ersetzen lässt
   * (z. B. ein Geburtsdatum in unbekanntem Format), wird geleert und gezählt (report) – nie unverändert durchgereicht.
   */
  fn(rule: AnonRule, column: AnonTarget): (v: ExportCell) => ExportCell {
    const max = maxLength(column.dataType);
    const bytes = binaryLength(column.dataType);
    const integer = NUMERIC_COLUMN.test(column.dataType);
    const numeric = integer || FLOAT_COLUMN.test(column.dataType);
    const binary = BINARY_COLUMN.test(column.dataType);
    const typeMax = integer ? numericMax(column.dataType) : undefined;
    const form = this.forms.get(rule) ?? { unique: false };
    const label = column.label;
    const empty = (): ExportCell => (column.nullable ? null : numeric ? 0 : binary ? Buffer.alloc(0) : '');
    const fit = (s: string): string => {
      if (max === undefined || s.length <= max) return s;
      this.note(label, 'cut');
      return s.slice(0, max);
    };
    const fitBytes = (s: string): Buffer => {
      let t = s;
      if (bytes !== undefined && Buffer.byteLength(t) > bytes) {
        this.note(label, 'cut');
        while (Buffer.byteLength(t) > bytes) t = t.slice(0, -1);
      }
      return Buffer.from(t, 'utf8');
    };
    return (v) => {
      if (v === null || v === undefined) return null;
      if (rule === 'empty') return empty();
      if (numeric && (typeof v === 'number' || typeof v === 'string')) {
        const r = this.number(rule, v, typeMax);
        if (r !== null) return r;
        this.note(label, 'unknown');
        return empty();
      }
      // Binärspalte: Inhalt als Text ersetzen und als Bytes zurück
      const text = Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'number' ? String(v) : v;
      if (typeof text !== 'string') return v; // Wahrheitswerte: keine Personendaten
      if (text.trim() === '') return v;
      const r = this.text(rule, text, form);
      if (r === null) {
        this.note(label, 'unknown');
        return empty();
      }
      return Buffer.isBuffer(v) ? fitBytes(r) : fit(r);
    };
  }

  /** Ersatz für einen Textwert; null = Format unbekannt (wird geleert) */
  private text(rule: AnonRule, v: string, form: Form): string | null {
    // E-Mail: Groß-/Kleinschreibung zählt nicht
    const input = rule === 'email' ? v.trim().toLowerCase() : v.trim();
    // nur Ziffern: wie dieselbe Nummer in einer Zahlenspalte (gleicher Ersatz)
    if ((rule === 'pseudonym' || rule === 'phone') && /^\d+$/.test(input)) {
      return /^0\d/.test(input) && rule === 'pseudonym' ? this.padded(rule, input, 'text') : this.digits(rule, input);
    }
    const h = this.hash(rule, input);
    const n = (i: number) => h.readUInt32BE((i % 8) * 4);
    // Prüfsummen-Teil aus den Bytes ab 16 – unabhängig von Vor- und Nachname (Bytes 0 bis 7)
    const hex = (len: number) => h.toString('hex').slice(32, 32 + len);
    const first = FIRST[n(0) % FIRST.length];
    const last = LAST[n(1) % LAST.length];
    const tagged = (s: string) => (form.unique ? `${s} ${hex(TAG)}` : s);
    switch (rule) {
      case 'firstname':
        return tagged(first);
      case 'lastname':
        return tagged(last);
      case 'name':
        // „Nachname, Vorname“ bleibt in dieser Form
        return tagged(/^[^,]+,\s*\S/.test(v) ? `${last}, ${first}` : `${first} ${last}`);
      case 'email':
        return form.short ? `u${hex(HASH)}${DOMAIN}` : `${ascii(first)}.${ascii(last)}.${hex(HASH)}${DOMAIN}`;
      case 'phone':
        return this.phone(v);
      case 'iban': {
        // Schweizer IBAN mit erfundener Clearing-Nummer 99999 (gibt es nicht), gültige Prüfziffer
        const bban = '99999' + String(n(2) % 1e6).padStart(6, '0') + String(n(3) % 1e6).padStart(6, '0');
        const iban = `CH${ibanCheck('CH', bban)}${bban}`;
        return /\s/.test(v) ? iban.replace(/(.{4})/g, '$1 ').trim() : iban;
      }
      case 'street': {
        // „Strasse Nr, PLZ Ort“: nur den Teil vor dem Komma ersetzen
        const rest = /,\s*\d{4,5}\s+.+$/.exec(v)?.[0] ?? '';
        return `${tagged(`${STREETS[n(2) % STREETS.length]} ${1 + (n(3) % 120)}`)}${rest}`;
      }
      case 'birthdate':
        return birthdate(v, 1 + (n(2) % 12), 1 + (n(3) % 28), 1 + (n(4) % 12));
      case 'pseudonym':
        return form.width !== undefined ? hex(form.width) : `p_${hex(HASH)}`;
    }
    return null;
  }

  /**
   * Telefonnummer: Ziffern umkehrbar eindeutig vertauscht, Schreibweise (Leerzeichen, +, Klammern) und Vorwahl bleiben
   * (+41, 0041, 044 bzw. die ersten zwei Ziffern) – keine Dubletten. Ohne Ziffern: unbekannt.
   */
  private phone(v: string): string | null {
    const digits = v.replace(/\D/g, '');
    if (!digits) return null;
    const prefix = /^\s*\+/.test(v) ? 2 : digits.startsWith('00') ? 4 : digits.startsWith('0') ? 3 : 2;
    const keep = Math.min(prefix, Math.max(0, digits.length - 3));
    const out = digits.slice(0, keep) + this.padded('phone', digits.slice(keep), digits.slice(0, keep));
    let k = 0;
    return v.replace(/\d/g, () => out[k++]);
  }

  /**
   * Zahl ersetzen: gleich viele Stellen und nie mehr, als der Spaltentyp fasst (eine Telefonnummer bleibt so lang, ein int
   * bleibt ein int), umkehrbar eindeutig; Vorzeichen bleibt, Nachkommastellen werden 0. JJJJMMTT als Geburtsdatum: Jahr
   * bleibt; ein vierstelliges Jahr bleibt ganz. null = kein Zahlformat (z. B. 1e+25).
   */
  private number(rule: AnonRule, v: number | string, typeMax: bigint | undefined): number | string | null {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
    if (!m) return null;
    const [, sign, int, frac] = m;
    let out: string;
    const date = /^((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.exec(int);
    if (rule === 'birthdate' && date) {
      const h = this.hash(rule, int);
      out = date[1] + String(1 + (h.readUInt32BE(0) % 12)).padStart(2, '0') + String(1 + (h.readUInt32BE(4) % 28)).padStart(2, '0');
    } else if (rule === 'birthdate' && /^(1[89]|20)\d{2}$/.test(int)) {
      out = int;
    } else {
      out = this.digits(rule, int, typeMax);
    }
    const res = sign + out + (frac ? '.' + '0'.repeat(frac.length) : '');
    return typeof v === 'number' ? Number(res) : res;
  }

  /** Ziffernfolge ohne führende Null: gleich viele Stellen, höchstens typeMax, umkehrbar eindeutig; Telefon: Vorwahl bleibt */
  private digits(rule: AnonRule, int: string, typeMax?: bigint): string {
    if (rule === 'phone') {
      const keep = Math.min(2, Math.max(0, int.length - 3));
      const head = int.slice(0, keep);
      // nur, wenn auch die größte so gebildete Zahl in den Typ passt
      if (keep > 0 && (typeMax === undefined || BigInt(head + '9'.repeat(int.length - keep)) <= typeMax)) {
        return head + this.padded(rule, int.slice(keep), head);
      }
    }
    const lo = int.length > 1 ? 10n ** BigInt(int.length - 1) : 0n;
    let hi = 10n ** BigInt(int.length) - 1n;
    if (typeMax !== undefined && typeMax < hi) hi = typeMax;
    const x = BigInt(int);
    if (hi < lo || x > hi) {
      // liegt außerhalb dessen, was der Typ fasst (sollte es nicht geben): wenigstens ersetzen
      const top = hi < lo ? x : hi;
      return (lo + (BigInt('0x' + this.hash(rule, int).toString('hex')) % (top - lo + 1n))).toString();
    }
    return (lo + permute(this.key, `${rule}\u0000${int.length}\u0000${hi}`, x - lo, hi - lo + 1n)).toString();
  }

  /** Ziffern, führende Nullen erlaubt (Rest einer Telefonnummer, Text): gleiche Länge, umkehrbar eindeutig */
  private padded(rule: AnonRule, digits: string, tweak: string): string {
    if (!digits) return '';
    return permute(this.key, `${rule}\u0000${tweak}\u0000${digits.length}`, BigInt(digits), 10n ** BigInt(digits.length))
      .toString()
      .padStart(digits.length, '0');
  }
}

/**
 * Geburtsdatum in Textform: Jahr und Schreibweise bleiben, Tag und Monat werden ersetzt. Erkannt werden JJJJ-MM-TT
 * (auch / und ., mit Zeit), TT.MM.JJJJ und TT-MM-JJJJ, TT/MM/JJJJ bzw. MM/TT/JJJJ (dann beide Teile höchstens 12, gültig
 * in beiden Lesarten), JJJJMMTT und ein Jahr allein (bleibt). null = unbekanntes Format.
 */
function birthdate(v: string, month: number, day: number, other: number): string | null {
  const pad = (x: number, like: string) => (like.length === 2 ? String(x).padStart(2, '0') : String(x));
  let m = /^(\s*\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/s.exec(v);
  if (m) return `${m[1]}${m[2]}${pad(month, m[3])}${m[2]}${pad(day, m[4])}${m[5]}`;
  m = /^(\s*)(\d{1,2})([.-])(\d{1,2})\3(\d{4})(.*)$/s.exec(v);
  if (m) return `${m[1]}${pad(day, m[2])}${m[3]}${pad(month, m[4])}${m[3]}${m[5]}${m[6]}`;
  m = /^(\s*)(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/s.exec(v);
  if (m) return `${m[1]}${pad(month, m[2])}/${pad(other, m[3])}/${m[4]}${m[5]}`;
  m = /^(\s*(?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\s*)$/.exec(v);
  if (m) return `${m[1]}${pad(month, '00')}${pad(day, '00')}${m[4]}`;
  if (/^\s*(1[89]|20)\d{2}\s*$/.test(v)) return v;
  return null;
}

/**
 * Regeln mit Spalten, die per Fremdschlüssel daran hängen (in beide Richtungen, auch über mehrere Stufen). Haben beide
 * Seiten verschiedene Regeln, gilt die des Elternteils (sonst passt der Ersatz nicht mehr zusammen). „leeren“ geht nie vom
 * Kind zum Elternteil – sonst würde z. B. dessen Primärschlüssel geleert; ein geleertes Kind verweist dann auf nichts (NULL).
 */
export function spreadRules(
  tables: { schema: string; name: string; info: TableInfo }[],
  rules: Map<string, AnonRule>,
  sameDatabaseRefs: boolean,
): { rules: Map<string, AnonRule>; notes: string[] } {
  const id = (schema: string, table: string, column: string) => `${schema}\u0000${table}\u0000${column}`;
  const out = new Map(rules);
  const notes: string[] = [];
  const said = new Set<string>();
  const once = (k: string, text: string) => {
    if (said.has(k)) return;
    said.add(k);
    notes.push(text);
  };
  const find = (refSchema: string, refTable: string) => tables.find((t) => t.name === refTable && (sameDatabaseRefs || t.schema === refSchema));
  const notNull = (t: { info: TableInfo }, column: string) => t.info.columns.find((c: ColumnInfo) => c.name === column)?.nullable === false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tables) {
      for (const fk of t.info.foreignKeys) {
        const p = find(fk.refSchema, fk.refTable);
        if (!p) continue;
        fk.columns.forEach((c, i) => {
          const ref = fk.refColumns[i];
          const child = id(t.schema, t.name, c);
          const parent = id(p.schema, p.name, ref);
          const rc = out.get(child);
          const rp = out.get(parent);
          if (rp && !rc) {
            out.set(child, rp);
            notes.push(`${t.name}.${c}: ${ANON_SHORT[rp]} wie ${p.name}.${ref} (Fremdschlüssel)`);
            changed = true;
          } else if (rc === 'empty' && rp !== 'empty') {
            once(`empty\u0000${child}`, `${t.name}.${c}: geleert – ${p.name}.${ref} bleibt, wie sie ist (Fremdschlüssel)`);
          } else if (rc && !rp) {
            out.set(parent, rc);
            notes.push(`${p.name}.${ref}: ${ANON_SHORT[rc]} wie ${t.name}.${c} (Fremdschlüssel)`);
            changed = true;
          } else if (rc && rp && rc !== rp) {
            out.set(child, rp);
            notes.push(`${t.name}.${c}: ${ANON_SHORT[rp]} wie ${p.name}.${ref} statt ${ANON_SHORT[rc]} – sonst passt der Fremdschlüssel nicht mehr`);
            changed = true;
          }
          if (out.get(child) === 'empty' && notNull(t, c)) {
            once(`nn\u0000${child}`, `${t.name}.${c}: geleert, aber NOT NULL – der Ersatz 0 bzw. '' verweist auf keine Zeile in ${p.name}, der Fremdschlüssel scheitert.`);
          }
        });
      }
    }
  }
  return { rules: out, notes };
}

/** Spalten, deren Ersatz eindeutig bleiben muss: Primärschlüssel und Spalten eindeutiger Indizes (Schlüssel wie bei spreadRules) */
export function uniqueColumns(tables: { schema: string; name: string; info: TableInfo }[]): Set<string> {
  const out = new Set<string>();
  for (const t of tables) {
    const add = (column: string) => out.add(`${t.schema}\u0000${t.name}\u0000${column}`);
    for (const c of t.info.columns) if (c.primaryKey) add(c.name);
    for (const ix of t.info.indexes) if (ix.unique || ix.primary) ix.columns.forEach(add);
  }
  return out;
}
