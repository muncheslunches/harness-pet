// Soak of the packaged app: four Clawrks with sound on (very quietly), Studio left open and their
// agent talking, against an isolated profile. Fails if the pets don't all start, the app stops, a
// process crashes, the audio stream never opens or memory keeps growing. Stops what it started.
//
//   node scripts/smoke-soak.js [minutes, default 6]
//
// Set HARNESS_PET_MENU_EXE to soak another build. A short run catches runaway growth only;
// a slow leak needs a longer one.
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const PETS = 4;
const RENDERERS = PETS + 1; // and Studio
const SAMPLE_MS = 5000;
const WARMUP_MS = 180000; // memory climbs for about 3 minutes after starting, then holds
const GROWTH_LIMIT = 0.1; // of the memory in use after warm-up
const MIN_GROWTH_LIMIT_MB = 40;
const MIN_SAMPLES = 9;

const mean = (list) => list.reduce((sum, s) => sum + s.privateMb, 0) / list.length;

// Memory wobbles, so this compares the first and last thirds of what came after warm-up
// rather than any two samples.
function verdict(samples, { renderers = RENDERERS } = {}) {
  const steady = samples.filter((s) => s.at >= WARMUP_MS);
  if (steady.length < MIN_SAMPLES) return { pass: false, problems: [`only ${steady.length} samples after warm-up, need ${MIN_SAMPLES}`] };
  const problems = [];
  if (steady.some((s) => s.processes === 0)) problems.push('the app stopped during the soak');
  else if (steady.some((s) => s.renderers < renderers)) problems.push(`expected ${renderers} renderers, saw ${Math.min(...steady.map((s) => s.renderers))}`);
  const third = Math.floor(steady.length / 3);
  const firstMb = mean(steady.slice(0, third));
  const lastMb = mean(steady.slice(-third));
  const growthMb = lastMb - firstMb;
  const limitMb = Math.max(MIN_GROWTH_LIMIT_MB, firstMb * GROWTH_LIMIT);
  if (growthMb > limitMb) problems.push(`memory grew ${growthMb.toFixed(1)} MB, limit ${limitMb.toFixed(1)} MB`);
  return { pass: !problems.length, firstMb, lastMb, growthMb, limitMb, problems };
}

async function readProcesses(pid) {
  const query = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid} or ParentProcessId = ${pid}" | Select-Object PrivatePageCount, CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, maxBuffer: 1 << 24 });
  return stdout.trim() ? [JSON.parse(stdout)].flat() : [];
}

async function soak(minutes) {
  const root = path.resolve(__dirname, '..');
  const exePath = process.env.HARNESS_PET_MENU_EXE || path.join(root, 'dist', 'win-unpacked', 'Harness Pet.exe');
  if (!fs.existsSync(exePath)) throw new Error(`Executable not found at ${exePath}. Run "npm run dist:win" first.`);

  const store = require('../lib/store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-soak-'));
  const userData = `--user-data-dir=${path.join(tmp, 'user-data')}`;
  const dataDir = path.join(tmp, '.harness-pet');
  const sessions = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify({
    instances: Array.from({ length: PETS }, (_, i) => {
      const inst = store.newInstance('builtin:clawrk', 'claude-code');
      return {
        ...inst, uid: `soak-${i}`, pos: { x: 120 + i * 180, y: 400 }, clickThrough: true,
        sound: { ...inst.sound, volume: 0.02 },
        behavior: { ...inst.behavior, avoidText: false, tricks: 'often' },
      };
    }),
    keyboardAsked: true, keyboardConsentVersion: 1, watchKeyboard: false, hotkeysEnabled: false,
    muteAll: false, idleRest: false, // a sleeping pet would flatter the numbers
  }));

  const env = { ...process.env, USERPROFILE: tmp, HOME: tmp, LOCALAPPDATA: path.join(tmp, 'local'), APPDATA: path.join(tmp, 'roaming'), ELECTRON_RUN_AS_NODE: undefined };
  console.log(`--- Soak: ${minutes} min of ${exePath}`);
  const child = spawn(exePath, [userData], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.once('error', (err) => console.error('Could not start the app:', err.message));

  const states = ['working', 'working', 'needs-you', 'working', 'done'];
  let said = 0;
  const talking = setInterval(() => {
    const state = states[said++ % states.length];
    fs.writeFileSync(path.join(sessions, 'claude-code-soak.json'), JSON.stringify({ sessionId: 'soak', harness: 'claude-code', state, ts: Date.now(), since: Date.now(), detail: `Step ${said}`, title: 'Soak' }));
  }, 3000);

  const samples = [];
  let audio = false;
  const startedAt = Date.now();
  let studioOpened = false;
  try {
    while (Date.now() - startedAt < minutes * 60e3) {
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
      const at = Date.now() - startedAt;
      if (!studioOpened && at > 10000) {
        studioOpened = true;
        spawn(exePath, [userData, '--studio=pets'], { env, stdio: 'ignore' });
      }
      const list = await readProcesses(child.pid);
      const privateMb = list.reduce((sum, p) => sum + (p.PrivatePageCount || 0), 0) / 1048576;
      const renderers = list.filter((p) => /--type=renderer/.test(p.CommandLine || '')).length;
      audio ||= list.some((p) => /audio\.mojom\.AudioService/.test(p.CommandLine || ''));
      samples.push({ at, privateMb, renderers, processes: list.length });
      console.log(`[${Math.round(at / 1000)}s] ${list.length} processes, ${renderers} renderers: ${privateMb.toFixed(1)} MB private${audio ? ', audio stream opened' : ''}`);
      if (!list.length) break;
    }
  } finally {
    clearInterval(talking);
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  const result = verdict(samples);
  if (!audio) result.problems.push('the audio stream never opened');
  let log = '';
  try { log = fs.readFileSync(path.join(dataDir, 'app.log'), 'utf8'); } catch {}
  const crashes = log.split('\n').filter((line) => /(render|child)-process-gone/.test(line) && !/"reason":"clean-exit"/.test(line));
  if (crashes.length) result.problems.push(`${crashes.length} process crashes in app.log, first: ${crashes[0].slice(0, 200)}`);

  console.log('\n--- Soak summary');
  if (result.firstMb) console.log(`Private memory after warm-up: ${result.firstMb.toFixed(1)} MB, at the end: ${result.lastMb.toFixed(1)} MB, growth ${result.growthMb.toFixed(1)} MB (limit ${result.limitMb.toFixed(1)} MB)`);
  for (const problem of result.problems) console.error('FAIL: ' + problem);
  if (!result.problems.length) console.log('PASS: pets, Studio and audio stayed up and memory did not keep growing.');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return result.problems.length ? 1 : 0;
}

if (require.main === module) {
  const minutes = Number(process.argv[2] || 6);
  soak(minutes).then((code) => process.exit(code), (err) => { console.error('FAIL:', err.message); process.exit(1); });
}

module.exports = { verdict, WARMUP_MS };
