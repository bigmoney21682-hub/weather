// Ocean quality: what the water at the nearest beach is actually like today.
//
// There is no national real-time bacteria feed — beach postings are made by
// state and county health departments on their own schedules, from lab cultures
// that take a day to grow. So this section does not pretend to be one. It puts
// together the things that *are* measured continuously and that a swimmer can
// act on:
//
//   * USGS NWIS   - dissolved oxygen, pH, turbidity, specific conductance and
//                   water temperature from real-time gauges, many of them in
//                   the tidal reaches and estuaries that drain onto a beach
//   * NOAA CO-OPS - observed water temperature (and salinity, at the minority
//                   of stations fitted for it) at the nearest tide station
//   * Open-Meteo  - sea surface temperature and ocean current at the beach, and
//                   the rain that has fallen on the watershed behind it
//   * NWS         - official beach hazard, rip current, high surf and water
//                   quality advisories in force nearby
//
// The score is a transparent deduction from 100, and every deduction is
// returned with the reading that caused it so the card can show its work. The
// heavyweight term is rainfall, because urban and agricultural runoff after
// rain is the single best-established predictor of bad beach water: health
// departments across the country issue standing "wait 24 to 72 hours after
// significant rain" advisories on exactly that basis.

import { cached, cToF, fetchJSON, haversineMiles, kmToMiles } from './util.js';
import { getNearbyAlerts } from './alerts.js';
import { nearestTideStation, stationLatest, surfableBeach } from './surf.js';

const OCEAN_ALERT_EVENTS = /beach|rip current|high surf|surf zone|water quality|swim|marine|red tide|tsunami/i;

// USGS parameter codes worth reading for water quality, and how to describe them.
const USGS_PARAMS = {
  '00300': { key: 'dissolvedOxygen', label: 'Dissolved oxygen', unit: 'mg/L' },
  '63680': { key: 'turbidity', label: 'Turbidity', unit: 'FNU' },
  '00400': { key: 'ph', label: 'pH', unit: '' },
  '00095': { key: 'conductance', label: 'Specific conductance', unit: 'µS/cm' },
  // NWIS reports Celsius; the rest of the dashboard is imperial throughout.
  '00010': { key: 'waterTempF', label: 'Water temperature', unit: '°F', convert: cToF },
};

// A gauge that last reported in 2019 is still in the response. Anything older
// than this is history, not conditions.
const USGS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Only gauges this close are allowed to move the score. Further out they are
// still worth listing as context, but they are not measuring your beach.
const SCORING_RADIUS_MILES = 15;

// Seawater runs about 50,000 µS/cm and fresh water under 1,500, so specific
// conductance tells us for free whether a gauge is sitting in the sea, in a
// brackish estuary, or in a storm drain that happens to be near the coast.
// That distinction matters: a canal's turbidity is not the beach's turbidity.
const BRACKISH_CONDUCTANCE = 5000;

const BANDS = [
  [85, 'Excellent', 'good', 'Nothing in the water data argues against getting in.'],
  [70, 'Good', 'good', 'Reasonable conditions for swimming.'],
  [55, 'Fair', 'moderate', 'Usable, but not the day for a long swim if you are prone to ear or stomach trouble.'],
  [40, 'Caution', 'usg', 'Conditions favour poor water quality. Keep your head up and rinse off afterwards.'],
  [22, 'Poor', 'unhealthy', 'Swimming is not advisable — wait for the water to settle and flush.'],
  [0, 'Avoid', 'hazardous', 'Stay out of the water and check with your local health department.'],
];

function band(score) {
  for (const [floor, label, cls, advice] of BANDS) {
    if (score >= floor) return { label, class: cls, advice };
  }
  return { label: 'Unknown', class: 'unknown', advice: null };
}

/* ------------------------------------------------------------------ USGS --- */

const JOINING_WORDS = new Set(['of', 'at', 'in', 'on', 'the', 'and', 'to', 'nr', 'near', 'abv', 'above', 'bl', 'below']);
const KEEP_UPPER = new Set(['us', 'sf', 'usa', 'usaa', 'la', 'nyc', 'jct', 'ph', 'wwtp', 'stp']);

