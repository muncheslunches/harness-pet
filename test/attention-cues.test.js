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
function hostRig(opts = {}) {
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
      if (name === './turn-check') return { checkTurn: () => null, backgroundTasks: () => 0, ...opts.turnCheck };
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

test('a session that only gets older wakes nobody; a new word from its agent does', () => {
  const rig = hostRig();
  try {
    const started = rig.clock.now;
    rig.writeSession({ sessionId: 'stuck', state: 'working', ts: started, harness: 'claude-code' });
    rig.run(`ctx = { prefs: { instances: [{ uid: 'pet', harness: 'claude-code', behavior: {} }] }, links: { links: {} } };`);
    const newsAt = () => rig.run(`sessions = readSessions(); noteAgentNews(); agentNews.get('pet').at`);
    assert.equal(newsAt(), 0, 'what was already there when the app started is not news');

    rig.clock.now = started + 31 * 60e3;
    assert.equal(newsAt(), 0, 'timing out to idle is not news');
    assert.equal(rig.run(`sessions[0].effective`), 'idle');

    const said = (rig.clock.now += 60e3);
    rig.writeSession({ sessionId: 'stuck', state: 'working', ts: said, harness: 'claude-code' });
    assert.equal(newsAt(), said, 'another tool call is');

    rig.clock.now = said + 25 * 3600e3;
    assert.equal(newsAt(), said, 'a day-old session being cleared away is not');
    assert.equal(rig.run(`sessions.length`), 0);

    const back = rig.clock.now;
    rig.writeSession({ sessionId: 'next', state: 'working', ts: back, harness: 'claude-code' });
    assert.equal(newsAt(), back, 'news still gets through after one');
  } finally {
    rig.cleanup();
  }
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

test('a pet you hide stays hidden while its agent window is open, until you show it', async () => {
  const rig = hostRig();
  try {
    const inst = store.newInstance('builtin:clawrk', 'antigravity');
    inst.behavior.showWithAgent = true;
    const appeared = [];
    rig.context.appear = (i) => appeared.push(i.uid);
    rig.context.spawnPet = () => null;
    rig.context.__inst = inst;
    rig.run(`ctx = { prefs: { instances: [__inst], petSettings: {} }, links: { links: { antigravity: { window: { process: 'Antigravity' } } } },
      save() {}, onChange() {} };
      sessions = [];`);
    rig.win.shown = true;

    // sent away by its agent: it comes back with the window
    rig.context.autoSet(inst.uid, { visible: false });
    await rig.context.presenceCheck();
    assert.deepEqual(appeared, [inst.uid]);

    // hidden by you (menu, Studio, tray or the show / hide hotkey): it waits for you
    rig.context.setInstance(inst.uid, { visible: false });
    assert.equal(inst.userHidden, true);
    await rig.context.presenceCheck();
    await rig.context.presenceCheck();
    assert.deepEqual(appeared, [inst.uid]);

    rig.context.setInstance(inst.uid, { visible: true });
    assert.equal(inst.userHidden, false);
  } finally {
    rig.cleanup();
  }
});

test('a session a narrower feed relays belongs to that feed only', () => {
  const rig = hostRig();
  try {
    const now = rig.clock.now;
    // a VS Code turn: the shared Claude Code hooks and the VS Code-only bridge both write it
    rig.writeSession({ sessionId: 'abc', state: 'working', ts: now, harness: 'claude-code' });
    rig.writeSession({ sessionId: 'claude-code-abc', state: 'working', ts: now, harness: 'vscode' });
    // a desktop turn: only the shared hooks see it
    rig.writeSession({ sessionId: 'def', state: 'working', ts: now, harness: 'claude-code' });
    const list = rig.context.readSessions().map((s) => `${s.harness}:${s.sessionId}`).sort();
    assert.equal(list.join(' '), 'claude-code:def vscode:claude-code-abc');
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

test('needs-you keeps calling you through a long wait and settles after an hour', () => {
  const rig = hostRig();
  try {
    const now = rig.clock.now += 2 * 3600e3;
    rig.writeSession({ sessionId: 'lunch', state: 'needs-you', ts: now - 40 * 60e3, harness: 'claude-code' });
    rig.writeSession({ sessionId: 'stuck-warn', state: 'needs-you', ts: now - 61 * 60e3, harness: 'antigravity' });
    const list = rig.context.readSessions();
    assert.strictEqual(list.find((x) => x.sessionId === 'lunch').effective, 'needs-you');
    assert.strictEqual(list.find((x) => x.sessionId === 'stuck-warn').effective, 'idle', 'a stale needs-you does not keep the pet warning forever');
  } finally {
    rig.cleanup();
  }
});

test('usage limit detection resolves needs-you to idle immediately', () => {
  const rig = hostRig({ turnCheck: { checkTurn: (_s, now) => ({ finished: true, at: now, state: 'idle', detail: 'Usage limit reached' }) } });
  try {
    const now = (rig.clock.now += 10 * 60e3);
    rig.writeSession({ sessionId: 'usage-out', state: 'needs-you', ts: now - 1000, harness: 'antigravity' });
    const list = rig.context.readSessions();
    const s = list.find((x) => x.sessionId === 'usage-out');
    assert.ok(s);
    assert.strictEqual(s.effective, 'idle');
    assert.strictEqual(s.detail, 'Usage limit reached');
  } finally {
    rig.cleanup();
  }
});

test('appear refreshes the pet right before it re-appears', () => {
  const rig = hostRig();
  try {
    const inst = store.newInstance('builtin:clawrk', 'antigravity');
    inst.behavior.smokeOnLeave = true;
    const refreshed = [];
    rig.context.refreshPet = (uid, opts) => refreshed.push({ uid, opts });
    rig.context.autoSet = () => {};
    rig.context.__inst = inst;
    rig.run(`ctx = { prefs: { instances: [__inst] } };
      presenceOf(__inst.uid).autoHidden = true;`);
    rig.context.appear(inst, null);
    assert.equal(refreshed[0].uid, inst.uid);
    assert.equal(refreshed[0].opts.appearWithSmoke, true);
  } finally {
    rig.cleanup();
  }
});

test('a background task keeps its pet with the window minimized; an unanswered window check sends nobody away', async () => {
  const rig = hostRig({ turnCheck: { backgroundTasks: (s) => (s.sessionId === 'bg' ? 1 : 0) } });
  try {
    const inst = store.newInstance('builtin:clawrk', 'claude-code');
    inst.behavior.showWithAgent = true;
    const left = [];
    rig.context.leave = (i) => left.push(i.uid);
    rig.context.__inst = inst;
    rig.writeSession({ sessionId: 'bg', state: 'done', ts: rig.clock.now - 60e3, harness: 'claude-code' });
    rig.run(`ctx = { prefs: { instances: [__inst] }, links: { links: { 'claude-code': { window: { process: 'claude' } } } } };
      sessions = readSessions();
      live.set(__inst.uid, { ready: true, win: { isDestroyed: () => false, webContents: { send() {} } } });`);
    assert.equal(rig.run('sessions[0].effective'), 'idle');
    rig.context.presenceOf(inst.uid).lastActive = Date.now() - 60 * 60e3;
    rig.win.shown = false;
    await rig.context.presenceCheck();
    assert.deepEqual(left, [], 'the background task keeps it');

    rig.run('sessions = [];');
    rig.context.presenceOf(inst.uid).lastActive = Date.now() - 60 * 60e3; // the task finished long ago
    rig.win.shown = null; // the helper could not tell
    await rig.context.presenceCheck();
    assert.deepEqual(left, []);
    rig.win.shown = false;
    await rig.context.presenceCheck();
    assert.deepEqual(left, [inst.uid]);
  } finally {
    rig.cleanup();
  }
});

test('show all pets leaves a pet that follows its agent to that agent\'s window', async () => {
  const rig = hostRig();
  try {
    const follower = store.newInstance('builtin:clawrk', 'claude-code');
    follower.behavior.showWithAgent = true;
    const plain = store.newInstance('builtin:clawrk', 'claude-code');
    const appeared = [];
    rig.context.appear = (i) => appeared.push(i.uid);
    rig.context.spawnPet = () => null;
    rig.context.__pets = [follower, plain];
    rig.run(`ctx = { prefs: { instances: __pets, petSettings: {} }, links: { links: { 'claude-code': { window: { process: 'claude' } } } },
      save() {}, onChange() {} };
      sessions = [];`);
    rig.context.setAllVisible(false);
    assert.equal(follower.userHidden, true);

    rig.win.shown = false; // its agent's window is minimized
    rig.context.setAllVisible(true); // checks presence at once
    await new Promise((r) => setImmediate(r));
    assert.equal(plain.visible, true);
    assert.equal(follower.visible, false, 'it stays away while the window is minimized');
    assert.equal(follower.userHidden, false, 'but is free to come back');
    assert.deepEqual(appeared, []);

    rig.win.shown = true;
    await rig.context.presenceCheck();
    assert.deepEqual(appeared, [follower.uid]);
  } finally {
    rig.cleanup();
  }
});
