// Harness Pet Studio: manage pets on screen, preview and test animations,
// tune behaviour, generate prompts for coding agents, and connect agents.

const S = window.studio;
window.addEventListener('unhandledrejection', e => {
  e.preventDefault();
  toast('Action failed: ' + String(e.reason?.message || 'Check settings permissions and try again.').slice(0, 300));
});
const Cat = PetCatalog;
const KIND_LABEL = { status: 'Agent status', reaction: 'Reactions', rest: 'Rest', trick: 'Idle tricks', movement: 'Movement' };

let state = null;
let selected = new URLSearchParams(location.search).get('pet') || null; // uid of the pet on screen being edited
let tab = new URLSearchParams(location.search).get('tab') || 'pets';
const codeCache = new Map();

// ---------- tiny DOM helper ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the page's CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const page = (name) => document.querySelector(`section[data-page="${name}"]`);

let toastTimer = null;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

async function copy(text, message) {
  await S.copy(text);
  toast(message || 'Copied');
}

// ---------- previews ----------

const players = new Set(); // { player, key, start, dir, x, stageW, moving }
// fit: the share of the box the pet may fill; still: draw one frame, then leave it
function preview(host, code, { key = 'idle', size = 1, fit = [0.7, 0.8], still = false } = {}) {
  const p = new PetPlayer(host);
  const entry = { player: p, key, start: performance.now(), dir: 1, x: 0, size, manifest: null, still };
  players.add(entry);
  p.onFailure = (err) => { entry.manifest = null; if (!still) host.append(h('div', { class: 'muted small', role: 'alert' }, err.message)); };
  p.onMove = (m) => {
    // movement previews slide around inside the box and bounce off its edges
    const w = host.clientWidth;
    const pw = p.displaySize.w;
    entry.x += (m.vx * 0.016) / 2;
    const lim = Math.max(0, (w - pw) / 2 - 6);
    if (Math.abs(entry.x) > lim) {
      entry.x = Math.sign(entry.x) * lim;
      entry.dir = -entry.dir;
    }
    if (p.canvas) p.canvas.style.transform = `translateX(${entry.x}px)`;
  };
  entry.ready = p.load(code).then(({ manifest }) => {
    entry.manifest = manifest;
    const maxW = host.clientWidth * fit[0];
    const maxH = host.clientHeight * fit[1];
    const natural = { w: manifest.canvas.width * manifest.scale, h: manifest.canvas.height * manifest.scale };
    p.resize(Math.min(size, maxW / natural.w, maxH / natural.h));
    return manifest;
  });
  entry.ready.catch((err) => {
    if (err.name === 'AbortError' || still) return;
    host.append(h('div', { class: 'muted small' }, 'Failed to load: ' + err.message));
  });
  return entry;
}

function stopPreviews(within) {
  for (const e of [...players]) {
    if (!within || within.contains(e.player.host)) {
      e.player.destroy();
      players.delete(e);
    }
  }
}

let lastFrame = 0;
function loop(t) {
  requestAnimationFrame(loop);
  if (t - lastFrame < 30) return;
  lastFrame = t;
  for (const e of players) {
    if (!e.manifest || e.drawn) continue;
    if (e.still) e.drawn = true;
    const a = e.manifest.animations[e.key] ? e.key : 'idle';
    const info = e.manifest.animations[a];
    const params = {};
    for (const [k, p] of Object.entries(info.params)) params[k] = p.default;
    Object.assign(params, e.params || {});
    const dur = info.duration || (Cat.BY_KEY[a] && Cat.BY_KEY[a].duration) || 0;
    let elapsed = t - e.start;
    if (dur && !info.loop && elapsed > dur + 600) {
      e.start = t; // loop one-shots in previews with a short pause
      elapsed = 0;
      if (info.kind === 'movement') e.dir = -e.dir;
    }
    const curInst = instance();
    e.player.draw({
      anim: a, t: elapsed, dt: 33, params, look: e.look || { x: 0, y: 0 }, dir: e.dir, speed: 1, size: 1,
      state: { title: 'Preview', detail: 'Testing' }, other: { dir: -e.dir, distance: 60 }, blocked: {}, home: { dx: 0, dy: 0 },
      seed: 7, wantMove: info.moves,
      fallWhenDropped: !!(curInst && curInst.behavior && curInst.behavior.fallWhenDropped),
      behavior: curInst ? curInst.behavior : null,
    });
  }
}
requestAnimationFrame(loop);

async function codeOf(ref) {
  if (!codeCache.has(ref)) codeCache.set(ref, await S.petCode(ref));
  return codeCache.get(ref);
}

// ---------- state ----------

const instance = () => state.instances.find((i) => i.uid === selected);
const petLabel = (inst) => inst?.isCage ? 'Cage' : PetControls.petName(inst, state.manifests[inst.uid]);
const harnessOf = (id) => state.harnesses.find((x) => x.id === id);
const linkName = (id) => (!id ? 'no agent yet' : id === 'any' ? 'any agent' : (state.links.links[id] && state.links.links[id].name) || (harnessOf(id) && harnessOf(id).name) || id);
// every agent a pet can follow: the known harnesses plus any extra links an agent set up
const agentIds = () => [...new Set([...state.harnesses.map((x) => x.id), ...Object.keys(state.links.links)])];
// what the two buttons under a pet are called before it follows an agent
const DEFAULT_BUTTONS = [{ label: 'New chat' }, { label: 'New code session' }];

async function refresh(full) {
  state = await S.state();
  document.getElementById('app-version').textContent = `v${state.version}`;
  if (!state.instances.find((i) => i.uid === selected)) selected = state.instances[0] && state.instances[0].uid;
  renderSide();
  renderTab(full);
}

function setInstance(patch) {
  return S.setInstance(selected, patch);
}

// ---------- sidebar ----------

// A still of each pet on screen, kept across re-renders so the list doesn't
// start a new pet worker every time it redraws.
const icons = new Map(); // uid → { pet, host, entry }
function dropIcon(uid) {
  const icon = icons.get(uid);
  if (icon?.entry) { icon.entry.player.destroy(); players.delete(icon.entry); }
  icons.delete(uid);
}
function iconOf(inst) {
  const had = icons.get(inst.uid);
  if (had && had.pet === inst.pet) return had.host;
  dropIcon(inst.uid);
  const icon = { pet: inst.pet, host: h('span', { class: 'inst-icon' }), entry: null };
  icons.set(inst.uid, icon);
  codeOf(inst.pet).then((code) => {
    if (icons.get(inst.uid) === icon) icon.entry = preview(icon.host, code, { size: 8, fit: [0.92, 0.92], still: true });
  }).catch(() => {});
  return icon.host;
}

