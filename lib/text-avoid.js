// Decides when pets should get out of the way of text, and where to.
//
//  - Typing: while you type, a pet that stands on text (or in the line you are about to
//    fill) walks to the nearest bare spot and waits until you have stopped typing.
//  - "GO AWAY" / "GET OUT" / "MOVE" typed in capitals: every pet near any text on its
//    screen walks to a bare spot and stays for 30 s to 5 min, or until you click it.
//
// The host does the walking and the parking; this module only looks and decides.
// Everything it needs comes in through `host`, `scan` and `context`, so it is tested
// without Electron.
//
//   host.avoidPets()          → [{ uid, rect, display, bounds, lockY, canMove, avoidText, avoid }]
//   host.avoidSend(uid, plan) → { x, y, kind, until }
//   host.avoidExtend(uid, until)
//   host.hideFromCapture(on)  → Promise (keeps the pets out of the screenshot)
//   scan(display, region)     → Promise<text grid | null>
//   context()                 → Promise<{ caret, window } in screen DIPs | null>

const TextMap = require('./text-map');

const TYPING_HOLD = 10e3; // stay put this long after the last key
const TYPING_MIN = 12e3;
const PHRASE_MIN = 30e3;
const PHRASE_MAX = 5 * 60e3;
const SCAN_GAP = 1200; // while pets are dodging, look again this soon
const CALM_GAP = 3000; // while nothing needed moving, look less often (each look is a screenshot)
const REGION_X = 700; // how far around a pet to look while you type
const REGION_Y = 350;

const { grow, meets } = TextMap;

// the stretch of line where the next words will appear
function caretZone(caret) {
  if (!caret) return null;
  const line = Math.max(caret.h, 16);
  return { x: caret.x - 40, y: caret.y - 6, w: 520, h: line * 2 + 12 };
}

