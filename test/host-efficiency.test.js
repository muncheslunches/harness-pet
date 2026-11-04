// The host's side of saving work: which cursor messages it skips, which windows it
// closes, and which helper it picks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const store = require('../lib/store');

function hostRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-efficiency-'));
  const clock = { now: 1_000_000 };
  class FakeDate extends Date { static now() { return clock.now; } }
  const timers = [];
  const cursor = { x: 500, y: 500 };
  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const powerMonitor = { idle: 0, getSystemIdleTime() { return this.idle; }, on() {} };
  const context = vm.createContext({
    module: { exports: {} }, __dirname: path.dirname(file), process, console, Date: FakeDate,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    require: (name) => {
      if (name === 'electron') return { screen: { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, ipcMain: { on() {}, handle() {} }, powerMonitor };
      if (name === './store') return { ...store, PATHS: { ...store.PATHS, sessions: dir } };
      return requireHost(name);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const fakeRt = (uid, extra = {}) => {
    const sent = [];
    const ignores = [];
    const rt = {
      uid, ready: true, ignoring: true, hits: [], hold: null, rest: 0, rect: { x: 400, y: 400, w: 100, h: 100 }, anchor: { x: 100, y: 100 }, offset: { x: 0, y: 0 },
      anchoredOffset: () => ({ x: 0, y: 0 }), sent, ignores,
      win: {
        destroyed: false, isDestroyed() { return this.destroyed; }, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 900, height: 900 }),
        setIgnoreMouseEvents: (v) => ignores.push(v), destroy() { this.destroyed = true; },
        webContents: { isCrashed: () => false, send: (channel, value) => sent.push([channel, value]) },
      },
      ...extra,
    };
    return rt;
  };
  const run = (code) => vm.runInContext(code, context);
  context.__add = (uid, rt) => run('live').set(uid, rt);
  return { context, clock, timers, cursor, powerMonitor, fakeRt, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function withPet(rig, behavior = {}, extra = {}) {
  const inst = { ...store.newInstance('builtin:clawrk', null), uid: 'a', behavior: { ...store.DEFAULT_BEHAVIOR, ...behavior }, ...extra };
  rig.context.__ctx = { prefs: { instances: [inst] }, save() {}, onChange() {} };
  rig.run('ctx = __ctx');
  const rt = rig.fakeRt('a');
  rig.context.__add('a', rt);
  return { inst, rt };
}

const cursorMessages = (rt) => rt.sent.filter(([c]) => c === 'cursor').length;
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects from the rig's own realm

test('a cursor position the page already has is repeated only once a second', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig);
    const poll = () => { rig.clock.now += 30; rig.run('pollCursor()'); };
    for (let i = 0; i < 100; i++) poll(); // 3 seconds with the mouse still
    assert.ok(cursorMessages(rt) >= 3 && cursorMessages(rt) <= 5, `about one a second, got ${cursorMessages(rt)}`);
    const before = cursorMessages(rt);
    rig.cursor.x += 7;
    for (let i = 0; i < 4; i++) poll();
    assert.equal(cursorMessages(rt), before + 1, 'a move goes out at the next feed');
    assert.deepEqual(plain(rt.sent.filter(([c]) => c === 'cursor').at(-1)[1]), { x: 507, y: 500 });
  } finally { rig.cleanup(); }
});

test('a pet moving under a still cursor counts as the cursor moving', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig);
    const poll = () => { rig.clock.now += 30; rig.run('pollCursor()'); };
    for (let i = 0; i < 4; i++) poll();
    const before = cursorMessages(rt);
    rt.win.getBounds = () => ({ x: 25, y: 0, width: 900, height: 900 });
    for (let i = 0; i < 4; i++) poll();
    assert.equal(cursorMessages(rt), before + 1);
    assert.deepEqual(plain(rt.sent.filter(([c]) => c === 'cursor').at(-1)[1]), { x: 475, y: 500 });
  } finally { rig.cleanup(); }
});

