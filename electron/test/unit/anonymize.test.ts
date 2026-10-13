/* Reine Logik ohne Datenbank (npm run test:unit): Anonymisieren – Vorschläge, Ersatzwerte, Formen je Lauf, Fremdschlüssel */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnonRule, ForeignKeyInfo, TableInfo } from '../../../shared/api-types';
import { suggestAnonRule } from '../../../shared/anonymize-rules';
import { Anonymizer, ibanCheck, spreadRules, uniqueColumns } from '../../anonymize';

const key = (n: number) => Buffer.alloc(32, n);
const text = (dataType = 'varchar(80)', nullable = true) => ({ nullable, dataType });

test('Vorschläge anhand der Spaltennamen (Personen-Tabellen, Text-Spalten)', () => {
  const s = (t: string, c: string, type = 'varchar(50)') => suggestAnonRule(t, c, type);
  assert.equal(s('kunde', 'email'), 'email');
  assert.equal(s('kunde', 'E_Mail'), 'email');
  assert.equal(s('kunde', 'name'), 'name');
  assert.equal(s('artikel', 'name'), null);
  assert.equal(s('mitarbeiter', 'vorname'), 'firstname');
  assert.equal(s('person', 'nachname'), 'lastname');
  assert.equal(s('kunde', 'telefon_privat'), 'phone');
  assert.equal(s('kunde', 'iban'), 'iban');
  assert.equal(s('kunde', 'strasse'), 'street');
  assert.equal(s('kunde', 'geburtsdatum', 'date'), 'birthdate');
  assert.equal(s('kunde', 'bemerkung', 'text'), 'empty');
  assert.equal(s('kunde', 'id', 'int'), null);
  // als Zahl gespeichert
  assert.equal(s('kunde', 'telefon', 'bigint'), 'phone');
  assert.equal(s('kunde', 'ahv_nr', 'decimal(13,0)'), 'pseudonym');
  assert.equal(s('kunde', 'geburtsdatum', 'int'), 'birthdate');
  assert.equal(s('kunde', 'umsatz', 'decimal(10,2)'), null);
  // F001: „mail“ ohne e davor, Geburtsdatum als Text
  assert.equal(s('kunde', 'mail'), 'email');
  assert.equal(s('kunde', 'kontakt_mail'), 'email');
  assert.equal(s('kunde', 'Mailadresse'), 'email');
  assert.equal(s('kunde', 'mailing_list'), null);
  assert.equal(s('kunde', 'geburtsdatum', 'varchar(10)'), 'birthdate');
  assert.equal(s('kunde', 'dob', 'text'), 'birthdate');
  // F301: das Geburtsjahr allein ist kein Geburtsdatum
  assert.equal(s('person', 'geburtsjahr', 'int'), null);
  assert.equal(s('person', 'birth_year', 'smallint'), null);
  // F302: „name“ nur, wenn das letzte Wort des Tabellennamens eine Person meint
  for (const t of ['customer_group', 'user_role', 'client_type', 'member_status', 'agent_queue']) assert.equal(s(t, 'name'), null, t);
  for (const t of ['tbl_kunden', 'Mitarbeiter', 'ShopCustomers', 'users']) assert.equal(s(t, 'name'), 'name', t);
});

