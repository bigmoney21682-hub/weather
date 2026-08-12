// A forecast built from the National Weather Service, for points it covers.
//
// This exists because the keyless Open-Meteo tier is rate limited per IP, and on
// a free Render instance that IP is shared with whoever else is on the box. The
// app's own traffic is nowhere near the daily cap, but the cap is not the app's
// to spend — a neighbour can exhaust it and take the forecast down with them.
// api.weather.gov has no such cap, is already trusted here for alerts, and is
// the upstream Open-Meteo is repackaging for US points anyway.
//
// It answers in the shape `lib/forecast.js` already returns, so nothing
// downstream knows which feed it got. What it cannot supply is the sun: NWS
// publishes no solar times, so those are computed locally (see solar.js).
//
// Three requests back this, all cached: the point lookup that maps a coordinate
// onto a forecast grid (which never changes, so it is held for a month), the
// grid itself, and the nearest station's latest observation for current
// conditions.

import { cached, fetchJSON } from './util.js';
import { sunTimes } from './solar.js';
import { describeCode } from './weathercodes.js';

const NWS = 'https://api.weather.gov';
const HOUR_MS = 3600000;
const FORECAST_DAYS = 4;

/* ------------------------------------------------------------------ units -- */

const cToF = (c) => (c == null ? null : c * 1.8 + 32);
const kmhToMph = (k) => (k == null ? null : k / 1.609344);
const mmToInch = (mm) => (mm == null ? null : mm / 25.4);
const paToMb = (pa) => (pa == null ? null : pa / 100);
const mToFt = (m) => (m == null ? null : Math.round(m * 3.28084));

const round = (v, places = 1) => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * A gust is never less than the wind it gusts above.
 *
 * The two can arrive from different places — a station reports its sustained
 * wind but only reports a gust when there is one, so the gust falls back to the
 * grid's expectation for the hour. Read straight, that produced "9 mph, gusting
 * 8" on the front of the card.
 */
const gustAtLeastWind = (gust, wind) => {
  if (gust == null) return wind;
  if (wind == null) return gust;
  return Math.max(gust, wind);
};

/* --------------------------------------------------------------- timezone -- */

