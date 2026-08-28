// Which way the weather is travelling, read off the frames themselves.
//
// The loop needs this so it can carry a frame forward between scans instead of
// dissolving into the next one where it stands. Without it two frames five
// minutes apart are two copies of the same storm about seven screen pixels
// apart at zoom 8 — dissolving between them reads as a shadow, not as movement.
//
// It is measured over the *whole* hour, oldest frame against newest, and then
// divided down. That is not an optimisation, it is the only way it works: over
// a single five-minute gap the displacement is well under a pixel at the tile
// resolutions involved and the correlation surface is flat enough that the peak
// is noise. Over an hour the same storms have moved far enough to correlate
// cleanly — measured 52 km/h across the upper Midwest, 28 km/h over the Plains.
//
// Everything here is deliberately happy to return null. A wrong vector slides
// the entire picture the wrong way, which is worse than the shadow it replaces,
// so a weak match is discarded rather than used.

import { SIGNATURE_GRID as G } from './radar-tiles.js';

// Cells of shift to search, either way. It is a ceiling rather than a fixed
// radius: the search is also held to a fraction of the grid it runs on, so that
// even the furthest shift tested still has most of both frames overlapping.
const SEARCH_MAX = 10;
const SEARCH_FRACTION = 0.3;
// Smallest grid worth correlating at all, in cells. One 512px tile reduces to a
// 32-cell signature, and a single tile is what the radar map holds at most
// phone sizes — so this has to sit below 32 or the common case never runs.
const MIN_GRID = 24;
// A shift is only believable if the two frames still substantially overlap at
// it; correlating a sliver against a sliver finds a strong match in noise.
const MIN_OVERLAP = 0.4;
// What makes a match believable is how strongly the two frames resemble each
// other once shifted — *not* how much that beats not shifting at all. Measured
// against live feeds, the clear-air layer over Florida had the largest
// improvement-over-still of anything tested (0.109) while being the one case
// that must be thrown away; its peak correlation was only 0.333, against 0.432
// and 0.545 for two regions of real rain. So the peak carries the decision and
// the improvement is only asked to be non-trivial.
const MIN_PEAK = 0.4;
const MIN_GAIN = 0.004;
const MIN_ECHO = 0.004; // mean coverage below this is empty sky
const MAX_TILES = 16; // bound on the work, in tiles per frame

/** Tiles both frames have painted, at whichever zoom has the most of them. */
function commonTiles(a, b) {
  const byZoom = new Map();
  for (const key of a.keys()) {
    if (!b.has(key)) continue;
    const [z, x, y] = key.split('/').map(Number);
    if (!Number.isFinite(z)) continue;
    let list = byZoom.get(z);
    if (!list) byZoom.set(z, (list = []));
    list.push({ key, x, y });
  }
  let best = null;
  for (const [z, list] of byZoom) {
    if (!best || list.length > best.tiles.length) best = { z, tiles: list };
  }
  return best;
}

/** The tiles' signatures laid out side by side as one grid. */
function assemble(tiles, sigs, minX, minY, w, h) {
  const grid = new Float32Array(w * h);
  for (const t of tiles) {
    const sig = sigs.get(t.key);
    if (!sig) continue;
    const ox = (t.x - minX) * G;
    const oy = (t.y - minY) * G;
    for (let cy = 0; cy < G; cy++) {
      for (let cx = 0; cx < G; cx++) {
        grid[(oy + cy) * w + ox + cx] = sig[cy * G + cx];
      }
    }
  }
  return grid;
}

/**
 * Normalised cross-correlation of `b` shifted by (dx, dy) against `a`, taken
 * over the region the two actually share at that shift.
 *
 * Correlating over a fixed interior instead — the whole grid less the search
 * radius on every side, so that one window suits every shift — is what used to
 * make this unusable on a small map. It throws away a border `SEARCH_MAX` cells
 * deep whatever the shift, which on the 32-cell grid a single tile produces is
 * two thirds of the picture, and it forced a guard demanding a grid wide enough
 * to spare that border twice over. The radar map is one tile at most phone
 * sizes, so the guard rejected the common case and the loop never advected at
 * all. Per-shift overlap uses everything the pair has in common.
 */
