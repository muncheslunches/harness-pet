#!/usr/bin/env node
// Harness Pet hook bridge. Any coding agent's hooks can call this to tell the
// pets what the agent is doing. It writes one small JSON file per session into
//   ~/.harness-pet/sessions/<harness>-<session>.json
//
// Usage (from a hook command):
//   node harness-pet-hook.js --harness claude-code                 (event read from stdin JSON)
//   node harness-pet-hook.js --harness antigravity --event PreToolUse
//   node harness-pet-hook.js --harness my-agent --state working --detail "Running tests" [--session ID] [--title T]
//   node harness-pet-hook.js ... --reply '{"decision":"allow"}'      (print this to stdout for harnesses that need an answer)
//
// Rules: never block, never print anything except an explicit --reply, always exit 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.harness-pet', 'sessions');
setTimeout(() => finish(), 1500).unref();

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      out[k] = v !== undefined ? v : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else if (a.trim().startsWith('{')) {
      out._json = a; // e.g. Codex "notify" passes its event as a JSON argument
    }
  }
  return out;
}
const opts = args(process.argv.slice(2));

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  let rep = typeof opts.reply === 'string' ? opts.reply.trim() : '';
  if (rep) {
    if ((rep.startsWith('"') && rep.endsWith('"')) || (rep.startsWith("'") && rep.endsWith("'"))) {
      try {
        const parsed = JSON.parse(rep);
        if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) rep = parsed;
        else if (typeof parsed === 'object') rep = JSON.stringify(parsed);
      } catch {
        rep = rep.slice(1, -1);
      }
    }
    try {
      JSON.parse(rep);
      process.stdout.write(rep);
      process.exit(0);
      return;
    } catch {}
  }
  if (opts.harness === 'antigravity') {
    const e = String(opts.event || '').toLowerCase();
    if (e.includes('pretool')) process.stdout.write(JSON.stringify({ decision: 'allow' }));
    else process.stdout.write('{}');
  }
  process.exit(0);
}

