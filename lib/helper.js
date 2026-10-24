// Talks to native/win-helper.ps1: one long-lived PowerShell process that focuses
// app windows, replays mouse-wheel notches the pets let through, and (for
// experimental voice buttons) presses buttons inside them.

const { spawn } = require('child_process');
const path = require('path');

const helper = {
  proc: null,
  queue: [],
  buf: '',
  start() {
    if (process.platform !== 'win32' || this.proc) return;
    const script = path.join(__dirname, '..', 'native', 'win-helper.ps1');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const proc = this.proc;
    this.buf = '';
    const failed = (reason) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.buf = '';
      this.queue.splice(0).forEach((cb) => cb(reason));
      proc.kill();
    };
    // A stopped helper closes its pipe. Without error listeners EPIPE (or a
    // failed PowerShell spawn) is an uncaught main-process exception.
    proc.on('error', (err) => failed('err helper-' + err.code));
    proc.stdin.on('error', () => failed('err helper-pipe-closed'));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return;
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line || line === 'ready') continue;
        const cb = this.queue.shift();
        if (cb) cb(line);
      }
    });
    this.proc.stderr.on('data', (d) => console.warn('win-helper:', String(d).trim()));
    this.proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.queue.splice(0).forEach((cb) => cb('err helper-exited'));
    });
  },
  send(cmd) {
    return new Promise((resolve) => {
      this.start();
      if (!this.proc) return resolve('err unavailable');
      this.queue.push(resolve);
      try {
        this.proc.stdin.write(cmd.replace(/[\r\n]+/g, ' ') + '\n');
      } catch {
        this.stop();
      }
    });
  },
  focus(matcher) {
    if (!matcher) return Promise.resolve('err no-matcher');
    return this.send('focus ' + JSON.stringify(matcher));
  },
  clickButton(matcher, names) {
    const clean = (names || []).map(String).filter((n) => n.trim().length >= 3);
    if (!matcher || !clean.length) return Promise.resolve('err no-names');
    return this.send('uia-click ' + JSON.stringify({ window: matcher, names: clean }));
  },
  // the window that has keyboard focus now, as a decimal HWND string (null if none or unknown)
  foreground() {
    return this.send('foreground').then((res) => {
      const m = /^ok (\d+)$/.exec(res);
      return m && m[1] !== '0' ? m[1] : null;
    });
  },
  // the app in front: { process, path, title }, or null when nothing has focus or the helper is unavailable
  foregroundApp() {
    return this.send('foreground-app').then((res) => {
      try {
        const app = res.startsWith('ok ') ? JSON.parse(res.slice(3)) : null;
        return app && app.process ? app : null;
      } catch {
        return null;
      }
    });
  },
  // whether a window matching `matcher` is open on screen (not minimized or hidden):
  // true, false, or null when that can't be told (no matcher, helper unavailable)
  windowShown(matcher) {
    if (!matcher) return Promise.resolve(null);
    return this.send('window-shown ' + JSON.stringify(matcher)).then((res) => (res === 'ok true' ? true : res === 'ok false' ? false : null));
  },
  // Where you are typing, in physical screen pixels: { caret: {x,y,w,h} | null, window: {x,y,w,h} },
  // or null when nothing has focus or the helper is unavailable.
  context() {
    return this.send('context').then((res) => {
      const n = /^ok ((?:-?\d+ ){8}-?\d+)$/.exec(res);
      if (!n) return null;
      const v = n[1].split(' ').map(Number);
      return { caret: v[0] ? { x: v[1], y: v[2], w: v[3], h: v[4] } : null, window: { x: v[5], y: v[6], w: v[7], h: v[8] } };
    });
  },
  // focus window `hwnd` again, but only while window `from` still has focus
  refocus(hwnd, from) {
    if (!/^\d+$/.test(String(hwnd))) return Promise.resolve('err no-window');
    return this.send(`refocus ${hwnd} ${/^\d+$/.test(String(from)) ? from : 0}`);
  },
  // scroll whatever window is under the cursor (120 = one notch; dy > 0 scrolls up)
  wheel(dy, dx) {
    dy = Math.max(-2400, Math.min(2400, Math.round(dy) || 0));
    dx = Math.max(-2400, Math.min(2400, Math.round(dx) || 0));
    if (!dy && !dx) return Promise.resolve('ok wheel 0');
    return this.send(`wheel ${dy} ${dx}`);
  },
  stop() {
    const proc = this.proc;
    this.proc = null;
    this.buf = '';
    this.queue.splice(0).forEach((cb) => cb('err helper-stopped'));
    if (proc) proc.kill();
  },
};

module.exports = helper;
