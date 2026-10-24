// Runs every pet on screen: one transparent window per pet, placement that keeps
// the pet still while its panels flip sides, a movement engine (walls, leash,
// falling), pet-to-pet interactions, session routing and button actions.

const { BrowserWindow, screen, shell, ipcMain, clipboard, powerMonitor } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const library = require('./library');
const helper = require('./helper');
const Harnesses = require('../shared/harnesses.js');
const prompts = require('./prompts');
const diag = require('./diag');
const instanceOptions = require('./instance-options');
const Controls = require('../shared/pet-controls');
const lifecycle = require('./lifecycle');
const turnCheck = require('./turn-check');
const security = require('./security');
const ipcPolicy = require('./ipc-policy');
const linkPolicy = require('./link-policy');
const shake = require('./shake');

const BAR_ROOM = 46; // button bar under the pet
const GRAVITY = 2600; // px/s² when "fall when dropped" is on
const DEBUG = !!process.env.HARNESS_PET_DEBUG;
const PRIORITY = { 'needs-you': 4, working: 3, thinking: 2, done: 1, idle: 0 };
const SPLIT_MS = 850;
const AVOID_NOTICE_MS = 900; // the pet reacts this long before it walks off
const AVOID_PANIC_MS = 2400; // ... and this long when there is nowhere bare to go
const AVOID_WALK = 80; // px/s, scaled by the pet's speed settings
const AVOID_RUN = 150;
// Electron rejects -0 as an integer argument. Rounding a small negative coordinate produces it.
const screenPixel = (value) => Math.round(value) || 0;

const live = new Map(); // uid → runtime state
let ctx = null; // { prefs, links, save, nodePath, onChange, menuFor }
let sessions = [];
let activeMenu = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const instOf = (uid) => ctx.prefs.instances.find((i) => i.uid === uid);

// ---------- sessions ----------

function readSessions() {
  const now = Date.now();
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(store.PATHS.sessions).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(store.PATHS.sessions, name);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (now - (s.ts || 0) > 24 * 3600e3) {
      fs.rmSync(file, { force: true });
      continue;
    }
    // the agent's own transcript says the turn is over even though the Stop hook never landed
    const ended = turnCheck.finishedAt(s, now);
    if (ended) s = { ...s, state: 'done', detail: 'Finished', since: ended, ts: ended };
    const age = now - (s.ts || 0);
    let effective = s.state;
    if ((s.state === 'working' || s.state === 'thinking') && age > 30 * 60e3) effective = 'idle';
    if (s.state === 'needs-you' && age > 3 * 3600e3) effective = 'idle';
    if (s.state === 'done' && age > 12e3) effective = 'idle';
    out.push({ ...s, harness: s.harness || 'claude-code', effective: PRIORITY[effective] !== undefined ? effective : 'idle', age, unseen: isUnseen(s, now) });
  }
  out.sort((a, b) => PRIORITY[b.effective] - PRIORITY[a.effective] || b.ts - a.ts);
  return out;
}

function sessionsFor(inst) {
  if (!inst.harness) return []; // not following any agent yet
  return inst.harness === 'any' ? sessions : sessions.filter((s) => s.harness === inst.harness);
}

// A finished turn stays "unseen" (the pet keeps a check mark) until you open the agent
// from the pet or switch to its window, so a finish you missed doesn't look like idle.
// Turns that ended before the app started, or long ago, count as seen.
const UNSEEN_MS = 3 * 3600e3;
const appStarted = Date.now();
const seen = new Map(); // sessionId → ts of the finished turn you have seen

function isUnseen(s, now) {
  if (s.state !== 'done' || !s.sessionId) return false;
  const ts = s.ts || 0;
  return ts >= appStarted && now - ts < UNSEEN_MS && seen.get(s.sessionId) !== ts;
}

function markSeen(list) {
  let changed = false;
  for (const s of list) {
    if (!s.unseen) continue;
    seen.set(s.sessionId, s.ts);
    s.unseen = false;
    changed = true;
  }
  if (changed) for (const [uid, rt] of live) { const inst = instOf(uid); if (inst && rt.win && !rt.win.isDestroyed()) sendSessions(inst, rt); }
}

// Switching to an agent's window counts as having seen what it finished.
let seenBusy = false;
async function seenCheck() {
  if (seenBusy || !ctx || !sessions.some((s) => s.unseen)) return;
  seenBusy = true;
  try {
    const fg = await helper.foregroundApp();
    if (fg) markSeen(sessions.filter((s) => s.unseen && windowMatches((ctx.links.links || {})[s.harness]?.window, fg)));
  } catch (err) {
    console.warn('seen check failed:', err.message);
  } finally {
    seenBusy = false;
  }
}

// The renderer only draws from this list, and shows age in whole minutes, so a send is
// skipped while nothing it could show has changed. `force` re-sends after a (re)load.
function sendSessions(inst, rt, force = false) {
  const list = sessionsFor(inst);
  const sig = JSON.stringify(list, (key, value) => (key === 'age' ? Math.round(value / 60000) : value));
  if (!force && sig === rt.sessionsSig) return;
  rt.sessionsSig = sig;
  rt.win.webContents.send('sessions', list);
}

function pollSessions() {
  sessions = readSessions();
  for (const [uid, rt] of live) {
    const inst = instOf(uid);
    if (inst && rt.win && !rt.win.isDestroyed()) sendSessions(inst, rt);
  }
}

// ---------- geometry ----------

function petScreen(rt) {
  const o = rt.anchoredOffset();
  return { x: rt.anchor.x + o.x, y: rt.anchor.y + o.y, w: rt.rect.w, h: rt.rect.h };
}

function displayFor(p) {
  return screen.getDisplayNearestPoint({ x: screenPixel(p.x + p.w / 2), y: screenPixel(p.y + p.h / 2) });
}

// Where the pet (its top-left) is allowed to be, given its containment setting.
function bounds(inst, rt, p) {
  const c = inst.behavior.containment;
  let a;
  if (c === 'all') {
    const all = screen.getAllDisplays().map((d) => d.workArea);
    const x0 = Math.min(...all.map((r) => r.x));
    const y0 = Math.min(...all.map((r) => r.y));
    const x1 = Math.max(...all.map((r) => r.x + r.width));
    const y1 = Math.max(...all.map((r) => r.y + r.height));
    a = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  } else {
    const d = screen.getAllDisplays().find((x) => x.id === rt.homeDisplay) || displayFor(p);
    a = d.workArea;
  }
  const minY = c === 'taskbar' ? a.y + a.height - p.h - BAR_ROOM : a.y;
  return { x0: a.x, x1: a.x + a.width - p.w, y0: minY, y1: a.y + a.height - p.h - BAR_ROOM };
}

function onSomeDisplay(p) {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return screen.getAllDisplays().some(({ bounds: b }) => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height);
}

// The renderer places the bubble and menus itself; it needs the work area of the
// screen the pet is on (sent whenever that screen changes).
function sendScreen(rt, force) {
  if (!rt.win || rt.win.isDestroyed() || !rt.anchor) return;
  const d = displayFor(petScreen(rt));
  if (!force && d.id === rt.screenId) return;
  rt.screenId = d.id;
  rt.win.webContents.send('screen', { work: d.workArea, bounds: d.bounds });
}

// Keep the pet's base position at rt.anchor; move the window around it.
function positionWindow(rt) {
  if (!rt.win || rt.win.isDestroyed() || !rt.anchor) return;
  const x = rt.anchor.x - rt.rect.x;
  const y = rt.anchor.y - rt.rect.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    // never hand Electron a NaN: it throws in the main process
    console.warn('pet position is not a number; ignoring', JSON.stringify(rt.anchor), JSON.stringify(rt.rect));
    return;
  }
  rt.win.setPosition(screenPixel(x), screenPixel(y));
  sendScreen(rt);
}

function clampAnchor(inst, rt) {
  const p = { ...rt.anchor, w: rt.rect.w, h: rt.rect.h };
  const b = bounds(inst, rt, p);
  rt.anchor.x = Math.min(Math.max(p.x, b.x0), Math.max(b.x0, b.x1));
  rt.anchor.y = Math.min(Math.max(p.y, b.y0), Math.max(b.y0, b.y1));
}

function recoverMotion(rt) {
  rt.vel = rt.fall = rt.push = rt.drag = null;
  rt.avoid = null;
  rt.collisionUntil = 0;
  rt.collisionStreak = null;
  rt.win.webContents.send('recover-motion');
}

function recoverPosition(inst, rt) {
  clampAnchor(inst, rt);
  if (!onSomeDisplay({ ...rt.anchor, w: rt.rect.w, h: rt.rect.h })) {
    const a = displayFor({ ...rt.anchor, w: rt.rect.w, h: rt.rect.h }).workArea;
    rt.anchor = { x: Math.max(a.x, Math.min(rt.anchor.x, a.x + a.width - rt.rect.w)),
      y: Math.max(a.y, Math.min(rt.anchor.y, a.y + a.height - rt.rect.h - BAR_ROOM)) };
  }
  positionWindow(rt);
}

function relayout(inst, rt) {
  sendScreen(rt);
}

function savePos(inst, rt) {
  inst.pos = { x: screenPixel(rt.anchor.x), y: screenPixel(rt.anchor.y) };
  inst.display = displayFor(petScreen(rt)).id;
  rt.homeDisplay = inst.display;
  ctx.save();
}

// ---------- movement engine ----------

let ticker = null;
let lastTick = 0;

function ensureTicker() {
  if (ticker) return;
  lastTick = Date.now();
  ticker = setInterval(tick, 16);
}

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  let busy = false;
  for (const [uid, rt] of live) {
    const inst = instOf(uid);
    // a pet that has not reported its size yet has no position to move from
    if (!inst || !rt.win || rt.win.isDestroyed() || rt.drag || rt.menuOpen || !rt.ready || !rt.anchor) continue;
    try {
      if (inst.asleep || inst.sitting) { rt.vel = rt.fall = rt.push = rt.split = null; if (rt.avoid) avoidCancel(uid, 'asleep'); continue; }
      if (rt.split) busy = stepSplit(inst, rt, now) || busy;
      else if (rt.duplicateUntil > now) busy = true;
      else if (inst.visible === false) continue;
      else if (rt.fall) busy = stepFall(inst, rt, dt) || busy;
      else if (rt.push) busy = stepPush(inst, rt) || busy;
      else if (rt.avoid && rt.avoid.phase !== 'park') busy = stepAvoid(inst, rt, dt, now) || busy;
      else if (rt.vel) busy = stepMove(inst, rt, dt) || busy;
    } catch (err) {
      // one broken pet must not stop the others or leave the ticker throwing every frame
      console.error('pet movement failed:', err);
      recoverMotion(rt);
    }
  }
  if (!busy) {
    clearInterval(ticker);
    ticker = null;
  }
}

