// Shared helpers: upstream fetching, in-memory caching, geo math, unit conversion.
//
// PRIVACY: nothing in here ever writes a user coordinate to disk or to any
// analytics service. Coordinates live in request URLs to public weather APIs
// only for as long as it takes to answer a request, and cache keys are held in
// process memory that dies with the server.

const UA = 'PersonalWeatherDashboard/1.0 (self-hosted, contact: local user)';

const memCache = new Map(); // key -> { expires, value } | { expires, error }

// How long a stale reading is allowed to stand in for a fresh one after the
// upstream has failed. Short enough that a recovered feed is picked up almost
// at once, long enough that a feed which is down or rate limited is asked once
// a minute rather than once a visitor.
const STALE_GRACE_MS = 60 * 1000;

/**
 * Simple TTL memo. `ttlMs` of 0 disables caching.
 *
 * `errorTtlMs` additionally remembers a *failure* for a while. Without it, an
 * upstream that is down (as opposed to slow) is retried on every single request,
 * and each one pays the full timeout-and-retry budget before the caller's
 * `.catch()` turns it into an empty section. Remembering the failure briefly
 * turns that into one slow request per interval instead of one per visitor.
 */
export async function cached(key, ttlMs, producer, { errorTtlMs = 0 } = {}) {
  const hit = memCache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) {
    if ('error' in hit) throw hit.error;
    return hit.value;
  }
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
        // ...and let it stand for a moment. Leaving the expiry in the past sent
        // the very next request straight back at an upstream that had just
        // failed, so a rate-limited feed was asked again once per visitor for
        // as long as it stayed rate limited — which is the surest way to keep
        // it that way.
        memCache.set(key, { ...hit, expires: now + Math.min(ttlMs, STALE_GRACE_MS), pending: null });
        return hit.value;
      }
      if (errorTtlMs > 0) memCache.set(key, { expires: now + errorTtlMs, error: err });
      else memCache.delete(key);
      throw err;
    }
  })();
  memCache.set(key, { ...(hit || {}), expires: hit?.expires ?? 0, pending });
  return pending;
}

async function fetchOnce(url, { timeout, headers, text }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: text ? '*/*' : 'application/json', ...headers },
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`upstream ${res.status} for ${new URL(url).host}`);
      err.status = res.status;
      // A rate limiter often says when to come back. Believe it rather than
      // guessing — coming back early is what got us throttled.
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) err.retryAfterMs = after * 1000;
      throw err;
    }
    return text ? await res.text() : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON (or text) from an upstream feed.
 * Weather services drop the occasional connection, and a single blip should not
 * leave a section broken until the user changes location, so transient failures
 * — network errors, timeouts and 5xx — get one quick retry. A 4xx is the
 * upstream telling us the request itself is wrong, so that fails immediately.
 *
 * 429 is the exception among the 4xx: it does not mean the request was wrong,
 * it means it was early. It gets a retry too, after a longer pause than a
 * dropped connection gets — but only if the upstream is asking for a wait we
 * are willing to hold a request open for. Beyond that, failing now is better,
 * because the caller's cache can answer with a slightly old reading instead.
 */
const RATE_LIMIT_WAIT_MS = 1200;
const RATE_LIMIT_MAX_WAIT_MS = 3000;

export async function fetchJSON(url, { timeout = 15000, headers = {}, text = false, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(url, { timeout, headers, text });
    } catch (err) {
      lastError = err;
      const limited = err.status === 429;
      const retriable = !err.status || err.status >= 500 || limited;
      if (!retriable || attempt === retries) break;
      const wait = limited ? (err.retryAfterMs ?? RATE_LIMIT_WAIT_MS) : 350 * (attempt + 1);
      if (limited && wait > RATE_LIMIT_MAX_WAIT_MS) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
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

/** Initial great-circle bearing in degrees, 0 = north, from one point to another. */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const la1 = toRad(lat1);
  const la2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
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

/**
 * Sunrise and sunset (UTC) for a day, from the standard low-precision solar
 * position formulas. Accurate to well under a minute, which is far more than
 * "is this tide during daylight?" needs, and costs no network call.
 * Returns nulls inside the polar day/night, where the sun never crosses.
 */
export function sunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const DAY_MS = 86400000;

  const days = date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const lw = rad * -lon;
  const phi = rad * lat;

  const n = Math.round(days - 0.0009 - lw / (2 * Math.PI));
  const approx = (angle) => 0.0009 + (angle + lw) / (2 * Math.PI) + n;

  const meanAnomaly = rad * (357.5291 + 0.98560028 * approx(0));
  const equationOfCentre =
    rad * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLon = meanAnomaly + equationOfCentre + rad * 102.9372 + Math.PI;
  const declination = Math.asin(Math.sin(rad * 23.4397) * Math.sin(eclipticLon));

  const transit = (ds) => J2000 + ds + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLon);
  const noonJ = transit(approx(0));

  // -0.833° is the standard sunrise altitude: refraction plus the solar radius.
  const cosH =
    (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
  if (!Number.isFinite(cosH) || cosH > 1 || cosH < -1) return { sunrise: null, sunset: null };

  const setJ = transit(approx(Math.acos(cosH)));
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
  return { sunrise: fromJulian(noonJ - (setJ - noonJ)), sunset: fromJulian(setJ) };
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
