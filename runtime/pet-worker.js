// Runs one pet's code in a Web Worker: no DOM, no Node, and network APIs removed
// before the pet code is evaluated. The pet can only draw on its canvas and
// suggest how it wants to move; the host decides what actually happens.

importScripts('../shared/catalog.js', '../shared/pet-schema.js');

// Private protocol state must be outside the global scope visible to pet code.
(() => {

const BLOCKED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker',
  'indexedDB', 'caches', 'BroadcastChannel', 'WebTransport', 'RTCPeerConnection'];

const rawPostMessage = (typeof postMessage === 'function' ? postMessage : self.postMessage).bind(self);
let privatePort = null;
let send = rawPostMessage;
const validate = PetSchema.validate;
const makeGraphics = PetSchema.makeGraphics;

let pet = null;
let manifest = null;
let g = null;
let failed = new Set();

function lockdown() {
  const scopes = new Set();
  try {
    for (let p = self; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      scopes.add(p);
    }
  } catch {}
  if (typeof DedicatedWorkerGlobalScope !== 'undefined' && DedicatedWorkerGlobalScope.prototype) {
    scopes.add(DedicatedWorkerGlobalScope.prototype);
  }
  if (typeof WorkerGlobalScope !== 'undefined' && WorkerGlobalScope.prototype) {
    scopes.add(WorkerGlobalScope.prototype);
  }
  if (typeof globalThis !== 'undefined' && globalThis) {
    scopes.add(globalThis);
  }

  for (const scope of scopes) {
    for (const name of BLOCKED) {
      try { delete scope[name]; } catch {}
      try { Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false }); } catch {}
    }
  }

  if (typeof navigator !== 'undefined' && navigator) {
    try { delete navigator.sendBeacon; Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: false, writable: false }); } catch {}
    try {
      const navProto = Object.getPrototypeOf(navigator);
      if (navProto && navProto !== Object.prototype) {
        delete navProto.sendBeacon;
        Object.defineProperty(navProto, 'sendBeacon', { value: undefined, configurable: false, writable: false });
      }
    } catch {}
  }

  for (const scope of scopes) {
    try {
      Object.defineProperty(scope, 'postMessage', { value: rawPostMessage, configurable: false, writable: false });
    } catch {}
  }
}

lockdown();

function load(code) {
  let def = null;
  const definePet = (d) => {
    if (def) throw new Error('definePet() was called more than once');
    def = d;
  };
  lockdown();
  new Function('definePet', '"use strict";\n' + code)(definePet);
  if (!def) throw new Error('The file never called definePet({...})');
  const r = validate(def);
  if (r.errors.length) throw new Error(r.errors.join('\n'));
  pet = def;
  manifest = r.manifest;
  return r;
}

function frame(m) {
  if (!pet || !g) return;
  const canvas = g.ctx.canvas;
  if (canvas.width !== manifest.canvas.width) canvas.width = manifest.canvas.width;
  if (canvas.height !== manifest.canvas.height) canvas.height = manifest.canvas.height;
  const anim = pet.animations[m.anim] && !failed.has(m.anim) ? pet.animations[m.anim] : pet.animations.idle;
  const ctx = {
    t: m.t,
    dt: m.dt,
    frame: m.frame,
    params: m.params || {},
    look: m.look || { x: 0, y: 0 },
    dir: m.dir || 1,
    speed: m.speed || 1,
    size: m.size || 1,
    state: m.state || {},
    other: m.other || null,
    blocked: m.blocked || {},
    home: m.home || { dx: 0, dy: 0 },
    seed: m.seed || 1,
    noise: (i) => PetSchema.noise(m.seed || 1, i),
    fallWhenDropped: !!(m.fallWhenDropped || (m.behavior && m.behavior.fallWhenDropped)),
    behavior: m.behavior || null,
  };
  g.ctx.setTransform(1, 0, 0, 1, 0, 0);
  g.ctx.globalAlpha = 1;
  g.clear();
  const fx = PetSchema.effectTransform(m.effect, m.t);
  if (fx) {
    const h = manifest.canvas.height;
    g.ctx.setTransform(1, 0, 0, fx.sy, fx.dx, fx.dy + h * (1 - fx.sy));
  }
  try {
    anim.draw(g, ctx);
    if (m.wantMove && typeof anim.move === 'function') {
      const v = anim.move(ctx);
      const ok = v && Number.isFinite(v.vx) && Number.isFinite(v.vy);
      send({ type: 'move', vx: ok ? v.vx : 0, vy: ok ? v.vy : 0, done: v === null });
    }
  } catch (err) {
    failed.add(m.anim);
    send({ type: 'draw-error', anim: m.anim, message: String((err && err.message) || err).slice(0, 500) });
  }
}

const receive = (e) => {
  const m = e.data;
  if (m.type === 'canvas') {
    if (g) return;
    g = makeGraphics(m.canvas.getContext('2d'));
    if (m.port) {
      privatePort = m.port;
      send = privatePort.postMessage.bind(privatePort);
      privatePort.onmessage = receive;
      // No further host messages go through the pet-visible global endpoint.
      self.onmessage = null;
    }
  } else if (m.type === 'load') {
    try {
      const r = load(m.code);
      send({ type: 'loaded', manifest: r.manifest, warnings: r.warnings });
    } catch (err) {
      send({ type: 'error', message: String((err && err.message) || err).slice(0, 500) });
    }
  } else if (m.type === 'frame') {
    frame(m);
    send({ type: 'frame-done', frame: m.frame });
  }
};
self.onmessage = receive;
})();
