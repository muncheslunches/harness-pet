// New pets on screen start with no agent; only the very first Clawrk follows Claude Code.

const test = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');

test('a new pet on screen follows no agent and shows both default buttons', () => {
  const inst = store.newInstance('C:\pets\sun.pet.js');
  assert.strictEqual(inst.harness, null);
  assert.deepStrictEqual(inst.buttons, [0, 1]);
});

test('an explicit agent is kept', () => {
  assert.strictEqual(store.newInstance('builtin:clawrk', 'claude-code').harness, 'claude-code');
});

test('dismissed pets restore independent behavior, animation, button, and sound settings', () => {
  const prefs = {};
  const original = store.newInstance('bird.pet.js', 'codex');
  original.behavior.followCursor = true;
  original.animOff.dig = true;
  original.params.fly = { speed: 2 };
  original.sound = { muted: true, volume: 0.15, anims: { done: { on: false } } };
  original.buttons = [null, 1];
  original.size = 0.25;
  store.rememberPet(prefs, original);
  const restored = store.restorePet(prefs, original.pet);
  assert.notStrictEqual(restored.uid, original.uid);
  for (const key of ['harness', 'behavior', 'animOff', 'params', 'sound', 'buttons', 'size']) assert.deepStrictEqual(restored[key], original[key]);
  restored.behavior.followCursor = false;
  assert.strictEqual(store.restorePet(prefs, original.pet).behavior.followCursor, true);
  assert.strictEqual(store.restorePet(prefs, 'sun.pet.js').behavior.followCursor, false);
});

test('temporary duplicate settings do not replace the original pet preferences', () => {
  const prefs = {};
  const original = store.newInstance('bird.pet.js');
  store.rememberPet(prefs, original);
  const duplicate = require('../lib/instance-options').duplicate(original);
  duplicate.size = 4;
  store.rememberPet(prefs, duplicate);
  assert.strictEqual(store.restorePet(prefs, original.pet).size, 1);
});

test('pets live in a source checkout, or in the data folder for an installed app', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-root-'));
  const data = path.join(root, 'data');
  assert.strictEqual(store.petsDir(root, data), path.join(data, 'pets'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'harness-pet' }));
  assert.strictEqual(store.petsDir(root, data), path.join(root, 'pets'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('watching the keyboard requires recorded consent for new and legacy setups', () => {
  // in a child process with a temporary home, so the real prefs are untouched
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'));
  const script = `
    const fs = require('fs');
    const store = require('./lib/store');
    const fresh = store.loadPrefs();
    fs.mkdirSync(store.PATHS.data, { recursive: true });
    fs.writeFileSync(store.PATHS.prefs, JSON.stringify({ instances: [] }));
    const existing = store.loadPrefs();
    console.log(JSON.stringify([fresh.watchKeyboard, fresh.keyboardAsked, existing.watchKeyboard, existing.keyboardAsked]));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), [false, false, false, false]);
});

test('legacy builtin:clawd references migrate cleanly to builtin:clawrk on upgrade', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-legacy-home-'));
  try {
    const dataDir = path.join(home, '.harness-pet');
    fs.mkdirSync(dataDir, { recursive: true });
    const legacyPrefs = {
      instances: [
        { uid: 'p-alpha-1', pet: 'builtin:clawd', harness: 'claude-code', buttons: [0, 1], visible: true, size: 1.5, barMode: 'expanded' },
        { uid: 'p-alpha-2', pet: path.join(dataDir, 'pets', 'clawd.pet.js'), harness: null, buttons: [0, 1], visible: true, size: 1, barMode: 'mini' },
      ],
      petSettings: {
        'builtin:clawd': { size: 1.5, sound: { muted: false, volume: 0.5 } }
      }
    };
    fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify(legacyPrefs));

    const { spawnSync } = require('child_process');
    const script = `
      const store = require('./lib/store');
      const library = require('./lib/library');
      const prefs = store.loadPrefs();
      const file = library.fileOf('builtin:clawd');
      console.log(JSON.stringify({
        inst1: prefs.instances[0].pet,
        inst2: prefs.instances[1].pet,
        size: prefs.instances[0].size,
        hasClawrkSettings: !!prefs.petSettings['builtin:clawrk'],
        fileFound: require('fs').existsSync(file)
      }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8'
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert.strictEqual(parsed.inst1, 'builtin:clawrk');
    assert.strictEqual(parsed.inst2, 'builtin:clawrk');
    assert.strictEqual(parsed.size, 1.5);
    assert.strictEqual(parsed.hasClawrkSettings, true);
    assert.strictEqual(parsed.fileFound, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
