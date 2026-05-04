const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const xlsx = require('xlsx');
const AutoLaunch = require('auto-launch');

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');

const DATA_FILE = path.join(DATA_DIR, 'afl-sales-data.json');

const DOCS_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'documents')
  : path.join(__dirname, 'data', 'documents');

const DEFAULT_BACKUP_DIR = path.join(
  os.homedir(),
  'OneDrive - Atlanta Fork Lifts Inc',
  'AFL App Backups'
);

const ICON_PATH = path.join(__dirname, 'assets', 'tray-icon.png');

// ── Auto-launch ───────────────────────────────────────────────────────────────

const autoLauncher = new AutoLaunch({
  name: 'AFL Sales Tracker',
  path: app.getPath('exe'),
  isHidden: false,
});

// ── Setup helpers ─────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureDocsDir() {
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// Read system settings from data file (sync, used before renderer is ready)
function readSystemSettings() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (d.settings && d.settings.system) || {};
  } catch { return {}; }
}

// ── Window & Tray state ───────────────────────────────────────────────────────

let mainWin = null;
let tray = null;
let forceQuit = false;
let closeToTray = true;  // synced from renderer settings

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(ICON_PATH);
  } catch {
    // Fallback if icon file has issues
    const { nativeImage } = require('electron');
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('AFL Sales Tracker');
  updateTrayMenu();

  tray.on('double-click', () => showWindow());
  tray.on('click', () => showWindow());
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open AFL Sales Tracker',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Back Up Now',
      click: () => {
        showWindow();
        if (mainWin) mainWin.webContents.send('tray:backup-now');
      },
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => exitApp(),
    },
  ]);
  tray.setContextMenu(menu);
}

function showWindow() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function exitApp() {
  forceQuit = true;
  mainWin?.webContents.send('app:before-close');
}

// ── createWindow ──────────────────────────────────────────────────────────────

function createWindow() {
  const sys = readSystemSettings();
  const startMinimized = sys.startMinimized === true;

  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'AFL Sales Tracker',
    show: !startMinimized,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (startMinimized) {
    mainWin.minimize();
  }

  // Close button behaviour: minimize to tray or trigger backup+close
  mainWin.on('close', (e) => {
    if (forceQuit) { forceQuit = false; return; }
    if (closeToTray && tray) {
      e.preventDefault();
      mainWin.hide();
    } else {
      e.preventDefault();
      mainWin.webContents.send('app:before-close');
    }
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  ensureDataDir();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Don't quit — app lives in tray
});

app.on('before-quit', () => {
  forceQuit = true;
});

// ── IPC: Read data ────────────────────────────────────────────────────────────

ipcMain.handle('data:read', () => {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return null; }
});

// ── IPC: Write data (atomic) ──────────────────────────────────────────────────

