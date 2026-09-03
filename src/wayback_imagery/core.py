"""
Core functions for downloading and stitching Esri World Imagery Wayback tiles,
with release selection based on imagery capture date.

Conventions:
- Points are (lat, lon) in WGS84 decimal degrees, except where a function
  parameter is explicitly named lon/lat.
- Bounding boxes are (west, south, east, north) in WGS84 decimal degrees.
- Tile coordinates follow the Web Mercator "slippy map" scheme (z, x, y).

Terminology:
- Release date: when Esri published a Wayback snapshot of the whole service.
- Capture date: when the source photo under a specific point was taken. Comes
  from the per-release metadata map service. Many releases share the same
  capture date at a given location because unchanged tiles are republished.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import math
import re
import threading
import time
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Constants and type aliases
# ---------------------------------------------------------------------------

WAYBACK_CONFIG_URL = (
    "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
)
DEFAULT_TILE_TEMPLATE = (
    "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/"
    "WMTS/1.0.0/default028mm/MapServer/tile/{release}/{level}/{row}/{col}"
)

TILE_SIZE = 256
USER_AGENT = "wayback-imagery/0.1"
CACHE_TTL = 6 * 3600          # seconds; applies to release list, layer lists, scans
MAX_TILES = 2500
MAX_MERCATOR_LAT = 85.05112878
ARCGIS_SCALE_Z0 = 591657527.591555  # map scale denominator at zoom 0, 96 dpi
EARTH_CIRCUMFERENCE_M = 40075016.686

BBox = tuple[float, float, float, float]

# ---------------------------------------------------------------------------
# Release list
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Release:
    """One dated Wayback snapshot."""

    release_id: int
    date: dt.date
    title: str
    tile_template: str
    metadata_url: str | None  # ArcGIS MapServer with capture-date metadata, or None

    def tile_url(self, z: int, x: int, y: int) -> str:
        """Fill the URL template for one tile. Wayback uses {level}/{row}/{col} = z/y/x."""
        return (
            self.tile_template.replace("{release}", str(self.release_id))
            .replace("{level}", str(z))
            .replace("{row}", str(y))
            .replace("{col}", str(x))
        )


_RELEASE_CACHE: dict = {"time": 0.0, "releases": None}
_RELEASE_LOCK = threading.Lock()


def _find_metadata_url(info: dict) -> str | None:
    """Return the metadata MapServer URL from a config entry, if present."""
    url = info.get("metadataLayerUrl")
    if not url:
        # Fallback in case the key name changes: any MapServer URL mentioning "metadata".
        for value in info.values():
            if isinstance(value, str) and "metadata" in value.lower() and "mapserver" in value.lower():
                url = value
                break
    return url.rstrip("/") if url else None


def get_releases(force_refresh: bool = False) -> list[Release]:
    """Download (or return cached) list of all Wayback releases, sorted by date."""
    with _RELEASE_LOCK:
        cached = _RELEASE_CACHE["releases"]
        fresh = cached is not None and (time.time() - _RELEASE_CACHE["time"]) < CACHE_TTL
        if fresh and not force_refresh:
            return cached

        resp = requests.get(WAYBACK_CONFIG_URL, timeout=30, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        config = resp.json()

        releases: list[Release] = []
        for key, info in config.items():
            match = re.search(r"(\d{4}-\d{2}-\d{2})", info.get("itemTitle", ""))
            if not match:
                continue
            releases.append(
                Release(
                    release_id=int(key),
                    date=dt.date.fromisoformat(match.group(1)),
                    title=info.get("itemTitle", ""),
                    tile_template=info.get("itemURL") or DEFAULT_TILE_TEMPLATE,
                    metadata_url=_find_metadata_url(info),
                )
            )

        releases.sort(key=lambda r: r.date)
        _RELEASE_CACHE["time"] = time.time()
        _RELEASE_CACHE["releases"] = releases
        return releases


def find_release_by_id(release_id: int) -> Release:
    for r in get_releases():
        if r.release_id == release_id:
            return r
    raise ValueError(f"No Wayback release with id {release_id}.")


def _pick_by_date(items, key, target: dt.date, mode: str, what: str):
    """Shared selection logic: nearest/before/after on the date returned by `key`."""
    if not items:
        raise ValueError(f"No {what} available.")
    if mode == "before":
        c = [i for i in items if key(i) <= target]
        if not c:
            raise ValueError(f"No {what} on or before {target}.")
        return max(c, key=key)
    if mode == "after":
        c = [i for i in items if key(i) >= target]
        if not c:
            raise ValueError(f"No {what} on or after {target}.")
        return min(c, key=key)
    if mode != "nearest":
        raise ValueError(f"Unknown mode '{mode}'. Use nearest, before, or after.")
    # Ties resolve to the earlier date because min() keeps the first minimum
    # and `items` is sorted ascending by date.
    return min(items, key=lambda i: abs((key(i) - target).days))


def find_release(target: dt.date, mode: str = "nearest",
                 releases: Sequence[Release] | None = None) -> Release:
    """Select a release by its RELEASE date."""
    releases = list(releases) if releases is not None else get_releases()
    return _pick_by_date(releases, lambda r: r.date, target, mode, "release")


# ---------------------------------------------------------------------------
# Capture-date metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CaptureInfo:
    """Metadata for the source image under a point in a given release."""

    release: Release
    capture_date: dt.date | None
    resolution_m: float | None
    accuracy_m: float | None
    provider: str | None

    def as_dict(self) -> dict:
        return {
            "release_id": self.release.release_id,
            "release_date": self.release.date.isoformat(),
            "capture_date": self.capture_date.isoformat() if self.capture_date else None,
            "resolution_m": self.resolution_m,
            "accuracy_m": self.accuracy_m,
            "provider": self.provider,
        }


_LAYER_CACHE: dict = {}    # metadata_url -> (time, [layer dicts])
_LAYER_LOCK = threading.Lock()
_SCAN_CACHE: dict = {}     # (lon, lat, zoom) -> (time, [CaptureInfo])
_SCAN_LOCK = threading.Lock()


def scale_for_zoom(zoom: int) -> float:
    """Approximate ArcGIS map scale denominator for a Web Mercator zoom level."""
    return ARCGIS_SCALE_Z0 / (2 ** zoom)


def _metadata_layers(session: requests.Session, metadata_url: str) -> list[dict]:
    """
    Fetch the layer list of a metadata MapServer. Each metadata service has
    several sub-layers, each valid for a range of map scales. Cached.
    """
    with _LAYER_LOCK:
        hit = _LAYER_CACHE.get(metadata_url)
        if hit and (time.time() - hit[0]) < CACHE_TTL:
            return hit[1]
    resp = session.get(metadata_url, params={"f": "json"}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise ValueError(f"Metadata service error: {data['error']}")
    layers = [layer for layer in data.get("layers", []) if not layer.get("subLayerIds")]
    with _LAYER_LOCK:
        _LAYER_CACHE[metadata_url] = (time.time(), layers)
    return layers


def _layers_for_zoom(layers: list[dict], zoom: int) -> list[dict]:
    """
    Return the layers visible at the given zoom, using ArcGIS scale ranges.
    minScale = most zoomed-out limit (large number), maxScale = most zoomed-in
    limit (small number), 0 = no limit. If none match, return all layers,
    most detailed first, so the caller can still try them.
    """
    scale = scale_for_zoom(zoom)

    def visible(layer: dict) -> bool:
        mn = layer.get("minScale") or 0
        mx = layer.get("maxScale") or 0
        return (mn == 0 or scale <= mn) and (mx == 0 or scale >= mx)

    chosen = [layer for layer in layers if visible(layer)]
    return chosen or sorted(layers, key=lambda layer: layer.get("maxScale") or 0)


def _query_layer(session: requests.Session, metadata_url: str, layer_id: int,
                 lon: float, lat: float) -> dict | None:
    """Point query against one metadata sub-layer. Returns the first feature's attributes."""
    params = {
        "f": "json",
        "geometry": json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}}),
        "geometryType": "esriGeometryPoint",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "false",
        "resultRecordCount": 1,
    }
    try:
        resp = session.get(f"{metadata_url}/{layer_id}/query", params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError):
        return None
    feats = data.get("features") or []
    return feats[0].get("attributes") if feats else None


