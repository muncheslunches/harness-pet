// Rest, closed hidden windows and the native helper, in real Electron windows against an
// isolated profile. Time away from the PC is faked, so this needs no waiting for the real
// thing. Sound and hotkeys stay off, and the app exits at the end.
const { app, BrowserWindow, powerMonitor, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const home = fs.mkdtempSync(path.join(root, '.test-tmp', 'electron-rest-'));
process.env.USERPROFILE = process.env.HOME = home;
app.setPath('userData', path.join(home, 'electron'));

let idleSeconds = 0;
powerMonitor.getSystemIdleTime = () => idleSeconds;

const store = require('../lib/store');
store.ensureDirs();
const prefs = store.loadPrefs();
const pet = (uid, harness, behavior = {}) => ({
  ...store.newInstance('builtin:clawrk', harness), uid, buttons: [null, null], barMode: 'off',
  behavior: { ...store.DEFAULT_BEHAVIOR, avoidText: false, tricks: 'often', wander: true, nap: false, ...behavior },
});
prefs.instances = [
  { ...pet('follower', 'claude-code'), pos: { x: 120, y: 500 } },
  { ...pet('loner', null), pos: { x: 320, y: 500 } },
  { ...pet('visitor', 'codex', { showWithAgent: true, lingerMinutes: 0.25, wander: false, tricks: 'off' }), pos: { x: 520, y: 500 } },
];
Object.assign(prefs, { keyboardAsked: true, keyboardConsentVersion: 1, watchKeyboard: false, hotkeysEnabled: false, muteAll: true });
store.savePrefs(prefs);

require('../main');
const host = require('../lib/pet-host');
const helper = require('../lib/helper');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function pass(name) {
  results.push(name);
  console.log('ok   ' + name);
}

async function until(what, fn, ms = 6000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error('timed out waiting for: ' + what);
    await pause(60);
  }
}

const js = (win, code) => win.webContents.executeJavaScript(code);
async function windowOf(uid) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const id = await js(win, 'typeof inst !== "undefined" && inst ? inst.uid : null').catch(() => null);
    if (id === uid) return win;
  }
  return null;
}
const rest = (win) => js(win, 'restLevel');
const session = (harness, state) => fs.writeFileSync(path.join(store.PATHS.sessions, `${harness}-s1.json`),
  JSON.stringify({ sessionId: 's1', harness, state, ts: Date.now(), since: Date.now(), detail: 'Testing', title: 'Smoke test' }));

// A picture of the pet, to tell a drawn pet from an empty window.
async function drawnPixels(win) {
  // Chromium refuses a capture while the window has no fresh frame to give
  const shot = await win.webContents.capturePage().catch(() => null);
  if (!shot) return { drawn: 0 };
  const { width, height } = shot.getSize();
  const px = shot.toBitmap();
  let drawn = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) drawn++;
  return { drawn, width, height, shot };
}

