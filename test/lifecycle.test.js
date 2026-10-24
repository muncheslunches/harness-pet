const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('renderer recovery resets input, reloads at most twice per minute, and ignores closed windows', () => {
  const pending = [];
  const context = vm.createContext({ module: { exports: {} }, require, setTimeout: (fn) => pending.push(fn) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/lifecycle.js'), 'utf8'), context);
  const wc = new EventEmitter();
  let resets = 0, reloads = 0, destroyed = false;
  wc.reload = () => reloads++;
  const win = { webContents: wc, isDestroyed: () => destroyed, on() {} };
  context.module.exports.watchWindow(win, 'test', () => resets++);
  for (let i = 0; i < 3; i++) wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(resets, 3);
  assert.equal(pending.length, 2);
  pending.shift()();
  assert.equal(reloads, 1);
  destroyed = true;
  pending.shift()();
  assert.equal(reloads, 1);
});

test('window count is logged on start, only when it changes, and on the periodic sample', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-life-'));
  const timers = [];
  const context = vm.createContext({
    module: { exports: {} }, require, process, console, Date,
    setTimeout: (fn) => fn(), // run the deferred sample immediately
    setInterval: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/lifecycle.js'), 'utf8'), context);
  const L = context.module.exports;
  const app = new EventEmitter();
  app.getAppPath = () => dir;
  app.getAppMetrics = () => [{}, {}, {}];
  let count = 2;
  L.install(app, dir);
  L.watchWindowCount(app, { getAllWindows: () => new Array(count) });
  app.emit('browser-window-created'); // unchanged: not logged
  count = 3;
  app.emit('browser-window-created');
  timers[0](); // periodic sample logs even when unchanged
  const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').split('\n').filter((l) => / windows /.test(l));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /windows: 2, processes: 3, reason: 'start'/);
  assert.match(lines[1], /windows: 3, processes: 3, reason: 'change'/);
  assert.match(lines[2], /windows: 3, processes: 3, reason: 'sample'/);
  fs.rmSync(dir, { recursive: true, force: true });
});
