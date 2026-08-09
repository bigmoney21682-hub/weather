// Active National Weather Service advisories, watches and warnings for the
// selected point.

import { api, el, clear, clock } from '../util.js';
import { createSection, bindLocation } from '../section.js';

const ICON = `<svg viewBox="0 0 24 24" class="wx-icon" fill="none"><path d="M12 3 2.5 20h19L12 3Z" fill="var(--warn)"/><path d="M12 9.5v5" stroke="#1b1305" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.2" fill="#1b1305"/></svg>`;

const SEVERITY_CLASS = {
  Extreme: 'sev-extreme',
  Severe: 'sev-severe',
  Moderate: 'sev-moderate',
  Minor: 'sev-minor',
};

export function advisoriesSection() {
  const ui = createSection({
    id: 'advisories',
    title: 'Weather Advisories',
    subtitle: 'Active alerts in your area',
    icon: ICON,
  });

  bindLocation(ui, async (place) => {
    const data = await api('/api/alerts', { lat: place.lat, lon: place.lon });
    render(ui, data, place);
  });

  return ui.card;
}

function render(ui, data, place) {
  clear(ui.body);

  if (!data.covered) {
    ui.setSubtitle(place.label);
    ui.note(data.note);
    ui.body.append(el('p', { class: 'empty', text: 'No government alert feed is available for this location.' }));
    return;
  }

  const n = data.alerts.length;
  ui.setSubtitle(`${place.label} · ${n === 0 ? 'nothing active' : `${n} active`}`);

  if (!n) {
    ui.body.append(
      el(
        'div',
        { class: 'all-clear' },
        el('span', { class: 'all-clear-mark', text: '✓' }),
        el('div', {}, el('b', { text: 'No active advisories' }), el('p', { text: 'The National Weather Service has nothing in effect for this point.' })),
      ),
    );
    return;
  }

  ui.body.append(
    el(
      'div',
      { class: 'alerts' },
      data.alerts.map((a) => {
        const detail = el('div', { class: 'alert-detail' },
          a.description ? el('pre', { class: 'alert-text', text: a.description.trim() }) : null,
          a.instruction ? el('div', { class: 'alert-instruction' }, el('b', { text: 'What to do' }), el('pre', { class: 'alert-text', text: a.instruction.trim() })) : null,
          el('p', { class: 'alert-meta', text: `Issued by ${a.sender || 'NWS'} · covers ${a.areaDesc || 'this area'}` }),
        );

        const item = el(
          'article',
          { class: `alert ${SEVERITY_CLASS[a.severity] || 'sev-minor'}` },
          el(
            'button',
            {
              class: 'alert-head',
              type: 'button',
              'aria-expanded': 'false',
              onClick(e) {
                const open = item.classList.toggle('open');
                e.currentTarget.setAttribute('aria-expanded', String(open));
              },
            },
            el(
              'div',
              { class: 'alert-headline' },
              el('span', { class: 'alert-event', text: a.event }),
              el('span', { class: 'alert-when', text: windowText(a) }),
            ),
            // Plenty of alerts carry severity "Unknown"; a badge saying so is noise.
            a.severity && a.severity !== 'Unknown'
              ? el('span', { class: 'alert-badge', text: a.severity })
              : null,
          ),
          detail,
        );
        return item;
      }),
    ),
  );
}

function windowText(a) {
  const parts = [];
  if (a.onset) parts.push(`from ${clock(a.onset)}`);
  if (a.expires) parts.push(`until ${clock(a.expires)}`);
  if (a.distanceMiles != null && a.distanceMiles > 0) parts.push(`${a.distanceMiles} mi`);
  return parts.join(' · ');
}
