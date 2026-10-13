import type { CheckInfo, ColumnInfo, CompareItem, CompareResult, Dialect, ForeignKeyInfo, IndexInfo, RoutineInfo, TableInfo } from '../shared/api-types';
import { commentText, quoteIdent } from '../shared/sql-util';
import type { MetaDriver } from './drivers/common';
import { columnSql, createTableSql, orderByRefs, orderByUse, sameDialectDefault } from './dump';
import { createOrAlter, dumpScript, editorScript } from './routines';

export interface CompareSideDriver {
  driver: MetaDriver;
  database: string;
  /** leer bei MySQL */
  schema: string;
}

const KEYWORD: Record<RoutineInfo['kind'], string> = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' };

/** für den Vergleich: Leerraum zusammengefasst, ohne ; am Ende; SQL Server merkt sich CREATE OR ALTER/ALTER so, wie es kam */
function norm(s: string): string {
  return s
    // führende Kommentare gehören bei SQL Server zur gespeicherten Definition, sagen aber nichts über den Inhalt
    .replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .trim()
    .replace(/^CREATE OR ALTER\b/i, 'CREATE')
    .replace(/^ALTER\b/i, 'CREATE');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ein Bezeichner, roh oder in den Anführungszeichen des Datenbanktyps */
function identRe(dialect: Dialect, name: string): string {
  if (dialect === 'mssql') return `(?:\\[${escape(name.replace(/]/g, ']]'))}\\]|"${escape(name.replace(/"/g, '""'))}"|${escape(name)})`;
  return `(?:"${escape(name.replace(/"/g, '""'))}"|${escape(name)})`;
}

/** Schema-Qualifizierung „schema.“ aus einem Text nehmen (zum Vergleich beider Seiten) */
export function withoutSchema(dialect: Dialect, text: string, schema: string): string {
  if (!schema) return text;
  return text.replace(new RegExp(`(^|[^\\w"\\]])${identRe(dialect, schema)}\\s*\\.\\s*`, 'g'), '$1');
}

/** SQL Server: alle Verweise „schema.“ im Text auf das Ziel-Schema (die Definition ist wörtlich gespeichert, auch der Rumpf) */
export function rewriteRefs(dialect: Dialect, text: string, fromSchema: string, toSchema: string): string {
  if (!fromSchema || !toSchema || fromSchema === toSchema) return text;
  return text.replace(new RegExp(`(^|[^\\w"\\]])${identRe(dialect, fromSchema)}\\s*\\.\\s*`, 'g'), `$1${quoteIdent(dialect, toSchema)}.`);
}

const IDENT_MSSQL = '(?:\\[[^\\]]*\\]|"[^"]*"|[^\\s.(\\[\\]"]+)';
const IDENT_PG = '(?:"(?:[^"]|"")+"|[^\\s".(]+)';

/**
 * Kopf einer Definition auf das Ziel-Schema umschreiben: „CREATE … FUNCTION quellschema.f(“ bzw. „CREATE OR ALTER PROCEDURE
 * [dbo].[p]“ – ohne das hieße das Skript die Quelle ändern (gleiche Datenbank) oder wirkte im falschen Schema.
 */
export function rewriteHead(dialect: Dialect, ddl: string, fromSchema: string, toSchema: string): string {
  if (dialect === 'mysql' || !toSchema) return ddl;
  const q = (s: string) => quoteIdent(dialect, s);
  const unquote = (s: string) => (s.startsWith('[') ? s.slice(1, -1).replace(/]]/g, ']') : s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);
  const ident = dialect === 'mssql' ? IDENT_MSSQL : IDENT_PG;
  const head =
    dialect === 'mssql'
      ? `^((?:\\s*(?:--[^\\n]*(?:\\n|$)|\\/\\*[\\s\\S]*?\\*\\/))*\\s*CREATE\\s+OR\\s+ALTER\\s+(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\\s+)(?:(${ident})\\s*\\.\\s*)?(${ident})`
      : `^(CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+)(?:(${ident})\\s*\\.\\s*)?(${ident})(?=\\s*\\()`;
  return ddl.replace(new RegExp(head, 'i'), (all, pre: string, schema: string | undefined, name: string) => {
    // ein anderes Schema als das verglichene bleibt, wie es ist
    if (schema !== undefined && unquote(schema) !== fromSchema) return all;
    return `${pre}${q(toSchema)}.${name}`;
  });
}

