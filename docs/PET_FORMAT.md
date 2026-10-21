# Harness Pet format (v1)

A pet is **one self-contained JavaScript file** named `<id>.pet.js`. It calls `definePet({...})` exactly once. Harness Pet runs the file inside a sandboxed Web Worker: no DOM, no Node.js, no network, no `import`/`require`. All art is drawn in code onto a small canvas. Don't use external images, fonts or libraries.

```js
// pebble.pet.js
const C = { body: '#4FA3E0', beak: '#F4C25B', eye: '#1E1D1B' };

function drawBird(g, ctx, pose) { /* draw with g.px / g.rect / g.pixels / g.ellipse */ }

definePet({
  format: 1,
  id: 'pebble',                  // a-z, 0-9, "-" (2–41 chars), unique
  name: 'Pebble',
  author: 'your name',
  version: '1.0.0',
  description: 'A tiny blue bird who cheers on your agent.',
  canvas: { width: 24, height: 24 },   // drawing surface in pet pixels (8–512)
  scale: 5,                            // screen pixels per pet pixel at 100% size
  animations: {
    idle: { draw(g, ctx) { drawBird(g, ctx, 'idle'); } },
    walk: {
      move: (ctx) => ({ vx: ctx.dir * 60, vy: 0 }),
      draw(g, ctx) { drawBird(g, ctx, 'hop'); },
    },
    // A custom animation. Hosts detect it and show a toggle plus sliders for its params.
    zoomAround: {
      label: 'Zoom around the screen',
      kind: 'movement',
      duration: 5000,
      description: 'Flies around at high speed.',
      params: { speed: { label: 'Speed', min: 0.5, max: 4, step: 0.1, default: 1.5 } },
      move: (ctx) => ({ vx: ctx.dir * 260 * ctx.params.speed, vy: Math.sin(ctx.t / 300) * 120 }),
      draw(g, ctx) { drawBird(g, ctx, 'fly'); },
    },
  },
});
```

## Speech: `lines` (optional)

When a pet gets out of the way of text, it says a short line in its speech bubble. Give it a voice:

```js
lines: {
  dodge:   ['Scuttling aside!', 'Sideways it is!'],   // you are typing over it
  command: ['Fine, fine. Going!'],                     // you typed GO AWAY / GET OUT / MOVE
  panic:   ["It's all words!"],                        // nowhere bare to go
},
```

Up to 10 lines per key, 60 characters each (aim for under 28 so the bubble stays small). One is picked at random each time. Pets without `lines` use plain defaults.

## Drawing: `draw(g, ctx)`

Called about 30 times a second for the animation that's playing. Draw the whole frame each time; the canvas is cleared for you. Work in **pet pixels**: (0, 0) is top-left, x grows right, y grows down. The host scales the canvas up with crisp pixels.

`g`, the graphics helper:

| Call | Does |
|---|---|
| `g.px(x, y, color)` | one pixel |
| `g.rect(x, y, w, h, color)` | filled rectangle |
| `g.pixels(list, color, dx = 0, dy = 0)` | many pixels; `list` is `[[x, y], …]` or `[[x, y, color], …]` |
| `g.ellipse(cx, cy, rx, ry, color)` | filled ellipse (good for soft shadows) |
| `g.alpha(a)` | set opacity (0–1) for what follows |
| `g.save()` / `g.restore()` / `g.clip(x, y, w, h)` | clip a region, for example to sink into the ground |
| `g.clear()` | clear (already done before each frame) |
| `g.width`, `g.height`, `g.ctx` | canvas size, and the raw `CanvasRenderingContext2D` if you need more |

`ctx`, what the pet knows this frame:

| Field | Meaning |
|---|---|
| `t` | milliseconds since this animation started |
| `dt`, `frame` | ms since the last frame, frame counter |
| `params` | resolved values of this animation's `params` |
| `look` | `{ x, y }` in −1…1, where the mouse is relative to the pet (for eyes that follow) |
| `dir` | `1` facing or moving right, `-1` left. Face this way in walk/run/movement poses. |
| `speed`, `size` | the user's speed multiplier and size (1 = 100%) |
| `state` | `{ status }`: `idle`, `thinking`, `working`, `needs-you` or `done`. Private session labels and transcript content are not passed to pet code. |
| `other` | for `bump`, `shoo` and `greet`: `{ dir, distance }` of the other pet |
| `blocked` | `{ left, right, top, bottom }`: true when the pet is against a wall |
| `home` | `{ dx, dy }` from the pet to its anchor point |
| `seed`, `noise(i)` | per-play random seed and a stable random number in [0, 1) for index `i` |

