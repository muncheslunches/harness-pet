const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const store = require('../lib/store');
const Controls = require('../shared/pet-controls');
const options = require('../lib/instance-options');
const menus = require('../lib/menus');
const prompts = require('../lib/prompts');
function trustedEvent(wc) {
  wc.mainFrame ||= { url: require('url').pathToFileURL(path.join(__dirname, '../pet-window/index.html')).href };
  return { sender: wc, senderFrame: wc.mainFrame };
}

test('bubble minimization is automatic and preserves the preference when buttons return', () => {
  const inst = store.newInstance('test.pet.js');
  inst.buttons = [null, null];
  assert.equal(Controls.bubbleMode(inst), 'mini');
  inst.buttons[1] = 1;
  assert.equal(Controls.bubbleMode(inst), 'expanded');
  inst.barMode = 'off';
  assert.equal(Controls.bubbleMode(inst), 'off');
  inst.buttons = [null, null];
  assert.equal(Controls.bubbleMode(inst), 'off');
});

test('experimental duplicates have independent settings and retain their original owner', () => {
  const original = store.newInstance('test.pet.js');
  original.pos = { x: 200, y: 200 };
  const dup = options.duplicate(original);
  const next = options.duplicate(dup);
  assert.notEqual(dup.uid, original.uid);
  assert.notEqual(dup.uid, next.uid);
  assert.equal(dup.experimentalDuplicate, true);
  assert.equal(next.duplicateOf, original.uid);
  dup.behavior.speed = 3;
  dup.buttons[0] = null;
  assert.equal(original.behavior.speed, 1);
  assert.equal(original.buttons[0], 0);
  assert.equal(original.experimentalDuplicate, undefined);
});

