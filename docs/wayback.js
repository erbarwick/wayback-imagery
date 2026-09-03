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
  const widthM = (east - west) * mPerDegLon, heightM = (north - south) * mPerDegLat;
  const margin = Math.max(marginM, marginFrac * Math.max(widthM, heightM));
  return [west - margin / mPerDegLon, south - margin / mPerDegLat,
          east + margin / mPerDegLon, north + margin / mPerDegLat];
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

export async function stitch(bbox, release, zoom, onProgress) {
  const { x0, y0, x1, y1 } = bboxPixelExtent(bbox, zoom);
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.ceil(x1 / TILE) - 1, ty1 = Math.ceil(y1 / TILE) - 1;
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  if (cols * rows > MAX_TILES) {
    throw new Error(`Request needs ${cols * rows} tiles (limit ${MAX_TILES}). Reduce area or zoom.`);
  }

  const canvas = document.createElement("canvas");
  canvas.width = cols * TILE; canvas.height = rows * TILE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push([tx, ty]);
  let missing = 0;
  await pool(tiles, 8, async ([tx, ty]) => {
    const img = await loadImage(tileUrl(release, zoom, tx, ty));
    if (img) ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE); else missing++;
  }, onProgress);

  // Crop to the exact bbox.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(x1 - x0)); out.height = Math.max(1, Math.round(y1 - y0));
  out.getContext("2d").drawImage(canvas, -Math.round(x0 - tx0 * TILE), -Math.round(y0 - ty0 * TILE));
  return { canvas: out, tilesTotal: tiles.length, tilesMissing: missing };
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

export function drawPoints(canvas, bbox, zoom, points, color = "rgb(255,40,40)") {
  const { x0, y0 } = bboxPixelExtent(bbox, zoom);
  const r = Math.max(5, Math.floor(canvas.width / 150));
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, Math.floor(r / 2));
  for (const [lat, lon] of points) {
    const [px, py] = lonlatToPixel(lon, lat, zoom);
    ctx.beginPath(); ctx.arc(px - x0, py - y0, r, 0, Math.PI * 2); ctx.stroke();
  }
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

export function buildFilename(label, requested, release, captureDate, [w, s, e, n], zoom, ext = "png") {
  const f = v => v.toFixed(5);
  return `${slugify(label)}_req${requested}_cap${captureDate || "unknown"}` +
    `_rel${release.date}-r${release.id}_bbox${f(w)}_${f(s)}_${f(e)}_${f(n)}_z${zoom}.${ext}`;
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
// High-level entry point (equivalent of core.generate_image)
// ---------------------------------------------------------------------------

/*
 * params: { bbox, date, label, zoom?, maxPx?, maxZoom?, mode?, selectBy?, releaseId?, points? }
 * onStatus(text) receives progress messages.
 * Returns { canvas, filename, meta } where meta mirrors the Python result dict.
 */
export async function generateImage(params, onStatus = () => {}) {
  const bbox = validateBbox(params.bbox);
  const zoom = params.zoom || chooseZoom(bbox, params.maxPx || 4096, params.maxZoom || 19);
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

  const { canvas, tilesTotal, tilesMissing } = await stitch(bbox, release, zoom, progress("Downloading tiles"));
  if (params.points?.length) drawPoints(canvas, bbox, zoom, params.points);

  onStatus("Checking for mixed capture dates");
  const cornerDates = await sampleCaptureDates(release, bbox, zoom);
  const allDates = [...new Set([...cornerDates, capture.captureDate].filter(Boolean))].sort();
  const mixed = allDates.length > 1;

  const extra = [];
  if (capture.resolutionM) extra.push(`${capture.resolutionM} m`);
  if (capture.provider) extra.push(capture.provider);
  if (mixed) extra.push(`mixed dates ${allDates[0]}..${allDates[allDates.length - 1]}`);
  const [w, s, e, n] = bbox;
  const f = v => v.toFixed(5);
  const lines = [
    params.label,
    `Captured: ${capture.captureDate || "unknown"}${extra.length ? ` (${extra.join(", ")})` : ""}`,
    `Requested: ${params.date}   Wayback release: ${release.date} (id ${release.id})`,
    `BBox W,S,E,N: ${f(w)}, ${f(s)}, ${f(e)}, ${f(n)}   Zoom: ${zoom}`,
    "Source: Esri World Imagery Wayback",
  ];
  const labeled = addLabel(canvas, lines);
  const filename = buildFilename(params.label, params.date, release, capture.captureDate, bbox, zoom);

  return {
    canvas: labeled,
    filename,
    meta: {
      label: params.label, requestedDate: params.date, selection,
      releaseId: release.id, releaseDate: release.date,
      captureDate: capture.captureDate, captureResolutionM: capture.resolutionM, captureProvider: capture.provider,
      captureDatesInBbox: allDates, mixedCapture: mixed,
      bbox, zoom, width: labeled.width, height: labeled.height, tilesTotal, tilesMissing,
    },
  };
}