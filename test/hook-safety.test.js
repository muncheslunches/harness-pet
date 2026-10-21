// All writes and hook execution use synthetic homes, never real agent settings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

function isolated(script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-hook-safety-'));
  try {
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr || String(r.error));
    return r.stdout;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
const prelude = `
  const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
  const h = require('./lib/claude-hooks');
  const home = os.homedir();
  fs.mkdirSync(path.dirname(h.SETTINGS), { recursive: true });
  const read = () => JSON.parse(fs.readFileSync(h.SETTINGS, 'utf8'));
`;

test('invalid JSON shapes cannot break status or mutate settings', () => isolated(prelude + `
  for (const value of [null, [], 3, 'text', {hooks:null}, {hooks:[]}, {hooks:{Stop:null}},
    {hooks:{Stop:{}}}, {hooks:{Stop:[null]}}, {hooks:{Stop:[{}]}},
    {hooks:{Stop:[{hooks:null}]}}, {hooks:{Stop:[{hooks:[null]}]}},
    {hooks:{Stop:[{hooks:[{type:'command',command:7}]}]}},
    {hooks:{Stop:[{matcher:[],hooks:[]}]}}]) {
    const raw = JSON.stringify(value);
    fs.writeFileSync(h.SETTINGS, raw);
    assert.match(h.status().error, /invalid structure/);
    for (const action of ['install','uninstall','uninstallThisCopy']) {
      assert.throws(() => h[action](process.execPath), /invalid structure/);
      assert.equal(fs.readFileSync(h.SETTINGS,'utf8'),raw);
      assert.deepEqual(fs.readdirSync(path.dirname(h.SETTINGS)),['settings.json']);
    }
  }
`));

test('ownership, migration, partial setup and two-copy removal preserve unrelated hooks', () => isolated(prelude + `
  const unrelated = [
    {type:'command',command:'"node" "D:/other/hook/pet-hook.js"'},
    {type:'command',command:'"node" "D:/other/hook/harness-pet-hook.js" --other'},
    {type:'command',command:'echo "D:/other/hook/harness-pet-hook.js" --harness claude-code'},
    {type:'prompt',prompt:'pet-hook.js',command:'"node" "D:/other/hook/harness-pet-hook.js" --harness claude-code'},
    {type:'command',command:'"node" "D:/claude-pet-copy/hook/pet-hook.js"'},
    {type:'command',command:'"node" "D:/claude-pet/hook/pet-hook.js.bak"'},
  ];
  for (const hook of unrelated) assert.equal(h.ownedBridge(hook),null);
  const old = [
    {type:'command',command:'if exist "C:/old/node.exe" "C:/old/node.exe" "C:/old/hook/harness-pet-hook.js" --harness claude-code'},
    {type:'command',command:'if exist "C:/old/hook/harness-pet-hook.js" node "C:/old/hook/harness-pet-hook.js" --harness claude-code'},
    {type:'command',command:'"node" "C:/old/claude-pet/hook/pet-hook.js"'},
  ];
  const original = {model:'test',hooks:{Stop:[{matcher:'*',custom:'preserved',hooks:[...unrelated,...old]}],Other:[{hooks:[]}],Empty:[]}};
  fs.writeFileSync(h.SETTINGS,JSON.stringify(original));
  assert.equal(h.status().legacy,true);
  h.install(process.execPath);
  h.install(process.execPath);
  let data = read();
  assert.deepEqual(data.hooks.Stop[0],{matcher:'*',custom:'preserved',hooks:unrelated});
  assert.equal(Object.values(data.hooks).flat().flatMap(g=>g.hooks).filter(x=>h.ownedBridge(x)).length,7);
  assert.equal(h.status().installed,true);
  assert.equal(h.status().needsReconnect,false);
  delete data.hooks.PreToolUse;
  fs.writeFileSync(h.SETTINGS,JSON.stringify(data));
  assert.equal(h.status().partial,true);
  h.install(process.execPath);
  const other = {type:'command',command:h.command(process.execPath,'D:/Second Copy/hook/harness-pet-hook.js')};
  data=read(); data.hooks.Stop[0].hooks.push(other);
  fs.writeFileSync(h.SETTINGS,JSON.stringify(data));
  assert.equal(h.status().needsReconnect,true);
  h.uninstallThisCopy();
  assert.deepEqual(read().hooks.Stop[0].hooks,[...unrelated,other]);
  const noChange=fs.readFileSync(h.SETTINGS);
  assert.equal(h.uninstallThisCopy().removed,false);
  assert.deepEqual(fs.readFileSync(h.SETTINGS),noChange);
  h.uninstall();
  assert.deepEqual(read().hooks.Stop[0].hooks,unrelated);
  const after=fs.readFileSync(h.SETTINGS);
  assert.equal(h.uninstall().removed,false);
  assert.deepEqual(fs.readFileSync(h.SETTINGS),after);
  assert.deepEqual(read().hooks.Other,[{hooks:[]}]);
  assert.deepEqual(read().hooks.Empty,[]);
`));

test('rapid backups are unique, byte exact (including BOM), and lock conflicts are actionable', () => isolated(prelude + `
  const raw=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{\\r\\n  "model": "test"\\r\\n}\\r\\n')]);
  fs.writeFileSync(h.SETTINGS,raw);
  const RealDate=Date;
  global.Date=class extends RealDate { constructor(...args) { super(...(args.length?args:['2026-10-19T00:00:00Z'])); } };
  const backups=[];
  for(let i=0;i<12;i++){
    const before=fs.readFileSync(h.SETTINGS);
    const result=i%2?h.uninstall():h.install(process.execPath);
    assert.deepEqual(fs.readFileSync(result.backup),before);
    backups.push(result.backup);
  }
  assert.equal(new Set(backups).size,12);
  assert.deepEqual(fs.readFileSync(backups[0]),raw);
  fs.writeFileSync(h.SETTINGS+'.pet-lock','test lock');
  const before=fs.readFileSync(h.SETTINGS);
  assert.throws(()=>h.install(process.execPath),/Another Harness Pet hook update/);
  assert.deepEqual(fs.readFileSync(h.SETTINGS),before);
  fs.unlinkSync(h.SETTINGS+'.pet-lock');
  h.install(process.execPath);
`));

test('read-only settings and injected read, backup, write and rename failures retain originals', () => isolated(prelude + `
  const cp=require('child_process');
  const raw=Buffer.from('{ "model": "keep me" }\\r\\n');
  fs.writeFileSync(h.SETTINGS,raw);
  if(process.platform==='win32'){
    cp.execFileSync('attrib.exe',['+R',h.SETTINGS],{windowsHide:true});
    try { assert.throws(()=>h.install(process.execPath),/permissions|EPERM|EACCES/); }
    finally { cp.execFileSync('attrib.exe',['-R',h.SETTINGS],{windowsHide:true}); }
    assert.deepEqual(fs.readFileSync(h.SETTINGS),raw);
  }
  for(const stage of ['read','backup','temp','rename']){
    const readFile=fs.readFileSync,writeFile=fs.writeFileSync,rename=fs.renameSync;
    const fail=()=>{const e=new Error('injected '+stage+' EACCES');e.code='EACCES';throw e;};
    if(stage==='read')fs.readFileSync=(p,...a)=>p===h.SETTINGS?fail():readFile(p,...a);
    if(stage==='backup'||stage==='temp')fs.writeFileSync=(p,...a)=>String(p).includes(stage==='backup'?'.pet-backup-':'.pet-tmp-')?fail():writeFile(p,...a);
    if(stage==='rename')fs.renameSync=fail;
    try {
      if(stage==='read')assert.match(h.status().error,/permissions/);
      assert.throws(()=>h.install(process.execPath),/EACCES/);
    } finally { fs.readFileSync=readFile;fs.writeFileSync=writeFile;fs.renameSync=rename; }
    assert.deepEqual(fs.readFileSync(h.SETTINGS),raw);
    const files=fs.readdirSync(path.dirname(h.SETTINGS));
    assert.ok(!files.some(x=>x.includes('.pet-tmp-')||x.endsWith('.pet-lock')));
    for(const file of files.filter(x=>x.includes('.pet-backup-')))assert.deepEqual(fs.readFileSync(path.join(path.dirname(h.SETTINGS),file)),raw);
  }
`));

test('external edits detected before replacement are preserved', () => isolated(prelude + `
  fs.writeFileSync(h.SETTINGS,'{}');
  const original=fs.writeFileSync;
  fs.writeFileSync=(p,...args)=>{
    const result=original(p,...args);
    if(String(p).includes('.pet-tmp-'))original(h.SETTINGS,'{"model":"external"}');
    return result;
  };
  try{assert.throws(()=>h.install(process.execPath),/changed during hook setup/);}
  finally{fs.writeFileSync=original;}
  assert.equal(read().model,'external');
`));

test('separate setup processes cannot overwrite each other while holding the lock', () => isolated(prelude + `
  const {spawn}=require('child_process');
  fs.writeFileSync(h.SETTINGS,'{"model":"concurrent"}');
  const script = \`
    const fs=require('fs'),h=require('./lib/claude-hooks');
    const original=fs.renameSync;
    fs.renameSync=(...args)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return original(...args);};
    try{h.install(process.execPath);process.stdout.write('saved');}
    catch(e){if(!e.message.includes('Another Harness Pet hook update'))throw e;process.stdout.write('busy');}
  \`;
  Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',script],{env:process.env,windowsHide:true});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    child.on('error',reject);child.on('close',code=>code?reject(new Error(err)):resolve(out));
  }))).then(results=>{
    assert.ok(results.includes('saved'));
    assert.ok(results.includes('busy'));
    assert.equal(read().model,'concurrent');
    assert.equal(Object.values(read().hooks).flat().flatMap(g=>g.hooks).filter(x=>h.ownedBridge(x)).length,7);
    assert.ok(!fs.existsSync(h.SETTINGS+'.pet-lock'));
  }).catch(e=>{console.error(e);process.exitCode=1;});
`));

test('guarded launcher works in cmd, Git Bash and PowerShell with Unicode paths and missing files', { skip: process.platform !== 'win32' }, () => {
  const output=isolated(prelude + `
    const cp=require('child_process');
    const dir=path.join(home,"François [é] & O'Neil $cash");
    fs.mkdirSync(dir);
    const node=path.join(dir,'node.exe'),bridge=path.join(dir,'harness-pet-hook.js');
    try{fs.linkSync(process.execPath,node);}catch{fs.copyFileSync(process.execPath,node);}
    const source=fs.readFileSync('./hook/harness-pet-hook.js');
    const shells=[
      ['cmd',process.env.ComSpec,['/d','/s','/c']],
      ['git-bash',process.env.HARNESS_TEST_BASH||'C:/Program Files/Git/bin/bash.exe',['--noprofile','--norc','-c']],
      ['powershell','powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command']],
    ];
    const timings=[];
    for(const [name,exe,args] of shells){
      assert.ok(name!=='git-bash'||fs.existsSync(exe),'Git Bash must be installed to claim its tests passed');
      fs.writeFileSync(bridge,source);
      const cmd=h.command(node,bridge);
      for(const [event,state] of [['UserPromptSubmit','thinking'],['PreToolUse','working'],['PermissionRequest','needs-you'],['PostToolUse','thinking'],['Notification','needs-you'],['Stop','done'],['SessionEnd',null]]){
        const payload={hook_event_name:event,session_id:name,prompt:'café test',tool_name:'Read',notification_type:'permission_prompt',message:'Test permission'};
        const started=Date.now();
        const r=cp.spawnSync(exe,[...args,cmd],{env:process.env,input:JSON.stringify(payload),encoding:'utf8',timeout:5000,windowsHide:true});
        assert.equal(r.status,0,name+' '+event+': '+r.stderr+' '+r.error);
        assert.equal(r.stderr,'');assert.equal(r.stdout,'');
        const file=path.join(home,'.harness-pet','sessions','claude-code-'+name+'.json');
        if(state){const record=JSON.parse(fs.readFileSync(file));assert.equal(record.state,state);assert.equal(record.harness,'claude-code');assert.equal(record.title,'café test');}
        else assert.ok(!fs.existsSync(file));
        timings.push({shell:name,event,ms:Date.now()-started});
      }
      // A protocol fixture confirms stdout and the exact argument vector are not swallowed.
      fs.writeFileSync(bridge,\`let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:JSON.parse(s),reply:'café'})));\`);
      const reply=cp.spawnSync(exe,[...args,cmd],{input:'{"test":"café"}',encoding:'utf8',timeout:5000,windowsHide:true});
      assert.equal(reply.status,0,reply.stderr);
      assert.deepEqual(JSON.parse(reply.stdout),{args:['--harness','claude-code'],input:{test:'café'},reply:'café'});
      assert.equal(reply.stderr,'');
      for(const [label,n,b] of [['node missing',node+'.missing',bridge],['bridge missing',node,bridge+'.missing'],['both missing',node+'.missing',bridge+'.missing']]){
        const started=Date.now();
        const r=cp.spawnSync(exe,[...args,h.command(n,b)],{input:'{}',encoding:'utf8',timeout:5000,windowsHide:true});
        assert.equal(r.status,0,name+' '+label+': '+r.stderr+' '+r.error);
        assert.equal(r.stdout,'');assert.equal(r.stderr,'');
        timings.push({shell:name,event:label,ms:Date.now()-started});
      }
    }
    console.log(JSON.stringify(timings));
  `);
  console.log('Hook shell timings (ms): '+output.trim());
});

test('missing runtime is an actionable setup failure and does not register dead hooks', () => isolated(prelude + `
  fs.writeFileSync(h.SETTINGS,'{"model":"preserve"}');
  assert.throws(()=>h.install(path.join(home,'missing.exe')),/ENOENT/);
  assert.deepEqual(read(),{model:'preserve'});
`));
