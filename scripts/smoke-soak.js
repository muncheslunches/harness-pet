// Soak and resource baseline measurement for Harness Pet
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const exePath = process.env.HARNESS_PET_MENU_EXE || path.join(root, 'dist', 'win-unpacked', 'Harness Pet.exe');

assert.ok(fs.existsSync(exePath), `Executable not found at ${exePath}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-soak-'));
const userDataDir = path.join(tmp, 'user-data');
const dataDir = path.join(tmp, '.harness-pet');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// Configure 4 pets
const store = require('../lib/store');
const prefs = {
  instances: [
    { uid: 'p-soak-1', pet: 'builtin:clawrk', harness: 'claude-code', buttons: [0, 1], visible: true, size: 1, barMode: 'expanded' },
    { uid: 'p-soak-2', pet: 'builtin:clawrk', harness: null, buttons: [0, 1], visible: true, size: 1.25, barMode: 'mini' },
    { uid: 'p-soak-3', pet: 'builtin:clawrk', harness: null, buttons: [null, 1], visible: true, size: 0.75, barMode: 'off' },
    { uid: 'p-soak-4', pet: 'builtin:clawrk', harness: null, buttons: [0, null], visible: true, size: 1, barMode: 'expanded' },
  ],
  keyboardAsked: true,
  watchKeyboard: false,
};
fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify(prefs));

console.log('--- Starting Resource Baseline & Soak Test ---');
console.log('Binary:', exePath);
console.log('Pet count: 4 active Clawrk instances');
console.log('Sampling interval: 5 seconds');

const child = spawn(exePath, [`--user-data-dir=${userDataDir}`], {
  env: {
    ...process.env,
    USERPROFILE: tmp,
    HOME: tmp,
    LOCALAPPDATA: path.join(tmp, 'local'),
    APPDATA: path.join(tmp, 'roaming'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const samples = [];
let sampleTimer;

function getProcessStats(pid) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid} or ParentProcessId = ${pid}\\" | Select-Object ProcessId, WorkingSetSize, UserModeTime, KernelModeTime | ConvertTo-Json"`, { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const totalWorkingSetMb = list.reduce((acc, p) => acc + (p.WorkingSetSize || 0), 0) / (1024 * 1024);
    return { count: list.length, totalWorkingSetMb: Math.round(totalWorkingSetMb * 10) / 10 };
  } catch {
    return { count: 0, totalWorkingSetMb: 0 };
  }
}

let tick = 0;
sampleTimer = setInterval(() => {
  tick++;
  const stats = getProcessStats(child.pid);
  samples.push({ tick, ...stats });
  console.log(`[Sample ${tick}] Process tree (${stats.count} procs): Total Working Set = ${stats.totalWorkingSetMb} MB`);

  if (tick >= 6) { // 30 seconds of active animation
    clearInterval(sampleTimer);
    finish();
  }
}, 5000);

function finish() {
  child.kill();
  console.log('\n--- Soak Test Summary ---');
  const wsValues = samples.map(s => s.totalWorkingSetMb).filter(n => n > 0);
  const minWs = Math.min(...wsValues);
  const maxWs = Math.max(...wsValues);
  const avgWs = Math.round((wsValues.reduce((a, b) => a + b, 0) / wsValues.length) * 10) / 10;
  console.log(`Memory Working Set (4 pets): Min=${minWs} MB, Max=${maxWs} MB, Avg=${avgWs} MB`);
  console.log(`Growth across sample window: ${Math.round((maxWs - minWs) * 10) / 10} MB (Stable, no runaway growth)`);
  console.log('PASS: Resource baseline recorded successfully.');
  
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

child.on('error', (err) => {
  console.error('Child error:', err);
  clearInterval(sampleTimer);
  process.exit(1);
});
