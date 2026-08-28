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
import { mrmsCovers, mrmsFrames, MRMS_TILE } from './mrms.js';

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
  let ts = null;
  try {
    ts = await cached('radar:nexrad:scan', 60 * 1000, async () => {
      const data = await fetchJSON(`${IEM}/json/radar?operation=list&product=N0Q&radar=USCOMP`, {
        timeout: 10000,
      });
      return data?.scans?.[0]?.ts || null;
    });
  } catch {
    // This endpoint is only the scan *clock*. Letting it throw used to take the
    // whole mosaic down with it — the error propagated out to `getRadar`, which
    // read it as "NEXRAD is unavailable" and dropped the user to the 10-minute
    // global composite, blurry and five zoom levels shallower, while the tile
    // service itself was answering perfectly well. Observed live: the JSON
    // endpoint timing out at 15s while a WMS tile came back 200 in 0.69s.
  }
  const parsed = ts ? Date.parse(ts) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  // Falling back to the wall clock, but a step behind it. The WMS reports
  // `nearestValue="0"`, so asking for a scan that has not been composited yet
  // returns a blank image rather than the closest one — and at the current
  // five-minute mark the newest scan may still be in the oven.
  return Math.floor(Date.now() / 300000) * 300000 - STEP_MINUTES * 60000;
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

/**
 * The two-minute composite, decoded from raw MRMS by lib/mrms.js. Frames land
 * two and a half times as often as the Iowa State mosaic can manage, which is
 * the whole reason it exists: five-minute steps are what made the loop read as
 * a slideshow rather than as weather moving.
 */
async function mrmsRadar() {
  const frames = await mrmsFrames();
  if (!frames?.length) return null;
  return {
    source: 'mrms',
    label: 'MRMS composite · 2-minute frames',
    frames,
    tile: { ...MRMS_TILE },
    attribution: 'Radar © <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a>',
  };
}

/**
 * Frames for a location: the two-minute MRMS composite over the lower 48, the
 * five-minute NEXRAD mosaic where MRMS does not reach but the radars do —
 * Alaska, Hawaii, Puerto Rico — and the global composite for everywhere else.
 *
 * MRMS is tried first and falls through on any failure, so a bad decode, a slow
 * NCEP or a gap in the listing costs a coarser loop rather than a broken one.
 */
export async function getRadar(lat, lon) {
  if (mrmsCovers(lat, lon)) {
    try {
      const radar = await mrmsRadar();
      if (radar) return radar;
    } catch {
      /* raw feed is unavailable — the five-minute mosaic still covers this */
    }
  }
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
