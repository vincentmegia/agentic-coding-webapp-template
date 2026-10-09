// Bus Stop Finder client behaviour (docs/features/bus-stop-finder.md):
// geolocation flow, card selection/expansion, and the optional Google Map.
//
// Everything the visitor reads is rendered server-side
// (web/templates/pages/bus-stops.html, components/bus-stop-list.html,
// components/bus-arrivals.html); this file only toggles `hidden`,
// data-*/aria-* state, and the text of a few status elements from strings
// that already live in the markup. Stop data for the map comes only from
// each card's data-* attributes, and marker titles/labels are plain
// strings — never innerHTML or InfoWindow HTML (the doc's Security
// Considerations: LTA data is untrusted).
//
// External module file, no inline script, per the site CSP. All listeners
// are delegated on `document` and registered once, so the page keeps
// working if it's ever swapped in by an HTMX navigation (same concern as
// library-game.js's htmx-revisit bootstrap fix); per-page state is reset
// whenever a new #bus-stops-app element appears.

const NEARBY_URL = '/bus-stops/nearby';
const GEO_OPTIONS = { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };
const MAPS_TIMEOUT_MS = 15000;
const SWAPPABLE_ERROR_STATUSES = [400, 404, 429, 500, 503];

// Warm, low-noise map styling in the spirit of the Organic palette. Only
// applies to the legacy (non-mapId) map, which is what this page uses.
const MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#efe2c9' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6b6355' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f5ead8' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#cdd5b3' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#fbf5ea' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e2cfac' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#bdd0c7' }] },
];

let state = null;

function getApp() {
  return document.getElementById('bus-stops-app');
}

// currentState returns the state for the mounted page, creating a fresh one
// when the page element is new (first load, or swapped in again).
function currentState() {
  const app = getApp();
  if (!app) return null;
  if (!state || state.app !== app) {
    state = {
      app,
      mapsKey: app.dataset.mapsKey || '',
      // Read via the .nonce property (browsers hide the attribute value
      // from the DOM once applied), from any nonce-bearing script.
      nonce: (document.querySelector('script[nonce]') || {}).nonce || '',
      coords: null,
      selected: null,
      mapsPromise: null,
      map: null,
      markers: new Map(),
      route: null, // { code, service } of the open "where this bus goes" view
      place: null, // { position, title } of a searched postal code's address
      placeMarker: null,
      routeOverlays: [], // Polylines + stop dots for the open route
      busMarkers: [], // live positions of the open stop's oncoming buses
      userMarker: null,
    };
  }
  return state;
}

function byId(id) {
  return document.getElementById(id);
}

function show(el, visible) {
  if (el) el.hidden = !visible;
}

function roundTo3(n) {
  return Math.round(n * 1000) / 1000;
}

// --- Location ---------------------------------------------------------

