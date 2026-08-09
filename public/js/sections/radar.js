// Animated precipitation radar.
//
// RainViewer publishes a global composite every ten minutes. We load the last
// hour of frames as stacked tile layers and cross-fade between them, which is
// far smoother than swapping a single layer's URL because every frame is
// already in the tile cache by the time it is shown.

import { api, el, clear } from '../util.js';
import { createSection } from '../section.js';
import { createMap, homeMarker, observeSize } from '../map.js';
import { onLocation, getLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><circle cx="12" cy="12" r="9" stroke="var(--radar)" stroke-width="1.6"/><circle cx="12" cy="12" r="5.5" stroke="var(--radar)" stroke-width="1.2" opacity=".6"/><circle cx="12" cy="12" r="2" fill="var(--radar)"/><path d="M12 12 19 7" stroke="var(--radar)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const SPEEDS = [
  { label: '0.5×', ms: 800 },
  { label: '1×', ms: 420 },
  { label: '2×', ms: 210 },
];

export function radarSection() {
  const ui = createSection({
    id: 'radar',
    title: 'Radar',
    subtitle: 'Last hour of precipitation, looping',
    icon: ICON,
  });

  const mapEl = el('div', { class: 'map map-tall', id: 'radar-map' });
  const timeLabel = el('span', { class: 'frame-time', text: '—' });
  const playBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Pause', text: '❚❚' });
  const scrub = el('input', { type: 'range', class: 'scrub', min: '0', max: '0', value: '0', 'aria-label': 'Radar frame' });
  const speedBtn = el('button', { class: 'chip', type: 'button', text: '1×' });
  const recenter = el('button', { class: 'chip', type: 'button', text: 'Recenter' });

  clear(ui.body).append(
    mapEl,
    el(
      'div',
      { class: 'map-controls' },
      playBtn,
      scrub,
      timeLabel,
      el('div', { class: 'control-group' }, speedBtn, recenter),
    ),
    el(
      'div',
      { class: 'legend radar-legend' },
      el('span', { text: 'Light' }),
      el('span', { class: 'legend-bar radar-bar' }),
      el('span', { text: 'Heavy' }),
      el('span', { class: 'legend-note', text: 'Colour follows rain rate; darker cores mean the strongest returns.' }),
    ),
  );

  let map;
  let frames = [];
  let layers = [];
  let index = 0;
  let timer = null;
  let speed = 1;
  let playing = true;
  let marker = null;

  function ensureMap() {
    if (map) return map;
    const place = getLocation();
    map = createMap(mapEl, {
      center: place ? [place.lat, place.lon] : [39, -98],
      zoom: place ? 8 : 4,
    });
    observeSize(map, mapEl);
    return map;
  }

  function show(i, { immediate = false } = {}) {
    if (!frames.length) return;
    index = ((i % frames.length) + frames.length) % frames.length;
    layers.forEach((layer, j) => {
      if (!layer) return;
      layer.setOpacity(j === index ? 0.78 : 0);
    });
    // Warm the next frame so the loop never stalls on a tile fetch.
    addLayer((index + 1) % frames.length);
    const f = frames[index];
    timeLabel.textContent = new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (f.nowcast ? ' (forecast)' : '');
    timeLabel.classList.toggle('is-nowcast', Boolean(f.nowcast));
    scrub.value = String(index);
    if (immediate) scrub.value = String(index);
  }

  function addLayer(i) {
    if (layers[i] || !map) return;
    const f = frames[i];
    layers[i] = L.tileLayer(f.url, { opacity: 0, zIndex: 400 + i, maxZoom: 19, tileSize: 512, zoomOffset: -1 }).addTo(map);
  }

  function tick() {
    show(index + 1);
  }

  function play() {
    playing = true;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    clearInterval(timer);
    timer = setInterval(tick, SPEEDS[speed].ms);
  }

  function pause() {
    playing = false;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    clearInterval(timer);
  }

  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  scrub.addEventListener('input', () => {
    pause();
    show(Number(scrub.value));
  });
  speedBtn.addEventListener('click', () => {
    speed = (speed + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speed].label;
    if (playing) play();
  });
  recenter.addEventListener('click', () => {
    const place = getLocation();
    if (place && map) map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8), { animate: true });
  });

  async function loadFrames() {
    ui.loading('Fetching radar frames…');
    try {
      const data = await api('/api/radar');
      const build = (f, nowcast) => ({
        time: f.time,
        nowcast,
        url: data.tileTemplate.replace('{host}', data.host).replace('{path}', f.path),
      });
      frames = [...data.past.map((f) => build(f, false)), ...data.nowcast.slice(0, 3).map((f) => build(f, true))];
      if (!frames.length) throw new Error('No radar frames were returned.');

      ensureMap();
      layers.forEach((l) => l && map.removeLayer(l));
      layers = new Array(frames.length).fill(null);
      scrub.max = String(frames.length - 1);
      // Start at the most recent observed frame rather than the nowcast.
      const lastObserved = Math.max(0, data.past.length - 1);
      addLayer(lastObserved);
      show(lastObserved, { immediate: true });
      ui.ready();
      if (playing) play();
    } catch (err) {
      ui.error(`Radar unavailable: ${err.message}`, loadFrames);
    }
  }

  onLocation((place) => {
    ensureMap();
    if (!place) return;
    if (marker) marker.remove();
    marker = homeMarker(map, place.lat, place.lon, place.label);
    map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8), { animate: false });
    ui.setSubtitle(`Last hour of precipitation near ${place.label}`);
  });

  loadFrames();
  // Frames age out every ten minutes; refresh a little more often than that.
  setInterval(loadFrames, 5 * 60 * 1000);

  // Stop animating when the card is off screen — it saves tiles and battery.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && playing) play();
        else clearInterval(timer);
      }
    },
    { rootMargin: '200px' },
  );
  io.observe(ui.card);

  return ui.card;
}