test('Zahlenspalten: gleich viele Stellen, passend zum Typ, gleichbleibend; leeren = 0 bzw. NULL', () => {
  const a = new Anonymizer(key(3));
  const num = (rule: AnonRule, dataType: string, nullable = true) => a.fn(rule, { nullable, dataType });
  const phone = num('phone', 'bigint');
  const p = phone('41791234567');
  assert.match(String(p), /^41\d{9}$/, 'Landesvorwahl bleibt');
  assert.notEqual(p, '41791234567');
  assert.equal(phone('41791234567'), p, 'gleichbleibend');
  // als JS-Zahl hinein, als Zahl heraus
  const pn = num('phone', 'int')(791234567);
  assert.equal(typeof pn, 'number');
  assert.equal(String(pn).length, 9);
  // int: nie über 2147483647, auch bei 10 Stellen
  for (let i = 0; i < 50; i++) {
    const v = Number(num('pseudonym', 'int(11)')(2_147_480_000 + i));
    assert.ok(v >= 1_000_000_000 && v <= 2_147_483_647, String(v));
  }
  assert.ok(Number(num('pseudonym', 'tinyint')(100)) <= 127);
  assert.match(String(num('pseudonym', 'decimal(10,2)')('12345.67')), /^\d{5}\.00$/);
  assert.match(String(num('pseudonym', 'numeric(12,0)')('-987654')), /^-\d{6}$/);
  // Geburtsdatum als JJJJMMTT: Jahr bleibt; ein Jahr allein bleibt ganz (F301)
  assert.match(String(num('birthdate', 'int')(19840723)), /^1984(0[1-9]|1[0-2])(0[1-9]|[12]\d)$/);
  assert.equal(num('birthdate', 'int')(1984), 1984);
  assert.equal(num('empty', 'int', false)(5), 0);
  assert.equal(num('empty', 'int', true)(5), null);
  // Textregel auf Zahlenspalte: trotzdem ersetzt (nie unverändert durchgereicht)
  assert.notEqual(num('name', 'bigint')('41791234567'), '41791234567');
});

test('F028: Zahlen umkehrbar eindeutig ersetzt – keine Dubletten, auch nicht im kleinen Wertebereich', () => {
  const a = new Anonymizer(key(4));
  const six = a.fn('pseudonym', text('int'));
  const seen = new Set<number>();
  for (let x = 100_000; x < 120_000; x++) {
    const y = Number(six(x));
    assert.ok(y >= 100_000 && y <= 999_999, String(y));
    seen.add(y);
  }
  assert.equal(seen.size, 20_000);
  // tinyint, dreistellig: genau die Werte 100 bis 127, jeder einmal
  const tiny = a.fn('pseudonym', text('tinyint'));
  const t = new Set(Array.from({ length: 28 }, (_, i) => Number(tiny(100 + i))));
  assert.deepEqual([...t].sort((x, y) => x - y), Array.from({ length: 28 }, (_, i) => 100 + i));
});

test('F025: Telefon behält Vorwahl und Schreibweise, ohne Dubletten; E-Mail mit 48 Bit Prüfsumme', () => {
  const a = new Anonymizer(key(5));
  const tel = a.fn('phone', text('varchar(30)'));
  const out = new Set<string>();
  for (let i = 0; i < 20_000; i++) {
    const v = `+41 44 ${String(Math.floor(i / 100)).padStart(3, '0')} ${String(i % 100).padStart(2, '0')} 00`;
    const o = String(tel(v));
    assert.match(o, /^\+41 \d{2} \d{3} \d{2} \d{2}$/, o);
    out.add(o);
  }
  assert.equal(out.size, 20_000);
  assert.match(String(tel('044 123 45 67')), /^044 \d{3} \d{2} \d{2}$/);
  assert.match(String(tel('0041 79 123 45 67')), /^0041 \d{2} \d{3} \d{2} \d{2}$/);
  assert.equal(tel('unbekannt'), null, 'ohne Ziffern: geleert');
  const mail = a.fn('email', text());
  const mails = new Set(Array.from({ length: 50_000 }, (_, i) => mail(`kunde${i}@example.com`)));
  assert.equal(mails.size, 50_000);
});