function setLocating(busy) {
  document.querySelectorAll('.bus-locate-button').forEach((button) => {
    button.disabled = busy;
    const label = button.querySelector('.bus-locate-label');
    if (label) label.textContent = busy ? label.dataset.busy : label.dataset.idle;
  });
  const results = byId('bus-stop-results');
  if (results) results.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function locate() {
  const s = currentState();
  if (!s) return;
  if (!('geolocation' in navigator)) {
    showLocationOff('unsupported');
    return;
  }
  setLocating(true);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = roundTo3(position.coords.latitude);
      const lng = roundTo3(position.coords.longitude);
      s.coords = { lat, lng };
      show(byId('bus-explainer'), false);
      show(byId('bus-location-off'), false);
      // No hx-push-url: coordinates never reach the address bar.
      window.htmx.ajax('GET', `${NEARBY_URL}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, {
        target: '#bus-stop-results',
        swap: 'innerHTML',
      }).finally(() => setLocating(false));
    },
    (error) => {
      setLocating(false);
      const type = error && error.code === 1 ? 'denied' : error && error.code === 3 ? 'timeout' : 'unavailable';
      showLocationOff(type);
    },
    GEO_OPTIONS,
  );
}

function showLocationOff(type) {
  setLocating(false);
  const panel = byId('bus-location-off');
  const title = byId('bus-location-off-title');
  if (panel && title) {
    const key = 'title' + type.charAt(0).toUpperCase() + type.slice(1);
    title.textContent = panel.dataset[key] || panel.dataset.titleDenied;
  }
  show(byId('bus-explainer'), false);
  show(panel, true);
  show(byId('bus-search'), true);
  if (title) title.focus();
}

function showSearch() {
  show(byId('bus-explainer'), false);
  show(byId('bus-search'), true);
  const input = byId('bus-search-input');
  if (input) input.focus();
}



// --- Results ----------------------------------------------------------

function cards() {
  return Array.from(document.querySelectorAll('#bus-stop-results .bus-stop-card'));
}

function onResultsSwapped() {
  const s = currentState();
  if (!s) return;
  setLocating(false);
  const root = byId('bus-stop-results').firstElementChild;
  const resultState = root ? root.dataset.busState : '';
  const mode = root ? root.dataset.mode : '';
  s.selected = null;

  if (resultState === 'results') {
    if (mode === 'nearby') {
      s.place = null; // location results: no searched-address marker
      const first = cards()[0];
      if (first) select(first.dataset.code, { scroll: false });
      if (s.mapsKey) {
        ensureMap().then(() => { renderMarkers(); drawRoute(); drawBuses(); }).catch(showMapError);
      }
    } else {
      // Postal-code and name searches show the real map too: the visitor
      // chose to look that place up, so loading Google for it reveals no
      // more than the search itself. A postal search also marks the
      // searched address and, like Nearby, expands the nearest stop.
      s.place = null;
      if (mode === 'postal') {
        const lat = Number(root.dataset.placeLat);
        const lng = Number(root.dataset.placeLng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          s.place = { position: { lat, lng }, title: `${root.dataset.postal || ''} · ${root.dataset.place || ''}` };
        }
        const first = cards()[0];
        if (first) select(first.dataset.code, { scroll: false });
      }
      if (s.mapsKey) {
        ensureMap().then(() => { renderMarkers(); drawRoute(); drawBuses(); }).catch(showMapError);
      }
    }
    return;
  }

  // Empty nearby results, outside Singapore, unreadable location, or an
  // error: offer search instead.
  if (resultState === 'empty' || resultState === 'outside-sg' || resultState === 'invalid-location' || resultState === 'error') {
    show(byId('bus-search'), true);
  }
}

function emptySlot(code) {
  const slot = document.createElement('div');
  slot.id = `bus-arrivals-${code}`;
  slot.className = 'bus-arrivals-slot';
  slot.hidden = true;
  return slot;
}

function collapse(card) {
  const code = card.dataset.code;
  const s = currentState();
  if (s && s.route && s.route.code === code) closeRoute();
  card.dataset.selected = 'false';
  const toggle = card.querySelector('.bus-stop-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  const current = document.getElementById(`bus-arrivals-${code}`);
  // Replacing the polling fragment removes it from the document, which
  // ends htmx's "every 20s" polling for this stop.
  if (current) current.replaceWith(emptySlot(code));
  show(document.getElementById(`bus-detail-${code}`), false);
}

function expand(card) {
  const code = card.dataset.code;
  card.dataset.selected = 'true';
  const toggle = card.querySelector('.bus-stop-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
  show(document.getElementById(`bus-detail-${code}`), true);
  const slot = document.getElementById(`bus-arrivals-${code}`);
  if (!slot) return;
  const skeleton = byId('bus-arrivals-skeleton');
  slot.hidden = false;
  if (skeleton) slot.replaceChildren(skeleton.content.cloneNode(true));
  window.htmx.ajax('GET', `/bus-stops/${encodeURIComponent(code)}/arrivals`, {
    target: slot,
    swap: 'outerHTML',
  });
}

function select(code, { scroll = false } = {}) {
  const s = currentState();
  if (!s) return;
  const all = cards();
  const target = all.find((c) => c.dataset.code === code);
  if (!target) return;

  // Clicking the open card again collapses it.
  if (s.selected === code) {
    collapse(target);
    s.selected = null;
    highlightMarker(null);
    drawBuses();
    return;
  }

  all.forEach((c) => {
    if (c !== target && c.dataset.selected === 'true') collapse(c);
  });
  expand(target);
  s.selected = code;
  highlightMarker(code);
  drawBuses();
  // The detail panel is what opened (on phones the card itself hides).
  const detail = document.getElementById(`bus-detail-${code}`);
  if (scroll && detail) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Map --------------------------------------------------------------

function ensureMap() {
  const s = currentState();
  if (!s || !s.mapsKey) return Promise.reject(new Error('no maps key'));
  if (s.mapsPromise) return s.mapsPromise;

  s.mapsPromise = loadMapsScript(s)
    .then(async () => {
      const { Map } = await window.google.maps.importLibrary('maps');
      await window.google.maps.importLibrary('marker');
      const el = byId('bus-map');
      show(el, true);
      show(byId('bus-map-placeholder'), false);
      show(byId('bus-map-placeholder-note'), false);
      s.map = new Map(el, {
        center: s.coords || (s.place && s.place.position) || { lat: 1.3521, lng: 103.8198 },
        zoom: 17,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
        // Mouse/trackpad: scroll zooms and drag pans straight away — the
        // map is the main tool here. Touch: one finger keeps scrolling the
        // page and two fingers move the map, so the page never gets trapped.
        gestureHandling: window.matchMedia('(pointer: coarse)').matches ? 'cooperative' : 'greedy',
        styles: MAP_STYLES,
      });
      show(byId('bus-recenter'), true);
      return s.map;
    });
  return s.mapsPromise;
}

function loadMapsScript(s) {
  if (window.google && window.google.maps && window.google.maps.importLibrary) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const callbackName = '__busStopsMapsReady';
    const timer = setTimeout(() => reject(new Error('maps load timed out')), MAPS_TIMEOUT_MS);
    window[callbackName] = () => {
      clearTimeout(timer);
      resolve();
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(s.mapsKey)}&loading=async&v=weekly&callback=${callbackName}`;
    script.async = true;
    if (s.nonce) script.nonce = s.nonce;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('maps script failed'));
    };
    document.head.appendChild(script);
  });
}