def _parse_capture_date(attrs: dict) -> dt.date | None:
    """SRC_DATE2 is epoch milliseconds; older services may only have SRC_DATE as YYYYMMDD."""
    v = attrs.get("SRC_DATE2")
    if isinstance(v, (int, float)) and v > 0:
        try:
            return dt.datetime.fromtimestamp(v / 1000.0, tz=dt.timezone.utc).date()
        except (OverflowError, OSError, ValueError):
            pass
    v = attrs.get("SRC_DATE")
    if v not in (None, 0, "", "0"):
        s = str(v).strip()
        for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y"):
            try:
                return dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc).date()
            except ValueError:
                continue
    return None


def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def get_capture_info(release: Release, lon: float, lat: float, zoom: int,
                     session: requests.Session | None = None) -> CaptureInfo:
    """Look up the capture metadata for `release` at one point. Never raises; unknowns are None."""
    session = session or _make_session()
    empty = CaptureInfo(release, None, None, None, None)
    if not release.metadata_url:
        return empty
    try:
        layers = _metadata_layers(session, release.metadata_url)
    except (requests.RequestException, ValueError):
        return empty
    for layer in _layers_for_zoom(layers, zoom):
        attrs = _query_layer(session, release.metadata_url, layer["id"], lon, lat)
        if attrs:
            return CaptureInfo(
                release=release,
                capture_date=_parse_capture_date(attrs),
                resolution_m=_num(attrs.get("SRC_RES")),
                accuracy_m=_num(attrs.get("SRC_ACC")),
                provider=attrs.get("NICE_NAME") or attrs.get("SRC_DESC"),
            )
    return empty


