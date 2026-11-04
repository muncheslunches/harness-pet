// The Rust helpers, for real, through the same pipes the app uses. Nothing here moves focus,
// the mouse or any window. Skipped where they haven't been built (npm run build:native).

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const bin = path.join(__dirname, '..', 'native', 'bin');
const helperExe = path.join(bin, 'harness-pet-helper.exe');
const keywatchExe = path.join(bin, 'harness-pet-keywatch.exe');
const skip = fs.existsSync(helperExe) && fs.existsSync(keywatchExe) ? false : 'native helpers not built';

const opened = new Set();
// A failed check must not leave a keyboard hook running, or keep this test file alive.
afterEach(() => {
  for (const child of opened) child.kill();
  opened.clear();
});

function open(exe, args = []) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  opened.add(child);
  const waiting = [];
  const early = [];
  const events = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('ev ')) return events.push(line);
    const next = waiting.shift();
    if (next) next(line);
    else early.push(line);
  });
  const nextLine = () => new Promise((resolve, reject) => {
    if (early.length) return resolve(early.shift());
    const timer = setTimeout(() => reject(new Error('no answer in time')), 5000);
    waiting.push((line) => { clearTimeout(timer); resolve(line); });
  });
  const ask = (cmd) => { child.stdin.write(cmd + '\n'); return nextLine(); };
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, ask, nextLine, exited, events };
}

test('the helper announces itself and answers each command with one line', { skip }, async () => {
  const h = open(helperExe);
  assert.equal(await h.nextLine(), 'ready events');
  assert.equal(h.child.exitCode, null);
  assert.equal(await h.ask('ping'), 'ok pong');
  assert.equal(await h.ask('   '.concat('ping  ')), 'ok pong');
  assert.equal(await h.ask('nonsense'), 'err unknown-command nonsense');
  assert.match(await h.ask('foreground'), /^ok -?\d+$/);
  assert.match(await h.ask('fullscreen'), /^ok (true|false)$/);
  assert.match(await h.ask('context'), /^ok (none|-?\d+( -?\d+){8})$/);
  const app = await h.ask('foreground-app');
  assert.match(app, /^ok \{/);
  JSON.parse(app.slice(3));
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
});

test('bad requests get an error answer rather than ending the helper', { skip }, async () => {
  const h = open(helperExe);
  await h.nextLine();
  assert.equal(await h.ask('focus'), 'err no-matcher');
  assert.match(await h.ask('focus {broken'), /^err /);
  assert.equal(await h.ask('focus {}'), 'err no-window');
  assert.equal(await h.ask('window-shown'), 'err no-matcher');
  assert.equal(await h.ask('window-shown {}'), 'err no-matcher');
  assert.equal(await h.ask('uia-click'), 'err no-names');
  assert.equal(await h.ask('uia-click {"window":{"process":"no-such-app"},"names":["ab"]}'), 'err no-names');
  assert.equal(await h.ask('uia-click {"window":{"process":"no-such-app"},"names":["button"]}'), 'err no-window');
  assert.match(await h.ask('wheel a b'), /^err /);
  assert.match(await h.ask('restack 12; rm'), /^err /);
  assert.match(await h.ask('keys hyper+a'), /^err unknown modifier/);
  assert.match(await h.ask('keys ctrl+nope'), /^err unknown key/);
  assert.equal(await h.ask('ping'), 'ok pong');
  h.child.kill();
});

test('window questions tell a missing app from a real one, and do nothing to stale handles', { skip }, async () => {
  const h = open(helperExe);
  await h.nextLine();
  assert.equal(await h.ask('window-shown {"process":"no-such-app-at-all"}'), 'ok false');
  assert.equal(await h.ask('focus {"process":"no-such-app-at-all"}'), 'err no-window');
  assert.equal(await h.ask('restack'), 'ok 0');
  assert.equal(await h.ask('restack 1 2 3'), 'ok 0');
  assert.equal(await h.ask('refocus 1 0'), 'ok refocus gone');
  assert.equal(await h.ask('wheel 0 0'), 'ok wheel');
  h.child.kill();
});

// CI machines may have no interactive desktop for a keyboard hook to watch.
test('the keyboard watcher reports a key press only when told to count sent keys, and never which key', { skip: skip || (process.env.CI ? 'needs an interactive desktop' : false) }, async (t) => {
  const h = open(helperExe);
  await h.nextLine();
  const strict = open(keywatchExe);
  assert.equal(await strict.nextLine(), 'ready');
  const lax = open(keywatchExe, ['--allow-injected']);
  assert.equal(await lax.nextLine(), 'ready');
  const lines = (w) => { const got = []; w.child.stdout.on('data', (d) => got.push(String(d))); return got; };
  const strictLines = lines(strict);
  const laxLines = lines(lax);
  // F24: a key no keyboard has, so pressing it disturbs nothing. Sent by a program, so not "typed".
  // Someone really typing shows up too, so a quiet moment for the strict watcher is what counts.
  let quiet = false;
  let reached = false;
  for (let tries = 0; tries < 6 && !quiet; tries++) {
    await new Promise((r) => setTimeout(r, 300)); // past the watcher's 250 ms pulse limit
    strictLines.length = laxLines.length = 0;
    assert.equal(await h.ask('keys f24'), 'ok keys');
    await new Promise((r) => setTimeout(r, 300));
    reached ||= laxLines.join('').includes('t');
    quiet = strictLines.length === 0 && laxLines.join('').includes('t');
  }
  // Windows drops sent keys while some apps are in front, or sends them to another PC with Mouse Without Borders.
  if (reached) assert.ok(quiet, 'the key a program sent counts only for the watcher told to count those');
  else t.skip('sent keys are not reaching this PC right now');
  for (const w of [strict, lax]) {
    w.child.stdin.end();
    assert.equal(await w.exited, 0, 'closing stdin stops it');
  }
  h.child.kill();
});
