// The one piece of shared state: where "here" is.
//
// PRIVACY: the chosen location is written to this browser's localStorage and
// nowhere else. There is no account, no cookie, and no server-side record of it.
// Clearing it (the ✕ in the location bar) removes it from the device entirely.

import { api } from './util.js';

const KEY = 'weather.location.v1';
const listeners = new Set();

let current = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lat === 'number' && typeof parsed?.lon === 'number') return parsed;
  } catch {
    /* corrupt or unavailable storage — start fresh */
  }
  return null;
}

function persist(place) {
  try {
    if (place) localStorage.setItem(KEY, JSON.stringify(place));
    else localStorage.removeItem(KEY);
  } catch {
    /* private-mode storage refusal is not fatal */
  }
}

export function getLocation() {
  return current;
}

export function onLocation(fn) {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

export function setLocation(place) {
  current = place;
  persist(place);
  for (const fn of listeners) {
    try {
      fn(place);
    } catch (err) {
      console.error('location listener failed', err);
    }
  }
}

export function clearLocation() {
  setLocation(null);
}

/** Resolve free text (ZIP, city, town, county) to a place and adopt it. */
export async function searchLocation(query) {
  const place = await api('/api/geocode', { q: query });
  setLocation(place);
  return place;
}

/**
 * Ask the browser for the device position.
 * The coordinates go to this app's own server only, and only to be turned into
 * a place name; they are never transmitted anywhere else.
 */
export function useDeviceLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser has no location support.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let place = { lat, lon, label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, source: 'device location' };
        try {
          place = await api('/api/reverse', { lat, lon });
        } catch {
          /* keep the coordinate label */
        }
        place.accuracyM = Math.round(pos.coords.accuracy);
        setLocation(place);
        resolve(place);
      },
      (err) => {
        const messages = {
          1: 'Location permission was denied. You can still type a ZIP, city, town or county above.',
          2: 'Your position is unavailable right now.',
          3: 'Getting your position timed out.',
        };
        reject(new Error(messages[err.code] || err.message));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  });
}