function hostRig() {
  let clock = 100000;
  const handlers = {};
  // stands in for the PowerShell window helper (lib/helper.js)
  const helperCalls = [];
  const helper = {
    foregroundHwnd: '111',
    foreground() { helperCalls.push(['foreground']); return Promise.resolve(this.foregroundHwnd); },
    refocus(hwnd, from) { helperCalls.push(['refocus', hwnd, from]); return Promise.resolve('ok refocus done'); },
    focus() { return Promise.resolve('ok'); }, clickButton() { return Promise.resolve('ok'); }, wheel() { return Promise.resolve('ok'); },
  };
  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const context = vm.createContext({
    module: { exports: {} }, __dirname: path.dirname(file), process, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return clock; } },
    setInterval() { return 1; }, clearInterval() {},
    require: (name) => name === 'electron' ? {
      ipcMain: { on: (key, fn) => { handlers[key] = fn; }, handle: (key, fn) => { handlers[key] = fn; } },
      screen: {
        getCursorScreenPoint: () => ({ x: 500, y: 500 }),
        getDisplayNearestPoint: () => ({ id: 1, workArea: { x: -1000, y: -1000, width: 3000, height: 2000 } }),
        getAllDisplays: () => [{ id: 1, workArea: { x: -1000, y: -1000, width: 3000, height: 2000 }, bounds: { x: -1000, y: -1000, width: 3000, height: 2000 } }],
      },
    } : name === './helper' ? helper : requireHost(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { context, handlers, helper, helperCalls, run: (code) => vm.runInContext(code, context), advance: (ms) => { clock += ms; } };
}

test('duplicates get increasing species numbers, including duplicates of duplicates', () => {
  const source = store.newInstance('bird.pet.js');
  const first = options.duplicate(source, [source]);
  const second = options.duplicate(first, [source, first]);
  assert.equal(Controls.petName(source, { name: 'Birdie' }), 'Birdie');
  assert.equal(Controls.petName(first, { name: 'Birdie' }), 'Birdie 2');
  assert.equal(Controls.petName(second, { name: 'Birdie' }), 'Birdie 3');
  assert.equal(options.duplicate(store.newInstance('sun.pet.js'), [source, first, second]).instanceNumber, 2);
  const oldCopies = [source, { ...first, instanceNumber: undefined }, { ...second, instanceNumber: undefined }];
  options.numberDuplicates(oldCopies);
  assert.deepEqual(oldCopies.map((i) => i.instanceNumber || 1), [1, 2, 3]);
});

test('an open menu catches only its panels and pet, never the transparent window', () => {
  const r = hostRig();
  r.context.inst = store.newInstance('bird.pet.js');
  r.context.runtime = { menuOpen: true, hold: 'menu', ignoring: true, hits: [
    { x: 10, y: 10, w: 50, h: 50 }, { x: 100, y: 100, w: 100, h: 200, menu: true },
  ] };
  assert.equal(r.run('wantsMouse(inst, runtime, { x: 500, y: 500 }, { x: 0, y: 0 })'), false);
  assert.equal(r.run('wantsMouse(inst, runtime, { x: 20, y: 20 }, { x: 0, y: 0 })'), true);
  r.context.inst.clickThrough = true;
  assert.equal(r.run('wantsMouse(inst, runtime, { x: 20, y: 20 }, { x: 0, y: 0 })'), false);
  assert.equal(r.run('wantsMouse(inst, runtime, { x: 120, y: 120 }, { x: 0, y: 0 })'), true);
  r.context.runtime.menuOpen = false;
  assert.equal(r.run('wantsMouse(inst, runtime, { x: 120, y: 120 }, { x: 0, y: 0 })'), false);
});

test('switching pet menus releases the previous window and blur closes the new one', () => {
  const r = hostRig();
  const messages = [];
  const instances = [store.newInstance('clawrk.pet.js'), store.newInstance('sun.pet.js')];
  r.context.instances = instances;
  const runtimes = instances.map((inst) => ({ uid: inst.uid, hits: [], ignoring: true,
    menuHandlers: new Map(), win: { isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 900, height: 900 }),
      setIgnoreMouseEvents() {}, setFocusable(on) { this.focusable = on; }, focus() {},
      isFocused: () => false, isAlwaysOnTop: () => true, setAlwaysOnTop() {},
      getNativeWindowHandle: () => Buffer.alloc(8),
      webContents: { send: (...args) => messages.push([inst.uid, ...args]) } } }));
  r.context.runtimes = runtimes;
  r.run(`ctx = { prefs: { instances }, menuFor: () => [{ label: 'Test', click() {} }] };
    instances.forEach((inst, n) => live.set(inst.uid, runtimes[n])); wireIpc();`);
  const event = (n) => trustedEvent(runtimes[n].win.webContents);
  r.handlers['pet:menu'](event(0));
  assert.equal(runtimes[0].menuOpen, true);
  r.handlers['pet:menu'](event(1));
  assert.equal(runtimes[0].menuOpen, false);
  assert.equal(runtimes[0].win.focusable, false);
  assert.equal(runtimes[1].menuOpen, true);
  assert.ok(messages.find(([uid, channel]) => uid === instances[0].uid && channel === 'menu-close'));
  r.run('closePetMenu(runtimes[1])');
  assert.equal(runtimes[1].win.focusable, false);
  r.handlers['pet:menu'](event(0));
  r.handlers['pet:interaction'](event(1));
  assert.equal(runtimes[0].menuOpen, false, 'clicking another nonfocusable pet also closes the menu');
});

test('a popup dismissed inside the pet hands focus back to the app it took it from', async () => {
  const r = hostRig();
  const inst = store.newInstance('clawrk.pet.js');
  r.context.instances = [inst];
  const hwnd = Buffer.alloc(8);
  hwnd.writeBigUInt64LE(222n);
  const log = [];
  const rt = { uid: inst.uid, hits: [], ignoring: true, menuHandlers: new Map(), win: {
    focused: false, onTop: true, focusable: false,
    isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 900, height: 900 }),
    setIgnoreMouseEvents() {}, getNativeWindowHandle: () => hwnd,
    setFocusable(on) { this.focusable = on; log.push(['focusable', on, this.onTop]); },
    focus() { this.focused = true; log.push(['focus']); }, isFocused() { return this.focused; },
    isAlwaysOnTop() { return this.onTop; }, setAlwaysOnTop(on) { this.onTop = on; },
    webContents: { send() {} } } };
  r.context.rt = rt;
  r.run(`ctx = { prefs: { instances }, menuFor: () => [{ label: 'Test', click() {} }] };
    live.set(rt.uid, rt); wireIpc();`);
  const event = trustedEvent(rt.win.webContents);
  const settle = () => new Promise((done) => setImmediate(done));

  r.handlers['pet:menu'](event);
  assert.equal(rt.win.focusable, true);
  await settle();
  assert.deepEqual(r.helperCalls, [['foreground']], 'asks who had focus before taking it');
  assert.ok(log.some(([k]) => k === 'focus'));
  r.handlers['pet:menu-closed'](event); // Escape, an item or a click on the pet
  await settle();
  assert.deepEqual(r.helperCalls[1], ['refocus', '111', '222']);
  assert.equal(rt.win.focusable, false);
  assert.deepEqual(log.at(-1), ['focusable', false, false], 'drops focus outside the topmost band');
  assert.equal(rt.win.onTop, true);

  // blur: the user clicked into another app, so focus stays where they put it
  r.helperCalls.length = 0;
  r.handlers['pet:menu'](event);
  await settle();
  rt.win.focused = false;
  r.run('closePetMenu(rt)');
  await settle();
  assert.deepEqual(r.helperCalls, [['foreground']]);
  assert.equal(rt.win.focusable, false);

  // the remembered window is never another pet
  r.helper.foregroundHwnd = '222';
  r.handlers['pet:menu'](event);
  await settle();
  r.handlers['pet:menu-closed'](event);
  await settle();
  assert.ok(!r.helperCalls.some(([k]) => k === 'refocus'));
});

