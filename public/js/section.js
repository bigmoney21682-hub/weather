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

  // The parts of a progress state, kept between updates so that ticking the
  // count along does not rebuild the pill and restart its animation.
  let bar = null;

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
      bar = null;
      status.className = 'card-status loading';
      status.textContent = message;
    },
    /**
     * `loading` for work that arrives in pieces: the same pill, with a bar that
     * fills as `done` climbs towards `total`. A spinner alone cannot tell a slow
     * fetch from a stalled one, which is exactly the question a phone on a weak
     * connection leaves you asking.
     */
    progress(message, done, total) {
      if (!(total > 0)) return ui.loading(message);
      if (!bar) {
        status.className = 'card-status loading';
        clear(status);
        bar = { text: el('span'), fill: el('i') };
        status.append(bar.text, el('div', { class: 'progress-track' }, bar.fill));
      }
      bar.text.textContent = message;
      bar.fill.style.width = `${Math.round(Math.min(1, Math.max(0, done / total)) * 100)}%`;
    },
    error(message, onRetry) {
      bar = null;
      status.className = 'card-status error';
      clear(status);
      status.append(el('span', { text: message }));
      if (onRetry) {
        status.append(el('button', { class: 'retry-btn', type: 'button', text: 'Try again', onClick: onRetry }));
      }
    },
    note(message) {
      bar = null;
      status.className = 'card-status note';
      status.textContent = message;
    },
    ready() {
      bar = null;
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
  let lastPlace = null;

  async function run(place) {
    const mine = ++token;
    lastPlace = place;
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
      ui.error(err.message || 'Could not load this section.', () => run(lastPlace));
    }
  }

  onLocation(run);
  return run;
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
