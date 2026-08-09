// National Weather Service active alerts for a point.
// Coverage is the US and its territories; elsewhere this returns an empty list
// with `covered: false` so the UI can say so instead of implying "all clear".

import { cached, fetchJSON, haversineMiles } from './util.js';

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
const URGENCY_RANK = { Immediate: 0, Expected: 1, Future: 2, Past: 3, Unknown: 4 };

// Rough bounding boxes for NWS coverage, used only to give a helpful message.
const NWS_REGIONS = [
  [-179.9, 15.0, -60.0, 72.0], // CONUS + Alaska
  [-160.5, 18.0, -154.0, 23.0], // Hawaii
  [-68.0, 17.0, -64.0, 19.0], // PR / USVI
  [144.0, 13.0, 146.5, 21.0], // Guam / CNMI
];

export function inNWSCoverage(lat, lon) {
  return NWS_REGIONS.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);
}

function normalize(feature, lat, lon) {
  const p = feature.properties || {};
  let distanceMiles = null;
  const g = feature.geometry;
  if (g) {
    // Distance to the nearest vertex is plenty for "how close is this to me".
    const pts = [];
    const walk = (c) => {
      if (typeof c[0] === 'number') pts.push(c);
      else c.forEach(walk);
    };
    walk(g.coordinates);
    for (const [plon, plat] of pts) {
      const d = haversineMiles(lat, lon, plat, plon);
      if (distanceMiles == null || d < distanceMiles) distanceMiles = d;
    }
  }
  return {
    id: p.id,
    event: p.event,
    headline: p.headline,
    description: p.description,
    instruction: p.instruction,
    severity: p.severity,
    certainty: p.certainty,
    urgency: p.urgency,
    sender: p.senderName,
    areaDesc: p.areaDesc,
    onset: p.onset || p.effective,
    expires: p.ends || p.expires,
    messageType: p.messageType,
    distanceMiles: distanceMiles == null ? null : Math.round(distanceMiles * 10) / 10,
  };
}

/** Alerts whose polygon/zone contains the point. */
export async function getAlerts(lat, lon) {
  if (!inNWSCoverage(lat, lon)) {
    return { covered: false, alerts: [], note: 'Government alerts are sourced from the US National Weather Service, which does not cover this location.' };
  }
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
  const data = await cached(`alerts:${lat.toFixed(3)}:${lon.toFixed(3)}`, 60 * 1000, () => fetchJSON(url));
  const alerts = (data.features || [])
    .map((f) => normalize(f, lat, lon))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) ||
        (URGENCY_RANK[a.urgency] ?? 4) - (URGENCY_RANK[b.urgency] ?? 4),
    );
  return { covered: true, alerts, updated: data.updated };
}

/**
 * Alerts anywhere within `radiusMiles`, used by the air-quality section to
 * surface smoke/ozone advisories that have not reached the user's zone yet.
 */
export async function getNearbyAlerts(lat, lon, radiusMiles, eventMatcher) {
  if (!inNWSCoverage(lat, lon)) return [];
  // The alerts endpoint only filters by state/zone server-side, so we pull the
  // active set once (cached across all sections) and do the radius test here.
  // The full feed is large, so give it room and share one copy across sections.
  const data = await cached('alerts:all', 90 * 1000, () =>
    fetchJSON('https://api.weather.gov/alerts/active', { timeout: 25000 }),
  );
  return (data.features || [])
    .map((f) => normalize(f, lat, lon))
    .filter((a) => a.distanceMiles != null && a.distanceMiles <= radiusMiles)
    .filter((a) => (eventMatcher ? eventMatcher.test(a.event || '') : true))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}
