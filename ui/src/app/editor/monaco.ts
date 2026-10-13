import { Injectable } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import type { CompletionInfo, Dialect } from '../../../../shared/api-types';
import { isConsoleRequest, splitEs } from '../../../../shared/es-console';
import { needsSchema, quoteIdent } from '../../../../shared/sql-util';

export type MonacoApi = typeof Monaco;

interface AmdRequire {
  (deps: string[], ok: () => void, err: (e: unknown) => void): void;
  config(c: unknown): void;
}

export interface CompletionSource {
  dialect: Dialect;
  info(): CompletionInfo | undefined;
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'AS', 'DISTINCT',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING', 'GROUP BY', 'ORDER BY', 'HAVING',
  'ASC', 'DESC', 'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'INDEX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST',
  'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRUNCATE TABLE', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT',
];
const DIALECT_KEYWORDS: Record<Dialect, string[]> = {
  mysql: ['LIMIT', 'OFFSET', 'SHOW TABLES', 'SHOW CREATE TABLE', 'DESCRIBE', 'USE', 'IFNULL', 'NOW()', 'CONCAT', 'GROUP_CONCAT', 'DATE_FORMAT', 'EXPLAIN'],
  postgres: ['LIMIT', 'OFFSET', 'ILIKE', 'RETURNING', 'NOW()', 'STRING_AGG', 'TO_CHAR', 'EXPLAIN ANALYZE', 'ON CONFLICT', 'NULLS LAST'],
  mssql: ['TOP', 'USE', 'GO', 'ISNULL', 'GETDATE()', 'SYSDATETIME()', 'STRING_AGG', 'FORMAT', 'NOLOCK', 'OFFSET', 'FETCH NEXT', 'ROWS ONLY', 'EXEC', 'PRINT', 'BEGIN TRANSACTION'],
  elasticsearch: ['LIMIT', 'MATCH()', 'QUERY()', 'SCORE()', 'SHOW TABLES', 'SHOW COLUMNS IN', 'SHOW FUNCTIONS', 'DESCRIBE', 'HISTOGRAM()', 'DATE_TRUNC()', 'NOW()', 'CURRENT_DATE', 'PIVOT', 'RLIKE'],
};

/** Elasticsearch: Endpunkte nach „GET index/“ bzw. „GET “ */
const ES_ENDPOINTS = ['_search', '_count', '_mapping', '_settings', '_field_caps?fields=*', '_stats', '_explain/', '_doc/'];
const ES_ROOT = ['_cat/indices?v&s=index', '_cat/aliases?v', '_cat/count?v', '_cat/health?v', '_cat/shards?v', '_cluster/health', '_nodes/stats', '_sql?format=txt', '_search', '_aliases', '_data_stream'];
/** Query DSL und Such-Body */
const ES_DSL = [
  'query', 'bool', 'must', 'filter', 'should', 'must_not', 'minimum_should_match', 'match', 'match_all', 'match_phrase', 'multi_match', 'term', 'terms',
  'range', 'gte', 'gt', 'lte', 'lt', 'exists', 'field', 'wildcard', 'prefix', 'regexp', 'fuzzy', 'ids', 'values', 'query_string', 'simple_query_string',
  'nested', 'path', 'size', 'from', 'sort', 'order', 'asc', 'desc', '_source', 'fields', 'track_total_hits', 'aggs', 'terms', 'date_histogram',
  'calendar_interval', 'fixed_interval', 'histogram', 'interval', 'avg', 'sum', 'min', 'max', 'cardinality', 'value_count', 'stats', 'top_hits',
  'highlight', 'search_after', 'collapse', 'profile', 'format', 'time_zone', 'missing', 'boost',
];

