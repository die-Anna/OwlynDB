import type { CompareItem, ComparePhase, Dialect } from './api-types';
import { commentOut, commentText } from './sql-util';

export const PHASES: ComparePhase[] = ['pre', 'tables', 'post', 'views', 'routines', 'drop'];

const TITLE: Record<ComparePhase, string> = {
  pre: 'geänderte Fremdschlüssel und Indizes entfernen',
  tables: 'Tabellen anlegen und ändern',
  post: 'Indizes und Fremdschlüssel anlegen',
  views: 'Views',
  routines: 'Prozeduren, Funktionen, Trigger',
  drop: 'Löschungen (gibt es nur im Ziel)',
};

/**
 * Löschungen in einer Reihenfolge, die der Server zulässt: erst die Teile bestehender Tabellen (Fremdschlüssel, Indizes,
 * Spalten), dann Routinen und Trigger, dann Views (abhängige zuerst), zuletzt ganze Tabellen (verweisende zuerst – so
 * sortiert compareSchemas sie)
 */
function dropOrder(items: CompareItem[]): CompareItem[] {
  const rank = (i: CompareItem) => (i.kind === 'table' ? (i.status === 'onlyTarget' ? 3 : 0) : i.kind === 'view' ? 2 : 1);
  const groups: CompareItem[][] = [[], [], [], []];
  for (const i of items) groups[rank(i)].push(i);
  groups[2].reverse();
  return groups.flat();
}

/**
 * Abgleich-Skript aus den gewählten Unterschieden, in einer Reihenfolge, die Abhängigkeiten berücksichtigt.
 * Löschungen sind ohne includeDrops auskommentiert (Daten oder Objekte gingen verloren).
 * header: Kommentarzeilen (mit oder ohne „-- “); Namen darin dürfen keine Zeile beenden.
 */
export function compareScript(dialect: Dialect, items: CompareItem[], includeDrops: boolean, header = ''): string {
  const out: string[] = header ? header.split(/\r\n|\r|\n/).map((l) => `-- ${commentText(l.replace(/^--\s?/, ''))}`) : [];
  for (const p of PHASES) {
    const stmts = (p === 'drop' ? dropOrder(items) : items).flatMap((i) => i.script[p] ?? []);
    if (!stmts.length) continue;
    out.push('', `-- ${TITLE[p]}`);
    // SQL Server speichert Kommentare vor CREATE VIEW/PROCEDURE als Teil der Definition: Überschrift als eigener Batch
    if (dialect === 'mssql') out.push('GO');
    if (p === 'drop' && !includeDrops) {
      out.push('-- auskommentiert – Daten oder Objekte gingen verloren; zum Ausführen die Kommentarzeichen entfernen');
      out.push(...stmts.map(commentOut));
    } else {
      out.push(...stmts);
    }
  }
  return out.join('\n') + '\n';
}
