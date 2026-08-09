// Global tropical cyclones.
//
// Two official sources, no third-party aggregator:
//   * NHC  (nhc.noaa.gov)          - Atlantic, Eastern & Central Pacific
//   * JTWC (metoc.navy.mil/jtwc)   - Western Pacific, Indian Ocean, Southern Hem.
//
// Both publish their forecast advisory as fixed-format text, which is where the
// track points, intensities and wind radii below come from. The cone of
// uncertainty is reconstructed from the forecast track plus the agencies'
// published average track-error radii — that is exactly how the official cone is
// defined, so it matches the graphic rather than approximating it.

import { cached, fetchJSON, ktToMph, offsetMiles } from './util.js';

const NM_TO_MILES = 1.15078;

// Published average track forecast errors (nautical miles) used to size the
// cone. NHC updates these annually from the previous five years of verification.
const CONE_RADII_NM = {
  atlantic: { 12: 26, 24: 41, 36: 55, 48: 69, 60: 86, 72: 102, 96: 151, 120: 198 },
  epac: { 12: 25, 24: 38, 36: 51, 48: 65, 60: 78, 72: 91, 96: 115, 120: 138 },
  // JTWC does not publish a cone; these are its verification-based averages.
  jtwc: { 12: 30, 24: 50, 36: 70, 48: 90, 60: 110, 72: 130, 96: 180, 120: 240 },
};

const SAFFIR_SIMPSON = [
  [157, 'Category 5', 'cat5'],
  [130, 'Category 4', 'cat4'],
  [111, 'Category 3', 'cat3'],
  [96, 'Category 2', 'cat2'],
  [74, 'Category 1', 'cat1'],
  [39, 'Tropical Storm', 'ts'],
  [0, 'Tropical Depression', 'td'],
];

export function categorize(windMph) {
  if (windMph == null) return { label: 'Unknown', class: 'unknown' };
  for (const [floor, label, cls] of SAFFIR_SIMPSON) {
    if (windMph >= floor) return { label, class: cls };
  }
  return { label: 'Unknown', class: 'unknown' };
}

/* ------------------------------------------------------------------ NHC ---- */

function parseNHCLatLon(text) {
  const m = text.match(/(\d{1,2}\.\d)\s*([NS])\s+(\d{1,3}\.\d)\s*([EW])/);
  if (!m) return null;
  return {
    lat: Number(m[1]) * (m[2] === 'S' ? -1 : 1),
    lon: Number(m[3]) * (m[4] === 'W' ? -1 : 1),
  };
}

/** Turn a "DD/HHMMZ" advisory stamp into an ISO instant near `reference`. */
function advisoryTimeToISO(stamp, reference = new Date()) {
  const m = stamp.match(/(\d{2})\/(\d{2})(\d{2})Z/);
  if (!m) return null;
  const [, dd, hh, mm] = m.map(Number);
  const d = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), dd, hh, mm));
  // Advisories run forward in time; roll the month if the day number wrapped.
  if (d.getTime() - reference.getTime() < -20 * 24 * 3600 * 1000) d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getTime() - reference.getTime() > 20 * 24 * 3600 * 1000) d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

function parseWindRadii(block) {
  // "64 KT.... 30NE  20SE  20SW  30NW."
  const radii = {};
  const re = /^\s*(34|50|64)\s*KT\.*\s+(\d+)NE\s+(\d+)SE\s+(\d+)SW\s+(\d+)NW/gm;
  let m;
  while ((m = re.exec(block))) {
    radii[m[1]] = { ne: +m[2], se: +m[3], sw: +m[4], nw: +m[5] }; // nautical miles
  }
  return Object.keys(radii).length ? radii : null;
}

