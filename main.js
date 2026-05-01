const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const xlsx = require('xlsx');

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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDocsDir() {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
}

let mainWin = null;
let forceQuit = false;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'AFL Sales Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Intercept close to allow renderer to run backup first
  mainWin.on('close', (e) => {
    if (forceQuit) { forceQuit = false; return; }
    e.preventDefault();
    mainWin.webContents.send('app:before-close');
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ensureDataDir();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Read data ────────────────────────────────────────────────────────────
ipcMain.handle('data:read', () => {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

// ── IPC: App close flow ───────────────────────────────────────────────────────

ipcMain.handle('app:ready-to-close', () => {
  forceQuit = true;
  if (mainWin) mainWin.close();
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

      // Prune old backups
      const keepCount = opts.keepCount || 30;
      const allFiles = fs.readdirSync(folder)
        .filter(f => f.startsWith('AFL_Backup_') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const old of allFiles.slice(keepCount)) {
        try { fs.unlinkSync(path.join(folder, old)); } catch {}
      }
      results.push({ folder, ok: true });
    } catch (err) {
      if (i === 0) primaryPath = '';
      results.push({ folder, ok: false, error: err.message });
    }
  }

  const primaryOk = results[0]?.ok ?? false;
  return { ok: primaryOk, filePath: primaryPath, timestamp: now.toISOString(), results };
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
        try {
          const stat = fs.statSync(fp);
          return { name: f, fullPath: fp, size: stat.size, mtime: stat.mtime.toISOString() };
        } catch { return null; }
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
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Backup — open folder in Explorer ────────────────────────────────────

ipcMain.handle('backup:open-folder', (_event, folderPath) => {
  const target = (folderPath || DEFAULT_BACKUP_DIR).trim();
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  } catch {}
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
    // Check for changes
    const status = await gitExec('git status --porcelain', cwd);
    if (status) {
      await gitExec('git add -A', cwd);
      await gitExec(`git commit -m "${message.replace(/"/g, "'")}"`, cwd);
    }
    // Always attempt push (may have unpushed commits from a prior failed push)
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
    const log = await gitExec('git log -1 --format=%ci origin/main 2>/dev/null || echo ""', cwd);
    return { ok: true, remote, branch, lastPush: log || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
