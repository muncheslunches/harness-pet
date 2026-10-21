// Validate renderer IPC data before host actions. No handler accepts arbitrary
// object keys that could replace identity, paths, or prototype properties.
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => typeof v === 'string' && v.length <= max;
const finite = v => typeof v === 'number' && Number.isFinite(v);
function safeData(v, depth = 0) {
  if (depth > 8) return false;
  if (v == null || typeof v === 'boolean' || str(v, 100000) || finite(v)) return true;
  if (Array.isArray(v)) return v.length <= 1000 && v.every(x => safeData(x, depth + 1));
  return record(v) && Object.keys(v).length <= 1000 && Object.entries(v).every(([k, x]) => !['__proto__', 'constructor', 'prototype'].includes(k) && safeData(x, depth + 1));
}
function patch(p) {
  if (!record(p) || !safeData(p)) return false;
  const booleans = ['visible', 'asleep', 'sitting', 'clickThrough', 'onTop', 'caged', 'isCage'];
  for (const [k, v] of Object.entries(p)) {
    if (booleans.includes(k)) { if (typeof v !== 'boolean') return false; }
    else if (k === 'size') { if (!finite(v) || v < 0.25 || v > 4) return false; }
    else if (k === 'disabledUntil') { if (!finite(v) || v < -1) return false; }
    else if (k === 'pet') { if (!str(v, 4096)) return false; }
    else if (k === 'harness') { if (v !== null && !str(v, 100)) return false; }
    else if (k === 'barMode') { if (!['mini', 'expanded', 'off'].includes(v)) return false; }
    else if (k === 'buttons') { if (!Array.isArray(v) || v.length > 2 || !v.every(n => n === null || Number.isInteger(n) && n >= 0 && n < 32)) return false; }
    else if (k === 'bubble') { if (v !== null && (!record(v) || !finite(v.dx) || !finite(v.dy))) return false; }
    else if (['animOff', 'params', 'sound', 'behavior'].includes(k)) { if (!record(v)) return false; }
    else return false;
  }
  if (p.behavior) {
    const defaults = require('./store').DEFAULT_BEHAVIOR;
    for (const [k, v] of Object.entries(p.behavior)) {
      if (!(Object.hasOwn(defaults, k)) || typeof v !== typeof defaults[k]) return false;
      if (typeof v === 'number' && (!finite(v) || v < 0 || v > 1440)) return false;
      if (k === 'containment' && !['screen', 'all', 'taskbar'].includes(v)) return false;
      if (k === 'cursorFollowMode' && !['sideways', 'all'].includes(v)) return false;
      if (k === 'tricks' && !['off', 'rare', 'normal', 'often'].includes(v)) return false;
    }
  }
  if (p.sound && ((p.sound.volume !== undefined && (!finite(p.sound.volume) || p.sound.volume < 0 || p.sound.volume > 1)) || (p.sound.muted !== undefined && typeof p.sound.muted !== 'boolean') || (p.sound.anims !== undefined && !record(p.sound.anims)))) return false;
  return true;
}

function studioArgs(name, args) {
  if (!safeData(args)) return false;
  const [a, b] = args;
  if (['pet-code', 'export', 'delete-pet'].includes(name)) return str(a, 4096);
  if (name === 'add-instance') return str(a, 4096) && (b == null || str(b, 100));
  if (name === 'set-instance') return str(a) && patch(b);
  if (name === 'move-instance') return str(a) && (b === -1 || b === 1 || b === 'up' || b === 'down');
  if (name === 'set-cage-enabled') return typeof a === 'boolean';
  if (['duplicate-instance', 'remove-instance', 'menu'].includes(name)) return str(a);
  if (name === 'play') return str(a) && str(b);
  if (name === 'press') return str(a) && (b === 0 || b === 1);
  if (name === 'copy') return str(a, 100000);
  if (name === 'prompt') return ['create', 'missing', 'custom-sounds', 'link', 'buttons'].includes(a) && record(b);
  if (name === 'claude-hooks') return ['install', 'uninstall', 'status'].includes(a);
  if (name === 'save-links') return record(a);
  if (name === 'open-path') return str(a, 4096);
  if (name === 'set-hotkey') return str(a, 100) && str(b, 100);
  if (name === 'hotkey-enabled') return str(a, 100) && typeof b === 'boolean';
  if (name === 'hotkeys-enabled') return typeof a === 'boolean';
  return args.length === 0;
}

function petArgs(name, args) {
  if (!safeData(args)) return false;
  const [a, b] = args;
  const point = p => record(p) && finite(p.x) && finite(p.y) && Math.abs(p.x) < 1e6 && Math.abs(p.y) < 1e6;
  if (name === 'set') return ['size', 'bubble', 'asleep', 'sitting', 'barMode'].includes(a) && patch({ [a]: b });
  if (name === 'action') return (a === 'jump' && (b == null || record(b) && (b.sessionId == null || str(b.sessionId)))) || (a === 'button' && record(b) && (b.index === 0 || b.index === 1));
  if (name === 'rect') return point(a) && [a.w, a.h, a.winW, a.winH].every(n => Number.isInteger(n) && n > 0 && n <= 16384);
  if (name === 'drag-start' || name === 'drag-move') return point(a);
  if (name === 'vel') return a == null || record(a) && [a.vx, a.vy].every(n => finite(n) && Math.abs(n) <= 10000);
  if (name === 'manifest') return record(a) && a.format === 1 && str(a.name, 200) && record(a.canvas) && [a.canvas.width, a.canvas.height].every(n => Number.isInteger(n) && n >= 8 && n <= 512) && finite(a.scale) && a.scale >= 0.25 && a.scale <= 20 && record(a.animations);
  if (name === 'hits') return Array.isArray(a) && a.length <= 32 && a.every(r => point(r) && finite(r.w) && finite(r.h));
  if (name === 'mode') return str(a, 41) && /^[a-zA-Z][a-zA-Z0-9]*$/.test(a);
  if (name === 'hold') return a === null || ['menu', 'drag'].includes(a);
  if (name === 'dance') return a === undefined || finite(a) && a >= 0 && a <= 120000;
  if (name === 'menu-click') return Number.isInteger(a);
  if (name === 'menu-slide') return Number.isInteger(a) && finite(b);
  if (name === 'pass-wheel') return record(a) && finite(a.dx) && finite(a.dy);
  if (name === 'copy-missing') return Array.isArray(a) && a.length <= 100 && a.every(k => str(k, 100));
  if (name === 'input-trace') return record(a);
  if (name === 'input-lost') return Number.isInteger(a) && a >= 0 && a < 5;
  return args.length === 0;
}
module.exports = { safeData, patch, studioArgs, petArgs };
