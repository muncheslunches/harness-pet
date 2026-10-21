const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const store = require('../lib/store');

function rig(positions) {
  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const instances = positions.map(() => store.newInstance('test.pet.js'));
  const messages = positions.map(() => []);
  const runtimes = positions.map((x, i) => ({
    uid: instances[i].uid, ready: true, mode: 'idle',
    anchoredOffset: () => ({ x: 0, y: 0 }),
    anchor: { x, y: 0 }, offset: { x: 0, y: 0 }, rect: { x: 0, y: 0, w: 100, h: 100 },
    manifest: { animations: { dance: { enabled: true } } },
    win: { isDestroyed: () => false, isVisible: () => true,
      getPosition: () => [x, 0], webContents: { send: (...args) => messages[i].push(args) } },
  }));
  let clock = 1000;
  const context = vm.createContext({
    require: (name) => name === 'electron' ? {} : requireHost(name),
    module: { exports: {} }, process, console,
    Date: { now: () => clock }, fixture: { instances, runtimes },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext('ctx = { prefs: { instances: fixture.instances } }; for (const rt of fixture.runtimes) live.set(rt.uid, rt)', context);
  return { instances, runtimes, messages,
    start: (i, duration = 3000) => vm.runInContext(`startDance(fixture.instances[${i}].uid, ${duration})`, context),
    advance: (ms) => { clock += ms; },
  };
}

test('dance spreads from left through the middle to the right, leaving distant pets alone', () => {
  const r = rig([0, 210, 420, 1000]);
  assert.equal(r.start(0), true);
  assert.equal(r.messages[1][0][0], 'dance');
  assert.equal(r.messages[2][0][0], 'dance', 'right pet joins through the middle');
  assert.equal(r.messages[2][0][1].duration, 3000);
  assert.equal(r.messages[3].length, 0);
  assert.equal(r.start(1), false, 'a follower cannot start another sound or cascade');
  assert.equal(r.messages[2].length, 1, 'followers only receive one invitation');
});

test('simultaneous separate dances have one sound owner, including the sound tail', () => {
  const r = rig([0, 1000, 2000]);
  assert.equal(r.start(0), true);
  assert.equal(r.start(1), false);
  r.advance(3500);
  assert.equal(r.start(2), false, 'previous audio tail still owns the sound');
  r.advance(4000);
  assert.equal(r.start(0), true, 'a later dance can have sound again');
});

test('group dance respects animation, visibility, sleep, social, calm and busy settings', () => {
  const cases = [
    (i) => { i.asleep = true; },
    (i) => { i.visible = false; },
    (i) => { i.disabledUntil = -1; },
    (i) => { i.disabledUntil = 5000; },
    (i) => { i.behavior.social = false; },
    (i) => { i.behavior.calm = true; },
    (i) => { i.animOff.dance = true; },
    (_, rt) => { rt.mode = 'working'; },
    (_, rt) => { rt.hold = 'menu'; },
    (_, rt) => { rt.fall = {}; },
    (_, rt) => { rt.avoid = {}; },
    (_, rt) => { delete rt.manifest.animations.dance; },
  ];
  for (const change of cases) {
    const r = rig([0, 210, 420]);
    change(r.instances[1], r.runtimes[1]);
    r.start(0);
    assert.equal(r.messages[1].length, 0, change.toString());
    assert.equal(r.messages[2].length, 0, 'excluded pets do not relay the dance');
  }
});
