const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { create } = require('../lib/text-avoid');
const keyWatch = require('../lib/key-watch');

test('disabling text avoidance cancels scheduled/queued scans before capture', async () => {
  const timers = []; let captures = 0; let enabled = true;
  const engine = create({ host: { avoidPets: () => [{ uid: 'p', canMove: true, avoidText: true, display: { id: 1 }, rect: { x: 0, y: 0, w: 16, h: 16 } }], hideFromCapture: async () => {} }, context: async () => null, scan: async () => { captures++; return null; }, enabled: () => enabled, setTimer: cb => { timers.push(cb); return cb; }, clearTimer: cb => { timers.splice(timers.indexOf(cb), 1); } });
  engine.typed(); assert.equal(timers.length, 1);
  const phrase = engine.phrase(); enabled = false; engine.stop();
  await phrase; await engine.idle();
  assert.equal(timers.length, 0); assert.equal(captures, 0);
  engine.typed(); await engine.phrase(); assert.equal(captures, 0);
});

test('a scan already in flight discards results after consent is withdrawn and restores visibility', async () => {
  let enabled = true; let resume; const shown = []; let plans = 0;
  const pet = { uid: 'p', canMove: true, avoidText: true, display: { id: 1 }, rect: { x: 0, y: 0, w: 16, h: 16 } };
  const engine = create({ host: { avoidPets: () => [pet], hideFromCapture: async on => { shown.push(on); }, avoidSend: () => { plans++; } }, context: async () => null, enabled: () => enabled, scan: () => new Promise(resolve => { resume = resolve; }) });
  const task = engine.phrase();
  while (!resume) await new Promise(resolve => setImmediate(resolve));
  enabled = false; engine.stop(); resume({}); await task;
  assert.deepEqual(shown, [true, false]); assert.equal(plans, 0);
});

test('screen capture requires consent at entry and after every asynchronous capture', async () => {
  const file = path.join(__dirname, '../lib/screen-scan.js');
  const req = createRequire(file); let calls = 0; let finish;
  const context = vm.createContext({ module: { exports: {} }, setTimeout, require: name => name === 'electron' ? { desktopCapturer: { getSources: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } } : req(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const scan = context.module.exports.scanDisplay;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 16, height: 16 } };
  assert.equal(await scan(display), null); assert.equal(calls, 0);
  let enabled = true;
  const result = scan(display, null, () => enabled); enabled = false; finish([]);
  assert.equal(await result, null); assert.equal(calls, 1);
});

test('stopped keyboard helpers cannot deliver late typing or phrase events or restart', () => {
  let typing = 0; let launches = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.kill = () => {};
  const watcher = keyWatch.create({ platform: 'win32', spawnProcess: () => { launches++; return child; }, onTyping: () => { typing++; } });
  assert.equal(launches, 0); watcher.start(); child.stdout.emit('data', 't\n'); assert.equal(typing, 1);
  watcher.stop(); child.stdout.emit('data', 't\n'); child.emit('exit');
  assert.equal(watcher.running, false); assert.equal(typing, 1); assert.equal(launches, 1);
});
