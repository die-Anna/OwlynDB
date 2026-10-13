const MAC_MOD: Record<string, string> = { Strg: '⌘', Umschalt: '⇧', Alt: '⌥' };
// Reihenfolge wie in den Menüs von macOS
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];
const SHORTCUT = /((?:(?:Strg|Umschalt|Alt)\+)+)(Enter|Leertaste|Klick|Mausrad|F\d{1,2}|[A-Z0-9])(?![\wäöüß])|\bEntf\b/g;

/**
 * Tastenkürzel in einem Text („Strg+Umschalt+F“, „Strg+Klick“, „Entf“) in der Schreibweise des Mac (⇧⌘F, ⌘-Klick, ⌫).
 * Strg wird ⌘ – die Kürzel selbst nehmen überall Strg oder ⌘ (ctrlKey || metaKey, im Editor KeyMod.CtrlCmd) –, außer bei
 * Strg+Leertaste: ⌘-Leertaste ist Spotlight, der Editor schlägt auf dem Mac mit ⌃-Leertaste vor.
 */
export function macShortcuts(text: string): string {
  return text.replace(SHORTCUT, (_all, mods: string | undefined, key: string | undefined) => {
    if (!mods || !key) return '⌫';
    const syms = mods
      .split('+')
      .filter(Boolean)
      .map((m) => (m === 'Strg' && key === 'Leertaste' ? '⌃' : MAC_MOD[m]));
    const mod = MAC_ORDER.filter((s) => syms.includes(s)).join('');
    if (key === 'Klick' || key === 'Mausrad' || key === 'Leertaste') return `${mod}-${key}`;
    return mod + (key === 'Enter' ? '↩' : key);
  });
}
