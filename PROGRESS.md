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

## 2026-11-23 00:53 EST — Cloudflare Worker deployed
- New free Cloudflare account (Bernard, `1qjyafsb@mail.grokbot.com`). workers.dev subdomain `policewatch` registered. Email verification was required (error 10034) before the first successful deploy.
- Deployed `police-watch-proxy` (version `42c60c97-cb3c-467e-956f-3c0677df697c`) at **https://police-watch-proxy.policewatch.workers.dev**. No card or paid plan.
- From the box, with `Origin: https://romanorecchio.github.io`:
  - `/health` **200**, CORS `Access-Control-Allow-Origin: https://romanorecchio.github.io`. OPTIONS preflight **204** with the same CORS headers.
  - `/adsb?lat=40.42&lon=-80.59&radius=15` **502**: `airplanes.live` HTTP 403, `adsb.lol` HTTP 429, `adsb.fi` HTTP 403. **0 aircraft**, so **0 FAA police matches**. Same errors at 50 nm. Not fabricated. (Direct from the box, `adsb.lol` and `adsb.fi` returned 200 with **0** aircraft around 00:52 EST — a quiet night — while the Worker IP was blocked or rate-limited.)
  - `/waze` **403** (`{"error":"Waze HTTP 403","alerts":[]}`). Waze also 403s from this datacenter directly. CORS headers were still present.
- The app now uses that Worker URL as the **default proxy**. Settings can still override it. Service worker cache bumped to `police-watch-v3`.

## 2026-11-23 06:13 EST — Tried other aircraft sources
- Roman asked for a different free aircraft feed after the first Worker deploy, because airplanes.live / adsb.lol / adsb.fi refuse Cloudflare IPs.
- Tested from the Cloudflare Worker (wrangler dev --remote, Origin `https://romanorecchio.github.io`): adsb.lol **429**, adsb.fi **403**, airplanes.live **403**, api.adsb.one **403** (Cloudflare challenge), OpenSky `/states/all` **522**, ADS-B Exchange **402** (paid key). **0 aircraft** through the Worker. Not fabricated.
- Off Cloudflare, the feeds do have data. OpenSky (via an external fetch, ~06:10 EST) returned **5** aircraft in a 15 nm box around Weirton 40.42, -80.59: DAL1504 (N958DZ), PDT5872, GJS4175, ABX3148, SWA3543 (N8831L). **0 FAA police-list matches** (hex and N-number checked). From the box, adsb.lol and adsb.fi returned **2** aircraft in 15 nm (same DAL1504 and SWA3543). No CORS headers on those APIs, so the iPhone page cannot read them directly. OpenSky CORS is restricted to opensky-network.org. AirLabs sends `Access-Control-Allow-Origin: *` but needs an API key; the free quota is too small for 15-second polls. Waze was left unchanged (still 403).
- Worker and app now include OpenSky as a last fallback and map US ICAO24 hex to N-number (verified against all 1,009 bundled FAA records). Tests 14/14. This does not make aircraft pins work until a feed allows the Worker IP, or the proxy runs on a host those feeds accept.
