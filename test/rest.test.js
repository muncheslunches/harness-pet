// Pets rest in two steps while you are away, and only your input or their agent wakes them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Rest = require('../lib/rest');
const policy = require('../lib/ipc-policy');
const store = require('../lib/store');

const min = 60e3;

test('pets slow down after 5 quiet minutes and sleep after 10', () => {
  assert.equal(Rest.levelFor(0), 0);
  assert.equal(Rest.levelFor(5 * min - 1), 0);
  assert.equal(Rest.levelFor(5 * min), 1);
  assert.equal(Rest.levelFor(10 * min - 1), 1);
  assert.equal(Rest.levelFor(10 * min), 2);
  assert.equal(Rest.levelFor(Infinity), 2);
});

test('rest can be switched off or timed differently', () => {
  assert.equal(Rest.levelFor(Infinity, { idleRest: false }), 0);
  const prefs = { idleSlowMinutes: 2, idleSleepMinutes: 3 };
  assert.equal(Rest.levelFor(2 * min, prefs), 1);
  assert.equal(Rest.levelFor(3 * min, prefs), 2);
  assert.equal(Rest.levelFor(10 * min, { idleSlowMinutes: 30, idleSleepMinutes: 10 }), 2, 'sleep wins when set earlier than slowing down');
});

test('only something new from an agent counts as news, not a session getting older', () => {
  const s = { sessionId: 'a', state: 'working', effective: 'working', ts: 1, detail: 'Editing', background: 0, age: 5 };
  const sig = Rest.agentSignature([s]);
  assert.equal(Rest.agentSignature([{ ...s, age: 50000 }]), sig);
  assert.equal(Rest.agentSignature([{ ...s, effective: 'idle' }]), sig, 'a stuck session timing out');
  assert.equal(Rest.agentSignature([{ ...s, background: 2 }]), sig, 'a background task counted or expiring');
  assert.notEqual(Rest.agentSignature([{ ...s, ts: 2 }]), sig, 'another tool call');
  assert.notEqual(Rest.agentSignature([{ ...s, state: 'done', effective: 'done' }]), sig, 'a finished task');
  assert.notEqual(Rest.agentSignature([]), sig, 'a session going away');
  assert.equal(Rest.agentSignature([s, { ...s, sessionId: 'b' }]), Rest.agentSignature([{ ...s, sessionId: 'b' }, s]), 'order does not matter');
});

test('rest settings are checked like every other setting', () => {
  for (const key of ['idleRest', 'pauseFullscreen']) {
    assert.equal(policy.studioArgs('set-general', [key, true]), true, key);
    assert.equal(policy.studioArgs('set-general', [key, 5]), false, key);
  }
  for (const key of ['idleSlowMinutes', 'idleSleepMinutes']) {
    assert.equal(policy.studioArgs('set-general', [key, 5]), true, key);
    for (const bad of [0, -1, 1.5, 241, true, '5']) assert.equal(policy.studioArgs('set-general', [key, bad]), false, `${key} ${bad}`);
  }
  assert.equal(store.validPrefs({ instances: [], idleRest: false, pauseFullscreen: true, idleSlowMinutes: 3, idleSleepMinutes: 240 }), true);
  assert.equal(store.validPrefs({ instances: [], idleRest: 'no' }), false);
  assert.equal(store.validPrefs({ instances: [], idleSlowMinutes: 0 }), false);
});

