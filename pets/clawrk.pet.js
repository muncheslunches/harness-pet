// Clawrk — the default Harness Pet. A pixel crab, drawn entirely in code.
// Grid: 22 × 22 pet pixels. Rows 0–3 are headroom for hops and effects; the
// crab's body sits on rows 10–17 and its legs touch the ground at row 19.

const W = 22;
const TOP = 4; // headroom offset added to every sprite row
const GROUND = 16; // sprite row of the sand line used when digging

const C = {
  body: '#D97757', light: '#E9A084', shade: '#B5603F', eye: '#1E1D1B',
  fx: '#F4C25B', fxSoft: '#F7E2B0', think: '#EDE6DA', sweat: '#8FD3FF',
  bubble: '#BFE7FF', sand: '#D9B27C', sandDark: '#B98F5A', dust: '#CFC8BC',
  blush: '#F2A0A0', heart: '#F27D8E', cap: '#7FB8E6', capDark: '#5E97C7', capWhite: '#F4F7FA',
  pebble: '#9AA0A6', note: '#EDE6DA', angry: '#1E1D1B',
};

const mirror = (pts) => pts.map(([x, y]) => [W - 1 - x, y]);
const both = (pts) => pts.concat(mirror(pts));
const step = (t, ms, n) => Math.floor(t / ms) % n;
const fx = (cells, color) => cells.map(([x, y]) => [x, y, color]);
const sparkle = (cx, cy) => fx([[cx, cy - 1], [cx - 1, cy], [cx, cy], [cx + 1, cy], [cx, cy + 1]], C.fx);
const heart = (x, y) => fx([[x, y], [x + 2, y], [x, y + 1], [x + 1, y + 1], [x + 2, y + 1], [x + 1, y + 2]], C.heart);
const note = (x, y) => fx([[x + 1, y], [x + 2, y], [x + 1, y + 1], [x + 1, y + 2], [x, y + 3], [x + 1, y + 3]], C.note);
// A proper Z: full top and bottom rows joined by a diagonal.
const Z = [[0, 0], [1, 0], [2, 0], [3, 0], [2, 1], [1, 2], [0, 3], [1, 3], [2, 3], [3, 3]];

function bodyCells(wide = 0) {
  const cells = [];
  const x0 = 5 - wide;
  const x1 = 16 + wide;
  for (let y = 6; y <= 13; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x === x0 || x === x1) && (y === 6 || y === 13)) continue;
      const color = y === 6 || (y === 7 && (x === x0 || x === x1)) ? C.light : y === 13 ? C.shade : C.body;
      cells.push([x, y, color]);
    }
  }
  return cells;
}
const BODY = bodyCells(0);
const BODY_PUFFED = bodyCells(1);

const CLAW = {
  rest: [[4, 10], [3, 10], [2, 9], [3, 9], [1, 8], [2, 8], [3, 8], [1, 6], [1, 7], [3, 6], [3, 7]],
  mid: [[4, 10], [3, 9], [2, 8], [3, 8], [1, 7], [2, 7], [3, 7], [1, 5], [1, 6], [3, 5], [3, 6]],
  up: [[4, 9], [3, 8], [2, 7], [3, 7], [1, 6], [2, 6], [3, 6], [1, 4], [1, 5], [3, 4], [3, 5]],
  upClosed: [[4, 9], [3, 8], [2, 7], [3, 7], [1, 6], [2, 6], [3, 6], [1, 5], [2, 5], [3, 5], [2, 4]],
  closed: [[4, 10], [3, 10], [2, 9], [3, 9], [1, 8], [2, 8], [3, 8], [1, 7], [2, 7], [3, 7], [2, 6]],
  tucked: [[4, 10], [4, 11], [3, 11], [3, 10], [3, 9]],
};
// arms: [left pose, right pose]
const ARMS = {
  rest: ['rest', 'rest'], mid: ['mid', 'mid'], up: ['up', 'up'], upClosed: ['upClosed', 'upClosed'],
  pinchA: ['closed', 'closed'], pinchB: ['rest', 'rest'], tucked: ['tucked', 'tucked'],
  waveR: ['rest', 'up'], waveR2: ['rest', 'mid'], waveL: ['up', 'rest'], waveL2: ['mid', 'rest'],
  leftUp: ['up', 'rest'], rightUp: ['rest', 'up'],
};
function armCells(name) {
  const [l, r] = ARMS[name] || ARMS.rest;
  return CLAW[l].concat(mirror(CLAW[r]));
}

