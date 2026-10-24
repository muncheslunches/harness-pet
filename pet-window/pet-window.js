// One pet on screen: picks which animation plays, schedules tricks and
// movement, reacts to the mouse and other pets, plays sounds, and draws the
// speech bubble, button bar, session list and right-click menu.

const $ = (id) => document.getElementById(id);
const col = $('pet-col');
const wrap = $('pet-wrap');
const bubble = $('bubble');
const tail = bubble.querySelector('.tail');
const puffs = [bubble.querySelector('.p1'), bubble.querySelector('.p2')];
const list = $('list');
const rows = $('rows');
const bar = $('bar');
const badge = bar.querySelector('.badge');
const hud = $('hud');
const doneMark = $('done-mark');
const menuRoot = $('menu');
const gurney = $('pet-gurney');
const bandages = $('pet-bandages');

// A frame this late stops the worker (a pet stuck in a loop). Busy, low-memory
// machines can stall that long too, so a stopped worker is restarted (see onFailure).
const player = new PetPlayer($('pet-host'), { frameTimeoutMs: 4000 });
const Cat = PetCatalog;
const STATUS_KEY = { idle: 'idle', thinking: 'thinking', working: 'working', 'needs-you': 'needsYou', done: 'done' };
const LABEL = { 'needs-you': 'Needs you', working: 'Working', thinking: 'Thinking', done: 'Done', idle: 'Idle' };
const TRICK_GAP = { off: null, rare: [40e3, 90e3], normal: [18e3, 45e3], often: [8e3, 20e3] };

let inst = null;
let link = null;
let globals = { muteAll: false, noDance: false }; // Studio > General settings
let manifest = null;
let sessions = [];
let cursor = null;
let notice = null;
let offset = { x: 0, y: 0 };
let work = { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight };
let margin = 380;

// ---------- animation state ----------

const now = () => performance.now();
let current = { wanted: null, key: 'idle', effect: null, since: now(), seed: 1 };
let sessionStatus = 'idle';
let dragging = false;
let falling = false;
let timed = null; // reactions, tricks, interactions
let forced = null; // studio "play"
let moving = null;
let blocked = {};
let lastActivity = now();
let sleeping = false;
let nextTrickAt = now() + 15e3;
let wasOver = false;
let hoverCooldown = 0;
let fleeCooldown = 0;
let collisionPauseUntil = 0;
let dir = 1;
let splitUntil = 0;
let splitAnimation = null;
let avoiding = null; // getting out of the way of text: { phase: 'notice' | 'walk' | 'park', dir, fast }

const rand = (a, b) => a + Math.random() * (b - a);
const has = (k) => !!(manifest && manifest.animations[k]);
const enabled = (k) => !(k === 'dance' && globals.noDance) && PetControls.animationEnabled(inst, manifest, k);
const durationOf = (k) => (manifest && manifest.animations[k] && manifest.animations[k].duration) || (Cat.BY_KEY[k] && Cat.BY_KEY[k].duration) || 2500;
const activity = () => (lastActivity = now());
const isDisabled = () => !!inst && (inst.disabledUntil === -1 || inst.disabledUntil > Date.now());

const NEGATIVE_KEYS = ['held', 'shrink', 'bump', 'shoo', 'fall', 'sad', 'cry', 'hurt', 'angry', 'depressed', 'gloom', 'tired', 'scared', 'fear', 'panic', 'pain', 'sigh', 'sob'];
function isNegativeAnim(k) {
  if (!k) return false;
  return NEGATIVE_KEYS.includes(k) || /(held|shrink|bump|shoo|fall|sad|cry|hurt|angry|panic|scared|fear|dizzy|gloom|depress|sob|sigh|pain|whine|tired)/i.test(k);
}

function pickNegativeAnim(t) {
  const available = Object.keys(manifest?.animations || {}).filter((k) => isNegativeAnim(k) && enabled(k));
  if (!available.length) return has('held') ? 'held' : has('shrink') ? 'shrink' : 'idle';
  const idx = Math.floor(t / 3500) % available.length;
  return available[idx];
}

function resolve(key) {
  if (inst?.caged) {
    const have = {};
    for (const k of Object.keys((manifest && manifest.animations) || {})) if (enabled(k)) have[k] = true;
    const r = Cat.resolve(key, have);
    if (r) return { key: r.key, effect: r.effect || 'shake' };
    return { key: 'idle', effect: 'shake' };
  }
  if (key !== 'idle' && ((has(key) && !enabled(key)) || inst?.animOff[key])) return resolve('idle');
  const have = {};
  for (const k of Object.keys((manifest && manifest.animations) || {})) if (enabled(k)) have[k] = true;
  return Cat.resolve(key, have) || { key: 'idle', effect: null };
}

function pickKey(t) {
  if (dragging) return has('held') ? 'held' : has('shrink') ? 'shrink' : 'idle';
  if (falling) return has('fall') ? 'fall' : has('held') ? 'held' : 'idle';
  if (isDisabled()) return 'idle';
  if (t < splitUntil) return 'idle';
  if (inst && inst.caged) {
    if (moving) return has('shrink') ? 'shrink' : has('held') ? 'held' : pickNegativeAnim(t);
    return pickNegativeAnim(t);
  }
  if (inst && inst.sitting) return 'idle';
  if (inst && inst.asleep) return 'sleep';
  if (forced && t < forced.until) return forced.key;
  if (timed && t < timed.until) return timed.key;
  if (moving) return moving.key;
  if (sessionStatus !== 'idle') return STATUS_KEY[sessionStatus];
  if (sleeping) return 'sleep';
  return 'idle';
}

function look() {
  if (!inst || !inst.behavior.trackCursor || !cursor || !player.canvas || isDisabled()) return { x: 0, y: 0 };
  const r = player.canvas.getBoundingClientRect();
  const k = r.width * 0.6;
  return {
    x: Math.max(-1, Math.min(1, (cursor.x - (r.left + r.width / 2)) / k)),
    y: Math.max(-1, Math.min(1, (cursor.y - (r.top + r.height / 2)) / k)),
  };
}

function paramsFor(key) {
  const a = manifest && manifest.animations[key];
  const out = {};
  if (a) for (const [p, def] of Object.entries(a.params)) out[p] = def.default;
  return Object.assign(out, (inst && inst.params[key]) || {});
}

// Steering belongs to the host, so any pet can opt in without changing its
// drawing code. Keep start/stop distances apart to avoid twitching at the cursor.
function cursorFollowVelocity(active = false) {
  if (!inst || !cursor || !player.canvas) return null;
  const b = inst.behavior;
  if (b.cursorFollowMode !== 'all' || !b.followCursor || !b.wander || b.anchored || b.calm) return null;
  const r = player.canvas.getBoundingClientRect();
  const dx = cursor.x - (r.left + r.width / 2);
  const dy = b.containment === 'taskbar' ? 0 : cursor.y - (r.top + r.height / 2);
  const distance = Math.hypot(dx, dy);
  const extent = b.containment === 'taskbar' ? r.width : Math.max(r.width, r.height);
  const stop = extent * 1.3;
  if (distance <= (active ? stop + 1 : extent * 2.2)) return null;
  const speed = Math.min(60, (distance - stop) * 3);
  let vx = dx / distance * speed;
  let vy = dy / distance * speed;
  if ((vx < 0 && blocked.left) || (vx > 0 && blocked.right)) vx = 0;
  if ((vy < 0 && blocked.top) || (vy > 0 && blocked.bottom)) vy = 0;
  return vx || vy ? { vx, vy } : null;
}

