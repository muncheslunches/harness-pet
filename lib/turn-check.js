// Agents report a finished turn through a hook, and a hook can be lost: Codex
// gives each hook a few seconds, and under load PowerShell + Node can take longer,
// so the Stop hook is killed before it writes and the session stays "thinking".
// The agent's own transcript settles it. Only records of how a turn ended count
// (a turn boundary, an interrupt, an API error); text the agent read or wrote never does.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL = 256 * 1024; // bytes of the transcript read from its end
const SETTLE_MS = 3000; // a busy record this fresh is trusted as is
const LATE_MS = 15000; // a busy record written this long after the turn ended is a new turn
const EARLY_MS = 2000; // an error or interrupt can land before the slower hook that preceded it
const RETRY_FIND_MS = 30000; // a transcript that could not be found is looked for again after this
const BACKGROUND_MAX_MS = 2 * 3600e3; // a background task that never reported back stops counting after this

// Applied only to the message of a recorded error, never to transcript text in general.
const USAGE = /(quota|rate[ _-]?limit|usage[ _-]?limit|resource[ _-]?exhausted|credit[ _-]?balance|out[ _-]?of[ _-]?(usage|credits)|insufficient[ _-]?quota|billing)/i;

const scans = new Map(); // kind + transcript file → { size, mtimeMs, last }
const located = new Map(); // session id → transcript file
const missing = new Map(); // session id → when a search last came up empty

function readTail(file, size) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Sessions are polled several times a second; a transcript is parsed again only when it changes.
function scan(kind, file, parse) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = kind + ':' + file;
  const hit = scans.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.last;
  const text = readTail(file, st.size);
  if (text === null) return null;
  const last = parse(text, st.mtimeMs);
  if (scans.size > 200) scans.clear();
  scans.set(key, { size: st.size, mtimeMs: st.mtimeMs, last });
  return last;
}

function records(text, keep) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!keep(line)) continue;
    try { out.push(JSON.parse(line)); } catch {} // the first line of the tail is usually cut
  }
  return out;
}

// ---------- Codex ----------

// Codex keeps rollouts in ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl
function findCodexRollout(sessionId, near, home = os.homedir()) {
  if (located.has(sessionId)) return located.get(sessionId);
  const root = path.join(home, '.codex', 'sessions');
  for (const offset of [0, -1, 1]) {
    const d = new Date(near + offset * 86400e3);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => n.endsWith(`-${sessionId}.jsonl`));
    if (hit) {
      const file = path.join(dir, hit);
      located.set(sessionId, file);
      return file;
    }
  }
  return null;
}

// The last turn boundary in a Codex rollout: { kind: 'started' | 'ended', at, error },
// where error is the message of an error event recorded during that turn.
function parseCodex(text) {
  let last = null;
  let error = null;
  for (const j of records(text, (line) => line.includes('"event_msg"'))) {
    const type = j.payload && j.payload.type;
    if (type === 'error') { error = String(j.payload.message || ''); continue; }
    const kind = type === 'task_started' ? 'started' : type === 'task_complete' || type === 'turn_aborted' ? 'ended' : null;
    const at = Date.parse(j.timestamp);
    if (kind === 'started') error = null;
    if (kind && Number.isFinite(at)) last = { kind, at, error };
  }
  return last;
}

const lastBoundary = (file) => scan('codex', file, parseCodex);

function checkCodexTurn(s, now, home) {
  const file = s.transcriptPath && fs.existsSync(s.transcriptPath) ? s.transcriptPath : findCodexRollout(s.sessionId, s.since || s.ts || now, home);
  if (!file) return null;
  const last = lastBoundary(file);
  if (!last || last.kind !== 'ended') return null;
  if ((s.ts || 0) > last.at + LATE_MS) return null;
  const usage = !!last.error && USAGE.test(last.error);
  return { finished: true, at: last.at, state: usage ? 'idle' : 'done', detail: usage ? 'Usage limit reached' : 'Finished' };
}

