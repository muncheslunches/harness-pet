// Runs native/key-watch.ps1 and turns its output into two events: "you are typing"
// and "you typed one of the capital-letter commands". It never sees which keys you
// press except while Caps Lock is on, and then keeps only a short rolling buffer of
// capital letters (see key-phrases.js). Nothing is stored or sent anywhere.

const { spawn } = require('child_process');
const path = require('path');
const { createPhraseMatcher } = require('./key-phrases');

const RESTART_MS = [2000, 10000, 60000]; // back-off if the watcher dies

function parseKeyLine(line) {
  const m = /^k (\d+) (\d+)$/.exec(line);
  if (!m) return null;
  const fl = Number(m[2]);
  return { vk: Number(m[1]), shift: !!(fl & 1), ctrl: !!(fl & 2), alt: !!(fl & 4), win: !!(fl & 8), caps: !!(fl & 16) };
}

function create({ onTyping, onPhrase, spawnProcess = spawn, platform = process.platform, script } = {}) {
  let proc = null;
  let wanted = false;
  let failures = 0;
  let retry = null;
  const matcher = createPhraseMatcher({ onMatch: (phrase) => onPhrase && onPhrase(phrase) });

  function handle(line) {
    if (line === 't') return onTyping && onTyping();
    const key = parseKeyLine(line);
    if (key) matcher.key(key);
  }

  function launch() {
    if (!wanted || proc || platform !== 'win32') return;
    const file = script || path.join(__dirname, '..', 'native', 'key-watch.ps1');
    // scripts/e2e-avoid.js types its own test keys; they are normally ignored as "not typed by you"
    const extra = process.env.HARNESS_PET_KEYWATCH_INJECTED ? ['-AllowInjected'] : [];
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...extra], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!wanted || proc !== child) return;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') { failures = 0; if (process.env.HARNESS_PET_AVOID_LOG) console.log('[key-watch] ready'); }
        else if (line) handle(line);
      }
    });
    child.stderr.on('data', (d) => console.warn('key-watch:', String(d).trim()));
    child.stdin.on('error', () => {});
    const ended = () => {
      if (proc !== child) return;
      proc = null;
      matcher.reset();
      if (!wanted) return;
      retry = setTimeout(launch, RESTART_MS[Math.min(failures++, RESTART_MS.length - 1)]);
      if (retry.unref) retry.unref();
    };
    child.on('error', ended);
    child.on('exit', ended);
  }

  return {
    start() {
      wanted = true;
      launch();
    },
    stop() {
      wanted = false;
      clearTimeout(retry);
      matcher.reset();
      const child = proc;
      proc = null;
      if (!child) return;
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref?.();
    },
    get running() { return !!proc; },
    // exposed for tests
    handle,
  };
}

module.exports = { create, parseKeyLine };
