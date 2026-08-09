// Recent lightning strikes near you, from the Blitzortung volunteer sensor
// network. Strikes fade as they age so the freshest ones stand out.
//
// "Watch live" turns the map into something closer to standing outside: each
// new strike drops a dot where it hit, and a ring leaves that dot travelling at
// the speed of sound. When the ring reaches you, you hear the thunder — the
// same gap you would count out between the flash and the bang.

import { api, el, clear, relative, duration } from '../util.js';
import { createSection } from '../section.js';
import { createMap, homeMarker, observeSize } from '../map.js';
import { onLocation, getLocation } from '../store.js';
import { primeThunder, thunder, setThunderMuted, isThunderMuted } from '../thunder.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M13 2 5 14h5l-1 8 9-12h-5l1-8Z" fill="var(--bolt)"/></svg>`;

const RADIUS_OPTIONS = [15, 30, 60, 120];

const SOUND_MPS = 343; // speed of sound in air, near enough at ground level
const METRES_PER_MILE = 1609.34;
const WATCH_POLL_MS = 2000;
const IDLE_POLL_MS = 20000;
// A strike first seen older than this gets a dot but no wavefront: its thunder
// has already been and gone.
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_WAVES = 40;

export function lightningSection() {
  const ui = createSection({
    id: 'lightning',
    title: 'Lightning',
    subtitle: 'Live strikes within 30 miles',
    icon: ICON,
  });

  const mapEl = el('div', { class: 'map', id: 'lightning-map' });
  const summary = el('div', { class: 'strike-summary' });
  const list = el('div', { class: 'strike-list' });

  const watchBtn = el('button', { class: 'chip watch-btn', type: 'button', text: '● Watch live' });
  const soundBtn = el('button', {
    class: 'chip sound-btn',
    type: 'button',
    text: '🔊',
    title: 'Mute thunder',
    'aria-label': 'Mute thunder',
    'aria-pressed': 'false',
  });

  const radiusPicker = el(
    'div',
    { class: 'control-group' },
    RADIUS_OPTIONS.map((r) =>
      el('button', {
        class: `chip${r === 30 ? ' active' : ''}`,
        type: 'button',
        text: `${r} mi`,
        onClick(e) {
          radius = r;
          radiusPicker.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
          e.currentTarget.classList.add('active');
          ui.setSubtitle(`Live strikes within ${radius} miles`);
          resetMarkers();
          refresh();
        },
      }),
    ),
  );

  clear(ui.body).append(
    mapEl,
    el('div', { class: 'map-controls' }, radiusPicker, el('div', { class: 'control-group' }, watchBtn, soundBtn), summary),
    el('p', { class: 'watch-note fine-print hidden', text: '' }),
    list,
  );
  const watchNote = ui.body.querySelector('.watch-note');

  let map;
  let marker = null;
  let ring = null;
  let layer = null; // the rolling snapshot of recent strikes
  let liveLayer = null; // wavefronts, which outlive individual refreshes
  let radius = 30;
  let poll = null;

  const markers = new Map(); // strike key -> circleMarker
  const seen = new Set(); // strike keys already considered for a wavefront
  let waves = [];
  let watching = false;
  let raf = null;
  let watchdog = null;

  const strikeKey = (s) => `${s.t}:${s.lat.toFixed(4)}:${s.lon.toFixed(4)}`;

  function ensureMap(place) {
    if (map) return map;
    map = createMap(mapEl, { center: place ? [place.lat, place.lon] : [39, -98], zoom: 8 });
    layer = L.layerGroup().addTo(map);
    liveLayer = L.layerGroup().addTo(map);
    observeSize(map, mapEl);
    return map;
  }

  function ageColor(ms) {
    // 0–10 min: hot yellow. Older strikes cool toward violet and fade out.
    const t = Math.min(1, ms / (60 * 60 * 1000));
    const hue = 52 - t * 62; // 52° amber → -10° (≈350°, magenta)
    const light = 62 - t * 18;
    const alpha = 0.95 - t * 0.6;
    return { color: `hsl(${(hue + 360) % 360} 95% ${light}%)`, alpha };
  }

  /* ------------------------------------------------------------ watching -- */

  /**
   * Launch a thunder wavefront from a strike. The ring is positioned from the
   * strike's own timestamp, not from when we happened to receive it, so a
   * strike that arrives two seconds late starts two seconds out.
   */
  function spawnWave(strike, place) {
    if (waves.length >= MAX_WAVES) return;
    const listenerM = strike.distanceMiles * METRES_PER_MILE;
    const elapsed = (Date.now() - strike.t) / 1000;

    const wave = {
      t: strike.t,
      listenerM,
      distanceMiles: strike.distanceMiles,
      // If the sound already swept past us, show the dot but stay quiet.
      heard: elapsed * SOUND_MPS > listenerM,
      dot: L.circleMarker([strike.lat, strike.lon], {
        radius: 10,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillColor: '#ffe98a',
        fillOpacity: 0.95,
      }).addTo(liveLayer),
      front: L.circle([strike.lat, strike.lon], {
        radius: Math.max(1, elapsed * SOUND_MPS),
        color: '#ffd93d',
        weight: 2,
        opacity: 0.85,
        fill: false,
      }).addTo(liveLayer),
    };
    wave.dot.bindPopup(`<b>Strike</b><br>${relative(strike.t)}<br>${strike.distanceMiles} mi away`);
    waves.push(wave);
    if (place) announce(place);
  }

  function announce(place) {
    const pending = waves.filter((w) => !w.heard).length;
    watchNote.classList.remove('hidden');
    watchNote.textContent = pending
      ? `${pending} thunder${pending === 1 ? '' : 's'} still travelling toward ${place.label}.`
      : `Watching for strikes within ${radius} mi of ${place.label} — the ring is the thunder, moving at ${SOUND_MPS} m/s.`;
  }

  /**
   * Advance every wavefront. Everything is derived from the strike's wall-clock
   * timestamp rather than accumulated per frame, so this is safe to call at any
   * rate — which is what lets a coarse timer stand in for the animation frames
   * a backgrounded tab does not get.
   */
  function update() {
    const now = Date.now();
    const place = getLocation();

    waves = waves.filter((wave) => {
      const elapsed = (now - wave.t) / 1000;
      const radiusM = elapsed * SOUND_MPS;
      wave.front.setRadius(Math.max(1, radiusM));

      // The flash itself is brief; the dot then settles to a small marker and
      // stops needing to be redrawn.
      const flash = Math.max(0, 1 - elapsed / 1.2);
      if (!wave.settled) {
        wave.dot.setRadius(5 + flash * 7);
        wave.dot.setStyle({ fillOpacity: 0.45 + flash * 0.5 });
        wave.settled = flash === 0;
      }

      if (!wave.heard && radiusM >= wave.listenerM) {
        wave.heard = true;
        thunder(wave.distanceMiles);
        if (place) announce(place);
      }

      // Hold the ring at full strength the whole way in — it is brightest as it
      // arrives, which is the moment the thunder lands — then let it fall away
      // once it has swept past.
      const overrun = radiusM - wave.listenerM;
      const tail = wave.listenerM * 0.35 + 3000;
      wave.front.setStyle({ opacity: overrun <= 0 ? 0.85 : Math.max(0, 0.85 * (1 - overrun / tail)) });
      const done = overrun > tail;
      if (done) {
        liveLayer.removeLayer(wave.front);
        liveLayer.removeLayer(wave.dot);
      }
      return !done;
    });
  }

  function frameLoop() {
    update();
    if (watching) raf = requestAnimationFrame(frameLoop);
  }

  function startWatching() {
    if (watching) return;
    watching = true;
    primeThunder(); // must happen inside the click that turned this on
    watchBtn.textContent = '■ Stop';
    watchBtn.classList.add('active');
    const place = getLocation();
    if (place) announce(place);
    raf = requestAnimationFrame(frameLoop);
    // Animation frames stop in a hidden tab; this keeps the rings honest and
    // stops finished ones from piling up while the page is in the background.
    watchdog = setInterval(update, 500);
    schedulePoll();
    refresh();
  }

  function stopWatching() {
    watching = false;
    watchBtn.textContent = '● Watch live';
    watchBtn.classList.remove('active');
    cancelAnimationFrame(raf);
    clearInterval(watchdog);
    for (const wave of waves) {
      liveLayer.removeLayer(wave.front);
      liveLayer.removeLayer(wave.dot);
    }
    waves = [];
    watchNote.classList.add('hidden');
    schedulePoll();
  }

  watchBtn.addEventListener('click', () => (watching ? stopWatching() : startWatching()));

  soundBtn.addEventListener('click', () => {
    const nowMuted = !isThunderMuted();
    setThunderMuted(nowMuted);
    soundBtn.textContent = nowMuted ? '🔇' : '🔊';
    soundBtn.title = nowMuted ? 'Unmute thunder' : 'Mute thunder';
    soundBtn.setAttribute('aria-label', soundBtn.title);
    soundBtn.setAttribute('aria-pressed', String(nowMuted));
  });

  /* ------------------------------------------------------------- loading -- */

  function schedulePoll() {
    clearInterval(poll);
    if (getLocation()) poll = setInterval(refresh, watching ? WATCH_POLL_MS : IDLE_POLL_MS);
  }

  function resetMarkers() {
    layer?.clearLayers();
    markers.clear();
    seen.clear();
  }

  async function refresh() {
    const place = getLocation();
    if (!place) return;
    try {
      const data = await api('/api/lightning', { lat: place.lat, lon: place.lon, miles: radius, limit: 50 });
      render(data, place);
      ui.ready();
    } catch (err) {
      ui.error(`Lightning feed unavailable: ${err.message}`, refresh);
    }
  }

  function render(data, place) {
    ensureMap(place);

    if (ring) ring.remove();
    ring = L.circle([place.lat, place.lon], {
      radius: radius * METRES_PER_MILE,
      color: 'rgba(255,255,255,.28)',
      weight: 1,
      dashArray: '4 6',
      fill: false,
    }).addTo(map);

    // Markers are added and removed rather than rebuilt, so a two-second watch
    // poll does not make the whole map flicker.
    const live = new Set();
    for (const s of data.strikes) {
      const key = strikeKey(s);
      live.add(key);
      const { color, alpha } = ageColor(Date.now() - s.t);

      let dot = markers.get(key);
      if (!dot) {
        dot = L.circleMarker([s.lat, s.lon], { radius: 5, weight: 1.5 })
          .bindPopup(
            `<b>Strike</b><br>${relative(s.t)}<br>${s.distanceMiles} mi away${s.sensors ? `<br>${s.sensors} sensors detected it` : ''}`,
          )
          .addTo(layer);
        markers.set(key, dot);
      }
      dot.setStyle({ color, opacity: alpha, fillColor: color, fillOpacity: alpha * 0.55 });

      if (!seen.has(key)) {
        seen.add(key);
        if (watching && Date.now() - s.t < LIVE_WINDOW_MS) spawnWave(s, place);
      }
    }

    for (const [key, dot] of markers) {
      if (!live.has(key)) {
        layer.removeLayer(dot);
        markers.delete(key);
      }
    }

    clear(summary);
    if (!data.connected) {
      summary.append(el('span', { class: 'warn-text', text: `Sensor feed offline${data.lastError ? ` (${data.lastError})` : ''} — retrying.` }));
    } else if (!data.strikes.length) {
      summary.append(el('span', { text: `No strikes in the last ${duration(data.watchingMs)} within ${radius} mi.` }));
    } else {
      const newest = data.strikes[0];
      summary.append(
        el('b', { text: `${data.strikes.length} strike${data.strikes.length === 1 ? '' : 's'}` }),
        el('span', { text: ` · nearest ${Math.min(...data.strikes.map((s) => s.distanceMiles)).toFixed(1)} mi · latest ${relative(newest.t)}` }),
      );
    }

    clear(list);
    if (data.strikes.length) {
      list.append(
        el(
          'div',
          { class: 'strike-rows' },
          data.strikes.slice(0, 8).map((s) =>
            el(
              'button',
              {
                class: 'strike-row',
                type: 'button',
                onClick() {
                  map.setView([s.lat, s.lon], Math.max(map.getZoom(), 10), { animate: true });
                },
              },
              el('span', { class: 'strike-dot', style: `background:${ageColor(Date.now() - s.t).color}` }),
              el('span', { class: 'strike-when', text: relative(s.t) }),
              el('span', { class: 'strike-dist', text: `${s.distanceMiles} mi` }),
              el('span', { class: 'strike-pos', text: `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}` }),
            ),
          ),
        ),
      );
    }

    ui.setSubtitle(
      `${data.strikes.length} of the last 50 strikes within ${radius} mi of ${place.label}${watching ? ' · watching live' : ''}`,
    );
  }

  onLocation((place) => {
    clearInterval(poll);
    if (!place) {
      ui.empty('Set a location above to watch for lightning.');
      return;
    }
    ensureMap(place);
    resetMarkers();
    if (marker) marker.remove();
    marker = homeMarker(map, place.lat, place.lon, place.label);
    map.setView([place.lat, place.lon], 8, { animate: false });
    ui.loading('Listening for strikes…');
    refresh();
    schedulePoll();
  });

  return ui.card;
}