def scan_captures(lon: float, lat: float, zoom: int, workers: int = 16,
                  session: requests.Session | None = None) -> list[CaptureInfo]:
    """
    Query every release's metadata at one point. Returns one CaptureInfo per
    release, in release-date order. Results are cached per (point, zoom).
    """
    key = (round(lon, 4), round(lat, 4), zoom)
    with _SCAN_LOCK:
        hit = _SCAN_CACHE.get(key)
        if hit and (time.time() - hit[0]) < CACHE_TTL:
            return hit[1]

    session = session or _make_session()
    releases = get_releases()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda r: get_capture_info(r, lon, lat, zoom, session), releases))

    with _SCAN_LOCK:
        _SCAN_CACHE[key] = (time.time(), results)
    return results


def distinct_captures(captures: Iterable[CaptureInfo]) -> list[CaptureInfo]:
    """
    Collapse a scan to one entry per distinct capture date. For each date the
    earliest release carrying it is kept. Entries without a date are dropped.
    """
    seen: dict[dt.date, CaptureInfo] = {}
    for c in sorted(captures, key=lambda c: c.release.date):
        if c.capture_date and c.capture_date not in seen:
            seen[c.capture_date] = c
    return sorted(seen.values(), key=lambda c: c.capture_date)


def find_release_by_capture(target: dt.date, lon: float, lat: float, zoom: int,
                            mode: str = "nearest") -> CaptureInfo:
    """Select the release whose CAPTURE date at (lon, lat) best matches `target`."""
    options = distinct_captures(scan_captures(lon, lat, zoom))
    if not options:
        raise ValueError(
            "No capture-date metadata is available at this location. "
            "Use selection by release date instead."
        )
    return _pick_by_date(options, lambda c: c.capture_date, target, mode, "capture date")


def sample_capture_dates(release: Release, bbox: BBox, zoom: int,
                         session: requests.Session | None = None) -> list[dt.date | None]:
    """Capture dates at four interior points of the bbox, used to detect mixed-date mosaics."""
    w, s, e, n = bbox
    pts = [(w + 0.15 * (e - w), s + 0.15 * (n - s)), (e - 0.15 * (e - w), s + 0.15 * (n - s)),
           (w + 0.15 * (e - w), n - 0.15 * (n - s)), (e - 0.15 * (e - w), n - 0.15 * (n - s))]
    session = session or _make_session()
    with ThreadPoolExecutor(max_workers=4) as pool:
        infos = list(pool.map(lambda p: get_capture_info(release, p[0], p[1], zoom, session), pts))
    return [i.capture_date for i in infos]


# ---------------------------------------------------------------------------
# Bounding box helpers
# ---------------------------------------------------------------------------


def bbox_from_segment(start, end, margin_m=150.0, margin_frac=0.25) -> BBox:
    """
    Bounding box around a segment (two (lat, lon) points). Each axis gets a
    margin equal to the larger of `margin_m` metres and `margin_frac` times the
    segment's extent along that axis, so a long, nearly straight segment does
    not produce a very wide box.
    """
    lat1, lon1 = start
    lat2, lon2 = end
    west, east = min(lon1, lon2), max(lon1, lon2)
    south, north = min(lat1, lat2), max(lat1, lat2)

    mid_lat = (south + north) / 2.0
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(mid_lat))

    width_m = (east - west) * m_per_deg_lon
    height_m = (north - south) * m_per_deg_lat
    margin_x = max(margin_m, margin_frac * width_m)
    margin_y = max(margin_m, margin_frac * height_m)

    return (west - margin_x / m_per_deg_lon, south - margin_y / m_per_deg_lat,
            east + margin_x / m_per_deg_lon, north + margin_y / m_per_deg_lat)

