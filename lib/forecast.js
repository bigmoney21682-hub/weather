// The forecast behind the Weather and Wind sections: current conditions, hourly
// for today, and a multi-day series.
//
// Two feeds answer this. Inside NWS coverage it is api.weather.gov, which has no
// per-IP daily cap — see nwsforecast.js for why that matters on a shared host.
// Everywhere else, and whenever NWS cannot answer, it is Open-Meteo. Both are
// keyless and both come back in the shape below, so the sections downstream
// never learn which one they got.

import { cached, fetchJSON } from './util.js';
import { describeCode } from './weathercodes.js';
import { inNWSCoverage } from './alerts.js';
import { getNwsForecast } from './nwsforecast.js';

const HOURLY = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'relative_humidity_2m',
  'uv_index',
  'is_day',
].join(',');

const CURRENT = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'precipitation',
  'is_day',
  'pressure_msl',
].join(',');

const DAILY = ['sunrise', 'sunset', 'temperature_2m_max', 'temperature_2m_min', 'weather_code'].join(',');

/**
 * A bare local stamp, given the offset it was written in.
 *
 * Open-Meteo returns solar times as wall time with nothing to anchor them, and
 * the client reads them with `new Date(...)`, which resolves a bare stamp
 * against whatever zone the *browser* is in. That is right only while you are
 * looking at your own city: Tokyo's 04:57 sunrise, read in Chicago and then
 * printed as Tokyo time, came out as "5:57 PM". Spelling the offset out fixes
 * it, and matches what the NWS feed already returns.
 */
function withOffset(stamp, offsetSeconds) {
  if (!stamp) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const abs = Math.abs(offsetSeconds);
  const seconds = stamp.length === 16 ? `${stamp}:00` : stamp;
  return `${seconds}${offsetSeconds < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

async function openMeteoForecast(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=4`;

  // A location nobody has asked for yet has no stale reading to fall back on,
  // which is exactly when a rate-limited Open-Meteo becomes a visible error
  // rather than a slightly old one. Remembering the failure briefly means the
  // next visitor to that cold spot waits on a cached "no" instead of adding
  // another request to whatever is already over the limit.
  const raw = await cached(`fc:${lat.toFixed(3)}:${lon.toFixed(3)}`, 5 * 60 * 1000, () => fetchJSON(url), {
    errorTtlMs: 30 * 1000,
  });

  const h = raw.hourly;
  const hours = h.time.map((t, i) => ({
    time: t,
    // Open-Meteo stamps are wall time at the location. Read them as UTC, then
    // back out the location's offset to get a true instant.
    epoch: Math.floor(Date.parse(`${t}:00Z`) / 1000) - raw.utc_offset_seconds,
    tempF: h.temperature_2m[i],
    feelsF: h.apparent_temperature[i],
    precipChance: h.precipitation_probability[i],
    precipIn: h.precipitation[i],
    windMph: h.wind_speed_10m[i],
    gustMph: h.wind_gusts_10m[i],
    windDir: h.wind_direction_10m[i],
    humidity: h.relative_humidity_2m[i],
    uv: h.uv_index[i],
    isDay: h.is_day[i] === 1,
    ...describeCode(h.weather_code[i]),
    code: h.weather_code[i],
  }));

  const c = raw.current;
  const days = raw.daily.time.map((t, i) => ({
    date: t,
    sunrise: withOffset(raw.daily.sunrise[i], raw.utc_offset_seconds),
    sunset: withOffset(raw.daily.sunset[i], raw.utc_offset_seconds),
    highF: raw.daily.temperature_2m_max[i],
    lowF: raw.daily.temperature_2m_min[i],
    ...describeCode(raw.daily.weather_code[i]),
  }));

  return {
    source: 'open-meteo',
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds,
    elevationFt: raw.elevation == null ? null : Math.round(raw.elevation * 3.28084),
    current: {
      time: c.time,
      tempF: c.temperature_2m,
      feelsF: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windMph: c.wind_speed_10m,
      gustMph: c.wind_gusts_10m,
      windDir: c.wind_direction_10m,
      precipIn: c.precipitation,
      pressureMb: c.pressure_msl,
      isDay: c.is_day === 1,
      ...describeCode(c.weather_code),
    },
    hours,
    days,
  };
}

/**
 * The forecast for a point, preferring the feed that cannot be rate limited out
 * from under us.
 *
 * NWS is tried first wherever it reaches. If it fails for any reason — a grid
 * that will not answer, a point inside the bounding box but outside real
 * coverage, an outage — Open-Meteo still covers the whole world, so the section
 * degrades to the old behaviour rather than to an error.
 */
export async function getForecast(lat, lon) {
  if (inNWSCoverage(lat, lon)) {
    try {
      return await getNwsForecast(lat, lon);
    } catch {
      /* fall through to the global feed */
    }
  }
  return openMeteoForecast(lat, lon);
}