function renderSide() {
  const side = document.getElementById('side');
  const scrollTop = side.scrollTop;
  const atBottom = side.scrollHeight - side.clientHeight - scrollTop < 4;
  const box = document.getElementById('onscreen');
  box.textContent = '';
  for (const uid of [...icons.keys()]) if (!state.instances.some((i) => i.uid === uid)) dropIcon(uid);
  for (const inst of state.instances) {
    const isCage = !!inst.isCage;
    const rowChildren = [
      h('button', {
        class: 'inst' + (inst.uid === selected ? ' on' : ''),
        title: isCage ? 'The Cage' : "Right-click for this pet's menu",
        onclick: () => { selected = inst.uid; renderSide(); renderTab(true); },
        oncontextmenu: (e) => {
          e.preventDefault();
          if (selected !== inst.uid) { selected = inst.uid; renderSide(); renderTab(true); }
          S.menu(inst.uid);
        },
      },
        h('span', { class: 'inst-pic', 'aria-hidden': 'true' }, iconOf(inst), h('span', { class: 'dot' + (inst.visible !== false ? ' live' : '') })),
        h('span', { class: 'inst-text' }, petLabel(inst), h('small', {}, isCage ? '...cage... · secure' : `${inst.harness ? 'follows ' : ''}${linkName(inst.harness)}${inst.caged ? ' · caged' : ''}${inst.experimentalDuplicate ? ' · duplicate' : ''}${inst.visible === false ? ' · hidden' : ''}`))),
    ];
    if (!isCage) {
      rowChildren.push(
        h('button', {
          class: 'dismiss',
          title: 'Take this pet off the screen',
          onclick: (e) => {
            e.currentTarget.disabled = true;
            S.removeInstance(inst.uid);
            toast(`${petLabel(inst)} vanished in a puff of smoke`);
          },
        }, 'Dismiss')
      );
    }
    box.append(h('div', { class: 'inst-row' }, ...rowChildren));
  }
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('on', b.dataset.tab === tab);
  document.getElementById('duplicate-pet').disabled = !instance() || !!instance()?.isCage;
  document.getElementById('dismiss-duplicates').disabled = !state.instances.some((i) => i.experimentalDuplicate);

  const curIdx = state.instances.findIndex((i) => i.uid === selected);
  const isCageSel = selected && state.instances[curIdx]?.isCage;
  const minSortIdx = state.cageEnabled ? 1 : 0;
  const upBtn = document.getElementById('move-pet-up');
  const downBtn = document.getElementById('move-pet-down');
  if (upBtn) upBtn.disabled = curIdx === -1 || isCageSel || curIdx <= minSortIdx;
  if (downBtn) downBtn.disabled = curIdx === -1 || isCageSel || curIdx >= state.instances.length - 1;

  const toggleCage = document.getElementById('toggle-cage');
  if (toggleCage) toggleCage.checked = !!state.cageEnabled;

  side.scrollTop = atBottom ? side.scrollHeight : scrollTop;
}

document.getElementById('move-pet-up')?.addEventListener('click', async () => {
  if (!selected) return;
  await S.moveInstance(selected, -1);
  await refresh(true);
});
document.getElementById('move-pet-down')?.addEventListener('click', async () => {
  if (!selected) return;
  await S.moveInstance(selected, 1);
  await refresh(true);
});
document.getElementById('toggle-cage')?.addEventListener('change', async (e) => {
  const on = e.target.checked;
  await S.setCageEnabled(on);
  if (on) toast('Cage enabled — drop pets inside; shake the cage to free them');
  else toast('Cage disabled — pets released');
  await refresh(true);
});

document.getElementById('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) show(b.dataset.tab);
});
document.getElementById('add-pet').addEventListener('click', () => {
  show('pets');
  toast('Pick a pet and press "Put on screen"');
});
document.getElementById('duplicate-pet').addEventListener('click', async () => {
  if (!selected) return;
  const uid = await S.duplicateInstance(selected);
  if (uid) toast('Added a duplicate of the selected pet');
  await refresh(true);
  const side = document.getElementById('side');
  side.scrollTop = side.scrollHeight;
});
document.getElementById('dismiss-duplicates').addEventListener('click', async () => {
  const count = await S.removeDuplicates();
  toast(`Dismissed ${count} duplicate${count === 1 ? '' : 's'}`);
  await refresh(true);
});

function show(name) {
  tab = name;
  renderSide();
  renderTab(true);
}

const RENDER = {};
let lastSig = '';
const pageScroll = new Map();
let renderedTab = null;
let renderVersion = 0;
let cleanupTab = null;
function renderTab(full) {
  const main = document.getElementById('main');
  const scrollTop = renderedTab === tab ? main.scrollTop : pageScroll.get(tab) || 0;
  if (renderedTab && renderedTab !== tab) pageScroll.set(renderedTab, main.scrollTop);
  for (const s of document.querySelectorAll('section[data-page]')) s.classList.toggle('on', s.dataset.page === tab);
  // pages with live previews or text inputs only re-render when something they show changed
  const inst = instance();
  const sig = JSON.stringify([tab, selected, inst, state.manifests[selected], tab === 'pets' ? [state.pets, state.instances.map((i) => [i.uid, i.pet, i.visible])] : null, tab === 'agents' ? [state.links, state.claude, state.instances.map((i) => [i.uid, i.pet, i.harness])] : null]);
  if (!full && sig === lastSig) return;
  if (!full && tab === 'create') return;
  lastSig = sig;
  if (cleanupTab) { cleanupTab(); cleanupTab = null; }
  renderedTab = tab;
  const version = ++renderVersion;
  const root = page(tab);
  root.renderVersion = version;
  // Keep the scroll range while async previews rebuild, then restore this page's position.
  root.style.minHeight = `${scrollTop + main.clientHeight}px`;
  stopPreviews(page(tab));
  root.textContent = '';
  if (state.recovery?.length) root.append(h('p', { role: 'alert', class: 'lede' }, 'Some settings could not be loaded or saved. Your original files are preserved. See README > Settings recovery.'));
  main.scrollTop = scrollTop;
  Promise.resolve(RENDER[tab](root)).then(() => {
    if (version !== renderVersion) return;
    root.style.minHeight = '';
    main.scrollTop = scrollTop;
    requestAnimationFrame(() => { if (version === renderVersion) main.scrollTop = scrollTop; });
  }).catch((err) => { root.style.minHeight = ''; console.error(err); });
}

// ---------- General settings ----------

RENDER.general = (root) => {
  const g = state.general;
  const row = (t, d, control, wide) => h('div', { class: 'setting' + (wide ? ' wide' : '') }, h('div', {}, h('div', { class: 't' }, t), h('div', { class: 'd' }, d)), control);
  const sw = (key, on, extra = {}) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!on, disabled: extra.disabled, 'aria-label': extra.label,
    onchange: (e) => S.setGeneral(key, e.target.checked).then(() => extra.done?.(e.target.checked)) }), h('span'));
  const tip = (text) => h('span', { class: 'tip', tabindex: 0, role: 'note', 'aria-label': text, 'data-tip': text }, 'i');
  root.append(
    h('h1', {}, 'General settings'),
    h('p', { class: 'lede' }, 'Settings for Harness Pet as a whole. What each pet does on its own is under My pets.'),
    h('div', { class: 'kind-head' }, 'Pets'),
    h('div', { class: 'settings' },
      row('Mute all pets', 'Silences every pet at once. Each pet keeps its own volume and sound choices for when you turn this off.', sw('muteAll', g.muteAll, { label: 'Mute all pets' })),
      row('No dancing', 'Pets never dance, alone or together.', sw('noDance', g.noDance, { label: 'No dancing' })),
    ),
    h('div', { class: 'kind-head' }, 'Typing'),
    h('div', { class: 'settings' },
      row(h('span', {}, 'Watch typing ', tip('Notices that you are typing (never what) and briefly scans the screen in memory for text. A pet standing on text you type over steps aside. With Caps Lock on, typing GO AWAY, GET OUT or MOVE sends pets off text for a while. Nothing is saved or sent anywhere.')),
        g.keyboardSupported ? 'Pets step off text you type over. Each pet can opt out with Dodge my typing.' : 'Available on Windows only.',
        sw('watchKeyboard', g.watchKeyboard, { label: 'Watch typing', disabled: !g.keyboardSupported })),
    ),
    h('div', { class: 'kind-head' }, 'App'),
    h('div', { class: 'settings' },
      row('Start with Windows', 'Opens Harness Pet (and your pets) when you sign in.', sw('startAtLogin', g.startAtLogin, { label: 'Start with Windows' })),
      row('Hotkeys', 'System-wide shortcuts, on or off and which keys.', h('button', { class: 'btn small', onclick: () => show('hotkeys') }, 'Hotkeys…')),
      row('Verbose logging', 'Writes extra detail to app.log: pets appearing, hiding and recovering, mouse input, and memory use every minute. Turn it on when a pet goes missing, then share the log in a bug report.',
        h('div', { style: 'display:flex;gap:6px;align-items:center' },
          h('button', { class: 'btn small', onclick: () => S.openPath(state.paths.data) }, 'Open log folder'),
          sw('verboseLogging', g.verboseLogging, { label: 'Verbose logging', done: (on) => toast(on ? 'Verbose logging on' : 'Verbose logging off') })), true),
    ),
  );
};