function parseNHCForecastAdvisory(text) {
  const now = new Date();
  const points = [];

  const current = text.match(/CENTER LOCATED NEAR\s+([\d.]+[NS])\s+([\d.]+[EW])\s+AT\s+(\d{2}\/\d{4}Z)/);
  const currentWind = text.match(/MAX SUSTAINED WINDS\s+(\d+)\s*KT\s+WITH GUSTS TO\s+(\d+)\s*KT/);
  if (current) {
    const pos = parseNHCLatLon(`${current[1]} ${current[2]}`);
    points.push({
      hour: 0,
      time: advisoryTimeToISO(current[3], now),
      ...pos,
      windMph: currentWind ? Math.round(ktToMph(+currentWind[1])) : null,
      gustMph: currentWind ? Math.round(ktToMph(+currentWind[2])) : null,
      radii: parseWindRadii(text.split(/FORECAST VALID/)[0]),
    });
  }

  // "FORECAST VALID 12/1200Z 33.5N 63.0W" then "MAX WIND 80 KT...GUSTS 100 KT."
  const re = /FORECAST VALID\s+(\d{2}\/\d{4}Z)\s+([\d.]+[NS])\s+([\d.]+[EW])([\s\S]*?)(?=FORECAST VALID|OUTLOOK VALID|REQUEST FOR|NNNN|$)/g;
  let m;
  const baseTime = points[0]?.time ? new Date(points[0].time) : now;
  while ((m = re.exec(text))) {
    const pos = parseNHCLatLon(`${m[2]} ${m[3]}`);
    if (!pos) continue;
    const wind = m[4].match(/MAX WIND\s+(\d+)\s*KT\.*\.*GUSTS\s+(\d+)\s*KT/);
    const time = advisoryTimeToISO(m[1], baseTime);
    points.push({
      hour: time ? Math.round((new Date(time) - baseTime) / 3600000) : null,
      time,
      ...pos,
      windMph: wind ? Math.round(ktToMph(+wind[1])) : null,
      gustMph: wind ? Math.round(ktToMph(+wind[2])) : null,
      radii: parseWindRadii(m[4]),
    });
  }

  const outlook = /OUTLOOK VALID\s+(\d{2}\/\d{4}Z)\s+([\d.]+[NS])\s+([\d.]+[EW])[\s\S]*?MAX WIND\s+(\d+)\s*KT\.*\.*GUSTS\s+(\d+)\s*KT/g;
  while ((m = outlook.exec(text))) {
    const pos = parseNHCLatLon(`${m[2]} ${m[3]}`);
    const time = advisoryTimeToISO(m[1], baseTime);
    points.push({
      hour: time ? Math.round((new Date(time) - baseTime) / 3600000) : null,
      time,
      ...pos,
      windMph: Math.round(ktToMph(+m[4])),
      gustMph: Math.round(ktToMph(+m[5])),
      outlook: true,
    });
  }

  return points.filter((p) => p.lat != null).sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0));
}

async function nhcStorms() {
  const data = await cached('nhc:current', 5 * 60 * 1000, () =>
    fetchJSON('https://www.nhc.noaa.gov/CurrentStorms.json'),
  );
  return (data.activeStorms || []).map((s) => {
    const windMph = s.intensity == null ? null : Math.round(ktToMph(Number(s.intensity)));
    return {
      id: s.id,
      name: s.name,
      agency: 'NHC',
      basin: /^al/i.test(s.id) ? 'Atlantic' : /^cp/i.test(s.id) ? 'Central Pacific' : 'Eastern Pacific',
      basinKey: /^al/i.test(s.id) ? 'atlantic' : 'epac',
      classification: s.classification,
      lat: s.latitudeNumeric ?? null,
      lon: s.longitudeNumeric ?? null,
      windMph,
      gustMph: null,
      pressureMb: s.pressure == null ? null : Number(s.pressure),
      movementDir: s.movementDir ?? null,
      movementMph: s.movementSpeed == null ? null : Math.round(ktToMph(Number(s.movementSpeed))),
      lastUpdate: s.lastUpdate,
      advisoryNumber: s.publicAdvisory?.advNum || s.forecastAdvisory?.advNum,
      _forecastAdvisoryUrl: s.forecastAdvisory?.url,
      _publicAdvisoryUrl: s.publicAdvisory?.url,
      links: {
        official: `https://www.nhc.noaa.gov/refresh/graphics_${/^al/i.test(s.id) ? 'at' : 'ep'}1+shtml/`,
        coneGraphic: s.forecastGraphics?.url || null,
        modelPlots: 'https://www.tropicaltidbits.com/storminfo/',
      },
      ...categorize(windMph),
    };
  });
}

