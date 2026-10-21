// Exercise real Electron renderers against isolated preferences; no user state is changed.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const home = fs.mkdtempSync(path.join(root, '.test-tmp', 'electron-input-'));
process.env.USERPROFILE = process.env.HOME = home;
app.setPath('userData', path.join(home, 'electron'));
const store = require('../lib/store');
store.ensureDirs();
const prefs = store.loadPrefs();
prefs.instances = ['clawrk', 'clawrk', 'clawrk', 'clawrk'].map((name) => {
  const inst = store.newInstance(path.join(root, 'pets', name + '.pet.js'));
  inst.behavior.wander = false;
  inst.behavior.nap = false;
  inst.sound.muted = true;
  inst.pos = { x: 100, y: 100 };
  inst.visible = false;
  return inst;
});
prefs.keyboardAsked = true; // no first-run question during the smoke test
store.savePrefs(prefs);
require('../main');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const menuVisible = (win) => win.webContents.executeJavaScript('!document.getElementById("menu").hidden');

app.whenReady().then(async () => {
  try {
    let windows;
    for (let tries = 0; tries < 100; tries++) {
      windows = BrowserWindow.getAllWindows();
      if (windows.length === 4 && (await Promise.all(windows.map((w) => w.webContents.executeJavaScript('!!player.manifest').catch(() => false)))).every(Boolean)) break;
      await pause(100);
    }
    assert.equal(windows.length, 4);
    // Chromium emits pointerdown only for the first pressed mouse button. A
    // second button (or a stale button state) must still work via mousedown.
    const chordPet = windows[0];
    chordPet.showInactive();
    chordPet.setIgnoreMouseEvents(false);
    const chordPoint = await chordPet.webContents.executeJavaScript(`(() => { const r = document.getElementById('pet-wrap').getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
    const chordPos = chordPet.getPosition();
    const chordInput = { ...chordPoint, globalX: chordPos[0] + chordPoint.x, globalY: chordPos[1] + chordPoint.y, clickCount: 1 };
    chordPet.webContents.sendInputEvent({ ...chordInput, type: 'mouseDown', button: 'right' });
    await pause(50);
    chordPet.webContents.sendInputEvent({ ...chordInput, type: 'mouseDown', button: 'middle', modifiers: ['rightButtonDown'] });
    await pause(100);
    assert.equal(await menuVisible(chordPet), true, 'middle-click works even with another button down');
    chordPet.webContents.sendInputEvent({ ...chordInput, type: 'mouseUp', button: 'middle', modifiers: ['rightButtonDown'] });
    chordPet.webContents.sendInputEvent({ ...chordInput, type: 'mouseUp', button: 'right' });
    await chordPet.webContents.executeJavaScript('closeMenu()');
    chordPet.hide();
    for (const win of windows) {
      await win.webContents.executeJavaScript(`{
        const r = document.getElementById('pet-wrap').getBoundingClientRect();
        document.getElementById('pet-wrap').dispatchEvent(new MouseEvent('mousedown', {
          button: 1, bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        }));
      }`);
      await pause(100);
      assert.equal(await menuVisible(win), true, 'middle-click opens this pet menu');
      assert.equal(win.isFocusable(), true);
      for (const other of windows.filter((w) => w !== win)) {
        assert.equal(await menuVisible(other), false, 'previous menu closes');
        assert.equal(other.isFocusable(), false);
      }
      const transparent = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('menu')).pointerEvents`);
      assert.equal(transparent, 'none');
      const panelHits = await win.webContents.executeJavaScript(`JSON.parse(hitsSent).filter(r => r.menu).length`);
      assert.ok(panelHits >= 1, 'menu panels have native hit regions');
    }
    const last = windows.at(-1);
    await last.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await pause(100);
    assert.equal(await menuVisible(last), false);
    assert.equal(last.isFocusable(), false);
    last.showInactive();
    await last.webContents.executeJavaScript(`document.getElementById('pet-wrap').dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, clientX: 400, clientY: 400 }))`);
    await pause(100);
    assert.equal(last.isFocused(), true, 'a visible popup accepts keyboard focus');
    await last.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mi')).find(r => r.querySelector('.lb').textContent === 'Behavior').click()`);
    await pause(100);
    await last.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mi')).find(r => r.querySelector('.lb').textContent === 'Pass through other pets').click()`);
    await pause(100);
    assert.equal(await last.webContents.executeJavaScript('inst.behavior.passThroughPets'), true);
    assert.equal(await menuVisible(last), false, 'choosing an item dismisses the popup');
    await last.webContents.executeJavaScript(`document.getElementById('pet-wrap').dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, clientX: 400, clientY: 400 }))`);
    await pause(100);
    const outside = new BrowserWindow({ width: 100, height: 100, show: false });
    outside.show();
    outside.focus();
    await pause(150);
    assert.equal(await menuVisible(last), false, 'switching focus outside the pet closes the popup');
    outside.destroy();
    last.hide();
    for (const win of windows) {
      win.showInactive();
      win.setIgnoreMouseEvents(false);
      await pause(100);
      const start = win.getPosition();
      const pet = await win.webContents.executeJavaScript(`(() => { const r = document.getElementById('pet-wrap').getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pet,
        globalX: start[0] + pet.x, globalY: start[1] + pet.y });
      await pause(80);
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: pet.x + 25, y: pet.y + 25,
        globalX: start[0] + pet.x + 25, globalY: start[1] + pet.y + 25 });
      await pause(80);
      assert.equal(await win.webContents.executeJavaScript('dragging'), true);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: pet.x + 25, y: pet.y + 25 });
      await pause(80);
      const state = await win.webContents.executeJavaScript('({ dragging, press, holding })');
      assert.equal(state.dragging, false);
      assert.equal(state.press, null);
      assert.equal(state.holding, null);
      assert.notDeepEqual(win.getPosition(), start, 'pet window moved during drag');
      win.hide();
    }
    const refreshed = windows[0];
    const uid = await refreshed.webContents.executeJavaScript('inst.uid');
    refreshed.showInactive();
    refreshed.setIgnoreMouseEvents(false);
    const point = await refreshed.webContents.executeJavaScript(`(() => { const r = document.getElementById('pet-wrap').getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
    const pos = refreshed.getPosition();
    const input = { ...point, globalX: pos[0] + point.x, globalY: pos[1] + point.y, modifiers: ['control'], button: 'left' };
    for (let clickCount = 1; clickCount <= 2; clickCount++) {
      refreshed.webContents.sendInputEvent({ ...input, type: 'mouseDown', clickCount });
      await pause(30);
      refreshed.webContents.sendInputEvent({ ...input, type: 'mouseUp', clickCount });
      await pause(30);
    }
    await pause(600);
    assert.equal(refreshed.isDestroyed(), true, 'Ctrl double-click replaces the native window');
    const replacement = BrowserWindow.getAllWindows().find((w) => !windows.includes(w));
    assert.ok(replacement);
    assert.equal(await replacement.webContents.executeJavaScript('inst.uid'), uid);
    assert.equal(await replacement.webContents.executeJavaScript('inst.sound.muted'), true);
    assert.equal(await replacement.webContents.executeJavaScript('!!player.manifest'), true);
    await replacement.webContents.executeJavaScript(`window.host.menu()`);
    await pause(100);
    for (const label of ['Behavior', 'Size (100%)', 'Speech bubble', 'Window']) {
      await replacement.webContents.executeJavaScript(`{
        const row = Array.from(document.querySelectorAll('.mi')).find(r => r.dataset.level === '0' && r.querySelector('.lb').textContent.startsWith(${JSON.stringify(label.split(' (')[0])}));
        if (!row) throw Error('Missing submenu'); row.click();
      }`);
      assert.equal(await replacement.webContents.executeJavaScript(`document.querySelectorAll('.mi.open[data-level="0"]').length`), 1,
        'switching submenus clears the previous highlight');
    }
    await replacement.webContents.executeJavaScript('closeMenu()');
    const { openStudio } = require('../main');
    openStudio('hotkeys');
    let studio;
    for (let n = 0; n < 60; n++) {
      studio = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('studio/index.html'));
      if (studio) break;
      await pause(50);
    }
    assert.ok(studio, 'Studio window opened');
    const waitFor = async (expression) => {
      for (let n = 0; n < 60; n++) {
        if (await studio.webContents.executeJavaScript(expression)) return;
        await pause(50);
      }
      throw new Error('Timed out: ' + expression);
    };
    await waitFor(`!!document.querySelector('section[data-page="hotkeys"] .setting button[title="Clear"]')`);
    await studio.webContents.executeJavaScript(`{
      const row = document.querySelector('section[data-page="hotkeys"] .setting');
      row.querySelector('button.btn:not(.small)').click();
      row.querySelector('button[title="Clear"]').click();
    }`);
    await waitFor(`document.querySelector('section[data-page="hotkeys"] .setting button.btn').textContent === 'Not set'`);
    await studio.webContents.executeJavaScript(`{
      document.querySelector('section[data-page="hotkeys"] .setting button.btn').click();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyU', ctrlKey: true, altKey: true, bubbles: true }));
    }`);
    await waitFor(`document.querySelector('section[data-page="hotkeys"] .setting button.btn').textContent.includes('U')`);
    assert.equal(await studio.webContents.executeJavaScript(`S.hotkeys().then(h => h.hotkeys.togglePets)`), 'Ctrl+Alt+U');
    await studio.webContents.executeJavaScript(`{
      const buttons = document.querySelectorAll('section[data-page="hotkeys"] .setting button.btn:not(.small)');
      buttons[0].click(); buttons[1].click();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI', ctrlKey: true, altKey: true, bubbles: true }));
    }`);
    await waitFor(`document.querySelectorAll('section[data-page="hotkeys"] .setting button.btn:not(.small)')[1].textContent.includes('I')`);
    assert.equal(await studio.webContents.executeJavaScript(`S.hotkeys().then(h => h.hotkeys.togglePets)`), 'Ctrl+Alt+U');
    assert.equal(await studio.webContents.executeJavaScript(`S.hotkeys().then(h => h.hotkeys.jump)`), 'Ctrl+Alt+I');
    await studio.webContents.executeJavaScript(`document.querySelector('section[data-page="hotkeys"] .setting button.btn').click(); show('sounds');`);
    await pause(150);
    await studio.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', ctrlKey: true, altKey: true, bubbles: true }))`);
    assert.equal(await studio.webContents.executeJavaScript(`S.hotkeys().then(h => h.hotkeys.togglePets)`), 'Ctrl+Alt+U');
    studio.destroy();
    console.log('PASS: button chords; four drags; exclusive menus; Escape; focus loss; ghost toggle; Ctrl double-click refresh with settings preserved');
    console.log('PASS: hotkey record → clear → Not set → rebind; rapid recording switch; navigate away during capture');
    app.quit();
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
