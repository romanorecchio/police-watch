import { haversineMiles, bearingDegrees, cardinal, formatMiles, bboxFromPoint, nmToMiles } from "./geo.js";
import { buildRegistryIndex, classifyAircraft, updateCircling } from "./classify.js";
import { evaluateAlerts, markSpoken, DEFAULTS, mphFromMps } from "./alerts.js";
import { fetchAircraftLive, fetchWazePolice, fetchCameras, DEFAULT_PROXY_BASE } from "./sources.js";
import { createSpeaker } from "./speech.js";

const DEFAULT_CENTER = { lat: 40.42, lon: -80.59, label: "Weirton / Steubenville" };
const STORAGE_KEY = "police-watch-settings-v1";

const speaker = createSpeaker();
const circlingHistory = new Map();
const cooldowns = new Map();
let registryIndex = { byHex: new Map(), byReg: new Map(), meta: {} };
let map, userMarker, headingLine, radiusCircle;
const markers = { cameras: [], aircraft: [], waze: [] };
let watchId = null;
let wakeLock = null;
let running = false;
let lastCamerasAt = 0;
let lastCameraOrigin = null;
let cameraCache = [];
let cachedBundle = [];
let latest = { aircraft: [], waze: [], cameras: [], status: {} };

const timers = { adsb: null, waze: null };

function loadSettings() {
  const defaults = {
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    useGps: true,
    voice: true,
    aircraftRadiusNm: DEFAULTS.aircraftRadiusNm,
    cameraAheadMiles: DEFAULTS.cameraAheadMiles,
    wazeAheadMiles: DEFAULTS.wazeAheadMiles,
    proxyBase: "",
    city: "",
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(defaults, JSON.parse(raw));
  } catch {}
  return defaults;
}

function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

let settings = loadSettings();
const origin = {
  lat: Number(settings.lat) || DEFAULT_CENTER.lat,
  lon: Number(settings.lon) || DEFAULT_CENTER.lon,
  heading: null,
  speedMph: 0,
  accuracy: null,
  source: "default",
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(kind, text) {
  latest.status[kind] = text;
  const el = $(`status-${kind}`);
  if (el) el.textContent = text;
}

function logAlert(alert) {
  const ul = $("alert-log");
  if (!ul) return;
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  li.innerHTML = `<span class="time">${t} ET</span> ${escapeHtml(alert.phrase)}`;
  ul.prepend(li);
  while (ul.children.length > 30) ul.removeChild(ul.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function applySettingsFromForm() {
  settings.voice = $("voice-toggle").checked;
  settings.useGps = $("gps-toggle").checked;
  settings.aircraftRadiusNm = Number($("radius-nm").value) || DEFAULTS.aircraftRadiusNm;
  settings.cameraAheadMiles = Number($("camera-miles").value) || DEFAULTS.cameraAheadMiles;
  settings.wazeAheadMiles = Number($("waze-miles").value) || DEFAULTS.wazeAheadMiles;
  settings.proxyBase = ($("proxy-base").value || "").trim();
  const lat = Number($("lat").value);
  const lon = Number($("lon").value);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    settings.lat = lat;
    settings.lon = lon;
    if (!settings.useGps) {
      origin.lat = lat;
      origin.lon = lon;
      origin.source = "manual";
      origin.heading = null;
      origin.speedMph = 0;
      updateUserMarker();
    }
  }
  settings.city = ($("city").value || "").trim();
  saveSettings(settings);
  speaker.setEnabled(settings.voice);
  updateRadiusCircle();
}

async function geocodeCity(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, mode: "cors" });
  if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
  const arr = await res.json();
  if (!arr.length) throw new Error("No place found");
  return { lat: Number(arr[0].lat), lon: Number(arr[0].lon), label: arr[0].display_name };
}

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([origin.lat, origin.lon], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  userMarker = L.circleMarker([origin.lat, origin.lon], {
    radius: 8,
    color: "#7dd3fc",
    weight: 2,
    fillColor: "#0ea5e9",
    fillOpacity: 0.9,
  }).addTo(map).bindPopup("You");
  radiusCircle = L.circle([origin.lat, origin.lon], {
    radius: nmToMiles(settings.aircraftRadiusNm) * 1609.344,
    color: "#38bdf8",
    weight: 1,
    fillOpacity: 0.05,
  }).addTo(map);
}

function updateUserMarker() {
  if (!userMarker) return;
  userMarker.setLatLng([origin.lat, origin.lon]);
  updateRadiusCircle();
}

function updateRadiusCircle() {
  if (!radiusCircle) return;
  radiusCircle.setLatLng([origin.lat, origin.lon]);
  radiusCircle.setRadius(nmToMiles(settings.aircraftRadiusNm) * 1609.344);
}