// ---------- My pets ----------

RENDER.pets = (root) => {
  root.append(
    h('div', { class: 'row-head' },
      h('div', {}, h('h1', {}, 'My pets'), h('p', { class: 'lede' }, 'Every pet in your library. Put several on screen at once — each can follow a different coding agent. Pets your agent creates in the pets folder show up here automatically.')),
    ),
    h('div', { class: 'row-head' },
      h('button', { class: 'btn primary', onclick: () => show('create') }, '✦ Create a new pet'),
      h('button', { class: 'btn', onclick: async () => { const refs = await S.importPets(); if (refs.length) toast(`Imported ${refs.length} pet${refs.length > 1 ? 's' : ''}`); } }, 'Import…'),
      h('button', { class: 'btn', onclick: () => S.openPath(state.paths.pets) }, 'Open pets folder'),
    )
  );
  const grid = h('div', { class: 'grid' });
  root.append(grid);
  for (const pet of state.pets) {
    const stage = h('div', { class: 'pet-stage' });
    const meta = h('div', { class: 'meta' }, 'Loading…');
    const name = h('div', { class: 'name' }, pet.ref.replace(/^builtin:/, ''));
    const mine = state.instances.filter((i) => i.pet === pet.ref);
    const shown = mine.filter((i) => i.visible !== false);
    const card = h('div', { class: 'card pet-card' },
      stage,
      h('div', {}, name, meta),
      h('div', { class: 'actions' },
        shown.length
          ? h('button', {
            class: 'btn small dismiss-btn',
            onclick: (e) => {
              e.currentTarget.disabled = true;
              for (const i of shown) S.removeInstance(i.uid);
              toast(`${name.textContent} vanished in a puff of smoke`);
            },
          }, 'Dismiss')
          : h('button', {
            class: 'btn primary small',
            onclick: async () => {
              // a hidden copy comes back; otherwise a new one joins the screen
              if (mine.length) {
                selected = mine[0].uid;
                await S.setInstance(mine[0].uid, { visible: true });
                return toast('Welcome back!');
              }
              selected = await S.addInstance(pet.ref);
              toast('Say hi to your new pet!');
            },
          }, 'Put on screen'),
        selected && h('button', { class: 'btn small', onclick: () => setInstance({ pet: pet.ref }).then(() => toast('Swapped')) }, 'Use for selected'),
        h('button', { class: 'btn small', onclick: async () => { const p = await S.exportPet(pet.ref); if (p) toast('Exported to ' + p); } }, 'Export'),
        !pet.builtIn && h('button', { class: 'btn small danger', onclick: async () => { if (confirm('Delete this pet file?')) { await S.deletePet(pet.ref); toast('Deleted'); } } }, 'Delete'),
      )
    );
    grid.append(card);
    codeOf(pet.ref).then((code) => {
      preview(stage, code).ready.then((m) => {
        name.textContent = m.name;
        const std = Cat.CATALOG.filter((c) => m.animations[c.key]).length;
        meta.textContent = `${std}/${Cat.CATALOG.length} standard · ${m.custom.length} custom${pet.builtIn ? ' · built-in' : ''}${shown.length ? ` · ${shown.length} on screen` : mine.length ? ' · hidden' : ''}`;
      }).catch(() => (meta.textContent = 'Not a valid pet'));
    });
  }
};

// ---------- Animations ----------

RENDER.animations = async (root) => {
  const version = root.renderVersion;
  const inst = instance();
  if (!inst) return root.append(h('div', { class: 'empty' }, 'No pet on screen. Add one from My pets.'));
  const code = await codeOf(inst.pet).catch(() => null);
  if (root.renderVersion !== version || tab !== 'animations') return;
  if (!code) return root.append(h('div', { class: 'empty' }, 'This pet file could not be read.'));

  const stage = h('div', { class: 'pet-stage' });
  const now = h('div', { class: 'now' }, 'Playing: idle');
  let alsoDesktop = false;
  const entry = preview(stage, code, { size: 1.6 });
  const m = await entry.ready.catch(() => null);
  if (root.renderVersion !== version || tab !== 'animations') { entry.player.destroy(); players.delete(entry); return; }
  if (!m) return;

  function play(key) {
    entry.key = key;
    entry.start = performance.now();
    entry.x = 0;
    entry.params = (inst.params || {})[key];
    if (entry.player.canvas) entry.player.canvas.style.transform = '';
    now.textContent = 'Playing: ' + m.animations[key].label;
    if (alsoDesktop) S.play(selected, key);
  }

  const missing = Cat.CATALOG.filter((c) => !m.animations[c.key]);
  root.append(
    h('div', { class: 'row-head' },
      h('div', {}, h('h1', {}, `${petLabel(inst)}'s animations`), h('p', { class: 'lede' }, 'Preview any animation, choose which ones play on your desktop, and tune custom ones. Missing animations can be added by your coding agent — press "Include this" to copy a ready-made prompt.')),
    ),
    h('div', { class: 'anim-layout' },
      h('div', { class: 'preview' },
        stage,
        h('div', { class: 'controls' },
          now,
        ),
        h('div', { class: 'controls' },
          h('div', { class: 'seg' }, ...['checker', 'dark', 'light'].map((bg, i) => h('button', { class: i === 0 ? 'on' : '', onclick: (e) => {
            stage.className = 'pet-stage' + (bg === 'checker' ? '' : ' ' + bg);
            for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target);
          } }, bg))),
          h('label', { class: 'param' }, h('input', { type: 'checkbox', onchange: (e) => (alsoDesktop = e.target.checked) }), 'Also play on the desktop'),
          h('button', { class: 'btn small', onclick: () => { entry.dir = -entry.dir; } }, '⇄ Face the other way'),
        ),
        missing.length ? h('button', { class: 'btn', onclick: async () => copy(await S.prompt('missing', { ref: inst.pet, manifest: m, keys: missing.map((c) => c.key) }), 'Prompt copied — paste it into your coding agent') }, `Copy prompt to add all ${missing.length} missing`) : h('div', { class: 'badge ok' }, '✓ Has every standard animation'),
      ),
      h('div', {}, ...Cat.KINDS.map((kind) => animGroup(kind, inst, m, play))),
    )
  );
  // stage stays a fixed size, so re-fit after layout
  requestAnimationFrame(() => entry.player.resize(Math.min(1.6, (stage.clientWidth * 0.6) / (m.canvas.width * m.scale), (stage.clientHeight * 0.75) / (m.canvas.height * m.scale))));
};

