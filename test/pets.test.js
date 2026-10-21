// Pet format: Clawrk validates, broken pets are rejected clearly, missing
// animations fall back sensibly, and custom animations are detected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('../scripts/validate-pet.js');
const Catalog = require('../shared/catalog.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pet-pets-'));
const write = (name, code) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, code);
  return f;
};

test('Clawrk has every standard animation and a custom one', () => {
  const r = check(path.join(__dirname, '..', 'pets', 'clawrk.pet.js'));
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepStrictEqual(r.manifest.missing, []);
  assert.deepStrictEqual(r.manifest.custom, ['scuttleSprint']);
  assert.strictEqual(r.manifest.animations.scuttleSprint.kind, 'movement');
  assert.strictEqual(r.manifest.animations.scuttleSprint.params.speed.default, 1.6);
});

test('a minimal pet is valid and lists what it is missing', () => {
  const r = check(write('tiny.pet.js', `definePet({ format: 1, id: 'tiny', name: 'Tiny', canvas: { width: 8, height: 8 }, animations: { idle: { draw(g) { g.rect(2, 2, 4, 4, '#fff'); } } } });`));
  assert.ok(r.ok, r.errors.join('\n'));
  assert.strictEqual(r.manifest.missing.length, Catalog.CATALOG.length - 1);
});

test('creation exclusions remain disabled even when an animation was included in the file', () => {
  const r = check(write('excluded.pet.js', `definePet({ format: 1, id: 'excluded', name: 'Excluded', canvas: { width: 8, height: 8 }, disabledAnimations: ['dig', 'sleep'], animations: {
    idle: { draw(g) { g.px(1, 1, '#fff'); } },
    dig: { draw(g) { g.px(1, 1, '#fff'); } },
    sleep: { draw(g) { g.px(1, 1, '#fff'); } },
  } });`));
  assert.ok(r.ok, r.errors.join('\n'));
  const Controls = require('../shared/pet-controls');
  const inst = { animOff: {} };
  assert.strictEqual(Controls.animationEnabled(inst, r.manifest, 'dig'), false);
  assert.strictEqual(Controls.animationEnabled(inst, r.manifest, 'sleep'), false);
  assert.strictEqual(Controls.animationEnabled(inst, r.manifest, 'idle'), true);
  assert.strictEqual(Controls.animationEnabled(inst, r.manifest, 'dance'), false);
  inst.animOff.dig = false;
  assert.strictEqual(Controls.animationEnabled(inst, r.manifest, 'dig'), true);
});

test('custom animations are detected with kind and params', () => {
  const r = check(write('bird.pet.js', `definePet({ format: 1, id: 'bird', name: 'Bird', canvas: { width: 16, height: 16 }, animations: {
    idle: { draw(g) { g.px(8, 8, '#4af'); } },
    zoomAround: { kind: 'movement', label: 'Zoom around', duration: 3000, params: { speed: { label: 'Speed', min: 0.5, max: 4, default: 2 } },
      move: (c) => ({ vx: c.dir * 200 * c.params.speed, vy: Math.sin(c.t / 200) * 50 }), draw(g, c) { g.px(8 + c.dir, 8, '#4af'); } },
  } });`));
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepStrictEqual(r.manifest.custom, ['zoomAround']);
  assert.strictEqual(r.manifest.animations.zoomAround.moves, true);
});

test('broken pets get clear errors', () => {
  assert.match(check(write('a.pet.js', 'const x = 1;')).errors.join(), /never called definePet/);
  assert.match(check(write('b.pet.js', `definePet({ format: 1, id: 'B!', name: '', canvas: { width: 2, height: 2 }, animations: {} });`)).errors.join(' | '), /id must be.*name is required.*canvas.*idle is required/);
  assert.match(check(write('c.pet.js', `definePet({ format: 1, id: 'cc', name: 'C', canvas: { width: 8, height: 8 }, animations: { idle: { draw() { throw new Error('boom'); } } } });`)).errors.join(), /idle failed while drawing: boom/);
  assert.match(check(write('d.pet.js', `definePet({ format: 1, id: 'dd', name: 'D', canvas: { width: 8, height: 8 }, animations: { idle: { draw(g) { g.px(1,1,'#fff'); } }, fly: { kind: 'movement', duration: 1000, draw() {} } } });`)).errors.join(), /movement animations need move/);
});

test('fallbacks: missing animations resolve to something sensible', () => {
  const have = { idle: true, hover: true };
  assert.deepStrictEqual(Catalog.resolve('held', have), { key: 'idle', effect: 'shake' });
  assert.deepStrictEqual(Catalog.resolve('poke', have), { key: 'hover', effect: 'hop' });
  assert.deepStrictEqual(Catalog.resolve('hover', have), { key: 'hover', effect: null });
  assert.strictEqual(Catalog.resolve('bubbles', have), null, 'tricks are skipped, not faked');
});
