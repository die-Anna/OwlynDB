import { computed, effect, Injectable, signal } from '@angular/core';
import type { ThemeMode } from '../../../../shared/api-types';
import { api } from '../core/api';
import { colorSchemeDark, colorSchemeLight, themeQuartz } from 'ag-grid-community';

const base = themeQuartz.withParams({
  fontFamily: ['Segoe UI', 'system-ui', 'sans-serif'],
  fontSize: 12,
  headerFontSize: 12,
  rowHeight: 24,
  headerHeight: 28,
  spacing: 4,
  wrapperBorderRadius: 0,
  borderRadius: 3,
  cellHorizontalPadding: 8,
  headerFontWeight: 600,
});

const light = base.withPart(colorSchemeLight).withParams({
  backgroundColor: '#ffffff',
  headerBackgroundColor: '#f4f5f7',
  oddRowBackgroundColor: '#fafbfc',
  selectedRowBackgroundColor: '#d8e5fb',
  borderColor: '#d6dadf',
  accentColor: '#2f6fdb',
});

const dark = base.withPart(colorSchemeDark).withParams({
  backgroundColor: '#1e1f22',
  headerBackgroundColor: '#25272b',
  oddRowBackgroundColor: '#222327',
  selectedRowBackgroundColor: '#29406a',
  borderColor: '#3a3d43',
  foregroundColor: '#dfe1e5',
  accentColor: '#4d8af0',
});

export type { ThemeMode };

const STORE = 'dbv.theme';

/** gespeicherte Wahl (fehlt sie oder ist der Speicher nicht lesbar: wie Windows) */
export function storedThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORE);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** an <html>: ohne Attribut gilt die Windows-Einstellung (styles.scss), sonst die Wahl */
export function applyThemeMode(mode: ThemeMode): void {
  const el = document.documentElement;
  if (mode === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', mode);
}

/** Hell/Dunkel: nach Wahl, ohne Wahl wie Windows */
@Injectable({ providedIn: 'root' })
export class Theme {
  private mq = window.matchMedia('(prefers-color-scheme: dark)');
  private systemDark = signal(this.mq.matches);
  readonly mode = signal<ThemeMode>(storedThemeMode());
  readonly dark = computed(() => this.mode() === 'dark' || (this.mode() === 'system' && this.systemDark()));

  constructor() {
    this.mq.addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const m = this.mode();
      applyThemeMode(m);
      // Titelleiste, native Dialoge und Fensterhintergrund (auch beim nächsten Start) – außerhalb von Electron ohne Wirkung.
      // Zurück auf „wie Windows“: die Antwort sagt, ob Windows dunkel ist – das change-Ereignis der Media-Query kommt nach
      // einem Wechsel von themeSource nicht zuverlässig
      api
        .setTheme(m)
        .then((dark) => {
          if (m === 'system') this.systemDark.set(dark);
        })
        .catch(() => undefined);
      try {
        if (m === 'system') localStorage.removeItem(STORE);
        else localStorage.setItem(STORE, m);
      } catch {
        // ohne Speicher gilt die Wahl bis zum Neustart
      }
    });
  }

  setMode(m: ThemeMode): void {
    this.mode.set(m);
  }

  grid() {
    return this.dark() ? dark : light;
  }
}
