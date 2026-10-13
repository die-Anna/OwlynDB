// Erzeugt THIRD-PARTY-NOTICES.txt im Wurzelordner: die Hinweise zu Drittanbieter-Software,
// die mit OwlynDB ausgeliefert werden (Urheberrechts- und Lizenzhinweise).
//
// Aufruf: npm run notices   (oder: node dev/third-party-notices.mjs)
//
// Quellen (alles lokal, keine zusätzlichen Abhängigkeiten, kein Netzzugriff):
//   1. Laufzeitpakete der Hauptanwendung: package-lock.json + node_modules/ (ohne Dev-Abhängigkeiten)
//   2. UI-Bundle: ui/dist/ui/3rdpartylicenses.txt (entsteht bei `npm run build:ui`)
//   3. Monaco Editor: ui/node_modules/monaco-editor/{LICENSE,ThirdPartyNotices.txt}
//   4. Lucide und Feather: Lizenztexte stehen unten in diesem Skript (von den Projekten übernommen)
//   5. Electron: node_modules/electron/LICENSE; Chromium: Verweis auf die Dateien des Installers
//
// Neu erzeugen, wenn sich Abhängigkeiten geändert haben, vor `npm run dist`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUSGABE = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt');
const UI_LIZENZEN = path.join(ROOT, 'ui', 'dist', 'ui', '3rdpartylicenses.txt');
const MONACO = path.join(ROOT, 'ui', 'node_modules', 'monaco-editor');

const BALKEN = '='.repeat(80);
const TRENNER = '-'.repeat(80);

// ---------------------------------------------------------------------------------------------
// Lizenztexte, die nicht aus node_modules kommen
// ---------------------------------------------------------------------------------------------

// Wortlaut übernommen von https://github.com/lucide-icons/lucide/blob/main/LICENSE (abgerufen 09.10.2026)
const LUCIDE_LIZENZ = String.raw`ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Wortlaut übernommen von https://github.com/feathericons/feather/blob/main/LICENSE (abgerufen 09.10.2026)
const FEATHER_LIZENZ = String.raw`The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Standardtexte für Pakete, die weder Lizenzdatei noch Lizenzabschnitt in der README mitbringen.
// {{inhaber}} wird durch den Autor aus der package.json ersetzt (ohne Jahreszahl, die kennen wir nicht).
const STANDARDTEXTE = {
  MIT: `MIT License

Copyright (c) {{inhaber}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,

  ISC: `ISC License

Copyright (c) {{inhaber}}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,

  'BSD-2-Clause': `BSD 2-Clause License

Copyright (c) {{inhaber}}. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,

  'BSD-3-Clause': `BSD 3-Clause License

Copyright (c) {{inhaber}}. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};

// Schreibweisen aus package.json-Dateien, die auf eine SPDX-Kennung abgebildet werden
const ALIAS = { 'MIT/X11': 'MIT', X11: 'MIT', Expat: 'MIT', 'BSD-3': 'BSD-3-Clause' };

// Doppellizenzen und Sonderfälle. `erwartet` ist die Angabe, auf die sich die Entscheidung bezieht:
// ändert eine neue Paketversion die Angabe, meldet das Skript eine Warnung statt still weiterzumachen.
// `kuerzen` lässt in der mitgelieferten Lizenzdatei den Teil der nicht gewählten Lizenz (GPL) weg.
const SONDERFAELLE = {
  'node-forge': {
    erwartet: '(BSD-3-Clause OR GPL-2.0)',
    gewaehlt: 'BSD-3-Clause',
    kuerzen: /\n-{20,}\n\s*GNU GENERAL PUBLIC LICENSE[\s\S]*$/,
    hinweis: 'Doppellizenz (BSD-3-Clause oder GPL-2.0), OwlynDB nutzt BSD-3-Clause. Der Text der GPL-2.0 ist hier nicht abgedruckt.',
  },
  jszip: {
    erwartet: '(MIT OR GPL-3.0-or-later)',
    gewaehlt: 'MIT',
    kuerzen: /\n+GPL version 3\n=+[\s\S]*$/,
    hinweis: 'Doppellizenz (MIT oder GPL-3.0-or-later), OwlynDB nutzt MIT. Der Text der GPL-3.0 ist hier nicht abgedruckt.',
  },
  pako: {
    erwartet: '(MIT AND Zlib)',
    gewaehlt: 'MIT AND Zlib',
    zusatzDateien: [['lib/zlib/README', 'zlib-Lizenz des portierten Codes']],
    hinweis: 'Beide Lizenzen gelten: MIT für die JavaScript-Portierung, zlib für den portierten Code.',
  },
};

