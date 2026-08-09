// The pill strip in the header, and the section order it controls.
//
// Tapping a pill jumps to its card. Pressing and holding one picks it up: drag
// it along the strip to put the sections in whatever order you actually read
// them in. The order is remembered in this browser (see PRIVACY.md — like the
// location, it never leaves the device).

import { el, clear } from './util.js';

const KEY = 'weather.order.v1';
const HOLD_MS = 300;
const MOVE_TOLERANCE = 8; // px of slop before a hold counts as a scroll instead

function loadOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(raw) && raw.every((id) => typeof id === 'string')) return raw;
  } catch {
    /* corrupt or unavailable storage — fall back to the default order */
  }
  return null;
}

function saveOrder(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* private-mode storage refusal is not fatal */
  }
}

/**
 * Sort `sections` by the stored order, keeping any section the stored list has
 * never heard of (a newly added card) in its declared position.
 */
export function orderedSections(sections) {
  const stored = loadOrder();
  if (!stored) return sections.slice();

  const byId = new Map(sections.map((s) => [s.id, s]));
  const out = [];
  for (const id of stored) {
    if (byId.has(id)) {
      out.push(byId.get(id));
      byId.delete(id);
    }
  }
  // Anything new keeps its place relative to the sections still unplaced.
  for (const s of sections) if (byId.has(s.id)) out.push(s);
  return out;
}

/**
 * Build the pill strip and wire up press-and-hold reordering.
 * `onReorder(ids)` runs whenever the order changes, so the caller can move the
 * cards to match.
 */
export function sectionPills(sections, onReorder) {
  const nav = document.getElementById('jumps');
  if (!nav) return;

  clear(nav);
  for (const s of sections) {
    nav.append(
      el('a', {
        href: `#${s.id}`,
        class: 'jump-pill',
        'data-id': s.id,
        text: s.label,
        title: `${s.label} — press and hold to move`,
        'aria-describedby': 'jump-help',
      }),
    );
  }
  nav.append(el('span', { id: 'jump-help', class: 'sr-only', text: 'Press and hold a section to drag it into a new order.' }));

  let held = null; // the pill currently picked up
  let holdTimer = null;
  let startX = 0;
  let startY = 0;
  let moved = false;

  const pills = () => [...nav.querySelectorAll('.jump-pill')];

  function commit() {
    const ids = pills().map((p) => p.dataset.id);
    saveOrder(ids);
    onReorder?.(ids);
  }

  function pickUp(pill) {
    held = pill;
    pill.classList.add('is-dragging');
    nav.classList.add('is-reordering');
    navigator.vibrate?.(12);
  }

  function drop() {
    clearTimeout(holdTimer);
    if (!held) return;
    held.classList.remove('is-dragging');
    nav.classList.remove('is-reordering');
    // The click that ends a drag is not a request to jump anywhere.
    held.dataset.justDragged = '1';
    held = null;
    commit();
  }

  /** Slide the held pill past whichever neighbour the pointer is now over. */
  function dragTo(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY)?.closest?.('.jump-pill');
    if (under && under !== held && under.parentNode === nav) {
      const box = under.getBoundingClientRect();
      const after = clientX > box.left + box.width / 2;
      nav.insertBefore(held, after ? under.nextSibling : under);
    }
    // Nudge the strip along when dragging against either end.
    const strip = nav.getBoundingClientRect();
    const edge = 44;
    if (clientX < strip.left + edge) nav.scrollLeft -= 12;
    else if (clientX > strip.right - edge) nav.scrollLeft += 12;
  }

  nav.addEventListener('pointerdown', (e) => {
    const pill = e.target.closest('.jump-pill');
    if (!pill || e.button > 0) return;
    startX = e.clientX;
    startY = e.clientY;
    moved = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!moved) {
        try {
          pill.setPointerCapture?.(e.pointerId);
        } catch {
          /* pointer already released — dragging still works without capture */
        }
        pickUp(pill);
      }
    }, HOLD_MS);
  });

  nav.addEventListener('pointermove', (e) => {
    if (held) {
      dragTo(e.clientX, e.clientY);
      return;
    }
    if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
      moved = true;
      clearTimeout(holdTimer);
    }
  });

  nav.addEventListener('pointerup', drop);
  nav.addEventListener('pointercancel', drop);

  // A touch-drag would otherwise scroll the strip out from under the pill.
  nav.addEventListener('touchmove', (e) => held && e.preventDefault(), { passive: false });

  nav.addEventListener('click', (e) => {
    const pill = e.target.closest('.jump-pill');
    if (!pill) return;
    e.preventDefault();
    if (pill.dataset.justDragged) {
      delete pill.dataset.justDragged;
      return;
    }
    document.getElementById(pill.dataset.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  highlightCurrent(nav);

  // Reordering without a pointer: hold Alt and step the focused pill along.
  nav.addEventListener('keydown', (e) => {
    const pill = e.target.closest?.('.jump-pill');
    if (!pill || !e.altKey) return;
    if (e.key === 'ArrowLeft' && pill.previousElementSibling?.classList.contains('jump-pill')) {
      nav.insertBefore(pill, pill.previousElementSibling);
    } else if (e.key === 'ArrowRight' && pill.nextElementSibling?.classList.contains('jump-pill')) {
      nav.insertBefore(pill.nextElementSibling, pill);
    } else {
      return;
    }
    e.preventDefault();
    pill.focus();
    commit();
  });
}

/**
 * Mark the pill for whichever card is currently on screen, and keep it in view
 * in the strip.
 *
 * The observer reports what is visible; picking the *topmost* visible card is
 * what makes it feel right, because a tall card scrolling out of the top is no
 * longer the one you are reading even while it still covers half the viewport.
 * The top margin discounts the band hidden behind the sticky strip itself.
 */
function highlightCurrent(nav) {
  const cards = [...document.querySelectorAll('main .card')];
  if (!cards.length || !('IntersectionObserver' in window)) return;

  const visible = new Set();
  let current = null;

  const paint = () => {
    // Sorted live rather than once, because reordering moves these very cards.
    const [top] = cards
      .filter((c) => visible.has(c.id))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (!top || top.id === current) return;
    current = top.id;
    for (const pill of nav.querySelectorAll('.jump-pill')) {
      const on = pill.dataset.id === current;
      pill.classList.toggle('is-current', on);
      // Only chase the pill when the user is scrolling the page, not the strip.
      if (on && !nav.matches(':hover')) {
        pill.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    }
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      paint();
    },
    { rootMargin: '-52px 0px -55% 0px', threshold: 0 },
  );
  for (const card of cards) io.observe(card);
}
