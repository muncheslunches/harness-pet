// Native Chromium input against an isolated renderer; no running pets or preferences change.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 900,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '../pet-window/preload.js') } });
  try {
    await win.loadFile(path.join(__dirname, '../pet-window/index.html'));
    for (const harness of ['antigravity', 'codex']) {
      for (const state of ['thinking', 'working']) {
        const inst = store.newInstance('test.pet.js', harness);
        inst.harness = harness;
        const sessions = [1, 2].map(n => ({ sessionId: `${harness}-${n}`, title: `Task ${n}`,
          model: 'Test model', effective: state, state, detail: state, age: 0 }));
        await win.webContents.executeJavaScript(`inst = ${JSON.stringify(inst)};
          sessions = ${JSON.stringify(sessions)}; render(); toggleList(false);`);
        const point = await win.webContents.executeJavaScript(`(() => {
          const r = bubble.querySelector('.more').getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        await pause(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        await pause(60);
        const result = await win.webContents.executeJavaScript(`({ open: !list.hidden,
          count: rows.children.length, titles: Array.from(rows.querySelectorAll('.row-title'), r => r.textContent) })`);
        assert.equal(result.open, true, `${harness}/${state}: +1 opens the list`);
        assert.equal(result.count, 2);
        assert.deepEqual(result.titles, ['Task 1', 'Task 2']);
        // A session update must preserve the header's close button.
        await win.webContents.executeJavaScript('render()');
        const closePoint = await win.webContents.executeJavaScript(`(() => {
          const r = document.getElementById('list-close').getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...closePoint });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...closePoint });
        await pause(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...closePoint });
        await pause(60);
        const closed = await win.webContents.executeJavaScript(`({ hidden: list.hidden,
          bubbleVisible: !bubble.hidden, mode: inst.barMode, more: bubble.querySelector('.more').textContent })`);
        assert.deepEqual(closed, { hidden: true, bubbleVisible: true, mode: 'expanded', more: '+1' });
        console.log(`PASS ${harness}/${state}: +1 opens both sessions; close restores compact bubble`);
      }
    }
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
