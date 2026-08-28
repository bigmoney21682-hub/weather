// Surf conditions: wave height, period, water temperature, tides, and the
// biggest swell within a radius.
//
// Waves and sea-surface temperature come from Open-Meteo's marine model; tides
// come from NOAA CO-OPS harmonic predictions at the nearest tide station.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cached, cToF, fetchJSON, haversineMiles, sunTimes } from './util.js';
import { nearestSpot, shoreEnds, surfSpots } from './surfspots.js';

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

async function marine(points, { days = 3, current = false } = {}) {
  const lats = points.map((p) => p.lat.toFixed(3)).join(',');
  const lons = points.map((p) => p.lon.toFixed(3)).join(',');
  // Scanning dozens of spots for the biggest wave only needs what is breaking
  // now; asking for three days of hourly at every one of them is a much larger
  // response for nothing.
  const fields = current
    ? '&current=wave_height,wave_period,wave_direction'
    : `&hourly=${MARINE_HOURLY}&current=${MARINE_HOURLY}&forecast_days=${days}`;
  const url =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lats}&longitude=${lons}` +
    `${fields}&length_unit=imperial&timezone=auto`;
  const data = await fetchJSON(url, { timeout: 20000 });
  return Array.isArray(data) ? data : [data];
}

/**
 * The nearest named surf spot on the open ocean.
 *
 * Kept as an export because the ocean-quality section anchors on the same beach.
 */
export async function surfableBeach(lat, lon) {
  const { spots } = await surfSpots(lat, lon);
  return nearestSpot(spots, lat, lon);
}

// The biggest wave is only reported for spots this near, so the answer stays
// somewhere you could actually paddle out. The spot list is itself clipped to
// the section's search radius, so whichever is smaller is the real reach — and
// that is the number the card has to quote, or it claims to have looked further
// than it did.
const BIGGEST_WAVE_MILES = 40;
const biggestReach = (radiusMiles) => Math.min(radiusMiles, BIGGEST_WAVE_MILES);

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

/** How many spots either side of the nearest one to offer as pills. */
const NEIGHBOURS_EACH_WAY = 5;

// One marine request carries every spot, so this is a cap on URL length rather
// than on cost. Beyond it the nearest spots are kept.
const MAX_SCAN_SPOTS = 60;

/** Where the surf is biggest right now among the named spots within reach. */
async function biggestAtSpots(spots, lat, lon, radiusMiles) {
  const reach = spots
    .map((s) => ({ ...s, fromViewer: haversineMiles(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.fromViewer <= biggestReach(radiusMiles))
    .sort((a, b) => a.fromViewer - b.fromViewer)
    .slice(0, MAX_SCAN_SPOTS);
  if (reach.length < 2) return null;

  const series = await marine(reach, { current: true });
  let best = null;
  reach.forEach((s, i) => {
    const now = series[i]?.current;
    if (now?.wave_height == null) return;
    if (!best || now.wave_height > best.waveFt) {
      best = {
        waveFt: now.wave_height,
        periodS: now.wave_period ?? null,
        dirDeg: now.wave_direction ?? null,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        distanceMiles: Math.round(s.fromViewer * 10) / 10,
      };
    }
  });
  return best;
}

export async function getSurf(lat, lon, { radiusMiles = 30, snapToBeach = true, at = null } = {}) {
  // Surf conditions belong to a named break on the open coast, not to wherever
  // the user happens to live, so the section is anchored on one and offers the
  // spots up and down the shore from it.
  const { spots, axisBearing, unavailable } =
    snapToBeach || at ? await surfSpots(lat, lon, { miles: radiusMiles }) : { spots: [], axisBearing: 0 };

  // The pills stay anchored on the spot nearest the user even after they browse
  // away from it, so the row does not reshuffle under the finger that tapped it.
  const home = spots.length ? nearestSpot(spots, lat, lon) : null;
  const chosen = at && spots.length ? nearestSpot(spots, at.lat, at.lon) : null;
  const beach = snapToBeach || at ? (chosen ?? home) : null;

  const originLat = beach?.lat ?? at?.lat ?? lat;
  const originLon = beach?.lon ?? at?.lon ?? lon;
  const spot = beach && {
    name: beach.name,
    lat: beach.lat,
    lon: beach.lon,
    // Always measured from the viewer, so "12 mi away" means the same thing on
    // every pill whichever one is currently selected.
    distanceMiles: Math.round(haversineMiles(lat, lon, beach.lat, beach.lon) * 10) / 10,
  };

  const nearby = home
    ? spots
        .slice(Math.max(0, home.index - NEIGHBOURS_EACH_WAY), home.index + NEIGHBOURS_EACH_WAY + 1)
        .map((s) => ({
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          distanceMiles: Math.round(haversineMiles(lat, lon, s.lat, s.lon) * 10) / 10,
          selected: s.lat === originLat && s.lon === originLon,
        }))
    : [];

  const [spotSeries, station] = await Promise.all([
    marine([{ lat: originLat, lon: originLon }]).catch(() => null),
    nearestTideStation(originLat, originLon).catch(() => null),
  ]);

  if (!spotSeries) {
    return {
      water: false,
      spot,
      nearby,
      shoreEnds: shoreEnds(axisBearing),
      note: 'The marine model has no data for this location — it is probably too far inland.',
    };
  }

  const home0 = spotSeries[0];
  const hourly = home0?.hourly;
  const hasWaves = Boolean(hourly?.wave_height?.some((v) => v != null));

  const offset = home0?.utc_offset_seconds || 0;
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

  const cur = home0?.current;
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

  // Biggest wave right now, across the named spots rather than across open
  // water. Sampling a ring of points out to the scan radius, as this used to,
  // reliably found the largest swell forty miles offshore — true, and useless:
  // you cannot surf a point in the middle of the Atlantic, and it has no name to
  // report. Every candidate here is a beach you could drive to.
  const biggest = await biggestAtSpots(spots, lat, lon, radiusMiles).catch(() => null);

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
    nearby,
    shoreEnds: shoreEnds(axisBearing),
    timezone: home0?.timezone || null,
    current,
    hourly: series,
    biggest,
    scanRadiusMiles: biggestReach(radiusMiles),
    waterTempF,
    waterTempSource,
    tideStation: station,
    tides: daytime.list,
    tidesAreToday: daytime.today,
    note: noteFor({ hasWaves, snapToBeach, beach, radiusMiles, unavailable }),
  };
}

function noteFor({ hasWaves, snapToBeach, beach, radiusMiles, unavailable }) {
  if (snapToBeach && !beach) {
    return unavailable
      ? 'Could not reach the map service that finds named beaches, so this is the location itself rather than the nearest break. It usually clears within a minute.'
      : `No named ocean beach within ${radiusMiles} miles — showing conditions for the location itself. Beaches on bays, lakes and the Intracoastal are deliberately left out.`;
  }
  if (!hasWaves) return 'No wave data at this point — the marine model has no water here.';
  return null;
}
