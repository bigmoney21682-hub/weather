// The wind map under the Wind card's chart: a field of arrows over the state
// you are in, on satellite imagery, with a slider from now to the end of the
// day after tomorrow. Arrows point the way the wind is blowing, like the ones
// along the chart and in the Forecast card's hourly row.

import { api, el } from './util.js';
import { createMap, homeMarker, observeSize } from './map.js';
import { compass } from './icons.js';

// The same shape as `windArrow` in icons.js, so the map reads like the rows.
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>';

// mph -> colour, calm to violent. Stops sit where the experience changes:
// barely felt, a breeze, small-craft territory, hard to stand in.
const SPEED_STOPS = [
  [0, [150, 170, 200]],
  [5, [94, 196, 255]],
  [10, [90, 220, 140]],
  [15, [240, 225, 80]],
  [20, [255, 160, 60]],
  [30, [240, 70, 70]],
  [45, [200, 80, 230]],
];

function speedColor(mph) {
  if (mph == null) return 'rgb(150,150,150)';
  let i = 1;
  while (i < SPEED_STOPS.length - 1 && mph > SPEED_STOPS[i][0]) i++;
  const [a, ca] = SPEED_STOPS[i - 1];
  const [b, cb] = SPEED_STOPS[i];
  const t = Math.max(0, Math.min(1, (mph - a) / (b - a)));
  const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
  return `rgb(${mix.join(',')})`;
}

/** Local calendar date in `tz` as 'YYYY-MM-DD'. */
const localDate = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });

export function windField() {
  const mapEl = el('div', { class: 'map map-tall', id: 'wind-map' });
  const timeLabel = el('span', { class: 'frame-time wind-map-time', text: '—' });
  const scrub = el('input', { type: 'range', class: 'scrub', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Forecast hour' });
  const nowBtn = el('button', { class: 'chip', type: 'button', text: 'Now' });
  const recenter = el('button', { class: 'chip', type: 'button', text: 'Recenter' });
  const status = el('p', { class: 'fine-print wind-map-status hidden' });

  const node = el(
    'div',
    { class: 'wind-map' },
    el('h4', { class: 'sub-head', text: 'Wind map' }),
    mapEl,
    el('div', { class: 'map-controls' }, scrub, timeLabel, el('div', { class: 'control-group' }, nowBtn, recenter)),
    el(
      'div',
      { class: 'legend' },
      el('span', { text: 'Calm' }),
      el('span', { class: 'legend-bar wind-speed-bar' }),
      el('span', { text: '45+ mph' }),
      el('span', { class: 'legend-note', text: 'Arrows point where the wind is blowing. Tap one for its speed.' }),
    ),
    status,
  );

  let map = null;
  let arrows = []; // { marker, point }
  let layer = null;
  let home = null;
  let data = null;
  let hours = []; // indexes into data.times that the slider walks
  let token = 0;

  function ensureMap(place) {
    if (map) return map;
    map = createMap(mapEl, { center: [place.lat, place.lon], zoom: 6, theme: 'satellite' });
    layer = L.layerGroup().addTo(map);
    observeSize(map, mapEl);
    return map;
  }

  function setStatus(text) {
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
  }

  function fit() {
    if (!map || !data) return;
    const [s, w, n, e] = data.area.bounds;
    map.fitBounds([[s, w], [n, e]], { padding: [6, 6], animate: false });
  }

  function label(i) {
    const ms = data.times[hours[i]];
    if (i === 0) return 'Now';
    return new Date(ms)
      .toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: data.timezone })
      .replace(',', '');
  }

  function show(i) {
    const h = hours[i];
    if (h == null) return;
    timeLabel.textContent = label(i);
    for (const { marker, point } of arrows) {
      const glyph = marker.getElement()?.firstElementChild;
      if (!glyph) continue;
      const dir = point.dir[h];
      const mph = point.mph[h];
      glyph.style.transform = `rotate(${(dir ?? 0) + 180}deg) scale(${0.8 + Math.min(mph ?? 0, 40) / 80})`;
      glyph.style.color = speedColor(mph);
      glyph.style.opacity = dir == null ? '0' : '1';
    }
  }

  function render(place) {
    const nowHour = Math.floor(Date.now() / 3600e3) * 3600e3;
    // Today and the two days after it, on the location's own calendar.
    const days = [];
    for (const t of data.times) {
      const d = localDate(t, data.timezone);
      if (!days.includes(d)) days.push(d);
    }
    const lastDay = days[days.indexOf(localDate(nowHour, data.timezone)) + 2] ?? days[days.length - 1];
    hours = data.times
      .map((t, i) => [t, i])
      .filter(([t]) => t >= nowHour && localDate(t, data.timezone) <= lastDay)
      .map(([, i]) => i);
    if (!hours.length) throw new Error('The wind map has no hours left to show.');

    ensureMap(place);
    layer.clearLayers();
    arrows = data.points.map((point) => {
      const marker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({ className: 'wind-map-arrow', html: ARROW, iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
      }).addTo(layer);
      marker.bindTooltip(() => {
        const h = hours[Number(scrub.value)];
        const gust = point.gust[h];
        return `${compass(point.dir[h])} ${point.mph[h] ?? '—'} mph${gust != null ? ` · gusts ${gust}` : ''}`;
      }, { direction: 'top', offset: [0, -10] });
      return { marker, point };
    });

    if (home) home.remove();
    home = homeMarker(map, place.lat, place.lon, place.label);

    scrub.max = String(hours.length - 1);
    scrub.value = '0';
    fit();
    show(0);
  }

  scrub.addEventListener('input', () => {
    show(Number(scrub.value));
    // A tooltip left open keeps the hour it opened on otherwise.
    for (const { marker } of arrows) if (marker.isTooltipOpen()) marker.getTooltip().update();
  });
  nowBtn.addEventListener('click', () => {
    scrub.value = '0';
    scrub.dispatchEvent(new Event('input'));
  });
  recenter.addEventListener('click', fit);

  return {
    node,
    /** Load the field for `place`. Failures stay on the map, not the card. */
    async load(place) {
      const mine = ++token;
      setStatus('Loading the wind map…');
      try {
        const next = await api('/api/windmap', { lat: place.lat, lon: place.lon });
        if (mine !== token) return;
        data = next;
        render(place);
        setStatus('');
      } catch (err) {
        if (mine !== token) return;
        setStatus(`Wind map unavailable: ${err.message || 'could not load'}`);
      }
    },
  };
}