function animGroup(kind, inst, m, play) {
  const have = Object.keys(m.animations).filter((k) => m.animations[k].kind === kind);
  const missing = Cat.CATALOG.filter((c) => c.kind === kind && !m.animations[c.key]);
  if (!have.length && !missing.length) return null;
  const box = h('div', {}, h('div', { class: 'kind-head' }, KIND_LABEL[kind]));
  for (const k of have) {
    const a = m.animations[k];
    const on = PetControls.animationEnabled(inst, m, k);
    const row = h('div', { class: 'anim' },
      h('div', {},
        h('div', { class: 'title' }, a.label, h('code', {}, k), ' ', a.standard ? null : h('span', { class: 'badge custom' }, '✦ custom')),
        h('div', { class: 'desc' }, a.description || ''),
      ),
      h('button', { class: 'btn small', onclick: () => play(k) }, '▶ Play'),
      k === 'idle' ? h('span', { class: 'badge' }, 'always on') : h('label', { class: 'switch', title: on ? 'Plays on the desktop' : 'Switched off' },
        h('input', { type: 'checkbox', checked: on, onchange: (e) => setInstance({ animOff: { ...inst.animOff, [k]: !e.target.checked } }) }), h('span')),
    );
    const params = Object.entries(a.params);
    if (params.length) {
      const pv = (inst.params || {})[k] || {};
      row.append(h('div', { class: 'params' }, ...params.map(([pk, p]) => {
        const out = h('output', {}, String(pv[pk] ?? p.default));
        return h('label', { class: 'param' }, p.label,
          h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: pv[pk] ?? p.default, oninput: (e) => (out.textContent = e.target.value), onchange: (e) => setInstance({ params: { ...inst.params, [k]: { ...pv, [pk]: Number(e.target.value) } } }) }),
          out);
      })));
    }
    box.append(row);
  }
  for (const c of missing) {
    box.append(h('div', { class: 'anim missing' },
      h('div', {}, h('div', { class: 'title' }, c.label, h('code', {}, c.key), ' ', h('span', { class: 'badge warn' }, 'missing')), h('div', { class: 'desc' }, c.spec)),
      h('span', { class: 'muted small' }, c.fallback ? 'uses a stand-in' : 'skipped'),
      h('button', { class: 'btn small', onclick: async () => copy(await S.prompt('missing', { ref: instance().pet, manifest: m, keys: [c.key] }), 'Install prompt copied — paste it into your coding agent') }, 'Include this'),
    ));
  }
  return box;
}

// ---------- Behavior ----------