test('F025/F108: eindeutige Spalte – Namen bekommen einen Prüfsummen-Anhang, alle Spalten mit der Regel gleich', () => {
  const a = new Anonymizer(key(6));
  const notes = a.prepare([
    { rule: 'name', ...text('varchar(60)'), unique: true, label: 'benutzer.name' },
    { rule: 'name', ...text('varchar(80)'), label: 'kunde.name' },
  ]);
  assert.ok(notes.some((n) => /benutzer\.name ist eindeutig .*Prüfsummen-Anhang/.test(n)), notes.join(' | '));
  const uniq = a.fn('name', text('varchar(60)'));
  const other = a.fn('name', text('varchar(80)'));
  const names = new Set(Array.from({ length: 5000 }, (_, i) => uniq(`Person ${i}`)));
  assert.equal(names.size, 5000);
  assert.match(String(uniq('Anna Meier')), /^\S+ \S+ [0-9a-f]{10}$/);
  assert.equal(other('Anna Meier'), uniq('Anna Meier'), 'gleiche Form in allen Spalten der Regel');
  // ohne eindeutige Spalte: Vor- und Nachname, Dubletten möglich
  const plain = new Anonymizer(key(6)).fn('name', text());
  assert.match(String(plain('Anna Meier')), /^\S+ \S+$/);
});

test('F026: Ersatz unabhängig von der Spaltenbreite – schmale Spalte erzwingt die Kurzform für alle', () => {
  const wide = new Anonymizer(key(7));
  wide.prepare([
    { rule: 'email', ...text('varchar(255)'), label: 'kunde.email' },
    { rule: 'email', ...text('varchar(60)'), label: 'newsletter.email' },
  ]);
  const long = String(wide.fn('email', text('varchar(255)'))('max@example.com'));
  assert.match(long, /^[a-z]+\.[a-z]+\.[0-9a-f]{12}@example\.invalid$/);
  assert.equal(wide.fn('email', text('varchar(60)'))('max@example.com'), long);
  const narrow = new Anonymizer(key(7));
  const notes = narrow.prepare([
    { rule: 'email', ...text('varchar(255)'), label: 'kunde.email' },
    { rule: 'email', ...text('varchar(30)'), label: 'newsletter.email' },
  ]);
  assert.ok(notes.some((n) => /newsletter\.email fasst nur 30 Zeichen.*Kurzform/.test(n)), notes.join(' | '));
  const short = String(narrow.fn('email', text('varchar(255)'))('max@example.com'));
  assert.match(short, /^u[0-9a-f]{12}@example\.invalid$/);
  assert.equal(narrow.fn('email', text('varchar(30)'))('max@example.com'), short);
  assert.ok(!notes.some((n) => /gekürzt/.test(n)), 'Kurzform (29 Zeichen) passt in 30');
  // auch die Kurzform passt nicht: Hinweis auf Kürzen und mögliche Dubletten in eindeutigen Spalten
  const tiny = new Anonymizer(key(7)).prepare([{ rule: 'email', ...text('varchar(20)'), label: 'login.mail', unique: true }]);
  assert.ok(tiny.some((n) => /login\.mail fasst nur 20 Zeichen.*braucht 29 Zeichen, dort wird gekürzt – in login\.mail sind Dubletten möglich/.test(n)), tiny.join(' | '));
  // gleiche Nummer als Zahl und als Text: gleicher Ersatz
  const a = new Anonymizer(key(8));
  assert.equal(String(a.fn('phone', text('bigint'))(41791234567)), String(a.fn('phone', text('varchar(20)'))('41791234567')));
  assert.equal(String(a.fn('pseudonym', text('int'))(12345)), String(a.fn('pseudonym', text('varchar(20)'))('12345')));
  // zu schmal für den Ersatz: gekürzt und gemeldet
  const cut = new Anonymizer(key(8));
  cut.fn('name', { ...text('varchar(4)'), label: 'kunde.kurz' })('Anna Meier');
  assert.ok(cut.report().some((r) => /^kunde\.kurz: 1 Ersatzwert\(e\) auf die Spaltenbreite gekürzt/.test(r)), cut.report().join(' | '));
});

