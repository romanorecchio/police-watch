/** Parse public ADS-B, Waze, and Overpass responses. Fetch helpers are browser-safe. */

export const DEFAULT_PROXY_BASE = "https://police-watch-proxy.policewatch.workers.dev";

/** Empty/missing values fall back to the built-in Worker. A non-empty value overrides it. */
export function resolveProxyBase(proxyBase) {
  const value = (proxyBase == null ? "" : String(proxyBase)).trim();
  return (value || DEFAULT_PROXY_BASE).replace(/\/$/, "");
}



/** US Mode S (ICAO24) hex in A00001–ADF7C7 maps to an N-number. Used for OpenSky, which has no registration field. */
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

export function icaoToNNumber(hex) {
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
  return Number.isFinite(n) ? Math.round(n * 3.28084) : m;
}

function mpsToKnots(mps) {
  const n = Number(mps);
  return Number.isFinite(n) ? Math.round(n * 1.94384 * 10) / 10 : mps;
}

/** Map one OpenSky state-vector array into the ADS-B v2-like object the rest of the app expects. */
export function parseOpenSkyState(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  if (row[5] == null || row[6] == null) return null;
  const lat = Number(row[6]);
  const lon = Number(row[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hex = String(row[0] || "").trim();
  const onGround = !!row[8];
  return {
    hex,
    flight: String(row[1] || "").trim(),
    r: icaoToNNumber(hex),
    t: "",
    desc: "",
    ownOp: "",
    origin_country: row[2] || "",
    alt_baro: onGround ? "ground" : metersToFeet(row[7]),
    alt_geom: metersToFeet(row[13]),
    gs: mpsToKnots(row[9]),
    track: row[10],
    squawk: row[14] || "",
    category: row[17],
    type: "opensky",
    lat,
    lon,
    on_ground: onGround,
    raw: row,
  };
}

export function parseAdsbResponse(data) {
  if (!data || typeof data !== "object") return [];
  const list = data.ac || data.aircraft || data.states || [];
  if (!Array.isArray(list)) return [];
  // OpenSky /states/all returns an array of state-vector arrays.
  if (list.length && Array.isArray(list[0])) {
    return list.map(parseOpenSkyState).filter(Boolean);
  }
  return list
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      const lat = Number(a.lat);
      const lon = Number(a.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        hex: String(a.hex || a.icao || "").trim(),
        flight: String(a.flight || a.callsign || "").trim(),
        r: String(a.r || a.reg || a.registration || "").trim(),
        t: String(a.t || a.tType || a.type || "").trim(),
        desc: a.desc || "",
        ownOp: a.ownOp || a.ownOpName || "",
        alt_baro: a.alt_baro,
        alt_geom: a.alt_geom,
        gs: a.gs,
        track: a.track,
        squawk: a.squawk,
        category: a.category,
        type: a.type,
        lat,
        lon,
        dst: a.dst,
        seen: a.seen,
        raw: a,
      };
    })
    .filter(Boolean);
}

export function parseWazeResponse(data) {
  const alerts = [];
  if (!data) return alerts;
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.alerts)) list = data.alerts;
  else if (data.jams && Array.isArray(data.alerts)) list = data.alerts;
  else if (data.rss && data.rss.channel) {
    // GeoRSS XML-as-JSON is uncommon; ignore here.
    list = [];
  }
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const typ = String(a.type || a.alertType || "").toUpperCase();
    if (typ && typ !== "POLICE") continue;
    // If type is missing, only keep obvious police subtypes.
    const sub = String(a.subtype || a.subType || "");
    if (!typ && !/POLICE/i.test(sub)) continue;
    let lat = null;
    let lon = null;
    if (a.location && typeof a.location === "object") {
      lat = Number(a.location.y ?? a.location.lat);
      lon = Number(a.location.x ?? a.location.lon);
    }
    if (!Number.isFinite(lat)) lat = Number(a.lat ?? a.latitude);
    if (!Number.isFinite(lon)) lon = Number(a.lon ?? a.lng ?? a.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = String(a.uuid || a.id || `${lat.toFixed(5)},${lon.toFixed(5)},${a.pubMillis || a.nThumbsUp || ""}`);
    alerts.push({
      id,
      type: "POLICE",
      subtype: sub,
      lat,
      lon,
      street: a.street || a.road || "",
      city: a.city || "",
      reliability: a.reliability,
      confidence: a.confidence,
      pubMillis: Number(a.pubMillis || a.pubTime || 0) || null,
    });
  }
  return alerts;
}

