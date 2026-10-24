// A field of wind arrows over the state you are in, hourly from now to the end
// of the day after tomorrow.
//
// One Open-Meteo request answers the whole grid: it takes comma-separated
// coordinate lists and returns one forecast per point. That is the only feed
// here that does; NWS would be a grid lookup and a megabyte of gridpoint JSON
// per arrow. Open-Meteo is the feed that the shared Render IP can rate limit
// out from under us (see forecast.js), so the field is cached for an hour per
// area — wind over a whole state does not need to be fresher than that, and it
// keeps this to a couple of dozen requests a day however many people look.
//
// "The state you are in" comes from the NWS point lookup the forecast already
// makes and holds for a month. Outside NWS coverage there is no state to ask
// for, so the field covers a box of about 250 miles around the point instead.

import { cached, fetchJSON } from './util.js';
import { inNWSCoverage } from './alerts.js';
import { nwsState } from './nwsforecast.js';

const HOUR_MS = 3600000;

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

// Arrows along the longer side of the area. Enough to read the pattern across a
// state from a phone without the arrows touching; Open-Meteo bills a
// multi-point request per point, so this is also the cost of one refresh.
const ACROSS = 11;
const MAX_POINTS = 130;

/** The area to cover for a point: its state where NWS names one, else a box. */
async function areaFor(lat, lon) {
  if (inNWSCoverage(lat, lon)) {
    const { state, timeZone } = await nwsState(lat, lon).catch(() => ({}));
    if (state && STATE_BOUNDS[state]) return { key: state, name: state, bounds: STATE_BOUNDS[state], timeZone };
  }
  // Two-degree cells, so everyone in the same neighbourhood shares one field.
  const cLat = Math.round(lat / 2) * 2;
  const cLon = Math.round(lon / 2) * 2;
  const halfLat = 2;
  const halfLon = Math.min(8, 2 / Math.max(0.2, Math.cos((cLat * Math.PI) / 180)));
  return {
    key: `${cLat},${cLon}`,
    name: null,
    bounds: [Math.max(-85, cLat - halfLat), cLon - halfLon, Math.min(85, cLat + halfLat), cLon + halfLon],
  };
}

/**
 * Evenly spaced points over the area, square on the ground rather than in
 * degrees — a degree of longitude in Montana is three-quarters of one in Texas.
 */
function gridOver([s, w, n, e]) {
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const widthMi = (e - w) * Math.cos(midLat);
  const heightMi = n - s;
  let step = Math.max(widthMi, heightMi) / (ACROSS - 1);
  let cols;
  let rows;
  for (;;) {
    cols = Math.max(2, Math.round(widthMi / step) + 1);
    rows = Math.max(2, Math.round(heightMi / step) + 1);
    if (cols * rows <= MAX_POINTS) break;
    step *= 1.1;
  }
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        lat: Math.round((s + ((n - s) * r) / (rows - 1)) * 1000) / 1000,
        lon: Math.round((w + ((e - w) * c) / (cols - 1)) * 1000) / 1000,
      });
    }
  }
  return points;
}

export async function getWindMap(lat, lon) {
  const area = await areaFor(lat, lon);
  return cached(
    `windmap:${area.key}`,
    HOUR_MS,
    async () => {
      const points = gridOver(area.bounds);
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${points.map((p) => p.lat).join(',')}` +
        `&longitude=${points.map((p) => p.lon).join(',')}` +
        `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph` +
        `&forecast_days=4&timeformat=unixtime&timezone=auto`;
      const raw = await fetchJSON(url, { timeout: 25000 });
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length !== points.length) throw new Error('Open-Meteo returned the wrong number of wind points');

      // Each point's series starts at its own local midnight, so a state split
      // between two zones — or a grid reaching into Gulf water Open-Meteo files
      // under a nautical zone — does not line up by index. Line them up by
      // instant instead, over the hours every point has.
      const first = Math.max(...list.map((r) => r.hourly.time[0]));
      const last = Math.min(...list.map((r) => r.hourly.time[r.hourly.time.length - 1]));
      const times = [];
      for (let t = first; t <= last; t += 3600) times.push(t * 1000);
      const round = (v) => (v == null ? null : Math.round(v));
      const along = (r, key) => {
        const offset = r.hourly.time.indexOf(first);
        return r.hourly[key].slice(offset, offset + times.length).map(round);
      };
      return {
        area: { name: area.name, bounds: area.bounds },
        // Slider labels read in the location's own zone where NWS gave one.
        timezone: area.timeZone || list[Math.floor(list.length / 2)].timezone,
        times,
        points: points.map((p, i) => ({
          lat: p.lat,
          lon: p.lon,
          mph: along(list[i], 'wind_speed_10m'),
          gust: along(list[i], 'wind_gusts_10m'),
          dir: along(list[i], 'wind_direction_10m'),
        })),
        updated: Date.now(),
      };
    },
    { errorTtlMs: 2 * 60 * 1000 },
  );
}
