// Surf conditions: wave height, period, water temperature, tides, and the
// biggest swell within a radius.
//
// Waves and sea-surface temperature come from Open-Meteo's marine model; tides
// come from NOAA CO-OPS harmonic predictions at the nearest tide station.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cached, cToF, fetchJSON, haversineMiles, offsetMiles, sunTimes } from './util.js';
import { BEACH_RINGS, beachesWithin, nearestCity } from './places.js';

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

export async function nearestTideStation(lat, lon) {
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

/**
 * The latest observation of one CO-OPS product at a station, or null.
 *
 * Most tide stations only carry water level. The rest of the sensor suite —
 * water temperature, salinity, conductivity — is fitted station by station, and
 * asking for one a station does not have is answered with an error body rather
 * than an empty list, so "not offered here" and "upstream is down" both land in
 * the same place: null, and the caller renders without it.
 */
export async function stationLatest(station, product) {
  try {
    const url =
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=${product}` +
      `&units=english&time_zone=lst_ldt&format=json&date=latest&station=${station.id}`;
    const data = await cached(`coops:${product}:${station.id}`, 20 * 60 * 1000, () =>
      fetchJSON(url, { timeout: 10000 }),
    );
    const row = data?.data?.[0];
    const v = Number(row?.v);
    return Number.isFinite(v) ? { value: v, time: row.t } : null;
  } catch {
    return null;
  }
}

async function stationWaterTempF(station) {
  return (await stationLatest(station, 'water_temperature'))?.value ?? null;
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

/**
 * The closest beach that the marine model will actually talk about.
 *
 * "Nearest beach" on its own can land on a lake or river shore — sandy, named,
 * and completely flat. One cheap multi-point probe sorts the surfable ones from
 * the merely sandy, and the search widens until it finds swell rather than
 * settling for whatever was closest.
 */
export async function surfableBeach(lat, lon) {
  // Two sections now ask this same question about the same coordinates, and it
  // is the slowest thing either of them does — several Nominatim searches and a
  // multi-point marine probe. The answer is a coastline, so cache it hard.
  return cached(`beach:surfable:${lat.toFixed(2)}:${lon.toFixed(2)}`, 24 * 60 * 60 * 1000, () =>
    findSurfableBeach(lat, lon),
  );
}

async function findSurfableBeach(lat, lon) {
  let closest = null;

  for (const miles of BEACH_RINGS) {
    const beaches = await beachesWithin(lat, lon, miles);
    if (!beaches.length) continue;
    closest ||= beaches[0];

    const url =
      `https://marine-api.open-meteo.com/v1/marine?latitude=${beaches.map((b) => b.lat.toFixed(3)).join(',')}` +
      `&longitude=${beaches.map((b) => b.lon.toFixed(3)).join(',')}&current=wave_height&length_unit=imperial`;
    const probe = await fetchJSON(url, { timeout: 15000 }).catch(() => null);
    const series = Array.isArray(probe) ? probe : probe ? [probe] : [];

    const surfable = beaches.find((_, i) => series[i]?.current?.wave_height != null);
    if (surfable) return surfable;
  }

  return closest;
}

/** Ring samples used to hunt for the biggest wave nearby, nearest ring first. */
function scanPoints(lat, lon, radiusMiles) {
  const pts = [{ lat, lon }];
  for (const frac of [0.15, 0.35, 0.7, 1]) {
    for (let b = 0; b < 360; b += 45) {
      pts.push(offsetMiles(lat, lon, radiusMiles * frac, b));
    }
  }
  return pts;
}

/* ------------------------------------------------------------- daylight --- */

/**
 * NOAA returns tide times as bare local wall-clock strings. Parsing one as if
 * it were UTC gives a number that can be compared against any other wall clock
 * expressed the same way — which is all the daylight test needs.
 */
function wallClock(localIso) {
  return Date.parse(`${localIso.length === 16 ? `${localIso}:00` : localIso}Z`);
}

/**
 * The tides that fall between sunrise and sunset today — the ones you would
 * actually plan a session around. Falls back to whatever is coming up next when
 * the day's daylight tides have already passed.
 */
function daytimeTides(tides, { lat, lon, utcOffsetSeconds }) {
  if (!tides.length) return { list: [], today: false };

  const offsetMs = (utcOffsetSeconds || 0) * 1000;
  const localNow = Date.now() + offsetMs;
  const todayIso = new Date(localNow).toISOString().slice(0, 10);

  const { sunrise, sunset } = sunTimes(lat, lon, new Date(`${todayIso}T12:00:00Z`));
  const dawn = sunrise ? sunrise.getTime() + offsetMs : wallClock(`${todayIso}T06:00`);
  const dusk = sunset ? sunset.getTime() + offsetMs : wallClock(`${todayIso}T20:00`);

  const daylight = tides.filter((t) => {
    const at = wallClock(t.time);
    return t.time.startsWith(todayIso) && at >= dawn && at <= dusk;
  });
  if (daylight.length) return { list: daylight.slice(0, 2), today: true, sunrise, sunset };

  return { list: tides.filter((t) => wallClock(t.time) > localNow).slice(0, 2), today: false, sunrise, sunset };
}

/* ------------------------------------------------------------------- API --- */

export async function getSurf(lat, lon, { radiusMiles = 60, snapToBeach = true } = {}) {
  // Surf conditions belong to a beach, not to wherever the user happens to
  // live, so the whole section is anchored on the closest named one.
  const beach = snapToBeach ? await surfableBeach(lat, lon) : null;
  const originLat = beach?.lat ?? lat;
  const originLon = beach?.lon ?? lon;
  const spot = beach && {
    name: beach.name,
    lat: beach.lat,
    lon: beach.lon,
    distanceMiles: beach.distanceMiles,
  };

  const scan = scanPoints(originLat, originLon, radiusMiles);

  const [spotSeries, station] = await Promise.all([
    marine(scan).catch(() => null),
    nearestTideStation(originLat, originLon).catch(() => null),
  ]);

  if (!spotSeries) {
    return { water: false, spot, note: 'The marine model has no data for this location — it is probably too far inland.' };
  }

  // The beach itself can land on a land cell with no wave data. `scan` runs
  // outward from it, so the first entry that has waves is the closest water.
  const homeIndex = spotSeries.findIndex((s) => s?.hourly?.wave_height?.some((v) => v != null));
  const home = spotSeries[homeIndex] ?? spotSeries[0];
  const hourly = home?.hourly;
  const hasWaves = homeIndex >= 0;

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
        distanceMiles: Math.round(haversineMiles(originLat, originLon, pt.lat, pt.lon) * 10) / 10,
      };
    }
  });

  // That winning point is usually a few miles out to sea, where ordinary
  // reverse geocoding draws a blank, so name it by the town it breaks in
  // front of instead.
  if (biggest) {
    const town = await nearestCity(biggest.lat, biggest.lon);
    if (town?.name) {
      biggest.city = town.name;
      biggest.cityDistanceMiles = town.distanceMiles;
    }
  }

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

  const daytime = daytimeTides(tides, { lat: originLat, lon: originLon, utcOffsetSeconds: offset });

  return {
    water: hasWaves,
    spot,
    timezone: home?.timezone || null,
    current,
    hourly: series,
    biggest,
    scanRadiusMiles: radiusMiles,
    waterTempF,
    waterTempSource,
    tideStation: station,
    tides: daytime.list,
    tidesAreToday: daytime.today,
    note: hasWaves ? null : 'No wave data at this point — the nearest model water is outside the sampled area.',
  };
}
