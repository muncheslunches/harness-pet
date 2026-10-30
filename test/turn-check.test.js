// A session stuck "thinking" or "needs you" after a lost hook is resolved from the
// transcript its agent writes, using only records of how a turn ended.

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

test('antigravity transcript detects usage limit error and resolves needs-you to idle', () => {
  const sid = 'ag-quota';
  const logs = path.join(HOME, '.gemini', 'antigravity', 'brain', sid, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: iso(T0) }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(T0 + 10e3), tool_calls: [{ name: 'ask_question' }] }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', created_at: iso(T0 + 20e3), content: 'Error: Resource has been exhausted (e.g. check quota, rate limit)' }),
    ].join('\n') + '\n'
  );
  const s = { harness: 'antigravity', sessionId: sid, state: 'needs-you', ts: T0 + 15e3 };
  const res = turnCheck.checkTurn(s, T0 + 30e3, HOME);
  assert.ok(res);
  assert.strictEqual(res.finished, true);
  assert.strictEqual(res.state, 'idle');
  assert.strictEqual(res.detail, 'Usage limit reached');
  assert.strictEqual(turnCheck.finishedAt(s, T0 + 30e3, HOME), T0 + 20e3);
});

// Claude Code transcripts, in the shape Claude Code writes them.
const claudeDir = path.join(HOME, '.claude', 'projects', 'test-proj');
function claude(id, lines) {
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const prompt = (ms) => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: 'fix the billing page' } });
const reply = (ms, stop_reason, content = [{ type: 'text', text: 'Done.' }], extra = {}) => ({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content, stop_reason, usage: { input_tokens: 14290 } }, ...extra });
const tool = (ms, input) => reply(ms, 'tool_use', [{ type: 'tool_use', name: 'Edit', input }]);
const apiError = (ms, error, apiErrorStatus, text) => ({ type: 'assistant', timestamp: iso(ms), isApiErrorMessage: true, error, apiErrorStatus, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'stop_sequence' } });
const cs = (id, extra) => ({ harness: 'claude-code', sessionId: id, state: 'working', ts: T0 + 5e3, ...extra });

test('Claude Code: words like 429, quota or billing in ordinary work never end a turn', () => {
  claude('c-busy', [prompt(T0), tool(T0 + 10e3, { file_path: 'src/billing.ts', new_string: 'if (res.status === 429) retry(); // quota' })]);
  assert.strictEqual(turnCheck.checkTurn(cs('c-busy'), T0 + 30e3, HOME), null);
});

test('Claude Code: a finished reply reads as done, and a reply from before the last hook does not', () => {
  claude('c-end', [prompt(T0), tool(T0 + 2e3, {}), reply(T0 + 10e3, 'end_turn')]);
  assert.deepStrictEqual(turnCheck.checkTurn(cs('c-end'), T0 + 30e3, HOME), { finished: true, at: T0 + 10e3, state: 'done', detail: 'Finished' });
  assert.strictEqual(turnCheck.checkTurn(cs('c-end', { ts: T0 + 20e3, state: 'thinking' }), T0 + 30e3, HOME), null);
});

test('Claude Code: usage limits and other API errors end the turn; a retried error does not', () => {
  claude('c-limit', [prompt(T0), apiError(T0 + 6e3, 'rate_limit', 429, "You've hit your weekly limit")]);
  assert.deepStrictEqual(turnCheck.checkTurn(cs('c-limit', { state: 'needs-you' }), T0 + 30e3, HOME), { finished: true, at: T0 + 6e3, state: 'idle', detail: 'Usage limit reached' });
  claude('c-credit', [prompt(T0), apiError(T0 + 6e3, 'billing_error', 400, 'Credit balance is too low')]);
  assert.strictEqual(turnCheck.checkTurn(cs('c-credit'), T0 + 30e3, HOME).detail, 'Usage limit reached');
  claude('c-500', [prompt(T0), apiError(T0 + 6e3, 'server_error', 500, 'API Error: 500')]);
  assert.strictEqual(turnCheck.checkTurn(cs('c-500'), T0 + 30e3, HOME).detail, 'API error');
  claude('c-retried', [prompt(T0), apiError(T0 + 6e3, 'server_error', 500, 'API Error: 500'), tool(T0 + 9e3, {})]);
  assert.strictEqual(turnCheck.checkTurn(cs('c-retried'), T0 + 30e3, HOME), null);
});

