// System-wide hotkeys (Electron globalShortcut). Each action can be rebound in
// Studio → Hotkeys; a combo that another app already owns is reported back.

const { globalShortcut } = require('electron');

const ACTIONS = {
  togglePets: 'Show / hide all pets',
  jump: 'Jump to the agent your pet is showing',
  button1: "Press the pet's first button",
  button2: "Press the pet's second button",
  studio: 'Open Harness Pet Studio',
  mute: 'Mute / unmute all pets',
  sleepAll: 'Put all pets to sleep / wake them',
};

let status = {}; // action → 'ok' | 'taken' | 'invalid' | 'off'

function apply(prefs, handlers) {
  globalShortcut.unregisterAll();
  status = {};
  for (const action of Object.keys(ACTIONS)) {
    const combo = prefs.hotkeys[action];
    if (!prefs.hotkeysEnabled || prefs.hotkeysDisabled?.[action] || !combo) {
      status[action] = 'off';
      continue;
    }
    try {
      status[action] = globalShortcut.register(combo, () => handlers[action] && handlers[action]()) ? 'ok' : 'taken';
    } catch {
      status[action] = 'invalid';
    }
  }
  return status;
}

// While the Studio records a new combo, existing ones must not fire.
function suspend() {
  globalShortcut.unregisterAll();
}

module.exports = { ACTIONS, apply, suspend, status: () => status };
