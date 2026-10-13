/* Alle Tests nach einem einzigen Build (npm test): zuerst die reine Logik ohne Docker (test:unit), danach die Suiten
   gegen die Test-Container in der Reihenfolge der test:*-Skripte in package.json (test:drivers spielt den Seed ein).
   Läuft weiter, wenn eine Suite scheitert, und fasst am Ende zusammen. Nur bestimmte Suiten: npm test -- drivers export */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const scripts = Object.keys((JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts);
const all = scripts.filter((s) => s.startsWith('test:') && s !== 'test:unit').map((s) => s.slice(5));
const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !all.includes(w));
if (unknown.length) {
  console.error(`Unbekannte Suite(n): ${unknown.join(', ')} – vorhanden: ${all.join(', ')}`);
  process.exit(2);
}
const suites = wanted.length ? all.filter((s) => wanted.includes(s)) : all;

const results: { name: string; ok: boolean; seconds: number }[] = [];
function run(name: string, args: string[]) {
  console.log(`\n===== ${name} =====`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  results.push({ name, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000) });
}

run('unit', ['--test', '--test-reporter=spec', 'dist-electron/electron/test/unit/*.test.js']);
for (const s of suites) run(s, [path.join('dist-electron/electron/test', `${s}.test.js`)]);

console.log('\n===== Übersicht =====');
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FEHL'} ${r.name} (${r.seconds} s)`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} von ${results.length} gescheitert: ${failed.map((r) => r.name).join(', ')}` : `\nalle ${results.length} ok`);
process.exit(failed.length ? 1 : 0);
