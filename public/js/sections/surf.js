// Surf: wave height, water temperature, the tide table, and which beach
// up or down the coast has the biggest swell on it right now.

import { api, el, clear, mount, f, clock } from '../util.js';
import { createSection, statTile } from '../section.js';
import { TimeChart } from '../chart.js';
import { expandableBox } from '../expand.js';
import { compass, windArrow } from '../icons.js';
import {
  onLocation,
  getLocation,
  onSavedSpots,
  saveSpot,
  removeSpot,
  setDefaultSpot,
  getDefaultSpot,
  placeId,
} from '../store.js';

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
  const savedBox = el('div', { class: 'place-pills surf-saved' });
  const reportBox = el('div', { class: 'surf-report' });
  const forecastBox = el('div', { class: 'surf-report' });

  clear(ui.body).append(
    savedBox,
    // Tides sit right under the saved spots: when the tide turns is the first
    // thing asked of a beach, before the swell numbers.
    tideHead,
    tideBox,
    stats,
    // The swell numbers drawn out over the next few days, ahead of the words.
    el('h4', { class: 'sub-head', text: 'Wave height forecast' }),
    expandableBox(
      holder,
      el(
        'div',
        { class: 'chart-legend' },
        el('span', { class: 'key' }, el('i', { style: 'background:var(--surf)' }), `Surfable (${SURFABLE_FT}ft+)`),
        el('span', { class: 'key' }, el('i', { style: 'background:var(--surf-flat)' }), `Too small (under ${SURFABLE_FT}ft)`),
        el('span', { class: 'hint', text: 'Pinch or scroll to zoom' }),
      ),
    ),
    // The chart said in words: right now, the days ahead, then the forecaster's own.
    reportBox,
    forecastBox,
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
  // A spot chosen from the biggest-wave callout, or a saved pill on its break.
  let selected = null;
  let place = null;
  let token = 0;
  // Set by a deliberate pick, so the spot that pick lands on becomes a pill.
  // Browsing to the nearest beach on a location change is not a pick.
  let saveNext = false;
  // The spot currently on the card, as a saved-pill id, for the highlight.
  let showingId = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    go.disabled = true;
    go.textContent = '…';
    try {
      override = await api('/api/geocode', { q });
      selected = null;
      saveNext = true;
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
    saveNext = true;
    if (place) load(place);
  }

  /** Open a saved pill: its own coast, wherever the page location is. */
  function openSaved(p) {
    override = { lat: p.lat, lon: p.lon, label: p.label, snap: p.snap, saved: true };
    selected = p.snap ? { lat: p.lat, lon: p.lon } : null;
    load(override);
  }

  // Saved spots, the same pills as the saved places at the top of the page:
  // the name opens it, the star makes the surf card open on it, ✕ forgets it.
  let savedList = [];
  function renderSaved() {
    clear(savedBox);
    if (!savedList.length) return;
    mount(savedBox,
      el('span', { class: 'fine-print', text: 'Saved spots:' }),
      savedList.map((p) =>
        el(
          'div',
          { class: `place-pill${p.id === showingId ? ' active' : ''}` },
          el('button', {
            class: `place-star${p.isDefault ? ' is-default' : ''}`,
            type: 'button',
            title: p.isDefault ? 'The surf card opens here — tap to stop' : 'Open the surf card on this spot',
            'aria-label': p.isDefault ? `${p.label} is the default surf spot` : `Make ${p.label} the default surf spot`,
            'aria-pressed': String(Boolean(p.isDefault)),
            text: p.isDefault ? '★' : '☆',
            onClick() {
              setDefaultSpot(p.id);
            },
          }),
          el('button', {
            class: 'place-pick',
            type: 'button',
            text: p.label,
            title: `Surf report for ${p.label}`,
            onClick() {
              openSaved(p);
            },
          }),
          el('button', {
            class: 'place-del',
            type: 'button',
            title: `Forget ${p.label}`,
            'aria-label': `Forget ${p.label}`,
            text: '✕',
            onClick() {
              removeSpot(p.id);
            },
          }),
        ),
      ),
    );
  }
  onSavedSpots((list) => {
    savedList = list;
    renderSaved();
  });

  async function load(next) {
    place = next;
    const mine = ++token;
    ui.loading('Reading the buoys…');
    try {
      // An explicitly searched spot is taken at its word; otherwise the server
      // snaps to the nearest named beach on the open ocean. A saved spot that was
      // picked off the coast snaps back onto the same break.
      const data = await api('/api/surf', {
        lat: place.lat,
        lon: place.lon,
        miles: 30,
        snap: override && !override.snap ? '0' : '1',
        ...(selected ? { atLat: selected.lat, atLon: selected.lon } : {}),
      });
      if (mine !== token) return;
      const shown = data.spot
        ? { lat: data.spot.lat, lon: data.spot.lon, label: data.spot.name, snap: true }
        : { lat: place.lat, lon: place.lon, label: place.label, snap: false };
      if (saveNext) saveSpot(shown);
      saveNext = false;
      showingId = placeId(shown);
      renderSaved();
      render(data);
      ui.ready();
      if (data.note) ui.note(data.note);
    } catch (err) {
      if (mine === token) ui.error(err.message, () => load(place));
    }
  }

  function render(data) {
    tz = data.timezone || undefined;
    // The card reports on a beach, not on the town in the location bar.
    const beach = data.spot
      ? `${data.spot.name} · ${f.miles(data.spot.distanceMiles)} from ${place.label}`
      : `Open water near ${place.label} — no named beach found`;
    ui.setSubtitle(
      override?.snap && data.spot
        ? `${data.spot.name}${override.saved ? ' · saved spot' : ''}`
        : override
          ? `${place.label} (spot override)`
          : beach,
    );

    // Everything below that needs to point at somewhere named falls back to the
    // location bar when the beach lookup came up empty.
    const spotName = data.spot?.name || place.label;

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

    renderReport(data);

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

  /**
   * The written report above the chart; the day-by-day forecast and the local
   * NWS office's surf forecast below it.
   */
  function renderReport(data) {
    clear(reportBox);
    clear(forecastBox);
    const r = data.report;
    const z = data.zoneForecast;
    if (!r && !z) return;

    if (r) {
      mount(reportBox,
        el('h4', { class: 'sub-head' }, 'Surf report', r.rating ? ratingBadge(r.rating) : null),
        el('p', { class: 'report-now' }, el('b', { text: 'Right now: ' }), r.now),
        r.later ? el('p', { class: 'report-now', text: r.later }) : null,
        r.hasWind ? null : el('p', { class: 'fine-print', text: 'No wind forecast reached this spot, so the surface conditions are left out.' }),
      );
      if (r.days.length) {
        mount(forecastBox,
          el('h4', { class: 'sub-head', text: 'Surf forecast' }),
          el(
            'div',
            { class: 'report-days' },
            r.days.map((d) =>
              el(
                'div',
                { class: 'report-day' },
                el('div', { class: 'report-day-head' }, el('b', { text: d.label }), d.rating ? ratingBadge(d.rating) : null),
                el('p', { text: d.text }),
              ),
            ),
          ),
          el('p', {
            class: 'fine-print',
            text: 'Written from the marine model’s waves and the forecast wind at this beach, read against the way the beach faces.',
          }),
        );
      }
    }

    if (z) {
      const box = el('div', { class: 'nws-surf' });
      mount(box,el('h4', { class: 'sub-head', text: `NWS surf zone forecast · ${z.area}` }));
      if (z.headlines.length) {
        mount(box,el('div', { class: 'nws-headlines' }, z.headlines.map((h) => el('span', { class: 'nws-headline', text: sentenceCase(h) }))));
      }
      if (z.shoreTable) {
        mount(box,
          el('p', {}, el('b', { text: `Surf on ${z.shoreTable.facing.toLowerCase()}: ` }), z.shoreTable.surf.map((s) => `${s.feet} ft ${s.when}`).join(', ') + '.'),
        );
      }
      for (const p of z.periods) {
        mount(box,el('p', {}, el('b', { text: `${p.name}: ` }), p.prose || p.fields.map(fieldSentence).join(' ')));
      }
      if (z.discussion) {
        mount(box,el('details', { class: 'nws-discussion' }, el('summary', { text: 'Forecaster’s discussion' }), el('p', { text: z.discussion })));
      }
      mount(box,
        el(
          'p',
          { class: 'fine-print' },
          `Written by forecasters at the National Weather Service, ${z.office} — issued ${new Date(z.issued).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz })}. `,
          el('a', { href: z.link, target: '_blank', rel: 'noopener noreferrer', text: 'Full text' }),
        ),
      );
      mount(forecastBox,box);
    }
  }

  // A default spot opens the card on it, ahead of whatever is nearest home.
  const preferredSpot = getDefaultSpot();
  if (preferredSpot) openSaved(preferredSpot);

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

const RATING_CLASS = { Flat: 'flat', Poor: 'poor', 'Poor to fair': 'poor', Fair: 'fair', 'Fair to good': 'good', Good: 'good', 'Very good': 'great' };

function ratingBadge(rating) {
  return el('span', { class: `surf-rating ${RATING_CLASS[rating] || 'fair'}`, text: rating });
}

/** NWS headlines arrive in capitals; read them at a normal volume. */
function sentenceCase(text) {
  const lower = text.toLowerCase().replace(/\b(edt|est|cdt|cst|mdt|mst|pdt|pst|hst|akdt|akst|nws)\b/g, (m) => m.toUpperCase())
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, (m) => m.charAt(0).toUpperCase() + m.slice(1));
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function fieldSentence({ label, value }) {
  const v = value.replace(/\.$/, '');
  const low = v.charAt(0).toLowerCase() + v.slice(1);
  switch (label) {
    case 'Surf Height':
    case 'Surf':
      return `Surf ${low}.`;
    case 'Rip Current Risk':
      return `Rip current risk ${low}.`;
    case 'Water Temperature':
      return `Water ${/^\d/.test(v) ? v : low}.`;
    default:
      return `${v}.`;
  }
}
