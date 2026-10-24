// Harness Pet: desktop pets that react to coding agents.
// Main process: tray, menus, the Studio window and wiring between them.

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, clipboard, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const library = require('./lib/library');
const host = require('./lib/pet-host');
const helper = require('./lib/helper');
const prompts = require('./lib/prompts');
const claudeHooks = require('./lib/claude-hooks');
const icon = require('./lib/icon');
const Catalog = require('./shared/catalog.js');
const menus = require('./lib/menus');
const hotkeys = require('./lib/hotkeys');
const lifecycle = require('./lib/lifecycle');
const keyWatch = require('./lib/key-watch');
const textAvoid = require('./lib/text-avoid');
const screenScan = require('./lib/screen-scan');
const security = require('./lib/security');
const ipcPolicy = require('./lib/ipc-policy');

// Pets are always-on-top overlays. Chromium's native occlusion tracking hides a
// covered (or locked-screen) window's input child, which with pets' disabled
// background throttling never comes back, so presses on that pet are dropped
// (see reviveInput in lib/pet-host.js). Overlays gain nothing from it anyway.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let prefs;
let links;
let tray = null;
let studio = null;
let nodePath = 'node';
let keys = null;
let avoider = null;

let lastSaveError = 0;
const save = () => {
  try { store.savePrefs(prefs); return true; }
  catch (err) {
    console.warn('Preferences could not be saved:', err.code || 'SAVE_FAILED');
    if (Date.now() - lastSaveError > 30000) {
      lastSaveError = Date.now();
      dialog.showErrorBox('Harness Pet settings recovery', 'Your previous settings file was preserved. Check free space and permissions, then restart. See README > Settings recovery.');
    }
    return false;
  }
};
const instOf = (uid) => prefs.instances.find((i) => i.uid === uid);

