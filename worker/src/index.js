/**
 * Tiny free CORS proxy for Police Watch.
 * Deploy on Cloudflare Workers (free tier, no card required for the free plan)
 * after logging in with `npx wrangler login` and `npx wrangler deploy`.
 *
 * Endpoints:
 *   GET /adsb?lat=&lon=&radius=     — airplanes.live, then adsb.lol, then adsb.fi
 *   GET /waze?top=&bottom=&left=&right=
 *   GET /proxy?url=                 — allow-listed hosts only
 *   GET /health
 */
const ADSB = [
  (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
  (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
];
const ADSB_NAMES = ["airplanes.live", "adsb.lol", "adsb.fi"];
const ALLOWED_HOSTS = new Set([
  "api.airplanes.live",
  "api.adsb.lol",
  "opendata.adsb.fi",
  "www.waze.com",
  "overpass-api.de",
  "lz4.overpass-api.de",
  "overpass.osm.ch",
  "overpass.openstreetmap.fr",
]);

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
          const r = await fetchUp(target, { Accept: "application/json", "User-Agent": ua });
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
