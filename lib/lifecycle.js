// Persistent local diagnostics and bounded recovery for Electron subprocesses.
const fs = require('fs');
const path = require('path');
const { inspect } = require('util');

let logFile;
let writes = 0;
let verbose = false;

// Verbose logging (General settings, or HARNESS_PET_VERBOSE=1) adds routine
// events to app.log: pet windows showing and hiding, input, memory samples.
function setVerbose(on) {
  verbose = !!on || !!process.env.HARNESS_PET_VERBOSE;
}

function trace(kind, details) {
  if (verbose) record(kind, details);
}

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
  setVerbose(verbose);
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
    let metrics = [];
    try { metrics = app.getAppMetrics(); } catch {}
    record('windows', { windows, processes: metrics.length, reason });
    if (verbose && reason === 'sample') record('memory', memoryReport(metrics, BrowserWindow));
  };
  app.on('browser-window-created', () => setTimeout(() => sample('change'), 0));
  app.on('browser-window-closed', () => setTimeout(() => sample('change'), 0));
  const timer = setInterval(() => sample('sample'), every);
  timer.unref();
  sample('start');
}

// Memory per process (MB), named by the window it draws where there is one, plus
// how much the system has left: pets vanishing under memory pressure shows up here.
function memoryReport(metrics, BrowserWindow) {
  const names = new Map();
  for (const w of BrowserWindow.getAllWindows()) {
    try { names.set(w.webContents.getOSProcessId(), w.getTitle() || 'window'); } catch {}
  }
  const mb = (kb) => Math.round((kb || 0) / 1024);
  const out = { processes: metrics.map((m) => `${names.get(m.pid) || m.type}:${mb(m.memory?.workingSetSize)}MB`).join(' ') };
  try {
    const sys = process.getSystemMemoryInfo();
    out.systemFreeMB = mb(sys.free);
    out.systemTotalMB = mb(sys.total);
  } catch {}
  out.mainHeapMB = Math.round(process.memoryUsage().heapUsed / 1048576);
  return out;
}

function watchWindow(win, label, reset = () => {}) {
  let failures = [];
  win.on('unresponsive', () => record('window-unresponsive', { window: label }));
  win.on('responsive', () => record('window-responsive', { window: label }));
  win.on('show', () => trace('window-show', { window: label }));
  win.on('hide', () => trace('window-hide', { window: label }));
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

module.exports = { install, watchWindow, watchWindowCount, record, trace, setVerbose, isVerbose: () => verbose };
