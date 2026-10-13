/* Ausführungsplan: Übersetzung der Formate (feste Beispiele), aufgezeichnete Ausgaben echter Server (Dateien in
   electron/test/fixtures, ohne Datenbank) und Pläne aus den Test-Datenbanken (MySQL, MariaDB, PostgreSQL, SQL Server).
   Vorher: npm run testdb:up. Aufruf: npm run test:plan. Ohne Datenbanken (nur feste Beispiele und Aufzeichnungen, auch ohne
   Docker): node dist-electron/electron/test/plan.test.js offline */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionInput, SqlDialect, PlanNode, QueryPlan, StatementPlan } from '../../shared/api-types';
import { ConnectionStore } from '../connection-store';
import { Manager } from '../manager';
import { JObj, mssqlPlans, mysqlJsonPlan, mysqlTreePlan, parseJsonKeepKeys, postgresPlan, tidySql } from '../plan';
import { assertTestContainers } from './guard';

const root = path.resolve(__dirname, '../../..');
const fixture = (name: string) => readFileSync(path.join(root, 'electron/test/fixtures', name), 'utf8');

let failed = 0;
async function step(name: string, fn: () => Promise<unknown> | unknown) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FEHL ${name}\n       ${(e as Error).message.split('\n').join('\n       ')}`);
  }
}

function nodes(n: PlanNode | undefined): PlanNode[] {
  return n ? [n, ...n.children.flatMap(nodes)] : [];
}

function find(p: StatementPlan, test: (n: PlanNode) => boolean): PlanNode {
  const hit = nodes(p.root).find(test);
  assert.ok(hit, 'Schritt nicht gefunden in:\n' + nodes(p.root).map((n) => `${n.op} [${n.detail ?? ''}]`).join('\n'));
  return hit;
}

function shareSum(p: StatementPlan): number {
  return nodes(p.root).reduce((s, n) => s + (n.share ?? 0), 0);
}

async function unitTests() {
  console.log('\nÜbersetzung (feste Beispiele)');
  await step('JSON-Leser behält doppelte Schlüssel', () => {
    const v = parseJsonKeepKeys('{"table": {"a": 1}, "table": {"a": 2}, "s": "x\\"y\\u00e4", "n": [1.5e2, true, null]}');
    assert.ok(v instanceof JObj);
    assert.deepEqual(
      v.entries.map((e) => e[0]),
      ['table', 'table', 's', 'n'],
    );
    assert.equal(v.get('s'), 'x"yä');
    assert.deepEqual(v.get('n'), [150, true, null]);
  });

  await step('MariaDB 10.5, ANALYZE: Tabellen ohne nested_loop, Fehlschätzung, Anteile nach Zeit', () => {
    const p = mysqlJsonPlan('SELECT …', fixture('plan-mariadb105-analyze.json'), true);
    assert.equal(p.error, undefined);
    assert.equal(p.root?.op, 'Select #1');
    const nl = find(p, (n) => n.op === 'Nested loop');
    assert.deepEqual(
      nl.children.map((c) => c.detail?.split(' ')[0]),
      ['k', '<subquery3>'],
    );
    const b = find(p, (n) => /^b using fk_best_kunde/.test(n.detail ?? ''));
    assert.equal(b.loops, 400);
    assert.match(b.warnings.join(), /Schätzung zu hoch: 3.000 statt 2.5 Zeilen/);
    assert.equal(p.shareBy, 'time');
    assert.ok(Math.abs(shareSum(p) - 1) < 1e-9, String(shareSum(p)));
    assert.ok(p.executionMs && p.executionMs > 3);
  });

  await step('MariaDB 10.5, EXPLAIN: Fensterfunktion, materialisierte Unterabfrage', () => {
    const p = mysqlJsonPlan('SELECT …', fixture('plan-mariadb105-explain.json'), false);
    assert.equal(p.error, undefined);
    const w = find(p, (n) => n.op === 'Window functions');
    assert.ok(nodes(w).some((n) => n.op === 'Sort'));
    const mat = find(p, (n) => n.op === 'Materialize');
    assert.equal(mat.children[0].op, 'Select #2');
    assert.equal(p.shareBy, undefined, 'MariaDB 10.5 meldet keine Kosten');
  });

  await step('MySQL-Baum: mehrere Wurzeln, Fortsetzungszeile, nie ausgeführt, Zahlen mit Exponent', () => {
    const text = [
      "-> Filter: (t.a = 'x",
      "y')  (cost=10 rows=2) (actual time=0.1..2e-1 rows=50 loops=2)",
      '    -> Table scan on t  (cost=10 rows=20000) (actual time=0.05..0.15 rows=20000 loops=2)',
      '-> Select #2 (subquery in condition; dependent)',
      '    -> Limit: 1 row(s)  (cost=0.5..0.5 rows=1) (never executed)',
      '',
    ].join('\n');
    const p = mysqlTreePlan('SELECT …', text, true);
    assert.equal(p.root?.op, 'Abfrage');
    assert.equal(p.root?.children.length, 2);
    const f = p.root!.children[0];
    assert.equal(f.op, 'Filter');
    assert.equal(f.detail, "(t.a = 'x\ny')");
    assert.equal(f.actualRows, 50);
    assert.equal(f.loops, 2);
    assert.ok(Math.abs((f.timeMs ?? 0) - 0.4) < 1e-9);
    assert.match(f.warnings.join(), /Schätzung zu niedrig: 2 statt 50 Zeilen \(17×\)/);
    const scan = f.children[0];
    assert.equal(scan.op, 'Table scan');
    assert.match(scan.warnings.join(), /Liest die ganze Tabelle \(20.000 Zeilen\)/);
    const limit = p.root!.children[1].children[0];
    assert.equal(limit.loops, 0);
    assert.match(limit.detail ?? '', /nie ausgeführt/);
    assert.equal(p.shareBy, 'time');
  });

  await step('PostgreSQL: innere Seite der Nested Loop zählt je Durchlauf; Sortieren auf Platte', () => {
    const scan = (rel: string, cost: number, rows: number, extra: Record<string, unknown> = {}) => ({
      'Node Type': 'Seq Scan',
      'Relation Name': rel,
      Alias: rel,
      'Total Cost': cost,
      'Plan Rows': rows,
      ...extra,
    });
    const json = [
      {
        Plan: {
          'Node Type': 'Sort',
          'Total Cost': 1100,
          'Plan Rows': 100,
          'Sort Key': ['a.x'],
          'Sort Method': 'external merge',
          'Sort Space Type': 'Disk',
          'Sort Space Used': 1234,
          'Actual Total Time': 5,
          'Actual Rows': 100,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Nested Loop',
              'Join Type': 'Inner',
              'Parent Relationship': 'Outer',
              'Total Cost': 1010,
              'Plan Rows': 100,
              Plans: [
                scan('a', 10, 100, { 'Parent Relationship': 'Outer' }),
                { 'Node Type': 'Index Scan', 'Parent Relationship': 'Inner', 'Index Name': 'b_pkey', 'Relation Name': 'b', Alias: 'b', 'Total Cost': 9.9, 'Plan Rows': 1, 'Index Cond': '(id = a.b_id)' },
              ],
            },
          ],
        },
        'Planning Time': 0.5,
        'Execution Time': 5.5,
      },
    ];
    const est = postgresPlan('SELECT …', json, false);
    const inner = find(est, (n) => n.op === 'Index Scan');
    assert.equal(inner.detail, 'using b_pkey on b · (id = a.b_id)');
    assert.ok((inner.share ?? 0) > 0.85, String(inner.share));
    const analyzed = postgresPlan('SELECT …', json, true);
    assert.match(analyzed.root!.warnings.join(), /Sortiert auf der Platte \(1234 kB\)/);
    assert.equal(analyzed.executionMs, 5.5);
  });

  await step('SQL Server: Prüfung herausgefiltert, fehlender Index, Warnung, Laufzeit über Threads', () => {
    const xml = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564"><BatchSequence><Batch><Statements>
<StmtCond StatementText="IF UPPER(ISNULL(CAST(SESSION_CONTEXT(N&apos;k&apos;) AS nvarchar(64)), &apos;&apos;)) &lt;&gt; &apos;TOKEN123&apos;" StatementType="COND"><Condition /><Then><Statements><StmtSimple StatementText=" THROW 51999, N&apos;x&apos;, 1;" /></Statements></Then></StmtCond>
<StmtSimple StatementText="SELECT b FROM t WHERE a = @p&#xa;" StatementType="SELECT" StatementSubTreeCost="1.5">
<QueryPlan CompileTime="3"><MissingIndexes><MissingIndexGroup Impact="88.5"><MissingIndex Database="[db]" Schema="[dbo]" Table="[t]"><ColumnGroup Usage="EQUALITY"><Column Name="[a]" ColumnId="1" /></ColumnGroup><ColumnGroup Usage="INCLUDE"><Column Name="[b]" ColumnId="2" /></ColumnGroup></MissingIndex></MissingIndexGroup></MissingIndexes>
<QueryTimeStats ElapsedTime="42" CpuTime="40" />
<RelOp NodeId="0" PhysicalOp="Parallelism" LogicalOp="Gather Streams" EstimateRows="10" EstimatedTotalSubtreeCost="1.5">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="20" ActualExecutions="1" ActualElapsedms="42" /></RunTimeInformation>
<Parallelism><RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="10" EstimatedRowsRead="50000" EstimatedTotalSubtreeCost="1.4">
<Warnings><PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(10),[db].[dbo].[t].[a],0)=[@p]" /></Warnings>
<RunTimeInformation><RunTimeCountersPerThread Thread="1" ActualRows="12" ActualExecutions="1" ActualElapsedms="30" ActualRowsRead="25000" /><RunTimeCountersPerThread Thread="2" ActualRows="8" ActualExecutions="1" ActualElapsedms="35" ActualRowsRead="25000" /></RunTimeInformation>
<IndexScan><Object Database="[db]" Schema="[dbo]" Table="[t]" Index="[pk_t]" Alias="[x]" /><Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(nvarchar(10),[db].[dbo].[t].[a] as [x].[a],0)=[@p]" /></Predicate></IndexScan>
</RelOp></Parallelism></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const plans = mssqlPlans([xml], true, (t) => t.includes('TOKEN123'));
    assert.equal(plans.length, 1);
    const p = plans[0];
    assert.equal(p.sql, 'SELECT b FROM t WHERE a = @p');
    assert.equal(p.executionMs, 42);
    assert.equal(p.planningMs, 3);
    assert.match(p.notes.join(), /Fehlender Index \(laut SQL Server 88.5 % günstiger\): CREATE NONCLUSTERED INDEX \[IX_t_a\] ON \[dbo\]\.\[t\] \(\[a\]\) INCLUDE \(\[b\]\)/);
    const scan = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.equal(scan.detail, 't x (pk_t) · Filter: CONVERT_IMPLICIT(nvarchar(10),x.a,0)=@p');
    assert.equal(scan.actualRows, 20, 'Threads zusammen: 12 + 8');
    assert.equal(scan.loops, 1);
    assert.equal(scan.timeMs, 35, 'parallele Threads: die längste Zeit');
    assert.match(scan.warnings.join(), /Implizite Umwandlung .* verhindert die Index-Suche/);
    assert.match(scan.warnings.join(), /Liest die ganze Tabelle \(50.000 Zeilen\)/);
    assert.equal(p.root?.op, 'Parallelism (Gather Streams)');
    assert.match(p.raw ?? '', /^<ShowPlanXML/);
    assert.match(p.raw ?? '', /\n {2}<BatchSequence>/);
    assert.doesNotMatch(p.raw ?? '', /TOKEN123|THROW/, 'Prüfung nicht in der Rohausgabe');
  });

  await step('SQL-Server-Ausdrücke kürzen', () => {
    assert.equal(tidySql('[db].[dbo].[t].[c] as [x].[c]=[db].[dbo].[u].[d]'), 'x.c=u.d');
    assert.equal(tidySql('[Expr1002]+[my col]'), 'Expr1002+[my col]');
  });
}

/* ---------------------------------------------------------------- aufgezeichnete Ausgaben ---- */

/*
 * Echte Ausgaben der Test-Server als Dateien in electron/test/fixtures (plan-<server><version>-<fall>.<json|txt|xml>):
 * PostgreSQL 17.11, MySQL 8.4.11, MariaDB 11.8.9, SQL Server 2022 (CU27). Aufgezeichnet in der Datenbank plan_fx, mit denselben
 * Anweisungen wie die Treiber (PostgreSQL: EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) bzw. EXPLAIN (FORMAT JSON); MySQL: EXPLAIN
 * ANALYZE / EXPLAIN FORMAT=TREE / FORMAT=JSON; MariaDB: ANALYZE / EXPLAIN FORMAT=JSON; SQL Server: SET STATISTICS XML ON bzw.
 * SET SHOWPLAN_XML ON; MySQL-Format 2: SET explain_json_format_version = 2). Die Tabellen (auf allen vier Servern gleich):
 *   fx_kunden      20 000 Zeilen: id 1…20000 (Primärschlüssel), ort = Bern, Basel, Zürich, Luzern nach 1 + id % 4, aktiv = id > 300;
 *                  Index ix_fx_ort auf ort
 *   fx_bestellungen 200 000 Zeilen: id (Primärschlüssel), kunde_id = 1 + id % 20000 (Index ix_fx_kunde), status = offen, bezahlt,
 *                  storniert nach 1 + id % 3 (ohne Index), betrag = 10 + id % 97
 *   fx_orte        4 Zeilen: name (Primärschlüssel; Bern, Basel, Zürich, Luzern), kanton
 * Danach ANALYZE bzw. UPDATE STATISTICS. Parallele Pläne in PostgreSQL mit parallel_setup_cost = 0, parallel_tuple_cost = 0,
 * min_parallel_table_scan_size = 0 und max_parallel_workers_per_gather = 2, sonst ohne Parallelität; Merge Join/Memoize mit
 * enable_hashjoin = off (und enable_nestloop = off bzw. enable_mergejoin = off); Sortieren auf der Platte und Hash in Teilen mit
 * work_mem = 64kB. SQL Server: der parallele Plan mit OPTION (LOOP JOIN, USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE')) auf einem
 * Container mit 22 Schedulern (DegreeOfParallelism 22).
 * Weitere Fälle: Gather mit weniger gestarteten als geplanten Workern (SET max_parallel_workers = 1); UPDATE auf fx_notiz mit
 * Trigger (nur PostgreSQL, in BEGIN … ROLLBACK aufgezeichnet); SQL Server ohne Zeilenziel (OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))):
 * mit Zeilenziel schätzt er bei TOP und EXISTS schon die wenigen gelesenen Zeilen, ohne die Zeilen der ganzen Tabelle – so zeigt
 * sich F284; Adaptive Join über LEFT JOIN auf die leere Columnstore-Tabelle fx_cs (erzwingt den Batch-Modus); DOP 2 mit OPTION (MAXDOP 2 …).
 * Aufbau am Beispiel PostgreSQL (die anderen Server entsprechend, Zahlenreihen aus einer Kreuzung kleiner Tabellen):
 *   CREATE TABLE fx_kunden (id int PRIMARY KEY, ort varchar(20) NOT NULL, aktiv boolean NOT NULL);  CREATE INDEX ix_fx_ort ON fx_kunden (ort);
 *   CREATE TABLE fx_bestellungen (id int PRIMARY KEY, kunde_id int NOT NULL, status varchar(10) NOT NULL, betrag numeric(10,2) NOT NULL);
 *   CREATE INDEX ix_fx_kunde ON fx_bestellungen (kunde_id);  CREATE TABLE fx_orte (name varchar(20) PRIMARY KEY, kanton char(2) NOT NULL);
 *   INSERT INTO fx_kunden SELECT n, (ARRAY['Bern','Basel','Zürich','Luzern'])[1 + n % 4], n > 300 FROM generate_series(1, 20000) n;
 *   INSERT INTO fx_bestellungen SELECT n, 1 + n % 20000, (ARRAY['offen','bezahlt','storniert'])[1 + n % 3], 10 + n % 97 FROM generate_series(1, 200000) n;
 *   INSERT INTO fx_orte VALUES ('Basel','BS'), ('Bern','BE'), ('Luzern','LU'), ('Zürich','ZH');
 *   CREATE TABLE fx_notiz (id int PRIMARY KEY, text text NOT NULL);  CREATE TABLE fx_notiz_log (nr serial PRIMARY KEY, notiz_id int NOT NULL, alt text, neu text);
 *   CREATE FUNCTION fx_notiz_protokoll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO fx_notiz_log (notiz_id, alt, neu) VALUES (NEW.id, OLD.text, NEW.text); RETURN NEW; END $$;
 *   CREATE TRIGGER fx_notiz_aenderung AFTER UPDATE ON fx_notiz FOR EACH ROW EXECUTE FUNCTION fx_notiz_protokoll();
 *   INSERT INTO fx_notiz SELECT n, 'Notiz ' || n FROM generate_series(1, 2000) n;  ANALYZE;
 * SQL Server: fx_cs = CREATE TABLE fx_cs (id int NOT NULL) mit CREATE CLUSTERED COLUMNSTORE INDEX cci_fx_cs ON fx_cs. Aufgezeichnet mit
 * den Treibern der App (pg, mysql2, mssql: batch mit SET STATISTICS XML ON) und unverändert gespeichert.
 * Erwartet wird, was die Datei hergibt: die Zahlen unten stehen so in den Dateien (Zeiten in ms), Anteile sind aus den Zahlen
 * der Datei gerechnet. Einige Schritte verändern die Ausgabe vor dem Lesen (z. B. Merge Join → Hash Join) als Gegenprobe: so
 * zeigt sich, dass eine Regel wirklich greift – dieselben Zahlen wären sonst eine Fehlschätzung.
 */
const FX = {
  gather: "SELECT count(*) AS n, sum(betrag) AS summe FROM fx_bestellungen WHERE status = 'storniert'",
  gatherCount: "SELECT count(*) AS n FROM fx_bestellungen WHERE status = 'storniert'",
  gatherMerge: 'SELECT id, betrag FROM fx_bestellungen WHERE betrag > 100 ORDER BY betrag, id',
  gatherJoin:
    "SELECT k.ort, count(*) AS n, sum(b.betrag) AS summe FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id WHERE b.status = 'offen' GROUP BY k.ort ORDER BY summe DESC",
  cte: 'WITH o AS MATERIALIZED (SELECT kunde_id, sum(betrag) AS s FROM fx_bestellungen GROUP BY kunde_id) SELECT k.ort, sum(o.s) AS summe FROM fx_kunden k JOIN o ON o.kunde_id = k.id GROUP BY k.ort ORDER BY summe DESC',
  notIn: "SELECT count(*) AS n FROM fx_kunden WHERE id NOT IN (SELECT kunde_id FROM fx_bestellungen WHERE status = 'storniert' AND betrag > 100)",
  subplan: 'SELECT k.id, (SELECT max(b.betrag) FROM fx_bestellungen b WHERE b.kunde_id = k.id) AS groesste FROM fx_kunden k WHERE k.id <= 500',
  limit: "SELECT id, betrag FROM fx_bestellungen WHERE status = 'storniert' LIMIT 10",
  lowEstimate: 'SELECT count(*) AS n FROM fx_bestellungen WHERE id % 7 = 3',
  lowEstimateLimit: 'SELECT id, betrag FROM fx_bestellungen WHERE id % 7 = 3 LIMIT 50000',
  sortDisk: 'SELECT id, betrag FROM fx_bestellungen ORDER BY betrag, id',
  hashBatches: 'SELECT count(*) AS n FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id',
  mergeJoin: 'SELECT count(*) AS n FROM fx_kunden k JOIN fx_bestellungen b ON b.kunde_id = k.id WHERE NOT k.aktiv',
  semiJoin: 'SELECT count(*) AS n FROM fx_orte o WHERE EXISTS (SELECT 1 FROM fx_kunden k WHERE k.ort = o.name)',
  incSort: 'SELECT id, kunde_id, betrag FROM fx_bestellungen ORDER BY kunde_id, betrag LIMIT 1000',
  incSortAll: 'SELECT id, kunde_id, betrag FROM fx_bestellungen ORDER BY kunde_id, betrag',
  memoize: 'SELECT count(*) AS n, count(o.kanton) AS mit_kanton FROM fx_kunden k LEFT JOIN fx_orte o ON o.name = k.ort',
  join: "SELECT k.ort, COUNT(*) AS n, SUM(b.betrag) AS summe FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id WHERE b.status = 'offen' GROUP BY k.ort ORDER BY summe DESC",
  mysqlSubquery: 'SELECT k.id, (SELECT MAX(b.betrag) FROM fx_bestellungen b WHERE b.kunde_id = k.id) AS groesste FROM fx_kunden k WHERE k.id <= 500',
  mysqlIn: "SELECT COUNT(*) AS n FROM fx_kunden WHERE id IN (SELECT kunde_id FROM fx_bestellungen WHERE status = 'storniert' AND betrag > 100)",
  mysqlDerived:
    'SELECT k.ort, SUM(o.s) AS summe FROM fx_kunden k JOIN (SELECT kunde_id, SUM(betrag) AS s FROM fx_bestellungen GROUP BY kunde_id) o ON o.kunde_id = k.id GROUP BY k.ort ORDER BY summe DESC',
  mysqlUpdate: "UPDATE fx_kunden SET ort = 'Genf' WHERE id = 7",
  mssqlJoin:
    "SELECT k.ort, COUNT(*) AS n, SUM(b.betrag) AS summe FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id WHERE b.status = N'offen' GROUP BY k.ort ORDER BY summe DESC",
  mssqlParallel:
    "SELECT k.ort, COUNT(*) AS n, SUM(b.betrag) AS summe FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id WHERE b.status = N'offen' GROUP BY k.ort ORDER BY summe DESC OPTION (LOOP JOIN, USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE'))",
  mssqlBatch: 'SELECT COUNT(*) AS n FROM fx_kunden\nSELECT MAX(betrag) AS groesste FROM fx_bestellungen',
  cteTwice:
    'WITH o AS MATERIALIZED (SELECT kunde_id, sum(betrag) AS s FROM fx_bestellungen GROUP BY kunde_id) SELECT count(*) AS n, sum(a.s + b.s) AS summe FROM o a JOIN o b ON b.kunde_id = a.kunde_id',
  nlMaterialize: 'SELECT count(*) AS n FROM fx_kunden k JOIN fx_orte o ON o.kanton <> k.ort WHERE k.id <= 500',
  trigger: "UPDATE fx_notiz SET text = text || '!' WHERE id <= 1000",
  mssqlTop: "SELECT TOP 10 id, betrag FROM fx_bestellungen WHERE status = N'storniert' OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))",
  mssqlExists:
    "SELECT COUNT(*) AS n FROM fx_orte o WHERE EXISTS (SELECT 1 FROM fx_kunden k WHERE k.ort = o.name) OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))",
  mssqlMerge: 'SELECT COUNT(*) AS n FROM fx_kunden k JOIN fx_bestellungen b ON b.kunde_id = k.id WHERE k.aktiv = 0 OPTION (MERGE JOIN)',
  mssqlAdaptive: 'SELECT k.ort, COUNT(*) AS n FROM fx_bestellungen b JOIN fx_kunden k ON k.id = b.kunde_id LEFT JOIN fx_cs c ON 1 = 0 WHERE b.betrag > 100 GROUP BY k.ort',
  mssqlDop2:
    "SELECT k.ort, COUNT(*) AS n, SUM(b.betrag) AS summe FROM fx_kunden k JOIN fx_bestellungen b ON b.kunde_id = k.id WHERE k.id <= 40 GROUP BY k.ort OPTION (LOOP JOIN, MAXDOP 2, USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE'))",
};

/** Zahl innerhalb der Toleranz */
function near(actual: number | undefined, expected: number, tol = 1e-6, what = ''): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tol, `${what} erwartet ${expected}, ist ${actual}`);
}

const warn = (n: PlanNode) => n.warnings.join(' | ');

/** Schritte mit einem Hinweis auf eine Fehlschätzung („Schätzung zu hoch/niedrig“) */
function misestimated(p: StatementPlan): string[] {
  return nodes(p.root)
    .filter((n) => n.warnings.some((w) => w.startsWith('Schätzung')))
    .map((n) => n.op);
}

/** Summe der eigenen Zeiten (selfMs) – jede Millisekunde nur einmal gezählt */
function selfSum(p: StatementPlan): number {
  return nodes(p.root).reduce((s, n) => s + (n.selfMs ?? 0), 0);
}

/** Anteile nach Zeit bzw. Kosten, zusammen 1 (das ist nach der Rechnung immer so: nur eine Plausibilitätsprobe – die Werte prüft jeder Schritt einzeln) */
function shares(p: StatementPlan, by: 'time' | 'cost'): void {
  assert.equal(p.shareBy, by);
  near(shareSum(p), 1, 1e-6, 'Summe der Anteile');
}

/** keine Zeit eines Schritts ist negativ (Abzüge werden bei 0 gekappt) */
function noNegative(p: StatementPlan): void {
  for (const n of nodes(p.root)) {
    assert.ok((n.timeMs ?? 0) >= 0 && (n.selfMs ?? 0) >= 0, `${n.op}: Zeit ${n.timeMs}, eigene Zeit ${n.selfMs}`);
  }
}

/** Kein Schritt braucht laut Plan länger als der Schritt darüber (mit den Schritten darunter gerechnet) */
function timesNest(p: StatementPlan): void {
  for (const n of nodes(p.root)) {
    for (const c of n.children) {
      if (c.timeMs !== undefined && n.timeMs !== undefined) assert.ok(c.timeMs <= n.timeMs + 1e-9, `${c.op}: ${c.timeMs} ms > ${n.op}: ${n.timeMs} ms`);
    }
  }
}

/** Ausgabe mit einer Ersetzung – schlägt fehl, wenn sie nichts ändert (die Vorlage hätte sich dann geändert) */
function swapped(text: string, from: string | RegExp, to: string): string {
  const r = text.replace(from, to);
  assert.notEqual(r, text, `„${from}“ kommt in der Ausgabe nicht vor`);
  return r;
}

const pgFx = (name: string, sql: string, analyzed: boolean) => postgresPlan(sql, JSON.parse(fixture(`plan-postgres17-${name}.json`)), analyzed);
const treeFx = (name: string, sql: string, analyzed: boolean) => mysqlTreePlan(sql, fixture(`plan-mysql8-tree-${name}.txt`), analyzed);

async function recordedTests() {
  console.log('\nAufgezeichnete Ausgaben (echte Server)');

  /* ---------------------------------------------------------- PostgreSQL ---- */

  await step('F296: PostgreSQL Gather (2 Worker): Zeit der Teilnehmer durch 3 geteilt, nicht mal Loops (F164)', () => {
    const p = pgFx('gather', FX.gather, true);
    assert.equal(p.error, undefined);
    assert.equal(p.root?.op, 'Finalize Aggregate');
    near(p.executionMs, 79.099);
    near(p.planningMs, 7.673);
    const gather = find(p, (n) => n.op === 'Gather');
    assert.equal(gather.loops, 1);
    assert.equal(gather.actualRows, 3);
    assert.ok(gather.props.some(([k, v]) => k === 'Workers Launched' && v === '2'));
    near(gather.timeMs, 78.234);
    const partial = find(p, (n) => n.op === 'Partial Aggregate');
    const scan = find(p, (n) => n.op === 'Parallel Seq Scan');
    assert.equal(partial.loops, 3, 'Teilnehmer: 2 Worker und der Leader');
    assert.equal(scan.loops, 3);
    assert.equal(scan.actualRows, 22222, 'je Teilnehmer gemittelt');
    near(partial.timeMs, 18.1, 1e-6, '18,1 ms je Teilnehmer, nicht 54,3 (Summe der CPU-Zeiten)');
    near(scan.timeMs, 13.069, 1e-6, '13,069 ms, nicht 39,207');
    near(partial.selfMs, 18.1 - 13.069);
    near(gather.selfMs, 78.234 - 18.1, 1e-6, 'Rest bei Gather: Anlauf der Worker');
    assert.ok(scan.timeMs! <= partial.timeMs! && partial.timeMs! <= gather.timeMs!, 'Kind-Zeit höchstens so groß wie die von Gather');
    timesNest(p);
    shares(p, 'time');
    near(gather.share, (78.234 - 18.1) / 78.263, 1e-9);
    assert.deepEqual(misestimated(p), []);
    assert.match(warn(scan), /Liest die ganze Tabelle \(199\W998 Zeilen\)/, '(22 222 + 44 444 verworfene) × 3 Teilnehmer');
  });

  await step('F296: PostgreSQL Gather Merge mit Sort darunter: Sort-Zeit 21,662 ms statt der Summe aller Teilnehmer (F164)', () => {
    const p = pgFx('gathermerge', FX.gatherMerge, true);
    assert.equal(p.root?.op, 'Gather Merge');
    near(p.root?.timeMs, 78.095);
    assert.equal(p.root?.actualRows, 12366);
    const sort = find(p, (n) => n.op === 'Sort');
    const scan = find(p, (n) => n.op === 'Parallel Seq Scan');
    assert.equal(sort.detail, 'betrag, id');
    assert.equal(sort.loops, 3);
    near(sort.timeMs, 21.662, 1e-6, 'nicht 3 × 21,662');
    near(sort.selfMs, 21.662 - 13.592);
    near(scan.timeMs, 13.592);
    near(p.root?.selfMs, 78.095 - 21.662);
    timesNest(p);
    shares(p, 'time');
    near(p.root?.share, (78.095 - 21.662) / 78.095, 1e-9);
    assert.deepEqual(misestimated(p), [], 'Sort: 5 114 geschätzt, 4 122 tatsächlich');
    assert.equal(sort.warnings.length, 0, 'sortiert im Speicher');
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W001 Zeilen\)/);
  });

  await step('F296: PostgreSQL Gather mit 2 geplanten, aber nur 1 gestarteten Worker: Teilnehmer = 2, Zeit durch 2 geteilt, nicht durch 3 (F164)', () => {
    const p = pgFx('gather-fewer', FX.gather, true);
    assert.equal(p.error, undefined);
    const gather = find(p, (n) => n.op === 'Gather');
    assert.ok(gather.props.some(([k, v]) => k === 'Workers Planned' && v === '2'));
    assert.ok(gather.props.some(([k, v]) => k === 'Workers Launched' && v === '1'));
    const partial = find(p, (n) => n.op === 'Partial Aggregate');
    const scan = find(p, (n) => n.op === 'Parallel Seq Scan');
    assert.equal(partial.loops, 2, 'Teilnehmer: 1 Worker und der Leader');
    assert.equal(scan.loops, 2);
    assert.equal(scan.actualRows, 33334, 'je Teilnehmer gemittelt');
    // 9,561 ms × 2 Loops / 2 Teilnehmer; mit den geplanten Workern (÷ 3) kämen 6,374 ms heraus
    near(partial.timeMs, 9.561, 1e-6);
    near(scan.timeMs, 6.506, 1e-6);
    near(gather.timeMs, 14.935);
    near(gather.selfMs, 14.935 - 9.561, 1e-6);
    near(partial.selfMs, 9.561 - 6.506, 1e-6);
    near(p.root?.timeMs, 14.946);
    near(selfSum(p), 14.946, 1e-6, 'jede Millisekunde nur einmal');
    timesNest(p);
    shares(p, 'time');
    near(scan.share, 6.506 / 14.946, 1e-9);
    near(gather.share, (14.935 - 9.561) / 14.946, 1e-9);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/, '(33 334 + verworfene) × 2 Teilnehmer');
    assert.deepEqual(misestimated(p), [], 'Parallel Seq Scan: 27 650 geschätzt, 33 334 tatsächlich');
  });

  await step('F296: PostgreSQL Parallel Hash Join unter Gather Merge: alle Zeiten darunter höchstens so groß wie die von Gather Merge', () => {
    const p = pgFx('gather-join', FX.gatherJoin, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Sort', 'Finalize GroupAggregate', 'Gather Merge', 'Sort', 'Partial HashAggregate', 'Parallel Hash Join', 'Parallel Seq Scan', 'Parallel Hash', 'Parallel Seq Scan'],
    );
    const gm = find(p, (n) => n.op === 'Gather Merge');
    near(gm.timeMs, 68.821);
    for (const n of nodes(gm).slice(1)) assert.ok(n.timeMs! <= gm.timeMs!, `${n.op}: ${n.timeMs} ms > ${gm.timeMs} ms`);
    const sort = gm.children[0];
    near(sort.timeMs, 23.978);
    near(find(p, (n) => n.op === 'Parallel Hash Join').timeMs, 17.418);
    near(gm.selfMs, 68.821 - 23.978);
    const big = find(p, (n) => n.op === 'Parallel Seq Scan' && /fx_bestellungen/.test(n.detail ?? ''));
    assert.equal(big.loops, 3);
    near(big.timeMs, 7.861);
    const small = find(p, (n) => n.op === 'Parallel Seq Scan' && /fx_kunden/.test(n.detail ?? ''));
    assert.equal(small.loops, 1, 'hier hat nur ein Teilnehmer die kleine Tabelle gelesen');
    assert.equal(small.actualRows, 20000);
    // 2,167 ms hat dieser eine Teilnehmer gebraucht; die Zeit des Hash darüber (2,538 ms) ist der Mittelwert der drei Teilnehmer.
    // Wie der Scan darunter angerechnet wird (Mittel je Teilnehmer), ist Sache des Modells und wird nicht festgeschrieben –
    // verlangt wird nur: nicht mehr als die 2,167 ms des einen Teilnehmers und nicht mehr als der Hash darüber
    assert.ok(small.timeMs! > 0 && small.timeMs! <= 2.167 + 1e-9, String(small.timeMs));
    const hash = find(p, (n) => n.op === 'Parallel Hash');
    near(hash.timeMs, 2.538);
    assert.ok(hash.selfMs! >= 0 && hash.selfMs! <= 2.538, String(hash.selfMs));
    timesNest(p);
    shares(p, 'time');
    near(selfSum(p), p.root!.timeMs!, 1e-6, 'jede Millisekunde nur einmal');
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL CTE: Zeit nur einmal (InitPlan), Hash Join darüber behält nur seine eigene (F165)', () => {
    const p = pgFx('cte', FX.cte, true);
    assert.equal(p.root?.op, 'Sort');
    assert.equal(p.root?.children.length, 2);
    const init = p.root!.children[0];
    assert.equal(init.op, 'HashAggregate');
    assert.match(init.detail ?? '', /^CTE o · /);
    near(init.timeMs, 106.819);
    near(init.selfMs, 106.819 - 18.935);
    const cteScan = find(p, (n) => n.op === 'CTE Scan');
    near(cteScan.timeMs, 111.843 - 106.819, 1e-6, 'CTE Scan ohne die Ausführung der CTE');
    near(cteScan.selfMs, 5.024);
    const join = find(p, (n) => n.op === 'Hash Join');
    near(join.timeMs, 128.968 - 106.819, 1e-6, 'auch der Hash Join darüber ohne die CTE');
    near(join.selfMs, 128.968 - 111.843 - 7.244, 1e-6, '9,881 ms eigene Zeit, nicht 116,7');
    const agg = p.root!.children[1];
    assert.equal(agg.op, 'HashAggregate');
    near(agg.selfMs, 133.955 - 128.968);
    near(p.root?.selfMs, 134.427 - 106.819 - (133.955 - 106.819));
    near(selfSum(p), 134.427, 1e-6, 'Summe der eigenen Zeiten = Zeit der Wurzel: nichts doppelt');
    shares(p, 'time');
    const top = nodes(p.root).reduce((a, b) => ((b.share ?? 0) > (a.share ?? 0) ? b : a));
    assert.equal(top, init, 'die Aggregation der CTE ist der größte Posten');
    near(init.share, (106.819 - 18.935) / 134.427, 1e-9);
    assert.match(warn(find(p, (n) => n.op === 'Seq Scan' && /fx_bestellungen/.test(n.detail ?? ''))), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL CTE, zweimal gelesen (Merge Join): nur der erste CTE Scan verliert die Zeit der CTE, der zweite behält seine (F165)', () => {
    const p = pgFx('cte-twice', FX.cteTwice, true);
    assert.equal(p.error, undefined);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'HashAggregate', 'Seq Scan', 'Merge Join', 'Sort', 'CTE Scan', 'Sort', 'CTE Scan'],
    );
    const [first, second] = nodes(p.root).filter((n) => n.op === 'CTE Scan');
    assert.equal(first.detail, 'on o a');
    assert.equal(second.detail, 'on o b');
    const init = find(p, (n) => n.op === 'HashAggregate');
    near(init.timeMs, 64.999);
    // der erste Scan (äußere Seite des Merge Join, wird zuerst sortiert) führte die CTE aus: 69,536 ms mit den 64,999 ms der CTE
    near(first.timeMs, 69.536 - 64.999, 1e-6);
    near(second.timeMs, 1.29, 1e-9, 'der zweite liest nur die gespeicherten Zeilen: seine Zeit bleibt');
    // die Schritte dazwischen bis zum Elternknoten des InitPlans verlieren die CTE-Zeit ebenfalls
    const [sortA, sortB] = nodes(p.root).filter((n) => n.op === 'Sort');
    near(sortA.timeMs, 75.727 - 64.999, 1e-6);
    near(sortB.timeMs, 6.645);
    near(find(p, (n) => n.op === 'Merge Join').timeMs, 86.951 - 64.999, 1e-6);
    near(p.root?.timeMs, 89.854);
    noNegative(p);
    timesNest(p);
    near(selfSum(p), 89.854, 1e-6, 'Summe der eigenen Zeiten = Zeit der Wurzel: die CTE zählt einmal');
    shares(p, 'time');
    near(init.share, (64.999 - 13.021) / 89.854, 1e-9);
    near(first.share, (69.536 - 64.999) / 89.854, 1e-9);
    near(second.share, 1.29 / 89.854, 1e-9);
    // der Merge Join selbst schätzt 2 011 817 Zeilen und liefert 20 000: die Warnung steht bei ihm (unter ihm wäre sie unterdrückt)
    assert.deepEqual(misestimated(p), ['Merge Join']);
  });

  await step('F296: PostgreSQL CTE, zweimal gelesen (Hash Join): die CTE läuft im zweiten Scan weiter – Grenze von F165: keine negativen Zeiten, Summe nahe der Wurzel', () => {
    const p = pgFx('cte-twice-hash', FX.cteTwice, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'HashAggregate', 'Seq Scan', 'Hash Join', 'CTE Scan', 'Hash', 'CTE Scan'],
    );
    const [first, second] = nodes(p.root).filter((n) => n.op === 'CTE Scan');
    // Datei: die CTE (56,458 ms) lief im ersten Scan (51,75 ms); beim Aufbau des Hash holte der zweite die restlichen Zeilen aus
    // ihr (10,252 ms). Die Zeit der CTE lässt sich so nicht genau auf die beiden Scans verteilen: der Abzug wird bei 0 gekappt
    assert.ok(first.timeMs! <= 51.75 + 1e-9, String(first.timeMs));
    near(second.timeMs, 10.252, 1e-9, 'der zweite Scan behält seine Zeit');
    noNegative(p);
    near(p.root?.timeMs, 71.121);
    assert.ok(Math.abs(selfSum(p) - 71.121) < 0.05 * 71.121, `Summe der eigenen Zeiten ${selfSum(p)} ms statt 71,121 ms`);
    shares(p, 'time');
    near(find(p, (n) => n.op === 'HashAggregate').timeMs, 56.458);
  });

  await step('F296: PostgreSQL hashed SubPlan (NOT IN): läuft einmal, Zeit und Zeilen des Elternknotens bleiben stimmig (F166)', () => {
    const p = pgFx('subplan-hashed', FX.notIn, true);
    assert.equal(p.root?.op, 'Aggregate');
    const scan = find(p, (n) => n.op === 'Seq Scan' && /fx_kunden/.test(n.detail ?? ''));
    assert.match(scan.detail ?? '', /hashed SubPlan 1/);
    const sub = find(p, (n) => /^SubPlan 1/.test(n.detail ?? ''));
    assert.equal(sub.loops, 1);
    assert.equal(sub.actualRows, 4122);
    // 20 000 Zeilen gelesen, 4 122 davon verworfen; die Unterabfrage lief nur einmal und steckt in den 31,772 ms des Scan
    assert.equal(scan.actualRows, 15878);
    near(sub.timeMs, 25.308);
    near(scan.timeMs, 31.772);
    near(scan.selfMs, 31.772 - 25.308);
    near(p.root?.selfMs, 32.918 - 31.772);
    shares(p, 'time');
    near(sub.share, 25.308 / 32.918, 1e-9);
    assert.deepEqual(misestimated(p), [], 'Seq Scan: 10 000 geschätzt, 15 878 tatsächlich');
  });

  await step('F296: PostgreSQL hashed SubPlan ohne ANALYZE: Anteil nach Kosten, Unterabfrage einmal gerechnet (nicht je Zeile) (F166)', () => {
    const p = pgFx('explain-subplan-hashed', FX.notIn, false);
    shares(p, 'cost');
    assert.equal(p.root?.timeMs, undefined);
    const sub = find(p, (n) => /^SubPlan 1/.test(n.detail ?? ''));
    near(p.totalCost, 4668.19);
    // 10 000 Zeilen × Kosten der Unterabfrage hätten sie auf über 99,99 % gehoben; so: 4 274 von 4 668,19 (91,6 %)
    near(sub.share, 4274 / 4668.19, 1e-9);
    near(find(p, (n) => n.op === 'Seq Scan' && /fx_kunden/.test(n.detail ?? '')).share, (4643.18 - 4274) / 4668.19, 1e-9);
    near(p.root?.share, (4668.19 - 4643.18) / 4668.19, 1e-9);
  });

  await step('F296: PostgreSQL normaler SubPlan (korrelierte Unterabfrage): läuft je Zeile, 500 Durchläufe', () => {
    const p = pgFx('subplan', FX.subplan, true);
    const root = p.root!;
    assert.equal(root.op, 'Index Only Scan');
    assert.equal(root.actualRows, 500);
    const agg = root.children[0];
    assert.equal(agg.op, 'Aggregate');
    assert.equal(agg.detail, 'SubPlan 1');
    assert.equal(agg.loops, 500);
    near(agg.timeMs, 11.5, 1e-6, '0,023 ms × 500');
    near(find(p, (n) => n.op === 'Bitmap Heap Scan').timeMs, 8, 1e-6, '0,016 ms × 500');
    near(find(p, (n) => n.op === 'Bitmap Index Scan').timeMs, 3.5);
    near(root.timeMs, 12.953);
    near(root.selfMs, 12.953 - 11.5, 1e-6, 'die Unterabfrage steckt in der Zeit des Elternknotens');
    near(selfSum(p), 12.953);
    shares(p, 'time');
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL normaler SubPlan ohne ANALYZE: Kosten der Unterabfrage × 500 Zeilen des Elternknotens (F166)', () => {
    const p = pgFx('explain-subplan', FX.subplan, false);
    shares(p, 'cost');
    near(p.totalCost, 20954.34);
    // 500 × 41,87 = 20 935 von 20 954,34: fast alles steckt in der Unterabfrage (Bitmap Heap Scan 89,4 %, Bitmap Index Scan 10,4 %)
    near(find(p, (n) => n.op === 'Bitmap Heap Scan').share, ((41.84 - 4.37) * 500) / 20954.34, 1e-9);
    near(find(p, (n) => n.op === 'Bitmap Index Scan').share, (4.37 * 500) / 20954.34, 1e-9);
    near(find(p, (n) => n.op === 'Aggregate').share, ((41.87 - 41.84) * 500) / 20954.34, 1e-9);
    near(p.root?.share, (20954.34 - 41.87 * 500) / 20954.34, 1e-9);
  });

  await step('F296: PostgreSQL Limit über Seq Scan mit Filter: 66 360 geschätzt, 10 gelesen – kein „zu hoch“ (F284)', () => {
    const p = pgFx('limit', FX.limit, true);
    assert.equal(p.root?.op, 'Limit');
    const scan = p.root!.children[0];
    assert.equal(scan.op, 'Seq Scan');
    assert.equal(scan.rows, 66360);
    assert.equal(scan.actualRows, 10);
    assert.equal(scan.loops, 1);
    assert.deepEqual(misestimated(p), []);
    assert.equal(scan.warnings.length, 0, 'nach 29 Zeilen (10 geliefert, 19 verworfen) abgebrochen: auch kein „ganze Tabelle“');
    near(p.root?.timeMs, 0.135);
    near(scan.timeMs, 0.027);
    shares(p, 'time');
    near(scan.share, 0.027 / 0.135, 1e-9);
    near(p.root?.share, (0.135 - 0.027) / 0.135, 1e-9);
    // ohne das Limit wäre es eine echte Fehlschätzung
    const bare = JSON.parse(fixture('plan-postgres17-limit.json'));
    bare[0].Plan = bare[0].Plan.Plans[0];
    const s = find(postgresPlan('SELECT …', bare, true), (n) => n.op === 'Seq Scan');
    assert.match(warn(s), /Schätzung zu hoch: 66\W360 statt 10 Zeilen \(6\W033×\)/);
  });

  await step('F296: PostgreSQL Merge Join: innere Seite wird früh beendet (200 000 geschätzt, 3 001 gelesen) – kein „zu hoch“ (F284)', () => {
    const p = pgFx('mergejoin', FX.mergeJoin, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'Merge Join', 'Index Only Scan', 'Sort', 'Seq Scan'],
    );
    const idx = find(p, (n) => n.op === 'Index Only Scan');
    assert.equal(idx.rows, 200000);
    assert.equal(idx.actualRows, 3001);
    assert.equal(idx.warnings.length, 0);
    assert.deepEqual(misestimated(p), []);
    assert.match(warn(find(p, (n) => n.op === 'Seq Scan')), /Liest die ganze Tabelle \(20\W000 Zeilen\)/);
    near(find(p, (n) => n.op === 'Merge Join').timeMs, 2.829);
    shares(p, 'time');
    // eigene Zeiten: Index Only Scan 0,455; Merge Join 2,829 − 0,455 − 1,838 (Sort); zusammen 3,03 ms (Zeit der Wurzel)
    near(idx.share, 0.455 / 3.03, 1e-9);
    near(find(p, (n) => n.op === 'Merge Join').share, (2.829 - 0.455 - 1.838) / 3.03, 1e-9);
    // dieselbe Datei als Hash Join gelesen: dort wäre es eine Fehlschätzung
    const hash = postgresPlan('SELECT …', JSON.parse(swapped(fixture('plan-postgres17-mergejoin.json'), '"Node Type": "Merge Join"', '"Node Type": "Hash Join"')), true);
    assert.match(warn(find(hash, (n) => n.op === 'Index Only Scan')), /Schätzung zu hoch: 200\W000 statt 3\W001 Zeilen \(67×\)/);
  });

  await step('F296: PostgreSQL Nested Loop Semi Join: innere Seite hört nach dem ersten Treffer auf (5 000 geschätzt, 1 gelesen) (F284)', () => {
    const p = pgFx('semijoin', FX.semiJoin, true);
    assert.equal(p.root!.children[0].op, 'Nested Loop Semi Join');
    const inner = find(p, (n) => n.op === 'Index Only Scan');
    assert.equal(inner.rows, 5000);
    assert.equal(inner.actualRows, 1);
    assert.equal(inner.loops, 4);
    assert.deepEqual(misestimated(p), []);
    near(inner.timeMs, 2.456);
    shares(p, 'time');
    near(inner.share, 2.456 / 2.97, 1e-9);
    near(find(p, (n) => n.op === 'Seq Scan').share, 0.481 / 2.97, 1e-9);
    const inner2 = postgresPlan('SELECT …', JSON.parse(swapped(fixture('plan-postgres17-semijoin.json'), '"Join Type": "Semi"', '"Join Type": "Inner"')), true);
    assert.match(warn(find(inner2, (n) => n.op === 'Index Only Scan')), /Schätzung zu hoch: 5\W000 statt 1 Zeilen \(2\W501×\)/);
  });

  await step('F296: PostgreSQL Incremental Sort unter Limit: 200 000 geschätzt, 1 000 geliefert – keine Warnung (F284)', () => {
    const p = pgFx('incsort', FX.incSort, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Limit', 'Incremental Sort', 'Index Scan'],
    );
    const sort = find(p, (n) => n.op === 'Incremental Sort');
    assert.equal(sort.detail, 'kunde_id, betrag');
    assert.ok(sort.props.some(([k, v]) => k === 'Presorted Key' && v === 'kunde_id'));
    assert.equal(sort.rows, 200000);
    assert.equal(sort.actualRows, 1000);
    const idx = find(p, (n) => n.op === 'Index Scan');
    assert.equal(idx.detail, 'using ix_fx_kunde on fx_bestellungen');
    assert.equal(idx.actualRows, 1001);
    assert.deepEqual(misestimated(p), []);
    near(sort.timeMs, 0.888);
    near(sort.selfMs, 0.888 - 0.416);
    near(idx.timeMs, 0.416);
    shares(p, 'time');
    near(sort.share, (0.888 - 0.416) / 0.973, 1e-9);
    near(idx.share, 0.416 / 0.973, 1e-9);
    near(p.root?.share, (0.973 - 0.888) / 0.973, 1e-9);
  });

  await step('F296: PostgreSQL Incremental Sort ohne Limit: alle 200 000 Zeilen, Anteile 48 % Sortieren, 52 % Index-Lesen', () => {
    const p = pgFx('incsort-nolimit', FX.incSortAll, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Incremental Sort', 'Index Scan'],
    );
    near(p.root?.timeMs, 213.705);
    near(p.root?.selfMs, 213.705 - 110.779);
    assert.equal(p.root?.actualRows, 200000);
    assert.deepEqual(misestimated(p), []);
    shares(p, 'time');
    near(p.root?.share, (213.705 - 110.779) / 213.705, 1e-9);
    near(p.root!.children[0].share, 110.779 / 213.705, 1e-9);
    assert.equal(p.root!.warnings.length, 0);
  });

  await step('F296: PostgreSQL Memoize: 20 000 Aufrufe, 19 996 Treffer, darunter nur 4 Durchläufe; Zeit unter der Messgrenze', () => {
    const p = pgFx('memoize', FX.memoize, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'Nested Loop Left Join', 'Seq Scan', 'Memoize', 'Index Scan'],
    );
    const memo = find(p, (n) => n.op === 'Memoize');
    assert.equal(memo.loops, 20000);
    assert.equal(memo.actualRows, 1);
    assert.ok(memo.props.some(([k, v]) => k === 'Cache Hits' && v === '19996'));
    assert.ok(memo.props.some(([k, v]) => k === 'Cache Misses' && v === '4'));
    near(memo.timeMs, 0);
    const idx = find(p, (n) => n.op === 'Index Scan');
    assert.equal(idx.loops, 4, 'nur bei Fehlgriffen im Cache');
    near(idx.timeMs, 0.087 * 4);
    const nl = find(p, (n) => n.op === 'Nested Loop Left Join');
    near(nl.timeMs, 9.709);
    // Memoize meldet 0,000 ms je Durchlauf (auf Mikrosekunden gerundet; bei 20 000 Durchläufen fehlen so bis zu 10 ms): die Zeit
    // der Schleife enthält die Arbeit des Memoize, ohne dass sie bei ihm steht. Die eigene Zeit der Schleife ist die Angabe der
    // Datenbank abzüglich ihrer Kinder (9,709 − 3,243 = 6,466 ms). Wie die gerundeten Mikrosekunden verteilt werden, bleibt offen:
    // verlangt wird nur, dass die eigenen Zeiten mindestens die Zeit der Wurzel ergeben und der Anteil eigene Zeit / Summe ist
    near(nl.selfMs, 9.709 - 3.243, 1e-6);
    near(memo.selfMs, 0);
    near(p.root?.timeMs, 10.808);
    assert.ok(selfSum(p) >= 10.808 - 1e-9, String(selfSum(p)));
    shares(p, 'time');
    near(nl.share, nl.selfMs! / selfSum(p), 1e-9);
    near(memo.share, 0);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL Memoize ohne ANALYZE: Kosten der inneren Seite nicht mit 20 000 vervielfacht', () => {
    const p = pgFx('explain-memoize', FX.memoize, false);
    shares(p, 'cost');
    near(p.totalCost, 864.73);
    // Kosten je Durchlauf 0,16 (Memoize) und 0,15 (Index Scan): zusammen 0,16 von 864,73, nicht 20 000 × 0,16 = 3 200
    near(find(p, (n) => n.op === 'Memoize').share, (0.16 - 0.15) / 864.73, 1e-9);
    near(find(p, (n) => n.op === 'Index Scan').share, 0.15 / 864.73, 1e-9);
    near(find(p, (n) => n.op === 'Nested Loop Left Join').share, (764.72 - 309 - 0.16) / 864.73, 1e-9);
    near(find(p, (n) => n.op === 'Seq Scan').share, 309 / 864.73, 1e-9);
    near(p.root?.share, (864.73 - 764.72) / 864.73, 1e-9);
  });

  await step('F296: PostgreSQL Nested Loop mit Materialize innen: 500 Durchläufe, Kosten der inneren Seite nicht mit 500 vervielfacht', () => {
    const est = pgFx('explain-nl-materialize', FX.nlMaterialize, false);
    assert.deepEqual(
      nodes(est.root).map((n) => n.op),
      ['Aggregate', 'Nested Loop', 'Index Scan', 'Materialize', 'Seq Scan'],
    );
    shares(est, 'cost');
    near(est.totalCost, 57.85);
    // Kosten je Durchlauf: Materialize 1,06 (davon 1,04 der Seq Scan darin); 500 × 1,06 = 530 wären 90 % der Gesamtkosten
    near(find(est, (n) => n.op === 'Materialize').share, (1.06 - 1.04) / 57.85, 1e-9);
    near(find(est, (n) => n.op === 'Seq Scan').share, 1.04 / 57.85, 1e-9);
    near(find(est, (n) => n.op === 'Index Scan').share, 23.04 / 57.85, 1e-9);
    near(find(est, (n) => n.op === 'Nested Loop').share, (54.09 - 23.04 - 1.06) / 57.85, 1e-9);
    near(est.root?.share, (57.85 - 54.09) / 57.85, 1e-9);
    const p = pgFx('nl-materialize', FX.nlMaterialize, true);
    const mat = find(p, (n) => n.op === 'Materialize');
    const seq = find(p, (n) => n.op === 'Seq Scan');
    assert.equal(mat.loops, 500);
    assert.equal(mat.actualRows, 4);
    assert.equal(seq.loops, 1, 'die Tabelle wird einmal gelesen, danach liefert Materialize aus dem Speicher');
    assert.equal(seq.actualRows, 4);
    near(mat.timeMs, 0);
    near(seq.timeMs, 0.007);
    near(find(p, (n) => n.op === 'Nested Loop').timeMs, 0.429);
    shares(p, 'time');
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL Fehlschätzung zu niedrig (id % 7 = 3): 1 000 statt 28 572 Zeilen wird gemeldet, nur dort', () => {
    const p = pgFx('lowestimate', FX.lowEstimate, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'Seq Scan'],
    );
    const scan = p.root!.children[0];
    assert.equal(scan.rows, 1000, 'Standardschätzung für einen Ausdruck: 0,5 % von 200 000');
    assert.equal(scan.actualRows, 28572);
    assert.equal(scan.warnings.length, 2);
    assert.match(scan.warnings[0], /^Schätzung zu niedrig: 1\W000 statt 28\W572 Zeilen \(29×\)$/);
    assert.match(scan.warnings[1], /^Liest die ganze Tabelle \(200\W000 Zeilen\)$/, '28 572 gelesen + 171 428 verworfen');
    assert.deepEqual(misestimated(p), ['Seq Scan']);
    assert.equal(p.root!.warnings.length, 0, 'Aggregate: 1 geschätzt, 1 tatsächlich');
    shares(p, 'time');
    near(scan.timeMs, 10.535);
    near(scan.share, 10.535 / 12.222, 1e-9);
  });

  await step('F296: PostgreSQL zu niedrig bleibt auch unter Limit: nur „zu hoch“ wird dort unterdrückt (F284)', () => {
    const p = pgFx('lowestimate-limit', FX.lowEstimateLimit, true);
    assert.equal(p.root?.op, 'Limit');
    assert.equal(p.root?.rows, 1000, 'Limit 50 000, aber höchstens die geschätzten 1 000 Zeilen');
    assert.equal(p.root?.actualRows, 28572);
    // beide Schritte lieferten 28 572 statt 1 000 Zeilen: Limit nimmt alle, weil 50 000 nicht erreicht wird
    assert.deepEqual(misestimated(p), ['Limit', 'Seq Scan']);
    assert.match(warn(p.root!.children[0]), /Schätzung zu niedrig: 1\W000 statt 28\W572 Zeilen \(29×\)/);
    shares(p, 'time');
    near(p.root!.children[0].share, 10.492 / 12.839, 1e-9);
    near(p.root?.share, (12.839 - 10.492) / 12.839, 1e-9);
  });

  await step('F296: PostgreSQL Sortieren auf der Platte (work_mem 64 kB): Hinweis mit den 3 776 kB der Datei', () => {
    const p = pgFx('sort-disk', FX.sortDisk, true);
    assert.equal(p.root?.op, 'Sort');
    assert.equal(p.root?.detail, 'betrag, id');
    assert.ok(p.root!.props.some(([k, v]) => k === 'Sort Method' && v === 'external merge'));
    assert.deepEqual(p.root!.warnings, ['Sortiert auf der Platte (3776 kB) – work_mem reicht nicht']);
    near(p.root?.timeMs, 239.701);
    near(p.root?.selfMs, 239.701 - 18.17);
    shares(p, 'time');
    near(p.root?.share, (239.701 - 18.17) / 239.701, 1e-9);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL Hash in 16 Teilen (work_mem 64 kB): Hinweis am Hash, nicht am Hash Join', () => {
    const p = pgFx('hash-batches', FX.hashBatches, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'Hash Join', 'Seq Scan', 'Hash', 'Seq Scan'],
    );
    const hash = find(p, (n) => n.op === 'Hash');
    assert.deepEqual(hash.warnings, ['Hash in 16 Teilen – work_mem reicht nicht']);
    assert.equal(find(p, (n) => n.op === 'Hash Join').warnings.length, 0);
    near(hash.timeMs, 3.217);
    near(hash.selfMs, 3.217 - 1.134);
    shares(p, 'time');
    near(find(p, (n) => n.op === 'Hash Join').selfMs, 57.918 - 11.722 - 3.217);
    timesNest(p);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: PostgreSQL Plan ohne ANALYZE (Join): Hash Join, Anteile nach Kosten, keine Zeiten, kein „ganze Tabelle“', () => {
    const p = pgFx('explain-join', FX.join, false);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Sort', 'HashAggregate', 'Hash Join', 'Seq Scan', 'Hash', 'Seq Scan'],
    );
    shares(p, 'cost');
    near(p.totalCost, 5006.46);
    assert.equal(p.planningMs, undefined);
    assert.equal(p.executionMs, undefined);
    // PostgreSQL nennt ohne ANALYZE nur die Zeilen nach dem Filter (66 647), nicht die gelesenen: darum kein „ganze Tabelle“
    assert.ok(nodes(p.root).every((n) => n.timeMs === undefined && n.actualRows === undefined && n.warnings.length === 0));
    const big = find(p, (n) => n.op === 'Seq Scan' && /fx_bestellungen/.test(n.detail ?? ''));
    assert.equal(big.rows, 66647);
    // Kosten der Schritte ohne die darunter: 3 774 (Scan), 4 507,98 − 3 774 − 309 (Hash Join), 5 006,41 − 4 507,98 (HashAggregate)
    near(big.share, 3774 / 5006.46, 1e-9);
    near(find(p, (n) => n.op === 'Hash Join').share, (4507.98 - 3774 - 309) / 5006.46, 1e-9);
    near(find(p, (n) => n.op === 'HashAggregate').share, (5006.41 - 4507.98) / 5006.46, 1e-9);
    near(find(p, (n) => n.op === 'Seq Scan' && /fx_kunden/.test(n.detail ?? '')).share, 309 / 5006.46, 1e-9);
    assert.equal(p.rawFormat, 'json');
    assert.match(p.raw ?? '', /"Node Type": "Hash Join"/);
  });

  await step('F296: PostgreSQL Gather ohne ANALYZE: Workers Planned, Anteile nach Kosten (Partial Aggregate 3 %, Scan 97 %)', () => {
    const p = pgFx('explain-gather', FX.gatherCount, false);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Finalize Aggregate', 'Gather', 'Partial Aggregate', 'Parallel Seq Scan'],
    );
    const gather = find(p, (n) => n.op === 'Gather');
    assert.ok(gather.props.some(([k, v]) => k === 'Workers Planned' && v === '2'));
    assert.ok(!gather.props.some(([k]) => k === 'Workers Launched'));
    shares(p, 'cost');
    // ohne ANALYZE nichts geteilt: Kosten 2 384,82 (Finalize), 2 384,8 (Gather, Partial Aggregate), 2 315,67 (Scan)
    near(find(p, (n) => n.op === 'Partial Aggregate').share, (2384.8 - 2315.67) / 2384.82, 1e-9);
    near(find(p, (n) => n.op === 'Parallel Seq Scan').share, 2315.67 / 2384.82, 1e-9);
    near(gather.share, 0, 1e-9);
    near(p.root?.share, 0.02 / 2384.82, 1e-9);
    assert.equal(find(p, (n) => n.op === 'Parallel Seq Scan').timeMs, undefined);
  });

  await step('F296: PostgreSQL UPDATE mit Trigger: Hinweis mit Aufrufen und Zeit des Triggers, Schritt „Update“', () => {
    const p = pgFx('trigger', FX.trigger, true);
    assert.equal(p.error, undefined);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Update', 'Seq Scan'],
    );
    assert.equal(p.root?.detail, 'on fx_notiz');
    assert.deepEqual(p.notes, ['Trigger fx_notiz_aenderung auf fx_notiz: 1000× in 6.856 ms']);
    // die Zeit des Triggers steht nur in der Ausführungszeit (18,401 ms), nicht bei den Schritten (11,403 ms)
    near(p.executionMs, 18.401);
    near(p.root?.timeMs, 11.403);
    near(selfSum(p), 11.403, 1e-6);
    const scan = find(p, (n) => n.op === 'Seq Scan');
    assert.equal(scan.rows, 1546);
    assert.equal(scan.actualRows, 1000);
    shares(p, 'time');
    near(scan.share, 0.241 / 11.403, 1e-9);
    near(p.root?.share, (11.403 - 0.241) / 11.403, 1e-9);
    assert.deepEqual(misestimated(p), []);
  });

  /* ---------------------------------------------------------- MySQL 8 ---- */

  await step('F296: MySQL 8 TREE ohne ANALYZE (Join): Nested loop, Kosten der inneren Seite × Zeilen der äußeren, Anteile nach Kosten', () => {
    const p = treeFx('join', FX.join, false);
    assert.equal(p.error, undefined);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Sort', 'Table scan', 'Aggregate using temporary table', 'Nested loop inner join', 'Filter', 'Table scan', 'Single-row index lookup'],
    );
    assert.equal(p.root?.detail, 'summe DESC');
    const nl = find(p, (n) => n.op === 'Nested loop inner join');
    assert.equal(nl.rows, 16882);
    assert.equal(nl.cost, 23119);
    const lookup = find(p, (n) => n.op === 'Single-row index lookup');
    assert.equal(lookup.detail, 'k using PRIMARY (id=b.kunde_id)');
    assert.equal(lookup.rows, 1);
    assert.equal(lookup.cost, 0.25);
    const scan = find(p, (n) => n.op === 'Table scan' && n.detail === 'b');
    assert.equal(scan.rows, 168817);
    shares(p, 'cost');
    // 0,25 × 16 882 Durchläufe = 4 220,5; Table scan 17 210; Rest der Schleife 1 688,5; zusammen 23 119
    near(lookup.share, 4220.5 / 23119, 1e-9);
    near(scan.share, 17210 / 23119, 1e-9);
    near(nl.share, 1688.5 / 23119, 1e-9);
    assert.match(warn(scan), /Liest die ganze Tabelle \(168\W817 Zeilen\)/, 'ohne ANALYZE nach der Schätzung');
    assert.equal(p.executionMs, undefined);
    assert.equal(p.rawFormat, 'text');
  });

  await step('F296: MySQL 8 EXPLAIN ANALYZE (Join): Zeit × Loops, 66 666 Nachschlagen, Anteile nach Zeit', () => {
    const p = treeFx('analyze-join', FX.join, true);
    near(p.executionMs, 278);
    near(p.root?.timeMs, 278);
    assert.equal(p.root?.actualRows, 4);
    const lookup = find(p, (n) => n.op === 'Single-row index lookup');
    assert.equal(lookup.loops, 66666);
    assert.equal(lookup.actualRows, 1);
    near(lookup.timeMs, 0.00163 * 66666, 1e-6, 'Endzeit je Durchlauf × Loops');
    const filter = find(p, (n) => n.op === 'Filter');
    assert.equal(filter.actualRows, 66666);
    near(filter.timeMs, 95.3);
    near(filter.selfMs, 95.3 - 67.8);
    const nl = find(p, (n) => n.op === 'Nested loop inner join');
    near(nl.timeMs, 222);
    near(nl.selfMs, 222 - 95.3 - 0.00163 * 66666, 1e-6);
    near(find(p, (n) => n.op === 'Aggregate using temporary table').selfMs, 278 - 222);
    near(selfSum(p), 278, 1e-6);
    shares(p, 'time');
    near(lookup.share, 0.00163 * 66666 / 278, 1e-9);
    const scan = find(p, (n) => n.op === 'Table scan' && n.detail === 'b');
    near(scan.share, 67.8 / 278, 1e-9);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/, 'tatsächlich gelesene Zeilen');
    assert.deepEqual(misestimated(p), [], 'Filter: 16 882 geschätzt, 66 666 tatsächlich = nur 4×');
  });

  await step('F296: MySQL 8 abhängige Unterabfrage (EXPLAIN ANALYZE): zwei Wurzeln, Select #2 läuft 500-mal', () => {
    const p = treeFx('analyze-subquery', FX.mysqlSubquery, true);
    assert.equal(p.root?.op, 'Abfrage');
    assert.deepEqual(
      p.root!.children.map((n) => n.op),
      ['Filter', 'Select #2'],
    );
    const sel = p.root!.children[1];
    assert.equal(sel.detail, '(subquery in projection; dependent)');
    const agg = find(p, (n) => n.op === 'Aggregate');
    assert.equal(agg.detail, 'max(b.betrag)');
    assert.equal(agg.loops, 500);
    near(agg.timeMs, 0.0144 * 500, 1e-6);
    const idx = find(p, (n) => n.op === 'Index lookup');
    assert.equal(idx.loops, 500);
    assert.equal(idx.actualRows, 10);
    assert.equal(idx.rows, 8.31);
    near(idx.timeMs, 0.0129 * 500, 1e-6);
    near(agg.selfMs, 0.0144 * 500 - 0.0129 * 500, 1e-6);
    near(find(p, (n) => n.op === 'Filter').selfMs, 0.229 - 0.151);
    near(find(p, (n) => n.op === 'Covering index range scan').selfMs, 0.151);
    shares(p, 'time');
    // Anteile an der Summe der eigenen Zeiten beider Wurzeln: Filter 0,078 + Index range scan 0,151 + Aggregate 0,75 + Index lookup
    // 6,45 = 7,429 ms. Die Unterabfrage steht bei MySQL neben der Hauptabfrage (deren 0,229 ms sie nicht enthalten), gehört aber zur
    // Abfrage. Welche Gesamtzeit oben steht (p.executionMs nennt nur die Hauptabfrage), wird hier bewusst nicht festgeschrieben
    const total = 0.078 + 0.151 + 0.75 + 6.45;
    near(selfSum(p), total, 1e-9);
    near(idx.share, 6.45 / total, 1e-9);
    near(agg.share, 0.75 / total, 1e-9);
    near(find(p, (n) => n.op === 'Covering index range scan').share, 0.151 / total, 1e-9);
    assert.ok(nodes(p.root).every((n) => n.warnings.length === 0), nodes(p.root).map(warn).join('|'));
  });

  await step('F296: MySQL 8 abhängige Unterabfrage ohne ANALYZE: Kosten × 500 Zeilen der Hauptabfrage', () => {
    const p = treeFx('subquery', FX.mysqlSubquery, false);
    assert.equal(p.root?.op, 'Abfrage');
    shares(p, 'cost');
    // 500 × 3,74 = 1 870 (Aggregate) davon 500 × 2,91 = 1 455 (Index lookup); dazu 100 (Index range scan): zusammen 1 970
    near(find(p, (n) => n.op === 'Index lookup').share, 1455 / 1970, 1e-9);
    near(find(p, (n) => n.op === 'Aggregate').share, 415 / 1970, 1e-9);
    near(find(p, (n) => n.op === 'Covering index range scan').share, 100 / 1970, 1e-9);
    assert.equal(find(p, (n) => n.op === 'Filter').share, 0);
    assert.equal(find(p, (n) => n.op === 'Select #2').share, undefined, 'die Wurzel der Unterabfrage nennt keine Kosten');
  });

  await step('F296: MySQL 8 NOT IN (EXPLAIN ANALYZE): Zahlen mit Exponent, Nested loop antijoin, Materialize with deduplication', () => {
    const p = treeFx('analyze-notin', FX.notIn, true);
    assert.equal(p.root?.op, 'Aggregate');
    assert.equal(p.root?.cost, 773e6, 'cost=773e+6');
    assert.equal(p.totalCost, 773e6);
    const anti = find(p, (n) => n.op === 'Nested loop antijoin');
    assert.equal(anti.rows, 3.86e9, 'rows=3.86e+9');
    assert.equal(anti.actualRows, 15878);
    assert.match(warn(anti), /Schätzung zu hoch: 3\W860\W000\W000 statt 15\W878 Zeilen \(243\W088×\)/);
    const lookup = find(p, (n) => n.op === 'Single-row index lookup');
    assert.equal(lookup.detail, '<subquery2> using <auto_distinct_key> (kunde_id=fx_kunden.id)');
    assert.equal(lookup.loops, 20000);
    assert.equal(lookup.actualRows, 0.206, 'MySQL gibt Zeilen je Durchlauf als Bruch an');
    const mat = find(p, (n) => n.op === 'Materialize with deduplication');
    assert.equal(mat.rows, 168817);
    assert.equal(mat.actualRows, 4122);
    assert.equal(mat.loops, 1);
    near(mat.timeMs, 77);
    const scan = find(p, (n) => n.op === 'Table scan' && n.detail === 'fx_bestellungen');
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    assert.equal(find(p, (n) => n.op === 'Filter').children[0].op, 'Filter');
    near(p.executionMs, 93.8);
    shares(p, 'time');
    // beim Anti-Join selbst bleibt die Warnung (sie steht nicht „darunter“). Was für die Schritte darunter gilt, die ihre Eingabe
    // ganz lesen (Materialize, die beiden Filter: 168 817 geschätzt, 4 122 tatsächlich), wird hier nicht festgelegt
    assert.ok(misestimated(p).includes('Nested loop antijoin'));
  });

  await step('F296: MySQL 8 EXISTS/NOT EXISTS: Nachschlagen unter semijoin/antijoin (5 407 geschätzt, 1 gelesen) ohne „zu hoch“ (F284)', () => {
    for (const [name, op, sql, perLoop, joinWarn] of [
      ['semijoin', 'Nested loop semijoin', 'SELECT COUNT(*) AS n FROM fx_orte o WHERE EXISTS (SELECT 1 FROM fx_kunden k WHERE k.ort = o.name)', 0.0588, /zu hoch: 21\W627 statt 4 Zeilen \(4\W326×\)/],
      ['antijoin', 'Nested loop antijoin', 'SELECT COUNT(*) AS n FROM fx_orte o WHERE NOT EXISTS (SELECT 1 FROM fx_kunden k WHERE k.ort = o.name)', 0.0607, /zu hoch: 21\W627 statt 0 Zeilen \(21\W628×\)/],
    ] as const) {
      const p = treeFx(`analyze-${name}`, sql, true);
      const join = find(p, (n) => n.op === op);
      const lookup = find(p, (n) => n.op === 'Covering index lookup');
      assert.equal(lookup.detail, 'k using ix_fx_ort (ort=o.`name`)');
      assert.equal(lookup.rows, 5407, name);
      assert.equal(lookup.actualRows, 1, name);
      assert.equal(lookup.loops, 4, name);
      assert.equal(lookup.warnings.length, 0, `${name}: ${warn(lookup)}`);
      assert.equal(join.children[0].op, 'Covering index scan');
      near(lookup.timeMs, perLoop * 4, 1e-9, name);
      // beim Join selbst bleibt die Warnung: MySQL schätzt 21 627 Zeilen (4 × 5 407), mehr als die äußere Seite je liefern kann
      assert.match(warn(join), joinWarn, name);
      assert.deepEqual(misestimated(p), [op], name);
      shares(p, 'time');
      // als gewöhnlicher Join gelesen wäre es eine Fehlschätzung
      const plain = mysqlTreePlan(sql, swapped(fixture(`plan-mysql8-tree-analyze-${name}.txt`), /(semi|anti)join/, 'inner join'), true);
      assert.match(warn(find(plain, (n) => n.op === 'Covering index lookup')), /Schätzung zu hoch: 5\W407 statt 1 Zeilen \(2\W704×\)/, name);
    }
  });

  await step('F296: MySQL 8 Limit über Filter und Table scan: 21 841 und 218 411 geschätzt, 10 geliefert, 29 gelesen – kein „zu hoch“ (F284)', () => {
    const p = treeFx('analyze-limit', FX.limit, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Limit', 'Filter', 'Table scan'],
    );
    assert.equal(p.root?.detail, '10 row(s)');
    const filter = find(p, (n) => n.op === 'Filter');
    const scan = find(p, (n) => n.op === 'Table scan');
    assert.equal(filter.rows, 21841);
    assert.equal(filter.actualRows, 10);
    assert.equal(scan.rows, 218411);
    assert.equal(scan.actualRows, 29);
    assert.deepEqual(misestimated(p), []);
    assert.equal(scan.warnings.length, 0, '29 Zeilen gelesen: auch kein „ganze Tabelle“');
    near(p.executionMs, 0.213);
    near(scan.timeMs, 0.206);
    near(filter.timeMs, 0.21);
    shares(p, 'time');
    near(scan.share, 0.206 / 0.213, 1e-9);
    near(filter.share, (0.21 - 0.206) / 0.213, 1e-9);
    near(p.root?.share, (0.213 - 0.21) / 0.213, 1e-9);
    // ohne Limit (hier ein Sort an der Stelle) wären beide Schätzungen Fehlschätzungen
    const bare = mysqlTreePlan(FX.limit, swapped(fixture('plan-mysql8-tree-analyze-limit.txt'), 'Limit: 10 row(s)', 'Sort: id'), true);
    assert.match(warn(find(bare, (n) => n.op === 'Filter')), /Schätzung zu hoch: 21\W841 statt 10 Zeilen \(1\W986×\)/);
    assert.match(warn(find(bare, (n) => n.op === 'Table scan')), /Schätzung zu hoch: 218\W411 statt 29 Zeilen \(7\W280×\)/);
  });

  await step('F296: MySQL 8 IN-Unterabfrage (Materialize with deduplication): nur Zeit mit ANALYZE, Anteile stimmig', () => {
    const p = treeFx('analyze-in', FX.mysqlIn, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Aggregate', 'Nested loop inner join', 'Table scan', 'Materialize with deduplication', 'Filter', 'Table scan', 'Single-row covering index lookup'],
    );
    const derived = find(p, (n) => n.detail === '<subquery2>');
    assert.equal(derived.actualRows, 4122);
    assert.equal(derived.warnings.length, 0, 'Table scan auf die materialisierte Unterabfrage ist kein Lesen der ganzen Tabelle');
    const lookup = find(p, (n) => n.op === 'Single-row covering index lookup');
    assert.equal(lookup.loops, 4122);
    near(lookup.timeMs, 0.0017 * 4122, 1e-6);
    const scan = find(p, (n) => n.op === 'Table scan' && n.detail === 'fx_bestellungen');
    near(scan.timeMs, 37.9);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    near(p.executionMs, 74.4);
    near(selfSum(p), 74.4, 1e-6);
    shares(p, 'time');
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: MySQL 8 IN-Unterabfrage ohne ANALYZE: Kosten des Nachschlagens (1 407 insgesamt) nicht noch mit 5 627 vervielfacht', () => {
    const p = treeFx('in', FX.mysqlIn, false);
    shares(p, 'cost');
    near(p.totalCost, 20377);
    const lookup = find(p, (n) => n.op === 'Single-row covering index lookup');
    assert.equal(lookup.cost, 1407);
    assert.equal(lookup.rows, 1);
    // 562 + 563 + 72 + 563 + 0 + 17 210 + 1 407 = 20 377
    near(lookup.share, 1407 / 20377, 1e-9);
    const scan = find(p, (n) => n.op === 'Table scan' && n.detail === 'fx_bestellungen');
    near(scan.share, 17210 / 20377, 1e-9);
    assert.match(warn(scan), /Liest die ganze Tabelle \(168\W817 Zeilen\)/);
    near(find(p, (n) => n.op === 'Materialize with deduplication').share, 563 / 20377, 1e-9);
  });

  await step('F296: MySQL 8 abgeleitete Tabelle (Materialize, Group aggregate): 20 000 Nachschlagen, keine Warnungen', () => {
    const p = treeFx('analyze-derived', FX.mysqlDerived, true);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Sort', 'Table scan', 'Aggregate using temporary table', 'Nested loop inner join', 'Table scan', 'Materialize', 'Group aggregate', 'Index scan', 'Single-row index lookup'],
    );
    const lookup = find(p, (n) => n.op === 'Single-row index lookup');
    assert.equal(lookup.loops, 20000);
    near(lookup.timeMs, 0.0014 * 20000, 1e-6);
    const mat = find(p, (n) => n.op === 'Materialize');
    assert.equal(mat.actualRows, 20000);
    near(mat.timeMs, 340);
    const idx = find(p, (n) => n.op === 'Index scan');
    assert.equal(idx.detail, 'fx_bestellungen using ix_fx_kunde');
    near(idx.timeMs, 306);
    assert.equal(idx.actualRows, 200000);
    near(p.executionMs, 387);
    near(selfSum(p), 387, 1e-6);
    shares(p, 'time');
    assert.ok(nodes(p.root).every((n) => n.warnings.length === 0), nodes(p.root).map(warn).join('|'));
    near(idx.share, 306 / 387, 1e-9);
  });

  await step('F296: MySQL 8 FORMAT=JSON (Join): Kosten read_cost + eval_cost, Anteile nach Kosten', () => {
    const p = mysqlJsonPlan(FX.join, fixture('plan-mysql8-json-join.json'), false);
    assert.equal(p.error, undefined);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Select #1', 'Sort', 'Group (temporary table)', 'Nested loop', 'Table scan', 'Single-row index lookup'],
    );
    assert.equal(p.totalCost, 23118.54, 'query_cost kommt als Text');
    const b = find(p, (n) => n.op === 'Table scan');
    assert.equal(b.rows, 168817);
    assert.match(b.detail ?? '', /^b · \(`plan_fx`.`b`.`status` = 'offen'\)$/);
    shares(p, 'cost');
    // b: 15 521,78 + 1 688,17; k: 4 220,43 + 1 688,17; zusammen 23 118,55
    near(b.share, 17209.95 / 23118.55, 1e-9);
    near(find(p, (n) => n.op === 'Single-row index lookup').share, 5908.6 / 23118.55, 1e-9);
    assert.match(warn(b), /Liest die ganze Tabelle \(168\W817 Zeilen\)/);
    assert.equal(p.executionMs, undefined);
    assert.equal(p.rawFormat, 'json');
  });

  await step('F296: MySQL 8 FORMAT=JSON eines UPDATE: Schritt „Update“, keine Kosten → keine Anteile', () => {
    const p = mysqlJsonPlan(FX.mysqlUpdate, fixture('plan-mysql8-json-update.json'), false);
    assert.equal(p.error, undefined);
    const t = find(p, (n) => n.op === 'Update: Index range scan');
    assert.equal(t.detail, "fx_kunden using PRIMARY · (`plan_fx`.`fx_kunden`.`id` = 7)");
    assert.equal(t.rows, 1);
    assert.equal(t.warnings.length, 0);
    assert.equal(p.shareBy, undefined);
    assert.equal(shareSum(p), 0);
  });

  await step('F296: MySQL 8.4 JSON-Format 2 (Baum als JSON): ohne und mit ANALYZE, Semijoin über weedout', () => {
    const est = mysqlJsonPlan(FX.mysqlIn, fixture('plan-mysql8-json2-in.json'), false);
    assert.equal(est.error, undefined);
    assert.deepEqual(
      nodes(est.root).map((n) => n.op),
      ['Aggregate', 'Remove duplicate fx_kunden rows using temporary table', 'Nested loop inner join', 'Filter', 'Table scan', 'Single-row covering index lookup'],
    );
    shares(est, 'cost');
    near(est.totalCost, 25445.18747559153);
    const scanE = find(est, (n) => n.op === 'Table scan');
    near(scanE.share, 22169.350000000002 / 25445.18747559153, 1e-9);
    assert.match(warn(scanE), /Liest die ganze Tabelle \(218\W411 Zeilen\)/);
    // Kosten je Durchlauf 0,25 × 7 279,64 Zeilen der äußeren Seite
    near(find(est, (n) => n.op === 'Single-row covering index lookup').share, (0.2500137369452347 * 7279.638834647834) / 25445.18747559153, 1e-9);
    const act = mysqlJsonPlan(FX.mysqlIn, fixture('plan-mysql8-json2-analyze-in.json'), true);
    shares(act, 'time');
    near(act.executionMs, 57.942462);
    const lookup = find(act, (n) => n.op === 'Single-row covering index lookup');
    assert.equal(lookup.loops, 4122);
    assert.equal(find(act, (n) => n.op === 'Filter').actualRows, 4122);
    const scanA = find(act, (n) => n.op === 'Table scan');
    assert.match(warn(scanA), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    near(selfSum(act), 57.942462, 1e-6);
    // Zeiten der Datei: Table scan 32,345993; Filter 49,682397 (mit dem Scan); Nested loop 54,918923; Nachschlagen 4,558345
    near(scanA.selfMs, 32.345993, 1e-9);
    near(scanA.share, 32.345993 / 57.942462, 1e-9);
    const filterA = find(act, (n) => n.op === 'Filter');
    near(filterA.selfMs, 49.682397 - 32.345993, 1e-9);
    near(filterA.share, (49.682397 - 32.345993) / 57.942462, 1e-9);
    near(lookup.selfMs, 4.558345, 1e-9);
    near(lookup.share, 4.558345 / 57.942462, 1e-9);
    near(find(act, (n) => n.op === 'Nested loop inner join').selfMs, 54.918923 - 49.682397 - 4.558345, 1e-9);
  });

  /* ---------------------------------------------------------- MariaDB 11.8 ---- */

  await step('F296: MariaDB 11.8 ANALYZE FORMAT=JSON: Tabellen als Nested loop, Anteile nach Zeit', () => {
    const p = mysqlJsonPlan(FX.join, fixture('plan-mariadb118-analyze-join.json'), true);
    assert.equal(p.error, undefined);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Select #1', 'Sort', 'Temporary table', 'Nested loop', 'Table scan', 'Single-row index lookup'],
    );
    near(p.executionMs, 183.4403387);
    near(p.planningMs, 0.320240515);
    near(p.totalCost, 212.2957769);
    const b = find(p, (n) => n.op === 'Table scan');
    assert.equal(b.rows, 200187);
    assert.equal(b.actualRows, 200000);
    assert.equal(b.loops, 1);
    near(b.selfMs, 63.46369704 + 17.09087287, 1e-6, 'r_table_time_ms + r_other_time_ms');
    const k = find(p, (n) => n.op === 'Single-row index lookup');
    assert.equal(k.loops, 66666);
    assert.equal(k.actualRows, 1);
    near(k.selfMs, 57.84968129 + 44.98189451, 1e-6);
    shares(p, 'time');
    // jede Tabelle meldet ihre eigene Zeit, die Summe aller eigenen Zeiten ist die Zeit des Select (183,44 ms)
    near(b.share, (63.46369704 + 17.09087287) / 183.4403387, 1e-9);
    near(k.share, (57.84968129 + 44.98189451) / 183.4403387, 1e-9);
    near(find(p, (n) => n.op === 'Sort').share, 0.020666519 / 183.4403387, 1e-9);
    near(selfSum(p), 183.4403387, 1e-9);
    assert.equal(find(p, (n) => n.op === 'Nested loop').share, undefined, 'Schritte ohne eigene Messung bleiben ohne Anteil');
    assert.match(warn(b), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: MariaDB 11.8 EXPLAIN FORMAT=JSON: meldet jetzt Kosten (Table scan 15,6 %, Nachschlagen 84,4 %)', () => {
    const p = mysqlJsonPlan(FX.join, fixture('plan-mariadb118-explain-join.json'), false);
    shares(p, 'cost');
    near(p.totalCost, 212.2957769);
    near(find(p, (n) => n.op === 'Table scan').share, 33.1610542 / 212.2957769, 1e-9);
    near(find(p, (n) => n.op === 'Single-row index lookup').share, 179.1347227 / 212.2957769, 1e-9);
    assert.equal(p.executionMs, undefined);
    assert.match(warn(find(p, (n) => n.op === 'Table scan')), /Liest die ganze Tabelle \(200\W187 Zeilen\)/);
  });

  /* ---------------------------------------------------------- SQL Server 2022 ---- */

  await step('F296: SQL Server geschätzter Plan (SHOWPLAN_XML): Hash Match, fehlender Index, Anteile nach Kosten', () => {
    const plans = mssqlPlans([fixture('plan-mssql2022-explain-join.xml')], false);
    assert.equal(plans.length, 1);
    const p = plans[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlJoin);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Sort', 'Compute Scalar', 'Hash Match (Aggregate)', 'Hash Match (Inner Join)', 'Index Scan', 'Clustered Index Scan'],
    );
    near(p.totalCost, 2.42921);
    near(p.planningMs, 17);
    assert.equal(p.executionMs, undefined);
    assert.equal(p.notes.length, 1);
    assert.equal(
      p.notes[0],
      'Fehlender Index (laut SQL Server 35 % günstiger): CREATE NONCLUSTERED INDEX [IX_fx_bestellungen_status] ON [dbo].[fx_bestellungen] ([status]) INCLUDE ([kunde_id], [betrag])',
    );
    const k = find(p, (n) => n.op === 'Index Scan');
    assert.equal(k.detail, 'fx_kunden k (ix_fx_ort)');
    assert.equal(k.rows, 20000);
    const b = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.match(b.detail ?? '', /^fx_bestellungen b \(PK__fx_beste__\w+\) · Filter: b.status=N'offen'$/);
    assert.equal(b.rows, 66666);
    assert.match(warn(b), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    assert.match(warn(k), /Liest die ganze Tabelle \(20\W000 Zeilen\)/);
    shares(p, 'cost');
    // geschätzte Kosten mit den Schritten darunter: Sort 2,42921; Compute Scalar und Aggregate 2,41783; Join 1,95471; k 0,0697264; b 1,03217
    near(b.share, 1.03217 / 2.42921, 1e-9);
    near(k.share, 0.0697264 / 2.42921, 1e-9);
    near(find(p, (n) => n.op === 'Hash Match (Inner Join)').share, (1.95471 - 0.0697264 - 1.03217) / 2.42921, 1e-9);
    near(find(p, (n) => n.op === 'Hash Match (Aggregate)').share, (2.41783 - 1.95471) / 2.42921, 1e-9);
    near(find(p, (n) => n.op === 'Sort').share, (2.42921 - 2.41783) / 2.42921, 1e-9);
    near(find(p, (n) => n.op === 'Compute Scalar').share, 0, 1e-9);
    assert.equal(p.rawFormat, 'xml');
  });

  await step('F296: SQL Server tatsächlicher Plan (STATISTICS XML): ganze Millisekunden, Zeit des Hash Join = 40 − 2 − 23', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-join.xml')], true)[0];
    assert.equal(p.error, undefined);
    near(p.executionMs, 68);
    near(p.planningMs, 17);
    const agg = find(p, (n) => n.op === 'Hash Match (Aggregate)');
    near(agg.timeMs, 68);
    near(agg.selfMs, 68 - 40);
    assert.equal(agg.actualRows, 4);
    const join = find(p, (n) => n.op === 'Hash Match (Inner Join)');
    near(join.timeMs, 40);
    near(join.selfMs, 15);
    assert.equal(join.actualRows, 66666);
    assert.equal(join.loops, 1);
    const b = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.equal(b.actualRows, 66666);
    near(b.timeMs, 23);
    shares(p, 'time');
    near(agg.share, 28 / 68, 1e-9);
    near(b.share, 23 / 68, 1e-9);
    near(selfSum(p), 68, 1e-9);
    assert.equal(find(p, (n) => n.op === 'Compute Scalar').selfMs, undefined, 'ohne eigene Messung');
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: SQL Server paralleler Plan (23 Threads): Nachschlagen in der inneren Seite summiert (66 666), nicht das Maximum (3 904) (F167)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-parallel.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlParallel);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      [
        'Parallelism (Gather Streams)',
        'Sort',
        'Compute Scalar',
        'Stream Aggregate (Aggregate)',
        'Sort',
        'Parallelism (Repartition Streams)',
        'Hash Match (Partial Aggregate)',
        'Nested Loops (Inner Join)',
        'Clustered Index Scan',
        'Clustered Index Seek',
      ],
    );
    near(p.executionMs, 36);
    near(p.planningMs, 11);
    const seek = find(p, (n) => n.op === 'Clustered Index Seek');
    assert.equal(seek.loops, 66666, 'Summe der Ausführungen aller Threads (298 + 17 × 3 904 …)');
    assert.equal(seek.actualRows, 1, '66 666 Zeilen auf 66 666 Durchläufe');
    assert.equal(seek.rows, 1);
    assert.match(seek.detail ?? '', /^fx_kunden k \(PK__fx_kunde__\w+\) · Seek: k.id = b.kunde_id$/);
    assert.ok(seek.props.some(([k, v]) => k === 'ActualExecutions' && v === '66666'));
    assert.ok(seek.props.some(([k, v]) => k === 'ActualRows' && v === '66666'));
    assert.ok(seek.props.some(([k, v]) => k === 'Threads' && v === '23'));
    near(seek.timeMs, 11, 1e-9, 'parallel: die längste Thread-Zeit');
    const scan = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.equal(scan.loops, 1, 'der Scan läuft in jedem Thread einmal, die Threads teilen sich die Zeilen');
    assert.equal(scan.actualRows, 66666);
    near(scan.timeMs, 10);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/, 'Summe der gelesenen Zeilen aller Threads');
    const nl = find(p, (n) => n.op === 'Nested Loops (Inner Join)');
    assert.equal(nl.actualRows, 66666);
    near(nl.timeMs, 26);
    near(nl.selfMs, 26 - 10 - 11);
    const partial = find(p, (n) => n.op === 'Hash Match (Partial Aggregate)');
    assert.equal(partial.actualRows, 72, '4 Gruppen in 18 Threads');
    assert.equal(partial.rows, 44);
    assert.equal(p.root?.actualRows, 4);
    near(p.root?.timeMs, 35);
    // kein Schritt länger als der darüber (Scan 10 ms und Seek 11 ms liegen beide unter den 26 ms der Nested Loop)
    timesNest(p);
    shares(p, 'time');
    near(seek.share, 11 / 35, 1e-9);
    near(scan.share, 10 / 35, 1e-9);
    near(nl.share, 5 / 35, 1e-9);
    near(selfSum(p), 35, 1e-9);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: SQL Server paralleler Plan ohne Laufzeit (SHOWPLAN_XML): Seek 91,6 % der Kosten, keine Durchläufe', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-explain-parallel.xml')], false)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.root?.op, 'Parallelism (Gather Streams)');
    near(p.totalCost, 11.7541);
    shares(p, 'cost');
    const seek = find(p, (n) => n.op === 'Clustered Index Seek');
    // Kosten des Seek gelten schon für alle Ausführungen (10,7618 von 11,7541), sie werden nicht noch mit den Zeilen der äußeren Seite vervielfacht
    near(seek.share, 10.7618 / 11.7541, 1e-9);
    assert.equal(seek.loops, undefined);
    assert.equal(seek.actualRows, undefined);
    near(find(p, (n) => n.op === 'Clustered Index Scan').share, 0.832028 / 11.7541, 1e-9);
    assert.ok(nodes(p.root).every((n) => n.timeMs === undefined));
  });

  await step('F296: SQL Server paralleler Plan, DOP 2: der Seek läuft in zwei Threads je 20-mal – 40 Durchläufe (Summe), nicht 20 (Maximum) (F167)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-parallel-dop2.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlDop2);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      [
        'Compute Scalar',
        'Parallelism (Gather Streams)',
        'Stream Aggregate (Aggregate)',
        'Sort',
        'Parallelism (Repartition Streams)',
        'Nested Loops (Inner Join)',
        'Stream Aggregate (Aggregate)',
        'Sort',
        'Parallelism (Repartition Streams)',
        'Clustered Index Scan',
        'Clustered Index Seek',
      ],
    );
    const seek = find(p, (n) => n.op === 'Clustered Index Seek');
    assert.equal(seek.loops, 40, 'Threads 20 + 20 (+ 0 des Koordinators)');
    assert.equal(seek.actualRows, 1, '40 Zeilen auf 40 Durchläufe');
    assert.ok(seek.props.some(([k, v]) => k === 'ActualExecutions' && v === '40'));
    assert.ok(seek.props.some(([k, v]) => k === 'Threads' && v === '3'));
    const scan = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.equal(scan.loops, 1, 'der Scan läuft in jedem Thread einmal');
    assert.equal(scan.actualRows, 400);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    near(p.executionMs, 7);
    near(p.planningMs, 5);
    near(scan.timeMs, 5);
    noNegative(p);
    timesNest(p);
    shares(p, 'time');
    near(scan.share, 5 / 13, 1e-9);
    near(find(p, (n) => n.op === 'Parallelism (Gather Streams)').share, 7 / 13, 1e-9);
    near(selfSum(p), 13, 1e-9);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: SQL Server TOP 10 ohne Zeilenziel: Scan schätzt 66 667 Zeilen, liefert 10 – unter Top kein „zu hoch“ (F284)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-top.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlTop);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Top', 'Clustered Index Scan'],
    );
    const scan = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.equal(scan.rows, 66667);
    assert.equal(scan.actualRows, 10);
    assert.equal(scan.loops, 1);
    assert.equal(scan.warnings.length, 0, 'nur wenige Zeilen gelesen: auch kein „ganze Tabelle“');
    assert.deepEqual(misestimated(p), []);
    near(p.executionMs, 0);
    shares(p, 'cost');
    // ohne Top (hier ein Compute Scalar an der Stelle) wäre es eine Fehlschätzung
    const bare = mssqlPlans([swapped(fixture('plan-mssql2022-analyze-top.xml'), 'PhysicalOp="Top" LogicalOp="Top"', 'PhysicalOp="Compute Scalar" LogicalOp="Compute Scalar"')], true)[0];
    assert.match(warn(find(bare, (n) => n.op === 'Clustered Index Scan')), /Schätzung zu hoch: 66\W667 statt 10 Zeilen \(6\W061×\)/);
  });

  await step('F296: SQL Server EXISTS (Left Semi Join) ohne Zeilenziel: Seek schätzt 5 000 je Durchlauf, findet 1 – kein „zu hoch“ (F284)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-exists.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlExists);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Compute Scalar', 'Stream Aggregate (Aggregate)', 'Nested Loops (Left Semi Join)', 'Clustered Index Scan', 'Index Seek'],
    );
    const seek = find(p, (n) => n.op === 'Index Seek');
    assert.equal(seek.detail, 'fx_kunden k (ix_fx_ort) · Seek: k.ort = o.name');
    assert.equal(seek.rows, 5000);
    assert.equal(seek.actualRows, 1);
    assert.equal(seek.loops, 4);
    assert.equal(seek.warnings.length, 0);
    assert.deepEqual(misestimated(p), []);
    shares(p, 'cost');
    // als Inner Join gelesen wäre es eine Fehlschätzung
    const inner = mssqlPlans([swapped(fixture('plan-mssql2022-analyze-exists.xml'), 'LogicalOp="Left Semi Join"', 'LogicalOp="Inner Join"')], true)[0];
    assert.match(warn(find(inner, (n) => n.op === 'Index Seek')), /Schätzung zu hoch: 5\W000 statt 1 Zeilen \(2\W501×\)/);
  });

  await step('F296: SQL Server Merge Join: Index Scan schätzt 200 000 und liest 3 011, Aggregat 19 809 statt 301 – darunter kein „zu hoch“ (F284)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-mergejoin.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlMerge);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Compute Scalar', 'Stream Aggregate (Aggregate)', 'Merge Join (Inner Join)', 'Clustered Index Scan', 'Stream Aggregate (Aggregate)', 'Index Scan'],
    );
    const idx = find(p, (n) => n.op === 'Index Scan');
    assert.equal(idx.rows, 200000);
    assert.equal(idx.actualRows, 3011);
    assert.equal(idx.warnings.length, 0, '3 011 gelesen');
    const agg = find(p, (n) => n.op === 'Stream Aggregate (Aggregate)' && n.rows === 19809);
    assert.equal(agg.actualRows, 301);
    assert.deepEqual(misestimated(p), []);
    // die äußere Seite liest dagegen wirklich alle 20 000 Zeilen (der Filter aktiv = 0 prüft jede): der Hinweis bleibt
    assert.match(warn(find(p, (n) => n.op === 'Clustered Index Scan')), /Liest die ganze Tabelle \(20\W000 Zeilen\)/);
    near(p.executionMs, 1);
    shares(p, 'time');
    // als Hash Match gelesen wären beide Schätzungen Fehlschätzungen (je 66-fach)
    const hash = mssqlPlans([swapped(fixture('plan-mssql2022-analyze-mergejoin.xml'), 'PhysicalOp="Merge Join"', 'PhysicalOp="Hash Match"')], true)[0];
    assert.deepEqual(misestimated(hash), ['Stream Aggregate (Aggregate)', 'Index Scan']);
    assert.match(warn(find(hash, (n) => n.op === 'Index Scan')), /Schätzung zu hoch: 200\W000 statt 3\W011 Zeilen \(66×\)/);
  });

  await step('F296: SQL Server Adaptive Join (Batch-Modus): drei Eingänge, der nicht gewählte Seek läuft nie (0 Durchläufe, keine Warnung)', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-adaptive.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.equal(p.sql, FX.mssqlAdaptive);
    assert.deepEqual(
      nodes(p.root).map((n) => n.op),
      ['Compute Scalar', 'Hash Match (Aggregate)', 'Adaptive Join (Inner Join)', 'Clustered Index Scan', 'Index Scan', 'Clustered Index Seek'],
    );
    const join = find(p, (n) => n.op === 'Adaptive Join (Inner Join)');
    assert.equal(join.children.length, 3);
    const [build, probe, seek] = join.children;
    assert.equal(seek.op, 'Clustered Index Seek');
    assert.equal(seek.rows, 1);
    assert.equal(seek.loops, 0, 'der Wechsel zur Nested Loop kam nicht');
    assert.equal(seek.actualRows, 0);
    assert.equal(seek.warnings.length, 0);
    assert.match(build.detail ?? '', /^fx_bestellungen b \(PK__\w+\) · Filter: b.betrag>/);
    assert.equal(build.actualRows, 12366);
    assert.match(probe.detail ?? '', /^fx_kunden k \(ix_fx_ort\) · Filter: PROBE\(Opt_Bitmap\d+,k.id\)$/);
    assert.equal(probe.actualRows, 12366, 'Bitmap-Filter: nur Zeilen mit Treffer');
    // Batch-Modus: jeder Schritt meldet seine eigene Zeit
    near(build.selfMs, 13);
    near(probe.selfMs, 2);
    near(p.executionMs, 18);
    near(p.planningMs, 6);
    shares(p, 'time');
    near(build.share, 13 / 15, 1e-9);
    near(probe.share, 2 / 15, 1e-9);
    assert.equal(seek.share, 0);
    assert.deepEqual(misestimated(p), []);
  });

  await step('F296: SQL Server Batch mit zwei Anweisungen (SHOWPLAN_XML): ein Dokument, zwei Pläne mit eigenem SQL und eigenen Kosten', () => {
    const plans = mssqlPlans([fixture('plan-mssql2022-explain-batch.xml')], false);
    assert.equal(plans.length, 2);
    assert.deepEqual(
      plans.map((s) => s.sql),
      FX.mssqlBatch.split('\n'),
    );
    assert.deepEqual(
      nodes(plans[0].root).map((n) => n.op),
      ['Compute Scalar', 'Stream Aggregate (Aggregate)', 'Index Scan'],
    );
    assert.deepEqual(
      nodes(plans[1].root).map((n) => n.op),
      ['Hash Match (Aggregate)', 'Clustered Index Scan'],
    );
    near(plans[0].totalCost, 0.0817269);
    near(plans[1].totalCost, 1.05105);
    near(plans[0].planningMs, 0);
    near(plans[1].planningMs, 2);
    for (const p of plans) shares(p, 'cost');
    near(plans[1].root?.share, (1.05105 - 1.03217) / 1.05105, 1e-9);
    near(find(plans[1], (n) => n.op === 'Clustered Index Scan').share, 1.03217 / 1.05105, 1e-9);
    near(find(plans[0], (n) => n.op === 'Index Scan').share, 0.0697264 / 0.0817269, 1e-9);
    near(find(plans[0], (n) => n.op === 'Stream Aggregate (Aggregate)').share, (0.0817269 - 0.0697264) / 0.0817269, 1e-9);
    assert.match(warn(find(plans[1], (n) => n.op === 'Clustered Index Scan')), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    assert.match(plans[0].raw ?? '', /MAX\(betrag\)/, 'beide Anweisungen stehen im einen Dokument');
    assert.equal(plans[0].raw, plans[1].raw);
  });

  await step('F296: SQL Server Batch mit zwei Anweisungen (STATISTICS XML): zwei Dokumente, Zeiten je Anweisung', () => {
    const plans = mssqlPlans([fixture('plan-mssql2022-analyze-batch-1.xml'), fixture('plan-mssql2022-analyze-batch-2.xml')], true);
    assert.equal(plans.length, 2);
    assert.deepEqual(
      plans.map((s) => s.sql),
      FX.mssqlBatch.split('\n'),
    );
    near(plans[0].executionMs, 2);
    near(plans[1].executionMs, 21);
    const scan = find(plans[1], (n) => n.op === 'Clustered Index Scan');
    assert.equal(scan.actualRows, 200000);
    assert.equal(scan.loops, 1);
    near(scan.timeMs, 20);
    near(find(plans[1], (n) => n.op === 'Hash Match (Aggregate)').selfMs, 1);
    near(scan.share, 20 / 21, 1e-9);
    near(find(plans[0], (n) => n.op === 'Index Scan').share, 0.5);
    for (const p of plans) shares(p, 'time');
    assert.doesNotMatch(plans[0].raw ?? '', /MAX\(betrag\)/, 'jede Rohausgabe nur mit ihrer Anweisung');
    assert.doesNotMatch(plans[1].raw ?? '', /COUNT\(\*\) AS n/);
  });

  await step('F296: SQL Server fehlender Index bei tatsächlichem Plan: 75,2 % günstiger, nur [betrag] im INCLUDE', () => {
    const p = mssqlPlans([fixture('plan-mssql2022-analyze-missingindex.xml')], true)[0];
    assert.equal(p.error, undefined);
    assert.deepEqual(p.notes, [
      'Fehlender Index (laut SQL Server 75.2 % günstiger): CREATE NONCLUSTERED INDEX [IX_fx_bestellungen_status] ON [dbo].[fx_bestellungen] ([status]) INCLUDE ([betrag])',
    ]);
    const scan = find(p, (n) => n.op === 'Clustered Index Scan');
    assert.match(scan.detail ?? '', /Filter: fx_bestellungen.status=N'storniert'$/);
    assert.equal(scan.actualRows, 66667);
    assert.match(warn(scan), /Liest die ganze Tabelle \(200\W000 Zeilen\)/);
    near(p.executionMs, 29);
    shares(p, 'time');
    near(scan.share, 22 / 29, 1e-9);
    assert.deepEqual(misestimated(p), []);
  });
}

/* ---------------------------------------------------------------- mit Datenbanken ---- */

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbv-plan-'));
const store = new ConnectionStore(path.join(dir, 'c.json'), { encrypt: (s) => 'x' + s, decrypt: (s) => s.slice(1) });
const m = new Manager(store, undefined, 0);

type Target = 'mysql' | 'mariadb' | 'postgres' | 'mssql';
const targets: Record<Target, { dialect: SqlDialect; port: number; user: string; password: string; db: string }> = {
  mysql: { dialect: 'mysql', port: 15306, user: 'root', password: 'dbviewer-test', db: 'plantest' },
  mariadb: { dialect: 'mysql', port: 15307, user: 'root', password: 'dbviewer-test', db: 'plantest' },
  postgres: { dialect: 'postgres', port: 15432, user: 'postgres', password: 'dbviewer-test', db: 'postgres' },
  mssql: { dialect: 'mssql', port: 15433, user: 'sa', password: 'Dbviewer-Test1', db: 'plantest' },
};

function input(t: Target, readOnly = false): ConnectionInput {
  const x = targets[t];
  return {
    name: t + (readOnly ? ' (nur lesen)' : ''),
    dialect: x.dialect,
    host: '127.0.0.1',
    port: x.port,
    user: x.user,
    password: x.password,
    database: x.dialect === 'postgres' ? 'postgres' : undefined,
    options: { ...(x.dialect === 'mssql' ? { trustServerCertificate: true } : {}), readOnly },
  };
}

const DIGITS = '(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
const MYSQL_NUMBERS = `(SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n FROM ${DIGITS} a CROSS JOIN ${DIGITS} b CROSS JOIN ${DIGITS} c CROSS JOIN ${DIGITS} e CROSS JOIN (SELECT 0 d UNION ALL SELECT 1) f)`;
const MSSQL_NUMBERS = (n: number) => `(SELECT TOP (${n}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b)`;

/** 3 000 Kunden, 12 000 Bestellungen (status ohne Index: Lesen der ganzen Tabelle) */
const setup: Record<SqlDialect, string[]> = {
  mysql: [
    'DROP TABLE IF EXISTS pl_bestellungen, pl_kunden',
    'CREATE TABLE pl_kunden (id INT PRIMARY KEY, ort VARCHAR(20) NOT NULL, aktiv TINYINT NOT NULL, KEY ix_pl_ort (ort))',
    'CREATE TABLE pl_bestellungen (id INT PRIMARY KEY, kunde_id INT NOT NULL, status VARCHAR(10) NOT NULL, betrag DECIMAL(10,2) NOT NULL, KEY ix_pl_kunde (kunde_id))',
    `INSERT INTO pl_kunden SELECT n, ELT(1 + n % 4, 'Bern', 'Basel', 'Zürich', 'Luzern'), n % 5 <> 0 FROM ${MYSQL_NUMBERS} x WHERE n <= 3000`,
    `INSERT INTO pl_bestellungen SELECT n, 1 + n % 3000, ELT(1 + n % 3, 'offen', 'bezahlt', 'storniert'), 10 + n % 97 FROM ${MYSQL_NUMBERS} x WHERE n <= 12000`,
    'ANALYZE TABLE pl_kunden, pl_bestellungen',
  ],
  postgres: [
    'DROP TABLE IF EXISTS pl_bestellungen, pl_kunden',
    'CREATE TABLE pl_kunden (id int PRIMARY KEY, ort varchar(20) NOT NULL, aktiv boolean NOT NULL)',
    'CREATE INDEX ix_pl_ort ON pl_kunden (ort)',
    'CREATE TABLE pl_bestellungen (id int PRIMARY KEY, kunde_id int NOT NULL, status varchar(10) NOT NULL, betrag numeric(10,2) NOT NULL)',
    'CREATE INDEX ix_pl_kunde ON pl_bestellungen (kunde_id)',
    "INSERT INTO pl_kunden SELECT n, (ARRAY['Bern','Basel','Zürich','Luzern'])[1 + n % 4], n % 5 <> 0 FROM generate_series(1, 3000) n",
    "INSERT INTO pl_bestellungen SELECT n, 1 + n % 3000, (ARRAY['offen','bezahlt','storniert'])[1 + n % 3], 10 + n % 97 FROM generate_series(1, 12000) n",
    'ANALYZE pl_kunden, pl_bestellungen',
  ],
  mssql: [
    "IF OBJECT_ID('dbo.pl_bestellungen') IS NOT NULL DROP TABLE dbo.pl_bestellungen",
    "IF OBJECT_ID('dbo.pl_kunden') IS NOT NULL DROP TABLE dbo.pl_kunden",
    'CREATE TABLE dbo.pl_kunden (id int PRIMARY KEY, ort nvarchar(20) NOT NULL, aktiv bit NOT NULL, INDEX ix_pl_ort (ort))',
    'CREATE TABLE dbo.pl_bestellungen (id int PRIMARY KEY, kunde_id int NOT NULL, status nvarchar(10) NOT NULL, betrag decimal(10,2) NOT NULL, INDEX ix_pl_kunde (kunde_id))',
    `INSERT INTO dbo.pl_kunden SELECT n, CHOOSE(1 + n % 4, N'Bern', N'Basel', N'Zürich', N'Luzern'), CASE WHEN n % 5 <> 0 THEN 1 ELSE 0 END FROM ${MSSQL_NUMBERS(3000)} x`,
    `INSERT INTO dbo.pl_bestellungen SELECT n, 1 + n % 3000, CHOOSE(1 + n % 3, N'offen', N'bezahlt', N'storniert'), 10 + n % 97 FROM ${MSSQL_NUMBERS(12000)} x`,
    'UPDATE STATISTICS dbo.pl_kunden',
    'UPDATE STATISTICS dbo.pl_bestellungen',
  ],
};

const JOIN =
  "SELECT k.ort, COUNT(*) AS n, SUM(b.betrag) AS summe FROM pl_bestellungen b JOIN pl_kunden k ON k.id = b.kunde_id WHERE b.status = 'offen' GROUP BY k.ort ORDER BY summe DESC";
const SCAN = "SELECT COUNT(*) AS n FROM pl_bestellungen WHERE status = 'storniert'";
const UPDATE = "UPDATE pl_kunden SET ort = 'Genf' WHERE id = 7";
const NO_PLAN: Record<SqlDialect, string> = { mysql: 'SHOW TABLES', postgres: 'SHOW search_path', mssql: 'DECLARE @x int' };

const stmts = (...sql: string[]) => sql.map((s) => ({ sql: s, offset: 0 }));

async function exec(sessionId: string, sql: string[]) {
  const r = await m.runQuery(sessionId, stmts(...sql), 10);
  const err = r.statements.find((s) => s.error);
  if (err) throw new Error(`${err.sql.slice(0, 80)}: ${err.error}`);
  return r;
}

async function ort7(sessionId: string): Promise<unknown> {
  const r = await exec(sessionId, ['SELECT ort FROM pl_kunden WHERE id = 7']);
  return r.results[0].rows[0][0];
}

function single(p: QueryPlan): StatementPlan {
  assert.equal(p.statements.length, 1, JSON.stringify(p.statements.map((s) => s.error ?? s.sql)));
  const s = p.statements[0];
  assert.equal(s.error, undefined, s.error);
  assert.ok(s.root, 'kein Baum');
  return s;
}

async function dbTests(t: Target) {
  const x = targets[t];
  console.log(`\n${t}`);
  const c = await store.save(input(t));
  // Datenbank anlegen (PostgreSQL: Tabellen in postgres)
  if (x.db !== 'postgres') {
    const s0 = await m.openSession(c.id);
    await exec(s0.sessionId, [x.dialect === 'mssql' ? "IF DB_ID('plantest') IS NULL CREATE DATABASE plantest" : 'CREATE DATABASE IF NOT EXISTS plantest']);
    await m.closeSession(s0.sessionId);
  }
  const { sessionId } = await m.openSession(c.id, x.db);
  await step('Testtabellen anlegen', () => exec(sessionId, setup[x.dialect]));

  await step('geschätzter Plan eines Joins: Baum, Anteile nach Kosten', async () => {
    const s = single(await m.explainQuery(sessionId, stmts(JOIN), false));
    if (t !== 'mariadb' || s.shareBy) {
      assert.equal(s.shareBy, 'cost');
      assert.ok(Math.abs(shareSum(s) - 1) < 1e-9, String(shareSum(s)));
    }
    assert.ok(nodes(s.root).length >= 3);
    assert.ok(nodes(s.root).some((n) => n.rows !== undefined));
    assert.ok(s.raw && s.raw.length > 50);
    assert.equal(s.rawFormat, t === 'mssql' ? 'xml' : t === 'postgres' || t === 'mariadb' ? 'json' : 'text');
  });

  await step('Plan mit Laufzeit: tatsächliche Zeilen, Anteile', async () => {
    const p = await m.explainQuery(sessionId, stmts(JOIN), true);
    assert.equal(p.analyzed, true);
    const s = single(p);
    const all = nodes(s.root);
    assert.ok(all.some((n) => n.actualRows !== undefined && n.loops), 'keine tatsächlichen Zeilen');
    // SQL Server misst ganze Millisekunden: bei kleinen Abfragen evtl. überall 0 → dann nach Kosten
    assert.ok(s.shareBy === 'time' || (t === 'mssql' && s.shareBy === 'cost'), String(s.shareBy));
    assert.ok(Math.abs(shareSum(s) - 1) < 1e-9, String(shareSum(s)));
    assert.ok(s.executionMs !== undefined || t === 'mysql', 'keine Ausführungszeit');
  });

  await step('Lesen der ganzen Tabelle wird erwähnt (12 000 Zeilen)', async () => {
    const s = single(await m.explainQuery(sessionId, stmts(SCAN), true));
    const hit = nodes(s.root).find((n) => n.warnings.some((w) => /Liest die ganze Tabelle/.test(w)));
    assert.ok(hit, nodes(s.root).map((n) => `${n.op}: ${n.warnings.join('; ')}`).join('\n'));
  });

  await step('geschätzter Plan eines UPDATE ändert nichts', async () => {
    assert.equal(await ort7(sessionId), 'Luzern');
    const s = single(await m.explainQuery(sessionId, stmts(UPDATE), false));
    assert.ok(nodes(s.root).length >= 1);
    assert.equal(await ort7(sessionId), 'Luzern');
  });

  await step('ohne Plan: Fehler je Anweisung, die nächste kommt trotzdem', async () => {
    const p = await m.explainQuery(sessionId, stmts(NO_PLAN[x.dialect], SCAN), false);
    assert.equal(p.statements.length, 2);
    assert.ok(p.statements[0].error, 'Fehler erwartet');
    assert.ok(p.statements[1].root, p.statements[1].error);
  });

  if (x.dialect === 'postgres') {
    await step('PostgreSQL: Fehler im Plan bricht eine offene Transaktion nicht ab (Savepoint)', async () => {
      await exec(sessionId, ['BEGIN']);
      const p = await m.explainQuery(sessionId, stmts('SHOW search_path', SCAN), false);
      assert.ok(p.statements[0].error, 'Fehler erwartet');
      assert.ok(p.statements[1].root, p.statements[1].error);
      assert.equal(p.inTransaction, true);
      await exec(sessionId, ['SELECT 1']);
      await exec(sessionId, ['ROLLBACK']);
    });
  }

  await step('danach normale Ausführung (kein Plan-Modus mehr)', async () => {
    const r = await exec(sessionId, ['SELECT COUNT(*) AS n FROM pl_kunden']);
    assert.equal(Number(r.results[0].rows[0][0]), 3000);
    assert.equal(r.results[0].columns[0].name, 'n');
  });

  if (x.dialect === 'mssql') {
    await step('SQL Server: zwei Anweisungen in einem Batch → zwei Pläne, ohne Kennzeichen-Prüfung', async () => {
      const p = await m.explainQuery(sessionId, stmts('SELECT COUNT(*) FROM pl_kunden\nSELECT MAX(betrag) FROM pl_bestellungen'), false);
      assert.deepEqual(
        p.statements.map((s) => s.sql),
        ['SELECT COUNT(*) FROM pl_kunden', 'SELECT MAX(betrag) FROM pl_bestellungen'],
      );
      assert.ok(p.statements.every((s) => s.root && !/SESSION_CONTEXT/.test(s.sql) && !/SESSION_CONTEXT/.test(s.raw ?? '')));
      const a = await m.explainQuery(sessionId, stmts('SELECT COUNT(*) FROM pl_kunden\nSELECT MAX(betrag) FROM pl_bestellungen'), true);
      assert.equal(a.statements.length, 2);
    });
  }

  await step('Plan mit Laufzeit steht im Verlauf', async () => {
    const h = await m.listHistory({ connectionId: c.id });
    assert.ok(h.some((e) => e.info === 'Plan mit Laufzeit' && e.sql === JOIN));
  });
  await m.closeSession(sessionId);

  // Nur lesen
  const ro = await store.save(input(t, true));
  const r = await m.openSession(ro.id, x.db);
  await step('Nur lesen: Plan eines SELECT geht, auch mit Laufzeit', async () => {
    single(await m.explainQuery(r.sessionId, stmts(JOIN), false));
    single(await m.explainQuery(r.sessionId, stmts(JOIN), true));
  });
  await step('Nur lesen: Plan eines UPDATE abgelehnt (mit und ohne Laufzeit), nichts geändert', async () => {
    for (const analyze of [false, true]) {
      const p = await m.explainQuery(r.sessionId, stmts(UPDATE), analyze);
      assert.match(p.statements[0]?.error ?? '', /Nur lesen/);
    }
    assert.equal(await ort7(r.sessionId), 'Luzern');
  });
  await m.closeSession(r.sessionId);
}

async function main() {
  await unitTests();
  await recordedTests();
  const only = process.argv[2];
  // ohne Datenbanken und ohne Docker: nur die festen Beispiele und die aufgezeichneten Ausgaben
  if (only === 'offline') {
    console.log(failed ? `\n${failed} fehlgeschlagen` : '\nalles ok');
    process.exit(failed ? 1 : 0);
  }
  // ein Tippfehler im Argument ergab sonst eine leere Liste, keinen Test und „alles ok“
  if (only && !(only in targets)) {
    console.error(`Unbekanntes Argument „${only}“ – möglich: offline, ${Object.keys(targets).join(', ')}`);
    process.exit(1);
  }
  const list = (Object.keys(targets) as Target[]).filter((t) => !only || t === only);
  assertTestContainers(list.map((t) => ({ name: t, host: '127.0.0.1', port: targets[t].port })));
  for (const t of list) {
    try {
      await dbTests(t);
    } catch (e) {
      failed++;
      console.log(`  FEHL ${t}: ${(e as Error).message}`);
    }
  }
  await m.shutdown();
  console.log(failed ? `\n${failed} fehlgeschlagen` : '\nalles ok');
  process.exit(failed ? 1 : 0);
}

void main();