// Hooks run outside this app, so they need a real Node, not Electron.
function findNode() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', 'node.exe');
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir.replace(/"/g, ''), exe);
    try {
      if (dir && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return 'node';
}

function appIcon(size) {
  return nativeImage.createFromBitmap(icon.pixels(size, { bgra: true }), { width: size, height: size });
}

// ---------- menus & hotkeys ----------

const menuFor = (uid) => menus.build(uid, { prefs, links, host, openStudio, quit: () => app.quit() });

// Studio shows a pet's menu natively: headers become disabled rows and sliders a
// submenu of preset values.
function nativeMenu(items) {
  const fmt = (it, v) => (it.format === '%' ? `${v}%` : it.format === 'x' ? `${Number(v).toFixed(1)}×` : String(v));
  return items.filter(Boolean).map((it) => {
    if (it.type === 'header') return { label: it.label, enabled: false };
    if (it.type === 'slider') {
      const round = (v) => Math.round(v / it.step) * it.step;
      const values = [...new Set([...Array.from({ length: 6 }, (_, i) => round(it.min + ((it.max - it.min) * i) / 5)), it.value].map((v) => Number(v.toFixed(2))))].sort((a, b) => a - b);
      return { label: `${it.label} (${fmt(it, it.value)})`, submenu: values.map((v) => ({ label: fmt(it, v), type: 'radio', checked: v === it.value, click: () => it.onSlide(v) })) };
    }
    const out = { label: it.label, type: it.type, checked: it.checked, enabled: it.enabled, click: it.click, accelerator: it.accelerator, registerAccelerator: false };
    if (it.submenu) out.submenu = nativeMenu(it.submenu);
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  });
}

const firstPet = () => prefs.instances.find((i) => i.visible !== false) || prefs.instances[0];

const hotkeyHandlers = {
  togglePets: () => host.setAllVisible(!prefs.instances.some((i) => i.visible !== false)),
  jump: () => firstPet() && host.jumpTo(firstPet().uid),
  button1: () => firstPet() && host.press(firstPet().uid, 0),
  button2: () => firstPet() && host.press(firstPet().uid, 1),
  studio: () => openStudio(),
  mute: () => {
    const mute = !prefs.instances.every((i) => i.sound.muted);
    for (const i of prefs.instances) host.setInstance(i.uid, { sound: { ...i.sound, muted: mute } });
  },
  sleepAll: () => {
    const sleep = !prefs.instances.every((i) => i.asleep);
    for (const i of prefs.instances) host.setInstance(i.uid, { asleep: sleep });
  },
};

function applyHotkeys() {
  hotkeys.apply(prefs, hotkeyHandlers);
  if (tray) buildTray();
}

function buildTray() {
  const hk = prefs.hotkeysEnabled ? prefs.hotkeys : {};
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Harness Pet Studio', click: () => openStudio('pets'), accelerator: hk.studio || undefined, registerAccelerator: false },
      { label: 'Show all pets', click: () => host.setAllVisible(true) },
      { label: 'Hide all pets', click: () => host.setAllVisible(false) },
      { label: 'Refresh all pets', click: () => host.refreshAll() },
      {
        label: 'Undo click-through',
        enabled: prefs.instances.some((i) => i.clickThrough),
        click: () => prefs.instances.forEach((i) => i.clickThrough && host.setInstance(i.uid, { clickThrough: false })),
      },
      { label: 'Bring all pets back on screen', click: () => prefs.instances.forEach((i) => host.home(i.uid)) },
      {
        label: 'Watch typing (dodge text, "GO AWAY")',
        type: 'checkbox',
        checked: prefs.watchKeyboard === true,
        enabled: process.platform === 'win32',
        click: (item) => setWatchKeyboard(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

// ---------- typing watcher ----------

// Screen coordinates from the Windows helper are physical pixels; pets live in DIPs.
function toDip(r) {
  const { screen } = require('electron');
  const a = screen.screenToDipPoint({ x: r.x, y: r.y });
  const b = screen.screenToDipPoint({ x: r.x + r.w, y: r.y + r.h });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

function startTextAvoid() {
  let lastTypingTrace = 0;
  const trace = process.env.HARNESS_PET_AVOID_LOG ? (...a) => console.log('[avoid]', ...a) : () => {};
  avoider = textAvoid.create({
    host,
    scan: async (display, region) => {
      const grid = await screenScan.scanDisplay(display, region, () => prefs.watchKeyboard === true && prefs.keyboardAsked === true);
      trace('scan', display.id, region ? 'region' : 'full', grid ? grid.text.reduce((n, c) => n + c, 0) + ' text cells' : 'no image');
      return grid;
    },
    context: async () => {
      const c = await helper.context();
      return c ? { caret: c.caret ? toDip(c.caret) : null, window: toDip(c.window) } : null;
    },
    enabled: () => prefs.watchKeyboard === true && prefs.keyboardAsked === true,
    log: (msg, err) => console.warn(msg, err && err.stack),
    trace,
  });
  keys = keyWatch.create({
    onTyping: () => { if (Date.now() - lastTypingTrace > 4000) trace('typing'); lastTypingTrace = Date.now(); avoider.typed(); },
    onPhrase: (phrase) => { trace('phrase', phrase); avoider.phrase(); },
  });
  applyKeyWatch();
}

// Asked once, on a new user's first run: the watcher is off until they say yes.
async function askAboutKeyboard() {
  if (prefs.keyboardAsked || process.platform !== 'win32') return;
  prefs.keyboardAsked = true;
  save();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Harness Pet',
    icon: appIcon(64),
    message: 'Should pets step off your text while you type?',
    detail: 'Harness Pet can notice that you are typing (not what you type) and move a pet that is covering text. '
      + 'With Caps Lock on, it also listens for the commands GO AWAY, GET OUT and MOVE.\n\n'
      + 'It also captures your screen briefly in memory to find text-like areas; screenshots and key input are not saved or sent to pets. You can change this any time from the tray icon: "Watch typing".',
    buttons: ['Turn on', 'Not now'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  prefs.watchKeyboard = response === 0;
  prefs.keyboardConsentVersion = 1;
  save();
  applyKeyWatch();
}

// From the tray or Studio. Turning it on the first time asks for consent instead.
function setWatchKeyboard(on) {
  if (on && prefs.keyboardConsentVersion !== 1) {
    prefs.keyboardAsked = false;
    askAboutKeyboard().catch(() => console.warn('Typing consent could not be shown')).finally(notifyStudio);
    return;
  }
  prefs.keyboardAsked = true;
  prefs.watchKeyboard = on;
  save();
  applyKeyWatch();
}

function applyKeyWatch() {
  if (!keys) return;
  if (prefs.watchKeyboard === true && prefs.keyboardAsked === true) keys.start();
  else { keys.stop(); avoider?.stop(); }
  if (tray) buildTray();
  notifyStudio();
}

// ---------- general settings ----------

// Starting with Windows: a source checkout has to tell Electron which app to run.
const loginItem = () => (app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] });

function generalSettings() {
  let startAtLogin = false;
  try { startAtLogin = app.getLoginItemSettings(loginItem()).openAtLogin; } catch {}
  return {
    muteAll: !!prefs.muteAll,
    noDance: !!prefs.noDance,
    verboseLogging: lifecycle.isVerbose(),
    watchKeyboard: prefs.watchKeyboard === true && prefs.keyboardAsked === true,
    keyboardSupported: process.platform === 'win32',
    startAtLogin,
    logFile: path.join(store.PATHS.data, 'app.log'),
  };
}

function setGeneral(key, on) {
  if (key === 'watchKeyboard') return setWatchKeyboard(on);
  if (key === 'startAtLogin') return app.setLoginItemSettings({ ...loginItem(), openAtLogin: on });
  prefs[key] = on;
  save();
  if (key === 'verboseLogging') {
    lifecycle.setVerbose(on);
    lifecycle.record('verbose-logging', { on });
  }
  if (key === 'muteAll' || key === 'noDance') host.broadcastGlobals();
}

// ---------- Studio ----------

// tab: the page to show; uid: the pet on screen to select there
function openStudio(tab, uid) {
  if (studio && !studio.isDestroyed()) {
    if (studio.isMinimized()) studio.restore();
    studio.show();
    studio.focus();
    if (tab) studio.webContents.send('studio:tab', tab, uid);
    return;
  }
  studio = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'Harness Pet Studio',
    icon: appIcon(64),
    backgroundColor: '#17161a',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'studio', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  security.protectWindow(studio);
  studio.loadFile(path.join(__dirname, 'studio', 'index.html'), { query: { tab: tab || 'pets', pet: uid || '' } });
  lifecycle.watchWindow(studio, 'studio');
  studio.on('closed', () => (studio = null));
}

function notifyStudio() {
  if (studio && !studio.isDestroyed()) studio.webContents.send('studio:changed');
}

function studioState() {
  const manifests = {};
  const modes = {};
  for (const i of prefs.instances) {
    manifests[i.uid] = host.manifestOf(i.uid);
    modes[i.uid] = host.modeOf(i.uid);
  }
  return {
    version: app.getVersion(),
    instances: prefs.instances,
    manifests,
    modes,
    links,
    pets: library.list(),
    catalog: Catalog.CATALOG,
    harnesses: prompts.HARNESSES,
    claude: claudeHooks.status(),
    paths: { ...store.PATHS, app: __dirname, validator: path.join(__dirname, 'scripts', 'validate-pet.js') },
    recommendedModel: prompts.RECOMMENDED_MODEL,
    nodePath,
    recovery: store.recoveryIssues(),
    cageEnabled: !!prefs.cageEnabled,
    general: generalSettings(),
  };
}

function wireStudio() {
  const handle = (name, fn) => ipcMain.handle('studio:' + name, (e, ...args) => {
    if (!security.isTrustedSender(e, studio, path.join(__dirname, 'studio', 'index.html'))) throw new Error('Unauthorized Studio caller');
    if (!ipcPolicy.studioArgs(name, args)) throw new Error('Invalid Studio request');
    return fn(...args);
  });
  handle('state', () => studioState());
  handle('pet-code', (ref) => library.read(ref).code);
  handle('set-instance', (uid, patch) => host.setInstance(uid, patch));
  handle('add-instance', (ref, harness) => host.addInstance(ref, harness).uid);
  handle('duplicate-instance', (uid) => host.duplicateInstance(uid));
  handle('remove-duplicates', () => host.removeDuplicates());
  handle('remove-instance', (uid) => host.removeInstance(uid));
  handle('move-instance', (uid, dir) => host.moveInstance(uid, dir));
  handle('set-cage-enabled', (on) => host.setCageEnabled(on));
  handle('set-general', (key, on) => { setGeneral(key, on); notifyStudio(); });
  handle('play', (uid, key) => host.play(uid, key));
  handle('import', async () => {
    const r = await dialog.showOpenDialog(studio, { title: 'Import a pet', filters: [{ name: 'Harness Pet', extensions: ['js'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => library.refOf(library.importFile(f)));
  });
  handle('export', async (ref) => {
    const src = library.fileOf(ref);
    const r = await dialog.showSaveDialog(studio, { title: 'Export pet', defaultPath: path.basename(src), filters: [{ name: 'Harness Pet', extensions: ['js'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(src, r.filePath);
    return r.filePath;
  });
  handle('delete-pet', (ref) => {
    const file = library.fileOf(ref);
    if (library.refOf(file).startsWith('builtin:')) throw new Error('Built-in pets cannot be deleted');
    for (const i of prefs.instances.filter((x) => x.pet === ref)) host.setInstance(i.uid, { pet: 'builtin:clawrk' });
    library.remove(ref);
  });
  handle('prompt', (kind, args) => {
    if (kind === 'create') return prompts.createPet(args, nodePath);
    if (kind === 'missing') return prompts.addMissing({ file: library.fileOf(args.ref), manifest: args.manifest, keys: args.keys }, nodePath);
    if (kind === 'custom-sounds') {
      const inst = instOf(args.uid);
      if (!inst) return '';
      return prompts.addSounds({ file: library.fileOf(inst.pet), manifest: host.manifestOf(inst.uid), requests: args.requests }, nodePath);
    }
    if (kind === 'link') return args.harness === 'any-agent' ? prompts.linkAnyAgent(nodePath) : prompts.linkHarness(args.harness, nodePath);
    if (kind === 'buttons') return prompts.linkButtons(args.harness, nodePath);
    return '';
  });
  handle('copy', (text) => clipboard.writeText(String(text)));
  handle('claude-hooks', (action) => {
    if (action === 'install') return claudeHooks.install(nodePath);
    if (action === 'uninstall') return claudeHooks.uninstall();
    return claudeHooks.status();
  });
  handle('save-links', (next) => {
    store.saveLinks(next);
    links = next;
    host.broadcastLinks();
    notifyStudio();
  });
  handle('open-path', (p) => {
    if (security.isAllowedOpenPath(p, Object.values(store.PATHS))) {
      shell.openPath(path.resolve(p));
    }
  });
  handle('press', (uid, i) => host.press(uid, i));
  handle('menu', (uid) => {
    if (!instOf(uid) || !studio || studio.isDestroyed()) return;
    Menu.buildFromTemplate(nativeMenu(menuFor(uid))).popup({ window: studio });
  });
  handle('hotkeys', () => ({ hotkeys: prefs.hotkeys, enabled: prefs.hotkeysEnabled, disabled: prefs.hotkeysDisabled, status: hotkeys.status(), actions: hotkeys.ACTIONS, defaults: store.DEFAULT_HOTKEYS }));
  handle('hotkey-enabled', (action, on) => {
    if (!Object.hasOwn(hotkeys.ACTIONS, action)) return null;
    prefs.hotkeysDisabled[action] = !on;
    save();
    applyHotkeys();
    return hotkeys.status();
  });
  handle('set-hotkey', (action, combo) => {
    if (!Object.hasOwn(hotkeys.ACTIONS, action)) return null;
    // one combo, one action
    for (const k of Object.keys(prefs.hotkeys)) if (combo && k !== action && prefs.hotkeys[k] === combo) prefs.hotkeys[k] = '';
    prefs.hotkeys[action] = combo || '';
    save();
    applyHotkeys();
    return hotkeys.status();
  });
  handle('hotkeys-enabled', (on) => { prefs.hotkeysEnabled = !!on; save(); applyHotkeys(); return hotkeys.status(); });
  handle('hotkeys-reset', () => { prefs.hotkeys = { ...store.DEFAULT_HOTKEYS }; prefs.hotkeysDisabled = {}; save(); applyHotkeys(); return hotkeys.status(); });
  handle('hotkeys-suspend', () => hotkeys.suspend());
  handle('hotkeys-resume', () => { applyHotkeys(); return hotkeys.status(); });
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // launching again opens the Studio; `--studio=<tab>` picks the page
  app.on('second-instance', (_e, argv) => {
    const arg = argv.find((a) => a.startsWith('--studio='));
    openStudio(arg ? arg.slice('--studio='.length) : undefined);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.harness-pet');
    store.ensureDirs();
    lifecycle.install(app, store.PATHS.data);
    lifecycle.watchWindowCount(app, BrowserWindow);
    prefs = store.loadPrefs();
    lifecycle.setVerbose(prefs.verboseLogging);
    links = store.loadLinks();
    save();
    nodePath = findNode();

    // Pets and windows may only reach files of this app and pets; block every other file and network request.
    const { session } = require('electron');
    const allowedDirs = security.getAllowedDirs(__dirname, store.PATHS.pets);
    security.protectSession(session.defaultSession, allowedDirs);

    host.start({
      prefs,
      get links() { return links; },
      save,
      nodePath,
      onChange: () => notifyStudio(),
      menuFor,
      openStudio,
    });
    helper.start();
    wireStudio();

    // A restarted GPU process can leave transparent pet windows blank until they repaint.
    app.on('child-process-gone', (_e, details) => {
      if (details.type === 'GPU' && details.reason !== 'clean-exit') setTimeout(() => host.repaintAll(), 1500);
    });
    const { screen } = require('electron');
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, (_e, display, changed) => lifecycle.trace(event, { id: display.id, bounds: display.bounds, workArea: display.workArea, changed }));
    }
    applyHotkeys();
    startTextAvoid();

    // HARNESS_PET_MENUTEST=1 builds every pet's menu once and logs the result.
    if (process.env.HARNESS_PET_MENUTEST) {
      setTimeout(() => {
        let failed = false;
        for (const i of prefs.instances) {
          try {
            if (!host.manifestOf(i.uid)) throw new Error('Pet worker did not load a manifest');
            const m = menuFor(i.uid);
            console.log('[menutest] ok', i.uid, m.map((x) => x.label).filter(Boolean).join(' | '));
          } catch (err) {
            failed = true;
            console.log('[menutest] FAILED', i.uid, err.stack);
          }
        }
        console.log('[menutest] Studio:', studio && !studio.isDestroyed() ? studio.getTitle() : 'closed');
        app.exit(failed ? 1 : 0);
      }, 6000);
    }

    tray = new Tray(appIcon(16));
    tray.setToolTip('Harness Pet');
    tray.on('click', () => openStudio());
    buildTray();
    if (!process.env.HARNESS_PET_MENUTEST) setTimeout(() => askAboutKeyboard().catch((err) => console.warn('keyboard question failed:', err)), 4000);

    // Links can be edited by agents; pick up their changes.
    let linksMtime = 0;
    setInterval(() => {
      try {
        const m = fs.statSync(store.PATHS.links).mtimeMs;
        if (linksMtime && m !== linksMtime) {
          links = store.loadLinks();
          host.broadcastLinks();
          notifyStudio();
        }
        linksMtime = m;
      } catch {}
    }, 2000);
  }).catch(err => {
    console.error('Harness Pet startup failed:', err.code || 'STARTUP_FAILED');
    dialog.showErrorBox('Harness Pet could not start', 'Your files were preserved. Check free space and permissions for the app and user data folders. See README > Settings recovery before resetting any files.');
    app.quit();
  });

  // keep running in the tray even with every window closed
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => require('electron').globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    if (prefs) prefs.watchKeyboard = false; // stop in-flight capture without changing the saved preference
    if (keys) keys.stop();
    if (avoider) avoider.stop();
    helper.stop();
    host.stopAll();
  });
}

if (typeof module !== 'undefined') module.exports = { openStudio };

