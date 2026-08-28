// Animated precipitation radar.
//
// The last hour of scans is loaded as a stack of tile layers which are then
// shown in turn, which is far smoother than swapping a single layer's URL
// because every frame is already in the tile cache by the time it is shown.
//
// Nothing in the loop ever stops. The cursor runs at a constant rate across the
// frames and straight back round to the start, and each frame eases into the
// next across the whole of its slot rather than sitting still and then cutting.
//
// A slow, even dissolve on its own would not work: two scans five minutes apart
// are about four kilometres apart on the ground — seven screen pixels at the
// zoom this map opens at, thirty by the time you have zoomed in — and fading
// between two copies that far apart reads as a shadow, not a storm. Two things
// keep it reading as movement instead. The frames are carried along their own
// measured drift for the whole slot (see radar-motion.js), so the two copies
// are on top of each other by the time either is faint; and the blend is eased
// rather than linear, so it spends most of the slot near one frame or the other
// and crosses the middle — where both are half-there — quickly. The eased curve
// settles onto each frame without ever holding it, which is what makes the
// motion continuous where the old hold-then-cut had a stop at every step.

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

/**
 * Smootherstep: the eased blend that replaces the old hold-then-cut. It leaves
 * and arrives with zero slope, so a frame settles into place and departs again
 * without the jolt of a linear ramp, and it crosses the middle steeply, so the
 * stretch where both frames are half-there — the part that reads as a ghost
 * rather than as rain — is over about as fast as the cut used to be. What it
 * never does is stop: there is no interval where the picture is not changing.
 */