const base = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
function clip(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}
// Read a field under any of several names (snake_case, camelCase, nested).
function pick(obj, ...names) {
  for (const n of names) {
    const v = n.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function describeTool(name, input) {
  input = input && typeof input === 'object' ? input : {};
  const file = base(pick(input, 'file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'targetFile', 'TargetFile', 'AbsolutePath'));
  const n = String(name || '');
  const lower = n.toLowerCase();
  if (/^(bash|powershell|shell|run_?(shell_?)?command|terminal|exec)/.test(lower) || lower.includes('shell')) {
    const d = pick(input, 'description', 'explanation', 'toolAction', 'toolSummary', 'CommandLine');
    return d ? 'Running: ' + clip(String(d), 40) : 'Running command';
  }
  if (/edit|write|replace|patch|create_?file/.test(lower)) return file ? 'Editing ' + file : 'Editing a file';
  if (/read|view|open_?file|cat/.test(lower)) return file ? 'Reading ' + file : 'Reading a file';
  if (/grep|glob|search|find|list_?dir|ls/.test(lower)) return lower.includes('web') ? 'Browsing the web' : 'Searching the code';
  if (/web|fetch|browse|url/.test(lower)) return 'Browsing the web';
  if (/task|agent|subagent|delegate/.test(lower)) {
    const r = pick(input, 'Role', 'role', 'description', 'prompt', 'task');
    return r ? 'Task: ' + clip(String(r), 34) : 'Delegating to an agent';
  }
  if (/todo|plan/.test(lower)) return 'Updating the plan';
  if (lower.startsWith('mcp__')) {
    const parts = n.split('__');
    return 'Using ' + clip(parts.slice(2).join(' ').replace(/_/g, ' ') || parts[1] || 'a tool', 36);
  }
  return n ? 'Using ' + clip(n, 36) : 'Working';
}

// First line of a prompt, without the XML-ish blocks harnesses wrap around it.
function titleFrom(text) {
  let s = String(text || '');
  const req = s.match(/<USER_REQUEST>([\s\S]*?)(<\/USER_REQUEST>|$)/i); // Antigravity
  if (req) s = req[1];
  s = s.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/?[a-z][\w-]*[^>]*>/gi, '');
  const first = s.split(/\r?\n/).find((l) => l.trim()) || '';
  return clip(first.replace(/^\s*#+\s*/, '').replace(/\*\*/g, ''), 48);
}

// Antigravity hooks carry no prompt, and each subagent it spawns runs as its own
// conversation. The transcript's first steps tell which: the user's request, or
// a message from a parent conversation ("sender=<id>").
function antigravityStart(ev, session) {
  const paths = [
    pick(ev, 'transcriptPath', 'transcript_path'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain', session, '.system_generated', 'logs', 'transcript.jsonl'),
  ];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    let head;
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(32 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8', 0, n);
    } catch {
      continue;
    }
    const steps = [];
    for (const line of head.split('\n')) {
      try {
        steps.push(JSON.parse(line));
      } catch {}
    }
    if (!steps.length) continue;
    const first = steps[0];
    const match = String(first.content || '').match(/sender=([0-9a-f-]{36})/i);
    if (first.type !== 'USER_INPUT' && /^SYSTEM/.test(String(first.source)) && match) {
      return { subagent: true, parentSession: match[1] };
    }
    const input = steps.find((s) => s.type === 'USER_INPUT');
    return { title: input ? titleFrom(input.content) : '' };
  }
  return {};
}

const ASKS_USER =/^(askuserquestion|exitplanmode|ask_?user|request_?user_?input|ask_?question)$/i;

// Map any harness's event name onto a pet state, by keyword.
function fromEvent(ev, event, prev) {
  const e = String(event || '').toLowerCase().replace(/[^a-z]/g, '');
  const tool = pick(ev, 'toolCall.name', 'tool_name', 'toolName', 'tool.name', 'tool');
  const toolInput = pick(ev, 'toolCall.args', 'tool_input', 'toolInput', 'tool.input', 'input', 'args', 'arguments');

  if (/subagent/.test(e)) {
    if (/subagent.?start/.test(e)) return { state: 'working', detail: 'Subagent working' };
    return null; // a helper agent finishing is not the main turn ending
  }
  // Antigravity's PostInvocation fires after every model call mid-turn; only Stop ends the turn.
  if (/postinvocation/.test(e)) return null;
  if (/sessionend|sessionstop|exit$/.test(e)) return { remove: true };
  if (/userpromptsubmit|beforesubmitprompt|beforeagent|preinvocation|promptsubmit|userprompt|preuserprompt|turnstart/.test(e)) {
    const title = titleFrom(pick(ev, 'prompt', 'userPrompt', 'user_prompt', 'message', 'input.prompt'));
    return { state: 'thinking', detail: 'Thinking', title: title || prev.title };
  }
  if (/taskstart|backgroundtask(start)?|jobstart/.test(e)) {
    const d = pick(ev, 'detail', 'task', 'description', 'message', 'title');
    return { state: 'working', detail: d ? clip(String(d), 48) : 'Task running' };
  }
  if (/permission|elicitation/.test(e)) return { state: 'needs-you', detail: 'Needs permission: ' + clip(String(tool || 'a tool'), 28) };
  if (/notification|notify/.test(e)) {
    const type = String(pick(ev, 'notification_type', 'notificationType', 'type') || '');
    const msg = String(pick(ev, 'message', 'title') || '');
    if (/task.?start|background.?start/.test(type) || /task started|running in background/i.test(msg)) {
      return { state: 'working', detail: clip(msg.replace(/^Claude\s+/i, '') || 'Task running', 44) };
    }
    if (/idle|auth_success/.test(type) || /waiting for your input/i.test(msg)) return null;
    if (/turn.?complete|agent.?turn/.test(type)) return { state: 'done', detail: 'Finished' };
    const text = clip(msg.replace(/^Claude\s+/i, ''), 44);
    return { state: 'needs-you', detail: text ? text[0].toUpperCase() + text.slice(1) : 'Needs you' };
  }
  if (/pretooluse|beforetool|beforeshell|beforemcp|beforereadfile|preruncommand|prereadcode|prewritecode|premcp|toolstart|pretool/.test(e)) {
    if (ASKS_USER.test(String(tool || ''))) {
      return { state: 'needs-you', detail: /plan/i.test(String(tool)) ? 'Plan ready for review' : 'Has a question for you' };
    }
    const guess = !tool && /shell|command/.test(e) ? 'shell' : !tool && /read/.test(e) ? 'read' : tool;
    return { state: 'working', detail: describeTool(guess, toolInput || ev) };
  }
  if (/posttooluse|aftertool|afterfileedit|aftershell|aftermcp|postruncommand|postwritecode|postreadcode|toolend|posttool/.test(e)) {
    return { state: 'thinking', detail: 'Thinking' };
  }
  if (/stop|afteragent|taskcomplete|turncomplete|turnend|agentturncomplete|complete|done/.test(e)) {
    const fullyIdle = pick(ev, 'fullyIdle', 'fully_idle');
    if (fullyIdle === false) {
      return { state: 'working', detail: 'Background task running' };
    }
    return { state: 'done', detail: 'Finished' };
  }
  return null;
}

// "claude-opus-5-5" → "Claude Opus 5.5", "gemini-3-pro" → "Gemini 3 Pro", "gpt-5.5-codex" → "GPT-5.5 Codex"
function prettyModel(id) {
  if (typeof id !== 'string' || !id.trim()) return '';
  const s = id.trim().replace(/^(models\/|anthropic\.|us\.anthropic\.)/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  if (/^gpt/i.test(s)) return s.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c) => ' ' + c.toUpperCase());
  const parts = s.split(/[-_ ]+/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] || '') && parts[i + 1].length <= 2) {
      out.push(p + '.' + parts[++i]);
    } else out.push(/^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1));
  }
  return out.join(' ');
}

