// Which stretches of shoreline face the open ocean.
//
// Asking OpenStreetMap for beaches near a point is easy; the hard part is that
// most of them are not surf. In West Palm Beach the nearest thing tagged
// `natural=beach` is on the Intracoastal, a few hundred yards of flat lagoon
// water behind a barrier island, and the marine model happily reports the
// Atlantic swell for it because the nearest wet grid cell it can find is on the
// other side of the island. Lakes, bays, harbours and rivers all fail the same
// way. Nothing in the forecast APIs can tell them apart.
//
// The coastline geometry can. OSM's `natural=coastline` ways are the mean
// high-water line, and they carry a convention that is rigidly enforced because
// the whole world's sea rendering depends on it: **the way runs with land on
// the left and water on the right**. That gives every point on the shore a
// direction that points out to sea. Fire a ray that way, and a beach on the
// open coast reaches the edge of the map without touching land, while a lagoon
// shore runs into the back of the barrier island within a mile.
//
// So: pull the coastline once per region, resample it, work out which samples
// have open water in front of them, and cache the answer for a week. Coastlines
// do not move, and this is the only question the surf section cannot answer any
// other way.

import { bearingDegrees, cached, haversineMiles, offsetMiles } from './util.js';
import { overpass } from './places.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const MI_PER_DEG_LAT = 69.055;
const lonScale = (lat) => Math.max(0.1, Math.cos(rad(lat)) * 69.172);

/** How far apart to place the shoreline samples we classify and snap onto. */
const SAMPLE_MILES = 0.25;

// How far along the shore to look when deciding which way is out to sea. A
// single segment is far too local: a jetty, a groyne or a surveyed wiggle points
// its own way, and the ray then fires off down the beach or straight inland.
// Averaging over a mile of shore either side smooths that out without blurring
// real headlands.
const SMOOTH_STEPS = 4;

// The ray. It has to outrun the largest body of water that is not the sea: a
// dozen miles clears any lagoon or river mouth, but Tampa Bay runs thirty miles
// end to end and passes for open ocean at anything shorter. It starts a third of
// a mile out so it does not immediately re-cross the shore it began on.
//
// A very long enclosed sound can still slip through. That is the accepted limit
// of this test: it settles lagoons, harbours, rivers and ordinary bays, which is
// what actually goes wrong when someone asks for their nearest surf.
const RAY_MILES = 40;
const SKIP_MILES = 0.35;

// Bearings tried, as offsets from the way the shore faces. The fan is wide
// because a beach that faces along a bay mouth rather than straight out of it
// still gets ocean swell — Santa Cruz Main Beach looks south into Monterey Bay
// and only escapes to the Pacific thirty degrees off that. But it is a fan and
// not the whole compass: inside a harbour mouth there is usually some bearing
// that threads the gap, and the shore there faces the wrong way entirely.
const FAN_OFFSETS = [0, -30, 30, -60, 60];

/* ------------------------------------------------------------ geometry --- */

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** Do segments p1p2 and p3p4 properly cross? */
function segsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y);
  const d2 = cross(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y);
  const d3 = cross(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y);
  const d4 = cross(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Walk a polyline emitting a point every `step` miles. */
function resample(geometry, step) {
  const out = [];
  let carry = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const len = haversineMiles(a.lat, a.lon, b.lat, b.lon);
    if (!len) continue;
    let d = carry;
    while (d < len) {
      const t = d / len;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      d += step;
    }
    carry = d - len;
  }
  return out;
}

/* --------------------------------------------------------------- index --- */

// A ray crosses a handful of these cells, so it only ever tests the few hundred
// segments near its own path instead of every segment in the region.
const CELL_DEG = 0.02;

function buildIndex(ways) {
  const segs = [];
  for (const way of ways) {
    const g = way.geometry || [];
    for (let i = 1; i < g.length; i++) {
      const a = { x: g[i - 1].lon, y: g[i - 1].lat };
      const b = { x: g[i].lon, y: g[i].lat };
      if (a.x === b.x && a.y === b.y) continue;
      segs.push({ a, b });
    }
  }
  const grid = new Map();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL_DEG);
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL_DEG);
    const y0 = Math.floor(Math.min(s.a.y, s.b.y) / CELL_DEG);
    const y1 = Math.floor(Math.max(s.a.y, s.b.y) / CELL_DEG);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(i);
      }
    }
  });
  return { segs, grid };
}

