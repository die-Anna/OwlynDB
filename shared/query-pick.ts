import type { Dialect, StatementInput } from './api-types';
import { splitEs } from './es-console';
import { batchHasSeveralStatements, readOnlyViolation, riskyStatements } from './sql-guard';
import { splitSql, statementAt, type SplitStatement } from './sql-splitter';

/** Abfrage-Tab: was ausgeführt werden soll – ohne Editor, damit es sich ohne Oberfläche prüfen lässt */
export interface PickRequest {
  /** ganzer Text des Editors */
  text: string;
  /** Markierung als Offsets im Text; fehlt oder leer = keine */
  selection?: { start: number; end: number };
  /** Cursor als Offset im Text */
  cursor: number;
  /** current = Anweisung unter dem Cursor (Strg+Enter), all = alles (F5) */
  mode: 'current' | 'all';
  dialect: Dialect;
}

export interface Picked {
  /** Anweisungen mit ihrem Offset im ganzen Text (Fehlermarker) */
  input: StatementInput[];
  /** Bereiche zum Hervorheben im Editor */
  ranges: [number, number][];
  /** genau eine Anweisung unter dem Cursor: dann die Rückfrage, ob darin mehrere stecken (SQL Server ohne „;“) */
  single: boolean;
}

/** Eine Markierung hat immer Vorrang, sonst alles (all) bzw. die Anweisung unter dem Cursor (current); null = nichts */
export function pickStatements(r: PickRequest): Picked | null {
  const split = (t: string): SplitStatement[] => (r.dialect === 'elasticsearch' ? splitEs(t) : splitSql(t, r.dialect));
  let base = 0;
  let stmts: SplitStatement[];
  if (r.selection && r.selection.end > r.selection.start) {
    base = r.selection.start;
    stmts = split(r.text.slice(r.selection.start, r.selection.end));
  } else {
    stmts = split(r.text);
    if (r.mode === 'current') {
      const s = statementAt(stmts, r.text, r.cursor);
      stmts = s ? [s] : [];
    }
  }
  if (!stmts.length) return null;
  // SQL Server „GO n“: die ausgewählten Anweisungen eines Batches laufen als Gruppe n-mal (a, b, a, b – wie in SSMS)
  const input: StatementInput[] = [];
  for (let i = 0; i < stmts.length; ) {
    let j = i + 1;
    while (j < stmts.length && stmts[i].batch !== undefined && stmts[j].batch === stmts[i].batch) j++;
    const group = stmts.slice(i, j).map((s) => ({ sql: s.sql, offset: base + s.start }));
    for (let k = 0; k < (stmts[i].repeat ?? 1); k++) input.push(...group);
    i = j;
  }
  return {
    input,
    ranges: stmts.map((s) => [base + s.start, base + s.end]),
    single: r.mode === 'current' && stmts.length === 1,
  };
}

export const SEVERAL_IN_BATCH = 'Ohne „;“ oder GO gehören mehrere Zeilen zu dieser Anweisung – sie werden alle zusammen ausgeführt (markiert).';

/**
 * Sicherheitsnetz gegen Versehen: Gründe für eine Rückfrage vor dem Ausführen; leer = ohne Rückfrage. Keine bei „Nur
 * lesen“ (der Hauptprozess lehnt Schreibendes ohnehin ab) und bei Elasticsearch (dort lässt er nur Lesendes durch).
 * analyze = Plan mit Laufzeit: die Anweisung läuft dabei wirklich.
 */
export function executeWarnings(picked: Picked, dialect: Dialect, opts: { readOnly: boolean; analyze?: boolean }): string[] {
  if (opts.readOnly || dialect === 'elasticsearch') return [];
  const sqls = picked.input.map((s) => s.sql);
  const warnings = [...(picked.single && batchHasSeveralStatements(sqls[0], dialect) ? [SEVERAL_IN_BATCH] : []), ...riskyStatements(sqls, dialect)];
  if (opts.analyze) {
    const writing = sqls.find((s) => readOnlyViolation(s, dialect));
    if (writing) warnings.unshift(`Mit Laufzeit wird die Anweisung wirklich ausgeführt und kann Daten ändern: ${writing.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  }
  return warnings;
}
