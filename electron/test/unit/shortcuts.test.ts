/* Reine Logik ohne Datenbank (npm run test:unit): Tastenkürzel in Texten der Oberfläche in Mac-Schreibweise */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { macShortcuts } from '../../../shared/shortcuts';

test('macShortcuts: Strg wird ⌘, Zeichen in der Reihenfolge der macOS-Menüs', () => {
  assert.equal(macShortcuts('Neue Abfrage (Strg+T)'), 'Neue Abfrage (⌘T)');
  assert.equal(macShortcuts('Objekte suchen (Strg+Umschalt+F)'), 'Objekte suchen (⇧⌘F)');
  assert.equal(macShortcuts('SQL formatieren (Umschalt+Alt+F)'), 'SQL formatieren (⌥⇧F)');
  assert.equal(macShortcuts('Ausführen (F5, Strg+Umschalt+Enter)'), 'Ausführen (F5, ⇧⌘↩)');
  assert.equal(macShortcuts('Strg+Enter'), '⌘↩');
  assert.equal(macShortcuts('Strg+0 = NULL, Strg+C'), '⌘0 = NULL, ⌘C');
  assert.equal(macShortcuts('Gespeicherte Abfragen (Strg+S speichert)'), 'Gespeicherte Abfragen (⌘S speichert)');
});

test('macShortcuts: Maus, Leertaste und Entf', () => {
  assert.equal(macShortcuts('· Strg+Klick öffnet'), '· ⌘-Klick öffnet');
  assert.equal(macShortcuts('Ziehen: verschieben · Strg+Mausrad: zoomen'), 'Ziehen: verschieben · ⌘-Mausrad: zoomen');
  // ⌘-Leertaste ist Spotlight: der Editor schlägt auf dem Mac mit Control vor
  assert.equal(macShortcuts('Strg+Leertaste zeigt Tabellen'), '⌃-Leertaste zeigt Tabellen');
  assert.equal(macShortcuts('Schließen (Strg+W, Entf)'), 'Schließen (⌘W, ⌫)');
});

test('macShortcuts: übriger Text bleibt', () => {
  for (const text of ['Entfernt werden die Dateien', 'entfernen', 'Strg allein', 'F5 führt alles aus', 'Umschalt-Taste', 'Strg+Tabelle']) {
    assert.equal(macShortcuts(text), text);
  }
});
