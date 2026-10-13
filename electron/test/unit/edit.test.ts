/* Reine Logik ohne Datenbank (npm run test:unit): Bearbeiten in der Tabellenansicht – Änderungsliste
   (shared/edit-state.ts) und die Anweisungen daraus (electron/edit.ts buildWrites) für alle drei Dialekte */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColumnInfo, Dialect, ObjectRef, RowChange, TableInfo } from '../../../shared/api-types';
import { EditState, sameCell, type EditRow } from '../../../shared/edit-state';
import { buildWrites } from '../../edit';

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  nullable: true,
  defaultValue: null,
  primaryKey: false,
  autoIncrement: false,
  ...extra,
});
const ref = (d: Dialect, name = 'kunde'): ObjectRef => ({ connectionId: 'c', database: 'shop', schema: d === 'mysql' ? '' : d === 'postgres' ? 'public' : 'dbo', name, kind: 'table' });
const table = (columns: ColumnInfo[], indexes: TableInfo['indexes'] = []): TableInfo => ({ columns, indexes, foreignKeys: [], referencedBy: [] });

const KUNDE = table(
  [col('id', 'int', { nullable: false, primaryKey: true, autoIncrement: true }), col('name', 'varchar(50)'), col('ort', 'varchar(50)'), col('geaendert', 'datetime'), col('betrag', 'decimal(10,2)')],
  [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }],
);
const COLS = KUNDE.columns.map((c) => c.name);
const row = (id: number, name: string): EditRow => [id, name, 'Bern', '2024-01-02 10:00:00', 12.5];

// ---------- Änderungsliste ----------

test('Zelle ändern und zurück: nur echte Änderungen zählen (12 und "12" sind gleich)', () => {
  const s = new EditState();
  const r = row(1, 'Meier');
  r[1] = 'Müller';
  s.cellEdited(r, 1, 'Müller', 'Meier');
  assert.equal(s.pending, 1);
  assert.equal(s.rowState(r), 'changed');
  assert.ok(s.isChanged(r, 1));
  assert.ok(!s.isChanged(r, 2));
  // als Text eingegebene Zahl: keine Änderung
  r[4] = '12.5';
  s.cellEdited(r, 4, '12.5', 12.5);
  assert.ok(!s.isChanged(r, 4));
  // zurück auf den Ausgangswert: nichts mehr offen
  r[1] = 'Meier';
  s.cellEdited(r, 1, 'Meier', 'Müller');
  assert.equal(s.pending, 0);
  assert.equal(s.rowState(r), null);
  assert.deepEqual(s.changes(COLS, ['id']), []);
  assert.ok(sameCell(12, '12') && !sameCell(null, 'null') && !sameCell('', null) && sameCell(undefined, undefined));
});

test('Ändern: über den ursprünglichen Schlüssel (auch wenn er geändert wird), nur geänderte Spalten samt Ausgangswert', () => {
  const s = new EditState();
  const r = row(7, 'Meier');
  r[0] = 8;
  s.cellEdited(r, 0, 8, 7);
  r[1] = 'Müller';
  s.cellEdited(r, 1, 'Müller', 'Meier');
  // dieselbe Zelle zweimal: Ausgangswert bleibt der erste
  r[1] = 'Huber';
  s.cellEdited(r, 1, 'Huber', 'Müller');
  assert.equal(s.pending, 1);
  assert.deepEqual(s.changes(COLS, ['id']), [{ kind: 'update', key: { id: 7 }, values: { id: 8, name: 'Huber' }, original: { id: 7, name: 'Meier' } }]);
});

test('Neue Zeile: nur gesetzte Spalten, ausdrücklich NULL zählt mit; Löschen nimmt sie ganz weg', () => {
  const s = new EditState();
  const n: EditRow = COLS.map(() => undefined);
  s.add(n);
  n[1] = 'Neu';
  s.cellEdited(n, 1, 'Neu', undefined);
  assert.ok(s.setNull(n, 2));
  assert.equal(s.rowState(n), 'new');
  assert.ok(s.isChanged(n, 1) && s.isChanged(n, 2) && !s.isChanged(n, 0));
  assert.deepEqual(s.changes(COLS, ['id']), [{ kind: 'insert', values: { name: 'Neu', ort: null } }]);
  assert.deepEqual(s.delete([n]), [n], 'aus dem Grid nehmen');
  assert.equal(s.pending, 0);
  assert.deepEqual(s.changes(COLS, ['id']), []);
});

