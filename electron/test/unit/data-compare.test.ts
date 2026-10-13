/* Reine Logik ohne Datenbank (npm run test:unit): Kommentarzeilen in Abgleich-Skripten (shared/sql-util.ts) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentOut, commentText } from '../../../shared/sql-util';

test('commentOut: jede Zeile einer Anweisung bekommt ihr eigenes „-- “ (Zeilenumbruch im Wert, \\r\\n, \\r)', () => {
  assert.equal(commentOut("DELETE FROM t WHERE k = 'x';"), "-- DELETE FROM t WHERE k = 'x';");
  const sql = "DELETE FROM t WHERE k = 'x''\nDROP TABLE users; --';";
  const out = commentOut(sql);
  assert.equal(out, "-- DELETE FROM t WHERE k = 'x''\n-- DROP TABLE users; --';");
  for (const l of out.split('\n')) assert.ok(l.startsWith('-- '), l);
  assert.equal(commentOut('a\r\nb\rc d'), '-- a\n-- b\n-- c\n-- d');
});

test('commentText: Namen und Hinweise für eine Kommentarzeile – Zeilenumbrüche und Steuerzeichen werden Leerzeichen', () => {
  assert.equal(commentText('kunden'), 'kunden');
  assert.equal(commentText('x\nDROP DATABASE prod;\n--'), 'x DROP DATABASE prod; --');
  assert.equal(commentText('a\r\nb\u0085c d\u0000e'), 'a b c d e');
  assert.ok(!commentText('zeile\n-- zwei').includes('\n'));
});
