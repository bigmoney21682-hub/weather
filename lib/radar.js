// Radar frames: high-resolution NEXRAD over the United States, RainViewer
// everywhere else.
//
// RainViewer is the only keyless radar composite with global coverage, but it
// is a compromise: it runs out of resolution at tile zoom 7 — ask for anything
// deeper and it hands back a placeholder saying so — and it lands five to eight
// minutes behind. Iowa State's NEXRAD mosaic is sharp to zoom 16 and about a
// minute behind, so wherever it reaches we use it, and the rest of the world
// still gets a radar.
//
// Both are keyless, so nothing here needs an account or an API key.

import { cached, fetchJSON } from './util.js';

const IEM = 'https://mesonet.agron.iastate.edu';
// The time-enabled WMS, and it has to be this one: the mosaic's tile service
// only offers layers named for an offset from now ("five minutes ago"), which
// round onto whatever scan is nearest and so hand back the same picture twice
// whenever a composite runs late. Its plain WMS sibling accepts TIME and
// ignores it. Only `n0q-t.cgi` answers for the moment you actually ask for.
const IEM_WMS = `${IEM}/cgi-bin/wms/nexrad/n0q-t.cgi`;
const IEM_WMS_LAYER = 'nexrad-n0q-wmst'; // NWS base reflectivity, national mosaic

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
const FRAME_COUNT = 12; // an hour of scans, five minutes apart

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
  // Snapped to the five-minute grid the mosaic composites on, so every frame
  // asks for a scan that exists rather than one the server has to round to.
  const newest = Math.floor((await newestScanMs()) / (STEP_MINUTES * 60000)) * STEP_MINUTES * 60000;
  const frames = [];
  // Oldest first, so the loop plays forward.
  for (let i = FRAME_COUNT - 1; i >= 0; i--) {
    const at = newest - i * STEP_MINUTES * 60000;
    const stamp = new Date(at).toISOString().replace(/\.\d+Z$/, 'Z');
    frames.push({
      time: Math.floor(at / 1000),
      key: `${IEM_WMS_LAYER}@${stamp}`,
      // The frame is addressed by the moment it was scanned, so its identity
      // changes exactly when its contents do. That is what lets the client keep
      // its tiles between polls and rebuild only when a new scan lands.
      params: { time: stamp },
    });
  }
  return {
    source: 'nexrad',
    label: 'NEXRAD mosaic · 5-minute scans',
    frames,
    tile: {
      wms: true,
      url: IEM_WMS,
      layers: IEM_WMS_LAYER,
      format: 'image/png',
      transparent: true,
      // The WMS renders on demand and charges by the request, not by the pixel:
      // a 512px tile comes back no slower than a 256px one and covers four
      // times the ground, so this is a quarter of the requests for the same
      // picture — and a quarter of the load on a free academic service.
      tileSize: 512,
      maxNativeZoom: 16,
      // These arrive as raw reflectivity — every bin the radars can see, in
      // hard squares, on the NWS ramp. The client reads the dBZ back off that
      // ramp so it can drop the clear-air clutter, soften the bins and repaint
      // them on the same scale the legend describes.
      paint: 'nexrad',
    },
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
      key: f.path,
      // Colour scheme 4 with smoothing reads closest to a broadcast radar.
      url: `${data.host}${f.path}/512/{z}/{x}/{y}/4/1_1.png`,
    })),
    // Stops at RainViewer's last real zoom. Ask for tile zoom 8 or deeper and
    // it answers every request with the same "Zoom Level Not Supported" card,
    // which Leaflet would happily paste across the map. With `zoomOffset` at
    // -1 the URL zoom is one below the map's, so 8 here means tile zoom 7.
    tile: { tileSize: 512, zoomOffset: -1, maxNativeZoom: 8, paint: 'rainviewer' },
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
