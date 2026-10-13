/*
 * Elasticsearch im Abfrage-Tab: Anfragen wie in der Kibana-Konsole („GET kunden/_search“ und darunter der JSON-Body)
 * und SQL-Anweisungen (über POST _sql) gemischt in einem Text. Hier: zerlegen, Anfragen lesen, Nur-lesen-Prüfung.
 * OwlynDB schickt an Elasticsearch nur lesende Anfragen (Entscheid 07.10.2026) – geprüft wird im Hauptprozess.
 */
import { splitSql, type SplitStatement } from './sql-splitter';

/** Kopfzeile einer Anfrage: Methode und Pfad, sonst nichts auf der Zeile */
const METHOD_LINE = /^[ \t]*(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S+)[ \t]*$/i;
/** Kommentarzeile außerhalb eines Bodys (wie in Kibana) */
const COMMENT_LINE = /^[ \t]*(#|\/\/)/;

export function isConsoleRequest(text: string): boolean {
  const first = text.trimStart().split('\n', 1)[0].replace(/\r$/, '');
  return METHOD_LINE.test(first);
}

/** Ende eines JSON-Werts ab from (erstes Zeichen { oder [); -1 = nicht geschlossen. Kennt "…" und """…""". */
function jsonValueEnd(text: string, from: number): number {
  let depth = 0;
  let i = from;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const e = text.indexOf('"""', i + 3);
        if (e < 0) return -1;
        i = e + 3;
        continue;
      }
      i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= n) return -1;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** nächste Zeile ab pos, die nicht leer ist: Offset ihres ersten sichtbaren Zeichens, sonst -1 */
function nextContent(text: string, pos: number): number {
  const m = /\S/.exec(text.slice(pos));
  return m ? pos + m.index : -1;
}

/**
 * Zerlegt den Text in Konsolen-Anfragen und SQL-Anweisungen. Eine Anfrage beginnt mit einer Zeile „METHODE pfad“;
 * ihr Body sind die JSON-Werte direkt darunter (mehrere = NDJSON, z. B. für _msearch). Alles andere ist SQL,
 * getrennt mit „;“. Zeilen mit # oder // außerhalb eines Bodys sind Kommentare.
 */
export function splitEs(text: string): SplitStatement[] {
  const out: SplitStatement[] = [];
  const n = text.length;
  // SQL-Bereich: Kommentarzeilen durch Leerzeichen ersetzen (Offsets bleiben), dann wie SQL zerlegen
  const flushSql = (from: number, to: number) => {
    if (to <= from) return;
    const part = text
      .slice(from, to)
      .split('\n')
      .map((l) => (COMMENT_LINE.test(l) ? ' '.repeat(l.length) : l))
      .join('\n');
    for (const s of splitSql(part, 'elasticsearch')) out.push({ sql: s.sql, start: from + s.start, end: from + s.end });
  };
  let sqlFrom = 0;
  let pos = 0;
  while (pos < n) {
    const eol = text.indexOf('\n', pos);
    const lineEnd = eol < 0 ? n : eol;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    if (!METHOD_LINE.test(line)) {
      pos = lineEnd + 1;
      continue;
    }
    flushSql(sqlFrom, pos);
    const start = pos + (line.length - line.trimStart().length);
    let end = pos + line.trimEnd().length;
    let next = lineEnd + 1;
    // Body: JSON-Werte direkt darunter (Leerzeilen dazwischen erlaubt)
    for (;;) {
      if (next >= n) break;
      const c = nextContent(text, next);
      if (c < 0 || (text[c] !== '{' && text[c] !== '[')) break;
      const e = jsonValueEnd(text, c);
      if (e < 0) {
        // nicht geschlossen: bis vor die nächste Anfrage (der Fehler kommt beim Ausführen)
        let stop = n;
        for (let p = text.indexOf('\n', c); p >= 0 && p + 1 < n; p = text.indexOf('\n', p + 1)) {
          const le = text.indexOf('\n', p + 1);
          if (METHOD_LINE.test(text.slice(p + 1, le < 0 ? n : le).replace(/\r$/, ''))) {
            stop = p + 1;
            break;
          }
        }
        end = start + text.slice(start, stop).trimEnd().length;
        next = stop;
        break;
      }
      end = e;
      next = e;
    }
    out.push({ sql: text.slice(start, end), start, end });
    // Rest der letzten Body-Zeile gehört nicht zum SQL danach
    const after = text.indexOf('\n', end);
    pos = after < 0 ? n : after + 1;
    if (next > pos) pos = next;
    sqlFrom = pos;
  }
  flushSql(sqlFrom, n);
  return out.sort((a, b) => a.start - b.start);
}

