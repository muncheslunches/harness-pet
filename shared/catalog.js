// The standard animation catalog every pet can implement. Shared by the pet
// window, the Studio, the validator and the prompt maker (works in Node and browsers).
//
// kind:     status    — driven by what the coding agent is doing
//           reaction  — played when the user does something to the pet
//           rest      — long idle states
//           trick     — random idle tricks (only scheduled if the pet has them)
//           movement  — animations that move the pet across the screen (need move())
// fallback: what the host plays (optionally with a built-in effect) when a pet lacks one.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CATALOG = [
    // ---- agent status ----
    { key: 'idle', kind: 'status', label: 'Idle', required: true, loop: true,
      spec: 'Default loop. Gentle breathing or bob, an occasional blink. If the pet has eyes, glance toward the cursor (ctx.look).' },
    { key: 'thinking', kind: 'status', label: 'Thinking', loop: true, fallback: ['idle', 'bob'],
      spec: 'The agent is thinking (a prompt was sent, or between tool calls). Pondering: looking up or around, "…" dots.' },
    { key: 'working', kind: 'status', label: 'Working', loop: true, fallback: ['idle', 'bob'],
      spec: 'A tool is running. Busy, energetic loop (typing, scuttling in place, hammering…).' },
    { key: 'needsYou', kind: 'status', label: 'Needs you', loop: true, fallback: ['idle', 'hop'],
      spec: 'The agent is waiting on the user (permission prompt, question, plan to review). Attention-grabbing: hopping, a "!" mark.' },
    { key: 'done', kind: 'status', label: 'Done', loop: true, fallback: ['idle', 'hop'],
      spec: 'The agent finished its turn. Celebrate for about 3 s (dance, sparkles), then hold a calm happy pose.' },

    // ---- reactions ----
    { key: 'held', kind: 'reaction', label: 'Resist dragging', loop: true, fallback: ['idle', 'shake'],
      spec: 'Being dragged by the mouse. Resist or panic: kicking legs, wiggling, wide or "> <" eyes, sweat drops.' },
    { key: 'fall', kind: 'reaction', label: 'Falling', loop: true, fallback: ['held', 'shake'],
      spec: 'Dropped in mid-air and falling (with the "Fall when dropped" option). Flailing or bracing for impact.' },
    { key: 'land', kind: 'reaction', label: 'Landing', duration: 650, fallback: ['idle', 'squash'],
      spec: 'Just landed after a drag or fall (about 650 ms). Short squash, a puff of dust, a blink.' },
    { key: 'hover', kind: 'reaction', label: 'Greet (hover)', duration: 1600, fallback: ['idle', 'hop'],
      spec: 'The mouse moved onto the pet (about 1.6 s). A friendly wave or greeting.' },
    { key: 'poke', kind: 'reaction', label: 'Giggle (double-click)', duration: 1200, fallback: ['hover', 'hop'],
      spec: 'The pet was double-clicked (about 1.2 s). Ticklish giggle, a little jump, happy eyes.' },
    { key: 'grow', kind: 'reaction', label: 'Getting bigger', duration: 900, fallback: ['idle', 'hop'],
      spec: 'The pet is being made bigger with Ctrl+wheel (about 0.9 s). Delighted, giggly, puffing up.' },
    { key: 'shrink', kind: 'reaction', label: 'Getting smaller', duration: 900, fallback: ['idle', 'shake'],
      spec: 'The pet is being made smaller (about 0.9 s). Alarmed, squeezed, eyes wide.' },
    { key: 'wake', kind: 'reaction', label: 'Waking up', duration: 1100, fallback: ['idle'],
      spec: 'Waking from a nap (about 1.1 s): stretch, rub eyes, shake off the nightcap.' },

    // ---- other pets on screen ----
    { key: 'bump', kind: 'reaction', label: 'Bumped & rejected', duration: 1000, fallback: ['shrink', 'shake'],
      spec: 'Walked into another pet and got rejected (about 1 s). Recoil, dizzy stars or swirly eyes. The host pushes the pet back; just draw the reaction.' },
    { key: 'shoo', kind: 'reaction', label: 'Shoo away', duration: 1000, fallback: ['held', 'shake'],
      spec: 'Another pet bumped into this one (about 1 s). Indignant: puff up, shove, angry eyebrows or a little "!" toward ctx.other.dir (-1 left, 1 right).' },
    { key: 'greet', kind: 'reaction', label: 'Greet a friend', duration: 1600, fallback: ['hover', 'hop'],
      spec: 'Another pet is nearby and both are idle (about 1.6 s). Wave or nod toward ctx.other.dir.' },

    // ---- rest ----
    { key: 'sleep', kind: 'rest', label: 'Nap', loop: true, fallback: ['idle'],
      spec: 'Napping after a few idle minutes. Closed eyes, slow breathing, a nightcap, rising "Z" letters (draw a real Z with a diagonal).' },

    // ---- idle tricks ----
    { key: 'bubbles', kind: 'trick', label: 'Blow bubbles', duration: 3600, spec: 'Blow a few bubbles and watch them float up.' },
    { key: 'dig', kind: 'trick', label: 'Dig / burrow', duration: 4200, spec: 'Burrow into the ground, peek out, pop back up and shake off.' },
    { key: 'dance', kind: 'trick', label: 'Dance', duration: 3200, spec: 'A short happy dance with a beat.' },
    { key: 'stretch', kind: 'trick', label: 'Stretch & yawn', duration: 2400, spec: 'Stretch tall, yawn, settle back down.' },
    { key: 'lookAround', kind: 'trick', label: 'Look around', duration: 2600, spec: 'Curiously look left, right and up, as if hearing something.' },
    { key: 'juggle', kind: 'trick', label: 'Juggle', duration: 3600, spec: 'Juggle or toss a small object (pebble, ball, seed).' },
    { key: 'sneeze', kind: 'trick', label: 'Sneeze', duration: 1600, spec: 'Wind up, sneeze (with a little puff), look embarrassed.' },

    // ---- movement ----
    { key: 'walk', kind: 'movement', label: 'Wander', duration: 3500, fallback: ['idle', 'bob'], moves: true,
      spec: 'Leisurely movement. move(ctx) returns { vx, vy } in px/s (about 60 px/s sideways). Draw a walk cycle facing ctx.dir.' },
    { key: 'run', kind: 'movement', label: 'Dash', duration: 900, fallback: ['walk', 'bob'], moves: true,
      spec: 'A quick dash (about 220 px/s), used to flee the cursor or hurry home. move(ctx) returns { vx, vy }; usually vx = ctx.dir * 220.' },
  ];

  const KINDS = ['status', 'reaction', 'rest', 'trick', 'movement'];
  const BY_KEY = Object.fromEntries(CATALOG.map((a) => [a.key, a]));
  // Built-in effects the host can apply to a fallback animation.
  const EFFECTS = ['bob', 'hop', 'shake', 'squash'];

  // Resolve which animation (and effect) to actually play for `key` on a pet with `have` animations.
  function resolve(key, have) {
    const seen = new Set();
    let effect = null;
    let k = key;
    while (k && !have[k] && !seen.has(k)) {
      seen.add(k);
      const entry = BY_KEY[k];
      if (!entry || !entry.fallback) return null;
      if (!effect) effect = entry.fallback[1] || null;
      k = entry.fallback[0];
    }
    return have[k] ? { key: k, effect: k === key ? null : effect } : null;
  }

  return { CATALOG, KINDS, BY_KEY, EFFECTS, resolve };
});
