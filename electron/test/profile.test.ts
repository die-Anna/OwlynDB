/* Profil aus der Zeit als „AtlasDB“ oder „dbviewer“: wann weiterbenutzen (ohne Datenbank). Aufruf: npm run test:profile */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyProfile } from '../profile';

const base = mkdtempSync(path.join(os.tmpdir(), 'dbv-profile-'));
const dir = (name: string, files: string[] = []) => {
  const d = path.join(base, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(path.join(d, f), '{}');
  return d;
};

let failed = 0;
function step(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message}`);
  }
}

step('altes Profil mit Verbindungen, neues leer (nur Local State): altes weiterbenutzen', () => {
  const old = dir('a-old', ['connections.json', 'Local State']);
  assert.equal(legacyProfile(old, dir('a-new', ['Local State'])), old);
});
step('auch nur Verlauf oder gespeicherte Abfragen zählen als benutzt', () => {
  const old = dir('b-old', ['history.jsonl']);
  assert.equal(legacyProfile(old, dir('b-new')), old);
});
step('neues Profil schon benutzt: neues bleibt', () => {
  assert.equal(legacyProfile(dir('c-old', ['connections.json']), dir('c-new', ['connections.json'])), null);
});
step('altes Profil ohne Daten (nur Local State) oder gar keins: neues', () => {
  assert.equal(legacyProfile(dir('d-old', ['Local State']), dir('d-new')), null);
  assert.equal(legacyProfile(path.join(base, 'gibts-nicht'), dir('e-new')), null);
});
step('gleicher Ordner (Groß-/Kleinschreibung egal): nichts tun', () => {
  const d = dir('f', ['connections.json']);
  assert.equal(legacyProfile(d, d.toUpperCase()), null);
});

step('Liste von neu nach alt: das erste benutzte Profil gewinnt (AtlasDB vor dbviewer)', () => {
  const atlas = dir('g-atlasdb', ['connections.json', 'Local State']);
  const dbv = dir('g-dbviewer', ['connections.json']);
  assert.equal(legacyProfile([atlas, dbv], dir('g-new', ['Local State'])), atlas);
});
step('AtlasDB-Profil ohne Daten: weiter zu dbviewer; keins der alten benutzt: neues', () => {
  const dbv = dir('h-dbviewer', ['saved-queries.json']);
  assert.equal(legacyProfile([dir('h-atlasdb', ['Local State']), dbv], dir('h-new')), dbv);
  assert.equal(legacyProfile([dir('i-atlasdb', ['Local State']), path.join(base, 'i-gibts-nicht')], dir('i-new')), null);
});
step('OwlynDB-Profil schon benutzt: neues bleibt, auch wenn AtlasDB- und dbviewer-Profil Daten haben', () => {
  const list = [dir('j-atlasdb', ['connections.json']), dir('j-dbviewer', ['connections.json'])];
  assert.equal(legacyProfile(list, dir('j-new', ['history.jsonl'])), null);
});
step('Eintrag der Liste ist zugleich der neue Ordner (Groß-/Kleinschreibung egal): nichts zu übernehmen, der nächste zählt nur ohne Daten im neuen', () => {
  const same = dir('k-profil', ['connections.json']);
  const dbv = dir('k-dbviewer', ['connections.json']);
  assert.equal(legacyProfile([same.toUpperCase(), dbv], same), null);
  assert.equal(legacyProfile([same.toUpperCase()], same), null);
  const leer = dir('l-profil', ['Local State']);
  assert.equal(legacyProfile([leer.toUpperCase(), dbv], leer), dbv);
});

console.log(failed ? `\n${failed} Fehler` : '\nalles ok');
process.exit(failed ? 1 : 0);
