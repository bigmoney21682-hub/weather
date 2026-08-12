// Sunrise and sunset from first principles.
//
// The National Weather Service publishes forecasts but not solar times, and the
// feed that used to supply them is the one we are trying to stop depending on.
// This is the NOAA solar position algorithm, which is a few dozen lines of
// arithmetic and needs no network at all — so the sun is one thing that can
// never be rate limited.
//
// Accurate to well under a minute at the latitudes anyone lives at. It drifts
// near the poles, where the sun crosses the horizon at a very shallow angle, and
// returns null where it does not cross at all.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// The centre of the sun is 0.833° below the horizon at the moment we call it
// risen: half a degree of solar disc, plus a third of a degree of atmospheric
// refraction lifting the image of it into view.
const ZENITH = 90.833;

/** Julian day at 00:00 UT on a Gregorian calendar date. */
function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/**
 * Solar declination and the equation of time for a Julian day.
 * The equation of time is the gap between clock noon and the sun's actual noon,
 * which swings by a quarter of an hour across the year and is the reason the
 * earliest sunset is not on the shortest day.
 */
function solarPosition(jd) {
  const t = (jd - 2451545) / 36525;
  const meanLong = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289;
  const trueLong = meanLong + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = obliq + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(apparentLong * RAD)) * DEG;

  const vy = Math.tan((obliqCorr / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (vy * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 * eccent * vy * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * vy * vy * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD));

  return { declination, eqTime };
}

/**
 * Sunrise and sunset as instants, for the UT date given.
 * Returns nulls through a polar summer or winter, when the sun does not cross
 * the horizon on that date at all.
 */
function eventsForUtcDate(year, month, day, lat, lon) {
  const jd = julianDay(year, month, day);
  const midnight = Date.UTC(year, month - 1, day);

  /**
   * Minutes from UT midnight to the event, for a sun whose position is read at
   * `atMinutes` into the day. `sign` is +1 for sunrise and -1 for sunset: the
   * two are the same solar hour angle either side of local noon.
   */
  const solve = (sign, atMinutes) => {
    const { declination, eqTime } = solarPosition(jd + atMinutes / 1440);
    const cosHourAngle =
      Math.cos(ZENITH * RAD) / (Math.cos(lat * RAD) * Math.cos(declination * RAD)) -
      Math.tan(lat * RAD) * Math.tan(declination * RAD);
    if (cosHourAngle > 1 || cosHourAngle < -1) return null;
    const hourAngle = Math.acos(cosHourAngle) * DEG;
    // Longitude is positive east, and every degree of it is four minutes of
    // solar time.
    return 720 - 4 * (lon + sign * hourAngle) - eqTime;
  };

  /**
   * Read the sun's position at midnight, use that to guess when the event is,
   * then read it again at the guess. The declination moves through the day, and
   * where the sun crosses the horizon at a shallow angle a small error in it
   * becomes a large error in the time — eight minutes at Barrow before this
   * second pass, well under one after it.
   */
  const refine = (sign) => {
    const first = solve(sign, 720);
    if (first == null) return null;
    const second = solve(sign, first);
    return second == null ? null : new Date(midnight + second * 60000);
  };

  const sunrise = refine(1);
  const sunset = refine(-1);
  if (!sunrise || !sunset) return { sunrise: null, sunset: null };
  return { sunrise, sunset };
}

/** The calendar date an instant falls on, in a named zone, as [y, m, d]. */
function dateInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return [get('year'), get('month'), get('day')];
}

/**
 * Sunrise and sunset for a *local* calendar date at a point.
 *
 * The algorithm works in UT, and far enough east or west the two calendars
 * disagree about which day it is — Tokyo's Tuesday sunrise happens on Monday in
 * UT. So the answer is checked against the zone it was asked about and the
 * calculation shifted a day if it landed on the wrong one.
 *
 * @param {[number, number, number]} localDate `[year, month, day]`, month 1-12
 */
export function sunTimes(localDate, lat, lon, timeZone) {
  const [y, m, d] = localDate;
  for (const shift of [0, -1, 1]) {
    const at = new Date(Date.UTC(y, m - 1, d + shift));
    const { sunrise, sunset } = eventsForUtcDate(
      at.getUTCFullYear(),
      at.getUTCMonth() + 1,
      at.getUTCDate(),
      lat,
      lon,
    );
    if (!sunrise) continue;
    const [ry, rm, rd] = dateInZone(sunrise, timeZone);
    if (ry === y && rm === m && rd === d) return { sunrise, sunset };
  }
  // Either a polar day, or a latitude where the sun rises and sets either side
  // of a local midnight and no UT date lands cleanly on this one.
  return { sunrise: null, sunset: null };
}
