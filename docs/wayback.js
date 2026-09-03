/*
 * Browser port of wayback_imagery/core.py.
 *
 * Conventions match the Python code:
 * - Points are [lat, lon]; bounding boxes are [west, south, east, north].
 * - Dates are ISO strings "YYYY-MM-DD" (they compare correctly as strings).
 * - Tile coordinates follow the Web Mercator slippy-map scheme (z, x, y).
 *
 * Everything runs in the browser: the release list, metadata queries and
 * tiles are fetched directly from Esri's servers, which send CORS headers.
 * Tiles are drawn onto a <canvas>; the result is downloaded via toBlob().
 */

export const CONFIG_URL =
    "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";
export const DEFAULT_TILE_TEMPLATE =
    "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/" +
    "WMTS/1.0.0/default028mm/MapServer/tile/{release}/{level}/{row}/{col}";

const TILE = 256;
const MAX_TILES = 2500;
const MAX_MERCATOR_LAT = 85.05112878;
const ARCGIS_SCALE_Z0 = 591657527.591555; // map scale denominator at zoom 0, 96 dpi

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function utcMs(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
export function daysBetween(a, b) {
  return Math.round((utcMs(a) - utcMs(b)) / 86400000);
}
function isoFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Run `fn` over `items` with at most `limit` calls in flight. Preserves order.
async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      onProgress?.(++done, items.length);
    }
  }));
  return out;
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

// ---------------------------------------------------------------------------
// Release list
// ---------------------------------------------------------------------------

let releasesPromise = null;

function findMetadataUrl(info) {
  let url = info.metadataLayerUrl;
  if (!url) {
    for (const v of Object.values(info)) {
      if (typeof v === "string" && /metadata/i.test(v) && /mapserver/i.test(v)) { url = v; break; }
    }
  }
  return url ? url.replace(/\/+$/, "") : null;
}

export function getReleases(force = false) {
  if (!releasesPromise || force) {
    releasesPromise = fetchJson(CONFIG_URL).then(cfg => {
      const out = [];
      for (const [key, info] of Object.entries(cfg)) {
        const m = /(\d{4}-\d{2}-\d{2})/.exec(info.itemTitle || "");
        if (!m) continue;
        out.push({
          id: Number(key),
          date: m[1],
          title: info.itemTitle || "",
          tileTemplate: info.itemURL || DEFAULT_TILE_TEMPLATE,
          metadataUrl: findMetadataUrl(info),
        });
      }
      return out.sort((a, b) => a.date.localeCompare(b.date));
    });
    releasesPromise.catch(() => { releasesPromise = null; }); // allow retry after a failure
  }
  return releasesPromise;
}

export async function findReleaseById(id) {
  const r = (await getReleases()).find(r => r.id === id);
  if (!r) throw new Error(`No Wayback release with id ${id}.`);
  return r;
}

export function tileUrl(release, z, x, y) {
  return release.tileTemplate
      .replace("{release}", release.id).replace("{level}", z).replace("{row}", y).replace("{col}", x);
}

// Shared nearest/before/after selection. `items` must be sorted ascending by key.
function pickByDate(items, key, target, mode, what) {
  if (!items.length) throw new Error(`No ${what} available.`);
  if (mode === "before") {
    const c = items.filter(i => key(i) <= target);
    if (!c.length) throw new Error(`No ${what} on or before ${target}.`);
    return c[c.length - 1];
  }
  if (mode === "after") {
    const c = items.filter(i => key(i) >= target);
    if (!c.length) throw new Error(`No ${what} on or after ${target}.`);
    return c[0];
  }
  if (mode !== "nearest") throw new Error(`Unknown mode '${mode}'.`);
  let best = items[0];
  for (const i of items) {
    if (Math.abs(daysBetween(key(i), target)) < Math.abs(daysBetween(key(best), target))) best = i;
  }
  return best; // ties keep the earlier item
}

export async function findRelease(target, mode = "nearest") {
  return pickByDate(await getReleases(), r => r.date, target, mode, "release");
}

// ---------------------------------------------------------------------------
// Capture-date metadata
// ---------------------------------------------------------------------------

const layerCache = new Map(); // metadataUrl -> [layer]
const scanCache = new Map();  // "lon,lat,zoom" -> [CaptureInfo]

