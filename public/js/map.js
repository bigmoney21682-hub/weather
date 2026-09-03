// Leaflet setup shared by the radar, lightning and hurricane maps.
//
// Leaflet is vendored under /vendor/leaflet, so no map code is fetched from a
// CDN. Basemap tiles come from Esri's ArcGIS Online canvas services; only the
// tile coordinates you look at are ever requested.
//
// CARTO served these until it started stamping "API KEY REQUIRED" diagonally
// across every keyless tile, which tiled the message over the whole map. Esri's
// canvas basemaps are the like-for-like replacement: muted enough to sit under
// radar and strike colours, and still keyless.

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ESRI_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

// The canvas services split the map in two: a base with no writing on it, and a
// transparent reference layer carrying the place names. Both are needed to match
// what CARTO's `*_all` styles drew in one pass.
const BASEMAPS = {
  dark: {
    base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
  light: {
    base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
};

// Esri's canvas tiles stop here — past it the service answers with a blank
// placeholder rather than a 404, so Leaflet has to be told to stretch the last
// real row instead of asking for the empty ones. The radar still zooms to 19.
const BASEMAP_MAX_NATIVE_ZOOM = 16;

/**
 * Create a map that is pinch-zoomable on touch and scroll-zoomable only after a
 * deliberate interaction, so the page still scrolls normally past it.
 */
export function createMap(container, { center = [39, -98], zoom = 5, worldCopyJump = true, theme = 'dark' } = {}) {
  const map = L.map(container, {
    center,
    zoom,
    zoomControl: true,
    attributionControl: true,
    worldCopyJump,
    // Touch: one finger scrolls the page, two fingers pan/zoom the map.
    dragging: !L.Browser.mobile,
    tap: true,
    touchZoom: true,
    scrollWheelZoom: false,
    minZoom: 2,
  });

  const base = BASEMAPS[theme] || BASEMAPS.dark;
  const tiles = { maxZoom: 19, maxNativeZoom: BASEMAP_MAX_NATIVE_ZOOM, detectRetina: true };
  L.tileLayer(base.base, { ...tiles, attribution: ESRI_ATTRIBUTION }).addTo(map);
  // Labels go on immediately after the base, so both sit below the radar frames
  // and strike markers the sections add later.
  L.tileLayer(base.labels, tiles).addTo(map);

  if (L.Browser.mobile) {
    // Re-enable one-finger dragging only once the user is clearly on the map.
    map.dragging.enable();
    map.getContainer().addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length > 1) map.dragging.enable();
      },
      { passive: true },
    );
  }

  // Click/tap the map to hand it the wheel; click away to give it back.
  map.getContainer().addEventListener('click', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());

  return map;
}

/** A small pulsing dot marking the user's location. */
export function homeMarker(map, lat, lon, label = 'Your location') {
  const icon = L.divIcon({
    className: 'home-marker',
    html: '<span class="home-dot"></span><span class="home-pulse"></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  return L.marker([lat, lon], { icon, title: label, keyboard: false, zIndexOffset: 1000 }).addTo(map);
}

/** Leaflet needs a nudge when a container changes size or becomes visible. */
export function observeSize(map, container) {
  const ro = new ResizeObserver(() => map.invalidateSize({ animate: false }));
  ro.observe(container);
  return () => ro.disconnect();
}
