// Only trusted links.json/Studio configuration can supply launch targets. Pet
// manifests and worker messages are never interpreted as launch configuration.
const path = require('path');
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 4096) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f]/.test(v);
const forbidden = new Set(['file:', 'javascript:', 'data:', 'blob:', 'vbscript:', 'shell:', 'ms-msdt:', 'search-ms:', 'ms-search:']);

function validateTarget(open) {
  if (!record(open)) throw new Error('Invalid launch target');
  if (open.url !== undefined) {
    if (open.command !== undefined || !text(open.url) || !open.url) throw new Error('Choose a URL or a command');
    const url = new URL(open.url);
    if (forbidden.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || (url.protocol !== 'https:' && url.protocol !== 'http:' && !open.url.startsWith(url.protocol + '//'))) throw new Error('Unsupported launch URL scheme');
  } else {
    if (!text(open.command) || !open.command.trim() || !Array.isArray(open.args || []) || (open.args || []).length > 64 || !(open.args || []).every(a => text(a))) throw new Error('Invalid command or argument list');
    if (open.cwd && (!text(open.cwd) || !path.isAbsolute(open.cwd))) throw new Error('Command working directory must be absolute');
  }
  return open;
}

function validateLinks(value) {
  if (!record(value) || !record(value.links) || Object.keys(value.links).length > 100 || !text(value.primary || '', 100)) throw new Error('Invalid links configuration');
  for (const [key, link] of Object.entries(value.links)) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(key) || !record(link) || !Array.isArray(link.buttons) || link.buttons.length > 32) throw new Error('Invalid agent link');
    for (const button of link.buttons) {
      if (!record(button) || !text(button.label, 200)) throw new Error('Invalid button');
      validateTarget(button.open);
      if (button.then && (!record(button.then) || !Array.isArray(button.then.uiaClick) || button.then.uiaClick.length > 32 || !button.then.uiaClick.every(n => text(n, 200)) || (button.then.delayMs !== undefined && (!Number.isFinite(button.then.delayMs) || button.then.delayMs < 0 || button.then.delayMs > 30000)))) throw new Error('Invalid follow-up action');
    }
    if (link.jump) for (const key of ['url', 'needsYouUrl']) if (link.jump[key] !== undefined) validateTarget({ url: link.jump[key] });
    if (link.window && (!record(link.window) || !Object.entries(link.window).every(([k, v]) => ['process', 'pathContains', 'titleContains', 'title'].includes(k) && text(v, 500)))) throw new Error('Invalid window matcher');
  }
  return value;
}

async function launch(open, { shell, spawn, fill = s => s, onError = () => {} }) {
  validateTarget(open);
  if (open.url) {
    const url = fill(open.url);
    validateTarget({ url });
    await shell.openExternal(url);
  } else {
    const child = spawn(open.command, (open.args || []).map(fill), { cwd: open.cwd || undefined, shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', onError);
    child.unref();
  }
}
module.exports = { validateLinks, validateTarget, launch };
