// The mouse-lag logger: stalls, slow handlers and click-through flapping, with fake Electron parts.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const diag = require('../lib/diag');

function rig() {
  let t = 0;
  const timers = [];
  const lines = [];
  const ipcMain = new EventEmitter();
  const proto = { setIgnoreMouseEvents() {} };
  const win = Object.assign(Object.create(proto), {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 900, height: 900 }),
  });
  const sender = {};
  diag.install({
    ipcMain,
    windowProto: proto,
    screen: { getCursorScreenPoint: () => ({ x: 450, y: 450 }) },
    pets: () => [{ name: 'clawrk', win }],
    nameOfSender: (wc) => (wc === sender ? 'clawrk' : null),
    now: () => t,
    write: (line) => lines.push(line),
    setInterval: (fn, every) => timers.push({ fn, every }),
  });
  const tick = (every) => timers.filter((x) => x.every === every).forEach((x) => x.fn());
  return { ipcMain, win, sender, lines, tick, advance: (ms) => (t += ms) };
}

test('a late tick is logged as a stall, with the cursor and the IPC that ran before it', () => {
  const r = rig();
  r.ipcMain.on('pet:hold', function (e, kind) { r.win.setIgnoreMouseEvents(!kind); r.advance(300); });
  r.ipcMain.emit('pet:hold', { sender: r.sender }, 'menu');
  r.tick(diag.TICK);
  const stall = r.lines.find((l) => l.includes('STALL'));
  assert.ok(stall, r.lines.join('\n'));
  assert.match(stall, /inside window of: clawrk \(catching mouse\)/);
  assert.match(stall, /clawrk: pet:hold\("menu"\)/);
  assert.ok(r.lines.some((l) => l.includes('SLOW ipc pet:hold("menu") from clawrk')));
});

test('rapid click-through flips are flagged as flapping and counted in the summary', () => {
  const r = rig();
  for (let i = 0; i < diag.FLAP; i++) {
    r.win.setIgnoreMouseEvents(i % 2 === 1);
    r.advance(50);
  }
  assert.ok(r.lines.some((l) => l.includes(`FLAP clawrk flipped click-through ${diag.FLAP}×`)), r.lines.join('\n'));
  r.tick(5000);
  assert.ok(r.lines.some((l) => l.startsWith('[') && l.includes('windows | clawrk 900×900 at 0,0')));
  assert.ok(r.lines.some((l) => l.includes(`clawrk: ${diag.FLAP} flips`)), r.lines.join('\n'));
});

test('handlers keep their return value and errors still reach the caller', () => {
  const r = rig();
  r.ipcMain.on('boom', () => { throw new Error('nope'); });
  assert.throws(() => r.ipcMain.emit('boom', { sender: r.sender }), /nope/);
});
