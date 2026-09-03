"""
Flask web interface.

Run:  wayback-imagery-web        (or: python -m wayback_imagery.app)
Open: http://127.0.0.1:5001

Environment variables:
  WAYBACK_OUTPUT_DIR  where generated images are written (default: ./output)
  PORT                listen port (default: 5001)
  FLASK_DEBUG=1       enable the reloader and debugger
"""

from __future__ import annotations

import datetime as dt
import os
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, render_template, request, send_from_directory

from .core import (
    bbox_center,
    bbox_from_segment,
    choose_zoom,
    distinct_captures,
    generate_image,
    get_releases,
    scan_captures,
    validate_bbox,
    corridor_geometry,
    corridor_from_rotated_bbox,
)

OUTPUT_DIR = Path(os.environ.get("WAYBACK_OUTPUT_DIR", Path.cwd() / "output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
app = Flask(__name__)

def _float(form, key, required=True):
    """Parse a float form field; raise ValueError naming the field on failure."""
    raw = (form.get(key) or "").strip()
    if not raw:
        if required:
            raise ValueError(f"Missing value for '{key}'.")
        return None
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"'{key}' must be a number (got '{raw}').")


def _int(form, key, default=None):
    raw = (form.get(key) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"'{key}' must be an integer (got '{raw}').")

def _resolve_area(form):
    """Return (bbox, marker_points, corridor) from either bbox fields or segment fields."""
    if form.get("area_mode", "segment") == "bbox":
        bbox = (_float(form, "west"), _float(form, "south"), _float(form, "east"), _float(form, "north"))
        angle = _float(form, "bbox_angle", required=False) or 0.0
        if abs(angle) < 0.05:
            return bbox, None, None
        geom = corridor_from_rotated_bbox(bbox, angle)
        return geom.envelope, None, geom
    start = (_float(form, "start_lat"), _float(form, "start_lon"))
    end = (_float(form, "end_lat"), _float(form, "end_lon"))
    points = [start, end] if form.get("markers") else None
    if form.get("aligned"):
        geom = corridor_geometry(start, end,
                                 _float(form, "half_width_m", required=False) or 20.0,
                                 _float(form, "pad_m", required=False) or 30.0)
        return geom.envelope, points, geom
    margin = _float(form, "margin_m", required=False) or 150.0
    return bbox_from_segment(start, end, margin_m=margin), points, None


@app.route("/", methods=["GET", "POST"])
def index():
    result = error = None
    form = request.form if request.method == "POST" else {}
    if request.method == "POST":
        try:
            bbox, points, corridor = _resolve_area(form)
            result = generate_image(
                bbox=bbox,
                date=dt.date.fromisoformat(form.get("date", "")),
                label=(form.get("label") or "").strip() or "imagery",
                out_dir=OUTPUT_DIR,
                zoom=_int(form, "zoom"),
                max_px=_int(form, "max_px", default=4096),
                mode=form.get("mode", "nearest"),
                select_by=form.get("select_by", "capture"),
                release_id=_int(form, "release_id"),
                points=points,
                corridor=corridor,
            )
        except (ValueError, requests.RequestException) as exc:
            error = str(exc)
    return render_template("index.html", form=form, result=result, error=error)


@app.route("/api/captures")
def api_captures():
    """
    Distinct capture dates at the center of the area described by the query
    string (same field names as the form). Used by the "List capture dates" button.
    """
    try:
        bbox, _, _ = _resolve_area(request.args)
        bbox = validate_bbox(bbox)
        zoom = _int(request.args, "zoom") or choose_zoom(bbox, max_px=_int(request.args, "max_px", 4096))
        lon, lat = bbox_center(bbox)
        caps = distinct_captures(scan_captures(lon, lat, zoom))
        return jsonify({"zoom": zoom, "center": [lat, lon], "captures": [c.as_dict() for c in caps]})
    except (ValueError, requests.RequestException) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/releases")
def api_releases():
    return jsonify([{"id": r.release_id, "date": r.date.isoformat()} for r in get_releases()])


def _safe_name(name: str) -> str:
    """Reject anything that is not a plain filename inside OUTPUT_DIR."""
    clean = Path(name).name
    if clean != name or not (OUTPUT_DIR / clean).is_file():
        abort(404)
    return clean


@app.route("/images/<path:name>")
def image(name):
    return send_from_directory(OUTPUT_DIR, _safe_name(name))


@app.route("/download/<path:name>")
def download(name):
    return send_from_directory(OUTPUT_DIR, _safe_name(name), as_attachment=True)


def main() -> None:
    """Entry point for the `wayback-imagery-web` console command."""
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5001")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )


if __name__ == "__main__":
    main()