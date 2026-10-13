import type { DbvApi } from '../../../../shared/api-types';

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
}

declare global {
  interface Window {
    dbv?: Bridge;
  }
}

/** Alle Aufrufe gehen über die Preload-Brücke in den Electron-Hauptprozess. */
export const api: DbvApi = new Proxy({} as DbvApi, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) => {
      if (!window.dbv) return Promise.reject(new Error('Keine Verbindung zum Hauptprozess (läuft die Oberfläche außerhalb von Electron?)'));
      return window.dbv.call(method, ...args);
    },
});

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