/** Seconds east of UTC in `timeZone` at `instant`, DST included. */
function zoneOffsetSeconds(instant, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName').value;
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "GMT" with no offset is UTC itself
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

/** Wall-clock date and time in `timeZone`, as `{ date: 'Y-M-D', time: 'HH:MM' }`. */
function wallClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * An instant as an ISO stamp carrying the location's own offset.
 *
 * The client reads sun times with `new Date(...)`, which resolves a bare local
 * stamp against the *browser's* zone — right only while you are looking at your
 * own city. Spelling the offset out makes the instant unambiguous wherever it is
 * read from.
 */
function isoWithOffset(instant, timeZone) {
  const offset = zoneOffsetSeconds(instant, timeZone);
  const local = new Date(instant.getTime() + offset * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const abs = Math.abs(offset);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`
  );
}

/** Midnight, local to `timeZone`, on the day `instant` falls in. */
function localMidnight(instant, timeZone) {
  const [y, m, d] = wallClock(instant, timeZone).date.split('-').map(Number);
  const utcNoonish = Date.UTC(y, m - 1, d);
  // Two passes: the first uses the offset in force now, the second the one in
  // force at the answer. They differ on the two days a year the clocks change.
  const first = utcNoonish - zoneOffsetSeconds(instant, timeZone) * 1000;
  return utcNoonish - zoneOffsetSeconds(new Date(first), timeZone) * 1000;
}

/* ------------------------------------------------------------ grid series -- */

/** ISO 8601 duration -> milliseconds. NWS uses only days, hours and minutes. */
function durationMs(text) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(text);
  if (!m) return HOUR_MS;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3] || 0) * 60) * 1000;
}

/**
 * A gridded layer, spread onto the hours it covers.
 *
 * NWS states each value once for the whole span it holds over — six hours of
 * one temperature, eleven of one sky. `accumulated` marks the layers where that
 * value is a total for the span rather than a level throughout it, so rainfall
 * gets divided across its hours instead of counted once per hour.
 *
 * @returns {Map<number, number>} hour-start epoch ms -> value
 */
function spreadHourly(layer, { convert = (v) => v, accumulated = false } = {}) {
  const out = new Map();
  for (const entry of layer?.values || []) {
    if (entry.value == null) continue;
    const [startText, durationText] = entry.validTime.split('/');
    const start = Date.parse(startText);
    if (!Number.isFinite(start)) continue;
    const span = durationMs(durationText);
    const hours = Math.max(1, Math.round(span / HOUR_MS));
    const value = convert(entry.value);
    const each = accumulated && value != null ? value / hours : value;
    for (let i = 0; i < hours; i++) out.set(start + i * HOUR_MS, each);
  }
  return out;
}

/* --------------------------------------------------------- weather coding -- */

// NWS names the weather; we answer in the WMO codes the client already draws
// icons for. Each family is [light, moderate, heavy] so an intensity can pick
// within it, and the rank decides which of several simultaneous entries is the
// one worth showing — an hour of "chance of thunderstorms and light rain
// showers" is a thunderstorm hour.
const WEATHER_FAMILIES = {
  thunderstorms: { codes: [95, 95, 96], rank: 100 },
  hail: { codes: [96, 96, 99], rank: 99 },
  freezing_rain: { codes: [66, 66, 67], rank: 90 },
  freezing_drizzle: { codes: [56, 56, 57], rank: 88 },
  sleet: { codes: [66, 66, 67], rank: 87 },
  ice_crystals: { codes: [77, 77, 77], rank: 60 },
  snow: { codes: [71, 73, 75], rank: 80 },
  snow_showers: { codes: [85, 85, 86], rank: 79 },
  blowing_snow: { codes: [73, 73, 75], rank: 78 },
  rain: { codes: [61, 63, 65], rank: 70 },
  rain_showers: { codes: [80, 81, 82], rank: 69 },
  drizzle: { codes: [51, 53, 55], rank: 50 },
  freezing_fog: { codes: [48, 48, 48], rank: 40 },
  ice_fog: { codes: [48, 48, 48], rank: 39 },
  fog: { codes: [45, 45, 45], rank: 38 },
  haze: { codes: [45, 45, 45], rank: 20 },
  smoke: { codes: [45, 45, 45], rank: 19 },
  blowing_dust: { codes: [45, 45, 45], rank: 18 },
  blowing_sand: { codes: [45, 45, 45], rank: 17 },
};

const INTENSITY_SLOT = { very_light: 0, light: 0, moderate: 1, heavy: 2 };

/** Sky cover percentage -> the clear/cloudy end of the WMO scale. */
function skyCode(cover) {
  if (cover == null) return null;
  if (cover <= 12) return 0;
  if (cover <= 37) return 1;
  if (cover <= 75) return 2;
  return 3;
}

/** The most significant of the weather entries NWS lists for one hour. */
function weatherCode(entries) {
  let best = null;
  let bestRank = -1;
  for (const entry of entries || []) {
    const family = WEATHER_FAMILIES[entry.weather];
    if (!family) continue;
    // Hail is reported as an attribute of a thunderstorm, not as its own entry.
    const hail = (entry.attributes || []).some((a) => String(a).includes('hail'));
    const slot = INTENSITY_SLOT[entry.intensity] ?? 1;
    const code = hail && entry.weather === 'thunderstorms' ? (slot >= 2 ? 99 : 96) : family.codes[slot];
    if (family.rank > bestRank) {
      bestRank = family.rank;
      best = code;
    }
  }
  return best;
}

// Current conditions arrive as a phrase rather than a code. Ordered longest and
// most specific first, so "light freezing rain" is not read as "rain".
const OBSERVED_PHRASES = [
  [/freezing (rain|drizzle)/, 66],
  [/ice pellets|sleet/, 66],
  [/thunder/, 95],
  [/heavy snow/, 75],
  [/snow/, 73],
  [/heavy rain/, 65],
  [/(rain|shower)/, 63],
  [/drizzle/, 53],
  [/(fog|mist)/, 45],
  [/(haze|smoke|dust|sand|ash)/, 45],
  [/overcast/, 3],
  [/(mostly|considerable) cloud/, 3],
  [/partly (cloudy|sunny)|scattered cloud/, 2],
  [/(mostly|partly) (clear|sunny)|few cloud/, 1],
  [/(clear|fair|sunny)/, 0],
];

function observedCode(text) {
  const said = String(text || '').toLowerCase();
  for (const [pattern, code] of OBSERVED_PHRASES) if (pattern.test(said)) return code;
  return null;
}

/* ---------------------------------------------------------------- fetches -- */

/**
 * The forecast grid a coordinate falls in. NWS rounds coordinates to four
 * decimals itself and the grid a point sits in does not move, so this is held
 * for a month — it is the one request here that never needs to be fresh.
 */
async function gridFor(lat, lon) {
  const key = `nws:point:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  return cached(key, 30 * 24 * 3600 * 1000, async () => {
    const data = await fetchJSON(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const p = data?.properties;
    if (!p?.gridId || !p?.timeZone) throw new Error('NWS returned no forecast grid for this point');
    return { office: p.gridId, x: p.gridX, y: p.gridY, timeZone: p.timeZone };
  });
}

async function gridData(grid) {
  const key = `nws:grid:${grid.office}:${grid.x},${grid.y}`;
  return cached(
    key,
    5 * 60 * 1000,
    async () => {
      const data = await fetchJSON(`${NWS}/gridpoints/${grid.office}/${grid.x},${grid.y}`, { timeout: 20000 });
      if (!data?.properties?.temperature) throw new Error('NWS grid held no temperature series');
      return data.properties;
    },
    { errorTtlMs: 30 * 1000 },
  );
}

/**
 * The latest observation from the nearest station that has one worth having.
 *
 * Stations go quiet, and a reading from four hours ago is worse than no reading
 * at all when the grid can say what this hour looks like. Walks the nearest few
 * and keeps the first that has reported recently — but keeps looking if that one
 * has no barometer, because a station reporting everything but pressure leaves a
 * dash on the front of the card that a neighbour a few miles away can fill.
 */
async function latestObservation(grid) {
  const stationsKey = `nws:stations:${grid.office}:${grid.x},${grid.y}`;
  const stations = await cached(stationsKey, 7 * 24 * 3600 * 1000, async () => {
    const data = await fetchJSON(`${NWS}/gridpoints/${grid.office}/${grid.x},${grid.y}/stations`);
    return (data?.features || []).slice(0, 4).map((f) => f.properties?.stationIdentifier).filter(Boolean);
  }).catch(() => []);

  let fallback = null;
  for (const station of stations) {
    const observation = await cached(
      `nws:obs:${station}`,
      5 * 60 * 1000,
      () => fetchJSON(`${NWS}/stations/${station}/observations/latest`).then((d) => d?.properties || null),
      { errorTtlMs: 60 * 1000 },
    ).catch(() => null);
    if (!observation?.timestamp) continue;
    const age = Date.now() - Date.parse(observation.timestamp);
    if (age < 0 || age >= 2 * HOUR_MS) continue;
    const hasPressure =
      observation.seaLevelPressure?.value != null || observation.barometricPressure?.value != null;
    if (hasPressure) return observation;
    fallback ??= observation;
  }
  return fallback;
}

/* --------------------------------------------------------------- assembly -- */

export async function getNwsForecast(lat, lon) {
  const grid = await gridFor(lat, lon);
  const timeZone = grid.timeZone;
  const [props, observation] = await Promise.all([gridData(grid), latestObservation(grid)]);

  const series = {
    tempF: spreadHourly(props.temperature, { convert: cToF }),
    feelsF: spreadHourly(props.apparentTemperature, { convert: cToF }),
    humidity: spreadHourly(props.relativeHumidity),
    windMph: spreadHourly(props.windSpeed, { convert: kmhToMph }),
    gustMph: spreadHourly(props.windGust, { convert: kmhToMph }),
    windDir: spreadHourly(props.windDirection),
    precipChance: spreadHourly(props.probabilityOfPrecipitation),
    precipIn: spreadHourly(props.quantitativePrecipitation, { convert: mmToInch, accumulated: true }),
    sky: spreadHourly(props.skyCover),
    weather: spreadHourly(props.weather, { convert: weatherCode }),
  };

  // Four days from local midnight, which is the window Open-Meteo was asked for
  // and the one the day strip and the wind chart are built around.
  const start = localMidnight(new Date(), timeZone);
  const hourCount = FORECAST_DAYS * 24;

  // Sun times first: they decide day from night for every hour, and the client
  // uses them to shade the wind chart overnight.
  const days = [];
  const daylightSpans = [];
  for (let d = 0; d < FORECAST_DAYS; d++) {
    const midday = new Date(start + d * 24 * HOUR_MS + 12 * HOUR_MS);
    const { date } = wallClock(midday, timeZone);
    const [y, m, dd] = date.split('-').map(Number);
    const { sunrise, sunset } = sunTimes([y, m, dd], lat, lon, timeZone);
    // The instants stay out of the day objects — those go to the client, and
    // `current` still needs to ask about daylight after the days are finished.
    daylightSpans.push(sunrise && sunset ? [sunrise.getTime(), sunset.getTime()] : null);
    days.push({
      date,
      sunrise: sunrise ? isoWithOffset(sunrise, timeZone) : null,
      sunset: sunset ? isoWithOffset(sunset, timeZone) : null,
      highF: null,
      lowF: null,
    });
  }

  const isDaylight = (ms) => {
    if (daylightSpans.some((span) => span && ms >= span[0] && ms < span[1])) return true;
    // Polar day or night: nothing crossed the horizon to compare against, so
    // fall back to the sun being up in the middle of the local day.
    if (daylightSpans.some(Boolean)) return false;
    const hour = Number(wallClock(new Date(ms), timeZone).time.slice(0, 2));
    return hour >= 6 && hour < 18;
  };

  const hours = [];
  for (let i = 0; i < hourCount; i++) {
    const ms = start + i * HOUR_MS;
    const tempF = series.tempF.get(ms) ?? null;
    // An hour the grid does not reach is not worth inventing. Missing hours
    // before the grid starts are skipped — late in the day, local midnight can
    // fall off the back of it — but once the series has begun a hole in it ends
    // it, because everything downstream reads these as evenly spaced.
    if (tempF == null) {
      if (hours.length) break;
      continue;
    }
    const code = series.weather.get(ms) ?? skyCode(series.sky.get(ms)) ?? 3;
    const { date, time } = wallClock(new Date(ms), timeZone);
    hours.push({
      time: `${date}T${time}`,
      epoch: Math.floor(ms / 1000),
      tempF: round(tempF),
      feelsF: round(series.feelsF.get(ms) ?? tempF),
      precipChance: series.precipChance.get(ms) ?? 0,
      precipIn: round(series.precipIn.get(ms) ?? 0, 3),
      windMph: round(series.windMph.get(ms) ?? null),
      gustMph: round(gustAtLeastWind(series.gustMph.get(ms) ?? null, series.windMph.get(ms) ?? null)),
      windDir: series.windDir.get(ms) ?? null,
      humidity: series.humidity.get(ms) ?? null,
      // NWS publishes no UV index. Nothing in the client reads it, and a made-up
      // number would be worse than an honest absence.
      uv: null,
      isDay: isDaylight(ms),
      ...describeCode(code),
      code,
    });
  }

  if (!hours.length) throw new Error('NWS grid held no hours for this point');

  // Highs, lows and a representative icon per day, read off the hours rather
  // than off the max/min grids — those are stated over forecaster-chosen spans
  // that do not line up with local midnight.
  for (const day of days) {
    const mine = hours.filter((h) => h.time.startsWith(day.date));
    if (!mine.length) continue;
    day.highF = Math.round(Math.max(...mine.map((h) => h.tempF)));
    day.lowF = Math.round(Math.min(...mine.map((h) => h.tempF)));
    // The day's face is its most significant daylight hour, so an afternoon of
    // storms is not hidden behind a clear morning. Codes at or above 45 are
    // weather and outrank any amount of cloud; below that the scale runs clear
    // to overcast, and the cloudiest reading is the honest one.
    const daylight = mine.filter((h) => h.isDay);
    const code = (daylight.length ? daylight : mine)
      .map((h) => h.code)
      .sort((a, b) => (b >= 45 ? b : -b) - (a >= 45 ? a : -a))[0];
    Object.assign(day, describeCode(code));
  }

  // A day the grid does not reach at all would show as a column of dashes.
  // Better to offer three days than four with one of them empty.
  const covered = days.filter((d) => d.highF != null);

  const nowMs = Date.now();
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const fromGrid = hours.find((h) => h.epoch * 1000 === currentHour) || hours[0];

  const observedTempF = cToF(observation?.temperature?.value);
  const observedCodeValue = observedCode(observation?.textDescription);
  const nowLocal = wallClock(new Date(nowMs), timeZone);
  const windMph = kmhToMph(observation?.windSpeed?.value) ?? fromGrid.windMph;
  const current = {
    time: `${nowLocal.date}T${nowLocal.time}`,
    tempF: round(observedTempF ?? fromGrid.tempF),
    feelsF: round(
      cToF(observation?.heatIndex?.value ?? observation?.windChill?.value) ?? observedTempF ?? fromGrid.feelsF,
    ),
    humidity: round(observation?.relativeHumidity?.value ?? fromGrid.humidity),
    windMph: round(windMph),
    // Stations report a gust only when there is one to report, so a null here is
    // "no gusts", not "unknown" — but the grid still has an expectation for the
    // hour, and the wind tile reads better with it than with a dash.
    gustMph: round(gustAtLeastWind(kmhToMph(observation?.windGust?.value) ?? fromGrid.gustMph, windMph)),
    windDir: observation?.windDirection?.value ?? fromGrid.windDir,
    precipIn: fromGrid.precipIn,
    pressureMb: round(
      paToMb(observation?.seaLevelPressure?.value ?? observation?.barometricPressure?.value),
    ),
    isDay: isDaylight(nowMs),
    ...describeCode(observedCodeValue ?? fromGrid.code),
  };

  return {
    source: 'nws',
    timezone: timeZone,
    utcOffsetSeconds: zoneOffsetSeconds(new Date(nowMs), timeZone),
    elevationFt: mToFt(props.elevation?.value),
    current,
    hours,
    days: covered,
  };
}
