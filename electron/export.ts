import ExcelJS from 'exceljs';
import { createWriteStream, promises as fs, WriteStream } from 'node:fs';
import { EXCEL_MAX_ROWS, type Cell, type ExportOptions, type ResultColumn } from '../shared/api-types';
import { literal, quoteIdent } from '../shared/sql-util';

/** Werte beim Export: wie im Grid, aber Binärdaten vollständig */
export type ExportCell = Cell | Buffer;

export interface ExportWriter {
  begin(columns: ResultColumn[]): Promise<void>;
  rows(batch: ExportCell[][]): Promise<void>;
  /** Hinweis des Lesers zum Ergebnis */
  note(text: string): void;
  /** fertig schreiben und erst jetzt die Zieldatei ersetzen */
  end(): Promise<void>;
  /** bei Fehler: halbe Datei löschen – eine vorhandene Zieldatei bleibt unverändert */
  abort(): Promise<void>;
  readonly count: number;
  /** Hinweise zum Ergebnis, z. B. gekürzte Excel-Zellen */
  notes(): string[];
}

/** mehr Zeichen fasst eine Excel-Zelle nicht (längere Werte machen die Datei beim Öffnen „beschädigt“) */
const EXCEL_MAX_CELL = 32_767;

/** geschrieben wird in <datei>.part; erst wenn alles da ist, ersetzt sie die Zieldatei */
export function partFile(file: string): string {
  return `${file}.part`;
}

/** Fehler beim Öffnen, Schreiben oder Ersetzen: gesperrte Datei (z. B. in Excel geöffnet) verständlich melden */
export function fileError(e: unknown, file: string): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error(`${file} ist gesperrt oder schreibgeschützt (z. B. in Excel geöffnet) – die bisherige Datei bleibt unverändert.`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Datenstrom zerstören und warten, bis er zu ist – erst danach lässt sich seine Datei sicher löschen (ein Strom, der die
 * Datei noch öffnet, legte sie sonst nach dem Löschen wieder an). Frist 2 s, falls „close“ ausbleibt.
 */
export async function closeStream(s: NodeJS.WritableStream & { closed?: boolean; destroy(): void; once(e: 'close', f: () => void): unknown }): Promise<void> {
  if (s.closed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    s.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    s.destroy();
  });
}

/** fertige Nachbardatei an die Stelle der Zieldatei setzen; scheitert das, verschwindet nur die Nachbardatei */
export async function replaceWith(part: string, file: string): Promise<void> {
  try {
    await fs.rename(part, file);
  } catch (e) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw fileError(e, file);
  }
}

export function createWriter(file: string, opts: ExportOptions): ExportWriter {
  switch (opts.format) {
    case 'csv':
      return new CsvWriter(file, opts);
    case 'json':
      return new JsonWriter(file);
    case 'sql':
      return new SqlWriter(file, opts);
    case 'xlsx':
      return new XlsxWriter(file);
  }
}

/** Zahl als Text, die verlustfrei als JS-Zahl geht (höchstens 15 Ziffern) */
function asNumber(v: ExportCell, col: ResultColumn): ExportCell | number {
  if (!col.numeric || typeof v !== 'string') return v;
  if (!/^-?\d+(\.\d+)?$/.test(v) || v.replace(/[-.]/g, '').replace(/^0+/, '').length > 15) return v;
  return Number(v);
}

function hex(b: Buffer): string {
  return '0x' + b.toString('hex').toUpperCase();
}

abstract class StreamWriter implements ExportWriter {
  protected out: WriteStream;
  private part: string;
  /** erster Fehler des Datenstroms – auch einer zwischen zwei Schreibaufrufen (ohne Empfänger stürzte der Hauptprozess ab) */
  private failure?: Error;
  /** Datei geöffnet (oder das Öffnen gescheitert): erst dann schreiben, damit ein fehlender Ordner sofort auffällt und nicht erst beim ersten vollen Stapel */
  private readonly opened: Promise<void>;
  count = 0;

  constructor(protected file: string) {
    this.part = partFile(file);
    this.out = createWriteStream(this.part, { encoding: 'utf8' });
    this.out.on('error', (e) => (this.failure ??= fileError(e, file)));
    this.opened = new Promise<void>((resolve) => {
      this.out.once('open', () => resolve());
      this.out.once('error', () => resolve());
    });
  }

  abstract begin(columns: ResultColumn[]): Promise<void>;
  abstract rows(batch: ExportCell[][]): Promise<void>;

  private extraNotes: string[] = [];

  /** Hinweis des Lesers (z. B. Felder, die erst nach dem Kopf auftauchten) – erscheint im Ergebnis */
  note(text: string): void {
    this.extraNotes.push(text);
  }

  notes(): string[] {
    return [...this.extraNotes];
  }

  private check() {
    if (this.failure) throw this.failure;
    if (this.out.destroyed) throw new Error('Die Exportdatei wurde unterwegs geschlossen.');
  }