RENDER.behavior = (root) => {
  const inst = instance();
  if (!inst) return root.append(h('div', { class: 'empty' }, 'No pet on screen.'));
  const b = inst.behavior;
  const setB = (patch) => setInstance({ behavior: patch });
  const toggle = (key, t, d) => h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, t), h('div', { class: 'd' }, d)),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!b[key], onchange: (e) => setB({ [key]: e.target.checked }) }), h('span')));
  const seg = (current, options, onPick) => h('div', { class: 'seg' }, ...options.map(([v, l, disabled]) => h('button', { class: current === v ? 'on' : '', disabled: !!disabled, onclick: () => onPick(v) }, l)));
  const slider = (value, min, max, step, fmt, onSet) => {
    const out = h('output', {}, fmt(value));
    return h('label', { class: 'param' }, h('input', { type: 'range', min, max, step, value, oninput: (e) => (out.textContent = fmt(Number(e.target.value))), onchange: (e) => onSet(Number(e.target.value)) }), out);
  };
  const link = inst.harness ? state.links.links[inst.harness === 'any' ? state.links.primary : inst.harness] || null : null;
  const btnOptions = [...((link && link.buttons && link.buttons.length ? link.buttons : DEFAULT_BUTTONS).map((x, i) => h('option', { value: i }, x.label))), h('option', { value: 'off' }, 'Off')];
  const slotValue = (v) => (v === 'off' ? null : Number(v));
  const isSlot = (o, v) => (o.value === 'off' ? v === null : Number(o.value) === v);
  const row = (t, d, control) => h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, t), h('div', { class: 'd' }, d)), control);
  const group = (title, ...kids) => h('section', { class: 'settings-group' }, h('h2', { class: 'group-head' }, title), ...kids);
  const sub = (title, ...kids) => h('div', { class: 'settings-sub' }, h('h3', { class: 'sub-head' }, title), h('div', { class: 'settings' }, ...kids));
  // A setting with options that only matter while it is on: they sit inside its card and grey out while it is off.
  const parent = (head, on, why, ...kids) => {
    const inner = h('div', { class: 'nested' + (on ? '' : ' off'), title: on ? null : why }, ...kids);
    if (!on) for (const el of inner.querySelectorAll('input, button, select')) el.disabled = true;
    return h('div', { class: 'setting-parent' }, head, inner);
  };

  root.append(
    h('h1', {}, `How ${petLabel(inst)} behaves`),
    h('p', { class: 'lede' }, 'These settings belong to this pet on screen; each pet can have its own. Most are also in the pet\'s right-click menu.'),
    h('div', { class: 'settings top-row' },
      row('On screen', 'Hide this pet, or dismiss it in a puff of smoke.',
        h('div', { style: 'display:flex;gap:6px' },
          h('button', { class: 'btn small', onclick: () => setInstance({ visible: inst.visible === false }) }, inst.visible === false ? 'Show' : 'Hide'),
          h('button', { class: 'btn small dismiss-btn', onclick: () => S.removeInstance(selected) }, 'Dismiss'))),
      row('Buttons under the pet', link ? `First and second button, from ${link.name}. Turn both off to leave just a small bar.` : 'Pick an agent under Follows first. Turn both off to leave just a small bar.',
        h('div', { class: 'button-slots' },
          h('label', {}, 'First button', h('select', { 'aria-label': 'First button', onchange: (e) => setInstance({ buttons: [slotValue(e.target.value), inst.buttons[1]] }) }, ...btnOptions.map((o) => { const c = o.cloneNode(true); if (isSlot(o, inst.buttons[0])) c.selected = true; return c; }))),
          h('label', {}, 'Second button', h('select', { 'aria-label': 'Second button', onchange: (e) => setInstance({ buttons: [inst.buttons[0], slotValue(e.target.value)] }) }, ...btnOptions.map((o) => { const c = o.cloneNode(true); if (isSlot(o, inst.buttons[1])) c.selected = true; return c; }))))),
    ),
    group('Coming and going',
      parent(
        toggle('showWithAgent', 'Only show with its agent', inst.harness
          ? 'Stays off screen until the agent your pet is attached to has a window open, is working or needs you. When that window is minimized or hidden and the agent is quiet, it waits out Leaves after, then goes. Put it on screen yourself any time; it stays until its agent\'s next turn.'
          : 'Attach this pet to an agent under Follows first. It then appears only while that agent has a window open, is working or needs you.'),
        !!b.showWithAgent, 'Turn on Only show with its agent first',
        row('Leaves after', 'How long it waits once its agent is quiet and the agent\'s window is minimized or hidden.',
          slider(b.lingerMinutes, 1, 15, 1, (v) => `${v} min`, (v) => setB({ lingerMinutes: v }))),
        toggle('smokeOnLeave', 'Arrive and leave in a puff of smoke', 'Off: it simply appears and disappears.')),
    ),
    group('Agent and look',
      h('div', { class: 'settings' },
        row('Follows', 'Which coding agent\'s sessions this pet reacts to.',
          h('select', { onchange: (e) => setInstance({ harness: e.target.value || null }) },
            ...agentIds().map((id) => h('option', { value: id, selected: inst.harness === id }, linkName(id))),
            h('option', { value: 'any', selected: inst.harness === 'any' }, 'Any agent'),
            h('option', { value: '', selected: !inst.harness }, 'No agent'))),
        row('Bubble', PetControls.hasButtons(inst) ? 'Minimized keeps a small bar. Off hides the bubble and its buttons.' : 'Automatically minimized while both buttons are off. Enable a button to use Shown.',
          seg(PetControls.bubbleMode(inst), [['expanded', 'Shown', !PetControls.hasButtons(inst)], ['mini', 'Minimized'], ['off', 'Off']], (v) => setInstance({ barMode: v }))),
        row('Size', 'Or hover the pet and use Ctrl + mouse wheel. Bigger pets move a little slower.',
          slider(inst.size, 0.25, 4, 0.05, (v) => Math.round(v * 100) + '%', (v) => setInstance({ size: v }))),
      ),
    ),
    group('Moving around',
      sub('Getting around',
        toggle('wander', 'Wander around', 'Walks and plays its movement animations on its own.'),
        row('Speed', 'How fast it moves around.',
          slider(b.speed, 0.4, 3, 0.1, (v) => v.toFixed(1) + '×', (v) => setB({ speed: v }))),
        row('Stay on', 'Where the pet is allowed to roam.',
          seg(b.containment, [['screen', 'This screen'], ['all', 'Any screen'], ['taskbar', 'Taskbar']], (v) => setB({ containment: v }))),
        toggle('anchored', 'Anchor to its bar', 'Stays on a short leash around its button bar and strolls back home.'),
        toggle('fallWhenDropped', 'Fall when dropped', 'Let go mid-air and it drops to the bottom of the screen.'),
      ),
      sub('Cursor and typing',
        toggle('avoidCursor', 'Shy', 'Scurries away when the cursor gets close.'),
        toggle('trackCursor', 'Eyes follow the cursor', 'Pets that support it glance toward your mouse.'),
        parent(
          toggle('followCursor', 'Clingy', 'Walks over toward the cursor when it\'s far away.'),
          !!b.followCursor, 'Turn on Clingy first',
          row('Cursor following', 'Follow sideways or fly toward the cursor in all directions. Requires Wander around and no anchor; Taskbar keeps movement sideways.',
            seg(b.cursorFollowMode === 'all' ? 'all' : 'sideways', [['sideways', 'Sideways'], ['all', 'All directions']], (v) => setB({ cursorFollowMode: v })))),
        toggle('avoidText', 'Dodge my typing', 'Steps off text while you type over it and waits until you stop. With Caps Lock on, typing GO AWAY, GET OUT or MOVE sends every pet near text to a bare spot for 30 seconds to 5 minutes (a click calls it back).'),
      ),
    ),
    group('Personality',
      sub('When idle',
        toggle('calm', 'Calm mode', 'No tricks or movement — only reacts to your agent.'),
        row('Idle tricks', 'How often it does tricks or wanders.',
          seg(b.tricks, [['off', 'Off'], ['rare', 'Rare'], ['normal', 'Normal'], ['often', 'Often']], (v) => setB({ tricks: v }))),
        toggle('nap', 'Nap when idle', `Falls asleep after ${b.napMinutes} quiet minutes; hover to wake it.`),
      ),
      sub('Other pets',
        toggle('social', 'Play with other pets', 'Bump, shoo and greet other pets on screen.'),
        toggle('passThroughPets', 'Pass through other pets', 'Move through other pets without bumping or blocking them. You can still click and drag this pet.'),
      ),
    ),
  );
};

// ---------- Sounds ----------

let studioAudio = null;
function previewSound(recipe, volume) {
  if (!recipe) return;
  studioAudio = studioAudio || new AudioContext();
  PetSounds.play(studioAudio, recipe, volume);
}

