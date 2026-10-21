// Security utilities for Harness Pet: URL and path validation for sandboxing.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

function getAllowedDirs(appDir = path.resolve(__dirname, '..'), petsDir = null) {
  const dirs = [
    ...['studio', 'pet-window', 'runtime', 'shared', 'assets', 'pets'].map(d => path.resolve(appDir, d)),
  ];
  if (petsDir) dirs.push(path.resolve(petsDir));
  return [...new Set(dirs)];
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Require both lexical containment and real filesystem containment. Missing files,
// UNC/device paths and NTFS alternate streams fail closed.
function isAllowedFile(target, dirs) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || /[\x00-\x1f]/.test(target)) return false;
  if (process.platform === 'win32' && (/^[\\/]{2}/.test(target) || target.slice(2).includes(':'))) return false;
  try {
    const resolved = path.resolve(target);
    const real = fs.realpathSync(resolved);
    return dirs.some(d => {
      try { return within(path.resolve(d), resolved) && within(fs.realpathSync(d), real); } catch { return false; }
    });
  } catch { return false; }
}

function isAllowedUrl(rawUrl, allowedDirs = getAllowedDirs()) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  if (/^(devtools|data|blob):/.test(rawUrl)) return true;
  if (/^file:/.test(rawUrl)) {
    try {
      const filePath = fileURLToPath(rawUrl);
      return isAllowedFile(filePath, allowedDirs);
    } catch {
      return false;
    }
  }
  return false;
}

function isTrustedSender(event, win, page) {
  try {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(page);
  } catch { return false; }
}

function protectWindow(win) {
  const wc = win.webContents;
  // App-directed loadFile/reload still work; renderer-directed navigation never does.
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) wc.on(name, e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function protectSession(session, dirs) {
  session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedUrl(details.url, dirs) }));
  session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', e => e.preventDefault());
}

function isAllowedOpenPath(targetPath, allowedPaths = []) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  try {
    const resolved = path.resolve(targetPath).toLowerCase();
    return allowedPaths.some((allowed) => {
      if (typeof allowed !== 'string' || !allowed.trim()) return false;
      return path.resolve(allowed).toLowerCase() === resolved;
    });
  } catch {
    return false;
  }
}

module.exports = {
  getAllowedDirs,
  isAllowedUrl,
  isAllowedOpenPath,
  isAllowedFile, within, isTrustedSender, protectWindow, protectSession,
};
