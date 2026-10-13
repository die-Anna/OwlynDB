import { createWriteStream, promises as fs } from 'node:fs';
import type { Writable } from 'node:stream';
import type { ColumnInfo, Dialect, DumpRequest, IndexInfo, ResultColumn, RoutineInfo, TableDataRequest, TableInfo } from '../shared/api-types';
import { DIALECT_LABEL } from '../shared/api-types';
import { ANON_SHORT, suggestAnonRule } from '../shared/anonymize-rules';
import { commentText, literal, quoteIdent } from '../shared/sql-util';
import { Anonymizer, spreadRules, uniqueColumns, type AnonColumn } from './anonymize';
import { errorText, type CancelCheck, type MetaDriver, type RowSink, type TypeDdl } from './drivers/common';
import { createOrAlter, dumpScript } from './routines';
import { closeStream, type ExportCell } from './export';
import { chunks, COMPOSITE_CHUNK, KEY_CHUNK, keyWhere, planSubset, ruleQuery, tableId } from './subset';

/** Tabelle mit Namen im Ziel */
interface Planned {
  schema: string;
  name: string;
  info: TableInfo;
  /** Schema im Ziel ('' = ohne Schema, MySQL) */
  toSchema: string;
  toName: string;
  /** Zieltypen je Spalte */
  types: string[];
  identity?: string;
  /** Spalten, die nicht eingefügt werden (berechnet, rowversion – der Server setzt sie selbst) */
  skip: Set<string>;
}

export interface DumpProgress {
  rows: number;
  table: string;
  warnings: string[];
}

const DEFAULT_SCHEMA: Record<Dialect, string> = { mysql: '', postgres: 'public', mssql: 'dbo', elasticsearch: '' };
/** ein INSERT höchstens so groß (wie net_buffer_length bei mysqldump): MariaDB nimmt standardmäßig 16 MB je Paket an */
const INSERT_BYTES = 1024 * 1024;

/**
 * Dump als SQL-Datei: Typen, Tabellen (ohne Fremdschlüssel), Daten, Indizes, Fremdschlüssel, Views – in dieser Reihenfolge,
 * damit es ohne Abhängigkeitssortierung einspielbar ist. Zieltyp darf vom Quelltyp abweichen.
 * target: Dateiname oder ein Datenstrom (Kopieren: geht direkt ins Einspielen).
 */