RENDER.sounds = async (root) => {
  const inst = instance();
  if (!inst) return root.append(h('div', { class: 'empty' }, 'No pet on screen.'));
  const m = state.manifests[selected];
  if (!m) return root.append(h('div', { class: 'empty' }, 'Waiting for the pet to load…'));
  const snd = inst.sound;
  const setSound = (patch) => setInstance({ sound: { ...snd, ...patch } });
  const setAnim = (k, patch) => setSound({ anims: { ...snd.anims, [k]: { ...(snd.anims[k] || {}), ...patch } } });
  const setCustom = (k, patch) => setSound({ custom: { ...snd.custom, [k]: { ...(snd.custom?.[k] || {}), ...patch } } });
  const recipeOf = (name) => (m.sounds && m.sounds[name]) || PetSounds.SOUNDS[name];
  const effective = (k) => {
    const user = snd.anims[k] || {};
    const petSound = m.animations[k].sound;
    const name = user.sound !== undefined ? user.sound : petSound || PetSounds.DEFAULTS[k] || '';
    return { name,
      on: user.on !== undefined ? user.on : PetSounds.ON_BY_DEFAULT.includes(k) || !!petSound,
      volume: user.volume !== undefined ? user.volume : 1,
    };
  };
  const options = [['', '— none —'], ...Object.entries(m.sounds || {}).map(([k, r]) => [k, `${r.label} (${m.name})`]), ...Object.entries(PetSounds.SOUNDS).map(([k, r]) => [k, r.label])];

  const volOut = h('output', {}, Math.round(snd.volume * 100) + '%');
  root.append(
    h('h1', {}, `${petLabel(inst)}'s sounds`),
    h('p', { class: 'lede' }, 'Tiny sounds, made in code, that play with animations. Pick a sound for any animation, switch it on or off, and set its volume. Each pet has its own mix, and a pet file can bring its own sounds.'),
    h('div', { class: 'settings' },
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, 'Mute this pet'), h('div', { class: 'd' }, 'Hotkey and right-click menu can toggle this too.')),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: snd.muted, onchange: (e) => setSound({ muted: e.target.checked }) }), h('span'))),
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, 'Volume'), h('div', { class: 'd' }, 'For all of this pet\'s sounds.')),
        h('label', { class: 'param' }, h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(snd.volume * 100), oninput: (e) => (volOut.textContent = e.target.value + '%'), onchange: (e) => setSound({ volume: Number(e.target.value) / 100 }) }), volOut)),
    ),
  );
  const requests = h('textarea', { placeholder: 'Soft fairy chime, tiny bell, cheerful sparkle', 'aria-label': 'Sounds wanted, separated by commas' });
  const prompt = h('textarea', { class: 'prompt', readonly: true, 'aria-label': 'Custom sounds prompt' });
  let promptRevision = 0;
  const makePrompt = async () => {
    const revision = ++promptRevision;
    const text = await S.prompt('custom-sounds', { uid: inst.uid, requests: requests.value });
    if (revision === promptRevision) prompt.value = text;
    return text;
  };
  const builder = h('div', { class: 'card sound-builder', hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Sounds you want (comma separated)'), requests),
    h('p', { class: 'muted small' }, 'Copy the prompt into your coding agent. It adds sounds to this pet, which reloads automatically.'), prompt);
  requests.addEventListener('input', makePrompt);
  root.append(h('div', { class: 'row-head', style: 'margin-top:18px' },
    h('button', { class: 'btn primary', onclick: async () => { builder.hidden = !builder.hidden; if (!builder.hidden) { await makePrompt(); requests.focus(); } } }, 'Add custom sounds'),
    h('button', { class: 'btn', onclick: async () => copy(await makePrompt(), `Sound prompt for ${m.name} copied`) }, 'Copy prompt')), builder);
  const customSounds = Object.entries(m.sounds || {});
  if (customSounds.length) {
    const box = h('div', {}, h('div', { class: 'kind-head' }, 'Custom sounds'));
    for (const [key, recipe] of customSounds) {
      const mix = snd.custom?.[key] || {};
      const volume = mix.volume ?? 1;
      const out = h('output', {}, Math.round(volume * 100) + '%');
      box.append(h('div', { class: 'anim' },
        h('div', {}, h('div', { class: 'title' }, recipe.label, h('code', {}, key)),
          h('label', { class: 'param' }, 'Volume', h('input', { type: 'range', min: 0, max: 150, step: 5, value: Math.round(volume * 100),
            oninput: (e) => { out.textContent = e.target.value + '%'; }, onchange: (e) => setCustom(key, { volume: Number(e.target.value) / 100 }) }), out)),
        h('button', { class: 'btn small', onclick: () => previewSound(recipe, snd.volume * volume) }, '▶ Hear it'),
        h('label', { class: 'switch', title: 'Enable this custom sound' }, h('input', { type: 'checkbox', checked: mix.on !== false,
          onchange: (e) => setCustom(key, { on: e.target.checked }) }), h('span'))));
    }
    root.append(box);
  }
  for (const kind of Cat.KINDS) {
    const keys = Object.keys(m.animations).filter((k) => m.animations[k].kind === kind);
    if (!keys.length) continue;
    const box = h('div', {}, h('div', { class: 'kind-head' }, KIND_LABEL[kind]));
    for (const k of keys) {
      const e = effective(k);
      const out = h('output', {}, Math.round(e.volume * 100) + '%');
      box.append(h('div', { class: 'anim' },
        h('div', {}, h('div', { class: 'title' }, m.animations[k].label, h('code', {}, k)),
          h('div', { class: 'params', style: 'margin-top:6px' },
            h('select', { onchange: (ev) => setAnim(k, { sound: ev.target.value }) }, ...options.map(([v, l]) => h('option', { value: v, selected: v === e.name }, l))),
            h('label', { class: 'param' }, 'Volume', h('input', { type: 'range', min: 0, max: 150, step: 5, value: Math.round(e.volume * 100), oninput: (ev) => (out.textContent = ev.target.value + '%'), onchange: (ev) => setAnim(k, { volume: Number(ev.target.value) / 100 }) }), out))),
        h('button', { class: 'btn small', disabled: !e.name, onclick: () => previewSound(recipeOf(e.name), snd.volume * e.volume * (snd.custom?.[e.name]?.volume ?? 1)) }, '▶ Hear it'),
        h('label', { class: 'switch', title: e.on ? 'Plays' : 'Silent' }, h('input', { type: 'checkbox', checked: e.on, onchange: (ev) => setAnim(k, { on: ev.target.checked }) }), h('span')),
      ));
    }
    root.append(box);
  }
  root.append(
    h('div', { class: 'kind-head', style: 'margin-top:26px' }, 'Sound catalog'),
    h('div', { class: 'checks' }, ...Object.entries(PetSounds.SOUNDS).map(([k, r]) => h('button', { class: 'btn small', onclick: () => previewSound(r, 0.5) }, '▶ ' + r.label))),
  );
};

// ---------- Hotkeys ----------

const KEY_NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Return', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };

function comboFrom(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (/^Numpad\d$/.test(e.code)) key = 'num' + e.code.slice(6);
  else if (KEY_NAMES[e.code]) key = KEY_NAMES[e.code];
  if (!key) return null; // only modifiers so far
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return { error: 'Add Ctrl, Alt, Shift or Win so it doesn\'t clash with typing' };
  if (mods.length === 1 && mods[0] === 'Shift' && !/^F\d/.test(key)) return { error: 'Shift alone would clash with typing; add Ctrl or Alt' };
  return { combo: [...mods, key].join('+') };
}

