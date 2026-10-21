// Finds where text is on a screenshot, and where a pet can stand without covering it.
//
// Text is recognised by its texture rather than by reading it: a small cell of the
// screen counts as text when it has sharp edges in both directions (letter strokes),
// which long borders, flat colour and smooth gradients do not. That works the same in
// every app, light or dark, which no per-app text API does.
//
// Everything here is plain arrays, so it is tested without Electron. Rectangles in
// the public functions are in screen DIPs; a grid remembers where its image sits.

const CELL = 12; // image pixels per cell (at most 16)
const EDGE = 30; // grey-level jump that counts as an edge
const MIN_X = 0.05; // share of pixels with a left-right edge a text cell needs (vertical strokes)
const MIN_Y = 0.03; // ... and with an up-down edge (horizontal strokes)
const MAX_BOTH = 0.85; // busier than this is noise or a photo, still worth avoiding but not as text
const MIN_COLUMNS = 3; // letters have several vertical strokes; the corner of a box has one edge
const MIN_ROWS = 2;

// Electron's NativeImage.toBitmap() on Windows is BGRA.
function grayFromBitmap(bgra, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (bgra[p] * 29 + bgra[p + 1] * 150 + bgra[p + 2] * 77) >> 8;
  return out;
}

// gray: w×h greys. origin: where the image's top-left sits on screen (DIPs).
// scale: image pixels per DIP.
function buildGrid(gray, w, h, { cell = CELL, edge = EDGE, ox = 0, oy = 0, scale = 1 } = {}) {
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const ex = new Uint16Array(cols * rows);
  const ey = new Uint16Array(cols * rows);
  const exColumns = new Uint16Array(cols * rows); // which of the cell's columns / rows hold an edge
  const eyRows = new Uint16Array(cols * rows);
  for (let y = 0; y < h - 1; y++) {
    const rowCell = ((y / cell) | 0) * cols;
    const base = y * w;
    for (let x = 0; x < w - 1; x++) {
      const g = gray[base + x];
      const c = rowCell + ((x / cell) | 0);
      if (Math.abs(gray[base + x + 1] - g) > edge) { ex[c]++; exColumns[c] |= 1 << (x % cell); }
      if (Math.abs(gray[base + w + x] - g) > edge) { ey[c]++; eyRows[c] |= 1 << (y % cell); }
    }
  }
  const text = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const ch = Math.min(cell, h - r * cell);
    for (let c = 0; c < cols; c++) {
      const area = Math.min(cell, w - c * cell) * ch;
      if (area < cell * 2) continue; // a sliver at the image edge says nothing
      const i = r * cols + c;
      const fx = ex[i] / area;
      const fy = ey[i] / area;
      text[i] = fx >= MIN_X && fy >= MIN_Y && fx + fy <= MAX_BOTH && bits(exColumns[i]) >= MIN_COLUMNS && bits(eyRows[i]) >= MIN_ROWS ? 1 : 0;
    }
  }
  return withSums({ cell, cols, rows, text, ox, oy, scale, w, h });
}

function bits(n) {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
}

// summed-area table so any rectangle of cells is counted in four reads
function withSums(grid) {
  const { cols, rows, text } = grid;
  const stride = cols + 1;
  const sum = new Int32Array(stride * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += text[r * cols + c];
      sum[(r + 1) * stride + c + 1] = sum[r * stride + c + 1] + run;
    }
  }
  grid.sum = sum;
  return grid;
}

// text cells touching the rectangle (DIPs); anything outside the image counts as empty
function countText(grid, rect) {
  const k = grid.scale / grid.cell;
  const c0 = Math.max(0, Math.floor((rect.x - grid.ox) * k));
  const r0 = Math.max(0, Math.floor((rect.y - grid.oy) * k));
  const c1 = Math.min(grid.cols, Math.ceil((rect.x + rect.w - grid.ox) * k));
  const r1 = Math.min(grid.rows, Math.ceil((rect.y + rect.h - grid.oy) * k));
  if (c1 <= c0 || r1 <= r0) return 0;
  const s = grid.cols + 1;
  return grid.sum[r1 * s + c1] - grid.sum[r0 * s + c1] - grid.sum[r1 * s + c0] + grid.sum[r0 * s + c0];
}

const grow = (r, pad) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
const meets = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// Is the pet standing on (or right beside) text?
function isOnText(grid, rect, { pad = 14, minCells = 2 } = {}) {
  return countText(grid, grow(rect, pad)) >= minCells;
}

// The nearest top-left position for a pet of `rect`'s size that is clear of text.
//   bounds   { x0, x1, y0, y1 }: where its top-left may go
//   blocked  rectangles to stay out of (other pets, the area about to be typed into)
//   lockY    walk along a line only (pets that stand on the ground or the taskbar)
//   pads     how much room around the pet must be bare, tried in order: a roomy margin first,
//            then a tight one, so a pet only settles close to text when nothing else is free
// Returns { x, y, clear: true }, or when nowhere is bare, the place with the least text
// { x, y, clear: false } (the pet should be frantic about it), or null if every place is blocked.
function pickClearSpot(grid, { rect, bounds, blocked = [], pad = 14, pads = [pad], minCells = 2, lockY = false, step = 16 }) {
  const xs = ladder(bounds.x0, bounds.x1, step);
  const ys = lockY ? [Math.min(Math.max(rect.y, bounds.y0), bounds.y1)] : ladder(bounds.y0, bounds.y1, step);
  const here = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const keepOut = blocked.map((b) => grow(b, 8));
  const free = (at) => !keepOut.some((b) => meets(at, b));
  const distance = (x, y) => Math.hypot(x + rect.w / 2 - here.x, (y + rect.h / 2 - here.y) * 1.4);

  for (const margin of pads) {
    let best = null;
    for (const y of ys) {
      for (const x of xs) {
        const at = { x, y, w: rect.w, h: rect.h };
        if (countText(grid, grow(at, margin)) >= minCells || !free(at)) continue;
        let cost = distance(x, y);
        if (best && cost >= best.cost) continue;
        cost += pathPenalty(grid, rect, at);
        if (!best || cost < best.cost) best = { x, y, cost };
      }
    }
    if (best) return { x: best.x, y: best.y, clear: true };
  }

  // nowhere is bare: the least covered place, nearest first
  const tight = pads[pads.length - 1];
  let least = null;
  for (const y of ys) {
    for (const x of xs) {
      const at = { x, y, w: rect.w, h: rect.h };
      if (!free(at)) continue;
      const count = countText(grid, grow(at, tight));
      const cost = distance(x, y);
      if (!least || count < least.count || (count === least.count && cost < least.cost)) least = { x, y, count, cost };
    }
  }
  return least ? { x: least.x, y: least.y, clear: false } : null;
}

// walking there should not drag the pet across lines of text on the way
function pathPenalty(grid, from, to) {
  let hits = 0;
  const inner = (r) => ({ x: r.x + r.w * 0.25, y: r.y + r.h * 0.25, w: r.w * 0.5, h: r.h * 0.5 });
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const at = inner({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, w: from.w, h: from.h });
    if (countText(grid, at) >= 2) hits++;
  }
  return hits * 60;
}

function ladder(a, b, step) {
  if (b < a) return [a];
  const out = [];
  for (let v = a; v < b; v += step) out.push(v);
  out.push(b);
  return out;
}

module.exports = { grayFromBitmap, buildGrid, countText, isOnText, pickClearSpot, grow, meets, CELL };
