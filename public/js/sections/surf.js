// Surf: wave height, period, water temperature, the tide table, and where the
// biggest swell is inside a 60-mile radius.

import { api, el, clear, f, clock } from '../util.js';
import { createSection, statTile } from '../section.js';
import { TimeChart } from '../chart.js';
import { compass, windArrow } from '../icons.js';
import { onLocation, getLocation } from '../store.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M2 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" stroke="var(--surf)" stroke-width="2" stroke-linecap="round"/><path d="M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" stroke="var(--surf)" stroke-width="2" stroke-linecap="round" opacity=".55"/><path d="M6 11c2-6 8-8 12-6-3 0-5 2-6 4" stroke="var(--surf)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export function surfSection() {
  const input = el('input', {
    type: 'search',
    class: 'mini-input',
    placeholder: 'Surf spot, ZIP or town',
    'aria-label': 'Look up a different surf spot',
    autocomplete: 'off',
  });
  const go = el('button', { class: 'mini-btn', type: 'submit', text: 'Go' });
  const reset = el('button', { class: 'mini-btn ghost', type: 'button', text: 'Nearest beach' });
  const form = el('form', { class: 'mini-form' }, input, go, reset);

  const ui = createSection({
    id: 'surf',
    title: 'Surf',
    subtitle: 'Waves, tides and water temperature',
    icon: ICON,
    tools: form,
  });

  const stats = el('div', { class: 'stat-row' });
  const canvas = el('canvas', { class: 'chart-canvas' });
  const holder = el('div', { class: 'chart-holder' }, canvas);
  const tideBox = el('div', { class: 'tides' });
  const tideHead = el('h4', { class: 'sub-head', text: 'Tides' });
  const biggestBox = el('div', { class: 'biggest' });

  clear(ui.body).append(
    stats,
    // Tides sit right under the swell and water-temp tiles: they are part of
    // the same "should I paddle out?" glance, not an appendix.
    tideHead,
    tideBox,
    el('h4', { class: 'sub-head', text: 'Wave height forecast' }),
    holder,
    el(
      'div',
      { class: 'chart-legend' },
      el('span', { class: 'key' }, el('i', { style: 'background:var(--surf)' }), 'Wave height (ft)'),
      el('span', { class: 'key' }, el('i', { style: 'background:var(--gust)' }), 'Swell period (s)'),
      el('span', { class: 'hint', text: 'Pinch or scroll to zoom' }),
    ),
    biggestBox,
  );

  // Axis labels follow the location's clock, not the viewer's.
  let tz;

  const chart = new TimeChart(canvas, {
    height: 220,
    zeroBased: true,
    formatY: (v) => v.toFixed(1),
    formatY2: (v) => `${Math.round(v)}s`,
    formatX: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }).replace(',', ''),
    formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }),
  });

  // A spot searched here overrides the page location for this section only,
  // until "Use my location" puts it back in sync.
  let override = null;
  let token = 0;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    go.disabled = true;
    go.textContent = '…';
    try {
      override = await api('/api/geocode', { q });
      input.value = '';
      await load(override);
    } catch (err) {
      ui.error(err.message);
    } finally {
      go.disabled = false;
      go.textContent = 'Go';
    }
  });

  reset.addEventListener('click', () => {
    override = null;
    const place = getLocation();
    if (place) load(place);
  });

  async function load(place) {
    const mine = ++token;
    ui.loading('Reading the buoys…');
    try {
      // An explicitly searched spot is taken at its word; otherwise the server
      // snaps to the nearest beach that actually has swell.
      const data = await api('/api/surf', { lat: place.lat, lon: place.lon, miles: 60, snap: override ? '0' : '1' });
      if (mine !== token) return;
      render(data, place);
      ui.ready();
      if (!data.water) ui.note(data.note);
    } catch (err) {
      if (mine === token) ui.error(err.message, () => load(place));
    }
  }

  function render(data, place) {
    tz = data.timezone || undefined;
    // The card reports on a beach, not on the town in the location bar.
    const beach = data.spot
      ? `${data.spot.name} · ${f.miles(data.spot.distanceMiles)} from ${place.label}`
      : place.label;
    ui.setSubtitle(override ? `${place.label} (spot override)` : beach);

    const c = data.current || {};
    clear(stats).append(
      statTile('Wave height', f.ft(c.waveFt)),
      statTile('Period', f.sec(c.periodS), c.dirDeg != null ? `${windArrow(c.dirDeg + 180)} from ${compass(c.dirDeg)}` : null),
      statTile('Swell', f.ft(c.swellFt), c.swellPeriodS ? `${Math.round(c.swellPeriodS)} s` : null),
      statTile('Water temp', f.tempF(data.waterTempF), data.waterTempSource),
    );

    clear(biggestBox);
    if (data.biggest) {
      const b = data.biggest;
      biggestBox.append(
        el(
          'div',
          { class: 'callout' },
          el('span', { class: 'callout-label', text: `Biggest wave within ${data.scanRadiusMiles} mi` }),
          el('span', { class: 'callout-value', text: f.ft(b.waveFt) }),
          b.city ? el('span', { class: 'callout-city', text: `off ${b.city}` }) : null,
          el('span', {
            class: 'callout-note',
            text:
              b.distanceMiles < 1
                ? 'right here at your spot'
                : `${f.miles(b.distanceMiles)} away · ${b.lat.toFixed(2)}, ${b.lon.toFixed(2)}` +
                  (b.periodS ? ` · ${Math.round(b.periodS)} s period` : ''),
          }),
          el('a', {
            class: 'chip link',
            href: `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lon}#map=10/${b.lat}/${b.lon}`,
            target: '_blank',
            rel: 'noopener',
            text: 'Show on map ↗',
          }),
        ),
      );
    }

    chart.setData([
      {
        key: 'period',
        label: 'Swell period',
        color: 'var(--gust)',
        axis: 'right',
        dashed: true,
        points: data.hourly.map((h) => ({ x: h.epoch * 1000, y: h.swellPeriodS ?? h.periodS })),
        format: (v) => `${Math.round(v)} s`,
      },
      {
        key: 'wave',
        label: 'Wave height',
        color: 'var(--surf)',
        fill: 'rgba(93,225,201,.28)',
        points: data.hourly.map((h) => ({ x: h.epoch * 1000, y: h.waveFt })),
        format: (v) => `${v.toFixed(1)} ft`,
      },
    ], { markers: [{ x: Date.now(), label: 'now' }] });

    tideHead.textContent = data.tidesAreToday ? 'Tides in daylight today' : 'Next tides';
    clear(tideBox);
    if (!data.tides?.length) {
      tideBox.append(
        el('p', { class: 'empty', text: data.tideStation ? 'No tide predictions were returned for the nearest station.' : 'No NOAA tide station within 120 miles.' }),
      );
    } else {
      tideBox.append(
        el(
          'div',
          { class: 'tide-rows' },
          // Already trimmed to the two daylight events for today by the server.
          data.tides.map((t) =>
            el(
              'div',
              { class: `tide-row ${t.kind.toLowerCase()}` },
              el('span', { class: 'tide-kind', text: t.kind }),
              el('span', { class: 'tide-time', text: clock(t.time) }),
              el('span', { class: 'tide-day', text: new Date(t.time).toLocaleDateString([], { weekday: 'short' }) }),
              el('span', { class: 'tide-height', text: `${t.heightFt.toFixed(1)} ft` }),
            ),
          ),
        ),
        el('p', {
          class: 'fine-print',
          text: `Predictions for ${data.tideStation.name}${data.tideStation.state ? `, ${data.tideStation.state}` : ''} — ${f.miles(data.tideStation.distanceMiles)} away (station ${data.tideStation.id}).`,
        }),
      );
    }
  }

  onLocation((place) => {
    if (override) return;
    if (!place) {
      ui.empty('Set a location above to see surf conditions.');
      return;
    }
    load(place);
  });

  return ui.card;
}
