// Card scaffolding: header, loading shimmer, error state, and a "reload when
// the location changes" wiring that every section shares.

import { el, clear } from './util.js';
import { onLocation } from './store.js';

export function createSection({ id, title, subtitle, icon, tools }) {
  const body = el('div', { class: 'card-body' });
  const status = el('div', { class: 'card-status', role: 'status' });
  const toolbar = el('div', { class: 'card-tools' });
  if (tools) toolbar.append(...[].concat(tools));

  const card = el(
    'section',
    { class: 'card', id },
    el(
      'header',
      { class: 'card-head' },
      el(
        'div',
        { class: 'card-title' },
        icon ? el('span', { class: 'card-icon', html: icon }) : null,
        el('div', {}, el('h2', { text: title }), subtitle ? el('p', { class: 'card-sub', text: subtitle }) : null),
      ),
      toolbar,
    ),
    status,
    body,
  );

  const ui = {
    card,
    body,
    toolbar,
    subtitleEl: card.querySelector('.card-sub'),
    setSubtitle(text) {
      if (!ui.subtitleEl) {
        ui.subtitleEl = el('p', { class: 'card-sub' });
        card.querySelector('.card-title > div').append(ui.subtitleEl);
      }
      ui.subtitleEl.textContent = text || '';
    },
    loading(message = 'Loading…') {
      status.className = 'card-status loading';
      status.textContent = message;
    },
    error(message) {
      status.className = 'card-status error';
      clear(status);
      status.append(el('span', { text: message }));
    },
    note(message) {
      status.className = 'card-status note';
      status.textContent = message;
    },
    ready() {
      status.className = 'card-status hidden';
      status.textContent = '';
    },
    empty(message) {
      clear(body).append(el('p', { class: 'empty', text: message }));
    },
  };
  return ui;
}

/**
 * Run `load(place, ui)` whenever the location changes, with consistent
 * loading/error handling and latest-wins ordering.
 */
export function bindLocation(ui, load, { placeholder = 'Set a location above to see this section.' } = {}) {
  let token = 0;
  onLocation(async (place) => {
    const mine = ++token;
    if (!place) {
      ui.ready();
      ui.empty(placeholder);
      return;
    }
    ui.loading();
    try {
      await load(place, ui, () => mine === token);
      if (mine === token) ui.ready();
    } catch (err) {
      if (mine !== token) return;
      ui.error(err.message || 'Could not load this section.');
    }
  });
  return () => ++token;
}

export function statTile(label, value, extra) {
  return el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat-label', text: label }),
    el('span', { class: 'stat-value', html: value }),
    extra ? el('span', { class: 'stat-extra', html: extra }) : null,
  );
}
