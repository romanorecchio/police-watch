#!/usr/bin/env python3
"""Build a local police/LE aircraft list from the FAA releasable registry.

Source: https://registry.faa.gov/database/ReleasableAircraft.zip
(public domain U.S. government work). Read-only. Re-run periodically;
the FAA refreshes the file daily.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

KEYWORD_RE = re.compile(
    r"\b("
    r"POLICE|SHERIFF|SHERRIF|"
    r"STATE PATROL|HIGHWAY PATROL|HIGHWAY SAFETY|"
    r"STATE POLICE|LAW ENFORCEMENT|"
    r"PUBLIC SAFETY|DEPT OF PUBLIC SAFETY|DEPARTMENT OF PUBLIC SAFETY|"
    r"CUSTOMS AND BORDER|CUSTOMS & BORDER|BORDER PATROL|"
    r"HOMELAND SECURITY|FEDERAL BUREAU|"
    r"DRUG ENFORCEMENT|U\.?S\.? MARSHAL|US MARSHALS|"
    r"IMMIGRATION AND CUSTOMS|IMMIGRATION & CUSTOMS"
    r")\b",
    re.I,
)
FED_RE = re.compile(
    r"(DEPARTMENT OF HOMELAND|DEPT OF HOMELAND|"
    r"U S CUSTOMS|US CUSTOMS|U\.S\. CUSTOMS|"
    r"CUSTOMS AND BORDER PROTECTION|"
    r"FEDERAL BUREAU OF INVESTIGATION|"
    r"DRUG ENFORCEMENT ADMINISTRATION|"
    r"DEPARTMENT OF JUSTICE|DEPT OF JUSTICE|"
    r"U S DEPT OF JUSTICE|"
    r"IMMIGRATION AND CUSTOMS ENFORCEMENT)\b",
    re.I,
)
# Drop fire/EMS-only names unless they also contain a police keyword.
EXCLUDE_RE = re.compile(
    r"(POLICE ATHLETIC|MUSEUM|HISTORICAL SOCIETY|"
    r"FIREFIGHTER|FIRE DEPT|FIRE DEPARTMENT|FIRE DIST|"
    r"AMBULANCE|HOSPITAL|RESCUE SQUAD|MEDICAL CENTER)",
    re.I,
)
KEEP_EVEN_IF_EXCLUDED = re.compile(
    r"\b(POLICE|SHERIFF|SHERRIF|PATROL|LAW ENFORCEMENT)\b",
    re.I,
)


def category_for(blob: str) -> str:
    u = blob.upper()
    if re.search(
        r"HOMELAND|CUSTOMS AND BORDER|CUSTOMS & BORDER|BORDER PATROL|"
        r"FEDERAL BUREAU|DRUG ENFORCEMENT|MARSHAL|"
        r"DEPARTMENT OF JUSTICE|DEPT OF JUSTICE|"
        r"IMMIGRATION AND CUSTOMS|\bCBP\b|\bDHS\b|\bICE\b|\bFBI\b|\bDEA\b",
        u,
    ):
        return "federal"
    if re.search(r"HIGHWAY PATROL|STATE PATROL|STATE POLICE|HIGHWAY SAFETY", u):
        return "state_police"
    if re.search(r"SHERIFF|SHERRIF", u):
        return "sheriff"
    if re.search(r"\bPOLICE\b", u):
        return "police"
    if re.search(r"PUBLIC SAFETY|LAW ENFORCEMENT", u):
        return "public_safety"
    return "law_enforcement"


def load_ref(zf: zipfile.ZipFile) -> dict:
    ref = {}
    with zf.open("ACFTREF.txt") as f:
        text = io.TextIOWrapper(f, encoding="latin-1", newline="")
        reader = csv.reader(text)
        next(reader, None)
        for row in reader:
            if not row:
                continue
            code = row[0].strip().lstrip("\ufeff")
            if not code:
                continue
            ref[code] = {
                "mfr": row[1].strip() if len(row) > 1 else "",
                "model": row[2].strip() if len(row) > 2 else "",
            }
    return ref


def parse_master(zf: zipfile.ZipFile, ref: dict) -> list[dict]:
    out = []
    with zf.open("MASTER.txt") as f:
        text = io.TextIOWrapper(f, encoding="latin-1", newline="")
        reader = csv.reader(text)
        header = [c.strip().lstrip("\ufeff") for c in next(reader)]
        # Rows are positional; header names vary only by BOM.
        for row in reader:
            if not row:
                continue
            name = row[6].strip() if len(row) > 6 else ""
            others = " ".join(
                row[i].strip()
                for i in range(24, 29)
                if i < len(row) and row[i].strip()
            )
            blob = (name + " " + others).strip()
            if not blob:
                continue
            if not (KEYWORD_RE.search(blob) or FED_RE.search(blob)):
                continue
            if EXCLUDE_RE.search(blob) and not KEEP_EVEN_IF_EXCLUDED.search(blob):
                continue
            nnum = row[0].strip().lstrip("\ufeff")
            registration = "N" + nnum if nnum and not nnum.upper().startswith("N") else nnum
            mfr_code = row[2].strip() if len(row) > 2 else ""
            info = ref.get(mfr_code, {})
            hexcode = (row[33].strip() if len(row) > 33 else "").upper()
            rec = {
                "hex": hexcode,
                "reg": registration.upper(),
                "owner": name,
                "other_names": others,
                "city": row[9].strip() if len(row) > 9 else "",
                "state": row[10].strip() if len(row) > 10 else "",
                "status": row[20].strip() if len(row) > 20 else "",
                "mfr": info.get("mfr", ""),
                "model": info.get("model", ""),
                "cat": category_for(blob),
            }
            out.append(rec)
    return out


def compact(rec: dict) -> dict:
    return {
        "hex": rec["hex"],
        "reg": rec["reg"],
        "owner": rec["owner"],
        "city": rec["city"],
        "state": rec["state"],
        "status": rec["status"],
        "mfr": rec["mfr"],
        "model": rec["model"],
        "cat": rec["cat"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, help="Path to ReleasableAircraft.zip")
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(args.zip) as zf:
        ref = load_ref(zf)
        rows = parse_master(zf, ref)

    # Prefer unique hex; keep first valid-status when duplicates exist.
    by_hex = defaultdict(list)
    no_hex = []
    for r in rows:
        if r["hex"]:
            by_hex[r["hex"]].append(r)
        else:
            no_hex.append(r)
    unique = []
    for hexcode, group in by_hex.items():
        group.sort(key=lambda r: (0 if r["status"] == "V" else 1, r["reg"]))
        unique.append(group[0])
    unique.extend(no_hex)
    unique.sort(key=lambda r: (r["state"], r["reg"]))

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    by_state = Counter(r["state"] or "??" for r in unique)
    by_cat = Counter(r["cat"] for r in unique)
    payload = {
        "source": "FAA Releasable Aircraft Database (registry.faa.gov)",
        "source_url": "https://registry.faa.gov/database/ReleasableAircraft.zip",
        "built_at": now,
        "note": (
            "Owners matched on public registrant names containing police, sheriff, "
            "patrol, state police, public safety, or federal LE agencies. "
            "A registration is not proof an aircraft is currently flying a "
            "law-enforcement mission. Many police aircraft do not broadcast ADS-B."
        ),
        "counts": {
            "total": len(unique),
            "by_state": dict(sorted(by_state.items(), key=lambda kv: (-kv[1], kv[0]))),
            "by_category": dict(by_cat),
        },
        "aircraft": [compact(r) for r in unique],
    }
    (outdir / "police_aircraft.json").write_text(json.dumps(payload, indent=None, separators=(",", ":")), encoding="utf-8")

    csv_path = outdir / "police_aircraft.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["hex", "reg", "owner", "other_names", "city", "state", "status", "mfr", "model", "cat"],
        )
        w.writeheader()
        for r in unique:
            w.writerow(r)

    summary = outdir / "registry_summary.txt"
    lines = [
        f"Built at {now}",
        f"Total: {len(unique)}",
        "By state:",
    ]
    for st, n in payload["counts"]["by_state"].items():
        lines.append(f"  {st}: {n}")
    lines.append("By category:")
    for cat, n in by_cat.most_common():
        lines.append(f"  {cat}: {n}")
    for st in ("OH", "WV", "PA"):
        lines.append(f"--- {st} ---")
        for r in unique:
            if r["state"] == st:
                lines.append(f"  {r['reg']} {r['hex']} {r['cat']} {r['mfr']} {r['model']} {r['owner']} ({r['city']})")
    summary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(summary.read_text())


if __name__ == "__main__":
    main()
