// Live lightning strikes from the Blitzortung.org community sensor network.
//
// Blitzortung streams every detected strike on the planet over a websocket.
// Buffering all of it would be gigabytes an hour, so the server keeps a list of
// "areas of interest" (the locations the app has actually asked about recently)
// and only retains strikes near those. A location stops being of interest a few
// minutes after the last request for it, and nothing is ever written to disk.

const HOSTS = ['wss://ws1.blitzortung.org/', 'wss://ws3.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'];
const ORIGIN = 'https://map.blitzortung.org';

const RETAIN_MS = 60 * 60 * 1000; // keep one hour of strikes
const INTEREST_TTL_MS = 10 * 60 * 1000; // an unused area falls out after 10 min
const INTEREST_PAD_MILES = 40; // buffer a little wider than the query radius
const MAX_STRIKES = 20000;

/** Blitzortung ships each frame through this LZW variant before sending it. */
function inflate(payload) {
  const dict = {};
  const chars = payload.split('');
  let prev = chars[0];
  let current = prev;
  const out = [prev];
  let next = 256;
  for (let i = 1; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0);
    const entry = code < 256 ? chars[i] : dict[code] || prev + current;
    out.push(entry);
    current = entry.charAt(0);
    dict[next++] = prev + current;
    prev = entry;
  }
  return out.join('');
}

function toRad(d) {
  return (d * Math.PI) / 180;
}
function milesBetween(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(a)));
}

class LightningFeed {
  constructor() {
    this.strikes = []; // newest last
    this.interests = new Map(); // "lat,lon" -> { lat, lon, miles, expires }
    this.ws = null;
    this.hostIndex = 0;
    this.attempts = 0;
    this.connectedSince = null;
    this.lastError = null;
    this.received = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.pruneTimer = setInterval(() => this.prune(), 60 * 1000);
    this.pruneTimer.unref?.();
  }

  connect() {
    const url = HOSTS[this.hostIndex % HOSTS.length];
    let ws;
    try {
      ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
    } catch (err) {
      this.ws = null;
      this.retire(null, err?.message || String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connectedSince = Date.now();
      this.attempts = 0;
      this.lastError = null;
      ws.send(JSON.stringify({ a: 111 })); // "a: 111" = subscribe to the global feed
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.ingest(event.data);
    };
    ws.onerror = (event) => this.retire(ws, event?.message || event?.error?.message || 'websocket error');
    ws.onclose = () => this.retire(ws, null);
  }

  /**
   * Both `error` and `close` end up here, because we cannot rely on either one
   * alone: when a handshake fails, Node 22 (what we deploy on) fires only
   * `error` and never `close`, while Node 25 fires both. Reconnecting from
   * `close` alone left the feed dead forever on the first refused handshake;
   * reconnecting from both without a guard would rotate hosts twice for a
   * single failure.
   *
   * The `this.ws !== ws` check is that guard. It also stops a straggling event
   * from an already-replaced socket from tearing down a healthy connection.
   */
  retire(ws, error) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (error) this.lastError = error;
    this.connectedSince = null;
    this.hostIndex++;
    try {
      ws?.close();
    } catch {
      // Already dead; nothing to close.
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(6, this.attempts++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  ingest(raw) {
    let strike;
    try {
      strike = JSON.parse(inflate(String(raw)));
    } catch {
      return;
    }
    if (typeof strike.lat !== 'number' || typeof strike.lon !== 'number') return;
    this.received++;

    if (!this.nearAnyInterest(strike.lat, strike.lon)) return;

    this.strikes.push({
      // Blitzortung timestamps are nanoseconds since epoch.
      t: Math.round(strike.time / 1e6),
      lat: strike.lat,
      lon: strike.lon,
      // How many sensors saw it — a rough confidence/energy proxy.
      sensors: Array.isArray(strike.sig) ? strike.sig.length : null,
    });
    if (this.strikes.length > MAX_STRIKES) this.strikes.splice(0, this.strikes.length - MAX_STRIKES);
  }

  nearAnyInterest(lat, lon) {
    const now = Date.now();
    for (const area of this.interests.values()) {
      if (area.expires < now) continue;
      // Cheap bounding-box reject before the trig.
      const pad = area.miles + INTEREST_PAD_MILES;
      if (Math.abs(lat - area.lat) > pad / 69) continue;
      if (milesBetween(lat, lon, area.lat, area.lon) <= pad) return true;
    }
    return false;
  }

  prune() {
    const cutoff = Date.now() - RETAIN_MS;
    let i = 0;
    while (i < this.strikes.length && this.strikes[i].t < cutoff) i++;
    if (i) this.strikes.splice(0, i);
    for (const [key, area] of this.interests) {
      if (area.expires < Date.now()) this.interests.delete(key);
    }
  }

  /** Register an area we care about, then answer with what we have for it. */
  query(lat, lon, miles, limit) {
    this.start();
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(miles)}`;
    this.interests.set(key, { lat, lon, miles, expires: Date.now() + INTEREST_TTL_MS });

    const cutoff = Date.now() - RETAIN_MS;
    const hits = [];
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if (s.t < cutoff) break;
      const d = milesBetween(lat, lon, s.lat, s.lon);
      if (d <= miles) {
        hits.push({ ...s, distanceMiles: Math.round(d * 10) / 10 });
        if (hits.length >= limit) break;
      }
    }

    const watchingFor = this.connectedSince ? Date.now() - this.connectedSince : 0;
    return {
      strikes: hits, // newest first
      radiusMiles: miles,
      connected: Boolean(this.connectedSince),
      // How long this area has been watched, so the UI can distinguish
      // "no strikes" from "we only just started listening".
      watchingMs: Math.min(watchingFor, RETAIN_MS),
      lastError: this.connectedSince ? null : this.lastError,
      network: 'Blitzortung.org volunteer sensor network',
    };
  }
}

export const lightningFeed = new LightningFeed();
