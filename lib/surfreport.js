// The surf report in words: "waist to chest high and choppy", the way a surfer
// would say it, for right now and for each of the next few days.
//
// Two sources, kept apart on the card because they are different kinds of
// claim:
//
//   - A report written here from the same numbers as the rest of the section —
//     the marine model's waves, the forecast grid's wind, the beach's own
//     facing. It covers any spot, anywhere, hour by hour.
//   - The National Weather Service's Surf Zone Forecast, which is written by a
//     forecaster at the local office. It is coarser (a whole county of beach,
//     today and tomorrow) but it is a person's judgement, with rip current risk
//     and any surf advisory in it.
//
// The commercial surf sites are not used: their reports sit behind accounts and
// terms of use that forbid exactly this, and none offer a keyless feed.

import { cached, fetchJSON, offsetMiles } from './util.js';
import { nwsState } from './nwsforecast.js';
import { inNWSCoverage } from './alerts.js';

const NWS = 'https://api.weather.gov';

/* ------------------------------------------------------------- language --- */

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** 0 when two bearings agree, 180 when they are opposite. */
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * What the model's wave height looks like on the face of a breaking wave.
 *
 * The model's number is significant wave height out in open water. A long
 * period swell stands up much taller than that when it reaches the sand; short
 * wind chop arrives smaller. The factors are the rule of thumb surf forecasters
 * use, not a physical model — the words that come out of them are ranges for
 * that reason.
 */
function faceFt(waveFt, periodS) {
  if (waveFt == null) return null;
  const t = periodS ?? 8;
  const k = t < 6 ? 0.7 : t < 8 ? 0.85 : t < 10 ? 1 : t < 12 ? 1.15 : t < 14 ? 1.3 : 1.45;
  return waveFt * k;
}

// Upper bound of each band, in feet of face, measured against a standing adult.
const BODY = [
  [1.25, 'ankle', true],
  [2, 'knee', true],
  [2.75, 'thigh', true],
  [3.5, 'waist', true],
  [4.5, 'chest', true],
  [5.25, 'shoulder', true],
  [6.5, 'head', true],
  [8, 'overhead', false],
  [11, 'well overhead', false],
  [15, 'double overhead', false],
  [Infinity, 'triple overhead', false],
];

const band = (ft) => BODY.find(([max]) => ft < max);

