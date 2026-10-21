const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const security = require('../lib/security');
const store = require('../lib/store');

function createWorkerContext() {
  function WorkerGlobalScope() {}
  WorkerGlobalScope.prototype.fetch = function(url) { return 'fetched: ' + url; };
  WorkerGlobalScope.prototype.importScripts = function(...args) { return 'imported: ' + args.join(); };
  WorkerGlobalScope.prototype.postMessage = function(m) { return 'posted: ' + JSON.stringify(m); };

  function DedicatedWorkerGlobalScope() {}
  DedicatedWorkerGlobalScope.prototype = Object.create(WorkerGlobalScope.prototype);
  DedicatedWorkerGlobalScope.prototype.constructor = DedicatedWorkerGlobalScope;

  const ctxObj = Object.create(DedicatedWorkerGlobalScope.prototype);
  ctxObj.WorkerGlobalScope = WorkerGlobalScope;
  ctxObj.DedicatedWorkerGlobalScope = DedicatedWorkerGlobalScope;
  ctxObj.self = ctxObj;
  ctxObj.globalThis = ctxObj;
  ctxObj.console = console;

  const posted = [];
  ctxObj.postMessage = function(m) { posted.push(m); };

  ctxObj.importScripts = function(...scripts) {
    for (const s of scripts) {
      const full = path.resolve(__dirname, '..', 'runtime', s);
      const code = fs.readFileSync(full, 'utf8');
      vm.runInContext(code, context);
    }
  };

  const context = vm.createContext(ctxObj);
  return { context, ctxObj, posted };
}

test('sandbox lockdown prevents prototype fetch, importScripts, and postMessage tampering', () => {
  const { context, ctxObj, posted } = createWorkerContext();
  const workerCode = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'pet-worker.js'), 'utf8');
  vm.runInContext(workerCode, context);

  // 1. Assert worker global environment is locked down
  assert.equal(ctxObj.fetch, undefined);
  assert.equal(ctxObj.WorkerGlobalScope.prototype.fetch, undefined);
  assert.equal(ctxObj.DedicatedWorkerGlobalScope.prototype.fetch, undefined);
  assert.equal(ctxObj.importScripts, undefined);
  assert.equal(ctxObj.WorkerGlobalScope.prototype.importScripts, undefined);

  // 2. Load the breakout test pet
  const breakoutCode = fs.readFileSync(path.join(__dirname, 'fixtures', 'breakout.pet.js'), 'utf8') + '\npostMessage({type: "probe", escapeLog});';
  vm.runInContext(`onmessage({ data: { type: 'load', code: ${JSON.stringify(breakoutCode)} } })`, context);

  assert.equal(posted.length, 2);
  assert.equal(posted[1].type, 'loaded');

  const escapeLog = posted[0].escapeLog;
  assert.ok(escapeLog, 'escapeLog should be populated by the breakout pet');
  assert.equal(escapeLog.prototypeFetch, false, 'prototype fetch attempt must fail');
  assert.equal(escapeLog.importScripts, false, 'importScripts attempt must fail');
  assert.equal(escapeLog.overwrotePostMessage, false, 'postMessage hijacking attempt must fail');

  // 3. Directly verify strict mode errors when attempting exploits
  assert.throws(() => {
    vm.runInContext('"use strict"; WorkerGlobalScope.prototype.fetch("file:///etc/passwd");', context);
  }, /is not a function/);

  assert.throws(() => {
    vm.runInContext('"use strict"; importScripts("file:///etc/passwd");', context);
  }, /is not a function/);

  assert.throws(() => {
    vm.runInContext('"use strict"; postMessage = function() {};', context);
  }, /read only property/);

  assert.throws(() => {
    vm.runInContext('"use strict"; self.postMessage = function() {};', context);
  }, /read only property/);
});

test('session URL filter blocks external network and limits file: URLs', () => {
  const appDir = path.resolve(__dirname, '..');
  const petsDir = path.resolve(store.PATHS.pets);
  const allowedDirs = security.getAllowedDirs(appDir, petsDir);

  // External network protocols must be blocked
  assert.equal(security.isAllowedUrl('http://example.com/leak', allowedDirs), false);
  assert.equal(security.isAllowedUrl('https://evil.org/api/token', allowedDirs), false);
  assert.equal(security.isAllowedUrl('ws://localhost:8080', allowedDirs), false);
  assert.equal(security.isAllowedUrl('wss://evil.org', allowedDirs), false);
  assert.equal(security.isAllowedUrl('ftp://files.example.com', allowedDirs), false);

  // Arbitrary filesystem paths must be blocked
  assert.equal(security.isAllowedUrl('file:///C:/Windows/System32/cmd.exe', allowedDirs), false);
  assert.equal(security.isAllowedUrl('file:///C:/Users/example/.ssh/id_rsa', allowedDirs), false);
  assert.equal(security.isAllowedUrl('file:///etc/passwd', allowedDirs), false);

  // Path traversal attacks must be blocked
  const traversalUrl = 'file:///' + path.join(appDir, '..', '..', 'Windows', 'win.ini').replace(/\\/g, '/');
  assert.equal(security.isAllowedUrl(traversalUrl, allowedDirs), false);

  // Safe internal schemes must be allowed
  assert.equal(security.isAllowedUrl('devtools://devtools/bundled/inspector.html', allowedDirs), true);
  assert.equal(security.isAllowedUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', allowedDirs), true);
  assert.equal(security.isAllowedUrl('blob:null/1234-5678', allowedDirs), true);

  // App folder files must be allowed
  const appFileUrl = 'file:///' + path.join(appDir, 'studio', 'index.html').replace(/\\/g, '/');
  assert.equal(security.isAllowedUrl(appFileUrl, allowedDirs), true);

  // Pets folder files must be allowed
  const petFileUrl = 'file:///' + path.join(petsDir, 'clawrk.pet.js').replace(/\\/g, '/');
  assert.equal(security.isAllowedUrl(petFileUrl, allowedDirs), true);
});

test('open-path IPC is limited strictly to paths in store.PATHS', () => {
  const allowed = Object.values(store.PATHS);

  // Approved store.PATHS must be accepted
  assert.equal(security.isAllowedOpenPath(store.PATHS.pets, allowed), true);
  assert.equal(security.isAllowedOpenPath(store.PATHS.links, allowed), true);
  assert.equal(security.isAllowedOpenPath(store.PATHS.sessions, allowed), true);
  assert.equal(security.isAllowedOpenPath(store.PATHS.docs, allowed), true);
  assert.equal(security.isAllowedOpenPath(store.PATHS.data, allowed), true);

  // Unapproved files or executables must be rejected
  assert.equal(security.isAllowedOpenPath('C:\\Windows\\System32\\calc.exe', allowed), false);
  assert.equal(security.isAllowedOpenPath('C:\\Windows\\System32\\cmd.exe', allowed), false);
  assert.equal(security.isAllowedOpenPath('C:\\evil.bat', allowed), false);
  assert.equal(security.isAllowedOpenPath('/bin/sh', allowed), false);
  assert.equal(security.isAllowedOpenPath('', allowed), false);
  assert.equal(security.isAllowedOpenPath(null, allowed), false);
  assert.equal(security.isAllowedOpenPath(undefined, allowed), false);
});