// The pet page, with just enough of a browser around it to drive its clock by hand.
function page(fixture = {}) {
  let clock = 1000;
  const noop = () => {};
  const el = () => new Proxy({
    hidden: true, style: {}, dataset: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    querySelector: () => el(), querySelectorAll: () => [], append: noop, setAttribute: noop, addEventListener: noop, animate: () => ({ cancel: noop }),
    getBoundingClientRect: () => ({ left: 400, right: 500, top: 400, bottom: 500, width: 100, height: 100 }),
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const listeners = {};
  const calls = [];
  const host = new Proxy({}, { get: (_t, k) => (cb) => {
    if (String(k).startsWith('on')) listeners[k] = cb;
    else calls.push([k, cb]);
  } });
  const draws = [];
  const rafs = [];
  const timers = [];
  const context = vm.createContext({
    window: { host, addEventListener: noop, innerWidth: 900, innerHeight: 900, screenX: 0, screenY: 0 },
    document: { getElementById: el, title: '', body: el(), querySelectorAll: () => [], addEventListener: noop, createElement: el },
    screen: { availWidth: 1920, availHeight: 1080 }, performance: { now: () => clock }, console, Date, Math, JSON, Object, Number, String, Array, Infinity, Map, Set,
    requestAnimationFrame: (fn) => rafs.push(fn), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    PetPlayer: class {
      constructor() { this.canvas = el(); this.worker = {}; this.unchangedFrames = 0; }
      draw(f) { draws.push(f); } resize() {} get displaySize() { return { w: 100, h: 100 }; } load() { return new Promise(noop); }
    },
    PetCatalog: { BY_KEY: {}, resolve: (k, have) => (have[k] ? { key: k } : { key: 'idle', effect: null }) },
    PetControls: { animationEnabled: () => true, bubbleMode: () => 'off', petName: () => 'Pet', avoidLine: () => '' },
    PetSounds: { SOUNDS: {}, DEFAULTS: {}, ON_BY_DEFAULT: [], play: noop },
    PetMenuIcons: {}, Icons: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pet-window/pet-window.js'), 'utf8'), context);
  context.fixture = {
    uid: 'a', visible: true, size: 1, sound: { muted: true, volume: 0, anims: {} }, animOff: {}, params: {},
    behavior: { wander: true, tricks: 'often', nap: false, social: true, speed: 1, avoidCursor: false }, ...fixture,
  };
  vm.runInContext(`inst = fixture; manifest = { animations: {
    idle: { params: {}, kind: 'state' }, sleep: { params: {}, kind: 'state' }, wake: { params: {}, kind: 'state', duration: 1000 },
    hover: { params: {}, kind: 'reaction' }, walk: { params: {}, kind: 'movement', moves: true, duration: 2000 }, jump: { params: {}, kind: 'trick', duration: 900 },
  } }`, context);
  rafs.length = timers.length = 0;
  return {
    context, listeners, draws, rafs, timers, calls,
    run: (code) => vm.runInContext(code, context),
    advance: (ms) => { clock += ms; return clock; },
    frame() { clock += 34; vm.runInContext('frame(now())', context); },
  };
}

test('drowsy pets stop wandering and play in slow motion; asleep pets sleep', () => {
  const p = page();
  p.frame();
  const t0 = p.draws.at(-1).t;
  p.run('nextTrickAt = 0; moving = { key: "walk", until: Infinity }');
  p.listeners.onRest(1);
  p.frame();
  assert.equal(p.run('moving'), null, 'stops walking');
  p.run('nextTrickAt = 0');
  for (let i = 0; i < 5; i++) p.frame();
  assert.equal(p.run('moving'), null, 'starts nothing new');
  assert.equal(p.run('timed'), null, 'no tricks');
  const before = p.draws.at(-1).t;
  p.frame();
  assert.ok(Math.abs(p.draws.at(-1).t - before - 34 * 0.25) < 0.01, 'a quarter speed');
  assert.ok(before >= t0, 'the animation carries on rather than jumping back');
  p.listeners.onRest(2);
  p.frame();
  assert.equal(p.draws.at(-1).anim, 'sleep');
});

test('a resting pet ignores other pets and wakes when you come back', () => {
  const p = page();
  p.frame();
  p.listeners.onRest(2);
  p.frame();
  p.listeners.onInteract({ type: 'greet', dir: 1, distance: 10 });
  assert.equal(p.run('timed'), null, 'no greeting');
  p.listeners.onDance({ duration: 2000 });
  assert.equal(p.run('timed'), null, 'no dancing');
  p.listeners.onRest(0);
  p.frame();
  assert.equal(p.draws.at(-1).anim, 'wake');
  assert.equal(p.run('restLevel'), 0);
});

test('a pet caught napping when you come back wakes up too', () => {
  const p = page();
  p.frame();
  p.run('sleeping = true');
  p.listeners.onRest(1);
  assert.equal(p.run('timed'), null, 'still dozing as it gets drowsy');
  p.listeners.onRest(0);
  assert.equal(p.run('sleeping'), false);
  assert.equal(p.run('timed.key'), 'wake');
});

test('dozing off and waking because you left make no sound, but agent news still does', () => {
  const p = page();
  const played = [];
  p.context.PetSounds.play = (_a, recipe) => played.push(recipe);
  p.context.AudioContext = class { state = 'running'; suspend() { return { catch() {} }; } };
  p.context.PetSounds.SOUNDS.snore = 'snore';
  p.context.PetSounds.SOUNDS.ding = 'ding';
  p.context.PetSounds.DEFAULTS.sleep = 'snore';
  p.context.PetSounds.DEFAULTS.wake = 'ding';
  p.context.PetSounds.DEFAULTS.done = 'ding';
  p.context.PetSounds.ON_BY_DEFAULT.push('sleep', 'wake', 'done');
  p.run('inst.sound = { muted: false, volume: 1, anims: {} }; manifest.animations.done = { params: {}, kind: "state" }; STATUS_KEY.done = "done"');
  p.frame();
  p.listeners.onRest(2);
  p.frame();
  assert.equal(p.draws.at(-1).anim, 'sleep');
  p.listeners.onRest(0);
  p.frame();
  assert.equal(p.draws.at(-1).anim, 'wake');
  assert.deepEqual(played, [], 'silent so far');
  p.run('timed = null; sessionStatus = "done"');
  p.frame();
  assert.equal(p.draws.at(-1).anim, 'done');
  assert.deepEqual(played, ['ding']);
});

// An audio stream that records what is asked of it, and a pet that is allowed to make sounds.
function audible(p) {
  const played = [];
  const streams = [];
  p.context.AudioContext = class {
    constructor() { this.state = 'running'; this.calls = []; streams.push(this); }
    suspend() { this.state = 'suspended'; this.calls.push('suspend'); return { catch() {} }; }
    resume() { this.state = 'running'; this.calls.push('resume'); return { then: (fn) => { fn(); return { catch() {} }; }, catch() {} }; }
  };
  p.context.PetSounds.play = (_a, recipe) => played.push(recipe);
  p.context.PetSounds.SOUNDS.ding = 'ding';
  p.context.PetSounds.DEFAULTS.hover = 'ding';
  p.context.PetSounds.ON_BY_DEFAULT.push('hover');
  p.run('inst.sound = { muted: false, volume: 1, anims: {} }; sound("hover")');
  return { played, streams };
}

test('the audio stream stays open while you are around and sounds are recent', () => {
  const p = page();
  const { played, streams } = audible(p);
  assert.deepEqual(played, ['ding']);
  for (let i = 0; i < 300; i++) p.frame(); // about 10 s with nothing playing
  assert.deepEqual(streams[0].calls, [], 'a sound right now would start at once');
  p.run('sound("hover")');
  assert.equal(played.length, 2);
  assert.deepEqual(streams[0].calls, []);
});

test('the audio stream suspends after 5 silent minutes, and the next sound still plays', () => {
  const p = page();
  const { played, streams } = audible(p);
  p.advance(5 * 60e3 + 1000);
  p.frame();
  assert.deepEqual(streams[0].calls, ['suspend']);
  p.run('sound("hover")');
  assert.deepEqual(streams[0].calls, ['suspend', 'resume']);
  assert.equal(played.length, 1, 'not yet: the device gets a moment');
  const lead = p.timers.at(-1);
  assert.equal(lead.ms, 60);
  lead.fn();
  assert.equal(played.length, 2);
  assert.equal(streams.length, 1, 'the same stream, not a new one');
});

test('resting suspends the audio stream once a sound has rung out, and coming back reopens it first', () => {
  const p = page();
  const { streams } = audible(p);
  p.listeners.onRest(1);
  p.frame();
  assert.deepEqual(streams[0].calls, [], 'a sound may still be ringing');
  p.advance(5100);
  p.frame();
  assert.deepEqual(streams[0].calls, ['suspend']);
  p.listeners.onRest(0);
  assert.deepEqual(streams[0].calls, ['suspend', 'resume'], 'ready before any sound asks');
});

test('a looping sound keeps the audio stream open', () => {
  const p = page();
  const { streams } = audible(p);
  p.run('loopTimer = 1');
  p.listeners.onRest(1);
  p.advance(5 * 60e3 + 1000);
  p.frame();
  assert.deepEqual(streams[0].calls, []);
});

test('redraws slow down only when nothing you could notice would change', () => {
  const p = page();
  const gap = () => p.run('frameGap()');
  assert.equal(gap(), 30);
  p.run('player.unchangedFrames = 1');
  assert.equal(gap(), 30, 'one repeat could be chance');
  p.run('player.unchangedFrames = 2');
  assert.equal(gap(), 100, 'a pet holding still');
  p.run('player.unchangedFrames = 30');
  assert.equal(gap(), 200, 'a pet that has held still for a while');
  p.run('moving = { key: "walk", until: Infinity }');
  assert.equal(gap(), 30, 'walking keeps the full rate');
  p.run('moving = null; cursor = { x: 450, y: 450 }');
  assert.equal(gap(), 30, 'so does the cursor being on the pet');
  p.run('cursor = null; player.unchangedFrames = 0; inst.asleep = true');
  assert.equal(gap(), 125);
  p.run('inst.asleep = false; inst.disabledUntil = -1');
  assert.equal(gap(), 1000);
  p.run('inst.disabledUntil = 0');
  p.listeners.onRest(1);
  assert.equal(gap(), 200);
  p.listeners.onRest(2);
  assert.equal(gap(), 1000);
  p.run('dragging = true');
  assert.equal(gap(), 30, 'picking a pet up always gets the full rate');
});

test('the heartbeat keeps going at every rest level, so the watchdog never reloads a sleeping pet', () => {
  const p = page();
  p.listeners.onRest(2);
  const alive = () => p.calls.filter(([k, v]) => k === 'health' && v.event === 'alive').length;
  p.frame();
  const before = alive();
  for (let i = 0; i < 12; i++) { p.advance(966); p.frame(); }
  assert.ok(alive() >= before + 2, 'at least every 5 s of frames');
});

// The bar's collapse used to run off the 11-a-second cursor messages. With a still cursor
// those are down to one a second, so the page's own frames have to keep its timing.
test('the bar still collapses on time with the cursor holding still', () => {
  const p = page({ barMode: 'mini' });
  p.context.PetControls.bubbleMode = () => 'mini';
  p.run('barState = "mini"; cursor = { x: 1500, y: 1500 }');
  p.frame();
  assert.equal(p.run('barState'), 'mini');
  for (let i = 0; i < 40; i++) p.frame(); // ~1.4 s, no cursor messages at all
  assert.equal(p.run('barState'), 'pill');
});

test('the host hit-tests on every poll, and repeats only an unchanged cursor position less often', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/pet-host.js'), 'utf8');
  const poll = source.slice(source.indexOf('function pollCursor()'), source.indexOf('// ---------- public API'));
  assert.ok(poll.indexOf('hitTest(uid, rt, p, b)') < poll.indexOf('if (!feed'), 'the hit test comes before anything can skip');
  assert.match(poll, /setTimeout\(pollCursor, HIT_FAST\)/);
  assert.ok(!/forward:\s*true/.test(source), 'no Electron mouse forwarding: its system-wide hook froze the cursor during main-thread stalls');
});