/** Hervorhebung für Elasticsearch-Tabs: Konsolenzeile, JSON-Body, SQL und Kommentare wie in Kibana */
const ES_LANGUAGE = {
  ignoreCase: true,
  defaultToken: '',
  keywords: [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'RLIKE', 'BETWEEN', 'AS', 'DISTINCT', 'GROUP', 'BY', 'ORDER', 'HAVING',
    'ASC', 'DESC', 'LIMIT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'SHOW', 'TABLES', 'COLUMNS', 'FUNCTIONS', 'DESCRIBE', 'CAST', 'PIVOT', 'FOR',
    'MATCH', 'QUERY', 'SCORE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TRUE', 'FALSE',
  ],
  tokenizer: {
    root: [
      // Monarch verlangt Gruppen über den ganzen Treffer – auch für Leerzeichen am Zeilenanfang und -ende
      [/^(\s*)(GET|POST|PUT|DELETE|HEAD|PATCH)(\s+)(\S+)(\s*)$/, ['', 'keyword', '', 'type', '']],
      [/^\s*(#|\/\/).*$/, 'comment'],
      [/--.*$/, 'comment'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/"""/, 'string', '@triple'],
      [/"([^"\\]|\\.)*"(?=\s*:)/, 'attribute.name'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^']|'')*'/, 'string'],
      [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
      [/[A-Za-z_][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[{}[\]()]/, '@brackets'],
    ],
    comment: [
      [/[^*/]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[*/]/, 'comment'],
    ],
    triple: [
      [/"""/, 'string', '@pop'],
      [/[^"]+/, 'string'],
      [/"/, 'string'],
    ],
  },
};

/** Wörter, die als Name gequotet werden müssen (aus den angebotenen Schlüsselwörtern, mehrteilige zerlegt) */
const SQL_WORDS = new Set([...KEYWORDS, ...Object.values(DIALECT_KEYWORDS).flat()].flatMap((k) => k.replace(/\(\)$/, '').split(' ')));

/**
 * Name aus dem Katalog zum Einsetzen: gequotet, sobald er sonst nicht als ein Bezeichner gelesen würde (Leerzeichen,
 * Sonderzeichen, Schlüsselwort; PostgreSQL auch Großbuchstaben). Ein Name wie „x; DELETE FROM konten; --“ würde sonst
 * zu ausführbarem SQL, „Order Details“ zu einem Syntaxfehler.
 */
function identText(dialect: Dialect, name: string): string {
  if (dialect === 'postgres') return quoteIdent(dialect, name);
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !SQL_WORDS.has(name.toUpperCase()) ? name : quoteIdent(dialect, name);
}

/** Namen mit Zeilenumbruch nicht anbieten (eingesetzt zerrissen sie die Anweisung) */
const offered = (name: string) => !/[\r\n]/.test(name);

/** Name in SQL von Elasticsearch: mit - oder anderen Zeichen in Anführungszeichen (Punkte in Feldnamen sind erlaubt) */
function esIdent(name: string, dots: boolean): string {
  return (dots ? /^[A-Za-z_@][\w.@]*$/ : /^[A-Za-z_][\w]*$/).test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}

/** Monaco als AMD-Paket aus ui/vs laden (einmal pro Fenster) */
@Injectable({ providedIn: 'root' })
export class MonacoLoader {
  private promise?: Promise<MonacoApi>;
  private sources = new Map<string, CompletionSource>();

  load(): Promise<MonacoApi> {
    this.promise ??= new Promise<MonacoApi>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vs/loader.js';
      s.onload = () => {
        const req = (window as unknown as { require: AmdRequire }).require;
        req.config({ paths: { vs: 'vs' } });
        req(
          ['vs/editor/editor.main'],
          () => {
            const m = (window as unknown as { monaco: MonacoApi }).monaco;
            this.setup(m);
            resolve(m);
          },
          reject,
        );
      };
      s.onerror = () => reject(new Error('Monaco konnte nicht geladen werden'));
      document.body.appendChild(s);
    });
    return this.promise;
  }

  /** Autovervollständigung pro Editor-Modell anmelden */
  register(model: Monaco.editor.ITextModel, source: CompletionSource): void {
    this.sources.set(model.uri.toString(), source);
    model.onWillDispose(() => this.sources.delete(model.uri.toString()));
  }

  private setup(m: MonacoApi) {
    // Formatieren (Umschalt+Alt+F, Kontextmenü): ganzer Text bzw. Markierung, je nach Datenbanktyp des Editors
    // Formatierer erst beim ersten Gebrauch laden (gut 300 KB)
    const formatEdits = async (model: Monaco.editor.ITextModel, range?: Monaco.IRange): Promise<Monaco.languages.TextEdit[]> => {
      const src = this.sources.get(model.uri.toString());
      if (!src) return [];
      const r = range ?? model.getFullModelRange();
      const text = model.getValueInRange(r);
      const { formatSql } = await import('./format');
      const out = formatSql(text, src.dialect).text;
      return out === text ? [] : [{ range: r, text: out }];
    };
    m.languages.register({ id: 'es-console' });
    m.languages.setMonarchTokensProvider('es-console', ES_LANGUAGE as Monaco.languages.IMonarchLanguage);
    m.languages.setLanguageConfiguration('es-console', {
      comments: { lineComment: '#', blockComment: ['/*', '*/'] },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string'] },
      ],
    });
    for (const lang of ['sql', 'es-console']) {
      m.languages.registerDocumentFormattingEditProvider(lang, { provideDocumentFormattingEdits: (model) => formatEdits(model) });
      m.languages.registerDocumentRangeFormattingEditProvider(lang, { provideDocumentRangeFormattingEdits: (model, range) => formatEdits(model, range) });
      m.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: lang === 'sql' ? ['.', ' '] : ['.', ' ', '/', '"'],
        provideCompletionItems: (model, position) => {
          const src = this.sources.get(model.uri.toString());
          if (!src) return { suggestions: [] };
          return { suggestions: this.suggest(m, model, position, src) };
        },
      });
    }
  }

  /** Elasticsearch-Konsole: Pfad (Indizes, Endpunkte) bzw. Body (Query DSL, Felder des Index); null = SQL */
  private suggestEs(m: MonacoApi, model: Monaco.editor.ITextModel, pos: Monaco.Position, src: CompletionSource): Monaco.languages.CompletionItem[] | null {
    const text = model.getValue();
    const offset = model.getOffsetAt(pos);
    const K = m.languages.CompletionItemKind;
    const word = model.getWordUntilPosition(pos);
    const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const tables = src.info()?.tables ?? [];
    const lineBefore = model.getLineContent(pos.lineNumber).slice(0, word.startColumn - 1);
    // „GET “ ohne Pfad ist für den Zerleger noch keine Anfrage – die Zeile selbst entscheidet
    const typingHead = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+\S*$/i.test(model.getLineContent(pos.lineNumber).slice(0, pos.column - 1));
    const st = splitEs(text).find((s) => offset >= s.start && offset <= s.end + 1);
    if (!typingHead && (!st || !isConsoleRequest(st.sql))) return null;
    const headLine = typingHead || !st ? pos.lineNumber : model.getPositionAt(st.start).lineNumber;
    if (pos.lineNumber === headLine) {
      // „GET “: Indizes und Endpunkte ohne Index; „GET kunden/“: Endpunkte
      const path = /^\s*\S+\s+(\S*)$/.exec(lineBefore)?.[1];
      if (path === undefined) return [];
      if (path.includes('/')) return ES_ENDPOINTS.map((e) => ({ label: e, kind: K.Method, insertText: e, range }));
      return [
        // im Pfad kodiert wie im Treiber (ein % im Namen gälte sonst als Escape)
        ...tables.map((t) => ({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Class, insertText: encodeURIComponent(t.name), range, sortText: '1' + t.name, detail: t.kind === 'view' ? 'Alias' : 'Index' })),
        ...ES_ROOT.map((e) => ({ label: e, kind: K.Method, insertText: e, range, sortText: '2' + e })),
      ];
    }
    // im Body: Felder des Index aus der Kopfzeile, dann Query DSL; nach einem " ohne Anführungszeichen einsetzen
    const quoted = lineBefore.endsWith('"');
    // als JSON-Zeichenkette: " und \ in Feldnamen escapen
    const q = (s: string) => (quoted ? JSON.stringify(s).slice(1, -1) : JSON.stringify(s));
    const index = /^\s*\S+\s+\/?([^/_\s?][^/\s?]*)/.exec(st?.sql ?? '')?.[1];
    const fields = tables.find((t) => t.name === index)?.columns ?? [];
    return [
      ...fields.map((f) => ({ label: f, kind: K.Field, insertText: q(f), range, sortText: '1' + f, detail: index })),
      ...ES_DSL.map((k) => ({ label: k, kind: K.Keyword, insertText: q(k), range, sortText: '2' + k })),
    ];
  }

  private suggest(m: MonacoApi, model: Monaco.editor.ITextModel, pos: Monaco.Position, src: CompletionSource): Monaco.languages.CompletionItem[] {
    const es = src.dialect === 'elasticsearch';
    if (es) {
      const console = this.suggestEs(m, model, pos, src);
      if (console) return console;
    }
    // SQL von Elasticsearch: Index- und Feldnamen mit - usw. in Anführungszeichen; sonst je Dialekt gequotet, wo nötig
    const tableText = (n: string) => (es ? esIdent(n, false) : identText(src.dialect, n));
    const columnText = (n: string) => (es ? esIdent(n, true) : identText(src.dialect, n));
    const info = src.info();
    const word = model.getWordUntilPosition(pos);
    const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const lineBefore = model.getLineContent(pos.lineNumber).slice(0, word.startColumn - 1);
    const K = m.languages.CompletionItemKind;
    const tables = (info?.tables ?? []).filter((t) => offered(t.name));
    const text = model.getValue();

    // "alias." oder "tabelle." oder "schema."
    const dot = /([\w$#@\]`"]+)\.\s*$/.exec(lineBefore);
    if (dot) {
      const qualifier = unquote(dot[1]).toLowerCase();
      const aliases = findAliases(text);
      const hit = pickTable(tables, aliases.get(qualifier) ?? { schema: '', table: qualifier });
      if (hit) {
        return hit.columns
          .filter(offered)
          .map((c, i) => ({ label: c, kind: K.Field, insertText: columnText(c), range, sortText: String(i).padStart(4, '0'), detail: (hit.schema ? hit.schema + '.' : '') + hit.name }));
      }
      const inSchema = tables.filter((t) => t.schema.toLowerCase() === qualifier);
      return inSchema.map((t) => ({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Class, insertText: tableText(t.name), range, detail: t.kind === 'view' ? 'View' : 'Tabelle' }));
    }

    const out: Monaco.languages.CompletionItem[] = [];
    // Spalten der Tabellen, die in der Abfrage vorkommen, zuerst – je Verweis die Tabelle im genannten Schema
    const used = new Set([...findAliases(text).values()].map((r) => pickTable(tables, r)));
    for (const t of tables) {
      if (!used.has(t)) continue;
      for (const c of t.columns.filter(offered)) out.push({ label: c, kind: K.Field, insertText: columnText(c), range, sortText: '1' + c, detail: t.name });
    }
    const schemas = new Set<string>();
    for (const t of tables) {
      out.push({
        label: t.name,
        kind: t.kind === 'view' ? K.Interface : K.Class,
        // mit Schema, wo der Server die Tabelle ohne nicht fände (z. B. spx.MITARBEITER bei Standardschema dbo)
        insertText: !es && needsSchema(src.dialect, t, info?.tables ?? [], info?.searchPath) ? `${identText(src.dialect, t.schema)}.${tableText(t.name)}` : tableText(t.name),
        range,
        sortText: '2' + t.name,
        detail: (t.schema ? t.schema + '.' : '') + (t.kind === 'view' ? 'View' : 'Tabelle'),
      });
      if (t.schema && offered(t.schema)) schemas.add(t.schema);
    }
    for (const s of schemas) out.push({ label: s, kind: K.Module, insertText: es ? s : identText(src.dialect, s), range, sortText: '3' + s, detail: 'Schema' });
    for (const k of [...KEYWORDS, ...DIALECT_KEYWORDS[src.dialect]]) {
      out.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '4' + k });
    }
    return out;
  }
}