test('the mouse is still hit-tested on every poll, cursor message or not', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig);
    const poll = () => { rig.clock.now += 30; rig.run('pollCursor()'); };
    for (let i = 0; i < 4; i++) poll();
    assert.equal(rt.ignoring, true);
    const before = cursorMessages(rt);
    // the pet's rectangle moves under the still cursor: the window must catch the mouse on the very next poll
    rt.hits = [{ x: 480, y: 480, w: 60, h: 60, menu: false }];
    poll();
    assert.equal(rt.ignoring, false, 'caught within one 30 ms poll');
    assert.equal(cursorMessages(rt), before, 'with no message to the page');
    rt.hits = [];
    poll();
    assert.equal(rt.ignoring, true, 'and let go just as fast');
  } finally { rig.cleanup(); }
});

test('moving the mouse wakes resting pets without waiting for the next check', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig);
    rig.powerMonitor.idle = 3600;
    rig.clock.now += 7200e3;
    rig.run('restCheck()');
    assert.equal(rt.rest, 2);
    rig.run('pollCursor()');
    rig.powerMonitor.idle = 0;
    rig.cursor.x += 1;
    rig.run('pollCursor()');
    assert.equal(rt.rest, 0);
    assert.deepEqual(rt.sent.filter(([c]) => c === 'rest').map(([, v]) => v), [2, 0]);
  } finally { rig.cleanup(); }
});

test('news from its agent wakes a pet, and it dozes off again later', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig);
    rig.context.__inst = rig.run('ctx.prefs.instances[0]');
    rig.run('__inst.harness = "claude-code"');
    rig.powerMonitor.idle = 3600;
    rig.clock.now += 7200e3;
    rig.run('noteAgentNews(); restCheck()');
    assert.equal(rt.rest, 2, 'what was already there at the start is not news');
    rig.context.__s = { sessionId: 's', harness: 'claude-code', state: 'working', effective: 'working', ts: 5 };
    rig.run('sessions = [__s]; noteAgentNews()');
    assert.equal(rt.rest, 0);
    rig.clock.now += 5 * 60e3;
    rig.run('restCheck()');
    assert.equal(rt.rest, 1);
    rig.clock.now += 5 * 60e3;
    rig.run('restCheck()');
    assert.equal(rt.rest, 2);
  } finally { rig.cleanup(); }
});

test('resting pets do not greet each other', () => {
  const rig = hostRig();
  try {
    const { inst, rt } = withPet(rig, { social: true });
    const other = { ...store.newInstance('builtin:clawrk', null), uid: 'b', behavior: { ...store.DEFAULT_BEHAVIOR, social: true } };
    rig.run('ctx').prefs.instances.push(other);
    const rtB = rig.fakeRt('b');
    rig.context.__add('b', rtB);
    Object.assign(rt, { mode: 'idle', greetCooldown: new Map(), rest: 2 });
    Object.assign(rtB, { mode: 'idle', greetCooldown: new Map(), rest: 0 });
    assert.ok(inst);
    const originalRandom = Math.random;
    rig.run('Math.random = () => 0');
    rig.run('socialCheck()');
    assert.equal(rt.sent.filter(([c]) => c === 'interact').length, 0);
    assert.equal(rtB.sent.filter(([c]) => c === 'interact').length, 0);
    rt.rest = 0;
    rig.run('socialCheck()');
    assert.equal(rt.sent.filter(([c]) => c === 'interact').length, 1, 'awake, they do');
    Math.random = originalRandom;
  } finally { rig.cleanup(); }
});

test('a hidden pet closes its window: soon if it comes and goes with its agent, later if you hid it', () => {
  const rig = hostRig();
  try {
    const { inst, rt } = withPet(rig, { showWithAgent: true }, { visible: false, userHidden: false });
    rig.run('closeWhenHidden("a", live.get("a"))');
    assert.equal(rig.timers.at(-1).ms, 30e3);
    inst.userHidden = true;
    rig.run('closeWhenHidden("a", live.get("a"))');
    assert.equal(rig.timers.at(-1).ms, 5 * 60e3);
    inst.behavior.showWithAgent = false;
    inst.userHidden = false;
    rig.run('closeWhenHidden("a", live.get("a"))');
    assert.equal(rig.timers.at(-1).ms, 5 * 60e3);
    assert.equal(rt.win.destroyed, false);
    rig.timers.at(-1).fn();
    assert.equal(rt.win.destroyed, true);
    assert.deepEqual(plain(inst.pos), { x: 100, y: 100 }, 'it remembers where it was');
  } finally { rig.cleanup(); }
});