let lastFrame = 0;
let lastAlive = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (!manifest || inst?.visible === false || t - lastFrame < 30) return;
  const dt = t - lastFrame;
  lastFrame = t;
  if (t - lastAlive > 5000) {
    // the host's watchdog reloads a pet whose page stops drawing
    lastAlive = t;
    window.host.health({ event: 'alive', worker: !!player.worker });
  }
  housekeeping(t);

  const key = pickKey(t);
  if (key !== current.wanted) {
    const r = resolve(key);
    current = { wanted: key, key: r.key, effect: r.effect, since: t, seed: (Math.random() * 1e9) | 0 };
    window.host.mode(key === 'idle' || key === 'sleep' ? 'idle' : key);
    if (key === 'dance') {
      // Followers stay silent. The host arbitrates simultaneous dance starts.
      sound(key);
      if (!timed?.groupDance && r.key === 'dance') {
        const dance = current;
        const duration = Math.min(60000, Math.max(1, (forced?.until || timed?.until || moving?.until || t + durationOf(key)) - t));
        const deadline = t + duration;
        window.host.dance(duration).then((audible) => {
          if (audible && now() < deadline && current === dance && pickKey(now()) === 'dance') sound('dance', true, deadline);
        }).catch((err) => console.warn('group dance:', err));
      }
    } else sound(key);
  }
  const top = sessions.find((s) => s.effective !== 'idle');
  const animationRate = inst.asleep ? 0.1 : 1;
  const speedMul = inst?.caged ? 0.4 : 1;
  if (inst?.caged || inst?.isCage) {
    if (!bar.hidden) bar.hidden = true;
    if (!bubble.hidden) bubble.hidden = true;
  }
  player.draw({
    anim: current.key,
    effect: current.effect,
    t: isDisabled() ? 0 : (t - current.since) * animationRate,
    dt: dt * animationRate,
    params: paramsFor(current.key),
    look: look(),
    dir,
    speed: (inst ? inst.behavior.speed : 1) * speedMul,
    size: inst ? inst.size : 1,
    state: { status: sessionStatus },
    other: timed && timed.other,
    blocked,
    home: { dx: -offset.x, dy: -offset.y },
    seed: current.seed,
    wantMove: !!moving && !moving.host && has(moving.key) && manifest.animations[moving.key].moves,
    fallWhenDropped: !!(inst && inst.behavior && inst.behavior.fallWhenDropped),
    behavior: inst ? inst.behavior : null,
  });
  if (moving && (moving.host || !(has(moving.key) && manifest.animations[moving.key].moves))) {
    window.host.vel(moving.follow ? moving.velocity : { vx: (moving.vx || 60) * dir * speedMul, vy: 0 });
  }
  if (!bubble.hidden && !bubbleDrag) placeBubble();
  if (!list.hidden) placeList();
  reportHits();
}
requestAnimationFrame(frame);

player.onMove = (m) => {
  if (!moving || moving.host) return;
  if (m.done) return endMove();
  window.host.vel({ vx: m.vx, vy: m.vy });
  if (m.vx) dir = m.vx > 0 ? 1 : -1;
};
player.onDrawError = (m) => console.warn(`animation "${m.anim}" failed: ${m.message}`);
// The worker stopped (a frame took too long, or it crashed). Start a fresh one with
// the same pet a few times; only then give up and say so.
let restarts = [];
player.onFailure = (err) => {
  endMove();
  window.host.health({ event: 'worker-failed', worker: false, message: err.message });
  restarts = restarts.filter((t) => now() - t < 5 * 60e3);
  if (!petCode || restarts.length >= 3) {
    window.host.health({ event: 'worker-gave-up', worker: false, message: err.message });
    return showNotice(err.message);
  }
  restarts.push(now());
  const code = petCode;
  setTimeout(() => {
    if (code !== petCode || player.worker || dismissing) return;
    loadPet(code).then((ok) => ok && window.host.health({ event: 'worker-restored', worker: true }));
  }, 1000 * restarts.length);
};

function startMove(key, opts = {}) {
  dir = opts.dir || (blocked.left ? 1 : blocked.right ? -1 : Math.random() < 0.5 ? -1 : 1);
  moving = {
    key, until: now() + (opts.duration || durationOf(key)), host: !!opts.host, vx: opts.vx, home: !!opts.home,
    follow: !!opts.follow, velocity: opts.velocity,
  };
  blocked = {};
}

function endMove() {
  if (!moving) return;
  moving = null;
  window.host.vel(null);
  window.host.moveEnd();
}

function housekeeping(t) {
  if (!inst || dismissing) return;
  if (t < splitUntil) { endMove(); return; }
  const b = inst.behavior;
  if (forced && t >= forced.until) forced = null;
  if (timed && t >= timed.until) timed = null;
  if (moving && (t >= moving.until || (moving.home && Math.abs(offset.x) < 3))) endMove();
  document.body.classList.toggle('disabled', isDisabled());
  if (isDisabled() || inst.asleep || inst.sitting) {
    if (moving) endMove();
    return;
  }
  if (!menuRoot.hidden || collisionPauseUntil > Date.now()) {
    endMove();
    return;
  }
  if (avoiding && avoiding.phase !== 'park') {
    // the host does the walking; this only keeps the legs going if something else stopped them
    if (avoiding.phase === 'walk' && !moving && !dragging && !falling) walkAway();
    return;
  }

  if (moving && moving.follow) {
    const velocity = !dragging && !falling && !forced && !timed && sessionStatus === 'idle' ? cursorFollowVelocity(true) : null;
    if (!velocity) endMove();
    else {
      moving.velocity = velocity;
      if (velocity.vx) dir = velocity.vx > 0 ? 1 : -1;
    }
  }

  const idle = !dragging && !falling && !forced && !timed && !moving && sessionStatus === 'idle';
  if (inst?.caged) {
    if (idle && t > nextTrickAt) {
      nextTrickAt = t + rand(6000, 15000);
      dir = Math.random() > 0.5 ? 1 : -1;
      startMove(has('walk') ? 'walk' : 'idle', { host: true, duration: 2400, vx: 25 });
    }
    return;
  }
  if (idle && b.nap && enabled('sleep') && !sleeping && t - lastActivity > b.napMinutes * 60e3) sleeping = true;
  if (sleeping && (!idle || !b.nap)) sleeping = false;
  if (!idle || sleeping || b.calm) return;
  if (avoiding) return; // parked: no wandering, tricks or cursor chasing until released

  if (b.anchored && Math.abs(offset.x) > 3) {
    dir = offset.x > 0 ? -1 : 1;
    return startMove(enabled('walk') ? 'walk' : 'idle', { host: true, home: true, duration: 6000, vx: 60 });
  }

  const pr = player.canvas && player.canvas.getBoundingClientRect();
  if (cursor && pr) {
    const cx = pr.left + pr.width / 2;
    const dist = Math.hypot(cursor.x - cx, cursor.y - (pr.top + pr.height / 2));
    if (b.avoidCursor && dist < pr.width * 1.3 && t > fleeCooldown) {
      fleeCooldown = t + 1500;
      return startMove(enabled('run') ? 'run' : 'walk', { dir: cursor.x < cx ? 1 : -1, duration: 700 });
    }
    if (b.cursorFollowMode === 'all') {
      const velocity = cursorFollowVelocity();
      if (velocity) return startMove(enabled('walk') ? 'walk' : 'idle', {
        dir: velocity.vx ? Math.sign(velocity.vx) : dir, host: true, follow: true, velocity, duration: Infinity,
      });
    } else if (b.followCursor && b.wander && !b.anchored && Math.abs(cursor.x - cx) > pr.width * 2.2) {
      return startMove(enabled('walk') ? 'walk' : 'idle', { dir: cursor.x > cx ? 1 : -1, duration: 1800, host: !enabled('walk') });
    }
  }

  const gap = TRICK_GAP[b.tricks];
  if (!gap || t < nextTrickAt) return;
  nextTrickAt = t + rand(gap[0], gap[1]);
  const tricks = [];
  const moves = [];
  for (const [k, a] of Object.entries(manifest.animations)) {
    if (!enabled(k)) continue;
    if (a.kind === 'trick' || (a.kind === 'reaction' && a.trigger === 'random')) tricks.push(k);
    if (a.kind === 'movement' && k !== 'run' && b.wander) moves.push(k);
  }
  const pool = [...tricks, ...moves, ...moves];
  if (!pool.length) return;
  const k = pool[Math.floor(Math.random() * pool.length)];
  if (manifest.animations[k].kind === 'movement') startMove(k);
  else timed = { key: k, until: t + durationOf(k) };
}