RENDER.hotkeys = async (root) => {
  const version = root.renderVersion;
  const hk = await S.hotkeys();
  if (version !== renderVersion) return;
  const STATUS = { ok: ['ok', '✓ enabled'], taken: ['warn', 'another app already uses this'], invalid: ['warn', 'not a valid combo'], off: ['', 'disabled'] };
  let recording = null;
  let revision = 0;
  let pending = Promise.resolve();
  let disposed = false;
  // Stop listening synchronously; serialize IPC so a late resume/save cannot
  // redraw a recording button or re-enable shortcuts during the next capture.
  function stopRecording() {
    if (!recording) return;
    window.removeEventListener('keydown', recording.onKey, true);
    recording = null;
  }
  function update(work) {
    stopRecording();
    const current = ++revision;
    pending = pending.then(work).then((status) => {
      hk.status = status;
      if (!disposed && current === revision) draw(status);
    }).catch((err) => { console.error('Hotkey update failed', err); if (!disposed) toast('Could not update shortcut. Try again.'); });
    return pending;
  }
  const cancel = () => recording && update(() => S.hotkeysResume());
  cleanupTab = () => {
    disposed = true;
    if (recording) update(() => S.hotkeysResume());
    window.removeEventListener('blur', cancel);
  };
  window.addEventListener('blur', cancel);

  const rowsBox = h('div', {});
  const draw = (status) => {
    rowsBox.textContent = '';
    for (const [action, label] of Object.entries(hk.actions)) {
      const combo = hk.hotkeys[action];
      const [cls, text] = STATUS[status[action]] || STATUS.off;
      const capturing = recording?.action === action;
      const keyBtn = h('button', { class: 'btn' + (capturing ? ' primary' : ''), style: 'min-width:170px;justify-content:center', onclick: () => record(action) },
        capturing ? 'Press the keys…' : combo ? combo.split('+').map((k, i) => [i ? ' + ' : '', h('kbd', {}, k === 'Super' ? 'Win' : k)]).flat() : h('span', { class: 'muted' }, 'Not set'));
      rowsBox.append(h('div', { class: 'setting', style: 'margin-bottom:8px' },
        h('div', {}, h('div', { class: 't' }, label), h('div', { class: 'd' }, h('button', {
          class: 'badge hotkey-toggle ' + cls, disabled: !combo, 'aria-pressed': !hk.disabled?.[action],
          title: hk.disabled?.[action] ? 'Enable this shortcut' : 'Disable this shortcut (keeps its keybinding)',
          onclick: async () => {
            update(async () => {
              hk.disabled = { ...(hk.disabled || {}), [action]: !hk.disabled?.[action] };
              return S.hotkeyEnabled(action, !hk.disabled[action]);
            });
          },
        }, combo ? text : 'not set'))),
        h('div', { style: 'display:flex;gap:6px;align-items:center' }, keyBtn,
          h('button', { class: 'btn small', title: 'Clear', disabled: !combo && !capturing, onclick: () => update(() => { hk.hotkeys[action] = ''; return S.setHotkey(action, ''); }) }, '✕'))));
    }
  };

  function record(action) {
    stopRecording();
    ++revision;
    pending = pending.then(() => S.hotkeysSuspend());
    const onKey = async (e) => {
      e.preventDefault();
      if (e.code === 'Escape') return done(null);
      if (e.code === 'Backspace' || e.code === 'Delete') return done('');
      const r = comboFrom(e);
      if (!r) return;
      if (r.error) return toast(r.error);
      done(r.combo);
    };
    const done = async (combo) => {
      update(async () => {
        if (combo === null) return S.hotkeysResume();
        for (const k of Object.keys(hk.hotkeys)) if (combo && k !== action && hk.hotkeys[k] === combo) hk.hotkeys[k] = '';
        hk.hotkeys[action] = combo;
        const status = await S.setHotkey(action, combo);
        if (combo && status[action] === 'taken') toast(`${combo} is already used by another app — try another combo`);
        return status;
      });
    };
    recording = { action, onKey };
    window.addEventListener('keydown', onKey, true);
    draw(hk.status);
  }

  root.append(
    h('h1', {}, 'Hotkeys'),
    h('p', { class: 'lede' }, 'System-wide shortcuts for your first visible pet. Click a shortcut and press the keys (Esc cancels, Backspace clears). Prefer Ctrl/Alt combinations: Win (Super) shortcuts may be reserved by Windows.'),
    h('div', { class: 'row-head' },
      h('label', { class: 'param' }, h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: hk.enabled, onchange: (e) => { const on = e.target.checked; update(() => { hk.enabled = on; return S.hotkeysEnabled(on); }); } }), h('span')), 'Hotkeys on'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => update(async () => { const s = await S.hotkeysReset(); Object.assign(hk, await S.hotkeys()); toast('Back to the defaults'); return s; }) }, 'Reset to defaults'),
    ),
    rowsBox,
  );
  draw(hk.status);
};

// ---------- Create a pet (prompt maker) ----------