function create({ host, scan, context, enabled = () => true, now = Date.now, rand = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, trace = () => {} }) {
  let lastTyping = 0;
  let lastScan = 0;
  let gap = SCAN_GAP;
  let timer = null;
  let chain = Promise.resolve();
  let generation = 0;

  const queue = (task) => {
    const token = generation;
    return chain = chain.then(() => enabled() && token === generation ? task(token) : undefined).catch((err) => log('avoid failed', err));
  };

  async function scanAll(groups, regionOf) {
    const token = generation;
    if (!enabled()) return new Map();
    // the pets are hidden from the capture, so they are not mistaken for text
    await host.hideFromCapture(true);
    try {
      const out = new Map();
      for (const group of groups.values()) {
        if (!enabled() || token !== generation) break;
        const grid = await scan(group.display, regionOf ? regionOf(group) : null);
        if (enabled() && token === generation) out.set(group, grid);
      }
      return out;
    } finally {
      await host.hideFromCapture(false);
    }
  }

  function byDisplay(pets) {
    const groups = new Map();
    for (const p of pets) {
      if (!groups.has(p.display.id)) groups.set(p.display.id, { display: p.display, pets: [] });
      groups.get(p.display.id).pets.push(p);
    }
    return groups;
  }

  // Keep the search inside the part of the screen that was actually captured.
  function limit(bounds, grid, rect) {
    const x0 = Math.max(bounds.x0, grid.ox);
    const y0 = Math.max(bounds.y0, grid.oy);
    const x1 = Math.min(bounds.x1, grid.ox + grid.w / grid.scale - rect.w);
    const y1 = Math.min(bounds.y1, grid.oy + grid.h / grid.scale - rect.h);
    return x0 <= x1 && y0 <= y1 ? { x0, x1, y0, y1 } : null;
  }

  // ---------- typing ----------

  function typed() {
    if (!enabled()) return;
    lastTyping = now();
    for (const p of host.avoidPets()) if (p.avoid && p.avoid.kind === 'typing') host.avoidExtend(p.uid, lastTyping + TYPING_HOLD);
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      queue(typingScan);
    }, Math.max(0, lastScan + gap - now()));
  }

  async function typingScan(token) {
    const started = now();
    lastScan = started;
    gap = CALM_GAP;
    const pets = host.avoidPets().filter((p) => p.canMove && p.avoidText && (!p.avoid || (p.avoid.kind === 'typing' && p.avoid.phase === 'park')));
    if (!pets.length) return trace('typing: no pet can dodge right now');
    const ctx = await context();
    if (!enabled() || token !== generation) return;
    // only pets over the window you are typing in can be in the way
    const near = ctx && ctx.window ? pets.filter((p) => meets(p.rect, ctx.window)) : pets;
    trace('typing:', pets.length, 'pets,', near.length, 'over', ctx && ctx.window ? JSON.stringify(ctx.window) : 'an unknown window');
    if (!near.length) return;
    const zone = caretZone(ctx && ctx.caret);
    const groups = byDisplay(near);
    const grids = await scanAll(groups, (g) => {
      const x0 = Math.min(...g.pets.map((p) => p.rect.x)) - REGION_X;
      const y0 = Math.min(...g.pets.map((p) => p.rect.y)) - REGION_Y;
      const x1 = Math.max(...g.pets.map((p) => p.rect.x + p.rect.w)) + REGION_X;
      const y1 = Math.max(...g.pets.map((p) => p.rect.y + p.rect.h)) + REGION_Y;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
    const all = host.avoidPets();
    if (!enabled() || token !== generation) return;
    const taken = [];
    for (const [group, grid] of grids) {
      if (!grid) continue;
      for (const pet of group.pets) {
        const blockedByCaret = zone && meets(grow(pet.rect, 8), zone);
        if (!blockedByCaret && !TextMap.isOnText(grid, pet.rect)) continue;
        const bounds = limit(pet.bounds, grid, pet.rect);
        if (!bounds) continue;
        const others = all.filter((o) => o.uid !== pet.uid).map((o) => o.avoidTarget || o.rect);
        const spot = TextMap.pickClearSpot(grid, { rect: pet.rect, bounds, lockY: pet.lockY, blocked: [...(zone ? [zone] : []), ...others, ...taken] });
        if (!spot || !spot.clear) continue; // dodging is a courtesy: with nowhere bare, stay put
        taken.push({ ...spot, w: pet.rect.w, h: pet.rect.h });
        host.avoidSend(pet.uid, { x: spot.x, y: spot.y, kind: 'typing', until: Math.max(now() + TYPING_MIN, lastTyping + TYPING_HOLD) });
        gap = SCAN_GAP;
      }
    }
    if (lastTyping > started) typed(); // still typing: look again shortly
  }

  // ---------- "GO AWAY" ----------

  function phrase() {
    return queue(async (token) => {
      const pets = host.avoidPets().filter((p) => p.canMove && !(p.avoid && p.avoid.phase !== 'park'));
      if (!pets.length) return;
      const groups = byDisplay(pets);
      const ctx = await context();
      if (!enabled() || token !== generation) return;
      const zone = caretZone(ctx && ctx.caret); // the word you just typed is the last place to stand
      const grids = await scanAll(groups, null);
      const all = host.avoidPets();
      if (!enabled() || token !== generation) return;
      const taken = [];
      const hold = () => PHRASE_MIN + rand() * (PHRASE_MAX - PHRASE_MIN);
      for (const [group, grid] of grids) {
        if (!grid) continue;
        for (const pet of group.pets) {
          if (!TextMap.isOnText(grid, pet.rect, { pad: 40 })) {
            if (pet.avoid) host.avoidExtend(pet.uid, now() + hold(), 'phrase'); // already out of the way: keep waiting
            continue;
          }
          const bounds = limit(pet.bounds, grid, pet.rect);
          if (!bounds) continue;
          const others = all.filter((o) => o.uid !== pet.uid).map((o) => o.avoidTarget || o.rect);
          const spot = TextMap.pickClearSpot(grid, { rect: pet.rect, bounds, lockY: pet.lockY, pads: [40, 14], blocked: [...(zone ? [zone] : []), ...others, ...taken] });
          if (!spot) continue;
          taken.push({ ...spot, w: pet.rect.w, h: pet.rect.h });
          // nowhere is bare: it still goes to the emptiest place, but in a flap about it
          host.avoidSend(pet.uid, { x: spot.x, y: spot.y, kind: 'phrase', until: now() + hold(), panic: !spot.clear });
        }
      }
    });
  }

  function stop() { generation++; if (timer) clearTimer(timer); timer = null; lastTyping = 0; }
  return { typed, phrase, stop, idle: () => chain, caretZone };
}

module.exports = { create, caretZone, TYPING_HOLD, TYPING_MIN, PHRASE_MIN, PHRASE_MAX, SCAN_GAP, CALM_GAP };