function react(trigger, stdKey, extra = {}) {
  if (isDisabled() || (inst && (inst.asleep || inst.sitting || inst.caged || inst.isCage))) return;
  const options = [];
  if (enabled(stdKey)) options.push(stdKey);
  for (const [k, a] of Object.entries((manifest && manifest.animations) || {})) {
    if (a.kind === 'reaction' && a.trigger === trigger && enabled(k)) options.push(k);
  }
  if (inst && inst.animOff[stdKey] && !options.length) return;
  const k = options.length ? options[Math.floor(Math.random() * options.length)] : stdKey;
  timed = { key: k, until: now() + durationOf(k), ...extra };
}

// ---------- sounds ----------

let audio = null;
let loopTimer = null;

function soundFor(key) {
  const user = (inst.sound.anims || {})[key] || {};
  const petSound = manifest.animations[key] && manifest.animations[key].sound;
  const name = user.sound !== undefined ? user.sound : petSound || PetSounds.DEFAULTS[key] || '';
  const on = user.on !== undefined ? user.on : PetSounds.ON_BY_DEFAULT.includes(key) || !!petSound;
  const custom = inst.sound.custom?.[name] || {};
  return { name, on: on && custom.on !== false, volume: (user.volume !== undefined ? user.volume : 1) * (custom.volume ?? 1) };
}

function sound(key, danceAllowed = false, deadline = Infinity) {
  clearInterval(loopTimer);
  loopTimer = null;
  if (key === 'dance' && !danceAllowed) return;
  if (!inst || !manifest || globals.muteAll || inst.visible === false || inst.sound.muted || isDisabled() || inst.sound.volume <= 0) return;
  if (!manifest.animations[key] && !Cat.BY_KEY[key]) return;
  const s = soundFor(key);
  const recipe = s.name && ((manifest.sounds && manifest.sounds[s.name]) || PetSounds.SOUNDS[s.name]);
  if (!s.on || !recipe || s.volume <= 0) return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    return;
  }
  const cageVolFactor = inst.caged ? 0.12 : 1;
  const vol = inst.sound.volume * s.volume * cageVolFactor;
  PetSounds.play(audio, recipe, vol);
  if (recipe.repeatMs) loopTimer = setInterval(() => {
    if (now() >= deadline) { clearInterval(loopTimer); loopTimer = null; return; }
    PetSounds.play(audio, recipe, vol);
  }, recipe.repeatMs);
}

// ---------- loading ----------

let petCode = null; // the code now running, to restart its worker with
async function loadPet(code) {
  try {
    const { manifest: m, warnings } = await player.load(code);
    petCode = code;
    manifest = m;
    document.title = PetControls.petName(inst, m);
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('aria-label', `${document.title} desktop pet`);
    if (warnings.length) console.warn(warnings.join('\n'));
    player.resize(inst.size);
    window.host.manifest(m);
    reportRect();
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return false;
    showNotice('This pet failed to load: ' + err.message);
    return false;
  }
}

window.host.onInit(async (data) => {
  if (!window.inputDiagnosticsInstalled) {
    window.inputDiagnosticsInstalled = true;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'pointercancel', 'contextmenu', 'gotpointercapture', 'lostpointercapture']) {
      document.addEventListener(type, (e) => window.host.inputTrace({ type, button: e.button, buttons: e.buttons,
        target: e.target.id || e.target.className, dragging, holding, menu: !menuRoot.hidden }), true);
    }
  }
  inst = data.instance;
  link = data.link;
  if (data.globals) globals = data.globals;
  renderButtons();
  applyInstance();
  await loadPet(data.code);
});

window.host.onPetCode(({ code }) => loadPet(code));

window.host.onInstance((next) => {
  const before = inst;
  inst = next;
  if (!before || next.size !== before.size) {
    player.resize(inst.size);
    reportRect();
  }
  if (before && before.asleep !== next.asleep) {
    endMove();
    forced = null;
    timed = next.asleep ? null : { key: 'wake', until: now() + durationOf('wake') };
    sleeping = false;
    current.wanted = null;
  }
  if (before && before.sitting !== next.sitting) {
    endMove();
    forced = null;
    timed = null;
    sleeping = false;
    current.wanted = null;
    reportHits();
  }
  applyInstance();
  if (before?.visible === false && next.visible !== false) {
    document.body.classList.remove('dismissed'); // it had left in a puff of smoke
    sound(current.key);
  }
});

window.host.onGlobals((g) => {
  globals = g;
  if (globals.muteAll) { clearInterval(loopTimer); loopTimer = null; }
  current.wanted = null; // a dance in progress stops
});

window.host.onLink((l) => {
  link = l;
  renderButtons();
});

function applyInstance() {
  if (!inst) return;
  renderButtons();
  if (PetControls.bubbleMode(inst) !== 'expanded') toggleList(false);
  if (inst.visible === false || inst.behavior.calm || isDisabled() || inst.sitting) endMove();
  const isSitting = !!inst.sitting;
  wrap.classList.toggle('sitting', isSitting);
  if (gurney) gurney.hidden = !isSitting;
  if (bandages) bandages.hidden = !isSitting;
  if (inst.visible === false || inst.sound.muted || isDisabled() || inst.sound.volume <= 0) {
    clearInterval(loopTimer);
    loopTimer = null;
    if (audio) { audio.close().catch(() => {}); audio = null; }
  }
  updateBar();
  render();
}

// ---------- geometry: the pet sits in the middle of a roomy window ----------

function reportRect() {
  // Measure without waiting for an animation frame: this window starts hidden.
  setTimeout(() => {
    if (!manifest) return;
    const d = player.displaySize;
    margin = Math.round(Math.max(360, Math.min(560, d.w + 260)));
    const colW = Math.max(d.w, 132);
    col.style.left = margin + 'px';
    col.style.top = margin + 'px';
    col.style.width = colW + 'px';
    const r = wrap.getBoundingClientRect();
    window.host.rect({
      x: r.left - offset.x, y: r.top - offset.y, w: d.w, h: d.h,
      winW: colW + 2 * margin, winH: Math.round(d.h + 4 + 36 + 2 * margin),
    });
  }, 0);
}
window.addEventListener('resize', reportRect);

window.host.onScreen((s) => (work = s.work));