RENDER.create = (root) => {
  const f = {};
  const field = (key, label, hint, el) => { f[key] = el; return h('label', { class: 'field' + (el.tagName === 'TEXTAREA' ? ' full' : '') }, h('span', {}, label), el, hint ? h('small', {}, hint) : null); };
  const include = Cat.CATALOG.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: true, disabled: c.key === 'idle' }) }));
  const out = h('textarea', { class: 'prompt', readonly: true, placeholder: 'Your prompt appears here.' });
  const copyBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => copy(out.value, 'Prompt copied — paste it into your coding agent') }, 'Copy prompt');
  const where = h('p', { class: 'muted small' });

  async function generate() {
    const form = {
      name: f.name.value, concept: f.concept.value, personality: f.personality.value, palette: f.palette.value,
      style: f.style.value, size: f.size.value, extras: f.extras.value, include: include.filter((x) => x.box.checked).map((x) => x.c.key),
    };
    out.value = await S.prompt('create', form);
    copyBtn.disabled = false;
    const id = (form.name || 'my-pet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-pet';
    where.textContent = `Your agent will save it as ${state.paths.pets}\\${id}.pet.js — Harness Pet picks it up automatically and it appears in My pets.`;
    out.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  root.append(
    h('h1', {}, 'Create a pet'),
    h('p', { class: 'lede' }, `Describe a pet, then paste the generated prompt into the coding agent of your choice (we suggest ${state.recommendedModel}). It writes one self-contained pet file with every animation you tick, validates it, and saves it where Harness Pet finds it.`),
    h('div', { class: 'form' },
      field('name', 'Name', null, h('input', { type: 'text', placeholder: 'Pip' })),
      field('palette', 'Colors', 'Optional', h('input', { type: 'text', placeholder: 'sky blue body, yellow beak' })),
      field('concept', 'What is it?', 'A creature, an object with a face, a robot… be as specific as you like.', h('textarea', { placeholder: 'A round little blue bird with a yellow beak and tiny wings' })),
      field('personality', 'Personality', null, h('input', { type: 'text', placeholder: 'excitable, nosy, loves to show off' })),
      field('style', 'Style', null, h('select', {}, h('option', { value: 'pixel' }, 'Pixel art'), h('option', { value: 'smooth' }, 'Smooth cartoon'))),
      field('size', 'Detail', 'Bigger canvases allow more detail.', h('select', {}, h('option', { value: 'small' }, 'Small (≈20 px)'), h('option', { value: 'medium', selected: true }, 'Medium (≈28 px)'), h('option', { value: 'large' }, 'Large (≈40 px)'))),
      field('extras', 'Extra animations', 'Anything special — the agent adds them as custom animations with their own toggles and sliders.', h('textarea', { placeholder: 'fly around the screen at high speed; perch on top of windows; sing when a turn finishes' })),
      h('div', { class: 'full' },
        h('div', { class: 'kind-head' }, 'Standard animations to include', h('button', { class: 'ghost small', onclick: () => include.forEach((x) => (x.box.checked = true)) }, 'all'), h('button', { class: 'ghost small', onclick: () => include.forEach((x) => (x.box.checked = x.c.key === 'idle')) }, 'none')),
        h('div', { class: 'checks' }, ...include.map(({ c, box }) => h('label', { title: c.spec }, box, c.label))),
      ),
      h('div', { class: 'full row-head' }, h('button', { class: 'btn primary', onclick: generate }, '✦ Generate prompt'), copyBtn),
      h('div', { class: 'full' }, out, where),
    )
  );
};

// ---------- Agents ----------

// One button per pet on screen: attach it to this agent, or detach it again (it then
// follows no agent). A pet follows one agent, so attaching moves it from any other.
function attachRow(id) {
  const name = linkName(id);
  const row = h('div', { class: 'attach-row' }, h('div', { class: 'attach-label' }, 'Pets'));
  if (!state.instances.length) return row.append(h('span', { class: 'muted small' }, 'No pets on screen yet.')), row;
  for (const inst of state.instances) {
    const on = inst.harness === id;
    const other = !on && inst.harness ? linkName(inst.harness) : null;
    row.append(h('button', {
      class: 'chip' + (on ? ' on' : ''),
      title: on ? `Detach ${petLabel(inst)} from ${name}` : other ? `Move ${petLabel(inst)} from ${other} to ${name}` : `Attach ${petLabel(inst)} to ${name}`,
      onclick: async () => {
        await S.setInstance(inst.uid, { harness: on ? null : id });
        toast(on ? `${petLabel(inst)} no longer follows ${name}` : `${petLabel(inst)} now follows ${name}`);
      },
    }, h('span', { class: 'chip-name' }, petLabel(inst)), h('span', { class: 'chip-act' }, on ? '✓ Attached · Detach' : other ? `Attach (now ${other})` : 'Attach')));
  }
  return row;
}

async function updateClaudeHooks(action) {
  try {
    const r = await S.claudeHooks(action);
    toast(action === 'install' ? 'Connected. Backup: ' + (r.backup || 'none needed') : 'Hooks removed');
    await refresh(true);
  } catch (err) {
    toast('Could not update Claude hooks. Check ~/.claude/settings.json for valid JSON and file permissions, then try again. ' + (err && err.message || ''));
  }
}

RENDER.agents = (root) => {
  const c = state.claude;
  const claudeStatus = c.needsReconnect ? h('span', { class: 'badge warn' }, 'reconnect recommended') : c.installed ? h('span', { class: 'badge ok' }, '✓ connected') : c.legacy ? h('span', { class: 'badge warn' }, 'old claude-pet hooks') : c.partial ? h('span', { class: 'badge warn' }, 'partly connected') : h('span', { class: 'badge' }, 'not connected');
  const cards = h('div', { class: 'agents' });

  cards.append(h('div', { class: 'card agent' },
    h('div', { class: 'top' }, h('h2', { style: 'margin:0' }, 'Claude Code'), claudeStatus),
    h('div', { class: 'muted small' }, 'Claude Desktop, the claude CLI and IDE extensions. One click — Harness Pet merges its hooks into ~/.claude/settings.json (with a backup) and leaves everything else alone.'),
    c.error && h('p', { role: 'alert' }, c.error),
    c.needsReconnect && h('p', { role: 'status' }, 'Reconnect to replace older hooks with the current launcher. Restart Claude sessions afterward. Disconnect removes recognized Harness Pet hooks from all copies.'),
    h('div', { class: 'actions', style: 'margin-top:12px' },
      h('button', { class: 'btn primary', onclick: () => updateClaudeHooks('install') }, c.installed ? 'Reinstall hooks' : 'Connect'),
      (c.installed || c.partial || c.legacy) && h('button', { class: 'btn', onclick: () => updateClaudeHooks('uninstall') }, 'Disconnect'),
    ),
    attachRow('claude-code')));

  for (const hn of state.harnesses.filter((x) => !x.builtIn)) {
    const linked = !!state.links.links[hn.id];
    cards.append(h('div', { class: 'card agent' },
      h('div', { class: 'top' }, h('h2', { style: 'margin:0' }, hn.name), linked ? h('span', { class: 'badge ok' }, 'buttons linked') : null),
      h('div', { class: 'muted small' }, hn.app),
      h('ul', {}, ...hn.notes.map((n) => h('li', {}, n))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary small', onclick: async () => copy(await S.prompt('link', { harness: hn.id }), `Setup prompt copied — paste it into ${hn.name}`) }, 'Copy setup prompt'),
        h('button', { class: 'btn small', onclick: async () => copy(await S.prompt('buttons', { harness: hn.id }), 'Buttons prompt copied') }, 'Buttons only'),
      ),
      attachRow(hn.id)));
  }
  // links an agent added that are not in the list above
  for (const [id, l] of Object.entries(state.links.links).filter(([id]) => !harnessOf(id))) {
    cards.append(h('div', { class: 'card agent' },
      h('div', { class: 'top' }, h('h2', { style: 'margin:0' }, l.name || id), h('span', { class: 'badge ok' }, 'buttons linked')),
      h('div', { class: 'muted small' }, l.app || 'Set up by an agent in links.json.'),
      attachRow(id)));
  }

  cards.append(h('div', { class: 'card agent' },
    h('div', { class: 'top' }, h('h2', { style: 'margin:0' }, 'Any other agent')),
    h('div', { class: 'muted small' }, `Paste this into any coding agent — it works out how its own harness does hooks, connects them, and wires up the two buttons. Works best with ${state.recommendedModel}.`),
    h('div', { class: 'actions', style: 'margin-top:12px' },
      h('button', { class: 'btn primary small', onclick: async () => copy(await S.prompt('link', { harness: 'any-agent' }), 'Prompt copied') }, 'Copy universal prompt'),
    )));

  const links = state.links;
  const table = h('table', { class: 'links-table' },
    h('tr', {}, h('th', {}, 'Link'), h('th', {}, 'Buttons'), h('th', {}, 'Window'), h('th', {}, '')),
    ...Object.entries(links.links).map(([id, l]) => h('tr', {},
      h('td', {}, h('strong', {}, l.name || id), h('div', { class: 'muted small mono' }, id)),
      h('td', {}, ...(l.buttons || []).map((b, i) => h('div', { class: 'small' }, `${i + 1}. ${b.label}`, h('span', { class: 'muted mono' }, '  ' + (b.open && (b.open.url || b.open.command) || ''))))),
      h('td', { class: 'small mono muted' }, l.window ? Object.values(l.window).filter(Boolean).join(' · ') : '—'),
      h('td', {}, h('label', { class: 'param' }, h('input', { type: 'radio', name: 'primary', checked: links.primary === id, onchange: () => S.saveLinks({ ...links, primary: id }) }), 'default')),
    )));

  root.append(
    h('h1', {}, 'Agents'),
    h('p', { class: 'lede' }, 'Connect coding agents so pets know what they\'re doing, and so the two buttons under a pet open the right app. Each pet follows one agent: attach or detach it with the pet buttons at the bottom of each card.'),
    cards,
    h('div', { class: 'row-head', style: 'margin-top:28px' }, h('h2', { style: 'margin:0' }, 'Button links'), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => S.openPath(state.paths.links) }, 'Open links.json')),
    h('div', { class: 'card' }, table),
  );
};

// ---------- About ----------

RENDER.about = (root) => {
  const p = state.paths;
  const pathRow = (label, value) => h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, label), h('div', { class: 'd mono' }, value)), h('button', { class: 'btn small', onclick: () => S.openPath(value) }, 'Open'));
  root.append(
    h('h1', {}, 'About Harness Pet'),
    h('p', { class: 'lede' }, 'Desktop pets that keep you company while your agents work. When I first saw OpenAI\'s pet feature, I thought it was brilliant and immediately wanted that same fun, lively presence for Claude Code. But as soon as I started tinkering, I realized the real magic would be watching different pets meet, get in each other\'s way, and interact on screen. What started as a fun little itch grew into the project you see here. Pets run safely sandboxed with zero access to your network, files, or Node. Clawrk is an original pixel crab made specially for this project; Harness Pet is proudly independent and not affiliated with any agent vendor.'),
    h('div', { class: 'settings' },
      pathRow('Your pets', p.pets),
      pathRow('Session state', p.sessions),
      pathRow('Button links', p.links),
      pathRow('Pet format guide', p.docs || (p.app + '\\docs\\PET_FORMAT.md')),
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, 'Validate a pet'), h('div', { class: 'd mono' }, `node "${p.validator}" my.pet.js`)),
        h('button', { class: 'btn small', onclick: () => copy(`"${state.nodePath}" "${p.validator}" `, 'Command copied') }, 'Copy')),
    )
  );
};

// ---------- boot ----------

let pending = null;
S.onChanged(() => {
  clearTimeout(pending);
  pending = setTimeout(() => refresh(false), 150);
});
S.onTab((t, uid) => {
  if (uid && state && state.instances.some((i) => i.uid === uid)) selected = uid;
  show(t);
});
refresh(true);