ipcMain.handle('data:write', (_event, data) => {
  try {
    ensureDataDir();
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Open Excel file dialog ───────────────────────────────────────────────

ipcMain.handle('dialog:openExcel', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Excel File',
    filters: [{ name: 'Excel Files', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── IPC: Parse Excel file ─────────────────────────────────────────────────────

ipcMain.handle('excel:parse', (_event, filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length === 0) return { headers: [], rows: [] };
    const headers = rows[0].map(h => String(h).trim());
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell !== ''));
    return { headers, rows: dataRows, sheetNames: workbook.SheetNames };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: Document Library ─────────────────────────────────────────────────────

ipcMain.handle('docs:upload', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Document to Upload',
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Documents', extensions: ['pdf','docx','doc','xlsx','xls','csv','txt','pptx','ppt','rtf'] },
      { name: 'Images', extensions: ['jpg','jpeg','png','gif','bmp','webp','svg'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const srcPath = result.filePaths[0];
  const originalFileName = path.basename(srcPath);
  const ext = path.extname(originalFileName).toLowerCase();
  const uniqueId = `doc_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const storedFileName = `${uniqueId}${ext}`;
  try {
    ensureDocsDir();
    fs.copyFileSync(srcPath, path.join(DOCS_DIR, storedFileName));
    const stat = fs.statSync(path.join(DOCS_DIR, storedFileName));
    return { storedFileName, originalFileName, fileSize: stat.size, ext };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('docs:open', (_event, storedFileName) => {
  const fullPath = path.join(DOCS_DIR, storedFileName);
  if (!fs.existsSync(fullPath)) return { error: 'File not found on disk' };
  shell.openPath(fullPath);
  return { ok: true };
});

ipcMain.handle('docs:saveAs', async (event, storedFileName, displayName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: displayName || storedFileName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.copyFileSync(path.join(DOCS_DIR, storedFileName), result.filePath);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('docs:delete', (_event, storedFileName) => {
  try {
    const fullPath = path.join(DOCS_DIR, storedFileName);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('docs:storageInfo', () => {
  try {
    ensureDocsDir();
    const files = fs.readdirSync(DOCS_DIR).filter(f => !f.startsWith('.'));
    let totalBytes = 0;
    for (const f of files) {
      try { totalBytes += fs.statSync(path.join(DOCS_DIR, f)).size; } catch {}
    }
    return { totalFiles: files.length, totalBytes };
  } catch {
    return { totalFiles: 0, totalBytes: 0 };
  }
});

// ── IPC: App close / ready-to-close flow ─────────────────────────────────────

ipcMain.handle('app:ready-to-close', () => {
  forceQuit = true;
  if (mainWin) mainWin.close();
});

// ── IPC: System settings ──────────────────────────────────────────────────────

ipcMain.handle('system:set-auto-launch', async (_event, enable) => {
  try {
    if (enable) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('system:get-auto-launch', async () => {
  try {
    const enabled = await autoLauncher.isEnabled();
    return { ok: true, enabled };
  } catch (err) {
    return { ok: false, enabled: false, error: err.message };
  }
});

ipcMain.handle('system:set-close-to-tray', (_event, enable) => {
  closeToTray = enable;
  return { ok: true };
});

ipcMain.handle('system:exit-app', () => {
  exitApp();
  return { ok: true };
});

ipcMain.handle('system:show-window', () => {
  showWindow();
  return { ok: true };
});

ipcMain.handle('system:show-notification', (_event, title, body) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
  return { ok: true };
});

// ── IPC: Backup — write ───────────────────────────────────────────────────────

ipcMain.handle('backup:write', async (_event, data, opts = {}) => {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `AFL_Backup_${ts}.json`;
  const payload = JSON.stringify(data, null, 2);

  const folders = [(opts.primaryFolder || DEFAULT_BACKUP_DIR).trim()];
  if (opts.secondaryFolder && opts.secondaryFolder.trim()) folders.push(opts.secondaryFolder.trim());

  const results = [];
  let primaryPath = '';

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    try {
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      const fullPath = path.join(folder, filename);
      fs.writeFileSync(fullPath, payload, 'utf8');
      if (i === 0) primaryPath = fullPath;

      const keepCount = opts.keepCount || 30;
      const allFiles = fs.readdirSync(folder)
        .filter(f => f.startsWith('AFL_Backup_') && f.endsWith('.json'))
        .sort().reverse();
      for (const old of allFiles.slice(keepCount)) {
        try { fs.unlinkSync(path.join(folder, old)); } catch {}
      }
      results.push({ folder, ok: true });
    } catch (err) {
      if (i === 0) primaryPath = '';
      results.push({ folder, ok: false, error: err.message });
    }
  }

  return { ok: results[0]?.ok ?? false, filePath: primaryPath, timestamp: now.toISOString(), results };
});

// ── IPC: Backup — list files ──────────────────────────────────────────────────

ipcMain.handle('backup:list', (_event, folderPath) => {
  try {
    const target = (folderPath || DEFAULT_BACKUP_DIR).trim();
    if (!fs.existsSync(target)) return { files: [] };
    const files = fs.readdirSync(target)
      .filter(f => f.startsWith('AFL_Backup_') && f.endsWith('.json'))
      .map(f => {
        const fp = path.join(target, f);
        try { const s = fs.statSync(fp); return { name: f, fullPath: fp, size: s.size, mtime: s.mtime.toISOString() }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.name.localeCompare(a.name));
    return { files };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

// ── IPC: Backup — restore ─────────────────────────────────────────────────────

ipcMain.handle('backup:restore', (_event, filePath) => {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Backup — open folder in Explorer ────────────────────────────────────

ipcMain.handle('backup:open-folder', (_event, folderPath) => {
  const target = (folderPath || DEFAULT_BACKUP_DIR).trim();
  try { if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true }); } catch {}
  shell.openPath(target);
  return { ok: true };
});

// ── IPC: Backup — get default directory ──────────────────────────────────────

ipcMain.handle('backup:default-dir', () => DEFAULT_BACKUP_DIR);

// ── IPC: Git — commit and push ────────────────────────────────────────────────

function gitExec(cmd, cwd) {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve((stdout || '').trim());
    });
  });
}

ipcMain.handle('git:commit-push', async (_event, message) => {
  const cwd = __dirname;
  try {
    const status = await gitExec('git status --porcelain', cwd);
    if (status) {
      await gitExec('git add -A', cwd);
      await gitExec(`git commit -m "${message.replace(/"/g, "'")}"`, cwd);
    }
    await gitExec('git push origin main', cwd);
    return { ok: true, committed: !!status, pushed: true, timestamp: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message, timestamp: new Date().toISOString() };
  }
});

ipcMain.handle('git:status', async () => {
  const cwd = __dirname;
  try {
    const remote = await gitExec('git remote get-url origin', cwd);
    const branch = await gitExec('git rev-parse --abbrev-ref HEAD', cwd);
    return { ok: true, remote, branch };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Lead Generation — Google Maps ────────────────────────────────────────

ipcMain.handle('leadgen:geocode', async (_event, { zip, apiKey }) => {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(zip + ',GA')}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK' || !json.results.length)
      return { ok: false, error: `Geocode failed: ${json.status}${json.error_message ? ' — ' + json.error_message : ''}` };
    const loc = json.results[0].geometry.location;
    return { ok: true, lat: loc.lat, lng: loc.lng };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('leadgen:maps-search', async (_event, { apiKey, query, lat, lng, radius, pageToken }) => {
  try {
    let url;
    if (pageToken) {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(pageToken)}&key=${encodeURIComponent(apiKey)}`;
    } else {
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
      if (lat != null && lng != null) url += `&location=${lat},${lng}&radius=${radius || 8047}`;
    }
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS')
      return { ok: false, error: `Places search failed: ${json.status}${json.error_message ? ' — ' + json.error_message : ''}` };
    return { ok: true, results: json.results || [], nextPageToken: json.next_page_token || null };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('leadgen:maps-details', async (_event, { apiKey, placeId }) => {
  try {
    const fields = 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,business_status,geometry';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK') return { ok: false, error: `Place details failed: ${json.status}` };
    return { ok: true, result: json.result };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('leadgen:test-maps-key', async (_event, apiKey) => {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=30301&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status === 'OK' || json.status === 'ZERO_RESULTS') return { ok: true };
    return { ok: false, error: json.error_message || json.status };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── IPC: Lead Generation — Apollo.io ─────────────────────────────────────────

ipcMain.handle('leadgen:apollo-search', async (_event, { apiKey, companyName, domain, page }) => {
  try {
    const body = {
      api_key: apiKey,
      q_organization_name: companyName,
      person_titles: [
        'Operations Manager', 'Warehouse Manager', 'Procurement Manager',
        'Logistics Manager', 'Supply Chain Manager', 'Facilities Manager',
        'Plant Manager', 'Distribution Manager', 'Operations Director',
        'VP Operations', 'General Manager', 'Director of Operations',
      ],
      page: page || 1,
      per_page: 10,
    };
    if (domain) body.q_organization_domains = [domain];
    const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.message || `Apollo API error: HTTP ${res.status}` };
    return { ok: true, people: json.people || [], pagination: json.pagination || {} };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('leadgen:test-apollo-key', async (_event, apiKey) => {
  try {
    const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ api_key: apiKey, q_organization_name: 'test', per_page: 1, page: 1 }),
    });
    if (res.ok || res.status === 422) return { ok: true };
    const json = await res.json().catch(() => ({}));
    return { ok: false, error: json.message || `HTTP ${res.status}` };
  } catch (err) { return { ok: false, error: err.message }; }
});