// screen work area → window coordinates
function workBox(pad = 6) {
  const x0 = Math.max(pad, work.x - window.screenX + pad);
  const y0 = Math.max(pad, work.y - window.screenY + pad);
  const x1 = Math.min(window.innerWidth - pad, work.x + work.width - window.screenX - pad);
  const y1 = Math.min(window.innerHeight - pad, work.y + work.height - window.screenY - pad);
  return { x0, y0, x1, y1 };
}

window.host.onOffset((o) => {
  offset = o;
  wrap.style.transform = o.x || o.y ? `translate(${o.x}px, ${o.y}px)` : '';
});

window.host.onMoveState((m) => {
  if ('retryAfter' in m) collisionPauseUntil = m.retryAfter;
  if (m.blocked) {
    blocked = m.blocked;
    if (!(moving && moving.follow) && ((blocked.left && dir < 0) || (blocked.right && dir > 0))) {
      dir = -dir;
      if (moving && moving.home) endMove();
    }
  }
  if (m.stop) endMove();
});

window.host.onRecoverMotion(() => {
  endMove();
  falling = dragging = sleeping = false;
  timed = forced = null;
  avoiding = null;
  blocked = {};
  collisionPauseUntil = 0;
  current.wanted = null;
  activity();
  reportRect();
});

window.host.onDuplicate(({ role, duration }) => {
  splitUntil = now() + duration;
  endMove();
  falling = sleeping = false;
  timed = forced = null;
  activity();
  splitAnimation?.cancel();
  const glow = 'brightness(1.9) drop-shadow(0 0 7px #fff7c2) drop-shadow(0 0 17px #a8eaff)';
  const frames = role === 'source' ? [
    { filter: 'none', transform: 'scale(1)', offset: 0 },
    { filter: glow, transform: 'scale(1.18, 0.94)', offset: 0.2 },
    { filter: glow, transform: 'scale(1.08, 1.04)', offset: 0.48 },
    { filter: 'none', transform: 'scale(1)', offset: 1 },
  ] : [
    { opacity: 0, filter: glow, transform: 'scale(0.55, 1.1)', offset: 0 },
    { opacity: 0.85, filter: glow, transform: 'scale(0.85, 1.05)', offset: 0.22 },
    { opacity: 1, filter: glow, transform: 'scale(1.06, 0.98)', offset: 0.6 },
    { opacity: 1, filter: 'none', transform: 'scale(1)', offset: 1 },
  ];
  splitAnimation = $('pet-host').animate(frames, { duration, easing: 'ease-in-out' });
});

// The host found text where this pet stands: huff, walk to a bare spot, wait there.
function walkAway() {
  const key = avoiding.fast && enabled('run') ? 'run' : enabled('walk') ? 'walk' : 'idle';
  startMove(key, { dir: avoiding.dir, host: true, duration: Infinity });
}

function cancelAvoid() {
  if (!avoiding) return;
  if (avoiding.phase === 'walk') endMove();
  avoiding = null;
  window.host.avoidCancel();
}

window.host.onAvoid((m) => {
  if (m.phase === 'release') {
    if (avoiding && avoiding.phase === 'walk') endMove();
    avoiding = null;
    return;
  }
  if (!inst || !manifest || isDisabled() || inst.asleep || inst.sitting) return;
  activity();
  sleeping = false;
  // a short line in the pet's own voice whenever it starts moving off (not on every later retarget)
  if (m.phase === 'notice' || (m.phase === 'walk' && (!avoiding || avoiding.phase === 'park'))) {
    showNotice(PetControls.avoidLine(manifest, m.kind, m.panic));
  }
  if (m.phase === 'notice') {
    endMove();
    forced = null;
    avoiding = { phase: 'notice', dir: m.dir, fast: !!m.fast };
    // nowhere bare to go: flail like a pet that has been picked up, then bolt
    if (m.panic) timed = { key: 'held', until: now() + (m.ms || 2400) };
    else react('shoo', 'shoo');
  } else if (m.phase === 'walk') {
    timed = null;
    avoiding = { phase: 'walk', dir: m.dir, fast: !!m.fast };
    walkAway();
  } else if (m.phase === 'park') {
    endMove();
    timed = null;
    avoiding = { phase: 'park' };
  }
});

window.host.onInteract((m) => {
  if (isDisabled() || !inst || inst.asleep || inst.sitting || inst.caged || inst.isCage) return;
  activity();
  sleeping = false;
  const key = { bump: 'bump', shoo: 'shoo', greet: 'greet' }[m.type];
  if (!key) return;
  if (m.type === 'bump') endMove();
  react(m.type === 'bump' ? 'bump' : 'random', key, { other: { dir: m.dir, distance: m.distance } });
});

window.host.onDance(({ duration }) => {
  if (!inst || !manifest || inst.visible === false || isDisabled() || inst.asleep || inst.sitting || sleeping ||
      inst.caged || inst.isCage ||
      !inst.behavior.social || inst.behavior.calm || !enabled('dance') || !has('dance') ||
      dragging || falling || forced || timed || avoiding || sessionStatus !== 'idle') return;
  endMove();
  activity();
  timed = { key: 'dance', until: now() + duration, groupDance: true };
  nextTrickAt = timed.until + 8000;
});

window.host.onFall((m) => {
  if (m.phase === 'start') falling = true;
  else {
    falling = false;
    react('drop', 'land');
  }
});

window.host.onPlay((key) => {
  if (inst && inst.sitting) return;
  activity();
  sleeping = false;
  if (manifest && manifest.animations[key] && manifest.animations[key].kind === 'movement') {
    forced = null;
    return startMove(key);
  }
  forced = { key, until: now() + (Cat.BY_KEY[key] && Cat.BY_KEY[key].loop ? 3500 : durationOf(key)) };
  current.wanted = null; // replay the sound even if it's the same animation
});

// ---------- sessions → speech bubble ----------

const titleOf = (s) => s.title || s.model || (link && link.name) || 'Agent';

window.host.onSessions((next) => {
  sessions = next;
  const top = sessions.find((s) => s.effective !== 'idle');
  const prev = sessionStatus;
  sessionStatus = top ? top.effective : 'idle';
  if (sessionStatus !== prev && sessionStatus !== 'idle') {
    if (sleeping) timed = { key: 'wake', until: now() + durationOf('wake') };
    sleeping = false;
    activity();
    if (moving) endMove();
  }
  render();
});

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  return Math.round(m / 60) + 'h';
}

function render() {
  if (!inst) return;
  const top = sessions.find((s) => s.effective !== 'idle');
  const t = now();
  const showNotice = notice && t < notice.until;
  const mode = PetControls.bubbleMode(inst);
  const show = !isDisabled() && mode !== 'off' && (showNotice || (top && mode === 'expanded'));
  if (show) {
    const kind = showNotice ? 'speech' : top.effective === 'thinking' ? 'thought' : top.effective === 'needs-you' ? 'shout' : 'speech';
    bubble.className = 'hit ' + kind + (!showNotice && top.effective === 'done' ? ' done-state' : '') + (bubbleDrag ? ' dragging' : '');
    // the model on top (when the title is the task), the task as the headline
    const eyebrow = showNotice ? '' : top.title && top.model ? top.model : '';
    bubble.querySelector('.eyebrow').textContent = eyebrow;
    bubble.querySelector('.bubble-title').textContent = showNotice ? PetControls.petName(inst, manifest) : titleOf(top);
    bubble.querySelector('.text').textContent = showNotice ? notice.text : top.effective === 'done' ? 'Finished' : top.detail || LABEL[top.effective];
    bubble.querySelector('.dot').className = 'dot ' + (showNotice ? 'needs-you' : top.effective);
    // "+N" counts other sessions that are still doing something, not idle ones
    const others = sessions.filter((s) => s !== top && s.effective !== 'idle').length;
    bubble.querySelector('.more').textContent = !showNotice && others ? '+' + others : '';
    bubble.dataset.session = top ? top.sessionId : '';
    bubble.title = [top && top.model, top && top.project, 'Click to open · drag to move'].filter(Boolean).join(' · ');
    if (bubble.hidden) {
      bubble.hidden = false;
      placeBubble();
    }
  } else {
    bubble.hidden = true;
  }
  const active = sessions.filter((s) => s.effective !== 'idle' && s.effective !== 'done');
  const needs = active.some((s) => s.effective === 'needs-you');
  badge.hidden = active.length === 0;
  badge.textContent = String(active.length);
  badge.classList.toggle('needs', needs);
  bar.classList.toggle('needs', needs);
  doneMark.hidden = isDisabled() || !sessions.some((s) => s.unseen);
  if (!list.hidden) renderList();
}

