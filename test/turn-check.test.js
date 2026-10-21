// A Codex session stuck "thinking" after a lost Stop hook is resolved from the
// rollout transcript Codex writes for every turn.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const turnCheck = require('../lib/turn-check');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pet-turns-'));
const T0 = Date.parse('2026-10-18T19:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ev = (ms, type) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload: { type } });

function rollout(id, lines) {
  const d = new Date(T0);
  const dir = path.join(HOME, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-10-18T15-00-00-${id}.jsonl`), lines.join('\n') + '\n');
}
const session = (id, extra) => ({ harness: 'codex', sessionId: id, state: 'thinking', since: T0, ts: T0 + 50e3, ...extra });

test('a finished turn whose Stop hook was lost reads as done', () => {
  rollout('s-lost', [ev(T0, 'task_started'), '{"timestamp":"x","type":"response_item"}', ev(T0 + 60e3, 'task_complete')]);
  assert.strictEqual(turnCheck.finishedAt(session('s-lost'), T0 + 120e3, HOME), T0 + 60e3);
});

test('a late write just after the turn ended still reads as done', () => {
  rollout('s-late', [ev(T0, 'task_started'), ev(T0 + 60e3, 'task_complete')]);
  assert.strictEqual(turnCheck.finishedAt(session('s-late', { ts: T0 + 62e3 }), T0 + 120e3, HOME), T0 + 60e3);
});

test('a running turn, a fresh record or a newer turn is left alone', () => {
  rollout('s-run', [ev(T0, 'task_started'), ev(T0 + 60e3, 'task_complete'), ev(T0 + 90e3, 'task_started')]);
  assert.strictEqual(turnCheck.finishedAt(session('s-run', { ts: T0 + 95e3 }), T0 + 120e3, HOME), null);
  rollout('s-fresh', [ev(T0, 'task_started'), ev(T0 + 60e3, 'task_complete')]);
  assert.strictEqual(turnCheck.finishedAt(session('s-fresh', { ts: T0 + 61e3 }), T0 + 62e3, HOME), null);
  // a new prompt whose task_started has not reached the transcript yet
  assert.strictEqual(turnCheck.finishedAt(session('s-fresh', { ts: T0 + 100e3 }), T0 + 120e3, HOME), null);
  assert.strictEqual(turnCheck.finishedAt(session('missing'), T0 + 120e3, HOME), null);
  assert.strictEqual(turnCheck.finishedAt({ ...session('s-lost'), harness: 'claude-code' }, T0 + 120e3, HOME), null);
  assert.strictEqual(turnCheck.finishedAt({ ...session('s-lost'), state: 'done' }, T0 + 120e3, HOME), null);
});

test('an aborted turn counts as ended', () => {
  rollout('s-abort', [ev(T0, 'task_started'), ev(T0 + 30e3, 'turn_aborted')]);
  assert.strictEqual(turnCheck.finishedAt(session('s-abort', { ts: T0 + 20e3 }), T0 + 120e3, HOME), T0 + 30e3);
});
