import type { Cell, RowChange } from './api-types';

/** Zeile im Grid; undefined = in einer neuen Zeile nicht gesetzt (der Server nimmt den Standardwert) */
export type EditRow = (Cell | undefined)[];

/** gleicher Wert (12 und "12" zählen als gleich – das Grid liefert Eingaben als Text) */
export function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  return a === b || (a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b));
}

/**
 * Bearbeiten in der Tabellenansicht: geänderte, neue und gelöschte Zeilen. Die Zeilen sind die Objekte des Grids (es
 * zählt die Identität); das Grid schreibt neue Werte direkt hinein, hier steht, was vorher war und was daraus an den
 * Server geht (changes). Ohne Angular, damit es sich mit node:test prüfen lässt.
 */
export class EditState {
  private edits = new Map<EditRow, { original: EditRow; changed: Set<number> }>();
  private added = new Set<EditRow>();
  private deleted = new Set<EditRow>();

  /** geänderte, neue und gelöschte Zeilen */
  get pending(): number {
    return this.edits.size + this.added.size + this.deleted.size;
  }

  isAdded(row: EditRow): boolean {
    return this.added.has(row);
  }

  isDeleted(row: EditRow): boolean {
    return this.deleted.has(row);
  }

  isChanged(row: EditRow, col: number): boolean {
    return this.added.has(row) ? row[col] !== undefined : !!this.edits.get(row)?.changed.has(col);
  }

  rowState(row: EditRow): 'new' | 'deleted' | 'changed' | null {
    return this.added.has(row) ? 'new' : this.deleted.has(row) ? 'deleted' : this.edits.has(row) ? 'changed' : null;
  }

  /** das Grid hat row[col] auf value gesetzt; previous = Wert davor. Zurück auf den Ausgangswert = keine Änderung mehr */
  cellEdited(row: EditRow, col: number, value: Cell, previous: Cell | undefined): void {
    if (this.added.has(row)) return;
    let ed = this.edits.get(row);
    if (!ed) {
      const original = [...row];
      original[col] = previous;
      ed = { original, changed: new Set() };
      this.edits.set(row, ed);
    }
    if (sameCell(value, ed.original[col])) ed.changed.delete(col);
    else ed.changed.add(col);
    if (!ed.changed.size) this.edits.delete(row);
  }

  /** Zelle auf NULL (Strg+0); false = war schon NULL */
  setNull(row: EditRow, col: number): boolean {
    const prev = row[col];
    if (prev === null) return false;
    row[col] = null;
    this.cellEdited(row, col, null, prev);
    return true;
  }

  add(row: EditRow): void {
    this.added.add(row);
  }

  /** zum Löschen vormerken; Rückgabe: neue Zeilen, die damit ganz wegfallen (aus dem Grid nehmen) */
  delete(rows: EditRow[]): EditRow[] {
    const gone = rows.filter((r) => this.added.has(r));
    for (const r of rows) {
      if (!this.added.has(r)) this.deleted.add(r);
      this.added.delete(r);
    }
    return gone;
  }

  /** Änderungen dieser Zeilen verwerfen (Werte zurück, Löschen aufheben); Rückgabe: neue Zeilen, die wegfallen */
  revert(rows: EditRow[]): EditRow[] {
    const gone = rows.filter((r) => this.added.has(r));
    for (const r of rows) {
      const ed = this.edits.get(r);
      if (ed) ed.original.forEach((v, i) => (r[i] = v));
      this.edits.delete(r);
      this.deleted.delete(r);
      this.added.delete(r);
    }
    return gone;
  }

  /** alles verwerfen; Rückgabe: neue Zeilen (aus dem Grid nehmen) */
  discard(): EditRow[] {
    for (const [r, ed] of this.edits) ed.original.forEach((v, i) => (r[i] = v));
    const gone = [...this.added];
    this.clear();
    return gone;
  }

  /** nach Speichern bzw. Neuladen: neue Zeilen-Objekte, alte Stände gelten nicht mehr */
  clear(): void {
    this.edits.clear();
    this.added.clear();
    this.deleted.clear();
  }

  /**
   * Aufträge an den Server: löschen und ändern über den ursprünglichen Schlüssel (auch wenn eine Schlüsselspalte
   * geändert wurde), ändern nur die geänderten Spalten samt ihrem Ausgangswert (erkennt Änderungen anderer),
   * einfügen nur gesetzte Spalten. columns = Spaltennamen in Grid-Reihenfolge, key = Schlüsselspalten.
   */
  changes(columns: string[], key: string[]): RowChange[] {
    const idx = (n: string) => columns.indexOf(n);
    const keyOf = (orig: EditRow) => Object.fromEntries(key.map((k) => [k, (orig[idx(k)] ?? null) as Cell]));
    const out: RowChange[] = [];
    for (const r of this.deleted) out.push({ kind: 'delete', key: keyOf(this.edits.get(r)?.original ?? r) });
    for (const [r, ed] of this.edits) {
      if (this.deleted.has(r)) continue;
      const values: Record<string, Cell> = {};
      const original: Record<string, Cell> = {};
      for (const i of ed.changed) {
        values[columns[i]] = (r[i] ?? null) as Cell;
        original[columns[i]] = (ed.original[i] ?? null) as Cell;
      }
      out.push({ kind: 'update', key: keyOf(ed.original), values, original });
    }
    for (const r of this.added) {
      const values: Record<string, Cell> = {};
      r.forEach((v, i) => {
        if (v !== undefined) values[columns[i]] = v;
      });
      out.push({ kind: 'insert', values });
    }
    return out;
  }
}
