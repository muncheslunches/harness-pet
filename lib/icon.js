// The Harness Pet icon: an ornate gilded cage with no animal inside,
// drawn as 32×32 pixel art and scaled with nearest-neighbour to any size.

const COLORS = {
  o: [74, 46, 16, 255], // dark bronze outline
  b: [224, 168, 58, 255], // brass / warm gold
  h: [247, 214, 128, 255], // light gold highlight
  s: [168, 114, 32, 255], // shade / antique gold
  w: [255, 250, 225, 255], // gilded gleam / luster
};

function grid() {
  const N = 32;
  const g = Array.from({ length: N }, () => Array(N).fill(null));
  const set = (x, y, k) => {
    if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = k;
  };

  // Golden hanging ring with dark bronze outline and bright gold gleam
  for (const [x, y] of [
    [14, 1], [15, 1], [16, 1], [17, 1],
    [13, 2], [18, 2],
    [13, 3], [18, 3],
    [14, 4], [17, 4],
    [15, 5], [16, 5],
    [15, 6], [16, 6],
  ]) {
    set(x, y, 'o');
  }
  set(15, 1, 'w'); set(16, 1, 'h');
  set(15, 5, 'h'); set(16, 5, 'b');
  set(15, 6, 'w'); set(16, 6, 'h');

  // Dome (top half of ellipse)
  for (let y = 7; y <= 14; y++) {
    for (let x = 3; x <= 28; x++) {
      const d = ((x - 15.5) / 12.5) ** 2 + ((y - 14.5) / 7.5) ** 2;
      if (d <= 1.05 && d > 0.6) {
        if (d > 0.82) {
          set(x, y, 'o');
        } else if (y < 10) {
          set(x, y, (x === 14 || x === 15) && y === 8 ? 'w' : 'h');
        } else {
          set(x, y, 'b');
        }
      }
    }
  }

  // Finial connector into dome apex
  set(15, 7, 'w'); set(16, 7, 'h');

  // 5 Vertical bars (empty gilded cage, continuous to base):
  // Left-to-right cylindrical lighting:
  const bars = [
    [8, 'h'],
    [12, 'h'],
    [15, 'h'],
    [16, 'b'],
    [19, 'b'],
    [23, 's'],
  ];
  for (const [x, col] of bars) {
    for (let y = 7; y <= 25; y++) {
      const d = ((x - 15.5) / 12.5) ** 2 + ((y - 14.5) / 7.5) ** 2;
      if (y >= 14 || d <= 0.82) {
        set(x, y, col);
      }
    }
  }

  // Gleam at middle band crossing
  set(15, 16, 'w');

  // Outer upright posts
  for (const x of [4, 27]) {
    for (let y = 13; y <= 25; y++) set(x, y, 'o');
  }

  // Middle horizontal band
  for (let x = 4; x <= 27; x++) {
    if (x === 4 || x === 27) {
      set(x, 16, 'o');
    } else if (x === 13 || x === 14) {
      set(x, 16, 'w');
    } else if (x > 20) {
      set(x, 16, 'b');
    } else {
      set(x, 16, 'h');
    }
  }

  // Base
  for (let y = 26; y <= 29; y++) {
    for (let x = 2; x <= 29; x++) {
      const edge = y === 29 || x === 2 || x === 29 || (y === 26 && (x < 4 || x > 27));
      if (edge) {
        set(x, y, 'o');
      } else if (y === 26) {
        set(x, y, 'b');
      } else if (y === 27) {
        set(x, y, x >= 10 && x <= 16 ? 'w' : 'h');
      } else if (y === 28) {
        set(x, y, 's');
      }
    }
  }
  set(2, 26, null);
  set(29, 26, null);
  return g;
}

// RGBA (or BGRA for Electron's createFromBitmap) pixels at `size`×`size`.
function pixels(size, { bgra = false } = {}) {
  const g = grid();
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = g[Math.floor((y * 32) / size)][Math.floor((x * 32) / size)];
      if (!k) continue;
      const [r, gg, b, a] = COLORS[k];
      const i = (y * size + x) * 4;
      buf[i] = bgra ? b : r;
      buf[i + 1] = gg;
      buf[i + 2] = bgra ? r : b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

// Minimal PNG encoder (for writing assets/icon.png).
function png(size) {
  const zlib = require('zlib');
  const raw = pixels(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { pixels, png };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  for (const s of [256, 64, 32]) fs.writeFileSync(path.join(out, `icon-${s}.png`), png(s));
  fs.copyFileSync(path.join(out, 'icon-256.png'), path.join(out, 'icon.png'));
  console.log('wrote assets/icon*.png');
}