test('pet IPC rejects foreign frames and malformed actions before mutating host state', () => {
  const r = hostRig();
  const inst = store.newInstance('builtin:clawrk');
  const wc = {};
  const rt = { uid: inst.uid, win: { isDestroyed: () => false, webContents: wc }, menuHandlers: new Map() };
  r.context.instances = [inst]; r.context.runtime = rt;
  r.run('ctx = { prefs: { instances }, save() { throw new Error("must not save"); } }; live.set(instances[0].uid, runtime); wireIpc()');
  const event = trustedEvent(wc);
  r.handlers['pet:set']({ sender: wc }, 'asleep', true);
  r.handlers['pet:set']({ sender: wc, senderFrame: { ...wc.mainFrame } }, 'asleep', true);
  r.handlers['pet:set'](event, 'uid', 'other');
  r.handlers['pet:set'](event, 'pet', 'C:\\private.pet.js');
  r.handlers['pet:action'](event, 'button', null);
  r.handlers['pet:rect'](event, { x: 0, y: 0, w: Infinity, h: 10, winW: 10, winH: 10 });
  assert.equal(inst.asleep, false); assert.equal(inst.pet, 'builtin:clawrk');
  assert.equal(rt.ready, undefined);
});

test('pass-through pets do not collide in either direction, including drops', () => {
  const r = hostRig();
  const one = store.newInstance('bird.pet.js');
  const two = store.newInstance('clawrk.pet.js');
  const rt = (uid, x) => ({ uid, ready: true, anchor: { x, y: 100 }, rect: { w: 100, h: 100 },
    anchoredOffset: () => ({ x: 0, y: 0 }), win: { isVisible: () => true } });
  r.context.instances = [one, two];
  r.context.one = rt(one.uid, 100);
  r.context.two = rt(two.uid, 140);
  r.run('ctx = { prefs: { instances } }; live.set(instances[0].uid, one); live.set(instances[1].uid, two)');
  assert.ok(r.run('overlapsOther(one.uid, petScreen(one))'));
  one.behavior.passThroughPets = true;
  assert.equal(r.run('overlapsOther(one.uid, petScreen(one))'), null);
  assert.equal(r.run('overlapsOther(two.uid, petScreen(two))'), null);
  r.run('resolveDropOverlap(instances[0], one); resolveDropOverlap(instances[1], two)');
  assert.equal(r.context.one.push, undefined);
  assert.equal(r.context.two.push, undefined);
  one.behavior.passThroughPets = false;
  assert.ok(r.run('overlapsOther(two.uid, petScreen(two))'));
});

test('window movement normalizes rounded negative zero before calling Electron', () => {
  const r = hostRig();
  let position;
  r.context.runtime = { anchor: { x: -0.2, y: -0.4 }, rect: { x: 0, y: 0, w: 56, h: 64 },
    anchoredOffset: () => ({ x: 0, y: 0 }), win: { isDestroyed: () => false, webContents: { send() {} },
      setPosition(x, y) { assert.ok(!Object.is(x, -0)); assert.ok(!Object.is(y, -0)); position = [x, y]; } } };
  r.run('positionWindow(runtime)');
  assert.deepEqual(position, [0, 0]);
});

