// The pet library: built-in pets shipped with the app plus pets in
// the project's pets folder. Files are read here but never run here — pet code only
// ever runs inside a sandboxed worker in a renderer.

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./store');
const security = require('./security');

const MAX_SIZE = 1024 * 1024;

function findPetFiles(dir, depth = 2) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...findPetFiles(full, depth - 1));
    else if (e.isFile() && e.name.endsWith('.pet.js')) out.push(full);
  }
  return out;
}

function refOf(file) {
  if (path.resolve(file) === path.join(PATHS.pets, 'clawrk.pet.js') || path.resolve(file) === path.join(PATHS.pets, 'clawd.pet.js')) return 'builtin:clawrk';
  if (path.resolve(file) === path.join(PATHS.pets, 'cage.pet.js')) return 'builtin:cage';
  return file;
}

function fileOf(ref) {
  let file = ref;
  if (typeof ref === 'string' && ref.startsWith('builtin:')) {
    if (ref === 'builtin:cage') return path.join(PATHS.builtinPets, 'cage.pet.js');
    if (ref !== 'builtin:clawrk' && ref !== 'builtin:clawd') throw new Error('Unknown built-in pet');
    file = path.join(PATHS.builtinPets, 'clawrk.pet.js');
  }
  if (typeof file !== 'string' || !file.endsWith('.pet.js') || !security.isAllowedFile(file, [PATHS.pets, PATHS.builtinPets])) throw new Error('Pet file is missing or outside the library');
  if (!fs.statSync(file).isFile()) throw new Error('Pet must be a regular file');
  return file;
}

function list() {
  const files = [...new Set([...findPetFiles(PATHS.builtinPets), ...findPetFiles(PATHS.pets)])].filter(file => security.isAllowedFile(file, [PATHS.pets, PATHS.builtinPets]));
  return files.map((file) => {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {}
    return { ref: refOf(file), file, builtIn: refOf(file).startsWith('builtin:'), mtime: stat ? stat.mtimeMs : 0, size: stat ? stat.size : 0 };
  }).filter((p) => p.ref !== 'builtin:cage');
}

function read(ref) {
  const file = fileOf(ref);
  const stat = fs.statSync(file);
  if (stat.size > MAX_SIZE) throw new Error('Pet files must be under 1 MB');
  return { ref, file, code: fs.readFileSync(file, 'utf8'), mtime: stat.mtimeMs };
}

// Copy a pet file into the user's pet folder; returns its new ref.
function importFile(src) {
  const stat = fs.statSync(src);
  if (stat.size > MAX_SIZE) throw new Error('Pet files must be under 1 MB');
  let name = path.basename(src);
  if (!name.endsWith('.pet.js')) name = name.replace(/\.js$/, '') + '.pet.js';
  let dest = path.join(PATHS.pets, name);
  for (let i = 2; fs.existsSync(dest) && path.resolve(dest) !== path.resolve(src); i++) {
    dest = path.join(PATHS.pets, name.replace(/\.pet\.js$/, `-${i}.pet.js`));
  }
  if (path.resolve(dest) !== path.resolve(src)) fs.copyFileSync(src, dest);
  return dest;
}

function remove(ref) {
  if (typeof ref !== 'string' || ref.startsWith('builtin:') || refOf(ref) === 'builtin:clawrk' || refOf(ref) === 'builtin:cage') throw new Error('Built-in pets cannot be deleted');
  fs.rmSync(fileOf(ref), { force: true });
}

// Calls onChange(ref) when a pet file is added, edited or removed (polling keeps it
// reliable across editors and agents that write via temp files).
function watch(onChange) {
  let known = new Map(list().map((p) => [p.ref, p.mtime]));
  return setInterval(() => {
    const now = new Map(list().map((p) => [p.ref, p.mtime]));
    for (const [ref, mtime] of now) if (known.get(ref) !== mtime) onChange(ref, known.has(ref) ? 'changed' : 'added');
    for (const ref of known.keys()) if (!now.has(ref)) onChange(ref, 'removed');
    known = now;
  }, 1500);
}

module.exports = { list, read, importFile, remove, watch, fileOf, refOf };