/* ----------------------------------------------------------------- JTWC ---- */

/**
 * JTWC states wind radii as four quadrant lines per threshold:
 *   RADIUS OF 064 KT WINDS - 030 NM NORTHEAST QUADRANT
 *                            020 NM SOUTHEAST QUADRANT  …
 */
function parseJTWCRadii(block) {
  const radii = {};
  const re = /RADIUS OF (\d+)\s*KT WINDS\s*-\s*(\d+)\s*NM NORTHEAST QUADRANT\s*\n\s*(\d+)\s*NM SOUTHEAST QUADRANT\s*\n\s*(\d+)\s*NM SOUTHWEST QUADRANT\s*\n\s*(\d+)\s*NM NORTHWEST QUADRANT/g;
  let m;
  while ((m = re.exec(block))) {
    radii[String(Number(m[1]))] = { ne: +m[2], se: +m[3], sw: +m[4], nw: +m[5] };
  }
  return Object.keys(radii).length ? radii : null;
}

function parseJTWCWarning(text) {
  const now = new Date();
  const points = [];
  const toISO = (stamp, ref) => advisoryTimeToISO(`${stamp.slice(0, 2)}/${stamp.slice(2, 6)}Z`, ref);

  // Current position block
  const cur = text.match(/WARNING POSITION:\s*\n\s*(\d{6})Z\s+---\s+NEAR\s+([\d.]+)([NS])\s+([\d.]+)([EW])/);
  const curWind = text.match(/MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT,\s*GUSTS\s*(\d+)\s*KT/);
  let baseTime = now;
  if (cur) {
    const time = toISO(cur[1], now);
    baseTime = time ? new Date(time) : now;
    points.push({
      hour: 0,
      time,
      lat: Number(cur[2]) * (cur[3] === 'S' ? -1 : 1),
      lon: Number(cur[4]) * (cur[5] === 'W' ? -1 : 1),
      windMph: curWind ? Math.round(ktToMph(+curWind[1])) : null,
      gustMph: curWind ? Math.round(ktToMph(+curWind[2])) : null,
      radii: parseJTWCRadii(text.split(/\d+\s*HRS?,\s*VALID AT:/)[0]),
    });
  }

  // "12 HRS, VALID AT:\n 091200Z --- 28.2N 121.2E\n MAX SUSTAINED WINDS - 060 KT, GUSTS 075 KT"
  const fcRe = /(\d+)\s*HRS?,\s*VALID AT:\s*\n\s*(\d{6})Z\s+---\s+([\d.]+)([NS])\s+([\d.]+)([EW])([\s\S]*?)(?=\d+\s*HRS?,\s*VALID AT:|REMARKS|NNNN|$)/g;
  let m;
  while ((m = fcRe.exec(text))) {
    const wind = m[7].match(/MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT,\s*GUSTS\s*(\d+)\s*KT/);
    points.push({
      hour: Number(m[1]),
      time: toISO(m[2], baseTime),
      lat: Number(m[3]) * (m[4] === 'S' ? -1 : 1),
      lon: Number(m[5]) * (m[6] === 'W' ? -1 : 1),
      windMph: wind ? Math.round(ktToMph(+wind[1])) : null,
      gustMph: wind ? Math.round(ktToMph(+wind[2])) : null,
      radii: parseJTWCRadii(m[7]),
    });
  }
  return points.sort((a, b) => a.hour - b.hour);
}

const JTWC_BASINS = {
  wp: 'Western Pacific',
  io: 'Indian Ocean',
  sh: 'Southern Hemisphere',
  cp: 'Central Pacific',
  ep: 'Eastern Pacific',
};

