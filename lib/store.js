// State and agent links live in ~/.harness-pet; the pet library lives beside the project.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const linkPolicy = require('./link-policy');
const issues = new Map();
const unreadable = new Set();
const originals = new Map();
const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);

const DATA = path.join(os.homedir(), '.harness-pet');
const APP_ROOT = path.basename(path.resolve(__dirname, '..', '..')) === 'resources'
  ? path.resolve(__dirname, '..', '..', '..', '..') : path.resolve(__dirname, '..');

// Pets live in the project when the app runs from (or is unpacked inside) a source
// checkout. An installed copy has no project around it, so they go in ~/.harness-pet;
// the folder above an install (e.g. C:\Program Files) is not ours to write to.
function petsDir(root = APP_ROOT, data = DATA) {
  try {
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'harness-pet') return path.join(root, 'pets');
  } catch {}
  return path.join(data, 'pets');
}

const PETS = petsDir();
const PATHS = {
  data: DATA,
  pets: PETS,
  sessions: path.join(DATA, 'sessions'),
  links: path.join(DATA, 'links.json'),
  prefs: path.join(DATA, 'prefs.json'),
  builtinPets: PETS,
  docs: path.join(APP_ROOT, 'docs', 'PET_FORMAT.md'),
};
const migratedRefs = new Map();

function ensureDirs() {
  for (const dir of [PATHS.data, PATHS.pets, PATHS.sessions]) fs.mkdirSync(dir, { recursive: true });
  migratePets(path.join(DATA, 'pets'));
  const flatClawrk = path.join(PATHS.pets, 'clawrk.pet.js');
  const bundledFlat = path.join(__dirname, '..', 'pets', 'clawrk.pet.js');
  const bundledClawrk = fs.existsSync(bundledFlat) ? bundledFlat : path.join(__dirname, '..', 'pets', 'clawrk', 'clawrk.pet.js');
  const localClawrk = path.join(PATHS.pets, 'clawrk', 'clawrk.pet.js');
  if (!fs.existsSync(flatClawrk) && fs.existsSync(bundledClawrk)) fs.copyFileSync(bundledClawrk, flatClawrk);
  if (fs.existsSync(localClawrk) && fs.existsSync(flatClawrk) && fs.readFileSync(localClawrk).equals(fs.readFileSync(flatClawrk))) {
    fs.unlinkSync(localClawrk);
    if (!fs.readdirSync(path.dirname(localClawrk)).length) fs.rmdirSync(path.dirname(localClawrk));
  }
}

function migratePets(dir) {
  if (path.resolve(dir) === path.resolve(PATHS.pets) || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, entry.name);
    if (entry.isDirectory()) { migratePets(src); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.pet.js')) continue;
    let dest = path.join(PATHS.pets, entry.name);
    for (let n = 2; fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(src)); n++) {
      dest = path.join(PATHS.pets, entry.name.replace(/\.pet\.js$/, `-${n}.pet.js`));
    }
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    migratedRefs.set(src, dest);
    fs.unlinkSync(src);
  }
}

function canonicalRef(ref) {
  if (migratedRefs.has(ref)) return migratedRefs.get(ref);
  if (typeof ref === 'string') {
    if (ref === 'builtin:clawd') return 'builtin:clawrk';
    if (ref === 'builtin:cage') return 'builtin:cage';
    if (!ref.startsWith('builtin:')) {
      const legacy = path.relative(path.join(DATA, 'pets'), ref);
      const dest = path.join(PATHS.pets, path.basename(ref));
      if (!legacy.startsWith('..') && !path.isAbsolute(legacy) && fs.existsSync(dest)) return dest;
      if (path.resolve(ref) === path.join(PATHS.pets, 'clawrk.pet.js') ||
          path.resolve(ref) === path.join(PATHS.pets, 'clawd.pet.js') ||
          path.resolve(ref) === path.join(DATA, 'pets', 'clawd.pet.js') ||
          path.resolve(ref) === path.join(DATA, 'pets', 'clawrk.pet.js')) return 'builtin:clawrk';
    }
  }
  return ref;
}

