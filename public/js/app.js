// Wires the page together: location bar, then every section stacked in the
// order the header pills are in.

import { locationBar } from './locationbar.js';
import { weatherSection } from './sections/weather.js';
import { advisoriesSection } from './sections/advisories.js';
import { radarSection } from './sections/radar.js';
import { lightningSection } from './sections/lightning.js';
import { windSection } from './sections/wind.js';
import { hurricaneSection } from './sections/hurricanes.js';
import { surfSection } from './sections/surf.js';
import { airSection } from './sections/air.js';
import { oceanSection } from './sections/ocean.js';
import { orderedSections, sectionPills } from './sections-order.js';
import { getLocation } from './store.js';

const app = document.getElementById('app');

app.append(locationBar());

// Declared order — used the first time, and for any card added later.
const SECTIONS = [
  { id: 'weather', label: 'Forecast', make: weatherSection },
  { id: 'advisories', label: 'Advisories', make: advisoriesSection },
  { id: 'radar', label: 'Radar', make: radarSection },
  { id: 'lightning', label: 'Lightning', make: lightningSection },
  { id: 'wind', label: 'Wind', make: windSection },
  { id: 'hurricanes', label: 'Hurricanes', make: hurricaneSection },
  { id: 'surf', label: 'Surf', make: surfSection },
  { id: 'air', label: 'Air', make: airSection },
  { id: 'ocean', label: 'Ocean', make: oceanSection },
];

const sections = orderedSections(SECTIONS);
const cards = new Map();

for (const section of sections) {
  try {
    const card = section.make();
    cards.set(section.id, card);
    app.append(card);
  } catch (err) {
    console.error(`section "${section.id}" failed to mount`, err);
  }
}

// Appending a node that is already in the document moves it, so re-appending
// in pill order is all it takes to restack the page.
sectionPills(sections, (ids) => {
  for (const id of ids) {
    const card = cards.get(id);
    if (card) app.append(card);
  }
});

// If nothing is stored yet, put the cursor where the user needs to act.
if (!getLocation()) {
  document.querySelector('.loc-input')?.focus({ preventScroll: true });
}

document.getElementById('year').textContent = new Date().getFullYear();
