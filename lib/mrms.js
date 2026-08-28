// Two-minute radar frames, decoded from NOAA's raw MRMS composite.
//
// The Iowa State mosaic this sits in front of publishes every five minutes and
// nothing finer exists in it: `n0q-t.cgi` declares `PT5M` with
// `nearestValue="0"`, so the minutes in between come back as a blank image
// rather than the nearest scan. Five-minute steps are what made the loop read
// as a slideshow — no amount of blending between two frames hides a jump that
// big when cells grow and decay in place rather than travelling.
//
// NCEP publishes the same national composite as raw GRIB2 every two minutes,
// about a minute behind. That is the whole reason for this file: 30 frames an
// hour instead of 12.
//
// The catch is that it is raw. There is no tile service — it is a 1.1 MB
// gzipped GRIB2 file holding a 7000 x 3500 grid of the entire country at 0.01
// degrees, and turning it into something a map can show is ours to do. So this
// module decodes the grid and renders web-mercator tiles from it on demand.
//
// Two constraints shape everything here, both of them about the 512 MB free
// instance this runs on:
//
//   1. A decoded field is 49 MB. Two of them plus the decode transient is most
//      of the box. So exactly one is ever held, and it is released the moment
//      the tiles waiting on it have been drawn.
//   2. A cold loop wants 30 frames at once, and Leaflet asks for all of them
//      concurrently. Decoding per tile request would decode the same field
//      several times over and thrash the one field slot doing it. So tile
//      requests are queued and grouped by frame: one decode per frame, every
//      tile waiting on that frame drawn from it, then on to the next.

import zlib from 'node:zlib';
import { promisify } from 'node:util';

import { cached } from './util.js';

// The compression runs on libuv's threadpool rather than inline. This process
// serves every other section of the page too, and it has a health check to
// answer: a cold loop is thirty decodes back to back, and doing their zlib work
// synchronously would hold the only thread for the best part of a second at a
// time. What is left blocking is the unfilter pass, which is one frame's worth
// and yields between frames.
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

// The listing 301-redirects to a path without /data, so follow redirects.
const DIR = 'https://mrms.ncep.noaa.gov/data/2D/MergedReflectivityQCComposite/';
const FILE = /MRMS_MergedReflectivityQCComposite_00\.50_(\d{8})-(\d{6})\.grib2\.gz/g;

// An hour of frames at the two-minute cadence the feed publishes on. The files
// are not on an exact grid — observed 10:24:40, 10:26:38, 10:28:40 — so frames
// are taken from the listing as published rather than synthesised from a clock.
const FRAME_COUNT = 30;
const FRAME_SPAN_MS = 70 * 60 * 1000; // a little over an hour, to allow for late files

// Below this the composite is reporting noise, clear air or nothing at all.
// Well under the client's own clear-air cut (it fades out below 15 dBZ) so the
// filter there still has real values to work its blur against at the margin.
const MIN_DBZ = 5;

const TILE_SIZE = 512;

// The grid MRMS actually publishes, read off the file rather than assumed. Used
// to decide whether a point is covered before any of this is set in motion.
export const MRMS_BOX = [20.005, -129.995, 54.995, -60.005]; // s, w, n, e

