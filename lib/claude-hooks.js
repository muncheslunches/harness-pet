// Claude Code hook setup. All mutations validate and back up the original file,
// and use an exclusive lock shared by Studio, the CLI and the uninstaller.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BRIDGE = path.resolve(__dirname, '..', 'hook', 'harness-pet-hook.js');
const EVENTS = [
  ['UserPromptSubmit', null], ['PreToolUse', '*'], ['PostToolUse', '*'],
  ['PermissionRequest', '*'], ['Notification', null], ['Stop', null], ['SessionEnd', null],
];
const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const psQuote = (v) => "'" + v.replace(/'/g, "''") + "'";
const normalize = (v) => v.replace(/\\/g, '/').toLowerCase();
const PREFIX = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ';

// Only ASCII reaches the outer shell. Literal paths inside the UTF-16 payload
// survive cmd, Git Bash and PowerShell, including Unicode and shell metacharacters.
// The guard lives in settings, so it still works after the app itself is deleted.
function command(nodePath, bridge = BRIDGE) {
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath) || /[\r\n\0]/.test(nodePath)) {
    throw new Error('Hook setup needs an absolute Node runtime path. Reinstall Harness Pet, then reconnect.');
  }
  const config = { node: nodePath, bridge };
  const script = [
    '# Harness Pet hook v2',
    '# ' + JSON.stringify(config),
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `if ([IO.File]::Exists(${psQuote(nodePath)}) -and [IO.File]::Exists(${psQuote(bridge)})) {`,
    `  & ${psQuote(nodePath)} ${psQuote(bridge)} '--harness' 'claude-code'`,
    '  exit $LASTEXITCODE',
    '}',
    'exit 0',
  ].join('\n');
  return PREFIX + Buffer.from(script, 'utf16le').toString('base64');
}

// Match complete commands we generated, never a substring in somebody else's
// script, arguments, echo, or prompt hook. Legacy support is deliberately narrow.
function ownedBridge(h) {
  if (!h || h.type !== 'command' || typeof h.command !== 'string' || h.args !== undefined) return null;
  const text = h.command;
  if (text.startsWith(PREFIX)) {
    try {
      const script = Buffer.from(text.slice(PREFIX.length), 'base64').toString('utf16le');
      const config = JSON.parse(script.split('\n')[1].slice(2));
      if (typeof config.bridge !== 'string' || !path.isAbsolute(config.bridge)) return null;
      return command(config.node, config.bridge) === text ? config.bridge : null;
    } catch { return null; }
  }
  const token = '(?:"([^"\\r\\n]+)"|([^\\s"&|<>;]+))';
  const legacy = new RegExp(`^(?:if exist ${token} )?${token} ${token}( --harness claude-code)?$`, 'i').exec(text);
  if (!legacy) return null;
  const guard = legacy[1] || legacy[2];
  const exe = legacy[3] || legacy[4];
  const bridge = legacy[5] || legacy[6];
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(exe)) return null;
  if (guard && normalize(guard) !== normalize(exe) && normalize(guard) !== normalize(bridge)) return null;
  if (/[\\/]hook[\\/]harness-pet-hook\.js$/i.test(bridge) && legacy[7]) return bridge;
  if (/[\\/]claude-pet[\\/]hook[\\/]pet-hook\.js$/i.test(bridge)) return bridge;
  return null;
}

function validate(data) {
  const bad = (where) => { throw new Error(`Claude settings.json has an invalid structure at ${where}. Fix ${SETTINGS}, then retry. Your settings have not been changed.`); };
  if (!plainObject(data)) bad('root (expected an object)');
  if (!Object.hasOwn(data, 'hooks')) return;
  if (!plainObject(data.hooks)) bad('hooks (expected an object)');
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) bad(`hooks.${event} (expected an array)`);
    for (const group of groups) {
      if (!plainObject(group) || !Array.isArray(group.hooks)) bad(`hooks.${event} group`);
      if (group.matcher !== undefined && typeof group.matcher !== 'string') bad(`hooks.${event} matcher`);
      for (const hook of group.hooks) {
        if (!plainObject(hook) || typeof hook.type !== 'string' ||
            (hook.type === 'command' && typeof hook.command !== 'string')) bad(`hooks.${event} handler`);
      }
    }
  }
}