const PET_SETTINGS = ['harness', 'buttons', 'size', 'barMode', 'behavior', 'animOff', 'params', 'bubble', 'clickThrough', 'onTop', 'sound'];
function rememberPet(prefs, inst) {
  if (!inst || inst.experimentalDuplicate) return;
  prefs.petSettings ||= {};
  prefs.petSettings[inst.pet] = JSON.parse(JSON.stringify(Object.fromEntries(PET_SETTINGS.map((key) => [key, inst[key]]))));
}

function restorePet(prefs, ref, harness) {
  const inst = newInstance(ref, harness);
  const saved = prefs.petSettings?.[ref];
  if (saved) Object.assign(inst, JSON.parse(JSON.stringify(saved)));
  if (harness !== undefined) inst.harness = harness;
  return inst;
}

function readJson(file, fallback, validate = () => true) {
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Settings file exceeds 4 MB; rename it to a retained backup before resetting');
    const bytes = fs.readFileSync(file);
    originals.set(file, bytes);
    if (bytes.length > 4 * 1024 * 1024) throw new Error('Settings file exceeds 4 MB');
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!validate(value)) throw new Error('Invalid settings structure');
    return value;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      if (!originals.has(file)) unreadable.add(file);
      issues.set(file, { file, message: 'Settings could not be loaded. Recovery defaults are in use; the original is preserved.', code: err.code || 'INVALID_SETTINGS' });
    }
    return fallback;
  }
}

function writeJson(file, value) {
  let tmp;
  try {
    if (unreadable.has(file)) throw new Error('Original settings are unreadable; restore permissions before saving');
    // A corrupt or structurally invalid file is backed up byte-for-byte before
    // defaults can replace it. If backup fails, refuse the replacement.
    if (issues.has(file) && !issues.get(file).backup && fs.existsSync(file)) {
      const backup = file + '.recovery-' + randomUUID();
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      issues.get(file).backup = backup;
    }
    if (originals.has(file) && fs.existsSync(file) && !fs.readFileSync(file).equals(originals.get(file))) throw new Error('Settings changed on disk; restart before saving');
    const text = JSON.stringify(value, null, 2) + '\n';
    tmp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
    originals.set(file, Buffer.from(text));
  } catch (err) {
    issues.set(file, { ...issues.get(file), file, message: 'Could not save settings. The previous file was preserved. Check permissions/free space and restart.', code: err.code || 'SAVE_FAILED' });
    throw err;
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch {}
  }
}

// ---------- per-pet behaviour (each pet on screen has its own) ----------

const DEFAULT_BEHAVIOR = {
  wander: true, // walk around on its own
  anchored: false, // stay on a short leash around its button bar
  containment: 'screen', // screen | all | taskbar
  fallWhenDropped: false,
  avoidCursor: false,
  avoidText: true, // steps off text you are typing over; always obeys "GO AWAY"
  followCursor: false,
  cursorFollowMode: 'sideways', // sideways | all (per-pet cursor pursuit)
  trackCursor: true, // eyes follow the mouse
  nap: true,
  napMinutes: 4,
  tricks: 'normal', // off | rare | normal | often
  social: true, // bump, shoo and greet other pets
  passThroughPets: false, // neither blocks nor bumps into other pets
  speed: 1,
  calm: false, // no tricks or movement at all
  showWithAgent: false, // rests off screen; appears while its agent is in front, busy or needs you
  lingerMinutes: 2, // ... and leaves after this many quiet minutes
  smokeOnLeave: true, // arrives and leaves in a puff of smoke
};

