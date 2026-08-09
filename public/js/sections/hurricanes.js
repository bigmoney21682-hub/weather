// Active tropical cyclones worldwide. Pick a storm to get its official
// advisory, forecast track, cone of uncertainty and intensity forecast.

import { api, el, clear, mount, f, clock } from '../util.js';
import { createSection, statTile } from '../section.js';
import { createMap, observeSize } from '../map.js';
import { TimeChart } from '../chart.js';
import { getLocation, onLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M12 12c4-4 9-3 9 1 0 3-4 5-9 5" stroke="var(--storm)" stroke-width="2" stroke-linecap="round"/><path d="M12 12c-4 4-9 3-9-1 0-3 4-5 9-5" stroke="var(--storm)" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="var(--storm)"/></svg>`;

const CAT_COLOR = {
  cat5: '#ff3d6e',
  cat4: '#ff6b4a',
  cat3: '#ff9f43',
  cat2: '#ffd166',
  cat1: '#f6f36b',
  ts: '#6be3a0',
  td: '#5ec4ff',
  unknown: '#9aa4b8',
};

export function hurricaneSection() {
  const ui = createSection({
    id: 'hurricanes',
    title: 'Hurricane Tracker',
    subtitle: 'Active tropical cyclones worldwide',
    icon: ICON,
  });

  const mapEl = el('div', { class: 'map map-tall', id: 'storm-map' });
  const picker = el('div', { class: 'storm-picker' });
  const detail = el('div', { class: 'storm-detail' });

  clear(ui.body).append(picker, mapEl, detail);

  let map;
  let stormLayer;
  let selectedId = null;
  let storms = [];
  let chart = null;

  function ensureMap() {
    if (map) return map;
    map = createMap(mapEl, { center: [20, -60], zoom: 3, worldCopyJump: true });
    stormLayer = L.layerGroup().addTo(map);
    observeSize(map, mapEl);
    return map;
  }

  async function loadList() {
    ui.loading('Checking the basins…');
    try {
      const data = await api('/api/hurricanes');
      storms = data.storms;
      ensureMap();
      renderPicker();
      if (!storms.length) {
        ui.ready();
        clear(detail).append(
          el(
            'div',
            { class: 'all-clear' },
            el('span', { class: 'all-clear-mark', text: '✓' }),
            el(
              'div',
              {},
              el('b', { text: 'No active tropical cyclones' }),
              el('p', { text: 'Neither the National Hurricane Center nor the Joint Typhoon Warning Center has a system under warning right now.' }),
            ),
          ),
        );
        stormLayer.clearLayers();
        return;
      }
      // Default to the storm nearest the user, else the strongest one going.
      const place = getLocation();
      const pick = place
        ? storms
            .filter((s) => s.lat != null)
            .sort(
              (a, b) =>
                Math.hypot(a.lat - place.lat, a.lon - place.lon) - Math.hypot(b.lat - place.lat, b.lon - place.lon),
            )[0]
        : storms.slice().sort((a, b) => (b.windMph || 0) - (a.windMph || 0))[0];
      select(pick?.id || storms[0].id);
      ui.ready();
    } catch (err) {
      ui.error(`Storm data unavailable: ${err.message}`, loadList);
    }
  }

  function renderPicker() {
    clear(picker);
    if (!storms.length) return;
    mount(picker,
      storms.map((s) =>
        el(
          'button',
          {
            class: `storm-chip cat-${s.class}`,
            type: 'button',
            dataset: { id: s.id },
            onClick: () => select(s.id),
          },
          el('span', { class: 'storm-chip-name', text: s.name }),
          el('span', { class: 'storm-chip-meta', text: `${s.label} · ${s.windMph ? `${s.windMph} mph` : s.basin}` }),
        ),
      ),
    );
  }

  async function select(id) {
    selectedId = id;
    picker.querySelectorAll('.storm-chip').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
    clear(detail).append(el('p', { class: 'empty', text: 'Loading advisory…' }));
    try {
      const storm = await api('/api/hurricane', { id });
      if (selectedId !== id) return;
      drawStorm(storm);
      renderDetail(storm);
    } catch (err) {
      clear(detail).append(el('p', { class: 'empty', text: err.message }));
    }
  }

  function drawStorm(storm) {
    ensureMap();
    stormLayer.clearLayers();

    if (storm.cone?.polygon?.length) {
      L.polygon(
        storm.cone.polygon.map(([lon, lat]) => [lat, lon]),
        { color: 'rgba(255,255,255,.45)', weight: 1, fillColor: '#ffffff', fillOpacity: 0.12, dashArray: '5 5' },
      )
        .bindPopup(`<b>Cone of uncertainty</b><br>${storm.coneNote}`)
        .addTo(stormLayer);
    }

    const track = storm.track.filter((p) => p.lat != null);
    if (track.length > 1) {
      L.polyline(
        track.map((p) => [p.lat, p.lon]),
        { color: '#ffffff', weight: 2, opacity: 0.8 },
      ).addTo(stormLayer);
    }

    track.forEach((p, i) => {
      const cat = catFor(p.windMph);
      L.circleMarker([p.lat, p.lon], {
        radius: i === 0 ? 9 : 6,
        color: '#0b0f18',
        weight: 1.5,
        fillColor: CAT_COLOR[cat.class],
        fillOpacity: 0.95,
      })
        .bindPopup(
          `<b>${i === 0 ? 'Current position' : `+${p.hour} h`}</b><br>${p.windMph ? `${p.windMph} mph (${cat.label})` : 'intensity n/a'}` +
            `${p.gustMph ? `<br>gusts ${p.gustMph} mph` : ''}` +
            `${p.time ? `<br>${new Date(p.time).toLocaleString()}` : ''}`,
        )
        .addTo(stormLayer);
    });

    // 34/50/64 kt wind field around the current centre.
    if (storm.windRadii && storm.lat != null) {
      const shades = { 34: 'rgba(94,196,255,.16)', 50: 'rgba(255,209,102,.16)', 64: 'rgba(255,61,110,.18)' };
      for (const [kt, q] of Object.entries(storm.windRadii)) {
        const maxNm = Math.max(q.ne, q.se, q.sw, q.nw);
        if (!maxNm) continue;
        L.circle([storm.lat, storm.lon], {
          radius: maxNm * 1852,
          color: shades[kt].replace(/[\d.]+\)$/, '.5)'),
          weight: 1,
          fillColor: shades[kt],
          fillOpacity: 0.5,
        })
          .bindPopup(`<b>${kt} kt wind field</b><br>up to ${Math.round(maxNm * 1.15)} miles from the centre`)
          .addTo(stormLayer);
      }
    }

    if (track.length) {
      map.fitBounds(L.latLngBounds(track.map((p) => [p.lat, p.lon])).pad(0.45), { animate: true, maxZoom: 7 });
    }
  }

  function renderDetail(storm) {
    const cat = { label: storm.label, class: storm.class };
    const stats = el(
      'div',
      { class: 'stat-row' },
      statTile('Max sustained', f.mph(storm.windMph), cat.label),
      statTile('Gusts', f.mph(storm.gustMph)),
      statTile('Pressure', storm.pressureMb ? `${storm.pressureMb} mb` : '—'),
      statTile('Moving', storm.movementMph ? `${storm.movementMph} mph` : '—', storm.movementDir != null ? `toward ${Math.round(storm.movementDir)}°` : null),
    );

    const canvas = el('canvas', { class: 'chart-canvas' });
    const chartHolder = el('div', { class: 'chart-holder chart-short' }, canvas);

    const advisoryBox = el(
      'details',
      { class: 'advisory' },
      el('summary', { text: `Full advisory${storm.advisoryNumber ? ` #${storm.advisoryNumber}` : ''} from ${storm.agency}` }),
      el('pre', { class: 'advisory-text', text: storm.advisoryText || 'No advisory text available.' }),
    );

    const toggles = el(
      'div',
      { class: 'control-group storm-toggles' },
      el('button', {
        class: 'chip active',
        type: 'button',
        text: 'Cone',
        onClick(e) {
          const on = e.currentTarget.classList.toggle('active');
          stormLayer.eachLayer((l) => {
            if (l instanceof L.Polygon && !(l instanceof L.Rectangle)) l.setStyle({ opacity: on ? 1 : 0, fillOpacity: on ? 0.12 : 0 });
          });
        },
      }),
      el('a', {
        class: 'chip link',
        href: storm.links?.modelPlots || '#',
        target: '_blank',
        rel: 'noopener',
        text: 'Model spaghetti ↗',
      }),
      el('a', {
        class: 'chip link',
        href: storm.links?.official || '#',
        target: '_blank',
        rel: 'noopener',
        text: `${storm.agency} page ↗`,
      }),
    );

    clear(detail).append(
      el(
        'div',
        { class: 'storm-head' },
        el('h3', { class: `storm-name cat-${storm.class}`, text: `${storm.classification || ''} ${storm.name}`.trim() }),
        el('span', { class: 'storm-basin', text: `${storm.basin} · ${storm.agency}${storm.lastUpdate ? ` · updated ${clock(storm.lastUpdate)}` : ''}` }),
      ),
      stats,
      el('h4', { class: 'sub-head', text: 'Forecast intensity' }),
      chartHolder,
      el(
        'div',
        { class: 'chart-legend' },
        el('span', { class: 'key' }, el('i', { style: 'background:var(--wind)' }), 'Sustained wind'),
        el('span', { class: 'key' }, el('i', { style: 'background:var(--gust)' }), 'Gusts'),
        el('span', { class: 'hint', text: 'Pinch or scroll to zoom' }),
      ),
      toggles,
      el('p', { class: 'fine-print', text: storm.coneNote }),
      advisoryBox,
    );

    if (chart) chart.destroy();
    chart = new TimeChart(canvas, {
      height: 190,
      zeroBased: true,
      formatY: (v) => `${Math.round(v)}`,
      formatX: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' }).replace(',', ''),
      formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric' }),
    });

    const pts = storm.track.filter((p) => p.time && p.windMph != null);
    chart.setData([
      {
        key: 'gust',
        label: 'Gusts',
        color: 'var(--gust)',
        dashed: true,
        dots: true,
        points: pts.map((p) => ({ x: new Date(p.time).getTime(), y: p.gustMph })),
        format: (v) => `${Math.round(v)} mph`,
      },
      {
        key: 'wind',
        label: 'Sustained',
        color: 'var(--wind)',
        fill: 'rgba(94,196,255,.26)',
        dots: true,
        points: pts.map((p) => ({ x: new Date(p.time).getTime(), y: p.windMph })),
        format: (v) => `${Math.round(v)} mph`,
      },
    ]);
  }

  function catFor(mph) {
    if (mph == null) return { label: 'Unknown', class: 'unknown' };
    if (mph >= 157) return { label: 'Category 5', class: 'cat5' };
    if (mph >= 130) return { label: 'Category 4', class: 'cat4' };
    if (mph >= 111) return { label: 'Category 3', class: 'cat3' };
    if (mph >= 96) return { label: 'Category 2', class: 'cat2' };
    if (mph >= 74) return { label: 'Category 1', class: 'cat1' };
    if (mph >= 39) return { label: 'Tropical Storm', class: 'ts' };
    return { label: 'Tropical Depression', class: 'td' };
  }

  onLocation(() => {
    if (!storms.length) return;
    ensureMap();
  });

  loadList();
  setInterval(loadList, 15 * 60 * 1000);

  return ui.card;
}
