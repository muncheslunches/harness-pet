// Run with: npx electron scripts/e2e-avoid.js [phrase|typing]
// End to end, on this machine: a window full of text, a pet standing on it, a second copy of
// the app (with its own data folder, so your real pets are untouched), and either "GO AWAY"
// typed with Caps Lock on (phrase, the default) or ordinary typing (typing). Passes when the
// pet ends up off the text. Needs the text window to have
// keyboard focus; if it cannot get it, the test stops instead of typing into another app.

const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const TEXT = { x: 100, y: 100, w: 700, h: 500 };

const MODE = process.argv.includes('typing') ? 'typing' : 'phrase';

function typeCommand() {
  const script = MODE === 'typing' ? `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
foreach ($i in 1..30) { [W.K]::keybd_event(0x4C,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x4C,0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100 }` : `
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
function Tap($vk){ [W.K]::keybd_event($vk,0,0,[UIntPtr]::Zero); [W.K]::keybd_event($vk,0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
$was = [System.Console]::CapsLock
if (-not $was) { Tap 0x14 }
Start-Sleep -Milliseconds 150
foreach ($c in 'G','O',' ','A','W','A','Y') { if ($c -eq ' ') { Tap 0x20 } else { Tap ([byte][char]$c) } }
Start-Sleep -Milliseconds 1200
if (-not $was) { Tap 0x14 }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

app.whenReady().then(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-e2e-'));
  const data = path.join(home, '.harness-pet');
  fs.mkdirSync(data, { recursive: true });
  const inst = store.newInstance('builtin:clawrk', null);
  inst.pos = { x: 300, y: 300 };
  Object.assign(inst.behavior, { avoidText: MODE === 'typing', wander: false, tricks: 'off', nap: false, avoidCursor: false, followCursor: false });
  fs.writeFileSync(path.join(data, 'prefs.json'), JSON.stringify({ instances: [inst], watchKeyboard: true, keyboardAsked: true }));
  const readPos = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'prefs.json'), 'utf8')).instances[0].pos; } catch { return null; } };

  const lines = Array.from({ length: 34 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog and keeps on running`).join('<br>');
  const win = new BrowserWindow({ x: TEXT.x, y: TEXT.y, width: TEXT.w, height: TEXT.h, frame: false, webPreferences: { sandbox: true } });
  await win.loadURL(`data:text/html,<body style="margin:0;background:white;color:black;font:14px Consolas,monospace;padding:8px;overflow:hidden"><div id=t style="display:inline-block;white-space:nowrap">${lines}</div></body>`);
  const textRight = TEXT.x + 8 + await win.webContents.executeJavaScript('document.getElementById("t").offsetWidth');

  const child = spawn(process.execPath, [ROOT, '--user-data-dir=' + path.join(home, 'ud')], {
    env: { ...process.env, USERPROFILE: home, HOME: home, HARNESS_PET_KEYWATCH_INJECTED: '1', ELECTRON_RUN_AS_NODE: undefined, HARNESS_PET_AVOID_LOG: '1' }, stdio: ['ignore', fs.openSync(path.join(home, 'app.log'), 'a'), fs.openSync(path.join(home, 'app.log'), 'a')],
  });
  const finish = (code, msg) => { try { require('../lib/helper').stop(); } catch {} console.log(msg); try { console.log(fs.readFileSync(path.join(home, 'app.log'), 'utf8').slice(-1500)); } catch {} try { child.kill(); } catch {} win.destroy(); app.exit(code); };

  await wait(9000); // pet window, key watcher and text helper start up
  // Typing goes to whichever window Windows says is in front, so ask Windows, not Electron.
  const helper = require('../lib/helper');
  const hwnd = () => { const b = win.getNativeWindowHandle(); return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString(); };
  const hasFocus = async () => (await helper.foreground()) === hwnd();
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  await wait(700);
  if (!(await hasFocus())) {
    helper.stop();
    return finish(3, 'ABORTED: the text window is not the window in front, so nothing was typed (try again without touching the mouse)');
  }
  const before = readPos();
  console.log('pet before:', JSON.stringify(before));
  if (!(await hasFocus())) { helper.stop(); return finish(3, 'ABORTED: focus moved away just before typing; nothing was typed'); }
  typeCommand();
  let after = before;
  let moved = false;
  let steadySince = 0;
  for (let i = 0; i < 70; i++) { // a walk takes several seconds; wait until the pet has been still for 3 s
    await wait(500);
    const now = readPos();
    if (now && after && (Math.abs(now.x - after.x) + Math.abs(now.y - after.y) > 1)) { moved = true; steadySince = Date.now(); }
    after = now;
    if (moved && Date.now() - steadySince > 3000) break;
  }
  console.log('pet after: ', JSON.stringify(after));
  const off = after && (after.x >= textRight || after.x + 110 <= TEXT.x || after.y >= TEXT.y + TEXT.h || after.y + 110 <= TEXT.y);
  finish(off ? 0 : 2, off ? 'E2E OK: the pet left the text' : 'E2E FAILED: the pet is still on the text');
});