function getActiveCage() {
  const cageInst = ctx?.prefs?.instances?.find((i) => (i.isCage || i.uid === 'cage') && i.visible !== false);
  if (!cageInst) return null;
  const rt = live.get(cageInst.uid);
  return rt && rt.ready && rt.win && !rt.win.isDestroyed() && rt.win.isVisible() ? { inst: cageInst, rt } : null;
}

function cageInterior(cageRt, petRt) {
  const cb = petScreen(cageRt);
  const pw = petRt?.rect?.w || 60;
  const ph = petRt?.rect?.h || 60;
  return {
    x0: cb.x + cb.w * 0.14,
    x1: Math.max(cb.x + cb.w * 0.14, cb.x + cb.w * 0.86 - pw),
    y0: cb.y + cb.h * 0.35,
    y1: Math.max(cb.y + cb.h * 0.35, cb.y + cb.h * 0.82 - ph),
  };
}

function clampInsideCage(inst, rt, cageRt) {
  const b = cageInterior(cageRt, rt);
  const cur = petScreen(rt);
  const cx = Math.max(b.x0, Math.min(b.x1, cur.x));
  const cy = Math.max(b.y0, Math.min(b.y1, cur.y));
  rt.anchor = { x: cx, y: cy };
  rt.offset = { x: 0, y: 0 };
  if (rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('offset', rt.offset);
}

// The cage's rect on screen right now, also while it is being dragged (its anchor
// only catches up when the drag ends).
function cageRectNow(cageRt) {
  const [wx, wy] = cageRt.win.getPosition();
  return { x: wx + cageRt.rect.x, y: wy + cageRt.rect.y, w: cageRt.rect.w, h: cageRt.rect.h };
}

// Where a pet lands when it gets out of the cage: beside it on the `side` it was
// thrown to if there is room, else the other side, else on top. Clear of the
// margin uncaged pets keep from the cage, so it can walk off.
function besideCage(inst, rt, cb, side) {
  const gap = 32;
  const w = rt.rect.w, h = rt.rect.h;
  const left = { x: cb.x - gap - w, y: cb.y + cb.h - h };
  const right = { x: cb.x + cb.w + gap, y: cb.y + cb.h - h };
  const top = { x: cb.x + (cb.w - w) / 2, y: cb.y - gap - h };
  for (const s of side < 0 ? [left, right, top] : [right, left, top]) {
    const b = bounds(inst, rt, { ...s, w, h });
    const spot = s === top ? s : { x: s.x, y: clamp(s.y, b.y0, b.y1) };
    if (spot.x >= b.x0 && spot.x <= b.x1 && spot.y >= b.y0 && spot.y <= b.y1) return spot;
  }
  return left;
}

const FREED_LINES = ['Free at last!', "I'm out!", 'Freedom!', 'Wheee!'];

// Shaken loose. A pet that is being dragged out lands where it is dropped; the
// others tumble out beside the cage (and fall, if they fall when dropped).
function freeFromCage(inst, rt, cb, side) {
  inst.caged = false;
  delete rt.cageDragOrigin;
  rt.vel = rt.push = null;
  if (cb && !rt.drag && rt.ready && rt.anchor) {
    rt.anchor = besideCage(inst, rt, cb, side);
    rt.offset = { x: 0, y: 0 };
    rt.win.webContents.send('offset', rt.offset);
    clampAnchor(inst, rt);
    positionWindow(rt);
    savePos(inst, rt);
    if (inst.behavior.fallWhenDropped && bounds(inst, rt, { ...rt.anchor, w: rt.rect.w, h: rt.rect.h }).y1 - rt.anchor.y > 30) {
      rt.fall = { vy: 0 };
      rt.win.webContents.send('fall', { phase: 'start' });
      ensureTicker();
    }
  }
  rt.win.webContents.send('instance', inst);
  notice(rt, FREED_LINES[Math.floor(Math.random() * FREED_LINES.length)]);
  interact(rt, 'shoo', side, 0);
  lifecycle.trace('cage-shaken', { uid: inst.uid, dragged: !!rt.drag });
}

// Shaking the cage empties it; shaking a caged pet frees just that one.
function shaken(inst, rt) {
  if (inst.isCage) {
    const cb = cageRectNow(rt);
    let side = 1;
    for (const other of ctx.prefs.instances) {
      if (!other.caged) continue;
      const ort = live.get(other.uid);
      side = -side;
      if (ort?.win && !ort.win.isDestroyed()) freeFromCage(other, ort, cb, side);
      else other.caged = false;
    }
  } else if (inst.caged) {
    freeFromCage(inst, rt, null, 1);
    rt.shakenFree = true; // dropped back inside the cage, it is not caught again
  } else return;
  ctx.save();
  ctx.onChange();
}

function speedFactor(inst) {
  // bigger pets are a little slower; caged pets move 60% slower (0.4x speed)
  const base = inst.behavior.speed * Math.pow(inst.size, -0.4);
  return inst.caged ? base * 0.4 : base;
}

function overlapsOther(uid, p) {
  const me = instOf(uid);
  if (me?.behavior.passThroughPets || me?.caged || me?.isCage) return null;
  const shrink = (r) => ({ x: r.x + r.w * 0.18, y: r.y + r.h * 0.25, w: r.w * 0.64, h: r.h * 0.6 });
  const a = shrink(p);
  for (const [other, ort] of live) {
    if (other === uid || !ort.ready || ort.split || ort.duplicateUntil > Date.now() || !ort.win.isVisible()) continue;
    const oi = instOf(other);
    if (!oi || !oi.behavior.social || oi.behavior.passThroughPets || oi.caged || oi.isCage) continue;
    const b = shrink(petScreen(ort));
    if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return { uid: other, rt: ort, rect: petScreen(ort) };
  }
  return null;
}

function duplicateTarget(inst, rt, origin) {
  const w = rt.rect.w, h = rt.rect.h;
  const fits = (p) => ![...live.values()].some((other) => {
    if (other === rt || !other.ready || !other.win || other.win.isDestroyed() || !other.win.isVisible()) return false;
    const r = other.split?.to ? { ...other.split.to, w: other.rect.w, h: other.rect.h } : petScreen(other);
    return p.x < r.x + r.w + 8 && p.x + w + 8 > r.x && p.y < r.y + r.h + 8 && p.y + h + 8 > r.y;
  });
  const b = bounds(inst, rt, { ...origin, w, h });
  let fallback = origin;
  for (let ring = 1; ring <= 12; ring++) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
      const p = { x: Math.max(b.x0, Math.min(b.x1, origin.x + dx * ring * (w + 18))),
        y: Math.max(b.y0, Math.min(b.y1, origin.y + dy * ring * (h + 18))), w, h };
      if (!onSomeDisplay(p)) continue;
      fallback = p;
      if (fits(p)) return { x: p.x, y: p.y };
    }
  }
  return { x: fallback.x, y: fallback.y };
}

function beginSplit(inst, rt) {
  const source = live.get(rt.splitSource);
  rt.splitSource = null;
  if (!source?.ready || !source.anchor || source.win.isDestroyed() || !source.win.isVisible()) return;
  const p = petScreen(source);
  const from = { x: p.x, y: p.y };
  rt.homeDisplay = source.homeDisplay;
  const to = duplicateTarget(inst, rt, from);
  rt.anchor = from;
  rt.split = { from, to, since: Date.now() };
  const duration = SPLIT_MS;
  source.duplicateUntil = Date.now() + duration;
  source.vel = source.fall = source.push = null;
  source.win.webContents.send('duplicate-effect', { role: 'source', duration });
  rt.win.webContents.send('duplicate-effect', { role: 'copy', duration });
  positionWindow(rt);
  ensureTicker();
}

function stepSplit(inst, rt, now) {
  const split = rt.split;
  const t = Math.min(1, Math.max(0, (now - split.since) / SPLIT_MS));
  const progress = Math.max(0, (t - 0.2) / 0.8);
  const ease = progress * progress * (3 - 2 * progress);
  rt.anchor = { x: split.from.x + (split.to.x - split.from.x) * ease,
    y: split.from.y + (split.to.y - split.from.y) * ease };
  positionWindow(rt);
  if (t >= 1) {
    rt.split = null;
    savePos(inst, rt);
  }
  return t < 1;
}