/**
 * Does the shot from p1 to p2 cross land?
 *
 * Walks the grid along the ray rather than taking every cell in its bounding
 * box: a twenty-five mile ray spans a few hundred cells cornerwise but passes
 * through only a few dozen, and this runs for every bearing at every sample.
 */
function crossesCoast(index, p1, p2) {
  const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (CELL_DEG / 3)));
  const seen = new Set();
  let lastKey = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.floor((p1.x + (p2.x - p1.x) * t) / CELL_DEG);
    const cy = Math.floor((p1.y + (p2.y - p1.y) * t) / CELL_DEG);
    const key = `${cx},${cy}`;
    if (key === lastKey) continue;
    lastKey = key;
    const bucket = index.grid.get(key);
    if (!bucket) continue;
    for (const j of bucket) {
      if (seen.has(j)) continue;
      seen.add(j);
      const s = index.segs[j];
      if (segsIntersect(p1, p2, s.a, s.b)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------- open water --- */

/** Grid of shore samples, for finding the shoreline nearest an offshore point. */
function buildPointIndex(points) {
  const grid = new Map();
  points.forEach((p, i) => {
    const key = `${Math.floor(p.lat / CELL_DEG)},${Math.floor(p.lon / CELL_DEG)}`;
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(i);
  });
  return grid;
}

/**
 * Is this point out at sea, rather than inland?
 *
 * A clear ray only says nothing was in the way, and a shot fired inland from a
 * lagoon meets no coastline at all — which is how a beach on the Intracoastal
 * comes to look like it has twenty-five miles of open water in front of it. The
 * winding convention settles it: find the nearest piece of shore, and see
 * whether the point lies on the water side of it or the land side. Read at the
 * far end of the ray this is a reliable question to ask, because the shoreline
 * nearest a point well offshore is a plain stretch of open coast rather than the
 * back of some inlet.
 */
function isSeaward(grid, points, lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  let foundAtRing = -1;
  const cy = Math.floor(lat / CELL_DEG);
  const cx = Math.floor(lon / CELL_DEG);
  for (let ring = 0; ring < 40; ring++) {
    // Stop one ring after the first hit: the true nearest can sit just over the
    // cell boundary, but nothing beyond the next ring can beat it.
    if (foundAtRing >= 0 && ring > foundAtRing + 1) break;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the newly added edge of the ring.
        if (ring && Math.abs(dy) !== ring && Math.abs(dx) !== ring) continue;
        for (const i of grid.get(`${cy + dy},${cx + dx}`) || []) {
          const d = haversineMiles(lat, lon, points[i].lat, points[i].lon);
          if (d < bestDistance) {
            bestDistance = d;
            best = points[i];
            if (foundAtRing < 0) foundAtRing = ring;
          }
        }
      }
    }
  }
  if (!best) return false;
  const toPoint = bearingDegrees(best.lat, best.lon, lat, lon);
  const off = Math.abs(((toPoint - best.seaward + 540) % 360) - 180);
  return off < 90;
}

/** A shot from the shore that reaches open sea without touching land. */
function escapesToSea(index, shoreGrid, shorePoints, lat, lon, bearing) {
  const near = offsetMiles(lat, lon, SKIP_MILES, bearing);
  const far = offsetMiles(lat, lon, RAY_MILES, bearing);
  if (crossesCoast(index, { x: near.lon, y: near.lat }, { x: far.lon, y: far.lat })) return false;
  return isSeaward(shoreGrid, shorePoints, far.lat, far.lon);
}

