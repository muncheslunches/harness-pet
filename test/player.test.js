const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('rapid pet reselection cancels stale worker loads and keeps the newest pet', async () => {
  const workers = [];
  const context = vm.createContext({
    window: {},
    setTimeout, clearTimeout,
    MessageChannel: class { constructor() { this.port1 = { postMessage() {}, close() {} }; this.port2 = {}; } },
    document: { createElement: () => ({ style: {}, transferControlToOffscreen: () => ({}), replaceWith() {}, remove() {} }) },
    Worker: class {
      constructor() { workers.push(this); }
      postMessage(m) { if (m.type === 'canvas') this.port = context.window.playerPort = m; }
      terminate() { this.terminated = true; }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runtime/pet-player.js'), 'utf8'), context);
  const player = new context.window.PetPlayer({ append() {} });
  const stale = player.load('old pet').catch((err) => err);
  const stalePort = player.pendingLoad.port;
  const current = player.load('Birdie');
  assert.equal((await stale).name, 'AbortError');
  assert.equal(workers[0].terminated, true);
  const manifest = { name: 'Birdie', scale: 4, canvas: { width: 28, height: 32 } };
  manifest.animations = { idle: {} };
  stalePort.onmessage({ data: { type: 'loaded', manifest: { ...manifest, name: 'Old pet' } } });
  // Replies arrive on the private channel, never the pet-visible worker endpoint.
  player.pendingLoad.port.onmessage({ data: { type: 'loaded', manifest, warnings: [] } });
  assert.equal((await current).manifest.name, 'Birdie');
  assert.equal(player.manifest.name, 'Birdie');
  const pending = player.load('another pet').catch((err) => err);
  player.destroy();
  assert.equal((await pending).name, 'AbortError');
  assert.equal(workers[2].terminated, true);
  player.destroy();
});

function rig() {
  const workers = [];
  const context = vm.createContext({ window: {}, setTimeout, clearTimeout,
    document: { createElement: () => ({ style: {}, transferControlToOffscreen: () => ({}), replaceWith() {}, remove() {} }) },
    MessageChannel: class { constructor() { this.port1 = { sent: [], postMessage(m) { this.sent.push(m); }, close() { this.closed = true; } }; this.port2 = {}; } },
    Worker: class { constructor() { workers.push(this); } postMessage() {} terminate() { this.terminated = true; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runtime/pet-player.js'), 'utf8'), context);
  const player = new context.window.PetPlayer({ append() {} }, { loadTimeoutMs: 25, frameTimeoutMs: 25 });
  return { player, workers };
}
const manifest = { format: 1, name: 'Test pet', scale: 1, canvas: { width: 16, height: 16 }, animations: { idle: {} } };

test('nonresponding and oversized loads fail with bounded cleanup', async () => {
  const { player, workers } = rig();
  await assert.rejects(player.load('while(true){}'), /timed out/);
  assert.equal(workers[0].terminated, true);
  assert.equal(player.pendingLoad, null);
  await assert.rejects(player.load('x'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.equal(workers.length, 1);
  player.destroy();
});

test('frame requests are bounded to one; a stuck animation terminates and can be reloaded', async () => {
  const { player, workers } = rig();
  let loaded = player.load('pet');
  const port = player.pendingLoad.port;
  port.onmessage({ data: { type: 'loaded', manifest } }); await loaded;
  const failure = new Promise(resolve => { player.onFailure = resolve; });
  for (let i = 0; i < 10000; i++) player.draw({ anim: 'idle' });
  assert.equal(port.sent.filter(m => m.type === 'frame').length, 1);
  assert.match((await failure).message, /stopped responding/);
  assert.equal(workers[0].terminated, true);
  loaded = player.load('fixed pet');
  player.pendingLoad.port.onmessage({ data: { type: 'loaded', manifest } }); await loaded;
  player.draw({ anim: 'idle' });
  const id = player.framePending.id;
  player.message({ type: 'frame-done', frame: id + 1 }); assert.ok(player.framePending);
  player.message({ type: 'frame-done', frame: id }); assert.equal(player.framePending, null);
  player.destroy();
});
