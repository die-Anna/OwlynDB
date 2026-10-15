// Erfundener Webshop für die Bilder in README und Handbuch: Datenbanken webshop und webshop_test (mit ein paar
// Abweichungen für den Datenvergleich) in einem PostgreSQL – alles erfunden, Adressen nur unter example.com/.org/.net.
// Die Zufallszahlen haben einen festen Startwert, die Daten sind also bei jedem Lauf gleich; nur die Zeitstempel richten
// sich nach dem heutigen Tag (die Abfragen auf den Bildern zeigen „die letzten 90 Tage“).
// Allein: node dev/readme-bilder/webshop.cjs [port] – sonst ruft aufnehmen.mjs fill() auf.
const { Client } = require('pg');

const KATEGORIEN = ['Outdoor', 'Küche', 'Garten', 'Elektronik', 'Bücher', 'Spielwaren', 'Büro', 'Musik'];
const LIEFERANTEN = [
  ['Alpenholz AG', 'CH'], ['Nordlicht GmbH', 'DE'], ['Bergkristall Elektronik', 'AT'], ['Seeblick Textil AG', 'CH'],
  ['Waldmeister Garten GmbH', 'DE'], ['Rösterei Bohnenglück', 'AT'], ['Papierwerk Federleicht', 'DE'], ['Spielwiese KG', 'DE'],
  ['Gipfelsport AG', 'CH'], ['Klangwerk Audio GmbH', 'AT'],
];
// [Kategorie, Name, Preis, Lieferant]
const ARTIKEL = [
  [0, 'Wanderschuh Gipfelstürmer', 189.0, 8], [0, 'Rucksack Alpin 32 l', 129.9, 8], [0, 'Stirnlampe LED 400', 39.9, 2],
  [0, 'Trekkingstöcke Carbon', 89.0, 8], [0, 'Schlafsack Bergnacht', 159.0, 3], [0, 'Trinkflasche Edelstahl 1 l', 24.9, 8],
  [0, 'Regenjacke Wetterfest', 219.0, 3], [0, 'Zelt Zweisam', 349.0, 8], [0, 'Funktionsshirt Merino', 69.9, 3],
  [0, 'Sitzkissen faltbar', 14.9, 3], [0, 'Kompass Klassik', 29.9, 8], [0, 'Erste-Hilfe-Set Tour', 34.5, 8],
  [1, 'Kaffeemühle Handmade', 79.0, 5], [1, 'Espressokanne 6 Tassen', 45.0, 5], [1, 'Kaffeebohnen Hausmischung 1 kg', 28.5, 5],
  [1, 'Schneidebrett Nussbaum', 59.0, 0], [1, 'Kochmesser Damast 20 cm', 149.0, 0], [1, 'Gusseisenpfanne 28 cm', 89.9, 0],
  [1, 'Teekanne Glas 1,2 l', 32.9, 5], [1, 'Gewürzregal Eiche', 49.0, 0], [1, 'Brotkasten Bambus', 39.9, 0],
  [1, 'Messbecher-Set', 12.9, 5], [1, 'Fondue-Set Familie', 119.0, 0], [1, 'Salatschleuder', 22.5, 5],
  [2, 'Gartenschere Profi', 44.9, 4], [2, 'Hochbeet Lärche', 299.0, 4], [2, 'Gießkanne 10 l', 19.9, 4],
  [2, 'Kräutersamen-Set', 9.9, 4], [2, 'Vogelhaus Fichte', 34.9, 0], [2, 'Gartenschlauch 25 m', 54.0, 4],
  [2, 'Pflanzkübel Terrakotta', 27.5, 4], [2, 'Rasensprenger', 31.9, 4], [2, 'Gartenhandschuhe Leder', 16.9, 4],
  [2, 'Komposter 300 l', 89.0, 4], [2, 'Solarleuchte Kugel', 24.9, 2], [2, 'Laubrechen Holz', 21.0, 0],
  [3, 'Kopfhörer Klangruhe', 199.0, 9], [3, 'Bluetooth-Lautsprecher Mini', 59.9, 9], [3, 'Powerbank 20 000 mAh', 44.9, 2],
  [3, 'USB-C-Ladegerät 65 W', 39.0, 2], [3, 'E-Reader Lesezeit', 129.0, 2], [3, 'Smartwatch Puls', 179.0, 2],
  [3, 'Webcam HD', 69.0, 2], [3, 'Funkmaus leise', 29.9, 2], [3, 'Tastatur mechanisch', 119.0, 2],
  [3, 'Mehrfachsteckdose 6-fach', 24.9, 2], [3, 'Radiowecker', 49.9, 9], [3, 'Plattenspieler Retro', 249.0, 9],
  [4, 'Kochbuch Alpenküche', 34.0, 6], [4, 'Wanderführer Graubünden', 26.9, 6], [4, 'Roman „Nebel über dem See“', 24.0, 6],
  [4, 'Kinderbuch Die kleine Eule', 16.9, 6], [4, 'Bildband Gletscher', 49.0, 6], [4, 'Krimi „Der letzte Pass“', 22.0, 6],
  [4, 'Sachbuch Datenbanken verstehen', 39.9, 6], [4, 'Gartenjahr-Kalender', 19.9, 6], [4, 'Notizbuch Leinen A5', 18.5, 6],
  [5, 'Holzeisenbahn Starter', 79.0, 7], [5, 'Puzzle 1000 Teile Matterhorn', 24.9, 7], [5, 'Bauklötze Buche 100', 49.0, 7],
  [5, 'Kartenspiel Jass', 9.9, 7], [5, 'Brettspiel Alpenexpress', 39.9, 7], [5, 'Plüscheule Owly', 19.9, 7],
  [5, 'Murmelbahn Turm', 59.0, 7], [5, 'Kreisel Set', 12.9, 7], [5, 'Malset Aquarell Kinder', 21.5, 7],
  [6, 'Füllfederhalter Klassik', 59.0, 6], [6, 'Schreibtischlampe LED', 79.0, 2], [6, 'Ordner A4 10er', 29.9, 6],
  [6, 'Briefpapier 100 Blatt', 14.9, 6], [6, 'Monitorständer Holz', 69.0, 0], [6, 'Kabelorganizer', 12.9, 2],
  [6, 'Whiteboard 90 × 60', 89.0, 6], [6, 'Haftnotizen 12er', 9.5, 6], [6, 'Bürostuhlkissen', 34.9, 3],
  [7, 'Ukulele Sopran', 69.0, 9], [7, 'Gitarrensaiten Satz', 14.9, 9], [7, 'Notenständer', 29.0, 9],
  [7, 'Mundharmonika C', 34.9, 9], [7, 'Metronom digital', 19.9, 9], [7, 'Cajón Buche', 129.0, 9],
  [7, 'Kopfhörerverstärker', 149.0, 9], [7, 'Liederbuch Lagerfeuer', 19.9, 6], [7, 'Stimmgerät Clip', 15.9, 9],
];
const VORNAMEN = ['Lukas', 'Lea', 'Noah', 'Mia', 'Elias', 'Emma', 'Leon', 'Sophie', 'Luca', 'Lena', 'Jonas', 'Laura', 'Finn', 'Sarah',
  'Felix', 'Julia', 'David', 'Nina', 'Simon', 'Marie', 'Tobias', 'Hannah', 'Matthias', 'Katharina', 'Stefan', 'Sandra', 'Thomas',
  'Andrea', 'Michael', 'Claudia', 'Markus', 'Petra', 'Daniel', 'Nicole', 'Martin', 'Sabine', 'Patrick', 'Melanie', 'Fabian',
  'Jasmin', 'Reto', 'Corinne', 'Urs', 'Barbara', 'Beat', 'Monika', 'Florian', 'Selina', 'Lars', 'Lara'];
