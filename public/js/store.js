// The one piece of shared state: where "here" is.
//
// PRIVACY: the chosen location is written to this browser's localStorage and
// nowhere else. There is no account, no cookie, and no server-side record of it.
// Clearing it (the ✕ in the location bar) removes it from the device entirely.

import { api, metersBetween } from './util.js';

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
  if (!place) return write(KEY, null);
  // `follow` describes this moment in a drive, not the place — a reload starts
  // parked, wherever the drive happened to end.
  const { follow, ...rest } = place;
  write(KEY, rest);
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
  // Choosing somewhere deliberately ends follow mode; without this the next GPS
  // sample would drag the page straight back to where the phone is.
  if (!place?.follow) stopFollowing();
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

/* -------------------------------------------------------- device position -- */

// A phone answers with whatever it has to hand. The first fix is very often a
// network estimate — the cell tower, the Wi-Fi neighbourhood, or, with nothing
// else to go on, the IP address, which can land tens of miles away. The GPS fix
// arrives a few seconds later. Waiting out those seconds is the whole
// difference between "your street" and "the city you are nowhere near".
const GOOD_ENOUGH_M = 100; // stop refining once a fix is this sharp
const REFINE_MS = 8000; // …but never spend longer than this waiting on GPS
const FIX_TIMEOUT_MS = 20000; // give up on a first fix entirely after this
// Anything vaguer than this is a network estimate, not a real position.
export const COARSE_FIX_M = 3000;

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);

/** Steps that actually unblock location on this device, most likely cause first. */
function unblockSteps() {
  if (isIOS()) {
    return [
      'Settings → Privacy & Security → Location Services — this master switch must be on.',
      'In that same list, tap Safari Websites → set it to “While Using the App” and turn on Precise Location.',
      'Safari’s own per-site setting (aA in the address bar → Website Settings → Location) has to be Ask or Allow.',
      'Private Browsing and Lockdown Mode both refuse location outright — leave them for this tab.',
      'Then reload this page and tap “Use my location” again.',
    ];
  }
  if (isAndroid()) {
    return [
      'Settings → Location — this master switch must be on.',
      'Long-press the browser icon → App info → Permissions → Location → “Allow only while using the app”, and turn on “Use precise location”.',
      'In the browser: ⋮ → Settings → Site settings → Location → allow this site.',
      'Then reload this page and tap “Use my location” again.',
    ];
  }
  return [
    'Click the padlock or location icon in the address bar and allow location for this site.',
    'Check that location services are enabled for your browser in the operating system’s privacy settings.',
  ];
}

/** Report the state the browser will admit to, without ever blocking on it. */
async function permissionState() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state ?? null; // 'granted' | 'prompt' | 'denied'
  } catch {
    /* older Safari has no geolocation entry in the Permissions API */
    return null;
  }
}

function locationError(message, help = []) {
  return Object.assign(new Error(message), { help });
}

/**
 * Browsers hand out one blunt "permission denied" for several very different
 * situations. Tell them apart so the fix on offer is the one that applies.
 */
async function describeError(err, elapsedMs) {
  if (err.code === 1) {
    const state = await permissionState();
    // A denial that comes back almost instantly means no prompt was ever shown:
    // something above the page — the OS switch, a per-site rule, Lockdown or
    // Private Browsing — refused on the user's behalf.
    if (state === 'denied' || elapsedMs < 500) {
      return locationError(
        'The browser refused without asking you, so the block is a setting rather than a tap of “Don’t Allow”.',
        unblockSteps(),
      );
    }
    return locationError(
      'Location permission was denied. You can still type a ZIP, city, town or county above.',
      unblockSteps(),
    );
  }
  if (err.code === 2) {
    return locationError('Your position is unavailable right now — indoors or in airplane mode is the usual reason.');
  }
  if (err.code === 3) {
    return locationError('Getting your position timed out. Somewhere with a view of the sky usually fixes it.');
  }
  return locationError(err.message || 'Could not get your position.');
}

/** Refuse early on http, where the browser will never hand out a position. */
function insecureContextError() {
  if (window.isSecureContext) return null;
  return locationError(
    `This page is on ${location.protocol}//${location.host}, which is not a secure connection, so the browser will not give out your location.`,
    ['Open the site over https (its Render address) and location will work.'],
  );
}

/** Coordinates go to this app's own server only, and only for a place name. */
async function describePlace(lat, lon, accuracyM) {
  let place = { lat, lon, label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, source: 'device location' };
  try {
    place = await api('/api/reverse', { lat, lon });
  } catch {
    /* keep the coordinate label */
  }
  place.accuracyM = Math.round(accuracyM);
  return place;
}