function interact(rt, type, dir, distance) {
  const inst = instOf(rt.uid);
  if (inst?.caged || inst?.isCage) return;
  if (rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('interact', { type, dir, distance });
}

function approaching(p, hit, dx, dy) {
  const x = hit.rect.x + hit.rect.w / 2 - (p.x + p.w / 2);
  const y = hit.rect.y + hit.rect.h / 2 - (p.y + p.h / 2);
  return dx * x + dy * y > 0;
}

function bumpInto(uid, rt, hit) {
  const key = [uid, hit.uid].sort().join('|');
  const now = Date.now();
  const me = petScreen(rt);
  const dir = hit.rect.x + hit.rect.w / 2 > me.x + me.w / 2 ? 1 : -1;
  const previous = rt.collisionStreak;
  const count = previous && previous.uid === hit.uid && now - previous.last < 15000 ? previous.count + 1 : 1;
  rt.collisionStreak = { uid: hit.uid, count, last: now };
  if (count >= 3) {
    rt.collisionUntil = now + 10000;
    rt.collisionStreak = null;
  }
  rt.vel = null;
  rt.win.webContents.send('move-state', { stop: true, blocked: dir > 0 ? { right: true } : { left: true }, retryAfter: rt.collisionUntil || 0 });
  // rejected: shoved back a little
  rt.push = { dx: -dir * Math.max(18, me.w * 0.25), dy: 0, ticks: 12 };
  if ((rt.bumpCooldown.get(key) || 0) > now) return;
  rt.bumpCooldown.set(key, now + 2500);
  interact(rt, 'bump', dir, 0);
  interact(hit.rt, 'shoo', -dir, 0);
}

function stepMove(inst, rt, dt) {
  const k = speedFactor(inst);
  let dx = rt.vel.vx * k * dt;
  let dy = inst.behavior.containment === 'taskbar' ? 0 : rt.vel.vy * k * dt;
  const blocked = {};
  if (inst.behavior.anchored) {
    const L = rt.rect.w;
    const o = rt.offset;
    let nx = o.x + dx;
    let ny = o.y + dy;
    if (nx < -L) { nx = -L; blocked.left = true; }
    if (nx > L) { nx = L; blocked.right = true; }
    if (ny < -0.8 * L) { ny = -0.8 * L; blocked.top = true; }
    if (ny > 0) { ny = 0; blocked.bottom = true; }
    const next = { x: rt.anchor.x + nx, y: rt.anchor.y + ny, w: rt.rect.w, h: rt.rect.h };
    const hit = overlapsOther(rt.uid, next);
    if (hit && approaching(petScreen(rt), hit, dx, dy)) return bumpInto(rt.uid, rt, hit), true;
    rt.offset = { x: nx, y: ny };
    rt.win.webContents.send('offset', rt.offset);
  } else {
    const p = { ...rt.anchor, w: rt.rect.w, h: rt.rect.h };
    let b;
    const cage = getActiveCage();
    if (inst.caged && cage) {
      b = cageInterior(cage.rt, rt);
    } else {
      b = bounds(inst, rt, p);
    }
    let nx = p.x + dx;
    let ny = p.y + dy;
    if (nx < b.x0) { nx = b.x0; blocked.left = true; }
    if (nx > b.x1) { nx = b.x1; blocked.right = true; }
    if (ny < b.y0) { ny = b.y0; blocked.top = true; }
    if (ny > b.y1) { ny = b.y1; blocked.bottom = true; }
    const next = { x: nx, y: ny, w: p.w, h: p.h };

    // Uncaged pets avoid the cage, steering away and not clashing into it
    if (!inst.caged && !inst.isCage && cage) {
      const cb = petScreen(cage.rt);
      const margin = 20;
      const avoid = { x0: cb.x - margin, x1: cb.x + cb.w + margin, y0: cb.y - margin, y1: cb.y + cb.h + margin };
      if (next.x + next.w > avoid.x0 && next.x < avoid.x1 && next.y + next.h > avoid.y0 && next.y < avoid.y1) {
        if (dx > 0 && p.x + p.w <= avoid.x0 + 6) { blocked.right = true; nx = p.x; }
        else if (dx < 0 && p.x >= avoid.x1 - 6) { blocked.left = true; nx = p.x; }
        else { blocked.left = true; blocked.right = true; nx = p.x; }
        rt.vel = null;
        rt.win.webContents.send('move-state', { stop: true, blocked });
        return true;
      }
    }

    if (inst.behavior.containment === 'all' && !onSomeDisplay(next)) {
      if (dx) blocked[dx < 0 ? 'left' : 'right'] = true;
      if (dy) blocked[dy < 0 ? 'top' : 'bottom'] = true;
    } else {
      const hit = overlapsOther(rt.uid, next);
      if (hit && approaching(p, hit, dx, dy)) return bumpInto(rt.uid, rt, hit), true;
      rt.anchor = { x: nx, y: ny };
      positionWindow(rt);
    }
  }
  rt.moveTicks = (rt.moveTicks || 0) + 1;
  if (rt.moveTicks % 3 === 0 || Object.keys(blocked).length) rt.win.webContents.send('move-state', { blocked, offset: rt.offset });
  return true;
}

function stepPush(inst, rt) {
  const step = { x: rt.push.dx / rt.push.ticks, y: rt.push.dy / rt.push.ticks };
  rt.push.left = (rt.push.left === undefined ? rt.push.ticks : rt.push.left) - 1;
  if (inst.behavior.anchored) {
    const L = rt.rect.w;
    rt.offset = { x: Math.max(-L, Math.min(L, rt.offset.x + step.x)), y: Math.max(-0.8 * L, Math.min(0, rt.offset.y + step.y)) };
    rt.win.webContents.send('offset', rt.offset);
  } else {
    rt.anchor = { x: rt.anchor.x + step.x, y: rt.anchor.y + step.y };
    clampAnchor(inst, rt);
    positionWindow(rt);
  }
  if (rt.push.left <= 0) {
    rt.push = null;
    if (!inst.behavior.anchored) {
      relayout(inst, rt);
      savePos(inst, rt);
    }
  }
  return true;
}

function stepFall(inst, rt, dt) {
  rt.fall.vy += GRAVITY * dt;
  const p = { ...rt.anchor, w: rt.rect.w, h: rt.rect.h };
  const cage = getActiveCage();
  const floor = (inst.caged && cage) ? cageInterior(cage.rt, rt).y1 : bounds(inst, rt, p).y1;
  rt.anchor.y = Math.min(floor, rt.anchor.y + rt.fall.vy * dt);
  positionWindow(rt);
  if (rt.anchor.y >= floor) {
    rt.fall = null;
    rt.win.webContents.send('fall', { phase: 'end' });
    relayout(inst, rt);
    savePos(inst, rt);
    resolveDropOverlap(inst, rt);
  }
  return true;
}

// Dropped on top of another pet: the other one shoos, this one gets shoved aside.
function resolveDropOverlap(inst, rt) {
  if (!inst.behavior.social || inst.behavior.passThroughPets || inst.caged || inst.isCage) return;
  const me = petScreen(rt);
  const hit = overlapsOther(rt.uid, me);
  if (!hit) return;
  const dir = hit.rect.x + hit.rect.w / 2 > me.x + me.w / 2 ? 1 : -1;
  const needed = dir > 0 ? me.x + me.w * 0.85 - hit.rect.x : hit.rect.x + hit.rect.w - me.x - me.w * 0.15;
  rt.push = { dx: -dir * Math.max(24, needed), dy: 0, ticks: 16 };
  interact(rt, 'bump', dir, 0);
  interact(hit.rt, 'shoo', -dir, 0);
  ensureTicker();
}

// ---------- getting out of the way of text ----------
// lib/text-avoid.js decides where; these walk the pet there, hold it still, and let
// it go again (on a timer, or at once when it is clicked).

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// Pets that stand on the ground (gravity on) or live on the taskbar only walk sideways;
// pets without gravity may go anywhere.
const sidewaysOnly = (inst) => inst.behavior.containment === 'taskbar' || !!inst.behavior.fallWhenDropped;

function avoidMovable(inst, rt) {
  const disabled = inst.disabledUntil === -1 || inst.disabledUntil > Date.now();
  return !!(rt.ready && rt.anchor && rt.win && !rt.win.isDestroyed() && rt.win.isVisible() && inst.visible !== false &&
    !inst.asleep && !inst.sitting && !disabled && !inst.behavior.anchored && !inst.behavior.calm &&
    !rt.drag && !rt.menuOpen && !rt.fall && !rt.split && !rt.dismissing && !(rt.duplicateUntil > Date.now()));
}

function avoidPets() {
  const out = [];
  for (const [uid, rt] of live) {
    const inst = instOf(uid);
    if (!inst || !rt.ready || !rt.anchor || !rt.win || rt.win.isDestroyed() || inst.visible === false) continue;
    const p = petScreen(rt);
    const b = bounds(inst, rt, p);
    const d = displayFor(p);
    const wa = d.workArea;
    const a = rt.avoid;
    out.push({
      uid,
      rect: { x: p.x, y: p.y, w: p.w, h: p.h },
      display: { id: d.id, bounds: d.bounds, workArea: wa },
      // the search stays on the pet's own screen even when it may roam across all of them
      bounds: { x0: Math.max(b.x0, wa.x), x1: Math.min(b.x1, wa.x + wa.width - p.w), y0: Math.max(b.y0, wa.y), y1: Math.min(b.y1, wa.y + wa.height - p.h - BAR_ROOM) },
      lockY: sidewaysOnly(inst),
      canMove: avoidMovable(inst, rt),
      avoidText: inst.behavior.avoidText !== false,
      avoid: a ? { kind: a.kind, phase: a.phase, until: a.until } : null,
      avoidTarget: a && a.phase !== 'park' ? { x: a.target.x, y: a.target.y, w: p.w, h: p.h } : null,
    });
  }
  return out;
}

// plan: { x, y, kind: 'typing' | 'phrase', until (ms timestamp) }
function avoidSend(uid, plan) {
  const inst = instOf(uid);
  const rt = live.get(uid);
  if (!inst || !rt || !avoidMovable(inst, rt) || !Number.isFinite(plan.x) || !Number.isFinite(plan.y)) return false;
  const prev = rt.avoid;
  if (prev && prev.kind === 'phrase' && plan.kind !== 'phrase') return false; // a command outranks dodging
  const p = petScreen(rt);
  const b = bounds(inst, rt, p);
  const x = clamp(plan.x, b.x0, b.x1);
  const y = sidewaysOnly(inst) ? p.y : clamp(plan.y, b.y0, b.y1);
  const dist = Math.hypot(x - p.x, y - p.y);
  const dir = Math.abs(x - p.x) < 1 ? (prev ? prev.dir : 1) : x > p.x ? 1 : -1;
  const panic = !!plan.panic;
  const fast = dist > 320 || panic;
  rt.vel = rt.push = null;
  const wait = prev ? 0 : panic ? AVOID_PANIC_MS : AVOID_NOTICE_MS;
  rt.avoid = { kind: plan.kind, until: plan.until, target: { x, y }, dir, fast, goAt: Date.now() + wait,
    phase: dist < 2 ? 'park' : prev ? 'walk' : 'notice' };
  const phase = rt.avoid.phase;
  rt.win.webContents.send('avoid', { phase, dir, fast, panic, ms: wait, kind: plan.kind });
  if (phase !== 'park') ensureTicker();
  return true;
}

function avoidExtend(uid, until, kind) {
  const rt = live.get(uid);
  if (!rt || !rt.avoid) return;
  rt.avoid.until = Math.max(rt.avoid.until, until);
  if (kind) rt.avoid.kind = kind;
}

function avoidCancel(uid, why) {
  const rt = live.get(uid);
  if (!rt || !rt.avoid) return;
  const walking = rt.avoid.phase !== 'park';
  rt.avoid = null;
  if (walking) rt.vel = null;
  if (rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('avoid', { phase: 'release', why });
}

function stepAvoid(inst, rt, dt, now) {
  const a = rt.avoid;
  if (a.phase === 'notice') {
    if (now < a.goAt) return true;
    a.phase = 'walk';
    rt.win.webContents.send('avoid', { phase: 'walk', dir: a.dir, fast: a.fast, kind: a.kind });
  }
  const p = petScreen(rt);
  const dx = a.target.x - p.x;
  const dy = a.target.y - p.y;
  const dist = Math.hypot(dx, dy);
  const step = (a.fast ? AVOID_RUN : AVOID_WALK) * speedFactor(inst) * dt;
  if (dist <= Math.max(step, 1)) {
    rt.anchor = { x: a.target.x, y: a.target.y };
    positionWindow(rt);
    a.phase = 'park';
    savePos(inst, rt);
    rt.win.webContents.send('avoid', { phase: 'park' });
    return true;
  }
  rt.anchor = { x: rt.anchor.x + dx / dist * step, y: rt.anchor.y + dy / dist * step };
  positionWindow(rt);
  return true;
}

// time is up: let every pet whose hold has run out go back to normal
function avoidExpire() {
  const now = Date.now();
  for (const [uid, rt] of live) if (rt.avoid && now >= rt.avoid.until && rt.avoid.phase === 'park') avoidCancel(uid, 'expired');
}

// Windows can leave a window out of screenshots; the pets use it while text is being mapped
// so they are not mistaken for text themselves.
async function hideFromCapture(on) {
  for (const rt of live.values()) {
    if (rt.win && !rt.win.isDestroyed()) {
      try { rt.win.setContentProtection(on); } catch {}
    }
  }
  if (on) await wait(80); // give the compositor a frame to drop them
}

// Every so often, idle pets that are near each other greet.
function socialCheck() {
  // greetings need a pair: with fewer than two social pets, skip the per-window visibility calls
  let social = 0;
  for (const uid of live.keys()) if (instOf(uid)?.behavior.social && ++social > 1) break;
  if (social < 2) return;
  const entries = [...live.entries()].filter(([uid, rt]) => rt.ready && rt.win.isVisible() && instOf(uid) && instOf(uid).behavior.social);
  const now = Date.now();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ua, a] = entries[i];
      const [ub, b] = entries[j];
      if (a.mode !== 'idle' || b.mode !== 'idle' || instOf(ua)?.caged || instOf(ub)?.caged || instOf(ua)?.isCage || instOf(ub)?.isCage) continue;
      const pa = petScreen(a);
      const pb = petScreen(b);
      const dist = Math.hypot(pa.x + pa.w / 2 - (pb.x + pb.w / 2), pa.y + pa.h / 2 - (pb.y + pb.h / 2));
      if (dist > (pa.w + pb.w) * 0.9 + 60) continue;
      const key = [ua, ub].sort().join('|');
      if ((a.greetCooldown.get(key) || 0) > now || Math.random() > 0.3) continue;
      a.greetCooldown.set(key, now + 45e3);
      const dir = pb.x > pa.x ? 1 : -1;
      interact(a, 'greet', dir, dist);
      interact(b, 'greet', -dir, dist);
    }
  }
}

