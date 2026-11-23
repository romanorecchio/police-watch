const CACHE = "police-watch-v3";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/geo.js",
  "./js/classify.js",
  "./js/alerts.js",
  "./js/sources.js",
  "./js/speech.js",
  "./data/police_aircraft.json",
  "./data/cameras_cache.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./media/keepawake.mp4",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Never cache live APIs.
  const live =
    /overpass|adsb\.|airplanes\.live|waze\.com|nominatim|basemaps\.cartocdn|tile\.openstreetmap/.test(url.hostname) ||
    url.pathname.includes("/adsb") ||
    url.pathname.includes("/waze") ||
    url.pathname.includes("/proxy");
  if (live) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((res) => {
          if (res && res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