export async function writeDump(
  driver: MetaDriver,
  src: Dialect,
  req: DumpRequest,
  target: string | Writable,
  progress: DumpProgress,
  cancelled: CancelCheck,
): Promise<void> {
  const dst = req.targetDialect;
  const same = src === dst;
  const out = new Out(target);
  try {
    const tables: Planned[] = [];
    const used = new Set<string>();
    const add = async (t: { schema: string; name: string }) => {
      const info = await driver.describeTable(req.database, t.schema, t.name);
      let toSchema = same ? t.schema : dst === 'mysql' ? '' : t.schema === DEFAULT_SCHEMA[src] ? DEFAULT_SCHEMA[dst] : t.schema;
      let toName = t.name;
      // MySQL kennt keine Schemas: gleiche Namen aus verschiedenen Schemas auseinanderhalten
      if (dst === 'mysql' && used.has(toName.toLowerCase())) toName = `${t.schema}_${t.name}`;
      used.add(toName.toLowerCase());
      if (dst === 'mysql' && same) toSchema = '';
      const indexed = indexedColumns(info);
      const types = info.columns.map((c) => (same ? c.dataType : mapType(src, c, dst, indexed.has(c.name), (m) => progress.warnings.push(`${t.name}.${c.name}: ${m}`))));
      const identity = info.columns.find((c) => c.autoIncrement)?.name;
      // berechnete Spalten und rowversion setzt der Server selbst – im anderen Datenbanktyp werden sie normale Spalten mit Werten
      const skip = new Set(same ? info.columns.filter((c) => c.generated !== undefined || c.rowversion).map((c) => c.name) : []);
      if (info.special) progress.warnings.push(`${t.name} ist ${info.special} – als normale Tabelle übernommen.`);
      tables.push({ schema: t.schema, name: t.name, info, toSchema, toName, types, identity, skip });
    };
    for (const t of req.tables) await add(t);

    // Teilmenge: Tabellen, auf die verwiesen wird, ergänzen (nur die nötigen Zeilen); dann planen, welche Zeilen mitkommen
    const rules = new Map((req.subset ?? []).map((s) => [tableId(s.schema, s.name), s.rule]));
    const partial = req.data && [...rules.values()].some((r) => r.kind !== 'all');
    const added = new Set<string>();
    if (partial && req.addReferenced) {
      for (let i = 0; i < tables.length; i++) {
        for (const fk of tables[i].info.foreignKeys) {
          // MySQL: Verweis in eine andere Datenbank bleibt draußen
          if (src === 'mysql' && fk.refSchema && fk.refSchema !== req.database) continue;
          const schema = src === 'mysql' ? '' : fk.refSchema;
          if (tables.some((x) => x.name === fk.refTable && x.schema === schema)) continue;
          await add({ schema, name: fk.refTable });
          rules.set(tableId(schema, fk.refTable), { kind: 'none' });
          added.add(tableId(schema, fk.refTable));
          progress.warnings.push(`${fk.refTable} ergänzt (${tables[i].name} verweist darauf) – nur die Zeilen, auf die verwiesen wird.`);
        }
      }
    }
    const plans = partial
      ? await planSubset(
          driver,
          src,
          req.database,
          tables.map((t) => ({ schema: t.schema, name: t.name, info: t.info, rule: rules.get(tableId(t.schema, t.name)) ?? { kind: 'all' } })),
          progress,
          cancelled,
        )
      : null;

    // Anonymisieren: Regeln je Spalte, über Fremdschlüssel auf verbundene Spalten ausgedehnt; die Form je Regel gilt für
    // den ganzen Lauf (eindeutige Spalten bekommen einen Prüfsummen-Anhang, schmale Spalten erzwingen die Kurzform)
    let anonFor: ((t: Planned, column: string) => ((v: ExportCell) => ExportCell) | undefined) | undefined;
    let anonymizer: Anonymizer | undefined;
    const anonNotes: string[] = [];
    if (req.data && req.anonymize?.length) {
      const colId = (schema: string, table: string, column: string) => `${schema}\u0000${table}\u0000${column}`;
      const given = new Map(req.anonymize.map((a) => [colId(a.schema, a.table, a.column), a.rule]));
      const { rules: all, notes } = spreadRules(tables, given, src === 'mysql');
      const unique = uniqueColumns(tables);
      const columns: AnonColumn[] = [];
      for (const t of tables) {
        t.info.columns.forEach((c, i) => {
          const rule = all.get(colId(t.schema, t.name, c.name));
          if (rule) columns.push({ rule, nullable: c.nullable, dataType: t.types[i], unique: unique.has(colId(t.schema, t.name, c.name)), label: `${t.name}.${c.name}` });
        });
      }
      const a = new Anonymizer();
      anonymizer = a;
      const forms = a.prepare(columns);
      anonFor = (t, column) => {
        const rule = all.get(colId(t.schema, t.name, column));
        const i = t.info.columns.findIndex((c) => c.name === column);
        return rule && i >= 0 ? a.fn(rule, { nullable: t.info.columns[i].nullable, dataType: t.types[i], label: `${t.name}.${column}` }) : undefined;
      };
      for (const c of columns) anonNotes.push(`${c.label} → ${ANON_SHORT[c.rule]}`);
      progress.warnings.push(`Anonymisiert: ${anonNotes.join(', ')}.`, ...notes, ...forms);
      // ergänzte Tabellen: Spalten, die nach Personendaten aussehen, aber keine Regel haben, gingen sonst still unverändert mit
      for (const t of tables) {
        if (!added.has(tableId(t.schema, t.name))) continue;
        const open = t.info.columns.filter((c) => !all.has(colId(t.schema, t.name, c.name)) && suggestAnonRule(t.name, c.name, c.dataType)).map((c) => c.name);
        if (open.length) {
          progress.warnings.push(
            `${t.name} (ergänzt): ${open.join(', ')} ${open.length === 1 ? 'sieht nach Personendaten aus, hat' : 'sehen nach Personendaten aus, haben'} aber keine Regel – ` +
              'geht unverändert mit. Auch für ergänzte Tabellen lassen sich im Dialog Regeln wählen.',
          );
        }
      }
    }
    const q = (s: string) => quoteIdent(dst, s);
    const full = (p: { toSchema: string; toName: string }) => (p.toSchema ? `${q(p.toSchema)}.${q(p.toName)}` : q(p.toName));
    const end = dst === 'mssql' ? ';\nGO\n' : ';\n';
    const stmt = (s: string) => out.write(s + end);
    // Kommentarzeilen: Namen aus der Datenbank dürfen Zeilenumbrüche enthalten – dahinter wäre wieder lebendiges SQL
    const note = (s: string) => out.write(`\n-- ${commentText(s)}\n`);

    await out.write(
      `-- ${commentText(`OwlynDB-Dump: ${req.database} (${DIALECT_LABEL[src]}) für ${DIALECT_LABEL[dst]}`)}\n` +
        `-- erstellt ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC; ${tables.length} Tabelle(n)` +
        `${req.structure ? ', Struktur' : ''}${req.data ? ', Daten' : ''}\n` +
        (partial ? '-- Teilmenge: nicht alle Zeilen, dazu alle Zeilen, auf die verwiesen wird\n' : '') +
        (anonNotes.length ? `-- ${commentText(`anonymisiert: ${anonNotes.join(', ')}`)}\n` : '') +
        '\n',
    );
    if (dst === 'mysql') await stmt('SET NAMES utf8mb4');
    // Zeitstempel: gelesen in UTC (streamTable mit utc), hier wieder in UTC gedeutet – egal, in welcher Zeitzone die Server laufen
    if (dst === 'mysql') await stmt("SET time_zone = '+00:00'");
    if (dst === 'mysql') await stmt('SET FOREIGN_KEY_CHECKS = 0');
    if (dst === 'postgres') await stmt("SET client_encoding = 'UTF8'");
    if (dst === 'postgres') await stmt('SET standard_conforming_strings = on');
    if (dst === 'postgres') await stmt("SET TIME ZONE 'UTC'");
    // wie pg_dump: Funktionsrümpfe nicht schon beim Anlegen prüfen (sie dürfen auf Objekte außerhalb des Dumps zeigen)
    if (dst === 'postgres' && req.routines && same) await stmt('SET check_function_bodies = false');
    // Datumsliterale sind bei datetime/smalldatetime sprachabhängig (DATEFORMAT dmy bei deutschen Logins)
    if (dst === 'mssql') await stmt('SET DATEFORMAT ymd');

    const views = req.structure ? req.views : [];
    if (req.structure && views.length && !same) {
      progress.warnings.push(`${views.length} View(s) nicht übernommen: View-SQL lässt sich nicht automatisch in ${DIALECT_LABEL[dst]} übersetzen.`);
    }
    // Views vorab lesen: die Reihenfolge richtet sich danach, welche View welche benutzt (angelegt in dieser, gelöscht in umgekehrter)
    const viewTargets: { schema: string; name: string; toSchema: string; toName: string; ddl: string; materialized: boolean }[] = [];
    if (same) {
      for (const v of views) {
        let ddl: string;
        try {
          ddl = (await driver.getDdl(req.database, v.schema, v.name, 'view')).trim().replace(/;\s*$/, '');
        } catch (e) {
          // z. B. SQL Server WITH ENCRYPTION oder fehlende Berechtigung
          progress.warnings.push(`View ${v.name} übersprungen: ${errorText(e)}`);
          continue;
        }
        if (dst === 'mysql') {
          // ohne DEFINER (anderer Server, andere Benutzer) und ohne Datenbanknamen (Einspielen in andere Datenbank)
          ddl = ddl.replace(/\s+DEFINER\s*=\s*\S+@\S+/i, '').replace(new RegExp('`' + req.database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`\\.', 'g'), '');
        }
        // SQL Server speichert den Text der letzten Anweisung – auch ein ALTER VIEW
        if (dst === 'mssql') ddl = createOrAlter(ddl);
        viewTargets.push({ ...v, toSchema: dst === 'mysql' ? '' : v.schema, toName: v.name, ddl, materialized: /^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(ddl) });
      }
      orderByUse(viewTargets);
    }
    // Tabellen: verweisende hinter den Tabellen, auf die sie zeigen (zum Löschen umgekehrt)
    const ordered = orderByRefs(tables, src);

    // benutzerdefinierte Typen (nur gleicher Datenbanktyp): ENUM, DOMAIN, Aliastypen – vor den Tabellen, die sie benutzen
    const types: TypeDdl[] = [];
    if (req.structure && same && driver.typeDdl) {
      for (const schema of [...new Set(tables.map((t) => t.schema))]) {
        for (const x of await driver.typeDdl(req.database, schema, tables.filter((t) => t.schema === schema).map((t) => t.name))) {
          if (x.note) progress.warnings.push(x.note);
          else if (!types.some((y) => y.schema === x.schema && y.name === x.name)) types.push(x);
        }
      }
    }

    // Schemas
    if (req.structure) {
      const schemas = [...new Set(tables.map((t) => t.toSchema).concat(viewTargets.map((v) => v.toSchema), types.map((x) => x.schema)))].filter((s) => s && s !== DEFAULT_SCHEMA[dst]);
      for (const s of schemas) {
        if (dst === 'postgres') await stmt(`CREATE SCHEMA IF NOT EXISTS ${q(s)}`);
        if (dst === 'mssql') await stmt(`IF SCHEMA_ID(${literal('mssql', s)}) IS NULL EXEC(${literal('mssql', `CREATE SCHEMA ${q(s)}`)})`);
      }
    }

    // vorher löschen: Views (abhängige zuerst), dann die Fremdschlüssel der Dump-Tabellen untereinander, dann die Tabellen,
    // dann Typen. Ohne CASCADE: was außerhalb des Dumps daran hängt (Views, Fremdschlüssel anderer Tabellen), lässt das
    // Löschen scheitern, statt still zu verschwinden und nie wieder angelegt zu werden.
    if (req.structure && req.dropFirst) {
      await out.write('\n-- vorhandene Objekte löschen (ohne CASCADE: hängt außerhalb des Dumps etwas daran, scheitert das Löschen hier)\n');
      for (const v of [...viewTargets].reverse()) {
        if (dst === 'postgres') {
          // IF EXISTS hilft nicht gegen die falsche Art: ist im Ziel eine materialisierte Sicht, scheitert DROP VIEW
          const name = literal('postgres', full(v));
          await stmt(
            `DO $$ BEGIN\n  IF (SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass(${name})) = 'm' THEN EXECUTE ${literal('postgres', `DROP MATERIALIZED VIEW ${full(v)}`)};\n` +
              `  ELSE EXECUTE ${literal('postgres', `DROP VIEW IF EXISTS ${full(v)}`)}; END IF;\nEND $$`,
          );
        } else await stmt(`DROP VIEW IF EXISTS ${full(v)}`);
      }
      if (dst !== 'mysql') {
        for (const t of tables) {
          for (const fk of t.info.foreignKeys) {
            if (!tables.some((x) => x.name === fk.refTable && x.schema === fk.refSchema)) continue;
            if (dst === 'postgres') await stmt(`ALTER TABLE IF EXISTS ${full(t)} DROP CONSTRAINT IF EXISTS ${q(fk.name)}`);
            else await stmt(`IF OBJECT_ID(${literal('mssql', `${q(t.toSchema)}.${q(fk.name)}`)}, 'F') IS NOT NULL ALTER TABLE ${full(t)} DROP CONSTRAINT ${q(fk.name)}`);
          }
        }
      }
      for (const t of [...ordered].reverse()) await stmt(`DROP TABLE IF EXISTS ${full(t)}`);
      for (const x of [...types].reverse()) await stmt(`DROP ${x.kind} IF EXISTS ${q(x.schema)}.${q(x.name)}`);
    }

    // Typen
    if (req.structure && types.length) {
      await out.write('\n-- Typen\n');
      for (const x of types) {
        if (req.dropFirst) await stmt(x.ddl!);
        // ohne Löschen vorab: ein schon vorhandener Typ bleibt, wie er ist
        else if (dst === 'postgres') await stmt(`DO $$ BEGIN\n  ${x.ddl};\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$`);
        else await stmt(`IF TYPE_ID(${literal('mssql', `${q(x.schema)}.${q(x.name)}`)}) IS NULL ${x.ddl}`);
      }
    }

    // Tabellen
    if (req.structure) {
      for (const t of tables) {
        await note(`Tabelle ${t.toName}`);
        await stmt(createTable(src, dst, t, full(t), progress.warnings));
        if (same && dst === 'postgres') {
          for (const c of t.info.columns) if (c.comment) await stmt(`COMMENT ON COLUMN ${full(t)}.${q(c.name)} IS ${literal(dst, c.comment)}`);
        }
      }
    }

    // Daten
    if (req.data) {
      for (const t of tables) {
        if (cancelled()) throw new Error('Abgebrochen.');
        progress.table = t.toName;
        const plan = plans?.get(tableId(t.schema, t.name)) ?? { mode: 'all' };
        if (plan.mode === 'none') {
          await note(`Daten ${t.toName}: keine Zeilen (Teilmenge)`);
          continue;
        }
        await note(`Daten ${t.toName}${plan.mode === 'keys' ? ` (Teilmenge: ${plan.keys.length} Zeilen)` : plan.mode === 'rule' || plan.mode === 'refs' ? ' (Teilmenge)' : ''}`);
        const identityInsert = dst === 'mssql' && !!t.identity;
        if (identityInsert) await stmt(`SET IDENTITY_INSERT ${full(t)} ON`);
        const sink = new InsertSink(out, dst, full(t), t, req.rowsPerInsert, end, progress, cancelled, anonFor && ((c) => anonFor!(t, c)));
        const base: TableDataRequest = {
          object: { connectionId: '', database: req.database, schema: t.schema, name: t.name, kind: 'table' },
          limit: 0,
          offset: 0,
          sort: [],
          utc: true,
          // PostgreSQL-Vererbung: nur die eigenen Zeilen (bei partitionierten Tabellen wäre ONLY leer)
          only: !t.info.special,
          ...(t.skip.size ? { columns: t.info.columns.filter((c) => !t.skip.has(c.name)).map((c) => c.name) } : {}),
        };
        // mit Abbruch-Signal: Abbrechen erreicht die Quelle auch, solange sie noch keine Zeile geliefert hat
        const signal = cancelled.signal;
        if (plan.mode === 'all') await driver.streamTable(base, sink, signal);
        else if (plan.mode === 'rule') await driver.streamTable({ ...base, ...ruleQuery(plan.rule) }, sink, signal);
        else if (plan.mode === 'refs') {
          for (const part of chunks(plan.values, plan.cols.length === 1 ? KEY_CHUNK : COMPOSITE_CHUNK)) {
            await driver.streamTable({ ...base, where: keyWhere(src, t.info, plan.cols, part) }, sink, signal);
          }
        } else {
          for (const part of chunks(plan.keys, plan.key.length === 1 ? KEY_CHUNK : COMPOSITE_CHUNK)) {
            await driver.streamTable({ ...base, where: keyWhere(src, t.info, plan.key, part) }, sink, signal);
          }
        }
        await sink.flush();
        if (identityInsert) await stmt(`SET IDENTITY_INSERT ${full(t)} OFF`);
        // Identität hinter den höchsten Wert setzen (MySQL und SQL Server machen das selbst); auch bei „nur Daten“ –
        // ohne Sequenz im Ziel ist setval(NULL, …) wirkungslos
        if (dst === 'postgres' && t.identity) {
          const col = q(t.identity);
          await stmt(`SELECT setval(pg_get_serial_sequence(${literal(dst, full(t))}, ${literal(dst, t.identity)}), COALESCE(MAX(${col}), 0) + 1, false) FROM ${full(t)}`);
        }
      }
      // Werte, die sich nicht ersetzen ließen (geleert) oder gekürzt wurden
      if (anonymizer) progress.warnings.push(...anonymizer.report());
    }

    // Indizes und Fremdschlüssel
    if (req.structure) {
      for (const t of tables) {
        for (const ix of t.info.indexes) {
          if (ix.primary) continue;
          const s = indexSql(src, dst, t, full(t), ix, progress.warnings);
          if (s) await stmt(s);
        }
      }
      for (const t of tables) {
        for (const fk of t.info.foreignKeys) {
          const ref = tables.find((x) => x.name === fk.refTable && (src === 'mysql' || x.schema === fk.refSchema));
          if (!ref) {
            progress.warnings.push(`Fremdschlüssel ${t.name}.${fk.name} übersprungen: ${fk.refTable} ist nicht im Dump.`);
            continue;
          }
          let rules = '';
          for (const [kw, rule] of [
            ['DELETE', fk.onDelete],
            ['UPDATE', fk.onUpdate],
          ] as const) {
            if (!rule) continue;
            // InnoDB kennt SET DEFAULT nicht
            if (dst === 'mysql' && rule === 'SET DEFAULT') progress.warnings.push(`Fremdschlüssel ${t.name}.${fk.name}: ON ${kw} SET DEFAULT kennt MySQL nicht – ohne Regel angelegt.`);
            else rules += ` ON ${kw} ${rule}`;
          }
          await stmt(
            `ALTER TABLE ${full(t)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
              `REFERENCES ${full(ref)} (${fk.refColumns.map(q).join(', ')})${rules}`,
          );
        }
      }
      // Routinen (nur gleicher Datenbanktyp): Funktionen vor den Views (die sie benutzen können), Prozeduren danach,
      // Trigger ganz am Schluss – nach den Daten, sonst lösten sie beim Einspielen aus
      const routines: { schema: string; r: RoutineInfo; ddl: string }[] = [];
      if (req.routines) {
        if (!same) {
          progress.warnings.push(`Prozeduren, Funktionen und Trigger nicht übernommen: ihr SQL lässt sich nicht automatisch in ${DIALECT_LABEL[dst]} übersetzen.`);
        } else {
          for (const schema of [...new Set([...req.tables, ...req.views].map((t) => t.schema))]) {
            for (const r of await driver.listRoutines(req.database, schema)) {
              // Trigger nur zu Tabellen und Views, die im Dump sind (INSTEAD OF auf Views zählt mit)
              if (r.kind === 'trigger' && !tables.some((t) => t.schema === schema && t.name === r.table) && !viewTargets.some((v) => v.schema === schema && v.name === r.table)) continue;
              try {
                routines.push({ schema, r, ddl: await driver.routineDdl(req.database, schema, r) });
              } catch (e) {
                progress.warnings.push(`${r.name} übersprungen: ${errorText(e)}`);
              }
            }
          }
        }
      }
      const writeRoutines = async (kinds: RoutineInfo['kind'][]) => {
        for (const x of routines.filter((y) => kinds.includes(y.r.kind))) {
          await note(`${x.r.kind === 'procedure' ? 'Prozedur' : x.r.kind === 'function' ? 'Funktion' : 'Trigger'} ${x.r.name}`);
          // SQL Server: Kommentar als eigener Batch, sonst wird er Teil der gespeicherten Definition
          if (dst === 'mssql') await out.write('GO\n');
          await out.write(dumpScript(dst, dst === 'mysql' ? '' : x.schema, x.r, x.ddl, req.dropFirst));
        }
      };
      await writeRoutines(['function']);

      // Views (nur gleicher Datenbanktyp)
      for (const v of viewTargets) {
        await note(`View ${v.name}`);
        if (dst === 'mssql') await out.write('GO\n');
        await stmt(v.ddl);
      }
      await writeRoutines(['procedure', 'trigger']);
    }
    if (dst === 'mysql') await stmt('SET FOREIGN_KEY_CHECKS = 1');
    await out.end();
  } catch (e) {
    await out.abort(e);
    throw e;
  }
}

function indexedColumns(info: TableInfo): Set<string> {
  const s = new Set<string>();
  for (const ix of info.indexes) ix.columns.forEach((c) => s.add(c));
  for (const fk of info.foreignKeys) fk.columns.forEach((c) => s.add(c));
  for (const c of info.columns) if (c.primaryKey) s.add(c.name);
  return s;
}

/** Tabellen so sortieren, dass jede hinter denen steht, auf die sie verweist (Selbstbezüge und Zyklen bleiben in der Reihenfolge) */
export function orderByRefs<T extends { schema: string; name: string; info: TableInfo }>(tables: T[], dialect: Dialect): T[] {
  const refs = (t: T) =>
    t.info.foreignKeys
      .map((fk) => tables.find((x) => x.name === fk.refTable && (dialect === 'mysql' || x.schema === fk.refSchema)))
      .filter((x): x is T => !!x && x !== t);
  return topological(tables, refs);
}

/** Views so sortieren, dass jede hinter denen steht, deren Namen in ihrer Definition vorkommen */
export function orderByUse<T extends { name: string; ddl: string }>(views: T[]): T[] {
  const uses = (v: T) =>
    views.filter((w) => {
      if (w === v) return false;
      const re = new RegExp('(^|[^\\w$])' + w.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w$])', 'i');
      return re.test(v.ddl);
    });
  const sorted = topological(views, uses);
  views.splice(0, views.length, ...sorted);
  return views;
}

/** Reihenfolge nach Abhängigkeiten, stabil; bei Zyklen kommt der Rest in der gegebenen Reihenfolge */
function topological<T>(items: T[], deps: (t: T) => T[]): T[] {
  const out: T[] = [];
  const done = new Set<T>();
  const visiting = new Set<T>();
  const visit = (t: T) => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const d of deps(t)) visit(d);
    visiting.delete(t);
    done.add(t);
    out.push(t);
  };
  for (const t of items) visit(t);
  return out;
}