// Spread through the whole nearby cluster, including neighbors of neighbors.
// Audio leases also cover the previous recipe's tail (sound masters last 4s).
let danceAudioUntil = 0;
function startDance(uid, duration) {
  const source = live.get(uid);
  const srcInst = instOf(uid);
  if (ctx.prefs.noDance) return false;
  if (!source || !srcInst || srcInst.caged || srcInst.isCage || !Number.isFinite(duration) || duration <= 0) return false;
  duration = Math.min(duration, 60000);
  const now = Date.now();
  if (source.danceUntil > now) return false;
  source.danceUntil = now + duration;
  const audible = now >= danceAudioUntil;
  if (audible) danceAudioUntil = now + duration + 4000;
  const eligible = (id, rt) => {
    const inst = instOf(id);
    return inst && !inst.caged && !inst.isCage && rt.ready && rt.win && !rt.win.isDestroyed() && rt.win.isVisible() &&
      inst.visible !== false && !inst.asleep && !inst.sitting && inst.disabledUntil !== -1 && !(inst.disabledUntil > now) && inst.behavior.social && !inst.behavior.calm &&
      rt.manifest?.animations?.dance && Controls.animationEnabled(inst, rt.manifest, 'dance') &&
      rt.mode === 'idle' && !rt.drag && !rt.fall && !rt.hold && !rt.avoid && !rt.split && !rt.dismissing &&
      !(rt.danceUntil > now);
  };
  if (!instOf(uid)?.behavior.social) return audible;
  const pending = [...live.entries()].filter(([id, rt]) => id !== uid && eligible(id, rt));
  const cluster = [source];
  for (let i = 0; i < cluster.length; i++) {
    const a = petScreen(cluster[i]);
    for (let j = pending.length - 1; j >= 0; j--) {
      const [, rt] = pending[j];
      const b = petScreen(rt);
      if (Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) > (a.w + b.w) * 0.9 + 60) continue;
      pending.splice(j, 1);
      cluster.push(rt);
      rt.danceUntil = now + duration;
      rt.vel = null;
      rt.win.webContents.send('dance', { duration });
    }
  }
  return audible;
}

// ---------- actions ----------

function linkFor(harness) {
  const links = ctx.links.links || {};
  return links[harness] || links[ctx.links.primary] || links['claude-code'];
}

// The link a pet's buttons use; null while the pet follows no agent, or follows one
// whose buttons nobody has set up yet (never another agent's buttons).
function linkOf(inst) {
  if (!inst.harness) return null;
  if (inst.harness === 'any') return linkFor(ctx.links.primary);
  return (ctx.links.links || {})[inst.harness] || null;
}

function fill(template, s) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent((s && s[k]) || ''));
}

async function openTarget(open, link, s, rt) {
  if (!open) return;
  await linkPolicy.launch(open, { shell, spawn, fill: a => fill(a, s), onError: () => {
    notice(rt, 'The configured application could not start. Check its command in Studio > Agents > links.json.');
    console.warn('Configured executable could not be started; check Studio > Agents > links.json.');
  } });
  if (link && link.window) {
    await wait(450);
    await helper.focus(link.window);
  }
}

// slot: 0 or 1 (the buttons under the pet); or { linkIndex } for any button of the link
async function pressButton(inst, rt, slot) {
  if (!inst.harness) {
    // no agent to open: the pet refuses and Studio opens where agents are connected
    if (rt && rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('refuse', "Nope! I don't follow an agent yet. Pick one for me in Studio.");
    if (ctx.openStudio) ctx.openStudio('agents', inst.uid);
    return;
  }
  const link = linkOf(inst);
  if (!link) {
    const name = (Harnesses.BY_ID[inst.harness] || {}).name || inst.harness;
    notice(rt, `${name}'s buttons aren't set up yet. Studio → Agents → Buttons only.`);
    if (ctx.openStudio) ctx.openStudio('agents', inst.uid);
    return;
  }
  const index = typeof slot === 'object' ? slot.linkIndex : inst.buttons[slot];
  if (index === null || index === undefined) return; // that button is switched off
  const btn = link && link.buttons && link.buttons[index];
  if (!btn) return notice(rt, 'This button has no action yet. Set one up in Studio → Agents.');
  await openTarget(btn.open, link, null, rt);
  if (btn.then && Array.isArray(btn.then.uiaClick)) {
    await wait(Math.max(0, (btn.then.delayMs || 1500) - 450));
    const res = await helper.clickButton(link.window, btn.then.uiaClick);
    if (!res.startsWith('ok')) notice(rt, `Couldn't find the button in ${link.app || link.name}`);
  }
}

async function jump(inst, rt, sessionId) {
  if (!inst.harness) return pressButton(inst, rt, 0);
  const list = sessionsFor(inst);
  const s = (sessionId && list.find((x) => x.sessionId === sessionId)) || list.find((x) => x.effective !== 'idle') || list[0];
  markSeen(sessionId ? list.filter((x) => x.sessionId === sessionId) : list);
  const link = linkFor(s ? s.harness : inst.harness);
  if (!link) return;
  if (s && link.jump) {
    const tpl = s.effective === 'needs-you' && link.jump.needsYouUrl ? link.jump.needsYouUrl : link.jump.url;
    const needsHost = tpl && tpl.includes('{hostSessionId}');
    if (tpl && (!needsHost || s.hostSessionId)) return openTarget({ url: tpl }, link, s, rt);
  }
  const res = link.window ? await helper.focus(link.window) : 'err';
  if (!res.startsWith('ok') && link.buttons && link.buttons[0]) await openTarget(link.buttons[0].open, link, s, rt);
}

function notice(rt, text) {
  if (rt && rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('notice', text);
}

function copyMissingPrompt(uid, keys) {
  const inst = instOf(uid);
  const rt = live.get(uid);
  if (!inst || !rt || !rt.manifest) return;
  const text = prompts.addMissing({ file: library.fileOf(inst.pet), manifest: rt.manifest, keys }, ctx.nodePath);
  clipboard.writeText(text);
  notice(rt, 'Install prompt copied. Paste it into your coding agent.');
}

// ---------- windows ----------

// On Windows a pet's clicks land on Chromium's input child window
// (Chrome_RenderWidgetHostHWND). Chromium hides that child whenever the pet window
// is hidden or occluded, and shows it again only for a renderer it had marked
// hidden, which backgroundThrottling:false prevents. So after hide → showInactive
// the child stays hidden and clicks reach the top-level window instead, where a
// non-focusable window answers WM_MOUSEACTIVATE with "don't activate, discard":
// every button-down is dropped while button-ups still arrive. Any real resize
// makes Chromium lay the child out again and show it.
function reviveInput(rt) {
  if (process.platform !== 'win32' || !rt.win || rt.win.isDestroyed() || !rt.win.isVisible()) return;
  const [w, h] = rt.win.getSize();
  rt.win.setSize(w + 1, h);
  rt.win.setSize(w, h);
}

function showPet(rt) {
  rt.win.showInactive();
  rt.aliveAt = Date.now(); // a hidden page has not been drawing; give it a fresh start
  rt.staleSince = 0;
  reviveInput(rt);
}

function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString();
  } catch {
    return null;
  }
}

// The popup takes focus (see pet:menu), so remember who had it to hand it back.
function takeMenuFocus(rt, carried) {
  const serial = rt.menuSerial;
  let done = false;
  const focus = (hwnd) => {
    if (done) return;
    done = true;
    if (!rt.menuOpen || rt.menuSerial !== serial || rt.win.isDestroyed()) return;
    const pets = new Set([...live.values()].map((r) => r.win && !r.win.isDestroyed() && hwndOf(r.win)));
    rt.returnFocus = carried || (hwnd && !pets.has(hwnd) ? hwnd : null);
    rt.win.focus();
  };
  if (carried || process.platform !== 'win32') return focus(null);
  helper.foreground().then(focus, () => focus(null));
  setTimeout(() => focus(null), 250); // a busy helper must not leave the popup unfocused
}

// Electron's setFocusable(false) also deactivates the window, and Windows then
// activates whatever is just below it in z-order. For a topmost pet that is some
// other topmost window (a tray widget, say), not the app you were in. Leaving the
// topmost band for that moment puts the most recent ordinary app right below.
function dropMenuFocus(rt) {
  if (rt.win.isDestroyed()) return;
  const onTop = process.platform === 'win32' && rt.win.isAlwaysOnTop();
  if (onTop) rt.win.setAlwaysOnTop(false);
  rt.win.setFocusable(false);
  if (onTop) rt.win.setAlwaysOnTop(true, 'floating');
}

// returnFocus: the popup was dismissed inside the pet (Escape, an item, a click
// on the pet), so focus goes back to the app it came from. Closing because the
// user clicked into another app (blur) leaves focus where they put it.
function closePetMenu(rt, { returnFocus = false } = {}) {
  if (!rt || !rt.menuOpen) return;
  rt.menuOpen = false;
  if (activeMenu === rt) activeMenu = null;
  if (rt.hold === 'menu') rt.hold = null;
  const back = returnFocus ? rt.returnFocus : null;
  rt.returnFocus = null;
  if (rt.win.isDestroyed()) return;
  rt.win.webContents.send('menu-close');
  if (back && rt.win.isFocused()) {
    const serial = rt.menuSerial;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      if (!rt.menuOpen && rt.menuSerial === serial) dropMenuFocus(rt);
    };
    helper.refocus(back, hwndOf(rt.win)).then(release, release);
    setTimeout(release, 400);
  } else {
    dropMenuFocus(rt);
  }
  hitTest(rt.uid, rt, screen.getCursorScreenPoint());
}

function closeOtherMenus(except) {
  for (const rt of live.values()) if (rt !== except) closePetMenu(rt);
}