const NACHNAMEN = ['Müller', 'Meier', 'Schmid', 'Keller', 'Weber', 'Huber', 'Schneider', 'Meyer', 'Steiner', 'Fischer', 'Gerber',
  'Brunner', 'Baumann', 'Frei', 'Zimmermann', 'Moser', 'Graf', 'Wyss', 'Roth', 'Suter', 'Bauer', 'Wagner', 'Becker', 'Hofmann',
  'Schulz', 'Koch', 'Richter', 'Wolf', 'Schröder', 'Neumann', 'Lang', 'Berger', 'Winkler', 'Lehmann', 'Hartmann'];
const ORTE = [
  ['8001', 'Zürich', 'CH'], ['3011', 'Bern', 'CH'], ['4051', 'Basel', 'CH'], ['6003', 'Luzern', 'CH'], ['9000', 'St. Gallen', 'CH'],
  ['8400', 'Winterthur', 'CH'], ['7000', 'Chur', 'CH'], ['1010', 'Wien', 'AT'], ['8010', 'Graz', 'AT'], ['5020', 'Salzburg', 'AT'],
  ['6020', 'Innsbruck', 'AT'], ['4020', 'Linz', 'AT'], ['80331', 'München', 'DE'], ['20095', 'Hamburg', 'DE'], ['10115', 'Berlin', 'DE'],
  ['50667', 'Köln', 'DE'], ['79098', 'Freiburg', 'DE'], ['70173', 'Stuttgart', 'DE'], ['01067', 'Dresden', 'DE'], ['04109', 'Leipzig', 'DE'],
];
const DOMAINS = ['example.com', 'example.org', 'example.net'];
const TEXTE = ['Super Qualität, gerne wieder.', 'Schnelle Lieferung, Ware wie beschrieben.', 'Etwas teuer, aber sein Geld wert.',
  'Hat nach zwei Wochen den Geist aufgegeben.', 'Perfekt für unsere Familienwanderung!', 'Gut verpackt, alles bestens.',
  'Farbe etwas anders als auf dem Bild.', 'Macht genau, was es soll.', 'Würde ich wieder kaufen.', null, null, null];
