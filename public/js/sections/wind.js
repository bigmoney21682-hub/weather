// Wind: sustained speed and gusts for today and the next two days, plus the
// direction along the bottom. Pinch or scroll the graph to zoom in on a day.

import { api, el, clear, mount, f } from '../util.js';
import { createSection, bindLocation, statTile } from '../section.js';
import { TimeChart } from '../chart.js';
import { windIcon, windArrow, compass } from '../icons.js';

export function windSection() {
  const ui = createSection({
    id: 'wind',
    title: 'Wind',
    subtitle: 'Current and forecast, today plus two days',
    icon: windIcon(),
  });

  const canvas = el('canvas', { class: 'chart-canvas' });
  const holder = el('div', { class: 'chart-holder' }, canvas);
  const stats = el('div', { class: 'stat-row' });
  const dirRow = el('div', { class: 'dir-row' });

  clear(ui.body).append(
    stats,
    holder,
    dirRow,
    el(
      'div',
      { class: 'chart-legend' },
      el('span', { class: 'key' }, el('i', { style: 'background:var(--wind)' }), 'Sustained'),
      el('span', { class: 'key' }, el('i', { style: 'background:var(--gust)' }), 'Gusts'),
      el('span', { class: 'hint', text: 'Pinch, scroll or drag to zoom · double-tap to reset' }),
    ),
  );

  // Axis labels follow the location's clock, not the viewer's.
  let tz;

  const chart = new TimeChart(canvas, {
    height: 240,
    zeroBased: true,
    formatY: (v) => `${Math.round(v)}`,
    formatX: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }).replace(',', ''),
    formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }),
  });

  bindLocation(ui, async (place) => {
    const data = await api('/api/weather', { lat: place.lat, lon: place.lon });
    render(data, place);
  });

  function render(data, place) {
    tz = data.timezone;
    const c = data.current;
    ui.setSubtitle(`${place.label} · next 3 days`);

    clear(stats).append(
      statTile('Now', `${windArrow(c.windDir)} ${f.mph(c.windMph)}`, compass(c.windDir)),
      statTile('Gusting', f.mph(c.gustMph)),
      statTile('Peak (3 days)', f.mph(Math.max(...data.hours.map((h) => h.gustMph ?? 0)))),
      statTile(
        'Calmest hour',
        f.mph(Math.min(...data.hours.filter((h) => h.windMph != null).map((h) => h.windMph))),
      ),
    );

    const toPoint = (key) => data.hours.map((h) => ({ x: h.epoch * 1000, y: h[key] }));
    const now = Date.now();

    // Night shading, so a gusty afternoon is easy to pick out from an overnight lull.
    const bands = [];
    for (const d of data.days) {
      const sunset = new Date(d.sunset).getTime();
      const nextRise = data.days
        .map((x) => new Date(x.sunrise).getTime())
        .find((t) => t > sunset);
      if (sunset && nextRise) bands.push({ from: sunset, to: nextRise, color: 'rgba(90,110,180,.10)' });
    }

    chart.setData(
      [
        { key: 'gust', label: 'Gusts', color: 'var(--gust)', points: toPoint('gustMph'), dashed: true, format: (v) => `${Math.round(v)} mph` },
        { key: 'wind', label: 'Sustained', color: 'var(--wind)', points: toPoint('windMph'), fill: 'rgba(94,196,255,.28)', format: (v) => `${Math.round(v)} mph` },
      ],
      { markers: [{ x: now, label: 'now' }], bands },
    );

    // Direction ticks under the graph, one every three hours for the first day.
    mount(clear(dirRow),
      data.hours
        .filter((h) => h.epoch * 1000 >= now - 3600e3)
        .slice(0, 24)
        .filter((_, i) => i % 3 === 0)
        .map((h) =>
          el(
            'span',
            { class: 'dir-tick' },
            el('span', { class: 'dir-arrow', html: windArrow(h.windDir, 15) }),
            el('span', { class: 'dir-label', text: compass(h.windDir) }),
            el('span', {
              class: 'dir-time',
              text: new Date(h.epoch * 1000).toLocaleTimeString([], { hour: 'numeric', timeZone: data.timezone }).replace(' ', ''),
            }),
          ),
        ),
    );
  }

  return ui.card;
}
