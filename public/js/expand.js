// Full screen for any map or chart: one button, one frame that fills the
// viewport, and the same exits however you leave.
//
// Filling the screen is done in two layers, because the Fullscreen API is not
// everywhere — iPhone Safari has never offered it for anything but a video.
// The class does the whole job on its own: the frame is fixed to the viewport,
// above the sticky jump bar, with the map or chart taking whatever the controls
// and the legend leave. Native fullscreen, where there is one, is asked for on
// top of that, and all it adds is dropping the browser's own chrome. Where it
// is missing or refused, the class is already the answer and nothing is lost.
//
// Neither the maps nor the charts need telling that they changed size: the
// ResizeObserver in map.js nudges Leaflet, and TimeChart watches its holder.

import { el } from './util.js';

let current = null; // the one frame filling the screen, if any

const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COLLAPSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Make `frame` expandable from `button`.
 *
 * `className` is what the frame wears while it fills the screen: the generic
 * `frame-expanded` by default, or `card-expanded` for a whole card.
 * `icon: true` draws the button as a corner glyph rather than a labelled chip.
 */
export function expandable(frame, button, { className = 'frame-expanded', icon = false } = {}) {
  const state = { expanded: false };

  function paint(on) {
    state.expanded = on;
    frame.classList.toggle(className, on);
    document.body.classList.toggle('has-expanded-card', on);
    button.classList.toggle('active', on);
    button.setAttribute('aria-expanded', String(on));
    button.setAttribute('aria-label', on ? 'Collapse' : 'Expand to full screen');
    button.title = on ? 'Collapse (Esc)' : 'Full screen';
    if (icon) button.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
    else button.textContent = on ? 'Collapse' : 'Expand';
  }

  function expand() {
    if (state.expanded) return;
    if (current && current !== api) current.collapse();
    current = api;
    paint(true);
    // Both hops are optional: the method is missing on browsers that have no
    // element fullscreen, and a refusal rejects. Neither is worth reporting —
    // the frame is already filling the screen either way.
    frame.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
  }

  function collapse() {
    if (!state.expanded) return;
    if (current === api) current = null;
    paint(false);
    if (document.fullscreenElement === frame) document.exitFullscreen()?.catch(() => {});
  }

  const api = { expand, collapse, get expanded() { return state.expanded; } };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.expanded) collapse();
    else expand();
  });

  // Native fullscreen takes Escape for itself; this is for the fallback, where
  // nothing but our own class is holding the frame over the page.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.expanded) collapse();
  });

  // Leaving fullscreen by a route the button does not own — Escape, the
  // browser's own control, or another element taking fullscreen from us.
  document.addEventListener('fullscreenchange', () => {
    if (state.expanded && document.fullscreenElement !== frame) collapse();
  });

  paint(false);
  return api;
}

/** A labelled "Expand" chip, for a row of map controls. */
export function expandChip() {
  return el('button', { class: 'chip', type: 'button', text: 'Expand', 'aria-expanded': 'false' });
}

/**
 * Wrap a chart holder or a map (and whatever belongs with it, such as its
 * legend) in a frame with a corner button that takes the lot full screen.
 */
export function expandableBox(holder, ...extras) {
  const button = el('button', { class: 'expand-corner', type: 'button' });
  // A press on the button must not also start a pan on the map or a drag on
  // the chart underneath it.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'wheel']) {
    button.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  }
  holder.append(button);
  const frame = el('div', { class: 'expand-frame' }, holder, ...extras);
  expandable(frame, button, { icon: true });
  return frame;
}
