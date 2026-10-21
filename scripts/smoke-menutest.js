// Launches the unpacked Electron app with HARNESS_PET_MENUTEST=1 and verifies menu build output.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const exePath = process.env.HARNESS_PET_MENU_EXE || path.join(root, 'dist', 'win-unpacked', 'Harness Pet.exe');

if (!fs.existsSync(exePath)) {
  console.error(`Unpacked binary not found at ${exePath}. Run "npm run dist:win" first.`);
  process.exit(1);
}

fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.test-tmp', 'smoke-menutest-'));
const userDataDir = path.join(tmp, 'user-data');
fs.mkdirSync(userDataDir, { recursive: true });

console.log(`Launching unpacked app at ${exePath} with HARNESS_PET_MENUTEST=1...`);

const child = spawn(exePath, [`--user-data-dir=${userDataDir}`], {
  env: {
    ...process.env,
    HARNESS_PET_MENUTEST: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    USERPROFILE: tmp,
    HOME: tmp,
    LOCALAPPDATA: path.join(tmp, 'local'),
    APPDATA: path.join(tmp, 'roaming'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (data) => {
  const s = data.toString();
  output += s;
  process.stdout.write(s);
});

child.stderr.on('data', (data) => {
  const s = data.toString();
  output += s;
  process.stderr.write(s);
});

const timeout = setTimeout(() => {
  console.error('FAIL: smoke test timed out after 25 seconds');
  child.kill();
  process.exit(1);
}, 25000);

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  console.log(`Process exited with code ${code}, signal ${signal}`);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  if (output.includes('[menutest] FAILED')) {
    console.error('FAIL: Output contains [menutest] FAILED');
    process.exit(1);
  }

  if (!output.includes('[menutest] ok')) {
    console.error('FAIL: Output does not contain expected [menutest] ok');
    process.exit(1);
  }

  if (code !== 0) {
    console.error(`FAIL: App exited with non-zero exit code: ${code}`);
    process.exit(code || 1);
  }

  console.log('PASS: Unpacked app HARNESS_PET_MENUTEST smoke test succeeded');
  process.exit(0);
});
