// Turning what the user typed into a coordinate.
//
// Accepts: US/international ZIP or postal codes, city, town, county/parish,
// "City, ST", and raw "lat,lon" pairs.

import { cached, fetchJSON, haversineMiles } from './util.js';

const DAY = 24 * 60 * 60 * 1000;

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico',
};

/** Countries whose postal codes zippopotam serves, tried in order for a bare code. */
const POSTAL_COUNTRIES = ['us', 'ca', 'gb', 'de', 'fr', 'au'];

function label(parts) {
  return parts.filter(Boolean).join(', ');
}

async function byUSZip(zip) {
  const data = await cached(`zip:us:${zip}`, 30 * DAY, () =>
    fetchJSON(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`),
  );
  const place = data?.places?.[0];
  if (!place) return null;
  return {
    lat: Number(place.latitude),
    lon: Number(place.longitude),
    name: place['place name'],
    admin1: place.state,
    country: 'United States',
    label: label([place['place name'], place['state abbreviation'], zip]),
    source: 'postal code',
  };
}

async function byPostal(code) {
  const clean = code.replace(/\s+/g, '').toUpperCase();
  if (/^\d{5}(-\d{4})?$/.test(clean)) return byUSZip(clean.slice(0, 5));
  for (const cc of POSTAL_COUNTRIES) {
    try {
      const data = await cached(`zip:${cc}:${clean}`, 30 * DAY, () =>
        fetchJSON(`https://api.zippopotam.us/${cc}/${encodeURIComponent(clean)}`),
      );
      const place = data?.places?.[0];
      if (place) {
        return {
          lat: Number(place.latitude),
          lon: Number(place.longitude),
          name: place['place name'],
          admin1: place.state,
          country: data.country,
          label: label([place['place name'], place['state abbreviation'] || place.state, clean]),
          source: 'postal code',
        };
      }
    } catch {
      /* try the next country */
    }
  }
  return null;
}

/**
 * Rank geocoder hits. A search for "Ocean County" should land on the county,
 * not on "Ocean County Park", so administrative areas outrank landmarks and an
 * explicit state/province in the query is a strong signal.
 */
function score(hit, { wantCounty, stateHint, queryName }) {
  let s = 0;
  const code = hit.feature_code || '';
  if (wantCounty && code.startsWith('ADM2')) s += 60;
  if (code.startsWith('PPLA') || code === 'PPLC') s += 25; // capitals / seats of government
  else if (code.startsWith('PPL')) s += 20; // populated places
  else if (code.startsWith('ADM')) s += 10;
  else s -= 25; // parks, reservoirs, ridges…
  if (hit.name?.toLowerCase() === queryName) s += 15;
  if (stateHint) {
    const st = stateHint.toLowerCase();
    if (hit.admin1?.toLowerCase() === st) s += 45;
    if (hit.country_code === 'US' && US_STATES[stateHint.toUpperCase()]?.toLowerCase() === hit.admin1?.toLowerCase()) s += 45;
  }
  if (hit.country_code === 'US') s += 5; // small tiebreak toward home
  s += Math.min(20, Math.log10((hit.population || 1) + 1) * 4);
  return s;
}

/**
 * OpenStreetMap's geocoder, used for counties and as a general fallback.
 * Open-Meteo's index is populated places only, so it cannot answer "Ocean
 * County" — it returns Ocean County *Park*. Nominatim knows administrative
 * boundaries, so counties, parishes and boroughs go here first.
 */
async function byNominatim(query) {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    '&format=jsonv2&limit=5&addressdetails=1';
  const results = await cached(`nom:${query.toLowerCase()}`, 7 * DAY, () =>
    fetchJSON(url, { timeout: 12000 }),
  );
  const hit = results?.[0];
  if (!hit) return null;
  const a = hit.address || {};
  const name = hit.name || a.county || a.city || a.town || a.village || hit.display_name.split(',')[0];
  const region = a.state || a.province || a.region;
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    name,
    admin1: region,
    admin2: a.county,
    country: a.country,
    label: label([name, region, a.country_code === 'us' ? null : a.country]),
    source: hit.type === 'administrative' ? 'administrative area' : 'place name',
    alternatives: results.slice(1, 5).map((r) => ({
      lat: Number(r.lat),
      lon: Number(r.lon),
      label: r.display_name.split(',').slice(0, 3).join(',').trim(),
    })),
  };
}

async function byName(query) {
  // "Springfield, IL" / "Bath, Somerset" — split off a trailing region hint.
  const [rawName, ...rest] = query.split(',').map((p) => p.trim());
  const stateHint = rest.join(', ') || null;
  const wantCounty = /\b(county|parish|borough|shire)\b/i.test(rawName);
  const name = rawName.replace(/\b(county|parish)\b/gi, '').trim() || rawName;

  // Counties never resolve well against a populated-places index.
  if (wantCounty) {
    const admin = await byNominatim(query).catch(() => null);
    if (admin) return admin;
  }

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=en&format=json`;
  const data = await cached(`geo:${name.toLowerCase()}`, 7 * DAY, () => fetchJSON(url)).catch(() => null);
  const results = data?.results || [];
  if (!results.length) return byNominatim(query).catch(() => null);

  const ctx = { wantCounty, stateHint, queryName: name.toLowerCase() };
  const ranked = results.slice().sort((a, b) => score(b, ctx) - score(a, ctx));
  const best = ranked[0];

  // A weak winner usually means the query was an address, a landmark or a
  // region this index does not carry. OSM is better at all three.
  if (score(best, ctx) < 20) {
    const alt = await byNominatim(query).catch(() => null);
    if (alt) return alt;
  }

  return {
    lat: best.latitude,
    lon: best.longitude,
    name: best.name,
    admin1: best.admin1,
    admin2: best.admin2,
    country: best.country,
    label: label([best.name, best.admin1, best.country_code === 'US' ? null : best.country]),
    source: wantCounty ? 'county' : 'place name',
    alternatives: ranked
      .slice(1, 6)
      .map((r) => ({
        lat: r.latitude,
        lon: r.longitude,
        label: label([r.name, r.admin1, r.country]),
      })),
  };
}

/** Main entry: resolve free text to a place. Returns null when nothing matched. */
export async function geocode(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return null;

  // Raw coordinates, e.g. "40.71,-74.01"
  const pair = q.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (pair) {
    const lat = Number(pair[1]);
    const lon = Number(pair[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, source: 'coordinates' };
    }
  }

  // Anything that looks like a postal code goes to the postal lookup first.
  if (/^[0-9]{4,6}(-[0-9]{4})?$/.test(q) || /^[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d$/.test(q) || /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/.test(q)) {
    const hit = await byPostal(q).catch(() => null);
    if (hit) return hit;
  }

  return byName(q);
}

/**
 * Coordinates -> a human label, for the "use my location" button.
 * Best-effort: if the reverse geocoder is unreachable we just show the numbers.
 */
export async function reverseGeocode(lat, lon) {
  const key = `rev:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  try {
    const data = await cached(key, 7 * DAY, () =>
      fetchJSON(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
        { timeout: 8000 },
      ),
    );
    const city = data.city || data.locality || data.localityInfo?.administrative?.slice(-1)[0]?.name;
    const region = data.principalSubdivisionCode?.split('-')[1] || data.principalSubdivision;
    const text = label([city, region, data.countryCode === 'US' ? null : data.countryName]);
    if (text) return { lat, lon, label: text, name: city, admin1: region, country: data.countryName, source: 'device location' };
  } catch {
    /* fall through to coordinates */
  }
  return { lat, lon, label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, source: 'device location' };
}

export { haversineMiles };
