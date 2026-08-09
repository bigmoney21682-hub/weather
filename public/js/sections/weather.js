// Hourly forecast for the rest of today (plus the coming night), with the
// current conditions pinned above it.

import { api, el, clear, f, hour, clock, dayName } from '../util.js';
import { createSection, bindLocation, statTile } from '../section.js';
import { weatherIcon, windArrow, compass } from '../icons.js';
import { searchLocation } from '../store.js';

export function weatherSection() {
  const input = el('input', {
    type: 'search',
    class: 'mini-input',
    placeholder: 'ZIP, city, town or county',
    'aria-label': 'Look up weather for another location',
    autocomplete: 'off',
  });
  const go = el('button', { class: 'mini-btn', type: 'submit', text: 'Go' });
  const form = el('form', { class: 'mini-form' }, input, go);

  const ui = createSection({
    id: 'weather',
    title: 'Weather',
    subtitle: 'Hourly forecast',
    icon: weatherIcon('partly-cloudy'),
    tools: form,
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    go.disabled = true;
    go.textContent = '…';
    try {
      // Sets the shared location, so every section below follows along.
      await searchLocation(q);
      input.value = '';
    } catch (err) {
      ui.error(err.message);
    } finally {
      go.disabled = false;
      go.textContent = 'Go';
    }
  });

  bindLocation(ui, async (place) => {
    const data = await api('/api/weather', { lat: place.lat, lon: place.lon });
    render(ui, data, place);
  });

  return ui.card;
}

function render(ui, data, place) {
  const tz = data.timezone;
  const c = data.current;
  ui.setSubtitle(`${place.label} · ${tz.replace(/_/g, ' ')}`);

  const now = Date.now();
  const upcoming = data.hours.filter((h) => h.epoch * 1000 >= now - 3600e3).slice(0, 24);
  const today = data.days[0];

  clear(ui.body).append(
    el(
      'div',
      { class: 'now' },
      el('div', { class: 'now-icon', html: weatherIcon(c.icon, c.isDay) }),
      el(
        'div',
        { class: 'now-main' },
        el('div', { class: 'now-temp', text: f.temp(c.tempF) }),
        el('div', { class: 'now-label', text: c.label }),
        el('div', {
          class: 'now-sub',
          text: `Feels ${f.temp(c.feelsF)} · High ${f.temp(today.highF)} · Low ${f.temp(today.lowF)}`,
        }),
      ),
      el(
        'div',
        { class: 'now-stats' },
        statTile('Wind', `${windArrow(c.windDir)} ${f.mph(c.windMph)}`, `${compass(c.windDir)} · gusts ${f.mph(c.gustMph)}`),
        statTile('Humidity', f.pct(c.humidity)),
        statTile('Pressure', c.pressureMb == null ? '—' : `${Math.round(c.pressureMb)} mb`),
        statTile('Sun', clock(today.sunrise, tz), `sets ${clock(today.sunset, tz)}`),
      ),
    ),
    el('div', { class: 'hourly-scroll-hint', text: 'Swipe for the next 24 hours →' }),
    el(
      'div',
      { class: 'hourly' },
      upcoming.map((h, i) => {
        const t = new Date(h.epoch * 1000);
        return el(
          'div',
          { class: `hour-cell${i === 0 ? ' is-now' : ''}` },
          el('span', { class: 'hour-time', text: i === 0 ? 'Now' : hour(t, tz) }),
          el('span', { class: 'hour-icon', html: weatherIcon(h.icon, h.isDay) }),
          el('span', { class: 'hour-temp', text: f.temp(h.tempF) }),
          el(
            'span',
            { class: `hour-precip${h.precipChance >= 30 ? ' wet' : ''}` },
            h.precipChance == null ? '—' : `${Math.round(h.precipChance)}%`,
          ),
          el('span', { class: 'hour-wind', html: `${windArrow(h.windDir, 13)} ${Math.round(h.windMph)}` }),
          el('span', { class: 'hour-desc', text: h.label }),
        );
      }),
    ),
    el(
      'div',
      { class: 'day-strip' },
      data.days.slice(0, 4).map((d, i) =>
        el(
          'div',
          { class: 'day-cell' },
          el('span', { class: 'day-name', text: i === 0 ? 'Today' : dayName(`${d.date}T12:00`, tz) }),
          el('span', { class: 'day-icon', html: weatherIcon(d.icon, true) }),
          el('span', { class: 'day-temps', html: `<b>${f.temp(d.highF)}</b> <i>${f.temp(d.lowF)}</i>` }),
        ),
      ),
    ),
  );
}
