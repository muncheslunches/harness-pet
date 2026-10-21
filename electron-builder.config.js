const fs = require('fs');
const path = require('path');

module.exports = {
  appId: 'dev.harness-pet',
  productName: 'Harness Pet',
  directories: { output: 'dist' },
  electronDist: 'node_modules/electron/dist',
  // Hooks, validators and the PowerShell helper run outside Electron and need
  // ordinary files, rather than paths inside an Electron-only ASAR archive.
  asar: false,
  files: [
    'main.js', 'lib/**', 'native/**', 'pet-window/**', 'pets/clawrk.pet.js', 'pets/cage.pet.js',
    'runtime/**', 'shared/**', 'studio/**', 'hook/**', 'docs/**',
    '!docs/releases/**', '!**/*.bak',
    'scripts/validate-pet.js', 'assets/*.png', 'LICENSE', 'README.md',
  ],
  extraResources: [{ from: 'build/runtime', to: 'node' }],
  beforePack: async (context) => {
    if (process.platform !== 'win32' || process.arch !== 'x64' || context.arch !== 1) {
      throw new Error('Build this Windows x64 release using Windows x64 Node.js.');
    }
    const runtime = path.join(__dirname, 'build', 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
    const license = path.join(path.dirname(process.execPath), 'LICENSE');
    if (!fs.existsSync(license)) throw new Error('Node.js LICENSE must be beside the build-time node.exe.');
    fs.copyFileSync(license, path.join(runtime, 'LICENSE'));
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon-256.png',
    artifactName: 'Harness-Pet-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    include: 'build/installer.nsh', // uninstalling removes this copy's Claude Code hooks
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: false,
  },
};
