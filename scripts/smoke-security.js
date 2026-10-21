// Run with: electron scripts/smoke-security.js
// Uses real Chromium workers and the production URL filter; no user settings are loaded.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.env.HARNESS_PET_SECURITY_APP || root);
let security;
try {
  security = require(path.join(appRoot, 'lib/security'));
} catch (e) {
  console.error('Failed to load security module from', appRoot, e);
  process.exit(1);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-security-'));
app.setPath('userData', path.join(scratch, 'electron'));
const deadline = setTimeout(() => { console.error('Security smoke test timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  console.log('security: ready');
  let win;
  try {
    const blocked = [];
    const allowedDirs = [...security.getAllowedDirs(appRoot), path.join(root, 'test', 'fixtures')];
    security.protectSession(session.defaultSession, allowedDirs);
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const cancel = !security.isAllowedUrl(details.url, allowedDirs);
      if (cancel) blocked.push(details.url);
      cb({ cancel });
    });
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    security.protectWindow(win);
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    await win.loadFile(path.join(root, 'test', 'fixtures', 'security-smoke.html'));
    console.log('security: fixture loaded');
    const workerUrl = pathToFileURL(path.join(appRoot, 'runtime', 'pet-worker.js')).href;
    const code = fs.readFileSync(path.join(root, 'test', 'fixtures', 'breakout.pet.js'), 'utf8') +
      '\nself.postMessage({type: "security-probe", escapeLog});';
    const log = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const worker = new Worker(${JSON.stringify(workerUrl)});
      let result;
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
      worker.onmessage = e => {
        if (e.data.type === 'security-probe') result = e.data.escapeLog;
        if (e.data.type === 'error') { worker.terminate(); reject(new Error(e.data.message)); }
        if (e.data.type === 'loaded') { worker.terminate(); resolve(result); }
      };
      worker.postMessage({type: 'load', code: ${JSON.stringify(code)}});
    })`);
    assert.ok(log, 'breakout pet returned results');
    for (const key of ['prototypeFetch', 'importScripts', 'overwrotePostMessage']) {
      assert.equal(log[key], false, key + ' must fail in a real worker');
    }
    console.log('security: breakout checked');
    const outside = path.join(scratch, 'private.txt');
    fs.writeFileSync(outside, 'must not be readable');
    const deniedUrls = [pathToFileURL(outside).href, 'http://127.0.0.1:18080/security-probe'];
    const escape = path.join(scratch, 'escape'); fs.mkdirSync(escape);
    const junction = path.join(root, 'test', 'fixtures', 'security-link-' + process.pid);
    fs.symlinkSync(scratch, junction, process.platform === 'win32' ? 'junction' : 'dir');
    try { deniedUrls.push(pathToFileURL(path.join(junction, 'private.txt')).href);
    for (const url of deniedUrls) {
      const readable = await win.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r => r.text()).then(() => true, () => false)`);
      assert.equal(readable, false, 'unauthorized request must fail');
      assert.ok(blocked.includes(url), 'production session filter must cancel ' + url);
    }
    } finally { fs.unlinkSync(junction); }
    console.log('security: file/http/junction checked');
    const wsUrl = 'ws://127.0.0.1:18080/security-probe';
    await win.webContents.executeJavaScript(`new Promise(resolve => { const ws = new WebSocket(${JSON.stringify(wsUrl)}); ws.onerror = () => resolve(false); ws.onopen = () => { ws.close(); resolve(true); }; })`).then(open => assert.equal(open, false));
    assert.ok(blocked.includes(wsUrl));
    console.log('security: websocket checked');
    assert.equal(await win.webContents.executeJavaScript('window.open("data:text/html,blocked") === null'), true);
    console.log('security: new-window checked');
    assert.equal(await win.webContents.executeJavaScript('Notification.requestPermission()'), 'denied');
    console.log('security: permission checked');
    assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
    const nav = new Promise(resolve => win.webContents.once('will-frame-navigate', () => resolve()));
    await win.webContents.executeJavaScript('location.href = location.href + "?blocked=1"'); await nav;
    assert.ok(win.webContents.getURL().endsWith('security-smoke.html'));
    console.log('security: navigation/permissions checked');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(appRoot, 'runtime', 'pet-player.js'), 'utf8') + '\nundefined;');
    const validCode = 'definePet({format:1,id:"test-pet",name:"Test pet",canvas:{width:16,height:16},animations:{idle:{draw(){}}}})';
    const outcomes = await win.webContents.executeJavaScript(`(async () => {
      const host = document.createElement('div'); document.body.append(host);
      const player = new window.PetPlayer(host, { workerUrl: ${JSON.stringify(workerUrl)}, loadTimeoutMs: 5000, frameTimeoutMs: 2000 });
      const result = [];
      for (const code of ['while(true){}', 'throw new Error("bad pet")', 'definePet({})', 'x'.repeat(1024 * 1024 + 1)]) {
        try { await player.load(code); result.push('UNEXPECTED'); } catch (e) { result.push(e.message); }
      }
      // Pet-visible postMessage cannot forge the private load/frame protocol.
      const spoof = 'postMessage({type:"loaded",manifest:{name:"Forged"}}); MessagePort.prototype.postMessage = function(){ postMessage({type:"frame-done",frame:0}); }; ';
      await player.load(spoof + ${JSON.stringify(validCode)});
      result.push(player.manifest.name);
      player.draw({anim:'idle', t:0, dt:33});
      await new Promise(r => setTimeout(r, 500));
      result.push(player.framePending === null);
      await player.load(${JSON.stringify(validCode.replace('draw(){}', 'draw(){while(true){}}'))});
      const failed = new Promise(r => { player.onFailure = e => r(e.message); });
      for (let i=0;i<10000;i++) player.draw({anim:'idle',t:0,dt:33});
      result.push(await failed); result.push(player.worker === null);
      await player.load(${JSON.stringify(validCode)}); result.push(player.manifest.name);
      player.destroy(); return result;
    })()`);
    assert.match(outcomes[0], /timed out/); assert.match(outcomes[1], /bad pet/); assert.notEqual(outcomes[2], 'UNEXPECTED'); assert.match(outcomes[3], /1 MB/);
    assert.equal(outcomes[4], 'Test pet'); assert.equal(outcomes[5], true); assert.match(outcomes[6], /stopped responding/); assert.equal(outcomes[7], true); assert.equal(outcomes[8], 'Test pet');
    if (appRoot !== root) {
      for (const file of ['main.js', 'lib/pet-host.js', 'lib/security.js', 'lib/ipc-policy.js', 'lib/link-policy.js', 'lib/library.js', 'lib/store.js', 'lib/key-watch.js', 'lib/text-avoid.js', 'lib/screen-scan.js', 'runtime/pet-worker.js', 'runtime/pet-player.js', 'pet-window/index.html', 'pet-window/pet-window.js', 'pet-window/preload.js', 'studio/index.html', 'studio/studio.js', 'studio/preload.js']) assert.deepEqual(fs.readFileSync(path.join(appRoot, file)), fs.readFileSync(path.join(root, file)), 'Packaged restrictions must match: ' + file);
      for (const file of ['main.js', 'lib/pet-host.js']) {
        const code = fs.readFileSync(path.join(appRoot, file), 'utf8');
        assert.match(code, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
        assert.match(code, /security.protectWindow/);
      }
    }
    console.log('PASS: real Electron worker isolation, bounded recovery, URL/junction/network denial, navigation and permission restrictions' + (appRoot !== root ? ', packaged-source parity' : ''));
    console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome }));
    app.exitCode = 0;
  } catch (err) {
    console.error(err);
    app.exitCode = 1;
  } finally {
    console.log('security: closing fixture');
    clearTimeout(deadline);
    if (win) win.destroy();
    console.log('security: exiting');
    app.exit(app.exitCode || 0);
  }
}).catch(err => { console.error(err); app.exit(1); });