export interface EsRequest {
  method: string;
  /** ohne führenden Schrägstrich, mit Query-String */
  path: string;
  /** JSON-Text (eine Zeile) bzw. NDJSON mit abschließendem Zeilenumbruch */
  body?: string;
  ndjson: boolean;
}

/** Kibana-Schreibweise in JSON umwandeln: Kommentare weg, """…""" als JSON-Zeichenkette */
export function kibanaToJson(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const e = text.indexOf('"""', i + 3);
        const raw = e < 0 ? text.slice(i + 3) : text.slice(i + 3, e);
        out += JSON.stringify(raw);
        i = e < 0 ? n : e + 3;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** JSON-Werte eines Bodys einzeln (NDJSON: mehrere hintereinander) */
function jsonValues(body: string): string[] {
  const values: string[] = [];
  let i = 0;
  for (;;) {
    const c = nextContent(body, i);
    if (c < 0) break;
    if (body[c] !== '{' && body[c] !== '[') throw new Error(`Der Body enthält nach dem JSON noch Text: „${body.slice(c, c + 30).split('\n')[0]}“`);
    const e = jsonValueEnd(body, c);
    if (e < 0) throw new Error('Der JSON-Body ist nicht geschlossen (fehlt eine } oder ]?).');
    values.push(body.slice(c, e));
    i = e;
  }
  return values;
}

/**
 * Geht der Pfad an _bulk oder _msearch (Body = NDJSON, auch mit nur einem Wert)? Geprüft wird nur der Pfad vor dem „?“
 * (F292: „GET k/_search?x=/_bulk“ ist keine NDJSON-Anfrage). Darf auch die ganze Kopfzeile sein: davor stehen dann
 * Methode und Leerzeichen bzw. Tabulator statt eines Schrägstrichs („POST _bulk“).
 */
function isNdjsonPath(pathOrHead: string): boolean {
  return /(^|[ \t/])_(msearch|bulk)(\/|$)/.test(pathOrHead.split('?')[0]);
}

/** Anfrage aus dem Editor-Text lesen; wirft bei ungültigem JSON eine verständliche Meldung */
export function parseRequest(text: string): EsRequest {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const head = (nl < 0 ? t : t.slice(0, nl)).replace(/\r$/, '');
  const m = METHOD_LINE.exec(head);
  if (!m) throw new Error('Keine Anfrage: die erste Zeile muss „METHODE pfad“ sein, z. B. GET kunden/_search');
  const method = m[1].toUpperCase();
  const path = m[2].replace(/^\/+/, '');
  const rest = nl < 0 ? '' : t.slice(nl + 1);
  const values = jsonValues(rest);
  if (!values.length) return { method, path, ndjson: false };
  const parsed = values.map((v, k) => {
    const json = kibanaToJson(v);
    try {
      // nur prüfen – nicht neu aufbauen: JSON.parse machte aus Ganzzahlen über 2^53 ungenaue Zahlen und sortierte Schlüssel um
      JSON.parse(json);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`Der JSON-Body${values.length > 1 ? ` (Teil ${k + 1})` : ''} ist ungültig: ${why}`);
    }
    return reflowJson(json, true);
  });
  if (parsed.length === 1 && !isNdjsonPath(path)) return { method, path, body: parsed[0], ndjson: false };
  return { method, path, body: parsed.join('\n') + '\n', ndjson: true };
}

