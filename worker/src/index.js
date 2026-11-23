/**
 * Tiny free CORS proxy for Police Watch.
 * Deploy on Cloudflare Workers (free tier, no card required for the free plan)
 * after logging in with `npx wrangler login` and `npx wrangler deploy`.
 *
 * Endpoints:
 *   GET /adsb?lat=&lon=&radius=     — adsb.lol, adsb.fi, airplanes.live, then OpenSky
 *   GET /waze?top=&bottom=&left=&right=
 *   GET /proxy?url=                 — allow-listed hosts only
 *   GET /health
 */
const ADSB = [
  (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
];
const ADSB_NAMES = ["adsb.lol", "adsb.fi", "airplanes.live"];
const ALLOWED_HOSTS = new Set([
  "api.airplanes.live",
  "api.adsb.lol",
  "opendata.adsb.fi",
  "api.adsb.one",
  "opensky-network.org",
  "www.waze.com",
  "overpass-api.de",
  "lz4.overpass-api.de",
  "overpass.osm.ch",
  "overpass.openstreetmap.fr",
]);

const US_ICAO_BASE = 0xA00001;
const US_ICAO_MAX = 0xADF7C7;
const US_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const US_B1 = 101711;
const US_B2 = 10111;
const US_B3 = 951;

function usSuffix(rem) {
  if (rem === 0) return "";
  if (rem <= 600) {
    rem -= 1;
    let s = US_LETTERS.charAt(Math.floor(rem / 25));
    if (rem % 25 > 0) s += US_LETTERS.charAt((rem % 25) - 1);
    return s;
  }
  rem -= 601;
  let s = String(Math.floor(rem / 35));
  if (rem % 35 > 0) {
    const base34 = US_LETTERS + "0123456789";
    s += base34.charAt((rem % 35) - 1);
  }
  return s;
}

function icaoToNNumber(hex) {
  const n = parseInt(String(hex || "").trim().replace(/^~/, ""), 16);
  if (!Number.isFinite(n) || n < US_ICAO_BASE || n > US_ICAO_MAX) return "";
  let off = n - US_ICAO_BASE;
  let out = "N" + "123456789".charAt(Math.floor(off / US_B1));
  let r1 = off % US_B1;
  if (r1 < 601) return out + usSuffix(r1);
  const d2 = Math.floor((r1 - 601) / US_B2);
  out += "0123456789".charAt(d2);
  const r2 = (r1 - 601) % US_B2;
  if (r2 < 601) return out + usSuffix(r2);
  const d3 = Math.floor((r2 - 601) / US_B3);
  const r3 = (r2 - 601) % US_B3;
  return out + "0123456789".charAt(d3) + usSuffix(r3);
}

function metersToFeet(m) {
  const n = Number(m);
  return Number.isFinite(n) ? Math.round(n * 3.28084) : null;
}

function mpsToKnots(mps) {
  const n = Number(mps);
  return Number.isFinite(n) ? Math.round(n * 1.94384 * 10) / 10 : null;
}

function bboxFromPoint(lat, lon, radiusNm) {
  const nm = Number(radiusNm) || 15;
  const phi = (Number(lat) * Math.PI) / 180;
  const dlat = nm / 60;
  const dlon = nm / (60 * Math.max(Math.cos(phi), 0.01));
  return {
    lamin: Number(lat) - dlat,
    lamax: Number(lat) + dlat,
    lomin: Number(lon) - dlon,
    lomax: Number(lon) + dlon,
  };
}

function openSkyToAc(data) {
  const states = Array.isArray(data && data.states) ? data.states : [];
  const ac = [];
  for (const row of states) {
    if (!Array.isArray(row) || row.length < 7) continue;
    if (row[5] == null || row[6] == null) continue;
    const lat = Number(row[6]);
    const lon = Number(row[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const hex = String(row[0] || "").trim();
    const onGround = !!row[8];
    ac.push({
      hex,
      flight: String(row[1] || "").trim(),
      r: icaoToNNumber(hex),
      t: "",
      alt_baro: onGround ? "ground" : metersToFeet(row[7]),
      alt_geom: metersToFeet(row[13]),
      gs: mpsToKnots(row[9]),
      track: row[10],
      squawk: row[14] || "",
      category: row[17],
      lat,
      lon,
    });
  }
  return ac;
}

function cors(req, env, extra = {}) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = allowed.includes(origin) || allowed.includes("*") ? origin : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allow || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    ...extra,
  };
}

function json(req, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors(req, env, { "Content-Type": "application/json" }),
  });
}