test('Löschen über den ursprünglichen Schlüssel – auch nach einer Änderung; Verwerfen stellt die Zeile wieder her', () => {
  const s = new EditState();
  const r = row(3, 'A');
  r[0] = 33;
  s.cellEdited(r, 0, 33, 3);
  assert.deepEqual(s.delete([r]), []);
  assert.equal(s.rowState(r), 'deleted');
  assert.deepEqual(s.changes(COLS, ['id']), [{ kind: 'delete', key: { id: 3 } }], 'kein UPDATE für eine gelöschte Zeile');
  assert.deepEqual(s.revert([r]), []);
  assert.deepEqual(r, row(3, 'A'));
  assert.equal(s.pending, 0);
});

test('NULL setzen, alles verwerfen, mehrspaltiger Schlüssel', () => {
  const s = new EditState();
  const r: EditRow = [1, null, 'x'];
  assert.equal(s.setNull(r, 1), false, 'schon NULL');
  assert.equal(s.pending, 0);
  assert.ok(s.setNull(r, 2));
  const n: EditRow = [undefined, undefined, undefined];
  s.add(n);
  assert.deepEqual(s.changes(['a', 'b', 'c'], ['a', 'b']), [
    { kind: 'update', key: { a: 1, b: null }, values: { c: null }, original: { c: 'x' } },
    { kind: 'insert', values: {} },
  ]);
  assert.deepEqual(s.discard(), [n]);
  assert.deepEqual(r, [1, null, 'x']);
  assert.equal(s.pending, 0);
});

// ---------- Anweisungen daraus ----------

/** eine Änderung, eine Löschung, eine neue Zeile – in beliebiger Reihenfolge erfasst */
function sample(): RowChange[] {
  const s = new EditState();
  const n: EditRow = COLS.map(() => undefined);
  s.add(n);
  n[1] = "O'Neil";
  s.cellEdited(n, 1, "O'Neil", undefined);
  const u = row(7, 'Meier');
  u[1] = 'Müller';
  s.cellEdited(u, 1, 'Müller', 'Meier');
  u[3] = '2024-02-03 00:00:00';
  s.cellEdited(u, 3, '2024-02-03 00:00:00', '2024-01-02 10:00:00');
  const d = row(3, 'A');
  s.delete([d]);
  return s.changes(COLS, ['id']);
}

test('buildWrites: löschen, ändern, einfügen – Parameter und Vorschau je Dialekt', () => {
  const expect: Record<'mysql' | 'postgres' | 'mssql', { sql: string[]; preview: string[] }> = {
    mysql: {
      sql: [
        'DELETE FROM `shop`.`kunde` WHERE `id` = ?',
        'UPDATE `shop`.`kunde` SET `name` = ?, `geaendert` = ? WHERE `id` = ? AND `name` = ?',
        'INSERT INTO `shop`.`kunde` (`name`) VALUES (?)',
      ],
      preview: [
        'DELETE FROM `shop`.`kunde` WHERE `id` = 3;',
        "UPDATE `shop`.`kunde` SET `name` = 'Müller', `geaendert` = '2024-02-03 00:00:00' WHERE `id` = 7 AND `name` = 'Meier';",
        "INSERT INTO `shop`.`kunde` (`name`) VALUES ('O''Neil');",
      ],
    },
    postgres: {
      sql: [
        'DELETE FROM public.kunde WHERE id = $1',
        'UPDATE public.kunde SET name = $1, geaendert = $2 WHERE id = $3 AND name = $4',
        'INSERT INTO public.kunde (name) VALUES ($1)',
      ],
      preview: [
        'DELETE FROM public.kunde WHERE id = 3;',
        "UPDATE public.kunde SET name = 'Müller', geaendert = '2024-02-03 00:00:00' WHERE id = 7 AND name = 'Meier';",
        "INSERT INTO public.kunde (name) VALUES ('O''Neil');",
      ],
    },
    mssql: {
      sql: [
        'DELETE FROM [shop].[dbo].[kunde] WHERE [id] = @p1',
        'UPDATE [shop].[dbo].[kunde] SET [name] = @p1, [geaendert] = @p2 WHERE [id] = @p3 AND [name] = @p4',
        'INSERT INTO [shop].[dbo].[kunde] ([name]) VALUES (@p1)',
      ],
      preview: [
        'DELETE FROM [shop].[dbo].[kunde] WHERE [id] = 3;',
        "UPDATE [shop].[dbo].[kunde] SET [name] = N'Müller', [geaendert] = N'2024-02-03T00:00:00' WHERE [id] = 7 AND [name] = N'Meier';",
        "INSERT INTO [shop].[dbo].[kunde] ([name]) VALUES (N'O''Neil');",
      ],
    },
  };
  for (const d of ['mysql', 'postgres', 'mssql'] as const) {
    const w = buildWrites(d, ref(d), KUNDE, sample());
    assert.deepEqual(
      w.ops.map((o) => o.sql),
      expect[d].sql,
      d,
    );
    assert.deepEqual(w.preview, expect[d].preview, d);
    // Datumsspalte geändert: ihr alter Wert steht nicht im WHERE (Bruchteile/Zeitzone vergleichen sich nicht exakt)
    // SQL Server bekommt das Datum mit T (ohne T las der Server es je nach Spracheinstellung als Tag-Monat)
    assert.deepEqual(w.ops[1].params, ['Müller', d === 'mssql' ? '2024-02-03T00:00:00' : '2024-02-03 00:00:00', 7, 'Meier'], d);
    assert.ok(w.ops.every((o) => o.expect === 1), 'jede Anweisung trifft genau eine Zeile');
    assert.deepEqual(
      w.ops.map((o) => o.label),
      ['Löschen (id = 3)', 'Ändern (id = 7)', 'Einfügen'],
    );
  }
});