export function scaleForZoom(zoom) {
  return ARCGIS_SCALE_Z0 / 2 ** zoom;
}

async function metadataLayers(url) {
  if (!layerCache.has(url)) {
    const data = await fetchJson(`${url}?f=json`);
    layerCache.set(url, (data.layers || []).filter(l => !l.subLayerIds));
  }
  return layerCache.get(url);
}

function layersForZoom(layers, zoom) {
  const scale = scaleForZoom(zoom);
  const visible = layers.filter(l =>
      (!l.minScale || scale <= l.minScale) && (!l.maxScale || scale >= l.maxScale));
  return visible.length ? visible : [...layers].sort((a, b) => (a.maxScale || 0) - (b.maxScale || 0));
}

async function queryLayer(metadataUrl, layerId, lon, lat) {
  const p = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
  });
  try {
    const data = await fetchJson(`${metadataUrl}/${layerId}/query?${p}`);
    return data.features?.[0]?.attributes || null;
  } catch {
    return null;
  }
}

// SRC_DATE2 is epoch milliseconds; older services may only have SRC_DATE as YYYYMMDD.
function parseCaptureDate(a) {
  const v = a.SRC_DATE2;
  if (typeof v === "number" && v > 0) return isoFromMs(v);
  const s = a.SRC_DATE;
  if (s != null && String(s) !== "0" && String(s) !== "") {
    const t = String(s).trim();
    let m;
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)) || (m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(t))) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
    if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t))) return `${m[3]}-${m[1]}-${m[2]}`;
  }
  return null;
}

const num = v => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// Never throws; unknown fields are null.
export async function getCaptureInfo(release, lon, lat, zoom) {
  const empty = { release, captureDate: null, resolutionM: null, accuracyM: null, provider: null };
  if (!release.metadataUrl) return empty;
  let layers;
  try { layers = await metadataLayers(release.metadataUrl); } catch { return empty; }
  for (const layer of layersForZoom(layers, zoom)) {
    const a = await queryLayer(release.metadataUrl, layer.id, lon, lat);
    if (a) {
      return {
        release,
        captureDate: parseCaptureDate(a),
        resolutionM: num(a.SRC_RES),
        accuracyM: num(a.SRC_ACC),
        provider: a.NICE_NAME || a.SRC_DESC || null,
      };
    }
  }
  return empty;
}

// One CaptureInfo per release, in release order. Cached per point and zoom.
export async function scanCaptures(lon, lat, zoom, onProgress) {
  const key = `${lon.toFixed(4)},${lat.toFixed(4)},${zoom}`;
  if (!scanCache.has(key)) {
    const releases = await getReleases();
    const infos = await pool(releases, 12, r => getCaptureInfo(r, lon, lat, zoom), onProgress);
    scanCache.set(key, infos);
  }
  return scanCache.get(key);
}

// One entry per distinct capture date; earliest release carrying it is kept.
export function distinctCaptures(captures) {
  const seen = new Map();
  for (const c of [...captures].sort((a, b) => a.release.date.localeCompare(b.release.date))) {
    if (c.captureDate && !seen.has(c.captureDate)) seen.set(c.captureDate, c);
  }
  return [...seen.values()].sort((a, b) => a.captureDate.localeCompare(b.captureDate));
}

export async function findReleaseByCapture(target, lon, lat, zoom, mode = "nearest", onProgress) {
  const options = distinctCaptures(await scanCaptures(lon, lat, zoom, onProgress));
  if (!options.length) {
    throw new Error("No capture-date metadata is available at this location. Use selection by release date.");
  }
  return pickByDate(options, c => c.captureDate, target, mode, "capture date");
}

