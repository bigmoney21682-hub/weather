// The wind map under the Wind card's chart: arrows over satellite imagery,
// opening on the state you are in, with a slider (and a play button) from now
// to the end of the day after tomorrow. Arrows point the way the wind is
// blowing, like the ones along the chart and in the Forecast card's hourly row.
//
// The arrows sit on a lattice laid over whatever part of the map is on screen.
// The lattice is anchored to the map's own pixel grid at a whole zoom level,
// and each level's points include every point of the level above it, so
// panning back, or zooming in and out, finds most arrows already fetched.
//
// Every arrow is one point of the viewer's own Open-Meteo allowance, so they
// load on their own only within reach of the state (100 miles, and further
// where the server says so — the Bahamas, for Florida). Past that, the map
// keeps whatever it already has and offers a button to load the view by hand.
// What has been fetched is kept in this browser for a couple of hours, so a
// reload or a return visit costs nothing.

import { api, el } from './util.js';
import { createMap, homeMarker, observeSize } from './map.js';
import { compass } from './icons.js';
import { expandable, expandChip } from './expand.js';

// The same shape as `windArrow` in icons.js, so the map reads like the rows.
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z"/></svg>';
const ARROW_PX = 16;

// Pixels between arrows at the lattice's zoom. Between whole zoom levels the
// map is scaled up, so on screen the spacing runs from this to twice it.
const SPACING_PX = 28;
// Past this zoom the lattice stops getting finer. The forecast models behind
// Open-Meteo are a few kilometres across at best, so a denser field would only
// repeat the same cell's wind — and cost a request per arrow to do it.
const LATTICE_MAX_ZOOM = 9;
// Most arrows on screen at once. A full-screen monitor would otherwise put a
// few thousand on the map, every one a request; past this the lattice steps
// to a coarser level, so a bigger map gets wider spacing rather than more.
const MAX_ARROWS = 350;
// Playback, in hours of forecast per second of screen. The arrows glide
// between hours rather than ticking, so these can be quick without strobing.
const SPEEDS = [
  { label: '1×', hoursPerSecond: 4 },
  { label: '0.5×', hoursPerSecond: 2 },
];
// A beat on the last hour before the loop starts over, so the end reads as an end.
const END_HOLD_MS = 700;

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

// The one request on this page that goes straight from the browser to a
// weather feed rather than through the server. Open-Meteo limits per IP, and
// the server's IP is shared with strangers who spend its allowance; from here
// it counts against the viewer's own. See PRIVACY.md.
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
// The models behind Open-Meteo run every hour to every six, and a forecast
// fetched two hours ago still holds every hour from now on, so this is as
// fresh as the arrows need to be.
const POINT_TTL_MS = 2 * 3600e3;
// Points per request. Open-Meteo takes far more, but a long URL is the first
// thing a proxy refuses, and smaller batches let the nearest arrows land first.
const BATCH = 150;

// Kept in localStorage so a reload, or coming back later in the afternoon,
// does not spend the allowance again on arrows already fetched. Only forecast
// numbers for points on a map grid — see PRIVACY.md. Capped so it never
// crowds out the location the rest of the page depends on.
const STORE_KEY = 'weather.windfield.v1';
const STORE_MAX_POINTS = 1500;

const pointCache = new Map(); // lattice key -> { lat, lon, start, mph, gust, dir, tz, fetched }

(function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    const now = Date.now();
    for (const [key, point] of Object.entries(saved?.points || {})) {
      if (now - point.fetched < POINT_TTL_MS && Array.isArray(point.dir)) pointCache.set(key, point);
    }
  } catch {
    /* corrupt or unavailable storage — start empty */
  }
})();

let saveTimer = null;