// Which model is answering: from the hook input, or the tail of a Claude Code transcript.
function detectModel(ev, prev) {
  const direct = pick(ev, 'model', 'model_id', 'modelId', 'modelName', 'model.display_name', 'model.id');
  if (typeof direct === 'string') return prettyModel(direct);
  const transcript = pick(ev, 'transcript_path', 'transcriptPath');
  if (typeof transcript === 'string') {
    try {
      const fd = fs.openSync(transcript, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 96 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const all = buf.toString('utf8').match(/"model":"([^"]+)"/g);
      if (all && all.length) return prettyModel(all[all.length - 1].slice(9, -1));
    } catch {}
  }
  return prev.model || '';
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 400).unref();
  });
}

function janusOwnsSession(harness) {
  // Agent hook settings are shared by desktop/CLI and VS Code. Only Janus's
  // additional observer should publish VS Code events while it is installed.
  const env = process.env;
  const vscode =
    (harness === 'codex' && env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'codex_vscode') ||
    (harness === 'claude-code' && env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') ||
    (harness === 'antigravity' && env.ANTIGRAVITY_VSCODE_HOST === '1' && env.ANTIGRAVITY_AUTH_SUCCESS_APP === 'vscode');
  if (!vscode) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harness-pet', 'vscode', 'installation.json'), 'utf8'));
    return manifest.extension === 'harness-pet-local.janus-vscode';
  } catch { return false; }
}

