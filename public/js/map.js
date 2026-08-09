// Leaflet setup shared by the radar, lightning and hurricane maps.
//
// Leaflet is vendored under /vendor/leaflet, so no map code is fetched from a
// CDN. Basemap tiles come from CARTO's free raster service; only the tile
// coordinates you look at are ever requested.

const BASEMAPS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
};

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
  L.tileLayer(base.url, { attribution: base.attribution, subdomains: 'abcd', maxZoom: 19, detectRetina: true }).addTo(map);

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