/** Ende einer Zeichenkette ab i (" oder """) */
function stringEnd(text: string, i: number): number {
  if (text.startsWith('"""', i)) {
    const e = text.indexOf('"""', i + 3);
    return e < 0 ? text.length : e + 3;
  }
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

/** JSON neu einrücken bzw. (oneLine) auf eine Zeile bringen; Zeichenketten, Zahlen und Kommentare bleiben unverändert */
function reflowJson(src: string, oneLine: boolean): string {
  // Ausgabe in Teilen: das Glätten vor einer schließenden Klammer sieht nur den letzten Teil an – ein replace über den
  // ganzen bisherigen Text machte das Formatieren quadratisch (2 000 Treffer-Objekte: 15 s, die Oberfläche stand)
  const parts: string[] = [];
  let depth = 0;
  const nl = () => (oneLine ? '' : '\n' + '  '.repeat(depth));
  const ws = /\s*/y;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      const e = stringEnd(src, i);
      parts.push(src.slice(i, e));
      i = e;
    } else if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      // Zeilenkommentar auf einer Zeile ginge nicht – dann als Blockkommentar. Ein „*/“ im Kommentartext würde ihn vorzeitig
      // beenden und den Rest als Text im JSON zurücklassen (F292) – es wird zu „* /“; nur der Kommentar ändert sich.
      parts.push(oneLine ? `/* ${src.slice(i + 2, end).trim().replace(/\*\//g, '* /')} */` : src.slice(i, end).trimEnd() + nl());
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      parts.push(src.slice(i, end));
      i = end;
    } else if (c === '{' || c === '[') {
      ws.lastIndex = i + 1;
      const m = ws.exec(src)![0].length;
      if (src[i + 1 + m] === (c === '{' ? '}' : ']')) {
        parts.push(c + src[i + 1 + m]);
        i += m + 2;
      } else {
        depth++;
        parts.push(c + nl());
        i++;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      // Leerraum am Ende weg (der Einzug nach einem Umbruch); nach einem Zeilenkommentar steht der Umbruch schon da
      while (parts.length) {
        const last = parts[parts.length - 1].replace(/[ \t]+$/, '');
        if (last) {
          parts[parts.length - 1] = last;
          break;
        }
        parts.pop();
      }
      parts.push((parts.length && parts[parts.length - 1].endsWith('\n') ? '  '.repeat(depth) : nl()) + c);
      i++;
    } else if (c === ',') {
      parts.push(',' + (oneLine ? '' : nl()));
      i++;
    } else if (c === ':') {
      parts.push(oneLine ? ':' : ': ');
      i++;
    } else {
      let j = i;
      while (j < src.length && !/[\s,:{}[\]"]/.test(src[j]) && !(src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*'))) j++;
      parts.push(src.slice(i, Math.max(j, i + 1)));
      i = Math.max(j, i + 1);
    }
  }
  return parts.join('');
}

/** Anfrage formatieren: Kopfzeile, Body eingerückt; bei _msearch/_bulk (NDJSON) je Wert eine Zeile */
export function formatRequest(text: string): string {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const head = (nl < 0 ? t : t.slice(0, nl)).trim();
  if (nl < 0) return head;
  const values = jsonValues(t.slice(nl + 1));
  if (!values.length) return head;
  // head enthält die Methode: vor „_bulk“ ohne Schrägstrich steht ein Leerzeichen (F292, sonst würde „POST _bulk“ mit nur einem Wert nicht als NDJSON erkannt)
  const nd = values.length > 1 || isNdjsonPath(head);
  return head + '\n' + values.map((v) => reflowJson(v, nd)).join('\n');
}

/** POST an genau diese Pfade (nach dem Index-Ziel) liest nur: Suche, Zählen, SQL, Erklären … */
const READ_POST = new Set([
  '_search', '_msearch', '_count', '_sql', '_sql/translate', '_sql/close', '_field_caps', '_validate/query', '_mget',
  '_search/scroll', '_search/template', '_msearch/template', '_render/template', '_termvectors', '_mtermvectors', '_analyze',
  '_rank_eval', '_async_search', '_pit', '_eql/search', '_terms_enum', '_knn_search', '_search_shards', '_query',
]);
/** POST mit genau einer Dokument-ID dahinter: _explain/{id}, _termvectors/{id} */
const READ_POST_WITH_ID = new Set(['_explain', '_termvectors']);
/** DELETE räumt hier nur Lese-Kontexte ab, keine Daten; _async_search/{id} mit ID */
const READ_DELETE = new Set(['_search/scroll', '_pit']);
const READ_DELETE_WITH_ID = new Set(['_async_search']);
/** GET/HEAD an diese Endpunkte ändert trotzdem etwas (Index aktualisieren, leeren, zusammenlegen, öffnen/schließen) */
const WRITE_GET = new Set(['_refresh', '_flush', '_cache', '_forcemerge', '_open', '_close', '_freeze', '_unfreeze', '_clear_scroll', '_reload_search_analyzers']);

/**
 * Nur lesen: null = Anfrage liest nur. GET und HEAD lesen (bis auf _refresh, _flush, _cache/clear …); POST nur an
 * Such- und Lese-Endpunkte, DELETE nur für Scroll, Point-in-Time und asynchrone Suchen. Der Endpunkt ist das erste
 * Segment bzw. das zweite hinter einem Index-Ziel (ohne _-Präfix oder _all, auch „_all,kunden“); dahinter darf nichts mehr kommen, sonst
 * ginge z. B. _search/_bulk als „_search“ durch (Elasticsearch liest es als Index „_search“ mit _bulk).
 * Alles andere (Dokumente, Indizes, Einstellungen …) wird abgelehnt.
 */
export function esReadOnlyViolation(method: string, path: string, body?: string): string | null {
  const m = method.toUpperCase();
  const clean = path.split('?')[0].replace(/^\/+/, '');
  // ein Proxy davor (z. B. nginx, Tomcat) löst ../, // und ;-Pfadparameter auf – dann wäre der geprüfte Endpunkt nicht der, der ankommt
  const unsafe = (p: string) => /(^|\/)\.\.?(\/|$)/.test(p) || /%2f|%5c|%2e/i.test(p) || p.includes('\\') || p.includes('//') || p.includes(';');
  const invalid = () => `Ungültiger Pfad „${path}“ – bitte ohne ./, ../, //, ; oder kodierte Schrägstriche.`;
  if (unsafe(clean)) return invalid();
  // F292: %-kodierte Zeichen löst jemand auf (ein Proxy oder Elasticsearch): „_%72efresh“ und „%5Frefresh“ sind „_refresh“. Für die
  // Sperrliste von GET/HEAD zählt deshalb auch der aufgelöste Pfad. Die Positivlisten für POST und DELETE lesen den Pfad dagegen so, wie er
  // dasteht – was nur kodiert wie ein Lese-Endpunkt aussieht („kunden/%5Fsearch“), wird abgelehnt statt freigegeben.
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return `Ungültiger Pfad „${path}“ – fehlerhafte %-Kodierung.`;
  }
  if (unsafe(decoded)) return invalid(); // „%252e“ wird erst jetzt zu „%2e“
  // Index-Ziel am Anfang: alles ohne _-Präfix (auch Listen und Platzhalter) sowie _all, auch als Listenanfang („_all,kunden“, F292)
  const target = (s: string[]) => (s.length && (!s[0].startsWith('_') || /^_all(,|$)/.test(s[0])) ? 1 : 0);
  const segs = clean.split('/').filter(Boolean);
  const from = target(segs);
  const ep = segs[from] ?? '';
  const rest = segs.slice(from).join('/');
  const trailing = segs.slice(from + 1);
  const refuse = () =>
    `Nur lesen: „${m} ${path}“ würde Elasticsearch ändern – OwlynDB schickt nur lesende Anfragen (GET, _search, _count, _sql …). Es wurde nichts ausgeführt.`;
  if (m === 'GET' || m === 'HEAD') {
    // ein aufgelöstes ? oder # beendet den Pfad
    const dsegs = decoded.split(/[?#]/)[0].split('/').filter(Boolean);
    const dep = dsegs[target(dsegs)] ?? '';
    return WRITE_GET.has(ep) || WRITE_GET.has(dep) ? refuse() : null;
  }
  if (!ep.startsWith('_')) return refuse();
  if (m === 'POST') {
    if (READ_POST.has(rest)) return null;
    if (READ_POST_WITH_ID.has(ep) && trailing.length === 1 && !trailing[0].startsWith('_')) return null;
    return refuse();
  }
  if (m === 'DELETE') {
    // alle Scroll-Kontexte des Clusters schließen (scroll_id "_all") träfe fremde Sitzungen
    if (rest === '_search/scroll' && body && /"scroll_id"\s*:\s*(\[\s*)?"_all"/.test(body)) return refuse();
    if (READ_DELETE.has(rest)) return null;
    if (READ_DELETE_WITH_ID.has(ep) && trailing.length === 1 && !trailing[0].startsWith('_')) return null;
  }
  return refuse();
}
