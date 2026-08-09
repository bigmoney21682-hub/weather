// Surf conditions: wave height, period, water temperature, tides, and the
// biggest swell within a radius.
//
// Waves and sea-surface temperature come from Open-Meteo's marine model; tides
// come from NOAA CO-OPS harmonic predictions at the nearest tide station.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cached, cToF, fetchJSON, haversineMiles, offsetMiles } from './util.js';

const CACHE_DIR = path.join(process.cwd(), '.cache');
const STATIONS_FILE = path.join(CACHE_DIR, 'noaa-tide-stations.json');
const STATIONS_TTL = 30 * 24 * 60 * 60 * 1000;

const MARINE_HOURLY = 'wave_height,wave_period,wave_direction,wind_wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature';

function iso(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/* ----------------------------------------------------------------- tides --- */

async function tideStations() {
  const memo = await cached('tides:stations', STATIONS_TTL, async () => {
    try {
      const stat = await fs.stat(STATIONS_FILE);
      if (Date.now() - stat.mtimeMs < STATIONS_TTL) {
        return JSON.parse(await fs.readFile(STATIONS_FILE, 'utf8'));
      }
    } catch {
      /* no usable cache on disk */
    }
    const data = await fetchJSON(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions',
      { timeout: 30000 },
    );
    // Keep only what we need; the raw file is ~2 MB of metadata we never read.
    const slim = (data.stations || []).map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      lat: s.lat,
      lon: s.lng,
    }));
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(STATIONS_FILE, JSON.stringify(slim));
    return slim;
  });
  return memo;
}

async function nearestTideStation(lat, lon) {
  const stations = await tideStations();
  let best = null;
  for (const s of stations) {
    const d = haversineMiles(lat, lon, s.lat, s.lon);
    if (!best || d < best.distanceMiles) best = { ...s, distanceMiles: d };
  }
  if (!best || best.distanceMiles > 120) return null;
  best.distanceMiles = Math.round(best.distanceMiles * 10) / 10;
  return best;
}

async function tidesFor(station) {
  const start = new Date();
  const end = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  const url =
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&datum=MLLW' +
    `&interval=hilo&units=english&time_zone=lst_ldt&format=json&station=${station.id}` +
    `&begin_date=${iso(start)}&end_date=${iso(end)}`;
  const data = await cached(`tides:${station.id}`, 30 * 60 * 1000, () => fetchJSON(url));
  return (data.predictions || []).map((p) => ({
    time: p.t.replace(' ', 'T'),
    heightFt: Number(p.v),
    kind: p.type === 'H' ? 'High' : 'Low',
  }));
}

async function stationWaterTempF(station) {
  try {
    const url =
      'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature' +
      `&units=english&time_zone=lst_ldt&format=json&date=latest&station=${station.id}`;
    const data = await cached(`wtemp:${station.id}`, 20 * 60 * 1000, () => fetchJSON(url, { timeout: 10000 }));
    const v = Number(data?.data?.[0]?.v);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- waves --- */

async function marine(points, { days = 3 } = {}) {
  const lats = points.map((p) => p.lat.toFixed(3)).join(',');
  const lons = points.map((p) => p.lon.toFixed(3)).join(',');
  const url =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lats}&longitude=${lons}` +
    `&hourly=${MARINE_HOURLY}&current=${MARINE_HOURLY}` +
    `&length_unit=imperial&timezone=auto&forecast_days=${days}`;
  const data = await fetchJSON(url, { timeout: 20000 });
  return Array.isArray(data) ? data : [data];
}

/** Ring samples used to hunt for the biggest wave nearby. */
function scanPoints(lat, lon, radiusMiles) {
  const pts = [{ lat, lon }];
  for (const frac of [0.35, 0.7, 1]) {
    for (let b = 0; b < 360; b += 45) {
      pts.push(offsetMiles(lat, lon, radiusMiles * frac, b));
    }
  }
  return pts;
}

/* ------------------------------------------------------------------- API --- */

export async function getSurf(lat, lon, { radiusMiles = 60 } = {}) {
  const scan = scanPoints(lat, lon, radiusMiles);

  const [spotSeries, station] = await Promise.all([
    marine(scan).catch(() => null),
    nearestTideStation(lat, lon).catch(() => null),
  ]);

  if (!spotSeries) {
    return { water: false, note: 'The marine model has no data for this location — it is probably too far inland.' };
  }

  const home = spotSeries[0];
  const hourly = home?.hourly;
  const hasWaves = hourly && hourly.wave_height?.some((v) => v != null);

  const offset = home?.utc_offset_seconds || 0;
  const series = hasWaves
    ? hourly.time.map((t, i) => ({
        time: t,
        epoch: Math.floor(Date.parse(`${t}:00Z`) / 1000) - offset,
        waveFt: hourly.wave_height[i],
        periodS: hourly.wave_period[i],
        dirDeg: hourly.wave_direction[i],
        swellFt: hourly.swell_wave_height[i],
        swellPeriodS: hourly.swell_wave_period[i],
        windWaveFt: hourly.wind_wave_height[i],
        waterTempF: cToF(hourly.sea_surface_temperature[i]),
      }))
    : [];

  const cur = home?.current;
  const current = hasWaves
    ? {
        waveFt: cur?.wave_height ?? null,
        periodS: cur?.wave_period ?? null,
        dirDeg: cur?.wave_direction ?? null,
        swellFt: cur?.swell_wave_height ?? null,
        swellPeriodS: cur?.swell_wave_period ?? null,
        waterTempF: cToF(cur?.sea_surface_temperature),
      }
    : null;

  // Biggest wave in the radius, right now.
  let biggest = null;
  spotSeries.forEach((s, i) => {
    const h = s?.current?.wave_height;
    if (h == null) return;
    const pt = scan[i];
    if (!biggest || h > biggest.waveFt) {
      biggest = {
        waveFt: h,
        periodS: s.current.wave_period ?? null,
        dirDeg: s.current.wave_direction ?? null,
        lat: pt.lat,
        lon: pt.lon,
        distanceMiles: Math.round(haversineMiles(lat, lon, pt.lat, pt.lon) * 10) / 10,
      };
    }
  });

  let tides = [];
  let waterTempF = current?.waterTempF ?? null;
  let waterTempSource = current?.waterTempF != null ? 'Marine model (sea surface)' : null;
  if (station) {
    tides = await tidesFor(station).catch(() => []);
    const observed = await stationWaterTempF(station);
    if (observed != null) {
      waterTempF = observed;
      waterTempSource = `Observed at ${station.name} (${station.distanceMiles} mi)`;
    }
  }

  return {
    water: hasWaves,
    timezone: home?.timezone || null,
    current,
    hourly: series,
    biggest,
    scanRadiusMiles: radiusMiles,
    waterTempF,
    waterTempSource,
    tideStation: station,
    tides,
    note: hasWaves ? null : 'No wave data at this point — the nearest model water is outside the sampled area.',
  };
}
