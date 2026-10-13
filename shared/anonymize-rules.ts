import type { AnonRule } from './api-types';

/** Regeln zum Ersetzen von Personendaten, in der Reihenfolge der Auswahl */
export const ANON_RULES: { rule: AnonRule; label: string; short: string; example: string }[] = [
  { rule: 'name', label: 'Name (Vor- und Nachname)', short: 'Name', example: 'Lea Brunner' },
  { rule: 'firstname', label: 'Vorname', short: 'Vorname', example: 'Lea' },
  { rule: 'lastname', label: 'Nachname', short: 'Nachname', example: 'Brunner' },
  { rule: 'email', label: 'E-Mail', short: 'E-Mail', example: 'lea.brunner.3fa9c1d2e4b5@example.invalid' },
  { rule: 'phone', label: 'Telefon (Vorwahl und Schreibweise bleiben)', short: 'Telefon', example: '+41 79 482 17 63' },
  { rule: 'iban', label: 'IBAN (gültige Prüfziffer)', short: 'IBAN', example: 'CH56 9999 9123 4567 8901 2' },
  { rule: 'street', label: 'Strasse und Nummer', short: 'Strasse', example: 'Lindenweg 17' },
  { rule: 'birthdate', label: 'Geburtsdatum (Jahr bleibt)', short: 'Geburtsdatum', example: '1984-07-23' },
  { rule: 'pseudonym', label: 'Pseudonym (Kürzel aus Prüfsumme)', short: 'Pseudonym', example: 'p_7c41d09e2b5a' },
  { rule: 'empty', label: 'leeren (NULL bzw. leer)', short: 'geleert', example: '' },
];

/** kurz, fürs Protokoll */
export const ANON_SHORT = Object.fromEntries(ANON_RULES.map((r) => [r.rule, r.short])) as Record<AnonRule, string>;

/** Zahlenspalten: dort ersetzen die Regeln die Ziffern (Telefon, Pseudonym, Geburtsdatum als JJJJMMTT) bzw. leeren mit 0 */
export const NUMERIC_COLUMN = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|int2|int4|int8|serial|bigserial|smallserial|money|smallmoney)\b/i;

/** Personen als letztes Wort des Tabellennamens (kunde, tbl_kunden, Mitarbeiter) – nicht customer_group, user_role */
const PERSON_NOUN =
  /^(kunden?|customers?|clients?|personen?|persons|people|users?|benutzer|mitarbeiter(innen)?|employees?|staff|kontakte?|contacts?|patient(en|s)?|mitglied(er)?|members?|teilnehmer(innen)?|teilnehmende|agents?|bewerber(innen)?|lieferanten?|suppliers?|vertreter(innen)?|ansprechpartner(innen)?|empf(ae|ä)nger(innen)?|recipients?|absender|senders?|schuldner|debitor(en)?|kreditor(en)?)$/;

/** Tabellen, deren Spalte „name“ eine Person meint (nicht z. B. artikel.name oder customer_group.name) */
function personTable(table: string): boolean {
  const words = table
    .replace(/([a-zäöü])([A-ZÄÖÜ])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter(Boolean);
  return PERSON_NOUN.test(words.at(-1) ?? '');
}

/** Vorschlag anhand von Tabellen- und Spaltennamen; null = keiner */
export function suggestAnonRule(table: string, column: string, dataType: string): AnonRule | null {
  const n = column.toLowerCase();
  const t = dataType.toLowerCase();
  const text = /char|text|string|clob/.test(t);
  const numeric = NUMERIC_COLUMN.test(t);
  // Geburtsdatum als Datum, Text oder JJJJMMTT – nicht das Geburtsjahr allein
  if (/geburt|birth|dob\b/.test(n) && !/jahr|year/.test(n) && (/date|time/.test(t) || text || (numeric && !/^(tinyint|smallint|int2)\b/.test(t)))) {
    return 'birthdate';
  }
  // Telefon oder AHV-Nummer als Zahl gespeichert
  if (numeric && /telefon|phone|^tel(_|$)|_tel$|natel|mobil|handy|fax/.test(n)) return 'phone';
  if (numeric && /ahv|svnr|sozialvers|ssn|passnummer|passport|ausweis/.test(n)) return 'pseudonym';
  if (!text) return null;
  if (/e[-_]?mail|^mail(_?adresse|_?address|_?addr)?$|_mail(_?adresse|_?address|_?addr)?$/.test(n)) return 'email';
  if (/iban|kontonummer|konto_?nr|account_?(no|number|nr)/.test(n)) return 'iban';
  if (/telefon|phone|^tel(_|$)|_tel$|natel|mobil|handy|fax/.test(n)) return 'phone';
  if (/vorname|first_?name|given_?name/.test(n)) return 'firstname';
  if (/nachname|last_?name|family_?name|surname|familienname/.test(n)) return 'lastname';
  if (/strasse|straße|street|adresse|address/.test(n)) return 'street';
  if (/ahv|svnr|sozialvers|ssn|passnummer|passport|ausweis/.test(n)) return 'pseudonym';
  if (/^(user_?name|login|benutzername|username)$/.test(n)) return 'pseudonym';
  if (/bemerkung|notiz|kommentar|comment|remark|^note|memo|freitext/.test(n)) return 'empty';
  if (/^(name|full_?name|vollname|kontaktperson|ansprechpartner)$/.test(n) && personTable(table)) return 'name';
  if (/(kunde|kunden|customer|person|kontakt|contact)_?name$/.test(n)) return 'name';
  return null;
}