const LEGS = {
  stand: [6, 8, 13, 15].flatMap((x) => [[x, 14], [x, 15]]),
  stepA: [[6, 14], [8, 14], [8, 15], [13, 14], [15, 14], [15, 15]],
  stepB: [[6, 14], [6, 15], [8, 14], [13, 14], [13, 15], [15, 14]],
  tuck: [6, 8, 13, 15].map((x) => [x, 14]),
  dangleA: [[6, 14], [5, 15], [5, 16], [8, 14], [8, 15], [8, 16], [13, 14], [13, 15], [13, 16], [15, 14], [16, 15], [16, 16]],
  dangleB: [[6, 14], [6, 15], [6, 16], [8, 14], [9, 15], [9, 16], [13, 14], [12, 15], [12, 16], [15, 14], [15, 15], [15, 16]],
};

const EYES = {
  open: both([[8, 8], [8, 9]]),
  blink: both([[7, 9], [8, 9]]),
  closed: both([[7, 9], [8, 9], [9, 9]]),
  up: both([[8, 7], [8, 8]]),
  side: [[9, 8], [9, 9], [14, 8], [14, 9]],
  wide: both([[7, 8], [8, 8], [7, 9], [8, 9]]),
  happy: both([[7, 9], [8, 8], [9, 9]]),
  panic: both([[7, 8], [8, 9], [7, 10]]), // > <
  dizzy: both([[7, 8], [9, 8], [8, 9], [7, 10], [9, 10]]), // x x
  angry: both([[8, 9], [9, 9]]),
};

