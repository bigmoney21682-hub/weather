# Weather

A private, single-page weather dashboard. Everything on one scroll, driven by one
location you set once at the top.

- **Weather** — current conditions and an hourly forecast with day/night icons.
- **Weather Advisories** — active NWS watches, warnings and advisories for your point.
- **Radar** — the last hour of global precipitation radar, looping, with a scrubber.
- **Lightning** — live strikes from the Blitzortung sensor network, newest first.
- **Wind** — sustained speed and gusts for today plus two days, pinch-zoomable.
- **Hurricane Tracker** — every active tropical cyclone worldwide, with forecast track,
  cone of uncertainty, wind field and intensity forecast in mph.
- **Surf** — wave height, swell period, water temperature, tides, and the biggest wave
  within 60 miles, with its own spot search.
- **Air Quality** — US AQI, pollutant breakdown, 24-hour forecast, and advisories or
  hot spots within 60 miles.

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
| Air quality | Open-Meteo Air Quality (CAMS) + NWS alerts |
| Geocoding | Zippopotam, Open-Meteo Geocoding, OpenStreetMap Nominatim |
| Basemap | OpenStreetMap via CARTO |

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

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: your location lives in this browser's
`localStorage` and nowhere else. No accounts, no cookies, no analytics, no logs.

## Deploying from GitHub

The app is a plain Node server, so anything that runs Node will host it:

```bash
git remote add origin git@github.com:<you>/weather.git
git push -u origin main
```

On the host: `npm ci --omit=dev && PORT=8787 HOST=0.0.0.0 node server.js`, behind
whatever reverse proxy you like. Two things to keep in mind:

- The lightning feed holds an outbound WebSocket to `ws1.blitzortung.org:443`.
  Hosts that block long-lived outbound sockets will show the section as offline;
  everything else keeps working.
- `.cache/` holds one derived file (the NOAA tide station list). It is safe to
  delete and is rebuilt on demand.