test('F024: Binärspalten und Gleitkommazahlen werden ersetzt, nicht durchgereicht', () => {
  const a = new Anonymizer(key(9));
  const bin = a.fn('email', text('varbinary(255)'));
  const out = bin(Buffer.from('max@example.com'));
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.toString('utf8'), a.fn('email', text())('max@example.com'));
  // auf die Länge in Bytes gekürzt
  assert.ok((a.fn('name', text('varbinary(5)'))(Buffer.from('Anna Meier')) as Buffer).length <= 5);
  // leeren in einer Binärspalte NOT NULL: leere Bytes statt Text
  const empty = a.fn('empty', text('varbinary(16)', false))(Buffer.from('x'));
  assert.ok(Buffer.isBuffer(empty) && empty.length === 0);
  const f = a.fn('phone', text('double'))(41791234567);
  assert.equal(typeof f, 'number');
  assert.notEqual(f, 41791234567);
  assert.equal(String(f).length, 11);
  // kein Zahlformat (Exponent): geleert und gemeldet
  const exp = a.fn('pseudonym', { ...text('double'), label: 'mess.wert' });
  assert.equal(exp(1e25), null);
  assert.ok(a.report().some((r) => /^mess\.wert: 1 Wert\(e\) in unbekanntem Format – geleert/.test(r)), a.report().join(' | '));
});

test('F001/F027: Geburtsdatum in Textform – Jahr und Schreibweise bleiben, Unbekanntes wird geleert', () => {
  const a = new Anonymizer(key(10));
  const b = a.fn('birthdate', { ...text('varchar(20)'), label: 'kunde.geburt' });
  const values = ['23.07.1984', '7.3.1984', '23-07-1984', '1984/07/23', '1984.07.23', '1984-07-23 00:00:00'];
  const results = values.map((v) => String(b(v)));
  assert.match(results[0], /^\d{2}\.\d{2}\.1984$/);
  assert.match(results[1], /^\d{1,2}\.\d{1,2}\.1984$/);
  assert.match(results[2], /^\d{2}-\d{2}-1984$/);
  assert.match(results[3], /^1984\/\d{2}\/\d{2}$/);
  assert.match(results[4], /^1984\.\d{2}\.\d{2}$/);
  assert.match(results[5], /^1984-\d{2}-\d{2} 00:00:00$/);
  assert.ok(results.some((r, i) => r !== values[i]), 'mindestens einer ersetzt');
  // TT/MM/JJJJ oder MM/TT/JJJJ: beide Teile höchstens 12 – gültig in beiden Lesarten
  for (let i = 1; i <= 28; i++) {
    const m = /^(\d{2})\/(\d{2})\/1984$/.exec(String(b(`07/${String(i).padStart(2, '0')}/1984`)));
    assert.ok(m && Number(m[1]) <= 12 && Number(m[2]) <= 12, String(m));
  }
  assert.match(String(b('19840723')), /^1984(0[1-9]|1[0-2])(0[1-9]|[12]\d)$/);
  assert.equal(b('1984'), '1984');
  assert.equal(b('unbekannt'), null);
  assert.equal(a.fn('birthdate', text('varchar(20)', false))('irgendwann'), '');
  assert.ok(a.report().some((r) => /^kunde\.geburt: 1 Wert\(e\) in unbekanntem Format/.test(r)), a.report().join(' | '));
});

