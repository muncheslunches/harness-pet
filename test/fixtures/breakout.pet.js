// A test pet that attempts sandbox breakout vectors:
// 1. Reaching fetch through prototype
// 2. Calling importScripts with a file:/// URL
// 3. Overwriting postMessage

const escapeLog = {
  prototypeFetch: false,
  importScripts: false,
  overwrotePostMessage: false,
  errors: [],
};

// 1. Try prototype fetch
try {
  let fetchFn = null;
  if (typeof WorkerGlobalScope !== 'undefined' && WorkerGlobalScope.prototype && typeof WorkerGlobalScope.prototype.fetch === 'function') {
    fetchFn = WorkerGlobalScope.prototype.fetch;
  } else if (typeof DedicatedWorkerGlobalScope !== 'undefined' && DedicatedWorkerGlobalScope.prototype && typeof DedicatedWorkerGlobalScope.prototype.fetch === 'function') {
    fetchFn = DedicatedWorkerGlobalScope.prototype.fetch;
  } else if (typeof self !== 'undefined' && typeof self.fetch === 'function') {
    fetchFn = self.fetch;
  }
  if (fetchFn) {
    fetchFn.call(self, 'file:///C:/Windows/win.ini');
    escapeLog.prototypeFetch = true;
  }
} catch (e) {
  escapeLog.errors.push('prototypeFetch: ' + e.message);
}

// 2. Try importScripts('file:///...')
try {
  let importFn = null;
  if (typeof importScripts === 'function') {
    importFn = importScripts;
  } else if (typeof WorkerGlobalScope !== 'undefined' && WorkerGlobalScope.prototype && typeof WorkerGlobalScope.prototype.importScripts === 'function') {
    importFn = WorkerGlobalScope.prototype.importScripts;
  }
  if (importFn) {
    importFn.call(self, 'file:///C:/Windows/win.ini');
    escapeLog.importScripts = true;
  }
} catch (e) {
  escapeLog.errors.push('importScripts: ' + e.message);
}

// 3. Try overwriting postMessage
try {
  const originalPostMessage = self.postMessage;
  self.postMessage = function() { return 'hijacked'; };
  if (self.postMessage !== originalPostMessage && self.postMessage() === 'hijacked') {
    escapeLog.overwrotePostMessage = true;
  }
} catch (e) {
  escapeLog.errors.push('overwritePostMessage (self): ' + e.message);
}

try {
  if (typeof WorkerGlobalScope !== 'undefined' && WorkerGlobalScope.prototype) {
    const orig = WorkerGlobalScope.prototype.postMessage;
    WorkerGlobalScope.prototype.postMessage = function() { return 'hijacked'; };
    if (WorkerGlobalScope.prototype.postMessage !== orig && WorkerGlobalScope.prototype.postMessage() === 'hijacked') {
      escapeLog.overwrotePostMessage = true;
    }
  }
} catch (e) {
  escapeLog.errors.push('overwritePostMessage (proto): ' + e.message);
}

try {
  postMessage = function() { return 'hijacked'; };
  if (postMessage() === 'hijacked') {
    escapeLog.overwrotePostMessage = true;
  }
} catch (e) {
  escapeLog.errors.push('overwritePostMessage (global): ' + e.message);
}

if (typeof definePet === 'function') {
  definePet({
    format: 1,
    id: 'breakout',
    name: 'Breakout Pet',
    author: 'Security Test',
    version: '1.0.0',
    description: 'A test pet that attempts sandbox breakout vectors.',
    canvas: { width: 16, height: 16 },
    scale: 4,
    lines: {
      dodge: ['Breaking out!', 'Attempting escape!'],
      command: ['Cannot escape!', 'Trapped in sandbox!'],
      panic: ['Sandbox held!', 'All exploits failed!'],
    },
    animations: {
      idle: {
        draw(g, ctx) {
          g.rect(0, 0, 16, 16, '#e00');
        },
      },
    },
    escapeLog,
  });
}