async function jtwcStorms() {
  const xml = await cached('jtwc:rss', 10 * 60 * 1000, () =>
    fetchJSON('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss', { text: true }),
  );

  // Each system appears as a bold heading followed by a list of product links.
  //
  // The advisory number is *not* the end of the heading: JTWC appends its own
  // markup for a system's last bulletin — "Warning #55 <font color=red><b>Final
  // Warning</b></font>" — so anchoring on a closing </b> right after the number
  // silently drops exactly the storms that just ended. Run to the product link
  // instead and read whatever markup sits in between.
  const storms = [];
  const blockRe = /<b>\s*([^<]*?(?:Typhoon|Tropical Storm|Tropical Depression|Cyclone|Hurricane)[^<]*?)\s*Warning\s*#?(\d+)\b([\s\S]{0,400}?)products\/([a-z]{2}\d{4})web\.txt/gi;
  let m;
  while ((m = blockRe.exec(xml))) {
    const heading = m[1].replace(/\s+/g, ' ').trim();
    const finalWarning = /final\s*warning/i.test(m[3]);
    const stormId = m[4]; // e.g. wp1226
    const basinKey = stormId.slice(0, 2).toLowerCase();
    // "Typhoon  12W (Dolphin)"
    const named = heading.match(/^(.*?)\s+(\d+[A-Z])\s*(?:\(([^)]+)\))?$/);
    const classification = named ? named[1].trim() : heading;
    const designation = named ? named[2] : heading;
    const name = named?.[3] || designation;
    if (basinKey === 'cp' || basinKey === 'ep' || basinKey === 'al') continue; // NHC owns these
    if (/formation alert/i.test(heading)) continue; // not yet a numbered system
    storms.push({
      id: `jtwc-${stormId}`,
      name,
      designation,
      agency: 'JTWC',
      basin: JTWC_BASINS[basinKey] || 'Western Pacific',
      basinKey: 'jtwc',
      classification,
      advisoryNumber: m[2],
      // JTWC's last bulletin on a system. It stays in the feed for a few hours
      // afterwards, and it is worth showing — "Dolphin is done" is information.
      finalWarning,
      _warningUrl: `https://www.metoc.navy.mil/jtwc/products/${stormId}web.txt`,
      links: {
        official: 'https://www.metoc.navy.mil/jtwc/jtwc.html',
        coneGraphic: `https://www.metoc.navy.mil/jtwc/products/${stormId}.gif`,
        modelPlots: 'https://www.tropicaltidbits.com/storminfo/',
      },
    });
  }

  // The RSS carries no position or intensity, so pull the current fix out of
  // each warning text. It is a handful of cached requests at most.
  await Promise.all(
    storms.map(async (s) => {
      try {
        const txt = await cached(`jtwc:txt:${s.id}`, 10 * 60 * 1000, () =>
          fetchJSON(s._warningUrl, { text: true, timeout: 12000 }),
        );
        const first = parseJTWCWarning(txt)[0];
        if (!first) return;
        Object.assign(s, {
          lat: first.lat,
          lon: first.lon,
          windMph: first.windMph,
          gustMph: first.gustMph,
          ...categorize(first.windMph),
        });
        const move = txt.match(/MOVEMENT PAST SIX HOURS\s*-\s*(\d+)\s*DEGREES AT\s*(\d+)\s*KTS/i);
        if (move) {
          s.movementDir = Number(move[1]);
          s.movementMph = Math.round(ktToMph(Number(move[2])));
        }
      } catch {
        /* leave the storm listed without a fix rather than dropping it */
      }
    }),
  );
  return storms;
}

/* ------------------------------------------------------------------ cone --- */

/**
 * Build the cone of uncertainty: the envelope of circles centred on each
 * forecast point whose radius is that lead time's average track error.
 */
