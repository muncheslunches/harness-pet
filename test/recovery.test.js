const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const library = require('../lib/library');

function fixture(t) {
  const parent = path.join(__dirname, '../.test-tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'hp-recovery-'));
  const old = { ...store.PATHS };
  Object.assign(store.PATHS, { data: root, prefs: path.join(root, 'prefs.json'), links: path.join(root, 'links.json'), pets: path.join(root, 'pets'), builtinPets: path.join(root, 'pets') });
  fs.mkdirSync(store.PATHS.pets);
  t.after(() => { Object.assign(store.PATHS, old); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('corrupt and invalid preferences are preserved byte-for-byte before defaults are saved', t => {
  const root = fixture(t);
  for (const text of ['\uFEFF{broken\r\n', '[]', '{"instances":[null]}', '{"instances":[],"petSettings":[]}']) {
    store.PATHS.prefs = path.join(root, Math.random() + '.json');
    const original = Buffer.from(text);
    fs.writeFileSync(store.PATHS.prefs, original);
    const prefs = store.loadPrefs();
    assert.equal(prefs.watchKeyboard, false);
    assert.equal(prefs.instances.length, 1);
    store.savePrefs(prefs);
    const issue = store.recoveryIssues().find(i => i.file === store.PATHS.prefs);
    assert.deepEqual(fs.readFileSync(issue.backup), original);
    assert.equal(JSON.parse(fs.readFileSync(store.PATHS.prefs)).instances.length, 1);
  }
});

test('invalid links stay untouched on read and are backed up before an explicit save', t => {
  fixture(t);
  const original = '{"links":{"bad":{"buttons":[{"label":"bad","open":{"url":"javascript:bad"}}]}}}';
  fs.writeFileSync(store.PATHS.links, original);
  const value = store.loadLinks();
  assert.equal(fs.readFileSync(store.PATHS.links, 'utf8'), original);
  assert.ok(value.links['claude-code']);
  store.saveLinks(value);
  const issue = store.recoveryIssues().find(i => i.file === store.PATHS.links);
  assert.equal(fs.readFileSync(issue.backup, 'utf8'), original);
});

test('backup, temporary-write and rename failures preserve originals and clean temporary files', t => {
  const root = fixture(t);
  for (const method of ['copyFileSync', 'writeFileSync', 'renameSync']) {
    store.PATHS.prefs = path.join(root, method + '.json');
    const original = Buffer.from('{ broken settings');
    fs.writeFileSync(store.PATHS.prefs, original);
    const prefs = store.loadPrefs();
    const fn = fs[method];
    fs[method] = () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' }); };
    try { assert.throws(() => store.savePrefs(prefs), /synthetic disk failure/); }
    finally { fs[method] = fn; }
    assert.deepEqual(fs.readFileSync(store.PATHS.prefs), original);
    assert.equal(fs.readdirSync(root).some(n => n.endsWith('.tmp')), false);
  }
});

test('unreadable settings block replacement and external edits are not overwritten', t => {
  const root = fixture(t);
  const original = '{"instances":[]}';
  fs.writeFileSync(store.PATHS.prefs, original);
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === store.PATHS.prefs) throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' });
    return read(file, ...args);
  };
  let prefs;
  try { prefs = store.loadPrefs(); } finally { fs.readFileSync = read; }
  assert.throws(() => store.savePrefs(prefs), /unreadable/);
  assert.equal(fs.readFileSync(store.PATHS.prefs, 'utf8'), original);
  store.PATHS.prefs = path.join(root, 'external.json');
  fs.writeFileSync(store.PATHS.prefs, original);
  prefs = store.loadPrefs();
  fs.writeFileSync(store.PATHS.prefs, '{"instances":[],"external":true}');
  assert.throws(() => store.savePrefs(prefs), /changed on disk/);
  assert.equal(JSON.parse(fs.readFileSync(store.PATHS.prefs)).external, true);
});

test('recorded keyboard consent is retained; legacy watcher flags alone never authorize capture', t => {
  const root = fixture(t);
  for (const [n, flags, expected] of [[1, { watchKeyboard: true, keyboardAsked: true }, false], [2, { watchKeyboard: true, keyboardAsked: true, keyboardConsentVersion: 1 }, true], [3, { watchKeyboard: false, keyboardAsked: true, keyboardConsentVersion: 1 }, false]]) {
    store.PATHS.prefs = path.join(root, n + '.json');
    fs.writeFileSync(store.PATHS.prefs, JSON.stringify({ instances: [], ...flags }));
    assert.equal(store.loadPrefs().watchKeyboard, expected);
  }
});

test('pet library rejects arbitrary read/delete, missing files and junction escapes', t => {
  const root = fixture(t);
  const inside = path.join(store.PATHS.pets, 'test.pet.js');
  const outside = path.join(root, 'private.pet.js');
  fs.writeFileSync(inside, 'definePet({})'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(root, path.join(store.PATHS.pets, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(library.read(inside).code, 'definePet({})');
  for (const file of [outside, path.join(store.PATHS.pets, 'escape', 'private.pet.js'), path.join(store.PATHS.pets, 'missing.pet.js')]) {
    assert.throws(() => library.read(file), /missing|outside/);
    assert.throws(() => library.remove(file), /missing|outside/);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
  assert.throws(() => library.fileOf('builtin:../../private'));
  fs.writeFileSync(path.join(store.PATHS.pets, 'clawrk.pet.js'), 'builtin');
  assert.throws(() => library.remove(path.join(store.PATHS.pets, 'clawrk.pet.js')), /Built-in/);
  library.remove(inside); assert.equal(fs.existsSync(inside), false);
});
