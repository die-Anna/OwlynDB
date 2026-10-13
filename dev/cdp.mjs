// Fernsteuerung der laufenden App über das DevTools-Protokoll (nur Entwicklung).
// Start der App:  $env:DBV_USER_DATA="…"; npx electron . --remote-debugging-port=9333
// Aufrufe:
//   node dev/cdp.mjs eval "<js-ausdruck>"        Ergebnis als JSON (Promises werden abgewartet)
//   node dev/cdp.mjs shot <datei.png>            Screenshot des Fensters
//   node dev/cdp.mjs click <css-selektor> [n]    n-tes Element anklicken (echte Mausereignisse)
//   node dev/cdp.mjs ctrlclick <css-selektor> [n]   mit gedrückter Strg-Taste
//   node dev/cdp.mjs dblclick <css-selektor> [n]
//   node dev/cdp.mjs rclick <css-selektor> [n]   Kontextmenü
//   node dev/cdp.mjs type "<text>"               Text tippen (ins fokussierte Element)
//   node dev/cdp.mjs key <Taste> [ctrl|shift|ctrl+shift]   z. B. key Enter ctrl, key F5
//   node dev/cdp.mjs drag <css-selektor> <dx> <dy> [n]   Element ziehen (drücken, in Schritten bewegen, loslassen)
//   node dev/cdp.mjs wheel <css-selektor> <dy> [ctrl]    Mausrad über dem Element, mit ctrl: Strg gedrückt
//   node dev/cdp.mjs sql <datei.sql>             Text aus der Datei in den Editor des sichtbaren Tabs setzen
//   node dev/cdp.mjs logs                        Konsolenmeldungen der letzten 3 s
// Unbekannter oder fehlender Befehl: Exit-Code 1. Jede Anfrage an die App hat 30 s Zeit (sonst Fehler statt Hängen).
import { writeFileSync } from 'node:fs';

const port = process.env.CDP_PORT ?? '9333';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('app://'));
if (!page) throw new Error('Fenster nicht gefunden: ' + targets.map((t) => t.url).join(', '));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) events.push(msg);
};
const SEND_TIMEOUT_MS = 30_000;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => {
      pending.delete(i);
      reject(new Error(`${method}: keine Antwort der App innerhalb von ${SEND_TIMEOUT_MS / 1000} s`));
    }, SEND_TIMEOUT_MS);
    pending.set(i, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function center(sel, n = 0) {
  const r = await evaluate(`(() => { const els = document.querySelectorAll(${JSON.stringify(sel)}); const el = els[${n}];
    if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, count: els.length }; })()`);
  if (!r) throw new Error(`Element nicht gefunden: ${sel} [${n}]`);
  return r;
}

async function mouse(sel, n, button, clickCount, modifiers = 0) {
  const { x, y } = await center(sel, Number(n ?? 0));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let c = 1; c <= clickCount; c++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c, buttons: button === 'right' ? 2 : 1, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c, modifiers });
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  F5: { code: 'F5', keyCode: 116 },
  F9: { code: 'F9', keyCode: 120 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
};

async function key(name, mods = '') {
  const m = (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0) | (mods.includes('alt') ? 1 : 0);
  const k = KEYS[name] ?? { code: 'Key' + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name };
  const base = { modifiers: m, key: k.key ?? name, code: k.code, windowsVirtualKeyCode: k.keyCode };
  // mit Strg oder Alt: Tastenkombination ohne Texteingabe
  await send('Input.dispatchKeyEvent', { type: m & 3 ? 'rawKeyDown' : 'keyDown', ...base, text: m & 3 ? undefined : k.text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const [cmd, a, b, c, d] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'eval':
      console.log(JSON.stringify(await evaluate(a), null, 2));
      break;
    case 'shot': {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(a, Buffer.from(r.data, 'base64'));
      console.log('gespeichert: ' + a);
      break;
    }
    case 'click':
      await mouse(a, b, 'left', 1);
      break;
    case 'ctrlclick':
      await mouse(a, b, 'left', 1, 2);
      break;
    case 'dblclick':
      await mouse(a, b, 'left', 2);
      break;
    case 'rclick':
      await mouse(a, b, 'right', 1);
      break;
    case 'drag': {
      const { x, y } = await center(a, Number(d ?? 0));
      const [dx, dy] = [Number(b), Number(c)];
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 10, y: y + (dy * i) / 10, button: 'left', buttons: 1 });
        await new Promise((r) => setTimeout(r, 20));
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
      break;
    }
    case 'wheel': {
      const { x, y } = await center(a, 0);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(b), modifiers: c === 'ctrl' ? 2 : 0 });
      break;
    }
    case 'sql': {
      // Text aus Datei in den Editor des sichtbaren Tabs setzen
      const text = (await import('node:fs')).readFileSync(a, 'utf8');
      console.log(
        await evaluate(`(() => { const host = document.querySelector('.pane:not([hidden]) .monaco-editor');
          const ed = monaco.editor.getEditors().find((e) => e.getContainerDomNode().contains(host) || host.contains(e.getContainerDomNode()));
          if (!ed) return 'kein Editor'; ed.setValue(${JSON.stringify(text)}); ed.focus(); return 'ok'; })()`),
      );
      break;
    }
    case 'type':
      await send('Input.insertText', { text: a });
      break;
    case 'key':
      await key(a, b);
      break;
    case 'logs': {
      await send('Runtime.enable');
      await send('Log.enable');
      await new Promise((r) => setTimeout(r, 3000));
      for (const e of events) {
        if (e.method === 'Runtime.consoleAPICalled') console.log(e.params.type, e.params.args.map((x) => x.value ?? x.description).join(' '));
        if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', e.params.exceptionDetails.exception?.description);
        if (e.method === 'Log.entryAdded') console.log(e.params.entry.level, e.params.entry.text);
      }
      break;
    }
    default:
      console.error(`unbekannter Befehl${cmd ? ` „${cmd}“` : ''} – möglich: eval, shot, click, ctrlclick, dblclick, rclick, type, key, drag, wheel, sql, logs`);
      process.exitCode = 1;
  }
} finally {
  ws.close();
}
