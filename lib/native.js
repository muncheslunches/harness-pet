// How to run a native helper: the small Rust program when it is there (npm run build:native;
// installers include it), and otherwise the PowerShell script that does the same job. That
// also covers a helper antivirus removed or blocked, since these binaries are unsigned.

const fs = require('fs');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native');
const distrusted = new Set();

function powershell(script, args = []) {
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], rust: false };
}

function command(name, script, { exeArgs = [], scriptArgs = [] } = {}) {
  const exe = path.join(NATIVE, 'bin', `harness-pet-${name}.exe`);
  if (!process.env.HARNESS_PET_NO_RUST && !distrusted.has(name) && fs.existsSync(exe)) return { file: exe, args: exeArgs, rust: true };
  return powershell(path.join(NATIVE, script), scriptArgs);
}

// It stopped before it ever said it was ready: use PowerShell from now on.
function distrust(name) {
  if (distrusted.has(name)) return;
  distrusted.add(name);
  console.warn(`harness-pet-${name}.exe did not start; using PowerShell instead`);
}

module.exports = { command, powershell, distrust };
