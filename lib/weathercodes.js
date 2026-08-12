// The vocabulary both forecast feeds answer in.
//
// Open-Meteo speaks WMO codes natively; the NWS feed is translated into them
// (see nwsforecast.js). Keeping the table here rather than in either feed means
// neither has to import the other, and the client keeps one icon set to draw.

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