app.whenReady().then(async () => {
  const watchdogExit = setTimeout(() => { console.log('FAILED: the whole test took too long'); app.exit(2); }, 240000);
  try {
    const follower = await until('the follower pet', () => windowOf('follower'), 20000);
    const loner = await until('the other pet', () => windowOf('loner'), 20000);
    await until('pets drawn', async () => (await js(follower, '!!manifest && !!player.worker')) && (await js(loner, '!!manifest && !!player.worker')), 20000);
    await pause(800);

    // ---------- the picture survives frames being skipped ----------
    const seen = await until('pet pixels on screen', async () => { const d = await drawnPixels(loner); return d.drawn > 200 ? d : null; });
    console.log(`     window ${seen.width}x${seen.height}, ${seen.drawn} drawn pixels`);
    if (process.env.HARNESS_PET_SHOT) fs.writeFileSync(process.env.HARNESS_PET_SHOT, nativeImage.createFromBitmap(seen.shot.toBitmap(), seen.shot.getSize()).toPNG());
    pass('a pet is really drawn on screen');

    // ---------- renderer errors reach the log ----------
    await js(loner, 'console.error("smoke test: a renderer error"); 1');
    await until('the error in app.log', () => fs.readFileSync(path.join(store.PATHS.data, 'app.log'), 'utf8').includes('smoke test: a renderer error'), 3000);
    pass('renderer console errors reach app.log');

    // ---------- you step away ----------
    assert.equal(await rest(follower), 0);
    await js(loner, 'startMove("walk", { host: true, duration: 60000, vx: 30 }); 1');
    idleSeconds = 5 * 60;
    await until('drowsy', async () => (await rest(follower)) === 1 && (await rest(loner)) === 1);
    await until('walking stops', async () => (await js(loner, 'moving')) === null);
    assert.equal(await js(loner, 'frameGap()'), 200);
    assert.equal(await js(loner, 'document.body.classList.contains("resting")'), true);
    await js(loner, 'nextTrickAt = 0; 1');
    await pause(1200);
    assert.equal(await js(loner, 'moving === null && timed === null'), true, 'no new moves or tricks');
    pass('5 minutes away: pets slow down and stop wandering');

    idleSeconds = 10 * 60;
    await until('asleep', async () => (await rest(follower)) === 2 && (await rest(loner)) === 2);
    await until('sleeping animation', async () => (await js(loner, 'current.wanted')) === 'sleep');
    assert.equal(await js(loner, 'frameGap()'), 1000);
    const before = await js(loner, 'lastFrame');
    await pause(2200);
    const frames = (await js(loner, 'lastFrame')) - before;
    assert.ok(frames > 900 && frames < 3200, 'still ticking, about once a second');
    await until('still visible', async () => (await drawnPixels(loner)).drawn > 200);
    pass('10 minutes away: pets sleep, about one frame a second, and stay visible');

    // ---------- the audio stream rests too (the test pets are far too quiet to hear) ----------
    await js(loner, 'globals = { muteAll: false, noDance: false }; inst.sound = { muted: false, volume: 0.00001, anims: {} }; 1');
    idleSeconds = 0;
    await until('awake for the audio check', async () => (await rest(loner)) === 0, 2500);
    await js(loner, 'sound("hover"); 1');
    await until('audio running', async () => (await js(loner, 'audio && audio.state')) === 'running', 3000);
    await js(loner, 'window.__hoverCount = 0; 1');
    idleSeconds = 10 * 60;
    await until('asleep', async () => (await rest(loner)) === 2);
    await until('audio suspended at rest', async () => (await js(loner, 'audio.state')) === 'suspended', 9000);
    idleSeconds = 0;
    await until('audio reopened on waking', async () => (await js(loner, 'audio.state')) === 'running', 2500);
    const resumed = await js(loner, `(async () => {
      await audio.suspend();
      const before = PetSounds.play;
      const t = performance.now();
      const started = new Promise((resolve) => { PetSounds.play = (...a) => { PetSounds.play = before; before(...a); resolve(performance.now() - t); }; });
      sound("hover");
      return started;
    })()`);
    assert.ok(resumed < 500, `a sound after a suspend starts promptly, took ${resumed} ms`);
    console.log(`     a sound after a suspend started ${Math.round(resumed)} ms later`);
    await js(loner, 'globals = { muteAll: true, noDance: false }; inst.sound.muted = true; if (audio) { audio.close(); audio = null; } 1');
    pass('the audio stream suspends at rest, reopens on waking, and a sound after it plays promptly');
    idleSeconds = 10 * 60;
    await until('asleep again', async () => (await rest(follower)) === 2 && (await rest(loner)) === 2);

    // ---------- only its own agent wakes a pet ----------
    session('claude-code', 'working');
    await until('news wakes the follower', async () => (await rest(follower)) === 0);
    assert.equal(await rest(loner), 2, 'another pet sleeps on');
    await until('status shows', async () => (await js(follower, 'sessionStatus')) === 'working');
    pass('news from its agent wakes only the pet that follows it');

    session('claude-code', 'done');
    await until('finished status', async () => (await js(follower, 'sessionStatus')) === 'done');
    assert.equal(await rest(follower), 0);
    assert.equal(await rest(loner), 2);
    pass('a finished task counts as news too');

    // ---------- time passing is not news ----------
    fs.writeFileSync(path.join(store.PATHS.sessions, 'claude-code-s1.json'), JSON.stringify({ sessionId: 's1', harness: 'claude-code', state: 'working', ts: Date.now() - 30 * 60e3 + 6000, detail: 'Stuck', title: 'Smoke test' }));
    await until('the stuck session shows', async () => (await js(follower, 'sessionStatus')) === 'working');
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('unlock-screen');
    await until('asleep with the session stuck', async () => (await rest(follower)) === 2);
    await until('it times out to idle', async () => (await js(follower, 'sessionStatus')) !== 'working', 9000);
    await pause(2500);
    assert.equal(await rest(follower), 2, 'nothing new was said');
    pass('a stuck session timing out does not wake its pet');

    // ---------- you come back ----------
    idleSeconds = 0;
    await until('everyone awake', async () => (await rest(follower)) === 0 && (await rest(loner)) === 0, 2500);
    assert.equal(await js(loner, 'timed && timed.key'), 'wake');
    assert.equal(await js(loner, 'document.body.classList.contains("resting")'), false);
    await until('full rate', async () => (await js(loner, 'frameGap()')) <= 100);
    pass('using the PC wakes every pet with a wake-up animation');

    // ---------- locking ----------
    const hadNews = Date.now();
    powerMonitor.emit('lock-screen');
    await until('locked pets sleep', async () => (await rest(follower)) === 2 && (await rest(loner)) === 2, 2500);
    assert.ok(Date.now() - hadNews < 2500, 'at once, despite recent agent news and input');
    powerMonitor.emit('unlock-screen');
    await until('unlocked pets wake', async () => (await rest(follower)) === 0 && (await rest(loner)) === 0, 2500);
    pass('locking the screen rests pets at once; unlocking wakes them');

    // ---------- full-screen apps ----------
    const realFullscreen = helper.fullscreen;
    assert.match(String(await realFullscreen.call(helper)), /true|false/, 'the real helper answers');
    pass('the helper can tell whether a full-screen app is in front');
    helper.fullscreen = () => Promise.resolve(true);
    await host.fullscreenCheck();
    await pause(300);
    assert.equal(await rest(loner), 0, 'off by default');
    pass('sleeping during full-screen apps stays off unless you choose it');
    helper.fullscreen = realFullscreen;

    // ---------- cursor messages ----------
    await js(loner, 'window.__cursorMessages = 0; window.host.onCursor(() => { window.__cursorMessages++; }); 1');
    const p0 = require('electron').screen.getCursorScreenPoint();
    const w0 = loner.getPosition();
    await pause(3000);
    const p1 = require('electron').screen.getCursorScreenPoint();
    const w1 = loner.getPosition();
    const messages = await js(loner, 'window.__cursorMessages');
    // a pet that walked at all has a new cursor position to report, even if it has stopped by now
    if (p0.x === p1.x && p0.y === p1.y && w0[0] === w1[0] && w0[1] === w1[1] && !(await js(loner, 'moving'))) {
      assert.ok(messages <= 6, `a still cursor sends few messages, got ${messages} in 3 s`);
      console.log(`     ${messages} cursor messages in 3 s with the mouse still (it used to be about 33)`);
    } else console.log(`     mouse or pet moved during this check; ${messages} messages`);
    pass('the page is not woken for a cursor position it already has');

    // ---------- a hidden pet's window closes, and it comes back fine ----------
    const visitor = await until('the visitor pet', () => windowOf('visitor'), 20000);
    await until('visitor loaded', () => js(visitor, '!!manifest'), 20000);
    const manifest = host.manifestOf('visitor');
    assert.ok(manifest, 'it reported what it can do');
    const count = BrowserWindow.getAllWindows().length;
    console.log('     waiting for the visitor to leave (15 s), then for its window to close (30 s)...');
    await until('visitor leaves', async () => store.loadPrefs().instances.find((i) => i.uid === 'visitor').visible === false, 30000);
    await until('hidden window closes', () => BrowserWindow.getAllWindows().length === count - 1, 40000);
    assert.equal(await windowOf('visitor'), null);
    assert.ok(host.manifestOf('visitor'), 'Studio still knows the pet');
    const saved = store.loadPrefs().instances.find((i) => i.uid === 'visitor');
    pass('an agent pet\'s hidden window closes after 30 s; Studio keeps its details');

    session('codex', 'working');
    const back = await until('visitor reappears with its agent', () => windowOf('visitor'), 12000);
    await until('visible', () => back.isVisible(), 8000);
    await until('drawn', async () => (await drawnPixels(back)).drawn > 200, 8000);
    const pos = store.loadPrefs().instances.find((i) => i.uid === 'visitor').pos;
    assert.deepEqual({ x: Math.round(pos.x), y: Math.round(pos.y) }, { x: Math.round(saved.pos.x), y: Math.round(saved.pos.y) }, 'in the same spot');
    assert.equal(BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length, count, 'exactly one new window');
    pass('it reappears with its agent, in the same place, in one new window');

    // ---------- the helper in use ----------
    const native = !process.env.HARNESS_PET_NO_RUST && fs.existsSync(path.join(root, 'native', 'bin', 'harness-pet-helper.exe'));
    assert.equal(helper.events, native, native ? 'the Rust helper announces window changes' : 'PowerShell does not');
    assert.equal(await helper.send('ping'), 'ok pong');
    assert.equal(typeof await helper.windowShown({ process: 'no-such-app' }), 'boolean');
    pass(native ? 'the app is talking to the Rust helper' : 'the app is talking to the PowerShell helper');
    if (native) {
      const heard = [];
      const original = helper.onEvent;
      helper.onEvent = (e) => { heard.push(e); original(e); };
      const probe = new BrowserWindow({ width: 220, height: 120, x: 40, y: 40, show: false, skipTaskbar: true, focusable: false, title: 'smoke-probe' });
      probe.showInactive();
      await until('a new window is announced', () => heard.includes('windows'), 4000);
      probe.destroy();
      helper.onEvent = original;
      pass('Windows\' window events reach the app');
    }

    // ---------- the settings, through Studio itself ----------
    require('../main').openStudio('general');
    const studio = await until('Studio', () => BrowserWindow.getAllWindows().find((w) => /Studio/.test(w.getTitle())), 10000);
    await until('settings page', () => js(studio, 'document.body.innerText.includes("Rest while you are away")'), 10000);
    assert.equal(await js(studio, '[...document.querySelectorAll("select")].filter((s) => /after/.test(s.getAttribute("aria-label"))).map((s) => s.value).join()'), '5,10', 'the defaults are shown');
    idleSeconds = 60 * 60;
    await until('asleep', async () => (await rest(loner)) === 2);
    await js(studio, 'S.setGeneral("idleRest", false)');
    await until('switching rest off wakes pets', async () => (await rest(loner)) === 0, 2500);
    assert.equal(store.loadPrefs().idleRest, false, 'and it is saved');
    await js(studio, 'S.setGeneral("idleRest", true)');
    await until('asleep again', async () => (await rest(loner)) === 2, 2500);
    await js(studio, 'S.setGeneral("idleSleepMinutes", 120)');
    await until('a longer time applies at once', async () => (await rest(loner)) === 1, 2500);
    await js(studio, 'S.setGeneral("idleSleepMinutes", 10)');
    idleSeconds = 0;
    await until('awake', async () => (await rest(loner)) === 0, 2500);
    pass('the rest settings work from Studio and are saved');

    helper.fullscreen = () => Promise.resolve(true);
    assert.equal(await js(studio, '!!document.getElementById("toggle-fullscreen")'), true);
    await js(studio, 'S.setGeneral("pauseFullscreen", true)');
    await until('full-screen rests pets', async () => (await rest(loner)) === 2, 4500);
    helper.fullscreen = () => Promise.resolve(false);
    await host.fullscreenCheck();
    await until('leaving full-screen wakes them', async () => (await rest(loner)) === 0, 2500);
    await js(studio, 'S.setGeneral("pauseFullscreen", false)');
    helper.fullscreen = realFullscreen;
    pass('the experimental full-screen option rests and wakes pets');
    studio.destroy();

    clearTimeout(watchdogExit);
    console.log(`PASS: ${results.length} checks`);
    app.exit(0);
  } catch (err) {
    console.log('FAILED: ' + (err.stack || err));
    app.exit(1);
  }
});
