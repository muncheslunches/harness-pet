// A pet's menu (opened by right-clicking it in Studio's "On your screen" list).
// Items: { label, click, type: normal|checkbox|radio|separator|header|slider, checked,
//          enabled, submenu, accelerator, min, max, step, value, format, onSlide }

const Catalog = require('../shared/catalog.js');
const Sounds = require('../shared/sounds.js');
const Harnesses = require('../shared/harnesses.js');
const Controls = require('../shared/pet-controls.js');

const KIND_LABEL = { status: 'Agent status', reaction: 'Reactions', rest: 'Rest', trick: 'Idle tricks', movement: 'Movement' };
const sep = { type: 'separator' };
// what the two buttons under a pet are called before it follows an agent
const DEFAULT_BUTTONS = [{ label: 'New chat', icon: 'compose' }, { label: 'New code session', icon: 'code' }];
const header = (label) => ({ type: 'header', label });

function build(uid, { prefs, links, host, openStudio, quit }) {
  const inst = prefs.instances.find((i) => i.uid === uid);
  const m = host.manifestOf(uid);
  const link = host.linkOf(uid);
  const agentName = (id) => (links.links[id] && links.links[id].name) || (Harnesses.BY_ID[id] && Harnesses.BY_ID[id].name) || id;
  const sessions = host.sessionsFor(uid);
  const set = (patch) => host.setInstance(uid, patch);
  const setB = (patch) => set({ behavior: patch });
  const hk = prefs.hotkeysEnabled ? prefs.hotkeys : {};
  const disabled = inst.disabledUntil === -1 || inst.disabledUntil > Date.now();

  const check = (label, value, onChange, extra = {}) => ({ label, type: 'checkbox', checked: !!value, click: (i) => onChange(i.checked), ...extra });
  const radio = (label, on, click) => ({ label, type: 'radio', checked: !!on, click });

  // ---- animations ----
  const animations = [];
  if (!m) animations.push({ label: 'Loading…', enabled: false });
  else {
    for (const kind of Catalog.KINDS) {
      const keys = Object.keys(m.animations).filter((k) => m.animations[k].kind === kind && k !== 'idle');
      if (!keys.length) continue;
      animations.push(header(KIND_LABEL[kind]));
      for (const k of keys) {
        animations.push(check(m.animations[k].label + (m.animations[k].standard ? '' : '  ✦'), Controls.animationEnabled(inst, m, k), (on) => set({ animOff: { ...inst.animOff, [k]: !on } })));
      }
    }
    if (m.missing.length) {
      animations.push(sep, {
        label: `Missing (${m.missing.length})`,
        submenu: [
          { label: 'Copy install prompt for all of them', click: () => host.copyMissingPrompt(uid, m.missing) },
          sep,
          ...m.missing.map((k) => ({ label: `Include "${Catalog.BY_KEY[k].label}"`, sublabel: 'copies a prompt', click: () => host.copyMissingPrompt(uid, [k]) })),
        ],
      });
    }
    animations.push(sep, { label: 'Play one now', submenu: Object.keys(m.animations).map((k) => ({ label: m.animations[k].label, click: () => host.play(uid, k) })) });
  }

  // ---- behaviour ----
  const b = inst.behavior;
  const behavior = [
    check('Wander around', b.wander, (on) => setB({ wander: on })),
    check('Anchor to its bar (short leash)', b.anchored, (on) => setB({ anchored: on })),
    header('Stay on'),
    radio('This screen', b.containment === 'screen', () => setB({ containment: 'screen' })),
    radio('Any screen', b.containment === 'all', () => setB({ containment: 'all' })),
    radio('The taskbar (walks along it)', b.containment === 'taskbar', () => setB({ containment: 'taskbar' })),
    sep,
    check('Fall when dropped', b.fallWhenDropped, (on) => setB({ fallWhenDropped: on })),
    check('Shy (runs from the cursor)', b.avoidCursor, (on) => setB({ avoidCursor: on })),
    check('Dodge my typing (steps off text)', b.avoidText, (on) => setB({ avoidText: on })),
    check('Clingy (follows the cursor)', b.followCursor, (on) => setB({ followCursor: on })),
    { label: 'Cursor following', submenu: [
      radio('Sideways', b.cursorFollowMode !== 'all', () => setB({ cursorFollowMode: 'sideways' })),
      radio('All directions', b.cursorFollowMode === 'all', () => setB({ cursorFollowMode: 'all' })),
    ] },
    check('Eyes follow the cursor', b.trackCursor, (on) => setB({ trackCursor: on })),
    check('Nap when idle', b.nap, (on) => setB({ nap: on })),
    check('Play with other pets', b.social, (on) => setB({ social: on })),
    check('Pass through other pets', b.passThroughPets, (on) => setB({ passThroughPets: on })),
    { label: 'Idle tricks', submenu: [['off', 'Off'], ['rare', 'Rare'], ['normal', 'Normal'], ['often', 'Often']].map(([v, l]) => radio(l, b.tricks === v, () => setB({ tricks: v }))) },
    { type: 'slider', label: 'Speed', min: 0.4, max: 3, step: 0.1, value: b.speed, format: 'x', onSlide: (v) => setB({ speed: v }) },
    check('Calm mode (no tricks or movement)', b.calm, (on) => setB({ calm: on })),
  ];

  // ---- sounds ----
  const sounds = [
    check('Mute this pet', inst.sound.muted, (on) => set({ sound: { ...inst.sound, muted: on } }), { accelerator: hk.mute }),
    { type: 'slider', label: 'Volume', min: 0, max: 100, step: 5, value: Math.round(inst.sound.volume * 100), format: '%', onSlide: (v) => set({ sound: { ...inst.sound, volume: v / 100 } }) },
    sep,
    { label: 'Choose sounds per animation…', click: () => openStudio('sounds') },
  ];
  if (m) {
    const heard = Object.keys(m.animations).filter((k) => soundFor(inst, m, k).sound);
    if (heard.length) {
      sounds.splice(2, 0, sep, header('Quick toggles'), ...heard.slice(0, 14).map((k) => {
        const s = soundFor(inst, m, k);
        return check(`${m.animations[k].label} · ${soundLabel(m, s.sound)}`, s.on, (on) => set({ sound: { ...inst.sound, anims: { ...inst.sound.anims, [k]: { ...inst.sound.anims[k], on } } } }));
      }));
    }
  }

  const btns = (link && link.buttons) || [];
  const pick = (n, i) => { const next = [...inst.buttons]; next[n] = i; set({ buttons: next }); host.broadcastLinks(); };
  const slot = (n) => [
    ...(btns.length ? btns : DEFAULT_BUTTONS).map((x, i) => radio(x.label, inst.buttons[n] === i, () => pick(n, i))),
    sep,
    radio('Off', inst.buttons[n] === null, () => pick(n, null)),
  ];

  return [
    header(Controls.petName(inst, m) + `  ·  ${!inst.harness ? 'no agent yet' : inst.harness === 'any' ? 'follows any agent' : 'follows ' + agentName(inst.harness)}`),
    { label: `Jump to ${link ? link.app || link.name : 'agent'}`, click: () => host.jumpTo(uid), accelerator: hk.jump },
    {
      label: 'Sessions',
      submenu: sessions.length
        ? sessions.slice(0, 10).map((s) => ({ label: s.title || s.project || 'Session', sublabel: [s.model, s.state === 'done' ? 'done' : s.effective].filter(Boolean).join(' · '), click: () => host.jumpTo(uid, s.sessionId) }))
        : [{ label: 'No sessions yet', enabled: false }],
    },
    ...btns.map((x, i) => ({ label: x.label, click: () => host.pressLinkButton(uid, i), accelerator: inst.buttons[0] === i ? hk.button1 : inst.buttons[1] === i ? hk.button2 : undefined })),
    sep,
    inst.sitting
      ? { label: 'Stand up', click: () => set({ sitting: false }), accelerator: 'S' }
      : { label: 'Put to sit', sublabel: 'until you click or move it', click: () => set({ sitting: true, asleep: false }), accelerator: 'S' },
    inst.asleep
      ? { label: 'Wake up', click: () => set({ asleep: false }), accelerator: 'Z' }
      : { label: 'Put to sleep', sublabel: 'until you click or move it', click: () => set({ asleep: true, sitting: false }), accelerator: 'Z' },
    disabled
      ? { label: 'Turn back on', click: () => set({ disabledUntil: 0 }) }
      : {
        label: 'Disable',
        sublabel: 'no reactions, movement or sounds',
        submenu: [
          { label: 'For 30 minutes', click: () => set({ disabledUntil: Date.now() + 30 * 60e3 }) },
          { label: 'For 1 hour', click: () => set({ disabledUntil: Date.now() + 60 * 60e3 }) },
          { label: 'For 4 hours', click: () => set({ disabledUntil: Date.now() + 4 * 60 * 60e3 }) },
          { label: 'Until I turn it back on', click: () => set({ disabledUntil: -1 }) },
        ],
      },
    sep,
    { label: 'Animations', submenu: animations },
    { label: 'Behavior', submenu: behavior },
    {
      label: `Size (${Math.round(inst.size * 100)}%)`,
      submenu: [
        { type: 'slider', label: 'Size', min: 25, max: 400, step: 5, value: Math.round(inst.size * 100), format: '%', onSlide: (v) => host.sizeStep(uid, v / 100 - inst.size) },
        { label: 'Reset to 100%', click: () => host.sizeStep(uid, 1 - inst.size) },
        { label: 'Tip: Ctrl + mouse wheel over the pet', enabled: false },
      ],
    },
    {
      label: 'Speech bubble',
      submenu: [
        { ...radio('Shown', Controls.bubbleMode(inst) === 'expanded', () => set({ barMode: 'expanded' })), enabled: Controls.hasButtons(inst) },
        radio('Minimized (bell)', Controls.bubbleMode(inst) === 'mini', () => set({ barMode: 'mini' })),
        radio('Off', Controls.bubbleMode(inst) === 'off', () => set({ barMode: 'off' })),
        sep,
        { label: 'Put it back in its default spot', enabled: !!inst.bubble, click: () => set({ bubble: null }) },
        { label: 'Tip: drag the bubble to move it', enabled: false },
      ],
    },
    { label: 'Sounds', submenu: sounds },
    {
      label: 'Follows',
      submenu: [
        ...[...new Set([...Harnesses.HARNESSES.map((x) => x.id), ...Object.keys(links.links || {})])].map((id) => radio(agentName(id), inst.harness === id, () => set({ harness: id }))),
        radio('Any agent', inst.harness === 'any', () => set({ harness: 'any' })),
        radio('No agent', !inst.harness, () => set({ harness: null })),
        sep,
        { label: 'Connect another agent…', click: () => openStudio('agents') },
      ],
    },
    { label: 'Buttons', submenu: [{ label: 'First button', submenu: slot(0) }, { label: 'Second button', submenu: slot(1) }] },
    {
      label: 'Window',
      submenu: [
        check('Always on top', inst.onTop !== false, (on) => set({ onTop: on })),
        check('Click-through (ignore the mouse)', inst.clickThrough, (on) => set({ clickThrough: on }), { sublabel: 'undo from the tray or Studio' }),
        sep,
        { label: 'Bring it back on screen', click: () => host.home(uid) },
      ],
    },
    sep,
    { label: 'Hotkeys…', click: () => openStudio('hotkeys') },
    { label: 'Open Harness Pet Studio…', click: () => openStudio('pets'), accelerator: hk.studio },
    { label: 'Hide this pet', click: () => set({ visible: false }), accelerator: hk.togglePets },
    { label: 'Refresh this pet', sublabel: 'reloads the pet and resets mouse input · Ctrl + double-click', click: () => host.refreshPet(uid) },
    ...(inst.isCage ? [] : [{ label: 'Dismiss (remove from screen)', click: () => host.removeInstance(uid) }]),
    sep,
    { label: 'Quit Harness Pet', click: quit },
  ];
}

// Effective sound for an animation: the user's choice, else the pet's, else the catalog default.
function soundFor(inst, m, key) {
  const user = (inst.sound.anims || {})[key] || {};
  const petSound = m.animations[key] && m.animations[key].sound;
  const sound = user.sound !== undefined ? user.sound : petSound || Sounds.DEFAULTS[key] || '';
  const on = user.on !== undefined ? user.on : Sounds.ON_BY_DEFAULT.includes(key) || !!petSound;
  const custom = inst.sound.custom?.[sound] || {};
  return { sound, on: on && custom.on !== false, volume: (user.volume !== undefined ? user.volume : 1) * (custom.volume ?? 1) };
}

function soundLabel(m, name) {
  return (m.sounds && m.sounds[name] && m.sounds[name].label) || (Sounds.SOUNDS[name] && Sounds.SOUNDS[name].label) || name;
}

module.exports = { build, soundFor, DEFAULT_BUTTONS };