test('a hidden pet becomes ready from its first rect even if setSize emits no resize event', () => {
  const r = hostRig();
  const inst = store.newInstance('bird.pet.js');
  let shown = false;
  let size = [900, 900];
  const sizes = [];
  const wc = { send() {} };
  r.context.instances = [inst];
  r.context.runtime = { ready: false, anchor: { x: 200, y: 200 }, rect: { x: 0, y: 0, w: 56, h: 64 },
    anchoredOffset: () => ({ x: 0, y: 0 }), win: { isDestroyed: () => false, isVisible: () => shown, webContents: wc,
      getSize: () => size, setSize(w, h) { size = [w, h]; sizes.push(`${w}x${h}`); }, setPosition() {}, showInactive() { shown = true; } } };
  r.run('ctx = { prefs: { instances }, save() {} }; live.set(instances[0].uid, runtime); wireIpc()');
  r.handlers['pet:rect'](trustedEvent(wc), { x: 398, y: 360, w: 56, h: 64, winW: 852, winH: 824 });
  assert.equal(shown, true);
  assert.equal(r.context.runtime.ready, true);
  // sized for the pet, then nudged once after showing so Chromium re-shows its input window
  assert.deepEqual(sizes, ['852x824', '853x824', '852x824']);
});

test('a failed falling tick tells the renderer to release its stuck movement state', () => {
  const r = hostRig();
  const inst = store.newInstance('bird.pet.js');
  const messages = [];
  r.context.instances = [inst];
  r.context.runtime = { ready: true, anchor: { x: 0, y: 0 }, fall: { vy: 20 },
    win: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } } };
  r.run(`ctx = { prefs: { instances } }; live.set(instances[0].uid, runtime);
    stepFall = () => { throw Error('window positioning failed'); }; console = { error() {} }; tick();`);
  assert.equal(r.context.runtime.fall, null);
  assert.equal(r.context.runtime.vel, null);
  assert.ok(messages.some(([channel]) => channel === 'recover-motion'));
});

test('split placement avoids existing pets and reserves destinations for simultaneous copies', () => {
  const r = hostRig();
  const inst = store.newInstance('bird.pet.js');
  const runtime = (x, y) => ({ ready: true, homeDisplay: 1, rect: { w: 56, h: 64 }, anchor: { x, y },
    anchoredOffset: () => ({ x: 0, y: 0 }), win: { isVisible: () => true, isDestroyed: () => false } });
  r.context.source = runtime(200, 200);
  r.context.copy = runtime(200, 200);
  r.context.inst = inst;
  r.run("live.set('source', source); live.set('copy', copy)");
  const first = r.run('duplicateTarget(inst, copy, source.anchor)');
  assert.ok(Math.abs(first.x - 200) >= 56 || Math.abs(first.y - 200) >= 64);
  r.context.reserved = runtime(first.x, first.y);
  r.context.reserved.split = { to: first };
  r.run("live.set('reserved', reserved)");
  const second = r.run('duplicateTarget(inst, copy, source.anchor)');
  assert.ok(first.x !== second.x || first.y !== second.y);
});

test('three successive collisions pause retries for ten seconds, then accept movement again', () => {
  const r = hostRig();
  const messages = [];
  const runtime = (uid, x) => ({
    uid, anchor: { x, y: 0 }, rect: { w: 100, h: 100 }, anchoredOffset: () => ({ x: 0, y: 0 }),
    ready: true, bumpCooldown: new Map(), win: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
  });
  r.context.me = runtime('one', 0);
  r.context.hit = { uid: 'two', rt: runtime('two', 80), rect: { x: 80, y: 0, w: 100, h: 100 } };
  r.run("ctx = { prefs: { instances: [] } }; live.set('one', me); wireIpc(); bumpInto('one', me, hit)");
  assert.equal(r.context.me.collisionUntil, undefined);
  r.advance(500);
  r.run("bumpInto('one', me, hit)");
  assert.equal(r.context.me.collisionUntil, undefined);
  r.advance(500);
  r.run("bumpInto('one', me, hit)");
  assert.equal(r.context.me.collisionUntil, 111000);
  assert.equal(messages.filter(([key]) => key === 'move-state').at(-1)[1].retryAfter, 111000);
  const event = trustedEvent(r.context.me.win.webContents);
  r.handlers['pet:vel'](event, { vx: 60, vy: 0 });
  assert.equal(r.context.me.vel, null);
  r.advance(10001);
  r.handlers['pet:vel'](event, { vx: 60, vy: 0 });
  assert.equal(r.context.me.vel.vx, 60);
});

