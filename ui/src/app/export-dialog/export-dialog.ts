import { ChangeDetectionStrategy, Component, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EXCEL_MAX_ROWS, type Cell, type Dialect, type ExportFormat, type ExportOptions, type ExportResult, type ResultColumn, type StatementInput, type TableDataRequest } from '../../../../shared/api-types';
import { api, message } from '../core/api';
import { Icon } from '../ui/icon';
import { Modal } from '../ui/modal';

/** Was exportiert werden soll */
export type ExportSource =
  | {
      kind: 'table';
      req: TableDataRequest;
      /** aktuell angezeigte Seite */
      page: { columns: ResultColumn[]; rows: Cell[][] };
      total: number | null;
      baseName: string;
      dialect: Dialect;
      sqlTable: string;
    }
  | {
      kind: 'rows';
      columns: ResultColumn[];
      rows: Cell[][];
      selected: Cell[][];
      truncated: boolean;
      /** abgeschnitten, Zahl aller Zeilen bekannt */
      totalRows?: number;
      /** Binärwerte in der Anzeige gekürzt */
      binaryCut?: boolean;
      /** vollständig: die Anweisung läuft im Tab noch einmal (nur lesende) */
      rerun?: { sessionId: string; statement: StatementInput; resultIndex: number };
      /** warum das nicht geht */
      rerunBlocker?: string;
      baseName: string;
      dialect: Dialect;
      sqlTable: string;
    };

@Injectable({ providedIn: 'root' })
export class ExportService {
  readonly source = signal<ExportSource | null>(null);

  open(s: ExportSource): void {
    this.source.set(s);
  }
}

type Scope = 'all' | 'page' | 'selected' | 'rerun';

interface Saved {
  format: ExportFormat;
  delimiter: ';' | ',' | '\t';
  header: boolean;
  bom: boolean;
  rowsPerInsert: number;
}

const STORE = 'dbv.export';
const DEFAULTS: Saved = { format: 'xlsx', delimiter: ';', header: true, bom: true, rowsPerInsert: 100 };
const fmt = new Intl.NumberFormat('de-CH');