// Auto spot (up-right, flipping near screen edges like before) or the user's anchor,
// pushed back inside the screen when it would go off; it returns to the anchor once there's room.
let autoSide = { v: 'up', h: 'right' };
function placeBubble() {
  const pet = wrap.getBoundingClientRect();
  const barR = bar.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  let x;
  let y;
  if (inst && inst.bubble) {
    x = pet.left + inst.bubble.dx;
    y = pet.top + inst.bubble.dy;
  } else {
    const cx = (window.screenX + pet.left + pet.width / 2 - work.x) / work.width;
    const cy = (window.screenY + pet.top + pet.height / 2 - work.y) / work.height;
    autoSide = { v: cy < 0.38 ? 'down' : cy > 0.62 ? 'up' : autoSide.v, h: cx > 0.62 ? 'left' : cx < 0.38 ? 'right' : autoSide.h };
    if (autoSide.v === 'up') {
      x = autoSide.h === 'right' ? pet.right + 4 : pet.left - bw - 4;
      y = pet.top - bh * 0.25;
    } else {
      x = autoSide.h === 'right' ? pet.left : pet.right - bw;
      y = barR.bottom + 12;
    }
  }
  const box = workBox();
  x = Math.min(Math.max(x, box.x0), box.x1 - bw);
  y = Math.min(Math.max(y, box.y0), box.y1 - bh);
  bubble.style.left = Math.round(x) + 'px';
  bubble.style.top = Math.round(y) + 'px';
  aimTail(x, y, bw, bh, pet);
}

// Point the tail (or the thought puffs) at the pet.
function aimTail(x, y, bw, bh, pet) {
  const pcx = pet.left + pet.width / 2;
  const pcy = pet.top + pet.height * 0.45;
  let side = null;
  if (pcy > y + bh) side = 'b';
  else if (pcy < y) side = 't';
  else if (pcx < x) side = 'l';
  else if (pcx > x + bw) side = 'r';
  tail.className = 'tail' + (side ? ' on ' + side : '');
  for (const p of puffs) p.classList.toggle('on', !!side);
  if (!side) return;
  const clampX = Math.min(Math.max(pcx - x, 22), bw - 22);
  const clampY = Math.min(Math.max(pcy - y, 18), bh - 18);
  const T = 13;
  const pos = {
    b: [clampX - T / 2, bh - T / 2 - 1],
    t: [clampX - T / 2, -T / 2 + 1],
    l: [-T / 2 + 1, clampY - T / 2],
    r: [bw - T / 2 - 1, clampY - T / 2],
  }[side];
  tail.style.left = pos[0] + 'px';
  tail.style.top = pos[1] + 'px';
  // thought puffs drift from the edge toward the pet
  const ex = side === 'l' ? 0 : side === 'r' ? bw : clampX;
  const ey = side === 't' ? 0 : side === 'b' ? bh : clampY;
  const vx = pcx - (x + ex);
  const vy = pcy - (y + ey);
  const len = Math.hypot(vx, vy) || 1;
  [[12, 11], [26, 7]].forEach(([d, s], i) => {
    puffs[i].style.left = ex + (vx / len) * d - s / 2 + 'px';
    puffs[i].style.top = ey + (vy / len) * d - s / 2 + 'px';
  });
}

// drag the bubble; where it's dropped becomes its anchor
let bubbleDrag = null;
bubble.addEventListener('pointerdown', (e) => {
  // Capturing a child button's pointer retargets its click to the bubble,
  // preventing +N from opening the session list. Only capture bubble drags.
  if (e.button === 0 && !e.target.closest('.more')) captureMouse(bubble, e);
});
bubble.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.more')) return;
  const r = bubble.getBoundingClientRect();
  bubbleDrag = { sx: e.clientX, sy: e.clientY, gx: e.clientX - r.left, gy: e.clientY - r.top, moved: false };
  hold('drag');
});
bubble.addEventListener('lostpointercapture', cancelDrag);
bubble.addEventListener('pointercancel', () => { bubbleDrag = null; bubble.classList.remove('dragging'); letGo(); });
bubble.addEventListener('mousemove', (e) => {
  if (!bubbleDrag) return;
  if (!(e.buttons & 1)) return cancelDrag();
  if (!bubbleDrag.moved && Math.hypot(e.clientX - bubbleDrag.sx, e.clientY - bubbleDrag.sy) < 4) return;
  bubbleDrag.moved = true;
  bubble.classList.add('dragging');
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const box = workBox();
  const x = Math.min(Math.max(e.clientX - bubbleDrag.gx, box.x0), box.x1 - bw);
  const y = Math.min(Math.max(e.clientY - bubbleDrag.gy, box.y0), box.y1 - bh);
  bubble.style.left = x + 'px';
  bubble.style.top = y + 'px';
  aimTail(x, y, bw, bh, wrap.getBoundingClientRect());
});
bubble.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const d = bubbleDrag;
  bubbleDrag = null;
  bubble.classList.remove('dragging');
  if (!d) return;
  if (d.moved) {
    const pet = wrap.getBoundingClientRect();
    const r = bubble.getBoundingClientRect();
    inst.bubble = { dx: Math.round(r.left - pet.left), dy: Math.round(r.top - pet.top) };
    window.host.set('bubble', inst.bubble);
  } else {
    window.host.action('jump', { sessionId: bubble.dataset.session || undefined });
  }
  letGo();
});
bubble.querySelector('.more').addEventListener('click', () => toggleList());

// The check mark sits on the pet, so keep its press from starting a drag.
for (const type of ['pointerdown', 'mousedown']) doneMark.addEventListener(type, (e) => e.stopPropagation());
doneMark.addEventListener('click', () => {
  const s = sessions.find((x) => x.unseen);
  window.host.action('jump', s ? { sessionId: s.sessionId } : {});
});

// ---------- session list ----------

$('list-close').addEventListener('click', () => toggleList(false));

function renderList() {
  rows.textContent = '';
  list.querySelector('.list-title').textContent = link ? `${link.name} sessions` : 'Sessions';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sessions yet. Start one and your pet will follow along.';
    rows.append(empty);
    return;
  }
  for (const s of sessions.slice(0, 6)) {
    const row = document.createElement('button');
    row.className = 'row';
    row.innerHTML = '<span class="dot"></span><span class="row-text"><div class="row-title"></div><div class="row-sub"></div></span><span class="row-age"></span>';
    row.querySelector('.dot').className = 'dot ' + (s.state === 'done' ? 'done' : s.effective);
    row.querySelector('.row-title').textContent = s.title || s.project || 'Session';
    const sub = s.state === 'done' ? 'Finished' : s.effective === 'idle' ? LABEL.idle : s.detail;
    row.querySelector('.row-sub').textContent = [s.model, sub, s.project].filter(Boolean).join(' · ');
    row.querySelector('.row-age').textContent = ago(s.age);
    row.addEventListener('click', () => {
      window.host.action('jump', { sessionId: s.sessionId });
      toggleList(false);
    });
    rows.append(row);
  }
}