export function buildCone(points, basinKey) {
  const table = CONE_RADII_NM[basinKey] || CONE_RADII_NM.atlantic;
  const hours = Object.keys(table).map(Number).sort((a, b) => a - b);
  const radiusFor = (hour) => {
    if (hour <= 0) return 0;
    if (hour >= hours[hours.length - 1]) return table[hours[hours.length - 1]];
    for (let i = 0; i < hours.length - 1; i++) {
      if (hour >= hours[i] && hour <= hours[i + 1]) {
        const t = (hour - hours[i]) / (hours[i + 1] - hours[i]);
        return table[hours[i]] + t * (table[hours[i + 1]] - table[hours[i]]);
      }
    }
    return table[hours[0]] * (hour / hours[0]);
  };

  const circles = points
    .filter((p) => p.lat != null && p.hour != null)
    .map((p) => ({
      lat: p.lat,
      lon: p.lon,
      miles: radiusFor(p.hour) * NM_TO_MILES,
    }));
  if (circles.length < 2) return null;

  // Convex-hull-style envelope: sample every circle, then take the outer ring.
  const samples = [];
  for (const c of circles) {
    for (let b = 0; b < 360; b += 10) {
      const pt = offsetMiles(c.lat, c.lon, Math.max(c.miles, 1), b);
      samples.push([pt.lon, pt.lat]);
    }
  }
  return { polygon: convexHull(samples), circles };
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/* ------------------------------------------------------------------- API --- */

export async function listStorms() {
  const [nhc, jtwc] = await Promise.all([
    nhcStorms().catch(() => []),
    jtwcStorms().catch(() => []),
  ]);
  // Systems still under warning first, strongest first; anything on its final
  // bulletin sinks to the end of the picker rather than leading it.
  const all = [...nhc, ...jtwc].sort(
    (a, b) => Number(!!a.finalWarning) - Number(!!b.finalWarning) || (b.windMph || 0) - (a.windMph || 0),
  );
  return all.map(({ _forecastAdvisoryUrl, _publicAdvisoryUrl, _warningUrl, ...rest }) => rest);
}

export async function getStorm(id) {
  const [nhc, jtwc] = await Promise.all([
    nhcStorms().catch(() => []),
    jtwcStorms().catch(() => []),
  ]);
  const storm = [...nhc, ...jtwc].find((s) => s.id === id);
  if (!storm) return null;

  let track = [];
  let advisoryText = null;
  try {
    if (storm.agency === 'NHC' && storm._forecastAdvisoryUrl) {
      const [fcst, pub] = await Promise.all([
        cached(`nhc:fcst:${id}`, 5 * 60 * 1000, () => fetchJSON(storm._forecastAdvisoryUrl, { text: true })),
        storm._publicAdvisoryUrl
          ? cached(`nhc:pub:${id}`, 5 * 60 * 1000, () => fetchJSON(storm._publicAdvisoryUrl, { text: true })).catch(() => null)
          : Promise.resolve(null),
      ]);
      track = parseNHCForecastAdvisory(stripTags(fcst));
      advisoryText = stripTags(pub || fcst);
    } else if (storm._warningUrl) {
      const txt = await cached(`jtwc:txt:${id}`, 10 * 60 * 1000, () => fetchJSON(storm._warningUrl, { text: true }));
      track = parseJTWCWarning(txt);
      advisoryText = txt;
    }
  } catch (err) {
    advisoryText = `Advisory text could not be retrieved: ${err.message}`;
  }

  const current = track[0];
  const merged = {
    ...storm,
    lat: storm.lat ?? current?.lat ?? null,
    lon: storm.lon ?? current?.lon ?? null,
    windMph: storm.windMph ?? current?.windMph ?? null,
    gustMph: storm.gustMph ?? current?.gustMph ?? null,
  };
  delete merged._forecastAdvisoryUrl;
  delete merged._publicAdvisoryUrl;
  delete merged._warningUrl;

  return {
    ...merged,
    ...categorize(merged.windMph),
    track,
    cone: buildCone(track, storm.basinKey),
    windRadii: current?.radii || null,
    advisoryText,
    coneNote:
      storm.agency === 'NHC'
        ? 'Cone drawn from the official NHC forecast track and this season’s published average track-error radii.'
        : 'JTWC does not publish a cone; this envelope uses JTWC average track errors and is indicative only.',
  };
}

function stripTags(html) {
  if (!html) return html;
  if (!/<\w+[^>]*>/.test(html)) return html;
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const body = pre ? pre[1] : html;
  return body
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}