Keep the pet's feet on the same row in every animation, and leave a few empty rows on top for hops and effects. The host draws nothing for you, so draw your own shadow if you want one.

## Moving: `move(ctx)`

Animations of kind `movement` must have `move(ctx)`, which returns `{ vx, vy }` in **screen pixels per second at 100% size**. The host:

- multiplies it by the user's speed setting, and slows bigger pets slightly;
- moves the pet window, keeping it inside the user's containment (this screen, all screens or the taskbar) or on its leash when anchored;
- sets `ctx.blocked` when the pet hits a wall, and flips `ctx.dir` for the next run;
- pushes the pet back if it walks into another pet, then plays `bump` on it and `shoo` on the other.

Return `null` to end the movement early. Positive `vy` moves down; on the taskbar `vy` is ignored.

## Animation fields

| Field | For | Meaning |
|---|---|---|
| `draw(g, ctx)` | all, required | draws one frame |
| `move(ctx)` | movement | velocity, see above |
| `duration` | custom non-looping | ms the animation plays (standard ones have defaults) |
| `kind` | custom | `status`, `reaction`, `rest`, `trick` or `movement` |
| `label`, `description` | custom | shown in the app |
| `params` | any | `{ name: { label, min, max, step, default } }`: sliders in the app, read via `ctx.params` |
| `trigger` | custom reactions | `hover`, `poke` (double-click), `drop`, `bump` or `random` |
| `loop` | custom | `true` keeps it playing until something else takes over |

| `sound` | any | name of a sound to play when the animation starts (from the built-in catalog or the pet's own `sounds`) |

Custom tricks and movements are mixed into the idle schedule automatically. Custom reactions play on their `trigger`.

## Sounds (optional)

Harness Pet has a catalog of small synthesized sounds: boop, blip, pop, chirp, ding, yay, sparkle, whoosh, thud, boing, huff, giggle, grow, shrink, eek, achoo, dig, yawn, snore, tick, patter, typing, hmm, beat and swish. Standard animations already get sensible defaults, and users can change any of them in the Studio. A pet can also bring its own sounds as plain data (no audio files):

```js
definePet({
  // …
  sounds: {
    tweet: { label: 'Tweet', parts: [
      { wave: 'sine', f: 2200, to: 3100, dur: 0.08, gain: 0.35 },
      { wave: 'sine', f: 2600, to: 3400, at: 0.11, dur: 0.07, gain: 0.3 },
    ] },
    flap: { label: 'Flap (loops)', repeatMs: 220, parts: [{ wave: 'noise', f: 900, dur: 0.05, gain: 0.25, q: 1.5 }] },
  },
  animations: {
    greet: { sound: 'tweet', duration: 1600, draw(g, ctx) { /* … */ } },
    zoomAround: { sound: 'flap', kind: 'movement', /* … */ },
  },
});
```

A recipe's `parts` play together: `wave` (sine, square, triangle, sawtooth or noise), `f` start frequency in Hz, optional `to` (slide), `at` (start offset in s), `dur` (≤ 3 s), `gain` (0–1), and `q` (filter sharpness, noise only). `repeatMs` loops the sound while the animation plays. Keep sounds short and soft.

## Standard animations

`idle` is required. Every other standard animation is optional; when one is missing, the host plays a fallback (usually `idle` with a built-in hop, shake or squash) and the app offers an "install prompt" to add it. The full list, with what each should look like, is in the app (and in prompts it generates).

## Checking your pet

```bash
node <harness-pet>/scripts/validate-pet.js path/to/pebble.pet.js
```

It loads the pet the same way the app does, then draws every animation over its whole duration in both directions to catch errors. Put finished pets in your pets folder, alongside `clawrk.pet.js` (`pets/` in the project when running from source, `~/.harness-pet/pets/` when installed). The app picks them up automatically, and reloads a pet live when its file changes. Optional top-level `disabledAnimations: ['dig', 'sleep']` or `enabled: false` on an animation keeps it off initially; a user's saved animation setting takes precedence.
