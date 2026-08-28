# Picking a surf spot: only the open ocean, and only places with names

Written 2026-08-15.

## The complaint

At West Palm Beach the surf section reported on **Summa Beach**, which is a few
hundred yards of flat water on the Intracoastal behind Palm Beach island, and it
put the biggest wave **forty miles out in the Atlantic** — true, and useless,
because nobody paddles out there and the point has no name to report.

Two separate faults, one cause: nothing in the pipeline knew the difference
between the sea and a lagoon.

## Why the obvious approaches do not work

**Ask a geocoder for the nearest beach.** Nominatim's free-text `beach` search
over Palm Beach County returns four results, of which one is on the Intracoastal
and one is a city. OpenStreetMap tags a lagoon shore `natural=beach` exactly as
readily as an ocean one, because it is one.

**Ask the marine model whether there is swell there.** This was the old test, and
it is the reason the wrong answer looked right. Open-Meteo snaps a request to the
nearest wet grid cell; ask it about a point on the Intracoastal and it answers
with the Atlantic on the far side of the barrier island, half a mile away. The
lagoon and the beach get identical forecasts.

**Measure the distance to the coastline.** In Florida the Intracoastal shores
*are* `natural=coastline` — the lagoon is tidal and connected to the sea, so OSM
draws it that way. Proximity to coastline says nothing.

## What does work

OSM's coastline ways carry a convention that is enforced worldwide, because every
map's sea rendering depends on it: **the way runs with land on the left and water
on the right.** That gives every point on the shore a direction that points out to
sea, which is the missing bit of information.

`lib/coastline.js` fetches the coastline for a region once a week and, for each
sample along it:

1. Takes the **seaward bearing** from the right-hand normal of the way, smoothed
   over about a mile of shore either side. One segment is far too local — a
   jetty, a groyne or a surveyed wiggle points its own way and sends the test off
   down the beach or straight inland.
2. Fires a **ray up to 40 miles** out, in a fan of five bearings within ±60° of
   seaward, and asks whether any of them reaches that far without crossing
   coastline.
3. Checks that the far end of a clear ray is **actually at sea** — the nearest
   shore to it, read through the same winding convention, has to have it on the
   water side.

Step 3 is what makes this work, and it is the step that is easy to leave out. A
ray fired inland from a lagoon crosses no coastline at all, because there is none
to cross; "nothing was in the way" and "this is the ocean" are not the same
statement. Every early version of this test passed West Palm Beach's Intracoastal
with flying colours by shooting west over the Everglades.

Two filters then clean up what is left:

- **Coherence.** An inlet or harbour mouth is genuinely open to the sea, so the
  docks a quarter mile inside one pass every test above. What gives them away is
  that they *face across the channel* — more than 60° off the run of the coast
  around them.
- **Long runs.** A surf beach is part of miles of continuous shoreline facing the
  same sea. An islet in a sound is not. Runs shorter than 3 miles are dropped.

## Where the names come from

`lib/surfspots.js`. A break is as likely to be mapped as a park, a pier or a
headland as it is to carry `natural=beach`, so the search is wide —
`natural=beach|reef|cape`, `sport=surfing`, `surfing=*`, `leisure=park|
nature_reserve|beach_resort`, `man_made=pier` — and then narrowed hard:

- The feature must **snap onto ocean shore** within a tag-dependent distance, and
  must not be closer to some *other* shore than it is to the sea. That last
  clause is what finally killed Summa Beach: snapping alone cheerfully dragged it
  across the barrier island and hung its name on the Atlantic.
- Generic features (parks, piers) must **say something coastal in the name**.
  "Seaview Park" and "Juno Beach Pier" qualify; "Memorial Park" and "USCG" do not.
- Shops are dropped. Several genuine-looking hits are surf shops — West Palm
  Beach's `sport=surfing` node is `shop=sports`, a shop on the mainland.
- Marina berths are dropped. They cluster around inlets, the one part of a lagoon
  with a clear line to open sea, and they are named "Pier A".

Spots are then deduped at 0.75 miles and sorted **along the coast** by the
principal axis of the cluster, so the pills either side of you run up and down the
shore in the order you would drive them. The axis also decides whether to label
the ends North/South or East/West, which matters on the Gulf.

## What it costs

Two Overpass queries per region, cached a week on a ~7 mile grid, plus a few
hundred thousand ray tests that run in about a tenth of a second.

Both queries are shaped around Overpass being charged by **area**, which is worth
knowing before editing them:

- Asking for `natural=beach` across the whole 30-mile search box takes ~30
  seconds per tag. Asking only inside the boxes that straddle the ocean shore
  takes ~2. Since a candidate has to snap to ocean shore to survive anyway, the
  wide search could only ever return rows that were going to be thrown away.
- The intuitive `way["natural"="coastline"](bbox)->.coast; nwr(around.coast:800)`
  times out outright — buffering a few hundred miles of shoreline is the slowest
  thing Overpass does.
- The resulting query names a rectangle per stretch of coast and overruns what
  the endpoints accept in a URL, so long ones are POSTed (414 otherwise).

A failed Overpass query is **allowed to throw past `cached`** so it is not
stored. An empty result that came back cleanly — a landlocked location — is
cached. Collapsing the two, which is what a `.catch(() => [])` inside the cached
producer does, leaves one busy minute's outage sitting there for a week.

## Known limits

- **Very long enclosed sounds still pass.** The 40-mile ray settles lagoons,
  harbours, rivers and ordinary bays — Tampa Bay is excluded, Monterey Bay is
  correctly kept, since Santa Cruz escapes to the Pacific 30° off its own normal.
  Something like Long Island Sound is longer than the ray and would not be.
- **Coverage is only as good as OSM.** Palm Beach island has world-famous breaks
  and almost nothing mapped as a beach; the nearest named spot there comes out as
  "Seaview Park", which is the right stretch of sand under a duller name than a
  local would use. Nothing here invents names.
- The `natural=coastline` winding convention is assumed correct. It is very well
  policed globally, but a locally broken way will misclassify its own shore.

## Verifying any of this

```bash
# What the section actually answers for a location
curl -s "localhost:8787/api/surf?lat=26.7153&lon=-80.0534" | python3 -m json.tool

# Whether a specific point counts as ocean shore
node --input-type=module -e '
  const { oceanShoreline } = await import("./lib/coastline.js");
  const shore = await oceanShoreline(26.7153, -80.0534, 30);
  console.log(shore.ocean.length, "ocean of", shore.all.length, "shore samples");
'
```

The two questions worth asking of any change here are **"does Summa Beach come
back?"** (a lagoon passing as surf) and **"does Santa Cruz still work?"** (real
surf inside a bay being rejected). They fail in opposite directions, and almost
every tuning knob in `lib/coastline.js` trades one against the other.
