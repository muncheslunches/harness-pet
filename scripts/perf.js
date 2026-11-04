// Measures what a controlled set of pets costs: CPU and memory per process type, plus
// dwm.exe (Windows' compositor, which is shared with everything else on screen, so read
// it as a comparison rather than a total). Runs against an isolated profile with sound
// and hotkeys off, and always stops what it started.
//
//   node scripts/perf.js [--root <checkout>] [--pets 3] [--settle 20] [--seconds 45]
//        [--scenario idle|lively|working|real] [--patch '{"asleep":true}'] [--env KEY=VALUE]... [--arg --switch]...
//        [--label name] [--json results.jsonl]
//
// --mine measures your own setup instead of plain Clawrks: "visible" for the pets you have
// showing, or a comma-separated part of their names. It copies their settings and your agent
// links into the isolated profile. With --scenario working their agents report news every
// few seconds; with idle no agent says anything; with real the pets see copies of your agents'
// session files as they change. Your real profile is only read. --patch applies here too.
//
// Read dwm.exe alongside the total: a change can move work out of the app and into Windows'
// compositor. Compare it against a reading with no test pets showing.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function options(argv) {
  const o = { root: path.resolve(__dirname, '..'), pets: 3, settle: 20, seconds: 45, scenario: 'idle', env: [], arg: [], patch: '{}', prefs: '{}', mine: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in o) && !['label', 'json'].includes(key)) throw new Error('Unknown option ' + argv[i]);
    if (Array.isArray(o[key])) o[key].push(argv[i + 1]);
    else o[key] = argv[i + 1];
  }
  for (const k of ['pets', 'settle', 'seconds']) o[k] = Number(o[k]);
  return o;
}

const QUIET = { wander: false, tricks: 'off', nap: false, social: false, trackCursor: false, avoidText: false };

const REAL_DATA = path.join(os.homedir(), '.harness-pet');

function myPrefs(o) {
  const real = JSON.parse(fs.readFileSync(path.join(REAL_DATA, 'prefs.json'), 'utf8'));
  const names = o.mine.toLowerCase().split(',');
  const instances = real.instances
    .filter((i) => (o.mine === 'visible' ? i.visible !== false : names.some((n) => String(i.pet).toLowerCase().includes(n))))
    .map((i) => ({ ...i, visible: true, ...JSON.parse(o.patch) }));
  if (!instances.length) throw new Error('No pets match --mine ' + o.mine);
  return { keyboardAsked: true, keyboardConsentVersion: 1, watchKeyboard: !!real.watchKeyboard, hotkeysEnabled: false, muteAll: true, ...JSON.parse(o.prefs), instances };
}

function prefsFor(o) {
  if (o.mine) return myPrefs(o);
  // working: every pet follows an agent that is busy, so it animates all the time
  const behavior = o.scenario === 'lively' ? { avoidText: false, tricks: 'often' } : QUIET;
  return {
    keyboardAsked: true,
    keyboardConsentVersion: 1, // without this the app asks about typing on screen
    watchKeyboard: false,
    hotkeysEnabled: false,
    muteAll: true,
    ...JSON.parse(o.prefs),
    instances: Array.from({ length: o.pets }, (_, i) => ({
      uid: 'perf' + i,
      pet: 'builtin:clawrk',
      harness: o.scenario === 'working' ? 'claude-code' : null,
      buttons: [null, null],
      barMode: 'off',
      visible: true,
      behavior,
      ...JSON.parse(o.patch),
    })),
  };
}

// Every process with its cumulative CPU time and memory.
function snapshot() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error('Process snapshot failed: ' + r.stderr);
  return { at: Date.now(), list: JSON.parse(r.stdout) };
}

function tree(list, rootPid) {
  const ids = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of list) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true; }
  }
  return list.filter((p) => ids.has(p.ProcessId));
}

function kindOf(p) {
  const cmd = p.CommandLine || '';
  const type = /--type=([a-z-]+)/.exec(cmd)?.[1];
  if (/^electron/i.test(p.Name)) {
    if (!type) return 'main';
    if (type === 'utility') return 'utility:' + (/utility-sub-type=([\w.]+)/.exec(cmd)?.[1]?.split('.')[0] || '?');
    return type;
  }
  if (/powershell/i.test(p.Name)) return /key-watch/.test(cmd) ? 'key-watch (PowerShell)' : 'win-helper (PowerShell)';
  return p.Name;
}

