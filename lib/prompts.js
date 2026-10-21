// Builds the prompts users paste into their coding agent: create a pet, add
// missing animations to a pet, and link an agent (hooks + the two pet buttons).

const fs = require('fs');
const path = require('path');
const Catalog = require('../shared/catalog.js');
const { HARNESSES, BY_ID } = require('../shared/harnesses.js');
const { PATHS } = require('./store');

const APP = path.resolve(__dirname, '..');
const RECOMMENDED_MODEL = 'Claude Opus 5.5';

function env(nodePath) {
  return {
    app: APP,
    node: nodePath || 'node',
    bridge: path.join(APP, 'hook', 'harness-pet-hook.js'),
    validator: path.join(APP, 'scripts', 'validate-pet.js'),
    pets: PATHS.pets,
    sessions: PATHS.sessions,
    links: PATHS.links,
    format: fs.readFileSync(path.join(APP, 'docs', 'PET_FORMAT.md'), 'utf8'),
    example: fs.readFileSync(path.join(PATHS.pets, 'clawrk.pet.js'), 'utf8'),
  };
}

function catalogTable(keys) {
  const rows = Catalog.CATALOG.filter((c) => !keys || keys.includes(c.key)).map((c) => {
    const dur = c.loop ? 'loops' : c.duration ? `${c.duration} ms` : '';
    return `| \`${c.key}\` | ${c.kind} | ${dur} | ${c.spec} |`;
  });
  return ['| Animation | Kind | Length | What it should look like |', '|---|---|---|---|', ...rows].join('\n');
}

const slug = (s) => String(s || 'my-pet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-pet';

// ---------- create a new pet ----------

function createPet(form, nodePath) {
  const e = env(nodePath);
  const name = (form.name || '').trim() || 'My Pet';
  const id = slug(form.id || name);
  const keys = Array.isArray(form.include) && form.include.length ? form.include : Catalog.CATALOG.map((c) => c.key);
  if (!keys.includes('idle')) keys.unshift('idle');
  const grid = { small: 20, medium: 28, large: 40 }[form.size] || 24;
  const style = form.style === 'smooth'
    ? 'Smooth, cartoony shapes drawn with g.ellipse and g.ctx paths (use a larger canvas so curves look clean, and a smaller `scale`).'
    : 'Crisp pixel art: draw with g.px / g.rect / g.pixels only, with a limited palette and 1-pixel outlines or shading.';
  const out = path.join(e.pets, `${id}.pet.js`);

  return `# Make me a desktop pet for Harness Pet

Create a new desktop pet as a single JavaScript file for **Harness Pet**, a desktop app where pets live on screen and react to coding agents. Write the file, check it with the validator, and fix anything it reports. Don't stop until it validates.

## The pet

- **Name:** ${name} (id \`${id}\`)
- **Concept:** ${form.concept || 'surprise me: a charming little creature'}
- **Personality:** ${form.personality || 'curious, friendly, a little dramatic'}
- **Colors:** ${form.palette || 'your choice; pick a small cohesive palette that reads well on both dark and light desktops'}
- **Style:** ${style}
- **Canvas:** about ${grid}×${grid} pet pixels plus 3–4 empty rows on top for hops and effects. Choose \`scale\` so the pet is roughly 100–130 screen pixels tall at 100%.
${form.extras ? `- **Extra animations the user wants:** ${form.extras}\n  Add each as a custom animation (camelCase key, \`label\`, \`kind\`, \`description\`, \`duration\` where needed, and \`params\` such as \`speed\` when it moves, so the app can show sliders).` : '- **Extra animations:** add 1–3 custom ones that fit this creature (for example a bird might `zoomAround` at high speed or `perch`), each with a `label`, `kind`, `description` and useful `params`.'}

- **Sounds:** give it 2–4 signature sounds of its own in \`sounds\` (short, soft, fitting the creature) and attach them to fitting animations with \`sound\`; the built-in catalog covers the rest.

## Save it here

\`${out}\`

Harness Pet watches that folder, so the pet shows up in the app as soon as the file exists, and reloads whenever you save.

## Animations to include

Implement every one of these. Each must be clearly distinct and full of character: make movement readable at a glance, and keep the feet on the same ground row throughout.

${catalogTable(keys)}

The user unchecked these standard animations: ${JSON.stringify(Catalog.CATALOG.filter((c) => !keys.includes(c.key)).map((c) => c.key))}. Do not implement unchecked animations. Also include this exact top-level metadata in the single definePet object: disabledAnimations: ${JSON.stringify(Catalog.CATALOG.filter((c) => !keys.includes(c.key)).map((c) => c.key))}. This keeps unchecked animations disabled even if a reference implementation is accidentally retained.

## The file format (follow it exactly)

${e.format}

## A complete reference pet

This is Clawrk, the built-in crab. Use it to see how a full pet is structured (pose tables, shared paint function, \`fx\` overlays, a custom movement with a speed param). Don't copy its art; make ${name} look and move like itself.

\`\`\`js
${e.example}
\`\`\`

## Check your work

Run:

\`\`\`
"${e.node}" "${e.validator}" "${out}"
\`\`\`

Fix every error, and every warning you reasonably can, then run it again until it prints ✓. When it passes, tell the user that ${name} is ready and that they can pick it in Harness Pet → My Pets.
`;
}

// ---------- add missing animations to an existing pet ----------

function addMissing({ file, manifest, keys }, nodePath) {
  const e = env(nodePath);
  const list = keys && keys.length ? keys : manifest.missing;
  const builtIn = file.startsWith(path.join(APP, 'pets'));
  const target = builtIn ? path.join(e.pets, path.basename(file)) : file;
  return `# Add new animations to my Harness Pet

My desktop pet **${manifest.name}** (\`${file}\`) is missing ${list.length === 1 ? 'an animation' : `${list.length} animations`} that Harness Pet supports. Add ${list.length === 1 ? 'it' : 'them'} to the pet file, keeping the pet's existing look, palette, proportions and drawing style. Reuse its existing helpers and poses wherever you can, and don't change existing animations.
${builtIn ? `\nThat file ships with the app, so first copy it to \`${target}\`, change its \`id\` to \`${manifest.id}-plus\`, and make all edits in the copy.\n` : ''}
## Add these

${catalogTable(list)}

## The file format

${e.format}

## Check your work

\`\`\`
"${e.node}" "${e.validator}" "${target}"
\`\`\`

Fix everything it reports. Harness Pet reloads the pet automatically when the file is saved, and the new animations appear in its menu.
`;
}