/** Spaltendefinition für CREATE/ALTER TABLE (Name, Typ, Zähler, NULL, Standardwert, berechneter Ausdruck) */
export function columnSql(src: Dialect, dst: Dialect, c: ColumnInfo, type: string, warnings: string[], table: string): string {
  const q = (s: string) => quoteIdent(dst, s);
  const same = src === dst;
  let line = `${q(c.name)} ${type}`;
  if (same && c.generated !== undefined) {
    // berechnete Spalte: Ausdruck im Wortlaut der Quelle
    if (dst === 'mssql') return `${q(c.name)} AS ${c.generated}${c.stored ? ' PERSISTED' : ''}`;
    if (dst === 'postgres') return `${line} GENERATED ALWAYS AS ${wrapped(c.generated)} STORED${c.nullable ? '' : ' NOT NULL'}`;
    return `${line} GENERATED ALWAYS AS ${wrapped(c.generated)} ${c.stored ? 'STORED' : 'VIRTUAL'}${c.nullable ? ' NULL' : ' NOT NULL'}`;
  }
  if (!same && c.generated !== undefined) warnings.push(`${table}.${c.name} ist in der Quelle berechnet (${c.generated}) – als normale Spalte mit den gelesenen Werten übernommen.`);
  if (same && c.rowversion) return `${q(c.name)} rowversion${c.nullable ? ' NULL' : ' NOT NULL'}`;
  if (c.autoIncrement) {
    if (dst === 'mysql') line += ' NOT NULL AUTO_INCREMENT';
    else if (dst === 'postgres') line += ' GENERATED BY DEFAULT AS IDENTITY';
    else line += ' IDENTITY(1,1) NOT NULL';
  } else {
    line += c.nullable ? ' NULL' : ' NOT NULL';
    let def = defaultFor(src, dst, c, type);
    // MySQL: TEXT/BLOB/JSON nur mit Ausdruck in Klammern (ab 8.0.13 bzw. MariaDB 10.2)
    if (def && dst === 'mysql' && /text|blob|json/i.test(type) && !def.startsWith('(')) def = `(${def})`;
    if (def === undefined) warnings.push(`Standardwert von ${table}.${c.name} nicht übernommen: ${c.defaultValue}`);
    else if (def) line += ` DEFAULT ${def}`;
  }
  if (c.onUpdate) {
    if (dst === 'mysql') line += ` ON UPDATE ${c.onUpdate}`;
    else warnings.push(`${table}.${c.name}: ON UPDATE ${c.onUpdate} gibt es in ${DIALECT_LABEL[dst]} nicht – nicht übernommen.`);
  }
  if (dst === 'mysql' && src === 'mysql' && c.comment) line += ` COMMENT ${literal('mysql', c.comment)}`;
  return line;
}