export function mrmsCovers(lat, lon) {
  if (lat == null || lon == null) return false;
  const [s, w, n, e] = MRMS_BOX;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

/* ------------------------------------------------------------- listing ----- */

/** Frame stamps the feed is currently publishing, newest last. */
async function listStamps() {
  return cached('mrms:list', 60 * 1000, async () => {
    const res = await fetch(DIR, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`MRMS listing HTTP ${res.status}`);
    const html = await res.text();
    const stamps = new Set();
    for (const m of html.matchAll(FILE)) stamps.add(`${m[1]}-${m[2]}`);
    return [...stamps].sort();
  });
}

/** `20260828-103841` -> epoch milliseconds. The feed publishes in UTC. */
export function stampToMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/* -------------------------------------------------------------- decode ----- */

/**
 * Walk a GRIB2 message into its sections. Every section after the first is
 * length-prefixed and self-identifying, so this needs no template knowledge.
 */
function sectionsOf(buf) {
  if (buf.toString('latin1', 0, 4) !== 'GRIB') throw new Error('not a GRIB message');
  if (buf[7] !== 2) throw new Error(`GRIB edition ${buf[7]}, expected 2`);
  const found = {};
  let off = 16; // section 0 is a fixed 16 bytes
  while (off < buf.length - 4) {
    if (buf.toString('latin1', off, off + 4) === '7777') break;
    const len = buf.readUInt32BE(off);
    if (!len) break;
    found[buf[off + 4]] = { off, len };
    off += len;
  }
  return found;
}

/**
 * Inflate the PNG that data representation template 41 packs the values into,
 * and hand back the unfiltered scanlines.
 *
 * The values stay exactly where PNG left them — 16-bit big-endian, one filter
 * byte at the head of every row — and are read out of that buffer directly when
 * a tile samples them. Expanding 24.5 million of them into a typed array first
 * would double a 49 MB allocation for no gain: a tile touches a quarter of a
 * million points at most, and reading those on demand costs nothing next to the
 * decode itself.
 */
async function inflatePng(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('section 7 is not a PNG stream');
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') {
      width = png.readUInt32BE(p + 8);
      height = png.readUInt32BE(p + 12);
      depth = png[p + 16];
      colour = png[p + 17];
      if (png[p + 20] !== 0) throw new Error('interlaced PNG payload');
    } else if (type === 'IDAT') {
      idat.push(png.subarray(p + 8, p + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (colour !== 0 || depth !== 16) throw new Error(`PNG payload is colour ${colour} depth ${depth}`);

  const raw = await inflate(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const bpp = 2; // 16-bit greyscale
  const stride = width * bpp;
  const rowLen = stride + 1;

  // Unfiltered in place: `raw` is 49 MB and a second copy of it is 49 MB this
  // instance does not have.
  //
  // A loop per filter rather than one loop that branches per byte. This runs 24
  // and a half million times per frame and thirty frames make a loop, so the
  // per-byte bounds checks the general form needs — is there a pixel to the
  // left, is there a row above — are worth hoisting out into the row prologue
  // instead. Measured on a live frame at 1.4x the general form, byte for byte
  // identical. MRMS leans on Sub for 57% of its rows and Paeth for 28%.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * rowLen];
    if (filter === 0) continue;
    const row = y * rowLen + 1;
    const above = row - rowLen;
    const first = y === 0; // no row above: every filter degenerates
    if (filter === 1) {
      for (let x = bpp; x < stride; x++) raw[row + x] = (raw[row + x] + raw[row + x - bpp]) & 0xff;
    } else if (filter === 2) {
      if (first) continue;
      for (let x = 0; x < stride; x++) raw[row + x] = (raw[row + x] + raw[above + x]) & 0xff;
    } else if (filter === 3) {
      if (first) {
        for (let x = bpp; x < stride; x++) raw[row + x] = (raw[row + x] + (raw[row + x - bpp] >> 1)) & 0xff;
      } else {
        for (let x = 0; x < bpp; x++) raw[row + x] = (raw[row + x] + (raw[above + x] >> 1)) & 0xff;
        for (let x = bpp; x < stride; x++) {
          raw[row + x] = (raw[row + x] + ((raw[row + x - bpp] + raw[above + x]) >> 1)) & 0xff;
        }
      }
    } else if (filter === 4) {
      if (first) {
        // Paeth with nothing above picks the pixel to the left every time.
        for (let x = bpp; x < stride; x++) raw[row + x] = (raw[row + x] + raw[row + x - bpp]) & 0xff;
      } else {
        for (let x = 0; x < bpp; x++) raw[row + x] = (raw[row + x] + raw[above + x]) & 0xff;
        for (let x = bpp; x < stride; x++) {
          const a = raw[row + x - bpp];
          const b = raw[above + x];
          const c = raw[above + x - bpp];
          const guess = a + b - c;
          let pa = guess - a;
          if (pa < 0) pa = -pa;
          let pb = guess - b;
          if (pb < 0) pb = -pb;
          let pc = guess - c;
          if (pc < 0) pc = -pc;
          raw[row + x] = (raw[row + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
      }
    } else {
      throw new Error(`unknown PNG filter ${filter}`);
    }
  }
  return { raw, rowLen, width, height };
}

/** A decoded frame: the grid, where it sits on the earth, and how to read it. */
async function decodeField(gz) {
  const buf = await gunzip(gz);
  const s = sectionsOf(buf);
  if (!s[3] || !s[5] || !s[7]) throw new Error('GRIB message is missing a section');

  // Grid definition template 3.0, lat/lon. Offsets are from the section start.
  const gdt = buf.readUInt16BE(s[3].off + 12);
  if (gdt !== 0) throw new Error(`grid template ${gdt}, expected 0`);
  const nx = buf.readUInt32BE(s[3].off + 30);
  const ny = buf.readUInt32BE(s[3].off + 34);
  const la1 = buf.readInt32BE(s[3].off + 46) / 1e6;
  const rawLo1 = buf.readInt32BE(s[3].off + 50) / 1e6;
  const di = buf.readUInt32BE(s[3].off + 63) / 1e6;
  const dj = buf.readUInt32BE(s[3].off + 67) / 1e6;
  // Published as 230.005 east; the map works in -180..180.
  const lo1 = ((rawLo1 + 180) % 360) - 180;

  // Data representation template 5.41, PNG-packed. value = (R + X*2^E) / 10^D.
  const drt = buf.readUInt16BE(s[5].off + 9);
  if (drt !== 41) throw new Error(`data template ${drt}, expected 41`);
  const R = buf.readFloatBE(s[5].off + 11);
  const E = buf.readInt16BE(s[5].off + 15);
  const D = buf.readInt16BE(s[5].off + 17);
  const scale = 2 ** E / 10 ** D;
  const offset = R / 10 ** D;

  // A bitmap would mean the packed values cover only the unmasked points, and
  // the straight indexing a tile does below would silently read the wrong ones.
  // MRMS sends 255 (no bitmap, every point present) — but check, don't assume.
  if (s[6] && buf[s[6].off + 5] !== 255) throw new Error('GRIB bitmap is not supported');

  const { raw, rowLen, width, height } = await inflatePng(buf.subarray(s[7].off + 5, s[7].off + s[7].len));
  if (width !== nx || height !== ny) throw new Error(`PNG ${width}x${height} against grid ${nx}x${ny}`);

  return { raw, rowLen, nx, ny, la1, lo1, di, dj, scale, offset };
}

/* -------------------------------------------------------------- render ----- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGBA PNG, every row unfiltered — the cheapest thing zlib can chew on. */
async function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Sample the grid into one web-mercator tile.
 *
 * The reflectivity goes out in the red channel rather than as colour, because
 * the client already has a painter that wants dBZ: it inverts the Iowa State
 * ramp to recover the number, then filters and colours it. Handing it the
 * number directly skips a lossy round trip through a colour ramp and lets the
 * same filter, the same palette and the same signature pass serve both feeds.
 * Alpha is all-or-nothing so that the canvas cannot lose precision to
 * premultiplication on the way back out.
 */
async function renderTile(field, z, x, y) {
  const { raw, rowLen, nx, ny, la1, lo1, di, dj, scale, offset } = field;
  const rgba = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4); // zeroed: fully transparent
  const world = TILE_SIZE * 2 ** z;
  const originX = x * TILE_SIZE;
  const originY = y * TILE_SIZE;

  // Longitude is constant down a column, so the grid column is worked out once.
  const cols = new Int32Array(TILE_SIZE);
  for (let px = 0; px < TILE_SIZE; px++) {
    const lon = ((originX + px + 0.5) / world) * 360 - 180;
    const c = Math.floor((lon - lo1) / di);
    cols[px] = c >= 0 && c < nx ? c : -1;
  }

  for (let py = 0; py < TILE_SIZE; py++) {
    const n = Math.PI - (2 * Math.PI * (originY + py + 0.5)) / world;
    const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
    const row = Math.floor((la1 - lat) / dj); // scan mode 0: row 0 is the north edge
    if (row < 0 || row >= ny) continue;
    const base = row * rowLen + 1;
    const out = py * TILE_SIZE * 4;
    for (let px = 0; px < TILE_SIZE; px++) {
      const c = cols[px];
      if (c < 0) continue;
      const dbz = offset + raw.readUInt16BE(base + c * 2) * scale;
      if (!(dbz >= MIN_DBZ)) continue; // also rejects the -99 and -999 sentinels
      const o = out + px * 4;
      // The client reads this straight back as `red / 2 - 32`.
      const code = Math.round((dbz + 32) * 2);
      rgba[o] = code < 0 ? 0 : code > 255 ? 255 : code;
      rgba[o + 3] = 255;
    }
  }
  return encodePng(rgba, TILE_SIZE, TILE_SIZE);
}

/* --------------------------------------------------------------- queue ----- */

// Rendered tiles, keyed by stamp/z/x/y. A frame's content never changes once
// published, so a tile is true for as long as it is kept. This is the cache
// that matters: it is what stops a second viewer, a pan back, or the client's
// own refresh from decoding anything at all.
const tiles = new Map();
const MAX_TILES = 400; // ~10 MB at the size these come out

function rememberTile(key, png) {
  tiles.delete(key);
  tiles.set(key, png);
  while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
}

// Compressed frames waiting to be decoded. Small enough to hold a few of, which
// is what lets the network run ahead of the decoder.
const gzips = new Map();
const MAX_GZIPS = 8;
// How many frames the downloader runs ahead of the decoder. Fetching a frame
// and decoding it cost about the same, so with nothing in flight the queue
// spends half its time waiting on NCEP; a few in hand keeps the decoder fed and
// makes a cold loop decode-bound instead of round-trip-bound.
const PREFETCH = 5;

async function fetchGz(stamp) {
  const held = gzips.get(stamp);
  if (held) return held;
  const pending = (async () => {
    const res = await fetch(`${DIR}MRMS_MergedReflectivityQCComposite_00.50_${stamp}.grib2.gz`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`MRMS frame HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  })();
  gzips.set(stamp, pending);
  while (gzips.size > MAX_GZIPS) gzips.delete(gzips.keys().next().value);
  // A failure must not be remembered as though it were the file.
  pending.catch(() => gzips.delete(stamp));
  return pending;
}

// Tile requests that have not been drawn yet, grouped by the frame they need.
const waiting = new Map(); // stamp -> [{ z, x, y, key, resolve, reject }]
let draining = false;

/**
 * Draw every outstanding tile, one frame at a time.
 *
 * Grouping is the whole point. Leaflet asks for all thirty frames at once, so
 * serving tiles in arrival order would decode a 49 MB field, throw it away for
 * the next frame's tile, and decode it again when the first frame's second tile
 * turned up. Taking one frame at a time means each field is decoded exactly
 * once however many tiles are waiting on it, and only one is ever in memory.
 */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (waiting.size) {
      // Oldest request first, so a loop that is already loading finishes before
      // a later one starts rather than the two interleaving.
      const stamp = waiting.keys().next().value;
      let group = waiting.get(stamp);
      waiting.delete(stamp);

      // Let the network run ahead: while this frame decodes and draws, the next
      // few are already downloading.
      for (const next of [...waiting.keys()].slice(0, PREFETCH)) fetchGz(next).catch(() => {});

      let field = null;
      const t0 = Date.now();
      let fetched = 0;
      try {
        const gz = await fetchGz(stamp);
        fetched = Date.now() - t0;
        field = await decodeField(gz);
      } catch (err) {
        for (const t of group) t.reject(err);
        continue;
      }
      // Kept so the route can report it. A cold loop is thirty of these and the
      // split between waiting on NCEP and working on the grid decides what is
      // worth optimising — on a shared instance those are very different costs.
      const timing = { fetch: fetched, decode: Date.now() - t0 - fetched, render: 0 };
      // Tiles for this same frame that arrived while it was downloading and
      // decoding are drawn from the field already in hand. Without this a pan
      // or a zoom, which asks for its tiles a moment apart, would decode the
      // same 49 MB field once per tile.
      while (group) {
        for (const t of group) {
          try {
            const started = Date.now();
            const png = await renderTile(field, t.z, t.x, t.y);
            timing.render = Date.now() - started;
            rememberTile(t.key, png);
            t.resolve({ png, timing });
          } catch (err) {
            t.reject(err);
          }
        }
        group = waiting.get(stamp);
        waiting.delete(stamp);
      }
      // Before the next iteration, not after the loop: the point is that two of
      // these are never alive at once.
      field = null;
      gzips.delete(stamp);
    }
  } finally {
    draining = false;
  }
}

/**
 * One rendered tile, from cache if it has been drawn before. Resolves to the
 * PNG and, when it had to be made, how long each stage of making it took.
 */
export function getTile(stamp, z, x, y) {
  const key = `${stamp}/${z}/${x}/${y}`;
  const hit = tiles.get(key);
  if (hit) {
    rememberTile(key, hit); // touch, so a tile still in the loop is not evicted
    return Promise.resolve({ png: hit, timing: null });
  }
  return new Promise((resolve, reject) => {
    let group = waiting.get(stamp);
    if (!group) waiting.set(stamp, (group = []));
    group.push({ z, x, y, key, resolve, reject });
    drain();
  });
}

/* -------------------------------------------------------------- frames ----- */

/** An hour of two-minute frames, oldest first, or null if the feed is quiet. */
export async function mrmsFrames() {
  const stamps = await listStamps();
  if (!stamps.length) return null;
  const now = Date.now();
  const recent = stamps
    .map((stamp) => ({ stamp, ms: stampToMs(stamp) }))
    .filter((f) => Number.isFinite(f.ms) && now - f.ms < FRAME_SPAN_MS)
    .slice(-FRAME_COUNT);
  if (recent.length < 4) return null; // not enough to be a loop
  return recent.map(({ stamp, ms }) => ({
    time: Math.floor(ms / 1000),
    key: `mrms@${stamp}`,
    url: `/api/radar/mrms/${stamp}/{z}/{x}/{y}.png`,
  }));
}

export const MRMS_TILE = {
  tileSize: TILE_SIZE,
  // Leaflet measures the world in 256px tiles whatever `tileSize` says, so a
  // 512px layer covers it in half as many tiles across — tile indices one zoom
  // shallower than the map's. Without this the {z} in the URL would name one
  // zoom while {x}/{y} counted in another, and the radar would land on the
  // wrong part of the country.
  zoomOffset: -1,
  // Where the rendering stops and Leaflet's upscale takes over. The grid is
  // 0.01 degrees — about 1.1 km, which is one screen pixel at map zoom 7 — so
  // everything past that is already interpolation and the only question is who
  // does it. Stopping here matters more than it looks: a zoom that crosses into
  // a new tile set has to decode all thirty frames again, and above this the
  // map re-scales what it already holds instead.
  maxNativeZoom: 9,
  // ...but the map may still be taken well past it. Upscaled 1 km data is
  // exactly what the Iowa State mosaic was showing at its own deep zooms, so
  // holding MRMS to the two levels the global composite gets would be a real
  // loss of reach for no gain in honesty.
  zoomHeadroom: 6,
  paint: 'mrms',
};
