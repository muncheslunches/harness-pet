#!/usr/bin/env node
// Checks a .pet.js file the same way Harness Pet will: runs it in a sandbox,
// validates the definition, then draws every animation across its whole
// duration (and calls move()) to catch errors before the pet is imported.
//
//   node scripts/validate-pet.js path/to/my-pet.pet.js [--json]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Catalog = require('../shared/catalog.js');
const Schema = require('../shared/pet-schema.js');

// A canvas stand-in that records whether anything was drawn.
function fakeContext(width, height) {
  const ctx = {
    canvas: { width, height },
    drawn: 0,
    fillStyle: '#000',
    globalAlpha: 1,
    fillRect() { ctx.drawn++; },
    clearRect() {},
    beginPath() {},
    ellipse() {},
    rect() {},
    fill() { ctx.drawn++; },
    clip() {},
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    scale() {},
    rotate() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    stroke() { ctx.drawn++; },
    closePath() {},
    drawImage() { ctx.drawn++; },
    fillText() { ctx.drawn++; },
    strokeRect() { ctx.drawn++; },
  };
  return ctx;
}

function check(file) {
  const report = { file, ok: false, errors: [], warnings: [], manifest: null };
  let code;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch (e) {
    report.errors.push('Cannot read file: ' + e.message);
    return report;
  }
  if (code.length > 1024 * 1024) report.errors.push('File is larger than 1 MB');

  let def = null;
  const sandbox = { definePet: (d) => { if (def) throw new Error('definePet() was called more than once'); def = d; }, Math, console: { log() {}, warn() {} } };
  try {
    vm.runInNewContext('"use strict";\n' + code, sandbox, { filename: path.basename(file), timeout: 2000 });
  } catch (e) {
    report.errors.push('The file threw while loading: ' + e.message);
    return report;
  }
  if (!def) {
    report.errors.push('The file never called definePet({...})');
    return report;
  }

  const r = Schema.validate(def);
  report.errors.push(...r.errors);
  report.warnings.push(...r.warnings);
  report.manifest = r.manifest;
  if (r.errors.length) return report;

  const m = r.manifest;
  for (const [key, info] of Object.entries(m.animations)) {
    const a = def.animations[key];
    const ctx2d = fakeContext(m.canvas.width, m.canvas.height);
    const g = Schema.makeGraphics(ctx2d);
    const until = info.duration || 6000;
    const params = Object.fromEntries(Object.entries(info.params).map(([k, p]) => [k, p.default]));
    try {
      for (let t = 0; t <= until; t += 37) {
        for (const dir of [1, -1]) {
          const c = {
            t, dt: 33, frame: t / 33, params, look: { x: dir, y: -1 }, dir, speed: 1, size: 1,
            state: { title: 'Test', detail: 'Testing' }, other: { dir, distance: 40 }, blocked: {},
            home: { dx: 0, dy: 0 }, seed: 7, noise: (i) => Schema.noise(7, i),
          };
          a.draw(g, c);
          if (info.moves) {
            const v = a.move(c);
            if (v !== null && (!v || !Number.isFinite(v.vx) || !Number.isFinite(v.vy))) throw new Error(`move() at t=${t} must return { vx, vy } numbers or null`);
          }
        }
      }
      if (ctx2d.drawn === 0) report.warnings.push(`animations.${key} never draws anything`);
    } catch (e) {
      report.errors.push(`animations.${key} failed while drawing: ${e.message}`);
    }
  }
  if (m.missing.length) report.warnings.push('Missing standard animations (the host will substitute): ' + m.missing.join(', '));
  report.ok = report.errors.length === 0;
  return report;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: node scripts/validate-pet.js <file.pet.js> [--json]');
    process.exit(2);
  }
  const report = check(path.resolve(file));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...report, manifest: report.manifest && { ...report.manifest } }, null, 2));
  } else {
    const m = report.manifest;
    console.log(report.ok ? `✓ ${m.name} (${m.id}) is a valid pet` : '✗ Not a valid pet yet');
    for (const e of report.errors) console.log('  error:   ' + e);
    for (const w of report.warnings) console.log('  warning: ' + w);
    if (m) {
      const std = Catalog.CATALOG.filter((c) => m.animations[c.key]).length;
      console.log(`  ${std}/${Catalog.CATALOG.length} standard animations, ${m.custom.length} custom${m.custom.length ? ': ' + m.custom.join(', ') : ''}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

module.exports = { check };
