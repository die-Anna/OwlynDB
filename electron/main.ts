import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPORT_EXT, type DbvApi, type DbvMethod, type ExportFormat, type FileKind, type IpcReply, type ThemeMode } from '../shared/api-types';
import { ConnectionStore } from './connection-store';
import { errorText } from './drivers/common';
import { Manager } from './manager';
import { legacyProfile } from './profile';

// gleiche ID wie im Installer (package.json build.appId)
if (process.platform === 'win32') app.setAppUserModelId('io.github.die-anna.owlyndb');

// eigenes Profil für Tests: DBV_USER_DATA=… electron .
if (process.env.DBV_USER_DATA) app.setPath('userData', process.env.DBV_USER_DATA);
else {
  // Das Profil heißt %APPDATA%\OwlynDB (Name aus package.json productName). Wer das Programm noch als „AtlasDB“ oder davor
  // als „dbviewer“ benutzt hat, behält sein altes Profil (Verbindungen samt verschlüsselter Passwörter): erstes benutztes der Liste
  const appData = app.getPath('appData');
  const legacy = legacyProfile([path.join(appData, 'AtlasDB'), path.join(appData, 'dbviewer')], app.getPath('userData'));
  if (legacy) app.setPath('userData', legacy);
}

// eine Instanz je Profil: zwei Prozesse überschrieben gegenseitig connections.json, Verlauf und gespeicherte Abfragen (jeder
// aus seinem eigenen Stand im Speicher) – ein zweiter Start holt das vorhandene Fenster nach vorn
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
}

// Oberfläche über ein eigenes Schema statt file://, damit Monaco & Co. wie im Web laufen
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** Methoden, die die Oberfläche aufrufen darf – jede aus DbvApi genau einmal (fehlt eine, meldet es der Compiler) */
const METHODS = {
  listConnections: true, saveConnection: true, duplicateConnection: true, deleteConnection: true, testConnection: true, pickFile: true, connect: true, reconnect: true, cancelSearch: true,
  disconnect: true, listDatabases: true, listSchemas: true, listObjects: true, listRoutines: true, getRoutineDdl: true,
  searchObjects: true, compareSchemas: true, describeTable: true, erModel: true, getDdl: true, fetchTable: true,
  countTable: true, completionInfo: true, exportRows: true, exportTable: true, cancelExport: true, exportQuery: true,
  showInFolder: true, setTheme: true, saveSvg: true, openSession: true, closeSession: true, setSessionDatabase: true, sessionState: true,
  runQuery: true, explainQuery: true, cancelQuery: true, listServerSessions: true, killServerSession: true, startDump: true,
  startImport: true, startCopy: true, startDataCompare: true, dataCompareResult: true, startDataCompareAll: true,
  dataCompareAllResult: true, startDataCompareScript: true, jobStatus: true, cancelJob: true, listHistory: true, historyCounts: true,
  clearHistory: true, listSavedQueries: true, saveQuery: true, deleteSavedQuery: true, exportSettings: true,
  previewSettings: true, importSettings: true, applyChanges: true, setUnsavedTables: true,
} satisfies Record<DbvMethod, true>;

let manager: Manager;
/** zuletzt gewählter Export-Ordner (nur für diese Sitzung) */
let lastExportDir: string | undefined;
/** Rückfrage vor dem Beenden schon bejaht (Fensterkreuz, Alt+F4 oder Datei > Beenden) */
let quitConfirmed = false;
/** so lange darf das Aufräumen beim Beenden dauern (Abfragen abbrechen, Sitzungen und Tunnel schließen) */
const SHUTDOWN_LIMIT_MS = 10_000;

/** was beim Beenden bzw. Neu laden verloren geht oder abgebrochen wird; leer = nichts */
function workLines(): string[] {
  if (!manager) return [];
  const w = manager.openWork();
  return [
    ...(w.unsaved.length ? [`Ungespeicherte Änderungen: ${w.unsaved.join(', ')} – gehen verloren.`] : []),
    ...(w.busy ? [`${w.busy} Abfrage${w.busy === 1 ? ' läuft' : 'n laufen'} noch – sie wird abgebrochen.`] : []),
    ...(w.inTransaction ? [`${w.inTransaction} Tab${w.inTransaction === 1 ? ' hat eine offene Transaktion' : 's haben offene Transaktionen'} – nicht festgeschriebene Änderungen werden zurückgerollt.`] : []),
    ...(w.jobs
      ? [
          `${w.jobs} Auftr${w.jobs === 1 ? 'ag läuft' : 'äge laufen'} noch (Dump, Einspielen, Kopieren oder Vergleich) – ${w.jobs === 1 ? 'er wird' : 'sie werden'} abgebrochen. ` +
            'Ohne Transaktion bleibt im Ziel, was schon eingespielt ist; eine Dump-Datei bleibt unvollständig.',
        ]
      : []),
    ...(w.exports ? [`${w.exports} Export${w.exports === 1 ? ' läuft' : 'e laufen'} noch – ${w.exports === 1 ? 'er wird' : 'sie werden'} abgebrochen, eine vorhandene Datei bleibt, wie sie war.`] : []),
  ];
}

