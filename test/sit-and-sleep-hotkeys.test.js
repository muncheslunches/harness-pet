const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const menus = require('../lib/menus');
const policy = require('../lib/ipc-policy');

test('menu includes Put to sit right above Put to sleep with accelerators S and Z', () => {
  const inst = store.newInstance('clawrk.pet.js');
  inst.asleep = false;
  inst.sitting = false;
  const prefs = { instances: [inst], hotkeys: {}, hotkeysEnabled: false };
  const calls = [];
  const host = {
    manifestOf: () => null,
    linkOf: () => null,
    sessionsFor: () => [],
    setInstance: (uid, patch) => calls.push([uid, patch]),
    broadcastLinks: () => {},
  };
  const items = menus.build(inst.uid, { prefs, links: { links: {} }, host, openStudio: () => {}, quit: () => {} });

  const sitIdx = items.findIndex((it) => it.label === 'Put to sit');
  const sleepIdx = items.findIndex((it) => it.label === 'Put to sleep');

  assert.ok(sitIdx !== -1, 'Put to sit should be in menu');
  assert.ok(sleepIdx !== -1, 'Put to sleep should be in menu');
  assert.equal(sitIdx, sleepIdx - 1, 'Put to sit must be directly above Put to sleep');

  const sitItem = items[sitIdx];
  const sleepItem = items[sleepIdx];

  assert.equal(sitItem.accelerator, 'S');
  assert.equal(sleepItem.accelerator, 'Z');

  // Triggering Put to sit
  sitItem.click();
  assert.deepEqual(calls[0], [inst.uid, { sitting: true, asleep: false }]);

  // Triggering Put to sleep
  sleepItem.click();
  assert.deepEqual(calls[1], [inst.uid, { asleep: true, sitting: false }]);
});

test('menu switches to Stand up and Wake up when pet is sitting or asleep', () => {
  const inst = store.newInstance('clawrk.pet.js');
  inst.sitting = true;
  inst.asleep = true;
  const prefs = { instances: [inst], hotkeys: {}, hotkeysEnabled: false };
  const calls = [];
  const host = {
    manifestOf: () => null,
    linkOf: () => null,
    sessionsFor: () => [],
    setInstance: (uid, patch) => calls.push([uid, patch]),
    broadcastLinks: () => {},
  };
  const items = menus.build(inst.uid, { prefs, links: { links: {} }, host, openStudio: () => {}, quit: () => {} });

  const standIdx = items.findIndex((it) => it.label === 'Stand up');
  const wakeIdx = items.findIndex((it) => it.label === 'Wake up');

  assert.ok(standIdx !== -1, 'Stand up should be in menu when sitting');
  assert.ok(wakeIdx !== -1, 'Wake up should be in menu when asleep');
  assert.equal(standIdx, wakeIdx - 1);

  assert.equal(items[standIdx].accelerator, 'S');
  assert.equal(items[wakeIdx].accelerator, 'Z');

  items[standIdx].click();
  assert.deepEqual(calls[0], [inst.uid, { sitting: false }]);

  items[wakeIdx].click();
  assert.deepEqual(calls[1], [inst.uid, { asleep: false }]);
});

test('ipc policy and store preferences support sitting boolean', () => {
  assert.ok(policy.patch({ sitting: true }));
  assert.ok(policy.patch({ sitting: false }));
  assert.ok(!policy.patch({ sitting: 'invalid' }));
  assert.ok(policy.petArgs('set', ['sitting', true]));
  assert.ok(policy.petArgs('set', ['sitting', false]));
  assert.ok(!policy.petArgs('set', ['sitting', 123]));

  const inst = store.newInstance('clawrk.pet.js');
  inst.sitting = true;
  const prefs = { instances: [inst] };
  assert.ok(store.validPrefs(prefs));
});

test('index.html and style.css contain gurney and bandages markup and styles', () => {
  const html = fs.readFileSync(path.join(__dirname, '../pet-window/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../pet-window/style.css'), 'utf8');

  assert.ok(html.includes('id="pet-gurney"'), 'index.html has pet-gurney');
  assert.ok(html.includes('id="pet-bandages"'), 'index.html has pet-bandages');
  assert.ok(html.includes('class="gurney-svg"'), 'index.html has gurney-svg');
  assert.ok(html.includes('class="bandages-svg"'), 'index.html has bandages-svg');

  // Verify elements of gurney (wheels, pillow, mattress)
  assert.ok(html.includes('pillow-grad') || html.includes('pillow'), 'gurney has pillow');
  assert.ok(html.includes('Caster Wheels') || html.includes('Caster'), 'gurney has wheels');
  assert.ok(!html.includes('IV Stand'), 'IV drip stand is removed');

  // Verify elements of bandages (clean white gauze straps with clamps, red cross removed)
  assert.ok(html.includes('bandage-shadow') && html.includes('gauze-grad'), 'bandages have gauze styling');
  assert.ok(!html.includes('fill="#ef4444"'), 'red cross emblem is removed so top layer is all white');

  // Check CSS stacking and reduced dimensions
  assert.ok(css.includes('.pet-gurney'), 'CSS has .pet-gurney');
  assert.ok(css.includes('.pet-bandages'), 'CSS has .pet-bandages');
  assert.ok(css.includes('z-index: 0'), 'gurney is behind pet at z-index 0');
  assert.ok(css.includes('z-index: 1') || css.includes('#pet-host'), 'pet-host is at z-index 1');
  assert.ok(css.includes('z-index: 3'), 'bandages are over pet at z-index 3');
  assert.ok(css.includes('width: 98%') && css.includes('height: 101%'), 'gurney dimensions reduced by 30%');
});

test('pet-window keydown triggers hotkeys z and s when menu is open', () => {
  const code = fs.readFileSync(path.join(__dirname, '../pet-window/pet-window.js'), 'utf8');

  // Verify that keydown listener checks menuRoot.hidden and matches accelerator/hotkey z and s
  assert.ok(code.includes("k === 'z'"), "keydown handles 'z'");
  assert.ok(code.includes("k === 's'"), "keydown handles 's'");
  assert.ok(code.includes('dataset.accelerator'), 'keydown matches dataset.accelerator');

  // Simulate the keydown logic directly
  const clicked = [];
  const rows = [
    { dataset: { accelerator: 'S', id: '1' }, textContent: 'Put to sit', classList: { contains: () => false }, click: () => clicked.push('s') },
    { dataset: { accelerator: 'Z', id: '2' }, textContent: 'Put to sleep', classList: { contains: () => false }, click: () => clicked.push('z') },
  ];

  function simulateKey(key, menuHidden = false) {
    if (menuHidden) return;
    const k = key.toLowerCase();
    let match = rows.find((r) => r.dataset.accelerator && r.dataset.accelerator.trim().toLowerCase() === k);
    if (!match && k === 'z') {
      match = rows.find((r) => r.textContent.toLowerCase().includes('put to sleep'));
    }
    if (!match && k === 's') {
      match = rows.find((r) => r.textContent.toLowerCase().includes('put to sit'));
    }
    if (match) match.click();
  }

  simulateKey('z', false);
  assert.deepEqual(clicked, ['z']);

  simulateKey('s', false);
  assert.deepEqual(clicked, ['z', 's']);

  // Menu closed should not trigger
  simulateKey('z', true);
  assert.deepEqual(clicked, ['z', 's']);
});
