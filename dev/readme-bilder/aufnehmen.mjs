// Bilder für README und Handbuch neu aufnehmen: docs/bilder/<motiv>-hell.png und <motiv>-dunkel.png, mit erfundenen Daten.
//   npm run readme-bilder                                        baut zuerst, dann alle Motive
//   node dev/readme-bilder/aufnehmen.mjs [motiv …] [--behalten]  ohne Bauen; Motive: abfrage er-diagramm plan datenvergleich ssh-tunnel
// Braucht Docker: Ein Wegwerf-PostgreSQL „owlyndb-demo-pg“ (127.0.0.1:15499) bekommt den Webshop aus webshop.cjs, OwlynDB
// startet mit leerem Profil im Temp-Ordner und DevTools-Port 9336 (anderer per CDP_PORT=…); das Fenster ist dabei zu sehen.
// Danach sind App, Profil und Container wieder weg (--behalten lässt den Container für weitere Läufe stehen).
// Vor dem Einchecken die Bilder ansehen: Das Repository ist öffentlich.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fill } = require('./webshop.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'bilder');
const CONTAINER = 'owlyndb-demo-pg';
const IMAGE = 'postgres:17.11-alpine';
const PG = { host: '127.0.0.1', port: 15499, password: 'demo-only' };
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const W = 1180;
const H = 720;
const DSF = 1.5;
const MOTIVE = ['abfrage', 'er-diagramm', 'plan', 'datenvergleich', 'ssh-tunnel'];

const HERO_SQL = `-- Die besten Kunden der letzten 90 Tage
SELECT k.vorname || ' ' || k.nachname AS kunde,
       k.ort,
       count(DISTINCT b.id)     AS bestellungen,
       sum(p.menge * p.preis)   AS umsatz,
       max(b.bestellt_am)::date AS zuletzt
FROM kunde k
JOIN bestellung b      ON b.kunde_id = k.id
JOIN bestellposition p ON p.bestellung_id = b.id
WHERE b.status <> 'storniert'
  AND b.bestellt_am >= now() - interval '90 days'
GROUP BY k.id
ORDER BY umsatz DESC
LIMIT 50;
`;
const PLAN_SQL = `-- Was lief in den letzten 90 Tagen am besten?
SELECT a.name AS artikel,
       sum(p.menge) AS menge,
       sum(p.menge * p.preis) AS umsatz
FROM bestellposition p
JOIN bestellung b ON b.id = p.bestellung_id
JOIN artikel a ON a.id = p.artikel_id
WHERE b.bestellt_am >= now() - interval '90 days'
  AND b.status <> 'storniert'
GROUP BY a.name
ORDER BY umsatz DESC
LIMIT 10;
`;
// Prod mit roter Farbe, Kürzel und „Nur lesen“, Test grün; die übrigen stehen nur im Baum und werden nie geöffnet
const demo = { dialect: 'postgres', host: PG.host, port: PG.port, user: 'postgres', password: PG.password };
const VERBINDUNGEN = [
  { ...demo, name: 'Webshop Prod', short: 'PRD', database: 'webshop', color: '#d64545', options: { readOnly: true } },
  { ...demo, name: 'Webshop Test', short: 'TST', database: 'webshop_test', color: '#3aa57a', options: {} },
  { name: 'Buchhaltung', dialect: 'mssql', host: '127.0.0.1', port: 1433, user: 'sa', options: { encrypt: true } },
  { name: 'Wiki', dialect: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', options: {} },
  { name: 'Logs', dialect: 'elasticsearch', host: '127.0.0.1', port: 9200, user: '', options: {} },
];

const args = process.argv.slice(2);
const keep = args.includes('--behalten');
const wanted = args.filter((a) => !a.startsWith('--'));
for (const m of wanted) if (!MOTIVE.includes(m)) throw new Error(`unbekanntes Motiv „${m}“ – möglich: ${MOTIVE.join(', ')}`);
const motive = wanted.length ? wanted : MOTIVE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (!existsSync(path.join(ROOT, 'dist-electron')) || !existsSync(path.join(ROOT, 'ui', 'dist'))) {
  console.error('Erst bauen: npm run build (npm run readme-bilder baut selbst)');
  process.exit(1);
}
if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(() => true, () => false)) {
  console.error(`Port ${CDP_PORT} ist belegt – läuft schon eine App mit DevTools? Anderen Port mit CDP_PORT=… wählen.`);
  process.exit(1);
}

// --- DevTools-Protokoll ---
let send;
let ev;
let closeWs = () => undefined;
async function connect() {
  let page;
  for (let i = 0; i < 160 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('app://'));
    } catch {
      // App startet noch
    }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('OwlynDB-Fenster nicht gefunden');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`${method}: keine Antwort der App innerhalb von 30 s`));
      }, 30_000);
      pending.set(i, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  closeWs = () => ws.close();
}
async function until(expr, ms = 20_000) {
  for (let t = 0; t < ms; t += 150) {
    try {
      if (await ev(expr)) return;
    } catch {
      // Seite lädt gerade neu
    }
    await sleep(150);
  }
  throw new Error('Zeitüberschreitung: ' + expr);
}

