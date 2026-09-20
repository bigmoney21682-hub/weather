// Surf: wave height, water temperature, the tide table, and which beach
// up or down the coast has the biggest swell on it right now.

import { api, el, clear, f, clock } from '../util.js';
import { createSection, statTile } from '../section.js';
import { TimeChart } from '../chart.js';
import { compass, windArrow } from '../icons.js';
import { onLocation, getLocation } from '../store.js';

// Above this the waves are worth paddling out for; below it the chart says so
// by draining the colour out of the line.
const SURFABLE_FT = 2.5;

// Local noon, in the beach's own timezone, of the day an instant falls in.
// Read the wall clock there, ask for noon on that date, and convert back —
// twice, because the offset at noon can differ from the offset at `ms` on the
// mornings the clocks change.
function tzOffset(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(ms)
    .reduce((o, part) => ((o[part.type] = part.value), o), {});
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  // Zone offsets are whole minutes; rounding drops the milliseconds `ms` carries
  // so that noon comes back as noon exactly, and today's rule compares equal.
  return Math.round((wall - ms) / 6e4) * 6e4;
}

function localNoon(ms, tz) {
  const local = new Date(ms + tzOffset(ms, tz));
  const midday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12);
  return midday - tzOffset(midday - tzOffset(ms, tz), tz);
}

