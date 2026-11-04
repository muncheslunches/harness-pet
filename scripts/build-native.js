// Builds the Rust helpers and puts them in native/bin, where the app and the installer
// look for them. Without them the app simply uses the PowerShell scripts in native/.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const crate = path.join(root, 'native', 'rust');
const bin = path.join(root, 'native', 'bin');

const built = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(crate, 'Cargo.toml')], { stdio: 'inherit' });
if (built.error || built.status !== 0) {
  console.error(built.error?.code === 'ENOENT' ? 'cargo was not found. Install Rust from https://rustup.rs to build the helpers.' : 'The Rust helpers did not build.');
  process.exit(1);
}
fs.mkdirSync(bin, { recursive: true });
for (const name of ['harness-pet-helper.exe', 'harness-pet-keywatch.exe']) {
  fs.copyFileSync(path.join(crate, 'target', 'release', name), path.join(bin, name));
  console.log(`${name}: ${Math.round(fs.statSync(path.join(bin, name)).size / 1024)} KB`);
}