function spawnPet(inst, splitSource = null) {
  const rt = {
    uid: inst.uid,
    splitSource,
    win: null,
    ready: false,
    spawnedAt: Date.now(),
    rect: { x: 0, y: 0, w: 110, h: 110 },
    anchor: inst.pos ? { ...inst.pos } : null,
    screenId: null,
    menuHandlers: new Map(),
    hits: [], // where the pet, its bar and panels are, in window coordinates
    hold: null, // 'menu' or 'drag': catch the mouse anywhere in the window
    ignoring: true,
    offset: { x: 0, y: 0 },
    vel: null,
    fall: null,
    push: null,
    drag: null,
    mode: 'idle',
    manifest: null,
    homeDisplay: inst.display,
    bumpCooldown: new Map(),
    greetCooldown: new Map(),
    anchoredOffset() {
      const i = instOf(this.uid);
      return i && i.behavior.anchored ? this.offset : { x: 0, y: 0 };
    },
  };
  const a = screen.getPrimaryDisplay().workArea;
  const size = { width: 900, height: 900 }; // the renderer resizes it once the pet has loaded
  rt.win = new BrowserWindow({
    x: a.x,
    y: a.y + a.height - size.height,
    ...size,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // never activates: hovering or clicking a pet leaves focus in the app you were typing in
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'pet-window', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  rt.win.setAlwaysOnTop(inst.onTop !== false, 'floating', inst.isCage ? 2 : 1);
  security.protectWindow(rt.win);
  rt.win.setIgnoreMouseEvents(true);
  rt.win.webContents.setVisualZoomLevelLimits(1, 1);
  rt.win.webContents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseDown') return;
    const serial = (rt.nativePress || 0) + 1;
    rt.nativePress = serial;
    const delivered = rt.deliveredPress || 0;
    lifecycle.trace('native-input', { uid: rt.uid, button: mouse.button, x: mouse.x, y: mouse.y,
      ignoring: rt.ignoring, hold: rt.hold, menu: !!rt.menuOpen });
    setTimeout(() => {
      if (!rt.win.isDestroyed() && rt.nativePress === serial && (rt.deliveredPress || 0) === delivered) {
        lifecycle.record('input-undelivered', { uid: rt.uid, button: mouse.button, ignoring: rt.ignoring,
          hold: rt.hold, hits: rt.hits, bounds: rt.win.getBounds() });
      }
    }, 500);
  });
  rt.win.on('blur', () => closePetMenu(rt));
  rt.win.on('hide', () => closePetMenu(rt));
  lifecycle.watchWindow(rt.win, `pet:${inst.uid}`, () => {
    closePetMenu(rt);
    rt.ready = false;
    rt.hits = [];
    rt.hold = null;
    rt.vel = rt.fall = rt.push = rt.drag = null;
    rt.ignoring = false;
    setIgnoring(rt, true);
  });
  rt.win.loadFile(path.join(__dirname, '..', 'pet-window', 'index.html'));
  rt.win.webContents.on('did-finish-load', () => sendInit(inst, rt));
  rt.win.on('closed', () => {
    if (activeMenu === rt) activeMenu = null;
    if (live.get(inst.uid) === rt) live.delete(inst.uid);
  });
  live.set(inst.uid, rt);
  lifecycle.trace('pet-spawn', { uid: inst.uid, pet: inst.pet, visible: inst.visible !== false, pos: inst.pos });
  return rt;
}

function sendInit(inst, rt) {
  let pet;
  try {
    pet = library.read(inst.pet);
  } catch (e) {
    try { pet = library.read('builtin:clawrk'); }
    catch {
      console.warn('Pet and bundled fallback are unavailable. Repair the app files or choose another pet in Studio.');
      rt.win.hide();
      if (ctx.openStudio) ctx.openStudio('pets', inst.uid);
      return;
    }
    console.warn('pet missing, falling back to Clawrk:', e.message);
  }
  rt.petFile = pet.file;
  rt.petMtime = pet.mtime;
  rt.win.webContents.send('init', { instance: inst, code: pet.code, link: linkOf(inst), globals: globals(), inputDiagnostics: !!process.env.HARNESS_PET_INPUT_DIAG });
  sendSessions(inst, rt, true);
}

function byWebContents(wc) {
  for (const [uid, rt] of live) if (rt.win && !rt.win.isDestroyed() && rt.win.webContents === wc) return { uid, rt, inst: instOf(uid) };
  return {};
}

