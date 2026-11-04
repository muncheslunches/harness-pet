// How rested a pet should be: 0 awake, 1 drowsy (slow motion, no wandering or tricks),
// 2 asleep (no moving or interacting). Measured from whichever happened last: you using
// the PC, or the agent this pet follows saying something new.

const DEFAULT_SLOW_MINUTES = 5;
const DEFAULT_SLEEP_MINUTES = 10;

const minutes = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

function levelFor(quietMs, prefs = {}) {
  if (prefs.idleRest === false) return 0;
  if (quietMs >= minutes(prefs.idleSleepMinutes, DEFAULT_SLEEP_MINUTES) * 60e3) return 2;
  return quietMs >= minutes(prefs.idleSlowMinutes, DEFAULT_SLOW_MINUTES) * 60e3 ? 1 : 0;
}

// What a pet's agent has said so far. `age` and the like tick on their own, so they stay out.
function agentSignature(sessions) {
  return (sessions || []).map((s) => [s.sessionId, s.state, s.effective, s.ts, s.detail, s.background].join('|')).sort().join('\n');
}

module.exports = { levelFor, agentSignature, DEFAULT_SLOW_MINUTES, DEFAULT_SLEEP_MINUTES };