  /** mit Gegendruck schreiben; endet mit Fehler, wenn der Datenstrom unterwegs scheitert (statt ewig auf drain zu warten) */
  protected async write(chunk: string): Promise<void> {
    await this.opened;
    this.check();
    if (!this.out.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.out.off('drain', done);
          this.out.off('close', done);
          this.out.off('error', done);
          resolve();
        };
        this.out.on('drain', done);
        this.out.on('close', done);
        this.out.on('error', done);
      });
    }
    this.check();
  }

  async end(): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const onClose = () => (this.failure ? reject(this.failure) : resolve());
      this.out.once('close', onClose);
      this.out.end((e?: Error | null) => {
        this.out.off('close', onClose);
        if (e || this.failure) reject(this.failure ?? fileError(e, this.file));
        else resolve();
      });
    });
    await replaceWith(this.part, this.file);
  }

  async abort(): Promise<void> {
    await closeStream(this.out);
    await fs.rm(this.part, { force: true });
  }
}

/** Zelle, die Excel als Formel auswerten würde: mit Apostroph davor bleibt sie Text (OWASP: CSV-Injection) */
const FORMULA_START = /^[=+\-@\t\r]/;

class CsvWriter extends StreamWriter {
  private sep: string;
  private numeric: boolean[] = [];
  private protect: boolean;

  constructor(
    file: string,
    private opts: ExportOptions,
  ) {
    super(file);
    this.sep = opts.delimiter ?? ';';
    this.protect = opts.protectFormulas !== false;
  }

  private field(v: ExportCell, textual = false): string {
    if (v === null) return '';
    let s = Buffer.isBuffer(v) ? hex(v) : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    // Textwerte, die mit =, +, -, @ beginnen: Excel wertete sie beim Öffnen als Formel aus (Zahlen aus Zahlspalten nicht)
    if (textual && this.protect && typeof v === 'string' && FORMULA_START.test(s)) s = "'" + s;
    return s.includes(this.sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async begin(columns: ResultColumn[]) {
    this.numeric = columns.map((c) => c.numeric);
    let head = this.opts.bom !== false ? '﻿' : '';
    if (this.opts.header !== false) head += columns.map((c) => this.field(c.name, true)).join(this.sep) + '\r\n';
    if (head) await this.write(head);
  }

  async rows(batch: ExportCell[][]) {
    this.count += batch.length;
    await this.write(batch.map((r) => r.map((v, j) => this.field(v, !this.numeric[j])).join(this.sep) + '\r\n').join(''));
  }
}

class JsonWriter extends StreamWriter {
  private keys: string[] = [];
  private cols: ResultColumn[] = [];

  async begin(columns: ResultColumn[]) {
    this.cols = columns;
    // doppelte Spaltennamen (Joins) eindeutig machen
    const seen = new Map<string, number>();
    this.keys = columns.map((c) => {
      const n = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, n);
      return n === 1 ? c.name : `${c.name}_${n}`;
    });
    await this.write('[');
  }

  async rows(batch: ExportCell[][]) {
    const parts = batch.map((r, i) => {
      const o: Record<string, unknown> = {};
      r.forEach((v, j) => (o[this.keys[j]] = Buffer.isBuffer(v) ? hex(v) : asNumber(v, this.cols[j])));
      return (this.count + i === 0 ? '\n  ' : ',\n  ') + JSON.stringify(o);
    });
    this.count += batch.length;
    await this.write(parts.join(''));
  }

  override async end() {
    await this.write(this.count ? '\n]\n' : ']\n');
    await super.end();
  }
}

class SqlWriter extends StreamWriter {
  private head = '';
  private cols: ResultColumn[] = [];
  private pending: string[] = [];

  constructor(
    file: string,
    private opts: ExportOptions,
  ) {
    super(file);
  }

  private value(v: ExportCell, col: ResultColumn): string {
    const d = this.opts.dialect ?? 'mysql';
    // MySQL kennt 0x nur mit mindestens einer Ziffer – ein leerer Binärwert ist X''
    if (Buffer.isBuffer(v)) return d === 'postgres' ? `'\\x${v.toString('hex')}'` : d === 'mysql' && !v.length ? "X''" : hex(v);
    return literal(d, v, col.numeric);
  }

  async begin(columns: ResultColumn[]) {
    const d = this.opts.dialect ?? 'mysql';
    this.cols = columns;
    this.head = `INSERT INTO ${this.opts.sqlTable || 'export'} (${columns.map((c) => quoteIdent(d, c.name)).join(', ')}) VALUES\n`;
  }

  private async flush() {
    if (!this.pending.length) return;
    await this.write(this.head + this.pending.join(',\n') + ';\n');
    this.pending = [];
  }

  async rows(batch: ExportCell[][]) {
    // SQL Server erlaubt höchstens 1000 Zeilen pro VALUES
    const per = Math.min(Math.max(1, this.opts.rowsPerInsert ?? 100), 1000);
    for (const r of batch) {
      this.pending.push('  (' + r.map((v, j) => this.value(v, this.cols[j])).join(', ') + ')');
      if (this.pending.length >= per) await this.flush();
    }
    this.count += batch.length;
  }

