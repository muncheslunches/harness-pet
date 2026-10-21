// Persistent local diagnostics and bounded recovery for Electron subprocesses.
const fs = require('fs');
const path = require('path');
const { inspect } = require('util');

let logFile;
let writes = 0;

function record(kind, details) {
  if (!logFile) return;
  try {
    if (++writes % 128 === 0 && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      fs.renameSync(logFile, logFile + '.previous');
    }
    const line = `${new Date().toISOString()} ${kind} ${inspect(details, { depth: 4, breakLength: Infinity })}\n`;
    fs.appendFileSync(logFile, line);
  } catch { /* A failed log must not crash the app. */ }
}

function install(app, dir) {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'app.log');
  try {
    if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.previous');
  } catch {}
  record('start', { pid: process.pid, electron: process.versions.electron, app: app.getAppPath() });
  for (const level of ['warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => { record(level, args); original.apply(console, args); };
  }
  // Observe fatal exceptions without swallowing them and continuing corrupt state.
  process.on('uncaughtExceptionMonitor', (error, origin) => record('fatal', { origin, stack: error.stack }));
  app.on('child-process-gone', (_event, details) => record('child-process-gone', details));
  app.on('before-quit', () => record('quit', { pid: process.pid }));
}

// Records the open window count whenever it changes, plus a periodic sample, so a
// window leak shows up in app.log as a count that climbs and never comes back down.
function watchWindowCount(app, BrowserWindow, every = 60000) {
  let last = -1;
  const sample = (reason) => {
    const windows = BrowserWindow.getAllWindows().length;
    if (windows === last && reason === 'change') return;
    last = windows;
    let processes;
    try { processes = app.getAppMetrics().length; } catch {}
    record('windows', { windows, processes, reason });
  };
  app.on('browser-window-created', () => setTimeout(() => sample('change'), 0));
  app.on('browser-window-closed', () => setTimeout(() => sample('change'), 0));
  const timer = setInterval(() => sample('sample'), every);
  timer.unref();
  sample('start');
}

function watchWindow(win, label, reset = () => {}) {
  let failures = [];
  win.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') record('renderer-error', { window: label, message: details.message,
      source: details.sourceId, line: details.lineNumber });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    record('renderer-gone', { window: label, ...details });
    reset();
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    failures = failures.filter((t) => now - t < 60000);
    failures.push(now);
    // Don't loop forever on a broken pet or exhausted system resources.
    if (failures.length > 2) return record('renderer-recovery-stopped', { window: label });
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 500);
  });
}

module.exports = { install, watchWindow, watchWindowCount, record };