test('buildWrites: mehrspaltiger Schlüssel, eindeutiger Index als Ersatz, Schlüssel ändern, NULL im alten Wert', () => {
  const pos = table([col('bestellung', 'int', { nullable: false }), col('pos', 'int', { nullable: false }), col('menge', 'int')], [
    { name: 'pk', columns: ['bestellung', 'pos'], unique: true, primary: true },
  ]);
  const w = buildWrites('postgres', ref('postgres', 'pos'), pos, [{ kind: 'update', key: { bestellung: 1, pos: 2 }, values: { pos: 3, menge: 5 }, original: { pos: 2, menge: null } }]);
  assert.deepEqual(w.preview, ['UPDATE public.pos SET pos = 3, menge = 5 WHERE bestellung = 1 AND pos = 2 AND menge IS NULL;']);
  assert.deepEqual(w.ops[0].params, [3, 5, 1, 2]);
  // kein Primärschlüssel, aber ein eindeutiger Index ohne NULL-Spalten
  const ersatz = table([col('code', 'char(2)', { nullable: false }), col('name', 'varchar(50)')], [{ name: 'u', columns: ['code'], unique: true, primary: false }]);
  assert.deepEqual(buildWrites('mysql', ref('mysql', 'land'), ersatz, [{ kind: 'delete', key: { code: 'CH' } }]).preview, ["DELETE FROM `shop`.`land` WHERE `code` = 'CH';"]);
  // eindeutiger Index mit NULL-fähiger Spalte taugt nicht als Schlüssel
  const ohne = table([col('code', 'char(2)'), col('name', 'varchar(50)')], [{ name: 'u', columns: ['code'], unique: true, primary: false }]);
  assert.throws(() => buildWrites('mysql', ref('mysql', 'land'), ohne, [{ kind: 'delete', key: { code: 'CH' } }]), /keinen Primärschlüssel/);
  // einfügen geht auch ohne Schlüssel
  assert.equal(buildWrites('mysql', ref('mysql', 'land'), ohne, [{ kind: 'insert', values: { code: 'DE' } }]).ops.length, 1);
});