// Capture dates at four interior points, used to detect mixed-date mosaics.
export async function sampleCaptureDates(release, [w, s, e, n], zoom) {
  const pts = [
    [w + 0.15 * (e - w), s + 0.15 * (n - s)], [e - 0.15 * (e - w), s + 0.15 * (n - s)],
    [w + 0.15 * (e - w), n - 0.15 * (n - s)], [e - 0.15 * (e - w), n - 0.15 * (n - s)],
  ];
  const infos = await Promise.all(pts.map(([lon, lat]) => getCaptureInfo(release, lon, lat, zoom)));
  return infos.map(i => i.captureDate);
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

export function bboxFromSegment([lat1, lon1], [lat2, lon2], marginM = 150, marginFrac = 0.25) {
  const west = Math.min(lon1, lon2), east = Math.max(lon1, lon2);
  const south = Math.min(lat1, lat2), north = Math.max(lat1, lat2);
  const midLat = (south + north) / 2;
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);
  const mx = Math.max(marginM, marginFrac * (east - west) * mPerDegLon);
  const my = Math.max(marginM, marginFrac * (north - south) * mPerDegLat);
  return [west - mx / mPerDegLon, south - my / mPerDegLat, east + mx / mPerDegLon, north + my / mPerDegLat];
}

export function validateBbox(bbox) {
  const [w, s, e, n] = bbox.map(Number);
  if (bbox.some(v => !Number.isFinite(Number(v)))) throw new Error("Bounding box values must be numbers.");
  if (w < -180 || w > 180 || e < -180 || e > 180) throw new Error("Longitude must be between -180 and 180.");
  if (w >= e) throw new Error("West must be less than east.");
  if (s >= n) throw new Error("South must be less than north.");
  return [w, Math.max(s, -MAX_MERCATOR_LAT), e, Math.min(n, MAX_MERCATOR_LAT)];
}

export const bboxCenter = ([w, s, e, n]) => [(w + e) / 2, (s + n) / 2]; // [lon, lat]

// ---------------------------------------------------------------------------
// Web Mercator tile math
// ---------------------------------------------------------------------------

export function lonlatToPixel(lon, lat, zoom) {
  const n = TILE * 2 ** zoom, r = lat * Math.PI / 180;
  return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}

export function pixelToLonlat(x, y, zoom) {
  const n = TILE * 2 ** zoom;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
}

export function bboxPixelExtent([w, s, e, n], zoom) {
  const [x0, y0] = lonlatToPixel(w, n, zoom), [x1, y1] = lonlatToPixel(e, s, zoom);
  return { x0, y0, x1, y1 };
}

export function chooseZoom(bbox, maxPx = 4096, maxZoom = 19, minZoom = 1) {
  for (let z = maxZoom; z >= minZoom; z--) {
    const { x0, y0, x1, y1 } = bboxPixelExtent(bbox, z);
    if (x1 - x0 <= maxPx && y1 - y0 <= maxPx) return z;
  }
  return minZoom;
}

// ---------------------------------------------------------------------------
// Tile download and stitching
// ---------------------------------------------------------------------------

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // required; otherwise toBlob() on the canvas throws
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // missing tile stays gray
    img.src = url;
  });
}

export async function stitch(bbox, release, zoom, onProgress, keep = null) {
  const { x0, y0, x1, y1 } = bboxPixelExtent(bbox, zoom);
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.ceil(x1 / TILE) - 1, ty1 = Math.ceil(y1 / TILE) - 1;
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;

  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (!keep || keep(tx, ty)) tiles.push([tx, ty]);
  }
  if (tiles.length > MAX_TILES) {
    throw new Error(`Request needs ${tiles.length} tiles (limit ${MAX_TILES}). Reduce area or zoom.`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = cols * TILE; canvas.height = rows * TILE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  let missing = 0;
  await pool(tiles, 8, async ([tx, ty]) => {
    const img = await loadImage(tileUrl(release, zoom, tx, ty));
    if (img) ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE); else missing++;
  }, onProgress);

  // Crop to the exact bbox.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(x1 - x0)); out.height = Math.max(1, Math.round(y1 - y0));
  out.getContext("2d").drawImage(canvas, -Math.round(x0 - tx0 * TILE), -Math.round(y0 - ty0 * TILE));
  return {
    canvas: out, tilesTotal: tiles.length, tilesMissing: missing,
    origin: [tx0 * TILE + Math.round(x0 - tx0 * TILE), ty0 * TILE + Math.round(y0 - ty0 * TILE)],
  };
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

export function drawCircles(canvas, pts, color = "rgb(255,40,40)") {
  const r = Math.max(5, Math.floor(Math.min(canvas.width, canvas.height * 3) / 150));
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, Math.floor(r / 2));
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
}

