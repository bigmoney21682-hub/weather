// Air quality now, over the next day, and anything worse within 60 miles.

import { api, el, clear, mount, clock } from '../util.js';
import { createSection, bindLocation, statTile } from '../section.js';
import { TimeChart } from '../chart.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M3 9h11a3 3 0 1 0-3-3" stroke="var(--air)" stroke-width="1.9" stroke-linecap="round"/><path d="M3 14h14a3 3 0 1 1-3 3" stroke="var(--air)" stroke-width="1.9" stroke-linecap="round"/><circle cx="19" cy="10" r="1.4" fill="var(--air)"/></svg>`;

export function airSection() {
  const ui = createSection({
    id: 'air',
    title: 'Air Quality',
    subtitle: 'US AQI here, plus advisories within 60 miles',
    icon: ICON,
  });

  const dial = el('div', { class: 'aqi-dial' });
  const stats = el('div', { class: 'stat-row' });
  const canvas = el('canvas', { class: 'chart-canvas' });
  const holder = el('div', { class: 'chart-holder chart-short' }, canvas);
  const advisories = el('div', { class: 'aq-advisories' });

  clear(ui.body).append(
    dial,
    stats,
    el('h4', { class: 'sub-head', text: 'Next 24 hours' }),
    holder,
    el(
      'div',
      { class: 'chart-legend' },
      el('span', { class: 'key' }, el('i', { style: 'background:var(--air)' }), 'US AQI'),
      el('span', { class: 'key' }, el('i', { style: 'background:var(--gust)' }), 'PM2.5 µg/m³'),
      el('span', { class: 'hint', text: 'Pinch or scroll to zoom' }),
    ),
    el('h4', { class: 'sub-head', text: 'Nearby' }),
    advisories,
  );

  // Axis labels follow the location's clock, not the viewer's.
  let tz;

  const chart = new TimeChart(canvas, {
    height: 180,
    zeroBased: true,
    formatY: (v) => String(Math.round(v)),
    formatY2: (v) => v.toFixed(0),
    formatX: (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', timeZone: tz }).replace(' ', ''),
    formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }),
  });

  bindLocation(ui, async (place) => {
    const data = await api('/api/air', { lat: place.lat, lon: place.lon, miles: 60 });
    render(data, place);
  });

  function render(data, place) {
    tz = data.timezone || undefined;
    const c = data.current;
    ui.setSubtitle(`${place.label} · ${c.label}`);

    clear(dial).append(
      el(
        'div',
        { class: `aqi-badge aqi-${c.class}` },
        el('span', { class: 'aqi-number', text: c.aqi == null ? '—' : String(c.aqi) }),
        el('span', { class: 'aqi-scale', text: 'US AQI' }),
      ),
      el(
        'div',
        { class: 'aqi-copy' },
        el('b', { class: `aqi-label aqi-text-${c.class}`, text: c.label }),
        el('p', { text: c.advice || '' }),
        c.dominant ? el('span', { class: 'fine-print', text: `Driven by ${c.dominant}` }) : null,
      ),
    );

    clear(stats).append(
      statTile('PM2.5', fmt(c.pm25, 'µg/m³')),
      statTile('PM10', fmt(c.pm10, 'µg/m³')),
      statTile('Ozone', fmt(c.ozone, 'µg/m³')),
      statTile('NO₂', fmt(c.no2, 'µg/m³')),
    );

    const now = Date.now();
    const window24 = data.hourly.filter((h) => {
      const t = h.epoch * 1000;
      return t >= now - 2 * 3600e3 && t <= now + 24 * 3600e3;
    });

    chart.setData([
      {
        key: 'pm',
        label: 'PM2.5',
        color: 'var(--gust)',
        axis: 'right',
        dashed: true,
        points: window24.map((h) => ({ x: h.epoch * 1000, y: h.pm25 })),
        format: (v) => `${v.toFixed(1)} µg/m³`,
      },
      {
        key: 'aqi',
        label: 'US AQI',
        color: 'var(--air)',
        fill: 'rgba(167,139,250,.28)',
        points: window24.map((h) => ({ x: h.epoch * 1000, y: h.aqi })),
        format: (v) => String(Math.round(v)),
      },
    ], { markers: [{ x: now, label: 'now' }] });

    clear(advisories);
    const rows = [];

    for (const a of data.alerts) {
      rows.push(
        el(
          'div',
          { class: 'aq-row alert-row' },
          el('span', { class: 'aq-tag official', text: 'Official' }),
          el(
            'div',
            {},
            el('b', { text: a.event }),
            el('p', { text: a.headline || a.areaDesc }),
            el('span', {
              class: 'fine-print',
              text:
                (a.distanceMiles ? `${a.distanceMiles} mi away` : 'in effect for your area') +
                (a.expires ? ` · until ${clock(a.expires)}` : ''),
            }),
          ),
        ),
      );
    }

    for (const h of data.hotspots) {
      rows.push(
        el(
          'div',
          { class: 'aq-row' },
          el('span', { class: `aq-tag aqi-${h.class}`, text: String(h.aqi) }),
          el(
            'div',
            {},
            el('b', { text: h.label }),
            el('span', { class: 'fine-print', text: `${h.distanceMiles} mi away · ${h.lat.toFixed(2)}, ${h.lon.toFixed(2)}` }),
          ),
        ),
      );
    }

    if (!rows.length) {
      mount(advisories,
        el('p', {
          class: 'empty',
          text: `No air quality advisories and no worse readings within ${data.radiusMiles} miles${data.areaWorst ? ` (highest nearby is ${data.areaWorst.aqi}).` : '.'}`,
        }),
      );
    } else {
      mount(advisories, rows);
    }
    advisories.append(el('p', { class: 'fine-print', text: data.source }));
  }

  function fmt(v, unit) {
    return v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} <small>${unit}</small>`;
  }

  return ui.card;
}
