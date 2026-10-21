// Opt-in mouse-lag diagnostics (set HARNESS_PET_DIAG=1). Electron makes a
// click-through window forward mouse moves through a global low-level mouse hook
// that runs on the main thread, so while any pet is click-through, a main-thread
// stall freezes the cursor everywhere. This logs those stalls (with what the main
// process was doing just before), slow IPC handlers, every click-through flip per
// pet, and a summary every few seconds, to ~/.harness-pet/diag.log.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const TICK = 20; // ms between stall-detector ticks
const STALL = 60; // a tick this late (ms) counts as a stall
const SLOW = 25; // an IPC handler or setIgnoreMouseEvents call this long (ms) is logged on its own
const FLAP = 8; // click-through flips per second for one pet that count as flapping
const SUMMARY = 5000;
const KEEP = 2000; // ms of recent events kept for stall reports

const clock = (d = new Date()) => d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
const ms = (n) => (n < 10 ? n.toFixed(1) : Math.round(n)) + 'ms';

// deps: { ipcMain, windowProto, screen, pets: () => [{ name, win }], nameOfSender(wc), file, now, write, setInterval }
function install(deps) {
  const now = deps.now || (() => performance.now());
  const every = deps.setInterval || setInterval;
  let write = deps.write;
  if (!write) {
    fs.mkdirSync(path.dirname(deps.file), { recursive: true });
    const out = fs.createWriteStream(deps.file, { flags: 'a' }); // async: logging must not stall the main thread itself
    write = (line) => out.write(line + '\n');
  }
  const log = (line) => write(`[${clock()}] ${line}`);

  const recent = []; // { t, pet, what, dur }
  const ignoring = new Map(); // pet name → last setIgnoreMouseEvents value
  let stats = fresh();
  function fresh() {
    return { pets: new Map(), stalls: 0, worstStall: 0, since: now() };
  }
  function petStats(name) {
    if (!stats.pets.has(name)) stats.pets.set(name, { flips: 0, ipc: 0, ipcMs: 0, slowest: null, flipTimes: [] });
    return stats.pets.get(name);
  }
  function remember(t, pet, what, dur) {
    recent.push({ t, pet, what, dur });
    while (recent.length && recent[0].t < t - KEEP) recent.shift();
  }
  const petOfWindow = (win) => {
    for (const p of deps.pets()) if (p.win === win) return p.name;
    return 'window';
  };

  // time every ipcMain.on handler registered from now on, labelled by the pet that sent it
  const on = deps.ipcMain.on;
  deps.ipcMain.on = function (channel, handler) {
    return on.call(this, channel, function (e, ...args) {
      const t0 = now();
      try {
        return handler.call(this, e, ...args);
      } finally {
        const dur = now() - t0;
        const pet = (e && e.sender && deps.nameOfSender(e.sender)) || 'app';
        const s = petStats(pet);
        s.ipc++;
        s.ipcMs += dur;
        if (!s.slowest || dur > s.slowest.dur) s.slowest = { channel, dur };
        const detail = channel === 'pet:hold' ? `${channel}(${JSON.stringify(args[0])})` : channel;
        remember(t0, pet, detail, dur);
        if (dur > SLOW) log(`SLOW ipc ${detail} from ${pet} took ${ms(dur)}`);
      }
    });
  };

  // every click-through flip, from any call site
  const setIgnore = deps.windowProto.setIgnoreMouseEvents;
  deps.windowProto.setIgnoreMouseEvents = function (ignore, opts) {
    const t0 = now();
    const r = setIgnore.call(this, ignore, opts);
    const dur = now() - t0;
    const pet = petOfWindow(this);
    const was = ignoring.get(pet);
    ignoring.set(pet, !!ignore);
    remember(t0, pet, ignore ? 'click-through ON' : 'click-through OFF (catching mouse)', dur);
    if (dur > SLOW) log(`SLOW setIgnoreMouseEvents(${!!ignore}) on ${pet} took ${ms(dur)}`);
    if ((was === undefined ? true : was) !== !!ignore) { // pet windows start click-through
      const s = petStats(pet);
      s.flips++;
      s.flipTimes.push(t0);
      while (s.flipTimes.length && s.flipTimes[0] < t0 - 1000) s.flipTimes.shift();
      if (s.flipTimes.length === FLAP) log(`FLAP ${pet} flipped click-through ${FLAP}× in the last second`);
    }
    return r;
  };

  function whereIsCursor() {
    let p;
    try {
      p = deps.screen.getCursorScreenPoint();
    } catch {
      return 'cursor ?';
    }
    const over = [];
    for (const { name, win } of deps.pets()) {
      if (!win || win.isDestroyed()) continue;
      const b = win.getBounds();
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) {
        over.push(`${name}${ignoring.get(name) === false ? ' (catching mouse)' : ''}`);
      }
    }
    return `cursor ${p.x},${p.y} inside window of: ${over.join(', ') || 'no pet'}`;
  }

  // stall detector: a late tick means the main thread was busy for that long
  let last = now();
  every(() => {
    const t = now();
    const late = t - last - TICK;
    last = t;
    if (late < STALL) return;
    stats.stalls++;
    stats.worstStall = Math.max(stats.worstStall, late);
    const before = recent.filter((r) => r.t >= t - late - TICK - 300);
    const byWhat = new Map();
    for (const r of before) {
      const k = `${r.pet}: ${r.what}`;
      const v = byWhat.get(k) || { n: 0, dur: 0 };
      v.n++;
      v.dur += r.dur;
      byWhat.set(k, v);
    }
    const what = [...byWhat].sort((a, b) => b[1].dur - a[1].dur).slice(0, 6).map(([k, v]) => `${k} ×${v.n} (${ms(v.dur)})`);
    log(`STALL main thread blocked ~${ms(late)} | ${whereIsCursor()} | just before: ${what.join('; ') || 'no IPC (native work, GC or a timer)'}`);
  }, TICK);

  let laidOut = false;
  every(() => {
    if (!laidOut) {
      // once: where every pet window is, since overlapping windows are a suspect
      laidOut = true;
      const wins = deps.pets().filter((p) => p.win && !p.win.isDestroyed()).map((p) => {
        const b = p.win.getBounds();
        return `${p.name} ${b.width}×${b.height} at ${b.x},${b.y}`;
      });
      log(`windows | ${wins.join(' | ')}`);
    }
    const secs = (now() - stats.since) / 1000;
    const parts = [];
    for (const [name, s] of stats.pets) {
      if (!s.flips && !s.ipc) continue;
      const slow = s.slowest ? `, slowest ${s.slowest.channel} ${ms(s.slowest.dur)}` : '';
      parts.push(`${name}: ${s.flips} flips, ${s.ipc} ipc (${ms(s.ipcMs)} total${slow})`);
    }
    if (parts.length || stats.stalls) {
      log(`summary ${secs.toFixed(0)}s | stalls ${stats.stalls}${stats.stalls ? ` (worst ${ms(stats.worstStall)})` : ''} | ${parts.join(' | ')}`);
    }
    stats = fresh();
  }, SUMMARY);

  log(`---- diagnostics on (pid ${process.pid}, electron ${process.versions.electron || '-'}) ----`);
  return { log };
}

module.exports = { install, enabled: () => !!process.env.HARNESS_PET_DIAG, TICK, STALL, SLOW, FLAP };
