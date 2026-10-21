const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Schema = require('../shared/pet-schema');
const Controls = require('../shared/pet-controls');

function define(file) {
  let def;
  new Function('definePet', fs.readFileSync(file, 'utf8'))((d) => { def = d; });
  return def;
}

test('every bundled pet has its own lines for dodging, commands and panic', () => {
  const dir = path.join(__dirname, '..', 'pets');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pet.js'));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const { manifest } = Schema.validate(define(path.join(dir, f)));
    for (const key of ['dodge', 'command', 'panic']) {
      assert.ok(manifest.lines[key] && manifest.lines[key].length >= 2, `${f} lines.${key}`);
      for (const line of manifest.lines[key]) assert.ok(line.length <= 28, `${f}: "${line}" is short enough for a bubble`);
    }
  }
});

test('lines are cleaned up and bad ones are ignored with a warning', () => {
  const base = { format: 1, id: 'tester', name: 'Tester', canvas: { width: 16, height: 16 }, animations: { idle: { draw() {} } } };
  const ok = Schema.validate({ ...base, lines: { dodge: ['  hi  ', '', 7, 'x'.repeat(100)], panic: 'nope', extra: ['ignored'] } });
  assert.deepEqual(ok.manifest.lines.dodge[0], 'hi');
  assert.equal(ok.manifest.lines.dodge.length, 2);
  assert.equal(ok.manifest.lines.dodge[1].length, 60);
  assert.equal(ok.manifest.lines.panic, undefined);
  assert.equal(ok.manifest.lines.extra, undefined);
  assert.ok(ok.warnings.some((w) => w.includes('lines.panic')));
  assert.deepEqual(Schema.validate(base).manifest.lines, {});
  assert.ok(Schema.validate({ ...base, lines: 'hello' }).warnings.some((w) => w.includes('lines')));
});

test('avoidLine speaks in the right situation, falling back to plain defaults', () => {
  const manifest = { lines: { dodge: ['D'], command: ['C'], panic: ['P'] } };
  assert.equal(Controls.avoidLine(manifest, 'typing', false), 'D');
  assert.equal(Controls.avoidLine(manifest, 'phrase', false), 'C');
  assert.equal(Controls.avoidLine(manifest, 'phrase', true), 'P');
  assert.equal(Controls.avoidLine(manifest, 'typing', true), 'P');
  for (const bare of [null, {}, { lines: {} }]) {
    assert.ok(Controls.DEFAULT_LINES.dodge.includes(Controls.avoidLine(bare, 'typing', false)));
    assert.ok(Controls.DEFAULT_LINES.command.includes(Controls.avoidLine(bare, 'phrase', false)));
    assert.ok(Controls.DEFAULT_LINES.panic.includes(Controls.avoidLine(bare, 'phrase', true)));
  }
  assert.equal(Controls.avoidLine({ lines: { dodge: ['a', 'b', 'c'] } }, 'typing', false, () => 0.99), 'c');
});