function load() {
  let raw;
  try { raw = fs.readFileSync(SETTINGS); }
  catch (err) { if (err.code === 'ENOENT') return { raw: null, data: {} }; throw err; }
  let data;
  try { data = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (err) {
    throw new SyntaxError(`Claude settings.json is not valid JSON. Fix ${SETTINGS}, then retry. Your settings have not been changed.`, { cause: err });
  }
  validate(data);
  return { raw, data };
}

function unchanged(raw) {
  let current;
  try { current = fs.readFileSync(SETTINGS); }
  catch (err) { if (err.code !== 'ENOENT') throw err; current = null; }
  if (raw === null ? current !== null : current === null || !raw.equals(current)) {
    throw new Error('Claude settings changed during hook setup. Retry after the other editor finishes.');
  }
}

function strip(hooks, match) {
  let removed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = [];
    for (const group of groups) {
      const next = group.hooks.filter((h) => !match(h));
      if (next.length === group.hooks.length) kept.push(group);
      else {
        removed = true;
        if (next.length) kept.push({ ...group, hooks: next });
      }
    }
    // Preserve unrelated empty groups/event arrays.
    if (kept.length || groups.length === 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

function mutate(edit) {
  // Validate before creating any lock/backup for invalid settings.
  load();
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const lock = SETTINGS + '.pet-lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Another Harness Pet hook update is running. Retry shortly. If all copies are closed and this persists, remove the stale lock ${lock}.`);
    throw new Error(`Cannot update ${SETTINGS}. Check file and folder permissions, then retry. Your settings have not been changed.`, { cause: err });
  }
  let backup = null, tmp = null;
  try {
    const { raw, data } = load();
    const changed = edit(data);
    if (!changed) return { settings: SETTINGS, backup: null, removed: false };
    if (raw !== null) {
      fs.accessSync(SETTINGS, fs.constants.W_OK);
      backup = SETTINGS + '.pet-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
      fs.writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
    }
    tmp = SETTINGS + '.pet-tmp-' + randomUUID();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    unchanged(raw);
    fs.renameSync(tmp, SETTINGS);
    tmp = null;
    return { settings: SETTINGS, backup, removed: true };
  } catch (err) {
    throw new Error(`${err.message} Hook update was not saved. Check settings.json structure and file/folder permissions, then retry.${backup ? ` Original bytes are backed up at ${backup}.` : ''}`, { cause: err });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function install(nodePath) {
  const cmd = command(nodePath);
  // Setup failures are visible, unlike a stale hook after files are removed.
  fs.accessSync(nodePath, fs.constants.R_OK);
  fs.accessSync(BRIDGE, fs.constants.R_OK);
  return mutate((data) => {
    data.hooks = data.hooks || {};
    strip(data.hooks, (h) => !!ownedBridge(h));
    for (const [event, matcher] of EVENTS) {
      const group = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
      if (matcher) group.matcher = matcher;
      data.hooks[event] = [...(data.hooks[event] || []), group];
    }
    return true;
  });
}

function remove(match) {
  if (load().raw === null) return { settings: SETTINGS, backup: null, removed: false };
  return mutate((data) => {
    if (!data.hooks || !strip(data.hooks, match)) return false;
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
    return true;
  });
}
const uninstall = () => remove((h) => !!ownedBridge(h));
const uninstallThisCopy = () => remove((h) => {
  const bridge = ownedBridge(h);
  return bridge !== null && normalize(bridge) === normalize(BRIDGE);
});

function status() {
  try {
    const { data } = load();
    const hooks = data.hooks || {};
    const all = Object.values(hooks).flat().flatMap((g) => g.hooks);
    const events = EVENTS.filter(([event]) => (hooks[event] || []).some((g) =>
      g.hooks.some((h) => normalize(ownedBridge(h) || '') === normalize(BRIDGE)))).map(([event]) => event);
    return {
      installed: events.length === EVENTS.length,
      partial: events.length > 0 && events.length < EVENTS.length,
      legacy: all.some((h) => !!ownedBridge(h) && !h.command.startsWith(PREFIX)),
      needsReconnect: all.some((h) => !!ownedBridge(h) &&
        (!h.command.startsWith(PREFIX) || normalize(ownedBridge(h)) !== normalize(BRIDGE))),
      events,
    };
  } catch (err) {
    return { installed: false, partial: false, legacy: false, events: [],
      error: `${err.message} Check ${SETTINGS} and file permissions, then retry. Your settings have not been changed.` };
  }
}

module.exports = { install, uninstall, uninstallThisCopy, status, SETTINGS, BRIDGE, command, ownedBridge };
if (require.main === module) {
  try {
    const action = { install: () => install(process.execPath), uninstall, 'uninstall-this-copy': uninstallThisCopy, status }[process.argv[2]];
    if (!action) throw new Error('Usage: node lib/claude-hooks.js install|uninstall|uninstall-this-copy|status');
    console.log(action());
  } catch (err) {
    console.error(err.message);
    // NSIS records cleanup failure and continues; never damage malformed settings.
    process.exitCode = 1;
  }
}
