"""Network-free tests for the pure functions in core.py."""

import datetime as dt

import pytest

from wayback_imagery.core import (
    CaptureInfo,
    Release,
    _layers_for_zoom,
    _parse_capture_date,
    bbox_from_segment,
    build_filename,
    choose_corridor_zoom,
    choose_zoom,
    corridor_geometry,
    corridor_point,
    distinct_captures,
    find_release,
    lonlat_to_pixel,
    pixel_to_lonlat,
    slugify,
    validate_bbox,
)


def rel(date: str, rid: int) -> Release:
    return Release(rid, dt.date.fromisoformat(date), f"Wayback {date}", "http://x/{level}/{row}/{col}", None)


RELEASES = [rel("2020-01-01", 1), rel("2021-01-01", 2), rel("2022-01-01", 3)]


# --- tile math -------------------------------------------------------------

def test_pixel_origin_is_top_left():
    x, y = lonlat_to_pixel(-180, 85.05112878, 0)
    assert (round(x), round(y)) == (0, 0)


def test_pixel_center_of_world():
    x, y = lonlat_to_pixel(0, 0, 1)
    assert (round(x), round(y)) == (256, 256)


def test_pixel_lonlat_roundtrip():
    x, y = lonlat_to_pixel(-121.67, 38.55, 15)
    lon, lat = pixel_to_lonlat(x, y, 15)
    assert abs(lon + 121.67) < 1e-9 and abs(lat - 38.55) < 1e-9


def test_choose_zoom_smaller_area_gets_higher_zoom():
    small = (-121.671, 38.556, -121.670, 38.557)
    large = (-121.80, 38.50, -121.60, 38.60)
    assert choose_zoom(small) > choose_zoom(large)


# --- bounding boxes --------------------------------------------------------

def test_segment_bbox_contains_endpoints_with_margin():
    w, s, e, n = bbox_from_segment((38.556, -121.676), (38.559, -121.670), margin_m=100)
    assert w < -121.676 and e > -121.670 and s < 38.556 and n > 38.559


def test_segment_bbox_minimum_margin_applies_to_short_segments():
    _w, s, _e, n = bbox_from_segment((38.5560, -121.6760), (38.5561, -121.6761), margin_m=150)
    # 150 m of latitude is about 0.00135 degrees on each side.
    assert (n - s) > 0.0025


def test_validate_bbox_rejects_inverted():
    with pytest.raises(ValueError):
        validate_bbox((-121.67, 38.56, -121.68, 38.55))


def test_validate_bbox_clamps_latitude():
    _, s, _, n = validate_bbox((-10, -89, 10, 89))
    assert s > -86 and n < 86


# --- aligned corridor ------------------------------------------------------

def test_corridor_east_west_segment():
    g = corridor_geometry((38.55, -121.68), (38.55, -121.66), half_width_m=20, pad_m=0)
    assert abs(g.theta) < 1e-9 and abs(g.bearing - 90) < 1e-6
    w, s, e, n = g.envelope
    # With no padding the envelope ends are the endpoints themselves (up to rounding).
    assert w <= -121.68 + 1e-9 and e >= -121.66 - 1e-9 and s < 38.55 < n
    # 20 m half-width is about 0.00018 deg of latitude
    assert 0.0003 < (n - s) < 0.0005


def test_corridor_envelope_contains_endpoints():
    g = corridor_geometry((38.5565, -121.6766), (38.5589, -121.6702))
    w, s, e, n = g.envelope
    for lat, lon in ((38.5565, -121.6766), (38.5589, -121.6702)):
        assert w <= lon <= e and s <= lat <= n


def test_corridor_identical_points_rejected():
    with pytest.raises(ValueError):
        corridor_geometry((38.55, -121.67), (38.55, -121.67))


def test_corridor_point_maps_start_left_end_right():
    start, end = (38.5565, -121.6766), (38.5589, -121.6702)
    g = corridor_geometry(start, end, half_width_m=20, pad_m=30)
    zoom = choose_corridor_zoom(g)
    width, height = round(2 * g.a * 2 ** zoom), round(2 * g.b * 2 ** zoom)
    sx, sy = corridor_point(g, zoom, start, width, height)
    ex, ey = corridor_point(g, zoom, end, width, height)
    assert sx < width / 2 < ex
    assert abs(sy - height / 2) < 1 and abs(ey - height / 2) < 1


# --- release selection -----------------------------------------------------

def test_find_release_modes():
    target = dt.date(2020, 12, 1)
    assert find_release(target, "nearest", RELEASES).release_id == 2
    assert find_release(target, "before", RELEASES).release_id == 1
    assert find_release(target, "after", RELEASES).release_id == 2


def test_find_release_before_first_raises():
    with pytest.raises(ValueError):
        find_release(dt.date(2019, 1, 1), "before", RELEASES)


# --- capture metadata ------------------------------------------------------

def test_parse_capture_date_epoch_ms():
    assert _parse_capture_date({"SRC_DATE2": 1609459200000}) == dt.date(2021, 1, 1)


def test_parse_capture_date_yyyymmdd_fallback():
    assert _parse_capture_date({"SRC_DATE": "20210101"}) == dt.date(2021, 1, 1)


def test_parse_capture_date_missing():
    assert _parse_capture_date({}) is None


def test_distinct_captures_collapses_same_photo_and_keeps_earliest_release():
    d = dt.date(2020, 6, 1)
    caps = [
        CaptureInfo(RELEASES[2], d, 0.3, None, "Maxar"),
        CaptureInfo(RELEASES[0], d, 0.3, None, "Maxar"),
        CaptureInfo(RELEASES[1], None, None, None, None),
    ]
    out = distinct_captures(caps)
    assert len(out) == 1
    assert out[0].release.release_id == 1


def test_layers_for_zoom_respects_scale_range():
    layers = [
        {"id": 0, "minScale": 100000, "maxScale": 10000},  # mid zooms only
        {"id": 1, "minScale": 5000, "maxScale": 0},        # zoomed in
    ]
    assert [layer["id"] for layer in _layers_for_zoom(layers, 19)] == [1]
    assert [layer["id"] for layer in _layers_for_zoom(layers, 13)] == [0]


# --- naming ----------------------------------------------------------------

def test_slugify():
    assert slugify("SR-1 PM 10.2-10.8") == "sr-1-pm-10-2-10-8"
    assert slugify("") == "imagery"


def test_build_filename_contains_all_fields():
    name = build_filename("Davis test", dt.date(2023, 9, 1), RELEASES[1], dt.date(2020, 6, 1),
                          (-121.67666, 38.5565, -121.67024, 38.55889), 19)
    assert name == ("davis-test_req2023-09-01_cap2020-06-01_rel2021-01-01-r2"
                    "_bbox-121.67666_38.55650_-121.67024_38.55889_z19.png")


def test_build_filename_unknown_capture():
    name = build_filename("x", dt.date(2023, 9, 1), RELEASES[0], None, (0, 0, 1, 1), 10)
    assert "_capunknown_" in name