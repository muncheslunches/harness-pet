const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const security = require('../lib/security');
const policy = require('../lib/ipc-policy');
const links = require('../lib/link-policy');

test('file boundaries deny junction escapes, traversal, missing files and NTFS variants', t => {
  const parent = path.join(__dirname, '../.test-tmp'); fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, 'hp-boundary-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const inside = path.join(tmp, 'allowed');
  const outside = path.join(tmp, 'private');
  fs.mkdirSync(inside); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(inside, 'safe.pet.js'), 'safe');
  fs.writeFileSync(path.join(outside, 'secret.pet.js'), 'secret');
  fs.symlinkSync(outside, path.join(inside, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const allowed = file => security.isAllowedUrl(pathToFileURL(file).href, [inside]);
  assert.equal(allowed(path.join(inside, 'safe.pet.js')), true);
  for (const file of [path.join(inside, 'escape', 'secret.pet.js'), path.join(inside, '..', 'private', 'secret.pet.js'), path.join(inside, 'absent.pet.js'), path.join(inside, 'safe.pet.js:stream')]) assert.equal(allowed(file), false, file);
  for (const url of ['file://server/share/pet.js', 'file:///C:/Windows/win.ini', 'file:///C:/Windows/%2fwin.ini', 'wss://example.com', 'ws://localhost', 'https://example.com']) assert.equal(security.isAllowedUrl(url, [inside]), false, url);
  assert.equal(security.isAllowedFile(path.join(inside, '..name'), [inside]), false);
});

test('sender checks require the intended window, main frame and exact app page', () => {
  const page = path.join(__dirname, '../studio/index.html');
  const frame = { url: pathToFileURL(page).href + '?tab=pets' };
  const wc = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: wc };
  assert.equal(security.isTrustedSender({ sender: wc, senderFrame: frame }, win, page), true);
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: wc }, { sender: wc, senderFrame: { ...frame } }]) assert.equal(security.isTrustedSender(event, win, page), false);
  frame.url = pathToFileURL(path.join(__dirname, '../pet-window/index.html')).href;
  assert.equal(security.isTrustedSender({ sender: wc, senderFrame: frame }, win, page), false);
});

test('windows deny all renderer navigation, new windows, webviews, permissions and downloads', () => {
  const wc = new EventEmitter();
  wc.setWindowOpenHandler = fn => { wc.open = fn; };
  security.protectWindow({ webContents: wc });
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let blocked = false; wc.emit(event, { preventDefault() { blocked = true; } }); assert.equal(blocked, true);
  }
  assert.equal(wc.open({ url: 'data:text/html,evil' }).action, 'deny');
  const ses = new EventEmitter();
  ses.webRequest = { onBeforeRequest: fn => { ses.request = fn; } };
  for (const name of ['setPermissionCheckHandler', 'setPermissionRequestHandler', 'setDevicePermissionHandler']) ses[name] = fn => { ses[name] = fn; };
  security.protectSession(ses, []);
  assert.equal(ses.setPermissionCheckHandler(null, 'media'), false);
  assert.equal(ses.setDevicePermissionHandler({ deviceType: 'usb' }), false);
  ses.setPermissionRequestHandler(null, 'display-capture', answer => assert.equal(answer, false));
  let blocked = false; ses.emit('will-download', { preventDefault() { blocked = true; } }); assert.equal(blocked, true);
});

test('IPC rejects identity/prototype replacement, malformed launches and unsafe numbers', () => {
  for (const patch of [{ uid: 'other' }, { pos: { x: 1, y: 2 } }, { size: NaN }, { size: Infinity }, { sound: { volume: 10 } }, { behavior: { command: 'calc.exe' } }, JSON.parse('{"__proto__":{"polluted":true}}')]) assert.equal(policy.studioArgs('set-instance', ['p1', patch]), false);
  assert.equal(policy.studioArgs('set-instance', ['p1', { behavior: { wander: false }, barMode: 'off' }]), true);
  assert.equal(policy.studioArgs('claude-hooks', ['destroy']), false);
  assert.equal(policy.petArgs('set', ['pet', 'C:\\private.pet.js']), false);
  assert.equal(policy.petArgs('action', ['button', { index: { linkIndex: 999 } }]), false);
  assert.equal(policy.petArgs('rect', [null]), false);
  assert.equal(policy.petArgs('vel', [{ vx: Infinity, vy: 0 }]), false);
  assert.equal(policy.petArgs('set', ['size', 1.5]), true);
});

test('Studio handlers enforce sender and input checks before filesystem or hook actions', () => {
  const handlers = new Map();
  const calls = [];
  const main = path.join(__dirname, '../main.js');
  const realRequire = createRequire(main);
  const context = vm.createContext({ process, console, __dirname: path.dirname(main), setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return { app: { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => false, quit() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, clipboard: { writeText: value => calls.push(value) } };
      if (['./lib/security', './lib/ipc-policy', 'fs', 'path'].includes(name)) return realRequire(name);
      if (name === './lib/library') return {
        read: ref => { calls.push(ref); return { code: 'test' }; },
        fileOf: ref => { if (ref === 'outside') throw new Error('outside library'); return ref; },
        refOf: ref => ref,
      };
      if (name === './lib/claude-hooks') return { install: () => calls.push('install') };
      return {};
    } });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context);
  const frame = { url: pathToFileURL(path.join(__dirname, '../studio/index.html')).href };
  const wc = { mainFrame: frame };
  context.testStudio = { isDestroyed: () => false, webContents: wc };
  vm.runInContext('studio = testStudio; wireStudio()', context);
  const fn = handlers.get('studio:pet-code');
  assert.throws(() => fn({ sender: {}, senderFrame: frame }, 'pet'), /Unauthorized/);
  assert.throws(() => fn({ sender: wc, senderFrame: { ...frame } }, 'pet'), /Unauthorized/);
  assert.throws(() => fn({ sender: wc, senderFrame: frame }, null), /Invalid/);
  assert.equal(calls.length, 0);
  assert.equal(fn({ sender: wc, senderFrame: frame }, 'builtin:clawrk'), 'test');
  assert.deepEqual(calls, ['builtin:clawrk']);
  context.testPrefs = { instances: [{ uid: 'p', pet: 'outside' }] };
  vm.runInContext('prefs = testPrefs', context);
  assert.throws(() => handlers.get('studio:delete-pet')({ sender: wc, senderFrame: frame }, 'outside'), /outside library/);
  assert.equal(context.testPrefs.instances[0].pet, 'outside');
});

test('configured launches validate schemes/arguments and use no shell; missing executables are handled', async () => {
  for (const target of [{ url: 'javascript:alert(1)' }, { url: 'file:///C:/Windows/calc.exe' }, { url: 'shell://AppsFolder' }, { url: 'data:text/html,x' }, { url: 'https://good', command: 'bad' }, { command: 'node', args: 'bad' }, { command: 'x', args: [null] }]) assert.throws(() => links.validateTarget(target));
  let options; let args; let failed = false;
  await links.launch({ command: 'missing.exe', args: ['a & b', '$(x)'] }, { spawn: (cmd, values, opts) => { args = values; options = opts; const child = new EventEmitter(); child.unref = () => queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; }, onError: () => { failed = true; } });
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(args, ['a & b', '$(x)']); assert.equal(failed, true);
  await assert.rejects(links.launch({ url: 'https://example.com' }, { shell: { openExternal: async () => { throw new Error('no handler'); } } }), /no handler/);
});