function ncc(a, b, w, h, dx, dy) {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const va = a[y * w + x];
      const vb = b[(y + dy) * w + (x + dx)];
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n++;
    }
  }
  if (n === 0) return 0;
  const ca = saa - (sa * sa) / n;
  const cb = sbb - (sb * sb) / n;
  const cab = sab - (sa * sb) / n;
  const d = Math.sqrt(ca * cb);
  return d > 1e-9 ? cab / d : 0;
}

/** Sub-cell peak position from the three samples around it. */
function refine(low, mid, high) {
  const d = low - 2 * mid + high;
  if (Math.abs(d) < 1e-9) return 0;
  const off = (0.5 * (low - high)) / d;
  return Math.abs(off) <= 1 ? off : 0;
}

/**
 * Displacement from frame `a` to frame `b`, in tile-grid cells. Null whenever
 * the answer would not be trustworthy: too little overlap, too little echo, or
 * a correlation peak that barely beats not moving at all.
 */
export function estimateShift(a, b) {
  if (!a?._signatures || !b?._signatures) return null;
  const common = commonTiles(a._signatures, b._signatures);
  if (!common?.tiles.length) return null;
  const { z, tiles } = common;

  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = (Math.max(...xs) - minX + 1) * G;
  const h = (Math.max(...ys) - minY + 1) * G;
  // Enough grid to correlate over, and a sane amount of work. Refusing is
  // cheap in the sense that nothing breaks — but it is not free: the loop then
  // dissolves each frame where it stands instead of carrying it, and that reads
  // as the picture skipping rather than moving. So the bar is the smallest one
  // the maths genuinely needs, not a comfortable margin above it.
  if (Math.min(w, h) < MIN_GRID || tiles.length > MAX_TILES) return null;

  // Held to a fraction of the grid so the furthest shift tested still overlaps
  // its partner across most of the frame. On a one-tile grid that is nine cells
  // either way, which at a 512px tile is a little over half the map — far more
  // drift than an hour of weather produces at any zoom this map opens at.
  const search = Math.max(3, Math.min(SEARCH_MAX, Math.floor(Math.min(w, h) * SEARCH_FRACTION)));

  const ga = assemble(tiles, a._signatures, minX, minY, w, h);
  const gb = assemble(tiles, b._signatures, minX, minY, w, h);

  let echo = 0;
  for (let i = 0; i < ga.length; i++) echo += ga[i] + gb[i];
  if (echo / (2 * ga.length) < MIN_ECHO) return null;

  const still = ncc(ga, gb, w, h, 0, 0);
  const full = w * h;
  let best = { r: -2, dx: 0, dy: 0 };
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      if ((w - Math.abs(dx)) * (h - Math.abs(dy)) < MIN_OVERLAP * full) continue;
      const r = ncc(ga, gb, w, h, dx, dy);
      if (r > best.r) best = { r, dx, dy };
    }
  }
  if (best.r < MIN_PEAK || best.r - still < MIN_GAIN) return null;
  // A peak hard against the edge of the search means the real one is outside it.
  if (Math.abs(best.dx) === search || Math.abs(best.dy) === search) return null;

  const dxr = refine(
    ncc(ga, gb, w, h, best.dx - 1, best.dy),
    best.r,
    ncc(ga, gb, w, h, best.dx + 1, best.dy),
  );
  const dyr = refine(
    ncc(ga, gb, w, h, best.dx, best.dy - 1),
    best.r,
    ncc(ga, gb, w, h, best.dx, best.dy + 1),
  );

  // `z` travels with the answer because the cells are tile-grid cells: the
  // caller has to know which zoom they were measured at to turn them into
  // screen pixels, and Leaflet may have clamped the tile zoom below the map's.
  return { dx: best.dx + dxr, dy: best.dy + dyr, z, gain: best.r - still };
}