async function fetchUp(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(req, env) });
    }
    if (url.pathname === "/health") {
      return json(req, env, { ok: true, service: "police-watch-proxy" });
    }
    const ua = "PoliceWatch/1.0 (personal PWA; read-only public data; github.com/romanorecchio/police-watch)";

    if (url.pathname === "/adsb") {
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      const radius = url.searchParams.get("radius") || "15";
      if (!lat || !lon) return json(req, env, { error: "lat, lon required" }, 400);
      const errors = [];
      for (let i = 0; i < ADSB.length; i++) {
        const target = ADSB[i](lat, lon, radius);
        try {
          let r = await fetchUp(target, { Accept: "application/json", "User-Agent": ua });
          if (r.status === 429 && ADSB_NAMES[i] === "adsb.lol") {
            await sleep(800);
            r = await fetchUp(target, { Accept: "application/json", "User-Agent": ua });
          }
          if (!r.ok) {
            errors.push(`${ADSB_NAMES[i]}: HTTP ${r.status}`);
            continue;
          }
          const data = JSON.parse(r.text);
          data._source = ADSB_NAMES[i];
          return json(req, env, data);
        } catch (e) {
          errors.push(`${ADSB_NAMES[i]}: ${e.message}`);
        }
      }
      const box = bboxFromPoint(lat, lon, radius);
      const osUrl = `https://opensky-network.org/api/states/all?lamin=${box.lamin}&lomin=${box.lomin}&lamax=${box.lamax}&lomax=${box.lomax}&extended=1`;
      try {
        const r = await fetchUp(osUrl, { Accept: "application/json", "User-Agent": ua });
        if (!r.ok) {
          errors.push(`opensky: HTTP ${r.status}`);
        } else {
          const raw = JSON.parse(r.text);
          return json(req, env, { ac: openSkyToAc(raw), _source: "opensky", time: raw.time, errors });
        }
      } catch (e) {
        errors.push(`opensky: ${e.message}`);
      }
      return json(req, env, { error: "all ADS-B sources failed", errors, ac: [] }, 502);
    }

    if (url.pathname === "/waze") {
      const top = url.searchParams.get("top");
      const bottom = url.searchParams.get("bottom");
      const left = url.searchParams.get("left");
      const right = url.searchParams.get("right");
      if (![top, bottom, left, right].every(Boolean)) {
        return json(req, env, { error: "top,bottom,left,right required" }, 400);
      }
      const target = `https://www.waze.com/live-map/api/georss?top=${top}&bottom=${bottom}&left=${left}&right=${right}&env=na&types=alerts`;
      try {
        const r = await fetchUp(target, {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; PoliceWatch/1.0; +https://github.com/romanorecchio/police-watch)",
          Referer: "https://www.waze.com/live-map",
        });
        if (!r.ok) return json(req, env, { error: `Waze HTTP ${r.status}`, alerts: [] }, r.status);
        return new Response(r.text, {
          status: 200,
          headers: cors(req, env, { "Content-Type": "application/json" }),
        });
      } catch (e) {
        return json(req, env, { error: e.message, alerts: [] }, 502);
      }
    }

    if (url.pathname === "/proxy") {
      const raw = url.searchParams.get("url");
      let target;
      try {
        target = new URL(raw);
      } catch {
        return json(req, env, { error: "invalid url" }, 400);
      }
      if (!ALLOWED_HOSTS.has(target.hostname)) {
        return json(req, env, { error: "host not allowed" }, 403);
      }
      const r = await fetchUp(target.toString(), { Accept: "application/json", "User-Agent": ua });
      return new Response(r.text, {
        status: r.status,
        headers: cors(req, env, { "Content-Type": "application/json" }),
      });
    }

    return json(req, env, { error: "not found" }, 404);
  },
};