// ---------- link an agent harness (hooks + the two buttons) ----------

function linkBlock(e, harnessId) {
  return `## Part 2: the two buttons under the pet

The pet shows two buttons (the user picks which) taken from \`${e.links}\`. Add or update the entry \`links["${harnessId}"]\`:

\`\`\`json
{
  "name": "Display name",
  "app": "The app these buttons open",
  "buttons": [
    { "label": "New chat",    "icon": "compose", "open": { "url": "…" } },
    { "label": "New session", "icon": "code",    "open": { "command": "…", "args": ["…"] } }
  ],
  "jump": { "url": "…{sessionId}…" },
  "window": { "process": "ProcessName", "pathContains": "", "titleContains": "" }
}
\`\`\`

- Each button's \`open\` is either \`{ "url": "…" }\` (opened with the OS, which suits app URL schemes like \`myapp://new\`) or \`{ "command": "exe", "args": [], "cwd": "" }\` (started detached).
- \`window\` identifies the app's main window so Harness Pet can bring it to the front after a button is pressed. Give a process name without .exe, and optionally a path or title fragment.
- \`jump\` is optional: a URL that opens one specific session. \`{sessionId}\` and \`{hostSessionId}\` are filled in from the session files.
- Icons: compose, code, chat, terminal, voice, sparkle, bolt, globe.

**Find out how this app really does it.** Look for registered URL protocols (on Windows, check \`HKEY_CLASSES_ROOT\` for the app's scheme, and the app's manifest or docs), CLI flags for "new chat" or "new session", and the process name of its window (\`Get-Process\`). Prefer a documented method; a URL scheme beats a command line. Button 1 should open a fresh chat or prompt box. Button 2 should open a new agent or coding session (or the closest equivalent). Don't invent URLs: verify each one by actually opening it once.

Keep every other entry in \`${e.links}\` exactly as it is.`;
}

