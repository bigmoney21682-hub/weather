// A field of wind arrows over the state you are in, hourly from now to the end
// of the day after tomorrow.
//
// The server's part is only where to start: which state, and where on it to
// centre. The arrows are laid out in the browser over whatever part of the map
// is on screen, and their wind comes from Open-Meteo, which takes comma-separated
// coordinate lists and answers the whole grid in one request — but it limits
// per IP, and a free Render instance shares its IP with whoever else is on the
// box, whose traffic routinely spends the day's allowance (see forecast.js).
// So the browser makes that one request itself, from the viewer's own IP.
// PRIVACY.md says so.
//
// "The state you are in" comes from the NWS point lookup the forecast already
// makes and holds for a month. Outside NWS coverage there is no state to ask
// for, so the field covers a box of about 250 miles around the point instead.

import { inNWSCoverage } from './alerts.js';
import { nwsState } from './nwsforecast.js';

// [south, west, north, east], loose enough to take in the coastal water a
// coastal state's wind is mostly about.
const STATE_BOUNDS = {
  AL: [30.1, -88.5, 35.0, -84.9], AK: [54.5, -169.0, 71.5, -130.0], AZ: [31.3, -114.8, 37.0, -109.0],
  AR: [33.0, -94.6, 36.5, -89.6], CA: [32.5, -124.5, 42.0, -114.1], CO: [37.0, -109.1, 41.0, -102.0],
  CT: [40.9, -73.7, 42.1, -71.8], DE: [38.4, -75.8, 39.9, -75.0], DC: [38.6, -77.3, 39.2, -76.7],
  FL: [24.4, -87.7, 31.0, -79.9], GA: [30.3, -85.6, 35.0, -80.8], HI: [18.9, -160.3, 22.3, -154.8],
  ID: [42.0, -117.3, 49.0, -111.0], IL: [36.9, -91.5, 42.5, -87.0], IN: [37.7, -88.1, 41.8, -84.8],
  IA: [40.4, -96.7, 43.5, -90.1], KS: [37.0, -102.1, 40.0, -94.6], KY: [36.5, -89.6, 39.2, -81.9],
  LA: [28.9, -94.1, 33.0, -88.8], ME: [43.0, -71.1, 47.5, -66.9], MD: [37.9, -79.5, 39.8, -75.0],
  MA: [41.2, -73.5, 42.9, -69.9], MI: [41.7, -90.4, 48.3, -82.4], MN: [43.5, -97.2, 49.4, -89.5],
  MS: [30.2, -91.7, 35.0, -88.1], MO: [36.0, -95.8, 40.6, -89.1], MT: [44.4, -116.1, 49.0, -104.0],
  NE: [40.0, -104.1, 43.0, -95.3], NV: [35.0, -120.0, 42.0, -114.0], NH: [42.7, -72.6, 45.3, -70.6],
  NJ: [38.9, -75.6, 41.4, -73.9], NM: [31.3, -109.1, 37.0, -103.0], NY: [40.5, -79.8, 45.0, -71.8],
  NC: [33.8, -84.3, 36.6, -75.4], ND: [45.9, -104.1, 49.0, -96.6], OH: [38.4, -84.8, 42.0, -80.5],
  OK: [33.6, -103.0, 37.0, -94.4], OR: [42.0, -124.6, 46.3, -116.5], PA: [39.7, -80.5, 42.3, -74.7],
  RI: [41.1, -71.9, 42.0, -71.1], SC: [32.0, -83.4, 35.2, -78.5], SD: [42.5, -104.1, 45.9, -96.4],
  TN: [35.0, -90.3, 36.7, -81.6], TX: [25.8, -106.6, 36.5, -93.5], UT: [37.0, -114.1, 42.0, -109.0],
  VT: [42.7, -73.4, 45.0, -71.5], VA: [36.5, -83.7, 39.5, -75.2], WA: [45.5, -124.8, 49.0, -116.9],
  WV: [37.2, -82.6, 40.6, -77.7], WI: [42.5, -92.9, 47.1, -86.8], WY: [41.0, -111.1, 45.0, -104.1],
  PR: [17.9, -67.3, 18.5, -65.6],
};

// Where to centre each state: the middle of its land, not of its bounding box.
// Florida's box is mostly Gulf, so centring on it pushed the peninsula off to
// the right; a box's middle is only the state's middle for the square ones.
const STATE_CENTERS = {
  AL: [32.8, -86.8], AK: [63.5, -151.0], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5],
  CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.4, -82.4],
  GA: [32.7, -83.2], HI: [20.3, -157.0], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3],
  IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.0, -92.0], ME: [45.4, -69.2],
  MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
  MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.5, -79.4], ND: [47.5, -100.5],
  OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.6],
  SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
  VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -90.0],
  WY: [43.0, -107.6], PR: [18.2, -66.5],
};

// How far past the state's edge arrows load without being asked.
const REACH_MILES = 100;

// Water a state's wind is bound up with that lies further out than that. The
// Bahamas sit 50 to 400 miles off Florida, and the wind across them is the
// wind a Florida boater, surfer or storm-watcher is looking at.
const REACH_EXTRA = {
  FL: [20.5, -79.9, 27.5, -72.3], // the Bahamas, Inagua to Abaco, and just past
};

/** The area's bounds grown by REACH_MILES, and by any extra water it claims. */
function reachOf([s, w, n, e], extra) {
  const dLat = REACH_MILES / 69;
  const dLon = REACH_MILES / (69 * Math.max(0.2, Math.cos((((s + n) / 2) * Math.PI) / 180)));
  const out = [s - dLat, w - dLon, n + dLat, e + dLon];
  if (extra) {
    out[0] = Math.min(out[0], extra[0]);
    out[1] = Math.min(out[1], extra[1]);
    out[2] = Math.max(out[2], extra[2]);
    out[3] = Math.max(out[3], extra[3]);
  }
  return out.map((v) => Math.round(v * 100) / 100);
}

/** The area to cover for a point: its state where NWS names one, else a box. */
async function areaFor(lat, lon) {
  if (inNWSCoverage(lat, lon)) {
    const { state, timeZone } = await nwsState(lat, lon).catch(() => ({}));
    if (state && STATE_BOUNDS[state]) {
      return {
        name: state,
        bounds: STATE_BOUNDS[state],
        center: STATE_CENTERS[state],
        reach: reachOf(STATE_BOUNDS[state], REACH_EXTRA[state]),
        timeZone,
      };
    }
  }
  const halfLat = 2;
  const halfLon = Math.min(8, 2 / Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bounds = [Math.max(-85, lat - halfLat), lon - halfLon, Math.min(85, lat + halfLat), lon + halfLon];
  return { name: null, bounds, center: [lat, lon], reach: reachOf(bounds) };
}

/**
 * The area to open the wind map on. The wind itself is not fetched here: the
 * browser asks Open-Meteo for it, so the request counts against the viewer's
 * own IP rather than the shared one this server sits behind.
 */
export async function getWindMap(lat, lon) {
  const area = await areaFor(lat, lon);
  return {
    area: { name: area.name, bounds: area.bounds, center: area.center, reach: area.reach },
    // The location's own zone where NWS gave one; otherwise the browser takes
    // the zone Open-Meteo reports for the arrows nearest the location.
    timezone: area.timeZone || null,
  };
}
