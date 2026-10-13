import fs from 'node:fs';
import path from 'node:path';

/** Dateien, an denen man ein benutztes Profil erkennt */
const DATA_FILES = ['connections.json', 'saved-queries.json', 'history.jsonl', 'ssh-host-keys.json'];

/**
 * Vor „OwlynDB“ hieß das Programm „AtlasDB“ (Profil %APPDATA%\AtlasDB), davor „dbviewer“ (%APPDATA%\dbviewer). Hat eins
 * dieser Profile Daten und das neue noch keine, wird das alte weiterbenutzt (Rückgabe: dieser Ordner; bei mehreren
 * benutzten gilt das erste der Liste – also das jüngere Profil, wenn die Liste von neu nach alt geordnet ist).
 * Kopieren ginge nicht: der Schlüssel der verschlüsselten Passwörter steht in „Local State“, und den neuen Ordner legt
 * Electron schon vor dem Start des Hauptskripts an.
 */
export function legacyProfile(oldDirs: string | readonly string[], newDir: string): string | null {
  const used = (dir: string) => DATA_FILES.some((f) => fs.existsSync(path.join(dir, f)));
  if (used(newDir)) return null;
  // ein Eintrag, der selbst der neue Ordner ist (Groß-/Kleinschreibung egal), ist hier ebenfalls unbenutzt und fällt von allein weg
  return (typeof oldDirs === 'string' ? [oldDirs] : oldDirs).find(used) ?? null;
}
