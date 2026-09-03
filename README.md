# Weather

A private, single-page weather dashboard. Everything on one scroll, driven by one
location you set at the top. Save as many places as you like as pills, tap one to
switch, and star the one the page should open on.

Press and hold any pill in the header to drag the sections into whatever order you
read them in; the order sticks in this browser.

**Use my location** holds out a few seconds for a real GPS fix rather than taking the
first network estimate the phone offers, and says so when all it could get was the
vague one. **Follow me** keeps the whole page moving with you — every section
refetches once you have covered three miles, so a drive stays ahead of you without
hammering the feeds. Searching, or tapping a saved pill, parks it again.

- **Weather** — current conditions and an hourly forecast with day/night icons.
- **Weather Advisories** — active NWS watches, warnings and advisories for your point.
- **Radar** — the last hour of global precipitation radar, looping in five-minute
  steps, with a scrubber.
- **Lightning** — live strikes from the Blitzortung sensor network, newest first.
  "Watch live" drops a dot on each new strike and expands a ring from it at the
  speed of sound, so the thunder reaches you when the ring does.
- **Wind** — sustained speed and gusts for today plus two days, pinch-zoomable.
- **Hurricane Tracker** — every active tropical cyclone worldwide, with forecast track,
  cone of uncertainty, wind field and intensity forecast in mph.
- **Surf** — conditions at the nearest named surf spot on the open ocean, with the five
  spots up and down the coast a tap away, today's two daylight tides, and the biggest
  wave within 40 miles at a beach you could drive to. Bays, lakes and the Intracoastal
  are deliberately excluded; see [docs/surf-spots.md](docs/surf-spots.md) for how.
- **Air Quality** — US AQI, pollutant breakdown, 24-hour forecast, and advisories or
  hot spots within 60 miles.
- **Ocean Quality** — a swim rating for the nearest beach, built from real-time USGS
  and NOAA gauges, sea surface temperature and the rain that has fallen on the
  watershed behind it. Every deduction from the score is shown with the reading that
  caused it. It is not a bacteria test — see the coverage notes.

## Run it

```bash
npm install     # only dependency is Leaflet, vendored into public/
npm start
```

The server prints every URL it can be opened on. It takes port `8787` when free
and otherwise walks up until it finds an open one, so it never collides with
something already running.

```
  Weather  →  http://localhost:8787
  Weather  →  http://192.168.1.2:8787     ← same Wi-Fi, e.g. your phone
```

By default it binds the wildcard address, which covers IPv4 and IPv6 loopback
plus your LAN. That matters on macOS: `localhost` resolves to IPv6 `::1` first,
so a server bound only to `127.0.0.1` refuses the connection.

```bash
PORT=9000 npm start        # start looking from a different port
HOST=127.0.0.1 npm start   # this machine only, not the LAN
npm run dev                # restart on file changes
```

