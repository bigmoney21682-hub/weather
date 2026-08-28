// Work out the surf spots for the busy coasts ahead of time, and commit them.
//
// Overpass allows two concurrent queries per IP. On a shared host that budget is
// already spent by whoever else is on the address: from Render's free instances
// the coastline query simply never gets a slot, so the live site could not find
// a single beach while the same query from a laptop answers in five seconds.
//
// The answer does not change between requests — coastlines do not move — so it
// does not have to be worked out at request time at all. This bakes the spot
// pool for a list of regions into data/surf-spots.json, which lib/surfspots.js
// reads in preference to asking Overpass anything. Coasts that are not baked
// still fall through to the live query, which is what a dev machine does.
//
//   node scripts/bake-surf-spots.js              # fill in what is missing
//   node scripts/bake-surf-spots.js --force      # rebuild every region
//   node scripts/bake-surf-spots.js "Tampa, FL"  # just the regions named
//
// It is deliberately slow. Overpass is a donated service and these are among
// the most expensive queries it answers.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spotPool } from '../lib/surfspots.js';
import { haversineMiles } from '../lib/util.js';

const OUT = path.join(process.cwd(), 'data', 'surf-spots.json');

// How far around each centre to gather. A viewer is served from the bake only
// when their whole search circle falls inside it, so this is the request radius
// (30 miles) plus the distance a viewer may sit from the centre.
const REGION_MILES = 60;

// Overpass hands out two query slots per IP and says when the next one frees up.
// Guessing at a fixed pause instead just spends the budget faster than it
// refills: a first pass at 20 seconds between regions failed two thirds of them,
// each failure having first burned a slot. Ask, wait the time it names, proceed.
const STATUS_URL = 'https://overpass-api.de/api/status';
const SLOTS_NEEDED = 2; // the coastline query and the spot query
const MAX_WAIT_MS = 180000;

/**
 * Block until Overpass will actually take a query.
 *
 * The status endpoint reports slots available now, or the times the running ones
 * expire. Anything unparseable falls back to a flat wait rather than charging in
 * — the endpoint changing shape should slow the bake down, not break it.
 */
async function waitForSlot() {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let text;
    try {
      text = await (await fetch(STATUS_URL, { headers: { 'User-Agent': 'weather-bake' } })).text();
    } catch {
      await sleep(30000);
      continue;
    }
    const now = Number(/(\d+) slots available now/.exec(text)?.[1] ?? NaN);
    if (Number.isFinite(now) && now >= SLOTS_NEEDED) return;

    const waits = [...text.matchAll(/in (-?\d+) seconds/g)].map((m) => Number(m[1]));
    // Enough slots free when the Nth-soonest expires, plus a second's grace.
    const need = waits.sort((a, b) => a - b)[SLOTS_NEEDED - 1 - (Number.isFinite(now) ? now : 0)];
    const secs = Math.min(Math.max(need ?? 30, 2), 90);
    process.stdout.write(`(waiting ${secs}s for an Overpass slot) `);
    await sleep(secs * 1000 + 1000);
  }
}

const ATTEMPTS = 3;