// Kurzname, unter dem ein Autor bekannt ist, wenn das Paket keine Lizenzangabe hat
const AUTOR_KURZ = { buffers: 'substack' };

// ---------------------------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------------------------

const warnungen = [];
const warn = (text) => warnungen.push(text);

function abbruch(text) {
  console.error(`Fehler: ${text}`);
  process.exit(1);
}

/** Liest eine Textdatei als UTF-8, ohne BOM und mit LF als Zeilenende. */
const lies = (datei) => fs.readFileSync(datei, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const liesJson = (datei) => JSON.parse(lies(datei));
const rein = (text) => text.replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\s+$/, '');
const unveraendert = (text) => text.replace(/^\n+/, '').replace(/\s+$/, '');

function htmlZeichen(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function datumDe(d = new Date()) {
  const zwei = (n) => String(n).padStart(2, '0');
  return `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function pad(text, breite) {
  return text.length >= breite ? text : text + ' '.repeat(breite - text.length);
}

function ueberschrift(text, zeichen = '=') {
  return `${text}\n${zeichen.repeat([...text].length)}`;
}

// ---------------------------------------------------------------------------------------------
// 1. Laufzeitpakete aus package-lock.json und node_modules
// ---------------------------------------------------------------------------------------------

/**
 * Sucht den Eintrag, den Node für `name` ausgehend von `von` auflösen würde
 * (erst in von/node_modules, dann aufwärts) – so wie npm die Einträge im Lockfile ablegt.
 */
function loeseAuf(pakete, von, name) {
  let p = von;
  for (;;) {
    const kandidat = `${p ? p + '/' : ''}node_modules/${name}`;
    if (pakete[kandidat]) return kandidat;
    if (!p) return null;
    const i = p.lastIndexOf('/node_modules/');
    p = i >= 0 ? p.slice(0, i) : '';
  }
}

/** Alle Einträge, die von den dependencies der Hauptanwendung aus erreichbar sind (ohne Dev-Abhängigkeiten). */
function laufzeitEintraege() {
  const lockDatei = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(lockDatei)) abbruch('package-lock.json fehlt.');
  const lock = liesJson(lockDatei);
  const pakete = lock.packages;
  if (!pakete || !pakete['']) abbruch('package-lock.json hat kein "packages"-Feld (lockfileVersion 2 oder 3 nötig).');
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) abbruch('node_modules fehlt – bitte zuerst `npm ci` ausführen.');

  const besucht = new Set();
  const fehlend = [];
  const besuche = (eintrag) => {
    if (besucht.has(eintrag)) return;
    besucht.add(eintrag);
    const e = pakete[eintrag];
    const optional = new Set(Object.keys(e.optionalDependencies ?? {}));
    const peerOptional = new Set(
      Object.entries(e.peerDependenciesMeta ?? {})
        .filter(([, m]) => m?.optional)
        .map(([n]) => n),
    );
    const abhaengig = { ...(e.dependencies ?? {}), ...(e.optionalDependencies ?? {}), ...(e.peerDependencies ?? {}) };
    for (const name of Object.keys(abhaengig)) {
      const ziel = loeseAuf(pakete, eintrag, name);
      if (ziel) besuche(ziel);
      else if (!optional.has(name) && !peerOptional.has(name)) fehlend.push(`${eintrag || '(Wurzel)'} -> ${name}`);
    }
  };
  besuche('');
  besucht.delete('');
  if (fehlend.length) warn(`Im Lockfile nicht auflösbare Abhängigkeiten: ${fehlend.join(', ')}`);

  // Gegenprobe: dieselbe Menge muss sich aus den "dev"-Markierungen des Lockfiles ergeben
  const ohneDev = Object.entries(pakete)
    .filter(([k, v]) => k && !v.dev)
    .map(([k]) => k);
  const abweichung = ohneDev.filter((k) => !besucht.has(k)).concat([...besucht].filter((k) => !ohneDev.includes(k)));
  if (abweichung.length) warn(`Erreichbare Pakete und dev-Markierung des Lockfiles weichen ab: ${abweichung.join(', ')}`);

  return [...besucht].sort();
}

const TEXTDATEI = /^(licen[sc]es?|copying|unlicen[sc]e|notice)([-._ ].*)?$/i;
const CODEDATEI = /\.(m?[jt]s|cjs|json|map)$/i;

function lizenzDateien(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && TEXTDATEI.test(e.name) && !CODEDATEI.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const n = (x) => (/^notice/i.test(x) ? 1 : 0); // NOTICE-Dateien nach den Lizenzdateien
      return n(a) - n(b) || a.localeCompare(b);
    });
}

/** Lizenzabschnitt aus der README, wenn er einen echten Lizenztext enthält (nicht nur "MIT"). */
function lizenzAusReadme(dir) {
  const datei = fs.readdirSync(dir).find((n) => /^readme(\.(md|markdown|txt))?$/i.test(n));
  if (!datei) return null;
  const zeilen = lies(path.join(dir, datei)).split('\n');
  const start = zeilen.findIndex((z) => /^#{1,6}\s*licen[sc]e\b/i.test(z));
  if (start < 0) return null;
  const ebene = /^#+/.exec(zeilen[start])[0].length;
  let ende = zeilen.length;
  for (let i = start + 1; i < zeilen.length; i++) {
    const m = /^(#{1,6})\s/.exec(zeilen[i]);
    if (m && m[1].length <= ebene) {
      ende = i;
      break;
    }
  }
  const text = htmlZeichen(zeilen.slice(start + 1, ende).join('\n'));
  if (!/permission is hereby granted|permission to use, copy|redistribution and use/i.test(text)) return null;
  if (!/copyright/i.test(text)) return null;
  return { datei, text: rein(text) };
}

function personName(p) {
  if (!p) return null;
  if (typeof p === 'object') p = p.name;
  if (typeof p !== 'string') return null;
  const name = p
    .replace(/<[^>]*>/g, '')
    .replace(/\((?:https?:\/\/|www\.)[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name || null;
}

function autorZeile(pj) {
  const autor = personName(pj.author);
  if (autor) return autor;
  const andere = [...(pj.maintainers ?? []), ...(pj.contributors ?? [])].map(personName).filter(Boolean);
  const eindeutig = [...new Set(andere)].slice(0, 3);
  if (eindeutig.length) return `nicht angegeben (Beitragende laut package.json: ${eindeutig.join(', ')})`;
  return 'nicht angegeben';
}

function quellUrl(pj) {
  let r = pj.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r === 'string' && r.trim()) {
    r = r.trim();
    let m;
    if ((m = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(r))) return `https://github.com/${m[1]}`;
    if ((m = /^(gitlab|bitbucket):([\w./-]+)$/.exec(r))) return `https://${m[1]}.${m[1] === 'gitlab' ? 'com' : 'org'}/${m[2]}`;
    return r
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^http:\/\//, 'https://')
      .replace(/#.*$/, '')
      .replace(/\.git$/, '');
  }
  return pj.homepage || null;
}

/** Lizenzangabe aus package.json: "license" als Text, Objekt oder Liste, oder das alte Feld "licenses". */
function lizenzAngabe(pj) {
  const eins = (x) => (typeof x === 'string' ? x : (x?.type ?? x?.name ?? null));
  const roh = pj.license ?? pj.licenses;
  if (roh == null) return null;
  if (Array.isArray(roh)) {
    const ids = roh.map(eins).filter(Boolean);
    if (!ids.length) return null;
    return ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0];
  }
  return eins(roh);
}

