#!/usr/bin/env python3
"""Download OSM speed / red-light / ALPR cameras for a bounding box via Overpass."""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
]

QUERY = """[out:json][timeout:90];
(
  node["surveillance:type"="ALPR"]({box});
  node["man_made"="surveillance"]["surveillance:type"="ALPR"]({box});
  node["highway"="speed_camera"]({box});
  way["highway"="speed_camera"]({box});
  node["enforcement"="maxspeed"]({box});
  node["enforcement"="traffic_signals"]({box});
  node["enforcement"="red_light"]({box});
  way["enforcement"="maxspeed"]({box});
  way["enforcement"="traffic_signals"]({box});
  relation["enforcement"="maxspeed"]({box});
  relation["enforcement"="traffic_signals"]({box});
);
out center tags;
"""


def kind_of(tags: dict) -> str | None:
    ev = str(tags.get("enforcement") or tags.get("enforcement:for") or "").lower()
    blob = " ".join(
        str(tags.get(k) or "")
        for k in ("manufacturer", "brand", "operator", "surveillance:manufacturer", "surveillance:brand")
    ).lower()
    flock = "flock" in blob
    st = str(tags.get("surveillance:type") or tags.get("surveillance") or "").upper()
    if ev in ("traffic_signals", "red_light") or "red_light" in ev:
        return "red_light"
    if tags.get("highway") == "speed_camera" or "maxspeed" in ev:
        return "speed"
    if st == "ALPR":
        return "flock" if flock else "alpr"
    if flock:
        return "flock"
    return None


def parse(data: dict) -> list[dict]:
    out = []
    seen = set()
    for el in data.get("elements") or []:
        tags = el.get("tags") or {}
        lat = el.get("lat")
        lon = el.get("lon")
        if lat is None and el.get("center"):
            lat = el["center"].get("lat")
            lon = el["center"].get("lon")
        if lat is None or lon is None:
            continue
        kind = kind_of(tags)
        if not kind:
            continue
        eid = f"{el.get('type','node')}/{el.get('id')}"
        if eid in seen:
            continue
        seen.add(eid)
        out.append({
            "id": eid,
            "kind": kind,
            "lat": float(lat),
            "lon": float(lon),
            "operator": tags.get("operator") or tags.get("brand") or tags.get("manufacturer") or "",
            "direction": tags.get("direction") or tags.get("camera:direction") or "",
        })
    return out


def fetch(box: str) -> tuple[list[dict], str]:
    query = QUERY.format(box=box)
    body = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for ep in ENDPOINTS:
        req = urllib.request.Request(
            ep,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "User-Agent": "PoliceWatch/1.0 (personal PWA; read-only OSM; github.com/romanorecchio/police-watch)",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                raw = res.read()
            data = json.loads(raw.decode())
            return parse(data), ep
        except Exception as e:
            last_err = e
            print(f"fail {ep}: {e}", file=sys.stderr)
            time.sleep(3)
    raise SystemExit(f"all Overpass mirrors failed: {last_err}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--south", type=float, default=39.6)
    ap.add_argument("--north", type=float, default=41.2)
    ap.add_argument("--west", type=float, default=-81.6)
    ap.add_argument("--east", type=float, default=-79.6)
    ap.add_argument("--out", default="data/cameras_cache.json")
    args = ap.parse_args()
    box = f"{args.south},{args.west},{args.north},{args.east}"
    cams, source = fetch(box)
    payload = {
        "source": source,
        "attribution": "© OpenStreetMap contributors",
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": {"top": args.north, "bottom": args.south, "left": args.west, "right": args.east},
        "counts": {
            "total": len(cams),
            "flock": sum(1 for c in cams if c["kind"] == "flock"),
            "alpr": sum(1 for c in cams if c["kind"] == "alpr"),
            "speed": sum(1 for c in cams if c["kind"] == "speed"),
            "red_light": sum(1 for c in cams if c["kind"] == "red_light"),
        },
        "cameras": cams,
    }
    Path(args.out).write_text(json.dumps(payload, separators=(",", ":")))
    print(json.dumps(payload["counts"], indent=2))
    print("wrote", args.out, "from", source)


if __name__ == "__main__":
    main()
