const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const store = require('../lib/store');
const library = require('../lib/library');

test('cage pet exists and is valid', () => {
  const cageRef = library.refOf(path.join(store.PATHS.pets, 'cage.pet.js'));
  assert.equal(cageRef, 'builtin:cage');
  const file = library.fileOf('builtin:cage');
  assert.ok(fs.existsSync(file));
  const pet = library.read('builtin:cage');
  assert.ok(pet.code.includes("id: 'cage'"));
});

function hostRig() {
  const handlers = {};
  const windows = [];
  class FakeWindow {
    constructor() {
      this.destroyed = false;
      this.visible = true;
      this.bounds = { x: 0, y: 0, width: 200, height: 200 };
      this.webContents = {
        send: () => {},
        setVisualZoomLevelLimits: () => {},
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
        on: () => {},
        isCrashed: () => false,
      };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    close() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
    getBounds() { return this.bounds; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    setAlwaysOnTop(onTop, level, relative) { this.alwaysOnTop = { onTop, level, relative }; }
    setIgnoreMouseEvents(ignore) { this.ignoring = ignore; }
    loadFile() {}
    moveTop() {}
    on() {}
  }

  const file = path.join(__dirname, '../lib/pet-host.js');
  const requireHost = createRequire(file);
  const context = vm.createContext({
    module: { exports: {} },
    __dirname: path.dirname(file),
    process,
    console,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    require: (name) => {
      if (name === 'electron') {
        return {
          BrowserWindow: FakeWindow,
          ipcMain: { on: (k, fn) => { handlers[k] = fn; }, handle: (k, fn) => { handlers[k] = fn; } },
          screen: {
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 }),
            getCursorScreenPoint: () => ({ x: 500, y: 500 }),
            getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
            getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
          },
        };
      }
      if (name === './helper') return { foreground() { return Promise.resolve('1'); }, refocus() { return Promise.resolve('ok'); } };
      if (name === './library') return { ...requireHost(name), watch: () => 1 };
      return requireHost(name);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { context, handlers, host: context.module.exports, run: (c) => vm.runInContext(c, context) };
}

test('cage activation, positioning, and dismiss protection', () => {
  const rig = hostRig();
  const host = rig.host;
  const prefs = {
    instances: [
      store.newInstance('builtin:clawrk', 'claude-code'),
      store.newInstance('builtin:clawrk', null),
    ],
    cageEnabled: false,
  };
  const saveCalls = [];
  const changes = [];
  const ctx = {
    prefs,
    save: () => saveCalls.push(JSON.parse(JSON.stringify(prefs))),
    onChange: () => changes.push(true),
    links: { links: {} },
    nodePath: 'node',
    menuFor: () => [],
    openStudio: () => {},
  };

  host.start(ctx);

  // 1. Enabling cage
  host.setCageEnabled(true);
  assert.equal(prefs.cageEnabled, true);
  assert.equal(prefs.instances.length, 3);
  const first = prefs.instances[0];
  assert.equal(first.isCage, true);
  assert.equal(first.pet, 'builtin:cage');
  assert.equal(first.barMode, 'off');

  // 2. Cage cannot be dismissed
  host.removeInstance(first.uid);
  assert.equal(prefs.instances[0].isCage, true);

  // 3. Sorting with cage active: regular pets cannot move above cage (min index 1)
  const petA = prefs.instances[1];
  const petB = prefs.instances[2];
  assert.notEqual(petA.uid, petB.uid);

  // Attempt to move petA up above cage -> should stay at index 1
  host.moveInstance(petA.uid, -1);
  assert.equal(prefs.instances[1].uid, petA.uid);

  // Move petA down -> should swap with petB
  host.moveInstance(petA.uid, 1);
  assert.equal(prefs.instances[1].uid, petB.uid);
  assert.equal(prefs.instances[2].uid, petA.uid);

  // Move petA back up
  host.moveInstance(petA.uid, -1);
  assert.equal(prefs.instances[1].uid, petA.uid);
  assert.equal(prefs.instances[2].uid, petB.uid);

  // Cage itself cannot be moved
  host.moveInstance(first.uid, 1);
  assert.equal(prefs.instances[0].isCage, true);

  // 4. Caging a pet: speedFactor is reduced by 60% (0.4x)
  rig.context.petA = petA;
  const normalSpeed = rig.run('speedFactor(petA)');
  petA.caged = true;
  const cagedSpeed = rig.run('speedFactor(petA)');
  assert.ok(Math.abs(cagedSpeed - normalSpeed * 0.4) < 1e-6);

  // 5. Disabling cage releases caged pets and removes cage
  host.setCageEnabled(false);
  assert.equal(prefs.cageEnabled, false);
  assert.equal(prefs.instances.some(i => i.isCage), false);
  assert.equal(petA.caged, false);

  // 6. Sorting without cage: pets can move to index 0
  host.moveInstance(petB.uid, -1);
  assert.equal(prefs.instances[0].uid, petB.uid);
  assert.equal(prefs.instances[1].uid, petA.uid);
});

test('caging overlap, drag-drop constraints, and avoidance', () => {
  const rig = hostRig();
  const host = rig.host;
  const prefs = {
    instances: [
      store.newInstance('builtin:clawrk', null),
      store.newInstance('builtin:clawrk', null),
    ],
    cageEnabled: true,
  };
  const ctx = {
    prefs,
    save: () => {},
    onChange: () => {},
    links: { links: {} },
    nodePath: 'node',
    menuFor: () => [],
    openStudio: () => {},
  };

  host.start(ctx);
  host.setCageEnabled(true);
  const cage = prefs.instances[0];
  const petA = prefs.instances[1];
  const petB = prefs.instances[2];

  // Set cage ready & positioned
  const cageRt = rig.run("live.get('cage')");
  cageRt.ready = true;
  cageRt.rect = { x: 0, y: 0, w: 154, h: 166 };
  cageRt.anchor = { x: 300, y: 300 };

  const petARt = rig.run(`live.get('${petA.uid}')`);
  petARt.ready = true;
  petARt.rect = { x: 0, y: 0, w: 110, h: 110 };
  petARt.anchor = { x: 100, y: 100 };

  // 1. Uncaged pet does not overlap cage
  rig.context.petA = petA;
  const hitCage = rig.run(`overlapsOther('${petA.uid}', { x: 320, y: 320, w: 110, h: 110 })`);
  assert.equal(hitCage, null);

  // 2. Caged pet does not overlap other pets
  petA.caged = true;
  const hitOther = rig.run(`overlapsOther('${petA.uid}', { x: 100, y: 100, w: 110, h: 110 })`);
  assert.equal(hitOther, null);

  // 3. Cage interior calculation
  const interior = rig.run(`cageInterior(live.get('cage'), live.get('${petA.uid}'))`);
  assert.ok(interior.x0 > 300);
  assert.ok(interior.x1 <= 300 + 154);
  assert.ok(interior.y0 > 300);
  assert.ok(interior.y1 <= 300 + 166);

  // 4. Clamping inside cage
  petARt.anchor = { x: 50, y: 50 }; // outside
  rig.run(`clampInsideCage(petA, live.get('${petA.uid}'), live.get('cage'))`);
  assert.ok(petARt.anchor.x >= interior.x0 && petARt.anchor.x <= interior.x1);
  assert.ok(petARt.anchor.y >= interior.y0 && petARt.anchor.y <= interior.y1);

  // 5. Hiding cage releases caged pets
  host.setInstance(cage.uid, { visible: false });
  assert.equal(petA.caged, false);
});

test('shaking the cage frees every pet inside; shaking a caged pet frees just it', () => {
  const rig = hostRig();
  const prefs = {
    instances: [store.newInstance('builtin:clawrk', null), store.newInstance('builtin:clawrk', null), store.newInstance('builtin:clawrk', null)],
    cageEnabled: true,
  };
  rig.host.start({ prefs, save: () => {}, onChange: () => {}, links: { links: {} }, nodePath: 'node', menuFor: () => [], openStudio: () => {} });
  rig.host.setCageEnabled(true);
  const [cage, petA, petB, petC] = prefs.instances;
  const cageRt = rig.run("live.get('cage')");
  Object.assign(cageRt, { ready: true, rect: { x: 0, y: 0, w: 154, h: 166 }, anchor: { x: 600, y: 500 } });
  cageRt.win.bounds = { x: 600, y: 500, width: 154, height: 166 }; // being dragged: the window is where the cage is now
  const rts = [petA, petB, petC].map((p) => {
    const rt = rig.run(`live.get('${p.uid}')`);
    Object.assign(rt, { ready: true, rect: { x: 0, y: 0, w: 110, h: 110 }, anchor: { x: 620, y: 540 } });
    return rt;
  });
  petA.caged = petB.caged = true;
  Object.assign(rig.context, { cage, petA, petC });

  rig.run("shaken(cage, live.get('cage'))");
  assert.equal(petA.caged, false);
  assert.equal(petB.caged, false);
  const outside = (rt) => rt.anchor.x + 110 <= 600 - 20 || rt.anchor.x >= 600 + 154 + 20 || rt.anchor.y + 110 <= 500 - 20;
  assert.ok(outside(rts[0]) && outside(rts[1]), 'freed pets land clear of the cage');
  assert.notEqual(Math.sign(rts[0].anchor.x - 600), Math.sign(rts[1].anchor.x - 600), 'one tumbles out each side');

  // a caged pet shaken while it is dragged is freed and not caught again when dropped back in
  petA.caged = true;
  rts[0].drag = { wx: 620, wy: 540, sx: 0, sy: 0 };
  const before = { ...rts[0].anchor };
  rig.run("shaken(petA, live.get(petA.uid))");
  assert.equal(petA.caged, false);
  assert.equal(rts[0].shakenFree, true);
  assert.deepEqual([rts[0].anchor.x, rts[0].anchor.y], [before.x, before.y], 'it stays in your hand');

  // shaking a pet that is not caged changes nothing
  rig.run("shaken(petC, live.get(petC.uid))");
  assert.equal(petC.caged, undefined);
});