function showMapError() {
  show(byId('bus-map-error'), true);
}

function markerIcon(selected) {
  return {
    path: window.google.maps.SymbolPath.CIRCLE,
    scale: selected ? 17 : 13,
    fillColor: selected ? '#a6572a' : '#c67139',
    fillOpacity: 1,
    strokeColor: '#fbf5ea',
    strokeWeight: selected ? 4 : 3,
  };
}

function renderMarkers() {
  const s = currentState();
  if (!s || !s.map) return;
  const { Marker, LatLngBounds } = window.google.maps;

  s.markers.forEach((m) => m.setMap(null));
  s.markers.clear();
  if (s.userMarker) s.userMarker.setMap(null);
  if (s.placeMarker) s.placeMarker.setMap(null);
  s.placeMarker = null;

  const bounds = new LatLngBounds();
  if (s.place) {
    // The searched address: a dark square-ish pin, distinct from the green
    // "You are here" dot and the numbered stop pins.
    s.placeMarker = new Marker({
      position: s.place.position,
      map: s.map,
      title: s.place.title, // plain string: the Maps API renders title as text
      zIndex: 1,
      icon: {
        path: 'M -7,-7 7,-7 7,7 -7,7 z',
        scale: 1,
        fillColor: '#201e1d',
        fillOpacity: 1,
        strokeColor: '#fbf5ea',
        strokeWeight: 3,
      },
    });
    bounds.extend(s.place.position);
  }
  if (s.coords) {
    s.userMarker = new Marker({
      position: s.coords,
      map: s.map,
      title: 'You are here',
      zIndex: 1,
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: '#5d6b45',
        fillOpacity: 1,
        strokeColor: '#fbf5ea',
        strokeWeight: 4,
      },
    });
    bounds.extend(s.coords);
  }

  const list = cards();
  list.forEach((card) => {
    const position = { lat: Number(card.dataset.lat), lng: Number(card.dataset.lng) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return;
    const code = card.dataset.code;
    const marker = new Marker({
      position,
      map: s.map,
      // Plain strings only: the Maps API renders title as text.
      title: `${card.dataset.name} (${code})`,
      label: { text: String(card.dataset.rank || ''), color: '#ffffff', fontWeight: '800', fontSize: '13px' },
      icon: markerIcon(code === s.selected),
      zIndex: code === s.selected ? 3 : 2,
    });
    marker.addListener('click', () => select(code, { scroll: true }));
    s.markers.set(code, marker);
    bounds.extend(position);
  });

  const chip = byId('bus-map-chip');
  if (chip) {
    chip.textContent = list.length === 1 ? '1 stop shown' : `${list.length} stops shown`;
    show(chip, list.length > 0);
  }
  if (list.length > 0) s.map.fitBounds(bounds, 64);
}