/**
 * Ask the device where it is, holding out briefly for a fix worth having.
 * `onProgress(accuracyM)` reports each fix as it sharpens.
 */
export function useDeviceLocation({ onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const insecure = insecureContextError();
    if (insecure) return reject(insecure);
    if (!navigator.geolocation) {
      return reject(locationError('This browser has no location support.'));
    }

    const startedAt = Date.now();
    let best = null;
    let watch = null;
    let refineTimer = null;
    let hardTimer = null;
    let settled = false;

    const stop = () => {
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      clearTimeout(refineTimer);
      clearTimeout(hardTimer);
    };
    const fail = (err) => {
      stop();
      settled = true;
      void describeError(err, Date.now() - startedAt).then(reject);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      stop();
      describePlace(best.coords.latitude, best.coords.longitude, best.coords.accuracy)
        .then((place) => {
          setLocation(place);
          resolve(place);
        })
        .catch(reject);
    };

    hardTimer = setTimeout(() => (best ? settle() : fail({ code: 3 })), FIX_TIMEOUT_MS);

    watch = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        onProgress?.(Math.round(best.coords.accuracy));
        if (best.coords.accuracy <= GOOD_ENOUGH_M) return settle();
        // Coarse first fix: give the GPS a few seconds to better it.
        if (refineTimer === null) refineTimer = setTimeout(settle, REFINE_MS);
      },
      (err) => {
        if (best) return; // a later sample failed; what we already have still stands
        fail(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: FIX_TIMEOUT_MS },
    );
  });
}

/* ------------------------------------------------------------ follow mode -- */

// Moving the map every few hundred feet would refetch nine sections' worth of
// feeds for no new information, so a drive only counts as a new place once it
// has covered real ground — and no more often than the gap below.
const FOLLOW_MIN_MOVE_M = 4800; // ~3 miles
const FOLLOW_MIN_GAP_MS = 90 * 1000;

let followWatch = null;
let followAnchor = null; // the fix the page is currently showing
let followBusy = false;
const followListeners = new Set();

export function isFollowing() {
  return followWatch !== null;
}

export function onFollowChange(fn) {
  followListeners.add(fn);
  fn(isFollowing());
  return () => followListeners.delete(fn);
}

function emitFollow() {
  for (const fn of followListeners) {
    try {
      fn(isFollowing());
    } catch (err) {
      console.error('follow listener failed', err);
    }
  }
}

async function adoptWhileMoving(pos, onFix) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const now = Date.now();
  if (followAnchor) {
    if (accuracy > COARSE_FIX_M) return; // a vague sample; a better one is coming
    if (now - followAnchor.at < FOLLOW_MIN_GAP_MS) return;
    if (metersBetween(followAnchor, { lat, lon }) < FOLLOW_MIN_MOVE_M) return;
  }
  if (followBusy) return;
  followBusy = true;
  followAnchor = { lat, lon, at: now };
  try {
    const place = await describePlace(lat, lon, accuracy);
    place.follow = true;
    setLocation(place);
    onFix?.(place);
  } finally {
    followBusy = false;
  }
}

/**
 * Keep the page pinned to the device as it moves.
 * `onFix(place)` fires on each adopted move, `onError(err)` when a sample or the
 * permission fails — errors carrying `transient` are momentary, not the end of
 * follow mode.
 */
export function startFollowing({ onFix, onError } = {}) {
  if (followWatch !== null) return;
  const insecure = insecureContextError();
  if (insecure) return onError?.(insecure);
  if (!navigator.geolocation) return onError?.(locationError('This browser has no location support.'));

  const startedAt = Date.now();
  followAnchor = null;
  followBusy = false;
  followWatch = navigator.geolocation.watchPosition(
    (pos) => void adoptWhileMoving(pos, onFix),
    (err) => {
      // A tunnel or a parking garage is not a reason to drop out of follow
      // mode — the watch keeps running and the next fix lands on the far side.
      if (err.code !== 1) {
        void describeError(err, Date.now() - startedAt).then((e) => onError?.(Object.assign(e, { transient: true })));
        return;
      }
      stopFollowing();
      void describeError(err, Date.now() - startedAt).then((e) => onError?.(e));
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  emitFollow();
}

export function stopFollowing() {
  if (followWatch === null) return;
  navigator.geolocation.clearWatch(followWatch);
  followWatch = null;
  followAnchor = null;
  emitFollow();
}
