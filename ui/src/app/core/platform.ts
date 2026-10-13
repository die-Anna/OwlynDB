import { macShortcuts } from '../../../../shared/shortcuts';

/** Betriebssystem der Oberfläche (Electron: navigator.platform ist Win32, MacIntel bzw. Linux x86_64) */
export const isMac = /^Mac/i.test(navigator.platform);
export const isWindows = /^Win/i.test(navigator.platform);

/** „Darstellung wie …“ */
export const systemName = isWindows ? 'Windows' : isMac ? 'macOS' : 'das System';

/** Wo Electron die Passwörter verschlüsselt (safeStorage): „über …“ */
export const secretStore = isWindows ? 'Windows' : isMac ? 'den macOS-Schlüsselbund' : 'den Schlüsselbund des Systems';

/** Tastenkürzel im Text in der Schreibweise des Systems: auf dem Mac ⌘ statt Strg (siehe macShortcuts) */
export function keys(text: string): string {
  return isMac ? macShortcuts(text) : text;
}
