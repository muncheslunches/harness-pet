// Exercise the actual NSIS cleanup macro with disposable installs/profiles.
// This is not a clean-machine test of the full product installer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const compiler = process.env.HARNESS_TEST_MAKENSIS || path.join(process.env.LOCALAPPDATA,
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe');
assert.ok(fs.existsSync(compiler), 'Set HARNESS_TEST_MAKENSIS to the existing NSIS compiler.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-nsis-hook-'));
const install = path.join(temp, 'Test Installation é');
const exe = path.join(install, 'resources/node/node.exe');
const setup = path.join(install, 'resources/app/lib/claude-hooks.js');
const bridge = path.join(install, 'resources/app/hook/harness-pet-hook.js');
const after = path.join(temp, 'after-cleanup.txt');
function run(executable, args, env = process.env, windowsVerbatimArguments = false) {
  const r = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true, windowsVerbatimArguments });
  assert.equal(r.status, 0, `${executable}: ${r.error || ''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const nsiPath = (s) => s.replace(/\$/g, '$$').replace(/"/g, '$\\"');
try {
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.mkdirSync(path.dirname(setup), { recursive: true });
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.copyFileSync(path.join(root, 'lib/claude-hooks.js'), setup);
  fs.copyFileSync(path.join(root, 'hook/harness-pet-hook.js'), bridge);
  const uninstallers = {};
  for (const upgrade of [false, true]) {
    const maker = path.join(temp, `make-${upgrade}.exe`);
    const uninstaller = path.join(temp, `uninstall-${upgrade}.exe`);
    const source = path.join(temp, `macro-${upgrade}.nsi`);
    fs.writeFileSync(source, '\uFEFF' + `
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "Harness Pet isolated hook test"
OutFile "${nsiPath(maker)}"
!include "LogicLib.nsh"
!define isUpdated '1 = ${upgrade ? '1' : '0'}'
!include "${nsiPath(path.join(root, 'build/installer.nsh'))}"
Section
  WriteUninstaller "${nsiPath(uninstaller)}"
SectionEnd
Section "Uninstall"
  StrCpy $INSTDIR "${nsiPath(install)}"
  !insertmacro customUnInstall
  ; Mimic runtime deletion after the real macro. No recursive deletion,
  ; registry writes, shortcuts, real app files or real agent settings.
  Delete "$INSTDIR\\resources\\node\\node.exe"
  FileOpen $1 "${nsiPath(after)}" w
  FileWrite $1 "cleanup finished before runtime deletion"
  FileClose $1
SectionEnd
`, 'utf8');
    run(compiler, ['/V2', source]);
    run(maker, ['/S']);
    uninstallers[upgrade] = uninstaller;
  }
  for (const scenario of ['connected', 'disconnected', 'malformed', 'locked', 'missing-runtime', 'upgrade']) {
    if (!fs.existsSync(exe)) {
      try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
    }
    const home = path.join(temp, scenario);
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    run(exe, ['-e', `
      const h=require(${JSON.stringify(setup)}),fs=require('fs');
      h.install(process.execPath);
      const data=JSON.parse(fs.readFileSync(h.SETTINGS));
      data.model='preserved';
      data.hooks.Stop[0].hooks.push(
        {type:'command',command:'"node" "D:/another-tool/pet-hook.js"'},
        {type:'command',command:h.command(process.execPath,'D:/another-copy/hook/harness-pet-hook.js')});
      fs.writeFileSync(h.SETTINGS,JSON.stringify(data));
    `], env);
    const settings = path.join(home, '.claude/settings.json');
    if (scenario === 'disconnected') run(exe, [setup, 'uninstall'], env);
    if (scenario === 'malformed') fs.writeFileSync(settings, '{"hooks":broken');
    if (scenario === 'locked') fs.writeFileSync(settings + '.pet-lock', 'held by test');
    if (scenario === 'missing-runtime') fs.unlinkSync(exe);
    const before = fs.readFileSync(settings);
    if (fs.existsSync(after)) fs.unlinkSync(after);
    // NSIS requires _?= to be the final unquoted command-line suffix, even
    // when its directory contains spaces. Suppress Node's argument quoting.
    run(uninstallers[scenario === 'upgrade'], ['/S', '_?=' + install], env, true);
    assert.ok(fs.existsSync(after), 'NSIS completed the real macro');
    assert.ok(!fs.existsSync(exe), 'runtime deleted only after cleanup');
    if (scenario === 'connected') {
      const result = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert.equal(result.model, 'preserved');
      assert.equal(Object.keys(result.hooks).length, 1);
      assert.equal(result.hooks.Stop[0].hooks.length, 2, 'third-party hook and second copy survived');
      const backups = fs.readdirSync(path.dirname(settings)).filter(n => n.includes('.pet-backup-'));
      assert.ok(backups.some(n => fs.readFileSync(path.join(path.dirname(settings), n)).equals(before)), 'cleanup backed up original bytes');
    } else {
      assert.deepEqual(fs.readFileSync(settings), before, scenario + ' preserved original bytes');
    }
    console.log('PASS NSIS macro: ' + scenario);
  }
} finally {
  // temp is an absolute directory returned by mkdtemp, entirely owned by this test.
  fs.rmSync(temp, { recursive: true, force: true });
}
