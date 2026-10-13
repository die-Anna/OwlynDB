/** Zellwerte im Ergebnis-Grid: Sortieren, JSON anzeigen, Zeilenenden beim Bearbeiten – ohne Angular, mit Tests */

interface Dec {
  neg: boolean;
  int: string;
  frac: string;
}

/** Dezimalzahl als Text zerlegen (ohne Exponent); null = keine */
function parseDec(s: string): Dec | null {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const int = (m[2] ?? '').replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  // -0 und 0 sind gleich
  return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
}

function compareAbs(a: Dec, b: Dec): number {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const n = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(n, '0');
  const fb = b.frac.padEnd(n, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/**
 * Sortieren numerischer Spalten im Grid: BIGINT, DECIMAL, numeric kommen als Text (sonst verlören sie Stellen) – also
 * als Zahl vergleichen, ohne Umweg über Number (keine Rundung jenseits 2^53). NULL und Standardwert zuerst; was keine
 * Dezimalzahl ist (1e400, NaN, Währungszeichen), nach Number bzw. als Text.
 */
export function compareNumeric(a: unknown, b: unknown): number {
  const na = a === null || a === undefined || a === '';
  const nb = b === null || b === undefined || b === '';
  if (na || nb) return na === nb ? 0 : na ? -1 : 1;
  const pa = parseDec(String(a));
  const pb = parseDec(String(b));
  if (pa && pb) {
    if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
    const c = compareAbs(pa, pb);
    return pa.neg ? -c : c;
  }
  const x = Number(a);
  const y = Number(b);
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x < y ? -1 : 1;
  return String(a).localeCompare(String(b));
}

/**
 * JSON gut lesbar einrücken, ohne es zu parsen und neu zu schreiben: JSON.parse rundete Zahlen über 2^53, machte aus
 * 1e400 null, zöge ganzzahlige Schlüssel nach vorn und verlöre doppelte. Hier werden nur Leerraum und Umbrüche gesetzt,
 * jedes Zeichen außerhalb davon bleibt. null = kein gültiges JSON.
 */
export function formatJson(text: string, indent = 2): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = '';
  let level = 0;
  let inString = false;
  let escaped = false;
  const newline = () => '\n' + ' '.repeat(level * indent);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '{' || c === '[') {
      // leer bleibt beisammen: {} bzw. []
      let j = i + 1;
      while (j < text.length && /[ \t\n\r]/.test(text[j])) j++;
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j];
        i = j;
        continue;
      }
      level++;
      out += c + newline();
    } else if (c === '}' || c === ']') {
      level--;
      out += newline() + c;
    } else if (c === ',') {
      out += ',' + newline();
    } else if (c === ':') {
      out += ': ';
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Text aus dem großen Eingabefeld (textarea): der Browser macht aus jedem CRLF ein LF. Hatte der alte Wert CRLF, kommen
 * sie zurück – sonst änderte schon ein einzelnes Wort alle Zeilenenden des Felds.
 */
export function keepLineEndings(old: unknown, edited: string): string {
  if (typeof old !== 'string' || !old.includes('\r\n') || edited.includes('\r')) return edited;
  return edited.replace(/\n/g, '\r\n');
}