const REGIONS = [
  { name: 'West Palm Beach, FL', lat: 26.7153, lon: -80.0534 },
  { name: 'Miami, FL', lat: 25.7617, lon: -80.1918 },
  { name: 'Cocoa Beach, FL', lat: 28.3200, lon: -80.6076 },
  { name: 'Jacksonville, FL', lat: 30.2946, lon: -81.3931 },
  { name: 'Tampa, FL', lat: 27.9506, lon: -82.4572 },
  { name: 'Santa Cruz, CA', lat: 36.9741, lon: -122.0308 },
  { name: 'San Francisco, CA', lat: 37.7749, lon: -122.4194 },
  { name: 'Los Angeles, CA', lat: 33.9900, lon: -118.4695 },
  { name: 'San Diego, CA', lat: 32.7157, lon: -117.1611 },
  { name: 'Outer Banks, NC', lat: 35.9000, lon: -75.6600 },
  { name: 'Virginia Beach, VA', lat: 36.8529, lon: -75.9780 },
  { name: 'Long Island, NY', lat: 40.5900, lon: -73.7500 },
  { name: 'Honolulu, HI', lat: 21.3000, lon: -157.8500 },
  { name: 'Cannon Beach, OR', lat: 45.8918, lon: -123.9615 },
  { name: 'Westport, WA', lat: 46.9040, lon: -124.1050 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same 0.75 miles the pipeline clusters at, applied across the whole file. Two
// regions that meet mid-coast snap the same beach from slightly different
// shoreline samples, so the copies are near-identical rather than identical and
// an equality check would keep them both.
const CLUSTER_MILES = 0.75;

function dedupeSpots(spots) {
  const kept = [];
  for (const s of spots) {
    if (kept.some((k) => k.name === s.name && haversineMiles(k.lat, k.lon, s.lat, s.lon) < CLUSTER_MILES)) continue;
    kept.push(s);
  }
  return kept;
}

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT, 'utf8'));
  } catch {
    return { generated: null, regionMiles: REGION_MILES, regions: [], spots: [] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));

  const data = await readExisting();
  const wanted = only.length ? REGIONS.filter((r) => only.includes(r.name)) : REGIONS;
  if (only.length && wanted.length !== only.length) {
    const known = REGIONS.map((r) => r.name).join('\n  ');
    throw new Error(`Unknown region. Known regions:\n  ${known}`);
  }

  let baked = 0;
  for (const region of wanted) {
    const done = data.regions.find((r) => r.name === region.name);
    if (done && !force) {
      console.log(`· ${region.name} — already baked, ${done.count} spots`);
      continue;
    }
    process.stdout.write(`↻ ${region.name} … `);
    const t0 = Date.now();
    let pool = null;
    for (let attempt = 1; attempt <= ATTEMPTS && !pool; attempt++) {
      await waitForSlot();
      try {
        pool = await spotPool(region.lat, region.lon, { miles: REGION_MILES });
      } catch (err) {
        // Leave the region unbaked rather than writing an empty one: an empty
        // region reads as "this coast has no surf on it", which is a worse
        // answer than falling through to a live query.
        if (attempt === ATTEMPTS) {
          console.log(`FAILED after ${((Date.now() - t0) / 1000).toFixed(0)}s — ${err.message}`);
        } else {
          process.stdout.write(`(${err.message}; retrying) `);
          await sleep(30000);
        }
      }
    }
    if (!pool) continue;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`${pool.length} spots in ${secs}s`);

    // Clipped to the region before storing. The pool reaches as far as the
    // coastline query did — a good 45 miles past the region edge, because the
    // rays need land beyond the search area to run into — so without this the
    // neighbouring regions each carry a copy of the coast between them, and the
    // pills come back reading "Juno Beach, Juno Beach, Juno Beach".
    const clipped = pool.filter(
      (s) => haversineMiles(s.lat, s.lon, region.lat, region.lon) <= REGION_MILES,
    );
    // Spots are shared across every region: the reader filters by distance from
    // the viewer, so one flat pool is all it needs.
    data.spots = data.spots.filter(
      (s) => haversineMiles(s.lat, s.lon, region.lat, region.lon) > REGION_MILES,
    );
    data.spots.push(...clipped.map(({ score, ...s }) => s));
    data.spots = dedupeSpots(data.spots);
    data.regions = data.regions.filter((r) => r.name !== region.name);
    data.regions.push({ ...region, miles: REGION_MILES, count: pool.length });
    baked++;

    // Written after each region, so a throttled run keeps what it has.
    data.generated = new Date().toISOString().slice(0, 10);
    data.regionMiles = REGION_MILES;
    data.regions.sort((a, b) => a.name.localeCompare(b.name));
    data.spots.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
    await fs.writeFile(OUT, `${JSON.stringify(data, null, 0)}\n`);
  }

  const bytes = (await fs.stat(OUT).catch(() => ({ size: 0 }))).size;
  console.log(
    `\n${data.regions.length} regions, ${data.spots.length} spots, ${(bytes / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), OUT)}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