test('dismiss all duplicates leaves every original instance in place', () => {
  const r = hostRig();
  const one = store.newInstance('one.pet.js');
  const two = store.newInstance('two.pet.js');
  r.context.instances = [one, options.duplicate(one), two, options.duplicate(two)];
  r.run('ctx = { prefs: { instances }, save() {}, onChange() {} }');
  assert.equal(r.run('removeDuplicates()'), 2);
  assert.deepEqual(Array.from(r.run('ctx.prefs.instances'), (i) => i.uid), [one.uid, two.uid]);
});

test('dismissal saves pet options before removing the instance', () => {
  const r = hostRig();
  const inst = store.newInstance('bird.pet.js');
  inst.animOff.dig = true;
  inst.behavior.followCursor = true;
  inst.size = 4;
  r.context.instances = [inst];
  r.run('ctx = { prefs: { instances }, save() {}, onChange() {} }; removeInstance(instances[0].uid)');
  assert.equal(r.run('ctx.prefs.instances.length'), 0);
  assert.equal(r.run("ctx.prefs.petSettings['bird.pet.js'].animOff.dig"), true);
  assert.equal(r.run("ctx.prefs.petSettings['bird.pet.js'].behavior.followCursor"), true);
  assert.equal(r.run("ctx.prefs.petSettings['bird.pet.js'].size"), 4);
});

test('host accepts the entire size range and clamps values outside it', () => {
  const r = hostRig();
  const inst = store.newInstance('bird.pet.js');
  r.context.instances = [inst];
  r.run('ctx = { prefs: { instances }, save() {}, onChange() {} }');
  for (const [input, expected] of [[0.25, 0.25], [4, 4], [0.1, 0.25], [5, 4]]) {
    r.run(`setInstance(instances[0].uid, { size: ${input} })`);
    assert.equal(inst.size, expected);
  }
});

test('collision direction handles vertical approaches and allows moving away', () => {
  const r = hostRig();
  r.context.pet = { x: 100, y: 100, w: 100, h: 100 };
  r.context.hit = { rect: { x: 100, y: 180, w: 100, h: 100 } };
  assert.equal(r.run('approaching(pet, hit, 0, 3)'), true);
  assert.equal(r.run('approaching(pet, hit, 0, -3)'), false);
  assert.equal(r.run('approaching(pet, hit, 3, 0)'), false);
});

test('disabling a hotkey unregisters it without losing its combo', () => {
  const registered = new Set();
  const file = path.join(__dirname, '../lib/hotkeys.js');
  const context = vm.createContext({
    module: { exports: {} }, require: () => ({ globalShortcut: {
      unregisterAll: () => registered.clear(), register: (combo) => { registered.add(combo); return true; },
    } }),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const hotkeys = context.module.exports;
  const prefs = { hotkeysEnabled: true, hotkeys: { ...store.DEFAULT_HOTKEYS }, hotkeysDisabled: { mute: true } };
  assert.equal(hotkeys.apply(prefs, {}).mute, 'off');
  assert.ok(!registered.has(prefs.hotkeys.mute));
  assert.equal(prefs.hotkeys.mute, store.DEFAULT_HOTKEYS.mute);
  prefs.hotkeysDisabled.mute = false;
  assert.equal(hotkeys.apply(prefs, {}).mute, 'ok');
  assert.ok(registered.has(prefs.hotkeys.mute));
});

test('custom sounds can be muted and mixed independently of animation volume', () => {
  const inst = store.newInstance('test.pet.js');
  const manifest = { animations: { done: { sound: 'fairyChime' } } };
  inst.sound.anims.done = { volume: 0.8 };
  inst.sound.custom = { fairyChime: { on: false, volume: 0.5 } };
  assert.deepEqual(menus.soundFor(inst, manifest, 'done'), { sound: 'fairyChime', on: false, volume: 0.4 });
  inst.sound.custom.fairyChime.on = true;
  assert.equal(menus.soundFor(inst, manifest, 'done').on, true);
});

test('custom sound prompts name the active pet file and end with comma-separated requests', () => {
  const prompt = prompts.addSounds({ file: 'C:/pets/bird.pet.js', manifest: { name: 'Birdie' }, requests: 'fairy bell, tiny cheer' }, 'C:/node/node.exe');
  assert.ok(prompt.includes('Add custom sounds to Birdie'));
  assert.ok(prompt.includes('C:/pets/bird.pet.js'));
  assert.ok(prompt.includes('single definePet'));
  assert.ok(prompt.includes('validate-pet.js'));
  assert.ok(prompt.trimEnd().endsWith('fairy bell, tiny cheer'));
});
