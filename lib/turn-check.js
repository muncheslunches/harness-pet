// Agents report a finished turn through a hook, and a hook can be lost: Codex
// gives each hook a few seconds, and under load PowerShell + Node can take longer,
// so the Stop hook is killed before it writes and the session stays "thinking".
// Codex also records every turn boundary in its rollout transcript, so a session
// that still looks busy is checked there.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL = 256 * 1024; // bytes of the transcript read from its end
const SETTLE_MS = 3000; // a busy record this fresh is trusted as is
const LATE_MS = 15000; // a busy record written this long after the turn ended is a new turn

const cache = new Map(); // transcript file → { size, mtimeMs, last }
const located = new Map(); // session id → transcript file

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

// The last turn boundary in a Codex rollout: { kind: 'started' | 'ended', at }.
function lastBoundary(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.last;
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"event_msg"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; } // the first line of the tail is usually cut
    const type = j.payload && j.payload.type;
    const kind = type === 'task_started' ? 'started' : type === 'task_complete' || type === 'turn_aborted' ? 'ended' : null;
    const at = Date.parse(j.timestamp);
    if (kind && Number.isFinite(at)) last = { kind, at };
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, last });
  return last;
}

// Returns when the turn ended if a busy-looking session has in fact finished, else null.
function antigravityTaskFinishedAt(s, now = Date.now(), home = os.homedir()) {
  if (s.harness !== 'antigravity' || s.state !== 'working' || !String(s.detail || '').includes('Background task')) return null;
  if (now - (s.ts || 0) < SETTLE_MS || !s.sessionId) return null;
  const p = s.transcriptPath || path.join(home, '.gemini', 'antigravity', 'brain', s.sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  let text = '';
  try {
    const fd = fs.openSync(p, 'r');
    const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }

  let lastTaskStart = 0;
  let lastTaskFinish = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const content = String(j.content || '');
    if (j.status === 'RUNNING' && content.includes('running as a background task')) {
      const at = Date.parse(j.created_at) || st.mtimeMs;
      if (at > lastTaskStart) lastTaskStart = at;
    }
    if (content.includes('finished with result:')) {
      const m = content.match(/timestamp=([^\s]+)/);
      const at = (m && Date.parse(m[1])) || st.mtimeMs;
      if (at > lastTaskFinish) lastTaskFinish = at;
    }
  }
  if (lastTaskFinish && lastTaskFinish >= lastTaskStart) {
    return lastTaskFinish;
  }
  return null;
}

function finishedAt(s, now = Date.now(), home) {
  if (s.harness === 'antigravity') {
    return antigravityTaskFinishedAt(s, now, home);
  }
  if (s.harness !== 'codex' || (s.state !== 'thinking' && s.state !== 'working')) return null;
  if (now - (s.ts || 0) < SETTLE_MS || !s.sessionId) return null;
  const last = (s.transcriptPath && lastBoundary(s.transcriptPath)) ||
    lastBoundary(findCodexRollout(s.sessionId, s.since || s.ts || now, home) || '');
  if (!last || last.kind !== 'ended') return null;
  // A record written well after the turn ended belongs to a newer turn whose
  // start has not reached the transcript yet.
  if ((s.ts || 0) > last.at + LATE_MS) return null;
  return last.at;
}

module.exports = { finishedAt, lastBoundary, findCodexRollout };
