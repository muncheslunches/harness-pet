// Browser-side wrapper around a sandboxed pet worker. Used by the pet window and
// the Studio preview. Each load gets a fresh canvas + worker, so a pet can be
// hot-reloaded when its file changes.

class PetPlayer {
  constructor(host, { workerUrl = '../runtime/pet-worker.js', loadTimeoutMs = 5000, frameTimeoutMs = 2000 } = {}) {
    this.host = host; // element the canvas lives in
    this.workerUrl = workerUrl;
    this.manifest = null;
    this.worker = null;
    this.canvas = null;
    this.onMove = null;
    this.onDrawError = null;
    this.frameNo = 0;
    this.pendingLoad = null;
    this.loadTimeoutMs = loadTimeoutMs;
    this.frameTimeoutMs = frameTimeoutMs;
    this.onFailure = null;
    this.framePending = null;
    this.port = null;
  }

  load(code) {
    this.cancelLoad();
    if (typeof code !== 'string' || code.length > 1024 * 1024) return Promise.reject(new Error('Pet code must be under 1 MB'));
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.className = 'pet-canvas';
      const worker = new Worker(this.workerUrl);
      const channel = new MessageChannel();
      const port = channel.port1;
      const fail = (error) => {
        if (this.pendingLoad?.worker !== worker) return;
        clearTimeout(this.pendingLoad.timer);
        this.pendingLoad = null;
        worker.terminate();
        port.close();
        reject(error);
      };
      this.pendingLoad = { worker, port, reject, timer: setTimeout(() => fail(new Error('Pet load timed out. Fix the pet or choose another in Studio.')), this.loadTimeoutMs) };
      port.onmessage = (e) => {
        if (this.pendingLoad?.worker !== worker) return;
        const m = e.data || {};
        if (m.type === 'loaded') {
          if (!this.validManifest(m.manifest)) return fail(new Error('Invalid pet manifest'));
          clearTimeout(this.pendingLoad.timer);
          this.pendingLoad = null;
          if (this.worker) this.worker.terminate();
          this.port?.close();
          clearTimeout(this.framePending?.timer);
          this.framePending = null;
          if (this.canvas) this.canvas.replaceWith(canvas);
          else this.host.append(canvas);
          this.worker = worker;
          this.port = port;
          this.canvas = canvas;
          this.manifest = m.manifest;
          port.onmessage = (ev) => this.message(ev.data || {});
          this.resize(this.size || 1);
          resolve({ manifest: m.manifest, warnings: Array.isArray(m.warnings) ? m.warnings.slice(0, 100) : [] });
        } else if (m.type === 'error') {
          fail(new Error(String(m.message).slice(0, 500)));
        }
      };
      worker.onerror = (err) => {
        if (this.pendingLoad?.worker === worker) fail(new Error(err.message || 'The pet failed to load'));
        else if (this.worker === worker) this.failWorker('The pet worker stopped. Refresh or remove it in Studio.');
      };
      try {
        const offscreen = canvas.transferControlToOffscreen();
        worker.postMessage({ type: 'canvas', canvas: offscreen, port: channel.port2 }, [offscreen, channel.port2]);
        port.postMessage({ type: 'load', code });
      } catch { fail(new Error('The pet worker could not be started')); }
    });
  }

  validManifest(m) {
    return m && typeof m.name === 'string' && m.name.length <= 200 && m.canvas &&
      [m.canvas.width, m.canvas.height].every(n => Number.isInteger(n) && n >= 8 && n <= 512) && Number.isFinite(m.scale) && m.scale >= 0.25 && m.scale <= 20 &&
      m.animations && typeof m.animations === 'object' && m.animations.idle;
  }

  failWorker(message) {
    clearTimeout(this.framePending?.timer);
    this.framePending = null;
    this.worker?.terminate();
    this.port?.close();
    this.worker = this.port = null;
    this.onFailure?.(new Error(message));
  }

  message(m) {
    if (m.type === 'frame-done' && this.framePending?.id === m.frame) {
      clearTimeout(this.framePending.timer);
      this.framePending = null;
    } else if (m.type === 'move' && Number.isFinite(m.vx) && Number.isFinite(m.vy) && this.onMove) this.onMove({ ...m, vx: Math.max(-10000, Math.min(10000, m.vx)), vy: Math.max(-10000, Math.min(10000, m.vy)) });
    else if (m.type === 'draw-error' && this.onDrawError) this.onDrawError({ anim: String(m.anim).slice(0, 41), message: String(m.message).slice(0, 500) });
  }

  // On-screen size: pet pixels × pet scale × user size.
  resize(size) {
    this.size = size;
    if (!this.canvas || !this.manifest) return;
    const k = this.manifest.scale * size;
    this.canvas.style.width = Math.round(this.manifest.canvas.width * k) + 'px';
    this.canvas.style.height = Math.round(this.manifest.canvas.height * k) + 'px';
  }

  get displaySize() {
    if (!this.manifest) return { w: 0, h: 0 };
    const k = this.manifest.scale * (this.size || 1);
    return { w: Math.round(this.manifest.canvas.width * k), h: Math.round(this.manifest.canvas.height * k) };
  }

  draw(frame) {
    if (!this.worker || this.framePending) return;
    const id = this.frameNo++;
    this.framePending = { id, timer: setTimeout(() => this.failWorker('Pet animation stopped responding. Refresh or remove it in Studio.'), this.frameTimeoutMs) };
    try { this.port.postMessage({ ...frame, type: 'frame', frame: id }); }
    catch { this.failWorker('The pet worker stopped. Refresh or remove it in Studio.'); }
  }

  destroy() {
    this.cancelLoad();
    if (this.worker) this.worker.terminate();
    this.port?.close();
    clearTimeout(this.framePending?.timer);
    this.framePending = this.port = null;
    if (this.canvas) this.canvas.remove();
    this.worker = this.canvas = null;
  }

  cancelLoad() {
    if (!this.pendingLoad) return;
    const { worker, port, reject, timer } = this.pendingLoad;
    this.pendingLoad = null;
    worker.terminate();
    port.close();
    clearTimeout(timer);
    const error = new Error('Pet load superseded');
    error.name = 'AbortError';
    reject(error);
  }
}

window.PetPlayer = PetPlayer;