export function drawPoints(canvas, bbox, zoom, points, color) {
  const { x0, y0 } = bboxPixelExtent(bbox, zoom);
  drawCircles(canvas, points.map(([lat, lon]) => {
    const [px, py] = lonlatToPixel(lon, lat, zoom);
    return [px - x0, py - y0];
  }), color);
}

export function addLabel(canvas, lines, padding = 8) {
  const probe = document.createElement("canvas").getContext("2d");
  let fontSize = Math.max(12, Math.floor(canvas.width / 60));
  const font = s => `${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  probe.font = font(fontSize);
  while (fontSize > 8 && probe.measureText(longest).width > canvas.width - 2 * padding) {
    probe.font = font(--fontSize);
  }
  const lineH = Math.round(fontSize * 1.35);
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height + padding * 2 + lineH * lines.length;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = "#fff"; ctx.font = font(fontSize); ctx.textBaseline = "top";
  lines.forEach((t, i) => ctx.fillText(t, padding, canvas.height + padding + i * lineH));
  return out;
}

// ---------------------------------------------------------------------------
// Output naming and download
// ---------------------------------------------------------------------------

export function slugify(text) {
  return String(text).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "imagery";
}

export function buildFilename(label, requested, release, captureDate, [w, s, e, n], zoom, suffix = "", ext = "png") {
  const f = v => v.toFixed(5);
  return `${slugify(label)}_req${requested}_cap${captureDate || "unknown"}` +
      `_rel${release.date}-r${release.id}_bbox${f(w)}_${f(s)}_${f(e)}_${f(n)}_z${zoom}${suffix}.${ext}`;
}

export function downloadCanvas(canvas, filename) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error("Could not encode image."));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      resolve();
    }, "image/png");
  });
}

// ---------------------------------------------------------------------------
// Rotated rectangles: an aligned corridor around a road segment, or a
// user-rotated bounding box. Both share the same geometry object:
//   centre   [x, y]        centre in zoom-0 pixel units
//   theta    radians       direction of the rectangle's local x axis, clockwise
//                          from screen east (y grows south). This is the axis
//                          that ends up horizontal in the output image.
//   bearing  degrees       corridor: compass bearing of the segment (0 = north)
//                          rotated:  the rotation angle (image top faces this bearing)
//   a, b                   half-extents along the local x and y axes (zoom-0 units)
//   corners  [[lon, lat]]  four corners
//   envelope [w, s, e, n]  axis-aligned box containing the rectangle (what gets fetched)
//   widthM, heightM        ground size of the rectangle in metres
//   kind                   "corridor" | "rotated"
// ---------------------------------------------------------------------------

const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Ground metres per zoom-0 pixel ("world unit") at a latitude.
export const metresPerWorldUnit = lat => EARTH_CIRCUMFERENCE_M * Math.cos(lat * Math.PI / 180) / TILE;

// Normalise degrees to [0, 360); returns exactly 0 for "no rotation".
export function normalizeAngle(deg) {
  const a = (((Number(deg) || 0) % 360) + 360) % 360;
  return Math.abs(a) < 1e-9 || Math.abs(a - 360) < 1e-9 ? 0 : a;
}

// Shared builder for both geometry kinds.
function rectGeometry(centre, a, b, theta) {
  const u = [Math.cos(theta), Math.sin(theta)], nv = [-u[1], u[0]];
  const cornersPx = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sa, sb]) =>
    [centre[0] + sa * a * u[0] + sb * b * nv[0], centre[1] + sa * a * u[1] + sb * b * nv[1]]);
  const xs = cornersPx.map(p => p[0]), ys = cornersPx.map(p => p[1]);
  const [w, n] = pixelToLonlat(Math.min(...xs), Math.min(...ys), 0);
  const [e, s] = pixelToLonlat(Math.max(...xs), Math.max(...ys), 0);
  const mpu = metresPerWorldUnit(pixelToLonlat(centre[0], centre[1], 0)[1]);
  return {
    centre, a, b, theta,
    corners: cornersPx.map(([x, y]) => pixelToLonlat(x, y, 0)),
    envelope: [w, s, e, n],
    widthM: 2 * a * mpu, heightM: 2 * b * mpu,
  };
}

// Corridor of half-width halfWidthM around start->end, extended by padM past each end.
export function corridorGeometry([lat1, lon1], [lat2, lon2], halfWidthM = 20, padM = 30) {
  const [x1, y1] = lonlatToPixel(lon1, lat1, 0), [x2, y2] = lonlatToPixel(lon2, lat2, 0);
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len === 0) throw new Error("Start and end points are identical.");
  const mpu = metresPerWorldUnit((lat1 + lat2) / 2);
  const a = len / 2 + padM / mpu, b = halfWidthM / mpu;
  return {
    ...rectGeometry([(x1 + x2) / 2, (y1 + y2) / 2], a, b, Math.atan2(dy, dx)),
    kind: "corridor",
    bearing: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360,
    halfWidthM, padM, start: [lat1, lon1], end: [lat2, lon2],
  };
}

// Predicate: does tile (tx, ty) at `zoom` possibly intersect the corridor? Conservative
// (a tile is kept if its centre is within half a tile diagonal of the rectangle).
export function corridorTileFilter(geom, zoom) {
  const k = 2 ** zoom, r = TILE * Math.SQRT1_2;
  const cx = geom.centre[0] * k, cy = geom.centre[1] * k, a = geom.a * k + r, b = geom.b * k + r;
  const c = Math.cos(geom.theta), s = Math.sin(geom.theta);
  return (tx, ty) => {
    const dx = (tx + 0.5) * TILE - cx, dy = (ty + 0.5) * TILE - cy;
    return Math.abs(dx * c + dy * s) <= a && Math.abs(-dx * s + dy * c) <= b;
  };
}

/*
 * A bounding box [w, s, e, n] rotated angleDeg degrees clockwise about its centre.
 * The output image is rotated back so the box is upright, i.e. its top edge faces
 * compass bearing angleDeg. angleDeg = 0 gives the same footprint as the plain box.
 */
export function rotatedBoxGeometry(bbox, angleDeg) {
  const box = validateBbox(bbox);
  const angle = normalizeAngle(angleDeg);
  const { x0, y0, x1, y1 } = bboxPixelExtent(box, 0);
  const centre = [(x0 + x1) / 2, (y0 + y1) / 2];
  return {
    ...rectGeometry(centre, (x1 - x0) / 2, (y1 - y0) / 2, angle * Math.PI / 180),
    kind: "rotated", angle, bearing: angle, bbox: box,
  };
}

// [lon, lat] of the point at fractional local coordinates (fx, fy in [-1, 1]) of a geometry.
export function geomPoint(geom, fx, fy) {
  const u = [Math.cos(geom.theta), Math.sin(geom.theta)], nv = [-u[1], u[0]];
  return pixelToLonlat(
    geom.centre[0] + fx * geom.a * u[0] + fy * geom.b * nv[0],
    geom.centre[1] + fx * geom.a * u[1] + fy * geom.b * nv[1], 0);
}

export function chooseCorridorZoom(geom, maxPx = 4096, maxZoom = 19, minZoom = 1) {
  for (let z = maxZoom; z >= minZoom; z--) {
    if (2 * geom.a * 2 ** z <= maxPx && 2 * geom.b * 2 ** z <= maxPx) return z;
  }
  return minZoom;
}

// Rotate and crop a stitched mosaic to the rectangle. `origin` comes from stitch().
// Output: the local x axis runs left to right (corridor: start on the left;
// rotated box: the box appears upright).
export function extractCorridor(stitched, origin, geom, zoom) {
  const k = 2 ** zoom;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(2 * geom.a * k));
  out.height = Math.max(1, Math.round(2 * geom.b * k));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(-geom.theta);
  ctx.drawImage(stitched, -(geom.centre[0] * k - origin[0]), -(geom.centre[1] * k - origin[1]));
  return out;
}

// Map a [lat, lon] point to rotated-canvas coordinates.
export function corridorPoint(geom, zoom, [lat, lon], width, height) {
  const k = 2 ** zoom;
  const [px, py] = lonlatToPixel(lon, lat, zoom);
  const rx = px - geom.centre[0] * k, ry = py - geom.centre[1] * k;
  const c = Math.cos(-geom.theta), s = Math.sin(-geom.theta);
  return [width / 2 + rx * c - ry * s, height / 2 + rx * s + ry * c];
}

// North arrow in the top-right corner of a rotated image.
export function drawNorthArrow(canvas, theta) {
  const size = Math.max(16, Math.min(canvas.height * 0.35, canvas.width / 20));
  const cx = canvas.width - size * 0.9, cy = size * 0.9;
  const nx = -Math.sin(theta), ny = -Math.cos(theta);   // north direction in the rotated frame
  const tip = [cx + nx * size * 0.45, cy + ny * size * 0.45];
  const tail = [cx - nx * size * 0.45, cy - ny * size * 0.45];
  const hl = size * 0.2, hx = -ny, hy = nx;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = "#fff"; ctx.lineWidth = Math.max(2, size / 12);
  ctx.shadowColor = "#000"; ctx.shadowBlur = 4;
  ctx.beginPath(); ctx.moveTo(...tail); ctx.lineTo(...tip); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(...tip);
  ctx.lineTo(tip[0] - nx * hl + hx * hl * 0.6, tip[1] - ny * hl + hy * hl * 0.6);
  ctx.lineTo(tip[0] - nx * hl - hx * hl * 0.6, tip[1] - ny * hl - hy * hl * 0.6);
  ctx.closePath(); ctx.fill();
  ctx.font = `bold ${Math.round(size * 0.4)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", tip[0] + nx * size * 0.3, tip[1] + ny * size * 0.3);
  ctx.restore();
}

// Capture dates at five points along the segment (used instead of bbox corners).
export async function sampleCaptureDatesAlong(release, [lat1, lon1], [lat2, lon2], zoom) {
  const pts = [0.1, 0.3, 0.5, 0.7, 0.9].map(t => [lon1 + t * (lon2 - lon1), lat1 + t * (lat2 - lat1)]);
  const infos = await Promise.all(pts.map(([lon, lat]) => getCaptureInfo(release, lon, lat, zoom)));
  return infos.map(i => i.captureDate);
}

// Capture dates at four interior points of a rotated rectangle (in its own frame).
export async function sampleCaptureDatesInBox(release, geom, zoom) {
  const pts = [[-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]].map(([fx, fy]) => geomPoint(geom, fx, fy));
  const infos = await Promise.all(pts.map(([lon, lat]) => getCaptureInfo(release, lon, lat, zoom)));
  return infos.map(i => i.captureDate);
}

// ---------------------------------------------------------------------------
// High-level entry point (equivalent of core.generate_image)
// ---------------------------------------------------------------------------

/*
 * params: { bbox, date, label, zoom?, maxPx?, maxZoom?, mode?, selectBy?, releaseId?, points?,
 *           rotation?,                                       // degrees clockwise, applies to bbox
 *           corridor?: { start, end, halfWidthM, padM } }    // overrides bbox/rotation
 * With corridor, or with a non-zero rotation, the output is the rotated rectangle.
 */
export async function generateImage(params, onStatus = () => {}) {
  const maxPx = params.maxPx || 4096, maxZoom = params.maxZoom || 19;
  let geom = null, bbox, zoom;
  if (params.corridor) {
    const c = params.corridor;
    geom = corridorGeometry(c.start, c.end, c.halfWidthM, c.padM);
  } else if (normalizeAngle(params.rotation)) {
    geom = rotatedBoxGeometry(params.bbox, params.rotation);
  }
  if (geom) {
    bbox = validateBbox(geom.envelope);
    zoom = params.zoom || chooseCorridorZoom(geom, maxPx, maxZoom);
  } else {
    bbox = validateBbox(params.bbox);
    zoom = params.zoom || chooseZoom(bbox, maxPx, maxZoom);
  }
  const [lonC, latC] = bboxCenter(bbox);
  const mode = params.mode || "nearest";
  const progress = what => (d, t) => onStatus(`${what} ${d}/${t}`);

  let release, capture, selection;
  if (params.releaseId) {
    release = await findReleaseById(params.releaseId);
    onStatus("Reading capture metadata");
    capture = await getCaptureInfo(release, lonC, latC, zoom);
    selection = `release id ${params.releaseId}`;
  } else if ((params.selectBy || "capture") === "capture") {
    capture = await findReleaseByCapture(params.date, lonC, latC, zoom, mode, progress("Scanning releases"));
    release = capture.release;
    selection = `capture date (${mode})`;
  } else {
    release = await findRelease(params.date, mode);
    onStatus("Reading capture metadata");
    capture = await getCaptureInfo(release, lonC, latC, zoom);
    selection = `release date (${mode})`;
  }

  let { canvas, tilesTotal, tilesMissing, origin } =
    await stitch(bbox, release, zoom, progress("Downloading tiles"), geom ? corridorTileFilter(geom, zoom) : null);
  if (geom) canvas = extractCorridor(canvas, origin, geom, zoom);
  if (params.points?.length) {
    if (geom) drawCircles(canvas, params.points.map(p => corridorPoint(geom, zoom, p, canvas.width, canvas.height)));
    else drawPoints(canvas, bbox, zoom, params.points);
  }
  if (geom) drawNorthArrow(canvas, geom.theta);

  onStatus("Checking for mixed capture dates");
  let sampled;
  if (geom?.kind === "corridor") sampled = await sampleCaptureDatesAlong(release, geom.start, geom.end, zoom);
  else if (geom) sampled = await sampleCaptureDatesInBox(release, geom, zoom);
  else sampled = await sampleCaptureDates(release, bbox, zoom);
  const allDates = [...new Set([...sampled, capture.captureDate].filter(Boolean))].sort();
  const mixed = allDates.length > 1;

  const extra = [];
  if (capture.resolutionM) extra.push(`${capture.resolutionM} m`);
  if (capture.provider) extra.push(capture.provider);
  if (mixed) extra.push(`mixed dates ${allDates[0]}..${allDates[allDates.length - 1]}`);
  const [w, s, e, n] = bbox;
  const f = v => v.toFixed(5);
  const bearingTxt = geom ? String(Math.round(geom.bearing)).padStart(3, "0") : null;
  const lines = [
    params.label,
    `Captured: ${capture.captureDate || "unknown"}${extra.length ? ` (${extra.join(", ")})` : ""}`,
    `Requested: ${params.date}   Wayback release: ${release.date} (id ${release.id})`,
  ];
  let suffix = "", nameBbox = bbox;
  if (geom?.kind === "corridor") {
    lines.push(`Aligned corridor: bearing ${bearingTxt}°, half-width ${geom.halfWidthM} m, start at left, north arrow top right`);
    lines.push(`Envelope W,S,E,N: ${f(w)}, ${f(s)}, ${f(e)}, ${f(n)}   Zoom: ${zoom}`);
    suffix = `_aligned-b${bearingTxt}-w${geom.halfWidthM}`;
  } else if (geom) {
    const [bw, bs, be, bn] = geom.bbox;
    lines.push(`Rotated box: ${geom.angle}° clockwise (image top faces bearing ${bearingTxt}°), ` +
        `${Math.round(geom.widthM)} x ${Math.round(geom.heightM)} m, north arrow top right`);
    lines.push(`Box W,S,E,N before rotation: ${f(bw)}, ${f(bs)}, ${f(be)}, ${f(bn)}   Zoom: ${zoom}`);
    suffix = `_rot${geom.angle}`;
    nameBbox = geom.bbox;
  } else {
    lines.push(`BBox W,S,E,N: ${f(w)}, ${f(s)}, ${f(e)}, ${f(n)}   Zoom: ${zoom}`);
  }
  lines.push("Source: Esri World Imagery Wayback");
  const labeled = addLabel(canvas, lines);
  const filename = buildFilename(params.label, params.date, release, capture.captureDate, nameBbox, zoom, suffix);

  return {
    canvas: labeled, filename, corners: geom?.corners ?? null,
    meta: {
      label: params.label, requestedDate: params.date, selection,
      releaseId: release.id, releaseDate: release.date,
      captureDate: capture.captureDate, captureResolutionM: capture.resolutionM, captureProvider: capture.provider,
      captureDatesInBbox: allDates, mixedCapture: mixed,
      bbox, box: nameBbox, zoom,
      bearing: geom?.bearing ?? null,
      aligned: geom?.kind === "corridor",
      rotated: geom?.kind === "rotated", rotation: geom?.angle ?? 0,
      width: labeled.width, height: labeled.height, tilesTotal, tilesMissing,
    },
  };
}