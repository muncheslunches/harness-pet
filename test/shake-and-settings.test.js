const test = require('node:test');
const assert = require('node:assert/strict');
const shake = require('../lib/shake');
const policy = require('../lib/ipc-policy');
const store = require('../lib/store');

// a drag that swings `amp` px left and right `swings` times, `ms` apart
function swing(s, { amp = 60, swings = 6, ms = 60, axis = 'x', t0 = 0 } = {}) {
  let hit = false;
  for (let i = 0; i <= swings; i++) {
    const v = i % 2 ? amp : 0;
    hit = s.feed(axis === 'x' ? 500 + v : 500, axis === 'y' ? 500 + v : 500, t0 + i * ms) || hit;
  }
  return hit;
}

test('a quick back-and-forth drag is a shake, sideways or up and down', () => {
  assert.equal(swing(shake.create()), true);
  assert.equal(swing(shake.create(), { axis: 'y' }), true);
});

test('an ordinary drag, small wiggles, or slow swings are not a shake', () => {
  const s = shake.create();
  let hit = false;
  for (let i = 0; i < 40; i++) hit = s.feed(100 + i * 20, 300 + i * 5, i * 16) || hit;
  assert.equal(hit, false, 'a straight drag');
  assert.equal(swing(shake.create(), { amp: 10 }), false, 'tiny jitter');
  assert.equal(swing(shake.create(), { ms: 600 }), false, 'slow swings');
});

test('one shake is reported once, then counting starts afresh', () => {
  const s = shake.create();
  const hits = [];
  for (let i = 0; i <= 6; i++) hits.push(s.feed(500 + (i % 2 ? 60 : 0), 500, i * 60));
  assert.equal(hits.filter(Boolean).length, 1);
});

test('pets report health and Studio sets general settings only in the expected shapes', () => {
  assert.equal(policy.petArgs('health', [{ event: 'alive', worker: true }]), true);
  assert.equal(policy.petArgs('health', [{ event: 'worker-failed', worker: false, message: 'Pet animation stopped responding.' }]), true);
  assert.equal(policy.petArgs('health', [{ event: 'anything' }]), false);
  assert.equal(policy.petArgs('health', [{ event: 'alive', worker: 'yes' }]), false);
  assert.equal(policy.petArgs('left', []), true);
  for (const key of ['muteAll', 'noDance', 'verboseLogging', 'watchKeyboard', 'startAtLogin']) assert.equal(policy.studioArgs('set-general', [key, true]), true, key);
  assert.equal(policy.studioArgs('set-general', ['instances', true]), false);
  assert.equal(policy.studioArgs('set-general', ['muteAll', 'on']), false);
});

test('"only show with its agent" settings are part of a pet\'s behaviour', () => {
  const b = store.newInstance('builtin:clawrk').behavior;
  assert.equal(b.showWithAgent, false);
  assert.equal(b.lingerMinutes, 2);
  assert.equal(b.smokeOnLeave, true);
  assert.equal(policy.patch({ behavior: { showWithAgent: true, lingerMinutes: 5, smokeOnLeave: false } }), true);
  assert.equal(policy.patch({ behavior: { showWithAgent: 'yes' } }), false);
  assert.equal(store.validPrefs({ instances: [], muteAll: true, noDance: false, verboseLogging: true }), true);
  assert.equal(store.validPrefs({ instances: [], muteAll: 'yes' }), false);
});
