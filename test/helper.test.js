const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function rig() {
  const children = [];
  const context = vm.createContext({ module: { exports: {} }, process: { platform: 'win32' },
    console: { warn() {} }, __dirname: path.join(__dirname, '../lib'),
    require: (name) => name === 'child_process' ? { spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.write = () => {};
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    } } : require(name),
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