/**
 * NWIS names sites in shouting caps — "BLACK CREEK CANAL EAST OF US1 NR
 * GOULDS, FL". Title-case them so they sit in a card without looking like an
 * error message, leaving anything with a digit in it (C-8, S-28, US1) and the
 * trailing state code alone.
 */
function titleCase(name) {
  if (!name) return name;
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  return name
    .trim()
    .split(/\s+/)
    .map((original, i) => {
      const word = original.toLowerCase();
      const bare = word.replace(/[.,]$/, '');
      // Anything with a digit is a structure or route number: C-8, S-28, US1.
      if (/\d/.test(word)) return original;
      // NWIS shouts the whole name, so case carries no signal and abbreviations
      // have to be named: the trailing state code, compass points, and a short
      // list of the ones that would otherwise read as words.
      const isLast = i === name.trim().split(/\s+/).length - 1;
      if (isLast && /^[a-z]{2},?$/.test(word)) return original;
      if (/^[nsew]{1,3}$/.test(bare) || KEEP_UPPER.has(bare)) return original;
      if (i > 0 && JOINING_WORDS.has(bare)) return word;
      // Hyphenated names get both halves: "richmond-san" → "Richmond-San".
      return word.split('-').map(cap).join('-');
    })
    .join(' ');
}

/** A box roughly `miles` on each side, in the lon/lat order NWIS expects. */
function bbox(lat, lon, miles) {
  const dLat = Math.min(0.45, miles / 69);
  const dLon = Math.min(0.45, miles / Math.max(1, 69 * Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((n) => n.toFixed(4)).join(',');
}

/**
 * Real-time water quality gauges near a point, newest reading per parameter.
 * Sites are returned nearest first with only the readings that are still fresh.
 */
async function usgsSites(lat, lon, miles) {
  const url =
    `https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=${bbox(lat, lon, miles)}` +
    `&parameterCd=${Object.keys(USGS_PARAMS).join(',')}&siteStatus=active`;

  // NWIS answers a healthy bounding-box query in well under a second, so a long
  // timeout with a retry only ever buys a longer wait for a request that is not
  // coming back. When it does fail, remember that for a few minutes: the caller
  // degrades to a gauge-less report, and without this every visitor pays the
  // whole timeout again to reach the same empty result.
  const data = await cached(
    `usgs:${lat.toFixed(2)}:${lon.toFixed(2)}`,
    20 * 60 * 1000,
    () => fetchJSON(url, { timeout: 8000, retries: 0 }),
    { errorTtlMs: 5 * 60 * 1000 },
  );

  const bySite = new Map();
  const cutoff = Date.now() - USGS_MAX_AGE_MS;

  for (const series of data?.value?.timeSeries || []) {
    const code = series.variable?.variableCode?.[0]?.value;
    const param = USGS_PARAMS[code];
    if (!param) continue;

    const rows = series.values?.[0]?.value || [];
    const last = rows[rows.length - 1];
    const value = Number(last?.value);
    const at = last?.dateTime ? Date.parse(last.dateTime) : NaN;
    // -999999 is NWIS's "sensor offline" sentinel.
    if (!Number.isFinite(value) || value <= -999999 || !Number.isFinite(at) || at < cutoff) continue;

    const info = series.sourceInfo || {};
    const id = info.siteCode?.[0]?.value;
    const geo = info.geoLocation?.geogLocation;
    if (!id || !geo) continue;

    if (!bySite.has(id)) {
      bySite.set(id, {
        id,
        name: titleCase(info.siteName),
        lat: geo.latitude,
        lon: geo.longitude,
        distanceMiles: Math.round(haversineMiles(lat, lon, geo.latitude, geo.longitude) * 10) / 10,
        readings: {},
      });
    }
    bySite.get(id).readings[param.key] = {
      value: param.convert ? param.convert(value) : value,
      unit: param.unit,
      label: param.label,
      time: last.dateTime,
    };
  }

  for (const site of bySite.values()) {
    const cond = site.readings.conductance?.value;
    site.kind = cond == null ? 'unknown' : cond >= BRACKISH_CONDUCTANCE ? 'coastal' : 'inflow';
  }

  return [...bySite.values()].sort((a, b) => a.distanceMiles - b.distanceMiles);
}

/* ---------------------------------------------------------------- runoff --- */

/** Rain on the watershed over the last day and three days, in inches. */
async function recentRain(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&hourly=precipitation&past_days=3&forecast_days=1&precipitation_unit=inch&timezone=auto';
  const data = await cached(`rain:${lat.toFixed(2)}:${lon.toFixed(2)}`, 30 * 60 * 1000, () =>
    fetchJSON(url, { timeout: 15000 }),
  );

  const offset = data?.utc_offset_seconds || 0;
  const times = data?.hourly?.time || [];
  const values = data?.hourly?.precipitation || [];
  const now = Date.now();

  let last24 = 0;
  let last72 = 0;
  const series = [];

  times.forEach((t, i) => {
    const epochMs = Date.parse(`${t}:00Z`) - offset * 1000;
    const mm = values[i];
    if (mm == null) return;
    series.push({ epoch: Math.floor(epochMs / 1000), inches: mm });
    const ageH = (now - epochMs) / 3600e3;
    if (ageH < 0) return; // forecast hours are not runoff that has happened
    if (ageH <= 24) last24 += mm;
    if (ageH <= 72) last72 += mm;
  });

  const round = (n) => Math.round(n * 100) / 100;
  return { last24: round(last24), last72: round(last72), series };
}

/* ---------------------------------------------------------------- marine --- */

const MARINE_CURRENT = 'sea_surface_temperature,wave_height,ocean_current_velocity,ocean_current_direction';

async function marineAt(lat, lon) {
  const url =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=${MARINE_CURRENT}&hourly=sea_surface_temperature,wave_height` +
    '&length_unit=imperial&timezone=auto&forecast_days=2';
  return cached(`ocean:marine:${lat.toFixed(2)}:${lon.toFixed(2)}`, 20 * 60 * 1000, () =>
    fetchJSON(url, { timeout: 20000 }),
  ).catch(() => null);
}

/* ----------------------------------------------------------------- score --- */

/**
 * Deduct from a clean 100 for each thing measurably wrong with the water, and
 * return the reasons alongside the number. Every threshold below is either a
 * published guideline (EPA's 5 mg/L dissolved oxygen for healthy aquatic life,
 * the 6.5–8.5 pH range, Vibrio risk rising above roughly 86 °F) or the standard
 * post-rain advisory window; none of it is a substitute for a lab culture.
 */
function scoreWater({ rain, turbidity: turb, dissolvedOxygen: oxy, ph: acidity, waterTempF, alerts }) {
  let score = 100;
  const factors = [];

  const deduct = (points, severity, title, detail) => {
    score -= points;
    factors.push({ severity, title, detail, points });
  };

  // A gauge reading means little without saying which gauge, and how far off.
  const at = (reading) => (reading ? ` Measured at ${reading.site}, ${reading.distanceMiles} mi away.` : '');
  const turbidity = turb?.value ?? null;
  const dissolvedOxygen = oxy?.value ?? null;
  const ph = acidity?.value ?? null;

  if (rain.last24 >= 1) {
    deduct(45, 'high', `${rain.last24.toFixed(2)}" of rain in the last 24 hours`,
      'Heavy runoff carries storm drains, septic overflow and farm and road washoff straight onto the beach. Most health departments advise staying out for 48–72 hours after rain like this.');
  } else if (rain.last24 >= 0.5) {
    deduct(30, 'high', `${rain.last24.toFixed(2)}" of rain in the last 24 hours`,
      'Enough to push storm drains onto the beach. The usual advice is to wait 24–48 hours, and to stay well clear of outfalls and river mouths.');
  } else if (rain.last24 >= 0.25) {
    deduct(18, 'medium', `${rain.last24.toFixed(2)}" of rain in the last 24 hours`,
      'Light runoff. Bacteria counts near drains and creek mouths typically rise for a day.');
  } else if (rain.last24 >= 0.1) {
    deduct(8, 'low', `${rain.last24.toFixed(2)}" of rain in the last 24 hours`,
      'A small amount of runoff — worth avoiding storm drains, but unlikely to affect open beach.');
  } else if (rain.last72 >= 1) {
    deduct(12, 'medium', `${rain.last72.toFixed(2)}" of rain in the last three days`,
      'The beach is still flushing out an earlier soaking, even though today is dry.');
  } else if (rain.last72 >= 0.4) {
    deduct(5, 'low', `${rain.last72.toFixed(2)}" of rain in the last three days`,
      'A little residual runoff from earlier in the week.');
  }

  if (turbidity != null) {
    if (turbidity >= 25) {
      deduct(25, 'high', `Turbidity ${Math.round(turbidity)} FNU`,
        `The water is heavily clouded with sediment. Bacteria ride on suspended particles and shelter from sunlight there, and you cannot see hazards underfoot.${at(turb)}`);
    } else if (turbidity >= 10) {
      deduct(14, 'medium', `Turbidity ${Math.round(turbidity)} FNU`,
        `Noticeably murky — sediment in the water usually means something has been stirred up or washed in.${at(turb)}`);
    } else if (turbidity >= 5) {
      deduct(6, 'low', `Turbidity ${turbidity.toFixed(1)} FNU`,
        `Slightly cloudy. Normal for a surf beach or an estuary on a windy day.${at(turb)}`);
    }
  }

  if (dissolvedOxygen != null) {
    if (dissolvedOxygen < 2) {
      deduct(30, 'high', `Dissolved oxygen ${dissolvedOxygen.toFixed(1)} mg/L`,
        `Hypoxic. Water this starved of oxygen kills fish and often accompanies an algal bloom or a decaying one.${at(oxy)}`);
    } else if (dissolvedOxygen < 4) {
      deduct(18, 'medium', `Dissolved oxygen ${dissolvedOxygen.toFixed(1)} mg/L`,
        `Well below the level healthy water holds — a sign the water is stagnant or loaded with nutrients.${at(oxy)}`);
    } else if (dissolvedOxygen < 5) {
      deduct(8, 'low', `Dissolved oxygen ${dissolvedOxygen.toFixed(1)} mg/L`,
        `Just under the EPA guideline of 5 mg/L for aquatic life.${at(oxy)}`);
    }
  }

  if (ph != null && (ph < 6.5 || ph > 8.6)) {
    deduct(10, 'medium', `pH ${ph.toFixed(1)}`,
      ph < 6.5
        ? `More acidic than natural seawater, which sits near 8.1. Usually acid runoff or a big freshwater input.${at(acidity)}`
        : `More alkaline than natural seawater. A heavy algal bloom drives pH up as it photosynthesises.${at(acidity)}`);
  }

  if (waterTempF != null && waterTempF >= 86) {
    deduct(10, 'medium', `Water temperature ${Math.round(waterTempF)}°F`,
      'Naturally occurring Vibrio bacteria multiply in warm coastal water. Worth knowing if you have an open cut or a weakened immune system.');
  }

  for (const a of alerts) {
    // No distance means a zone alert that already covers this point, which is
    // as close as an advisory gets.
    const here = a.distanceMiles == null || a.distanceMiles <= 10;
    deduct(here ? 22 : 10, 'high', a.event,
      `${a.headline || a.areaDesc || 'Official advisory in force'}${a.distanceMiles ? ` · ${a.distanceMiles} mi away` : ''}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!factors.length) {
    factors.push({
      severity: 'none',
      title: 'Nothing adverse in the current readings',
      detail: 'No recent runoff, no advisories in force, and the gauges nearby are reading normally.',
      points: 0,
    });
  }
  return { score, factors, ...band(score) };
}

/**
 * What the rating is actually standing on. A perfect 100 built from nothing but
 * "it did not rain" is worse than useless — it reads as an all-clear on water
 * nobody measured. Somewhere with no sea, no gauge and no observed temperature
 * gets no score at all.
 */
function unrated(reason) {
  return {
    score: null,
    label: 'Not rated',
    class: 'unknown',
    advice: reason,
    factors: [],
  };
}

/* ------------------------------------------------------------------- API --- */

export async function getOceanQuality(lat, lon, { radiusMiles = 60 } = {}) {
  // Like surf, this is a report on a beach rather than on wherever the user
  // lives, so everything downstream is anchored on the nearest one.
  const beach = await surfableBeach(lat, lon).catch(() => null);
  const originLat = beach?.lat ?? lat;
  const originLon = beach?.lon ?? lon;

  const [marine, station, sites, rain, alerts] = await Promise.all([
    marineAt(originLat, originLon),
    nearestTideStation(originLat, originLon).catch(() => null),
    usgsSites(originLat, originLon, radiusMiles).catch(() => []),
    recentRain(originLat, originLon).catch(() => ({ last24: 0, last72: 0, series: [] })),
    getNearbyAlerts(lat, lon, radiusMiles, OCEAN_ALERT_EVENTS).catch(() => []),
  ]);

  const [observed, salinity] = station
    ? await Promise.all([stationLatest(station, 'water_temperature'), stationLatest(station, 'salinity')])
    : [null, null];

  const cur = marine?.current || {};
  const modelTempF = cToF(cur.sea_surface_temperature);
  const waterTempF = observed?.value ?? modelTempF;
  const waterTempSource = observed
    ? `Observed at ${station.name} (${station.distanceMiles} mi)`
    : modelTempF != null
      ? 'Marine model (sea surface)'
      : null;

  // Gauges close enough, and in the right kind of water, to speak for the
  // beach. Everything else stays on the page as context but out of the score.
  const scoring = sites.filter((s) => s.distanceMiles <= SCORING_RADIUS_MILES && s.kind !== 'inflow');

  /** The nearest scoring gauge that reports `key`, tagged with where it is. */
  const pick = (key) => {
    for (const s of scoring) {
      if (s.readings[key]) {
        return { ...s.readings[key], site: s.name, distanceMiles: s.distanceMiles, kind: s.kind };
      }
    }
    return null;
  };
  const turbidity = pick('turbidity');
  const dissolvedOxygen = pick('dissolvedOxygen');
  const ph = pick('ph');
  const conductance = pick('conductance');

  // Sea surface temperature over the next two days, for the trend chart.
  const offset = marine?.utc_offset_seconds || 0;
  const hourly = (marine?.hourly?.time || []).map((t, i) => ({
    epoch: Math.floor(Date.parse(`${t}:00Z`) / 1000) - offset,
    waterTempF: cToF(marine.hourly.sea_surface_temperature[i]),
    waveFt: marine.hourly.wave_height[i],
  }));

  const hasSea = hourly.some((h) => h.waterTempF != null) || waterTempF != null;
  // A river gauge reporting nothing but its own temperature does not make an
  // inland lake ratable — it takes sea water, or a gauge actually measuring
  // water quality, before a number here means anything.
  const measured = [turbidity, dissolvedOxygen, ph].filter(Boolean);
  const rating =
    hasSea || measured.length
      ? scoreWater({
          rain,
          turbidity: turbidity?.value ?? null,
          dissolvedOxygen: dissolvedOxygen?.value ?? null,
          ph: ph?.value ?? null,
          waterTempF,
          alerts,
        })
      : unrated(
          `There is no sea, bay or estuary near ${beach?.name || 'this location'} that either the marine model or a ` +
            'real-time water quality gauge covers, so there is nothing here to rate.',
        );

  return {
    spot: beach && {
      name: beach.name,
      lat: beach.lat,
      lon: beach.lon,
      distanceMiles: beach.distanceMiles,
    },
    timezone: marine?.timezone || null,
    water: hourly.some((h) => h.waterTempF != null),
    rating,
    current: {
      waterTempF,
      waterTempSource,
      waveFt: cur.wave_height ?? null,
      currentMph: kmToMiles(cur.ocean_current_velocity),
      currentDirDeg: cur.ocean_current_direction ?? null,
      salinityPsu: salinity?.value ?? null,
      turbidity,
      dissolvedOxygen,
      ph,
      conductance,
    },
    rain,
    hourly,
    stations: sites.slice(0, 5),
    scoringRadiusMiles: SCORING_RADIUS_MILES,
    tideStation: station,
    alerts,
    radiusMiles,
    source:
      'Real-time gauges from USGS NWIS and NOAA Tides & Currents; sea surface temperature, currents and rainfall ' +
      'from Open-Meteo; advisories from the US National Weather Service.',
    disclaimer:
      'This is not a bacteria test. Enterococcus and E. coli counts come from lab cultures your state or county ' +
      'health department collects, usually weekly — check their beach postings before you swim.',
  };
}
