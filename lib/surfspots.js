// Named surf spots along the open coast.
//
// A surf report needs somewhere to be *about*, and the name matters as much as
// the coordinates: "Juno Beach Pier" or "Reef Road" is an answer, "26.79, -80.03"
// is not. OpenStreetMap has the names, but not under any single tag — a break is
// as likely to be mapped as a park, a pier or a headland as it is to carry
// `natural=beach` — and the tags alone cannot tell a surf beach from a lagoon
// shore. So this module casts a wide net for named things near the water and
// then leans on lib/coastline.js to throw back everything that is not on the
// open ocean.

import fs from 'node:fs';
import path from 'node:path';
import { bearingDegrees, cached, haversineMiles } from './util.js';
import { overpass } from './places.js';
import { oceanShoreline, snapToOcean } from './coastline.js';

/* --------------------------------------------------------------- baked --- */

// Spots worked out ahead of time and committed, so the common coasts need no
// Overpass call at request time. Regenerate with `node scripts/bake-surf-spots.js`.
const BAKED_FILE = path.join(process.cwd(), 'data', 'surf-spots.json');

let bakedCache;

function baked() {
  if (bakedCache !== undefined) return bakedCache;
  try {
    bakedCache = JSON.parse(fs.readFileSync(BAKED_FILE, 'utf8'));
  } catch {
    // Nothing baked is a perfectly ordinary state — every coast then falls
    // through to Overpass, which is what a dev machine does anyway.
    bakedCache = null;
  }
  return bakedCache;
}

/**
 * The baked pool covering this viewer, or null to go and ask Overpass.
 *
 * A region only counts as covering the request when the whole search circle
 * sits inside the area that was baked. Answering from a pool that stops short
 * would quietly drop the spots past its edge and look like a shorter coast
 * rather than like missing data.
 */