@Component({
  selector: 'app-export-dialog',
  imports: [FormsModule, Icon, Modal],
  templateUrl: './export-dialog.html',
  styleUrl: './export-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportDialog {
  protected svc = inject(ExportService);
  private readonly allFormats: [ExportFormat, string][] = [
    ['xlsx', 'Excel'],
    ['csv', 'CSV'],
    ['json', 'JSON'],
    ['sql', 'SQL INSERT'],
  ];
  /** Elasticsearch: kein SQL-INSERT (es gäbe keinen passenden Zieltyp) */
  protected readonly formats = computed(() => (this.svc.source()?.dialect === 'elasticsearch' ? this.allFormats.filter(([f]) => f !== 'sql') : this.allFormats));
  /** gewähltes Format, sofern es hier geht (die gespeicherte Wahl bleibt für andere Verbindungen) */
  protected readonly format = computed<ExportFormat>(() => (this.formats().some(([f]) => f === this.o().format) ? this.o().format : 'xlsx'));
  protected readonly delimiters: [Saved['delimiter'], string][] = [
    [';', 'Semikolon ;'],
    [',', 'Komma ,'],
    ['\t', 'Tabulator'],
  ];

  protected o = signal<Saved>(load());
  protected scope = signal<Scope>('all');
  protected sqlTable = signal('');
  protected busy = signal(false);
  protected error = signal<string | null>(null);
  protected done = signal<ExportResult | null>(null);

  protected readonly scopes = computed(() => {
    const s = this.svc.source();
    if (!s) return [];
    if (s.kind === 'table') {
      return [
        { id: 'all' as Scope, label: s.total !== null ? `alle ${fmt.format(s.total)} Zeilen` : 'alle Zeilen', hint: s.req.where || s.req.search ? 'mit aktuellem Filter und Sortierung' : 'mit aktueller Sortierung' },
        { id: 'page' as Scope, label: `nur diese Seite (${fmt.format(s.page.rows.length)})`, hint: '' },
      ];
    }
    const list: { id: Scope; label: string; hint: string }[] = [];
    if (s.rerun && (s.truncated || s.binaryCut)) {
      const label = !s.truncated ? 'ganzes Ergebnis mit vollständigen Binärwerten' : s.totalRows !== undefined ? `alle ${fmt.format(s.totalRows)} Zeilen` : 'alle Zeilen';
      list.push({ id: 'rerun', label, hint: 'führt die Abfrage im Tab noch einmal aus' });
    }
    list.push({ id: 'all', label: s.truncated ? `geladene Zeilen (${fmt.format(s.rows.length)})` : `ganzes Ergebnis (${fmt.format(s.rows.length)} Zeilen)`, hint: '' });
    if (s.selected.length > 1) list.push({ id: 'selected', label: `markierte Zeilen (${fmt.format(s.selected.length)})`, hint: '' });
    return list;
  });

  /** Hinweise zum gewählten Umfang: abgeschnitten, Binärwerte gekürzt, warum nicht erneut ausgeführt wird */
  protected readonly warnings = computed(() => {
    const s = this.svc.source();
    const scope = this.scope();
    if (!s || s.kind !== 'rows' || scope === 'rerun') return [];
    const out: string[] = [];
    if (s.truncated && scope === 'all') out.push('Das Ergebnis wurde bei „max. Zeilen“ abgeschnitten – exportiert wird nur, was geladen ist.');
    if (s.binaryCut) out.push('Binärwerte über 1 KB sind in der Anzeige gekürzt und werden so gespeichert.');
    if (out.length && !s.rerun && s.rerunBlocker) out.push(s.rerunBlocker);
    return out;
  });

  /** Export mit erneuter Ausführung bzw. der ganzen Tabelle läuft: lässt sich abbrechen */
  protected readonly cancellable = computed(() => this.busy() && (this.scope() === 'rerun' || (this.svc.source()?.kind === 'table' && this.scope() === 'all')));
  /** Kennzeichen des laufenden Tabellen-Exports (cancelExport) */
  private token = '';

  constructor() {
    effect(() => {
      const s = this.svc.source();
      untracked(() => {
        this.error.set(null);
        this.done.set(null);
        this.busy.set(false);
        if (!s) return;
        // markierte Zeilen haben Vorrang; ein abgeschnittenes Ergebnis exportiert man meist vollständig
        this.scope.set(s.kind === 'rows' && s.selected.length > 1 ? 'selected' : s.kind === 'rows' && s.rerun && (s.truncated || s.binaryCut) ? 'rerun' : 'all');
        this.sqlTable.set(s.sqlTable);
      });
    });
  }

  protected set<K extends keyof Saved>(k: K, v: Saved[K]) {
    this.o.update((x) => ({ ...x, [k]: v }));
    this.done.set(null);
    try {
      localStorage.setItem(STORE, JSON.stringify(this.o()));
    } catch {
      // nur Komfort
    }
  }

  protected async run() {
    const s = this.svc.source();
    if (!s || this.busy()) return;
    const o = this.o();
    const opts: ExportOptions = {
      format: this.format(),
      delimiter: o.delimiter,
      header: o.header,
      bom: o.bom,
      rowsPerInsert: o.rowsPerInsert,
      sqlTable: this.sqlTable().trim() || s.sqlTable,
      dialect: s.dialect,
      baseName: s.baseName,
    };
    // Excel fasst nicht mehr Zeilen: lieber gleich sagen, als nach Stunden beim Schreiben zu scheitern
    const known =
      s.kind === 'table'
        ? this.scope() === 'page'
          ? s.page.rows.length
          : s.total
        : this.scope() === 'rerun'
          ? (s.totalRows ?? null)
          : this.scope() === 'selected'
            ? s.selected.length
            : s.rows.length;
    if (opts.format === 'xlsx' && known !== null && known > EXCEL_MAX_ROWS) {
      this.error.set(`Excel fasst höchstens ${fmt.format(EXCEL_MAX_ROWS)} Zeilen – hier sind es ${fmt.format(known)}. Bitte filtern oder als CSV exportieren.`);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.done.set(null);
    try {
      let r: ExportResult | null;
      if (s.kind === 'table') {
        this.token = crypto.randomUUID();
        r = this.scope() === 'page' ? await api.exportRows(s.page.columns, s.page.rows, opts) : await api.exportTable(s.req, { ...opts, cancelToken: this.token });
      } else if (this.scope() === 'rerun' && s.rerun) {
        r = await api.exportQuery(s.rerun.sessionId, s.rerun.statement, s.rerun.resultIndex, opts);
      } else {
        r = await api.exportRows(s.columns, this.scope() === 'selected' ? s.selected : s.rows, opts);
      }
      this.done.set(r);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected show(file: string) {
    void api.showInFolder(file);
  }

  protected n(v: number) {
    return fmt.format(v);
  }

  protected close() {
    if (!this.busy()) this.svc.source.set(null);
  }

  /** Fußzeile: während des Exports mit erneuter Ausführung bzw. der ganzen Tabelle abbrechen, sonst schließen */
  protected abort() {
    const s = this.svc.source();
    if (this.cancellable() && s?.kind === 'rows' && s.rerun) void api.cancelQuery(s.rerun.sessionId);
    else if (this.cancellable() && s?.kind === 'table') void api.cancelExport(this.token);
    else this.close();
  }

  protected onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}

function load(): Saved {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Saved>) };
  } catch {
    return DEFAULTS;
  }
}