async function main() {
  const raw = await readStdin();
  let ev = {};
  for (const text of [raw, opts._json]) {
    if (!text || !String(text).trim()) continue;
    try {
      ev = { ...ev, ...JSON.parse(text) };
    } catch {}
  }

  const harness = String(opts.harness || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'unknown';
  if (janusOwnsSession(harness)) return;
  const session = String(
    opts.session || pick(ev, 'session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId', 'chat_id', 'taskId', 'task_id', 'id') ||
      (opts.state ? 'default' : '')
  ).replace(/[^A-Za-z0-9_-]/g, '');
  if (!session) return;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `${harness}-${session}.json`);

  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  if (harness === 'antigravity') {
    const start = antigravityStart(ev, session);
    if (start.subagent) {
      // its parent conversation already shows what's going on; mirror subagent work to parent session
      fs.rmSync(file, { force: true });
      if (start.parentSession) {
        const parentFile = path.join(STATE_DIR, `${harness}-${start.parentSession}.json`);
        try {
          const parent = JSON.parse(fs.readFileSync(parentFile, 'utf8'));
          let subChange = opts.state
            ? { state: String(opts.state), detail: typeof opts.detail === 'string' ? clip(opts.detail, 48) : parent.detail || '' }
            : fromEvent(ev, opts.event || pick(ev, 'hook_event_name', 'hookEventName', 'event', 'eventName', 'type'), parent);
          if (subChange && subChange.state === 'working') {
            const detail = subChange.detail ? (subChange.detail.startsWith('Subagent') ? subChange.detail : 'Subagent: ' + subChange.detail) : 'Subagent working';
            const updated = { ...parent, state: 'working', detail: clip(detail, 48), ts: Date.now() };
            fs.writeFileSync(parentFile, JSON.stringify(updated));
          }
        } catch {}
      }
      return;
    }
    if (start.title && !prev.title) prev.title = start.title;
  }

  let change;
  if (opts.state) {
    const state = String(opts.state);
    if (state === 'end' || state === 'remove') change = { remove: true };
    else change = { state, detail: typeof opts.detail === 'string' ? clip(opts.detail, 48) : prev.detail || '' };
  } else {
    change = fromEvent(ev, opts.event || pick(ev, 'hook_event_name', 'hookEventName', 'event', 'eventName', 'type'), prev);
  }
  if (!change) return;
  if (change.remove) {
    fs.rmSync(file, { force: true });
    return;
  }

  // Hooks run as separate processes, and one killed by a timeout can leave its
  // Node child to write late: a tool event from a turn that already finished
  // must not turn "done" back into "thinking".
  const turnId = pick(ev, 'turn_id', 'turnId');
  const midTurn = /tooluse|beforetool|aftertool|toolstart|toolend|pretool|posttool/.test(String(opts.event || pick(ev, 'hook_event_name', 'hookEventName') || '').toLowerCase());
  if (!opts.state && midTurn && prev.state === 'done' && turnId && prev.turnId === turnId) return;

  const now = Date.now();
  const cwd = pick(ev, 'cwd', 'workspace', 'workspaceRoot', 'workspace_roots.0', 'workspaceRoots.0', 'workspacePaths.0', 'project_dir', 'projectDir') || prev.cwd || process.cwd();
  const record = {
    harness,
    sessionId: session,
    // Claude Desktop sets this for Code-tab sessions; lets the pet open the exact session.
    hostSessionId: process.env.CLAUDE_CODE_HOST_SESSION_ID || prev.hostSessionId || null,
    cwd,
    project: base(cwd),
    title: typeof opts.title === 'string' ? clip(opts.title, 48) : prev.title || '',
    model: typeof opts.model === 'string' ? prettyModel(opts.model) : detectModel(ev, prev),
    turnId: turnId || prev.turnId || undefined,
    // lets the app confirm a turn ended from the agent's own record if a Stop hook is lost
    transcriptPath: pick(ev, 'transcript_path', 'transcriptPath') || prev.transcriptPath || undefined,
    ...change,
    since: change.state === prev.state ? prev.since || now : now,
    ts: now,
  };
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record));
  // On Windows the rename fails (EPERM/EBUSY) while the pet is reading the file;
  // losing the update would leave a stale state (e.g. a lost Stop), so retry, then write in place.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      if (i >= 4) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(file, JSON.stringify(record));
}

// Never fail the agent's hook, but leave a trace of why an update was lost.
main().catch((err) => {
  try {
    const log = path.join(os.homedir(), '.harness-pet', 'hook-errors.log');
    if ((fs.statSync(log, { throwIfNoEntry: false })?.size || 0) > 256 * 1024) fs.rmSync(log, { force: true });
    fs.appendFileSync(log, `${new Date().toISOString()} ${opts.harness || '?'} ${opts.event || ''} ${err && err.stack || err}\n`);
  } catch {}
}).finally(finish);