const cpu = (p) => (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e4; // ms

function report(before, after, rootPid) {
  const ms = after.at - before.at;
  const start = new Map(before.list.map((p) => [p.ProcessId, cpu(p)]));
  const rows = {};
  for (const p of tree(after.list, rootPid)) {
    const row = (rows[kindOf(p)] ||= { count: 0, cpuPct: 0, privateMB: 0, workingSetMB: 0 });
    row.count++;
    // a process that started during the sample counts from zero
    row.cpuPct += (cpu(p) - (start.get(p.ProcessId) || 0)) / ms * 100;
    row.privateMB += Number(p.PrivatePageCount) / 1048576;
    row.workingSetMB += Number(p.WorkingSetSize) / 1048576;
  }
  const total = { count: 0, cpuPct: 0, privateMB: 0, workingSetMB: 0 };
  for (const row of Object.values(rows)) for (const k of Object.keys(total)) total[k] += row[k];
  const dwmStart = before.list.find((p) => /^dwm\.exe$/i.test(p.Name));
  const dwmEnd = after.list.find((p) => /^dwm\.exe$/i.test(p.Name) && p.ProcessId === dwmStart?.ProcessId);
  return { seconds: ms / 1000, rows, total, dwmCpuPct: dwmEnd ? (cpu(dwmEnd) - cpu(dwmStart)) / ms * 100 : null };
}

function print(label, r) {
  const fmt = (n, w) => n.toFixed(1).padStart(w);
  console.log(`\n${label} (${r.seconds.toFixed(0)} s; CPU is % of one core)`);
  console.log('  process                          n  CPU%  private MB  working set MB');
  for (const [k, v] of Object.entries(r.rows).sort((a, b) => b[1].cpuPct - a[1].cpuPct)) {
    console.log(`  ${k.padEnd(30)} ${String(v.count).padStart(3)} ${fmt(v.cpuPct, 5)} ${fmt(v.privateMB, 11)} ${fmt(v.workingSetMB, 15)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(30)} ${String(r.total.count).padStart(3)} ${fmt(r.total.cpuPct, 5)} ${fmt(r.total.privateMB, 11)} ${fmt(r.total.workingSetMB, 15)}`);
  console.log(`  dwm.exe (whole desktop)              ${fmt(r.dwmCpuPct ?? 0, 5)}`);
}

async function main() {
  const o = options(process.argv.slice(2));
  const label = o.label || `${path.basename(o.root)} ${o.scenario} ${o.pets} pets`;
  const exe = path.join(o.root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-perf-'));
  const data = path.join(tmp, '.harness-pet');
  fs.mkdirSync(data, { recursive: true });
  const prefs = prefsFor(o);
  fs.writeFileSync(path.join(data, 'prefs.json'), JSON.stringify(prefs));
  if (o.mine && fs.existsSync(path.join(REAL_DATA, 'links.json'))) fs.copyFileSync(path.join(REAL_DATA, 'links.json'), path.join(data, 'links.json'));
  let news = null;
  if (o.scenario === 'real') {
    fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
    const copy = () => {
      const from = path.join(REAL_DATA, 'sessions');
      for (const name of fs.readdirSync(from).filter((n) => n.endsWith('.json'))) {
        try { fs.copyFileSync(path.join(from, name), path.join(data, 'sessions', name)); } catch {}
      }
    };
    copy();
    news = setInterval(copy, 2000);
  }
  if (o.scenario === 'working') {
    fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
    const since = Date.now();
    const harnesses = o.mine ? [...new Set(prefs.instances.map((i) => i.harness).filter(Boolean))] : ['claude-code'];
    let count = 0;
    const report = () => {
      const now = Date.now();
      for (const harness of harnesses) {
        fs.writeFileSync(path.join(data, 'sessions', `perf-${harness}.json`), JSON.stringify({ sessionId: 'perf-' + harness, harness, state: 'working', ts: now, since, detail: o.mine ? `Measuring ${++count}` : 'Measuring', title: 'perf' }));
      }
    };
    report();
    if (o.mine) news = setInterval(report, 5000);
  }
  const env = { ...process.env, USERPROFILE: tmp, HOME: tmp, APPDATA: path.join(tmp, 'roaming'),
    // shared between runs: the PowerShell helpers compile once and keep the result here
    LOCALAPPDATA: path.join(os.tmpdir(), 'hp-perf-localappdata') };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code's shells set it, which makes electron.exe run as plain Node
  for (const pair of o.env) { const i = pair.indexOf('='); env[pair.slice(0, i)] = pair.slice(i + 1); }
  const child = spawn(exe, [o.root, `--user-data-dir=${path.join(tmp, 'ud')}`, ...o.arg], { env, stdio: 'ignore', windowsHide: false });
  const seen = new Set();
  let failure = null;
  try {
    const pause = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));
    await pause(o.settle);
    const before = snapshot();
    tree(before.list, child.pid).forEach((p) => seen.add(p.ProcessId));
    if (!seen.size || child.exitCode !== null) throw new Error('The app is not running');
    await pause(o.seconds);
    const after = snapshot();
    tree(after.list, child.pid).forEach((p) => seen.add(p.ProcessId));
    const r = report(before, after, child.pid);
    print(label, r);
    if (process.env.HARNESS_PET_PERF_VERBOSE) for (const p of tree(after.list, child.pid)) if (!/^electron/i.test(p.Name)) console.log('  ' + p.Name + ': ' + (p.CommandLine || '').slice(0, 200));
    if (o.json) fs.appendFileSync(o.json, JSON.stringify({ label, at: new Date().toISOString(), scenario: o.scenario, pets: o.pets, env: o.env, arg: o.arg, ...r }) + '\n');
  } catch (err) {
    failure = err;
  } finally {
    clearInterval(news);
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const left = snapshot().list.filter((p) => seen.has(p.ProcessId) && /electron|powershell|harness-pet/i.test(p.Name));
    for (const p of left) spawnSync('taskkill', ['/PID', String(p.ProcessId), '/F'], { stdio: 'ignore', windowsHide: true });
    console.log(left.length ? `  stopped ${left.length} leftover process(es)` : '  all test processes stopped');
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
  if (failure) throw failure;
}

main().catch((err) => { console.error(err); process.exit(1); });
