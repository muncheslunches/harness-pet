// The soak has to be able to fail: a report that prints PASS whatever it measured proves nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verdict, WARMUP_MS } = require('../scripts/smoke-soak');

const run = (mb, extra = {}) => Array.from({ length: 30 }, (_, i) => ({ at: WARMUP_MS + i * 5000, privateMb: mb(i), renderers: 5, processes: 9, ...extra }));

test('steady memory passes, wobble included', () => {
  const result = verdict(run((i) => 400 + (i % 2 ? 12 : -12)), { renderers: 5 });
  assert.deepEqual(result.problems, []);
  assert.equal(result.pass, true);
});

test('memory that keeps growing fails', () => {
  const result = verdict(run((i) => 400 + i * 5), { renderers: 5 });
  assert.equal(result.pass, false);
  assert.match(result.problems.join(), /grew/);
});

test('a climb during warm-up does not count, one after it does', () => {
  const samples = run(() => 400);
  samples.unshift({ at: 5000, privateMb: 150, renderers: 5, processes: 9 });
  assert.equal(verdict(samples, { renderers: 5 }).pass, true);
  samples.push(...Array.from({ length: 15 }, (_, i) => ({ at: WARMUP_MS + (30 + i) * 5000, privateMb: 600, renderers: 5, processes: 9 })));
  assert.equal(verdict(samples, { renderers: 5 }).pass, false);
});

test('a soak that barely ran, or lost its pets or the app, fails', () => {
  assert.equal(verdict(run(() => 400).slice(0, 3), { renderers: 5 }).pass, false);
  assert.match(verdict(run(() => 400, { renderers: 2 }), { renderers: 5 }).problems.join(), /renderers/);
  assert.match(verdict(run(() => 400, { processes: 0 }), { renderers: 5 }).problems.join(), /stopped/);
});