/** Ausdruck in genau einer Klammer (die Kataloge liefern ihn oft schon so) */
function wrapped(e: string): string {
  if (!e.startsWith('(') || !e.endsWith(')')) return `(${e})`;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++;
    else if (e[i] === ')' && --depth === 0 && i < e.length - 1) return `(${e})`;
  }
  return e;
}

/** CREATE TABLE für denselben Datenbanktyp (Schema-Vergleich) */
export function createTableSql(dialect: Dialect, info: TableInfo, name: string, target: string, warnings: string[]): string {
  return createTable(dialect, dialect, { schema: '', name, info, toSchema: '', toName: name, types: info.columns.map((c) => c.dataType), skip: new Set() }, target, warnings);
}

/** Standardwert im selben Datenbanktyp ('' = keiner) */
export function sameDialectDefault(dialect: Dialect, c: ColumnInfo): string {
  return defaultFor(dialect, dialect, c, c.dataType) ?? '';
}

/** CREATE [UNIQUE] INDEX bzw. ADD CONSTRAINT … UNIQUE für einen Index der Quelle; null = übersprungen (mit Hinweis) */
export function indexSql(src: Dialect, dst: Dialect, t: { name: string; toName: string; info: TableInfo; types: string[] }, target: string, ix: IndexInfo, warnings: string[]): string | null {
  const q = (s: string) => quoteIdent(dst, s);
  const same = src === dst;
  const cols = new Set(t.info.columns.map((c) => c.name));
  const plain = ix.columns.every((c) => cols.has(c));
  const skip = (why: string) => {
    warnings.push(`Index ${t.name}.${ix.name} übersprungen (${why}).`);
    return null;
  };
  if (same) {
    if (ix.constraint) {
      if (!ix.unique) return skip('Einschränkung ohne Eindeutigkeit, z. B. EXCLUDE');
      return `ALTER TABLE ${target} ADD CONSTRAINT ${q(ix.name)} UNIQUE (${ix.columns.map(q).join(', ')})`;
    }
    const def = ix.definition ?? `(${ix.columns.map((c) => (cols.has(c) ? q(c) : c)).join(', ')})`;
    if (dst === 'mysql' && (ix.kind === 'FULLTEXT' || ix.kind === 'SPATIAL')) return `CREATE ${ix.kind} INDEX ${q(ix.name)} ON ${target} ${def}`;
    if (dst === 'mssql' && ix.kind && ix.kind !== 'CLUSTERED') return skip(`Art ${ix.kind}`);
    return `CREATE ${ix.unique ? 'UNIQUE ' : ''}${dst === 'mssql' && ix.kind === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${q(ix.name)} ON ${target} ${def}`;
  }
  if (!plain) return skip(`Ausdruck: ${ix.columns.join(', ')}`);
  // ein Filter „Spalte IS NOT NULL“ auf den Indexspalten (SQL Server: eindeutig trotz mehrerer NULL) ist anderswo die Vorgabe
  const nullFilter =
    !!ix.where &&
    ix.where
      .replace(/[()[\]"`]/g, '')
      .split(/\s+AND\s+/i)
      .every((part) => {
        const m = /^\s*(\S+)\s+IS\s+NOT\s+NULL\s*$/i.exec(part);
        return !!m && ix.columns.includes(m[1]);
      });
  if (ix.where && !nullFilter) return skip(`Teilindex WHERE ${ix.where}`);
  if (ix.kind && !(src === 'mssql' && ix.kind === 'CLUSTERED')) return skip(`Art ${ix.kind}`);
  const typeOf = (c: string) => t.types[t.info.columns.findIndex((x) => x.name === c)] ?? '';
  if (dst === 'mysql' && ix.columns.some((c) => /^json$/i.test(typeOf(c)))) return skip('JSON lässt sich in MySQL nicht direkt indizieren');
  // PostgreSQL: Indexnamen gelten im ganzen Schema
  const name = dst === 'postgres' && !ix.name.startsWith(t.toName) ? `${t.toName}_${ix.name}`.slice(0, 63) : ix.name;
  // MySQL: TEXT/BLOB nur mit Präfixlänge indizierbar
  const list = ix.columns.map((c) => (dst === 'mysql' && /text|blob/i.test(typeOf(c)) ? `${q(c)}(255)` : q(c))).join(', ');
  let sql = `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${target} (${list})`;
  // SQL Server lässt in einem eindeutigen Index nur ein NULL zu (MySQL und PostgreSQL beliebig viele): NULL ausnehmen
  const nullable = ix.columns.filter((c) => t.info.columns.find((x) => x.name === c)?.nullable);
  if (dst === 'mssql' && ix.unique && nullable.length) {
    sql += ` WHERE ${nullable.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')}`;
    warnings.push(`Index ${t.name}.${ix.name}: eindeutig mit NULL-Spalten – in SQL Server als gefilterter Index (NULL ausgenommen).`);
  }
  return sql;
}

function createTable(src: Dialect, dst: Dialect, t: Planned, target: string, warnings: string[]): string {
  const q = (s: string) => quoteIdent(dst, s);
  const same = src === dst;
  const lines = t.info.columns.map((c, i) => '  ' + columnSql(src, dst, c, t.types[i], warnings, t.name));
  const pk = t.info.columns.filter((c) => c.primaryKey).map((c) => q(c.name));
  // Reihenfolge der Schlüsselspalten wie im Primärindex
  const pkIndex = t.info.indexes.find((ix) => ix.primary);
  const pkCols = pkIndex ? pkIndex.columns.map(q) : pk;
  if (pkCols.length) lines.push(`  ${same && dst !== 'mysql' && pkIndex ? `CONSTRAINT ${q(pkIndex.name)} ` : ''}PRIMARY KEY (${pkCols.join(', ')})`);
  for (const k of t.info.checks ?? []) {
    // Ausdrücke anderer Datenbanktypen (Quoting, Casts) lassen sich nicht übersetzen
    if (!same) warnings.push(`CHECK-Einschränkung ${t.name}.${k.name} nicht übernommen: ${k.expression}`);
    else lines.push(`  ${k.column ? '' : `CONSTRAINT ${q(k.name)} `}CHECK ${k.expression}`);
  }
  let tail = '';
  if (dst === 'mysql') {
    // Zeichensatz der Tabelle: sonst gälte die Vorgabe des Zielservers (latin1 auf älteren Servern)
    const collation = same ? t.info.collation : undefined;
    tail = collation ? ` DEFAULT CHARSET=${collation.split('_')[0]} COLLATE=${collation}` : ' DEFAULT CHARSET=utf8mb4';
  }
  return `CREATE TABLE ${target} (\n${lines.join(',\n')}\n)${tail}`;
}

const CURRENT_TS = /^(CURRENT_TIMESTAMP|now\(\)|getdate\(\)|sysdatetime\(\)|current_timestamp\(\d*\)|localtimestamp|localtimestamp\(\d*\)|localtime|localtime\(\d*\)|sysutcdatetime\(\)|getutcdate\(\)|transaction_timestamp\(\)|statement_timestamp\(\)|clock_timestamp\(\))$/i;
const CURRENT_DATE = /^(CURRENT_DATE|curdate\(\)|current_date\(\)|CAST\(\s*(GETDATE|SYSDATETIME)\(\)\s+AS\s+date\s*\)|CONVERT\(\s*date\s*,\s*(GETDATE|SYSDATETIME)\(\)\s*\))$/i;
const NEW_UUID = /^(uuid\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\)|newid\(\)|newsequentialid\(\))$/i;

/** Standardwert im Ziel: '' = keiner, undefined = nicht übersetzbar */
function defaultFor(src: Dialect, dst: Dialect, c: ColumnInfo, dstType: string): string | undefined {
  const raw = c.defaultValue;
  if (raw == null || raw === '') return '';
  // Verweis auf eine Sequenz: die gibt es im Ziel nicht (Sequenzen sind nicht Teil des Dumps)
  if (/\bNEXT\s+VALUE\s+FOR\b|\bnextval\s*\(/i.test(raw)) return undefined;
  // gleicher Datenbanktyp: so, wie der Katalog es liefert (MySQL-Treiber: schon in SQL-Form)
  if (src === dst) return raw;
  let v = raw.trim();
  if (src === 'mssql') while (/^\(.*\)$/.test(v)) v = v.slice(1, -1).trim();
  if (src === 'postgres') v = v.replace(/::[\w\s".[\]]+$/, '').trim();
  // MySQL: Ausdruck in Klammern
  if (src === 'mysql' && /^\(.*\)$/s.test(v)) v = v.slice(1, -1).trim();
  if (/^NULL$/i.test(v)) return '';
  const isBool = /^(boolean|bool|bit|tinyint\(1\))$/i.test(dstType);
  if (CURRENT_TS.test(v)) {
    if (!/date|time/i.test(dstType)) return undefined;
    if (dst === 'mssql') return 'SYSDATETIME()';
    // MySQL: Nachkommastellen müssen zur Spalte passen
    const fsp = dst === 'mysql' ? /\((\d+)\)/.exec(dstType)?.[1] : undefined;
    return fsp && fsp !== '0' ? `CURRENT_TIMESTAMP(${fsp})` : 'CURRENT_TIMESTAMP';
  }
  if (CURRENT_DATE.test(v)) {
    if (!/^date$/i.test(dstType)) return undefined;
    return dst === 'mysql' ? '(CURDATE())' : dst === 'postgres' ? 'CURRENT_DATE' : 'CAST(SYSDATETIME() AS date)';
  }
  if (NEW_UUID.test(v)) {
    if (!/uuid|uniqueidentifier|char\(36\)/i.test(dstType)) return undefined;
    return dst === 'mysql' ? '(UUID())' : dst === 'postgres' ? 'gen_random_uuid()' : 'NEWID()';
  }
  // MySQL-Bitwert b'101'
  const bits = /^b'([01]+)'$/i.exec(v);
  if (bits) v = String(parseInt(bits[1], 2));
  if (/^(true|false)$/i.test(v)) {
    const b = v.toLowerCase() === 'true';
    return dst === 'postgres' ? String(b) : b ? '1' : '0';
  }
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) {
    if (isBool && dst === 'postgres') return v === '0' ? 'false' : 'true';
    return v;
  }
  let str: string | undefined;
  if (/^N?'.*'$/s.test(v)) {
    str = v.replace(/^N?'/, '').slice(0, -1).replace(/''/g, "'");
    if (src === 'mysql') str = str.replace(/\\(.)/g, '$1');
  }
  if (str !== undefined) return literal(dst, str);
  return undefined;
}

/** Spaltentyp in einen anderen Datenbanktyp übersetzen; note bekommt Hinweise zu verlustbehafteten Übersetzungen */
export function mapType(src: Dialect, c: ColumnInfo, dst: Dialect, indexed: boolean, note?: (msg: string) => void): string {
  const t = c.dataType.toLowerCase().trim();
  const args = /\(([^)]*)\)/.exec(t)?.[1]?.split(',').map((x) => x.trim()) ?? [];
  const base = t.replace(/\(.*?\)/g, '').replace(/\bunsigned\b|\bzerofill\b|\bsigned\b/g, '').trim();
  const unsigned = /\bunsigned\b/.test(t);
  const n = (i: number) => (args[i] === undefined || args[i] === 'max' ? undefined : Number(args[i]));

  // Kategorie bestimmen
  let k:
    | { kind: 'bool' | 'date' | 'uuid' | 'json' | 'xml' | 'text' | 'binmax' | 'float' | 'real' }
    | { kind: 'int'; bytes: number }
    | { kind: 'dec'; p?: number; s?: number }
    | { kind: 'char' | 'varchar' | 'bin'; len?: number }
    | { kind: 'time' | 'datetime' | 'datetimetz'; p?: number }
    | { kind: 'enum'; len: number };
  if (base.endsWith('[]')) k = { kind: 'json' };
  else if (base === 'boolean' || base === 'bool' || base === 'bit' && (src === 'mssql' || n(0) === 1 || args.length === 0) || (base === 'tinyint' && src === 'mysql' && n(0) === 1))
    k = { kind: 'bool' };
  else if (base === 'tinyint') k = { kind: 'int', bytes: src === 'mssql' || unsigned ? 2 : 1 };
  else if (base === 'smallint' || base === 'int2' || base === 'year') k = { kind: 'int', bytes: unsigned ? 4 : 2 };
  else if (base === 'mediumint') k = { kind: 'int', bytes: 4 };
  else if (base === 'int' || base === 'integer' || base === 'int4' || base === 'serial') k = { kind: 'int', bytes: unsigned ? 8 : 4 };
  else if (base === 'bigint' || base === 'int8' || base === 'bigserial') k = { kind: 'int', bytes: unsigned ? 16 : 8 };
  else if (base === 'smallserial') k = { kind: 'int', bytes: 2 };
  else if (base === 'decimal' || base === 'numeric' || base === 'dec') k = { kind: 'dec', p: n(0), s: n(1) };
  else if (base === 'money') k = { kind: 'dec', p: 19, s: 4 };
  else if (base === 'smallmoney') k = { kind: 'dec', p: 10, s: 4 };
  else if (base === 'double' || base === 'double precision' || base === 'float8' || (base === 'float' && src !== 'mysql')) k = { kind: 'float' };
  else if (base === 'real' || base === 'float4' || base === 'float') k = { kind: 'real' };
  else if (base === 'char' || base === 'character' || base === 'nchar' || base === 'bpchar') k = { kind: 'char', len: n(0) ?? 1 };
  else if (base === 'varchar' || base === 'character varying' || base === 'nvarchar' || base === 'varchar2') k = { kind: 'varchar', len: n(0) };
  else if (/^(tiny|medium|long)?text$|^ntext$|^citext$|^set$|^name$/.test(base)) k = { kind: 'text' };
  else if (base === 'enum') k = { kind: 'enum', len: Math.max(1, ...args.map((a) => a.replace(/^'|'$/g, '').length)) };
  else if (base === 'date') k = { kind: 'date' };
  else if (base === 'time' || base === 'time without time zone') k = { kind: 'time', p: n(0) };
  else if (base === 'datetimeoffset' || base === 'timestamptz' || base === 'timestamp with time zone') k = { kind: 'datetimetz', p: n(0) };
  // SQL Server: timestamp ist rowversion, 8 Bytes Binärwert
  else if (base === 'timestamp' && src === 'mssql') k = { kind: 'bin', len: 8 };
  else if (/^(datetime|datetime2|smalldatetime|timestamp|timestamp without time zone)$/.test(base))
    k = { kind: 'datetime', p: n(0) ?? (base === 'datetime2' ? 7 : src === 'postgres' ? 6 : base === 'datetime' && src === 'mssql' ? 3 : 0) };
  else if (base === 'binary' || base === 'varbinary') k = { kind: 'bin', len: n(0) };
  else if (/^(tiny|medium|long)?blob$|^bytea$|^image$|^bit$/.test(base)) k = { kind: 'binmax' };
  else if (base === 'uuid' || base === 'uniqueidentifier') k = { kind: 'uuid' };
  else if (base === 'json' || base === 'jsonb') k = { kind: 'json' };
  else if (base === 'xml') k = { kind: 'xml' };
  else {
    note?.(`Typ ${c.dataType} ist in ${DIALECT_LABEL[dst]} unbekannt – als Text übernommen.`);
    k = { kind: 'text' };
  }
  // Zähler: Identität gibt es nur auf ganzen Zahlen bis bigint (bigint unsigned wäre sonst numeric(20,0))
  if (k.kind === 'int' && k.bytes > 8 && c.autoIncrement) {
    note?.(`Zähler auf ${c.dataType}: als bigint angelegt (Werte über 2^63 passen nicht).`);
    k.bytes = 8;
  }

  const textType = (len: number | undefined): string => {
    if (dst === 'mysql') return len !== undefined && len <= 16383 ? `varchar(${len})` : indexed ? 'varchar(255)' : 'longtext';
    if (dst === 'postgres') return len !== undefined ? `varchar(${len})` : 'text';
    return len !== undefined && len <= 4000 ? `nvarchar(${len})` : indexed ? 'nvarchar(450)' : 'nvarchar(max)';
  };
  switch (k.kind) {
    case 'bool':
      return dst === 'mysql' ? 'tinyint(1)' : dst === 'postgres' ? 'boolean' : 'bit';
    case 'int': {
      const b = k.bytes;
      if (dst === 'mysql') return b <= 1 ? 'tinyint' : b <= 2 ? 'smallint' : b <= 4 ? 'int' : b <= 8 ? 'bigint' : 'decimal(20,0)';
      if (dst === 'postgres') return b <= 2 ? 'smallint' : b <= 4 ? 'integer' : b <= 8 ? 'bigint' : 'numeric(20,0)';
      return b <= 1 ? 'smallint' : b <= 2 ? 'smallint' : b <= 4 ? 'int' : b <= 8 ? 'bigint' : 'decimal(20,0)';
    }
    case 'dec': {
      if (k.p === undefined) {
        // PostgreSQL numeric ohne Angabe: beliebige Genauigkeit – im Ziel das größte, was geht (statt 18,0 ohne Nachkommastellen)
        if (dst === 'postgres') return 'numeric';
        note?.(`numeric ohne Genauigkeit: als ${dst === 'mysql' ? 'decimal(65,30)' : 'decimal(38,18)'} angelegt – mehr Stellen passen nicht.`);
        return dst === 'mysql' ? 'decimal(65,30)' : 'decimal(38,18)';
      }
      const p = Math.min(k.p, dst === 'mysql' ? 65 : dst === 'mssql' ? 38 : 1000);
      const s = Math.min(k.s ?? 0, p);
      return dst === 'postgres' ? `numeric(${p},${s})` : `decimal(${p},${s})`;
    }
    case 'float':
      return dst === 'mysql' ? 'double' : dst === 'postgres' ? 'double precision' : 'float';
    case 'real':
      return dst === 'mysql' ? 'float' : 'real';
    case 'char':
      if (dst === 'mysql') return k.len! <= 255 ? `char(${k.len})` : textType(k.len);
      if (dst === 'postgres') return `char(${k.len})`;
      return k.len! <= 4000 ? `nchar(${k.len})` : textType(undefined);
    case 'varchar':
      return textType(k.len);
    case 'text':
      return textType(undefined);
    case 'enum':
      return textType(k.len);
    case 'date':
      return 'date';
    case 'time':
      return dst === 'mysql' ? `time(${Math.min(k.p ?? 0, 6)})` : dst === 'postgres' ? `time(${Math.min(k.p ?? 6, 6)})` : `time(${Math.min(k.p ?? 7, 7)})`;
    case 'datetime':
      return dst === 'mysql' ? `datetime(${Math.min(k.p ?? 0, 6)})` : dst === 'postgres' ? `timestamp(${Math.min(k.p ?? 6, 6)})` : `datetime2(${Math.min(k.p ?? 7, 7)})`;
    case 'datetimetz':
      return dst === 'mysql' ? `datetime(${Math.min(k.p ?? 6, 6)})` : dst === 'postgres' ? 'timestamptz' : `datetimeoffset(${Math.min(k.p ?? 7, 7)})`;
    case 'bin':
      if (dst === 'postgres') return 'bytea';
      if (dst === 'mysql') return k.len !== undefined && k.len <= 65535 ? `varbinary(${k.len})` : 'longblob';
      return k.len !== undefined && k.len <= 8000 ? `varbinary(${k.len})` : 'varbinary(max)';
    case 'binmax':
      return dst === 'mysql' ? 'longblob' : dst === 'postgres' ? 'bytea' : 'varbinary(max)';
    case 'uuid':
      return dst === 'mysql' ? 'char(36)' : dst === 'postgres' ? 'uuid' : 'uniqueidentifier';
    case 'json':
      return dst === 'mysql' ? 'json' : dst === 'postgres' ? 'jsonb' : 'nvarchar(max)';
    case 'xml':
      return dst === 'mysql' ? 'longtext' : 'xml';
  }
}

/** Zeilen als INSERT … VALUES, Werte passend zum Zieltyp; begrenzt nach Zeilen und nach Größe */
class InsertSink implements RowSink {
  private head = '';
  private pending: string[] = [];
  private bytes = 0;
  private conv: ((v: ExportCell) => string)[] = [];
  private anon: (((v: ExportCell) => ExportCell) | undefined)[] = [];
  /** Spalten der Ergebnismenge, die eingefügt werden (berechnete und rowversion nicht) */
  private keep: number[] = [];

  constructor(
    private out: Out,
    private dst: Dialect,
    private target: string,
    private t: Planned,
    private perInsert: number,
    private end: string,
    private progress: DumpProgress,
    private cancelled: () => boolean,
    /** Ersatz für Personendaten je Spalte (Anonymisieren) */
    private anonFor?: (column: string) => ((v: ExportCell) => ExportCell) | undefined,
  ) {}

  async begin(columns: ResultColumn[]) {
    this.keep = columns.map((c, i) => (this.t.skip.has(c.name) ? -1 : i)).filter((i) => i >= 0);
    const kept = this.keep.map((i) => columns[i]);
    this.head = `INSERT INTO ${this.target} (${kept.map((c) => quoteIdent(this.dst, c.name)).join(', ')}) VALUES\n`;
    this.conv = kept.map((c) => {
      const i = this.t.info.columns.findIndex((x) => x.name === c.name);
      return valueConverter(this.dst, this.t.types[i] ?? '', this.t.info.columns[i]?.dataType ?? '', c.numeric);
    });
    this.anon = kept.map((c) => this.anonFor?.(c.name));
  }

  async rows(batch: ExportCell[][]) {
    if (this.cancelled()) throw new Error('Abgebrochen.');
    // SQL Server erlaubt höchstens 1000 Zeilen pro VALUES
    const per = Math.min(Math.max(1, this.perInsert), 1000);
    for (const r of batch) {
      const line = '  (' + this.keep.map((i, j) => this.conv[j](this.anon[j] ? this.anon[j]!(r[i]) : r[i])).join(', ') + ')';
      this.pending.push(line);
      this.bytes += line.length;
      if (this.pending.length >= per || this.bytes >= INSERT_BYTES) await this.flush();
    }
    this.progress.rows += batch.length;
  }

  async flush() {
    if (!this.pending.length) return;
    await this.out.write(this.head + this.pending.join(',\n') + this.end);
    this.pending = [];
    this.bytes = 0;
  }
}

/** Wert als SQL-Literal im Ziel (auch für das Abgleich-Skript des Datenvergleichs) */
export function valueConverter(dst: Dialect, dstType: string, srcType: string, numeric: boolean): (v: ExportCell) => string {
  const ty = dstType.toLowerCase();
  // Wahrheitswert nur bei echten boolean/bit-Spalten – tinyint(1) ist in MySQL eine Zahl, 2 und 5 bleiben 2 und 5
  const bool = /^(boolean|bool|bit)$/.test(ty);
  const pgArray = dst === 'postgres' && ty.endsWith('[]');
  const srcArray = dst !== 'postgres' && srcType.trim().endsWith('[]');
  // Zeitpunkt mit Zone: die Quelle liefert ihn in UTC (PostgreSQL mit +00, SQL Server ohne Zone)
  const zoned = /datetimeoffset|timestamptz|timestamp(\(\d+\))? with time zone/i.test(srcType);
  // SQL Server: 'JJJJ-MM-TT hh:mm:ss' liest ein Login mit DATEFORMAT dmy als Jahr-Tag-Monat – mit T ist es sprachneutral
  const mssqlDate = dst === 'mssql' && /date|time/i.test(ty);
  return (v) => {
    if (v === null) return 'NULL';
    if (bool) {
      const b = Buffer.isBuffer(v)
        ? v.some((x) => x !== 0)
        : typeof v === 'boolean'
          ? v
          : typeof v === 'number'
            ? v !== 0
            : /^(t|true|y|yes|on)$/i.test(v) || (/^-?\d+(\.\d+)?$/.test(v) && Number(v) !== 0);
      return dst === 'postgres' ? String(b) : b ? '1' : '0';
    }
    if (Buffer.isBuffer(v)) {
      const hex = v.toString('hex');
      // MySQL kennt 0x nur mit mindestens einer Ziffer – ein leerer Binärwert ist X''
      if (dst === 'mysql' && !v.length) return "X''";
      return dst === 'postgres' ? `'\\x${hex}'::bytea` : '0x' + hex.toUpperCase();
    }
    if (pgArray && typeof v === 'string' && v.startsWith('[')) return literal(dst, jsonToPgArray(v));
    // PostgreSQL-Array {a,b} als JSON ["a","b"] für die anderen
    if (srcArray && typeof v === 'string' && v.startsWith('{')) return literal(dst, JSON.stringify(pgArrayToJson(v)));
    if (typeof v === 'boolean') return dst === 'postgres' ? String(v) : v ? '1' : '0';
    if (zoned && typeof v === 'string' && dst !== 'postgres') {
      // MySQL kennt keine Zone im Literal (der Dump liest und schreibt in UTC); SQL Server will +hh:mm (und T, s. u.)
      const m = /([+-])(\d\d)(:?(\d\d))?$/.exec(v);
      // SQL Server liefert '… +00:00' mit Leerzeichen: das muss weg, 'T' und Leerzeichen vor der Zone zusammen lehnt der Server ab
      if (m) return literal(dst, dst === 'mysql' ? v.slice(0, m.index).trimEnd() : `${v.slice(0, m.index).trimEnd().replace(' ', 'T')}${m[1]}${m[2]}:${m[4] ?? '00'}`);
    }
    if (mssqlDate && typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return literal(dst, v.replace(' ', 'T'));
    // MySQL bit(n) und Ähnliches kommen als Zahl/Text; Zahl in Textspalte bleibt Text
    if (typeof v === 'number' && /char|text|json|xml|uuid|uniqueidentifier/.test(ty)) return literal(dst, String(v));
    return literal(dst, v, numeric || typeof v === 'number');
  };
}

/** PostgreSQL-Array-Text {a,"b c",NULL,{1,2}} → verschachteltes Array */
export function pgArrayToJson(text: string): unknown {
  let i = 0;
  const parse = (): unknown[] => {
    const out: unknown[] = [];
    i++; // {
    while (i < text.length && text[i] !== '}') {
      if (text[i] === '{') out.push(parse());
      else if (text[i] === '"') {
        let s = '';
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') i++;
          s += text[i++];
        }
        i++;
        out.push(s);
      } else {
        let s = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '}') s += text[i++];
        out.push(s === 'NULL' ? null : s);
      }
      if (text[i] === ',') i++;
    }
    i++; // }
    return out;
  };
  // Dimensionsangabe wie [1:2]={…} überspringen
  const eq = text.indexOf('={');
  if (text.startsWith('[') && eq > 0) i = eq + 1;
  return parse();
}

/** ["a","b"] → {"a","b"} */
function jsonToPgArray(json: string): string {
  try {
    const a = JSON.parse(json) as unknown;
    const enc = (x: unknown): string =>
      Array.isArray(x) ? '{' + x.map(enc).join(',') + '}' : x === null ? 'NULL' : '"' + String(typeof x === 'object' ? JSON.stringify(x) : x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return enc(a);
  } catch {
    return json;
  }
}

/** Datei bzw. Datenstrom mit Gegendruck schreiben */
class Out {
  private s: Writable;
  private file?: string;

  constructor(target: string | Writable) {
    if (typeof target === 'string') {
      this.file = target;
      this.s = createWriteStream(target, { encoding: 'utf8' });
      // Fehler zwischen zwei Schreibaufrufen (Platte voll, Laufwerk weg): ohne Empfänger stürzte der Hauptprozess ab;
      // so meldet ihn der nächste write() über s.errored
      this.s.on('error', () => undefined);
    } else this.s = target;
  }

  /** wartet, bis der Puffer wieder Platz hat; endet mit Fehler, wenn das Ziel unterwegs geschlossen wird */
  write(chunk: string): Promise<void> {
    const closed = () => this.s.errored ?? new Error('Ausgabe wurde geschlossen.');
    if (this.s.destroyed) return Promise.reject(closed());
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (e?: Error | null) => {
        if (settled) return;
        settled = true;
        this.s.off('drain', onDrain);
        this.s.off('close', onClose);
        this.s.off('error', onError);
        if (e) reject(e);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(closed());
      const onError = (e: Error) => done(e);
      this.s.once('error', onError);
      if (this.s.write(chunk, (e) => e && done(e))) done();
      else {
        this.s.once('drain', onDrain);
        this.s.once('close', onClose);
      }
    });
  }

  end(): Promise<void> {
    return new Promise((resolve, reject) => this.s.end((e?: Error | null) => (e ? reject(e) : resolve())));
  }

  /** Datei: halbe Datei löschen; Datenstrom: mit dem Fehler beenden (das Einspielen dahinter hört dann auf) */
  async abort(cause?: unknown): Promise<void> {
    if (this.file) {
      // erst zu, dann löschen: ein Strom, der die Datei noch öffnet, legte sie sonst wieder an
      await closeStream(this.s);
      await fs.rm(this.file, { force: true });
    } else if (!this.s.destroyed) this.s.destroy(cause instanceof Error ? cause : new Error('Dump abgebrochen.'));
  }
}