function isFlock(tags) {
  const blob = [
    tags.manufacturer,
    tags.brand,
    tags.operator,
    tags["surveillance:manufacturer"],
    tags["surveillance:brand"],
    tags["surveillance:operator"],
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes("flock");
}

function cameraKind(tags) {
  const t = tags || {};
  const ev = String(t.enforcement || t["enforcement:for"] || t.restriction || "").toLowerCase();
  if (
    ev.includes("traffic_signals") ||
    ev.includes("red_light") ||
    String(t["speed_camera:type"] || "").toLowerCase().includes("red") ||
    t["traffic_signals"] === "red_light" ||
    t.device === "red_light_camera"
  ) {
    return "red_light";
  }
  if (t.highway === "speed_camera" || ev.includes("maxspeed") || ev.includes("speed") || t.device === "safety_camera") {
    return "speed";
  }
  if (String(t["surveillance:type"] || t.surveillance || "").toUpperCase() === "ALPR") {
    return isFlock(t) ? "flock" : "alpr";
  }
  if (isFlock(t)) return "flock";
  return "unknown";
}

export function parseOverpassResponse(data) {
  const elements = (data && data.elements) || [];
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    if (!el) continue;
    const tags = el.tags || {};
    let lat = Number(el.lat);
    let lon = Number(el.lon);
    if (!Number.isFinite(lat) && el.center) {
      lat = Number(el.center.lat);
      lon = Number(el.center.lon);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const kind = cameraKind(tags);
    if (kind === "unknown") continue;
    const id = `${el.type || "node"}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      lat,
      lon,
      operator: tags.operator || tags.brand || tags.manufacturer || "",
      direction: tags.direction || tags["camera:direction"] || "",
      tags,
    });
  }
  return out;
}

export function overpassQuery(bbox) {
  const box = `${bbox.bottom},${bbox.left},${bbox.top},${bbox.right}`;
  return `[out:json][timeout:45];
(
  node["surveillance:type"="ALPR"](${box});
  node["man_made"="surveillance"]["surveillance:type"="ALPR"](${box});
  node["highway"="speed_camera"](${box});
  way["highway"="speed_camera"](${box});
  node["enforcement"="maxspeed"](${box});
  node["enforcement"="traffic_signals"](${box});
  node["enforcement"="red_light"](${box});
  way["enforcement"="maxspeed"](${box});
  way["enforcement"="traffic_signals"](${box});
  relation["enforcement"="maxspeed"](${box});
  relation["enforcement"="traffic_signals"](${box});
);
out center tags;`;
}

export const OVERPASS_ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

export const ADSB_ENDPOINTS = [
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

export function wazeUrl(bbox) {
  const q = new URLSearchParams({
    top: String(bbox.top),
    bottom: String(bbox.bottom),
    left: String(bbox.left),
    right: String(bbox.right),
    env: "na",
    types: "alerts",
  });
  return `https://www.waze.com/live-map/api/georss?${q.toString()}`;
}

function joinProxy(proxyBase, targetUrl, extraPath) {
  if (!proxyBase) return targetUrl;
  const base = proxyBase.replace(/\/$/, "");
  if (extraPath) {
    const u = new URL(base + extraPath);
    return u.toString();
  }
  return `${base}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Fetch JSON, trying a project proxy first (same-origin or configured), then
 * the direct URL (works only if the API sends CORS headers).
 */
export async function fetchJson(url, options = {}) {
  const headers = Object.assign({ Accept: "application/json" }, options.headers || {});
  const res = await fetch(url, { method: options.method || "GET", headers, body: options.body, mode: "cors" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function fetchAircraftLive(lat, lon, radiusNm, options = {}) {
  const errors = [];
  const proxy = resolveProxyBase(options.proxyBase);
  if (proxy) {
    try {
      const url = `${proxy}/adsb?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radius=${encodeURIComponent(radiusNm)}`;
      const data = await fetchJson(url);
      return { aircraft: parseAdsbResponse(data), source: data._source || "proxy", errors };
    } catch (e) {
      errors.push(`proxy: ${e.message}`);
    }
  }
  for (const ep of ADSB_ENDPOINTS) {
    try {
      const data = await fetchJson(ep.url(lat, lon, radiusNm));
      return { aircraft: parseAdsbResponse(data), source: ep.name, errors };
    } catch (e) {
      errors.push(`${ep.name}: ${e.message}`);
    }
  }
  return { aircraft: [], source: null, errors };
}

export async function fetchWazePolice(bbox, options = {}) {
  const errors = [];
  const target = wazeUrl(bbox);
  const proxy = resolveProxyBase(options.proxyBase);
  const tries = [];
  if (proxy) tries.push(`${proxy}/waze?top=${bbox.top}&bottom=${bbox.bottom}&left=${bbox.left}&right=${bbox.right}`);
  tries.push(target);
  for (const url of tries) {
    try {
      const data = await fetchJson(url, {
        headers: url.includes("waze.com")
          ? { Accept: "application/json", Referer: "https://www.waze.com/live-map" }
          : { Accept: "application/json" },
      });
      return { alerts: parseWazeResponse(data), source: url.includes("/waze") && proxy ? "proxy" : "waze", errors };
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  return { alerts: [], source: null, errors };
}

export async function fetchCameras(bbox, options = {}) {
  const errors = [];
  const query = overpassQuery(bbox);
  const endpoints = options.endpoints || OVERPASS_ENDPOINTS;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json" },
        body: new URLSearchParams({ data: query }),
        mode: "cors",
      });
      if (!res.ok) {
        errors.push(`${ep}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      return { cameras: parseOverpassResponse(data), source: ep, errors };
    } catch (e) {
      errors.push(`${ep}: ${e.message}`);
    }
  }
  return { cameras: [], source: null, errors };
}

// silence unused in some bundlers
void joinProxy;
