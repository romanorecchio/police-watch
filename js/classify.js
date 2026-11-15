/** Classify ADS-B aircraft against the FAA police/LE registry and heuristics. */

import { headingDelta } from "./geo.js";

const OWNER_WORDS = [
  "POLICE",
  "SHERIFF",
  "SHERRIF",
  "STATE PATROL",
  "HIGHWAY PATROL",
  "STATE POLICE",
  "LAW ENFORCEMENT",
  "PUBLIC SAFETY",
  "CUSTOMS AND BORDER",
  "CUSTOMS & BORDER",
  "BORDER PATROL",
  "HOMELAND SECURITY",
  "FEDERAL BUREAU",
  "DRUG ENFORCEMENT",
  "MARSHAL",
  "IMMIGRATION AND CUSTOMS",
];

const CALLSIGN_HINTS = [
  /POLICE/i,
  /SHERIFF/i,
  /\bS\/?O\b/i,
  /\bOSP\b/i,
  /\bOHP\b/i,
  /\bWVSP\b/i,
  /\bPSP\b/i,
  /\bSTATE\s*P(D|ATROL|OLICE)\b/i,
  /\bC[BP]P\b/i,
];

const HELI_TYPE_RE = /^(A109|A119|A139|A169|AS50|AS55|AS65|B06|B06T|B407|B412|B429|B430|B47G|BK17|EC20|EC30|EC35|EC45|EC55|EC75|H500|H60|H64|MD50|MD52|MD60|R22|R44|R66|S76|S92|UH1|UH60|AS35|H120|H130|H135|H145|H155|H160|H175|H225|S70|AW13|AW14|AW16|AW18|B212|B222|B230|B412|B427|B505|R44|S360|EN28|H269)/i;
const HELI_TEXT_RE = /HELICOPTER|HELI\b|AS.?350|AS.?355|EC.?13|EC.?135|BELL\s*2(06|07|12|22|407|429)|MD\s*369|OH-?58|UH-?60|ROBINSON|EUROCOPTER|AIRBUS HELICOPTERS/i;

export function normalizeHex(hex) {
  return String(hex || "").trim().toLowerCase().replace(/^~/, "");
}

