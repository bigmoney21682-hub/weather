// Ocean quality at the nearest beach: a swim rating built from real-time
// gauges and recent rainfall, with every deduction shown so the number is
// arguable rather than magic.

import { api, el, clear, mount, f, clock } from '../util.js';
import { createSection, bindLocation, statTile } from '../section.js';
import { TimeChart } from '../chart.js';
import { compass, windArrow } from '../icons.js';

// Gauges are sorted into salt water and the fresh water running into it by
// their own conductance reading — see lib/oceanquality.js.
const KIND_LABEL = {
  coastal: 'salt water',
  inflow: 'inflow',
  unknown: 'unclassified',
};

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M2 17c2.4 0 2.4-2 4.8-2s2.4 2 4.8 2 2.4-2 4.8-2 2.4 2 4.8 2" stroke="var(--ocean)" stroke-width="2" stroke-linecap="round"/><path d="M2 21c2.4 0 2.4-2 4.8-2s2.4 2 4.8 2 2.4-2 4.8-2 2.4 2 4.8 2" stroke="var(--ocean)" stroke-width="2" stroke-linecap="round" opacity=".5"/><circle cx="12" cy="7.5" r="4.2" stroke="var(--ocean)" stroke-width="1.8"/><path d="M9.6 7.5h4.8M12 5.1v4.8" stroke="var(--ocean)" stroke-width="1.5" stroke-linecap="round" opacity=".75"/></svg>`;

