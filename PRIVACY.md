# Privacy

**All of your data is 100% private.** That claim is on the page, so here is exactly
what backs it.

## What is stored

One thing: the location you set, in this browser's `localStorage` under
`weather.location.v1`. It holds a latitude, a longitude, and a label like
"Nags Head, North Carolina".

Clearing it (the ✕ in the location bar) deletes it from the device. Nothing else
persists — no history of what you looked at, no session, no identifier.

## What is not stored

- No accounts, sign-in, or email address.
- No cookies. The server never sets one.
- No analytics, telemetry, tracking pixels, or third-party scripts of any kind.
- No server-side database, user record, or request log containing a location.
- No advertising identifiers, and nothing is ever sold or shared.

## What leaves your device

Weather data has to come from somewhere, so a coordinate does travel — but only a
bare coordinate, attached to nothing.

1. Your browser sends the coordinate to **this app's own server** (the one you
   started). It holds it in memory only for as long as the request takes.
2. That server asks the public weather APIs listed in the README the question you
   asked — "what is the forecast at 35.96, -75.62". Those providers see a request
   from your server's IP with a coordinate in the URL, and nothing else: no name,
   no account, no cookie, no referrer (the page sends `Referrer-Policy: no-referrer`).
3. Answers come back and are cached in the server's memory for a few minutes so
   repeat views do not re-ask.

Two requests go directly from your browser rather than through the server, because
that is how map tiles work:

- **Map tiles** from CARTO/OpenStreetMap and radar tiles from RainViewer. These
  reveal the map squares you are looking at, which is inherent to any map.
- Nothing else. There are no other outbound requests from the page.

If you use **"Use my location"**, the browser's geolocation permission gives the app
your coordinate. It is used exactly like a typed location — resolved to a place
name, then used for the sections — and stored in the same single `localStorage`
entry. It is not sent anywhere else.

**"Follow me"** is the same thing repeated: while it is on, the browser reports the
device's position as it moves, and each position that counts as a new place (three
miles on, and no sooner than ninety seconds after the last) is used exactly like a
typed location. No trail is kept. Only the latest position is stored, in that same
single entry, overwriting the one before it — there is nowhere in this app that a
route or a history of where you have been could accumulate. Follow mode never
survives a reload, and any deliberate choice of another place turns it off.

## Verifying this yourself

- `grep -r "localStorage" public/js` — one key, in `public/js/store.js`.
- Open the browser's network tab: the only hosts are your server and the tile hosts.
- `server.js` writes no request log; the only file the app ever writes is
  `.cache/noaa-tide-stations.json`, a public list of tide gauges with no user data
  in it.
