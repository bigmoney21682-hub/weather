// Named places from OpenStreetMap, via the Overpass API.
//
// The surf section needs two things no forecast API can answer: "where is the
// nearest beach to here?" and "what town is that swell breaking in front of?".
// Overpass answers both straight from OSM tags — including for points sitting
// out in open water, where ordinary reverse geocoders return nothing.
//
// Overpass is a shared volunteer service, so lookups are rounded onto a coarse
// grid and cached for a week. Coastlines do not move.

import { cached, fetchJSON, haversineMiles } from './util.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const WEEK = 7 * 24 * 60 * 60 * 1000;

async function overpass(query) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      // GET keeps this inside fetchJSON's timeout/retry handling.
      // Overpass answers a warm query in seconds; a slow one means we are being
      // throttled, and waiting longer almost never turns that around. Better to
      // give up and let the caller render without the label.
      const data = await fetchJSON(`${endpoint}?data=${encodeURIComponent(query)}`, { timeout: 12000, retries: 0 });
      // An over-budget query still answers 200, with an empty element list and
      // a remark. Treating that as "no results" would cache the emptiness.
      if (data?.remark) throw new Error(data.remark);
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** ~3.5 mile grid, so every lookup in a neighbourhood shares one cache entry. */
function gridKey(lat, lon) {
  return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;
}

/** Flatten Overpass elements to plain points. Ways come back as `center`. */
function points(elements) {
  const out = [];
  for (const e of elements || []) {
    const p = e.center || e;
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    out.push({ lat: p.lat, lon: p.lon, name: e.tags?.name || null, kind: e.tags?.place || e.tags?.natural || null });
  }
  return out;
}

/** Measure a cached point list against the caller's exact position. */
function byDistance(list, lat, lon) {
  return list
    .map((p) => ({ ...p, distanceMiles: Math.round(haversineMiles(lat, lon, p.lat, p.lon) * 10) / 10 }))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

const around = (miles, lat, lon) => `around:${Math.round(miles * 1609.34)},${lat},${lon}`;

// Widening squares to search for a beach in. Small first: it keeps the result
// set relevant, and almost everyone near the water stops on the first pass.
export const BEACH_RINGS = [25, 75, 160];

/** A lon,lat,lon,lat box roughly `miles` in every direction from a point. */
function viewbox(lat, lon, miles) {
  const dLat = miles / 69;
  const dLon = miles / Math.max(1, 69 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(3)).join(',');
}

/**
 * Named beaches within `miles` of a point, nearest first.
 *
 * Nominatim's free-text search matches the OSM feature class as well as the
 * name, so "beach" finds a Praia and a Playa too — and it answers in well under
 * a second, where the equivalent Overpass area query takes tens of seconds.
 * Overpass is kept as the backstop for coasts Nominatim comes up empty on.
 */
export async function beachesWithin(lat, lon, miles, { limit = 12 } = {}) {
  const found = await cached(`beaches:${gridKey(lat, lon)}:${miles}`, WEEK, async () => {
    const url =
      'https://nominatim.openstreetmap.org/search?q=beach&format=jsonv2&limit=40&bounded=1' +
      `&viewbox=${viewbox(lat, lon, miles)}`;
    const hits = await fetchJSON(url, { timeout: 15000 }).catch(() => null);
    const named = (hits || [])
      .filter((h) => h.type === 'beach' && h.name)
      .map((h) => ({ lat: Number(h.lat), lon: Number(h.lon), name: h.name, kind: 'beach' }));
    if (named.length) return named;

    const box = around(miles, lat, lon);
    const query =
      '[out:json][timeout:20];(' +
      `node["natural"="beach"]["name"](${box});` +
      `way["natural"="beach"]["name"](${box});` +
      ');out center 60;';
    return points((await overpass(query)).elements);
  }).catch(() => null);

  return found?.length ? byDistance(found, lat, lon).slice(0, limit) : [];
}

/**
 * The nearest city, town or village — used to put a name on the point where the
 * biggest waves are, which is usually a few miles offshore.
 */
export async function nearestCity(lat, lon, { maxMiles = 60 } = {}) {
  const key = `city:${gridKey(lat, lon)}:${maxMiles}`;
  const found = await cached(key, WEEK, async () => {
    const query =
      '[out:json][timeout:20];' +
      `node["place"~"^(city|town|village)$"]["name"](${around(maxMiles, lat, lon)});` +
      'out 200;';
    return points((await overpass(query)).elements);
  }).catch(() => null);

  return found?.length ? byDistance(found, lat, lon)[0] : null;
}
