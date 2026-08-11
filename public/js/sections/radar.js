// Animated precipitation radar.
//
// RainViewer publishes a global composite every ten minutes. We load the last
// hour of frames as stacked tile layers and cross-fade between them, which is
// far smoother than swapping a single layer's URL because every frame is
// already in the tile cache by the time it is shown.
//
// The fade is driven by requestAnimationFrame over a continuous cursor rather
// than by a timer stepping through a handful of fixed blends. With frames ten
// minutes apart there is only ever room for one intermediate blend per gap, and
// a lone 50/50 step reads as the picture stalling in place and then jumping —
// a smooth ramp reads as one steady dissolve.

import { api, el, clear } from '../util.js';
import { createSection } from '../section.js';
import { createMap, homeMarker, observeSize } from '../map.js';
import { radarTileLayer } from '../radar-tiles.js';
import { onLocation, getLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><circle cx="12" cy="12" r="9" stroke="var(--radar)" stroke-width="1.6"/><circle cx="12" cy="12" r="5.5" stroke="var(--radar)" stroke-width="1.2" opacity=".6"/><circle cx="12" cy="12" r="2" fill="var(--radar)"/><path d="M12 12 19 7" stroke="var(--radar)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

// Milliseconds spent crossing from one observed frame to the next. 1× is the
// default; 0.5× is the half-speed look, so it takes twice as long per frame.
const SPEEDS = [
  { label: '1×', ms: 1000 },
  { label: '0.5×', ms: 2000 },
];

const FRAME_OPACITY = 0.78;
const END_HOLD = 900; // beat on the newest frame before cutting back to the start
const MAX_DELTA = 200; // a backgrounded tab must not fast-forward on its way back

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
  const scrub = el('input', { type: 'range', class: 'scrub', min: '0', max: '0', step: '0.01', value: '0', 'aria-label': 'Radar frame' });
  const speedBtn = el('button', { class: 'chip', type: 'button', text: SPEEDS[0].label });
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
  const layers = new Map(); // frame url -> tile layer, kept across refreshes
  let cursor = 0; // continuous position across `frames`
  let hold = 0; // milliseconds left of the end-of-loop pause
  let raf = null;
  let lastTs = 0;
  let speed = 0;
  let playing = true;
  let visible = true;
  let loaded = false;
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

  /** The layer for frame `i`, created on first use and reused thereafter. */
  function layerFor(i) {
    const frame = frames[i];
    if (!frame || !map) return null;
    let layer = layers.get(frame.url);
    if (!layer) {
      layer = radarTileLayer(frame.url, {
        opacity: 0,
        zIndex: 400 + i,
        maxZoom: 19,
        tileSize: 512,
        zoomOffset: -1,
      }).addTo(map);
      layers.set(frame.url, layer);
    }
    return layer;
  }

  /* --------------------------------------------------------- cursor maths -- */

  /** Wall-clock time sitting under a fractional cursor position. */
  function timeAt(list, pos) {
    const i = Math.min(Math.floor(pos), list.length - 1);
    const a = list[i];
    if (!a) return null;
    const b = list[i + 1];
    return b ? a.time + (pos - i) * (b.time - a.time) : a.time;
  }

  /** Inverse of `timeAt`: where a wall-clock time falls in a frame list. */
  function positionAt(list, time) {
    for (let i = 0; i < list.length - 1; i++) {
      if (time < list[i + 1].time) {
        const span = list[i + 1].time - list[i].time;
        return i + (span > 0 ? Math.max(0, (time - list[i].time) / span) : 0);
      }
    }
    return Math.max(0, list.length - 1);
  }

  /* ------------------------------------------------------------- painting -- */

  let scrubValue = null;
  let shownStamp = null;

  /** The scrub input snaps to its own step, so only write real movements. */
  function syncScrub(pos) {
    const next = pos.toFixed(2);
    if (next === scrubValue) return;
    scrubValue = next;
    scrub.value = next;
  }

  function render(pos) {
    if (!frames.length) return;
    const i = Math.min(Math.max(0, Math.floor(pos)), frames.length - 1);
    const blend = Math.min(1, Math.max(0, pos - i));
    const nextIndex = blend > 0 && i + 1 < frames.length ? i + 1 : null;

    const from = layerFor(i);
    const to = nextIndex == null ? null : layerFor(nextIndex);
    // Warm the frame after this one so its tiles are fetched and recoloured
    // well before the fade reaches them.
    layerFor(Math.min(i + 2, frames.length - 1));

    // Two stacked translucent layers would wash out where they overlap, so the
    // upper one is boosted to land the composite back on FRAME_OPACITY.
    const fromOpacity = FRAME_OPACITY * (1 - blend);
    const toOpacity = to ? (FRAME_OPACITY - fromOpacity) / (1 - fromOpacity) : 0;
    // Leaflet's setOpacity walks every tile in the layer, so at 60fps the nine
    // or so layers that are already hidden would cost more style writes than
    // the two that are actually moving. Only write when the value changes.
    for (const layer of layers.values()) {
      const want = layer === from ? fromOpacity : layer === to ? toOpacity : 0;
      if (layer._wxOpacity === want) continue;
      layer._wxOpacity = want;
      layer.setOpacity(want);
    }

    // The clock only moves every few hundred frames, and formatting a date is
    // far too costly to redo sixty times a second. Reformat when it changes.
    const shown = frames[blend < 0.5 || nextIndex == null ? i : nextIndex];
    const stamp = `${shown.time}/${nextIndex == null}`;
    if (stamp !== shownStamp) {
      shownStamp = stamp;
      timeLabel.textContent =
        new Date(shown.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        (shown.nowcast ? ' (forecast)' : '');
      timeLabel.classList.toggle('is-nowcast', Boolean(shown.nowcast));
      timeLabel.title = nextIndex == null ? 'Observed radar frame' : 'Fading between the frames either side';
    }
  }

  function tick(ts) {
    const dt = Math.min(MAX_DELTA, Math.max(0, ts - lastTs));
    lastTs = ts;

    if (hold > 0) {
      hold -= dt;
      if (hold <= 0) cursor = 0;
    } else {
      cursor += dt / SPEEDS[speed].ms;
      if (cursor >= frames.length - 1) {
        cursor = Math.max(0, frames.length - 1);
        hold = END_HOLD;
      }
    }

    render(cursor);
    syncScrub(cursor);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf != null || !frames.length) return;
    lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf == null) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  function play() {
    playing = true;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    if (visible) start();
  }

  function pause() {
    playing = false;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    stop();
  }

  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  scrub.addEventListener('input', () => {
    pause();
    hold = 0;
    cursor = Number(scrub.value);
    scrubValue = scrub.value; // the input already holds this; don't write it back
    render(cursor);
  });
  speedBtn.addEventListener('click', () => {
    // The tick reads the interval every frame, so there is nothing to restart.
    speed = (speed + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speed].label;
  });
  recenter.addEventListener('click', () => {
    const place = getLocation();
    if (place && map) map.setView([place.lat, place.lon], Math.max(map.getZoom(), 8), { animate: true });
  });

  async function loadFrames() {
    if (!loaded) ui.loading('Fetching radar frames…');
    try {
      const data = await api('/api/radar');
      const build = (f, nowcast) => ({
        time: f.time,
        nowcast,
        url: data.tileTemplate.replace('{host}', data.host).replace('{path}', f.path),
      });
      const next = [...data.past.map((f) => build(f, false)), ...data.nowcast.slice(0, 3).map((f) => build(f, true))];
      if (!next.length) throw new Error('No radar frames were returned.');

      // The window has slid, so remember the moment the loop was showing and
      // put the cursor back on it rather than snapping to the newest frame.
      const watching = frames.length ? timeAt(frames, cursor) : null;
      frames = next;

      ensureMap();
      // Successive refreshes overlap by all but a frame or two. Dropping only
      // the frames that aged out keeps the rest of the stack — already fetched
      // and already recoloured — instead of rebuilding every layer from
      // scratch and stalling the loop while the tiles come back.
      const live = new Set(frames.map((f) => f.url));
      for (const [url, layer] of layers) {
        if (live.has(url)) continue;
        map.removeLayer(layer);
        layers.delete(url);
      }
      frames.forEach((f, i) => layers.get(f.url)?.setZIndex(400 + i));

      scrub.max = String(Math.max(0, frames.length - 1));
      cursor = watching == null ? Math.max(0, data.past.length - 1) : positionAt(frames, watching);
      hold = 0;
      render(cursor);
      // The range just changed, so the cached value no longer describes the input.
      scrubValue = null;
      syncScrub(cursor);

      loaded = true;
      ui.ready();
      if (playing && visible) start();
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
        visible = e.isIntersecting;
        if (visible && playing) start();
        else stop();
      }
    },
    { rootMargin: '200px' },
  );
  io.observe(ui.card);

  return ui.card;
}
