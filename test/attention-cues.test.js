const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const Catalog = require('../shared/catalog');
const Schema = require('../shared/pet-schema');
const store = require('../lib/store');

// pet-host with a temp sessions folder and a scriptable window helper
function hostRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sessions-'));
  const win = { fg: null, shown: null, shownCalls: 0 };
  const clock = { now: Date.now() };
  class FakeDate extends Date { static now() { return clock.now; } }
  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.dirname(file),
    process,
    console,
    Date: FakeDate,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    require: (name) => {
      if (name === 'electron') return { screen: {}, ipcMain: { on() {}, handle() {} } };
      if (name === './store') return { ...store, PATHS: { ...store.PATHS, sessions: dir } };
      if (name === './turn-check') return { finishedAt: () => null };
      if (name === './helper') return {
        foregroundApp: async () => win.fg,
        windowShown: async () => { win.shownCalls++; return win.shown; },
      };
      return requireHost(name);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const writeSession = (s) => fs.writeFileSync(path.join(dir, s.sessionId + '.json'), JSON.stringify(s));
  return { context, win, clock, writeSession, run: (c) => vm.runInContext(c, context), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('needs-you and done fall back to different effects', () => {
  const have = { idle: true };
  const needs = Catalog.resolve('needsYou', have);
  const done = Catalog.resolve('done', have);
  assert.deepEqual(needs, { key: 'idle', effect: 'alert' });
  assert.deepEqual(done, { key: 'idle', effect: 'cheer' });
  assert.ok(Catalog.EFFECTS.includes('alert') && Catalog.EFFECTS.includes('cheer'));
  // a pet that draws its own needsYou still plays it
  assert.deepEqual(Catalog.resolve('needsYou', { idle: true, needsYou: true }), { key: 'needsYou', effect: null });
});

test('alert keeps moving, cheer settles after its celebration', () => {
  const alertDy = [];
  for (let t = 0; t < 1260; t += 70) alertDy.push(Schema.effectTransform('alert', t).dy);
  assert.ok(alertDy.some((dy) => dy < 0), 'alert hops');
  assert.ok(Schema.effectTransform('alert', 9 * 70).dx !== 0, 'alert wiggles between hops');
  assert.ok(alertDy.slice(12).every((dy) => dy === 0), 'alert pauses before the next pair of hops');
  assert.ok(Schema.effectTransform('cheer', 180).dy < 0, 'cheer hops at first');
  for (const t of [2600, 5000, 60000]) assert.deepEqual(Schema.effectTransform('cheer', t), { dx: 0, dy: 0, sy: 1 });
});

test('a finished turn stays unseen until it is marked seen', () => {
  const rig = hostRig();
  try {
    const started = rig.clock.now;
    const now = (rig.clock.now += 10 * 60e3); // the app has been running ten minutes
    rig.writeSession({ sessionId: 'a', state: 'done', ts: now - 60e3, harness: 'claude-code' });
    rig.writeSession({ sessionId: 'b', state: 'working', ts: now, harness: 'claude-code' });
    rig.writeSession({ sessionId: 'old', state: 'done', ts: started - 1000, harness: 'claude-code' }); // ended before the app started
    let list = rig.context.readSessions();
    const byId = (id) => list.find((s) => s.sessionId === id);
    assert.equal(byId('a').effective, 'idle', 'the celebration is over');
    assert.equal(byId('a').unseen, true, 'but the finish is still marked');
    assert.equal(byId('b').unseen, false);
    assert.equal(byId('old').unseen, false);

    rig.context.markSeen(list);
    list = rig.context.readSessions();
    assert.equal(byId('a').unseen, false);

    // the next finished turn of the same session is new again
    rig.writeSession({ sessionId: 'a', state: 'done', ts: now - 1000, harness: 'claude-code' });
    list = rig.context.readSessions();
    assert.equal(byId('a').unseen, true);
    assert.equal(byId('a').effective, 'done');
  } finally {
    rig.cleanup();
  }
});

test('switching to the agent window marks only that agent\'s finishes seen', async () => {
  const rig = hostRig();
  try {
    const now = (rig.clock.now += 10 * 60e3);
    rig.writeSession({ sessionId: 'c', state: 'done', ts: now - 60e3, harness: 'claude-code' });
    rig.writeSession({ sessionId: 'g', state: 'done', ts: now - 60e3, harness: 'antigravity' });
    rig.run(`ctx = { prefs: { instances: [] }, links: { links: {
      'claude-code': { window: { process: 'claude' } },
      antigravity: { window: { process: 'Antigravity' } } } } };
      sessions = readSessions();`);
    rig.win.fg = { process: 'Antigravity', path: 'C:\\x\\Antigravity.exe', title: 'proj' };
    await rig.context.seenCheck();
    const list = rig.context.readSessions();
    assert.equal(list.find((s) => s.sessionId === 'g').unseen, false);
    assert.equal(list.find((s) => s.sessionId === 'c').unseen, true);
  } finally {
    rig.cleanup();
  }
});

test('only-show-with-agent pets stay while the agent window is open and leave once it is minimized', async () => {
  const rig = hostRig();
  try {
    const inst = store.newInstance('builtin:clawrk', 'antigravity');
    inst.behavior.showWithAgent = true;
    inst.behavior.lingerMinutes = 2;
    const left = [];
    const appeared = [];
    rig.context.leave = (i) => left.push(i.uid);
    rig.context.appear = (i) => appeared.push(i.uid);
    rig.context.__inst = inst;
    rig.run(`ctx = { prefs: { instances: [__inst] }, links: { links: { antigravity: { window: { process: 'Antigravity' } } } } };
      sessions = [];
      live.set(__inst.uid, { ready: true, win: { isDestroyed: () => false, webContents: { send() {} } } });`);
    const presence = rig.context.presenceOf(inst.uid);
    rig.win.fg = { process: 'explorer', path: '', title: '' }; // something else is in front

    // window open (just not in front): it stays, and the quiet countdown restarts
    presence.lastActive = Date.now() - 10 * 60e3;
    rig.win.shown = true;
    await rig.context.presenceCheck();
    assert.deepEqual(left, []);
    assert.ok(Date.now() - presence.lastActive < 1000);

    // minimized: it waits out Leaves after, then goes
    rig.win.shown = false;
    await rig.context.presenceCheck();
    assert.deepEqual(left, [], 'not before the countdown runs out');
    presence.lastActive = Date.now() - 3 * 60e3;
    await rig.context.presenceCheck();
    assert.deepEqual(left, [inst.uid]);

    // window restored: the hidden pet comes back
    inst.visible = false;
    rig.win.shown = true;
    await rig.context.presenceCheck();
    assert.deepEqual(appeared, [inst.uid]);
  } finally {
    rig.cleanup();
  }
});

test('a busy agent keeps its pet even with the window minimized', async () => {
  const rig = hostRig();
  try {
    const inst = store.newInstance('builtin:clawrk', 'antigravity');
    inst.behavior.showWithAgent = true;
    const left = [];
    rig.context.leave = (i) => left.push(i.uid);
    rig.context.__inst = inst;
    rig.run(`ctx = { prefs: { instances: [__inst] }, links: { links: { antigravity: { window: { process: 'Antigravity' } } } } };
      sessions = [{ sessionId: 's', harness: 'antigravity', effective: 'needs-you' }];
      live.set(__inst.uid, { ready: true, win: { isDestroyed: () => false, webContents: { send() {} } } });`);
    rig.context.presenceOf(inst.uid).lastActive = Date.now() - 60 * 60e3;
    rig.win.shown = false;
    await rig.context.presenceCheck();
    assert.deepEqual(left, []);
  } finally {
    rig.cleanup();
  }
});