let nextUid = 1;
function newInstance(petRef, harness = null) {
  return {
    uid: 'p' + Date.now().toString(36) + (nextUid++),
    pet: petRef, // "builtin:clawrk" or an absolute path to a .pet.js file
    harness, // which agent's sessions this pet follows ("any" = all of them, null = none yet)
    buttons: [0, 1], // which of the link's buttons sit under the pet (null = that slot is off)
    visible: true,
    size: 1,
    barMode: 'expanded',
    pos: null,
    display: null,
    behavior: { ...DEFAULT_BEHAVIOR },
    animOff: {}, // animation key → true when switched off
    params: {}, // animation key → { param: value }
    bubble: null, // where the speech bubble sits relative to the pet ({ dx, dy }), null = automatic
    asleep: false, // "put to sleep": stays asleep until clicked or dragged
    sitting: false, // "put to sit": strapped to gurney until clicked or dragged
    disabledUntil: 0, // ms timestamp; -1 = until switched back on
    clickThrough: false, // mouse passes straight through the pet
    onTop: true,
    sound: { muted: false, volume: 0.35, anims: {} }, // anims: key → { sound, on, volume }
  };
}

const DEFAULT_HOTKEYS = {
  togglePets: 'Ctrl+Alt+P',
  jump: 'Ctrl+Alt+J',
  button1: 'Ctrl+Alt+N',
  button2: 'Ctrl+Alt+K',
  studio: 'Ctrl+Alt+H',
  mute: 'Ctrl+Alt+M',
  sleepAll: '',
};

function loadPrefs() {
  const saved = readJson(PATHS.prefs, null, validPrefs);
  const p = saved || {};
  if (!Array.isArray(p.instances)) p.instances = [newInstance('builtin:clawrk', 'claude-code')];
  p.petSettings = Object.fromEntries(Object.entries(p.petSettings || {}).map(([ref, value]) => [canonicalRef(ref), value]));
  for (const inst of p.instances) {
    inst.pet = canonicalRef(inst.pet);
    inst.behavior = { ...DEFAULT_BEHAVIOR, ...(inst.behavior || {}) };
    inst.animOff = inst.animOff || {};
    inst.params = inst.params || {};
    if (!Array.isArray(inst.buttons)) inst.buttons = [0, 1];
    if (inst.harness === undefined) inst.harness = null;
    if (typeof inst.size !== 'number') inst.size = 1;
    if (inst.bubble === undefined) inst.bubble = null;
    if (typeof inst.disabledUntil !== 'number') inst.disabledUntil = 0;
    if (inst.onTop === undefined) inst.onTop = true;
    inst.caged = !!inst.caged;
    inst.sitting = !!inst.sitting;
    if (inst.pet === 'builtin:cage' || inst.uid === 'cage') inst.isCage = true;
    inst.sound = { muted: false, volume: 0.35, anims: {}, ...(inst.sound || {}) };
    rememberPet(p, inst);
  }
  if (p.cageEnabled) {
    let cage = p.instances.find(i => i.isCage || i.uid === 'cage' || i.pet === 'builtin:cage');
    if (!cage) {
      cage = newInstance('builtin:cage', null);
      cage.uid = 'cage';
      cage.isCage = true;
      cage.barMode = 'off';
      cage.sound = { muted: true, volume: 0, anims: {} };
      cage.behavior = { ...DEFAULT_BEHAVIOR, wander: false, calm: true, social: false, avoidCursor: false, followCursor: false, trackCursor: false, nap: false, tricks: 'off', avoidText: false, fallWhenDropped: false, passThroughPets: true };
      p.instances.unshift(cage);
    } else {
      cage.isCage = true;
      cage.pet = 'builtin:cage';
      cage.barMode = 'off';
      const idx = p.instances.indexOf(cage);
      if (idx > 0) {
        p.instances.splice(idx, 1);
        p.instances.unshift(cage);
      }
    }
  }
  p.hotkeys = { ...DEFAULT_HOTKEYS, ...(p.hotkeys || {}) };
  require('./instance-options').numberDuplicates(p.instances);
  p.hotkeysDisabled = p.hotkeysDisabled || {};
  if (p.hotkeysEnabled === undefined) p.hotkeysEnabled = true;
  // Legacy profiles without a recorded choice must also consent.
  p.watchKeyboard = p.keyboardConsentVersion === 1 && p.keyboardAsked === true && p.watchKeyboard === true;
  p.keyboardAsked = p.keyboardConsentVersion === 1 && p.keyboardAsked === true;
  return p;
}

