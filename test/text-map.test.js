const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGrid, countText, isOnText, pickClearSpot, grayFromBitmap } = require('../lib/text-map');

const PAPER = 240;
const INK = 30;

function image(w, h) {
  return { w, h, gray: new Uint8Array(w * h).fill(PAPER) };
}

// seeded 5x7 glyphs: not real letters, but stroke-like in both directions
function glyph(seed) {
  let s = seed * 2654435761 >>> 0;
  const bits = [];
  for (let i = 0; i < 35; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    bits.push((s >>> 16) % 100 < 55);
  }
  return bits;
}

function drawText(img, x0, y0, cols, lines) {
  for (let line = 0; line < lines; line++) {
    for (let c = 0; c < cols; c++) {
      if ((c + line) % 6 === 5) continue; // word gaps
      const bits = glyph(line * 131 + c * 7 + 3);
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (bits[gy * 5 + gx]) img.gray[(y0 + line * 14 + gy) * img.w + x0 + c * 7 + gx] = INK;
        }
      }
    }
  }
}

const grid = (img, opts) => buildGrid(img.gray, img.w, img.h, opts);

test('a blank screen has no text', () => {
  const g = grid(image(600, 300));
  assert.equal(countText(g, { x: 0, y: 0, w: 600, h: 300 }), 0);
});

test('text is found where it is and not far from it', () => {
  const img = image(600, 300);
  drawText(img, 40, 40, 30, 5); // 210 x 70 px block
  const g = grid(img);
  assert.ok(countText(g, { x: 40, y: 40, w: 210, h: 70 }) > 30);
  assert.equal(countText(g, { x: 330, y: 0, w: 270, h: 300 }), 0);
  assert.equal(countText(g, { x: 0, y: 160, w: 600, h: 140 }), 0);
});

test('borders, flat fills and gradients are not text', () => {
  const img = image(600, 300);
  for (let x = 20; x < 580; x++) img.gray[100 * img.w + x] = INK; // a 1 px rule
  for (let y = 150; y < 250; y++) for (let x = 20; x < 300; x++) img.gray[y * img.w + x] = 90; // a panel
  for (let y = 0; y < 300; y++) for (let x = 320; x < 580; x++) if (y > 150) img.gray[y * img.w + x] = Math.round(((x - 320) / 260) * 200);
  const g = grid(img);
  assert.equal(countText(g, { x: 0, y: 0, w: 600, h: 300 }), 0);
});

test('isOnText reports a pet standing on text', () => {
  const img = image(600, 300);
  drawText(img, 40, 40, 30, 5);
  const g = grid(img);
  assert.equal(isOnText(g, { x: 80, y: 50, w: 60, h: 50 }), true);
  assert.equal(isOnText(g, { x: 400, y: 100, w: 60, h: 50 }), false);
});

test('the grid honours the image origin and scale', () => {
  const img = image(300, 150);
  drawText(img, 20, 20, 15, 4);
  const g = grid(img, { ox: 1000, oy: 500, scale: 2 }); // image is a 2x capture of a 150x75 DIP area
  assert.ok(countText(g, { x: 1010, y: 510, w: 60, h: 30 }) > 5);
  assert.equal(countText(g, { x: 0, y: 0, w: 900, h: 400 }), 0, 'elsewhere on the desktop is empty');
});

test('pickClearSpot walks to the nearest clear place', () => {
  const img = image(800, 400);
  drawText(img, 10, 10, 55, 28); // covers the left half, full height
  const g = grid(img);
  const rect = { x: 100, y: 150, w: 80, h: 80 };
  assert.equal(isOnText(g, rect), true);
  const spot = pickClearSpot(g, { rect, bounds: { x0: 0, x1: 720, y0: 0, y1: 320 } });
  assert.ok(spot);
  assert.equal(isOnText(g, { ...spot, w: 80, h: 80 }), false);
  assert.ok(spot.x > 300, `went right, to x=${spot.x}`);
});

test('pickClearSpot keeps out of blocked areas', () => {
  const img = image(800, 400);
  drawText(img, 10, 10, 55, 28);
  const g = grid(img);
  const rect = { x: 100, y: 150, w: 80, h: 80 };
  const blocked = [{ x: 380, y: 0, w: 200, h: 400 }]; // e.g. where the caret is about to type
  const spot = pickClearSpot(g, { rect, bounds: { x0: 0, x1: 720, y0: 0, y1: 320 }, blocked });
  assert.ok(spot);
  assert.ok(spot.x >= 580 + 8 - 1, `stays right of the blocked area, x=${spot.x}`);
});

test('a pet on a line only moves along it', () => {
  const img = image(800, 400);
  drawText(img, 10, 10, 55, 28);
  const g = grid(img);
  const rect = { x: 100, y: 300, w: 80, h: 80 };
  const spot = pickClearSpot(g, { rect, bounds: { x0: 0, x1: 720, y0: 300, y1: 300 }, lockY: true });
  assert.ok(spot);
  assert.equal(spot.y, 300);
});

test('with nowhere bare it settles on the emptiest place and says so', () => {
  const img = image(400, 300);
  drawText(img, 4, 4, 56, 21);
  for (let y = 200; y < 296; y++) for (let x = 250; x < 396; x++) img.gray[y * img.w + x] = PAPER; // a lightly covered patch
  drawText(img, 300, 240, 3, 1); // one short word in it
  const g = grid(img);
  const spot = pickClearSpot(g, { rect: { x: 20, y: 20, w: 80, h: 80 }, bounds: { x0: 0, x1: 320, y0: 0, y1: 220 } });
  assert.ok(spot);
  assert.equal(spot.clear, false);
  assert.ok(spot.x > 150 && spot.y > 100, `heads for the emptier corner, got ${spot.x},${spot.y}`);
});

test('a roomy margin is preferred, a tight one still counts as clear', () => {
  const img = image(800, 300);
  drawText(img, 10, 10, 20, 20); // text on the left
  drawText(img, 420, 10, 3, 1); // a short word further right
  const g = grid(img);
  const rect = { x: 20, y: 120, w: 80, h: 80 };
  const bounds = { x0: 0, x1: 720, y0: 0, y1: 220 };
  const roomy = pickClearSpot(g, { rect, bounds, pads: [60, 14] });
  assert.equal(roomy.clear, true);
  const tight = pickClearSpot(g, { rect, bounds: { x0: 150, x1: 460, y0: 0, y1: 220 }, pads: [200, 14] });
  assert.equal(tight.clear, true, 'nothing roomy fits, but a tighter margin is still bare');
});

test('every place blocked gives null', () => {
  const g = grid(image(400, 300));
  const spot = pickClearSpot(g, { rect: { x: 100, y: 100, w: 80, h: 80 }, bounds: { x0: 0, x1: 320, y0: 0, y1: 220 }, blocked: [{ x: -50, y: -50, w: 600, h: 500 }] });
  assert.equal(spot, null);
});

test('grayFromBitmap reads BGRA', () => {
  const px = Uint8Array.from([0, 0, 255, 255, 255, 255, 255, 255]); // red, white
  const out = grayFromBitmap(px, 2, 1);
  assert.ok(out[0] > 60 && out[0] < 90);
  assert.ok(out[1] >= 254);
});
