// Erzeugt die Programmsymbole aus dem Logo in brand/ (die App-Kachel unten rechts):
//   build/icon.png      256×256 – Windows-Symbol (electron-builder macht daraus die .ico)
//   build/icon-512.png  512×512 – Linux (AppImage, deb)
//   build/icon-mac.png  512×512 – macOS: Kachel mit dem dort üblichen Rand (412 von 512, wie Apples Vorlage 824 von 1024)
//   ui/public/logo.png  256×256 – Startseite der Oberfläche
//   ui/public/favicon.png 64×64 – Fenster-/Tab-Symbol
// Aufruf: npx electron dev/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'brand', 'owlyndb-logo.png');

/** läuft im Fenster: Kachel finden (dunkelblaue Fläche unten rechts), mit runden Ecken ausschneiden */
function render(url, sizes) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('Logo nicht lesbar'));
    img.onload = () => {
      const w = img.width;
      const h = img.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      // erst unterhalb des Schriftzugs suchen (der Untertitel „One Tool to Bind Them.“ ist ebenfalls dunkelblau und reicht bis etwa 61 % der Höhe)
      for (let y = Math.floor(h * 0.65); y < h; y++) {
        for (let x = Math.floor(w * 0.7); x < w; x++) {
          const i = (y * w + x) * 4;
          // Dunkelblau der Kachel (etwa #12324f)
          if (d[i] < 50 && d[i + 1] < 75 && d[i + 2] > 45 && d[i + 2] < 120) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return reject(new Error('App-Kachel im Logo nicht gefunden'));
      // die Kachel ist quadratisch: sonst hat die Suche mehr als die Kachel erfasst (z. B. Teile der Schrift)
      if (Math.abs((x1 - x0) - (y1 - y0)) > (x1 - x0) * 0.08) return reject(new Error(`gefundener Bereich ist nicht quadratisch: ${x0}, ${y0}, ${x1}, ${y1}`));
      // ein paar Pixel nach innen: an den Rändern liegt die Kantenglättung zum weißen Hintergrund
      const inset = Math.round((x1 - x0) * 0.012) + 1;
      const sx = x0 + inset;
      const sy = y0 + inset;
      const sw = x1 - x0 + 1 - 2 * inset;
      const sh = y1 - y0 + 1 - 2 * inset;
      const out = {};
      // Größe oder [Größe, Rand]: die Kachel liegt dann mit durchsichtigem Rand in der Mitte
      for (const [name, spec] of Object.entries(sizes)) {
        const [size, pad] = Array.isArray(spec) ? spec : [spec, 0];
        const inner = size - 2 * pad;
        const k = document.createElement('canvas');
        k.width = size;
        k.height = size;
        const t = k.getContext('2d');
        t.imageSmoothingEnabled = true;
        t.imageSmoothingQuality = 'high';
        t.beginPath();
        t.roundRect(pad, pad, inner, inner, inner * 0.21);
        t.clip();
        t.drawImage(img, sx, sy, sw, sh, pad, pad, inner, inner);
        out[name] = k.toDataURL('image/png');
      }
      resolve({ box: [x0, y0, x1, y1], out });
    };
    img.src = url;
  });
}

app.whenReady().then(async () => {
  // ohne try/finally bliebe Electron bei einem Fehler (Logo fehlt, Kachel nicht gefunden) mit verstecktem Fenster für immer stehen
  try {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const url = 'data:image/png;base64,' + fs.readFileSync(source).toString('base64');
  const sizes = { icon: 256, linux: 512, mac: [512, 50], logo: 256, favicon: 64 };
  const r = await win.webContents.executeJavaScript(`(${render.toString()})(${JSON.stringify(url)}, ${JSON.stringify(sizes)})`);
  const save = (file, dataUrl) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('geschrieben:', path.relative(root, file));
  };
  console.log('Kachel im Logo:', r.box.join(', '));
  save(path.join(root, 'build', 'icon.png'), r.out.icon);
  save(path.join(root, 'build', 'icon-512.png'), r.out.linux);
  save(path.join(root, 'build', 'icon-mac.png'), r.out.mac);
  save(path.join(root, 'ui', 'public', 'logo.png'), r.out.logo);
  save(path.join(root, 'ui', 'public', 'favicon.png'), r.out.favicon);
  } catch (e) {
    console.error('Fehler:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