// ---- the sleeping cap: light blue with a white band and pom-pom, drooping right ----
const CAP = fx([[6, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [12, 5], [13, 5], [14, 5], [15, 5]], C.capWhite)
  .concat(fx([[7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [9, 3], [10, 3], [11, 3], [12, 3], [13, 3], [14, 3], [12, 2], [13, 2], [14, 2], [15, 2], [15, 3], [16, 3]], C.cap))
  .concat(fx([[8, 4], [10, 3], [13, 2]], C.capDark))
  .concat(fx([[17, 3], [18, 3], [17, 4], [18, 4]], C.capWhite));

// ---- frame building ----

function base() {
  return { arms: 'rest', legs: 'stand', eyes: 'open', dy: 0, dx: 0, fx: [], over: [], clip: false, sink: false, lift: 0, puffed: false, cap: null, eyeShift: null, mouth: null, brows: false };
}

function lookShift(c) {
  return { x: Math.max(-1, Math.min(1, Math.round(c.look.x))), y: c.look.y < -0.5 ? -1 : 0 };
}

const POSES = {
  idle(t, c) {
    const f = base();
    f.dy = step(t, 700, 2);
    if (t % 4200 > 4000) f.eyes = 'blink';
    f.eyeShift = lookShift(c);
    return f;
  },
  thinking(t) {
    const f = base();
    f.eyes = step(t, 1600, 2) ? 'up' : 'side';
    f.dy = step(t, 500, 2);
    f.over = [[8, 1], [11, 1], [14, 1]].slice(0, step(t, 350, 4)).flatMap(([x, y]) => fx([[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]], C.think));
    return f;
  },
  working(t) {
    const f = base();
    const s = step(t, 140, 2);
    f.legs = s ? 'stepA' : 'stepB';
    f.arms = step(t, 280, 2) ? 'pinchA' : 'pinchB';
    f.dy = s;
    f.eyes = t % 3000 > 2850 ? 'blink' : 'open';
    if (s) f.over = fx([[0, 5], [21, 5], [0, 12], [21, 12]], C.fxSoft);
    return f;
  },
  needsYou(t) {
    const f = base();
    const hop = [0, -2, -4, -4, -2, 0, 0, 0, 0, 0][step(t, 70, 10)];
    f.dy = hop;
    f.eyes = 'wide';
    f.arms = hop < 0 ? 'up' : 'rest';
    f.legs = hop < 0 ? 'tuck' : 'stand';
    f.over = fx([-4, -3, -2, -1, 1].flatMap((y) => [[10, y], [11, y]]), C.fx);
    return f;
  },
  done(t) {
    const f = base();
    const dancing = t < 3200;
    f.dx = dancing ? [0, 1, 0, -1][step(t, 180, 4)] : 0;
    f.dy = dancing ? [0, -1][step(t, 180, 2)] : 0;
    f.legs = dancing ? (step(t, 180, 2) ? 'stepA' : 'stepB') : 'stand';
    f.eyes = 'happy';
    f.arms = dancing ? (step(t, 360, 2) ? 'up' : 'upClosed') : 'rest';
    f.over = step(t, 250, 2) ? sparkle(2, 1).concat(sparkle(19, -1)) : sparkle(18, 2).concat(sparkle(4, -1));
    return f;
  },
  held(t) {
    const f = base();
    f.legs = step(t, 70, 2) ? 'dangleA' : 'dangleB';
    f.arms = step(t, 90, 2) ? 'up' : 'upClosed';
    f.eyes = 'panic';
    f.dx = step(t, 80, 2) ? 1 : -1;
    f.dy = -1;
    f.lift = 4;
    const drop = step(t, 110, 4);
    f.over = fx([[4, 3 + drop], [17, 2 + ((drop + 2) % 4)]], C.sweat);
    return f;
  },
  fall(t) {
    const f = base();
    f.legs = step(t, 60, 2) ? 'dangleA' : 'dangleB';
    f.arms = 'up';
    f.eyes = 'wide';
    f.lift = 6;
    const k = step(t, 80, 3);
    f.over = fx([[5, 1 + k], [5, 2 + k], [16, k], [16, 1 + k], [11, 2 + k]], C.fxSoft);
    return f;
  },
  land(t) {
    const f = base();
    f.dy = [-2, 0, 0, -1, 0, 0][Math.min(5, Math.floor(t / 110))];
    f.legs = t < 220 ? 'tuck' : 'stand';
    f.eyes = t < 160 ? 'blink' : 'open';
    if (t < 450) {
      const s = Math.floor(t / 150);
      f.over = fx([[3 - s, 15], [2 - s, 14], [18 + s, 15], [19 + s, 14]], C.dust);
    }
    return f;
  },
  hover(t) {
    const f = base();
    f.arms = step(t, 220, 2) ? 'waveR' : 'waveR2';
    f.eyes = 'happy';
    return f;
  },
  poke(t) {
    // ticklish giggle
    const f = base();
    f.eyes = 'happy';
    f.dy = [0, -1, 0, -1, 0, -2, 0][step(t, 90, 7)];
    f.dx = step(t, 120, 2) ? 1 : 0;
    f.arms = step(t, 180, 2) ? 'pinchA' : 'tucked';
    f.over = heart(15, -1 - Math.floor(t / 300)).concat(fx([[6, 14], [15, 14]], C.blush));
    return f;
  },
  grow(t) {
    const f = base();
    f.puffed = true;
    f.eyes = 'happy';
    f.arms = step(t, 150, 2) ? 'up' : 'upClosed';
    f.dy = [0, -1, -2, -1][step(t, 110, 4)];
    f.over = sparkle(3, 2).concat(sparkle(18, 0)).concat(fx([[6, 14], [15, 14]], C.blush));
    return f;
  },
  shrink(t) {
    const f = base();
    f.arms = 'tucked';
    f.legs = 'tuck';
    f.eyes = 'wide';
    f.dx = step(t, 60, 2) ? 1 : -1;
    f.over = fx([[4, 4 + step(t, 120, 4)], [17, 5 + step(t + 200, 120, 4)]], C.sweat);
    return f;
  },
  wake(t) {
    const f = base();
    if (t < 450) {
      f.eyes = 'closed';
      f.arms = 'up';
      f.dy = -1;
      f.cap = { dx: 0, dy: 0 };
    } else {
      f.eyes = t < 700 ? 'blink' : 'open';
      // the nightcap flies off to the upper right
      const k = Math.floor((t - 450) / 60);
      if (k < 10) f.cap = { dx: k, dy: -k };
    }
    return f;
  },
  sleep(t) {
    const f = base();
    f.eyes = 'closed';
    f.legs = 'tuck';
    f.dy = step(t, 900, 2);
    f.cap = { dx: 0, dy: 0 };
    for (let i = 0; i < 2; i++) {
      const age = (t + i * 1300) % 2600;
      const rise = Math.floor(age / 520);
      f.over.push(...fx(Z.map(([x, y]) => [x + 17 + rise, y + 1 - Math.round(rise * 1.4)]), C.think));
    }
    return f;
  },
  bump(t) {
    const f = base();
    f.eyes = 'dizzy';
    f.legs = t < 300 ? 'tuck' : 'stand';
    f.dy = t < 200 ? -1 : 0;
    // stars circling the head
    for (let i = 0; i < 3; i++) {
      const a = t / 160 + (i * Math.PI * 2) / 3;
      f.over.push([Math.round(10.5 + Math.cos(a) * 6), Math.round(3 + Math.sin(a) * 1.5), C.fx]);
    }
    return f;
  },
  shoo(t, c) {
    const f = base();
    const toward = c.other && c.other.dir < 0 ? -1 : 1;
    f.puffed = t < 700;
    f.brows = true;
    f.eyes = 'angry';
    f.arms = toward > 0 ? (step(t, 160, 2) ? 'rightUp' : 'rest') : step(t, 160, 2) ? 'leftUp' : 'rest';
    f.dx = t < 400 ? toward * [0, 1, 1, 0][step(t, 100, 4)] : 0;
    f.over = fx([-3, -2, -1, 1].map((y) => [toward > 0 ? 19 : 2, y + 4]), C.fx);
    return f;
  },
  greet(t, c) {
    const f = base();
    const toward = c.other && c.other.dir < 0 ? -1 : 1;
    f.eyes = 'happy';
    f.arms = toward > 0 ? (step(t, 220, 2) ? 'waveR' : 'waveR2') : step(t, 220, 2) ? 'waveL' : 'waveL2';
    f.eyeShift = { x: toward, y: 0 };
    return f;
  },
  bubbles(t) {
    const f = base();
    f.dy = step(t, 700, 2);
    f.eyes = 'up';
    for (let i = 0; i < 4; i++) {
      const age = t - i * 650;
      if (age < 0 || age > 1700) continue;
      const y = Math.round(5 - age / 170);
      const x = 11 + Math.round(Math.sin(age / 180 + i) * 1.2) - (i % 2);
      f.over.push(...fx(age > 1500 ? [[x, y]] : [[x, y], [x + 1, y], [x, y - 1], [x + 1, y - 1]], C.bubble));
    }
    return f;
  },
  dig(t, c) {
    const f = base();
    const spray = (n) => {
      const k = step(t, 90, 3);
      return fx([[3 - k, 14 - k], [2 - k, 13 - (k % 2)], [18 + k, 14 - k], [19 + k, 13 - (k % 2)]].slice(0, n), C.sand);
    };
    const mound = fx([...Array(14)].map((_, i) => [4 + i, GROUND - 1]), C.sand).concat(fx([[3, GROUND - 1], [18, GROUND - 1]], C.sandDark));
    f.legs = step(t, 80, 2) ? 'stepA' : 'stepB';
    if (t < 400) f.over = spray(2);
    else if (t < 1400) {
      f.dy = Math.round(((t - 400) / 1000) * 5);
      f.sink = f.clip = true;
      f.over = spray(4).concat(mound);
    } else if (t < 2800) {
      f.dy = 5;
      f.sink = f.clip = true;
      f.eyes = t % 900 < 120 ? 'blink' : 'open';
      f.eyeShift = { x: step(t, 600, 2) ? -1 : 1, y: 0 };
      f.over = mound;
    } else if (t < 3400) {
      f.dy = [5, 2, -2, -1, 0][Math.min(4, Math.floor((t - 2800) / 120))];
      f.sink = f.clip = f.dy > 0;
      f.arms = 'up';
      f.over = spray(4);
    } else {
      f.dx = step(t, 70, 2) ? 1 : -1;
      f.eyes = 'happy';
      const k = Math.floor((t - 3400) / 160);
      f.over = fx([[6, 6 + k], [15, 7 + k], [10, 5 + k]], C.sand);
    }
    return f;
  },
  dance(t) {
    // crab rave: claws alternate on the beat, sideways shimmy, music notes
    const f = base();
    const beat = step(t, 220, 4);
    f.arms = beat % 2 ? 'leftUp' : 'rightUp';
    f.dx = [0, 1, 0, -1][beat];
    f.dy = beat % 2 ? -1 : 0;
    f.legs = beat % 2 ? 'stepA' : 'stepB';
    f.eyes = 'happy';
    const k = Math.floor((t % 1300) / 260);
    f.over = note(2, 3 - k).concat(note(17, 1 - ((k + 2) % 5)));
    return f;
  },
  stretch(t) {
    const f = base();
    if (t < 900) {
      f.arms = t < 300 ? 'mid' : 'up';
      f.dy = -1;
      f.legs = 'stand';
      f.eyes = 'closed';
    } else if (t < 1700) {
      f.arms = 'up';
      f.eyes = 'closed';
      f.mouth = t < 1500 ? 'yawn' : 'small';
    } else {
      f.eyes = t < 1900 ? 'blink' : 'open';
      f.dy = step(t, 300, 2);
    }
    return f;
  },
  lookAround(t) {
    const f = base();
    const phase = Math.floor(t / 650);
    f.eyeShift = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 0 }][Math.min(3, phase)];
    if (phase === 3) f.over = fx([[10, 1], [11, 1], [12, 2], [11, 3], [11, 5]], C.think); // "?"
    if (phase === 1) f.dx = 1;
    if (phase === 0) f.dx = -1;
    return f;
  },
  juggle(t) {
    const f = base();
    f.eyes = 'up';
    f.arms = step(t, 400, 2) ? 'leftUp' : 'rightUp';
    for (let i = 0; i < 2; i++) {
      const p = ((t + i * 400) % 800) / 800;
      const from = (Math.floor((t + i * 400) / 800) + i) % 2 ? 2 : 19;
      const to = from === 2 ? 19 : 2;
      const x = Math.round(from + (to - from) * p);
      const y = Math.round(4 - Math.sin(p * Math.PI) * 6);
      f.over.push(...fx([[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]], C.pebble));
    }
    return f;
  },
  sneeze(t) {
    const f = base();
    if (t < 700) {
      f.eyes = 'blink';
      f.dy = -Math.floor(t / 350);
      f.mouth = 'small';
    } else if (t < 1000) {
      f.eyes = 'closed';
      f.dx = -1;
      f.mouth = 'yawn';
      const k = Math.floor((t - 700) / 80);
      f.over = fx([[12 + k, 12], [13 + k, 11], [14 + k, 12], [13 + k, 13], [15 + k, 10]], C.dust);
    } else {
      f.eyes = 'happy';
      f.over = fx([[6, 14], [15, 14]], C.blush);
    }
    return f;
  },
  walk(t, c) {
    const f = base();
    const s = step(t, 90, 2);
    f.legs = s ? 'stepA' : 'stepB';
    f.dy = s;
    f.arms = step(t, 360, 2) ? 'pinchA' : 'pinchB';
    f.eyeShift = { x: c.dir, y: 0 };
    return f;
  },
  run(t, c) {
    const f = base();
    const s = step(t, 55, 2);
    f.legs = s ? 'stepA' : 'stepB';
    f.dy = s;
    f.arms = 'up';
    f.eyes = 'wide';
    f.eyeShift = { x: c.dir, y: 0 };
    const back = c.dir > 0 ? 1 : 20;
    f.over = fx([[back, 17], [back - c.dir, 16], [back - 2 * c.dir, 17]], C.dust);
    return f;
  },
  scuttleSprint(t, c) {
    const f = POSES.run(t, c);
    f.eyes = 'happy';
    f.arms = step(t, 120, 2) ? 'up' : 'upClosed';
    const back = c.dir > 0 ? 1 : 20;
    for (let i = 0; i < 4; i++) f.over.push([back - i * c.dir, 17 - (i % 2), C.dust]);
    return f;
  },
};