function placeList() {
  const anchor = (bubble.hidden ? wrap : bubble).getBoundingClientRect();
  const lw = list.offsetWidth;
  const lh = list.offsetHeight;
  const box = workBox();
  let y = anchor.bottom + 8;
  if (y + lh > box.y1) y = anchor.top - lh - 8;
  const x = Math.min(Math.max(anchor.left, box.x0), box.x1 - lw);
  list.style.left = Math.round(x) + 'px';
  list.style.top = Math.round(Math.max(box.y0, y)) + 'px';
}

function toggleList(open = list.hidden) {
  if (PetControls.bubbleMode(inst) === 'off') open = false;
  list.hidden = !open;
  if (open) {
    renderList();
    placeList();
  }
}

function showNotice(text) {
  notice = { text, until: now() + 4500 };
  render();
  setTimeout(render, 4600);
}
window.host.onNotice(showNotice);

// ---------- bar ----------

// what the two buttons are before the pet follows an agent (pressing one says so)
const DEFAULT_BUTTONS = [{ label: 'New chat', icon: 'compose' }, { label: 'New code session', icon: 'code' }];
const seps = bar.querySelectorAll('.sep');
let noButtons = false;

function renderButtons() {
  const following = inst && inst.harness;
  const list = following && link && link.buttons && link.buttons.length ? link.buttons : DEFAULT_BUTTONS;
  const slots = PetControls.buttons(inst);
  const off = slots.map((slot) => slot === null);
  for (const i of [0, 1]) {
    const el = $('b-' + i);
    const btn = list[slots[i] ?? i];
    el.hidden = off[i];
    el.innerHTML = PetIcons.svg(btn ? btn.icon : 'sparkle');
    el.title = !following ? `${btn ? btn.label : 'Button'} (pick an agent in Studio first)` : !link ? `${btn ? btn.label : 'Button'} (set up in Studio → Agents)` : btn ? btn.label : 'Not set up yet (Studio → Agents)';
    el.setAttribute('aria-label', el.title);
  }
  seps[0].hidden = off[0] || off[1];
  seps[1].hidden = off[0] && off[1];
  // with both buttons off only the small bar stays, as a reminder of where the pet lives
  noButtons = off[0] && off[1];
  $('b-bell').disabled = noButtons;
  bar.classList.toggle('no-buttons', noButtons);
  updateBar();
}

let barState = 'expanded';
let leftAt = 0;
function insidePetCol(pad = 10) {
  if (!cursor) return false;
  const r = col.getBoundingClientRect();
  return cursor.x >= r.left - pad && cursor.x <= r.right + pad && cursor.y >= r.top - pad && cursor.y <= r.bottom + pad;
}

function updateBar() {
  if (!inst) return;
  const t = now();
  const mode = PetControls.bubbleMode(inst);
  bar.hidden = mode === 'off';
  let next = 'expanded';
  if (noButtons) next = 'pill';
  else if (mode !== 'expanded') {
    if (insidePetCol() || dragging || !menuRoot.hidden) {
      leftAt = 0;
      next = 'mini';
    } else {
      if (!leftAt) leftAt = t;
      next = t - leftAt > 1200 ? 'pill' : 'mini';
    }
  }
  if (next !== barState) {
    bar.classList.remove(barState);
    bar.classList.add(next);
    barState = next;
  }

  const r = player.canvas && player.canvas.getBoundingClientRect();
  const over = !!(cursor && r && cursor.x >= r.left && cursor.x <= r.right && cursor.y >= r.top && cursor.y <= r.bottom);
  if (over && !wasOver && !inst.asleep && !isDisabled()) {
    activity();
    if (sleeping) {
      sleeping = false;
      timed = { key: 'wake', until: t + durationOf('wake') };
    } else if (t > hoverCooldown && !timed && !moving && sessionStatus === 'idle') {
      hoverCooldown = t + 8000;
      react('hover', 'hover');
    }
  }
  wasOver = over;
}

window.host.onCursor((p) => {
  cursor = p;
  updateBar();
});

// ---------- click-through ----------

// The window catches the mouse only over the pet, its bar and panels (the .hit
// elements). The main process hit-tests the cursor against the rects reported here,
// and while a drag or the menu holds the mouse, the whole window catches it.
let hitsSent = '';
function reportHits() {
  const rects = [];
  for (const el of document.querySelectorAll('.hit, .menu-panel')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue; // hidden
    const x = Math.floor(r.left);
    const y = Math.floor(r.top);
    rects.push({ x, y, w: Math.ceil(r.right) - x, h: Math.ceil(r.bottom) - y,
      menu: el.classList.contains('menu-panel') });
  }
  const key = JSON.stringify(rects);
  if (key === hitsSent) return;
  hitsSent = key;
  window.host.hits(rects);
}

let holding = null;
function hold(kind) {
  if (kind === holding) return;
  holding = kind;
  window.host.hold(kind);
}
function letGo() {
  if (holding === 'drag') hold(null);
}

function captureMouse(element, e) {
  // Native mouse handling must still work if Chromium has lost pointer capture.
  try { element.setPointerCapture(e.pointerId); } catch (err) {
    if (window.inputDiagnosticsInstalled) window.host.inputTrace({ type: 'capture-failed', message: err.message });
  }
}

function cancelDrag() {
  compatibilityButton = null;
  if (press || dragging) { clearTimeout(clickTimer); clickTimer = null; }
  if (dragging) window.host.dragEnd();
  press = null;
  dragging = false;
  bubbleDrag = null;
  document.body.classList.remove('dragging');
  bubble.classList.remove('dragging');
  letGo();
}

window.addEventListener('blur', cancelDrag);

// A button-up without its button-down means the press was dropped before it
// reached this page (see reviveInput in lib/pet-host.js); the main process then
// repairs the window so the next press lands.
const pressedButtons = new Set();
for (const type of ['pointerdown', 'mousedown']) document.addEventListener(type, (e) => pressedButtons.add(e.button), true);
document.addEventListener('mouseup', (e) => {
  if (!pressedButtons.delete(e.button)) window.host.inputLost(e.button);
}, true);

// ---------- drag the pet (it resists), click, double-click ----------

let press = null;
let clickTimer = null;
let compatibilityButton = null;

