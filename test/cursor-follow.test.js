// Exercise the actual renderer loop with a stationary canvas and recorded IPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const store = require('../lib/store');
const Catalog = require('../shared/catalog');

function rig(behavior = {}) {
  let clock = 0;
  const sent = [];
  const listeners = {};
  const documentEvents = {};
  const draws = [];
  const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, style: {}, dataset: {}, events: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(key, fn) { this.events[key] = fn; }, setAttribute() {}, setPointerCapture() {},
      querySelector(s) { return element(id + s); },
      querySelectorAll(s) { return s === '.sep' ? [element('sep0'), element('sep1')] : []; },
      getBoundingClientRect() { return rect; }, append() {},
    });
    return elements.get(id);
  };
  const host = new Proxy({ dance: async (...args) => { sent.push({ key: 'dance', args }); return true; } }, { get: (target, key) => target[key] || (key.startsWith('on')
    ? (cb) => { listeners[key] = cb; }
    : (...args) => sent.push({ key, args })) });
  const inst = store.newInstance('test.pet.js');
  Object.assign(inst.behavior, { followCursor: true, tricks: 'off', nap: false }, behavior);
  inst.sound.muted = true;
  const context = vm.createContext({
    console, screen: { availWidth: 1920, availHeight: 1080 },
    performance: { now: () => clock }, requestAnimationFrame() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    document: { getElementById: element, body: element('body'), addEventListener(key, fn) { documentEvents[key] = fn; }, querySelectorAll: () => [] },
    window: { host, addEventListener() {} }, PetCatalog: Catalog, PetControls: require('../shared/pet-controls'), PetIcons: { svg: () => '' },
    PetPlayer: class {
      constructor() { this.canvas = element('canvas'); }
      draw(frame) { draws.push(frame); }
      resize() {}
    },
    fixture: inst,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pet-window/pet-window.js'), 'utf8'), context);
  vm.runInContext(`inst = fixture; manifest = { animations: {
    idle: { params: {}, moves: false }, walk: { params: {}, moves: true }
  } };`, context);
  return {
    inst, sent, draws, listeners, element, documentEvents,
    cursor(x, y) { listeners.onCursor({ x, y }); },
    frame() { clock += 34; vm.runInContext('frame(now())', context); },
    state: () => vm.runInContext('moving', context),
    velocity: () => sent.filter((m) => m.key === 'vel').at(-1)?.args[0],
    set(patch) { Object.assign(inst.behavior, patch); listeners.onInstance(inst); },
    run: (code) => vm.runInContext(code, context),
  };
}

test('nearby dance joins silently, stops walking, and ends without restarting a cascade', () => {
  const r = rig();
  r.run("manifest.animations.dance = { params: {}, duration: 3000 }; startMove('walk');");
  r.listeners.onDance({ duration: 1000 });
  r.frame();
  assert.equal(r.draws.at(-1).anim, 'dance');
  assert.equal(r.state(), null);
  assert.equal(r.sent.filter(m => m.key === 'dance').length, 0);
  for (let i = 0; i < 30; i++) r.frame();
  assert.equal(r.draws.at(-1).anim, 'idle');
});

test('sleeping, busy and dance-disabled renderers decline a group invitation', () => {
  for (const setup of ["sleeping = true", "sessionStatus = 'working'", "inst.animOff.dance = true", "inst.asleep = true", "forced = { key: 'poke', until: 5000 }"]) {
    const r = rig();
    r.run(`manifest.animations.dance = { params: {} }; ${setup}`);
    r.listeners.onDance({ duration: 3000 });
    assert.equal(r.run('timed'), null, setup);
  }
});

test('only the host-approved dance plays sound; interrupted requests cannot play late', async () => {
  for (const allowed of [true, false]) {
    const r = rig();
    r.run(`globalThis.soundPlays = 0;
      globalThis.PetSounds = { DEFAULTS: { dance: 'beat' }, ON_BY_DEFAULT: ['dance'], SOUNDS: { beat: { parts: [] } }, play() { soundPlays++; } };
      globalThis.AudioContext = class { close() { return Promise.resolve(); } };
      inst.sound.muted = false;
      manifest.animations.dance = { params: {}, duration: 3000 };
      window.host.dance = async () => ${allowed};
      forced = { key: 'dance', until: 3000 };`);
    r.frame();
    await Promise.resolve();
    assert.equal(r.run('soundPlays'), allowed ? 1 : 0);
    r.run("sound('dance')");
    assert.equal(r.run('soundPlays'), allowed ? 1 : 0, 'visibility changes cannot start extra dance audio');
  }
  const r = rig();
  r.run(`globalThis.soundPlays = 0; globalThis.sound = () => soundPlays++;
    manifest.animations.dance = { params: {} };
    window.host.dance = () => new Promise(resolve => { globalThis.approveDance = resolve; });
    forced = { key: 'dance', until: 3000 };`);
  r.frame();
  const before = r.run('soundPlays');
  r.run('forced = null; approveDance(true)');
  await Promise.resolve();
  assert.equal(r.run('soundPlays'), before, 'late approval after interruption stays silent');
});

test('pointer-only input still drags, releases and opens the menu without duplicate compatibility actions', () => {
  const r = rig();
  const wrap = r.element('pet-wrap');
  const left = { button: 0, pointerId: 1, screenX: 10, screenY: 10 };
  wrap.events.pointerdown(left);
  wrap.events.mousedown(left);
  r.documentEvents.pointermove({ buttons: 1, screenX: 40, screenY: 30 });
  assert.equal(r.run('dragging'), true);
  r.documentEvents.pointerup({ button: 0 });
  r.documentEvents.mouseup({ button: 0 });
  assert.equal(r.sent.filter(e => e.key === 'dragStart').length, 1);
  assert.equal(r.sent.filter(e => e.key === 'dragEnd').length, 1);
  assert.equal(r.run('holding'), null);
  const middle = { button: 1, screenX: 40, screenY: 30, clientX: 10, clientY: 10, preventDefault() {} };
  wrap.events.pointerdown(middle);
  wrap.events.mousedown(middle);
  assert.equal(r.sent.filter(e => e.key === 'menu').length, 1);
});

test('a single left click on the pet leaves the harness and agent closed after the double-click window', () => {
  const r = rig();
  r.run(`globalThis.clickTimeouts = [];
    setTimeout = (callback, delay) => { clickTimeouts.push({ callback, delay }); return clickTimeouts.length; };`);
  const wrap = r.element('pet-wrap');
  const left = { button: 0, pointerId: 1, screenX: 10, screenY: 10 };
  wrap.events.pointerdown(left);
  wrap.events.mousedown(left);
  r.documentEvents.pointerup(left);
  r.documentEvents.mouseup(left);
  assert.equal(r.run('clickTimer !== null'), true);
  assert.equal(r.run('clickTimeouts.at(-1).delay'), 260);
  r.run('clickTimeouts.at(-1).callback()');
  assert.equal(r.run('clickTimer'), null);
  assert.equal(r.sent.filter((m) => m.key === 'action').length, 0);
  assert.equal(r.run('holding'), null);
});

test('manual sleep slows animation time to ten percent, stops walking and wakes with its animation', () => {
  const r = rig();
  r.run(`manifest.animations.sleep = { params: {}, moves: false };
    manifest.animations.wake = { params: {}, duration: 1100, moves: false };
    startMove('walk', { host: true, vx: 60 }); forced = { key: 'walk', until: Infinity };`);
  const asleep = { ...r.inst, asleep: true };
  r.listeners.onInstance(asleep);
  r.frame();
  assert.equal(r.draws.at(-1).anim, 'sleep');
  assert.equal(r.draws.at(-1).wantMove, false);
  assert.equal(r.state(), null);
  r.frame();
  assert.ok(Math.abs(r.draws.at(-1).t - 3.4) < 0.001);
  assert.ok(Math.abs(r.draws.at(-1).dt - 3.4) < 0.001);
  r.listeners.onInstance({ ...asleep, asleep: false });
  r.frame();
  assert.equal(r.draws.at(-1).anim, 'wake');
  r.frame();
  assert.equal(r.draws.at(-1).t, 34);
});

test('existing pets stay sideways; vertical pursuit starts only after opting in live', () => {
  const r = rig();
  assert.equal(r.inst.behavior.cursorFollowMode, 'sideways');
  r.cursor(50, -500);
  r.frame();
  assert.equal(r.state(), null);
  r.set({ cursorFollowMode: 'all' });
  r.frame();
  assert.equal(r.velocity().vx, 0);
  assert.equal(r.velocity().vy, -60);
  assert.equal(r.draws.at(-1).wantMove, false, 'pet drawing cannot override host steering');
  r.run('player.onMove({ vx: 60, vy: 0 })');
  assert.equal(r.velocity().vy, -60, 'ignore outstanding worker movement');
});

test('recovering a pet clears transient falling and collision blocks so a flying pet can pursue again', () => {
  const r = rig({ cursorFollowMode: 'all' });
  r.cursor(550, 550);
  r.run('falling = true; collisionPauseUntil = Date.now() + 10000; blocked = { right: true, bottom: true }; forced = { key: "fall", until: Infinity }');
  r.listeners.onRecoverMotion();
  assert.equal(r.run('falling'), false);
  assert.equal(r.run('collisionPauseUntil'), 0);
  r.frame();
  assert.ok(r.velocity().vx > 0 && r.velocity().vy > 0);
  assert.equal(r.inst.behavior.followCursor, true);
});

test('turning either button off updates the actual bar immediately; both off minimizes it', () => {
  const r = rig();
  r.inst.buttons = [null, 1];
  r.listeners.onInstance(r.inst);
  assert.equal(r.element('b-0').hidden, true);
  assert.equal(r.element('b-1').hidden, false);
  assert.equal(r.element('sep0').hidden, true);
  r.inst.buttons = [null, null];
  r.listeners.onInstance(r.inst);
  assert.equal(r.run('barState'), 'pill');
  assert.equal(r.element('b-bell').disabled, true);
  r.element('bar').events.click();
  assert.ok(!r.sent.some((m) => m.key === 'set'), 'cannot expand the automatic minimization');
  r.inst.buttons = [0, null];
  r.listeners.onInstance(r.inst);
  assert.equal(r.run('barState'), 'expanded');
});

test('hiding a sounding pet immediately stops its audio and restores playback when shown', () => {
  const r = rig();
  r.run(`let played = 0, closed = 0;
    AudioContext = class { constructor() { this.state = 'running'; } close() { closed++; return Promise.resolve(); } };
    PetSounds = { DEFAULTS: {}, ON_BY_DEFAULT: [], SOUNDS: {}, play() { played++; } };
    manifest.animations.idle.sound = 'chime';
    manifest.sounds = { chime: { parts: [{ f: 880, dur: 1 }] } };
    inst.sound.muted = false;
    sound('idle');`);
  assert.equal(r.run('played'), 1);
  r.listeners.onInstance({ ...r.inst, visible: false });
  assert.equal(r.run('closed'), 1);
  r.run("sound('idle')");
  assert.equal(r.run('played'), 1);
  assert.equal(r.run('inst.sound.muted'), false, 'visibility does not overwrite the mute preference');
  r.listeners.onInstance({ ...r.inst, visible: true });
  assert.equal(r.run('played'), 2);
  r.listeners.onInstance({ ...r.inst, visible: false, sound: { ...r.inst.sound, muted: true } });
  r.listeners.onInstance({ ...r.inst, visible: true, sound: { ...r.inst.sound, muted: true } });
  assert.equal(r.run('played'), 2, 'an explicitly muted pet stays muted when shown');
});

test('Bubble Off hides the bar, speech, and sessions without hiding the pet', () => {
  const r = rig();
  r.inst.barMode = 'off';
  r.listeners.onInstance(r.inst);
  r.listeners.onNotice('An agent needs you');
  r.run('toggleList(true)');
  assert.equal(r.element('bar').hidden, true);
  assert.equal(r.element('bubble').hidden, true);
  assert.equal(r.element('list').hidden, true);
  assert.equal(r.inst.visible, true);
});

test('middle-click requests the pet menu without dragging or shooing', () => {
  const r = rig();
  let prevented = false;
  r.element('pet-wrap').events.mousedown({ button: 1, clientX: 25, clientY: 30, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.ok(r.sent.some((m) => m.key === 'menu'));
  assert.ok(!r.sent.some((m) => m.key === 'dragStart'));
  assert.equal(r.run('menuAt.x'), 25);
});

test('an interrupted drag ends host movement and permits the next drag', () => {
  const r = rig();
  const wrap = r.element('pet-wrap');
  wrap.events.mousedown({ button: 0, pointerId: 1, screenX: 10, screenY: 10 });
  r.documentEvents.mousemove({ buttons: 1, screenX: 50, screenY: 30 });
  assert.equal(r.run('dragging'), true);
  wrap.events.lostpointercapture();
  assert.equal(r.run('dragging'), false);
  assert.equal(r.run('press'), null);
  assert.equal(r.run('holding'), null);
  assert.equal(r.sent.filter((m) => m.key === 'dragEnd').length, 1);
  wrap.events.mousedown({ button: 0, pointerId: 2, screenX: 50, screenY: 30 });
  r.documentEvents.mousemove({ buttons: 1, screenX: 80, screenY: 50 });
  r.documentEvents.mouseup({ button: 0 });
  assert.equal(r.sent.filter((m) => m.key === 'dragStart').length, 2);
  assert.equal(r.sent.filter((m) => m.key === 'dragEnd').length, 2);
  assert.equal(r.run('holding'), null);
});

test('releasing another button does not terminate an ongoing left drag', () => {
  const r = rig();
  const wrap = r.element('pet-wrap');
  wrap.events.mousedown({ button: 0, pointerId: 1, screenX: 10, screenY: 10 });
  r.documentEvents.mousemove({ buttons: 1, screenX: 50, screenY: 30 });
  r.documentEvents.mouseup({ button: 1 });
  assert.equal(r.run('dragging'), true);
  wrap.events.pointercancel();
  assert.equal(r.run('dragging'), false);
  assert.equal(r.run('holding'), null);
});

test('a missed mouse release is repaired on the next movement and Ctrl double-click refreshes', () => {
  const r = rig();
  const wrap = r.element('pet-wrap');
  wrap.events.mousedown({ button: 0, screenX: 10, screenY: 10 });
  r.documentEvents.mousemove({ buttons: 1, screenX: 50, screenY: 30 });
  r.documentEvents.mousemove({ buttons: 0, screenX: 50, screenY: 30 });
  assert.equal(r.run('dragging'), false);
  assert.equal(r.run('press'), null);
  assert.equal(r.run('holding'), null);
  r.run('clickTimer = 42');
  wrap.events.mousedown({ button: 0, screenX: 10, screenY: 10 });
  r.documentEvents.mouseup({ button: 0, ctrlKey: true });
  assert.equal(r.sent.filter((m) => m.key === 'refresh').length, 1);
});

test('failed pointer capture cannot prevent the subsequent mouse drag or middle click', () => {
  const r = rig();
  const wrap = r.element('pet-wrap');
  wrap.setPointerCapture = () => { throw new Error('No active pointer'); };
  assert.doesNotThrow(() => wrap.events.pointerdown({ button: 0, pointerId: 9 }));
  wrap.events.mousedown({ button: 0, screenX: 10, screenY: 10 });
  r.documentEvents.mousemove({ buttons: 1, screenX: 50, screenY: 30 });
  assert.equal(r.run('dragging'), true);
  r.documentEvents.mouseup({ button: 0 });
  wrap.events.mousedown({ button: 1, clientX: 25, clientY: 30, preventDefault() {} });
  assert.ok(r.sent.some((m) => m.key === 'menu'));
});

test('sideways mode preserves the pet animation\'s own movement', () => {
  const r = rig();
  r.cursor(550, 50);
  r.frame();
  assert.ok(!r.state().follow);
  assert.equal(r.draws.at(-1).wantMove, true);
  r.run('player.onMove({ vx: 60, vy: 15 })');
  assert.equal(r.velocity().vx, 60);
  assert.equal(r.velocity().vy, 15);
});

test('diagonal pursuit keeps the same speed and retargets beyond the old movement duration', () => {
  const r = rig({ cursorFollowMode: 'all' });
  r.cursor(550, 550);
  r.frame();
  assert.ok(Math.abs(Math.hypot(r.velocity().vx, r.velocity().vy) - 60) < 1e-9);
  for (let i = 0; i < 60; i++) r.frame();
  r.cursor(-500, -500);
  r.frame();
  assert.ok(r.velocity().vx < 0 && r.velocity().vy < 0);
});

test('pursuit slows nearby, stops short, and does not restart inside its start radius', () => {
  const r = rig({ cursorFollowMode: 'all' });
  r.cursor(350, 50);
  r.frame();
  assert.equal(r.velocity().vx, 60);
  r.cursor(190, 50);
  r.frame();
  assert.equal(r.velocity().vx, 30);
  r.cursor(180, 50);
  r.frame();
  assert.equal(r.velocity(), null);
  r.cursor(200, 50);
  r.frame();
  assert.equal(r.state(), null);
});

test('taskbar containment ignores vertical distance; boundary feedback stops outward pursuit', () => {
  const r = rig({ cursorFollowMode: 'all', containment: 'taskbar' });
  r.cursor(50, -500);
  r.frame();
  assert.equal(r.state(), null);
  r.cursor(550, -500);
  r.frame();
  assert.equal(r.velocity().vx, 60);
  assert.equal(r.velocity().vy, 0);
  r.listeners.onMoveState({ blocked: { right: true } });
  r.frame();
  assert.equal(r.velocity(), null);
  r.cursor(-500, 50);
  r.frame();
  assert.equal(r.velocity().vx, -60, 'can leave a blocked boundary inward');
});

test('vertical boundaries allow steering along the edge without pushing out of bounds', () => {
  const r = rig({ cursorFollowMode: 'all' });
  r.cursor(550, -500);
  r.frame();
  r.listeners.onMoveState({ blocked: { top: true } });
  r.frame();
  assert.equal(r.velocity().vy, 0);
  assert.ok(r.velocity().vx > 0);
});

test('live behavior changes and agent activity stop continuous pursuit', () => {
  for (const patch of [
    { cursorFollowMode: 'sideways' }, { followCursor: false }, { wander: false }, { anchored: true }, { calm: true },
  ]) {
    const r = rig({ cursorFollowMode: 'all' });
    r.cursor(50, -500);
    r.frame();
    assert.ok(r.state()?.follow);
    r.set(patch);
    r.frame();
    assert.equal(r.state(), null, JSON.stringify(patch));
    assert.equal(r.velocity(), null);
  }
  const r = rig({ cursorFollowMode: 'all' });
  r.cursor(50, -500);
  r.frame();
  r.run("sessionStatus = 'working'");
  r.frame();
  assert.equal(r.velocity(), null);
});

test('following does not depend on eye tracking or the pet providing a walk animation', () => {
  const r = rig({ cursorFollowMode: 'all', trackCursor: false });
  r.run('delete manifest.animations.walk');
  r.cursor(50, 550);
  r.frame();
  assert.equal(r.state().key, 'idle');
  assert.equal(r.velocity().vy, 60);
});

test('crossing a vertical gap between monitors reports the correct blocked direction', () => {
  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const displays = [0, 200].map((y, id) => ({
    id, bounds: { x: 0, y, width: 100, height: 100 }, workArea: { x: 0, y, width: 100, height: 100 },
  }));
  for (const [y, vy, direction] of [[89, 60, 'bottom'], [191, -60, 'top']]) {
    const sent = [];
    const inst = store.newInstance('test.pet.js');
    inst.behavior.containment = 'all';
    const rt = {
      uid: inst.uid, anchor: { x: 20, y }, rect: { w: 20, h: 20 }, offset: { x: 0, y: 0 },
      vel: { vx: 0, vy }, moveTicks: 0, win: { webContents: { send: (...args) => sent.push(args) } },
    };
    const context = vm.createContext({
      require: (name) => name === 'electron' ? { screen: { getAllDisplays: () => displays } } : requireHost(name),
      module: { exports: {} }, process, console, fixture: { inst, rt },
    });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    vm.runInContext('stepMove(fixture.inst, fixture.rt, 0.05)', context);
    assert.equal(rt.anchor.y, y, 'pet stays on its current monitor');
    const state = sent.find(([channel]) => channel === 'move-state')[1];
    assert.equal(state.blocked[direction], true);
    assert.equal(state.blocked.right, undefined, 'vertical movement does not block horizontal steering');
  }
});

test('getting out of the way of text: huff, walk where the host steers, then hold still', () => {
  const r = rig({ followCursor: true, cursorFollowMode: 'all' });
  r.cursor(600, 600);
  r.listeners.onAvoid({ phase: 'notice', dir: 1, fast: false });
  r.frame();
  assert.equal(r.state(), null, 'no wandering or chasing while it reacts');
  assert.equal(r.run('timed && timed.key'), 'shoo');
  r.listeners.onAvoid({ phase: 'walk', dir: -1, fast: false });
  assert.equal(r.state().key, 'walk');
  assert.equal(r.state().host, true);
  assert.equal(r.run('dir'), -1);
  r.run('endMove()'); // something else stopped the legs
  r.frame();
  assert.equal(r.state().key, 'walk', 'the legs keep going until the host says it has arrived');
  r.listeners.onAvoid({ phase: 'park' });
  assert.equal(r.state(), null);
  r.frame();
  r.frame();
  assert.equal(r.state(), null, 'parked pets do not chase the cursor');
});

test('a left click calls a parked pet back and it resumes normal behaviour', () => {
  const r = rig({ followCursor: true, cursorFollowMode: 'all' });
  r.cursor(600, 600);
  r.listeners.onAvoid({ phase: 'park' });
  r.frame();
  assert.equal(r.state(), null);
  const wrap = r.element('pet-wrap');
  wrap.events.pointerdown({ button: 0, pointerId: 1, screenX: 10, screenY: 10 });
  assert.equal(r.sent.filter((m) => m.key === 'avoidCancel').length, 1);
  assert.equal(r.run('avoiding'), null);
  r.run('press = null; dragging = false;');
  r.frame();
  assert.ok(r.state(), 'chasing the cursor again');
});

test('a right click releases a parked pet too, and the host releasing it clears the hold', () => {
  const r = rig();
  r.listeners.onAvoid({ phase: 'park' });
  r.documentEvents.contextmenu({ preventDefault() {}, clientX: 5, target: { closest: (sel) => (sel === '#pet-wrap' ? {} : null) } });
  assert.equal(r.sent.filter((m) => m.key === 'avoidCancel').length, 1);
  assert.equal(r.run('avoiding'), null);
  r.listeners.onAvoid({ phase: 'park' });
  r.listeners.onAvoid({ phase: 'release', why: 'expired' });
  assert.equal(r.run('avoiding'), null);
  assert.equal(r.sent.filter((m) => m.key === 'avoidCancel').length, 1, 'a release from the host is not sent back');
});

test('a pet always says something when it starts moving out of the way, in its own voice', () => {
  const r = rig();
  r.run("manifest.lines = { dodge: ['Scooting!'], command: ['On my way!'], panic: ['Eek!'] };");
  r.listeners.onAvoid({ phase: 'notice', dir: 1, kind: 'typing', panic: false, ms: 900 });
  assert.equal(r.run('notice.text'), 'Scooting!');
  r.listeners.onAvoid({ phase: 'release' });
  r.listeners.onAvoid({ phase: 'notice', dir: 1, kind: 'phrase', panic: false, ms: 900 });
  assert.equal(r.run('notice.text'), 'On my way!');
  r.listeners.onAvoid({ phase: 'release' });
  r.listeners.onAvoid({ phase: 'notice', dir: 1, kind: 'phrase', panic: true, ms: 2400 });
  assert.equal(r.run('notice.text'), 'Eek!');
  assert.equal(r.run('timed.key'), 'held', 'panics before it bolts');
});

test('a retarget while already moving does not chatter, but a fresh move from parked does', () => {
  const r = rig();
  r.listeners.onAvoid({ phase: 'notice', dir: 1, kind: 'typing', ms: 900 });
  r.run('notice = null');
  r.listeners.onAvoid({ phase: 'walk', dir: 1, kind: 'typing' });
  assert.equal(r.run('notice'), null, 'the walk that follows the huff stays quiet');
  r.listeners.onAvoid({ phase: 'park' });
  r.listeners.onAvoid({ phase: 'walk', dir: -1, kind: 'typing' });
  assert.ok(r.run('notice && notice.text'), 'moving again from a parked spot speaks');
});
