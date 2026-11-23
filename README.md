# Police Watch

A free phone app for Roman that speaks call-outs while you drive:

- Speed cameras and red-light cameras
- Flock / other ALPR cameras
- Police aircraft overhead
- Waze police reports

It is a **Progressive Web App**. There is no App Store listing and no Apple developer fee. On iPhone you add it to the Home Screen from Safari.

Default map center is Weirton, WV / Steubenville, OH (`40.42, -80.59`). You can use GPS or type a city / lat-lon.

**Live URL (once GitHub Pages is on):** https://romanorecchio.github.io/police-watch/

## iPhone setup

1. Open the live URL in **Safari** (not Chrome).
2. Tap the Share button, then **Add to Home Screen**.
3. Open **Police Watch** from the Home Screen (this gives a full-screen app and is what iOS needs for Wake Lock).
4. Turn the ringer on and raise the volume.
5. Tap the big **Start Driving** button and allow location when asked. That tap is what unlocks spoken call-outs on iOS.
6. Keep the app in the foreground. iPhone will **not** speak from the lock screen or another app.
7. To help the screen stay on: iOS 16.4+ can use the Wake Lock API in a Home Screen app. The app also plays a silent looping video as a fallback. If the screen still sleeps, temporarily set **Settings → Display & Brightness → Auto-Lock → Never**, and plug the phone in.

Voice, GPS, and the keep-awake video all start from the Start Driving tap. Do not background Safari before you tap it.

Android works the same way (Chrome → Add to Home Screen / Install app), but this project is tuned first for iPhone.

## What the voices say

- “Flock camera ahead, 0.3 miles”
- “ALPR camera ahead, 0.4 miles”
- “Speed camera ahead”
- “Red light camera ahead”
- “Police helicopter overhead” / “Ohio Highway Patrol aircraft, 6 miles northwest”
- “Police reported 1 mile ahead”
- “Possible circling aircraft, 2 miles north. This is a guess.”

Alerts are heading-aware when you are moving, and each target has a cooldown so it does not nag every second.

## Data sources (all free, read-only, no login)

| Data | Source | Browser notes |
| --- | --- | --- |
| Police / LE aircraft list | Public [FAA Releasable Aircraft Database](https://registry.faa.gov/database/ReleasableAircraft.zip), owners matching POLICE, SHERIFF, STATE / HIGHWAY PATROL, STATE POLICE, LAW ENFORCEMENT, PUBLIC SAFETY, plus federal names (CBP, FBI, DHS, etc.) | Bundled as `data/police_aircraft.json` |
| Live aircraft | [airplanes.live](https://api.airplanes.live/v2/point/{lat}/{lon}/{radius_nm}), then [adsb.lol](https://api.adsb.lol/v2/point/...), then [adsb.fi](https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}) | **No CORS** from GitHub Pages. Uses the built-in Cloudflare Worker proxy. |
| Speed / red-light / Flock ALPR | OpenStreetMap Overpass (`surveillance:type=ALPR`, `highway=speed_camera`, enforcement relations). Same tags DeFlock uses. | **CORS is allowed** (`Access-Control-Allow-Origin: *`). |
| Waze police reports | Public live-map endpoint `https://www.waze.com/live-map/api/georss?...&types=alerts`, filtered to `type=POLICE`. Polled every 90 seconds, never faster than 60s. | Often **CORS-blocked** and sometimes **403 from datacenter IPs**. Uses the built-in proxy; Waze may still refuse the Worker IP. |

The app ships a bundled OSM camera cache for the Weirton / Pittsburgh / Wheeling area and refreshes live when Overpass is reachable.

### FAA registry counts (built 15 Nov 2026)

**1,009** U.S. registrations matched. Highlights for this area:

- **Ohio: 24** — Ohio State Highway Patrol / DPS (N*HP, including helicopters N71HP, N72HP, N73HP), Columbus PD (N553CP, N556CP, N557CP), Cleveland PD (N951CP, N952CP, N766CP), Butler County Sheriff, plus a few PD drones
- **West Virginia: 2** — WV State Police N890SP, N895SP (Bell 206B, South Charleston)
- **Pennsylvania: 14** — PA State Police aviation (N870ST–N879ST, Hershey), Philadelphia PD helicopters, Allegheny County Sheriff drone, others
- Also nationwide city/state/federal fleets so the list still works when you drive elsewhere in Ohio or WV. DC has 225 mostly DHS/CBP aircraft.

A registration on this list means the FAA owner name looks like a law-enforcement agency. It does **not** prove the plane is on a police mission right now.

## Important limits

- **Many police aircraft do not broadcast ADS-B**, or they use a blocked / hidden identity. If it is not in the public feed, this app cannot see it.
- OSM camera coverage is volunteer-mapped and can be wrong or out of date. A missing pin is not a promise the road is clear. In the bundled home-area extract (15 Nov 2026) there were **2,919** cameras (1,370 Flock, 1,532 other ALPR, 17 speed cameras, **0** red-light cameras tagged in that box). Red-light cameras may simply be unmapped.
- Waze reports are crowd-sourced and can be late, duplicated, or false.
- “Circling” is a heading-change heuristic at low altitude. The app labels it as a guess.
- This app only **reads** public data. It does not interfere with any aircraft, camera, or law-enforcement equipment.
- **Do not handle the phone while driving.** Mount it, start the app before you move, and watch the road.

## Aircraft and Waze proxy

From a phone browser, Overpass (cameras) works. The ADS-B APIs and Waze do **not** send `Access-Control-Allow-Origin`, so Safari cannot read them directly from GitHub Pages.

A Cloudflare Worker (free plan, no card) is deployed at:

`https://police-watch-proxy.policewatch.workers.dev`

The app uses that URL by default, so you do not need to paste anything in Settings. You can still override it under **Settings → Proxy URL**. Source for the Worker is in `worker/`.

The Worker adds the CORS headers the app needs. Upstream feeds can still refuse Cloudflare IPs: as of 23 Nov 2026, Waze returned **403** through the Worker, and the ADS-B fallbacks were **403** (airplanes.live, adsb.fi) or **429** (adsb.lol). Camera call-outs do not depend on this proxy.

## Run it locally (Mac or any computer)

```bash
cd police-watch
python3 -m http.server 8000
```

Open http://127.0.0.1:8000/ in Safari or Chrome. HTTPS is required for GPS on a real iPhone; GitHub Pages provides that. Localhost is allowed for testing.

Rebuild the FAA list (needs the [public zip](https://registry.faa.gov/database/ReleasableAircraft.zip)):

```bash
python3 scripts/build_registry.py --zip ReleasableAircraft.zip --outdir data
```

Refresh the local camera cache:

```bash
python3 scripts/fetch_cameras.py --out data/cameras_cache.json
```

Tests (Node 18+):

```bash
node --test tests/test_logic.mjs
```

## Legal

Read-only use of public FAA registration data, community ADS-B aggregators, OpenStreetMap, and (when available) Waze’s public live map. No scraping behind a login, no recording, no interference with equipment. Not a substitute for paying attention to the road or obeying traffic law.