test('buildWrites: nicht vergleichbare Spalten bleiben aus dem WHERE, vergleichbare kommen hinein', () => {
  const t = table(
    [
      col('id', 'bigint', { nullable: false, primaryKey: true }),
      ...['varchar(10)', 'int', 'decimal(10,2)', 'uuid', 'boolean', 'char(3)'].map((ty, i) => col(`v${i}`, ty)),
      ...['datetime', 'timestamp with time zone', 'float', 'double precision', 'real', 'json', 'jsonb', 'blob', 'bytea', 'money', 'interval', 'text[]', 'xml'].map((ty, i) =>
        col(`n${i}`, ty),
      ),
    ],
    [],
  );
  const names = t.columns.slice(1).map((c) => c.name);
  const values = Object.fromEntries(names.map((n) => [n, 'neu']));
  const original = Object.fromEntries(names.map((n) => [n, 'alt']));
  const w = buildWrites('postgres', ref('postgres', 't'), t, [{ kind: 'update', key: { id: 1 }, values, original }]);
  const where = w.ops[0].sql.split(' WHERE ')[1];
  for (const n of names) {
    if (n.startsWith('v')) assert.match(where, new RegExp(`\\b${n} = `), `${n} gehört ins WHERE`);
    else assert.doesNotMatch(where, new RegExp(`\\b${n}\\b`), `${n} gehört nicht ins WHERE`);
  }
  // SQL Server: text/ntext lassen sich nicht mit = vergleichen
  const ms = table([col('id', 'int', { nullable: false, primaryKey: true }), col('notiz', 'ntext'), col('kurz', 'nvarchar(10)')]);
  const m = buildWrites('mssql', ref('mssql', 't'), ms, [{ kind: 'update', key: { id: 1 }, values: { notiz: 'a', kurz: 'b' }, original: { notiz: 'x', kurz: 'y' } }]);
  assert.equal(m.ops[0].sql, 'UPDATE [shop].[dbo].[t] SET [notiz] = @p1, [kurz] = @p2 WHERE [id] = @p3 AND [kurz] = @p4');
});

test('buildWrites: leere neue Zeile, Sonderzeichen in Namen, Zahlen in der Vorschau, Fehler', () => {
  assert.deepEqual(buildWrites('mysql', ref('mysql'), KUNDE, [{ kind: 'insert', values: {} }]).preview, ['INSERT INTO `shop`.`kunde` () VALUES ();']);
  assert.deepEqual(buildWrites('postgres', ref('postgres'), KUNDE, [{ kind: 'insert', values: {} }]).preview, ['INSERT INTO public.kunde DEFAULT VALUES;']);
  assert.deepEqual(buildWrites('mssql', ref('mssql'), KUNDE, [{ kind: 'insert', values: {} }]).preview, ['INSERT INTO [shop].[dbo].[kunde] DEFAULT VALUES;']);
  // Bezeichner mit Quote-Zeichen werden verdoppelt
  const odd = table([col('i`d]"X', 'int', { nullable: false, primaryKey: true }), col('Wert', 'decimal(10,2)')]);
  const ins = (d: Dialect) => buildWrites(d, ref(d, 'Tab"le'), odd, [{ kind: 'update', key: { 'i`d]"X': 1 }, values: { Wert: '12.50' }, original: {} }]).preview[0];
  assert.equal(ins('mysql'), 'UPDATE `shop`.`Tab"le` SET `Wert` = 12.50 WHERE `i``d]"X` = 1;');
  assert.equal(ins('postgres'), 'UPDATE public."Tab""le" SET "Wert" = 12.50 WHERE "i`d]""X" = 1;');
  assert.equal(ins('mssql'), 'UPDATE [shop].[dbo].[Tab"le] SET [Wert] = 12.50 WHERE [i`d]]"X] = 1;');
  // Backslash: MySQL verdoppelt, PostgreSQL schreibt E'…'
  const bs = { kind: 'update' as const, key: { id: 1 }, values: { name: 'a\\b' }, original: {} };
  assert.match(buildWrites('mysql', ref('mysql'), KUNDE, [bs]).preview[0], /`name` = 'a\\\\b'/);
  assert.match(buildWrites('postgres', ref('postgres'), KUNDE, [bs]).preview[0], /name = E'a\\\\b'/);
  // Fehler: Schlüssel NULL, Schlüssel fehlt, unbekannte Spalte; leeres UPDATE fällt weg
  assert.throws(() => buildWrites('mysql', ref('mysql'), KUNDE, [{ kind: 'delete', key: { id: null } }]), /ohne Schlüsselwert/);
  assert.throws(() => buildWrites('mysql', ref('mysql'), KUNDE, [{ kind: 'delete', key: {} }]), /Schlüsselwerte fehlen/);
  assert.throws(() => buildWrites('mysql', ref('mysql'), KUNDE, [{ kind: 'update', key: { id: 1 }, values: { weg: 1 } }]), /Spalte weg gibt es/);
  assert.equal(buildWrites('mysql', ref('mysql'), KUNDE, [{ kind: 'update', key: { id: 1 }, values: {} }]).ops.length, 0);
});
