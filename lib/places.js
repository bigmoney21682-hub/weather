// Access to the Overpass API, which answers questions about OpenStreetMap that
// no forecast or geocoding service can: where the coastline runs, and what the
// named things sitting beside it are called.
//
// Overpass is a shared volunteer service. Callers round their lookups onto a
// coarse grid and cache the answers for a week — the map does not move.

import { fetchJSON } from './util.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function overpass(query, { timeout = 12000 } = {}) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      // Short queries go in the URL; a long one (the surf spot search names a
      // rectangle per stretch of coast) overruns what the endpoints accept there
      // and comes back 414, so those are posted instead. Either way this stays
      // inside fetchJSON's timeout handling.
      //
      // Overpass answers a warm query in seconds; a slow one means we are being
      // throttled, and waiting longer almost never turns that around. Better to
      // give up and let the caller render without the label.
      const encoded = `data=${encodeURIComponent(query)}`;
      const data =
        encoded.length > 3000
          ? await fetchJSON(endpoint, { timeout, retries: 0, body: encoded })
          : await fetchJSON(`${endpoint}?${encoded}`, { timeout, retries: 0 });
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
