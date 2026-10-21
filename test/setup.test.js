// Claude Code hook merge and the generated prompts. Runs in a child process
// with a temporary home folder, so the real ~/.claude/settings.json is untouched.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function inTempHome(script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pet-home-'));
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return { home, out: r.stdout };
}

test('Claude Code hooks merge without touching other settings', () => {
  const { home } = inTempHome(`
    const fs = require('fs'), path = require('path'), os = require('os');
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
      { matcher: '*', hooks: [{ type: 'command', command: '"node" "C:/old/claude-pet/hook/pet-hook.js"' }] },
    ] } }));
    const h = require('./lib/claude-hooks.js');
    h.install(process.execPath);
    h.install(process.execPath); // twice: still one copy
    fs.writeFileSync(path.join(os.homedir(), 'after-install.json'), fs.readFileSync(file));
    h.uninstall();
  `);
  const after = JSON.parse(fs.readFileSync(path.join(home, 'after-install.json'), 'utf8'));
  const text = JSON.stringify(after.hooks);
  assert.strictEqual(after.model, 'opus');
  assert.ok(text.includes('rtk hook claude'), 'RTK hook kept');
  assert.ok(!text.includes('claude-pet/hook/pet-hook.js'), 'old claude-pet hook replaced');
  assert.strictEqual(text.split('powershell.exe').length - 1, 7, 'one bridge hook per event');
  const final = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(final.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] });
});

test('hook install and uninstall preserve third-party hooks and exact backups', () => {
  inTempHome(`
    const assert = require('node:assert/strict');
    const fs = require('fs'), path = require('path');
    const h = require('./lib/claude-hooks');
    const original = {
      model: 'opus', permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [
          { type: 'command', command: 'rtk hook claude', timeout: 12 },
          { type: 'command', command: 'echo audit', async: true }
        ] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
        CustomEvent: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo custom' }] }]
      }
    };
    const raw = JSON.stringify(original, null, 4) + '\\n';
    fs.mkdirSync(path.dirname(h.SETTINGS), { recursive: true });
    fs.writeFileSync(h.SETTINGS, raw);
    const installed = h.install(process.execPath);
    assert.ok(installed.backup);
    assert.equal(fs.readFileSync(installed.backup, 'utf8'), raw);
    const installedRaw = fs.readFileSync(h.SETTINGS, 'utf8');
    const data = JSON.parse(installedRaw);
    for (const [event, groups] of Object.entries(original.hooks)) {
      assert.deepEqual(data.hooks[event].slice(0, groups.length), groups);
    }
    const removed = h.uninstall();
    assert.ok(removed.backup);
    assert.equal(fs.readFileSync(removed.backup, 'utf8'), installedRaw);
    assert.equal(fs.readFileSync(installed.backup, 'utf8'), raw, 'install backup survives uninstall');
    assert.deepEqual(JSON.parse(fs.readFileSync(h.SETTINGS, 'utf8')), original);
  `);
});

test('malformed Claude settings report a friendly error and remain untouched', () => {
  inTempHome(`
    const assert = require('node:assert/strict');
    const fs = require('fs'), path = require('path');
    const h = require('./lib/claude-hooks');
    fs.mkdirSync(path.dirname(h.SETTINGS), { recursive: true });
    const raw = '{ "hooks": invalid JSON';
    fs.writeFileSync(h.SETTINGS, raw);
    const status = h.status();
    assert.equal(status.installed, false);
    assert.match(status.error, /settings.json is not valid JSON/);
    assert.ok(status.error.includes(h.SETTINGS));
    for (const action of ['install', 'uninstall', 'uninstallThisCopy']) {
      assert.throws(() => h[action](process.execPath), SyntaxError);
      assert.equal(fs.readFileSync(h.SETTINGS, 'utf8'), raw);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(h.SETTINGS)), ['settings.json']);
  `);
});

test('Studio displays settings errors and handles rejected Connect and Disconnect requests', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'studio', 'studio.js'), 'utf8');
  const messages = [];
  const actions = [];
  let refreshes = 0;
  const element = (tag, attrs = {}, ...kids) => ({ tag, attrs, kids: kids.flat(), append(...more) { this.kids.push(...more); } });
  const context = vm.createContext({
    S: { claudeHooks: async (action) => { actions.push(action); throw new Error('IPC: invalid JSON'); } },
    toast: (message) => messages.push(message), refresh: async () => { refreshes++; },
    state: { claude: { error: 'Claude settings.json is not valid JSON.', partial: true }, harnesses: [], links: { links: {} }, paths: {}, recommendedModel: 'test' },
    RENDER: {}, h: element, attachRow: () => null, harnessOf: () => null,
  });
  vm.runInContext(source.slice(source.indexOf('async function updateClaudeHooks('), source.indexOf('// ---------- About ----------')), context);
  const root = element('section');
  context.RENDER.agents(root);
  const nodes = [];
  function walk(node) { if (!node || typeof node !== 'object') return; nodes.push(node); node.kids.forEach(walk); }
  walk(root);
  assert.ok(nodes.some((node) => node.attrs.role === 'alert' && node.kids.includes(context.state.claude.error)));
  for (const label of ['Connect', 'Disconnect']) {
    const button = nodes.find((node) => node.tag === 'button' && node.kids.includes(label));
    assert.ok(button, label + ' rendered');
    await assert.doesNotReject(button.attrs.onclick());
  }
  assert.deepEqual(actions, ['install', 'uninstall']);
  assert.equal(messages.length, 2);
  for (const message of messages) assert.match(message, /Could not update Claude hooks.*settings.json.*valid JSON.*permissions/);
  assert.equal(refreshes, 0, 'failed updates must not report success');
});

test('prompts carry the format, catalog and paths an agent needs', () => {
  const { out } = inTempHome(`
    const p = require('./lib/prompts.js');
    const create = p.createPet({ name: 'Pip', concept: 'a blue bird', extras: 'fly around at high speed' }, 'C:/node/node.exe');
    const link = p.linkHarness('antigravity', 'C:/node/node.exe');
    const any = p.linkAnyAgent('C:/node/node.exe');
    console.log(JSON.stringify({ create, link, any }));
  `);
  const { create, link, any } = JSON.parse(out);
  assert.match(create, /pip\.pet\.js/);
  assert.match(create, /definePet/);
  assert.match(create, /`needsYou`/);
  assert.match(create, /fly around at high speed/);
  assert.match(create, /validate-pet\.js/);
  assert.match(link, /--harness antigravity --event/);
  assert.match(link, /hooks\.json/);
  assert.match(link, /links\["antigravity"\]/);
  assert.match(any, /Claude Opus 5\.5/);
  assert.match(any, /<short-harness-id>/);
});

test('the uninstaller removes only the hooks of this copy', () => {
  const { home } = inTempHome(`
    const fs = require('fs'), path = require('path'), os = require('os');
    const h = require('./lib/claude-hooks.js');
    if (h.uninstallThisCopy().removed || fs.existsSync(h.SETTINGS)) throw new Error('wrote settings with no hooks to remove');
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    h.install(process.execPath);
    // another copy (say a source checkout) also registered its bridge
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.hooks.Stop.push({ hooks: [{ type: 'command', command: '"node" "D:/elsewhere/hook/harness-pet-hook.js" --harness claude-code' }] });
    fs.writeFileSync(file, JSON.stringify(data));
    h.uninstallThisCopy();
  `);
  const final = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(final.hooks, { Stop: [{ hooks: [{ type: 'command', command: '"node" "D:/elsewhere/hook/harness-pet-hook.js" --harness claude-code' }] }] });
});