// An inlet, a harbour mouth or a river entrance is open to the sea by every test
// above — that is what makes it an inlet — so the docks a quarter mile inside one
// come back looking like beachfront. What gives them away is which way they
// face: the shore inside a channel looks across it, at right angles to the coast
// on either side. Anything pointing more than this far from the run of the local
// coast is water's edge, but it is not a beach.
const COHERENCE_DEGREES = 60;
const COHERENCE_RADIUS_MILES = 3;

/** Drop ocean points that face across the grain of the coast around them. */
function coherentOnly(points) {
  const cellDeg = COHERENCE_RADIUS_MILES / MI_PER_DEG_LAT;
  const grid = new Map();
  points.forEach((p, i) => {
    const key = `${Math.floor(p.lat / cellDeg)},${Math.floor(p.lon / cellDeg)}`;
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(i);
  });

  return points.filter((p) => {
    const cy = Math.floor(p.lat / cellDeg);
    const cx = Math.floor(p.lon / cellDeg);
    let sx = 0;
    let sy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of grid.get(`${cy + dy},${cx + dx}`) || []) {
          const q = points[i];
          if (haversineMiles(p.lat, p.lon, q.lat, q.lon) > COHERENCE_RADIUS_MILES) continue;
          // Sum as unit vectors; averaging bearings as numbers breaks at north.
          sx += Math.cos(rad(q.seaward));
          sy += Math.sin(rad(q.seaward));
        }
      }
    }
    if (!sx && !sy) return true;
    const mean = deg(Math.atan2(sy, sx));
    return Math.abs(((p.seaward - mean + 540) % 360) - 180) <= COHERENCE_DEGREES;
  });
}

// The open coast is continuous: a surf beach is part of miles of shoreline all
// facing the same sea. An islet in a sound, a spoil bank or a jetty head is not,
// and a couple of those slip through the ray test wherever the water behind a
// barrier island is wide enough. Requiring a run of this much connected ocean
// shore is what tells them apart.
const MIN_RUN_MILES = 3;
const RUN_LINK_MILES = 0.45; // consecutive samples are SAMPLE_MILES apart

/** Drop ocean points that are not part of a long connected stretch of coast. */
function longRunsOnly(points) {
  const cell = new Map();
  const key = (lat, lon) => `${Math.round(lat / 0.008)},${Math.round(lon / 0.008)}`;
  points.forEach((p, i) => {
    const k = key(p.lat, p.lon);
    let bucket = cell.get(k);
    if (!bucket) cell.set(k, (bucket = []));
    bucket.push(i);
  });

  const seen = new Uint8Array(points.length);
  const kept = [];
  const minPoints = Math.round(MIN_RUN_MILES / SAMPLE_MILES);
  for (let start = 0; start < points.length; start++) {
    if (seen[start]) continue;
    const run = [start];
    seen[start] = 1;
    for (let head = 0; head < run.length; head++) {
      const p = points[run[head]];
      const cy = Math.round(p.lat / 0.008);
      const cx = Math.round(p.lon / 0.008);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of cell.get(`${cy + dy},${cx + dx}`) || []) {
            if (seen[j]) continue;
            if (haversineMiles(p.lat, p.lon, points[j].lat, points[j].lon) > RUN_LINK_MILES) continue;
            seen[j] = 1;
            run.push(j);
          }
        }
      }
    }
    if (run.length >= minPoints) for (const i of run) kept.push(points[i]);
  }
  return kept;
}

/** Resampled shore points carrying the compass bearing of the water in front. */
function shorelinePoints(ways) {
  const out = [];
  for (const way of ways) {
    const pts = resample(way.geometry || [], SAMPLE_MILES);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - SMOOTH_STEPS)];
      const b = pts[Math.min(pts.length - 1, i + SMOOTH_STEPS)];
      if (a === b) continue;
      const dx = (b.lon - a.lon) * lonScale(pts[i].lat);
      const dy = (b.lat - a.lat) * MI_PER_DEG_LAT;
      if (!dx && !dy) continue;
      // The right-hand normal of the direction of travel is the water side.
      out.push({ ...pts[i], seaward: (deg(Math.atan2(dy, -dx)) + 360) % 360 });
    }
  }
  return out;
}