export function oceanSection() {
  const ui = createSection({
    id: 'ocean',
    title: 'Ocean Quality',
    subtitle: 'Is the water worth getting into today?',
    icon: ICON,
  });

  const dial = el('div', { class: 'oq-dial' });
  const stats = el('div', { class: 'stat-row' });
  const factors = el('div', { class: 'oq-factors' });
  const canvas = el('canvas', { class: 'chart-canvas' });
  const holder = el('div', { class: 'chart-holder chart-short' }, canvas);
  const legend = el(
    'div',
    { class: 'chart-legend' },
    el('span', { class: 'key' }, el('i', { style: 'background:var(--ocean)' }), 'Sea surface temp (°F)'),
    el('span', { class: 'key' }, el('i', { style: 'background:var(--surf)' }), 'Wave height (ft)'),
    el('span', { class: 'hint', text: 'Pinch or scroll to zoom' }),
  );
  const chartHead = el('h4', { class: 'sub-head', text: 'Water temperature ahead' });
  const factorHead = el('h4', { class: 'sub-head', text: 'What went into that' });
  const gauges = el('div', { class: 'oq-gauges' });
  const gaugeHead = el('h4', { class: 'sub-head', text: 'Monitoring nearby' });
  const notes = el('div', { class: 'oq-notes' });

  clear(ui.body).append(
    dial,
    stats,
    factorHead,
    factors,
    chartHead,
    holder,
    legend,
    gaugeHead,
    gauges,
    notes,
  );

  // Axis labels follow the beach's clock, not the viewer's.
  let tz;

  const chart = new TimeChart(canvas, {
    height: 180,
    formatY: (v) => `${Math.round(v)}°`,
    formatY2: (v) => v.toFixed(1),
    formatX: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }).replace(',', ''),
    formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }),
  });

  bindLocation(
    ui,
    async (place) => {
      const data = await api('/api/ocean', { lat: place.lat, lon: place.lon, miles: 60 });
      render(data, place);
    },
    { placeholder: 'Set a location above to see ocean conditions.' },
  );

  function render(data, place) {
    tz = data.timezone || undefined;
    const r = data.rating;
    const c = data.current;

    ui.setSubtitle(
      data.spot
        ? `${data.spot.name} · ${f.miles(data.spot.distanceMiles)} from ${place.label}`
        : `${place.label} · nearest modelled water`,
    );

    const rated = r.score != null;
    clear(dial).append(
      el(
        'div',
        { class: `oq-badge oq-${r.class}` },
        el('span', { class: 'oq-number', text: rated ? String(r.score) : '—' }),
        el('span', { class: 'oq-scale', text: rated ? '/ 100' : 'no data' }),
      ),
      el(
        'div',
        { class: 'oq-copy' },
        el('b', { class: `oq-label oq-text-${r.class}`, text: r.label }),
        el('p', { text: r.advice || '' }),
        rated
          ? el('span', { class: 'fine-print', text: 'Swim rating — conditions and runoff, not a bacteria count.' })
          : null,
      ),
    );

    clear(stats).append(
      statTile('Water temp', f.tempF(c.waterTempF), c.waterTempSource),
      statTile('Rain, 24 h', `${data.rain.last24.toFixed(2)}"`, `${data.rain.last72.toFixed(2)}" over three days`),
      statTile('Clarity', turbidityLabel(c.turbidity),
        c.turbidity ? `${c.turbidity.value.toFixed(1)} FNU · ${c.turbidity.distanceMiles} mi` : 'no gauge nearby'),
      statTile('Current', c.currentMph == null ? '—' : `${c.currentMph.toFixed(1)} <small>mph</small>`,
        c.currentDirDeg != null ? `${windArrow(c.currentDirDeg + 180)} toward ${compass(c.currentDirDeg)}` : null),
    );

    // A second row only when the gauges gave us something to put in it. Tiles
    // name the gauge briefly; the full name is in the monitoring list below.
    const from = (r) => `${shorten(r.site)} · ${r.distanceMiles} mi`;
    const extras = [
      c.dissolvedOxygen && statTile('Dissolved O₂', `${c.dissolvedOxygen.value.toFixed(1)} <small>mg/L</small>`,
        from(c.dissolvedOxygen)),
      c.ph && statTile('pH', c.ph.value.toFixed(1), from(c.ph)),
      c.salinityPsu != null && statTile('Salinity', `${c.salinityPsu.toFixed(1)} <small>PSU</small>`, data.tideStation?.name),
      c.conductance && statTile('Conductance', `${Math.round(c.conductance.value)} <small>µS/cm</small>`,
        from(c.conductance)),
    ].filter(Boolean);
    if (extras.length) mount(stats, extras);

    // Nothing was scored, so there is no working-out to show.
    factorHead.classList.toggle('hidden', !r.factors.length);
    clear(factors);
    mount(factors,
      r.factors.map((x) =>
        el(
          'div',
          { class: `oq-factor sev-${x.severity}` },
          el('span', { class: 'oq-factor-mark', text: x.points ? `−${x.points}` : '✓' }),
          el('div', {}, el('b', { text: x.title }), el('p', { text: x.detail })),
        ),
      ),
    );

    // Official advisories carry more weight than anything modelled, so they get
    // their own block rather than being buried in the deduction list.
    clear(notes);
    if (data.alerts.length) {
      mount(notes,
        data.alerts.map((a) =>
          el(
            'div',
            { class: 'oq-alert' },
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
        ),
      );
    }
    notes.append(
      el('p', { class: 'fine-print oq-disclaimer', text: data.disclaimer }),
      el('p', { class: 'fine-print', text: data.source }),
    );

    clear(gauges);
    if (!data.stations.length) {
      gauges.append(
        el('p', {
          class: 'empty',
          text: `No real-time water quality gauge is reporting within ${data.radiusMiles} miles, so this rating leans on rainfall, the marine model and any official advisories.`,
        }),
      );
    } else {
      mount(gauges,
        data.stations.map((s) =>
          el(
            'div',
            { class: `oq-gauge kind-${s.kind}` },
            el(
              'div',
              { class: 'oq-gauge-head' },
              el('b', { text: s.name }),
              el('span', { class: `oq-gauge-kind kind-${s.kind}`, text: KIND_LABEL[s.kind] }),
              el('span', { class: 'oq-gauge-dist', text: `${s.distanceMiles} mi` }),
            ),
            el(
              'div',
              { class: 'oq-gauge-readings' },
              Object.values(s.readings).map((v) =>
                el(
                  'span',
                  { class: 'oq-reading' },
                  el('i', { text: v.label }),
                  `${formatReading(v)}${v.unit ? ` ${v.unit}` : ''}`,
                ),
              ),
            ),
            el('span', {
              class: 'fine-print',
              text: `USGS ${s.id} · last reading ${clock(Object.values(s.readings)[0].time)}`,
            }),
          ),
        ),
      );
      gauges.append(
        el('p', {
          class: 'fine-print',
          text: `Only salt-water gauges within ${data.scoringRadiusMiles} miles feed the rating. Freshwater inflows are listed because they tell you what is heading for the beach, not because they measure it.`,
        }),
      );
    }

    // No modelled water means no temperature curve worth drawing.
    const showChart = data.water;
    for (const node of [chartHead, holder, legend]) node.classList.toggle('hidden', !showChart);
    if (showChart) {
      chart.setData(
        [
          {
            key: 'wave',
            label: 'Wave height',
            color: 'var(--surf)',
            axis: 'right',
            dashed: true,
            points: data.hourly.map((h) => ({ x: h.epoch * 1000, y: h.waveFt })),
            format: (v) => `${v.toFixed(1)} ft`,
          },
          {
            key: 'temp',
            label: 'Water temp',
            color: 'var(--ocean)',
            fill: 'rgba(56,189,248,.26)',
            points: data.hourly.map((h) => ({ x: h.epoch * 1000, y: h.waterTempF })),
            format: (v) => `${Math.round(v)}°F`,
          },
        ],
        { markers: [{ x: Date.now(), label: 'now' }] },
      );
    }
  }

  /** Gauge names run long; a stat tile has room for about this much. */
  function shorten(name, max = 26) {
    return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
  }

  function formatReading(v) {
    const n = v.value;
    return Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1);
  }

  function turbidityLabel(t) {
    if (!t) return '—';
    if (t.value < 5) return 'Clear';
    if (t.value < 10) return 'Slightly murky';
    if (t.value < 25) return 'Murky';
    return 'Very murky';
  }

  return ui.card;
}
