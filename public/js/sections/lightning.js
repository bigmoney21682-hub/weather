// Recent lightning strikes near you, from the Blitzortung volunteer sensor
// network. Strikes fade as they age so the freshest ones stand out.

import { api, el, clear, relative, duration } from '../util.js';
import { createSection } from '../section.js';
import { createMap, homeMarker, observeSize } from '../map.js';
import { onLocation, getLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M13 2 5 14h5l-1 8 9-12h-5l1-8Z" fill="var(--bolt)"/></svg>`;

const RADIUS_OPTIONS = [15, 30, 60, 120];

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
          refresh();
        },
      }),
    ),
  );

  clear(ui.body).append(mapEl, el('div', { class: 'map-controls' }, radiusPicker, summary), list);

  let map;
  let marker = null;
  let ring = null;
  let layer = null;
  let radius = 30;
  let poll = null;

  function ensureMap(place) {
    if (map) return map;
    map = createMap(mapEl, { center: place ? [place.lat, place.lon] : [39, -98], zoom: 8 });
    layer = L.layerGroup().addTo(map);
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

  async function refresh() {
    const place = getLocation();
    if (!place) return;
    try {
      const data = await api('/api/lightning', { lat: place.lat, lon: place.lon, miles: radius, limit: 50 });
      render(data, place);
      ui.ready();
    } catch (err) {
      ui.error(`Lightning feed unavailable: ${err.message}`);
    }
  }

  function render(data, place) {
    ensureMap(place);
    layer.clearLayers();

    if (ring) ring.remove();
    ring = L.circle([place.lat, place.lon], {
      radius: radius * 1609.34,
      color: 'rgba(255,255,255,.28)',
      weight: 1,
      dashArray: '4 6',
      fill: false,
    }).addTo(map);

    for (const s of data.strikes) {
      const age = Date.now() - s.t;
      const { color, alpha } = ageColor(age);
      L.circleMarker([s.lat, s.lon], {
        radius: 5,
        color,
        weight: 1.5,
        opacity: alpha,
        fillColor: color,
        fillOpacity: alpha * 0.55,
      })
        .bindPopup(
          `<b>Strike</b><br>${relative(s.t)}<br>${s.distanceMiles} mi away${s.sensors ? `<br>${s.sensors} sensors detected it` : ''}`,
        )
        .addTo(layer);
    }

    clear(summary);
    if (!data.connected) {
      summary.append(el('span', { class: 'warn-text', text: `Sensor feed offline${data.lastError ? ` (${data.lastError})` : ''} — retrying.` }));
    } else if (!data.strikes.length) {
      summary.append(
        el('span', { text: `No strikes in the last ${duration(data.watchingMs)} within ${radius} mi.` }),
      );
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

    ui.setSubtitle(`${data.strikes.length} of the last 50 strikes within ${radius} mi of ${place.label}`);
  }

  onLocation((place) => {
    clearInterval(poll);
    if (!place) {
      ui.empty('Set a location above to watch for lightning.');
      return;
    }
    ensureMap(place);
    if (marker) marker.remove();
    marker = homeMarker(map, place.lat, place.lon, place.label);
    map.setView([place.lat, place.lon], 8, { animate: false });
    ui.loading('Listening for strikes…');
    refresh();
    poll = setInterval(refresh, 20000);
  });

  return ui.card;
}
