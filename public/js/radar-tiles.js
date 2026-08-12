// Radar tile layers that repaint the feed's palette on the way in.
//
// Both feeds bake their colour scheme into the PNGs, so the only way to change
// what they look like is to redraw the tiles. They are served with an open CORS
// header, which means a canvas can read them back and rewrite them per pixel —
// no proxy, and no extra request.
//
// RainViewer needs only a colour swap: its low-intensity bands are one long
// blue ramp — pale cyan for drizzle darkening to deep navy for steady rain —
// which is remapped onto a green ramp over the same range, and the yellow
// through violet it uses for the intensities that matter are left alone.
//
// The NEXRAD mosaic needs more than that. It arrives as raw reflectivity: hard
// square bins, no smoothing, and every bin the radars can see including the
// clear-air return and ground clutter that speckles a dry day with blue. Read
// back through the NWS ramp it becomes a dBZ field, which can be cleaned up and
// then painted with the same colours as the other feed.

/* ------------------------------------------------- RainViewer colours ----- */

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

function mapColour(r, g, b) {
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

function paintRainviewer(data) {
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

/* ------------------------------------------------ NEXRAD reflectivity ----- */

// Corners of the NWS N0Q ramp, read off the mosaic's own legend and fitted so
// that straight lines between them reproduce it to within a few RGB steps.
// Below about 15 dBZ it runs through mauve, grey and blue — that end of the
// scale is dust, insects, terrain and clear-air return rather than rain.
const N0Q_RAMP = [
  [-31, 0x836c92], [-24, 0x938d75], [-23, 0x969153], [-12, 0xcfd2b4],
  [1, 0x7c89af], [8, 0x415b9e], [17, 0x6fd6e8], [20, 0x35d65b],
  [21, 0x11d518], [34, 0x095e09], [40, 0xffe200], [50, 0xff8000],
  [50.5, 0xff0000], [60, 0x710000], [60.5, 0xffffff], [65, 0xff92ff],
  [65.5, 0xff75ff], [70, 0xe10be3], [70.5, 0xb200ff], [76, 0x6300d6],
  [76.5, 0x05ecf0], [82, 0x012020], [82.5, 0x3a67b5], [83, 0xffffff],
];

// The ramp expanded to one entry per half-decibel, which is the resolution the
// product is quantised to, so a tile colour can be matched back to a dBZ.
let reflectivityRamp = null;

function rampEntries() {
  if (reflectivityRamp) return reflectivityRamp;
  reflectivityRamp = [];
  for (let i = 1; i < N0Q_RAMP.length; i++) {
    const [d0, c0] = N0Q_RAMP[i - 1];
    const [d1, c1] = N0Q_RAMP[i];
    const steps = Math.max(1, Math.round((d1 - d0) * 2));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      reflectivityRamp.push({
        r: ((c0 >> 16) & 255) + t * (((c1 >> 16) & 255) - ((c0 >> 16) & 255)),
        g: ((c0 >> 8) & 255) + t * (((c1 >> 8) & 255) - ((c0 >> 8) & 255)),
        b: (c0 & 255) + t * ((c1 & 255) - (c0 & 255)),
        dbz: d0 + t * (d1 - d0),
      });
    }
  }
  return reflectivityRamp;
}

// The mosaic only ever draws in ramp colours, so a tile holds a hundred or so
// distinct values however big it is. Memoising the search makes it free.
const reflectivity = new Map();

function dbzFor(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let dbz = reflectivity.get(key);
  if (dbz !== undefined) return dbz;
  let best = Infinity;
  dbz = -32;
  for (const e of rampEntries()) {
    const d = (e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2;
    if (d < best) {
      best = d;
      dbz = e.dbz;
    }
  }
  reflectivity.set(key, dbz);
  return dbz;
}

// Where the picture starts, and the width of the band it fades in over. Nothing
// below FLOOR - FADE is drawn at all: that is the clutter.
//
// The cut sits at 15 dBZ because below that is not rain reaching the ground.
// On a summer night the mosaic over Florida is a broad, smooth 10–20 dBZ sheet
// of insects and birds — measured over Orlando, 89% of everything the old 8 dBZ
// cut drew was under 20 dBZ, and correlating consecutive scans put its best
// match at zero displacement, so it does not travel the way rain does. It sits
// there and boils, which is what read as noise and as part of the jerk.
//
// The fade band then runs all the way to 25 rather than over a few decibels, so
// what survives the cut arrives as a haze rather than a wash: genuine light
// rain at 20–25 dBZ still comes through at half alpha and up, and the bio layer
// underneath it stays faint. Reflectivity is the only thing separating them —
// local texture does not: measured, both sit at a standard deviation of about
// 2.3 dBZ over the same band.
const FLOOR = 25;
const FADE = 10;
// How much of a pixel's neighbourhood has to hold an echo for it to survive. A
// lone speck of clutter fails this; the edge of a real cell does not.
const SUPPORT = 0.35;

// The legend bar in app.css, as dBZ stops. Light rain opens pale green and
// darkens through to a deep green, then the intensities that matter run yellow,
// orange, red and violet — the same scale the other feed is repainted onto.
const RAIN_STOPS = [
  [15, 0x9a, 0xed, 0x83],
  [22, 0x33, 0xe4, 0x2e],
  [28, 0x0d, 0xa6, 0x26],
  [34, 0x07, 0x5a, 0x22],
  [40, 0xff, 0xe0, 0x00],
  [47, 0xff, 0x8b, 0x00],
  [54, 0xe0, 0x2c, 0x2c],
  [65, 0xa0, 0x20, 0xc8],
];

// The stops sampled every half-decibel, indexed the same way the field is.
let rainPalette = null;

function rainColours() {
  if (rainPalette) return rainPalette;
  rainPalette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const dbz = i / 2 - 32;
    let stop = RAIN_STOPS[0];
    let next = null;
    let t = 0;
    for (let s = 1; s < RAIN_STOPS.length; s++) {
      if (dbz > RAIN_STOPS[s][0]) continue;
      stop = RAIN_STOPS[s - 1];
      next = RAIN_STOPS[s];
      t = clamp((dbz - stop[0]) / (next[0] - stop[0]), 0, 1);
      break;
    }
    if (!next) {
      stop = RAIN_STOPS[RAIN_STOPS.length - 1];
      next = stop;
    }
    for (let c = 0; c < 3; c++) {
      rainPalette[i * 3 + c] = Math.round(stop[c + 1] + t * (next[c + 1] - stop[c + 1]));
    }
  }
  return rainPalette;
}

// Working room for the pass below, kept between tiles: every tile is the same
// size, a tile is painted start to finish without yielding, and three fresh
// float fields per tile is a megabyte of garbage each time otherwise.
let scratchFields = null;

function fields(n) {
  if (!scratchFields || scratchFields[0].length !== n) {
    scratchFields = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  } else {
    scratchFields[0].fill(0);
    scratchFields[1].fill(0);
  }
  return scratchFields;
}

/** Separable 5-tap binomial blur, clamped at the tile edge. */
function blur(field, w, h, scratch) {
  const K0 = 6 / 16;
  const K1 = 4 / 16;
  const K2 = 1 / 16;
  const at = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      scratch[row + x] =
        K2 * field[row + at(x - 2, w - 1)] +
        K1 * field[row + at(x - 1, w - 1)] +
        K0 * field[row + x] +
        K1 * field[row + at(x + 1, w - 1)] +
        K2 * field[row + at(x + 2, w - 1)];
    }
  }
  for (let y = 0; y < h; y++) {
    const up2 = at(y - 2, h - 1) * w;
    const up1 = at(y - 1, h - 1) * w;
    const dn1 = at(y + 1, h - 1) * w;
    const dn2 = at(y + 2, h - 1) * w;
    for (let x = 0; x < w; x++) {
      field[y * w + x] =
        K2 * scratch[up2 + x] +
        K1 * scratch[up1 + x] +
        K0 * scratch[y * w + x] +
        K1 * scratch[dn1 + x] +
        K2 * scratch[dn2 + x];
    }
  }
}

