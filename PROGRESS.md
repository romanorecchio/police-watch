# Police Watch — Progress Log

Times are America/New_York (UTC-5).

## 2026-11-15 13:36 EST — Start
Created /workspace/police-watch. Python 3.13.5 on the box.
Original brief was a Mac Python app; scope later changed to a free iPhone/Android PWA.

## 2026-11-15 13:36–13:49 EST — Built the PWA
- FAA Releasable Aircraft zip (15 Nov 2026 file dated 13 Nov) parsed: **1009** LE registrations. OH 24, WV 2, PA 14. Bundled as data/police_aircraft.json + .csv.
- Live ADS-B: adsb.lol and adsb.fi return data from the box (27 aircraft near Weirton in the first snapshot). airplanes.live returns 403 from this datacenter and asks for an email. **None of the ADS-B APIs send CORS headers**, so a GitHub Pages page cannot read them in Safari without a proxy.
- Waze live-map georss: **403** from this datacenter; also no CORS. Implemented the client + a Worker proxy; status may stay blocked until a proxy IP that Waze accepts is available.
- Overpass: CORS is `Access-Control-Allow-Origin: *`. overpass.osm.ch is regional (returned 0). **overpass.openstreetmap.fr** works. Home-area cache: **2919** cameras (1370 Flock, 1532 other ALPR, 17 speed, 0 red-light) in bbox 39.8–41.35, -81.85–-79.70. Within 10 miles of Weirton: 31 Flock cameras (2 within 3 miles).
- PWA: Leaflet/OSM (Carto dark), voice via Web Speech API, heading-aware alerts, cooldowns, Wake Lock + silent video fallback, Start Driving button (iOS gesture unlock).
- Unit tests: 11/11 passing (`node --test tests/test_logic.mjs`).
- Live snapshot classification: 27 aircraft, **0 police matches**. Not fabricated.
- Cloudflare Worker source is in worker/, not deployed (no Cloudflare login on this box).
- GitHub Pages deploy is the remaining publish step.

## 2026-11-15 13:45 EST — Confirmed iPhone
Tuned for iOS Safari / Add to Home Screen:
- apple-touch-icon 180x180, apple-mobile-web-app-capable, manifest, theme-color, viewport-fit=cover, safe-area insets, 100dvh.
- Big **Start Driving** button unlocks speech with a real spoken phrase (not a silent utterance), requests GPS, starts the keep-awake video, and requests Wake Lock — all in the same tap, no await beforehand.
- Speech resume timer for the iOS pause bug; voices prefer Samantha/Siri/en-US.
- Wake Lock API (iOS 16.4+) with muted looping `media/keepawake.mp4` fallback. Documented Auto-Lock limitation.
- Layout aimed at iPhone SE / 14 / Pro Max widths; Start button 56px full width; 16px inputs to avoid focus-zoom.

## 2026-11-15 13:51 EST — Published
GitHub Pages is live at https://romanorecchio.github.io/police-watch/ (HTTPS, status built).
Repo: https://github.com/romanorecchio/police-watch
