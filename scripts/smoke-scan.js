// Run with: npx electron scripts/smoke-scan.js
// Checks, on this machine, that a screenshot can be taken and mapped for text, and that a
// window marked with content protection (which is how pets are hidden from the capture)
// really is missing from the screenshot.

const { app, BrowserWindow, screen } = require('electron');
const { scanDisplay } = require('../lib/screen-scan');
const { countText } = require('../lib/text-map');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const box = { x: b.x + 300, y: b.y + 300, w: 260, h: 200 };
  const win = new BrowserWindow({ x: box.x, y: box.y, width: box.w, height: box.h, frame: false, show: false, alwaysOnTop: true, focusable: false, resizable: false,
    webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23d22"><div style="font:14px monospace;color:%23fff;padding:8px">' +
    Array.from({ length: 9 }, (_, i) => 'The quick brown fox jumps ' + i).join('<br>') + '</div></body>');
  win.showInactive();
  await wait(600);

  const probe = { x: box.x, y: box.y, w: box.w, h: box.h };
  const out = {};
  for (const hidden of [false, true]) {
    win.setContentProtection(hidden);
    await wait(120);
    const t0 = Date.now();
    const grid = await scanDisplay(display, null, () => true); // explicit manual capture diagnostic
    const ms = Date.now() - t0;
    if (!grid) { console.log('scan returned null (protection ' + hidden + ')'); app.exit(1); return; }
    out[hidden ? 'hidden' : 'visible'] = { textCellsInWindowArea: countText(grid, probe), totalTextCells: grid.text.reduce((a, c) => a + c, 0), cells: grid.cols * grid.rows, ms };
  }
  console.log(JSON.stringify({ display: { id: display.id, bounds: b, scale: display.scaleFactor }, ...out }, null, 2));
  const ok = out.visible.textCellsInWindowArea > 10 && out.hidden.textCellsInWindowArea < out.visible.textCellsInWindowArea / 2;
  console.log(ok ? 'SMOKE OK: the window is in the capture normally and missing when protected' : 'SMOKE CHECK FAILED');
  win.destroy();
  app.exit(ok ? 0 : 2);
});