wrap.addEventListener('pointerdown', (e) => {
  if (e.button === 0) captureMouse(wrap, e);
  // Canceled pointer events can suppress compatibility mouse events. Support
  // both paths, with mousedown retained for button chords and stale state.
  if (Number.isFinite(e.screenX) && Number.isFinite(e.screenY)) {
    compatibilityButton = e.button;
    petPress(e);
  }
});
// Mouse buttons are independent: unlike pointerdown, mousedown also fires when
// Chromium believes a different button is already down (including stale state).
wrap.addEventListener('mousedown', (e) => {
  if (compatibilityButton === e.button) { compatibilityButton = null; return; }
  petPress(e);
});
function petPress(e) {
  if (e.button === 1) {
    e.preventDefault();
    activity();
    menuAt = { x: e.clientX, y: e.clientY };
    window.host.menu();
    return;
  }
  if (e.button !== 0) return;
  cancelAvoid();
  clearTimeout(clickTimer);
  // Keep the timer's marker for double-click detection until release.
  press = { x: e.screenX, y: e.screenY };
  hold('drag');
}
wrap.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
wrap.addEventListener('lostpointercapture', cancelDrag);
wrap.addEventListener('pointercancel', cancelDrag);
function petMove(e) {
  if (!press) return;
  if (!(e.buttons & 1)) return cancelDrag();
  if (!dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    clickTimer = null;
    dragging = true;
    sleeping = false;
    if (inst.asleep) window.host.set('asleep', false); // moving it wakes it
    if (inst.sitting) window.host.set('sitting', false); // moving it wakes it
    endMove();
    document.body.classList.add('dragging');
    toggleList(false);
    window.host.dragStart(press.x, press.y);
  }
  if (dragging) window.host.dragMove(e.screenX, e.screenY);
}
document.addEventListener('pointermove', petMove);
document.addEventListener('mousemove', petMove);
function petRelease(e) {
  compatibilityButton = null;
  if (e.button !== 0) return;
  if (dragging) {
    window.host.dragEnd();
  } else if (press) {
    if (inst.asleep) {
      window.host.set('asleep', false); // a click wakes it instead of opening anything
    } else if (inst.sitting) {
      window.host.set('sitting', false); // a click wakes it instead of opening anything
    } else if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      if (e.ctrlKey) window.host.refresh();
      else react('poke', 'poke');
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
      }, 260);
    }
  }
  activity();
  press = null;
  dragging = false;
  document.body.classList.remove('dragging');
  letGo();
}
document.addEventListener('pointerup', petRelease);
document.addEventListener('mouseup', petRelease);
document.addEventListener('pointercancel', cancelDrag);

// ---------- size: Ctrl + mouse wheel ----------

let hudTimer = null;
function changeSize(delta) {
  if (!inst) return;
  const next = Math.max(0.25, Math.min(4, Math.round((inst.size + delta) * 100) / 100));
  if (next === inst.size) return;
  activity();
  sleeping = false;
  const key = delta > 0 ? 'grow' : 'shrink';
  if (!inst.asleep && !inst.sitting && !isDisabled()) timed = { key, until: now() + durationOf(key) };
  window.host.set('size', next);
  hud.hidden = false;
  hud.className = delta > 0 ? 'up' : 'down';
  hud.querySelector('span').textContent = Math.round(next * 100) + '%';
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => (hud.hidden = true), 1100);
}
wrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  changeSize(e.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

// Any other wheel goes through the pet to whatever is underneath (pets only catch
// left and right clicks): the host makes the window click-through for a moment.
// The sessions list keeps its own scrolling.
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey && e.target.closest('#pet-wrap')) return;
  if (e.target.closest('#list') && list.scrollHeight > list.clientHeight) return;
  if (e.target.closest('.menu-panel')) return;
  e.preventDefault();
  window.host.passWheel({ dy: e.deltaY, dx: e.deltaX });
}, { passive: false });
window.host.onSizeStep(changeSize);

// ---------- buttons ----------

$('b-0').addEventListener('click', () => window.host.action('button', { index: 0 }));
$('b-1').addEventListener('click', () => window.host.action('button', { index: 1 }));
$('b-min').addEventListener('click', () => window.host.set('barMode', 'mini'));
$('b-bell').addEventListener('click', () => { if (!noButtons) window.host.set('barMode', 'expanded'); });
bar.addEventListener('click', () => {
  if (barState !== 'pill') return;
  if (!noButtons) window.host.set('barMode', 'expanded');
});

// ---------- right-click menu (drawn here, actions run in the main process) ----------

let menuAt = { x: 0, y: 0 };
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('#pet-wrap')) {
    cancelAvoid();
    shoo(e.clientX);
  }
});

// Right-click is the "bad" click, like shooing a cat: the pet huffs and, if it is
// allowed to move, scampers away from the cursor. (Left-click is the friendly one.)
function shoo(fromX) {
  if (!inst || !manifest || isDisabled() || dismissing) return;
  activity();
  if (inst.asleep) return window.host.set('asleep', false);
  if (inst.sitting) return window.host.set('sitting', false);
  sleeping = false;
  const b = inst.behavior;
  const runKey = enabled('run') ? 'run' : enabled('walk') ? 'walk' : null;
  if (runKey && b.wander && !b.calm && !dragging && !falling) {
    const r = player.canvas.getBoundingClientRect();
    timed = null;
    startMove(runKey, { dir: fromX < r.left + r.width / 2 ? 1 : -1, duration: 900 });
    fleeCooldown = now() + 1500;
    sound('shoo');
  } else {
    react('shoo', 'shoo');
  }
}

// Pressing a button before the pet follows an agent: it refuses, grumpily.
window.host.onRefuse((text) => {
  if (!inst || dismissing) return;
  activity();
  sleeping = false;
  endMove();
  forced = { key: enabled('shoo') ? 'shoo' : 'bump', until: now() + Math.max(1200, durationOf('shoo')) };
  showNotice(text);
});

window.host.onMenuOpen(({ items }) => {
  cancelDrag();
  endMove();
  menuRoot.textContent = '';
  menuRoot.hidden = false;
  openPanel(items, menuAt.x, menuAt.y, 0);
  reportHits();
});
window.host.onMenuClose(() => closeMenu());

function closeMenu() {
  if (menuRoot.hidden) return;
  menuRoot.textContent = '';
  menuRoot.hidden = true;
  if (holding === 'menu') hold(null);
  reportHits();
  window.host.menuClosed();
}

menuRoot.addEventListener('mousedown', (e) => {
  if (e.target === menuRoot) closeMenu();
});
document.addEventListener('mousedown', (e) => {
  window.host.interaction();
  if (!menuRoot.hidden && !e.target.closest('#menu')) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    toggleList(false);
    return;
  }
  if (!menuRoot.hidden && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    const rows = [...menuRoot.querySelectorAll('.mi:not(.disabled)')];
    let match = rows.find((r) => r.dataset.accelerator && r.dataset.accelerator.trim().toLowerCase() === k);
    if (!match && k === 'z') {
      match = rows.find((r) => {
        const t = r.textContent.toLowerCase();
        return t.includes('put to sleep') || t.includes('wake up');
      });
    }
    if (!match && k === 's') {
      match = rows.find((r) => {
        const t = r.textContent.toLowerCase();
        return t.includes('put to sit') || t.includes('stand up');
      });
    }
    if (match) {
      e.preventDefault();
      match.click();
    }
  }
});