function savePrefs(prefs) {
  if (!validPrefs(prefs)) throw new Error('Invalid preferences');
  writeJson(PATHS.prefs, prefs);
}

function validPrefs(p) {
  const policy = require('./ipc-policy');
  if (!isRecord(p) || !policy.safeData(p)) return false;
  if (p.instances !== undefined && (!Array.isArray(p.instances) || p.instances.length > 100 || !p.instances.every(i => isRecord(i) && typeof i.uid === 'string' && typeof i.pet === 'string' && (i.pos == null || isRecord(i.pos) && Number.isFinite(i.pos.x) && Number.isFinite(i.pos.y)) && policy.patch(Object.fromEntries(Object.entries(i).filter(([k]) => PET_SETTINGS.includes(k) || ['visible', 'asleep', 'sitting', 'disabledUntil', 'caged', 'isCage'].includes(k))))))) return false;
  if (p.petSettings !== undefined && (!isRecord(p.petSettings) || !Object.values(p.petSettings).every(policy.patch))) return false;
  for (const key of ['hotkeys', 'hotkeysDisabled']) if (p[key] !== undefined && !isRecord(p[key])) return false;
  if (p.hotkeys && !Object.values(p.hotkeys).every(v => typeof v === 'string' && v.length <= 100)) return false;
  return ['watchKeyboard', 'keyboardAsked', 'hotkeysEnabled', 'cageEnabled', 'muteAll', 'noDance', 'verboseLogging'].every(k => p[k] === undefined || typeof p[k] === 'boolean');
}

// ---------- links: how each agent app is opened ----------

const DEFAULT_LINKS = {
  primary: 'claude-code',
  links: {
    'claude-code': {
      name: 'Claude Code',
      app: 'Claude Desktop',
      buttons: [
        { label: 'New chat', icon: 'compose', open: { url: 'claude://claude.ai/new?surface=chat' } },
        { label: 'New Claude Code session', icon: 'code', open: { url: 'claude://code/new' } },
        {
          label: 'Voice (experimental)',
          icon: 'voice',
          open: { url: 'claude://claude.ai/new?surface=chat' },
          then: { delayMs: 1500, uiaClick: ['voice mode', 'dictation', 'dictate', 'microphone', 'press and hold to record', 'voice'] },
        },
      ],
      jump: {
        url: 'claude://code/continue?session={hostSessionId}',
        needsYouUrl: 'claude://code/needs-input?session={hostSessionId}',
      },
      window: { process: 'claude', pathContains: 'WindowsApps' },
    },
  },
};

function loadLinks() {
  const l = readJson(PATHS.links, null, v => { try { linkPolicy.validateLinks(v); return true; } catch { return false; } });
  if (!l || !l.links) {
    return JSON.parse(JSON.stringify(DEFAULT_LINKS));
  }
  // keep the built-in Claude Code link available even if the file predates it
  if (!l.links['claude-code']) l.links['claude-code'] = DEFAULT_LINKS.links['claude-code'];
  return l;
}

function saveLinks(links) {
  linkPolicy.validateLinks(links);
  writeJson(PATHS.links, links);
}

module.exports = { PATHS, petsDir, DEFAULT_BEHAVIOR, DEFAULT_HOTKEYS, ensureDirs, readJson, writeJson, newInstance, loadPrefs, savePrefs, loadLinks, saveLinks, rememberPet, restorePet, canonicalRef, validPrefs, recoveryIssues: () => [...issues.values()] };