function ask(win: BrowserWindow | undefined, title: string, message: string, ok: string, lines: string[]): boolean {
  const opts: Electron.MessageBoxSyncOptions = { type: 'warning', title, message, detail: lines.join('\n'), buttons: ['Abbrechen', ok], defaultId: 0, cancelId: 0, noLink: true };
  return (win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)) === 1;
}

/** laufende Abfragen, offene Transaktionen, Aufträge, Exporte und ungespeicherte Tabellenänderungen: nachfragen; true = beenden */
function confirmQuit(win?: BrowserWindow): boolean {
  if (quitConfirmed) return true;
  const lines = workLines();
  if (!lines.length) return true;
  if (ask(win, 'OwlynDB beenden', 'Trotzdem beenden?', 'Beenden', lines)) quitConfirmed = true;
  return quitConfirmed;
}

/** Neu laden schließt die Sitzungen und bricht Aufträge ab (die neue Oberfläche kennt sie nicht): nachfragen; true = neu laden */
function confirmReload(win: BrowserWindow): boolean {
  const lines = workLines();
  return !lines.length || ask(win, 'Neu laden', 'Trotzdem neu laden?', 'Neu laden', lines);
}

/** gewählte Darstellung (ui-theme.json im Profil): schon vor dem ersten Fenster, sonst blitzten Titelleiste und Hintergrund */
function themeFile(): string {
  return path.join(app.getPath('userData'), 'ui-theme.json');
}

function loadTheme(): void {
  try {
    const m = (JSON.parse(readFileSync(themeFile(), 'utf8')) as { mode?: unknown }).mode;
    if (m === 'light' || m === 'dark') nativeTheme.themeSource = m;
  } catch {
    // keine Wahl gespeichert: wie Windows
  }
}

function setTheme(mode: ThemeMode): boolean {
  nativeTheme.themeSource = mode;
  try {
    writeFileSync(themeFile(), JSON.stringify({ mode }));
  } catch {
    // nicht schreibbar: gilt bis zum Beenden
  }
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground());
  return nativeTheme.shouldUseDarkColors;
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff';
}

function uiRoot(): string {
  return path.join(app.getAppPath(), 'ui', 'dist', 'ui', 'browser');
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'OwlynDB',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    // Linux nimmt das Fenstersymbol nicht aus der .desktop-Datei (X11)
    ...(process.platform === 'linux' ? { icon: path.join(uiRoot(), 'logo.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links aus der Oberfläche im normalen Browser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  // Beenden mit laufender Abfrage, offener Transaktion oder laufendem Auftrag: nachfragen (Schließen rollt zurück)
  win.on('close', (e) => {
    if (!confirmQuit(win)) e.preventDefault();
  });
  // Seite lädt neu (Menü, Entwicklerwerkzeuge) oder die Oberfläche ist abgestürzt: ihre Sitzungen samt offener Transaktionen,
  // Aufträge und Exporte kennt danach niemand mehr – schließen bzw. abbrechen (sonst hielten sie Sperren bis zum Beenden)
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void manager?.releaseUi();
  });
  win.webContents.on('render-process-gone', () => void manager?.releaseUi());
  if (process.env.DBV_USER_DATA) {
    // Testlauf: Konsolenmeldungen des Fensters im Terminal zeigen
    win.webContents.on('console-message', (e) => console.log(`[ui:${e.level}] ${e.message}`));
  }
  void win.loadURL('app://ui/index.html');
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // macOS: das erste Menü ist das Programm-Menü (⌘Q, ⌘H); kein Fenster-Menü – dessen ⌘W und ⌘M gehören den Tabs bzw. dem Plan
      process.platform === 'darwin'
        ? {
            label: app.name,
            submenu: [
              { role: 'about', label: `Über ${app.name}` },
              { type: 'separator' },
              { role: 'hide', label: `${app.name} ausblenden` },
              { role: 'hideOthers', label: 'Andere ausblenden' },
              { role: 'unhide', label: 'Alle einblenden' },
              { type: 'separator' },
              { role: 'quit', label: `${app.name} beenden` },
            ],
          }
        : { label: 'Datei', submenu: [{ role: 'quit', label: 'Beenden' }] },
      {
        label: 'Bearbeiten',
        submenu: [
          { role: 'undo', label: 'Rückgängig' },
          { role: 'redo', label: 'Wiederholen' },
          { type: 'separator' },
          { role: 'cut', label: 'Ausschneiden' },
          { role: 'copy', label: 'Kopieren' },
          { role: 'paste', label: 'Einfügen' },
          { role: 'selectAll', label: 'Alles auswählen' },
        ],
      },
      {
        label: 'Ansicht',
        submenu: [
          { role: 'zoomIn', label: 'Vergrößern', accelerator: 'CmdOrCtrl+=' },
          { role: 'zoomOut', label: 'Verkleinern' },
          { role: 'resetZoom', label: 'Originalgröße' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Vollbild' },
          { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge', accelerator: 'F12' },
          {
            // wie role 'forceReload', aber mit Rückfrage (ungespeicherte Tabellenänderungen, Transaktionen, Aufträge)
            label: 'Neu laden',
            accelerator: 'CmdOrCtrl+Shift+R',
            click: () => {
              const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
              if (w && confirmReload(w)) w.webContents.reloadIgnoringCache();
            },
          },
        ],
      },
    ]),
  );
}

