// Weather dashboard server.
//
// Serves the single-page UI out of public/ and proxies a handful of public
// weather APIs under /api. It holds no database, sets no cookies, and writes no
// request logs containing a location. See PRIVACY.md.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { geocode, reverseGeocode } from './lib/geocode.js';
import { getForecast } from './lib/forecast.js';
import { getAlerts } from './lib/alerts.js';
import { lightningFeed } from './lib/lightning.js';
import { listStorms, getStorm } from './lib/hurricanes.js';
import { getSurf } from './lib/surf.js';
import { getAirQuality } from './lib/airquality.js';
import { getOceanQuality } from './lib/oceanquality.js';
import { getRadar } from './lib/radar.js';
import { startKeepAlive } from './lib/keepalive.js';
import { coords, num } from './lib/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Undefined means Node's wildcard address, which is dual-stack: it answers on
// IPv4 and IPv6 loopback (macOS resolves "localhost" to ::1 first, so binding
// 127.0.0.1 alone gets connections refused) and on the LAN, so a phone on the
// same Wi-Fi can open it. Set HOST=127.0.0.1 to keep it to this machine only.
const HOST = process.env.HOST || undefined;
// A host that sets PORT is telling us the one port it will route traffic to, so
// there is nowhere to walk if it is busy — fail loudly instead of binding a port
// nobody is listening for.
const PORT_IS_FIXED = Boolean(process.env.PORT);
const BASE_PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/* ------------------------------------------------------------------ API ---- */

const routes = {
  // Cheap liveness probe. The host's health check and the keep-alive ping both
  // hit this rather than '/', so neither reads index.html off disk.
  '/healthz'() {
    return { ok: true, uptimeSeconds: Math.round(process.uptime()) };
  },

  async '/api/geocode'(query) {
    const q = query.get('q');
    if (!q) {
      const err = new Error('q query parameter is required');
      err.status = 400;
      throw err;
    }
    const place = await geocode(q);
    if (!place) {
      const err = new Error(`No place matched “${q}”. Try a ZIP/postal code, "City, ST", or a county name.`);
      err.status = 404;
      throw err;
    }
    return place;
  },

  async '/api/reverse'(query) {
    const { lat, lon } = coords(query);
    return reverseGeocode(lat, lon);
  },

  async '/api/weather'(query) {
    const { lat, lon } = coords(query);
    return getForecast(lat, lon);
  },

  async '/api/alerts'(query) {
    const { lat, lon } = coords(query);
    return getAlerts(lat, lon);
  },

  /**
   * An hour of radar frames for a point: the NEXRAD mosaic where it reaches,
   * the global composite otherwise. Without coordinates it answers globally.
   */
  async '/api/radar'(query) {
    const lat = num(query.get('lat'), { min: -90, max: 90 });
    const lon = num(query.get('lon'), { min: -180, max: 180 });
    return getRadar(lat, lon);
  },

  async '/api/lightning'(query) {
    const { lat, lon } = coords(query);
    const miles = num(query.get('miles'), { min: 1, max: 300, fallback: 30 });
    const limit = num(query.get('limit'), { min: 1, max: 500, fallback: 50 });
    return lightningFeed.query(lat, lon, miles, limit);
  },

  async '/api/hurricanes'() {
    return { storms: await listStorms(), updated: new Date().toISOString() };
  },

  async '/api/hurricane'(query) {
    const id = query.get('id');
    const storm = id ? await getStorm(id) : null;
    if (!storm) {
      const err = new Error('Storm not found — it may have dissipated since the list was loaded.');
      err.status = 404;
      throw err;
    }
    return storm;
  },

  async '/api/surf'(query) {
    const { lat, lon } = coords(query);
    const miles = num(query.get('miles'), { min: 5, max: 200, fallback: 30 });
    // `at` picks one of the spots the last response offered, so tapping along
    // the coast does not move the search — the list of pills stays put.
    const atLat = num(query.get('atLat'), { min: -90, max: 90 });
    const atLon = num(query.get('atLon'), { min: -180, max: 180 });
    const at = atLat != null && atLon != null ? { lat: atLat, lon: atLon } : null;
    return getSurf(lat, lon, { radiusMiles: miles, snapToBeach: query.get('snap') !== '0', at });
  },

  async '/api/air'(query) {
    const { lat, lon } = coords(query);
    const miles = num(query.get('miles'), { min: 5, max: 200, fallback: 60 });
    return getAirQuality(lat, lon, { radiusMiles: miles });
  },

  async '/api/ocean'(query) {
    const { lat, lon } = coords(query);
    const miles = num(query.get('miles'), { min: 5, max: 200, fallback: 60 });
    return getOceanQuality(lat, lon, { radiusMiles: miles });
  },
};

/* --------------------------------------------------------------- static ---- */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC, rel);
  // Refuse anything that escapes public/.
  if (!target.startsWith(PUBLIC + path.sep) && target !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('directory');
    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      // Revalidate app code every load (ETag makes that a cheap 304) but let
      // the vendored library and images sit in cache.
      'Cache-Control': rel.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    } else {
      // Unknown non-file path: hand it to the single-page app.
      const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(html);
    }
  }
}

/* --------------------------------------------------------------- server ---- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handler = routes[url.pathname];

  if (handler) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJSON(res, 405, { error: 'Method not allowed' });
      return;
    }
    try {
      const body = await handler(url.searchParams);
      sendJSON(res, 200, body);
    } catch (err) {
      const status = err.status || 502;
      if (status >= 500) console.error(`[api] ${url.pathname}: ${err.message}`);
      sendJSON(res, status, { error: err.message });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  await serveStatic(req, res, url.pathname);
});

/** Take BASE_PORT if it is free, otherwise walk up until something opens. */
function listen(port, attemptsLeft = PORT_IS_FIXED ? 0 : 25) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log('');
    for (const url of reachableURLs(port)) console.log(`  Weather  →  ${url}`);
    console.log('\n  All location data stays in your browser. No accounts, no cookies, no logs.\n');
    // Warm up the lightning websocket so strikes are already buffered by the
    // time the first request for them arrives.
    lightningFeed.start();
    if (startKeepAlive()) console.log('  Keep-alive pinging this service so it does not idle out.\n');
  });
}

/** Every address this server can actually be opened on, for the startup banner. */
function reachableURLs(port) {
  if (HOST) return [`http://${HOST}:${port}`];
  const urls = [`http://localhost:${port}`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      // Only IPv4 LAN addresses — those are the ones worth typing on a phone.
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

listen(BASE_PORT);

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