test('Claude Code: pressing Esc or declining a tool reads as interrupted', () => {
  const declined = { type: 'user', timestamp: iso(T0 + 8e3), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
  claude('c-esc', [prompt(T0), tool(T0 + 2e3, {}), declined]);
  assert.deepStrictEqual(turnCheck.checkTurn(cs('c-esc', { state: 'needs-you' }), T0 + 30e3, HOME), { finished: true, at: T0 + 8e3, state: 'idle', detail: 'Interrupted' });
});

test('Claude Code: a long wait for your permission is never cut short', () => {
  claude('c-wait', [prompt(T0), tool(T0 + 2e3, {})]);
  assert.strictEqual(turnCheck.checkTurn(cs('c-wait', { state: 'needs-you' }), T0 + 3600e3, HOME), null);
});

test('Claude Code: a transcript is read again once it changes', () => {
  const s = cs('c-grow', { transcriptPath: path.join(claudeDir, 'c-grow.jsonl') });
  claude('c-grow', [prompt(T0), tool(T0 + 8e3, {})]);
  assert.strictEqual(turnCheck.checkTurn(s, T0 + 30e3, HOME), null);
  fs.appendFileSync(s.transcriptPath, JSON.stringify(reply(T0 + 20e3, 'end_turn')) + '\n');
  assert.strictEqual(turnCheck.checkTurn(s, T0 + 30e3, HOME).state, 'done');
});

test('Codex: an error event marks a usage limit; ordinary output mentioning one does not', () => {
  const said = (ms, text) => JSON.stringify({ timestamp: iso(ms), type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text }] } });
  const err = (ms, message) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'error', message } });
  rollout('s-limit', [ev(T0, 'task_started'), err(T0 + 50e3, "You've hit your usage limit."), ev(T0 + 60e3, 'task_complete')]);
  assert.strictEqual(turnCheck.checkTurn(session('s-limit'), T0 + 120e3, HOME).detail, 'Usage limit reached');
  rollout('s-said', [ev(T0, 'task_started'), said(T0 + 50e3, 'Handled the 429 rate limit and the quota check.'), ev(T0 + 60e3, 'task_complete')]);
  assert.strictEqual(turnCheck.checkTurn(session('s-said'), T0 + 120e3, HOME).detail, 'Finished');
});

test('Antigravity: a quiet transcript while waiting for you is left alone', () => {
  const sid = 'stall-session';
  const logs = path.join(HOME, '.gemini', 'antigravity', 'brain', sid, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const tfile = path.join(logs, 'transcript.jsonl');
  fs.writeFileSync(tfile, JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: iso(T0) }) + '\n');
  fs.utimesSync(tfile, new Date(T0), new Date(T0));
  assert.strictEqual(turnCheck.checkTurn({ harness: 'antigravity', sessionId: sid, state: 'needs-you', ts: T0 }, T0 + 3600e3, HOME), null);
});

test('background shells, agents and monitors a Claude Code turn left running count until they report back', () => {
  const dir = path.join(HOME, '.claude', 'projects', 'C--bg');
  fs.mkdirSync(dir, { recursive: true });
  const result = (ms, r) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult: r });
  const note = (ms, id, status) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` } });
  const write = (lines) => fs.writeFileSync(path.join(dir, 'bg.jsonl'), lines.join('\n') + '\n');
  const s = { harness: 'claude-code', sessionId: 'bg', state: 'done', ts: T0 + 20e3 };
  const started = [
    result(T0, { stdout: '', backgroundTaskId: 'b1' }),
    result(T0 + 1e3, { isAsync: true, status: 'async_launched', agentId: 'a1' }),
    result(T0 + 2e3, { taskId: 'm1', timeoutMs: 900000, persistent: false }),
    result(T0 + 3e3, { taskId: 'm2', timeoutMs: 900000, persistent: true }), // watches for good: not work
  ];
  write(started);
  assert.strictEqual(turnCheck.backgroundTasks(s, T0 + 60e3, HOME), 3);
  write([...started, note(T0 + 30e3, 'b1', 'completed'), note(T0 + 31e3, 'a1', 'failed')]);
  assert.strictEqual(turnCheck.backgroundTasks(s, T0 + 60e3, HOME), 1);
  write([...started, note(T0 + 30e3, 'b1', 'completed'), note(T0 + 31e3, 'a1', 'failed'), result(T0 + 32e3, { message: 'Successfully stopped task: m1 (watch)', task_id: 'm1' })]);
  assert.strictEqual(turnCheck.backgroundTasks(s, T0 + 60e3, HOME), 0);
  // a task whose app was closed never reports back; it stops counting after two hours
  write(started);
  assert.strictEqual(turnCheck.backgroundTasks(s, T0 + 2.5 * 3600e3, HOME), 0);
  assert.strictEqual(turnCheck.backgroundTasks({ ...s, harness: 'codex' }, T0 + 60e3, HOME), 0);
});
