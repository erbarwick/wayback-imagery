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
# Constants
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

BBox = tuple[float, float, float, float]


def bbox_from_segment(start: tuple[float, float], end: tuple[float, float],
                      margin_m: float = 150.0, margin_frac: float = 0.25) -> BBox:
    """
    Bounding box around a segment (two (lat, lon) points). The margin on each
    side is the larger of `margin_m` metres and `margin_frac` times the longer
    side of the segment's extent.
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
    margin = max(margin_m, margin_frac * max(width_m, height_m))

    return (west - margin / m_per_deg_lon, south - margin / m_per_deg_lat,
            east + margin / m_per_deg_lon, north + margin / m_per_deg_lat)


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
           session: requests.Session | None = None) -> tuple[Image.Image, dict]:
    """Download all tiles covering bbox, paste onto a canvas, crop to the exact bbox."""
    session = session or _make_session()
    x0, y0, x1, y1 = bbox_pixel_extent(bbox, zoom)
    tx0, ty0 = int(x0 // TILE_SIZE), int(y0 // TILE_SIZE)
    tx1 = math.ceil(x1 / TILE_SIZE) - 1
    ty1 = math.ceil(y1 / TILE_SIZE) - 1
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    if cols * rows > MAX_TILES:
        raise ValueError(f"Request needs {cols * rows} tiles (limit {MAX_TILES}). Reduce area or zoom.")

    # Gray canvas; tiles that fail to download stay gray.
    canvas = Image.new("RGB", (cols * TILE_SIZE, rows * TILE_SIZE), (128, 128, 128))
    tiles = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]

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
    return cropped, {"tiles_total": len(tiles), "tiles_missing": missing}


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


def draw_points(image: Image.Image, bbox: BBox, zoom: int, points: Sequence[tuple[float, float]],
                color=(255, 40, 40)) -> None:
    """Circle marker at each (lat, lon) point. Modifies image in place."""
    x0, y0, _, _ = bbox_pixel_extent(bbox, zoom)
    r = max(5, image.width // 150)
    draw = ImageDraw.Draw(image)
    for lat, lon in points:
        px, py = lonlat_to_pixel(lon, lat, zoom)
        cx, cy = px - x0, py - y0
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=max(2, r // 2))


# ---------------------------------------------------------------------------
# Output naming
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Reduce text to lowercase ASCII letters, digits, and hyphens."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return slug or "imagery"


def build_filename(label: str, requested: dt.date, release: Release,
                   capture_date: dt.date | None, bbox: BBox, zoom: int, ext: str = "png") -> str:
    """Encode label, requested date, capture date, release, bbox and zoom in the filename."""
    w, s, e, n = bbox
    cap = capture_date.isoformat() if capture_date else "unknown"
    return (f"{slugify(label)}_req{requested.isoformat()}_cap{cap}"
            f"_rel{release.date.isoformat()}-r{release.release_id}"
            f"_bbox{w:.5f}_{s:.5f}_{e:.5f}_{n:.5f}_z{zoom}.{ext}")


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
) -> dict:
    """
    Full pipeline: choose zoom, select release, download, stitch, annotate, save.

    select_by:
      "capture" - release whose capture date at the bbox center is closest to `date`
      "release" - release whose release date is closest to `date`
    release_id, if given, overrides both.
    """
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

    image, stats = stitch(bbox, release, zoom, workers=workers, session=session)
    if points:
        draw_points(image, bbox, zoom, points)

    # Check whether the bbox spans images with different capture dates.
    corner_dates = sample_capture_dates(release, bbox, zoom, session)
    all_dates = sorted({d for d in [*corner_dates, capture.capture_date] if d})
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
    lines = [
        label,
        cap_line,
        f"Requested: {date.isoformat()}   "
        f"Wayback release: {release.date.isoformat()} (id {release.release_id})",
        f"BBox W,S,E,N: {w:.5f}, {s:.5f}, {e:.5f}, {n:.5f}   Zoom: {zoom}",
        "Source: Esri World Imagery Wayback",
    ]
    labeled = add_label(image, lines)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = build_filename(label, date, release, capture.capture_date, bbox, zoom, ext=ext)
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
        **stats,
    }