// Open-Meteo forecast: current conditions, hourly for today, and a 3-day wind
// series. One upstream request serves the Weather and Wind sections.

import { cached, fetchJSON } from './util.js';

/**
 * WMO weather code -> { icon, label }. `icon` names a glyph drawn by the client
 * (see public/js/icons.js); `night` variants are chosen client-side.
 */
const WMO = {
  0: ['clear', 'Clear'],
  1: ['mostly-clear', 'Mostly clear'],
  2: ['partly-cloudy', 'Partly cloudy'],
  3: ['cloudy', 'Overcast'],
  45: ['fog', 'Fog'],
  48: ['fog', 'Freezing fog'],
  51: ['drizzle', 'Light drizzle'],
  53: ['drizzle', 'Drizzle'],
  55: ['drizzle', 'Heavy drizzle'],
  56: ['sleet', 'Freezing drizzle'],
  57: ['sleet', 'Freezing drizzle'],
  61: ['rain', 'Light rain'],
  63: ['rain', 'Rain'],
  65: ['heavy-rain', 'Heavy rain'],
  66: ['sleet', 'Freezing rain'],
  67: ['sleet', 'Freezing rain'],
  71: ['snow', 'Light snow'],
  73: ['snow', 'Snow'],
  75: ['heavy-snow', 'Heavy snow'],
  77: ['snow', 'Snow grains'],
  80: ['showers', 'Rain showers'],
  81: ['showers', 'Rain showers'],
  82: ['heavy-rain', 'Violent rain showers'],
  85: ['snow', 'Snow showers'],
  86: ['heavy-snow', 'Heavy snow showers'],
  95: ['thunderstorm', 'Thunderstorm'],
  96: ['thunderstorm-hail', 'Thunderstorm with hail'],
  99: ['thunderstorm-hail', 'Severe thunderstorm with hail'],
};

export function describeCode(code) {
  const [icon, label] = WMO[code] || ['cloudy', 'Unknown'];
  return { icon, label };
}

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

export async function getForecast(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=4`;

  const raw = await cached(`fc:${lat.toFixed(3)}:${lon.toFixed(3)}`, 5 * 60 * 1000, () => fetchJSON(url));

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
    sunrise: raw.daily.sunrise[i],
    sunset: raw.daily.sunset[i],
    highF: raw.daily.temperature_2m_max[i],
    lowF: raw.daily.temperature_2m_min[i],
    ...describeCode(raw.daily.weather_code[i]),
  }));

  return {
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