function clearLayer(list) {
  for (const m of list) map.removeLayer(m);
  list.length = 0;
}

function iconDot(color) {
  return L.divIcon({
    className: "dot-icon",
    html: `<span class="dot" style="background:${color}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function refreshMarkers() {
  clearLayer(markers.cameras);
  clearLayer(markers.aircraft);
  clearLayer(markers.waze);
  for (const c of cameraCache) {
    const color = c.kind === "flock" || c.kind === "alpr" ? "#f59e0b" : c.kind === "red_light" ? "#ef4444" : "#fb7185";
    const label =
      c.kind === "flock" ? "Flock / ALPR" : c.kind === "alpr" ? "ALPR camera" : c.kind === "red_light" ? "Red light camera" : "Speed camera";
    const m = L.marker([c.lat, c.lon], { icon: iconDot(color), keyboard: false }).addTo(map);
    m.bindPopup(`${label}${c.operator ? " — " + c.operator : ""}`);
    markers.cameras.push(m);
  }
  for (const ev of latest.waze) {
    const m = L.marker([ev.lat, ev.lon], { icon: iconDot("#a78bfa"), keyboard: false }).addTo(map);
    m.bindPopup(`Waze police report${ev.street ? " — " + ev.street : ""}${ev.subtype ? " (" + ev.subtype + ")" : ""}`);
    markers.waze.push(m);
  }
  for (const ac of latest.aircraft) {
    const isLe = !!(ac.classification && ac.classification.match);
    const color = isLe ? "#facc15" : ac.circling && ac.circling.circling ? "#f97316" : "#64748b";
    const m = L.marker([ac.lat, ac.lon], { icon: iconDot(color), keyboard: false }).addTo(map);
    const alt = ac.alt_baro != null ? ` ${ac.alt_baro} ft` : "";
    const title = isLe ? ac.classification.label : ac.flight || ac.r || ac.hex;
    m.bindPopup(`${title}<br>${ac.r || ""} ${ac.t || ""}${alt}${isLe && ac.classification.source ? "<br>" + ac.classification.source : ""}${ac.circling && ac.circling.circling ? "<br>Circling guess" : ""}`);
    markers.aircraft.push(m);
  }
  if ($("count-aircraft")) {
    $("count-aircraft").textContent = String(latest.aircraft.filter((a) => a.classification && a.classification.match).length);
    $("count-all-aircraft").textContent = String(latest.aircraft.length);
    $("count-waze").textContent = String(latest.waze.length);
    $("count-cameras").textContent = String(cameraCache.length);
  }
}

function tickAlerts() {
  const alerts = evaluateAlerts({
    now: Date.now(),
    origin,
    heading: origin.heading,
    speedMph: origin.speedMph,
    cameras: cameraCache,
    waze: latest.waze,
    aircraft: latest.aircraft,
    cooldowns,
    settings,
  });
  if (alerts.length) {
    markSpoken(cooldowns, alerts, Date.now());
    for (const a of alerts) {
      logAlert(a);
      if (settings.voice) speaker.speak(a.phrase);
    }
  }
  $("count-aircraft").textContent = String(latest.aircraft.filter((a) => a.classification && a.classification.match).length);
  $("count-all-aircraft").textContent = String(latest.aircraft.length);
  $("count-waze").textContent = String(latest.waze.length);
  $("count-cameras").textContent = String(cameraCache.length);
}

async function pollAircraft() {
  const radius = settings.aircraftRadiusNm;
  const res = await fetchAircraftLive(origin.lat, origin.lon, radius, { proxyBase: settings.proxyBase });
  const now = Date.now();
  const classified = res.aircraft.map((ac) => {
    const classification = classifyAircraft(ac, registryIndex);
    const circling = updateCircling(circlingHistory, ac, now);
    return { ...ac, classification, circling };
  });
  latest.aircraft = classified;
  const le = classified.filter((a) => a.classification.match);
  if (res.source) {
    setStatus("adsb", `${classified.length} aircraft (${le.length} matched LE list) via ${res.source}`);
  } else {
    const detail = (res.errors || []).join("; ");
    setStatus("adsb", detail ? `Aircraft feed failed (${detail}).` : "Aircraft feed unavailable.");
  }
  refreshMarkers();
  tickAlerts();
}

async function pollWaze() {
  const bbox = bboxFromPoint(origin.lat, origin.lon, Math.max(settings.wazeAheadMiles * 2, 8));
  const res = await fetchWazePolice(bbox, { proxyBase: settings.proxyBase });
  latest.waze = res.alerts;
  if (res.source) setStatus("waze", `${res.alerts.length} police reports via ${res.source}`);
  else {
    const detail = (res.errors || []).join("; ");
    setStatus("waze", detail ? `Waze police feed failed (${detail}).` : "Waze police feed unavailable.");
  }
  refreshMarkers();
  tickAlerts();
}

async function pollCameras(force = false) {
  const now = Date.now();
  if (!force && lastCameraOrigin && now - lastCamerasAt < 8 * 60 * 1000) {
    const moved = haversineMiles(lastCameraOrigin.lat, lastCameraOrigin.lon, origin.lat, origin.lon);
    if (moved < 5) return;
  }
  const bbox = bboxFromPoint(origin.lat, origin.lon, 25);
  const res = await fetchCameras(bbox);
  lastCamerasAt = now;
  lastCameraOrigin = { lat: origin.lat, lon: origin.lon };
  if (res.cameras.length) {
    cameraCache = mergeCameras(res.cameras, cachedBundle, origin, 30);
    setStatus("cameras", `${res.cameras.length} OSM cameras in view (${cameraCache.length} cached)`);
  } else {
    cameraCache = mergeCameras([], cachedBundle, origin, 30);
    setStatus("cameras", `Live OSM query failed; using ${cameraCache.length} bundled cameras. ${summarizeErrors(res.errors)}`);
  }
  refreshMarkers();
  tickAlerts();
}

function mergeCameras(live, bundled, orig, maxMiles) {
  const map = new Map();
  for (const c of [...bundled, ...live]) {
    if (haversineMiles(orig.lat, orig.lon, c.lat, c.lon) <= maxMiles) map.set(c.id, c);
  }
  return [...map.values()];
}

function summarizeErrors(errors) {
  if (!errors || !errors.length) return "";
  const last = errors[errors.length - 1];
  return last.length > 160 ? last.slice(0, 157) + "…" : last;
}

function onPosition(pos) {
  const c = pos.coords;
  origin.lat = c.latitude;
  origin.lon = c.longitude;
  origin.accuracy = c.accuracy;
  origin.source = "gps";
  if (c.heading != null && !Number.isNaN(c.heading)) origin.heading = c.heading;
  if (c.speed != null && !Number.isNaN(c.speed)) origin.speedMph = mphFromMps(c.speed);
  $("lat").value = origin.lat.toFixed(5);
  $("lon").value = origin.lon.toFixed(5);
  $("fix-info").textContent =
    `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)} · ${origin.speedMph ? Math.round(origin.speedMph) + " mph" : "stationary"}` +
    (origin.heading != null ? ` · heading ${Math.round(origin.heading)}°` : "");
  updateUserMarker();
  if (map && !map._userPanned) map.panTo([origin.lat, origin.lon], { animate: true });
}

function onPositionError(err) {
  const msg = `GPS: ${err.message || err.code}. Using ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}.`;
  setStatus("gps", msg);
  if ($("fix-info")) $("fix-info").textContent = `GPS unavailable · ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
}

