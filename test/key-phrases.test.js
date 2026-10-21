const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhraseMatcher } = require('../lib/key-phrases');

function rig() {
  const fired = [];
  let pending = null;
  const m = createPhraseMatcher({
    onMatch: (p) => fired.push(p),
    setTimer: (fn) => (pending = fn),
    clearTimer: () => (pending = null),
  });
  const press = (vk, extra = {}) => m.key({ vk, caps: true, shift: false, ctrl: false, alt: false, win: false, ...extra });
  const type = (text, extra) => { for (const ch of text) press(ch === ' ' ? 0x20 : ch.charCodeAt(0), extra); };
  const settle = () => { const fn = pending; pending = null; if (fn) fn(); };
  return { fired, press, type, settle, pending: () => !!pending };
}

test('a capital phrase fires once typing pauses', () => {
  const r = rig();
  r.type('GO AWAY');
  assert.deepEqual(r.fired, []);
  r.settle();
  assert.deepEqual(r.fired, ['GO AWAY']);
});

test('each trigger phrase is recognised', () => {
  for (const phrase of ['GO AWAY', 'GET OUT', 'MOVE']) {
    const r = rig();
    r.type(phrase);
    r.settle();
    assert.deepEqual(r.fired, [phrase]);
  }
});

test('a space or Enter after the phrase fires it immediately', () => {
  const r = rig();
  r.type('MOVE');
  r.press(0x20);
  assert.deepEqual(r.fired, ['MOVE']);
  const s = rig();
  s.type('GET OUT');
  s.press(0x0d);
  assert.deepEqual(s.fired, ['GET OUT']);
});

test('the phrase must be a whole word', () => {
  const r = rig();
  r.type('MOVEMENT');
  r.settle();
  r.type(' REMOVE');
  r.settle();
  assert.deepEqual(r.fired, []);
});

test('typing on after the phrase cancels it', () => {
  const r = rig();
  r.type('MOVE');
  r.press('S'.charCodeAt(0));
  r.settle();
  assert.deepEqual(r.fired, []);
});

test('it can sit inside a longer capital sentence', () => {
  const r = rig();
  r.type('PLEASE GO AWAY');
  r.settle();
  assert.deepEqual(r.fired, ['GO AWAY']);
});

test('backspace edits the buffer', () => {
  const r = rig();
  r.type('MOVEX');
  r.press(0x08);
  r.settle();
  assert.deepEqual(r.fired, ['MOVE']);
});

test('without Caps Lock, or with Shift held, nothing counts', () => {
  const r = rig();
  r.type('GO AWAY', { caps: false });
  r.settle();
  r.type('GO AWAY', { shift: true });
  r.settle();
  assert.deepEqual(r.fired, []);
});

test('shortcuts and other keys reset the buffer', () => {
  const r = rig();
  r.type('GO ');
  r.press('A'.charCodeAt(0), { ctrl: true });
  r.type('AWAY');
  r.settle();
  assert.deepEqual(r.fired, []);
  r.type('MO');
  r.press(0x31); // the 1 key
  r.type('VE');
  r.settle();
  assert.deepEqual(r.fired, []);
});

test('pressing Shift or Caps Lock between letters does not break the phrase', () => {
  const r = rig();
  r.type('GO');
  r.press(0x10);
  r.type(' AWAY');
  r.settle();
  assert.deepEqual(r.fired, ['GO AWAY']);
});

test('it can fire again afterwards', () => {
  const r = rig();
  r.type('MOVE');
  r.settle();
  r.type('MOVE');
  r.settle();
  assert.deepEqual(r.fired, ['MOVE', 'MOVE']);
});