function paint(g, f) {
  g.clear();
  const lift = Math.max(0, -f.dy) + f.lift;
  if (!f.sink) {
    g.alpha(Math.max(0.1, 0.3 - lift * 0.04));
    g.ellipse(W / 2, 16.6 + TOP, Math.max(3, 8 - lift), 1.1, '#000');
    g.alpha(1);
  }
  const px = (x, y, color, dy = f.dy, dx = f.dx) => g.px(x + dx, y + dy + TOP, color);

  g.save();
  if (f.clip) g.clip(0, 0, g.width, GROUND - 1 + TOP);
  const legDy = f.sink || f.dy < 0 || f.legs.startsWith('dangle') ? f.dy : 0;
  for (const [x, y] of LEGS[f.legs]) px(x, y, C.shade, legDy);
  for (const [x, y, c] of f.puffed ? BODY_PUFFED : BODY) px(x, y, c);
  for (const [x, y] of armCells(f.arms)) px(x, y, C.body);
  const es = f.eyeShift || { x: 0, y: 0 };
  for (const [x, y] of EYES[f.eyes]) px(x + (f.eyes === 'open' ? es.x : 0), y + (f.eyes === 'open' ? es.y : 0), C.eye);
  if (f.brows) for (const [x, y] of both([[7, 7], [8, 7]])) px(x, y - (x === 7 || x === 14 ? 1 : 0), C.angry);
  if (f.mouth === 'yawn') for (const [x, y] of [[10, 11], [11, 11], [10, 12], [11, 12]]) px(x, y, C.eye);
  if (f.mouth === 'small') for (const [x, y] of [[10, 11], [11, 11]]) px(x, y, C.eye);
  if (f.cap) for (const [x, y, c] of CAP) px(x + f.cap.dx, y + f.cap.dy, c);
  g.restore();

  for (const [x, y, c] of f.over) px(x, y, c, 0, 0);
}

