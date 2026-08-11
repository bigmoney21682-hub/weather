// Radar frames: high-resolution NEXRAD over the United States, RainViewer
// everywhere else.
//
// RainViewer is the only keyless radar composite with global coverage, but it
// is a compromise: it runs out of resolution at tile zoom 8 — ask for anything
// deeper and it hands back the byte-identical zoom 8 image — and it lands five
// to eight minutes behind. Iowa State's NEXRAD mosaic is sharp to zoom 16 and
// about a minute behind, so wherever it reaches we use it, and the rest of the
// world still gets a radar.
//
// Both are keyless, so nothing here needs an account or an API key.

import { cached, fetchJSON } from './util.js';

const IEM = 'https://mesonet.agron.iastate.edu';
const IEM_LAYER = 'nexrad-n0q-900913'; // NWS base reflectivity, national mosaic

// Boxes the national mosaic actually answers for, checked against real tiles:
// Alaska, Hawaii and Puerto Rico are in it, and the CONUS box deliberately
// spills into southern Canada and northern Mexico because US radars see there.
const NEXRAD_BOXES = [
  [21, -127, 53, -64], // CONUS and the spill either side
  [50, -180, 72, -128], // Alaska
  [18, -161, 23, -154], // Hawaii
  [17, -68, 19.5, -64], // Puerto Rico and the USVI
];

export function nexradCovers(lat, lon) {
  if (lat == null || lon == null) return false;
  return NEXRAD_BOXES.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
}

const STEP_MINUTES = 5;
const FRAME_COUNT = 12; // the live layer plus -m05m..-m55m: an hour, five minutes apart

/**
 * The mosaic publishes its own scan clock. Reading it keeps the frame labels
 * honest — deriving them from the wall clock would drift by however far behind
 * the feed happens to be running.
 */
async function newestScanMs() {
  const ts = await cached('radar:nexrad:scan', 60 * 1000, async () => {
    const data = await fetchJSON(`${IEM}/json/radar?operation=list&product=N0Q&radar=USCOMP`, {
      timeout: 10000,
    });
    return data?.scans?.[0]?.ts || null;
  });
  const parsed = ts ? Date.parse(ts) : NaN;
  // Fall back to the current five-minute mark if the clock is unreadable; the
  // frames themselves are still the right ones, only the captions would slip.
  return Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 300000) * 300000;
}

async function nexradRadar() {
  const newest = await newestScanMs();
  const frames = [];
  // Oldest first, so the loop plays forward.
  for (let i = FRAME_COUNT - 1; i >= 0; i--) {
    const suffix = i === 0 ? '' : `-m${String(i * STEP_MINUTES).padStart(2, '0')}m`;
    const time = Math.floor((newest - i * STEP_MINUTES * 60000) / 1000);
    // These layer names are relative — "-m05m" always means five minutes ago —
    // so the URL would stay put while the picture underneath it rolls on.
    // Stamping the scan time makes each frame's address change exactly when its
    // contents do, which is what lets the client keep its tiles between polls
    // and rebuild only when a genuinely new scan lands.
    frames.push({
      time,
      url: `${IEM}/cache/tile.py/1.0.0/${IEM_LAYER}${suffix}/{z}/{x}/{y}.png?scan=${Math.floor(newest / 1000)}`,
    });
  }
  return {
    source: 'nexrad',
    label: 'NEXRAD mosaic · 5-minute scans',
    frames,
    // The NWS reflectivity ramp already runs green through magenta, which is
    // the scale the legend describes, so these tiles are left as they arrive —
    // which also skips a canvas pass per tile.
    tile: { tileSize: 256, zoomOffset: 0, maxNativeZoom: 16, recolour: false },
    attribution:
      'Radar © <a href="https://mesonet.agron.iastate.edu/">Iowa State Mesonet</a> / NOAA',
  };
}

async function rainviewerRadar() {
  const data = await cached('radar:index', 60 * 1000, () =>
    fetchJSON('https://api.rainviewer.com/public/weather-maps.json'),
  );
  const now = Math.floor(Date.now() / 1000);
  // The keyless tier serves past frames only — its nowcast and satellite lists
  // are always empty — so there is no forecast tail to add here.
  const past = (data.radar?.past || []).filter((f) => f.time >= now - 3600);
  return {
    source: 'rainviewer',
    label: 'RainViewer global composite · 10-minute scans',
    frames: past.map((f) => ({
      time: f.time,
      // Colour scheme 4 with smoothing reads closest to a broadcast radar.
      url: `${data.host}${f.path}/512/{z}/{x}/{y}/4/1_1.png`,
    })),
    // Stops at RainViewer's last real zoom; past that it repeats itself and the
    // map would stretch one image over a sixteenth of the ground it covers.
    tile: { tileSize: 512, zoomOffset: -1, maxNativeZoom: 9, recolour: true },
    attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
  };
}

/** Frames for a location, preferring NEXRAD wherever it reaches. */
export async function getRadar(lat, lon) {
  if (nexradCovers(lat, lon)) {
    try {
      const radar = await nexradRadar();
      if (radar.frames.length) return radar;
    } catch {
      /* mosaic is down — the global composite still covers this point */
    }
  }
  return rainviewerRadar();
}