/** Write the cache back, newest points first, dropping what has expired. */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const now = Date.now();
    const fresh = [...pointCache.entries()]
      .filter(([, p]) => now - p.fetched < POINT_TTL_MS)
      .sort((a, b) => b[1].fetched - a[1].fetched);
    for (let keep = Math.min(fresh.length, STORE_MAX_POINTS); keep > 0; keep = Math.floor(keep / 2)) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ points: Object.fromEntries(fresh.slice(0, keep)) }));
        return;
      } catch {
        /* over the storage quota — try again with half as many */
      }
    }
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage unavailable altogether */
    }
  }, 500);
}

/** Fetch hourly wind for `points` ({ key, lat, lon }) into the cache. */
async function fetchPoints(points) {
  const url =
    `${OPEN_METEO}?latitude=${points.map((p) => p.lat.toFixed(3)).join(',')}` +
    `&longitude=${points.map((p) => p.fetchLon.toFixed(3)).join(',')}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=mph` +
    `&forecast_days=4&timeformat=unixtime&timezone=auto`;
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  const raw = await res.json().catch(() => null);
  if (!res.ok) throw new Error(raw?.reason || `Open-Meteo answered ${res.status}`);
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length !== points.length) throw new Error('Open-Meteo returned the wrong number of wind points');
  const round = (v) => (v == null ? null : Math.round(v));
  const fetched = Date.now();
  points.forEach((p, i) => {
    const h = list[i].hourly;
    // Each point's series starts at its own local midnight, so values are
    // looked up by instant rather than by index — see `at` below.
    pointCache.set(p.key, {
      lat: p.lat,
      lon: p.lon,
      start: h.time[0] * 1000,
      mph: h.wind_speed_10m.map(round),
      gust: h.wind_gusts_10m.map(round),
      dir: h.wind_direction_10m.map(round),
      tz: list[i].timezone,
      fetched,
    });
  });
  persist();
}

/** A point's value of `series` at instant `ms`, or null outside its hours. */
const at = (point, series, ms) => point[series][Math.round((ms - point.start) / 3600e3)] ?? null;

/** `a` to `b` by fraction `t`, or whichever one exists. */
const lerp = (a, b, t) => (a == null ? b : b == null ? a : a + (b - a) * t);

/** Compass bearing `a` to `b` by fraction `t`, the short way round. */
function lerpAngle(a, b, t) {
  if (a == null || b == null) return a ?? b;
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

/** Local calendar date in `tz` as 'YYYY-MM-DD'. */
const localDate = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });

/** Every hour from this one to the end of the day after tomorrow, in `tz`. */
function hoursAhead(tz) {
  const out = [];
  let ms = Math.floor(Date.now() / 3600e3) * 3600e3;
  const days = new Set();
  for (;;) {
    days.add(localDate(ms, tz));
    if (days.size > 3) break;
    out.push(ms);
    ms += 3600e3;
  }
  return out;
}

