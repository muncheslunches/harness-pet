// Validates a pet definition (the object a .pet.js file passes to definePet) and
// turns it into a plain manifest the host can reason about. Works in Node and browsers.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'));
  else root.PetSchema = factory(root.PetCatalog);
})(typeof self !== 'undefined' ? self : this, function (Catalog) {
  const TRIGGERS = ['hover', 'poke', 'drop', 'bump', 'random'];
  // what a pet says when it gets out of the way of text: while you type, when you tell it to, when there is no room
  const LINE_KEYS = ['dodge', 'command', 'panic'];
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

  function validate(def) {
    const errors = [];
    const warnings = [];
    if (!def || typeof def !== 'object') return { errors: ['definePet() must be called with an object'], warnings, manifest: null };

    if (def.format !== 1) errors.push('format must be 1');
    if (typeof def.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(def.id)) errors.push('id must be 2–41 chars of a-z, 0-9 and "-"');
    if (typeof def.name !== 'string' || !def.name.trim()) errors.push('name is required');
    const canvas = def.canvas || {};
    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 8 || canvas.height < 8 || canvas.width > 512 || canvas.height > 512) {
      errors.push('canvas.width and canvas.height must be whole numbers between 8 and 512');
    }
    const scale = def.scale === undefined ? 4 : def.scale;
    if (!isNum(scale) || scale < 0.25 || scale > 20) errors.push('scale must be a number between 0.25 and 20');

    const anims = def.animations || {};
    if (!anims.idle) errors.push('animations.idle is required');

    const out = {};
    for (const [key, a] of Object.entries(anims)) {
      const where = `animations.${key}`;
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key)) { errors.push(`${where}: names must be camelCase letters and digits`); continue; }
      if (!a || typeof a.draw !== 'function') { errors.push(`${where}.draw must be a function`); continue; }
      const std = Catalog.BY_KEY[key];
      const kind = std ? std.kind : a.kind;
      if (!Catalog.KINDS.includes(kind)) { errors.push(`${where}.kind must be one of ${Catalog.KINDS.join(', ')} (custom animations need a kind)`); continue; }
      if (std && a.kind && a.kind !== std.kind) warnings.push(`${where}.kind is ignored; standard animation "${key}" is always "${std.kind}"`);
      if (a.move !== undefined && typeof a.move !== 'function') errors.push(`${where}.move must be a function`);
      if (kind === 'movement' && typeof a.move !== 'function') errors.push(`${where}: movement animations need move(ctx)`);
      const loop = std ? !!std.loop : !!a.loop;
      let duration = a.duration !== undefined ? a.duration : std && std.duration;
      if (duration !== undefined && (!isNum(duration) || duration < 100 || duration > 120000)) {
        errors.push(`${where}.duration must be 100–120000 ms`);
        duration = undefined;
      }
      if (!loop && duration === undefined && kind !== 'status' && kind !== 'rest') {
        if (kind === 'movement') duration = 4000;
        else errors.push(`${where}.duration is required for ${kind} animations`);
      }
      const params = {};
      for (const [pk, p] of Object.entries(a.params || {})) {
        if (!p || !isNum(p.min) || !isNum(p.max) || !isNum(p.default) || p.min >= p.max || p.default < p.min || p.default > p.max) {
          errors.push(`${where}.params.${pk} needs numeric min < max and a default between them`);
          continue;
        }
        params[pk] = { label: String(p.label || pk), min: p.min, max: p.max, step: isNum(p.step) ? p.step : (p.max - p.min) / 20, default: p.default };
      }
      let trigger = a.trigger;
      if (!std && kind === 'reaction') {
        if (!TRIGGERS.includes(trigger)) { warnings.push(`${where}.trigger should be one of ${TRIGGERS.join(', ')}; using "random"`); trigger = 'random'; }
      }
      if (a.sound !== undefined && typeof a.sound !== 'string') warnings.push(`${where}.sound should be the name of a sound`);
      out[key] = {
        enabled: key === 'idle' || (a.enabled !== false && !(Array.isArray(def.disabledAnimations) && def.disabledAnimations.includes(key))),
        sound: typeof a.sound === 'string' ? a.sound : undefined,
        label: String(a.label || (std && std.label) || key),
        kind,
        standard: !!std,
        loop,
        duration,
        params,
        trigger: std ? undefined : trigger,
        moves: typeof a.move === 'function',
        description: typeof a.description === 'string' ? a.description : std ? std.spec : '',
      };
    }

    // Optional pet-defined sounds: plain data recipes (see shared/sounds.js).
    const sounds = {};
    for (const [sk, r] of Object.entries(def.sounds || {})) {
      const ok = r && Array.isArray(r.parts) && r.parts.length && r.parts.length <= 12 &&
        r.parts.every((p) => p && isNum(p.f) && p.f > 10 && p.f < 20000 && isNum(p.dur) && p.dur > 0 && p.dur <= 3);
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(sk) || !ok) { warnings.push(`sounds.${sk} is not a valid sound recipe; ignored`); continue; }
      sounds[sk] = {
        label: String(r.label || sk),
        repeatMs: isNum(r.repeatMs) && r.repeatMs >= 60 ? r.repeatMs : undefined,
        parts: r.parts.map((p) => ({ wave: String(p.wave || 'sine'), f: p.f, to: isNum(p.to) ? p.to : undefined, at: isNum(p.at) ? p.at : 0, dur: p.dur, gain: isNum(p.gain) ? p.gain : 0.4, q: isNum(p.q) ? p.q : undefined })),
      };
    }

    // Optional lines for the speech bubble, in the pet's own voice (short ones read best).
    const lines = {};
    if (def.lines !== undefined && (!def.lines || typeof def.lines !== 'object')) warnings.push('lines should be an object of arrays of short strings; ignored');
    else {
      for (const key of LINE_KEYS) {
        const list = def.lines && def.lines[key];
        if (list === undefined) continue;
        const kept = Array.isArray(list) ? list.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 60)).slice(0, 10) : [];
        if (kept.length) lines[key] = kept;
        else warnings.push(`lines.${key} should be an array of short strings; ignored`);
      }
    }

    const missing = Catalog.CATALOG.filter((c) => !out[c.key]).map((c) => c.key);
    const custom = Object.keys(out).filter((k) => !out[k].standard);
    const manifest = {
      format: 1,
      id: def.id,
      name: def.name,
      author: typeof def.author === 'string' ? def.author : '',
      version: typeof def.version === 'string' ? def.version : '1.0.0',
      description: typeof def.description === 'string' ? def.description : '',
      canvas: { width: canvas.width, height: canvas.height },
      scale,
      groundY: Number.isInteger(def.groundY) ? def.groundY : canvas.height,
      animations: out,
      sounds,
      lines,
      missing,
      custom,
    };
    return { errors, warnings, manifest };
  }

  // Deterministic noise in [0, 1) so particles stay stable frame to frame.
  function noise(seed, i) {
    let h = (seed ^ Math.imul(i + 0x9e3779b9, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // A tiny pixel-drawing helper over a 2D canvas context; this is the `g` pets draw with.
  function makeGraphics(c) {
    return {
      ctx: c,
      get width() { return c.canvas.width; },
      get height() { return c.canvas.height; },
      clear() { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, c.canvas.width, c.canvas.height); c.restore(); },
      px(x, y, color) { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), 1, 1); },
      rect(x, y, w, h, color) { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); },
      pixels(list, color, dx = 0, dy = 0) {
        for (const p of list) { c.fillStyle = p[2] || color; c.fillRect(Math.round(p[0] + dx), Math.round(p[1] + dy), 1, 1); }
      },
      ellipse(cx, cy, rx, ry, color) { c.fillStyle = color; c.beginPath(); c.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2); c.fill(); },
      save() { c.save(); },
      restore() { c.restore(); },
      clip(x, y, w, h) { c.beginPath(); c.rect(x, y, w, h); c.clip(); },
      alpha(a) { c.globalAlpha = a; },
    };
  }

  // Host-side effects for fallback animations, in pet pixels.
  function effectTransform(effect, t) {
    switch (effect) {
      case 'bob': return { dx: 0, dy: Math.floor(t / 450) % 2, sy: 1 };
      case 'hop': return { dx: 0, dy: [0, -2, -3, -2, 0, 0, 0][Math.floor(t / 90) % 7], sy: 1 };
      case 'shake': return { dx: Math.floor(t / 70) % 2 ? 1 : -1, dy: 0, sy: 1 };
      case 'squash': return { dx: 0, dy: 0, sy: t < 300 ? 0.85 : 1 };
      default: return null;
    }
  }

  return { validate, noise, makeGraphics, effectTransform, TRIGGERS };
});