If a browser cannot reach it, check the server is actually up:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep node    # what port did it take?
curl -sI http://localhost:8787/            # expect HTTP/1.1 200
```

Requires Node 22 or newer (it uses the built-in `fetch` and `WebSocket`).

## How it fits together

```
server.js          HTTP server: static files from public/, JSON API under /api
lib/               one module per upstream data source, each returning plain JSON
public/js/         ES modules, no build step — the browser loads them directly
public/js/chart.js hand-written canvas charts with pinch/pan/wheel zoom
public/vendor/     Leaflet, vendored so no map code loads from a CDN
```

There is no build, no bundler and no framework. Edit a file, reload the page.

## Data sources

| Section | Source |
| --- | --- |
| Forecast, wind | [Open-Meteo](https://open-meteo.com/) |
| Advisories | [NWS API](https://www.weather.gov/documentation/services-web-api) |
| Radar | [RainViewer](https://www.rainviewer.com/api.html) |
| Lightning | [Blitzortung.org](https://www.blitzortung.org/) volunteer network |
| Hurricanes | [NHC](https://www.nhc.noaa.gov/) and [JTWC](https://www.metoc.navy.mil/jtwc/jtwc.html) |
| Surf | Open-Meteo Marine + [NOAA Tides & Currents](https://tidesandcurrents.noaa.gov/) |
| Surf spots and coastline | OpenStreetMap via [Overpass](https://overpass-api.de/), baked into `data/surf-spots.json` |
| Air quality | Open-Meteo Air Quality (CAMS) + NWS alerts |
| Ocean quality | [USGS NWIS](https://waterservices.usgs.gov/) real-time gauges + NOAA Tides &amp; Currents + Open-Meteo + NWS alerts |
| Geocoding | Zippopotam, Open-Meteo Geocoding, OpenStreetMap Nominatim |
| Basemap | Esri ArcGIS Online canvas tiles (Esri, HERE, Garmin, OpenStreetMap) |

None of them need an API key. Requests are cached in memory for as long as each
feed stays fresh, so the page can refresh often without hammering anyone.

### Coverage notes

- Official **advisories** come from the National Weather Service, so they cover the
  US and its territories only. Elsewhere the section says so rather than showing
  a misleading "all clear".
- **Lightning** is a live feed with no history: the server starts buffering strikes
  for an area the first time you ask about it, and the card tells you how long it
  has been listening so "no strikes" is never ambiguous.
- The hurricane **cone** is rebuilt from the official forecast track and each
  agency's published average track error — the same definition the official
  graphic uses. JTWC does not publish a cone, so theirs is labelled indicative.
- **Spaghetti model plots** are not available as open data; the storm panel links
  out to them instead of drawing a fabricated version.
- A storm on its **final warning** stays in the hurricane list, dimmed and labelled,
  until the agency drops it from the feed. "Dolphin is done" is information; having
  it silently disappear is not.
- The **ocean quality** score is not a bacteria count. Enterococcus and E. coli
  results come from lab cultures that state and county health departments collect
  on their own schedule, and there is no national real-time feed of them. The score
  combines what *is* measured continuously — runoff, turbidity, dissolved oxygen,
  pH, water temperature and official advisories — and shows every deduction it
  made. Gauges only count toward it if they are within 15 miles and reading salt
  water; that last test is free, because specific conductance tells salt water
  (about 50,000 µS/cm) from a storm drain (under 1,500) on its own. Somewhere with
  no sea and no gauge is reported as "not rated" rather than scored 100.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: your location lives in this browser's
`localStorage` and nowhere else. No accounts, no cookies, no analytics, no logs.

## Deploying

Live at **https://weather-oxyj.onrender.com**, running on Render from this
repository's `main` branch. Pushing to `main` redeploys it.

Render reads [`render.yaml`](render.yaml), so the build and start commands live in
the repo rather than in dashboard settings. Nothing needs configuring by hand and
there are no secrets to set — every upstream feed is keyless.

Note that GitHub Pages cannot host this app. Pages serves static files only, and
this is a Node server that proxies the weather APIs; the page would load with
every section failing.

Any other host that runs Node works too:
`npm ci --omit=dev && PORT=8787 HOST=0.0.0.0 node server.js`. Three things to keep
in mind:

- The lightning feed holds an outbound WebSocket to `ws1.blitzortung.org:443`.
  Hosts that block long-lived outbound sockets will show the section as offline;
  everything else keeps working. (Render allows it.)
- If the host sets `PORT`, the server binds exactly that port and exits if it is
  taken, rather than walking to the next free one as it does locally — a health
  check has no way to find a port it was not told about.
- `.cache/` holds one derived file (the NOAA tide station list). It is safe to
  delete and is rebuilt on demand.
- **Surf spots are baked into the repo, and need to be.** Overpass allows two
  concurrent queries per IP, and on a shared host that budget belongs to whoever
  else is on the address — from Render's free instances the coastline query never
  gets a slot and every coast comes back empty. `data/surf-spots.json` is built
  ahead of time by `node scripts/bake-surf-spots.js`; add a coast to `REGIONS`
  there and re-run. Coasts outside it fall back to querying Overpass live, which
  works on a laptop and generally will not on a shared host.

### Staying awake on a free instance

Free hosts spin an instance down once it has been idle for a while, which makes
the next visit wait out a cold start. `lib/keepalive.js` prevents that by pinging
`/healthz` on its own public URL on an interval. The ping has to go out to the
public hostname and come back in, because the idle timer counts inbound requests
through the host's router — pinging `127.0.0.1` never leaves the container and
would reset nothing.

It only runs when a public URL is advertised, so local runs are unaffected.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RENDER_EXTERNAL_URL` | set by Render | The public URL to ping. Keep-alive is off when absent. |
| `KEEPALIVE_URL` | — | Overrides the above on hosts that do not set it. |
| `KEEPALIVE_INTERVAL_MS` | `40000` | Time between pings. |

Two caveats worth knowing. Keeping one instance awake around the clock uses about
730 of Render's 750 free instance-hours per month, so a second always-on free
service would exceed the allowance — raising the interval buys headroom, and
anything under the host's idle window (15 minutes on Render) works equally well.
And an instance that never sleeps never reloads, so a slow memory leak has more
room to accumulate; `/healthz` reports uptime if you want to keep an eye on it.
