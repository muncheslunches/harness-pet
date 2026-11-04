const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function rig() {
  const children = [];
  // each rig gets its own memory of which helper it has given up on
  const nativeFile = path.join(__dirname, '../lib/native.js');
  delete require.cache[nativeFile];
  const native = require(nativeFile);
  const context = vm.createContext({ module: { exports: {} }, process: { platform: 'win32' },
    console: { warn() {} }, __dirname: path.join(__dirname, '../lib'),
    require: (name) => name === 'child_process' ? { spawn(file) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.write = () => {};
      child.kill = () => { child.killed = true; };
      child.file = file;
      children.push(child);
      return child;
    } } : name === './native' ? native : require(name),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/helper.js'), 'utf8'), context);
  return { helper: context.module.exports, children };
}

test('a broken native-helper pipe fails pending actions without crashing and restarts on demand', async () => {
  const { helper, children } = rig();
  const first = helper.focus({ process: 'example' });
  children[0].stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  assert.equal(await first, 'err helper-pipe-closed');
  assert.equal(helper.proc, null);
  const second = helper.focus({ process: 'example' });
  children[0].emit('exit', 1);
  children[0].stdout.emit('data', 'ok stale\n');
  assert.equal(helper.proc, children[1], 'old exit must not disconnect the new helper');
  children[1].stdout.emit('data', 'ready\nok focus true\n');
  assert.equal(await second, 'ok focus true');
  helper.stop();
});

test('failed helper spawn and shutdown both settle queued actions', async () => {
  const { helper, children } = rig();
  const first = helper.send('ping');
  children[0].emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
  assert.equal(await first, 'err helper-ENOENT');
  const second = helper.send('ping');
  helper.stop();
  assert.equal(await second, 'err helper-stopped');
});

test('a helper reports its events apart from its answers', async () => {
  const { helper, children } = rig();
  const lines = (child, text) => child.stdout.emit('data', text);
  helper.start();
  const first = children[0];
  lines(first, 'ready events\n');
  assert.equal(helper.events, true);
  const events = [];
  helper.onEvent = (e) => events.push(e);
  const answer = helper.send('ping');
  lines(first, 'ev foreground\nev windows\nok pong\n');
  assert.equal(await answer, 'ok pong', 'an event is not an answer');
  assert.deepEqual(events, ['foreground', 'windows']);
  first.emit('exit', 1);
  assert.equal(helper.events, false);
  assert.equal(helper.proc, null);
  helper.stop();
});

test('a Rust helper that started and later stopped is started again; one that never started is replaced by PowerShell', { skip: !fs.existsSync(path.join(__dirname, '../native/bin/harness-pet-helper.exe')) && 'not built' }, () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { helper, children } = rig();
    helper.start();
    assert.match(children[0].file, /harness-pet-helper\.exe$/);
    children[0].stdout.emit('data', 'ready events\n');
    children[0].emit('exit', 1);
    helper.start();
    assert.match(children[1].file, /harness-pet-helper\.exe$/, 'a crash after starting is not a reason to give it up');
    children[1].emit('error', Object.assign(new Error('blocked'), { code: 'EPERM' }));
    helper.start();
    assert.equal(children[2].file, 'powershell.exe', 'blocked or missing: PowerShell takes over');
    assert.ok(children[2].file);
    helper.stop();
  } finally {
    console.warn = warn;
  }
});

test('restack sends only window handles and reads back how many windows moved', async () => {
  const { helper, children } = rig();
  assert.equal(await helper.restack([]), 0, 'nothing to check spawns no helper');
  assert.equal(children.length, 0);
  const sent = [];
  helper.start();
  children[0].stdin.write = (line) => sent.push(line);
  const moved = helper.restack(['123', null, '45; rm', 678]);
  children[0].stdout.emit('data', 'ready\nok 2\n');
  assert.equal(await moved, 2);
  assert.deepEqual(sent, ['restack 123 678\n']);
  const failed = helper.restack(['123']);
  children[0].stdout.emit('data', 'err boom\n');
  assert.equal(await failed, 0);
  helper.stop();
});