function unquote(s: string): string {
  return s.replace(/^[[`"]|[\]`"]$/g, '');
}

/** Tabelle aus FROM/JOIN/…: Name und, falls angegeben, Schema (klein geschrieben) */
interface TableRef {
  schema: string;
  table: string;
}

/** Tabelle zu einem Verweis: im genannten Schema, sonst die erste gleichnamige (gleichnamige Tabellen in dbo und audit) */
function pickTable<T extends { schema: string; name: string }>(tables: T[], ref: TableRef): T | undefined {
  const same = tables.filter((t) => t.name.toLowerCase() === ref.table);
  return (ref.schema ? same.find((t) => t.schema.toLowerCase() === ref.schema) : undefined) ?? same[0];
}

/** alias -> Tabelle (klein geschrieben, mit Schema) aus FROM/JOIN/UPDATE/INTO */
function findAliases(text: string): Map<string, TableRef> {
  const map = new Map<string, TableRef>();
  const re = /\b(?:from|join|update|into)\s+((?:[\w$#@]+|\[[^\]]+\]|`[^`]+`|"[^"]+")(?:\s*\.\s*(?:[\w$#@]+|\[[^\]]+\]|`[^`]+`|"[^"]+")){0,2})(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  const stop = new Set(['where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'group', 'order', 'limit', 'set', 'values', 'using', 'having', 'union', 'with']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = m[1].split('.').map((p) => unquote(p.trim()).toLowerCase());
    const ref = { table: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : '' };
    map.set(ref.table, ref);
    const alias = m[2]?.toLowerCase();
    if (alias && !stop.has(alias)) map.set(alias, ref);
  }
  return map;
}
