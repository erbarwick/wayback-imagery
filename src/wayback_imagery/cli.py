"""
Command-line interface.

Examples:
  wayback-imagery --bbox -121.67666 38.55650 -121.67024 38.55889 --date 2023-09-01 --label "Davis test"
  wayback-imagery --bbox ... --date 2023-09-01 --select-by release
  wayback-imagery --bbox ... --list-captures
  wayback-imagery --bbox ... --all-captures --label "Davis test"
  wayback-imagery --bbox ... --date 2023-09-01 --release-id 64776
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

import requests

from .core import (
    bbox_center,
    bbox_from_segment,
    choose_zoom,
    distinct_captures,
    generate_image,
    get_releases,
    scan_captures,
    validate_bbox,
)


def parse_date(text: str) -> dt.date:
    try:
        return dt.date.fromisoformat(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid date '{text}'. Use YYYY-MM-DD.") from exc


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wayback-imagery",
        description="Download and stitch Esri Wayback historical imagery.",
    )
    area = p.add_mutually_exclusive_group()
    area.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"),
                      help="Bounding box in decimal degrees.")
    area.add_argument("--segment", nargs=4, type=float, metavar=("LAT1", "LON1", "LAT2", "LON2"),
                      help="Road segment endpoints; a bounding box with margin is derived.")

    p.add_argument("--date", nargs="+", type=parse_date, help="One or more dates (YYYY-MM-DD).")
    p.add_argument("--label", default="imagery", help="Text for the image label and filename.")
    p.add_argument("--out", default="output", help="Output directory.")
    p.add_argument("--select-by", choices=["capture", "release"], default="capture",
                   help="Match the date against imagery capture date (default) or release date.")
    p.add_argument("--mode", choices=["nearest", "before", "after"], default="nearest",
                   help="How to pick the release relative to the requested date.")
    p.add_argument("--release-id", type=int, help="Force a specific Wayback release id.")
    p.add_argument("--zoom", type=int, help="Force a zoom level instead of choosing automatically.")
    p.add_argument("--max-px", type=int, default=4096, help="Max output width/height for automatic zoom.")
    p.add_argument("--max-zoom", type=int, default=19, help="Upper bound for automatic zoom selection.")
    p.add_argument("--margin-m", type=float, default=150.0,
                   help="Minimum margin around a segment, in metres.")
    p.add_argument("--no-markers", action="store_true", help="Do not draw segment endpoint markers.")
    p.add_argument("--workers", type=int, default=8, help="Parallel tile downloads.")
    p.add_argument("--format", choices=["png", "jpg"], default="png", help="Output image format.")
    p.add_argument("--json", action="store_true", help="Print results as JSON.")
    p.add_argument("--list-releases", action="store_true", help="List release dates and exit.")
    p.add_argument("--list-captures", action="store_true",
                   help="List distinct capture dates at the area center and exit.")
    p.add_argument("--all-captures", action="store_true",
                   help="Download one image per distinct capture date at the area center.")
    return p


def resolve_area(args):
    """Return (bbox, marker_points) from --bbox or --segment."""
    if args.segment:
        lat1, lon1, lat2, lon2 = args.segment
        start, end = (lat1, lon1), (lat2, lon2)
        bbox = bbox_from_segment(start, end, margin_m=args.margin_m)
        return bbox, (None if args.no_markers else [start, end])
    return tuple(args.bbox), None


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_releases:
        for r in get_releases():
            print(f"{r.date.isoformat()}  id={r.release_id}  metadata={'yes' if r.metadata_url else 'no'}")
        return 0

    if not (args.bbox or args.segment):
        print("error: one of --bbox or --segment is required.", file=sys.stderr)
        return 2
    bbox, points = resolve_area(args)

    # Listing or bulk download by capture date: scan the center point once.
    if args.list_captures or args.all_captures:
        vb = validate_bbox(bbox)
        zoom = args.zoom or choose_zoom(vb, max_px=args.max_px, max_zoom=args.max_zoom)
        lon, lat = bbox_center(vb)
        caps = distinct_captures(scan_captures(lon, lat, zoom))
        if args.list_captures:
            if args.json:
                print(json.dumps([c.as_dict() for c in caps], indent=2))
            else:
                print(f"{len(caps)} distinct capture dates at ({lat:.5f}, {lon:.5f}), zoom {zoom}:")
                for c in caps:
                    res = f"{c.resolution_m:g} m" if c.resolution_m else "?"
                    print(f"  captured {c.capture_date}  release {c.release.date} "
                          f"(id {c.release.release_id})  {res}  {c.provider or ''}")
            return 0
        dates = [(c.capture_date, c.release.release_id) for c in caps]
    else:
        if not args.date:
            print("error: --date is required.", file=sys.stderr)
            return 2
        dates = [(d, args.release_id) for d in args.date]

    results, exit_code = [], 0
    for date, rid in dates:
        try:
            r = generate_image(
                bbox=bbox, date=date, label=args.label, out_dir=args.out, zoom=args.zoom,
                max_px=args.max_px, max_zoom=args.max_zoom, mode=args.mode,
                select_by=args.select_by, release_id=rid, points=points,
                workers=args.workers, ext=args.format,
            )
            results.append(r)
            if not args.json:
                mixed = " [mixed dates in bbox]" if r["mixed_capture"] else ""
                print(f"{date}: captured {r['capture_date']}, release {r['release_date']} "
                      f"(id {r['release_id']}), zoom {r['zoom']}, {r['width']}x{r['height']} px, "
                      f"{r['tiles_missing']}/{r['tiles_total']} missing{mixed} -> {r['path']}")
        except (ValueError, requests.RequestException) as exc:
            exit_code = 1
            if args.json:
                results.append({"requested_date": date.isoformat(), "error": str(exc)})
            else:
                print(f"{date}: error: {exc}", file=sys.stderr)

    if args.json:
        print(json.dumps(results, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())