let keepVideo = null;

function startKeepAwakeFallback() {
  keepVideo = $("keepawake-video");
  if (!keepVideo) return false;
  keepVideo.muted = true;
  keepVideo.loop = true;
  keepVideo.setAttribute("playsinline", "");
  keepVideo.setAttribute("webkit-playsinline", "true");
  const play = keepVideo.play();
  if (play && play.then) {
    play.catch(() => {
      setStatus("wake", "Could not start the screen-on fallback video. Leave Auto-Lock off.");
    });
  }
  return true;
}

function stopKeepAwakeFallback() {
  if (!keepVideo) return;
  try {
    keepVideo.pause();
    keepVideo.currentTime = 0;
  } catch {}
}

async function requestWakeLock() {
  const hasVideo = startKeepAwakeFallback();
  try {
    if (navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        if (running) requestWakeLock().catch(() => {});
      });
      setStatus("wake", "Screen will stay on (Wake Lock). Keep Police Watch in the foreground for voice — iPhone will not speak from the lock screen or another app.");
      return;
    }
  } catch (e) {
    // Fall through to the video / manual fallback. Common if the page is not visible.
  }
  if (hasVideo) {
    setStatus("wake", "Wake Lock unavailable; using a silent video to help keep the screen on. On iPhone, also set Auto-Lock to Never while driving, and keep this app open.");
  } else {
    setStatus("wake", "Could not keep the screen awake automatically. On iPhone: Settings → Auto-Lock → Never, keep the app open, and leave the screen on.");
  }
}