def validate_bbox(bbox: Iterable[float]) -> BBox:
    """Check ordering and ranges; clamp latitude to the Web Mercator limit."""
    west, south, east, north = (float(v) for v in bbox)
    if not (-180.0 <= west <= 180.0 and -180.0 <= east <= 180.0):
        raise ValueError("Longitude must be between -180 and 180.")
    if west >= east:
        raise ValueError("West must be less than east.")
    if south >= north:
        raise ValueError("South must be less than north.")
    return (west, max(south, -MAX_MERCATOR_LAT), east, min(north, MAX_MERCATOR_LAT))


def bbox_center(bbox: BBox) -> tuple[float, float]:
    """Return (lon, lat) of the bbox center."""
    w, s, e, n = bbox
    return (w + e) / 2.0, (s + n) / 2.0


# ---------------------------------------------------------------------------
# Web Mercator tile math
# ---------------------------------------------------------------------------


def lonlat_to_pixel(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    """Convert lon/lat to global pixel coordinates at the given zoom level."""
    n = TILE_SIZE * (2 ** zoom)
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def pixel_to_lonlat(x: float, y: float, zoom: int) -> tuple[float, float]:
    """Inverse of lonlat_to_pixel. Returns (lon, lat)."""
    n = TILE_SIZE * (2 ** zoom)
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def bbox_pixel_extent(bbox: BBox, zoom: int) -> tuple[float, float, float, float]:
    """Return (x0, y0, x1, y1) global pixel bounds of the bbox. y grows southward."""
    west, south, east, north = bbox
    x0, y0 = lonlat_to_pixel(west, north, zoom)
    x1, y1 = lonlat_to_pixel(east, south, zoom)
    return x0, y0, x1, y1


def choose_zoom(bbox: BBox, max_px: int = 4096, max_zoom: int = 19, min_zoom: int = 1) -> int:
    """Highest zoom at which the bbox fits within max_px on both axes."""
    for zoom in range(max_zoom, min_zoom - 1, -1):
        x0, y0, x1, y1 = bbox_pixel_extent(bbox, zoom)
        if (x1 - x0) <= max_px and (y1 - y0) <= max_px:
            return zoom
    return min_zoom


# ---------------------------------------------------------------------------
# Aligned corridor around a road segment
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Corridor:
    """
    Rotated rectangle of half-width half_width_m around a segment, extended by
    pad_m past each end. Lengths are in zoom-0 pixel units; multiply by 2**zoom
    for pixels. theta is the segment direction in radians, clockwise from
    screen east (y grows southward). bearing is the compass bearing in degrees.
    """

    start: tuple[float, float]      # (lat, lon)
    end: tuple[float, float]
    centre: tuple[float, float]     # zoom-0 pixel units
    theta: float
    bearing: float
    a: float                        # half-length including padding
    b: float                        # half-width
    corners: list[tuple[float, float]]   # (lon, lat)
    envelope: BBox
    half_width_m: float
    pad_m: float


def corridor_geometry(start: tuple[float, float], end: tuple[float, float],
                      half_width_m: float = 20.0, pad_m: float = 30.0) -> Corridor:
    (lat1, lon1), (lat2, lon2) = start, end
    x1, y1 = lonlat_to_pixel(lon1, lat1, 0)
    x2, y2 = lonlat_to_pixel(lon2, lat2, 0)
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length == 0:
        raise ValueError("Start and end points are identical.")
    m_per_unit = EARTH_CIRCUMFERENCE_M * math.cos(math.radians((lat1 + lat2) / 2)) / TILE_SIZE
    a, b = length / 2 + pad_m / m_per_unit, half_width_m / m_per_unit
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    corners_px = [(cx + sa * a * ux + sb * b * nx, cy + sa * a * uy + sb * b * ny)
                  for sa, sb in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
    xs, ys = [p[0] for p in corners_px], [p[1] for p in corners_px]
    w, n = pixel_to_lonlat(min(xs), min(ys), 0)
    e, s = pixel_to_lonlat(max(xs), max(ys), 0)
    return Corridor(
        start=start, end=end, centre=(cx, cy),
        theta=math.atan2(dy, dx),
        bearing=(math.degrees(math.atan2(dx, -dy)) + 360) % 360,
        a=a, b=b,
        corners=[pixel_to_lonlat(x, y, 0) for x, y in corners_px],
        envelope=(w, s, e, n), half_width_m=half_width_m, pad_m=pad_m,
    )

def corridor_tile_filter(geom: Corridor, zoom: int):
    """Return a predicate (tx, ty) -> bool that is False for tiles clearly outside the corridor."""
    k = 2 ** zoom
    r = TILE_SIZE * math.sqrt(0.5)
    cx, cy = geom.centre[0] * k, geom.centre[1] * k
    a, b = geom.a * k + r, geom.b * k + r
    c, s = math.cos(geom.theta), math.sin(geom.theta)

    def keep(tx: int, ty: int) -> bool:
        dx, dy = (tx + 0.5) * TILE_SIZE - cx, (ty + 0.5) * TILE_SIZE - cy
        return abs(dx * c + dy * s) <= a and abs(-dx * s + dy * c) <= b
    return keep

def corridor_from_box(centre: tuple[float, float], length_m: float, width_m: float, bearing: float) -> Corridor:
    """Rotated rectangle: centre (lat, lon), length_m along `bearing` (deg, 0 = north), width_m across it."""
    lat, lon = centre
    cx, cy = lonlat_to_pixel(lon, lat, 0)
    mpu = EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / TILE_SIZE
    t = math.radians(bearing)
    dx, dy = math.sin(t) * length_m / 2 / mpu, -math.cos(t) * length_m / 2 / mpu
    lon1, lat1 = pixel_to_lonlat(cx - dx, cy - dy, 0)
    lon2, lat2 = pixel_to_lonlat(cx + dx, cy + dy, 0)
    return corridor_geometry((lat1, lon1), (lat2, lon2), half_width_m=width_m / 2, pad_m=0.0)


def corridor_from_rotated_bbox(bbox: BBox, angle_deg: float) -> Corridor:
    """Same convention as the web UI: `bbox` is the unrotated box, rotated `angle_deg` clockwise about its centre."""
    w, s, e, n = validate_bbox(bbox)
    x0, y0 = lonlat_to_pixel(w, n, 0)
    x1, y1 = lonlat_to_pixel(e, s, 0)
    lon, lat = pixel_to_lonlat((x0 + x1) / 2, (y0 + y1) / 2, 0)
    mpu = EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / TILE_SIZE
    return corridor_from_box((lat, lon), (x1 - x0) * mpu, (y1 - y0) * mpu, 90.0 + angle_deg)

def choose_corridor_zoom(geom: Corridor, max_px: int = 4096, max_zoom: int = 19, min_zoom: int = 1) -> int:
    for zoom in range(max_zoom, min_zoom - 1, -1):
        if 2 * geom.a * 2 ** zoom <= max_px and 2 * geom.b * 2 ** zoom <= max_px:
            return zoom
    return min_zoom


def extract_corridor(stitched: Image.Image, origin: tuple[int, int], geom: Corridor, zoom: int) -> Image.Image:
    """
    Rotate and crop a stitched mosaic to the corridor so the segment runs left
    to right with the start on the left. Uses an affine transform that maps each
    output pixel back to the mosaic: in = C + R(theta) * (out - (a, b)).
    """
    k = 2 ** zoom
    width, height = max(1, round(2 * geom.a * k)), max(1, round(2 * geom.b * k))
    a, b = width / 2, height / 2
    cx, cy = geom.centre[0] * k - origin[0], geom.centre[1] * k - origin[1]
    c, s = math.cos(geom.theta), math.sin(geom.theta)
    data = (c, -s, cx - a * c + b * s,
            s, c, cy - a * s - b * c)
    return stitched.transform((width, height), Image.AFFINE, data,
                              resample=Image.BICUBIC, fillcolor=(128, 128, 128))


def corridor_point(geom: Corridor, zoom: int, point: tuple[float, float],
                   width: int, height: int) -> tuple[float, float]:
    """Map a (lat, lon) point to corridor image coordinates."""
    k = 2 ** zoom
    lat, lon = point
    px, py = lonlat_to_pixel(lon, lat, zoom)
    rx, ry = px - geom.centre[0] * k, py - geom.centre[1] * k
    c, s = math.cos(-geom.theta), math.sin(-geom.theta)
    return width / 2 + rx * c - ry * s, height / 2 + rx * s + ry * c


def draw_north_arrow(image: Image.Image, theta: float) -> None:
    """North arrow in the top-right corner of a rotated image. Modifies in place."""
    size = max(16, min(image.height * 0.35, image.width / 20))
    cx, cy = image.width - size * 0.9, size * 0.9
    nx, ny = -math.sin(theta), -math.cos(theta)
    tip = (cx + nx * size * 0.45, cy + ny * size * 0.45)
    tail = (cx - nx * size * 0.45, cy - ny * size * 0.45)
    hl, hx, hy = size * 0.2, -ny, nx
    draw = ImageDraw.Draw(image)
    lw = max(2, int(size / 12))
    for color, offset in (((0, 0, 0), 2), ((255, 255, 255), 0)):  # dark shadow, then white
        o = offset / 2
        draw.line([(tail[0] + o, tail[1] + o), (tip[0] + o, tip[1] + o)], fill=color, width=lw + offset)
        draw.polygon([
            (tip[0] + o, tip[1] + o),
            (tip[0] - nx * hl + hx * hl * 0.6 + o, tip[1] - ny * hl + hy * hl * 0.6 + o),
            (tip[0] - nx * hl - hx * hl * 0.6 + o, tip[1] - ny * hl - hy * hl * 0.6 + o),
        ], fill=color)
    font = _load_font(max(10, int(size * 0.4)))
    pos = (tip[0] + nx * size * 0.3, tip[1] + ny * size * 0.3)
    try:
        draw.text(pos, "N", fill=(255, 255, 255), font=font, anchor="mm",
                  stroke_width=1, stroke_fill=(0, 0, 0))
    except (ValueError, TypeError):  # Pillow bitmap fallback font: no anchor/stroke support
        draw.text(pos, "N", fill=(255, 255, 255), font=font)


def sample_capture_dates_along(release: Release, start: tuple[float, float], end: tuple[float, float],
                               zoom: int, session: requests.Session | None = None) -> list[dt.date | None]:
    """Capture dates at five points along the segment."""
    (lat1, lon1), (lat2, lon2) = start, end
    pts = [(lon1 + t * (lon2 - lon1), lat1 + t * (lat2 - lat1)) for t in (0.1, 0.3, 0.5, 0.7, 0.9)]
    session = session or _make_session()
    with ThreadPoolExecutor(max_workers=5) as pool:
        infos = list(pool.map(lambda p: get_capture_info(release, p[0], p[1], zoom, session), pts))
    return [i.capture_date for i in infos]


# ---------------------------------------------------------------------------
# Tile download and stitching
# ---------------------------------------------------------------------------


def _make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def fetch_tile(session: requests.Session, url: str, retries: int = 3,
               timeout: int = 30) -> Image.Image | None:
    """Download one tile. Returns None if the tile does not exist or all retries fail."""
    for attempt in range(retries):
        try:
            resp = session.get(url, timeout=timeout)
            if resp.status_code == 200 and resp.content:
                return Image.open(io.BytesIO(resp.content)).convert("RGB")
            if resp.status_code in (400, 404):
                return None
        except requests.RequestException:
            pass
        time.sleep(0.5 * (attempt + 1))
    return None


def stitch(bbox: BBox, release: Release, zoom: int, workers: int = 8,
           session: requests.Session | None = None, keep=None) -> tuple[Image.Image, dict]:
    """Download all tiles covering bbox, paste onto a canvas, crop to the exact bbox."""
    session = session or _make_session()
    x0, y0, x1, y1 = bbox_pixel_extent(bbox, zoom)
    tx0, ty0 = int(x0 // TILE_SIZE), int(y0 // TILE_SIZE)
    tx1 = math.ceil(x1 / TILE_SIZE) - 1
    ty1 = math.ceil(y1 / TILE_SIZE) - 1
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1

    # Gray canvas; tiles that fail to download stay gray.
    tiles = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)
             if keep is None or keep(tx, ty)]
    if len(tiles) > MAX_TILES:
        raise ValueError(f"Request needs {len(tiles)} tiles (limit {MAX_TILES}). Reduce area or zoom.")
    canvas = Image.new("RGB", (cols * TILE_SIZE, rows * TILE_SIZE), (128, 128, 128))

    def work(t):
        tx, ty = t
        return t, fetch_tile(session, release.tile_url(zoom, tx, ty))

    missing = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for (tx, ty), img in pool.map(work, tiles):
            if img is None:
                missing += 1
                continue
            canvas.paste(img, ((tx - tx0) * TILE_SIZE, (ty - ty0) * TILE_SIZE))

    cropped = canvas.crop((
        round(x0 - tx0 * TILE_SIZE), round(y0 - ty0 * TILE_SIZE),
        round(x1 - tx0 * TILE_SIZE), round(y1 - ty0 * TILE_SIZE),
    ))

    origin = (tx0 * TILE_SIZE + round(x0 - tx0 * TILE_SIZE), ty0 * TILE_SIZE + round(y0 - ty0 * TILE_SIZE))
    return cropped, {"tiles_total": len(tiles), "tiles_missing": missing, "origin": origin}


# ---------------------------------------------------------------------------
# Annotation
# ---------------------------------------------------------------------------


def _load_font(size: int) -> ImageFont.ImageFont:
    """Try a few common TrueType fonts; fall back to Pillow's built-in font."""
    for name in ("DejaVuSans.ttf", "Arial.ttf", "Helvetica.ttc", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def add_label(image: Image.Image, lines: Sequence[str], padding: int = 8) -> Image.Image:
    """Append a black bar below the image containing the given text lines."""
    font_size = max(12, image.width // 60)
    font = _load_font(font_size)
    longest = max(lines, key=len) if lines else ""
    while font_size > 8 and font.getlength(longest) > image.width - 2 * padding:
        font_size -= 1
        font = _load_font(font_size)
    line_h = int(font_size * 1.35)
    bar_h = padding * 2 + line_h * len(lines)
    out = Image.new("RGB", (image.width, image.height + bar_h), (0, 0, 0))
    out.paste(image, (0, 0))
    draw = ImageDraw.Draw(out)
    y = image.height + padding
    for line in lines:
        draw.text((padding, y), line, fill=(255, 255, 255), font=font)
        y += line_h
    return out


def draw_circles(image: Image.Image, pts: Sequence[tuple[float, float]], color=(255, 40, 40)) -> None:
    r = max(5, min(image.width, image.height * 3) // 150)
    draw = ImageDraw.Draw(image)
    for cx, cy in pts:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=max(2, r // 2))


def draw_points(image, bbox, zoom, points, color=(255, 40, 40)) -> None:
    x0, y0, _, _ = bbox_pixel_extent(bbox, zoom)
    pts = []
    for lat, lon in points:
        px, py = lonlat_to_pixel(lon, lat, zoom)
        pts.append((px - x0, py - y0))
    draw_circles(image, pts, color)


# ---------------------------------------------------------------------------
# Output naming
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Reduce text to lowercase ASCII letters, digits, and hyphens."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return slug or "imagery"


def build_filename(label: str, requested: dt.date, release: Release,
                   capture_date: dt.date | None, bbox: BBox, zoom: int, suffix: str = "", ext: str = "png") -> str:
    """Encode label, requested date, capture date, release, bbox and zoom in the filename."""
    w, s, e, n = bbox
    cap = capture_date.isoformat() if capture_date else "unknown"
    return (f"{slugify(label)}_req{requested.isoformat()}_cap{cap}"
            f"_rel{release.date.isoformat()}-r{release.release_id}"
            f"_bbox{w:.5f}_{s:.5f}_{e:.5f}_{n:.5f}_z{zoom}{suffix}.{ext}")


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------


def generate_image(
    bbox: Iterable[float],
    date: dt.date,
    label: str,
    out_dir: str | Path = "output",
    zoom: int | None = None,
    max_px: int = 4096,
    max_zoom: int = 19,
    mode: str = "nearest",
    select_by: str = "capture",
    release_id: int | None = None,
    points: Sequence[tuple[float, float]] | None = None,
    workers: int = 8,
    ext: str = "png",
    corridor: Corridor | None = None,
) -> dict:
    """
    Full pipeline: choose zoom, select release, download, stitch, annotate, save.

    select_by:
      "capture" - release whose capture date at the bbox center is closest to `date`
      "release" - release whose release date is closest to `date`
    release_id, if given, overrides both.
    corridor, if given, overrides bbox and produces a rotated strip.
    """
    if corridor is not None:
        bbox = validate_bbox(corridor.envelope)
        if zoom is None:
            zoom = choose_corridor_zoom(corridor, max_px=max_px, max_zoom=max_zoom)
    else:
        bbox = validate_bbox(bbox)
        if zoom is None:
            zoom = choose_zoom(bbox, max_px=max_px, max_zoom=max_zoom)
    lon_c, lat_c = bbox_center(bbox)

    session = _make_session()

    if release_id is not None:
        release = find_release_by_id(release_id)
        capture = get_capture_info(release, lon_c, lat_c, zoom, session)
        selection = f"release id {release_id}"
    elif select_by == "capture":
        capture = find_release_by_capture(date, lon_c, lat_c, zoom, mode=mode)
        release = capture.release
        selection = f"capture date ({mode})"
    elif select_by == "release":
        release = find_release(date, mode=mode)
        capture = get_capture_info(release, lon_c, lat_c, zoom, session)
        selection = f"release date ({mode})"
    else:
        raise ValueError("select_by must be 'capture' or 'release'.")

    image, stats = stitch(bbox, release, zoom, workers=workers, session=session,
                          keep=corridor_tile_filter(corridor, zoom) if corridor is not None else None)
    origin = stats.pop("origin")
    if corridor is not None:
        image = extract_corridor(image, origin, corridor, zoom)
    if points:
        if corridor is not None:
            draw_circles(image, [corridor_point(corridor, zoom, p, image.width, image.height) for p in points])
        else:
            draw_points(image, bbox, zoom, points)
    if corridor is not None:
        draw_north_arrow(image, corridor.theta)

    if corridor is not None:
        sampled = sample_capture_dates_along(release, corridor.start, corridor.end, zoom, session)
    else:
        sampled = sample_capture_dates(release, bbox, zoom, session)
    all_dates = sorted({d for d in [*sampled, capture.capture_date] if d})
    mixed = len(all_dates) > 1

    cap_text = capture.capture_date.isoformat() if capture.capture_date else "unknown"
    extra = []
    if capture.resolution_m:
        extra.append(f"{capture.resolution_m:g} m")
    if capture.provider:
        extra.append(str(capture.provider))
    if mixed:
        extra.append(f"mixed dates {all_dates[0]}..{all_dates[-1]}")
    cap_line = f"Captured: {cap_text}" + (f" ({', '.join(extra)})" if extra else "")

    w, s, e, n = bbox
    bearing_txt = f"{round(corridor.bearing):03d}" if corridor is not None else None
    lines = [label, cap_line,
             f"Requested: {date.isoformat()}   "
             f"Wayback release: {release.date.isoformat()} (id {release.release_id})"]
    if corridor is not None:
        lines.append(f"Aligned corridor: bearing {bearing_txt}°, half-width {corridor.half_width_m:g} m, "
                     "start at left, north arrow top right")
        lines.append(f"Envelope W,S,E,N: {w:.5f}, {s:.5f}, {e:.5f}, {n:.5f}   Zoom: {zoom}")
    else:
        lines.append(f"BBox W,S,E,N: {w:.5f}, {s:.5f}, {e:.5f}, {n:.5f}   Zoom: {zoom}")
    lines.append("Source: Esri World Imagery Wayback")
    labeled = add_label(image, lines)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = f"_aligned-b{bearing_txt}-w{corridor.half_width_m:g}" if corridor is not None else ""
    filename = build_filename(label, date, release, capture.capture_date, bbox, zoom, suffix=suffix, ext=ext)
    path = out_dir / filename
    labeled.save(path, **({"quality": 92} if ext.lower() in ("jpg", "jpeg") else {}))

    return {
        "path": str(path),
        "filename": filename,
        "label": label,
        "requested_date": date.isoformat(),
        "selection": selection,
        "release_id": release.release_id,
        "release_date": release.date.isoformat(),
        "capture_date": cap_text if capture.capture_date else None,
        "capture_resolution_m": capture.resolution_m,
        "capture_provider": capture.provider,
        "capture_dates_in_bbox": [d.isoformat() for d in all_dates],
        "mixed_capture": mixed,
        "bbox": [w, s, e, n],
        "zoom": zoom,
        "width": labeled.width,
        "height": labeled.height,
        "aligned": corridor is not None,
        "bearing": corridor.bearing if corridor is not None else None,
        "corners": [list(c) for c in corridor.corners] if corridor is not None else None,
        **stats,
    }