function wireIpc() {
  const guarded = (name, fn) => (e, ...args) => {
    const { rt } = byWebContents(e.sender);
    if (!rt || !security.isTrustedSender(e, rt.win, path.join(__dirname, '..', 'pet-window', 'index.html')) || !ipcPolicy.petArgs(name.slice(4), args)) return;
    try { return fn(e, ...args); } catch { console.warn('Pet request failed:', name); }
  };
  const on = (name, fn) => ipcMain.on(name, guarded(name, fn));
  const handle = (name, fn) => ipcMain.handle(name, guarded(name, fn));
  handle('pet:dance', (e, duration) => {
    const { uid } = byWebContents(e.sender);
    return uid ? startDance(uid, duration) : false;
  });
  on('pet:refresh', (e) => {
    const { uid } = byWebContents(e.sender);
    if (uid) refreshPet(uid);
  });
  on('pet:input-trace', (e, event) => {
    const { uid, rt } = byWebContents(e.sender);
    if (uid) {
      if (event?.type === 'mousedown' || event?.type === 'pointerdown') rt.deliveredPress = (rt.deliveredPress || 0) + 1;
      // renderer errors come this way too, and are always worth keeping
      if (/^renderer-/.test(event?.type)) lifecycle.record(event.type, { uid, message: event.message });
      else lifecycle.trace('input', { uid, ...event });
    }
  });
  // The renderer saw a button-up whose button-down never arrived (see reviveInput).
  on('pet:input-lost', (e, button) => {
    const { uid, rt } = byWebContents(e.sender);
    if (!rt) return;
    lifecycle.record('input-lost', { uid, button, ignoring: rt.ignoring, hold: rt.hold });
    if (Date.now() - (rt.revivedAt || 0) < 500) return;
    rt.revivedAt = Date.now();
    reviveInput(rt);
  });
  on('pet:interaction', (e) => {
    const { rt } = byWebContents(e.sender);
    if (rt) closeOtherMenus(rt);
  });
  on('pet:menu-closed', (e) => {
    const { rt } = byWebContents(e.sender);
    closePetMenu(rt, { returnFocus: true });
  });
  on('pet:rect', (e, r) => {
    const { inst, rt } = byWebContents(e.sender);
    if (!rt || !inst || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return;
    if (DEBUG) console.log('[rect]', JSON.stringify(r), 'anchor', JSON.stringify(rt.anchor), 'win', JSON.stringify(rt.win.getBounds()));
    const old = rt.rect;
    rt.rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const firstTime = !rt.ready;
    if (!rt.anchor) {
      const a = screen.getPrimaryDisplay().workArea;
      const n = [...live.keys()].indexOf(inst.uid);
      rt.anchor = { x: a.x + 24 + n * (r.w + 40), y: a.y + a.height - r.h - BAR_ROOM - 8 };
    } else if (!firstTime && (Math.abs(old.w - r.w) > 0.5 || Math.abs(old.h - r.h) > 0.5)) {
      // resized: keep the bottom-centre of the pet where it was
      rt.anchor = { x: rt.anchor.x + (old.w - r.w) / 2, y: rt.anchor.y + (old.h - r.h) };
    }
    // the renderer sizes the window: the pet in the middle with room all around for the bubble and menus
    // A hidden window may not emit resize until shown. The pet's position inside
    // the window uses fixed margins, so this rect is already usable after setSize.
    const [cw, ch] = rt.win.getSize();
    const want = r.winW + 'x' + r.winH;
    if (r.winW && r.winH && (cw !== r.winW || ch !== r.winH) && rt.askedSize !== want) {
      rt.askedSize = want;
      rt.win.setSize(r.winW, r.winH);
    }
    recoverPosition(inst, rt);
    sendScreen(rt, firstTime);
    if (firstTime) {
      rt.ready = true;
      if (rt.splitSource) beginSplit(inst, rt);
      if (inst.visible !== false) showPet(rt);
      savePos(inst, rt);
    }
  });
  on('pet:manifest', (e, m) => {
    const { rt } = byWebContents(e.sender);
    if (rt) {
      rt.manifest = m;
      ctx.onChange();
    }
  });
  on('pet:hits', (e, rects) => {
    const { uid, rt } = byWebContents(e.sender);
    if (!rt || !Array.isArray(rects)) return;
    rt.hits = rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite)).slice(0, 32);
    hitTest(uid, rt, screen.getCursorScreenPoint());
  });
  on('pet:hold', (e, kind) => {
    const { uid, rt } = byWebContents(e.sender);
    if (!rt) return;
    rt.hold = kind === 'menu' || kind === 'drag' ? kind : null;
    hitTest(uid, rt, screen.getCursorScreenPoint());
  });
  on('pet:mode', (e, mode) => {
    const { rt } = byWebContents(e.sender);
    if (rt) rt.mode = mode;
  });
  on('pet:drag-start', (e, p) => {
    const { rt, inst } = byWebContents(e.sender);
    if (!rt) return;
    rt.vel = rt.fall = rt.push = rt.split = null;
    if (rt.avoid) avoidCancel(rt.uid, 'drag');
    if (rt.offset.x || rt.offset.y) {
      // picked up mid-stroll: re-anchor under the pet so nothing jumps
      rt.anchor = { x: rt.anchor.x + rt.offset.x, y: rt.anchor.y + rt.offset.y };
      rt.offset = { x: 0, y: 0 };
      rt.win.webContents.send('offset', rt.offset);
      positionWindow(rt);
    }
    const [wx, wy] = rt.win.getPosition();
    rt.drag = { wx, wy, sx: p.x, sy: p.y };
    rt.shake = inst?.isCage || inst?.caged ? shake.create() : null;

    if (inst?.isCage) {
      for (const other of ctx.prefs.instances) {
        if (other.caged) {
          const ort = live.get(other.uid);
          if (ort && ort.win && !ort.win.isDestroyed()) {
            const [ox, oy] = ort.win.getPosition();
            ort.cageDragOrigin = { wx: ox, wy: oy, anchor: { ...ort.anchor } };
          }
        }
      }
    }
  });
  on('pet:drag-move', (e, p) => {
    const { rt, inst } = byWebContents(e.sender);
    if (rt && rt.drag) {
      const dx = p.x - rt.drag.sx;
      const dy = p.y - rt.drag.sy;
      rt.win.setPosition(screenPixel(rt.drag.wx + dx), screenPixel(rt.drag.wy + dy));
      if (inst && rt.shake?.feed(p.x, p.y, Date.now())) shaken(inst, rt);
      if (inst?.isCage) {
        for (const other of ctx.prefs.instances) {
          if (other.caged) {
            const ort = live.get(other.uid);
            if (ort?.cageDragOrigin && ort.win && !ort.win.isDestroyed()) {
              ort.win.setPosition(screenPixel(ort.cageDragOrigin.wx + dx), screenPixel(ort.cageDragOrigin.wy + dy));
            }
          }
        }
      }
    }
  });
  on('pet:drag-end', (e) => {
    const { inst, rt } = byWebContents(e.sender);
    if (!rt || !rt.drag) return;
    if (!inst) return void (rt.drag = null);
    const [wx, wy] = rt.win.getPosition();
    const dx = wx - rt.drag.wx;
    const dy = wy - rt.drag.wy;
    const freed = rt.shakenFree;
    rt.drag = rt.shake = null;
    rt.shakenFree = false;
    rt.anchor = { x: wx + rt.rect.x, y: wy + rt.rect.y };
    rt.offset = { x: 0, y: 0 };
    rt.win.webContents.send('offset', rt.offset);
    rt.homeDisplay = displayFor(petScreen(rt)).id;

    if (inst.isCage) {
      for (const other of ctx.prefs.instances) {
        if (other.caged) {
          const ort = live.get(other.uid);
          if (ort?.cageDragOrigin) {
            ort.anchor = { x: ort.cageDragOrigin.anchor.x + dx, y: ort.cageDragOrigin.anchor.y + dy };
            delete ort.cageDragOrigin;
            positionWindow(ort);
            savePos(other, ort);
          }
        }
      }
      clampAnchor(inst, rt);
      positionWindow(rt);
      savePos(inst, rt);
      return;
    }

    const cage = getActiveCage();
    if (cage && !inst.isCage) {
      const cb = petScreen(cage.rt);
      const petP = petScreen(rt);
      const petCenterX = petP.x + petP.w / 2;
      const petCenterY = petP.y + petP.h / 2;
      const insideCage = petCenterX >= cb.x && petCenterX <= cb.x + cb.w &&
                         petCenterY >= cb.y && petCenterY <= cb.y + cb.h;
      if (insideCage && freed) {
        rt.anchor = besideCage(inst, rt, cb, petCenterX < cb.x + cb.w / 2 ? -1 : 1);
      } else if (insideCage) {
        inst.caged = true;
        clampInsideCage(inst, rt, cage.rt);
        positionWindow(rt);
        relayout(inst, rt);
        savePos(inst, rt);
        rt.win.webContents.send('instance', inst);
        rt.win.webContents.send('fall', { phase: 'landed' });
        ctx.save();
        ctx.onChange();
        return;
      } else if (inst.caged) {
        // Caged pets cannot leave the cage until cage is disabled or hidden!
        clampInsideCage(inst, rt, cage.rt);
        positionWindow(rt);
        relayout(inst, rt);
        savePos(inst, rt);
        rt.win.webContents.send('fall', { phase: 'landed' });
        return;
      }
    }

    const floor = bounds(inst, rt, { ...rt.anchor, w: rt.rect.w, h: rt.rect.h }).y1;
    if (inst.behavior.fallWhenDropped && floor - rt.anchor.y > 30) {
      rt.fall = { vy: 0 };
      rt.win.webContents.send('fall', { phase: 'start' });
      ensureTicker();
      return;
    }
    clampAnchor(inst, rt);
    positionWindow(rt);
    relayout(inst, rt);
    savePos(inst, rt);
    rt.win.webContents.send('fall', { phase: 'landed' });
    resolveDropOverlap(inst, rt);
  });
  on('pet:vel', (e, v) => {
    const { inst, rt } = byWebContents(e.sender);
    if (!rt || !rt.ready || rt.drag || rt.fall || rt.avoid || rt.leaving) return; // a pet getting out of the way is steered by the host
    if (inst?.asleep || inst?.sitting) { rt.vel = null; return; }
    if (rt.split || rt.duplicateUntil > Date.now() || rt.collisionUntil > Date.now()) { rt.vel = null; return; }
    // pet code reports these; anything that is not a finite number counts as 0
    const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
    const vx = v ? num(v.vx) : 0;
    const vy = v ? num(v.vy) : 0;
    rt.vel = vx || vy ? { vx, vy } : null;
    if (rt.vel) ensureTicker();
  });
  on('pet:avoid-cancel', (e) => {
    const { uid } = byWebContents(e.sender);
    if (uid) avoidCancel(uid, 'click');
  });
  on('pet:move-end', (e) => {
    const { inst, rt } = byWebContents(e.sender);
    if (!rt || !inst) return;
    rt.vel = null;
    if (!inst.behavior.anchored) {
      relayout(inst, rt);
      savePos(inst, rt);
    }
  });
  on('pet:set', (e, key, value) => {
    const { inst } = byWebContents(e.sender);
    if (inst) setInstance(inst.uid, { [key]: value });
  });
  on('pet:action', (e, name, payload) => {
    const { inst, rt } = byWebContents(e.sender);
    if (!inst) return;
    const run = name === 'jump' ? jump(inst, rt, payload && payload.sessionId) : name === 'button' ? pressButton(inst, rt, payload.index) : null;
    if (run) run.catch((err) => console.warn('action', name, err));
  });
  on('pet:menu', (e) => {
    const { uid, rt } = byWebContents(e.sender);
    if (!uid) return;
    lifecycle.trace('menu-request', { uid, ignoring: rt.ignoring, hold: rt.hold });
    try {
      // The menu is drawn by the pet window itself; here it becomes plain data with ids.
      rt.menuHandlers = new Map();
      let next = 1;
      const serialize = (items) => items.filter(Boolean).map((it) => {
        const id = next++;
        if (it.click || it.onSlide) rt.menuHandlers.set(id, it);
        return {
          id,
          type: it.type || (it.submenu ? 'submenu' : 'normal'),
          label: it.label,
          sublabel: it.sublabel,
          checked: !!it.checked,
          enabled: it.enabled !== false,
          accelerator: it.accelerator,
          min: it.min, max: it.max, step: it.step, value: it.value, format: it.format,
          submenu: it.submenu ? serialize(it.submenu) : undefined,
        };
      });
      const items = serialize(ctx.menuFor(uid));
      // another pet's popup is open: the app to return to is the one it came from
      const carried = activeMenu && activeMenu !== rt ? activeMenu.returnFocus : null;
      closeOtherMenus(rt);
      rt.menuOpen = true;
      rt.menuSerial = (rt.menuSerial || 0) + 1;
      activeMenu = rt;
      // Pets normally leave keyboard focus alone. Only an open popup takes focus,
      // so Escape, Alt+Tab and clicks in other programs dismiss it as expected.
      rt.win.setFocusable(true);
      takeMenuFocus(rt, carried);
      rt.win.webContents.send('menu-open', { items });
    } catch (err) {
      console.error('pet menu failed:', err);
      closePetMenu(rt);
      notice(rt, 'Menu error: ' + err.message);
    }
  });
  on('pet:menu-click', (e, id) => {
    const { rt } = byWebContents(e.sender);
    const it = rt && rt.menuHandlers.get(id);
    if (!it || !it.click) return;
    try {
      it.click({ checked: it.type === 'checkbox' ? !it.checked : true });
    } catch (err) {
      console.error('menu action failed:', err);
    }
  });
  on('pet:menu-slide', (e, id, value) => {
    const { rt } = byWebContents(e.sender);
    const it = rt && rt.menuHandlers.get(id);
    if (it && it.onSlide && Number.isFinite(value) && value >= it.min && value <= it.max) {
      try { it.onSlide(Number(value)); } catch (err) { console.error('menu slider failed:', err); }
    }
  });
  // A plain mouse wheel over a pet scrolls whatever is underneath: the window turns
  // click-through for a moment and the first notch is replayed there.
  on('pet:pass-wheel', (e, d) => {
    const { rt } = byWebContents(e.sender);
    if (!rt || rt.dismissing || !d) return;
    rt.wheelUntil = Date.now() + 600; // then the cursor poll lets the pet catch the mouse again
    setIgnoring(rt, true);
    // Chromium reports 100 px per notch; Windows counts 120 per notch, positive = up
    helper.wheel(Math.round(-(Number(d.dy) || 0) * 1.2), Math.round((Number(d.dx) || 0) * 1.2));
  });
  on('pet:dismissed', (e) => {
    const { rt } = byWebContents(e.sender);
    if (rt && rt.dismissing && !rt.win.isDestroyed()) rt.win.close();
  });
  on('pet:copy-missing', (e, keys) => {
    const { uid } = byWebContents(e.sender);
    if (uid) copyMissingPrompt(uid, keys);
  });
  // a heartbeat while the page draws, and news of its animation worker (see watchdog)
  on('pet:health', (e, h) => {
    const { uid, rt } = byWebContents(e.sender);
    if (!rt) return;
    rt.aliveAt = Date.now();
    if (h.worker === false && rt.workerOk !== false) rt.workerFailedAt = Date.now();
    rt.workerOk = h.worker !== false;
    if (h.event !== 'alive') lifecycle.record('pet-' + h.event, { uid, message: h.message });
  });
  on('pet:left', (e) => {
    const { uid, rt } = byWebContents(e.sender);
    if (rt?.leaving) finishLeave(uid, rt);
  });
}

// ---------- watchdog ----------
// A pet that should be on screen but is not: its window hidden or gone, off every
// screen, a crashed page that recovery gave up on, a frozen page, or a stopped
// animation worker. Each is logged; most are fixed in place, the rest by
// reloading the pet (at most a few times, so a broken pet cannot loop).

const WATCH_MS = 5000;
const STALE_MS = 30000; // no heartbeat for this long counts as frozen
const HEALS = 3; // reloads per pet per 10 minutes
const healed = new Map(); // uid → reload times
let watchPausedUntil = 0; // after sleep or unlock, pages get a moment to catch up

function heal(inst, why) {
  const now = Date.now();
  const times = (healed.get(inst.uid) || []).filter((t) => now - t < 10 * 60e3);
  if (times.length >= HEALS) {
    if (times.length === HEALS) lifecycle.record('pet-heal-gave-up', { uid: inst.uid, why });
    times.push(now); // logged once; the window slides on from here
    healed.set(inst.uid, times.slice(-HEALS - 1));
    return;
  }
  times.push(now);
  healed.set(inst.uid, times);
  lifecycle.record('pet-heal', { uid: inst.uid, why });
  refreshPet(inst.uid);
}