function releaseWakeLock() {
  stopKeepAwakeFallback();
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function startGps() {
  if (settings.useGps && navigator.geolocation) {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
    setStatus("gps", "Waiting for GPS… Allow location if iPhone asks.");
    if ($("fix-info")) $("fix-info").textContent = "Waiting for GPS…";
  } else {
    setStatus("gps", `Manual location ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`);
    if ($("fix-info")) $("fix-info").textContent = `Manual · ${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
  }
}

function startLoops() {
  stopLoops();
  pollAircraft();
  pollWaze();
  pollCameras(true);
  timers.adsb = setInterval(pollAircraft, 15000);
  timers.waze = setInterval(pollWaze, 90000);
}

function stopLoops() {
  if (timers.adsb) clearInterval(timers.adsb);
  if (timers.waze) clearInterval(timers.waze);
  timers.adsb = timers.waze = null;
}

function start() {
  // Everything that needs the iOS user-gesture (speech, GPS, wake video)
  // must run in this click stack — no await beforehand.
  applySettingsFromForm();
  speaker.setEnabled(settings.voice);
  if (settings.voice) {
    speaker.unlock("Police Watch started. Voice is on.");
  }
  startKeepAwakeFallback();
  startGps();
  running = true;
  document.body.classList.add("running");
  $("start-btn").hidden = true;
  $("stop-btn").hidden = false;
  requestWakeLock();
  startLoops();
  if (map) setTimeout(() => map.invalidateSize(), 250);
}

function stop() {
  running = false;
  $("start-btn").hidden = false;
  $("stop-btn").hidden = true;
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  stopLoops();
  releaseWakeLock();
  document.body.classList.remove("running");
  setStatus("wake", "Stopped.");
}

async function loadRegistry() {
  const res = await fetch("data/police_aircraft.json", { cache: "force-cache" });
  const payload = await res.json();
  registryIndex = buildRegistryIndex(payload);
  const counts = payload.counts || {};
  setStatus(
    "registry",
    `LE aircraft list: ${counts.total || payload.aircraft.length} registrations (OH ${counts.by_state?.OH || 0}, WV ${counts.by_state?.WV || 0}, PA ${counts.by_state?.PA || 0})`
  );
}

async function loadCameraBundle() {
  try {
    const res = await fetch("data/cameras_cache.json", { cache: "force-cache" });
    if (!res.ok) return;
    const payload = await res.json();
    cachedBundle = payload.cameras || payload || [];
    cameraCache = mergeCameras([], cachedBundle, origin, 30);
    setStatus("cameras", `${cachedBundle.length} bundled OSM cameras (will refresh live when possible)`);
    refreshMarkers();
  } catch {
    cachedBundle = [];
  }
}

function fillForm() {
  $("voice-toggle").checked = settings.voice;
  $("gps-toggle").checked = settings.useGps;
  $("radius-nm").value = settings.aircraftRadiusNm;
  $("camera-miles").value = settings.cameraAheadMiles;
  $("waze-miles").value = settings.wazeAheadMiles;
  $("proxy-base").value = settings.proxyBase || DEFAULT_PROXY_BASE;
  $("lat").value = Number(settings.lat).toFixed(5);
  $("lon").value = Number(settings.lon).toFixed(5);
  $("city").value = settings.city || "";
}

function bindUi() {
  $("start-btn").addEventListener("click", start);
  $("stop-btn").addEventListener("click", stop);
  $("settings-toggle").addEventListener("click", () => {
    $("settings-panel").classList.toggle("open");
  });
  $("settings-form").addEventListener("change", applySettingsFromForm);
  $("lookup-city").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const q = $("city").value.trim();
    if (!q) return;
    try {
      const place = await geocodeCity(q);
      $("lat").value = place.lat.toFixed(5);
      $("lon").value = place.lon.toFixed(5);
      settings.useGps = false;
      $("gps-toggle").checked = false;
      applySettingsFromForm();
      map.setView([place.lat, place.lon], 12);
      setStatus("gps", `Set to ${place.label}`);
    } catch (e) {
      setStatus("gps", `Place lookup failed: ${e.message}`);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running) {
      requestWakeLock();
      startKeepAwakeFallback();
    }
  });
  window.addEventListener("orientationchange", () => {
    if (map) setTimeout(() => map.invalidateSize(), 300);
  });
  window.addEventListener("resize", () => {
    if (map) map.invalidateSize();
  });
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) document.body.classList.add("standalone");
}

async function main() {
  fillForm();
  initMap();
  bindUi();
  speaker.setEnabled(settings.voice);
  await Promise.all([loadRegistry(), loadCameraBundle()]);
  updateUserMarker();
  setStatus("boot", "Ready. Tap Start Driving so iPhone can unlock voice and ask for location. Keep the app on screen for call-outs.");
}

main().catch((err) => {
  setStatus("boot", `Failed to start: ${err.message}`);
  console.error(err);
});