// --- Bausteine der Szenen ---
const row = (label) =>
  `[...document.querySelectorAll('app-tree [role=treeitem]')].find((r) => r.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(label)})`;
const viewport = (w = W, h = H) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: DSF, mobile: false });
const blur = () => ev(`(() => { document.activeElement?.blur(); return true; })()`);

async function expand(label) {
  if ((await ev(`${row(label)}?.getAttribute('aria-expanded') ?? 'fehlt'`)) === 'fehlt') throw new Error('Baumzeile fehlt: ' + label);
  await ev(`(() => { const r = ${row(label)}; if (r.getAttribute('aria-expanded') !== 'true') r.querySelector('.twisty').click(); return true; })()`);
  await until(`${row(label)}?.getAttribute('aria-expanded') === 'true'`);
  await sleep(300);
}
async function closeTabs() {
  for (let i = 0; i < 20 && (await ev(`document.querySelectorAll('.tabs .tab').length`)); i++) {
    await ev(`document.querySelector('.tabs .tab .x').click()`);
    await sleep(250);
    // Rückfrage beim Schließen (z. B. Text im Abfrage-Tab) bestätigen
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && /^(Schließen|Verwerfen|Nicht speichern)/.test(x.textContent.trim())); b?.click(); return true; })()`);
    await sleep(150);
  }
}
/** frischer Stand je Motiv: Tabs zu, neu laden (Tabs zählen wieder ab 1, Baum zugeklappt) */
async function fresh() {
  await viewport();
  await closeTabs();
  await send('Page.reload');
  await sleep(1000);
  await until(`!!document.querySelector('app-tree [role=treeitem]')`);
  await closeTabs();
}
async function contextMenu(label, item) {
  await ev(`(() => { const r = ${row(label)}; const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.top + b.height / 2, button: 2 })); return true; })()`);
  await sleep(300);
  const ok = await ev(`(() => { const all = [...document.querySelectorAll('[role=menuitem], .menu button, .ctx button, .context-menu button')].filter((x) => x.offsetParent);
    const m = all.find((x) => x.textContent.trim().startsWith(${JSON.stringify(item)}));
    if (!m) return all.map((x) => x.textContent.trim()).join(' | ') || 'kein Menü'; m.click(); return true; })()`);
  if (ok !== true) throw new Error(`Menüpunkt „${item}“ fehlt – da: ${ok}`);
  await sleep(400);
}
async function button(scope, name) {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((x) => x.offsetParent &&
    (x.title.startsWith(${JSON.stringify(name)}) || x.textContent.trim() === ${JSON.stringify(name)})); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`Knopf „${name}“ fehlt in ${scope}`);
  await sleep(300);
}
async function setSql(sql) {
  await until(`typeof monaco !== 'undefined' && monaco.editor.getEditors().some((e) => e.getDomNode()?.offsetParent)`);
  await ev(`(() => { const e = monaco.editor.getEditors().find((e) => e.getDomNode()?.offsetParent); e.setValue(${JSON.stringify(sql)});
    e.setPosition({ lineNumber: 1, column: 1 }); return true; })()`);
}
/** Abfrage-Tab auf Webshop Prod · webshop, im Baum die Tabellen aufgeklappt */
async function newQuery() {
  await expand('Webshop Prod');
  await ev(`${row('webshop')}.click()`);
  await sleep(300);
  await expand('webshop');
  await ev(`document.querySelector('.tabs .add').click()`);
}
/** Trenner zwischen Editor und Ergebnis um dy ziehen, danach die Maus weg (sonst leuchtet er) */
async function dragHandle(dy) {
  const h = await ev(`(() => { const e = [...document.querySelectorAll('app-query-view .handle')].find((x) => x.offsetParent); const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  await mouse('mouseMoved', h.x, h.y);
  await mouse('mousePressed', h.x, h.y, { button: 'left', clickCount: 1, buttons: 1 });
  for (let d = 1; d <= 6; d++) await mouse('mouseMoved', h.x, h.y + (dy * d) / 6, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', h.x, h.y + dy, { button: 'left', clickCount: 1 });
  await mouse('mouseMoved', 200, H + 60);
  await sleep(300);
}
/** Ziel des Datenvergleichs wählen: je Titel ist das zweite Feld das Ziel */
async function pickTarget(title, text) {
  const sel = JSON.stringify(`app-data-compare select[title="${title}"]`);
  await until(`(() => { const s = document.querySelectorAll(${sel})[1]; return s && [...s.options].some((o) => o.text.trim() === ${JSON.stringify(text)}); })()`);
  await ev(`(() => { const s = document.querySelectorAll(${sel})[1]; const o = [...s.options].find((x) => x.text.trim() === ${JSON.stringify(text)});
    if (!o.selected) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await sleep(500);
}

// --- Motive: bauen die Ansicht auf; Rückgabe = Ausschnitt (sonst ganzes Fenster) ---
const SZENEN = {
  async abfrage() {
    await newQuery();
    await setSql(HERO_SQL);
    await button('app-query-view', 'Ausführen');
    await until(`document.querySelectorAll('app-query-view .ag-row').length > 10`);
    await blur();
  },
  async 'er-diagramm'() {
    await expand('Webshop Prod');
    await contextMenu('webshop', 'ER-Diagramm');
    await until(`!!document.querySelector('app-er-view svg') && document.querySelector('app-er-view').textContent.includes('Fremdschlüssel')`, 30_000);
    await sleep(1000);
  },
  async plan() {
    await viewport(1360, 800);
    await newQuery();
    await setSql(PLAN_SQL);
    await dragHandle(-120);
    await button('app-query-view', 'Plan mit Laufzeit');
    await until(`document.querySelector('app-plan-view')?.textContent.includes('Ausführung')`, 30_000);
    await sleep(800);
    await blur();
  },
  async datenvergleich() {
    await expand('Webshop Prod');
    await expand('webshop');
    await contextMenu('kunde', 'Daten vergleichen');
    await until(`!!document.querySelector('app-data-compare select[title="Verbindung"]')`);
    await sleep(500);
    await pickTarget('Verbindung', 'Webshop Test');
    await pickTarget('Datenbank', 'webshop_test');
    await pickTarget('Tabelle', 'kunde');
    await button('app-data-compare', 'Vergleichen');
    await until(`document.querySelector('app-data-compare').textContent.includes('Alle Unterschiede')`, 30_000);
    await sleep(800);
  },
  async 'ssh-tunnel'() {
    // nur ausgefüllt, nicht gespeichert; Werte wie im Beispiel des README
    const type = (sel, value) =>
      ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(value)};
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); return true; })()`);
    await ev(`document.querySelector('app-tree button[title="Neue Verbindung"]').click()`);
    await until(`!!document.querySelector('#cd-host')`);
    await ev(`[...document.querySelectorAll('.types .type')].find((b) => b.textContent.trim() === 'PostgreSQL').click()`);
    await sleep(200);
    await ev(`(() => { const c = document.querySelector('input[name=ssh]'); if (!c.checked) c.click(); return true; })()`);
    await until(`!!document.querySelector('#cd-ssh-host')`);
    for (const [sel, value] of [
      ['#cd-name', 'Shop Prod (über SSH)'],
      ['#cd-host', 'localhost'],
      ['#cd-port', '5432'],
      ['#cd-user', 'app_read'],
      ['#cd-password', 'beispiel-passwort'],
      ['#cd-database', 'shop'],
      ['#cd-ssh-host', 'ssh.example.com'],
      ['#cd-ssh-user', 'deploy'],
    ])
      await type(sel, value);
    await sleep(300);
    return ev(`(() => { const r = document.querySelector('app-connection-dialog .dialog').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, innerHeight - r.y) }; })()`);
  },
};

// --- Ablauf ---
const profile = mkdtempSync(path.join(tmpdir(), 'owlyndb-bilder-'));
let app;
try {
  const state = docker('ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}');
  if (!state) docker('run', '-d', '--name', CONTAINER, '-p', `${PG.host}:${PG.port}:5432`, '-e', `POSTGRES_PASSWORD=${PG.password}`, IMAGE);
  else if (state !== 'running') docker('start', CONTAINER);
  console.log('Webshop angelegt:', await fill(PG));

  app = spawn(
    require('electron'),
    ['.', `--remote-debugging-port=${CDP_PORT}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    { cwd: ROOT, env: { ...process.env, DBV_USER_DATA: profile }, stdio: 'ignore' },
  );
  await connect();
  await until(`!!document.querySelector('app-tree')`);
  for (const c of VERBINDUNGEN) await ev(`window.dbv.call('saveConnection', ${JSON.stringify(c)})`);

  for (const mode of ['light', 'dark']) {
    await ev(`localStorage.setItem('dbv.theme', ${JSON.stringify(mode)})`);
    for (const m of motive) {
      await fresh();
      const clip = await SZENEN[m]();
      await sleep(400);
      const file = path.join(OUT, `${m}-${mode === 'light' ? 'hell' : 'dunkel'}.png`);
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(`${path.relative(ROOT, file)}  ${Math.round(statSync(file).size / 1024)} KB`);
    }
  }
} finally {
  closeWs();
  // nur diesen Prozessbaum beenden, nie nach Programmnamen (ein laufendes OwlynDB bleibt unberührt)
  if (app && app.exitCode === null) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill();
  }
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (!keep) {
    try {
      docker('rm', '-f', CONTAINER);
    } catch {
      // kein Docker oder Container nie angelegt – der eigentliche Fehler steht darüber
    }
  }
}