function linkHarness(harnessId, nodePath) {
  const e = env(nodePath);
  const h = BY_ID[harnessId];
  const id = h ? h.id : slug(harnessId);
  const name = h ? h.name : harnessId;
  const notes = h ? h.notes.map((n) => `- ${n}`).join('\n') : '- Nothing is known about this harness yet. Find out from its docs whether it supports hooks, lifecycle events, plugins or a notify command.';
  return `# Connect ${name} to my Harness Pet

I use **Harness Pet**, a desktop pet that reacts to what my coding agent is doing. Connect **${name}** (${h ? h.app : 'my coding agent'}) to it in two parts: hooks, so the pet knows what you're doing, and the two buttons under the pet. Work carefully: never remove or break existing configuration, back up any config file before you edit it, and keep anything you add easy to remove.

## Part 1: hooks → pet state

Harness Pet ships a bridge script. Every hook calls it, and it writes the session state to \`${e.sessions}\`:

\`\`\`
"${e.node}" "${e.bridge}" --harness ${id} --event <EventName>
\`\`\`

- It reads the hook's JSON from stdin (snake_case or camelCase), maps the event to a pet state by name, prints nothing, and always exits 0 within 1.5 s, so it can't break the agent.
- Recognized event names include UserPromptSubmit / BeforeSubmitPrompt / BeforeAgent / PreInvocation (→ thinking), PreToolUse / BeforeTool / beforeShellExecution / TaskStart / BackgroundTask (→ working), PostToolUse / AfterTool / afterFileEdit (→ thinking), PermissionRequest / Notification (→ needs you), Stop / AfterAgent / TaskEnd (→ done unless fullyIdle is false) and SessionEnd (→ removed). Wire each hook with its own event name (SessionStart as SessionStart), and only map the real end of a turn to Stop: events that fire after every model call, such as Antigravity’s PostInvocation, are ignored. When background tasks or subagents are running, Stop with fullyIdle: false keeps the pet indicating ongoing work. Always pass \`--event\` explicitly.
- If the harness needs a JSON answer on stdout (for example to allow a tool), add \`--reply '<json>'\` with the most permissive "continue/allow" answer its docs describe. The bridge must never deny or change anything.
- If an event has no usable name, set the state directly: \`--state thinking|working|needs-you|done|end --detail "short text" [--session ID] [--title "…"]\`.

What I know about ${name} (verify against its current docs; hook systems change quickly):
${notes}

Register hooks for as many of these moments as the harness supports: prompt sent, tool starting, tool finished, waiting for the user (permission or question), turn finished, session ended. Then trigger one real prompt and confirm that a file named \`${id}-<session>.json\` appears in \`${e.sessions}\` and changes state.

${linkBlock(e, id)}

## Finish

Tell me which events you hooked, where the config lives, and what the two buttons do. In Harness Pet, I'll set a pet to follow "${name}" (right-click the pet → Follows, or Studio → Agents).
`;
}

function linkButtons(harnessId, nodePath) {
  const e = env(nodePath);
  const h = BY_ID[harnessId];
  const name = h ? h.name : harnessId;
  return `# Set up the buttons under my Harness Pet for ${name}

I use **Harness Pet**, a desktop pet with two buttons under it. Make those buttons open **${name}** (${h ? h.app : 'my coding agent'}) properly. Don't touch anything except the one entry described below.

${linkBlock(e, h ? h.id : slug(harnessId))}

When you're done, tell me exactly what each button opens and how you verified it.
`;
}

// The "any agent" prompt: the agent researches its own harness.
function linkAnyAgent(nodePath) {
  const p = linkHarness('my-agent', nodePath)
    .replace('# Connect my-agent to my Harness Pet', '# Connect this coding agent to my Harness Pet')
    .replace('Connect **my-agent** (my coding agent)', 'Connect **the harness you are running in** (identify it first: its name, version and how it is configured)')
    .replace(/--harness my-agent/g, '--harness <short-harness-id>')
    .replace(/links\["my-agent"\]/g, 'links["<short-harness-id>"]')
    .replace('`my-agent-<session>.json`', '`<short-harness-id>-<session>.json`')
    .replace('"my-agent" (right-click', '"<short-harness-id>" (right-click');
  return `> Tip: this works best with a strong agentic model. We suggest ${RECOMMENDED_MODEL}.\n\n` + p;
}

function addSounds({ file, manifest, requests }, nodePath) {
  const name = manifest?.name || path.basename(file, '.pet.js');
  const validator = path.join(APP, 'scripts', 'validate-pet.js');
  return `# Add custom sounds to ${name} in Harness Pet

Edit the existing pet file at: ${file}
Read that file first. Preserve its art, animations, movement, existing sounds and identity. Do not change other pets or app files.

Use the comma-separated requests at the bottom to create short, soft synthesized sounds that fit ${name}. Add them to the existing sounds object INSIDE the pet's single definePet({...}) call; merge existing entries. Do not append a second definePet call or put recipes outside the definition. Use unique camelCase keys and readable labels.

Recipe example:
sounds: {
  softChime: { label: 'Soft chime', parts: [
    { wave: 'sine', f: 880, to: 1320, dur: 0.15, gain: 0.25 },
    { wave: 'triangle', f: 660, at: 0.12, dur: 0.2, gain: 0.15 }
  ] }
}

Each recipe needs 1–12 parts. wave: sine, square, triangle, sawtooth or noise; f: 10 < Hz < 20000; dur: 0 < seconds <= 3; optional to (end Hz), at (start seconds), gain (0–1), q (noise filter). Optional repeatMs >= 60 loops while the animation plays. Keep volume modest.

Attach each requested sound to an appropriate existing animation using its sound: 'recipeKey' property when suitable. Preserve all drawing/move functions and other animation settings. Harness Pet detects the sounds, adds volume/on-off/preview controls above Agent status, and makes them available in animation sound choices. Save the file; it reloads automatically.

Validate and fix any errors:
"${nodePath || 'node'}" "${validator}" "${file}"

If the requests below are still a placeholder, ask the user what sounds they want before editing.

## Sounds I want (comma separated)
${String(requests || '').trim() || '[Type the sounds you want here, separated by commas]'}
`;
}

module.exports = { createPet, addMissing, addSounds, linkHarness, linkButtons, linkAnyAgent, HARNESSES, RECOMMENDED_MODEL };