test('a pet shown again before the timer ends keeps its window', () => {
  const rig = hostRig();
  try {
    const { inst, rt } = withPet(rig, {}, { visible: false });
    rig.run('closeWhenHidden("a", live.get("a"))');
    inst.visible = true;
    rig.timers.at(-1).fn();
    assert.equal(rt.win.destroyed, false);
  } finally { rig.cleanup(); }
});

test('a visible pet or the cage never gets a closing timer', () => {
  const rig = hostRig();
  try {
    const { inst } = withPet(rig, {}, { visible: true });
    const before = rig.timers.length;
    rig.run('closeWhenHidden("a", live.get("a"))');
    assert.equal(rig.timers.length, before);
    inst.visible = false;
    inst.isCage = true;
    rig.run('closeWhenHidden("a", live.get("a"))');
    assert.equal(rig.timers.length, before);
  } finally { rig.cleanup(); }
});

test('a page still loading gets longer before each reload', () => {
  const rig = hostRig();
  try {
    const { rt } = withPet(rig, {});
    rt.ready = false;
    rt.spawnedAt = rig.clock.now;
    let refreshes = 0;
    rig.context.refreshPet = () => { refreshes++; rt.spawnedAt = rig.clock.now; };
    rig.run('watchPausedUntil = 0');
    const after = (ms) => { rig.clock.now += ms; rig.run('watchdog()'); return refreshes; };
    assert.equal(after(19_000), 0);
    assert.equal(after(2_000), 1, 'first reload after 20 s');
    assert.equal(after(30_000), 1, 'no second reload at 20 s more');
    assert.equal(after(11_000), 2, 'second after 40 s');
    assert.equal(after(70_000), 2);
    assert.equal(after(11_000), 3, 'third after 80 s');
  } finally { rig.cleanup(); }
});

test('the Rust helper is used when present and PowerShell otherwise', () => {
  const native = require('../lib/native');
  const bin = path.join(__dirname, '..', 'native', 'bin');
  const built = fs.existsSync(path.join(bin, 'harness-pet-helper.exe'));
  const cmd = native.command('helper', 'win-helper.ps1', { scriptArgs: ['-X'], exeArgs: ['--x'] });
  if (built) {
    assert.equal(cmd.rust, true);
    assert.deepEqual(cmd.args, ['--x']);
  } else assert.equal(cmd.rust, false);
  process.env.HARNESS_PET_NO_RUST = '1';
  const off = native.command('helper', 'win-helper.ps1', { scriptArgs: ['-X'] });
  delete process.env.HARNESS_PET_NO_RUST;
  assert.equal(off.rust, false);
  assert.equal(off.file, 'powershell.exe');
  assert.ok(off.args.includes('-NonInteractive'));
  assert.equal(off.args.at(-1), '-X');
  assert.ok(off.args.at(-2).endsWith('win-helper.ps1'));
  const warn = console.warn;
  console.warn = () => {};
  native.distrust('helper');
  console.warn = warn;
  assert.equal(native.command('helper', 'win-helper.ps1').rust, false, 'a helper that never started is not tried again');
});

test('the source of the helpers stays out of the installer, and their programs out of git', () => {
  const config = fs.readFileSync(path.join(__dirname, '../electron-builder.config.js'), 'utf8');
  assert.match(config, /'native\/\*\*'/);
  assert.match(config, /'!native\/rust\/\*\*'/);
  const ignore = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8');
  assert.match(ignore, /^native\/bin\/\r?$/m);
  assert.match(ignore, /^native\/rust\/target\/\r?$/m);
});
