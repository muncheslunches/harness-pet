// The hook bridge: every harness's events map to the right pet state.
// Runs the bridge with a temporary home folder so real state is untouched.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', 'hook', 'harness-pet-hook.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pet-test-'));
const DIR = path.join(HOME, '.harness-pet', 'sessions');

function fire(args, input = {}) {
  const r = spawnSync(process.execPath, [BRIDGE, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, USERPROFILE: HOME, HOME, CLAUDE_CODE_HOST_SESSION_ID: '' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'bridge must always exit 0');
  return r.stdout;
}
const read = (harness, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${harness}-${id}.json`), 'utf8'));
  } catch {
    return null;
  }
};

test('Claude Code events (snake_case, event in stdin)', () => {
  assert.strictEqual(fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'UserPromptSubmit', prompt: 'Rename project to Linkcraft', cwd: 'C:\\x\\linkcraft' }), '');
  assert.deepStrictEqual([read('claude-code', 'c1').state, read('claude-code', 'c1').title, read('claude-code', 'c1').project], ['thinking', 'Rename project to Linkcraft', 'linkcraft']);
  fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\a\\Main.kt' } });
  assert.strictEqual(read('claude-code', 'c1').detail, 'Editing Main.kt');
  fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' });
  assert.strictEqual(read('claude-code', 'c1').state, 'needs-you');
  fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'SubagentStop' });
  assert.strictEqual(read('claude-code', 'c1').state, 'needs-you', 'a subagent finishing is not the turn ending');
  fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'Stop' });
  assert.strictEqual(read('claude-code', 'c1').state, 'done');
  fire(['--harness', 'claude-code'], { session_id: 'c1', hook_event_name: 'SessionEnd' });
  assert.strictEqual(read('claude-code', 'c1'), null);
});

test('Antigravity (camelCase, event passed as a flag, JSON reply)', () => {
  fire(['--harness', 'antigravity', '--event', 'PreInvocation'], { sessionId: 'a1', userPrompt: 'Add dark mode', workspaceRoots: ['/w/app'] });
  assert.deepStrictEqual([read('antigravity', 'a1').state, read('antigravity', 'a1').title], ['thinking', 'Add dark mode']);
  const out = fire(['--harness', 'antigravity', '--event', 'PreToolUse', '--reply', '{"decision":"allow"}'], { sessionId: 'a1', toolName: 'run_command', toolInput: { command: 'npm test' } });
  assert.strictEqual(out, '{"decision":"allow"}');
  assert.deepStrictEqual([read('antigravity', 'a1').state, read('antigravity', 'a1').detail], ['working', 'Running command']);
  fire(['--harness', 'antigravity', '--event', 'PostInvocation'], { sessionId: 'a1' });
  assert.strictEqual(read('antigravity', 'a1').state, 'working', 'PostInvocation fires mid-turn, after every model call');
  fire(['--harness', 'antigravity', '--event', 'Stop'], { sessionId: 'a1', terminationReason: 'NO_TOOL_CALL' });
  assert.strictEqual(read('antigravity', 'a1').state, 'done');
});

test('Antigravity titles come from the transcript; subagent conversations are skipped', () => {
  const logs = (id) => path.join(HOME, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  const step = (o) => JSON.stringify({ step_index: 0, status: 'DONE', ...o }) + '\n';
  fs.mkdirSync(logs('main1'), { recursive: true });
  fs.writeFileSync(
    path.join(logs('main1'), 'transcript.jsonl'),
    step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n# Connect **Antigravity** to my pet\n\nDetails…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' })
  );
  fire(['--harness', 'antigravity', '--event', 'PreInvocation'], { conversationId: 'main1', workspacePaths: ['c:/w/app'] });
  assert.deepStrictEqual([read('antigravity', 'main1').state, read('antigravity', 'main1').title], ['thinking', 'Connect Antigravity to my pet']);

  fs.mkdirSync(logs('sub1'), { recursive: true });
  fs.writeFileSync(
    path.join(logs('sub1'), 'transcript.jsonl'),
    step({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] sender=cd8cae4f-151c-4368-9e7f-dc12c4493946 content=Run echo\n</SYSTEM_MESSAGE>' })
  );
  fire(['--harness', 'antigravity', '--event', 'PreInvocation'], { conversationId: 'sub1' });
  fire(['--harness', 'antigravity', '--event', 'PreToolUse'], { conversationId: 'sub1', toolCall: { name: 'run_command', args: {} } });
  assert.strictEqual(read('antigravity', 'sub1'), null);
});

test('Cursor events', () => {
  fire(['--harness', 'cursor', '--event', 'beforeSubmitPrompt'], { conversation_id: 'k1', prompt: 'Fix the login bug' });
  assert.strictEqual(read('cursor', 'k1').state, 'thinking');
  fire(['--harness', 'cursor', '--event', 'beforeShellExecution'], { conversation_id: 'k1', command: 'npm run build' });
  assert.deepStrictEqual([read('cursor', 'k1').state, read('cursor', 'k1').detail], ['working', 'Running command']);
  fire(['--harness', 'cursor', '--event', 'afterFileEdit'], { conversation_id: 'k1' });
  assert.strictEqual(read('cursor', 'k1').state, 'thinking');
  fire(['--harness', 'cursor', '--event', 'stop'], { conversation_id: 'k1' });
  assert.strictEqual(read('cursor', 'k1').state, 'done');
});

test('Codex notify passes its event as a JSON argument', () => {
  fire(['--harness', 'codex', '--event', 'agent-turn-complete', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'x', thread_id: 'th1' })], '');
  assert.strictEqual(read('codex', 'th1').state, 'done');
});

test('a late tool event from a finished turn cannot undo its Stop', () => {
  const ev = (name, turn) => fire(['--harness', 'codex', '--event', name], { session_id: 'late1', turn_id: turn, hook_event_name: name, transcript_path: 'C:\\r.jsonl' });
  ev('UserPromptSubmit', 't1');
  ev('PostToolUse', 't1');
  ev('Stop', 't1');
  ev('PostToolUse', 't1'); // a killed hook's Node child writing after Stop
  assert.deepStrictEqual([read('codex', 'late1').state, read('codex', 'late1').turnId, read('codex', 'late1').transcriptPath], ['done', 't1', 'C:\\r.jsonl']);
  ev('PreToolUse', 't2'); // the next turn
  assert.strictEqual(read('codex', 'late1').state, 'working');
});

test('model names come from the input or the transcript', () => {
  const transcript = path.join(HOME, 't.jsonl');
  fs.writeFileSync(transcript, '{"message":{"model":"claude-sonnet-5-5"}}\n{"message":{"model":"claude-opus-5-5"}}\n');
  fire(['--harness', 'claude-code'], { session_id: 'm1', hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: transcript });
  assert.strictEqual(read('claude-code', 'm1').model, 'Claude Opus 5.5');
  fire(['--harness', 'gemini-cli', '--event', 'BeforeTool'], { session_id: 'm2', model: 'gemini-3-pro' });
  assert.strictEqual(read('gemini-cli', 'm2').model, 'Gemini 3 Pro');
  fire(['--harness', 'codex', '--event', 'PreToolUse'], { session_id: 'm3', model: 'gpt-5.5-codex' });
  assert.strictEqual(read('codex', 'm3').model, 'GPT-5.5 Codex');
});

test('explicit state mode for any agent', () => {
  fire(['--harness', 'my-agent', '--state', 'working', '--detail', 'Crunching numbers', '--session', 's9', '--title', 'Budget report']);
  assert.deepStrictEqual([read('my-agent', 's9').state, read('my-agent', 's9').detail, read('my-agent', 's9').title], ['working', 'Crunching numbers', 'Budget report']);
  fire(['--harness', 'my-agent', '--state', 'end', '--session', 's9']);
  assert.strictEqual(read('my-agent', 's9'), null);
});

test('garbage never breaks anything', () => {
  fire(['--harness', 'claude-code'], 'not json at all');
  fire(['--harness', 'claude-code'], { hook_event_name: 'Stop' }); // no session id
  fire([], {});
});

test('background task and subagent task handling for all agent connections', () => {
  // Antigravity Stop with fullyIdle: false keeps state in working
  fire(['--harness', 'antigravity', '--event', 'PreInvocation'], { sessionId: 'bg1', userPrompt: 'Run long job' });
  assert.strictEqual(read('antigravity', 'bg1').state, 'thinking');
  fire(['--harness', 'antigravity', '--event', 'Stop'], { sessionId: 'bg1', fullyIdle: false });
  assert.deepStrictEqual([read('antigravity', 'bg1').state, read('antigravity', 'bg1').detail], ['working', 'Background task running']);
  // Once fully idle, normal stop marks done
  fire(['--harness', 'antigravity', '--event', 'Stop'], { sessionId: 'bg1', fullyIdle: true });
  assert.strictEqual(read('antigravity', 'bg1').state, 'done');

  // Subagents mirror activity to parent conversation
  const parentId = '11111111-2222-3333-4444-555555555555';
  fire(['--harness', 'antigravity', '--event', 'PreInvocation'], { conversationId: parentId, userPrompt: 'Parent task' });
  fire(['--harness', 'antigravity', '--event', 'Stop'], { conversationId: parentId, fullyIdle: true });
  assert.strictEqual(read('antigravity', parentId).state, 'done');

  const logs = (id) => path.join(HOME, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  const subId = 'sub-child-99';
  fs.mkdirSync(logs(subId), { recursive: true });
  fs.writeFileSync(
    path.join(logs(subId), 'transcript.jsonl'),
    JSON.stringify({ step_index: 0, status: 'DONE', source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n[Message] sender=${parentId} content=Explore code\n</SYSTEM_MESSAGE>` }) + '\n'
  );
  fire(['--harness', 'antigravity', '--event', 'PreToolUse'], { conversationId: subId, toolCall: { name: 'run_command', args: { CommandLine: 'pytest' } } });
  assert.strictEqual(read('antigravity', subId), null, 'subagent standalone file is omitted');
  assert.deepStrictEqual([read('antigravity', parentId).state, read('antigravity', parentId).detail], ['working', 'Subagent: Running: pytest']);

  // Claude Code / Generic TaskStart and background notifications
  fire(['--harness', 'claude-code'], { session_id: 'c2', hook_event_name: 'Notification', notification_type: 'task_started', message: 'Claude Running tests in background' });
  assert.deepStrictEqual([read('claude-code', 'c2').state, read('claude-code', 'c2').detail], ['working', 'Running tests in background']);

  // Generic harness TaskStart event
  fire(['--harness', 'generic-agent', '--event', 'TaskStart'], { session_id: 'g1', detail: 'Processing dataset' });
  assert.deepStrictEqual([read('generic-agent', 'g1').state, read('generic-agent', 'g1').detail], ['working', 'Processing dataset']);
});