function bakedPool(lat, lon, miles) {
  const data = baked();
  if (!data?.regions?.length) return null;
  const covering = data.regions.find(
    (r) => haversineMiles(lat, lon, r.lat, r.lon) + miles <= r.miles,
  );
  if (!covering) return null;
  return data.spots;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

const MI_PER_DEG_LAT = 69.055;
const lonScale = (lat) => Math.max(0.1, Math.cos((lat * Math.PI) / 180) * 69.172);

// What a spot is mapped as, and how much that says about it being surf. A thing
// tagged for surfing is a surf spot by definition; a beach is one by default;
// everything else merely happens to be near the sea, and has to say something
// coastal in its name to earn a place.
const NAME_MUST_SAY_COAST = 90;

const KINDS = {
  surfing: { score: 110, snapMiles: 0.6 },
  beach: { score: 100, snapMiles: 0.6 },
  reef: { score: 70, snapMiles: 0.6 },
  cape: { score: 70, snapMiles: 0.6 },
  beach_resort: { score: 65, snapMiles: 0.5 },
  pier: { score: 60, snapMiles: 0.3 },
  nature_reserve: { score: 40, snapMiles: 0.3 },
  park: { score: 40, snapMiles: 0.3 },
};

// Words that make a generic feature read as a place you would surf. The strong
// ones match as prefixes, because the name of a break is as often "Seaview" or
// "Surfside" as it is two words; the weak ones have to stand alone, or "Head"
// picks up every Headquarters and "Bay" every Bayberry Lane.
const SEA_WORDS = new RegExp(
  '\\b(?:' +
    'beach|surf|ocean|sea|pier|inlet|cove|reef|dune|shore|strand|playa|praia|plage|spiaggia|jetty|jetties|boardwalk|cliff' +
    '|(?:point|bay|cape|head|bluff|sand|break|groyne|light|lighthouse)\\b' +
    ')',
  'i',
);

// ...and words that mean it is not, however close to the water it sits. Marinas
// and yacht basins in particular cluster around inlets, which are the one part
// of a lagoon that does have a clear line to open sea.
const NOT_SURF =
  /\b(marina|yacht|boat ?(ramp|yard|club)|dock|slip|ball ?field|little league|playground|sports? (complex|field)|golf|cemetery|memorial|amphitheat|garden|museum|library|school|plaza|square|greenway|canal|treatment|utility|parking)\b/i;

// A berth in a marina is named "Pier A" or "Pier 3". A pier people surf beside
// is named after the place it is at.
const BERTH = /^pier[ -]?[a-z0-9]$/i;

function gridKey(lat, lon) {
  return `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
}

/**
 * Rectangles covering the ocean shore, for asking about things beside it.
 *
 * The obvious query — everything within half a mile of a coastline way — is the
 * one Overpass is slowest at: buffering a few hundred miles of shoreline
 * geometry times out. Since we have already worked out where the ocean shore is,
 * naming a handful of boxes around it asks the same question in a form the
 * indexes can answer. Tiles are merged into runs first, or a straight coast
 * turns into sixty near-identical rectangles.
 */
const TILE_DEG = 0.04;

function shoreBoxes(shore) {
  const rows = new Map();
  for (const p of shore) {
    const ty = Math.floor(p.lat / TILE_DEG);
    const tx = Math.floor(p.lon / TILE_DEG);
    let row = rows.get(ty);
    if (!row) rows.set(ty, (row = new Set()));
    row.add(tx);
  }
  const boxes = [];
  for (const [ty, cols] of [...rows].sort((a, b) => a[0] - b[0])) {
    const sorted = [...cols].sort((a, b) => a - b);
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
        continue;
      }
      boxes.push({ ty, x0: start, x1: prev });
      start = prev = sorted[i];
    }
  }
  // Merge vertically adjacent runs that span the same columns.
  const merged = [];
  for (const b of boxes) {
    const up = merged.find((m) => m.x0 === b.x0 && m.x1 === b.x1 && m.ty1 + 1 === b.ty);
    if (up) up.ty1 = b.ty;
    else merged.push({ ...b, ty1: b.ty });
  }
  return merged.map((m) =>
    [m.ty * TILE_DEG, m.x0 * TILE_DEG, (m.ty1 + 1) * TILE_DEG, (m.x1 + 1) * TILE_DEG]
      .map((n) => n.toFixed(4))
      .join(','),
  );
}

/**
 * Named candidates beside the ocean shore.
 *
 * Every clause is confined to the shore boxes, including the ones looking for
 * beaches. Asking for those across the whole search area is the intuitive thing
 * to do and costs about thirty seconds per tag: a degree-square bbox is a lot of
 * map, and Overpass charges for the area whether or not anything matches. Since
 * a candidate has to snap to the ocean shore to survive anyway, the wider search
 * could only ever have turned up rows we were going to throw away.
 *
 * Tags are grouped into value regexes for the same reason — each clause is
 * charged separately, so four cost a quarter of what sixteen do.
 */
async function candidates(shore) {
  const query =
    '[out:json][timeout:90];(' +
    shoreBoxes(shore)
      .flatMap((b) => [
        `nw["name"]["natural"~"^(beach|reef|cape)$"](${b});`,
        `nw["name"]["leisure"~"^(park|nature_reserve|beach_resort)$"](${b});`,
        `nw["name"]["man_made"="pier"](${b});`,
        `nw["name"]["surfing"](${b});`,
        `nw["name"]["sport"="surfing"](${b});`,
      ])
      .join('') +
    ');out center 900;';

  const data = await overpass(query, { timeout: 45000 });
  const out = [];
  for (const e of data.elements || []) {
    const p = e.center || e;
    const t = e.tags || {};
    if (!t.name || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    // A surf shop, surf school or board hire is tagged for surfing too, and sits
    // right behind the beach. It is a shop. Anything else keeps its place: a
    // break mapped as a beach club is still where the break is.
    if (t.shop || t.office || t.craft || t.tourism === 'hotel') continue;
    const kind =
      t.sport === 'surfing' || t.surfing
        ? 'surfing'
        : t.natural === 'beach' || t.natural === 'reef' || t.natural === 'cape'
          ? t.natural
          : t.leisure === 'beach_resort' || t.leisure === 'nature_reserve' || t.leisure === 'park'
            ? t.leisure
            : t.man_made === 'pier'
              ? 'pier'
              : null;
    if (!kind) continue;
    out.push({ name: t.name.trim(), lat: p.lat, lon: p.lon, kind });
  }
  return out;
}

/** Merge spots that name the same stretch of sand, keeping the better name. */
function dedupe(spots, clusterMiles) {
  const kept = [];
  for (const s of spots.slice().sort((a, b) => b.score - a.score)) {
    if (kept.some((k) => haversineMiles(k.lat, k.lon, s.lat, s.lon) < clusterMiles)) continue;
    kept.push(s);
  }
  return kept;
}

/**
 * Sort spots along the coast rather than by distance from the viewer.
 *
 * The pills either side of the nearest spot are "up the coast" and "down the
 * coast", which is only the same thing as north and south on a coast that runs
 * that way. Fitting a line through the spots (the principal axis of the cloud)
 * gives the local trend of the shore, whichever way it runs, and projecting
 * onto it puts them in the order you would drive them.
 */
function alongShore(spots) {
  if (spots.length < 2) return { sorted: spots, axisBearing: 0 };
  const lat0 = spots.reduce((a, s) => a + s.lat, 0) / spots.length;
  const lon0 = spots.reduce((a, s) => a + s.lon, 0) / spots.length;
  const kx = lonScale(lat0);

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const s of spots) {
    const x = (s.lon - lon0) * kx;
    const y = (s.lat - lat0) * MI_PER_DEG_LAT;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  // Principal axis of the 2x2 covariance matrix.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ax = Math.cos(angle);
  let ay = Math.sin(angle);
  // Point the axis at the northern (or, for an east-west coast, eastern) end so
  // "forward" along it is a direction we can put a compass label on.
  if (ay < 0 || (ay === 0 && ax < 0)) {
    ax = -ax;
    ay = -ay;
  }

  const sorted = spots
    .map((s) => ({ ...s, along: ((s.lon - lon0) * kx * ax + (s.lat - lat0) * MI_PER_DEG_LAT * ay) }))
    .sort((a, b) => a.along - b.along);

  return { sorted, axisBearing: (((Math.atan2(ax, ay) * 180) / Math.PI) + 360) % 360 };
}

/**
 * Named surf spots on the open coast near a point, ordered along the shore.
 *
 * Everything here is cached for a week and shared across a ~7 mile grid: it is
 * two Overpass queries and a few hundred thousand ray tests, and none of the
 * answer changes between requests.
 */
export async function spotPool(lat, lon, { miles = 30, clusterMiles = 0.75 } = {}) {
  {
    // Sequential, because the second query only asks about the boxes the first
    // one turned up. The coastline is the cheap half.
    //
    // Neither call is wrapped in a catch: a failed Overpass query has to be
    // allowed to throw past `cached` so it is not stored, or one busy minute
    // leaves an inland-looking answer in place for a week. An empty result that
    // came back cleanly — a landlocked location — is worth caching.
    const shore = await oceanShoreline(lat, lon, miles);
    if (!shore.ocean.length) return [];
    const found = await candidates(shore.ocean);
    if (!found.length) return [];

    const scored = [];
    for (const c of found) {
      if (NOT_SURF.test(c.name) || BERTH.test(c.name)) continue;
      const kind = KINDS[c.kind];
      // A generic park or pier has to say something coastal in its name; being
      // near the sea is not enough, or every waterfront lawn and coastguard
      // jetty becomes a break.
      const named = SEA_WORDS.test(c.name);
      if (!named && kind.score < NAME_MUST_SAY_COAST) continue;
      // A park called Seaview is allowed to reach a little further to find the
      // water than one called Memorial: on a narrow barrier island the polygon's
      // centre sits mid-island, half a mile from the beach it is named after.
      const snapped = snapToOcean(shore, c.lat, c.lon, kind.snapMiles + (named ? 0.2 : 0));
      if (!snapped) continue;
      scored.push({
        name: c.name,
        kind: c.kind,
        // The shoreline point, not the feature centroid: a park polygon's centre
        // can sit a quarter mile inland, which is a land cell to the wave model.
        lat: snapped.lat,
        lon: snapped.lon,
        seaward: snapped.seaward,
        score: kind.score + (named ? 25 : 0) - snapped.snapMiles * 10,
      });
    }

    return dedupe(scored, clusterMiles);
  }
}

/**
 * Shape a pool of spots into the answer for one viewer.
 *
 * Clipped to the radius asked for: the coastline behind the pool is gathered
 * from a much wider box — the rays need land beyond the search area to run into
 * — and without this the list off West Palm Beach runs on across the Straits of
 * Florida and into the Bahamas.
 */
function shapeFor(pool, lat, lon, miles) {
  const within = pool.filter((s) => haversineMiles(lat, lon, s.lat, s.lon) <= miles);
  const { sorted, axisBearing } = alongShore(within);
  return { spots: sorted.map(({ score, along, ...s }) => s), axisBearing };
}

export async function surfSpots(lat, lon, { miles = 30, clusterMiles = 0.75 } = {}) {
  // Baked data first, and no network at all when it covers the viewer. Overpass
  // allows two concurrent queries per IP, which on a shared host — Render's free
  // instances all share an egress address — are already spoken for by somebody
  // else, so the live site could not reach it at all. See scripts/bake-surf-spots.js.
  const baked = bakedPool(lat, lon, miles);
  if (baked) return shapeFor(baked, lat, lon, miles);

  return cached(`surfspots:${gridKey(lat, lon)}:${miles}`, WEEK, async () => {
    const pool = await spotPool(lat, lon, { miles, clusterMiles });
    return shapeFor(pool, lat, lon, miles);
    // `unavailable` keeps "you are inland" apart from "Overpass was busy". They
    // are the same empty list, and telling a surfer on the coast that there is
    // no beach near them is a worse answer than admitting the lookup failed.
  }).catch(() => ({ spots: [], axisBearing: 0, unavailable: true }));
}

/**
 * What to call the two ends of the coast.
 *
 * The list runs up the principal axis, which on most coasts is close enough to
 * north-south to say so, and on the Gulf or the south side of Long Island is
 * not. Naming the ends after the axis keeps the pills honest either way.
 */
export function shoreEnds(axisBearing) {
  const northish = Math.abs(Math.cos((axisBearing * Math.PI) / 180)) >= Math.SQRT1_2;
  return northish ? { forward: 'North', back: 'South' } : { forward: 'East', back: 'West' };
}

/** The nearest listed spot to a point, with its index in the along-shore list. */
export function nearestSpot(spots, lat, lon) {
  let index = -1;
  let best = Infinity;
  spots.forEach((s, i) => {
    const d = haversineMiles(lat, lon, s.lat, s.lon);
    if (d < best) {
      best = d;
      index = i;
    }
  });
  if (index < 0) return null;
  return {
    ...spots[index],
    index,
    distanceMiles: Math.round(best * 10) / 10,
    bearingDeg: Math.round(bearingDegrees(lat, lon, spots[index].lat, spots[index].lon)),
  };
}