app.whenReady().then(() => {
  if (!primary) return;
  const root = uiRoot();
  protocol.handle('app', (req) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response('Ungültige Adresse', { status: 400 });
    }
    const file = path.normalize(path.join(root, pathname));
    // nur innerhalb des Ordners: „startsWith(root)“ ließe auch den Nachbarordner …\browser-alt durch
    const rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return new Response('Nicht erlaubt', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const store = new ConnectionStore(path.join(app.getPath('userData'), 'connections.json'), {
    encrypt: (s) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Verschlüsselung des Betriebssystems nicht verfügbar; Passwort wird nicht gespeichert.');
      // Linux ohne Schlüsselbund (Secret Service, KWallet): Electron nähme einen fest eingebauten Schlüssel – das wäre kaum mehr als Klartext
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
        throw new Error('Kein Schlüsselbund gefunden (GNOME-Schlüsselbund, KWallet); Passwort wird nicht gespeichert.');
      }
      return safeStorage.encryptString(s).toString('base64');
    },
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  });
  const pickFile = async (kind: FileKind, current?: string) => {
    // Testlauf: ohne Dialog diese Datei (wie DBV_SAVE_DIR beim Speichern)
    if (process.env.DBV_PICK_FILE) return process.env.DBV_PICK_FILE;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      title:
        kind === 'cert'
          ? 'Zertifikat wählen'
          : kind === 'clientCert'
            ? 'Client-Zertifikat wählen'
          : kind === 'ssh'
            ? 'SSH-Schlüssel wählen'
            : kind === 'sql'
              ? 'SQL-Datei einspielen'
              : kind === 'settings'
                ? 'Einstellungen importieren'
                : 'Privaten Schlüssel wählen',
      // SSH-Schlüssel haben meist keine Endung und liegen in ~/.ssh
      defaultPath: current || (kind === 'ssh' ? path.join(app.getPath('home'), '.ssh') : undefined),
      properties: ['openFile', 'showHiddenFiles'],
      filters:
        kind === 'ssh'
          ? [{ name: 'Alle Dateien', extensions: ['*'] }]
          : kind === 'sql'
          ? [{ name: 'SQL-Dateien', extensions: ['sql', 'txt'] }, { name: 'Alle Dateien', extensions: ['*'] }]
          : kind === 'settings'
          ? [{ name: 'OwlynDB-Einstellungen (JSON)', extensions: ['json'] }, { name: 'Alle Dateien', extensions: ['*'] }]
          : kind === 'clientCert'
          ? [
              // PEM oder PKCS#12 (Zertifikat und Schlüssel in einer Datei, mit Passwort)
              { name: 'Client-Zertifikat (PEM, PKCS#12)', extensions: ['crt', 'pem', 'cer', 'p12', 'pfx'] },
              { name: 'Alle Dateien', extensions: ['*'] },
            ]
          : [
              kind === 'key' ? { name: 'Schlüssel (PEM)', extensions: ['key', 'pem'] } : { name: 'Zertifikate (PEM)', extensions: ['crt', 'pem', 'cer'] },
              { name: 'Alle Dateien', extensions: ['*'] },
            ],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  };
  const FILTERS: Record<ExportFormat, Electron.FileFilter> = {
    csv: { name: 'CSV', extensions: ['csv'] },
    xlsx: { name: 'Excel', extensions: ['xlsx'] },
    json: { name: 'JSON', extensions: ['json'] },
    sql: { name: 'SQL', extensions: ['sql'] },
  };
  manager = new Manager(store, {
    pickFile,
    saveFile: async (baseName, format) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const safe = baseName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'export';
      const ext = format === 'svg' ? 'svg' : EXPORT_EXT[format];
      // Testlauf: ohne Dialog direkt in diesen Ordner
      if (process.env.DBV_SAVE_DIR) return path.join(process.env.DBV_SAVE_DIR, `${safe}.${ext}`);
      const opts: Electron.SaveDialogOptions = {
        title: format === 'svg' ? 'Diagramm speichern' : 'Exportieren',
        defaultPath: path.join(lastExportDir ?? app.getPath('documents'), `${safe}.${ext}`),
        filters: [format === 'svg' ? { name: 'SVG-Grafik', extensions: ['svg'] } : FILTERS[format]],
      };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return null;
      lastExportDir = path.dirname(r.filePath);
      return r.filePath;
    },
    showInFolder: (file) => shell.showItemInFolder(file),
    setTheme,
    confirmHostKey: async (hostId, keyType, fingerprint, previous) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const opts: Electron.MessageBoxOptions = previous
        ? {
            type: 'warning',
            title: 'SSH-Hostschlüssel geändert',
            message: `Der SSH-Server ${hostId} meldet einen ANDEREN Hostschlüssel als bisher.`,
            detail:
              `Bisher: ${previous}
Jetzt (${keyType}): ${fingerprint}

` +
              'Das kann ein Angriff sein (jemand gibt sich als der Server aus). Nur übernehmen, wenn der Server bekanntermaßen neu aufgesetzt wurde.',
            buttons: ['Abbrechen', 'Neuen Schlüssel übernehmen'],
          }
        : {
            type: 'question',
            title: 'Unbekannter SSH-Server',
            message: `Erste Verbindung zu ${hostId}. Diesem Hostschlüssel vertrauen?`,
            detail:
              `${keyType}  ${fingerprint}

` +
              'Mit dem Fingerabdruck vergleichen, den ssh beim ersten Verbinden zeigt oder den der Betreiber nennt ' +
              '(auf dem Server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).',
            buttons: ['Abbrechen', 'Vertrauen'],
          };
      const r = win ? await dialog.showMessageBox(win, { ...opts, defaultId: 0, cancelId: 0, noLink: true }) : await dialog.showMessageBox({ ...opts, defaultId: 0, cancelId: 0, noLink: true });
      return r.response === 1;
    },
  });

  ipcMain.handle('dbv', async (_e, method: DbvMethod, args: unknown[]): Promise<IpcReply<unknown>> => {
    // eigene Eigenschaft: mit „in“ kämen auch toString, constructor … durch
    if (!Object.hasOwn(METHODS, method)) return { ok: false, error: `Unbekannte Methode ${method}` };
    try {
      const fn = manager[method] as (...a: unknown[]) => Promise<unknown>;
      return { ok: true, value: await fn.apply(manager, args) };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  });

  buildMenu();
  loadTheme();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !manager) return;
  e.preventDefault();
  // Datei > Beenden kommt hier an, ohne dass ein Fenster geschlossen wurde: dieselbe Rückfrage wie beim Fensterkreuz
  if (!confirmQuit(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])) return;
  quitting = true;
  // Fenster sofort weg, Aufräumen dahinter – mit Frist: ein toter Server oder eine hängende Abfrage hält das Beenden nicht auf
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  void Promise.race([manager.shutdown(), new Promise<void>((r) => setTimeout(r, SHUTDOWN_LIMIT_MS))]).finally(() => app.exit(0));
});

// auch auf dem Mac beenden: ohne Fenster blieben Sitzungen und offene Transaktionen bis zum Beenden bestehen – und die
// Rückfrage beim Schließen verspricht, dass Schließen zurückrollt
app.on('window-all-closed', () => app.quit());

export type { DbvApi };