function watchdog() {
  const now = Date.now();
  if (now < watchPausedUntil) return;
  for (const inst of ctx.prefs.instances) {
    if (inst.visible === false) continue;
    const rt = live.get(inst.uid);
    if (!rt || !rt.win || rt.win.isDestroyed()) { heal(inst, 'no-window'); continue; }
    if (rt.dismissing || rt.leaving || rt.drag || rt.split) continue;
    if (rt.win.webContents.isCrashed()) {
      rt.crashedAt ||= now; // recovery reloads it within a second; this is for when it gave up
      if (now - rt.crashedAt > 15000) heal(inst, 'renderer-crashed');
      continue;
    }
    rt.crashedAt = 0;
    if (!rt.ready) {
      if (now - rt.spawnedAt > 20000) heal(inst, 'never-ready');
      continue;
    }
    if (!rt.win.isVisible()) {
      lifecycle.record('pet-unexpectedly-hidden', { uid: inst.uid });
      showPet(rt);
      continue;
    }
    if (rt.anchor && !onSomeDisplay(petScreen(rt))) {
      lifecycle.record('pet-off-screen', { uid: inst.uid, anchor: rt.anchor });
      recoverPosition(inst, rt);
      continue;
    }
    if (rt.workerOk === false && now - rt.workerFailedAt > 60000) { heal(inst, 'worker-stopped'); continue; }
    if (rt.aliveAt && now - rt.aliveAt > STALE_MS) {
      // a frozen page: a resize makes Chromium lay it out and paint again; failing that, reload
      if (!rt.staleSince) {
        rt.staleSince = now;
        lifecycle.record('pet-stalled', { uid: inst.uid, silentMs: now - rt.aliveAt });
        reviveInput(rt);
      } else if (now - rt.staleSince > STALE_MS) heal(inst, 'page-stalled');
    } else rt.staleSince = 0;
  }
}

function pauseWatchdog(why) {
  watchPausedUntil = Date.now() + 60000;
  for (const rt of live.values()) rt.aliveAt = 0;
  lifecycle.trace('watchdog-paused', { why });
}

// ---------- appear with its agent ----------
// A pet with "Only show with its agent" rests off screen. It appears (in a puff of
// smoke) while its agent's app has a window open on screen or the agent is busy or
// needs you. Once that window is minimized, hidden or closed and the agent is quiet,
// it leaves after "Leaves after" minutes. A pet you bring back yourself stays until
// its agent has had its next turn.

const presence = new Map(); // uid → { lastActive, manual, autoHidden }
let presenceBusy = false;
let autoShowing = false; // setInstance calls made by this section, not by you

function presenceOf(uid) {
  if (!presence.has(uid)) presence.set(uid, { lastActive: Date.now(), manual: false, autoHidden: false });
  return presence.get(uid);
}

// matcher: a link's window ({ process, pathContains, titleContains }); app: helper.foregroundApp()
function windowMatches(m, app) {
  if (!m || !app || !(m.process || m.pathContains || m.titleContains)) return false;
  const low = (s) => String(s || '').toLowerCase();
  return (!m.process || low(app.process) === low(m.process)) &&
    (!m.pathContains || low(app.path).includes(low(m.pathContains))) &&
    (!m.titleContains || low(app.title).includes(low(m.titleContains)));
}

const lingerMs = (inst) => Math.max(0.25, Number(inst.behavior.lingerMinutes) || 2) * 60e3;

function autoSet(uid, patch) {
  autoShowing = true;
  try { setInstance(uid, patch); } finally { autoShowing = false; }
}

async function presenceCheck() {
  if (presenceBusy || !ctx) return;
  const pets = ctx.prefs.instances.filter((i) => i.behavior.showWithAgent && !i.isCage);
  if (!pets.length) return;
  presenceBusy = true;
  try {
    const fg = pets.some((i) => linkOf(i)?.window) ? await helper.foregroundApp() : null;
    const shownBy = new Map(); // one window check per agent app, however many pets follow it
    const now = Date.now();
    for (const inst of pets) {
      const rt = live.get(inst.uid);
      if (!instOf(inst.uid) || !rt || !rt.ready || rt.dismissing || !rt.win || rt.win.isDestroyed()) continue;
      const p = presenceOf(inst.uid);
      const busy = sessionsFor(inst).some((s) => ['working', 'thinking', 'needs-you'].includes(s.effective));
      const disabled = inst.disabledUntil === -1 || inst.disabledUntil > now;
      const matcher = linkOf(inst)?.window;
      const key = JSON.stringify(matcher || null);
      if (matcher && !shownBy.has(key)) shownBy.set(key, await helper.windowShown(matcher));
      if (busy || shownBy.get(key) === true || windowMatches(matcher, fg)) {
        p.lastActive = now;
        p.manual = false;
        if (inst.visible === false && !disabled) appear(inst, rt);
      } else if (inst.visible !== false && !p.manual && !rt.leaving && !rt.drag && !rt.menuOpen && now - p.lastActive > lingerMs(inst)) {
        leave(inst, rt);
      }
    }
  } catch (err) {
    console.warn('agent presence check failed:', err.message);
  } finally {
    presenceBusy = false;
  }
}

function appear(inst, rt) {
  presenceOf(inst.uid).autoHidden = false;
  lifecycle.trace('pet-appear', { uid: inst.uid });
  autoSet(inst.uid, { visible: true });
  if (inst.behavior.smokeOnLeave !== false) rt.win.webContents.send('presence', { phase: 'appear' });
}

function leave(inst, rt) {
  lifecycle.trace('pet-leave', { uid: inst.uid });
  rt.leaving = true;
  if (inst.behavior.smokeOnLeave === false) return finishLeave(inst.uid, rt);
  rt.vel = rt.fall = rt.push = null;
  if (rt.avoid) avoidCancel(inst.uid, 'leave');
  closePetMenu(rt);
  setIgnoring(rt, true);
  rt.win.webContents.send('presence', { phase: 'leave' });
  rt.leaveTimer = setTimeout(() => finishLeave(inst.uid, rt), 4500); // in case the page never says the smoke cleared
}

function finishLeave(uid, rt) {
  if (!rt.leaving) return;
  rt.leaving = false;
  clearTimeout(rt.leaveTimer);
  if (!instOf(uid) || rt.win.isDestroyed()) return;
  presenceOf(uid).autoHidden = true;
  autoSet(uid, { visible: false });
}

// ---------- settings for every pet (Studio > General settings) ----------

const globals = () => ({ muteAll: !!ctx.prefs.muteAll, noDance: !!ctx.prefs.noDance });