/** Noon of every day the visible window touches, labelled for the axis. */
function noonTicks(fromMs, toMs, tz) {
  const out = [];
  const today = localNoon(Date.now(), tz);
  for (let t = localNoon(fromMs, tz); t <= toMs; t = localNoon(t + 30 * 36e5, tz)) {
    if (t < fromMs) continue;
    const day = t === today ? 'Today' : new Date(t).toLocaleDateString([], { weekday: 'short', timeZone: tz });
    out.push({ x: t, label: `${day} 12pm`, strong: true });
    if (out.length > 30) break;
  }
  return out;
}

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
  const pillBox = el('div', { class: 'spot-pills' });

  clear(ui.body).append(
    pillBox,
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
      el('span', { class: 'key' }, el('i', { style: 'background:var(--surf)' }), `Surfable (${SURFABLE_FT}ft+)`),
      el('span', { class: 'key' }, el('i', { style: 'background:var(--surf-flat)' }), `Too small (under ${SURFABLE_FT}ft)`),
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
    formatX: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }).replace(',', ''),
    formatTooltipTitle: (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz }),
    // One labelled rule per day at noon. Zoomed inside a day no noon is in
    // view, and the chart falls back to its own hour grid.
    xTicks: (from, to) => (tz ? noonTicks(from, to, tz) : null),
    guides: [{ y: SURFABLE_FT, color: 'var(--surf)', label: `${SURFABLE_FT}` }],
    // Keep the surfable line on the chart even on a flat week, so a low line
    // reads as "well under it" rather than as an unexplained grey.
    includeY: [SURFABLE_FT],
  });

  // A spot searched here overrides the page location for this section only,
  // until "Use my location" puts it back in sync.
  let override = null;
  // A spot chosen from the pills. It moves which beach is reported on, but not
  // which beaches are offered — the row is anchored on the one nearest home.
  let selected = null;
  let place = null;
  let token = 0;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    go.disabled = true;
    go.textContent = '…';
    try {
      override = await api('/api/geocode', { q });
      selected = null;
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
    selected = null;
    const home = getLocation();
    if (home) load(home);
  });

  function selectSpot(spot) {
    selected = { lat: spot.lat, lon: spot.lon };
    if (place) load(place);
  }

  async function load(next) {
    place = next;
    const mine = ++token;
    ui.loading('Reading the buoys…');
    try {
      // An explicitly searched spot is taken at its word; otherwise the server
      // snaps to the nearest named beach on the open ocean.
      const data = await api('/api/surf', {
        lat: place.lat,
        lon: place.lon,
        miles: 30,
        snap: override ? '0' : '1',
        ...(selected ? { atLat: selected.lat, atLon: selected.lon } : {}),
      });
      if (mine !== token) return;
      render(data);
      ui.ready();
      if (data.note) ui.note(data.note);
    } catch (err) {
      if (mine === token) ui.error(err.message, () => load(place));
    }
  }

  /**
   * The spots up and down the coast, in the order you would drive them.
   *
   * They run in one row from one end of the coast to the other rather than in
   * two lists either side of "here", because that is how a surfer already holds
   * the coast in their head — and the labelled ends say which way is which.
   */
  function renderPills(data) {
    clear(pillBox);
    if (!data.nearby?.length) return;

    const ends = data.shoreEnds || { forward: 'North', back: 'South' };
    pillBox.append(el('span', { class: 'spot-end', text: `↓ ${ends.back}` }));
    for (const spot of data.nearby) {
      const pill = el('button', {
        class: `chip${spot.selected ? ' active' : ''}`,
        type: 'button',
        title: `Surf report for ${spot.name} — ${f.miles(spot.distanceMiles)} from ${place.label}`,
        'aria-pressed': spot.selected ? 'true' : 'false',
      });
      pill.append(
        el('span', { class: 'pill-name', text: spot.name }),
        el('span', { class: 'pill-dist', text: f.miles(spot.distanceMiles) }),
      );
      pill.addEventListener('click', () => selectSpot(spot));
      pillBox.append(pill);
    }
    pillBox.append(el('span', { class: 'spot-end', text: `${ends.forward} ↑` }));

    // Open on the spot you are actually at, however far along the row it sits.
    // Scrolling the strip by hand rather than with scrollIntoView, which would
    // also drag the page down to a card the reader may not have got to yet.
    const active = pillBox.querySelector('.chip.active');
    if (active) pillBox.scrollLeft = active.offsetLeft - (pillBox.clientWidth - active.offsetWidth) / 2;
  }

  function render(data) {
    tz = data.timezone || undefined;
    // The card reports on a beach, not on the town in the location bar.
    const beach = data.spot
      ? `${data.spot.name} · ${f.miles(data.spot.distanceMiles)} from ${place.label}`
      : `Open water near ${place.label} — no named beach found`;
    ui.setSubtitle(override ? `${place.label} (spot override)` : beach);

    // Everything below that needs to point at somewhere named falls back to the
    // location bar when the beach lookup came up empty.
    const spotName = data.spot?.name || place.label;

    renderPills(data);

    const c = data.current || {};
    clear(stats).append(
      statTile('Wave height', f.ft(c.waveFt)),
      // `dirDeg` is where the swell comes from; the arrow shows where it is
      // headed — the way it runs at the beach — which is what windArrow draws
      // from a "from" bearing unaided.
      statTile('Period', f.sec(c.periodS), c.dirDeg != null ? `${windArrow(c.dirDeg)} from ${compass(c.dirDeg)}` : null),
      statTile('Swell', f.ft(c.swellFt), c.swellPeriodS ? `${Math.round(c.swellPeriodS)} s` : null),
      statTile('Water temp', f.tempF(data.waterTempF), data.waterTempSource),
    );

    clear(biggestBox);
    if (data.biggest) {
      const b = data.biggest;
      const here = b.name === spotName;
      const jump = el('button', { class: 'chip', type: 'button', text: 'Show its forecast →' });
      jump.addEventListener('click', () => selectSpot(b));
      biggestBox.append(
        el(
          'div',
          { class: 'callout' },
          el('span', { class: 'callout-label', text: `Biggest wave within ${data.scanRadiusMiles} mi` }),
          el('span', { class: 'callout-value', text: f.ft(b.waveFt) }),
          el('span', { class: 'callout-city', text: `at ${b.name}` }),
          el('span', {
            class: 'callout-note',
            text:
              (here ? 'the spot you are looking at' : `${f.miles(b.distanceMiles)} from ${place.label}`) +
              (b.periodS ? ` · ${Math.round(b.periodS)} s period` : ''),
          }),
          here ? null : jump,
        ),
      );
    }

    chart.setData([
      {
        key: 'wave',
        label: 'Wave height',
        color: 'var(--surf)',
        split: {
          at: SURFABLE_FT,
          above: 'var(--surf)',
          below: 'var(--surf-flat)',
          fillAbove: 'rgba(93,225,201,.28)',
          fillBelow: 'rgba(111,127,150,.22)',
        },
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

  onLocation((home) => {
    if (override) return;
    // A spot picked off the old coast means nothing on the new one.
    selected = null;
    if (!home) {
      ui.empty('Set a location above to see surf conditions.');
      return;
    }
    load(home);
  });

  return ui.card;
}