function openPanel(items, x, y, level, parentRow) {
  for (const p of [...menuRoot.querySelectorAll('.menu-panel')]) if (Number(p.dataset.level) >= level) p.remove();
  // The opener lives one level above its panel. Clear its siblings as well as
  // deeper openers, preserving only ancestors in the current submenu path.
  for (const r of menuRoot.querySelectorAll('.mi.open')) if (Number(r.dataset.level) >= level - 1) r.classList.remove('open');
  // A delayed hover from a closed menu must never recreate an invisible panel.
  if (menuRoot.hidden || (parentRow && !parentRow.isConnected)) return;
  if (parentRow) parentRow.classList.add('open');

  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.dataset.level = level;
  let hoverTimer = null;
  for (const it of items) {
    if (it.type === 'separator') {
      panel.append(Object.assign(document.createElement('div'), { className: 'ms' }));
      continue;
    }
    if (it.type === 'header') {
      panel.append(Object.assign(document.createElement('div'), { className: 'mh', textContent: it.label }));
      continue;
    }
    if (it.type === 'slider') {
      const row = document.createElement('label');
      row.className = 'mslide';
      const fmt = (v) => (it.format === '%' ? Math.round(v) + '%' : it.format === 'x' ? Number(v).toFixed(1) + '×' : String(v));
      const out = document.createElement('output');
      out.textContent = fmt(it.value);
      const input = Object.assign(document.createElement('input'), { type: 'range', min: it.min, max: it.max, step: it.step, value: it.value });
      let last = 0;
      input.addEventListener('input', () => {
        out.textContent = fmt(input.value);
        if (now() - last > 120) {
          last = now();
          window.host.menuSlide(it.id, Number(input.value));
        }
      });
      input.addEventListener('change', () => window.host.menuSlide(it.id, Number(input.value)));
      row.append(Object.assign(document.createElement('span'), { textContent: it.label }), out, input);
      panel.append(row);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'mi' + (it.enabled ? '' : ' disabled');
    row.dataset.level = level;
    row.dataset.id = it.id;
    if (it.accelerator) row.dataset.accelerator = it.accelerator;
    const mark = it.type === 'checkbox' ? (it.checked ? '✓' : '') : it.type === 'radio' ? (it.checked ? '●' : '') : '';
    row.innerHTML = '<span class="ck"></span><span class="lb"></span><span class="ac"></span><span class="ar"></span>';
    row.querySelector('.ck').textContent = mark;
    row.querySelector('.lb').textContent = it.label;
    if (it.sublabel) row.querySelector('.lb').append(Object.assign(document.createElement('small'), { textContent: it.sublabel }));
    row.querySelector('.ac').textContent = it.accelerator || '';
    row.querySelector('.ar').textContent = it.type === 'submenu' ? '›' : '';
    row.addEventListener('mouseenter', () => {
      for (const sibling of panel.querySelectorAll('.mi.open')) if (sibling !== row) sibling.classList.remove('open');
    });
    if (it.enabled) {
      if (it.type === 'submenu') {
        const open = () => {
          const r = row.getBoundingClientRect();
          const pr = panel.getBoundingClientRect();
          openPanel(it.submenu, pr.right - 4, r.top - 6, level + 1, row);
        };
        row.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(open, 110);
        });
        row.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
        row.addEventListener('click', open);
      } else {
        row.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => openPanel([], 0, 0, level + 1), 160); // close deeper panels
        });
        row.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
        row.addEventListener('click', () => {
          window.host.menuClick(it.id);
          closeMenu();
        });
      }
    }
    panel.append(row);
  }
  if (!panel.childElementCount) { reportHits(); return; }
  menuRoot.append(panel);

  // keep the panel on screen: flip submenus to the left, shift up, scroll if tall
  const box = workBox(4);
  panel.style.maxHeight = Math.max(160, box.y1 - box.y0) + 'px';
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  let px = x;
  if (px + w > box.x1) px = level && parentRow ? parentRow.getBoundingClientRect().left - w + 4 : box.x1 - w;
  px = Math.max(box.x0, px);
  const py = Math.max(box.y0, Math.min(y, box.y1 - h));
  panel.style.left = px + 'px';
  panel.style.top = py + 'px';
  reportHits();
}

// ---------- dismissed: vanish in a puff of smoke ----------

const SMOKE_MS = 2500;
let dismissing = false;

window.host.onDismiss(() => {
  if (dismissing) return;
  dismissing = true;
  moving = timed = forced = null;
  clearInterval(loopTimer);
  closeMenu();
  toggleList(false);
  // the first frame of smoke is drawn before the pet is hidden, in the same task,
  // so there is never a frame with neither
  smoke(wrap.getBoundingClientRect());
  document.body.classList.add('dismissed');
  poof();
});

function poof() {
  if (!inst || inst.visible === false || globals.muteAll || inst.sound.muted || isDisabled() || inst.sound.volume <= 0) return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    PetSounds.play(audio, PetSounds.SOUNDS.poof, Math.min(1, inst.sound.volume * 1.5));
  } catch {}
}

// "Only show with its agent": arrive and leave in a puff of smoke. The host hides
// the window once the smoke has cleared.
let leaving = false;
window.host.onPresence(({ phase }) => {
  if (dismissing) return;
  if (phase === 'appear') {
    leaving = false;
    document.body.classList.remove('dismissed');
    requestAnimationFrame(() => smoke(wrap.getBoundingClientRect(), () => {}));
  } else if (phase === 'leave') {
    leaving = true;
    moving = timed = forced = null;
    clearInterval(loopTimer);
    closeMenu();
    toggleList(false);
    smoke(wrap.getBoundingClientRect(), () => { if (leaving) window.host.left(); });
    document.body.classList.add('dismissed');
    poof();
  } else if (phase === 'cancel') {
    leaving = false;
    document.body.classList.remove('dismissed');
  }
});

function smoke(r, done = () => window.host.dismissed()) {
  const c = document.createElement('canvas');
  c.id = 'smoke';
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(window.innerWidth * dpr);
  c.height = Math.round(window.innerHeight * dpr);
  document.body.append(c);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);

  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const S = Math.max(r.width, r.height, 40);
  const puffs = [];
  const add = (x, y, rad) => {
    const dx = x - cx || rand(-1, 1);
    const dy = y - cy || rand(-1, 1);
    const len = Math.hypot(dx, dy) || 1;
    const dist = S * rand(0.3, 0.75);
    puffs.push({
      x, y, r: rad,
      tx: (dx / len) * dist + rand(-0.1, 0.1) * S,
      ty: (dy / len) * dist * 0.7 - S * rand(0.15, 0.4), // smoke rises as it spreads
      grow: rand(0.5, 0.9),
      fade: rand(1.3, 1.9),
      tone: rand(0, 1),
    });
  };
  // A 3x3 grid of puffs, each with radius >= half the pet's longer side: every point of
  // the pet is inside one of them, so the very first frame covers it completely.
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) add(r.left + (r.width * i) / 2, r.top + (r.height * j) / 2, S * rand(0.5, 0.58));
  // a billowy outer ring
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2 + rand(-0.2, 0.2);
    add(cx + Math.cos(a) * S * 0.7, cy + Math.sin(a) * S * 0.6, S * rand(0.28, 0.42));
  }
  puffs.sort((p, q) => p.tone - q.tone); // darker puffs behind lighter ones

  const start = now();
  const draw = () => {
    const p = Math.min(1, (now() - start) / SMOKE_MS);
    const ease = 1 - Math.pow(1 - p, 3);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const f of puffs) {
      const alpha = 0.97 * Math.pow(1 - p, f.fade);
      if (alpha < 0.005) continue;
      const x = f.x + f.tx * ease;
      const y = f.y + f.ty * ease;
      const rad = f.r * (1 + f.grow * ease);
      const light = Math.round(222 + f.tone * 26);
      const grad = g.createRadialGradient(x - rad * 0.25, y - rad * 0.3, rad * 0.1, x, y, rad);
      grad.addColorStop(0, `rgba(${light}, ${light}, ${light + 4}, ${alpha})`);
      grad.addColorStop(0.7, `rgba(${light - 30}, ${light - 30}, ${light - 24}, ${alpha * 0.95})`);
      grad.addColorStop(1, `rgba(${light - 60}, ${light - 60}, ${light - 52}, 0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    if (p < 1) return requestAnimationFrame(draw);
    c.remove();
    done();
  };
  draw();
}
