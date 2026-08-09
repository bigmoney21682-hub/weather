// Air quality: US AQI where you are, a short forecast, and anything worse
// nearby. "Advisories" combine NWS air-quality alerts (Air Quality Alert, dense
// smoke, ozone action days) with model hot spots inside the search radius.

import { getAlerts, getNearbyAlerts } from './alerts.js';
import { cached, fetchJSON, haversineMiles, offsetMiles } from './util.js';

const AIR_ALERT_EVENTS = /air quality|smoke|ozone|particulate|dust/i;

const CATEGORIES = [
  [0, 50, 'Good', 'good', 'Air quality is satisfactory.'],
  [51, 100, 'Moderate', 'moderate', 'Unusually sensitive people should consider limiting prolonged outdoor exertion.'],
  [101, 150, 'Unhealthy for Sensitive Groups', 'usg', 'Sensitive groups should reduce prolonged or heavy exertion outdoors.'],
  [151, 200, 'Unhealthy', 'unhealthy', 'Everyone should reduce prolonged or heavy exertion outdoors.'],
  [201, 300, 'Very Unhealthy', 'very-unhealthy', 'Everyone should avoid prolonged or heavy exertion outdoors.'],
  [301, 1000, 'Hazardous', 'hazardous', 'Everyone should avoid all physical activity outdoors.'],
];

export function aqiCategory(aqi) {
  if (aqi == null) return { label: 'Unknown', class: 'unknown', advice: null };
  for (const [lo, hi, label, cls, advice] of CATEGORIES) {
    if (aqi >= lo && aqi <= hi) return { label, class: cls, advice };
  }
  return { label: 'Hazardous', class: 'hazardous', advice: CATEGORIES[5][4] };
}

const CURRENT = 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,us_aqi_pm2_5,us_aqi_ozone';
const HOURLY = 'us_aqi,pm2_5,ozone';

function scanPoints(lat, lon, radiusMiles) {
  const pts = [{ lat, lon, home: true }];
  for (const frac of [0.5, 1]) {
    for (let b = 0; b < 360; b += 45) {
      pts.push(offsetMiles(lat, lon, radiusMiles * frac, b));
    }
  }
  return pts;
}

export async function getAirQuality(lat, lon, { radiusMiles = 60 } = {}) {
  const scan = scanPoints(lat, lon, radiusMiles);
  const lats = scan.map((p) => p.lat.toFixed(3)).join(',');
  const lons = scan.map((p) => p.lon.toFixed(3)).join(',');
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}&longitude=${lons}` +
    `&current=${CURRENT}&hourly=${HOURLY}&timezone=auto&forecast_days=2`;

  const key = `aq:${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusMiles}`;
  const [data, nearby, here] = await Promise.all([
    cached(key, 10 * 60 * 1000, () => fetchJSON(url, { timeout: 20000 })),
    // Polygon alerts anywhere in the radius…
    getNearbyAlerts(lat, lon, radiusMiles, AIR_ALERT_EVENTS).catch(() => []),
    // …plus alerts for this exact point. Many air quality alerts are issued
    // against forecast zones rather than polygons, so they carry no geometry
    // and the radius scan cannot see them — but a point lookup resolves them.
    getAlerts(lat, lon).catch(() => ({ alerts: [] })),
  ]);

  const alerts = [];
  const seen = new Set();
  for (const a of [
    ...here.alerts.filter((a) => AIR_ALERT_EVENTS.test(a.event || '')).map((a) => ({ ...a, distanceMiles: 0 })),
    ...nearby,
  ]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    alerts.push(a);
  }

  const series = Array.isArray(data) ? data : [data];
  const home = series[0];
  const c = home?.current || {};

  const offset = home?.utc_offset_seconds || 0;
  const hourly = (home?.hourly?.time || []).map((t, i) => ({
    time: t,
    epoch: Math.floor(Date.parse(`${t}:00Z`) / 1000) - offset,
    aqi: home.hourly.us_aqi[i],
    pm25: home.hourly.pm2_5[i],
    ozone: home.hourly.ozone[i],
  }));

  // Model hot spots: anywhere in the radius meaningfully worse than home.
  const homeAqi = c.us_aqi ?? null;
  const hotspots = series
    .map((s, i) => ({ aqi: s?.current?.us_aqi ?? null, point: scan[i] }))
    .filter((x) => x.aqi != null && !x.point.home)
    .map((x) => ({
      aqi: Math.round(x.aqi),
      lat: x.point.lat,
      lon: x.point.lon,
      distanceMiles: Math.round(haversineMiles(lat, lon, x.point.lat, x.point.lon)),
      ...aqiCategory(x.aqi),
    }))
    .filter((x) => x.aqi >= 101 || (homeAqi != null && x.aqi - homeAqi >= 25))
    .sort((a, b) => b.aqi - a.aqi)
    .slice(0, 5);

  const worst = series.reduce(
    (acc, s, i) => {
      const v = s?.current?.us_aqi;
      if (v == null) return acc;
      return !acc || v > acc.aqi ? { aqi: Math.round(v), point: scan[i] } : acc;
    },
    null,
  );

  return {
    timezone: home?.timezone || null,
    current: {
      time: c.time,
      aqi: homeAqi == null ? null : Math.round(homeAqi),
      dominant: pickDominant(c),
      pm25: c.pm2_5,
      pm10: c.pm10,
      ozone: c.ozone,
      no2: c.nitrogen_dioxide,
      so2: c.sulphur_dioxide,
      co: c.carbon_monoxide,
      ...aqiCategory(homeAqi),
    },
    hourly,
    radiusMiles,
    hotspots,
    areaWorst: worst
      ? {
          aqi: worst.aqi,
          distanceMiles: Math.round(haversineMiles(lat, lon, worst.point.lat, worst.point.lon)),
          lat: worst.point.lat,
          lon: worst.point.lon,
          ...aqiCategory(worst.aqi),
        }
      : null,
    alerts,
    source: 'Open-Meteo CAMS air quality model; official alerts from the US National Weather Service.',
  };
}

function pickDominant(current) {
  const pm = current.us_aqi_pm2_5;
  const o3 = current.us_aqi_ozone;
  if (pm == null && o3 == null) return null;
  if (o3 == null || (pm != null && pm >= o3)) return 'PM2.5';
  return 'Ozone';
}