function broadcastGlobals() {
  for (const rt of live.values()) if (rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('globals', globals());
}

// After the GPU process restarts, transparent windows can stay blank until they repaint.
function repaintAll() {
  for (const [uid, rt] of live) {
    const inst = instOf(uid);
    if (inst && inst.visible !== false && rt.ready) reviveInput(rt);
  }
}

// ---------- click-through ----------

// A pet window is click-through except over the pet, its bar and its panels. The
// renderer reports where those are and the cursor is hit-tested here. (Electron's
// mouse forwarding would let the renderer do it, but on Windows that installs a
// system-wide mouse hook on this thread, so any main-thread stall froze the cursor.)
const HIT_FAST = 30; // ms between hit tests while the cursor is inside some pet window
const HIT_SLOW = 100; // ms otherwise; also the cursor feed's rate
const HIT_SLACK = 4; // px the cursor may stray past a rect before the pet lets go

function setIgnoring(rt, ignore) {
  if (rt.ignoring === ignore || rt.win.isDestroyed()) return;
  rt.win.setIgnoreMouseEvents(ignore);
  rt.ignoring = ignore; // cache only after the native call succeeds
}

function wantsMouse(inst, rt, p, b) {
  if (rt.dismissing || rt.leaving || rt.wheelUntil > Date.now()) return false;
  if (rt.hold === 'drag' || rt.drag) return true;
  const x = p.x - b.x;
  const y = p.y - b.y;
  const pad = rt.ignoring ? 0 : HIT_SLACK;
  return rt.hits.some((r) => (r.menu ? rt.menuOpen : !inst.clickThrough) &&
    x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad);
}

// returns whether the cursor is inside the pet's window
function hitTest(uid, rt, p, b = rt.win.getBounds()) {
  const inst = instOf(uid);
  if (!inst || rt.win.isDestroyed()) return false;
  setIgnoring(rt, !wantsMouse(inst, rt, p, b));
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// also the cursor feed for eyes, hover and the collapsing bar
let lastFeed = 0;
function pollCursor() {
  try {
    const p = screen.getCursorScreenPoint();
    const t = Date.now();
    const feed = t - lastFeed >= HIT_SLOW - 10;
    if (feed) lastFeed = t;
    for (const [uid, rt] of live) {
      if (!rt.win || rt.win.isDestroyed() || !rt.win.isVisible()) continue;
      const b = rt.win.getBounds();
      hitTest(uid, rt, p, b);
      if (feed && !rt.win.webContents.isCrashed()) rt.win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
    }
  } catch (err) {
    console.error('cursor poll failed:', err);
  }
  // Catch entry promptly too; the former 100 ms gap could swallow a quick click.
  setTimeout(pollCursor, HIT_FAST);
}

// ---------- public API ----------

function refreshPet(uid) {
  const inst = instOf(uid);
  const rt = live.get(uid);
  if (!inst) return;
  if (rt?.win && !rt.win.isDestroyed()) {
    if (rt.ready && rt.anchor) {
      const p = petScreen(rt);
      inst.pos = { x: screenPixel(p.x), y: screenPixel(p.y) };
      inst.display = displayFor(p).id;
      ctx.save();
    }
    closePetMenu(rt);
    rt.dismissing = true;
    setIgnoring(rt, true);
    rt.win.destroy();
  }
  lifecycle.record('refresh-pet', { uid });
  spawnPet(inst);
  ctx.onChange();
}

function setInstance(uid, patch) {
  const inst = instOf(uid);
  if (!inst) return;
  // turning "Only show with its agent" off brings back a pet it had sent away
  if (patch.behavior?.showWithAgent === false && presence.get(uid)?.autoHidden) patch = { ...patch, visible: true };
  if (patch.behavior?.showWithAgent === true) presenceOf(uid).lastActive = Date.now();
  if (patch.visible === true && !autoShowing) Object.assign(presenceOf(uid), { manual: true, autoHidden: false });
  if ('visible' in patch && patch.visible !== (inst.visible !== false)) lifecycle.trace('pet-visible', { uid, visible: patch.visible, auto: autoShowing });
  if (patch.pet) library.fileOf(patch.pet);
  if (patch.pet && patch.pet !== inst.pet) {
    store.rememberPet(ctx.prefs, inst);
    const restored = store.restorePet(ctx.prefs, patch.pet);
    Object.assign(inst, restored, { uid: inst.uid, pos: inst.pos, display: inst.display, visible: inst.visible });
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'behavior') inst.behavior = { ...inst.behavior, ...v };
    else if (k === 'size') inst.size = Math.max(0.25, Math.min(4, Math.round(v * 100) / 100));
    else inst[k] = v;
  }
  store.rememberPet(ctx.prefs, inst);
  ctx.save();
  const rt = live.get(uid);
  if (rt && rt.win && !rt.win.isDestroyed()) {
    if (patch.behavior?.passThroughPets === true) {
      rt.push = null;
      rt.collisionUntil = 0;
      rt.collisionStreak = null;
      rt.win.webContents.send('move-state', { blocked: {}, retryAfter: 0 });
    }
    if (patch.visible === false || patch.pet) closePetMenu(rt);
    if (rt.avoid && (patch.visible === false || patch.pet || patch.behavior?.calm || patch.behavior?.anchored || patch.disabledUntil)) avoidCancel(uid, 'settings');
    if (patch.behavior && patch.behavior.anchored === false && rt.offset.x) {
      // dropping the anchor: the pet keeps its spot and the bar comes to it
      rt.anchor = { x: rt.anchor.x + rt.offset.x, y: rt.anchor.y + rt.offset.y };
      rt.offset = { x: 0, y: 0 };
      rt.win.webContents.send('offset', rt.offset);
      positionWindow(rt);
    }
    rt.win.webContents.send('instance', inst);
    if (patch.asleep === true || patch.sitting === true) {
      rt.vel = rt.fall = rt.push = rt.split = null;
      rt.win.webContents.send('fall', { phase: 'landed' });
    }
    if ('harness' in patch) {
      rt.win.webContents.send('link', linkOf(inst));
      sendSessions(inst, rt, true);
    }
    if (patch.pet) sendInit(inst, rt);
    if ('onTop' in patch || patch.pet) rt.win.setAlwaysOnTop(inst.onTop !== false, 'floating', inst.isCage ? 2 : 1);
    if ('clickThrough' in patch || patch.pet) hitTest(uid, rt, screen.getCursorScreenPoint());
    if (patch.visible === true) {
      if (rt.leaving) {
        rt.leaving = false;
        clearTimeout(rt.leaveTimer);
        rt.win.webContents.send('presence', { phase: 'cancel' });
      }
      recoverMotion(rt);
      if (rt.ready && rt.anchor) { recoverPosition(inst, rt); showPet(rt); }
    }
    if (patch.visible === false) {
      if (inst.isCage) {
        for (const other of ctx.prefs.instances) {
          if (other.caged) {
            other.caged = false;
            const ort = live.get(other.uid);
            if (ort?.win && !ort.win.isDestroyed()) ort.win.webContents.send('instance', other);
          }
        }
      }
      rt.win.hide();
    }
  } else if (patch.visible === true) spawnPet(inst);
  ctx.onChange();
}

function petName(rt, inst) {
  return Controls.petName(inst, rt.manifest);
}

function start(context) {
  ctx = context;
  if (diag.enabled()) {
    diag.install({
      ipcMain,
      windowProto: BrowserWindow.prototype,
      screen,
      file: path.join(store.PATHS.data, 'diag.log'),
      pets: () => [...live].map(([uid, rt]) => ({ name: petName(rt, instOf(uid)), win: rt.win })),
      nameOfSender: (wc) => {
        const { rt, inst } = byWebContents(wc);
        return rt ? petName(rt, inst) : null;
      },
    });
  }
  wireIpc();
  for (const inst of ctx.prefs.instances) spawnPet(inst);
  setInterval(pollSessions, 400);
  setInterval(socialCheck, 1500);
  setInterval(avoidExpire, 1000);
  setInterval(watchdog, WATCH_MS);
  setInterval(presenceCheck, 2500);
  setInterval(seenCheck, 2500);
  for (const why of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) powerMonitor?.on(why, () => pauseWatchdog(why));
  pollCursor();
  // hot-reload pets whose files change
  library.watch((ref) => {
    for (const [uid, rt] of live) {
      const inst = instOf(uid);
      if (inst && inst.pet === ref && rt.win && !rt.win.isDestroyed()) {
        try {
          const pet = library.read(ref);
          rt.win.webContents.send('pet-code', { code: pet.code });
        } catch {}
      }
    }
    ctx.onChange();
  });
}

function addInstance(petRef, harness) {
  library.fileOf(petRef);
  // Clawrk follows Claude Code out of the box; every other pet starts with no agent
  const inst = store.restorePet(ctx.prefs, petRef, harness);
  if (harness === undefined && !ctx.prefs.petSettings?.[petRef] && petRef === 'builtin:clawrk') inst.harness = 'claude-code';
  ctx.prefs.instances.push(inst);
  ctx.save();
  spawnPet(inst);
  ctx.onChange();
  return inst;
}

function duplicateInstance(uid) {
  const source = instOf(uid);
  if (!source) return null;
  const inst = instanceOptions.duplicate(source, ctx.prefs.instances);
  const sourceRt = live.get(uid);
  if (sourceRt?.ready && sourceRt.anchor) {
    const p = petScreen(sourceRt);
    inst.pos = { x: p.x, y: p.y };
    inst.display = sourceRt.homeDisplay;
  }
  ctx.prefs.instances.push(inst);
  ctx.save();
  spawnPet(inst, uid);
  ctx.onChange();
  return inst.uid;
}

function removeDuplicates() {
  const duplicates = ctx.prefs.instances.filter((inst) => inst.experimentalDuplicate === true);
  for (const inst of duplicates) removeInstance(inst.uid);
  return duplicates.length;
}

// Takes a pet off the screen. A visible pet vanishes in a puff of smoke first; its
// window closes once the renderer says the smoke has cleared (or after a safety delay).
function removeInstance(uid) {
  const target = instOf(uid);
  if (target?.isCage) return;
  store.rememberPet(ctx.prefs, target);
  const rt = live.get(uid);
  const shown = rt && rt.ready && rt.win && !rt.win.isDestroyed() && rt.win.isVisible();
  ctx.prefs.instances = ctx.prefs.instances.filter((i) => i.uid !== uid);
  ctx.save();
  ctx.onChange();
  if (!rt || !rt.win || rt.win.isDestroyed() || rt.dismissing) return;
  if (!shown) return rt.win.close();
  rt.dismissing = true;
  rt.vel = rt.fall = rt.push = rt.drag = null;
  setIgnoring(rt, true);
  rt.win.webContents.send('dismiss');
  setTimeout(() => !rt.win.isDestroyed() && rt.win.close(), 4500);
}

function moveInstance(uid, dir) {
  const instances = ctx.prefs.instances;
  const index = instances.findIndex((i) => i.uid === uid);
  if (index === -1) return;
  if (instances[index].isCage) return;
  const delta = (dir === -1 || dir === 'up') ? -1 : 1;
  const targetIndex = index + delta;
  const minIndex = ctx.prefs.cageEnabled ? 1 : 0;
  if (targetIndex < minIndex || targetIndex >= instances.length) return;
  const temp = instances[index];
  instances[index] = instances[targetIndex];
  instances[targetIndex] = temp;
  ctx.save();
  ctx.onChange();
}

function setCageEnabled(on) {
  ctx.prefs.cageEnabled = !!on;
  if (on) {
    let cageInst = ctx.prefs.instances.find((i) => i.isCage || i.uid === 'cage');
    if (!cageInst) {
      cageInst = store.newInstance('builtin:cage', null);
      cageInst.uid = 'cage';
      cageInst.isCage = true;
      cageInst.barMode = 'off';
      cageInst.sound = { muted: true, volume: 0, anims: {} };
      cageInst.behavior = {
        ...store.DEFAULT_BEHAVIOR,
        wander: false,
        calm: true,
        social: false,
        avoidCursor: false,
        followCursor: false,
        trackCursor: false,
        nap: false,
        tricks: 'off',
        avoidText: false,
        fallWhenDropped: false,
        passThroughPets: true,
      };
      ctx.prefs.instances.unshift(cageInst);
    } else {
      cageInst.isCage = true;
      cageInst.visible = true;
      cageInst.barMode = 'off';
      const idx = ctx.prefs.instances.indexOf(cageInst);
      if (idx > 0) {
        ctx.prefs.instances.splice(idx, 1);
        ctx.prefs.instances.unshift(cageInst);
      }
    }
    ctx.save();
    let cageRt = live.get('cage');
    if (!cageRt) spawnPet(cageInst);
    else if (cageRt.win && !cageRt.win.isDestroyed()) {
      cageRt.win.show();
      cageRt.win.setAlwaysOnTop(true, 'floating', 2);
    }
  } else {
    for (const inst of ctx.prefs.instances) {
      if (inst.caged) {
        inst.caged = false;
        const rt = live.get(inst.uid);
        if (rt?.win && !rt.win.isDestroyed()) rt.win.webContents.send('instance', inst);
      }
    }
    const cageRt = live.get('cage');
    if (cageRt?.win && !cageRt.win.isDestroyed()) {
      cageRt.dismissing = true;
      cageRt.win.close();
    }
    live.delete('cage');
    ctx.prefs.instances = ctx.prefs.instances.filter((i) => !i.isCage && i.uid !== 'cage');
    ctx.save();
  }
  ctx.onChange();
}

function play(uid, anim) {
  const rt = live.get(uid);
  if (rt && rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('play', anim);
}

function broadcastLinks() {
  for (const [uid, rt] of live) {
    const inst = instOf(uid);
    if (inst && rt.win && !rt.win.isDestroyed()) rt.win.webContents.send('link', linkOf(inst));
  }
}

function setAllVisible(show) {
  for (const inst of ctx.prefs.instances) setInstance(inst.uid, { visible: show });
}

module.exports = {
  refreshPet,
  refreshAll: () => { for (const inst of [...ctx.prefs.instances]) refreshPet(inst.uid); },
  avoidPets, avoidSend, avoidExtend, avoidCancel, hideFromCapture,
  repaintAll, pauseWatchdog, broadcastGlobals,
  start, addInstance, duplicateInstance, removeDuplicates, removeInstance, moveInstance, setCageEnabled, setInstance, play, broadcastLinks, setAllVisible, copyMissingPrompt,
  manifestOf: (uid) => (live.get(uid) || {}).manifest || null,
  modeOf: (uid) => (live.get(uid) || {}).mode || null,
  sessionsFor: (uid) => (instOf(uid) ? sessionsFor(instOf(uid)) : []),
  jumpTo: (uid, sessionId) => { const inst = instOf(uid); const rt = live.get(uid); if (inst) jump(inst, rt, sessionId); },
  press: (uid, i) => { const inst = instOf(uid); const rt = live.get(uid); if (inst) pressButton(inst, rt, i); },
  pressLinkButton: (uid, i) => { const inst = instOf(uid); const rt = live.get(uid); if (inst) pressButton(inst, rt, { linkIndex: i }); },
  // put a pet back at the bottom-left of the main screen
  home: (uid) => {
    const inst = instOf(uid);
    const rt = live.get(uid);
    if (!inst || !rt || !rt.win || rt.win.isDestroyed()) return;
    const a = screen.getPrimaryDisplay().workArea;
    rt.split = null;
    recoverMotion(rt);
    rt.offset = { x: 0, y: 0 };
    rt.win.webContents.send('offset', rt.offset);
    rt.homeDisplay = screen.getPrimaryDisplay().id;
    rt.anchor = { x: a.x + 24, y: a.y + a.height - rt.rect.h - BAR_ROOM - 8 };
    positionWindow(rt);
    savePos(inst, rt);
    if (inst.visible === false) setInstance(uid, { visible: true });
  },
  sizeStep: (uid, delta) => { const rt = live.get(uid); if (rt) rt.win.webContents.send('size-step', delta); },
  stopAll: () => { for (const rt of live.values()) if (rt.win && !rt.win.isDestroyed()) rt.win.destroy(); },
  linkFor,
  linkOf: (uid) => (instOf(uid) ? linkOf(instOf(uid)) : null),
};
