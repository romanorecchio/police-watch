/** Proximity + heading-aware call-outs with cooldowns. Pure logic. */

import { haversineMiles, bearingDegrees, isAhead, cardinal, formatMiles, nmToMiles } from "./geo.js";

export const DEFAULTS = {
  cameraAheadMiles: 0.6,
  cameraNearbyMiles: 0.15,
  wazeAheadMiles: 1.0,
  wazeNearbyMiles: 0.35,
  aircraftRadiusNm: 15,
  aircraftOverheadMiles: 2.0,
  coneDeg: 70,
  movingMph: 5,
  cooldownCameraMs: 8 * 60 * 1000,
  cooldownWazeMs: 6 * 60 * 1000,
  cooldownAircraftMs: 10 * 60 * 1000,
  cooldownCirclingMs: 8 * 60 * 1000,
};

export function mphFromMps(mps) {
  return Number(mps) * 2.236936;
}

/**
 * @param {object} opts
 * @returns {object[]} alerts to speak/show, already filtered by cooldown
 */
export function evaluateAlerts({
  now,
  origin,
  heading,
  speedMph,
  cameras,
  waze,
  aircraft,
  cooldowns,
  settings,
}) {
  const cfg = { ...DEFAULTS, ...(settings || {}) };
  const moving = Number(speedMph) >= cfg.movingMph && heading != null && !Number.isNaN(Number(heading));
  const out = [];

  function tryEmit(alert) {
    const last = cooldowns.get(alert.cooldownId);
    if (last && now - last < alert.cooldownMs) return;
    out.push(alert);
  }

  for (const cam of cameras || []) {
    const miles = haversineMiles(origin.lat, origin.lon, cam.lat, cam.lon);
    const brg = bearingDegrees(origin.lat, origin.lon, cam.lat, cam.lon);
    const ahead = moving ? isAhead(heading, brg, cfg.coneDeg) : null;
    const inRange = ahead ? miles <= cfg.cameraAheadMiles : miles <= (moving ? cfg.cameraNearbyMiles : cfg.cameraAheadMiles);
    if (!inRange) continue;
    const kindName =
      cam.kind === "flock"
        ? "Flock camera"
        : cam.kind === "alpr"
          ? "ALPR camera"
          : cam.kind === "red_light"
            ? "Red light camera"
            : "Speed camera";
    const phrase = ahead
      ? `${kindName} ahead, ${formatMiles(miles)}`
      : `${kindName} ${formatMiles(miles)} ${cardinal(brg)}`;
    tryEmit({
      type: cam.kind,
      priority: cam.kind === "red_light" || cam.kind === "speed" ? 3 : 4,
      cooldownId: `cam:${cam.id}`,
      cooldownMs: cfg.cooldownCameraMs,
      miles,
      bearing: brg,
      ahead: !!ahead,
      phrase,
      title: kindName,
      item: cam,
    });
  }

  for (const ev of waze || []) {
    const miles = haversineMiles(origin.lat, origin.lon, ev.lat, ev.lon);
    const brg = bearingDegrees(origin.lat, origin.lon, ev.lat, ev.lon);
    const ahead = moving ? isAhead(heading, brg, cfg.coneDeg) : null;
    const inRange = ahead ? miles <= cfg.wazeAheadMiles : miles <= (moving ? cfg.wazeNearbyMiles : cfg.wazeAheadMiles);
    if (!inRange) continue;
    const phrase = ahead
      ? `Police reported ${formatMiles(miles)} ahead`
      : `Police reported ${formatMiles(miles)} ${cardinal(brg)}`;
    tryEmit({
      type: "police_report",
      priority: 2,
      cooldownId: `waze:${ev.id}`,
      cooldownMs: cfg.cooldownWazeMs,
      miles,
      bearing: brg,
      ahead: !!ahead,
      phrase,
      title: "Police report",
      item: ev,
    });
  }

  const radiusMiles = nmToMiles(cfg.aircraftRadiusNm);
  for (const ac of aircraft || []) {
    if (!ac.classification || !ac.classification.match) {
      if (ac.circling && ac.circling.circling) {
        const miles = haversineMiles(origin.lat, origin.lon, ac.lat, ac.lon);
        if (miles <= radiusMiles) {
          const brg = bearingDegrees(origin.lat, origin.lon, ac.lat, ac.lon);
          tryEmit({
            type: "circling",
            priority: 2,
            cooldownId: `circle:${ac.hex}`,
            cooldownMs: cfg.cooldownCirclingMs,
            miles,
            bearing: brg,
            ahead: false,
            phrase: `Possible circling aircraft, ${formatMiles(miles)} ${cardinal(brg)}. This is a guess.`,
            title: "Possible circling aircraft (guess)",
            item: ac,
          });
        }
      }
      continue;
    }
    const miles = haversineMiles(origin.lat, origin.lon, ac.lat, ac.lon);
    if (miles > radiusMiles) continue;
    const brg = bearingDegrees(origin.lat, origin.lon, ac.lat, ac.lon);
    const label = ac.classification.label || "Police aircraft";
    const overhead = miles <= cfg.aircraftOverheadMiles;
    const phrase = overhead
      ? `${label} overhead`
      : `${label}, ${formatMiles(miles)} ${cardinal(brg)}`;
    tryEmit({
      type: "aircraft",
      priority: 1,
      cooldownId: `ac:${ac.hex || ac.r}`,
      cooldownMs: cfg.cooldownAircraftMs,
      miles,
      bearing: brg,
      ahead: moving ? !!isAhead(heading, brg, cfg.coneDeg) : false,
      phrase,
      title: label,
      item: ac,
    });
  }

  out.sort((a, b) => a.priority - b.priority || a.miles - b.miles);
  return out;
}

export function markSpoken(cooldowns, alerts, now) {
  for (const a of alerts) cooldowns.set(a.cooldownId, now);
}
