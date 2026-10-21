// Spots the commands you type with Caps Lock on ("GO AWAY", "GET OUT", "MOVE").
// Pure logic: the native key watcher feeds it one event per key press, and only
// while Caps Lock is on. Nothing is kept beyond a short rolling buffer of capital
// letters, and the buffer is thrown away on anything that is not a letter or space.

const PHRASES = ['GO AWAY', 'GET OUT', 'MOVE'];
const SETTLE_MS = 700; // a phrase counts once no further letter follows it
const BUFFER = 16;

const VK = { BACK: 0x08, SPACE: 0x20, A: 0x41, Z: 0x5a };
const MODIFIER_KEYS = new Set([0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);

// event: { vk, shift, ctrl, alt, win, caps }
function createPhraseMatcher({ phrases = PHRASES, settleMs = SETTLE_MS, onMatch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let buffer = '';
  let timer = null;

  const cancel = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const reset = () => {
    cancel();
    buffer = '';
  };
  // the phrase the buffer ends with, as a whole word
  const endsWithPhrase = () => phrases.find((p) => buffer.endsWith(p) && (buffer.length === p.length || buffer[buffer.length - p.length - 1] === ' '));
  const fire = (phrase) => {
    reset();
    if (onMatch) onMatch(phrase);
  };

  const arm = () => {
    const hit = endsWithPhrase();
    if (hit) timer = setTimer(() => fire(hit), settleMs);
  };

  function key(e) {
    cancel(); // any further key keeps the phrase from firing early
    if (MODIFIER_KEYS.has(e.vk)) return; // pressing Shift or Caps Lock itself is not typing
    if (!e.caps || e.ctrl || e.alt || e.win) return reset();
    // Caps Lock with Shift held types lowercase, which is not a shout
    if (e.shift) return reset();
    if (e.vk >= VK.A && e.vk <= VK.Z) {
      buffer = (buffer + String.fromCharCode(e.vk)).slice(-BUFFER);
      return arm();
    }
    if (e.vk === VK.BACK) {
      buffer = buffer.slice(0, -1);
      return arm();
    }
    // a space, Enter or punctuation ends the word: a finished phrase fires now
    const hit = endsWithPhrase();
    if (hit) return fire(hit);
    if (e.vk === VK.SPACE) buffer = (buffer + ' ').slice(-BUFFER);
    else reset();
  }

  return { key, reset };
}

module.exports = { createPhraseMatcher, PHRASES, SETTLE_MS };
