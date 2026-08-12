// Animated precipitation radar.
//
// The last hour of scans is loaded as a stack of tile layers which are then
// shown in turn, which is far smoother than swapping a single layer's URL
// because every frame is already in the tile cache by the time it is shown.
//
// Each frame is *held*, then dissolved quickly into the next, rather than being
// ramped across the whole gap. Two scans five minutes apart are about four
// kilometres apart on the ground — seven screen pixels at the zoom this map
// opens at, thirty by the time you have zoomed in — and dissolving slowly
// between two copies that far apart never reads as movement. You see the old
// one fade where it stands while a second one appears alongside it: a shadow,
// not a storm. A near-clean cut leaves the eye to do what it does with a
// flipbook, and the short dissolve only takes the hard edge off the switch.

import { api, el, clear } from '../util.js';
import { createSection } from '../section.js';
import { createMap, homeMarker, observeSize } from '../map.js';
import { radarTileLayer, SIGNATURE_GRID } from '../radar-tiles.js';
import { estimateShift } from '../radar-motion.js';
import { onLocation, getLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><circle cx="12" cy="12" r="9" stroke="var(--radar)" stroke-width="1.6"/><circle cx="12" cy="12" r="5.5" stroke="var(--radar)" stroke-width="1.2" opacity=".6"/><circle cx="12" cy="12" r="2" fill="var(--radar)"/><path d="M12 12 19 7" stroke="var(--radar)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

// Milliseconds a frame owns before the next one takes over. 1× is the default;
// 0.5× is the half-speed look, so it takes twice as long per frame. A radar
// loop wants to run at somewhere near two frames a second — much slower and
// each frame is read as its own picture rather than as one step of a movement.
const SPEEDS = [
  { label: '1×', ms: 620 },
  { label: '0.5×', ms: 1240 },
];

// How much of a frame's slot it is held still for; the rest is the dissolve
// into the next frame. Long enough that the eye settles on one picture, short
// enough that two offset copies are never both on screen for any length of time.
const HOLD = 0.76;

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

  const sourceNote = ui.card.querySelector('.legend-note');

  let map;
  let frames = [];
  let tileOptions = null; // tile geometry for whichever feed is in play
  let source = null;
  const layers = new Map(); // frame key -> tile layer, kept across refreshes
  let cursor = 0; // continuous position across `frames`
  let hold = 0; // milliseconds left of the end-of-loop pause
  let raf = null;
  let lastTs = 0;
  let speed = 0;
  let playing = true;
  let visible = true;
  let loaded = false;
  let marker = null;
  // Tile-grid cells per second, and the tile zoom they were measured at. Null
  // until enough of the oldest and newest frames have painted to correlate, and
  // back to null whenever the match stops being convincing.
  let motion = null;
  let motionTimer = null;

  function ensureMap() {
    if (map) return map;
    const place = getLocation();
    map = createMap(mapEl, {
      center: place ? [place.lat, place.lon] : [39, -98],
      zoom: place ? 8 : 4,
    });
    observeSize(map, mapEl);
    // Panning brings different ground into view and zooming changes the tile
    // grid the drift was measured on, so both are worth re-reading.
    map.on('zoomend moveend', () => scheduleMotion(1200));
    return map;
  }

  /** The layer for frame `i`, created on first use and reused thereafter. */
  function layerFor(i) {
    const frame = frames[i];
    if (!frame || !map || !tileOptions) return null;
    let layer = layers.get(frame.key);
    if (!layer) {
      // Geometry comes from the server with the frames, because the two feeds
      // disagree about all of it: NEXRAD is 256px tiles sharp to zoom 16 asked
      // for one scan at a time, the global composite is 512px tiles that run
      // out at zoom 7. Capping at each feed's last real zoom keeps the picture
      // blurry rather than laid over ground it does not describe.
      layer = radarTileLayer({
        opacity: 0,
        zIndex: 400 + i,
        maxZoom: 19,
        ...tileOptions,
        // Whatever makes this frame its own: its own address for a feed that
        // publishes one per scan, the scan time for one that does not.
        ...frame.params,
        url: frame.url || tileOptions.url,
      }).addTo(map);
      layers.set(frame.key, layer);
    }
    return layer;
  }

  /* -------------------------------------------------------------- motion -- */

  let motionTries = 0;

  function scheduleMotion(delay = 1500) {
    if (motionTimer != null) clearTimeout(motionTimer);
    motionTimer = setTimeout(measureMotion, delay);
  }

  /**
   * Measure the drift across the whole hour and divide it down to a rate. See
   * radar-motion.js for why it cannot be measured over a single gap.
   */
  function measureMotion() {
    motionTimer = null;
    if (!map || frames.length < 2) return;
    const first = layers.get(frames[0].key);
    const last = layers.get(frames[frames.length - 1].key);
    const span = frames[frames.length - 1].time - frames[0].time;
    if (!first || !last || span <= 0) return;
    // Tiles paint asynchronously, so early on there may be nothing to compare
    // yet. That is worth coming back for — a weak correlation is not.
    if (!first._signatures.size || !last._signatures.size) {
      if (motionTries++ < 6) scheduleMotion(4000);
      return;
    }
    const shift = estimateShift(first, last);
    motion = shift ? { x: shift.dx / span, y: shift.dy / span, z: shift.z } : null;
  }

  /** Slide a whole frame layer across the map, in screen pixels. */
  function shiftLayer(layer, x, y) {
    const node = layer?.getContainer?.();
    if (!node) return;
    // Leaflet 1.9.4 gives a GridLayer's container only `zIndex` and `opacity` —
    // pan and zoom are transforms on the level elements inside it — so the
    // container's own transform is ours to use and nothing will fight us for it.
    const next = x || y ? `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)` : '';
    if (node._wxShift === next) return;
    node._wxShift = next;
    node.style.transform = next;
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
    const through = Math.min(1, Math.max(0, pos - i));
    // Still for the first HOLD of the slot, then across in what is left.
    const blend = through <= HOLD ? 0 : (through - HOLD) / (1 - HOLD);
    const nextIndex = blend > 0 && i + 1 < frames.length ? i + 1 : null;

    const from = layerFor(i);
    const to = nextIndex == null ? null : layerFor(nextIndex);
    // Warm the frame after this one so its tiles are fetched and recoloured
    // well before the fade reaches them.
    layerFor(Math.min(i + 2, frames.length - 1));

    // Two stacked translucent layers would wash out where they overlap, so the
    // lower one is boosted to land the composite back on FRAME_OPACITY.
    //
    // Which one is lower matters, and it is `to`: layers are stacked by frame
    // index, so the incoming frame sits *above* the outgoing one. Solving for
    // `from` — as though it were on top — makes the curve badly lopsided, with
    // the incoming frame taking a third of the picture a tenth of the way in
    // and four fifths of it by halfway. That is the snap-then-sit the loop had.
    const toOpacity = to ? FRAME_OPACITY * blend : 0;
    const fromOpacity = to ? (FRAME_OPACITY * (1 - blend)) / (1 - toOpacity) : FRAME_OPACITY;

    // Carry the frames along their own motion, so the picture moves throughout
    // the slot rather than only during the dissolve, and so the two copies are
    // on top of each other by the time they cross-fade instead of side by side.
    // The outgoing frame is run forward from where it was observed; the
    // incoming one is wound back to meet it and arrives home as it takes over.
    let fx = 0;
    let fy = 0;
    let tx = 0;
    let ty = 0;
    const gap = frames[i + 1] ? frames[i + 1].time - frames[i].time : 0;
    if (motion && gap > 0) {
      // Cells are tile-grid cells at the zoom they were measured at, so they
      // scale with the map — which is right: a storm covers four times as many
      // screen pixels a minute two zoom levels in.
      const cell = ((tileOptions?.tileSize || 256) / SIGNATURE_GRID) * 2 ** (map.getZoom() - motion.z);
      const dx = motion.x * gap * cell;
      const dy = motion.y * gap * cell;
      fx = dx * through;
      fy = dy * through;
      tx = -dx * (1 - through);
      ty = -dy * (1 - through);
    }

    // Leaflet's setOpacity walks every tile in the layer, so at 60fps the nine
    // or so layers that are already hidden would cost more style writes than
    // the two that are actually moving. Only write when the value changes.
    for (const layer of layers.values()) {
      const want = layer === from ? fromOpacity : layer === to ? toOpacity : 0;
      if (layer._wxOpacity !== want) {
        layer._wxOpacity = want;
        layer.setOpacity(want);
      }
      if (layer === from) shiftLayer(layer, fx, fy);
      else if (layer === to) shiftLayer(layer, tx, ty);
      else shiftLayer(layer, 0, 0);
    }

    // The clock only moves every few hundred frames, and formatting a date is
    // far too costly to redo sixty times a second. Reformat when it changes.
    const shown = frames[blend < 0.5 || nextIndex == null ? i : nextIndex];
    const stamp = `${shown.time}/${nextIndex == null}`;
    if (stamp !== shownStamp) {
      shownStamp = stamp;
      // Both feeds are observed scans only — NEXRAD publishes no forecast, and
      // RainViewer's nowcast list is always empty without an API key — so every
      // frame here is something that actually happened.
      timeLabel.textContent = new Date(shown.time * 1000).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
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
      // Which feed answers depends on where you are, so the point travels with
      // the request and a move can swap the source underneath us.
      const place = getLocation();
      const data = await api('/api/radar', place ? { lat: place.lat, lon: place.lon } : {});
      const next = data.frames || [];
      if (!next.length) throw new Error('No radar frames were returned.');

      if (data.source !== source) {
        source = data.source;
        tileOptions = { ...data.tile, attribution: data.attribution };
        motion = null; // different feed, different tile grid
        sourceNote.textContent =
          data.source === 'nexrad'
            ? `${data.label} — sharp enough to zoom right in; colour follows rain rate.`
            : `${data.label} — colour follows rain rate; darker cores are the strongest returns.`;
      }

      // The window has slid, so remember the moment the loop was showing and
      // put the cursor back on it rather than snapping to the newest frame.
      const watching = frames.length ? timeAt(frames, cursor) : null;
      frames = next;

      ensureMap();
      // Build the incoming set before dropping anything, so whatever is on
      // screen stays there while the replacements fetch.
      frames.forEach((_, i) => layerFor(i));
      // Successive refreshes overlap by all but a frame or two. Dropping only
      // the frames that aged out keeps the rest of the stack — already fetched
      // and already recoloured — instead of rebuilding every layer from
      // scratch and stalling the loop while the tiles come back.
      const live = new Set(frames.map((f) => f.key));
      for (const [key, layer] of layers) {
        if (live.has(key)) continue;
        map.removeLayer(layer);
        layers.delete(key);
      }
      frames.forEach((f, i) => layers.get(f.key)?.setZIndex(400 + i));

      scrub.max = String(Math.max(0, frames.length - 1));
      // Newest frame last, and there is no forecast tail on either feed.
      cursor = watching == null ? Math.max(0, frames.length - 1) : positionAt(frames, watching);
      hold = 0;
      render(cursor);
      // The range just changed, so the cached value no longer describes the input.
      scrubValue = null;
      syncScrub(cursor);

      loaded = true;
      ui.ready();
      // The window has slid, so the drift is worth re-reading — but not until
      // the newest frame has had a chance to paint.
      motionTries = 0;
      scheduleMotion(2500);
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
    // Moving can cross into or out of NEXRAD's footprint, which changes both
    // the feed and the tile geometry, so the frames are refetched for the point.
    loadFrames();
  });

  loadFrames();
  // NEXRAD scans every five minutes and the global composite every ten, so this
  // keeps up with the faster of the two.
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