const ZAHLARTEN = ['Rechnung', 'Kreditkarte', 'Kreditkarte', 'Lastschrift', 'Vorkasse', 'Mobile Payment'];
const DIENSTE = ['Standard', 'Standard', 'Express', 'Kurier'];
const DAY = 86400000;

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const ascii = (s) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z]/g, '');
const iso = (ms) => new Date(ms).toISOString();

async function connect(cfg, database) {
  for (let i = 0; ; i++) {
    const c = new Client({ host: cfg.host, port: cfg.port, user: 'postgres', password: cfg.password, database });
    try {
      await c.connect();
      return c;
    } catch (e) {
      // frisch gestarteter Container: der Server startet einmal neu, bevor er Verbindungen annimmt
      if (i >= 60) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
async function insert(c, table, rows) {
  for (let i = 0; i < rows.length; i += 1000) await c.query(`INSERT INTO ${table} VALUES ${rows.slice(i, i + 1000).map((r) => '(' + r.map(q).join(', ') + ')').join(', ')}`);
}

/** webshop und webshop_test (neu) anlegen; cfg = { host, port, password } des Benutzers postgres */
async function fill(cfg) {
  let seed = 20261015;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const NOW = Date.now();

  const admin = await connect(cfg, 'postgres');
  await admin.query('DROP DATABASE IF EXISTS webshop_test');
  await admin.query('DROP DATABASE IF EXISTS webshop');
  await admin.query("CREATE DATABASE webshop ENCODING 'UTF8'");
  const c = await connect(cfg, 'webshop');
  await c.query(`
    CREATE TABLE kategorie (id smallint PRIMARY KEY, name text NOT NULL UNIQUE);
    CREATE TABLE lieferant (id smallint PRIMARY KEY, name text NOT NULL, land char(2) NOT NULL, email text NOT NULL);
    CREATE TABLE artikel (
      id integer PRIMARY KEY, name text NOT NULL,
      kategorie_id smallint NOT NULL REFERENCES kategorie, lieferant_id smallint NOT NULL REFERENCES lieferant,
      preis numeric(10,2) NOT NULL CHECK (preis > 0), aktiv boolean NOT NULL DEFAULT true);
    CREATE TABLE kunde (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, vorname text NOT NULL, nachname text NOT NULL,
      email text NOT NULL UNIQUE, plz text NOT NULL, ort text NOT NULL, land char(2) NOT NULL,
      registriert_am date NOT NULL, newsletter boolean NOT NULL DEFAULT false);
    CREATE TABLE bestellung (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, kunde_id integer NOT NULL REFERENCES kunde,
      bestellt_am timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('offen', 'bezahlt', 'versendet', 'storniert')), zahlart text NOT NULL);
    CREATE TABLE bestellposition (
      bestellung_id integer NOT NULL REFERENCES bestellung ON DELETE CASCADE, pos smallint NOT NULL,
      artikel_id integer NOT NULL REFERENCES artikel, menge smallint NOT NULL CHECK (menge > 0), preis numeric(10,2) NOT NULL,
      PRIMARY KEY (bestellung_id, pos));
    CREATE TABLE lager (id smallint PRIMARY KEY, ort text NOT NULL);
    CREATE TABLE lagerbestand (
      lager_id smallint NOT NULL REFERENCES lager, artikel_id integer NOT NULL REFERENCES artikel, menge integer NOT NULL,
      PRIMARY KEY (lager_id, artikel_id));
    CREATE TABLE versand (
      bestellung_id integer PRIMARY KEY REFERENCES bestellung, lager_id smallint NOT NULL REFERENCES lager,
      dienst text NOT NULL, sendungsnr text NOT NULL UNIQUE, versendet_am timestamptz NOT NULL);
    CREATE TABLE bewertung (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, artikel_id integer NOT NULL REFERENCES artikel,
      kunde_id integer NOT NULL REFERENCES kunde, sterne smallint NOT NULL CHECK (sterne BETWEEN 1 AND 5), text text,
      erstellt_am timestamptz NOT NULL);
    CREATE INDEX bestellung_kunde_idx ON bestellung (kunde_id);
    CREATE INDEX bewertung_artikel_idx ON bewertung (artikel_id);
  `);
  await insert(c, 'kategorie', KATEGORIEN.map((n, i) => [i + 1, n]));
  await insert(c, 'lieferant', LIEFERANTEN.map(([n, l], i) => [i + 1, n, l, `bestellung@${ascii(n.split(' ')[0])}.example`]));
  await insert(c, 'artikel', ARTIKEL.map(([k, n, p, l], i) => [i + 1, n, k + 1, l + 1, p, i % 23 !== 7]));
  await insert(c, 'lager', [[1, 'Zürich'], [2, 'Wien'], [3, 'Leipzig']]);
  await insert(c, 'lagerbestand', [1, 2, 3].flatMap((l) => ARTIKEL.map((_, i) => [l, i + 1, int(0, 400)])));

  // 2500 Kunden seit gut dreieinhalb Jahren; die letzten 40 haben sich eben erst registriert und noch nichts bestellt
  const kunden = [];
  const used = new Set();
  for (let k = 1; k <= 2500; k++) {
    const vor = pick(VORNAMEN);
    const nach = pick(NACHNAMEN);
    let mail = `${ascii(vor)}.${ascii(nach)}@${pick(DOMAINS)}`;
    for (let n = 2; used.has(mail); n++) mail = `${ascii(vor)}.${ascii(nach)}${n}@${pick(DOMAINS)}`;
    used.add(mail);
    const [plz, ort, land] = pick(ORTE);
    const reg = k > 2460 ? NOW - int(1, 20) * DAY : NOW - 1380 * DAY + Math.floor(rnd() * 1260 * DAY);
    kunden.push({ id: k, reg, row: [k, vor, nach, mail, plz, ort, land, iso(reg).slice(0, 10), rnd() < 0.35] });
  }
  await insert(c, 'kunde', kunden.map((k) => k.row));

  // 40 000 Bestellungen der letzten 650 Tage, je 1–4 Positionen; Versand und Bewertungen zu den versendeten
  const best = [];
  const pos = [];
  const vers = [];
  const bew = [];
  const seit = NOW - 650 * DAY;
  for (let b = 1; b <= 40000; b++) {
    const k = kunden[int(0, 2459)];
    const ab = Math.max(k.reg + DAY, seit);
    const t = ab + Math.floor(rnd() * (NOW - ab));
    const alter = (NOW - t) / DAY;
    const r = rnd();
    const status = r < 0.08 ? 'storniert' : alter < 2 ? (r < 0.6 ? 'offen' : 'bezahlt') : alter < 5 ? (r < 0.5 ? 'bezahlt' : 'versendet') : 'versendet';
    best.push([b, k.id, iso(t), status, pick(ZAHLARTEN)]);
    const n = int(1, 4);
    for (let p = 1; p <= n; p++) {
      const a = int(0, ARTIKEL.length - 1);
      pos.push([b, p, a + 1, rnd() < 0.8 ? 1 : int(2, 5), ARTIKEL[a][2]]);
      if (status === 'versendet' && rnd() < 0.05) bew.push([bew.length + 1, a + 1, k.id, pick([5, 5, 5, 4, 4, 4, 3, 2, 1]), pick(TEXTE), iso(t + int(5, 30) * DAY)]);
    }
    if (status === 'versendet') vers.push([b, k.row[6] === 'CH' ? 1 : k.row[6] === 'AT' ? 2 : 3, pick(DIENSTE), `${k.row[6]}${String(70000000 + b * 7)}`, iso(t + int(1, 3) * DAY)]);
  }
  await insert(c, 'bestellung', best);
  await insert(c, 'bestellposition', pos);
  await insert(c, 'versand', vers);
  await insert(c, 'bewertung', bew.filter((x) => Date.parse(x[5]) < NOW));
  await c.query(`
    SELECT setval(pg_get_serial_sequence('kunde', 'id'), (SELECT max(id) FROM kunde));
    SELECT setval(pg_get_serial_sequence('bestellung', 'id'), (SELECT max(id) FROM bestellung));
    SELECT setval(pg_get_serial_sequence('bewertung', 'id'), (SELECT max(id) FROM bewertung));
    CREATE VIEW umsatz_monat AS
      SELECT date_trunc('month', b.bestellt_am)::date AS monat, count(DISTINCT b.id) AS bestellungen, sum(p.menge * p.preis) AS umsatz
      FROM bestellung b JOIN bestellposition p ON p.bestellung_id = b.id
      WHERE b.status <> 'storniert' GROUP BY 1;
    CREATE FUNCTION kundenwert(k integer) RETURNS numeric LANGUAGE sql STABLE AS $$
      SELECT coalesce(sum(p.menge * p.preis), 0) FROM bestellung b JOIN bestellposition p ON p.bestellung_id = b.id
      WHERE b.kunde_id = k AND b.status <> 'storniert'
    $$;
    ANALYZE;
  `);
  await c.end();

  // Testkopie mit Abweichungen bei neuen Kunden (ohne Bestellungen): 3 fehlen, 5 geändert, 2 nur im Test
  await admin.query('CREATE DATABASE webshop_test TEMPLATE webshop');
  const t = await connect(cfg, 'webshop_test');
  await t.query(`
    DELETE FROM kunde WHERE id IN (2491, 2495, 2498);
    UPDATE kunde SET email = replace(email, '@', '.alt@') WHERE id = 2462;
    UPDATE kunde SET ort = 'Winterthur', plz = '8400' WHERE id = 2470;
    UPDATE kunde SET newsletter = NOT newsletter WHERE id IN (2475, 2483);
    UPDATE kunde SET nachname = 'Meyer' WHERE id = 2487;
    INSERT INTO kunde VALUES (9001, 'Max', 'Mustermann', 'max.mustermann@example.com', '8001', 'Zürich', 'CH', CURRENT_DATE - 14, false),
                             (9002, 'Erika', 'Musterfrau', 'erika.musterfrau@example.com', '3011', 'Bern', 'CH', CURRENT_DATE - 14, true);
  `);
  await t.end();
  await admin.end();
  return { kunden: kunden.length, bestellungen: best.length, positionen: pos.length };
}

module.exports = { fill };

if (require.main === module) {
  const port = Number(process.argv[2] ?? 15499);
  fill({ host: '127.0.0.1', port, password: process.env.DEMO_PG_PASSWORD ?? 'demo-only' })
    .then((n) => console.log('Webshop angelegt:', n))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