/** "Waist to chest high (3–4 ft)", or "Flat". */
export function sizeWords(face) {
  if (face == null) return null;
  if (face < 0.75) return { text: 'Flat', short: 'flat', lo: 0, hi: 0 };
  const lo = Math.max(1, Math.round(face * 0.8));
  const hi = Math.max(lo + 1, Math.round(face * 1.2));
  const a = band(Math.max(face * 0.85, 0.8));
  const b = band(face * 1.15);
  const words =
    a === b
      ? `${a[1]}${a[2] ? ' high' : ''}`
      : `${a[1]}${a[2] && !b[2] ? ' high' : ''} to ${b[1]}${b[2] ? ' high' : ''}`;
  return { text: `${cap(words)} (${lo}–${hi} ft)`, short: words, lo, hi };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * How the wind leaves the water's surface at a beach that faces `seaward`.
 *
 * Wind direction is where the wind comes from, so a wind from the seaward
 * bearing is blowing straight onshore and one from behind the beach is
 * offshore — which holds the wave faces up and grooms them.
 */
export function texture(windMph, windDir, seaward) {
  if (windMph == null) return null;
  if (windMph <= 4) return { word: 'glassy', score: 3, relation: null };
  if (windDir == null || seaward == null) {
    // No facing to measure against: speed is all that can be said.
    if (windMph <= 8) return { word: 'fairly clean', score: 2, relation: null };
    if (windMph <= 15) return { word: 'bumpy', score: 1, relation: null };
    return { word: 'choppy', score: 0.5, relation: null };
  }
  const rel = angleBetween(windDir, seaward);
  if (rel > 145) {
    return windMph <= 20
      ? { word: 'clean', score: 3, relation: 'offshore' }
      : { word: 'clean but wind-blown', score: 2, relation: 'strong offshore' };
  }
  if (rel > 110) return windMph <= 15 ? { word: 'clean', score: 2.5, relation: 'side-offshore' } : { word: 'a bit bumpy', score: 1.5, relation: 'side-offshore' };
  if (rel > 80) return windMph <= 8 ? { word: 'fairly clean', score: 2, relation: 'cross-shore' } : windMph <= 14 ? { word: 'bumpy', score: 1, relation: 'cross-shore' } : { word: 'choppy', score: 0.5, relation: 'cross-shore' };
  if (rel > 45) return windMph <= 7 ? { word: 'fairly clean', score: 2, relation: 'side-onshore' } : windMph <= 13 ? { word: 'bumpy', score: 1, relation: 'side-onshore' } : windMph <= 19 ? { word: 'choppy', score: 0.5, relation: 'side-onshore' } : { word: 'blown out', score: 0, relation: 'side-onshore' };
  return windMph <= 8 ? { word: 'a little textured', score: 1.5, relation: 'onshore' } : windMph <= 14 ? { word: 'choppy', score: 0.5, relation: 'onshore' } : { word: 'blown out', score: 0, relation: 'onshore' };
}

function windPhrase(windMph, windDir, tex) {
  if (windMph == null) return null;
  if (windMph <= 4) return 'light and variable winds';
  const from = windDir != null ? `${compass(windDir)} ` : '';
  return `${from}winds ${Math.round(windMph)} mph${tex?.relation ? ` (${tex.relation})` : ''}`;
}

function swellPhrase(periodS, dirDeg) {
  if (periodS == null) return null;
  const p = Math.round(periodS);
  const kind = p < 7 ? 'wind swell' : p < 11 ? 'swell' : 'groundswell';
  return `${p}-second ${dirDeg != null ? `${compass(dirDeg)} ` : ''}${kind}`;
}

const RATINGS = ['Poor', 'Poor', 'Poor to fair', 'Fair', 'Fair to good', 'Good', 'Very good'];

function rating(face, tex, periodS) {
  if (face == null) return null;
  if (face < 0.75) return 'Flat';
  const size = face < 1.5 ? 0 : face < 2.5 ? 1 : face < 3.5 ? 2 : face < 6 ? 3 : 3.5;
  // Long-period swell has push behind it; short-period swell is weak and
  // closely spaced however tall it gets.
  const period = (periodS ?? 8) >= 11 ? 0.5 : (periodS ?? 8) < 8 ? -0.5 : 0;
  // Without wind the size is the whole story, scored as if middling.
  const surface = tex ? tex.score : 1.5;
  const score = Math.round(size + surface + period - 0.5);
  // Size cannot rescue a blown-out sea: it is just more of a mess.
  const cap = surface === 0 ? 1 : surface <= 0.5 ? 2 : 6;
  return RATINGS[Math.max(0, Math.min(cap, score))];
}

/* ------------------------------------------------------------- the hours --- */

/** The marine hours with the grid's wind laid onto them. */
function joinHours(hourly, windHours) {
  const wind = new Map((windHours || []).map((h) => [h.epoch, h]));
  return hourly.map((h) => {
    const w = wind.get(h.epoch);
    // The swell that sets the size is whichever train carries the energy.
    const swellLeads = (h.swellFt ?? 0) >= (h.windWaveFt ?? 0);
    const periodS = swellLeads ? (h.swellPeriodS ?? h.periodS) : h.periodS;
    return {
      ...h,
      date: h.time.slice(0, 10),
      hour: Number(h.time.slice(11, 13)),
      face: faceFt(h.waveFt, periodS),
      sizePeriodS: periodS,
      windMph: w?.windMph ?? null,
      windDir: w?.windDir ?? null,
    };
  });
}

/** The mean of a run of hours — winds averaged as vectors, not as bearings. */
function summarise(hours, seaward) {
  const valid = hours.filter((h) => h.face != null);
  if (!valid.length) return null;
  const mean = (k) => valid.reduce((a, h) => a + (h[k] ?? 0), 0) / valid.length;
  // The typical wave across the hours, not the peak: one big hour at dusk
  // should not set the size for a whole morning.
  const face = mean('face');
  const windy = valid.filter((h) => h.windMph != null);
  let windMph = null;
  let windDir = null;
  if (windy.length) {
    windMph = windy.reduce((a, h) => a + h.windMph, 0) / windy.length;
    const withDir = windy.filter((h) => h.windDir != null);
    if (withDir.length) {
      const x = withDir.reduce((a, h) => a + Math.sin((h.windDir * Math.PI) / 180), 0);
      const y = withDir.reduce((a, h) => a + Math.cos((h.windDir * Math.PI) / 180), 0);
      windDir = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
    }
  }
  const lead = valid[Math.floor(valid.length / 2)];
  const tex = texture(windMph, windDir, seaward);
  return {
    face,
    size: sizeWords(face),
    tex,
    windMph,
    windDir,
    periodS: mean('sizePeriodS'),
    dirDeg: lead.swellFt >= (lead.windWaveFt ?? 0) ? (lead.dirDeg ?? null) : lead.dirDeg,
    rating: rating(face, tex, mean('sizePeriodS')),
  };
}

function tideClock(localIso) {
  const [h, m] = localIso.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** One sentence for a half day: "Clean with light W winds (offshore)." */
function surfaceSentence(s) {
  if (!s?.tex) return null;
  const wind = windPhrase(s.windMph, s.windDir, s.tex);
  return `${cap(s.tex.word)}${wind ? ` with ${wind}` : ''}`;
}

/**
 * The written report: what it is like now, how the rest of today goes, and a
 * paragraph for each day after.
 */
export function writeReport({ hourly, windHours, seaward, tides }) {
  if (!hourly?.length) return null;
  const hours = joinHours(hourly, windHours);
  const nowSec = Date.now() / 1000;
  const nowIdx = hours.reduce((best, h, i) => (Math.abs(h.epoch - nowSec) < Math.abs(hours[best].epoch - nowSec) ? i : best), 0);
  const now = hours[nowIdx];
  const today = now.date;

  const current = summarise([now], seaward);
  if (!current) return null;

  const parts = [];
  parts.push(
    `${current.size.text}${current.tex ? ` and ${current.tex.word}` : ''}` +
      `${current.windMph != null ? `, ${windPhrase(current.windMph, current.windDir, current.tex)}` : ''}.`,
  );
  const swell = swellPhrase(now.sizePeriodS, now.dirDeg);
  if (swell) {
    const chop = (now.windWaveFt ?? 0) > (now.swellFt ?? 0) * 0.8 && (now.windWaveFt ?? 0) >= 1;
    parts.push(`${cap(swell)}${chop ? ', with plenty of local wind chop on top' : ''}.`);
  }
  // Tide times are the station's wall clock; so is the marine hour, which gives
  // the offset to read "now" on that same clock to the minute.
  const offsetMs = Date.parse(`${now.time}:00Z`) - now.epoch * 1000;
  const localNow = new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
  const nextTide = (tides || []).find((t) => t.time > localNow);
  if (nextTide) parts.push(`${nextTide.kind} tide at ${tideClock(nextTide.time)}${nextTide.time.slice(0, 10) === today ? '' : ' tomorrow'}.`);

  // The rest of today's daylight, as one look ahead.
  let later = null;
  const rest = hours.filter((h, i) => i > nowIdx + 1 && h.date === today && h.hour >= 6 && h.hour <= 18);
  if (rest.length >= 2) {
    const s = summarise(rest, seaward);
    const when = now.hour < 11 ? 'This afternoon' : 'Later today';
    const grew = s.size.short !== current.size.short ? `${s.face > current.face ? 'building to' : 'easing to'} ${s.size.short}` : 'holding size';
    const surface = s.tex && s.tex.word !== current.tex?.word ? `, turning ${s.tex.word}${s.windMph != null ? ` as the wind goes ${compass(s.windDir ?? 0)} ${Math.round(s.windMph)} mph` : ''}` : '';
    later = `${when}: ${grew}${surface}.`;
  }

  // Each day after today, split into the two sessions people actually plan.
  const days = [];
  const dates = [...new Set(hours.map((h) => h.date))].filter((d) => d > today);
  for (const date of dates.slice(0, 3)) {
    const am = summarise(hours.filter((h) => h.date === date && h.hour >= 6 && h.hour < 12), seaward);
    const pm = summarise(hours.filter((h) => h.date === date && h.hour >= 12 && h.hour <= 18), seaward);
    const day = summarise(hours.filter((h) => h.date === date && h.hour >= 6 && h.hour <= 18), seaward);
    if (!day) continue;

    const bits = [`${day.size.text}.`];
    const sw = swellPhrase(day.periodS, day.dirDeg);
    if (sw) bits.push(`${cap(sw)}.`);
    if (am?.tex && pm?.tex) {
      if (am.tex.word === pm.tex.word) {
        bits.push(`${surfaceSentence(day)} through the day.`);
      } else {
        bits.push(`${surfaceSentence(am)} in the morning, ${pm.tex.word} in the afternoon${pm.windMph != null ? ` (${windPhrase(pm.windMph, pm.windDir, null)})` : ''}.`);
      }
      const better = am.tex.score > pm.tex.score + 0.5 ? 'Go early.' : pm.tex.score > am.tex.score + 0.5 ? 'The afternoon is the better session.' : null;
      if (better) bits.push(better);
    }
    if (am?.size && pm?.size && am.size.short !== pm.size.short && pm.size.short !== day.size.short) {
      bits.push(`${pm.face > am.face ? 'Building' : 'Dropping'} to ${pm.size.short} by the afternoon.`);
    }
    days.push({
      date,
      label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      rating: day.rating,
      text: bits.join(' '),
    });
  }

  return {
    rating: current.rating,
    now: parts.join(' '),
    later,
    days,
    hasWind: current.windMph != null,
  };
}

/* --------------------------------------------------- NWS surf zone text --- */

/**
 * Expand a UGC line — "HIZ006-007-009-032>035-250230-" — into zone ids.
 * The trailing six digits are the expiry, not a zone.
 */
function expandUgc(line) {
  const out = [];
  let prefix = '';
  for (const tok of line.replace(/\s+/g, '').split('-')) {
    if (!tok || /^\d{6}$/.test(tok)) continue;
    const m = tok.match(/^([A-Z]{2}[ZC])?(\d{3})(?:>(\d{3}))?$/);
    if (!m) continue;
    if (m[1]) prefix = m[1];
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    for (let n = from; n <= to && n - from < 200; n++) out.push(`${prefix}${String(n).padStart(3, '0')}`);
  }
  return out;
}

/** "Rip Current Risk*...........High." lines, with their wrapped continuations. */
function readFields(block) {
  const fields = {};
  let current = null;
  for (const raw of block.split('\n')) {
    const m = raw.match(/^([A-Z][A-Za-z ]+?)\**\.{3,}\s*(.*)$/);
    if (m) {
      current = m[1].trim();
      fields[current] = m[2].trim();
      continue;
    }
    if (current && /^\s{6,}\S/.test(raw)) fields[current] += ` ${raw.trim()}`;
    else if (!raw.trim()) current = null;
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].replace(/\s+/g, ' ').trim();
  return fields;
}

/** The shore-facing table Honolulu uses in place of a single surf height. */
function readShoreTable(text, seaward) {
  const lines = text.split('\n');
  const shores = lines.findIndex((l) => /^Shores\s+Surf/.test(l));
  if (shores < 0) return null;
  // The period names sit a line or two above, past a blank and the rule.
  let above = shores - 1;
  while (above > 0 && (!lines[above].trim() || /^_+$/.test(lines[above].trim()))) above--;
  const names = (lines[above] || '').trim().split(/\s{2,}/).filter(Boolean);
  const halves = (lines[shores + 1] || '').trim().split(/\s+/).filter(Boolean);
  if (!names.length || halves.length !== names.length * 2) return null;
  const face = seaward == null ? null : ['North', 'East', 'South', 'West'][Math.round((((seaward % 360) + 360) % 360) / 90) % 4];
  const rows = lines.slice(shores + 2).map((l) => l.match(/^(North|East|South|West) Facing\s+(.*)$/)).filter(Boolean);
  const row = rows.find((r) => r[1] === face) || null;
  if (!row) return null;
  const values = row[2].trim().split(/\s+/);
  const when = halves.map((h, i) => `${names[Math.floor(i / 2)]} ${h === 'AM' ? 'morning' : h === 'PM' ? 'afternoon' : h}`);
  return {
    facing: `${row[1]}-facing shores`,
    surf: values.slice(0, when.length).map((v, i) => ({ when: when[i].replace(/Tonight afternoon/, 'tonight').replace(/Tonight morning/, 'overnight').replace(/^Today/, 'today'), feet: v.replace('-', '–') })),
  };
}

function parseSegment(seg) {
  const ugcMatch = seg.match(/^((?:[A-Z]{2}[ZC]\d{3}[\d>\-]*\n?)+?-?\d{6}-)\s*$/m);
  if (!ugcMatch) return null;
  const zones = expandUgc(ugcMatch[1]);
  const after = seg.slice(ugcMatch.index + ugcMatch[0].length).replace(/^\n/, '');
  const head = [];
  let i = 0;
  const lines = after.split('\n');
  for (; i < lines.length; i++) {
    if (/^\d{3,4} (AM|PM) /.test(lines[i])) break;
    if (lines[i].trim()) head.push(lines[i].trim().replace(/-$/, ''));
  }
  const body = lines.slice(i + 1).join('\n');
  const beachesAt = head.findIndex((h) => /^Including/i.test(h));
  const names = beachesAt < 0 ? head : head.slice(0, beachesAt);
  const beaches = beachesAt < 0 ? null : head.slice(beachesAt).join(' ').replace(/\s+/g, ' ');

  const firstPeriod = body.search(/^\.[A-Z][A-Z .]*\.\.\.\s*$/m);
  const preamble = firstPeriod < 0 ? body : body.slice(0, firstPeriod);
  const headlines = [...preamble.matchAll(/^\.\.\.([\s\S]+?)\.\.\.\s*$/gm)].map((m) => m[1].replace(/\s+/g, ' ').trim());

  const periods = [];
  if (firstPeriod >= 0) {
    const rest = body.slice(firstPeriod).split(/^&&\s*$/m)[0];
    const chunks = rest.split(/^\.([A-Z][A-Z .]*?)\.\.\.\s*$/m).slice(1);
    for (let k = 0; k < chunks.length; k += 2) {
      const name = chunks[k].trim();
      const fields = readFields(chunks[k + 1] || '');
      const prose = Object.keys(fields).length ? null : (chunks[k + 1] || '').replace(/\s+/g, ' ').trim();
      periods.push({ name: cap(name.toLowerCase()), fields, prose });
    }
  }
  return { zones, names, beaches, headlines, periods, preamble };
}

async function latestSrf(office) {
  return cached(
    `nws:srf:${office}`,
    20 * 60 * 1000,
    async () => {
      const list = await fetchJSON(`${NWS}/products/types/SRF/locations/${office}`);
      const latest = list?.['@graph']?.[0];
      if (!latest?.id) return null;
      const product = await fetchJSON(`${NWS}/products/${latest.id}`);
      return { text: product?.productText || '', issued: latest.issuanceTime };
    },
    { errorTtlMs: 60 * 1000 },
  );
}

async function zonesAt(lat, lon) {
  return cached(`nws:zonesAt:${lat.toFixed(3)}:${lon.toFixed(3)}`, 30 * 24 * 3600 * 1000, async () => {
    const data = await fetchJSON(`${NWS}/zones?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
    return (data?.features || [])
      .map((f) => f.properties)
      .filter((p) => p?.type === 'public' || p?.type === 'county')
      .map((p) => ({ id: p.id, name: p.name }));
  });
}

const norm = (s) => s.toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z]+/g, ' ').trim();

/**
 * The local office's written surf forecast for the stretch of coast a beach is
 * on, or null where there is none (outside the US, or an office that does not
 * issue one).
 */
export async function surfZoneForecast(lat, lon, seaward) {
  if (!inNWSCoverage(lat, lon)) return null;
  const { office } = await nwsState(lat, lon);
  if (!office) return null;
  const srf = await latestSrf(office);
  if (!srf?.text) return null;
  // A day and a half old is yesterday's forecast; better to show nothing.
  if (Date.now() - Date.parse(srf.issued) > 36 * 3600 * 1000) return null;

  // A point on the waterline can fall just outside the land zone's polygon, so
  // ask again a few hundred yards inland when the first answer has no zone.
  let zones = await zonesAt(lat, lon).catch(() => []);
  if (!zones.length && seaward != null) {
    const inland = offsetMiles(lat, lon, 0.3, (seaward + 180) % 360);
    zones = await zonesAt(inland.lat, inland.lon).catch(() => []);
  }
  if (!zones.length) return null;

  const text = srf.text.replace(/\r/g, '');
  const segments = text.split(/^\$\$\s*$/m).map(parseSegment).filter(Boolean);
  const ids = new Set(zones.map((z) => z.id));
  // Offices draw their beach zones differently from their public zones; when no
  // id matches, the segment carrying the zone's name is the same stretch.
  const seg =
    segments.find((s) => s.zones.some((z) => ids.has(z))) ||
    segments.find((s) => s.names.some((n) => zones.some((z) => z.name && norm(n) && (norm(n).includes(norm(z.name)) || norm(z.name).includes(norm(n))))));
  if (!seg) return null;

  const discussion = text.match(/^\.DISCUSSION\.\.\.\s*\n([\s\S]+?)(?=^\s*$\n^[A-Z]{2}[ZC]\d{3})/m)?.[1]?.replace(/\s+/g, ' ').trim() || null;
  const office_name = text.match(/National Weather Service ([^\n]+)/)?.[1]?.trim() || office;

  const KEEP = ['Surf Height', 'Surf', 'Rip Current Risk', 'Winds', 'Weather', 'Water Temperature', 'Remarks', 'Swell', 'Wave Height'];
  return {
    office: office_name,
    issued: srf.issued,
    // Some offices still write segment names in capitals.
    area: seg.names.map((n) => (n === n.toUpperCase() ? n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : n)).join(', '),
    beaches: seg.beaches,
    headlines: seg.headlines,
    discussion,
    shoreTable: readShoreTable(seg.preamble, seaward),
    periods: seg.periods
      .map((p) => ({
        name: p.name,
        prose: p.prose,
        fields: KEEP.filter((k) => p.fields[k]).map((k) => ({ label: k, value: p.fields[k] })),
      }))
      .filter((p) => p.fields.length || p.prose)
      .slice(0, 3),
    link: `https://forecast.weather.gov/product.php?site=${office}&issuedby=${office}&product=SRF`,
  };
}
