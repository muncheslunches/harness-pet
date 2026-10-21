const test = require('node:test');
const assert = require('node:assert/strict');
const TextAvoid = require('../lib/text-avoid');
const { buildGrid } = require('../lib/text-map');

const PAPER = 240;
const INK = 30;
const W = 1000;
const H = 600;

function glyph(seed) {
  let s = seed * 2654435761 >>> 0;
  const bits = [];
  for (let i = 0; i < 35; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    bits.push((s >>> 16) % 100 < 55);
  }
  return bits;
}

// a screen with a column of text down the left 400 px
function screenGrid({ cover = 400 } = {}) {
  const gray = new Uint8Array(W * H).fill(PAPER);
  for (let line = 0; line < 40; line++) {
    for (let c = 0; c < Math.floor(cover / 7) - 2; c++) {
      if ((c + line) % 6 === 5) continue;
      const bits = glyph(line * 131 + c * 7 + 3);
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (bits[gy * 5 + gx]) gray[(10 + line * 14 + gy) * W + 10 + c * 7 + gx] = INK;
    }
  }
  return buildGrid(gray, W, H, { ox: 0, oy: 0, scale: 1 });
}

function rig({ pets, grid = screenGrid(), ctx = null, clock = { t: 1_000_000 } } = {}) {
  const display = { id: 1, bounds: { x: 0, y: 0, width: W, height: H }, workArea: { x: 0, y: 0, width: W, height: H } };
  const state = new Map(pets.map((p) => [p.uid, {
    uid: p.uid, rect: { x: p.x, y: p.y, w: 80, h: 80 }, display,
    bounds: { x0: 0, x1: W - 80, y0: 0, y1: H - 80 }, lockY: !!p.lockY, canMove: p.canMove !== false, avoidText: p.avoidText !== false, avoid: p.avoid || null,
  }]));
  const log = { sent: [], extended: [], hidden: [], scans: [] };
  const host = {
    avoidPets: () => [...state.values()],
    avoidSend: (uid, plan) => { log.sent.push({ uid, ...plan }); const s = state.get(uid); s.avoid = { kind: plan.kind, phase: 'park', until: plan.until }; s.rect = { ...s.rect, x: plan.x, y: plan.y }; },
    avoidExtend: (uid, until, kind) => log.extended.push({ uid, until, kind }),
    hideFromCapture: async (on) => { log.hidden.push(on); },
  };
  const timers = [];
  const engine = TextAvoid.create({
    host,
    scan: async (d, region) => { log.scans.push(region); return grid; },
    context: async () => ctx,
    now: () => clock.t,
    rand: () => 0.5,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
  });
  const fire = async () => { while (timers.length) timers.shift()(); await engine.idle(); };
  return { engine, host, log, state, fire, clock };
}

test('typing: a pet standing on text steps to a bare spot and holds there', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 200 }] });
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.sent.length, 1);
  const plan = r.log.sent[0];
  assert.equal(plan.kind, 'typing');
  assert.ok(plan.x > 350, `moved clear of the text column, x=${plan.x}`);
  assert.ok(plan.until >= r.clock.t + TextAvoid.TYPING_MIN);
  assert.deepEqual(r.log.hidden, [true, false], 'pets hidden from the screenshot, then shown again');
});

test('typing: a pet on bare ground is left alone', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 700, y: 200 }] });
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.sent.length, 0);
});

test('typing: pets that opted out stay put', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 200, avoidText: false }] });
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.scans.length, 0);
});

test('typing: a pet over a different window than the one you type in is ignored', async () => {
  const ctx = { caret: null, window: { x: 600, y: 0, w: 400, h: 600 } };
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 200 }], ctx });
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.sent.length, 0);
});

test('typing: the line about to be typed into counts even though it is still blank', async () => {
  const bare = screenGrid({ cover: 0 });
  const ctx = { caret: { x: 500, y: 300, w: 2, h: 18 }, window: { x: 0, y: 0, w: W, h: H } };
  const r = rig({ pets: [{ uid: 'a', x: 560, y: 290 }], grid: bare, ctx });
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.sent.length, 1);
  const zone = TextAvoid.caretZone(ctx.caret);
  const plan = r.log.sent[0];
  const hit = plan.x < zone.x + zone.w && plan.x + 80 > zone.x && plan.y < zone.y + zone.h && plan.y + 80 > zone.y;
  assert.equal(hit, false, 'the new spot is outside the caret zone');
});

test('typing: continued typing extends a parked pet instead of moving it again', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 700, y: 200, avoid: { kind: 'typing', phase: 'park', until: 0 } }] });
  r.clock.t += 5000;
  r.engine.typed();
  assert.deepEqual(r.log.extended.map((e) => e.until), [r.clock.t + TextAvoid.TYPING_HOLD]);
});