// ---------- Claude Code ----------

// Claude Code keeps transcripts in ~/.claude/projects/<project>/<session id>.jsonl
function findClaudeTranscript(sessionId, home = os.homedir(), now = Date.now()) {
  const key = 'claude:' + sessionId;
  if (located.has(key)) return located.get(key);
  if (now - (missing.get(key) ?? -Infinity) < RETRY_FIND_MS) return null;
  const root = path.join(home, '.claude', 'projects');
  let projects = [];
  try { projects = fs.readdirSync(root); } catch {}
  for (const project of projects) {
    const file = path.join(root, project, sessionId + '.jsonl');
    if (fs.existsSync(file)) {
      located.set(key, file);
      return file;
    }
  }
  missing.set(key, now);
  return null;
}

const interrupted = (content) => (typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((c) => c && c.text) : [])
  .some((t) => typeof t === 'string' && t.startsWith('[Request interrupted by user'));

// Where the last exchange stands: { kind, at, usage }. kind is 'ended' (the reply
// finished), 'interrupted' (Esc, or a declined tool), 'error' (an API error such as
// a usage limit ended the turn) or 'busy'.
function parseClaude(text, mtimeMs) {
  let last = null;
  const keep = (line) => line.includes('"type":"assistant"') || line.includes('"type":"user"');
  for (const j of records(text, keep)) {
    if ((j.type !== 'assistant' && j.type !== 'user') || j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || mtimeMs;
    const m = j.message || {};
    if (j.type === 'assistant' && j.isApiErrorMessage) {
      last = { kind: 'error', at, usage: j.error === 'rate_limit' || j.error === 'billing_error' || j.apiErrorStatus === 429 };
    } else if (j.type === 'assistant') {
      last = { kind: m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' ? 'ended' : 'busy', at };
    } else {
      last = { kind: interrupted(m.content) ? 'interrupted' : 'busy', at };
    }
  }
  return last;
}

function checkClaudeTurn(s, now, home) {
  const file = s.transcriptPath && fs.existsSync(s.transcriptPath) ? s.transcriptPath : findClaudeTranscript(s.sessionId, home, now);
  if (!file) return null;
  const last = scan('claude', file, parseClaude);
  const ts = s.ts || 0;
  if (!last || last.kind === 'busy') return null;
  if (last.kind === 'ended') return last.at >= ts ? { finished: true, at: last.at, state: 'done', detail: 'Finished' } : null;
  if (last.at < ts - EARLY_MS) return null;
  if (last.kind === 'interrupted') return { finished: true, at: last.at, state: 'idle', detail: 'Interrupted' };
  return { finished: true, at: last.at, state: 'idle', detail: last.usage ? 'Usage limit reached' : 'API error' };
}

// Background work a Claude Code turn left running: shells (backgroundTaskId), agents
// (isAsync + agentId) and monitors (taskId). Each ends with a <task-notification>
// naming its task id, or a TaskStop. Returns the start time of each one still open.
function parseClaudeTasks(text, mtimeMs) {
  const open = new Map(); // task id → started at
  for (const line of text.split('\n')) {
    if (line.includes('<task-notification>') && !line.includes('"type":"assistant"')) {
      for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>/g)) open.delete(m[1]);
      continue;
    }
    if (!line.includes('"toolUseResult"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const r = j.toolUseResult;
    if (j.type !== 'user' || j.isSidechain || !r || typeof r !== 'object') continue;
    const id = r.backgroundTaskId || (r.isAsync && r.agentId) || (r.taskId && !r.persistent && r.taskId);
    if (typeof id === 'string') open.set(id, Date.parse(j.timestamp) || mtimeMs);
    if (typeof r.task_id === 'string' && /^Successfully stopped/i.test(String(r.message || ''))) open.delete(r.task_id);
  }
  return [...open.values()];
}

// How many background tasks of this session are still running. One that never
// reported back (its app was closed) stops counting BACKGROUND_MAX_MS after it started.
function backgroundTasks(s, now = Date.now(), home = os.homedir()) {
  if (!s || !s.sessionId || (s.harness !== 'claude-code' && s.harness !== 'vscode')) return 0;
  if (now - (s.ts || 0) > BACKGROUND_MAX_MS) return 0; // nothing it started can still count
  const file = s.transcriptPath && fs.existsSync(s.transcriptPath) ? s.transcriptPath : findClaudeTranscript(s.sessionId, home, now);
  if (!file) return 0;
  const started = scan('claude-bg', file, parseClaudeTasks) || [];
  return started.filter((at) => now - at < BACKGROUND_MAX_MS).length;
}

// ---------- Antigravity ----------

function findAntigravityTranscript(sessionId, home = os.homedir()) {
  const logs = path.join(home, '.gemini', 'antigravity', 'brain', sessionId, '.system_generated', 'logs');
  for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) {
    if (fs.existsSync(path.join(logs, name))) return path.join(logs, name);
  }
  return null;
}

// Background task starts and finishes, the planner's last step, and whether the
// very last step failed on a usage limit.
function parseAntigravity(text, mtimeMs) {
  const out = { taskStart: 0, taskFinish: 0, planner: null, limit: null };
  for (const j of records(text, (line) => !!line.trim())) {
    const content = String(j.content || '');
    const at = Date.parse(j.created_at) || mtimeMs;
    if (j.status === 'RUNNING' && content.includes('running as a background task')) out.taskStart = Math.max(out.taskStart, at);
    if (content.includes('finished with result:')) {
      const m = content.match(/timestamp=([^\s]+)/);
      out.taskFinish = Math.max(out.taskFinish, (m && Date.parse(m[1])) || at);
    }
    if (j.type === 'PLANNER_RESPONSE') out.planner = { at, done: j.status === 'DONE' && !(j.tool_calls && j.tool_calls.length) };
    out.limit = j.status === 'ERROR' && USAGE.test(content) ? { at } : null;
  }
  return out;
}

function checkAntigravityTurn(s, now, home) {
  const file = s.transcriptPath || findAntigravityTranscript(s.sessionId, home);
  if (!file) return null;
  const t = scan('antigravity', file, parseAntigravity);
  if (!t) return null;
  const ts = s.ts || 0;
  if (t.taskFinish && t.taskFinish >= t.taskStart && String(s.detail || '').includes('Background task')) {
    return { finished: true, at: t.taskFinish, state: 'done', detail: 'Finished' };
  }
  if (t.limit && t.limit.at >= ts - EARLY_MS) return { finished: true, at: t.limit.at, state: 'idle', detail: 'Usage limit reached' };
  if (t.planner && t.planner.done && t.planner.at >= ts) return { finished: true, at: t.planner.at, state: 'done', detail: 'Finished' };
  return null;
}

// ---------- any agent ----------

// How a session that still looks busy or waiting actually stands, from its transcript:
// { finished: true, at, state, detail }, or null when the record stands as written.
// A wait for your permission writes nothing, so a quiet transcript never ends a turn.
function checkTurn(s, now = Date.now(), home = os.homedir()) {
  if (!s || !s.sessionId || !s.state || s.state === 'done' || s.state === 'idle') return null;
  if (now - (s.ts || 0) < SETTLE_MS) return null;
  if (s.harness === 'codex') return checkCodexTurn(s, now, home);
  if (s.harness === 'claude-code' || s.harness === 'vscode') return checkClaudeTurn(s, now, home);
  if (s.harness === 'antigravity') return checkAntigravityTurn(s, now, home);
  return null;
}

function finishedAt(s, now = Date.now(), home) {
  const res = checkTurn(s, now, home);
  return res ? res.at : null;
}

module.exports = { checkTurn, finishedAt, backgroundTasks, lastBoundary, findCodexRollout };