/** PostgreSQL-Trigger: Tabelle („ON schema.t“) und Funktion („EXECUTE FUNCTION schema.f“) auf das Ziel-Schema */
export function rewriteTrigger(ddl: string, fromSchema: string, toSchema: string): string {
  const q = quoteIdent('postgres', toSchema);
  return ddl
    .replace(new RegExp(`(\\sON\\s+)${identRe('postgres', fromSchema)}\\.`, 'i'), `$1${q}.`)
    .replace(new RegExp(`(\\sEXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+)${identRe('postgres', fromSchema)}\\.`, 'i'), `$1${q}.`);
}

/** höchstens n gleichzeitig (Katalogabfragen über Tunnel nicht alle auf einmal); nach dem ersten Fehler fängt keiner mehr an */
async function mapLimit<T, R>(list: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length && !failed) {
        const k = next++;
        try {
          out[k] = await fn(list[k]);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );
  return out;
}

/**
 * Struktur zweier Datenbanken bzw. Schemas desselben Typs vergleichen. Ergebnis: nur die Unterschiede, je mit
 * Anweisungen, die das Ziel an die Quelle angleichen. Ausgeführt wird hier nichts.
 */
export async function compareSchemas(dialect: Dialect, src: CompareSideDriver, dst: CompareSideDriver): Promise<CompareResult> {
  const q = (s: string) => quoteIdent(dialect, s);
  const end = (stmt: string) => (dialect === 'mssql' ? `${stmt}\nGO` : `${stmt};`);
  const full = (name: string) => (dialect === 'mysql' ? q(name) : `${q(dst.schema)}.${q(name)}`);
  // MySQL und SQL Server unterscheiden Groß-/Kleinschreibung in Namen meist nicht
  const key = (s: string) => (dialect === 'postgres' ? s : s.toLowerCase());
  const warnings: string[] = [];
  const items: CompareItem[] = [];
  let same = 0;

  const [srcObjs, dstObjs] = await Promise.all([src.driver.listObjects(src.database, src.schema), dst.driver.listObjects(dst.database, dst.schema)]);

  // --- Tabellen -----------------------------------------------------------------------------------
  const tablesOf = (list: typeof srcObjs) => new Map(list.filter((o) => o.kind === 'table').map((o) => [key(o.name), o.name]));
  const st = tablesOf(srcObjs);
  const dt = tablesOf(dstObjs);
  const tableKeys = [...new Set([...st.keys(), ...dt.keys()])].sort();
  const onlyTarget: { schema: string; name: string; info: TableInfo; item: CompareItem }[] = [];
  const tableItems = await mapLimit(tableKeys, 4, async (k): Promise<CompareItem | null> => {
    const s = st.get(k);
    const d = dt.get(k);
    if (s && !d) {
      const info = await src.driver.describeTable(src.database, src.schema, s);
      const details = [`nur in der Quelle (${info.columns.length} Spalten)`];
      if (info.special) {
        details.push(`${info.special} – im Skript als normale Tabelle`);
        warnings.push(`${s} ist ${info.special} – das Skript legt eine normale Tabelle an.`);
      }
      return {
        kind: 'table',
        name: s,
        status: 'onlySource',
        details,
        script: {
          tables: [end(createTableSql(dialect, info, s, full(s), warnings))],
          post: [
            ...info.indexes.filter((i) => !i.primary).map((i) => createIndex(s, i, info)).filter((x): x is string => x !== null).map(end),
            ...info.foreignKeys.map((f) => end(addForeignKey(s, f))),
          ],
        },
      };
    }
    if (!s && d) {
      // Fremdschlüssel des Ziels bestimmen die Reihenfolge der Löschungen (verweisende Tabellen zuerst)
      const info = await dst.driver.describeTable(dst.database, dst.schema, d);
      const item: CompareItem = { kind: 'table', name: d, status: 'onlyTarget', details: ['nur im Ziel'], script: { drop: [end(`DROP TABLE ${full(d)}`)] } };
      onlyTarget.push({ schema: dst.schema, name: d, info, item });
      return item;
    }
    const [a, b] = await Promise.all([src.driver.describeTable(src.database, src.schema, s!), dst.driver.describeTable(dst.database, dst.schema, d!)]);
    return diffTable(d!, a, b);
  });
  // Tabellen nur im Ziel: verweisende vor denen, auf die sie zeigen – so lässt sich die Löschphase ohne CASCADE ausführen
  const dropOrder = orderByRefs(onlyTarget, dialect).reverse();
  for (const it of tableItems) {
    if (!it) same++;
    else if (it.status !== 'onlyTarget') items.push(it);
  }
  items.push(...dropOrder.map((x) => x.item));

  /** CREATE INDEX bzw. ADD CONSTRAINT … UNIQUE im Wortlaut der Quelle; null = nicht abbildbar (mit Hinweis) */
  function createIndex(table: string, ix: IndexInfo, info: TableInfo): string | null {
    const cols = new Set(info.columns.map((c) => c.name));
    const list = ix.columns.map((c) => (cols.has(c) ? q(c) : c)).join(', ');
    if (ix.constraint) {
      if (!ix.unique) {
        warnings.push(`${table}: Einschränkung ${ix.name} (z. B. EXCLUDE) lässt sich nicht automatisch anlegen.`);
        return null;
      }
      return `ALTER TABLE ${full(table)} ADD CONSTRAINT ${q(ix.name)} UNIQUE (${list})`;
    }
    const def = ix.definition ?? `(${list})`;
    if (dialect === 'mysql' && (ix.kind === 'FULLTEXT' || ix.kind === 'SPATIAL')) return `CREATE ${ix.kind} INDEX ${q(ix.name)} ON ${full(table)} ${def}`;
    if (dialect === 'mssql' && ix.kind && ix.kind !== 'CLUSTERED') {
      warnings.push(`${table}: Index ${ix.name} (${ix.kind}) lässt sich nicht automatisch anlegen.`);
      return null;
    }
    return `CREATE ${ix.unique ? 'UNIQUE ' : ''}${dialect === 'mssql' && ix.kind === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${q(ix.name)} ON ${full(table)} ${def}`;
  }

  function dropIndex(table: string, ix: IndexInfo): string {
    // Index einer UNIQUE-Einschränkung: DROP INDEX lehnt der Server ab
    if (ix.constraint) return `ALTER TABLE ${full(table)} DROP CONSTRAINT ${q(ix.name)}`;
    return dialect === 'postgres' ? `DROP INDEX ${q(dst.schema)}.${q(ix.name)}` : `DROP INDEX ${q(ix.name)} ON ${full(table)}`;
  }

  /** Verweis aufs eigene Schema/die eigene Datenbank zeigt im Ziel aufs Ziel-Schema */
  function refTable(f: ForeignKeyInfo): string {
    if (dialect === 'mysql') return f.refSchema && key(f.refSchema) !== key(src.database) ? `${q(f.refSchema)}.${q(f.refTable)}` : q(f.refTable);
    const schema = key(f.refSchema) === key(src.schema) ? dst.schema : f.refSchema;
    return `${q(schema)}.${q(f.refTable)}`;
  }

  function addForeignKey(table: string, f: ForeignKeyInfo): string {
    const rules = `${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}${f.onUpdate ? ` ON UPDATE ${f.onUpdate}` : ''}`;
    return `ALTER TABLE ${full(table)} ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${refTable(f)} (${f.refColumns.map(q).join(', ')})${rules}`;
  }

  function dropForeignKey(table: string, f: ForeignKeyInfo): string {
    return dialect === 'mysql' ? `ALTER TABLE ${full(table)} DROP FOREIGN KEY ${q(f.name)}` : `ALTER TABLE ${full(table)} DROP CONSTRAINT ${q(f.name)}`;
  }

  function addCheck(table: string, k: CheckInfo): string {
    return `ALTER TABLE ${full(table)} ADD ${k.column ? '' : `CONSTRAINT ${q(k.name)} `}CHECK ${k.expression}`;
  }

  function dropCheck(table: string, k: CheckInfo): string {
    return `ALTER TABLE ${full(table)} DROP ${dialect === 'mysql' ? 'CHECK' : 'CONSTRAINT'} ${q(k.name)}`;
  }

  function sameType(a: string, b: string): boolean {
    return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
  }

  /** SQL Server: die DEFAULT-Einschränkung einer Spalte entfernen (sie hat meist einen generierten Namen) */
  function dropDefaultMssql(table: string, column: string): string {
    const t = full(table);
    const obj = `N'${t.replace(/'/g, "''")}'`;
    // in BEGIN … END, damit der Abfrage-Editor den Block nicht an den ; zerteilt (die Variable ginge verloren)
    return end(
      `BEGIN\n  DECLARE @df sysname = (SELECT name FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID(${obj})` +
        ` AND parent_column_id = COLUMNPROPERTY(OBJECT_ID(${obj}), N'${column.replace(/'/g, "''")}', 'ColumnId'));\n` +
        // EXEC() erlaubt keinen Funktionsaufruf in der Verkettung: Befehl vorher in eine Variable
        `  DECLARE @drop nvarchar(max) = N'ALTER TABLE ${t.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(@df);\n` +
        `  IF @df IS NOT NULL EXEC(@drop);\nEND`,
    );
  }

  /** Anweisungen, die eine Spalte im Ziel (b) wie in der Quelle (a) machen */
  function alterColumn(table: string, a: ColumnInfo, b: ColumnInfo, changes: { type: boolean; nullable: boolean; def: boolean }): string[] {
    const t = full(table);
    const col = q(a.name);
    // MySQL: AUTO_INCREMENT bleibt, wie es im Ziel ist (nur Hinweis, siehe README)
    if (dialect === 'mysql') return [end(`ALTER TABLE ${t} MODIFY COLUMN ${columnSql('mysql', 'mysql', { ...a, autoIncrement: b.autoIncrement }, a.dataType, warnings, table)}`)];
    const out: string[] = [];
    if (dialect === 'postgres') {
      if (changes.type) out.push(end(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${a.dataType}`));
      if (changes.nullable) out.push(end(`ALTER TABLE ${t} ALTER COLUMN ${col} ${a.nullable ? 'DROP' : 'SET'} NOT NULL`));
      if (changes.def) {
        const def = sameDialectDefault('postgres', a);
        out.push(end(def ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${def}` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`));
      }
      return out;
    }
    // SQL Server: Standardwerte sind eigene Einschränkungen – sie blockieren das Ändern des Typs, also vorher weg und danach neu
    const hadDefault = b.defaultValue != null;
    const redo = changes.def || (changes.type && hadDefault);
    if (hadDefault && redo) out.push(dropDefaultMssql(table, a.name));
    if (changes.type || changes.nullable) out.push(end(`ALTER TABLE ${t} ALTER COLUMN ${col} ${a.dataType} ${a.nullable ? 'NULL' : 'NOT NULL'}`));
    if (redo) {
      const def = sameDialectDefault('mssql', a);
      if (def) out.push(end(`ALTER TABLE ${t} ADD DEFAULT ${def} FOR ${col}`));
    }
    return out;
  }

  function diffTable(name: string, a: TableInfo, b: TableInfo): CompareItem | null {
    const details: string[] = [];
    const script: CompareItem['script'] = { pre: [], tables: [], post: [], drop: [] };
    /** Löschungen in der Reihenfolge, in der der Server sie zulässt: Fremdschlüssel, Indizes, Einschränkungen, dann Spalten */
    const drops = { fk: [] as string[], ix: [] as string[], ck: [] as string[], col: [] as string[] };
    const t = full(name);
    const bCols = new Map(b.columns.map((c) => [key(c.name), c]));
    const aCols = new Map(a.columns.map((c) => [key(c.name), c]));
    for (const ca of a.columns) {
      const cb = bCols.get(key(ca.name));
      if (!cb) {
        details.push(`Spalte ${ca.name} fehlt im Ziel` + (!ca.nullable && !ca.defaultValue && !ca.autoIncrement ? ' (NOT NULL ohne Standardwert: bei vorhandenen Zeilen schlägt das Hinzufügen fehl)' : ''));
        script.tables!.push(end(`ALTER TABLE ${t} ADD ${dialect === 'mssql' ? '' : 'COLUMN '}${columnSql(dialect, dialect, ca, ca.dataType, warnings, name)}`));
        continue;
      }
      const changes = {
        type: !sameType(ca.dataType, cb.dataType),
        nullable: ca.nullable !== cb.nullable,
        def: norm(ca.defaultValue ?? '') !== norm(cb.defaultValue ?? '') || (ca.onUpdate ?? '') !== (cb.onUpdate ?? ''),
      };
      const parts: string[] = [];
      if (changes.type) parts.push(`${cb.dataType} → ${ca.dataType}`);
      if (changes.nullable) parts.push(ca.nullable ? 'NOT NULL → NULL' : 'NULL → NOT NULL');
      if (changes.def) parts.push(`Standard ${cb.defaultValue ?? '–'}${cb.onUpdate ? ` ON UPDATE ${cb.onUpdate}` : ''} → ${ca.defaultValue ?? '–'}${ca.onUpdate ? ` ON UPDATE ${ca.onUpdate}` : ''}`);
      if (ca.autoIncrement !== cb.autoIncrement) details.push(`Spalte ${ca.name}: Zähler/Identität unterschiedlich – nicht automatisch angepasst`);
      if ((ca.generated ?? '') !== (cb.generated ?? '')) {
        if (dialect === 'mysql') {
          parts.push(`berechnet: ${cb.generated ?? '–'} → ${ca.generated ?? '–'}`);
          changes.type = true;
        } else {
          details.push(`Spalte ${ca.name}: berechneter Ausdruck unterschiedlich (${cb.generated ?? '–'} → ${ca.generated ?? '–'}) – bitte von Hand anpassen`);
          script.tables!.push(`-- ${commentText(`${name}.${ca.name}: berechneter Ausdruck unterschiedlich, bitte von Hand anpassen`)}`);
        }
      }
      if (!parts.length) continue;
      details.push(`Spalte ${ca.name}: ${parts.join(', ')}`);
      script.tables!.push(...alterColumn(name, ca, cb, changes));
    }
    for (const cb of b.columns) {
      if (aCols.has(key(cb.name))) continue;
      details.push(`Spalte ${cb.name} nur im Ziel`);
      // SQL Server: eine DEFAULT-Einschränkung an der Spalte verhindert das Löschen
      if (dialect === 'mssql' && cb.defaultValue != null) drops.col.push(dropDefaultMssql(name, cb.name));
      drops.col.push(end(`ALTER TABLE ${t} DROP COLUMN ${q(cb.name)}`));
    }
    // Primärschlüssel
    const pk = (i: TableInfo) => (i.indexes.find((x) => x.primary)?.columns ?? i.columns.filter((c) => c.primaryKey).map((c) => c.name)).map(key).join(',');
    if (pk(a) !== pk(b)) {
      details.push(`Primärschlüssel: (${pk(b) || '–'}) → (${pk(a) || '–'}) – bitte von Hand anpassen`);
      script.tables!.push(`-- ${commentText(`${name}: Primärschlüssel unterschiedlich, bitte von Hand anpassen`)}`);
    }
    // Indizes
    const ixKey = (i: IndexInfo) => (i.definition ? `${i.unique}|${i.constraint ?? false}|${i.kind ?? ''}|${i.definition}` : `${i.unique}|${i.columns.map(key).join(',')}`);
    const ixText = (i: IndexInfo) => `${i.columns.join(', ')}${i.unique ? ', eindeutig' : ''}${i.where ? `, WHERE ${i.where}` : ''}${i.kind ? `, ${i.kind}` : ''}`;
    const bIx = new Map(b.indexes.filter((i) => !i.primary).map((i) => [key(i.name), i]));
    const aIx = new Map(a.indexes.filter((i) => !i.primary).map((i) => [key(i.name), i]));
    for (const [k, ia] of aIx) {
      const ib = bIx.get(k);
      if (!ib) {
        details.push(`Index ${ia.name} fehlt im Ziel`);
        const s = createIndex(name, ia, a);
        if (s) script.post!.push(end(s));
      } else if (ixKey(ia) !== ixKey(ib)) {
        details.push(`Index ${ia.name}: (${ixText(ib)}) → (${ixText(ia)})`);
        const s = createIndex(name, ia, a);
        if (s) {
          script.pre!.push(end(dropIndex(name, ib)));
          script.post!.push(end(s));
        }
      }
    }
    for (const [k, ib] of bIx) {
      if (aIx.has(k)) continue;
      details.push(`Index ${ib.name} nur im Ziel`);
      drops.ix.push(end(dropIndex(name, ib)));
    }
    // Fremdschlüssel (mit Regeln: ON DELETE CASCADE im Ziel ohne CASCADE wäre ein Unterschied im Verhalten)
    const fkKey = (f: ForeignKeyInfo, side: CompareSideDriver) =>
      `${f.columns.map(key).join(',')}>${key(f.refTable)}(${f.refColumns.map(key).join(',')})@${key(f.refSchema) === key(dialect === 'mysql' ? side.database : side.schema) ? '' : key(f.refSchema)}` +
      `|${f.onDelete ?? ''}|${f.onUpdate ?? ''}`;
    const bFk = new Map(b.foreignKeys.map((f) => [key(f.name), f]));
    const aFk = new Map(a.foreignKeys.map((f) => [key(f.name), f]));
    for (const [k, fa] of aFk) {
      const fb = bFk.get(k);
      if (!fb) {
        details.push(`Fremdschlüssel ${fa.name} fehlt im Ziel`);
        script.post!.push(end(addForeignKey(name, fa)));
      } else if (fkKey(fa, src) !== fkKey(fb, dst)) {
        details.push(`Fremdschlüssel ${fa.name} unterschiedlich`);
        script.pre!.push(end(dropForeignKey(name, fb)));
        script.post!.push(end(addForeignKey(name, fa)));
      }
    }
    for (const [k, fb] of bFk) {
      if (aFk.has(k)) continue;
      details.push(`Fremdschlüssel ${fb.name} nur im Ziel`);
      drops.fk.push(end(dropForeignKey(name, fb)));
    }
    // CHECK-Einschränkungen
    const ckNorm = (k: CheckInfo) => k.expression.replace(/\s+/g, '').toLowerCase();
    const bCk = new Map((b.checks ?? []).map((k) => [key(k.name), k]));
    const aCk = new Map((a.checks ?? []).map((k) => [key(k.name), k]));
    for (const [k, ka] of aCk) {
      const kb = bCk.get(k);
      if (!kb) {
        details.push(`CHECK ${ka.name} fehlt im Ziel`);
        script.post!.push(end(addCheck(name, ka)));
      } else if (ckNorm(ka) !== ckNorm(kb)) {
        details.push(`CHECK ${ka.name}: ${kb.expression} → ${ka.expression}`);
        script.pre!.push(end(dropCheck(name, kb)));
        script.post!.push(end(addCheck(name, ka)));
      }
    }
    for (const [k, kb] of bCk) {
      if (aCk.has(k)) continue;
      details.push(`CHECK ${kb.name} nur im Ziel`);
      drops.ck.push(end(dropCheck(name, kb)));
    }
    script.drop!.push(...drops.fk, ...drops.ix, ...drops.ck, ...drops.col);
    if (!details.length) return null;
    for (const p of ['pre', 'tables', 'post', 'drop'] as const) if (!script[p]!.length) delete script[p];
    return { kind: 'table', name, status: 'different', details, script };
  }

  // --- Views ----------------------------------------------------------------------------------------
  const viewsOf = (list: typeof srcObjs) => new Map(list.filter((o) => o.kind === 'view').map((o) => [key(o.name), o.name]));
  const sv = viewsOf(srcObjs);
  const dv = viewsOf(dstObjs);
  /** View-Text ohne Merkmale der jeweiligen Seite (MySQL: DEFINER und Datenbankname; PostgreSQL und SQL Server: Schema) */
  const viewText = (ddl: string, side: CompareSideDriver) => {
    let s = ddl.trim().replace(/;\s*$/, '');
    if (dialect === 'mysql') s = s.replace(/\s+DEFINER\s*=\s*\S+@\S+/i, '').replace(new RegExp('`' + escape(side.database) + '`\\.', 'g'), '');
    else s = withoutSchema(dialect, s, side.schema);
    return s;
  };
  const isMat = (ddl: string) => /^\s*CREATE\s+MATERIALIZED\s+VIEW/i.test(ddl);
  /** Anweisung, die die View im Ziel anlegt oder ersetzt; targetMat = Art im Ziel (undefined: fehlt dort) */
  const viewScript = (ddl: string, name: string, targetMat?: boolean) => {
    let s = ddl.trim().replace(/;\s*$/, '');
    if (dialect === 'mysql') {
      s = s.replace(/\s+DEFINER\s*=\s*\S+@\S+/i, '').replace(new RegExp('`' + escape(src.database) + '`\\.', 'g'), '');
      s = /^CREATE\s+OR\s+REPLACE\b/i.test(s) ? s : s.replace(/^CREATE\b/i, 'CREATE OR REPLACE');
    } else if (dialect === 'postgres') {
      // Kopf der View auf das Ziel-Schema; materialisierte Views lassen sich nicht ersetzen – und DROP VIEW bzw. DROP
      // MATERIALIZED VIEW muss zur Art im Ziel passen (sonst „is not a view“)
      if (isMat(s)) {
        const drop = targetMat === false ? `DROP VIEW IF EXISTS ${full(name)}` : `DROP MATERIALIZED VIEW IF EXISTS ${full(name)}`;
        return [end(drop), end(s.replace(/^CREATE\s+MATERIALIZED\s+VIEW\s+\S+/i, `CREATE MATERIALIZED VIEW ${full(name)}`))];
      }
      s = s.replace(/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+\S+/i, `CREATE OR REPLACE VIEW ${full(name)}`);
      if (targetMat) return [end(`DROP MATERIALIZED VIEW IF EXISTS ${full(name)}`), end(s)];
    } else {
      // gespeichert ist der Text der letzten Anweisung (auch ALTER VIEW): Kopf vereinheitlichen, Kopf und Rumpf aufs Ziel-Schema
      s = rewriteRefs('mssql', rewriteHead('mssql', createOrAlter(s), src.schema, dst.schema), src.schema, dst.schema);
    }
    return [end(s)];
  };
  const viewKeys = [...new Set([...sv.keys(), ...dv.keys()])].sort();
  const viewItems: (CompareItem & { ddl: string })[] = [];
  for (const k of viewKeys) {
    const s = sv.get(k);
    const d = dv.get(k);
    try {
    if (s && !d) {
      const ddl = await src.driver.getDdl(src.database, src.schema, s, 'view');
      viewItems.push({ kind: 'view', name: s, status: 'onlySource', details: ['nur in der Quelle'], script: { views: viewScript(ddl, s) }, ddl });
    } else if (!s && d) {
      const ddl = await dst.driver.getDdl(dst.database, dst.schema, d, 'view');
      viewItems.push({ kind: 'view', name: d, status: 'onlyTarget', details: ['nur im Ziel'], script: { drop: [end(`DROP ${isMat(ddl) ? 'MATERIALIZED ' : ''}VIEW ${full(d)}`)] }, ddl });
    } else {
      const [a, b] = await Promise.all([src.driver.getDdl(src.database, src.schema, s!, 'view'), dst.driver.getDdl(dst.database, dst.schema, d!, 'view')]);
      if (norm(viewText(a, src)) === norm(viewText(b, dst))) same++;
      else {
        const kinds = isMat(a) !== isMat(b) ? [`${isMat(b) ? 'materialisiert' : 'gewöhnlich'} → ${isMat(a) ? 'materialisiert' : 'gewöhnlich'}`] : [];
        viewItems.push({ kind: 'view', name: d!, status: 'different', details: ['Definition unterschiedlich', ...kinds], script: { views: viewScript(a, d!, isMat(b)) }, ddl: a });
      }
    }
    } catch (e) {
      // z. B. SQL Server WITH ENCRYPTION: nicht vergleichbar
      warnings.push(`View ${s ?? d}: ${(e as Error).message}`);
    }
  }
  // Views, die andere Views benutzen, hinter diesen (angelegt in dieser Reihenfolge, gelöscht in umgekehrter – siehe compareScript)
  for (const v of orderByUse(viewItems)) {
    const { ddl: _ddl, ...item } = v;
    items.push(item);
  }

  // --- Prozeduren, Funktionen, Trigger -------------------------------------------------------------------
  const [sr, dr] = await Promise.all([src.driver.listRoutines(src.database, src.schema), dst.driver.listRoutines(dst.database, dst.schema)]);
  const rKey = (r: RoutineInfo) => `${r.kind}|${key(r.name)}|${r.args ?? ''}|${key(r.table ?? '')}`;
  const srm = new Map(sr.map((r) => [rKey(r), r]));
  const drm = new Map(dr.map((r) => [rKey(r), r]));
  const routineText = (ddl: string, side: CompareSideDriver) => (dialect === 'mysql' ? ddl.replace(/\s+DEFINER\s*=\s*\S+@\S+/i, '') : withoutSchema(dialect, ddl, side.schema));
  const routineScript = (r: RoutineInfo, ddl: string): string => {
    const schema = dialect === 'mysql' ? '' : dst.schema;
    if (dialect === 'mssql') return editorScript('mssql', schema, r, rewriteRefs('mssql', rewriteHead('mssql', createOrAlter(ddl), src.schema, dst.schema), src.schema, dst.schema)).trimEnd();
    if (dialect === 'postgres') {
      // PostgreSQL-Funktionen per CREATE OR REPLACE (ein DROP scheiterte an abhängigen Views/Triggern)
      if (r.kind !== 'trigger') return dumpScript('postgres', schema, r, rewriteHead('postgres', ddl, src.schema, dst.schema), false).trimEnd();
      return dumpScript('postgres', schema, r, rewriteTrigger(ddl, src.schema, dst.schema), true).trimEnd();
    }
    return dumpScript(dialect, schema, r, ddl, true).trimEnd();
  };
  const dropRoutine = (r: RoutineInfo): string => {
    const kw = KEYWORD[r.kind];
    if (dialect === 'mysql') return end(`DROP ${kw} IF EXISTS ${q(r.name)}`);
    if (dialect === 'postgres') {
      return end(r.kind === 'trigger' ? `DROP TRIGGER IF EXISTS ${q(r.name)} ON ${full(r.table ?? '')}` : `DROP ${kw} IF EXISTS ${full(r.name)}(${r.args ?? ''})`);
    }
    return end(`DROP ${kw} IF EXISTS ${full(r.name)}`);
  };
  const order = { function: 0, procedure: 1, trigger: 2 } as const;
  const routineKeys = [...new Set([...srm.keys(), ...drm.keys()])].sort((x, y) => {
    const a = (srm.get(x) ?? drm.get(x))!;
    const b = (srm.get(y) ?? drm.get(y))!;
    return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
  });
  for (const k of routineKeys) {
    const s = srm.get(k);
    const d = drm.get(k);
    const base = (r: RoutineInfo) => ({ kind: r.kind, name: r.name, ...(r.table ? { table: r.table } : {}), ...(r.args !== undefined ? { args: r.args } : {}) });
    try {
      if (s && !d) {
        const ddl = await src.driver.routineDdl(src.database, src.schema, s);
        items.push({ ...base(s), status: 'onlySource', details: ['nur in der Quelle'], script: { routines: [routineScript(s, ddl)] } });
      } else if (!s && d) {
        items.push({ ...base(d), status: 'onlyTarget', details: ['nur im Ziel'], script: { drop: [dropRoutine(d)] } });
      } else {
        const [a, b] = await Promise.all([src.driver.routineDdl(src.database, src.schema, s!), dst.driver.routineDdl(dst.database, dst.schema, d!)]);
        if (norm(routineText(a, src)) === norm(routineText(b, dst))) same++;
        else items.push({ ...base(s!), status: 'different', details: ['Text unterschiedlich'], script: { routines: [routineScript(s!, a)] } });
      }
    } catch (e) {
      warnings.push(`${(s ?? d)!.name}: ${(e as Error).message}`);
    }
  }

  return { dialect, items, same, warnings: [...new Set(warnings)] };
}
