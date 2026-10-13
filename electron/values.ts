/* Vergleichsform von Werten: gleiche Werte sehen über Datenbanktypen hinweg gleich aus (Datenvergleich, Teil-Dump) */
import { NUMERIC_TYPE } from './drivers/common';
import type { ExportCell } from './export';

export type Kind = 'num' | 'date' | 'time' | 'datetime' | 'uuid' | 'json' | 'other';

export interface CanonOptions {
  ignoreCase: boolean;
  trailing: boolean;
}

/** Art der Spalte, damit gleiche Werte über Datenbanktypen hinweg gleich aussehen */
export function kindOf(dataType: string): Kind {
  const t = dataType.toLowerCase().trim();
  if (/^(uuid|uniqueidentifier)$/.test(t)) return 'uuid';
  if (/^jsonb?$/.test(t)) return 'json';
  if (t === 'date') return 'date';
  if (/^time(\(\d+\))?( without time zone)?$/.test(t)) return 'time';
  if (/date|time/.test(t)) return 'datetime';
  if (NUMERIC_TYPE.test(t) || /^(dec|double precision|smallmoney)\b/.test(t)) return 'num';
  return 'other';
}

const NUM = /^([+-]?)0*(\d*)(?:\.(\d*?)0*)?$/;

/** Zahl ohne führende und nachgestellte Nullen: 1.50 = 1.5, 007 = 7, -0.0 = 0 */
function num(s: string): string {
  const m = NUM.exec(s.trim());
  if (!m || (!m[2] && m[3] === undefined)) return s;
  const int = m[2] || '0';
  const frac = m[3] ?? '';
  const neg = m[1] === '-' && (int !== '0' || frac !== '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

/** Datum/Zeit ohne nachgestellte Nullen; Datum ohne 00:00:00, Uhrzeit ohne 1970-01-01 (so liefern es manche Treiber) */
function dateTime(s: string, kind: Kind): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d*?)0*)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s.trim());
  if (m) {
    const [, d, t, f, z] = m;
    if (kind === 'time' && d === '1970-01-01' && !z) return t + (f ? '.' + f : '');
    if (kind === 'date' && t === '00:00:00' && !f && !z) return d;
    return `${d} ${t}${f ? '.' + f : ''}${z ?? ''}`;
  }
  const t = /^(\d{2}:\d{2}:\d{2})(?:\.(\d*?)0*)?$/.exec(s.trim());
  return t ? t[1] + (t[2] ? '.' + t[2] : '') : s;
}

/** Zahl aus dem JSON-Text, wie sie dort steht (JSON.parse rundete Ganzzahlen über 2^53) */
class RawNumber {
  constructor(readonly text: string) {}
}

/** JSON mit sortierten Schlüsseln, ohne Leerzeichen; Zahlen in ihrer Vergleichsform aus dem Quelltext */
function stable(x: unknown): string {
  if (x instanceof RawNumber) return x.text;
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(x);
}

/** JSON lesen, Zahlen als Text behalten (Node liefert dem Reviver den Quelltext) */
function parseKeepingNumbers(text: string): unknown {
  const reviver = (_k: string, v: unknown, ctx?: { source?: string }) => (typeof v === 'number' && ctx?.source ? new RawNumber(num(ctx.source)) : v);
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/** Vergleichsform eines Werts */
export function canon(v: ExportCell | undefined, kind: Kind, o: CanonOptions): string | null {
  if (v === null || v === undefined) return null;
  // MySQL BIT(n) kommt als Bytes: als Zahl, damit es dem Boolean/0-1 der anderen Datenbank gleicht
  if (Buffer.isBuffer(v)) return kind === 'num' && v.length <= 8 ? (v.length ? BigInt('0x' + v.toString('hex')).toString() : '0') : '\\x' + v.toString('hex');
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return num(String(v));
  switch (kind) {
    case 'num':
      return num(v);
    case 'date':
    case 'time':
    case 'datetime':
      return dateTime(v, kind);
    case 'uuid':
      return v.toLowerCase();
    case 'json':
      try {
        return stable(parseKeepingNumbers(v));
      } catch {
        return v;
      }
  }
  let s = v;
  if (o.trailing) s = s.replace(/ +$/, '');
  if (o.ignoreCase) s = s.toLowerCase();
  return s;
}
