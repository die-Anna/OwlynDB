/* Reine Logik ohne Datenbank (npm run test:unit): Zellwerte im Ergebnis-Grid – numerisch sortieren (F216), JSON
   einrücken ohne Werte zu verändern (F218), Zeilenenden beim Bearbeiten (F215) */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareNumeric, formatJson, keepLineEndings } from '../../../shared/grid-values';

test('compareNumeric: Zahlen als Text numerisch, ohne Rundung, NULL zuerst', () => {
  const sort = (v: unknown[]) => [...v].sort(compareNumeric);
  assert.deepEqual(sort(['100', '9', '10', '2', '1']), ['1', '2', '9', '10', '100']);
  assert.deepEqual(sort(['10.50', '100.00', '9.00', '-5.00', '-10.00', '0.5']), ['-10.00', '-5.00', '0.5', '9.00', '10.50', '100.00']);
  // jenseits 2^53: Number wäre gleich
  assert.deepEqual(sort(['12345678901234567891', '12345678901234567890']), ['12345678901234567890', '12345678901234567891']);
  assert.deepEqual(sort([3, null, '2', 1]), [null, 1, '2', 3]);
  // Array.sort reicht undefined nie an den Vergleich weiter, AG Grid schon (Standardwert einer neuen Zeile)
  assert.equal(compareNumeric(undefined, 1), -1);
  assert.equal(compareNumeric(undefined, null), 0);
  assert.equal(compareNumeric('-0', '0'), 0);
  assert.equal(compareNumeric('1.50', '1.5'), 0);
  assert.equal(compareNumeric('007', '7'), 0);
  // keine Dezimalzahl: über Number bzw. als Text
  assert.equal(compareNumeric('1e3', '999'), 1);
  assert.equal(compareNumeric('abc', 'abd'), -1);
});

test('formatJson: nur Einrückung – große Zahlen, Schlüsselreihenfolge, doppelte Schlüssel und Texte bleiben', () => {
  const src = '{"id": 12345678901234567890, "b": 1, "2": 2, "b": [1e400, {}, [], "a, {b}: \\"c\\""]}';
  const out = formatJson(src)!;
  assert.equal(
    out,
    [
      '{',
      '  "id": 12345678901234567890,',
      '  "b": 1,',
      '  "2": 2,',
      '  "b": [',
      '    1e400,',
      '    {},',
      '    [],',
      '    "a, {b}: \\"c\\""',
      '  ]',
      '}',
    ].join('\n'),
  );
  // nur Leerraum verändert
  assert.equal(out.replace(/\s/g, ''), src.replace(/\s/g, ''));
  assert.equal(formatJson('{"a": 1'), null);
  assert.equal(formatJson('[1, 2]', 4), '[\n    1,\n    2\n]');
});

test('keepLineEndings: CRLF bleibt CRLF, LF bleibt LF', () => {
  assert.equal(keepLineEndings('Zeile1\r\nZeile2\r\nZeile3', 'Zeile1\nZeile2\nZeile 3 neu'), 'Zeile1\r\nZeile2\r\nZeile 3 neu');
  assert.equal(keepLineEndings('a\nb', 'a\nb neu'), 'a\nb neu');
  assert.equal(keepLineEndings(null, 'a\nb'), 'a\nb');
  assert.equal(keepLineEndings('a\r\nb', 'a\r\nb'), 'a\r\nb', 'schon CRLF: nicht doppelt');
});
