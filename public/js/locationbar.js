// The sticky location bar at the top of the page. Every section reads from it.

import { el, clear, mount } from './util.js';
import {
  getLocation,
  onLocation,
  searchLocation,
  useDeviceLocation,
  clearLocation,
  setLocation,
  savePlace,
  removePlace,
  setDefaultPlace,
  onSavedPlaces,
  placeId,
} from './store.js';

export function locationBar() {
  const input = el('input', {
    type: 'search',
    class: 'loc-input',
    placeholder: 'ZIP code, city, town or county',
    'aria-label': 'Location by ZIP code, city, town or county',
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Search' });
  const gps = el(
    'button',
    { class: 'btn', type: 'button', title: 'Use this device’s location' },
    el('span', { class: 'gps-dot', 'aria-hidden': 'true' }),
    'Use my location',
  );
  const current = el('div', { class: 'loc-current' });
  const message = el('p', { class: 'loc-message', role: 'status' });

  const form = el('form', { class: 'loc-form' }, input, submit, gps);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    setBusy(submit, true, 'Searching…');
    message.className = 'loc-message';
    message.textContent = '';
    try {
      await searchLocation(q);
      input.value = '';
      input.blur();
    } catch (err) {
      message.className = 'loc-message error';
      message.textContent = err.message;
    } finally {
      setBusy(submit, false, 'Search');
    }
  });

  gps.addEventListener('click', async () => {
    setBusy(gps, true, 'Locating…');
    message.className = 'loc-message';
    message.textContent = '';
    try {
      await useDeviceLocation();
    } catch (err) {
      message.className = 'loc-message error';
      message.textContent = err.message;
    } finally {
      gps.disabled = false;
      clear(gps).append(el('span', { class: 'gps-dot', 'aria-hidden': 'true' }), 'Use my location');
    }
  });

  onLocation((place) => {
    clear(current);
    if (!place) {
      current.append(el('span', { class: 'loc-empty', text: 'No location set yet — search above or tap “Use my location”.' }));
      return;
    }
    current.append(
      el('span', { class: 'loc-pin', html: PIN }),
      el(
        'div',
        { class: 'loc-text' },
        el('b', { text: place.label }),
        el('span', {
          class: 'loc-coords',
          text:
            `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}` +
            (place.source ? ` · ${place.source}` : '') +
            (place.accuracyM ? ` · ±${place.accuracyM} m` : ''),
        }),
      ),
      el('button', {
        class: 'loc-clear',
        type: 'button',
        title: 'Forget this location',
        'aria-label': 'Forget this location',
        text: '✕',
        onClick() {
          clearLocation();
          input.focus();
        },
      }),
    );
  });

  // Saved places. Tap the name to switch to one, the star to make it the place
  // this page opens on, the ✕ to forget it.
  const places = el('div', { class: 'place-pills' });

  onSavedPlaces((list) => {
    clear(places);
    if (!list.length) return;
    const active = getLocation();
    mount(places,
      el('span', { class: 'fine-print', text: 'Saved:' }),
      list.map((p) =>
        el(
          'div',
          { class: `place-pill${active && p.id === placeId(active) ? ' active' : ''}` },
          el('button', {
            class: `place-star${p.isDefault ? ' is-default' : ''}`,
            type: 'button',
            title: p.isDefault ? 'Opens here by default' : 'Make this the default location',
            'aria-label': p.isDefault ? `${p.label} is the default location` : `Make ${p.label} the default location`,
            'aria-pressed': String(Boolean(p.isDefault)),
            text: p.isDefault ? '★' : '☆',
            onClick() {
              setDefaultPlace(p.id);
            },
          }),
          el('button', {
            class: 'place-pick',
            type: 'button',
            text: p.label,
            title: `Show weather for ${p.label}`,
            onClick() {
              setLocation({ lat: p.lat, lon: p.lon, label: p.label, source: p.source || 'saved place' });
            },
          }),
          el('button', {
            class: 'place-del',
            type: 'button',
            title: `Forget ${p.label}`,
            'aria-label': `Forget ${p.label}`,
            text: '✕',
            onClick() {
              removePlace(p.id);
            },
          }),
        ),
      ),
    );
  });

  // Anywhere the user actually lands becomes a pill, so the list builds itself.
  onLocation((place) => {
    if (place) savePlace(place);
  });

  const alternatives = el('div', { class: 'loc-alts' });
  onLocation((place) => {
    clear(alternatives);
    if (!place?.alternatives?.length) return;
    mount(alternatives,
      el('span', { class: 'fine-print', text: 'Did you mean:' }),
      place.alternatives.slice(0, 4).map((alt) =>
        el('button', {
          class: 'chip',
          type: 'button',
          text: alt.label,
          onClick() {
            searchLocation(alt.label).catch(() => {});
          },
        }),
      ),
    );
  });

  return el(
    'div',
    { class: 'loc-bar' },
    form,
    places,
    current,
    alternatives,
    message,
    el(
      'p',
      { class: 'privacy-note' },
      el('span', { class: 'lock', html: LOCK }),
      el('span', {
        html:
          '<b>All of your data is 100% private.</b> Your location is stored only in this browser and is never sold, shared, ' +
          'or tied to an identity. There are no accounts, no cookies, no trackers, and no analytics. ' +
          'Forecast providers only ever see a bare coordinate, with nothing attached to it.',
      }),
    ),
  );
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = busy ? label : label;
}

const PIN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 22s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="11" r="2.6" fill="currentColor"/></svg>`;
const LOCK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V8a4 4 0 1 1 8 0v2.5" stroke="currentColor" stroke-width="1.7"/></svg>`;

export { getLocation };