test('typing: a taskbar pet only moves along its line', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 520, lockY: true }] });
  r.state.get('a').bounds = { x0: 0, x1: W - 80, y0: 520, y1: 520 };
  r.engine.typed();
  await r.fire();
  assert.equal(r.log.sent.length, 1);
  assert.equal(r.log.sent[0].y, 520);
});

test('GO AWAY: every pet near text moves and holds for 30 s to 5 min', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 100 }, { uid: 'b', x: 300, y: 300 }, { uid: 'c', x: 800, y: 300 }] });
  await r.engine.phrase();
  assert.deepEqual(r.log.sent.map((s) => s.uid).sort(), ['a', 'b']);
  for (const s of r.log.sent) {
    assert.equal(s.kind, 'phrase');
    const hold = s.until - r.clock.t;
    assert.ok(hold >= TextAvoid.PHRASE_MIN && hold <= TextAvoid.PHRASE_MAX, `hold ${hold}`);
    assert.ok(s.x > 380);
  }
  const [a, b] = r.log.sent;
  const apart = a.x + 80 <= b.x || b.x + 80 <= a.x || a.y + 80 <= b.y || b.y + 80 <= a.y;
  assert.ok(apart, 'the two pets do not pile onto the same spot');
});

test('GO AWAY: ignores the per-pet typing switch but not calm or anchored pets', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 100, avoidText: false }, { uid: 'b', x: 100, y: 300, canMove: false }] });
  await r.engine.phrase();
  assert.deepEqual(r.log.sent.map((s) => s.uid), ['a']);
});

test('GO AWAY: a pet already waiting somewhere safe has its wait renewed as a command', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 800, y: 300, avoid: { kind: 'typing', phase: 'park', until: 5 } }] });
  await r.engine.phrase();
  assert.equal(r.log.sent.length, 0);
  assert.equal(r.log.extended.length, 1);
  assert.equal(r.log.extended[0].kind, 'phrase');
});

test('GO AWAY with nowhere bare: the pet goes to the emptiest place but panics about it', async () => {
  const gray = new Uint8Array(W * H).fill(PAPER);
  for (let line = 0; line < 42; line++) {
    for (let c = 0; c < 140; c++) {
      if ((c + line) % 6 === 5) continue;
      const bits = glyph(line * 131 + c * 7 + 3);
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (bits[gy * 5 + gx]) gray[(4 + line * 14 + gy) * W + 4 + c * 7 + gx] = INK;
    }
  }
  const r = rig({ pets: [{ uid: 'a', x: 300, y: 200 }], grid: buildGrid(gray, W, H) });
  await r.engine.phrase();
  assert.equal(r.log.sent.length, 1);
  assert.equal(r.log.sent[0].panic, true);
});

test('GO AWAY with a bare spot: no panic', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 100 }] });
  await r.engine.phrase();
  assert.equal(r.log.sent[0].panic, false);
});

test('GO AWAY keeps pets off the line you just typed on', async () => {
  const ctx = { caret: { x: 500, y: 300, w: 2, h: 18 }, window: { x: 0, y: 0, w: W, h: H } };
  // a patch of text so the pet has a reason to move; the caret's line is bare ground nearby
  const gray = new Uint8Array(W * H).fill(PAPER);
  for (let line = 0; line < 12; line++) for (let c = 0; c < 20; c++) {
    if ((c + line) % 6 === 5) continue;
    const bits = glyph(line * 131 + c * 7 + 3);
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (bits[gy * 5 + gx]) gray[(60 + line * 14 + gy) * W + 60 + c * 7 + gx] = INK;
  }
  const r2 = rig({ pets: [{ uid: 'a', x: 100, y: 100 }], grid: buildGrid(gray, W, H), ctx });
  await r2.engine.phrase();
  const zone = TextAvoid.caretZone(ctx.caret);
  const plan = r2.log.sent[0];
  assert.ok(plan);
  const hit = plan.x < zone.x + zone.w && plan.x + 80 > zone.x && plan.y < zone.y + zone.h && plan.y + 80 > zone.y;
  assert.equal(hit, false);
});

test('a pet that stands on the ground (lockY) never changes height, in either mode', async () => {
  const r = rig({ pets: [{ uid: 'a', x: 100, y: 250, lockY: true }] });
  r.state.get('a').bounds = { x0: 0, x1: W - 80, y0: 0, y1: H - 80 };
  await r.engine.phrase();
  assert.equal(r.log.sent[0].y, 250);
});