  override async end() {
    await this.flush();
    await super.end();
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?$/;

/**
 * Datum für Excel – nur, wenn es eines ist, das Excel darstellen kann: ab 1900, Monat und Tag gültig. Sonst null, dann
 * bleibt der Text (Date.UTC machte aus 0001-01-01 den 01.01.1901 und aus 2024-00-00 den 30.11.2023).
 */
function excelDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date | null {
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null;
}

/** Excel: echte Zahlen und Datumswerte, damit man damit rechnen und filtern kann */
class XlsxWriter implements ExportWriter {
  private wb: ExcelJS.stream.xlsx.WorkbookWriter;
  private ws!: ExcelJS.Worksheet;
  private cols: ResultColumn[] = [];
  private dateCols: boolean[] = [];
  private part: string;
  /** eigener Datenstrom: ExcelJS schluckt Fehler seines eigenen, dann warteten end() und abort() ewig */
  private out: WriteStream;
  private failure?: Error;
  private failed: Promise<never>;
  /** so viele Zellen waren länger, als Excel fasst */
  private cut = 0;
  count = 0;

  constructor(private file: string) {
    this.part = partFile(file);
    this.out = createWriteStream(this.part);
    let fail!: (e: Error) => void;
    this.failed = new Promise<never>((_, reject) => (fail = reject));
    this.failed.catch(() => undefined);
    this.out.on('error', (e) => {
      this.failure ??= fileError(e, file);
      fail(this.failure);
    });
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: this.out, useStyles: true, useSharedStrings: false });
  }

  private extraNotes: string[] = [];

  note(text: string): void {
    this.extraNotes.push(text);
  }

  notes(): string[] {
    return [
      ...(this.cut ? [`${this.cut.toLocaleString('de-CH')} Zelle(n) mit mehr als ${EXCEL_MAX_CELL.toLocaleString('de-CH')} Zeichen gekürzt – mehr fasst Excel nicht; vollständig als CSV oder JSON.`] : []),
      ...this.extraNotes,
    ];
  }

  /** Text, den Excel noch fasst: zu lange Werte gekürzt, mit Hinweis in der Zelle */
  private fit(s: string): string {
    if (s.length <= EXCEL_MAX_CELL) return s;
    this.cut++;
    const note = ` … (gekürzt, ${s.length.toLocaleString('de-CH')} Zeichen)`;
    return s.slice(0, EXCEL_MAX_CELL - note.length) + note;
  }

  async begin(columns: ResultColumn[]) {
    if (this.failure) throw this.failure;
    this.cols = columns;
    this.dateCols = columns.map((c) => /date|timestamp/i.test(c.typeName));
    this.ws = this.wb.addWorksheet('Export', { views: [{ state: 'frozen', ySplit: 1 }] });
    this.ws.columns = columns.map((c) => ({ header: c.name, width: Math.min(40, Math.max(10, c.name.length + 2)) }));
    const head = this.ws.getRow(1);
    head.font = { bold: true };
    if (columns.length) this.ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    head.commit();
  }

  private cell(v: ExportCell, j: number): ExcelJS.CellValue {
    if (v === null) return null;
    if (Buffer.isBuffer(v)) return this.fit(hex(v));
    if (this.dateCols[j] && typeof v === 'string') {
      let m = DATE_TIME.exec(v);
      const date = m
        ? excelDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +(m[7] ?? '0').padEnd(3, '0'))
        : (m = DATE_ONLY.exec(v))
          ? excelDate(+m[1], +m[2], +m[3])
          : null;
      if (date) return date;
    }
    const x = asNumber(v, this.cols[j]);
    return (typeof x === 'string' ? this.fit(x) : x) as ExcelJS.CellValue;
  }

  async rows(batch: ExportCell[][]) {
    if (this.failure) throw this.failure;
    if (this.count + batch.length > EXCEL_MAX_ROWS) {
      throw new Error(`Excel fasst höchstens ${EXCEL_MAX_ROWS.toLocaleString('de-CH')} Zeilen. Bitte filtern oder als CSV exportieren.`);
    }
    for (const r of batch) {
      const row = this.ws.addRow(r.map((v, j) => this.cell(v, j)));
      r.forEach((v, j) => {
        if (this.dateCols[j] && typeof v === 'string') {
          const c = row.getCell(j + 1);
          if (c.value instanceof Date) c.numFmt = DATE_ONLY.test(v) ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss';
        }
      });
      row.commit();
    }
    this.count += batch.length;
  }

  async end() {
    if (this.failure) throw this.failure;
    this.ws.commit();
    await Promise.race([this.wb.commit(), this.failed]);
    await replaceWith(this.part, this.file);
  }

  /** halbe Arbeitsmappe nicht noch fertig schreiben (hing bei einem kaputten Datenstrom) – Strom zu, Nachbardatei weg */
  async abort() {
    await closeStream(this.out);
    await fs.rm(this.part, { force: true });
  }
}