export function normalizeReg(reg) {
  return String(reg || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function buildRegistryIndex(payload) {
  const byHex = new Map();
  const byReg = new Map();
  const list = (payload && payload.aircraft) || payload || [];
  for (const rec of list) {
    if (rec.hex) byHex.set(normalizeHex(rec.hex), rec);
    if (rec.reg) byReg.set(normalizeReg(rec.reg), rec);
  }
  return { byHex, byReg, meta: payload && payload.counts ? payload : {} };
}

export function ownerLooksLawEnforcement(text) {
  if (!text) return false;
  const u = String(text).toUpperCase();
  return OWNER_WORDS.some((w) => u.includes(w));
}

export function isHelicopter(ac, registryRec) {
  const t = String(ac.t || ac.tType || ac.icaoType || "").trim();
  if (t && HELI_TYPE_RE.test(t)) return true;
  const cat = String(ac.category || "");
  if (cat === "A7" || cat === "B6") return true;
  const blob = [ac.desc, ac.t, registryRec?.mfr, registryRec?.model].filter(Boolean).join(" ");
  if (blob && HELI_TEXT_RE.test(blob)) return true;
  return false;
}

/**
 * @returns {{match: 'registry'|'owner'|'callsign'|null, record: object|null, label: string, confidence: 'high'|'medium'|'low'}}
 */
export function classifyAircraft(ac, index) {
  const hex = normalizeHex(ac.hex);
  const reg = normalizeReg(ac.r || ac.reg || ac.registration);
  const rec = (hex && index.byHex.get(hex)) || (reg && index.byReg.get(reg)) || null;
  if (rec) {
    const kind = isHelicopter(ac, rec) ? "helicopter" : "aircraft";
    const who = agencyShortName(rec);
    return {
      match: "registry",
      record: rec,
      kind,
      label: who ? `${who} ${kind}` : `Police ${kind}`,
      confidence: "high",
      source: `${rec.owner}${rec.city ? " — " + rec.city + ", " + rec.state : ""}`,
    };
  }
  const owner = ac.ownOp || ac.ownOpName || ac.operator || "";
  if (ownerLooksLawEnforcement(owner)) {
    const kind = isHelicopter(ac, null) ? "helicopter" : "aircraft";
    return {
      match: "owner",
      record: null,
      kind,
      label: `Police ${kind}`,
      confidence: "medium",
      source: String(owner).trim(),
    };
  }
  const flight = String(ac.flight || ac.callsign || "").trim();
  if (flight && CALLSIGN_HINTS.some((re) => re.test(flight))) {
    const kind = isHelicopter(ac, null) ? "helicopter" : "aircraft";
    return {
      match: "callsign",
      record: null,
      kind,
      label: `Possible police ${kind}`,
      confidence: "low",
      source: `Callsign ${flight}`,
    };
  }
  return { match: null, record: null, kind: isHelicopter(ac, null) ? "helicopter" : "aircraft", label: "", confidence: null, source: "" };
}

export function agencyShortName(rec) {
  if (!rec) return "Police";
  const blob = `${rec.owner || ""} ${rec.other_names || ""}`;
  const u = blob.toUpperCase();
  if (u.includes("OHIO STATE HIGHWAY") || (rec.state === "OH" && /HP$/.test(rec.reg || ""))) {
    return "Ohio Highway Patrol";
  }
  if (u.includes("WEST VIRGINIA STATE POLICE")) return "West Virginia State Police";
  if (u.includes("PENNSYLVANIA STATE POLICE")) return "Pennsylvania State Police";
  if (u.includes("COLUMBUS") && u.includes("POLICE")) return "Columbus Police";
  if (u.includes("CLEVELAND") && (u.includes("POLICE") || u.includes("PUBLIC SAFETY"))) return "Cleveland Police";
  if (u.includes("CINCINNATI") && u.includes("POLICE")) return "Cincinnati Police";
  if (u.includes("PITTSBURGH") && u.includes("POLICE")) return "Pittsburgh Police";
  if (u.includes("CUSTOMS") || u.includes("BORDER")) return "Border Patrol";
  if (u.includes("HOMELAND")) return "Homeland Security";
  if (u.includes("FEDERAL BUREAU")) return "FBI";
  if (rec.cat === "sheriff") return "Sheriff";
  if (rec.cat === "state_police") return "State police";
  if (rec.cat === "federal") return "Federal";
  return "Police";
}

/**
 * Circling / loitering heuristic. Not a confirmation of police activity.
 * Tracks recent headings and requires several large heading changes at low
 * altitude and modest ground speed.
 */
export function updateCircling(historyByHex, ac, nowMs, options = {}) {
  const hex = normalizeHex(ac.hex);
  if (!hex) return { circling: false, reason: "" };
  const maxAlt = options.maxAltFt ?? 3500;
  const maxGs = options.maxGsKt ?? 140;
  const windowMs = options.windowMs ?? 120000;
  const minTurns = options.minTurns ?? 3;
  const turnDeg = options.turnDeg ?? 50;

  const alt = Number(ac.alt_baro ?? ac.alt_geom ?? ac.alt);
  const gs = Number(ac.gs ?? ac.groundSpeed);
  const track = Number(ac.track ?? ac.trk ?? ac.heading);
  const list = historyByHex.get(hex) || [];
  const next = list.filter((p) => nowMs - p.t <= windowMs);
  if (Number.isFinite(track)) next.push({ t: nowMs, track, alt, gs });
  historyByHex.set(hex, next);

  const groundOrLow = !Number.isFinite(alt) || alt <= maxAlt || String(ac.alt_baro).toLowerCase() === "ground";
  const slowish = !Number.isFinite(gs) || gs <= maxGs;
  if (!groundOrLow || !slowish || next.length < minTurns + 1) {
    return { circling: false, reason: "" };
  }
  let turns = 0;
  let signed = 0;
  for (let i = 1; i < next.length; i++) {
    const d = ((next[i].track - next[i - 1].track + 540) % 360) - 180;
    if (Math.abs(d) >= turnDeg) {
      turns += 1;
      signed += Math.sign(d);
    }
  }
  if (turns >= minTurns) {
    return {
      circling: true,
      reason: `Heading changed substantially ${turns} times in the last two minutes at ${Number.isFinite(alt) ? Math.round(alt) + " ft" : "low altitude"} — circling is a guess, not confirmation.`,
    };
  }
  return { circling: false, reason: "" };
}
