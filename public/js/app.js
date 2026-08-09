// Wires the page together: location bar, then every section stacked in order.

import { locationBar } from './locationbar.js';
import { weatherSection } from './sections/weather.js';
import { advisoriesSection } from './sections/advisories.js';
import { radarSection } from './sections/radar.js';
import { lightningSection } from './sections/lightning.js';
import { windSection } from './sections/wind.js';
import { hurricaneSection } from './sections/hurricanes.js';
import { surfSection } from './sections/surf.js';
import { airSection } from './sections/air.js';
import { getLocation } from './store.js';

const app = document.getElementById('app');

app.append(locationBar());

const sections = [
  weatherSection,
  advisoriesSection,
  radarSection,
  lightningSection,
  windSection,
  hurricaneSection,
  surfSection,
  airSection,
];

for (const make of sections) {
  try {
    app.append(make());
  } catch (err) {
    console.error('section failed to mount', err);
  }
}

// Jump links in the header.
document.querySelectorAll('[data-jump]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById(link.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// If nothing is stored yet, put the cursor where the user needs to act.
if (!getLocation()) {
  document.querySelector('.loc-input')?.focus({ preventScroll: true });
}

document.getElementById('year').textContent = new Date().getFullYear();