function highlightMarker(code) {
  const s = currentState();
  if (!s || !s.map) return;
  s.markers.forEach((marker, markerCode) => {
    const selected = markerCode === code;
    marker.setIcon(markerIcon(selected));
    marker.setZIndex(selected ? 3 : 2);
  });
}

// --- Route ("where this bus goes") and live buses -----------------------

const ROUTE_COLOR = '#c67139';

function routeSlot(code) {
  return document.getElementById(`bus-route-${code}`);
}

// Mark the open route's button pressed (and every other one not). Runs
// after each arrivals refresh too, since that swap re-renders the buttons.
function syncRouteButtons() {
  const s = currentState();
  if (!s) return;
  document.querySelectorAll('#bus-stops-app .bus-route-toggle').forEach((btn) => {
    const panel = btn.closest('.bus-stop-detail');
    const on = !!(s.route && panel && panel.dataset.code === s.route.code && btn.dataset.service === s.route.service);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function openRoute(code, service) {
  const s = currentState();
  const slot = routeSlot(code);
  if (!s || !slot) return;
  if (s.route && s.route.code !== code) closeRoute();
  s.route = { code, service };
  syncRouteButtons();
  window.htmx.ajax('GET', `/bus-stops/${encodeURIComponent(code)}/route/${encodeURIComponent(service)}`, {
    target: slot,
    swap: 'innerHTML',
  });
}

function closeRoute() {
  const s = currentState();
  if (!s || !s.route) return;
  const slot = routeSlot(s.route.code);
  if (slot) slot.replaceChildren();
  s.route = null;
  clearOverlays(s.routeOverlays);
  syncRouteButtons();
  drawBuses();
}

function toggleRoute(btn) {
  const s = currentState();
  const panel = btn.closest('.bus-stop-detail');
  if (!s || !panel) return;
  const code = panel.dataset.code;
  const service = btn.dataset.service;
  if (s.route && s.route.code === code && s.route.service === service) closeRoute();
  else openRoute(code, service);
}

function clearOverlays(list) {
  list.forEach((o) => o.setMap(null));
  list.length = 0;
}

function pointOf(el) {
  const lat = Number(el.dataset.lat);
  const lng = Number(el.dataset.lng);
  // data-lat is "" for a route stop LTA lists without coordinates.
  if (el.dataset.lat === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// Draw the open route: the stops it comes from as a dashed line, then the
// boarding stop onward as a solid line with a dot per stop.
function drawRoute() {
  const s = currentState();
  if (!s) return;
  clearOverlays(s.routeOverlays);
  if (!s.map || !s.route) return;
  const section = routeSlot(s.route.code) && routeSlot(s.route.code).querySelector('.bus-route');
  if (!section) return;
  const { Polyline, Marker, LatLngBounds, SymbolPath } = window.google.maps;

  const approach = [...section.querySelectorAll('.bus-route-approach li')].map(pointOf).filter(Boolean);
  const stops = [...section.querySelectorAll('.bus-route-stops li')];
  const onward = stops.map(pointOf).filter(Boolean);
  if (onward.length === 0) return;

  if (approach.length > 0) {
    s.routeOverlays.push(new Polyline({
      map: s.map,
      path: [...approach, onward[0]],
      strokeOpacity: 0,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, strokeColor: '#9c8f7a', scale: 3 }, offset: '0', repeat: '14px' }],
      zIndex: 4,
    }));
  }
  s.routeOverlays.push(new Polyline({ map: s.map, path: onward, strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 9, zIndex: 5 }));
  s.routeOverlays.push(new Polyline({ map: s.map, path: onward, strokeColor: ROUTE_COLOR, strokeOpacity: 1, strokeWeight: 5, zIndex: 6 }));

  const bounds = new LatLngBounds();
  stops.forEach((li, i) => {
    const p = pointOf(li);
    if (!p) return;
    bounds.extend(p);
    if (i === 0) return; // the boarding stop already has its numbered pin
    s.routeOverlays.push(new Marker({
      position: p,
      map: s.map,
      // Plain string only: the Maps API renders title as text.
      title: li.dataset.name || '',
      zIndex: 7,
      icon: { path: SymbolPath.CIRCLE, scale: 4.5, fillColor: '#fbf5ea', fillOpacity: 1, strokeColor: ROUTE_COLOR, strokeWeight: 3 },
    }));
  });
  s.map.fitBounds(bounds, 64);
}

// One marker per oncoming bus that LTA has a live position for, at the
// open stop. The open route's buses are filled; the rest are outlined.
function drawBuses() {
  const s = currentState();
  if (!s) return;
  clearOverlays(s.busMarkers);
  if (!s.map || !s.selected) return;
  const container = document.getElementById(`bus-arrivals-${s.selected}`);
  if (!container) return;
  const { Marker, SymbolPath } = window.google.maps;
  container.querySelectorAll('.bus-time[data-lat]').forEach((el) => {
    const p = pointOf(el);
    const row = el.closest('.bus-service-row');
    if (!p || !row) return;
    const service = row.dataset.service || '';
    const label = el.dataset.label || '';
    const onRoute = !!(s.route && s.route.service === service);
    s.busMarkers.push(new Marker({
      position: p,
      map: s.map,
      title: `Bus ${service}, ${label === 'Arr' ? 'arriving' : `${label} min away`}`,
      label: { text: service, color: onRoute ? '#ffffff' : '#201e1d', fontWeight: '800', fontSize: '11px' },
      zIndex: onRoute ? 9 : 8,
      icon: { path: SymbolPath.CIRCLE, scale: 13, fillColor: onRoute ? ROUTE_COLOR : '#fbf5ea', fillOpacity: 1, strokeColor: onRoute ? '#fbf5ea' : ROUTE_COLOR, strokeWeight: 2.5 },
    }));
  });
}

function recenter() {
  const s = currentState();
  const target = s && (s.coords || (s.place && s.place.position));
  if (!s || !s.map || !target) return;
  s.map.panTo(target);
  s.map.setZoom(17);
}

// --- Wiring -----------------------------------------------------------

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-bus-action]');
  if (!trigger || !getApp() || !getApp().contains(trigger)) return;
  const action = trigger.dataset.busAction;
  if (action === 'locate') locate();
  else if (action === 'show-search') showSearch();
  else if (action === 'recenter') recenter();
  else if (action === 'route') toggleRoute(trigger);
  else if (action === 'toggle') {
    // A list card, or the detail panel's close button (data-code).
    const card = trigger.closest('.bus-stop-card');
    const code = trigger.dataset.code || (card && card.dataset.code);
    if (code) select(code);
  }
});