export function windField() {
  const mapEl = el('div', { class: 'map map-tall', id: 'wind-map' });
  const timeLabel = el('span', { class: 'frame-time wind-map-time', text: '—' });
  const playBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Play', text: '▶' });
  const speedBtn = el('button', { class: 'chip', type: 'button', text: SPEEDS[0].label, title: 'Playback speed' });
  const scrub = el('input', { type: 'range', class: 'scrub', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Forecast hour' });
  const nowBtn = el('button', { class: 'chip', type: 'button', text: 'Now' });
  const recenter = el('button', { class: 'chip', type: 'button', text: 'Recenter' });
  const loadHere = el('button', { class: 'chip', type: 'button', text: 'Load arrows here', title: 'Fetch wind for everything on screen' });
  const expandBtn = expandChip();
  const status = el('p', { class: 'fine-print wind-map-status hidden' });

  const node = el(
    'div',
    { class: 'wind-map' },
    el('h4', { class: 'sub-head', text: 'Wind map' }),
    mapEl,
    el(
      'div',
      { class: 'map-controls' },
      playBtn,
      scrub,
      timeLabel,
      el('div', { class: 'control-group' }, speedBtn, nowBtn, recenter, loadHere, expandBtn),
    ),
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
  let layer = null;
  let home = null;
  let place = null;
  let geometry = null; // { area: { bounds, center }, timezone }
  let reach = null; // L.LatLngBounds arrows load inside unasked
  // Position along `hours`, fractional while playing: 2.5 is half past the third hour.
  let cursor = 0;
  let speed = 0;
  let raf = null;
  let lastTs = 0;
  let holdUntil = 0;
  let tz; // undefined reads in the browser's own zone until one is known
  let hours = [];
  const markers = new Map(); // lattice key -> marker on screen
  const pending = new Set(); // lattice keys being fetched
  let token = 0;
  let moveTimer = null;

  function setStatus(text) {
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
  }

  function ensureMap() {
    if (map) return map;
    map = createMap(mapEl, { center: [place.lat, place.lon], zoom: 6, theme: 'satellite', zoomSnap: 0.25 });
    layer = L.layerGroup().addTo(map);
    observeSize(map, mapEl);
    map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(refresh, 250);
    });
    return map;
  }

  /**
   * Open on the state, centred on the middle of its land. The zoom is the one
   * that fits a box around that centre holding the whole state, so a lopsided
   * state like Florida is centred and still shows the end of its panhandle.
   */
  function fit() {
    if (!map || !geometry) return;
    const [s, w, n, e] = geometry.area.bounds;
    const [cLat, cLon] = geometry.area.center;
    const halfLat = Math.max(n - cLat, cLat - s);
    const halfLon = Math.max(e - cLon, cLon - w);
    const box = L.latLngBounds([cLat - halfLat, cLon - halfLon], [cLat + halfLat, cLon + halfLon]);
    map.setView([cLat, cLon], map.getBoundsZoom(box, false, L.point(16, 16)), { animate: false });
  }

  /** The lattice points covering the view, one cell beyond each edge. */
  function latticeInView() {
    const size = map.getSize();
    const need = Math.sqrt((size.x * size.y) / MAX_ARROWS);
    const coarser = Math.log2(Math.max(1, need / SPACING_PX));
    const z = Math.max(0, Math.min(Math.floor(map.getZoom() - coarser), LATTICE_MAX_ZOOM));
    const b = map.getBounds();
    const nw = map.project(b.getNorthWest(), z);
    const se = map.project(b.getSouthEast(), z);
    const out = [];
    for (let i = Math.floor(nw.x / SPACING_PX) - 1; i <= Math.ceil(se.x / SPACING_PX) + 1; i++) {
      for (let j = Math.floor(nw.y / SPACING_PX) - 1; j <= Math.ceil(se.y / SPACING_PX) + 1; j++) {
        const ll = map.unproject([i * SPACING_PX, j * SPACING_PX], z);
        if (Math.abs(ll.lat) > 85) continue;
        const lat = Math.round(ll.lat * 1e4) / 1e4;
        const lon = Math.round(ll.lng * 1e4) / 1e4;
        // Leaflet keeps going past the antimeridian when you pan round the
        // world; the arrow stays where it was drawn, the forecast asked for is
        // the real longitude underneath it.
        out.push({ key: `${lat},${lon}`, lat, lon, fetchLon: ((((lon + 180) % 360) + 360) % 360) - 180 });
      }
    }
    return out;
  }

  function markerFor(key, point) {
    const marker = L.marker([point.lat, point.lon], {
      icon: L.divIcon({
        className: 'wind-map-arrow',
        html: ARROW,
        iconSize: [ARROW_PX, ARROW_PX],
        iconAnchor: [ARROW_PX / 2, ARROW_PX / 2],
      }),
      keyboard: false,
    }).addTo(layer);
    marker.bindTooltip(() => {
      const ms = hours[Math.round(cursor)];
      const mph = at(point, 'mph', ms);
      const gust = at(point, 'gust', ms);
      return `${compass(at(point, 'dir', ms))} ${mph ?? '—'} mph${gust != null ? ` · gusts ${gust}` : ''}`;
    }, { direction: 'top', offset: [0, -8] });
    markers.set(key, marker);
    paint(marker, point);
    return marker;
  }

  /**
   * Draw one arrow at `cursor`, blending the hours either side of it.
   *
   * The rotation is kept unwrapped per arrow and only ever moved by the short
   * way round, so a wind backing from 350° to 10° turns twenty degrees rather
   * than spinning the other three hundred and forty — which is what made the
   * old hour-by-hour ticks lurch.
   */
  function paint(marker, point) {
    const glyph = marker.getElement()?.firstElementChild;
    if (!glyph) return;
    const i = Math.floor(cursor);
    const t = cursor - i;
    const a = hours[i];
    const b = hours[Math.min(i + 1, hours.length - 1)];
    const dir = lerpAngle(at(point, 'dir', a), at(point, 'dir', b), t);
    const mph = lerp(at(point, 'mph', a), at(point, 'mph', b), t);
    if (dir == null) {
      glyph.style.visibility = 'hidden';
      return;
    }
    const target = dir + 180;
    const prev = marker._rot ?? target;
    marker._rot = prev + (((target - prev + 540) % 360) - 180);
    glyph.style.transform = `rotate(${marker._rot.toFixed(1)}deg) scale(${(0.8 + Math.min(mph ?? 0, 40) / 80).toFixed(3)})`;
    glyph.style.color = speedColor(mph);
    glyph.style.visibility = '';
  }

  function show() {
    const i = Math.round(cursor);
    timeLabel.textContent =
      i === 0
        ? 'Now'
        : new Date(hours[i]).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }).replace(',', '');
    for (const [key, marker] of markers) {
      const point = pointCache.get(key);
      if (point) paint(marker, point);
    }
  }

  function setHours() {
    const keep = hours[Math.round(cursor)];
    hours = hoursAhead(tz);
    scrub.max = String(hours.length - 1);
    const i = hours.indexOf(keep);
    cursor = i < 0 ? 0 : i;
    scrub.value = String(cursor);
  }

  /** Until the server names the zone, take it from the arrow nearest home. */
  function adoptZone() {
    if (tz || !place) return;
    let best = null;
    let bestD = Infinity;
    for (const p of pointCache.values()) {
      const d = (p.lat - place.lat) ** 2 + (p.lon - place.lon) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best?.tz) {
      tz = best.tz;
      setHours();
    }
  }

  /**
   * Put arrows on whatever is on screen, fetching the ones not yet known —
   * within reach of the state, or everywhere in view when `manual`.
   */
  async function refresh({ manual = false } = {}) {
    if (!map || !geometry) return;
    const mine = token;
    // A page left open rolls "now" forward with the clock.
    if (hours[0] < Math.floor(Date.now() / 3600e3) * 3600e3) {
      setHours();
      show();
    }
    const wanted = latticeInView();
    const wantedKeys = new Set(wanted.map((p) => p.key));

    for (const [key, marker] of markers) {
      if (!wantedKeys.has(key)) {
        marker.remove();
        markers.delete(key);
      }
    }

    const now = Date.now();
    const missing = [];
    const onScreen = map.getBounds();
    let inView = 0;
    let outOfReach = 0;
    for (const p of wanted) {
      const cached = pointCache.get(p.key);
      if (cached && now - cached.fetched < POINT_TTL_MS) {
        if (!markers.has(p.key)) markerFor(p.key, cached);
      } else if (pending.has(p.key)) {
        // already on its way
      } else if (manual || reach.contains([p.lat, p.fetchLon])) {
        missing.push(p);
      } else if (onScreen.contains([p.lat, p.lon])) {
        outOfReach++;
      }
      if (onScreen.contains([p.lat, p.lon])) inView++;
    }
    // A sliver past the edge of the opening view is not worth a note.
    const reachNote = outOfReach > inView * 0.25
      ? `Arrows load on their own within about 100 miles of ${geometry.area.name || 'your area'}. Tap “Load arrows here” for the rest of this view.`
      : '';
    if (!missing.length) {
      if (!pending.size) setStatus(reachNote);
      return;
    }

    // Nearest the middle of the view first, so the part you are looking at fills in first.
    const c = map.getCenter();
    missing.sort((a, b) => (a.lat - c.lat) ** 2 + (a.lon - c.lng) ** 2 - ((b.lat - c.lat) ** 2 + (b.lon - c.lng) ** 2));
    for (const p of missing) pending.add(p.key);
    setStatus('Loading wind…');
    try {
      for (let k = 0; k < missing.length; k += BATCH) {
        const batch = missing.slice(k, k + BATCH);
        try {
          await fetchPoints(batch);
        } finally {
          for (const p of batch) pending.delete(p.key);
        }
        if (mine !== token) return;
        adoptZone();
        show();
        const visible = new Set(latticeInView().map((p) => p.key));
        for (const p of batch) {
          const point = pointCache.get(p.key);
          if (point && visible.has(p.key) && !markers.has(p.key)) markerFor(p.key, point);
        }
      }
      setStatus(reachNote);
    } catch (err) {
      for (const p of missing) pending.delete(p.key);
      if (mine === token) setStatus(`Wind map unavailable: ${err.message || 'could not load'}`);
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = null;
    node.classList.remove('is-playing');
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  }

  /** Advance the cursor by real time and redraw every arrow, once per frame. */
  function tick(ts) {
    const dt = lastTs ? Math.min(ts - lastTs, 100) : 0; // a background tab resumes, it does not leap
    lastTs = ts;
    const last = hours.length - 1;
    if (holdUntil) {
      if (ts >= holdUntil) {
        holdUntil = 0;
        cursor = 0;
      }
    } else {
      cursor += (dt / 1000) * SPEEDS[speed].hoursPerSecond;
      if (cursor >= last) {
        cursor = last;
        holdUntil = ts + END_HOLD_MS;
      }
    }
    scrub.value = String(Math.round(cursor));
    onHour();
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (hours.length < 2) return;
    if (cursor >= hours.length - 1) cursor = 0;
    // Frame-by-frame painting does its own easing; the CSS transition meant for
    // a single scrub step would only drag every frame behind.
    node.classList.add('is-playing');
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    lastTs = 0;
    holdUntil = 0;
    raf = requestAnimationFrame(tick);
  }

  function onHour() {
    show();
    // A tooltip left open keeps the hour it opened on otherwise.
    for (const marker of markers.values()) if (marker.isTooltipOpen()) marker.getTooltip().update();
  }

  playBtn.addEventListener('click', () => (raf ? stop() : play()));
  speedBtn.addEventListener('click', () => {
    speed = (speed + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speed].label;
  });
  scrub.addEventListener('input', () => {
    stop();
    cursor = Number(scrub.value);
    onHour();
  });
  nowBtn.addEventListener('click', () => {
    stop();
    cursor = 0;
    scrub.value = '0';
    onHour();
  });
  recenter.addEventListener('click', fit);
  loadHere.addEventListener('click', () => refresh({ manual: true }));
  expandable(node, expandBtn);

  return {
    node,
    /** Load the field for `next`. Failures stay on the map, not the card. */
    async load(next) {
      const mine = ++token;
      place = next;
      setStatus('Loading the wind map…');
      try {
        const g = await api('/api/windmap', { lat: place.lat, lon: place.lon });
        if (mine !== token) return;
        geometry = g;
        const [s, w, n, e] = g.area.reach;
        reach = L.latLngBounds([s, w], [n, e]);
        tz = g.timezone || undefined;
        setHours();
        ensureMap();
        if (home) home.remove();
        home = homeMarker(map, place.lat, place.lon, place.label);
        fit();
        show();
        await refresh();
      } catch (err) {
        if (mine !== token) return;
        setStatus(`Wind map unavailable: ${err.message || 'could not load'}`);
      }
    },
  };
}
