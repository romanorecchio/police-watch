import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { haversineMiles, bearingDegrees, isAhead, formatMiles, headingDelta, cardinal, bboxFromPoint } from "../js/geo.js";
import { buildRegistryIndex, classifyAircraft, updateCircling, ownerLooksLawEnforcement } from "../js/classify.js";
import { parseAdsbResponse, parseWazeResponse, parseOverpassResponse } from "../js/sources.js";
import { evaluateAlerts, markSpoken, DEFAULTS } from "../js/alerts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "data/police_aircraft.json"), "utf8"));
const sampleAdsb = JSON.parse(readFileSync(join(root, "samples/adsb_sample.json"), "utf8"));
const sampleWaze = JSON.parse(readFileSync(join(root, "samples/waze_sample.json"), "utf8"));
const sampleOverpass = JSON.parse(readFileSync(join(root, "samples/overpass_sample.json"), "utf8"));
const index = buildRegistryIndex(registry);

test("haversine is roughly correct for a known short hop", () => {
  // Pittsburgh to Weirton is about 30–35 miles
  const mi = haversineMiles(40.42, -80.59, 40.4406, -79.9959);
  assert.ok(mi > 28 && mi < 40, mi);
});

test("ahead cone and opposite heading", () => {
  assert.equal(isAhead(90, 90, 70), true);
  assert.equal(isAhead(90, 120, 70), true);
  assert.equal(isAhead(90, 180, 70), false);
  assert.equal(isAhead(null, 90, 70), null);
  assert.equal(headingDelta(10, 350), 20);
  assert.equal(cardinal(0), "north");
  assert.equal(formatMiles(0.3), "0.3 miles");
  assert.equal(formatMiles(1), "1 mile");
});

test("bbox is ordered correctly", () => {
  const b = bboxFromPoint(40.42, -80.59, 10);
  assert.ok(b.top > b.bottom);
  assert.ok(b.right > b.left);
});

test("FAA registry includes OH / WV / PA aircraft used in this project", () => {
  assert.ok(registry.counts.total >= 900);
  assert.equal(registry.counts.by_state.OH, 24);
  assert.equal(registry.counts.by_state.WV, 2);
  assert.equal(registry.counts.by_state.PA, 14);
  const n71 = index.byReg.get("N71HP");
  assert.ok(n71, "N71HP should be in the registry");
  assert.equal(n71.state, "OH");
  const wv = index.byReg.get("N890SP");
  assert.ok(wv);
  assert.match(wv.owner, /WEST VIRGINIA STATE POLICE/);
  const psp = index.byReg.get("N871ST");
  assert.ok(psp);
});

test("classifies sample aircraft: registry hit, airline miss, callsign hint", () => {
  const list = parseAdsbResponse(sampleAdsb);
  assert.equal(list.length, 3);
  const a = classifyAircraft(list[0], index);
  assert.equal(a.match, "registry");
  assert.equal(a.confidence, "high");
  assert.match(a.label, /helicopter|Highway Patrol|Police/i);
  const b = classifyAircraft(list[1], index);
  assert.equal(b.match, null);
  const c = classifyAircraft(list[2], index);
  assert.equal(c.match, "callsign");
  assert.equal(c.confidence, "low");
});

test("Waze parser keeps only POLICE alerts", () => {
  const alerts = parseWazeResponse(sampleWaze);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].lat, 40.425);
  assert.equal(alerts[0].lon, -80.589);
  assert.equal(alerts[1].id, "waze-3");
});

test("Overpass parser tags Flock, ALPR, speed, and red-light; drops unrelated nodes", () => {
  const cams = parseOverpassResponse(sampleOverpass);
  assert.equal(cams.length, 4);
  const kinds = cams.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["alpr", "flock", "red_light", "speed"]);
});

test("owner keyword helper", () => {
  assert.equal(ownerLooksLawEnforcement("OHIO STATE HIGHWAY PATROL"), true);
  assert.equal(ownerLooksLawEnforcement("DELTA AIR LINES INC"), false);
});

test("circling heuristic needs repeated heading changes at low altitude", () => {
  const hist = new Map();
  const hex = "abc123";
  let now = 1_000_000;
  let heading = 0;
  let last;
  for (let i = 0; i < 6; i++) {
    heading = (heading + 70) % 360;
    now += 15_000;
    last = updateCircling(hist, { hex, track: heading, alt_baro: 1200, gs: 80 }, now);
  }
  assert.equal(last.circling, true);
  assert.match(last.reason, /guess/i);
  const cruise = updateCircling(new Map(), { hex: "def", track: 90, alt_baro: 31000, gs: 450 }, now);
  assert.equal(cruise.circling, false);
});

test("alert engine speaks Flock ahead, Waze ahead, and overhead helicopter, with cooldowns", () => {
  const origin = { lat: 40.42, lon: -80.59 };
  const cameras = parseOverpassResponse(sampleOverpass);
  const waze = parseWazeResponse(sampleWaze);
  const aircraft = parseAdsbResponse(sampleAdsb).map((ac) => ({
    ...ac,
    classification: classifyAircraft(ac, index),
    circling: { circling: false },
  }));
  const cooldowns = new Map();
  const now = Date.now();
  const first = evaluateAlerts({
    now,
    origin,
    heading: 0, // north — Flock at 40.421,-80.591 is essentially on top / slightly north
    speedMph: 35,
    cameras,
    waze,
    aircraft,
    cooldowns,
    settings: { ...DEFAULTS, cameraAheadMiles: 0.6, wazeAheadMiles: 2, aircraftRadiusNm: 15, aircraftOverheadMiles: 3 },
  });
  const phrases = first.map((a) => a.phrase).join(" | ");
  assert.ok(first.some((a) => a.type === "flock"), phrases);
  assert.ok(first.some((a) => a.type === "police_report"), phrases);
  assert.ok(first.some((a) => a.type === "aircraft" && /overhead|Ohio|Police|helicopter/i.test(a.phrase)), phrases);
  markSpoken(cooldowns, first, now);
  const second = evaluateAlerts({
    now: now + 1000,
    origin,
    heading: 0,
    speedMph: 35,
    cameras,
    waze,
    aircraft,
    cooldowns,
    settings: DEFAULTS,
  });
  assert.equal(second.length, 0, "cooldown should suppress repeats");
});

test("does not fabricate a police match for a random airliner in live-shaped data", () => {
  const ac = parseAdsbResponse(sampleAdsb).find((a) => a.r === "N922AT");
  const result = classifyAircraft(ac, index);
  assert.equal(result.match, null);
});
