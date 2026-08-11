// A radar tile layer that repaints RainViewer's palette on the way in.
//
// RainViewer bakes its colour scheme into the PNGs, so the only way to change
// it is to redraw the tiles. They are served with an open CORS header, which
// means a canvas can read them back and swap colours per pixel — no proxy, and
// no extra request.
//
// The mapping: RainViewer's low-intensity bands are one long blue ramp — pale
// cyan for drizzle darkening to deep navy for steady rain — which is remapped
// onto a green ramp running light green to dark green over the same range.
// Yellow through violet, the intensities that actually matter, are left exactly
// as the forecasters coloured them.

/* ------------------------------------------------------------- colour ----- */

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pack = ([r, g, b]) => (r << 16) | (g << 8) | b;

/** Hue bands, in degrees, of the palette we are rewriting. */
const BLUE = [165, 265];
const GREEN = [70, 165];

// Ends of the green ramp the blues are rewritten onto.
const DARK = { hue: 142, light: 0.15 };
const LIGHT = { hue: 104, light: 0.77 };

export function mapColour(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  // Greys, whites and the near-black outlines carry no rain rate.
  if (s < 0.18) return (r << 16) | (g << 8) | b;

  if (h >= BLUE[0] && h <= BLUE[1]) {
    // How far up the blue ramp this pixel sits: 0 is the deepest navy (heaviest
    // of the light bands), 1 the palest cyan. Running the replacement as a
    // continuous ramp rather than two flat bands keeps the smoothed tiles from
    // developing a hard seam down the middle of every rain shield.
    const t = clamp((l - 0.18) / 0.6, 0, 1);
    return pack(
      hslToRgb(
        DARK.hue + t * (LIGHT.hue - DARK.hue),
        clamp(s, 0.5, 0.85),
        DARK.light + t * (LIGHT.light - DARK.light),
      ),
    );
  }

  // Schemes that do use green get the deep end of the same ramp.
  if (h > GREEN[0] && h < GREEN[1]) {
    return pack(hslToRgb(DARK.hue, clamp(s + 0.08, 0.5, 1), clamp(l * 0.5, 0.15, 0.3)));
  }
  return (r << 16) | (g << 8) | b;
}

// Radar tiles draw from a palette of a couple of dozen colours, so memoising
// turns a per-pixel colour conversion into a per-pixel map lookup.
const palette = new Map();

function recolour(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // fully transparent: no rain here
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let mapped = palette.get(key);
    if (mapped === undefined) {
      mapped = mapColour(data[i], data[i + 1], data[i + 2]);
      palette.set(key, mapped);
    }
    data[i] = (mapped >> 16) & 255;
    data[i + 1] = (mapped >> 8) & 255;
    data[i + 2] = mapped & 255;
  }
}

/* -------------------------------------------------------------- layer ----- */

// Built on first use rather than at module scope: Leaflet is a deferred classic
// script, so `L` is not guaranteed to exist while this module is evaluating.
// Memoised because every `L.TileLayer.extend` call mints a fresh class, and a
// frame layer is built for each of the dozen-odd frames.
let Recoloured = null;

function recolouredClass() {
  if (Recoloured) return Recoloured;
  Recoloured = L.TileLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize();
      const tile = L.DomUtil.create('canvas');
      tile.width = size.x;
      tile.height = size.y;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const ctx = tile.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size.x, size.y);
        try {
          const pixels = ctx.getImageData(0, 0, size.x, size.y);
          recolour(pixels.data);
          ctx.putImageData(pixels, 0, 0);
        } catch {
          /* tainted canvas — the untouched tile is still readable */
        }
        done(null, tile);
      };
      // A missing tile leaves an empty canvas, which keeps the loop running.
      img.onerror = () => done(null, tile);
      img.src = this.getTileUrl(coords);
      return tile;
    },
  });
  return Recoloured;
}

/**
 * Same contract as `L.tileLayer`, but each tile is a canvas we have repainted.
 * If a tile ever fails the canvas security check we keep RainViewer's original
 * colours rather than dropping the frame.
 *
 * Pass `recolour: false` for a feed that already ships the palette we want — it
 * then behaves as a plain tile layer and skips a canvas pass per tile.
 */
export function radarTileLayer(url, { recolour: shouldRecolour = true, ...options } = {}) {
  return shouldRecolour ? new (recolouredClass())(url, options) : L.tileLayer(url, options);
}
