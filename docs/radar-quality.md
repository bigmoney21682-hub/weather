# Radar: quality, load time and smooth playback

Written 2026-08-11. Everything measured here was measured against the live feeds
on that date; re-run the commands in [Verifying](#verifying-any-of-this) before
trusting a number that matters.

## The complaint

The radar got worse after the Render deploy, not better:

1. **Lower quality** — not high-res, blocky.
2. **No purple** — the intense colours never appear any more.
3. **The colours don't move** — "it's like shadows move", the picture sits still
   and something else shifts over the top of it.
4. **Jerky** — it should be a smooth dissolve, it stutters.

Target: **high quality, fast loading, smooth play.**

## What is actually running

`main` is level with `origin/main` at `3633364`, so **the deployed build is
`3633364`** — NEXRAD over the US via Iowa State's *cached tile service*, using
layer names that are relative to now (`nexrad-n0q-900913-m05m`, `-m10m`, …),
served as 256px tiles with **no canvas recolour**.

The **rework** (`lib/radar.js`, `public/js/radar-tiles.js`,
`public/js/sections/radar.js`, `public/css/app.css`) moved NEXRAD onto the
time-enabled WMS, addressed by exact scan time, served as 512px tiles and
repainted on a canvas. Every symptom in this section is a symptom of `3633364`;
see [What the rework fixes](#what-the-rework-fixes-verified-in-the-running-app)
for what it fixed.

It did **not** fix the shadow, which had a second cause found a day later —
see [the shadow, properly diagnosed](#the-shadow-properly-diagnosed-2026-08-12).
Both were committed and deployed together on 2026-08-12.

## Diagnosis

### 3. "The colours don't move, like shadows move" — root cause, confirmed

**The loop contains duplicate frames.** The deployed build asks for twelve
frames by *relative* layer name, and those names round onto whichever composite
is nearest, so when a scan runs late two different offsets return the same
picture. Measured just now, same tile, all twelve offsets:

| Layer | Bytes | md5 |
| --- | --- | --- |
| `nexrad-n0q-900913` (live) | 6423 | `fb8a71bf…` |
| `-m05m` | 6383 | `b24985e9…` |
| `-m10m` | 6383 | **`b24985e9…` ← identical to `-m05m`** |
| `-m15m` | 6429 | `b8b39e1d…` |
| `-m20m` | 6542 | `9ff63165…` |
| `-m25m` | 6622 | `1063afb3…` |
| `-m30m` | 6550 | `edf502bb…` |
| `-m35m` | 6707 | `480a3120…` |
| `-m40m` | 6731 | `1e7338dd…` |
| `-m45m` | 6861 | `33caca40…` |
| `-m50m` | 6969 | `0f6fb8e6…` |
| `-m55m` | 7009 | `6484de82…` |

Eleven distinct pictures where the code assumes twelve.

This produces the exact effect described. The animation cross-fades frame *i*
into frame *i+1* over a continuous cursor. When those two frames are the same
image, the fade still runs — opacities ramp, the compositor keeps working — but
**nothing in the picture moves**. You get one frame-time of a stationary image
being gently re-blended (the "shadow"), then the next transition has to cover two
scans' worth of movement at once, so the rain jumps. Sit still, jump, sit still.

The `?scan=` query parameter does not help here. It changes the *address* so the
browser refetches, which is what keeps the layer-reuse fix working — but it does
not change *which composite* the server picks for a relative layer name.

### 2. "Can't see purple" — confirmed, two causes

**The colour scale changed underneath the legend.** `3633364` sets
`recolour: false` for NEXRAD, so the tiles arrive painted in the NWS N0Q
reflectivity ramp and are drawn as-is. On that ramp violet and magenta do not
start until about **65 dBZ**, which is hail-core territory and essentially never
present in ordinary rain. Everything you actually see day to day lands in the
green → yellow → orange → red stretch. Under the old RainViewer path those tiles
were recoloured onto a scale that reached violet at far more ordinary rain rates.
Purple didn't break — the scale moved.

**The legend is now describing a scale the tiles don't use.** `3633364` toggles a
`.is-nexrad` class on the legend bar, but there is no such rule anywhere:

```
$ grep -rn "is-nexrad" public/ lib/ server.js
(no matches)
```

So the bar keeps its default gradient from `public/css/app.css:1316` —
`#9aed83 → #33e42e → #0da626 → #075a22 → #ffe000 → #ff8b00 → #e02c2c → #a020c8`,
ending in violet — while the tiles above it are drawn on the NWS ramp. The legend
promises purple that the picture cannot produce.

### 1. "Lower quality, not high res" — confirmed, and partly a misdiagnosis

N0Q is **raw base reflectivity**: roughly 1 km bins, quantised to half a decibel,
with no smoothing, and the cached tile service serves it exactly that way — hard
squares. RainViewer's tiles were requested as `…/4/1_1.png`, where the trailing
`1_1` asks for the *smoothed* rendering. So the deployed picture is blockier even
though it carries strictly more information, and zooming past about z12 just
magnifies 1 km squares rather than revealing detail.

Two separate things are bundled inside "quality" and they pull in opposite
directions: **resolution** went up, **presentation** went down. The fix is
smoothing and a sensible colour ramp, not a different feed.

Related, and only affecting people **outside** NEXRAD coverage: the deployed
RainViewer path sets `maxNativeZoom: 9` with `zoomOffset: -1`, i.e. URL zoom 8.
RainViewer's last real zoom is 7. Measured at three different tile coordinates:

| URL zoom | Bytes | md5 |
| --- | --- | --- |
| 6 | 4946 | `acf7a29c…` |
| 7 | 11017 | `4bf05a66…` |
| 8 | 3269 | `6227f878…` |
| 9 | 3269 | `6227f878…` |
| 10 | 3269 | `6227f878…` |

Byte-identical at 8, 9 and 10 *at different coordinates* — that is the "Zoom
Level Not Supported" placeholder card being pasted across the map. The working
tree already corrects this to `maxNativeZoom: 8`.

### 4. "Jerky" — several contributors, in order of size

1. **Duplicate frames.** Cause #3 above. This is most of it.
2. **The cursor ignores the real gap between frames.** `tick()` advances the
   cursor one index per `SPEEDS[speed].ms` regardless of how far apart the two
   frames actually are in time. When the feed drops or duplicates a scan, that
   gap plays at the wrong speed. This is a known regression introduced with the
   rAF rewrite — the old `buildSteps` handled it proportionally — and it is
   **still open**.
3. **Four times the tile requests.** NEXRAD is served at 256px against
   RainViewer's 512px, so the same map area needs 4× the tiles, × 12 frames. Any
   layer whose tiles have not landed yet shows as a hole when the fade reaches it.
4. Not a factor on the deployed build: the cached tile service returns in
   0.24–0.5s and sends `Cache-Control: public, max-age=300`.

## What the rework fixes, verified in the running app

The rework moves NEXRAD onto `n0q-t.cgi`, the time-enabled WMS, addressing each
frame by exact scan time; and it adds a canvas pass that reads dBZ back off the
NWS ramp, drops clutter below 15 dBZ, blurs, and repaints onto the legend's ramp.

Measured against the app running on localhost, Chicago at zoom 8, by hashing the
pixels of every frame layer's tiles in the live DOM:

| Check | Result |
| --- | --- |
| Distinct frames in the loop | **12 of 12** (deployed build: 9–11 of 12) |
| WMS requests to fill the map | **12** — one per frame, down from 72 at 256px |
| RainViewer URL zoom after zooming all the way in | clamped to **7**; the placeholder card is gone |
| Painted tile that is 97% dry sky | fully transparent — no wash over the basemap |

And the colour scale now lands where the old one did. Same ground, same minute,
counting every painted pixel by hue — repainted NEXRAD against the RainViewer
rendering Joe was used to:

| Band | NEXRAD repainted | RainViewer recoloured |
| --- | --- | --- |
| green | 89.7% | 81.3% |
| yellow | 4.8% | 11.2% |
| orange | 3.5% | 4.0% |
| red | 1.8% | 2.5% |
| violet | **0.2%** | **0.3%** |

Violet comes back at the rate it used to, which answers the open question below:
the app's own ramp reproduces the scale Joe had, so there was no need to move the
stops to manufacture purple.

**It fixes the duplicate frames.** Twelve consecutive 5-minute timestamps,
CONUS bbox, all distinct:

| Time | Bytes | md5 |
| --- | --- | --- |
| 12:00:00Z | 13724 | `3be7b372…` |
| 11:55:00Z | 13796 | `dceb8c95…` |
| 11:50:00Z | 13694 | `e1960af2…` |
| 11:45:00Z | 13701 | `25d23e2a…` |
| 11:40:00Z | 13720 | `8c5fb4cd…` |
| 11:35:00Z | 13640 | `6d5f29a9…` |
| 11:30:00Z | 13611 | `63c514b3…` |
| 11:25:00Z | 13882 | `1884abeb…` |
| 11:20:00Z | 13731 | `bf9d7e4d…` |
| 11:15:00Z | 13967 | `5ab22a9a…` |
| 11:10:00Z | 14083 | `42af4bcf…` |
| 11:05:00Z | 14101 | `2aa3df91…` |

12 for 12. It also fixes the purple (repaints onto the legend's own ramp) and the
blockiness (the blur), and it corrects the RainViewer zoom cap.

**Two of the three costs are dealt with; one is still open:**

- **512px tiles — done.** Wall-clock cost is per-request, not per-pixel: 3-request
  averages against the same bbox and time were 256px **0.738s**, 512px **0.608s**,
  so a bigger tile costs *less* and covers four times the ground. Switching cut a
  map view from 72 requests to 12.
- **The repaint on the main thread — measured, and left alone.** It is two
  separable 5-tap blurs over two `Float32Array` fields, run synchronously in
  `img.onload`. A tile with no echo above the floor now returns before either
  blur, which is most tiles over most of the country; a dense 256px tile measured
  5–19ms in Node. No long tasks were recorded during a load. Revisit only with a
  profile that says otherwise.
- **No caching at all — still open.** The WMS sends *no* `Cache-Control`,
  `Expires` or `Age` header, where the cached tile service sends `max-age=300`.
  Every page load refetches all twelve frames from scratch, and nothing is shared
  between users or between reloads. This is plan item #3 and it is the one that
  still matters.

**And one sharp edge worth knowing about.** GetCapabilities reports
`nearestValue="0"` on the time extent, meaning the WMS does **not** snap to the
nearest scan — an off-grid timestamp returns a blank image rather than the
closest one. Measured: a request at `11:48:45Z` returns 588 bytes of nothing,
while `11:45:00Z` returns 13701 bytes of radar. The 5-minute snap in
`nexradRadar()` is load-bearing; if it ever drifts, the radar goes silently
blank instead of failing loudly.

## The shadow, properly diagnosed (2026-08-12)

The duplicate-frame fix above was real, but it was not the whole of the shadow.
Joe described it again after living with the reworked build:

> There's a shadow behind/next to the cluster of storms and it moves like it's
> disconnected from the cluster, so every 5 min the cluster moves then the
> shadow moves, and on and on.

That is not duplicate frames. That is the cross-dissolve itself, and there were
two separate causes.

### The blend was solved for the wrong layer

Frames are stacked by index — `zIndex: 400 + i` — so the **incoming** frame sits
*above* the outgoing one. The old code solved the opacity pair the other way
round, holding `from` at `FRAME_OPACITY * (1 - blend)` and deriving `to` from it,
which is only correct if `from` is on top. Composited in the real z-order that
curve is badly lopsided:

| Through the dissolve | New frame's share, old | New frame's share, fixed |
| --- | --- | --- |
| 17% | **48%** | 17% |
| 37% | **73%** | 37% |
| 50% | **82%** | 50% |
| 75% | **93%** | 75% |

The incoming frame took nearly half the picture in the first sixth of the
transition and four fifths of it by halfway, then crawled. Snap, then sit — which
is exactly what "the cluster moves, then the shadow moves" looks like. Total
composite opacity was right at every point, which is why it was easy to miss.

Fixed by solving for the lower layer: `toOpacity = FRAME_OPACITY * blend`,
`fromOpacity = FRAME_OPACITY * (1 - blend) / (1 - toOpacity)`. Verified against
the running app by driving the scrub input and reading the layer opacities back
out of the DOM — they match the table above to three decimals.

### Cross-dissolving offset frames cannot read as motion

Even with a perfect curve, a long dissolve between two frames five minutes apart
does not read as movement. Five minutes of storm motion is about **4 km**, which
is ~7 screen pixels at zoom 8 and ~30 by zoom 10. Dissolving slowly between two
copies that far apart shows you the old one fading where it stands while a
second one appears beside it. A shadow, not a storm.

So the loop no longer ramps across the whole gap. Each frame is **held** for 76%
of its slot and dissolved in the remaining 24%, which is near enough to a clean
cut for ordinary apparent motion to take over, and the frame slot dropped from
1000 ms to 620 ms so the loop runs nearer two frames a second.

### "Noisy clusters around Orlando" — nocturnal clear-air return

Measured over central Florida at 04:40Z (12:40 AM local), against the old 8 dBZ
draw floor: **89% of every pixel being drawn was under 20 dBZ**, and almost
nothing was above 25.

The giveaway is that it does not travel. Correlating consecutive scans over the
same box, the best match is at **zero displacement** — shifting gains `0.003`
and `0.000`. Rain advects; this sits still and boils, which is what read as
noise and fed the jerk. It is the summer night-time insect and bird layer.

Local texture does **not** separate it from rain, which was the first guess and
was wrong: over the same 10–20 dBZ band the standard deviation is ~2.3 dBZ for
the Florida clutter and ~2.0–2.9 dBZ for CONUS. Only magnitude separates them.

`FLOOR`/`FADE` therefore moved from `15`/`7` to `25`/`10`: the hard cut rises
from 8 dBZ to 15 dBZ, and what survives fades in across 15→25 rather than
arriving at full strength. Anything at or above 25 dBZ is **untouched** — the
strength term is already 1.0 there under both settings. Running the real paint
pass over live tiles, as total alpha laid down per tile:

| Region | Before | After | Change |
| --- | --- | --- | --- |
| Orlando (clear-air) | 7.30 | 2.04 | **−72%** |
| Upper Midwest (rain) | 12.90 | 8.06 | −38% |
| Plains (rain) | 6.40 | 3.30 | −48% |

The clutter loses roughly twice what the weather does.

### Still open: real interpolation

Held frames plus a short dissolve gets the shadow out and reads as motion, but
the loop is still twelve discrete steps. Genuinely continuous motion needs the
frames advected — shifted toward each other during the blend by the storm's own
motion vector — so the two copies coincide instead of merely alternating.

That vector is measurable, but **not over a 5-minute baseline**: at the tile
resolutions involved the displacement is sub-pixel and the correlation surface
is flat (best shift 0–1 px, gain ≤0.005). Over a **55-minute** baseline it comes
out cleanly and plausibly:

| Region | Shift | Implied motion | Correlation gain |
| --- | --- | --- | --- |
| Upper Midwest | (12, 4) px | 52 km/h ESE | 0.091 |
| Plains | (6, 2) px | 28 km/h ESE | 0.025 |
| Orlando | (13, 19) px | 19 km/h — but r=0.33, don't trust it | 0.109 |

So the approach is: correlate the oldest frame against the newest, divide by the
number of gaps, and apply it as a CSS transform on each frame layer's container
during the dissolve. Leaflet 1.9.4's `GridLayer._container` only ever receives
`zIndex` and `opacity`, so a transform there is ours to own. Not built — it is a
real piece of work and a bad vector would slide the whole field the wrong way,
which is worse than the shadow.

## Plan

Ordered by impact on the three goals.

| # | Change | Fixes | State |
| --- | --- | --- | --- |
| 1 | Ship the exact-time WMS rework | Shadows/jerk, purple, blockiness | **Done**, in the working tree |
| 2 | Request 512px WMS tiles instead of 256px | Load time | **Done** — 72 requests to 12 |
| 7 | Make the legend render whichever ramp is actually drawn | Purple | **Done** — both feeds share one ramp, `.is-nexrad` deleted |
| 3 | Proxy the WMS through our own server with cache headers | Load time | Open, and the biggest one left. Frames older than the newest never change, so they are immutable; also shares cost across users and shields IEM |
| 4 | Make the cursor advance in wall-clock time, not frame index | Jerk | Open, but no longer biting: exact-time frames are all exactly five minutes apart. It matters again the day a scan comes back blank |
| 5 | Assert the 5-minute grid alignment, fail loudly if a frame comes back blank | Reliability | Open — `nearestValue="0"` means drift = silent blank radar |
| 6 | Move the repaint to an `OffscreenCanvas` in a worker | Load time | Not needed on the measurements above; don't build it without a profile |
| 8 | Solve the dissolve for the lower layer, and hold each frame instead of ramping across the gap | Shadows/jerk | **Done** — see [the shadow, properly diagnosed](#the-shadow-properly-diagnosed-2026-08-12) |
| 9 | Raise the clutter floor to cut the night-time clear-air layer | Noise, jerk | **Done** — 15 dBZ hard cut, fading in to 25 |
| 10 | Advect the frames during the dissolve by a long-baseline motion vector | Genuinely continuous motion | Open, and the only lever left on smoothness |

Next: **#3**, then re-measure load time. #5 is cheap and worth doing alongside
it. #10 is the one that would make the loop properly continuous rather than
merely un-jerky.

## Open questions for Joe

- **Purple — answered, unless you disagree.** The repaint puts violet on 0.2% of
  painted pixels where RainViewer put it on 0.3%, so the scale you had is the
  scale you get back. The alternative is the NWS meteorological scale, where
  purple genuinely means "65+ dBZ, this is hail" and you would almost never see
  it. Say if you'd rather have that.
- **IEM load.** Twelve uncached WMS renders per map view per user is a real
  amount of traffic to point at a free academic service. 512px tiles cut it by
  four; plan item #3 would cut it again and share it between visits. Worth doing
  before this gets any real traffic.

## Verifying any of this

```sh
# Duplicate frames on the deployed build (expect a repeated md5)
for off in "" -m05m -m10m -m15m -m20m -m25m -m30m; do
  curl -s -o t.png "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913${off}/4/4/6.png"
  echo "${off:-live} $(md5 -q t.png)"
done

# Distinct frames on the WMS (expect twelve different md5s)
BB="-14000000,2800000,-7000000,6300000"
NOW=$(( ($(date +%s) / 300) * 300 ))
for i in $(seq 0 11); do
  T=$(date -u -r $((NOW - i*300)) +%Y-%m-%dT%H:%M:00Z)
  curl -s -o w.png "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857&BBOX=$BB&WIDTH=512&HEIGHT=256&TIME=$T"
  echo "$T $(wc -c < w.png) $(md5 -q w.png)"
done
```

**Testing gotcha, previously cost real time:** the Chrome automation tab reports
`document.visibilityState === "hidden"`, which throttles timers and
`requestAnimationFrame` hard — a 1s sampler fired 3 times in 70s. That looks
exactly like a main-thread freeze and is not. Drive `render()` through the scrub
input's `input` event instead of relying on rAF, and check `visibilityState`
before believing any timing measurement taken in that tab.
