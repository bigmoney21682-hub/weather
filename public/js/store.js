// The one piece of shared state: where "here" is.
//
// PRIVACY: the chosen location is written to this browser's localStorage and
// nowhere else. There is no account, no cookie, and no server-side record of it.
// Clearing it (the ✕ in the location bar) removes it from the device entirely.

import { api } from './util.js';

const KEY = 'weather.location.v1';
const SAVED_KEY = 'weather.places.v1';
const listeners = new Set();
const savedListeners = new Set();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    /* corrupt or unavailable storage — start fresh */
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private-mode storage refusal is not fatal */
  }
}

function load() {
  const parsed = read(KEY, null);
  if (typeof parsed?.lat === 'number' && typeof parsed?.lon === 'number') return parsed;
  return null;
}

function persist(place) {
  write(KEY, place);
}

/* ---------------------------------------------------------- saved places -- */

// { id, lat, lon, label, source, isDefault } — the pills under the search box.
let saved = (read(SAVED_KEY, []) || []).filter((p) => typeof p?.lat === 'number' && typeof p?.lon === 'number');

/** Two searches that land within ~100 m are the same place. */
const placeId = (place) => `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;

function persistSaved() {
  write(SAVED_KEY, saved);
  for (const fn of savedListeners) {
    try {
      fn(saved);
    } catch (err) {
      console.error('saved-place listener failed', err);
    }
  }
}

export function getSavedPlaces() {
  return saved;
}

export function onSavedPlaces(fn) {
  savedListeners.add(fn);
  fn(saved);
  return () => savedListeners.delete(fn);
}

/** Remember a place as a pill. The first one saved becomes the default. */
export function savePlace(place) {
  if (!place) return null;
  const id = placeId(place);
  const existing = saved.find((p) => p.id === id);
  if (existing) {
    existing.label = place.label || existing.label;
    persistSaved();
    return existing;
  }
  const entry = { id, lat: place.lat, lon: place.lon, label: place.label, source: place.source || null, isDefault: !saved.length };
  saved = [...saved, entry];
  persistSaved();
  return entry;
}

export function removePlace(id) {
  const dropped = saved.find((p) => p.id === id);
  saved = saved.filter((p) => p.id !== id);
  // Never leave the list without a default to open on.
  if (dropped?.isDefault && saved.length) saved[0].isDefault = true;
  persistSaved();
}

export function setDefaultPlace(id) {
  saved = saved.map((p) => ({ ...p, isDefault: p.id === id }));
  persistSaved();
}

export function getDefaultPlace() {
  return saved.find((p) => p.isDefault) || null;
}

export { placeId };

// A starred place is where the page opens, every time. Without one, it picks up
// wherever the last visit left off.
const preferred = getDefaultPlace();
let current = preferred ? { lat: preferred.lat, lon: preferred.lon, label: preferred.label, source: preferred.source } : load();
if (preferred) persist(current);

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