/**
 * Turn a tile of raw reflectivity into rain: read the dBZ back off the ramp,
 * drop the bins below the weather, soften what is left, and repaint it.
 */
function paintNexrad(data, w, h) {
  const colours = rainColours();
  const n = w * h;
  const [value, cover, scratch] = fields(n);

  let echoes = 0;
  for (let i = 0; i < n; i++) {
    const alpha = data[i * 4 + 3];
    if (alpha === 0) continue;
    const dbz = dbzFor(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (dbz < FLOOR - FADE) {
      data[i * 4 + 3] = 0; // clear-air return and ground clutter
      continue;
    }
    value[i] = dbz;
    cover[i] = alpha / 255;
    echoes++;
  }
  // Most tiles over most of the country are dry, and blurring an empty field
  // twice to arrive back at an empty field is the bulk of what a page load
  // would otherwise spend on the radar.
  if (echoes === 0) return;

  // Normalised convolution — the reflectivity is blurred weighted by how much
  // echo each pixel holds, so a cell's edge softens into nothing instead of
  // being dragged down towards zero by the empty sky around it.
  for (let i = 0; i < n; i++) value[i] *= cover[i];
  blur(value, w, h, scratch);
  blur(cover, w, h, scratch);

  for (let i = 0; i < n; i++) {
    const held = cover[i];
    if (held < 0.02) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const dbz = value[i] / held;
    // A speck of clutter has nothing around it to hold it up, so its coverage
    // collapses under the blur while a real cell's survives.
    const support = clamp((held - SUPPORT) / (1 - SUPPORT), 0, 1);
    const strength = clamp((dbz - (FLOOR - FADE)) / FADE, 0, 1);
    const alpha = support * strength;
    if (alpha <= 0.01) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const shade = clamp(Math.round((dbz + 32) * 2), 0, 255) * 3;
    data[i * 4] = colours[shade];
    data[i * 4 + 1] = colours[shade + 1];
    data[i * 4 + 2] = colours[shade + 2];
    data[i * 4 + 3] = Math.round(255 * alpha);
  }
}

/* -------------------------------------------------------------- layer ----- */

const PAINTERS = {
  rainviewer: (data) => paintRainviewer(data),
  nexrad: (data, w, h) => paintNexrad(data, w, h),
};

// Built on first use rather than at module scope: Leaflet is a deferred classic
// script, so `L` is not guaranteed to exist while this module is evaluating.
// Memoised per base class because every `extend` call mints a fresh one, and a
// frame layer is built for each of the dozen-odd frames.
const painted = new Map();

function paintedClass(Base) {
  let cls = painted.get(Base);
  if (cls) return cls;
  cls = Base.extend({
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
          this._paintTile(pixels.data, size.x, size.y);
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
  painted.set(Base, cls);
  return cls;
}

/**
 * Same contract as `L.tileLayer`, but each tile is a canvas we have repainted
 * for the feed named by `paint`. Pass `wms: true` for a feed addressed by the
 * OGC service rather than by tile coordinates — the NEXRAD mosaic is, because
 * that is the only way to ask it for a particular scan. If a tile ever fails
 * the canvas security check we keep the feed's own colours rather than dropping
 * the frame; an unknown feed name falls back to a plain tile layer.
 *
 * Anything left in `options` that Leaflet does not recognise is handed to the
 * WMS as a request parameter, which is how a frame carries its scan time.
 */
export function radarTileLayer({ url, paint, wms, ...options } = {}) {
  const Base = wms ? L.TileLayer.WMS : L.TileLayer;
  const paintTile = PAINTERS[paint];
  const layer = new (paintTile ? paintedClass(Base) : Base)(url, options);
  layer._paintTile = paintTile;
  return layer;
}