test('gleicher Wert → gleicher Ersatz, anderer Schlüssel → anderer Ersatz; Formate und Längen', () => {
  const a = new Anonymizer(key(1));
  const b = new Anonymizer(key(2));
  const mail = a.fn('email', text());
  assert.equal(mail('Max@Example.com'), mail('max@example.com'));
  assert.notEqual(mail('max@example.com'), b.fn('email', text())('max@example.com'));
  const iban = String(a.fn('iban', text())('CH93 0076 2011 6238 5295 7')).replace(/\s/g, '');
  assert.match(iban, /^CH\d{19}$/);
  assert.equal(ibanCheck('CH', iban.slice(4)), iban.slice(2, 4));
  assert.match(String(a.fn('street', text())('Echtgasse 5, 8000 Zürich')), /^[A-ZÄÖÜa-zäöüß]+ \d+, 8000 Zürich$/);
  assert.match(String(a.fn('birthdate', text())('1980-05-17')), /^1980-\d{2}-\d{2}$/);
  assert.match(String(a.fn('name', text())('Meier, Anna')), /^\S+, \S+$/);
  assert.equal(a.fn('empty', text('text'))('x'), null);
  assert.equal(a.fn('empty', text('text', false))('x'), '');
  assert.equal(a.fn('name', text())(null), null);
  assert.equal(String(a.fn('pseudonym', text('char(8)'))('benutzer1')).length, 8);
  assert.match(String(a.fn('pseudonym', text())('benutzer1')), /^p_[0-9a-f]{12}$/);
});

// ---------- Fremdschlüssel ----------

type Col = [name: string, nullable?: boolean, pk?: boolean];
function table(name: string, columns: Col[], fks: ForeignKeyInfo[] = [], unique: string[][] = []) {
  const info: TableInfo = {
    columns: columns.map(([c, nullable = true, pk = false]) => ({ name: c, dataType: 'int', nullable, primaryKey: pk, autoIncrement: false, defaultValue: null })),
    indexes: unique.map((cols, i) => ({ name: `uq${i}`, columns: cols, unique: true, primary: false })),
    foreignKeys: fks,
    referencedBy: [],
  };
  return { schema: 'public', name, info };
}
const fk = (columns: string[], refTable: string, refColumns: string[]): ForeignKeyInfo => ({ name: `fk_${refTable}`, columns, refSchema: 'public', refTable, refColumns });
const id = (t: string, c: string) => `public\u0000${t}\u0000${c}`;

test('F029: „leeren“ geht nicht vom Kind auf den Primärschlüssel des Elternteils über', () => {
  const tables = [
    table('users', [['id', false, true], ['name']]),
    table('orders', [['id', false, true], ['created_by'], ['owner', false]], [fk(['created_by'], 'users', ['id']), fk(['owner'], 'users', ['id'])]),
  ];
  const { rules, notes } = spreadRules(tables, new Map([[id('orders', 'created_by'), 'empty'], [id('orders', 'owner'), 'empty']]), false);
  assert.equal(rules.get(id('users', 'id')), undefined, 'users.id bleibt');
  assert.ok(notes.some((n) => /^orders\.created_by: geleert – users\.id bleibt/.test(n)), notes.join(' | '));
  assert.ok(notes.some((n) => /^orders\.owner: geleert, aber NOT NULL/.test(n)), notes.join(' | '));
});

test('F030: verschiedene Regeln an einem Fremdschlüssel – das Kind übernimmt die Regel des Elternteils', () => {
  const tables = [table('benutzer', [['name', false]], [], [['name']]), table('bestellung', [['benutzername']], [fk(['benutzername'], 'benutzer', ['name'])])];
  const given = new Map<string, AnonRule>([
    [id('benutzer', 'name'), 'name'],
    [id('bestellung', 'benutzername'), 'pseudonym'],
  ]);
  const { rules, notes } = spreadRules(tables, given, false);
  assert.equal(rules.get(id('bestellung', 'benutzername')), 'name');
  assert.ok(notes.some((n) => /^bestellung\.benutzername: Name wie benutzer\.name statt Pseudonym/.test(n)), notes.join(' | '));
  // weitergereicht wird wie bisher in beide Richtungen
  const up = spreadRules(tables, new Map<string, AnonRule>([[id('bestellung', 'benutzername'), 'email']]), false);
  assert.equal(up.rules.get(id('benutzer', 'name')), 'email');
  assert.deepEqual([...uniqueColumns(tables)], [id('benutzer', 'name')]);
});
