// DOM and formatting helpers shared by every section.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * Append children, flattening arrays and skipping blanks.
 * DOM `append` stringifies an array argument, so anything built with `.map()`
 * has to come through here (or through `el`, which uses the same rules).
 */
export function mount(node, ...children) {
  for (const c of children.flat(3)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export const f = {
  temp: (v) => (v == null ? '—' : `${Math.round(v)}°`),
  tempF: (v) => (v == null ? '—' : `${Math.round(v)}°F`),
  mph: (v) => (v == null ? '—' : `${Math.round(v)} mph`),
  ft: (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ft`),
  sec: (v) => (v == null ? '—' : `${Math.round(v)} s`),
  pct: (v) => (v == null ? '—' : `${Math.round(v)}%`),
  miles: (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} mi`),
  int: (v) => (v == null ? '—' : String(Math.round(v))),
  inches: (v) => (v == null ? '—' : `${v.toFixed(2)}"`),
};

export function hour(dateish, tz) {
  const d = new Date(dateish);
  return d.toLocaleTimeString([], { hour: 'numeric', timeZone: tz }).replace(' ', '');
}

export function clock(dateish, tz) {
  return new Date(dateish).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

export function dayName(dateish, tz) {
  return new Date(dateish).toLocaleDateString([], { weekday: 'short', timeZone: tz });
}

export function relative(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const h = Math.round(s / 3600);
  return h === 1 ? '1 hr ago' : `${h} hrs ago`;
}

export function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'a few seconds';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

/** Great-circle distance in metres between two {lat, lon} points. */
export function metersBetween(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** "±120 m" / "±38 mi" — a radius the reader can picture. */
export function accuracyLabel(m) {
  if (m == null) return '';
  if (m < 1000) return `±${Math.round(m)} m`;
  const miles = m / 1609.34;
  return `±${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/** Rate-limited, latest-wins async runner so rapid location changes don't stack. */
export function latest(fn) {
  let token = 0;
  return async (...args) => {
    const mine = ++token;
    const result = await fn(...args);
    if (mine !== token) return undefined;
    return result;
  };
}