/** A lon,lat,lon,lat Overpass bbox (south,west,north,east) padded by `miles`. */
function bbox(lat, lon, miles) {
  const dLat = miles / MI_PER_DEG_LAT;
  const dLon = miles / lonScale(lat);
  return [
    Math.max(-90, lat - dLat),
    Math.max(-180, lon - dLon),
    Math.min(90, lat + dLat),
    Math.min(180, lon + dLon),
  ]
    .map((n) => n.toFixed(4))
    .join(',');
}

/** ~7 mile grid, so nearby lookups share one cached coastline. */
function gridKey(lat, lon) {
  return `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
}

/**
 * Ocean-facing shore points within `miles` of a location.
 *
 * The fetched box is padded past the search radius so that rays fired from its
 * far edge still have land to run into — without the padding, the coastline
 * simply stops and every ray near the edge looks like open water.
 *
 * Throws if Overpass could not be reached, and deliberately does not catch:
 * "there is no coastline here" is an answer worth remembering for a week, but
 * "the server was busy" is not, and the two are indistinguishable once one has
 * been turned into an empty list. Callers handle the throw.
 */
export async function oceanShoreline(lat, lon, miles) {
  return cached(`coastline:${gridKey(lat, lon)}:${miles}`, WEEK, async () => {
    const box = bbox(lat, lon, miles + RAY_MILES + 5);
    const data = await overpass(`[out:json][timeout:90];way["natural"="coastline"](${box});out geom;`, {
      timeout: 45000,
    });
    const ways = (data.elements || []).filter((e) => e.geometry?.length > 1);
    // Same shape as the answer below, even when there is nothing to say. An
    // inland box has no coastline in it at all, and handing back a bare array
    // here threw on `shore.ocean` — which `surfSpots` could only read as a
    // failed lookup, so every inland request re-queried Overpass and told the
    // user the map service was down rather than that they are nowhere near the
    // sea.
    if (!ways.length) return { ocean: [], all: [] };

    const index = buildIndex(ways);
    const all = shorelinePoints(ways);
    const shoreIndex = buildPointIndex(all);
    const ocean = [];
    for (const p of all) {
      // Straight out to sea is tried first — on an ordinary open beach that is
      // the shot that works, and the rest of the fan is never fired.
      const escapes = FAN_OFFSETS.some((off) =>
        escapesToSea(index, shoreIndex, all, p.lat, p.lon, (p.seaward + off + 360) % 360),
      );
      if (escapes) ocean.push(p);
    }
    // The sheltered shore is kept as well: knowing where the *nearest* water is,
    // and not only where the nearest sea is, is what tells a beach on the ocean
    // from one on the lagoon behind it.
    return { ocean: longRunsOnly(coherentOnly(ocean)), all };
  });
}

function nearest(points, lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  for (const p of points) {
    const d = haversineMiles(lat, lon, p.lat, p.lon);
    if (d < bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  return best ? { ...best, snapMiles: bestDistance } : null;
}

// How much further the sea is allowed to be than the nearest water of any kind
// before we call a place sheltered rather than coastal.
const SHELTER_MARGIN_MILES = 0.25;

/**
 * Put a named feature on the ocean shore, or reject it.
 *
 * Snapping matters because a park polygon's centre can sit a quarter mile
 * inland, which is a land cell to the wave model — the report has to be run for
 * a point in the water. But snapping alone will happily drag a lagoon beach
 * across a barrier island and hang its name on the surf break the other side,
 * which is how "Summa Beach", a few hundred yards of flat Intracoastal water,
 * came to stand in for the Atlantic at West Palm Beach. So a feature also has to
 * be no further from the sea than it is from any other shore: if it is sitting
 * on the back side of an island, it belongs to the back side.
 */
export function snapToOcean(shore, lat, lon, maxMiles) {
  const sea = nearest(shore.ocean, lat, lon);
  if (!sea || sea.snapMiles > maxMiles) return null;
  const any = nearest(shore.all, lat, lon);
  if (any && sea.snapMiles > any.snapMiles + SHELTER_MARGIN_MILES) return null;
  return sea;
}