const anim = (name, extra = {}) => ({ ...extra, draw: (g, c) => paint(g, POSES[name](c.t, c)) });

definePet({
  format: 1,
  id: 'clawrk',
  name: 'Clawrk',
  lines: {
    dodge: ['Scuttling aside!', 'Pardon the pinch!', 'Sideways it is!', 'Clear the shell zone!'],
    command: ['Aye, scuttling off!', 'Fine, fine. Going!', 'Claws up, leaving!'],
    panic: ['No room! Snip snip!', "It's all words!", 'Crab emergency!'],
  },
  author: 'Harness Pet',
  version: '2.0.0',
  description: 'A pixel crab who lives on your screen and keeps an eye on your coding agent.',
  canvas: { width: 22, height: 22 },
  scale: 5,
  animations: {
    idle: anim('idle'),
    thinking: anim('thinking'),
    working: anim('working'),
    needsYou: anim('needsYou'),
    done: anim('done'),
    held: anim('held'),
    fall: anim('fall'),
    land: anim('land'),
    hover: anim('hover'),
    poke: anim('poke'),
    grow: anim('grow'),
    shrink: anim('shrink'),
    wake: anim('wake'),
    sleep: anim('sleep'),
    bump: anim('bump'),
    shoo: anim('shoo'),
    greet: anim('greet'),
    bubbles: anim('bubbles'),
    dig: anim('dig'),
    dance: anim('dance'),
    stretch: anim('stretch'),
    lookAround: anim('lookAround'),
    juggle: anim('juggle'),
    sneeze: anim('sneeze'),
    walk: anim('walk', { move: (c) => ({ vx: c.dir * 60, vy: 0 }) }),
    run: anim('run', { move: (c) => ({ vx: c.dir * 220, vy: 0 }) }),
    // A custom animation: hosts detect it and offer a toggle plus a speed slider.
    scuttleSprint: anim('scuttleSprint', {
      label: 'Scuttle sprint',
      kind: 'movement',
      duration: 2200,
      description: 'A joyful full-speed sideways sprint with a dust trail.',
      params: { speed: { label: 'Speed', min: 0.5, max: 4, step: 0.1, default: 1.6 } },
      move: (c) => ({ vx: c.dir * 140 * c.params.speed, vy: 0 }),
    }),
  },
});
