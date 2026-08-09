// Shared helpers: upstream fetching, in-memory caching, geo math, unit conversion.
//
// PRIVACY: nothing in here ever writes a user coordinate to disk or to any
// analytics service. Coordinates live in request URLs to public weather APIs
// only for as long as it takes to answer a request, and cache keys are held in
// process memory that dies with the server.

const UA = 'PersonalWeatherDashboard/1.0 (self-hosted, contact: local user)';

const memCache = new Map(); // key -> { expires, value }

/** Simple TTL memo. `ttlMs` of 0 disables caching. */
export async function cached(key, ttlMs, producer) {
  const hit = memCache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  // Collapse concurrent misses onto one upstream call.
  if (hit && hit.pending) return hit.pending;
  const pending = (async () => {
    try {
      const value = await producer();
      if (ttlMs > 0) memCache.set(key, { expires: now + ttlMs, value });
      else memCache.delete(key);
      return value;
    } catch (err) {
      // On failure, serve stale data if we have any rather than showing nothing.
      if (hit && 'value' in hit) {
        memCache.set(key, { ...hit, pending: null });
        return hit.value;
      }
      memCache.delete(key);
      throw err;
    }
  })();
  memCache.set(key, { ...(hit || {}), expires: hit?.expires ?? 0, pending });
  return pending;
}

export async function fetchJSON(url, { timeout = 15000, headers = {}, text = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: text ? '*/*' : 'application/json', ...headers },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`upstream ${res.status} for ${new URL(url).host}`);
    return text ? await res.text() : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const R_MILES = 3958.7613;

/** Great-circle distance in statute miles. */
export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Offset a lat/lon by a distance (miles) along a bearing (degrees). */
export function offsetMiles(lat, lon, miles, bearingDeg) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const d = miles / R_MILES;
  const br = toRad(bearingDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 =
    lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

export const ktToMph = (kt) => (kt == null ? null : kt * 1.15078);
export const cToF = (c) => (c == null ? null : (c * 9) / 5 + 32);
export const kmToMiles = (km) => (km == null ? null : km * 0.621371);

/** Clamp a value parsed from a query string into a sane numeric range. */
export function num(value, { min, max, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min != null && n < min) return fallback;
  if (max != null && n > max) return fallback;
  return n;
}

/** Validate a coordinate pair coming off the wire. */
export function coords(query) {
  const lat = num(query.get('lat'), { min: -90, max: 90 });
  const lon = num(query.get('lon'), { min: -180, max: 180 });
  if (lat == null || lon == null) {
    const err = new Error('lat and lon query parameters are required');
    err.status = 400;
    throw err;
  }
  return { lat, lon };
}