// htmx doesn't swap 4xx/5xx responses by default; this page's fragments
// carry fixed, user-facing copy for those statuses (validation, 429,
// unavailable), so let them render in place.
document.addEventListener('htmx:beforeSwap', (event) => {
  const app = getApp();
  const target = event.detail.target;
  if (!app || !target || !app.contains(target)) return;
  if (SWAPPABLE_ERROR_STATUSES.includes(event.detail.xhr.status)) {
    event.detail.shouldSwap = true;
    event.detail.isError = false;
  }
});

document.addEventListener('htmx:afterSwap', (event) => {
  const target = event.detail.target;
  if (target && target.id === 'bus-stop-results') onResultsSwapped();
  if (target && target.id && target.id.startsWith('bus-route-')) drawRoute();
});

// An arrivals refresh (outerHTML swap) re-renders the Route buttons and
// moves the live buses: restore the pressed state and redraw the buses.
document.addEventListener('htmx:afterSettle', (event) => {
  const elt = event.detail.elt;
  const app = getApp();
  if (!app || !elt || !app.contains(elt)) return;
  if (elt.classList && (elt.classList.contains('bus-arrivals') || elt.classList.contains('bus-arrivals-slot'))) {
    syncRouteButtons();
    drawBuses();
  }
});

// Skip arrival polls while the tab is hidden (no hx-trigger filter
// expressions: those need eval, which the CSP forbids). The polling timer
// keeps running, so refreshes resume on the next tick after the tab is
// visible again.
document.addEventListener('htmx:beforeRequest', (event) => {
  const elt = event.detail.elt;
  if (document.hidden && elt && elt.classList && elt.classList.contains('bus-arrivals')) {
    event.preventDefault();
  }
});

currentState();