function ease(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

const FRAME_OPACITY = 0.78;
const MAX_DELTA = 200; // a backgrounded tab must not fast-forward on its way back

// What to call each feed while it loads. Which one answers depends on where you
// are, and they are far apart in how long they take to arrive, so the wait says
// which one it is waiting for rather than a generic "loading".
const FEED_NAMES = {
  mrms: 'MRMS composite',
  nexrad: 'NEXRAD mosaic',
  rainviewer: 'Global composite',
};

// The half-sentence under the legend that says what you are actually looking
// at. Each feed gives up something different, and saying which is the whole
// point — a kilometre grid and a continent-wide one are not the same picture.
const SOURCE_NOTES = {
  mrms: 'a kilometre grid, refreshed every two minutes; colour follows rain rate.',
  nexrad: 'sharp enough to zoom right in; colour follows rain rate.',
  rainviewer: 'broad strokes, so it stops short of street level; colour follows rain rate.',
};

// The basemap's own limit, and what the frame layers are built with.
const MAP_MAX_ZOOM = 19;

// How far past a feed's last real zoom the map may still be taken. Leaflet will
// upscale a tile forever, and the global composite runs out at map zoom 8 — so
// arriving somewhere outside NEXRAD while zoomed into a US street stretched one
// tile across five levels and painted a smear of coloured squares that reads as
// a broken radar rather than as rain. Two levels of upscale still reads: enough
// to put a storm against a coastline, not enough to claim detail the feed does
// not have. NEXRAD reaches zoom 16, so this leaves it untouched.
const ZOOM_HEADROOM = 2;

// Longest we will sit on a progress bar. Every tile resolves one way or the
// other — a failed image still calls `done` — but a map that never gets a size
// never asks for tiles at all, and a bar that hangs forever is worse than one
// that gives up and lets you look at whatever did arrive.
const PROGRESS_LIMIT = 25000;

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
  const expandBtn = el('button', { class: 'chip', type: 'button', text: 'Expand', 'aria-expanded': 'false' });

  clear(ui.body).append(
    mapEl,
    el(
      'div',
      { class: 'map-controls' },
      playBtn,
      scrub,
      timeLabel,
      el('div', { class: 'control-group' }, speedBtn, recenter, expandBtn),
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
  // Continuous position across `frames`, and it runs one slot past the last
  // frame: that final slot is the newest frame folding back into the oldest,
  // which is what closes the loop into a circle with no pause and no jump cut.
  let cursor = 0;
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
  // Latest-wins token. Picking a place while a load is in flight would other-
  // wise let the older answer land last and paint the wrong part of the world.
  let generation = 0;
  // Whether this load is one the user is waiting on — a first load or a move —
  // as opposed to the five-minute refresh, which must not throw a bar over a
  // loop that is already playing perfectly well.
  let announcing = false;
  let progressTimer = null;

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
        // A pinch crosses several zoom levels on its way to the one you meant.
        // Asking for tiles at each of them means a dozen frames' worth of
        // painting per level, all of it thrown away as the gesture continues —
        // so wait for the gesture to finish and fetch the level you landed on.
        updateWhenZooming: false,
        updateWhenIdle: true,
        // The ring of off-screen tiles Leaflet keeps ready costs whatever one
        // frame costs, times twelve here. One row is enough to pan into.
        keepBuffer: 1,
        ...tileOptions,
        // Whatever makes this frame its own: its own address for a feed that
        // publishes one per scan, the scan time for one that does not.
        ...frame.params,
        url: frame.url || tileOptions.url,
      }).addTo(map);
      // Leaflet fires this once every tile the layer wants is painted, which is
      // the only honest measure of "the radar is here". The frame list itself
      // arrives in a moment; it is the tiles behind it that keep a phone
      // waiting, and until now nothing on screen said so.
      layer.on('load', () => {
        layer._radarLoaded = true;
        reportProgress();
      });
      layer._radarLoaded = false;
      layer._wxZ = 400 + i;
      layers.set(frame.key, layer);
    }
    return layer;
  }

  /**
   * Hold the map to a zoom the feed in play can actually describe. Leaflet
   * clamps `setView` and the zoom control to `maxZoom` for us, so setting it is
   * enough to cover panning, the recenter button and pinching alike.
   */
  function applyZoomCeiling() {
    if (!map) return;
    const native = tileOptions?.maxNativeZoom;
    // A feed may ask for more room than the default. MRMS renders its own tiles
    // and stops early on purpose, so the two levels that suit the global
    // composite would pin the map far shallower than the data deserves.
    const headroom = tileOptions?.zoomHeadroom ?? ZOOM_HEADROOM;
    const cap = native == null ? MAP_MAX_ZOOM : Math.min(MAP_MAX_ZOOM, native + headroom);
    map.setMaxZoom(cap);
    // Unanimated: this is the feed changing under the view, not a gesture, and
    // gliding out three levels reads as the map wandering off on its own.
    if (map.getZoom() > cap) map.setZoom(cap, { animate: false });
  }

  /* ------------------------------------------------------------- progress -- */

  function framesPainted() {
    let n = 0;
    for (const f of frames) if (layers.get(f.key)?._radarLoaded) n++;
    return n;
  }

  /**
   * How much of the loop can be played without showing a frame that has not
   * arrived yet — the leading run of painted frames.
   *
   * The five-minute mosaic made this moot: a dozen tiles came off a CDN in
   * parallel and were all there within a second. MRMS frames are decoded one at
   * a time on our own server and land in order over several seconds, so
   * animating the full list from the outset would flash blanks through the loop
   * for as long as the load took. Playing only what has landed means the loop
   * starts short and lengthens as the rest arrive, and never shows a hole.
   */
  function playableFrames() {
    let n = 0;
    while (n < frames.length && layers.get(frames[n].key)?._radarLoaded) n++;
    // Nothing has painted yet: show the first frame rather than an empty map.
    return Math.max(1, n);
  }

  function reportProgress() {
    if (!announcing) return;
    const total = frames.length;
    const done = framesPainted();
    if (!total || done >= total) return endProgress();
    ui.progress(`Loading ${FEED_NAMES[source] || 'radar'} · ${done} of ${total} frames`, done, total);
  }

  function endProgress() {
    if (!announcing) return;
    announcing = false;
    clearTimeout(progressTimer);
    progressTimer = null;
    ui.ready();
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
    if (shift) {
      motion = { x: shift.dx / span, y: shift.dy / span, z: shift.z };
      return;
    }
    // No answer this time. Tiles are still landing through the first minute and
    // the estimate sharpens as they do, so an early null is worth coming back
    // for — settling for good would leave the loop dissolving frames where they
    // stand, which is the skip this measurement exists to remove.
    motion = null;
    if (motionTries++ < 6) scheduleMotion(4000);
  }

  /** Stack a frame layer, skipping the write when it is already there. */
  function setZ(layer, z) {
    if (!layer || layer._wxZ === z) return;
    layer._wxZ = z;
    layer.setZIndex(z);
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
    // The wrap slot lives past the last frame and the scrub has no room for it,
    // so the handle rests at the end for that half-second rather than running
    // off the track. It is the one place the two disagree, and briefly.
    const next = Math.min(pos, Math.max(0, frames.length - 1)).toFixed(2);
    if (next === scrubValue) return;
    scrubValue = next;
    scrub.value = next;
  }

  function render(pos, span = frames.length) {
    if (!frames.length) return;
    const count = Math.min(Math.max(1, span), frames.length);
    const i = Math.min(Math.max(0, Math.floor(pos)), count - 1);
    const through = Math.min(1, Math.max(0, pos - i));
    // Eased across the whole slot, so the picture is always on its way
    // somewhere. Nothing is held and nothing is cut.
    const blend = ease(through);
    // Round, not off the end: past the newest frame in play the loop dissolves
    // back into the oldest. A lone frame has nowhere to go, so it just stands.
    const nextIndex = blend > 0 && count > 1 ? (i + 1) % count : null;

    const from = layerFor(i);
    const to = nextIndex == null ? null : layerFor(nextIndex);
    // The blend below assumes the incoming frame is the one on top, and
    // stacking by frame index gives that for free at every step but the wrap,
    // where the oldest frame is coming back in underneath the newest. Placing
    // the active pair by hand makes the wrap composite like any other step.
    setZ(from, 400 + i);
    setZ(to, 400 + i + 1);
    // Warm the frame after this one so its tiles are fetched and recoloured
    // well before the fade reaches them — wrapping too, so the oldest frame is
    // ready by the time the loop comes back round to it.
    if (count > 1) layerFor((i + 2) % count);

    // Two stacked translucent layers would wash out where they overlap, so the
    // lower one is boosted to land the composite back on FRAME_OPACITY.
    //
    // Which one is lower matters, and the stacking just above guarantees it is
    // `from`: the incoming frame always sits above the outgoing one, so `from`
    // is the one boosted. Solving for `to` instead — as though it were the
    // lower — makes the curve badly lopsided, with the incoming frame taking a
    // third of the picture a tenth of the way in and four fifths of it by
    // halfway. That is the snap-then-sit this loop used to have.
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
      timeLabel.title =
        nextIndex == null
          ? 'Observed radar frame'
          : nextIndex === 0
            ? 'Looping back to the start of the hour'
            : 'Fading between the frames either side';
    }
  }

  function tick(ts) {
    const dt = Math.min(MAX_DELTA, Math.max(0, ts - lastTs));
    lastTs = ts;

    // One slot per frame, including the last one, whose slot is the fold back
    // to the start — so the cursor simply wraps and there is no end to stop at.
    const span = playableFrames();
    cursor = (cursor + dt / SPEEDS[speed].ms) % span;

    render(cursor, span);
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

  /* --------------------------------------------------------- fullscreen -- */

  // Filling the screen is done in two layers, because the Fullscreen API is not
  // everywhere — iPhone Safari has never offered it for anything but a video.
  // The class does the whole job on its own: the card is fixed to the viewport,
  // above the sticky jump bar, with the map taking whatever the controls and the
  // legend leave. Native fullscreen, where there is one, is asked for on top of
  // that, and all it adds is dropping the browser's own chrome. Where it is
  // missing or refused, the class is already the answer and nothing is lost.
  //
  // Either way it is the ResizeObserver in map.js that tells Leaflet its
  // container changed size, so there is no invalidateSize to place by hand.
  let expanded = false;

  function paintExpanded(on) {
    expanded = on;
    ui.card.classList.toggle('card-expanded', on);
    document.body.classList.toggle('has-expanded-card', on);
    expandBtn.textContent = on ? 'Collapse' : 'Expand';
    expandBtn.classList.toggle('active', on);
    expandBtn.setAttribute('aria-expanded', String(on));
  }

  function expand() {
    if (expanded) return;
    paintExpanded(true);
    // Both hops are optional: the method is missing on browsers that have no
    // element fullscreen, and a refusal rejects. Neither is worth reporting —
    // the card is already filling the screen either way.
    ui.card.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
  }

  function collapse() {
    if (!expanded) return;
    paintExpanded(false);
    if (document.fullscreenElement === ui.card) document.exitFullscreen()?.catch(() => {});
  }

  expandBtn.addEventListener('click', () => (expanded ? collapse() : expand()));

  // Native fullscreen takes Escape for itself; this is for the fallback, where
  // nothing but our own class is holding the card over the page.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expanded) collapse();
  });

  // Leaving fullscreen by a route the button does not own — Escape, the
  // browser's own control, or another element taking fullscreen from us.
  document.addEventListener('fullscreenchange', () => {
    if (expanded && document.fullscreenElement !== ui.card) collapse();
  });

  /**
   * @param {boolean} announce Whether to show the wait. True for the loads a
   *   user is sitting through — the first one, and every move — and false for
   *   the background refresh, which replaces frames under a running loop.
   */
  async function loadFrames(announce = true) {
    const mine = ++generation;
    if (announce) {
      announcing = true;
      // Named for the feed as soon as we know which one it is; until the
      // response lands we do not, because coverage decides it.
      ui.loading('Fetching radar frames…');
      clearTimeout(progressTimer);
      progressTimer = setTimeout(endProgress, PROGRESS_LIMIT);
    }
    try {
      // Which feed answers depends on where you are, so the point travels with
      // the request and a move can swap the source underneath us.
      const place = getLocation();
      const data = await api('/api/radar', place ? { lat: place.lat, lon: place.lon } : {});
      if (mine !== generation) return; // a newer place is already loading
      const next = data.frames || [];
      if (!next.length) throw new Error('No radar frames were returned.');

      if (data.source !== source) {
        source = data.source;
        tileOptions = { ...data.tile, attribution: data.attribution };
        motion = null; // different feed, different tile grid
        sourceNote.textContent = `${data.label} — ${SOURCE_NOTES[data.source] || SOURCE_NOTES.rainviewer}`;
      }

      // The window has slid, so remember the moment the loop was showing and
      // put the cursor back on it rather than snapping to the newest frame.
      const watching = frames.length ? timeAt(frames, cursor) : null;
      frames = next;

      ensureMap();
      // Before the layers are built, so a view left too deep by the place we
      // came from is pulled back in first and the frames fetch the tiles they
      // will actually be shown at rather than a row that is discarded.
      applyZoomCeiling();
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
      frames.forEach((f, i) => setZ(layers.get(f.key), 400 + i));

      scrub.max = String(Math.max(0, frames.length - 1));
      // Newest frame last, and there is no forecast tail on either feed.
      cursor = watching == null ? Math.max(0, frames.length - 1) : positionAt(frames, watching);
      render(cursor);
      // The range just changed, so the cached value no longer describes the input.
      scrubValue = null;
      syncScrub(cursor);

      loaded = true;
      // Not `ready` yet when the user is waiting on this one: the frames are
      // only the addresses of the pictures. Hold the pill until the tiles
      // themselves have painted, counting them off as they land — that is the
      // difference between "this is slow" and "this is broken", and on the
      // global composite the gap between the two is seconds of blank map.
      if (announcing) {
        // A frame the loop already had keeps its layer, but a move means new
        // ground under it and so new tiles. Un-count only the layers Leaflet
        // has actually put back to work: if nothing is fetching then what is on
        // screen already is the answer, and the wait is over before it starts.
        for (const f of frames) {
          const layer = layers.get(f.key);
          if (layer?._loading) layer._radarLoaded = false;
        }
        reportProgress();
      } else {
        ui.ready();
      }
      // The window has slid, so the drift is worth re-reading — but not until
      // the newest frame has had a chance to paint.
      motionTries = 0;
      scheduleMotion(2500);
      if (playing && visible) start();
    } catch (err) {
      if (mine !== generation) return;
      announcing = false;
      clearTimeout(progressTimer);
      progressTimer = null;
      // The five-minute refresh failing costs nothing the user can see: the
      // frames already up are minutes old at worst and still looping, and the
      // clock under them says how old. Throwing a banner over that reports a
      // working radar as broken — which is what it was doing. So the error
      // surfaces only when someone is actually waiting on this load, or when
      // there is nothing behind the banner to look at.
      if (announce || !loaded) {
        ui.error(`Radar unavailable: ${err.message}`, () => loadFrames());
      } else {
        console.warn(`[radar] refresh failed, keeping the frames on screen: ${err.message}`);
      }
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
  // keeps up with the faster of the two. Silent: the loop on screen stays
  // watchable while its replacement frames fetch behind it.
  setInterval(() => loadFrames(false), 5 * 60 * 1000);

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
