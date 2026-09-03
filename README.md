# wayback-imagery

Download, stitch, and label historical aerial imagery from the
[Esri World Imagery Wayback](https://livingatlas.arcgis.com/wayback/) archive.
Imagery is selected by the date the photo was **captured**, not the date the
Wayback snapshot was published, so requesting two dates only produces two
files when the underlying photo actually differs.

Provides a command-line tool and a small Flask web app.

## Why capture date

A Wayback release is a snapshot of the whole World Imagery service. Tiles that
did not change between releases are republished unchanged, so at any given
location most releases show the same photo. This tool queries Esri's
per-release metadata to find the capture date under the area of interest and
picks the release whose capture date is closest to the requested date.

## Install

```bash
pip install git+https://github.com/erbarwick/wayback-imagery
```

or for development:

```bash
git clone https://github.com/erbarwick/wayback-imagery
cd wayback-imagery
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Command line

```bash
# Distinct photos available for an area (bbox = west south east north)
wayback-imagery --bbox -121.67666 38.55650 -121.67024 38.55889 --list-captures

# Image whose capture date is nearest to a requested date
wayback-imagery --bbox -121.67666 38.55650 -121.67024 38.55889 \
    --date 2023-09-01 --label "Davis test"

# One image per distinct capture date
wayback-imagery --bbox -121.67666 38.55650 -121.67024 38.55889 \
    --all-captures --label "Davis test"

# Road segment (lat1 lon1 lat2 lon2); bbox with margin is derived automatically
wayback-imagery --segment 38.5565 -121.6766 38.5589 -121.6702 \
    --date 2019-07-01 --label "SR-1 PM 10.2-10.8" --out ./imagery
```

Run `wayback-imagery --help` for all options. Images are written to `../../output`
unless `--out` is given.

## Web interface

```bash
wayback-imagery-web            # http://127.0.0.1:5001
```

Draw a rectangle on the map or click two points for a road segment, choose a
date, and fetch. "List capture dates for this area" shows each distinct photo
available at the area's center. Output goes to `../../output` or the directory in
the `WAYBACK_OUTPUT_DIR` environment variable.

The web app uses Flask's development server and has no authentication. It is
intended for local use.

## Filenames

```
<label>_req<requested>_cap<captured>_rel<release>-r<release id>_bbox<W>_<S>_<E>_<N>_z<zoom>.png
```

Example:

```
davis-test_req2023-09-01_cap2022-05-14_rel2022-06-08-r48012_bbox-121.67666_38.55650_-121.67024_38.55889_z19.png
```

`cap` is `unknown` when no metadata is available for the location.

## Limitations

- Capture date is looked up at the center of the bounding box. Four interior
  points are also sampled; if they disagree the output is flagged as
  `mixed_capture` and the label shows the date range.
- Some releases (especially early ones) have no metadata service. They are
  excluded from capture-date selection but can be reached with
  `--select-by release` or `--release-id`.
- Not every zoom level exists everywhere. Missing tiles are gray and counted.
- Bounding boxes crossing the antimeridian are not supported.
- The release list and capture-date scans are cached in memory only.

## Data source and terms

Imagery is fetched on demand from Esri World Imagery Wayback and is subject to
[Esri's terms of use](https://www.esri.com/en-us/legal/terms/full-master-agreement).
Keep the attribution line in the label bar. The web map uses OpenStreetMap
and Esri basemap tiles, each with their own attribution.

## Development

```bash
pip install -e ".[dev]"
ruff check src tests
pytest
```

## License

MIT. See `LICENSE`.