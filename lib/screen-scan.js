// Takes a screenshot of one display (or part of it) and maps where its text is.
// The screenshot is held in memory just long enough to build the map, then dropped.

const { desktopCapturer } = require('electron');
const TextMap = require('./text-map');

// region: screen DIPs, optional. Returns a text grid (see text-map.js) or null.
async function scanDisplay(display, region = null, enabled = () => false) {
  if (!enabled()) return null;
  const b = display.bounds;
  // Windows now and then hands back an empty frame; one more try almost always works.
  let source = null;
  for (let attempt = 0; attempt < 2 && !source; attempt++) {
    if (!enabled()) return null;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: b.width, height: b.height }, // DIPs: text strokes stay a pixel or two wide
      fetchWindowIcons: false,
    });
    if (!enabled()) return null;
    const found = sources.find((s) => s.display_id === String(display.id));
    if (found && !found.thumbnail.isEmpty()) source = found;
    else if (attempt === 0) await new Promise((r) => setTimeout(r, 120));
  }
  if (!source) return null;
  let image = source.thumbnail;
  const full = image.getSize();
  const sx = full.width / b.width;
  const sy = full.height / b.height;
  let ox = b.x;
  let oy = b.y;
  if (region) {
    const x0 = Math.max(b.x, Math.floor(region.x));
    const y0 = Math.max(b.y, Math.floor(region.y));
    const x1 = Math.min(b.x + b.width, Math.ceil(region.x + region.w));
    const y1 = Math.min(b.y + b.height, Math.ceil(region.y + region.h));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    image = image.crop({ x: Math.round((x0 - b.x) * sx), y: Math.round((y0 - b.y) * sy), width: Math.round((x1 - x0) * sx), height: Math.round((y1 - y0) * sy) });
    ox = x0;
    oy = y0;
  }
  const { width, height } = image.getSize();
  const gray = TextMap.grayFromBitmap(image.toBitmap(), width, height);
  return TextMap.buildGrid(gray, width, height, { ox, oy, scale: sx });
}

module.exports = { scanDisplay };
