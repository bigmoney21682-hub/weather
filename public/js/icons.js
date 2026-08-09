// Weather glyphs as inline SVG. Drawn here rather than loaded as an icon font
// so they inherit theme colours and stay crisp at any size.

const CLOUD = 'M45 47H20.5A10.5 10.5 0 0 1 19 26.1 14.5 14.5 0 0 1 45.6 24 11.5 11.5 0 0 1 45 47Z';

const wrap = (body, extra = '') =>
  `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" class="wx-icon" ${extra}>${body}</svg>`;

const sun = (cx = 32, cy = 30, r = 11) => {
  let rays = '';
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 4.5);
    const y1 = cy + Math.sin(a) * (r + 4.5);
    const x2 = cx + Math.cos(a) * (r + 9);
    const y2 = cy + Math.sin(a) * (r + 9);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--sun)" stroke-width="3.2" stroke-linecap="round"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--sun)"/>${rays}`;
};

const moon = (cx = 32, cy = 29, r = 12) =>
  `<path d="M${cx + r * 0.35} ${cy - r} a${r} ${r} 0 1 0 ${r * 0.75} ${r * 1.5} ${r * 0.95} ${r * 0.95} 0 0 1 -${r * 0.75} -${r * 1.5}Z" fill="var(--moon)"/>`;

const cloud = (fill = 'var(--cloud)', d = CLOUD) => `<path d="${d}" fill="${fill}"/>`;

const drops = (color, xs, y0 = 50, len = 7, slant = 2) =>
  xs
    .map(
      (x, i) =>
        `<line x1="${x}" y1="${y0 + (i % 2) * 3}" x2="${x - slant}" y2="${y0 + len + (i % 2) * 3}" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>`,
    )
    .join('');

const flakes = (xs, y = 54) =>
  xs
    .map(
      (x, i) =>
        `<g transform="translate(${x} ${y + (i % 2) * 3}) rotate(${i * 20})" stroke="var(--snow)" stroke-width="2.6" stroke-linecap="round">
           <line x1="-3.5" y1="0" x2="3.5" y2="0"/><line x1="0" y1="-3.5" x2="0" y2="3.5"/>
         </g>`,
    )
    .join('');

const bolt = '<path d="M34 42 24 58h7l-2 10 11-17h-7l3-9Z" fill="var(--bolt)" stroke="var(--bolt)" stroke-width="1.5" stroke-linejoin="round"/>';

const ICONS = {
  clear: () => wrap(sun()),
  'clear-night': () => wrap(moon()),
  'mostly-clear': () => wrap(`${sun(24, 24, 9)}${cloud()}`),
  'mostly-clear-night': () => wrap(`${moon(24, 23, 9)}${cloud()}`),
  'partly-cloudy': () => wrap(`${sun(23, 22, 9)}${cloud('var(--cloud)')}`),
  'partly-cloudy-night': () => wrap(`${moon(23, 22, 9)}${cloud('var(--cloud)')}`),
  cloudy: () => wrap(`${cloud('var(--cloud-dim)', 'M40 40H16.5A9.5 9.5 0 0 1 15 21.1 13.5 13.5 0 0 1 40.6 19 10.5 10.5 0 0 1 40 40Z')}${cloud()}`),
  fog: () =>
    wrap(
      `${cloud()}<g stroke="var(--cloud-dim)" stroke-width="3.4" stroke-linecap="round">
        <line x1="14" y1="53" x2="46" y2="53"/><line x1="20" y1="59" x2="52" y2="59"/></g>`,
    ),
  drizzle: () => wrap(`${cloud()}${drops('var(--rain)', [24, 33, 42], 51, 5)}`),
  rain: () => wrap(`${cloud()}${drops('var(--rain)', [23, 32, 41], 51, 8)}`),
  'heavy-rain': () => wrap(`${cloud()}${drops('var(--rain-heavy)', [20, 27, 34, 41], 51, 10)}`),
  showers: () => wrap(`${sun(23, 20, 8)}${cloud()}${drops('var(--rain)', [26, 35, 44], 51, 7)}`),
  sleet: () => wrap(`${cloud()}${drops('var(--rain)', [24, 40], 51, 7)}${flakes([32], 55)}`),
  snow: () => wrap(`${cloud()}${flakes([23, 32, 41], 54)}`),
  'heavy-snow': () => wrap(`${cloud()}${flakes([20, 28, 36, 44], 54)}`),
  thunderstorm: () => wrap(`${cloud()}${bolt}${drops('var(--rain)', [21, 46], 50, 7)}`),
  'thunderstorm-hail': () =>
    wrap(`${cloud()}${bolt}<circle cx="20" cy="55" r="3" fill="var(--snow)"/><circle cx="48" cy="55" r="3" fill="var(--snow)"/>`),
  wind: () =>
    wrap(
      `<g stroke="var(--wind)" stroke-width="3.6" stroke-linecap="round" fill="none">
        <path d="M8 24h28a7 7 0 1 0-7-7"/><path d="M8 36h38a7 7 0 1 1-7 7"/><path d="M8 48h20"/></g>`,
    ),
};

/** Return SVG markup for a WMO-derived icon name, honouring day/night. */
export function weatherIcon(name, isDay = true) {
  const key = isDay ? name : `${name}-night`;
  const make = ICONS[key] || ICONS[name] || ICONS.cloudy;
  return make();
}

export function windIcon() {
  return ICONS.wind();
}

/** Compass arrow pointing the way the wind is going (meteorological "from" + 180°). */
export function windArrow(fromDeg, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="wind-arrow" style="transform:rotate(${(fromDeg ?? 0) + 180}deg)" aria-hidden="true">
    <path d="M12 3l6 16-6-4-6 4z" fill="currentColor"/></svg>`;
}

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(deg) {
  if (deg == null) return '—';
  return COMPASS[Math.round(((deg % 360) / 22.5)) % 16];
}