function liesPaket(rel) {
  const dir = path.join(ROOT, rel);
  const pj = liesJson(path.join(dir, 'package.json'));
  const name = pj.name ?? rel.replace(/^.*node_modules\//, '');
  const sonder = SONDERFAELLE[name];
  const angabe = lizenzAngabe(pj);
  const alias = angabe && ALIAS[angabe] ? ALIAS[angabe] : angabe;
  const autor = autorZeile(pj);
  const p = {
    name,
    version: pj.version ?? '?',
    angabe, // so steht es in der package.json
    kennung: alias ?? 'keine Angabe', // für Anzeige und Zählung
    gewaehlt: null,
    anzeige: null,
    autor,
    quelle: quellUrl(pj),
    hinweise: [],
    texte: [], // { titel, text }
    textHerkunft: '',
    ohneEigenenText: false,
  };

  if (sonder) {
    if (angabe !== sonder.erwartet) {
      warn(`${name}@${p.version}: Lizenzangabe "${angabe}" statt "${sonder.erwartet}" – Auswahl in SONDERFAELLE prüfen.`);
    } else {
      p.gewaehlt = sonder.gewaehlt;
      p.hinweise.push(sonder.hinweis);
    }
  } else if (angabe && / OR /.test(angabe)) {
    warn(`${name}@${p.version}: Lizenzwahl "${angabe}" ist nicht in SONDERFAELLE entschieden.`);
  }
  if (!angabe) {
    const kurz = AUTOR_KURZ[name] ?? personName(pj.author) ?? 'unbekannt';
    p.kennung = 'keine Lizenzangabe im Paket';
    p.anzeige = `keine Lizenzangabe im Paket, Autor ${kurz}`;
    p.hinweise.push('Das Paket nennt weder in der package.json noch in einer Datei eine Lizenz.');
  }

  // Lizenzdateien im Paketordner
  const gesehen = new Set();
  for (const datei of lizenzDateien(dir)) {
    let text = rein(lies(path.join(dir, datei)));
    if (sonder?.kuerzen && p.gewaehlt) {
      const gekuerzt = text.replace(sonder.kuerzen, '');
      if (gekuerzt === text) warn(`${name}@${p.version}: Der Abschnitt der nicht gewählten Lizenz wurde in ${datei} nicht gefunden.`);
      text = rein(gekuerzt);
    }
    if (!text || gesehen.has(text)) continue;
    gesehen.add(text);
    p.texte.push({ titel: `Datei ${datei}`, text });
  }
  for (const [relDatei, titel] of sonder?.zusatzDateien ?? []) {
    const datei = path.join(dir, relDatei);
    if (fs.existsSync(datei)) p.texte.push({ titel: `${titel} (Datei ${relDatei})`, text: rein(lies(datei)) });
    else warn(`${name}@${p.version}: ${relDatei} fehlt.`);
  }

  if (p.texte.length) {
    p.textHerkunft = p.texte.map((t) => t.titel).join('; ');
    return p;
  }

  // Keine Lizenzdatei: README-Abschnitt, sonst Standardtext
  p.ohneEigenenText = true;
  const readme = lizenzAusReadme(dir);
  if (readme) {
    p.texte.push({ titel: `Abschnitt „License“ der Datei ${readme.datei}`, text: readme.text });
    p.textHerkunft = `Abschnitt „License“ der Datei ${readme.datei} (keine Lizenzdatei im Paket)`;
    return p;
  }
  const standard = STANDARDTEXTE[p.gewaehlt ?? alias];
  if (standard && angabe) {
    const inhaber = personName(pj.author) ?? `die Autoren von ${name}`;
    p.texte.push({ titel: `Standardtext der Lizenz ${alias}`, text: standard.replace('{{inhaber}}', inhaber) });
    p.textHerkunft = `Lizenztext nicht im Paket enthalten – Standardtext der Lizenz ${alias}, Urheber laut package.json: ${inhaber}`;
    return p;
  }
  if (angabe) {
    p.textHerkunft = `Lizenztext nicht im Paket enthalten – Wortlaut der Lizenz ${alias}: https://spdx.org/licenses/${encodeURIComponent(alias)}.html`;
  } else {
    p.textHerkunft = 'keiner (weder Lizenzdatei noch Lizenzangabe im Paket)';
  }
  return p;
}

function sammlePakete() {
  const eintraege = laufzeitEintraege();
  const nachSchluessel = new Map();
  const nichtInstalliert = [];
  for (const rel of eintraege) {
    if (!fs.existsSync(path.join(ROOT, rel, 'package.json'))) {
      nichtInstalliert.push(rel.replace(/^.*node_modules\//, ''));
      continue;
    }
    const p = liesPaket(rel);
    const schluessel = `${p.name}@${p.version}`;
    if (!nachSchluessel.has(schluessel)) nachSchluessel.set(schluessel, p); // gleiche Version in mehreren Ordnern: einmal
  }
  const liste = [...nachSchluessel.values()].sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.version.localeCompare(b.version, undefined, { numeric: true }),
  );
  return { liste, nichtInstalliert, eintraege: eintraege.length };
}

function zaehleKennungen(liste) {
  const zaehler = new Map();
  for (const p of liste) {
    const k = p.gewaehlt ?? p.kennung;
    zaehler.set(k, (zaehler.get(k) ?? 0) + 1);
  }
  return [...zaehler.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function anzeigeLizenz(p) {
  if (p.anzeige) return p.anzeige;
  if (p.gewaehlt) return `${p.angabe} -> gewählt: ${p.gewaehlt}`;
  return p.angabe === p.kennung || !p.angabe ? p.kennung : `${p.kennung} (Angabe im Paket: ${p.angabe})`;
}

function paketEintrag(p) {
  const kopf = [`${p.name} ${p.version}`, `Lizenz:  ${anzeigeLizenz(p)}`, `Autor:   ${p.autor}`];
  if (p.quelle) kopf.push(`Quelle:  ${p.quelle}`);
  for (const h of p.hinweise) kopf.push(`Hinweis: ${h}`);
  kopf.push(`Text:    ${p.textHerkunft}`);
  const teile = [TRENNER, ...kopf, TRENNER];
  if (!p.texte.length) teile.push('', '(Das Paket enthält keinen Lizenztext.)');
  for (const t of p.texte) {
    teile.push('');
    if (p.texte.length > 1) teile.push(`[${t.titel}]`, '');
    teile.push(t.text);
  }
  return teile.join('\n');
}

function abschnittPakete(daten) {
  const { liste, nichtInstalliert } = daten;
  const kennungen = zaehleKennungen(liste);
  const breiteName = Math.max(...liste.map((p) => p.name.length)) + 2;
  const breiteVersion = Math.max(...liste.map((p) => p.version.length)) + 2;
  const out = [];
  out.push(ueberschrift('1. Hauptanwendung (Electron-Prozess): Node-Pakete'));
  out.push('');
  out.push(
    `Diese ${liste.length} Pakete (mit allen Unterabhängigkeiten, ohne Entwicklungswerkzeuge) werden mit der Anwendung ausgeliefert. ` +
      'Gleiche Versionen sind nur einmal aufgeführt. Quelle: package-lock.json und node_modules.',
  );
  out.push('');
  out.push('Lizenzen im Überblick (bei Doppellizenzen zählt die gewählte):');
  for (const [k, n] of kennungen) out.push(`  ${pad(k, 28)} ${String(n).padStart(4)}`);
  out.push('');
  if (nichtInstalliert.length) {
    out.push(
      `Optionale Pakete, die auf diesem Rechner nicht installiert und daher nicht Teil des Pakets sind: ${nichtInstalliert.join(', ')}.`,
    );
    out.push('');
  }
  out.push('Paketliste:');
  out.push('');
  out.push(`  ${pad('Paket', breiteName)}${pad('Version', breiteVersion)}Lizenz`);
  for (const p of liste) out.push(`  ${pad(p.name, breiteName)}${pad(p.version, breiteVersion)}${anzeigeLizenz(p)}`);
  out.push('');
  out.push('Lizenztexte der Pakete:');
  out.push('');
  out.push(liste.map(paketEintrag).join('\n\n'));
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 2. UI-Bundle
// ---------------------------------------------------------------------------------------------

function abschnittUi() {
  if (!fs.existsSync(UI_LIZENZEN)) {
    abbruch(`${path.relative(ROOT, UI_LIZENZEN)} fehlt – bitte zuerst \`npm run build:ui\` ausführen.`);
  }
  const text = unveraendert(lies(UI_LIZENZEN));
  if (!text) abbruch(`${path.relative(ROOT, UI_LIZENZEN)} ist leer.`);
  const anzahl = (text.match(/^Package: /gm) ?? []).length;
  const out = [];
  out.push(ueberschrift('2. Oberfläche (UI-Bundle)'));
  out.push('');
  out.push(
    `Der Angular-Build der Oberfläche fügt ${anzahl} Bibliotheken in das Bundle ein. Ihre Lizenzhinweise stehen hier unverändert, ` +
      'wie sie der Build erzeugt hat (ui/dist/ui/3rdpartylicenses.txt). Der Monaco Editor wird nicht in das Bundle eingefügt, ' +
      'sondern als eigene Dateien mitgeliefert; er steht in Abschnitt 3.',
  );
  out.push('');
  out.push(text);
  return { text: out.join('\n'), anzahl };
}

// ---------------------------------------------------------------------------------------------
// 3. Monaco Editor
// ---------------------------------------------------------------------------------------------

function abschnittMonaco() {
  const pjDatei = path.join(MONACO, 'package.json');
  if (!fs.existsSync(pjDatei)) abbruch('ui/node_modules/monaco-editor fehlt – bitte zuerst `npm ci` im Ordner ui ausführen.');
  const pj = liesJson(pjDatei);
  const lizenz = rein(lies(path.join(MONACO, 'LICENSE')));
  const notices = unveraendert(lies(path.join(MONACO, 'ThirdPartyNotices.txt')));

  let purify = 'unbekannte Version';
  const purifyDatei = path.join(MONACO, 'esm', 'vs', 'base', 'browser', 'dompurify', 'dompurify.js');
  if (fs.existsSync(purifyDatei)) {
    const m = /@license DOMPurify ([\w.-]+)/.exec(lies(purifyDatei).slice(0, 400));
    if (m) purify = m[1];
    else warn('DOMPurify: Versionskennung in monaco-editor nicht gefunden.');
  } else {
    warn('DOMPurify: Datei in monaco-editor nicht gefunden; Versionsangabe fehlt.');
  }

  const out = [];
  out.push(ueberschrift('3. Monaco Editor (SQL-Editor)'));
  out.push('');
  out.push(`${pj.name} ${pj.version}`);
  out.push(`Lizenz:  ${pj.license}`);
  out.push(`Autor:   ${personName(pj.author)}`);
  out.push(`Quelle:  ${pj.homepage ?? 'https://github.com/microsoft/monaco-editor'}`);
  out.push('');
  out.push(TRENNER);
  out.push(lizenz);
  out.push(TRENNER);
  out.push('');
  out.push('Im Monaco Editor sind weitere Komponenten enthalten:');
  out.push('');
  out.push(`DOMPurify ${purify}`);
  out.push('  Copyright (c) Cure53 und weitere Mitwirkende.');
  out.push('  Doppelt lizenziert unter der Apache License 2.0 und der Mozilla Public License 2.0;');
  out.push('  OwlynDB nutzt DOMPurify unter der Apache License 2.0.');
  out.push('  Wortlaut: https://www.apache.org/licenses/LICENSE-2.0 (und bei den Apache-2.0-Paketen in diesem Dokument).');
  out.push('  Projekt:  https://github.com/cure53/DOMPurify');
  out.push('  Lizenz:   https://github.com/cure53/DOMPurify/blob/main/LICENSE');
  out.push('');
  out.push('Codicons (Symbolschrift des Editors)');
  out.push('  Copyright (c) Microsoft Corporation.');
  out.push('  Lizenz: Creative Commons Attribution 4.0 International (CC BY 4.0), unverändert verwendet.');
  out.push('  Projekt: https://github.com/microsoft/vscode-codicons');
  out.push('  Lizenz:  https://creativecommons.org/licenses/by/4.0/');
  out.push('');
  out.push('Weitere Hinweise von Microsoft zu Bestandteilen des Editors (ThirdPartyNotices.txt aus dem Paket, unverändert):');
  out.push('');
  out.push(TRENNER);
  out.push(notices);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 4. Lucide und Feather
// ---------------------------------------------------------------------------------------------

function abschnittIcons() {
  const out = [];
  out.push(ueberschrift('4. Symbole: Lucide und Feather'));
  out.push('');
  out.push(
    'Die Linien-Symbole der Oberfläche (SVG-Pfade in ui/src/app/ui/icon.ts und ui/src/app/er-view/er-view.ts) sind an die Symbole der ' +
      'Projekte Lucide (ISC) und Feather (MIT) angelehnt. Lucide ist selbst aus Feather hervorgegangen. Beide Projekte verlangen, ' +
      'ihren Lizenzhinweis mitzuliefern.',
  );
  out.push('');
  out.push('Lucide');
  out.push('  Projekt: https://lucide.dev, https://github.com/lucide-icons/lucide');
  out.push('  Lizenz:  ISC (mit MIT-Teil für die von Feather übernommenen Symbole)');
  out.push('');
  out.push(TRENNER);
  out.push(unveraendert(LUCIDE_LIZENZ));
  out.push(TRENNER);
  out.push('');
  out.push('Feather');
  out.push('  Projekt: https://feathericons.com, https://github.com/feathericons/feather');
  out.push('  Lizenz:  MIT');
  out.push('');
  out.push(TRENNER);
  out.push(unveraendert(FEATHER_LIZENZ));
  out.push(TRENNER);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// 5. Electron und Chromium
// ---------------------------------------------------------------------------------------------

function abschnittElectron() {
  const pjDatei = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  const version = fs.existsSync(pjDatei) ? liesJson(pjDatei).version : null;
  const lizenzDatei = path.join(ROOT, 'node_modules', 'electron', 'LICENSE');
  const out = [];
  out.push(ueberschrift('5. Electron und Chromium'));
  out.push('');
  out.push(
    `OwlynDB läuft auf Electron${version ? ` ${version}` : ''} (https://www.electronjs.org, MIT-Lizenz). Electron enthält Chromium, ` +
      'Node.js, V8 und weitere Komponenten Dritter, jeweils unter eigenen Lizenzen.',
  );
  out.push('');
  out.push('Der Installer legt die zugehörigen Lizenzdateien neben das Programm:');
  out.push('  LICENSE.electron.txt     Lizenz von Electron');
  out.push('  LICENSES.chromium.html   Lizenzen von Chromium und den darin enthaltenen Komponenten');
  out.push('Diese beiden Dateien sind Teil der Lizenzhinweise und dürfen nicht entfernt werden.');
  if (fs.existsSync(lizenzDatei)) {
    out.push('');
    out.push('Lizenz von Electron (Datei LICENSE aus dem Paket electron):');
    out.push('');
    out.push(TRENNER);
    out.push(rein(lies(lizenzDatei)));
    out.push(TRENNER);
  } else {
    warn('node_modules/electron/LICENSE nicht gefunden; der Electron-Lizenztext fehlt in Abschnitt 5.');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Zusammenbau
// ---------------------------------------------------------------------------------------------

function kopfzeilen(daten, ui) {
  const rootPj = liesJson(path.join(ROOT, 'package.json'));
  let urheber = null;
  const lizenzDatei = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(lizenzDatei)) urheber = /^Copyright.*$/m.exec(lies(lizenzDatei))?.[0] ?? null;
  urheber ??= `Copyright (c) ${new Date().getFullYear()} ${personName(rootPj.author) ?? ''}`.trim();
  const out = [];
  out.push(ueberschrift('OwlynDB – Hinweise zu Drittanbieter-Software'));
  out.push('');
  out.push(`Erzeugt am ${datumDe()}. Diese Datei ist generiert und wird nicht von Hand gepflegt:`);
  out.push('Neu erzeugen mit `npm run notices` (Skript dev/third-party-notices.mjs).');
  out.push('');
  out.push(`OwlynDB selbst steht unter der ${rootPj.license ?? 'MIT'}-Lizenz (Datei LICENSE): ${urheber}`);
  out.push(
    'OwlynDB enthält und verwendet die unten genannte Software Dritter. Deren Lizenzen verlangen, ' +
      'dass die Urheberrechts- und Lizenzhinweise mitgeliefert werden; das geschieht mit dieser Datei.',
  );
  out.push('');
  out.push('Inhalt');
  out.push(`  1. Hauptanwendung (Electron-Prozess): ${daten.liste.length} Node-Pakete`);
  out.push(`  2. Oberfläche (UI-Bundle): ${ui.anzahl} Bibliotheken`);
  out.push('  3. Monaco Editor (SQL-Editor) mit DOMPurify und Codicons');
  out.push('  4. Symbole: Lucide und Feather');
  out.push('  5. Electron und Chromium');
  return out.join('\n');
}

function main() {
  const daten = sammlePakete();
  const ui = abschnittUi();
  const teile = [kopfzeilen(daten, ui), abschnittPakete(daten), ui.text, abschnittMonaco(), abschnittIcons(), abschnittElectron()];
  const text = teile.join(`\n\n${BALKEN}\n\n`) + '\n';
  fs.writeFileSync(AUSGABE, text, 'utf8');

  const kb = (fs.statSync(AUSGABE).size / 1024).toFixed(0);
  console.log(`${path.relative(ROOT, AUSGABE)} geschrieben (${kb} KB).`);
  console.log(`  Node-Pakete: ${daten.liste.length} (Lockfile-Einträge: ${daten.eintraege}, nicht installiert: ${daten.nichtInstalliert.length})`);
  console.log(`  UI-Bundle:   ${ui.anzahl} Bibliotheken`);
  console.log('  Lizenzen:    ' + zaehleKennungen(daten.liste).map(([k, n]) => `${k} ${n}`).join(', '));
  const ohneText = daten.liste.filter((p) => p.ohneEigenenText);
  if (ohneText.length) {
    console.log('  Ohne Lizenzdatei im Paket:');
    for (const p of ohneText) console.log(`    ${p.name}@${p.version} – ${p.textHerkunft}`);
  }
  if (warnungen.length) {
    console.warn('Warnungen:');
    for (const w of warnungen) console.warn(`  - ${w}`);
  }
}

main();
