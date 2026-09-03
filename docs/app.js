/*
 * UI wiring for index.html. Replaces app.py and the Jinja logic of the Flask
 * template. All work happens in the browser via wayback.js.
 */

import {
  bboxCenter, bboxFromSegment, chooseZoom, distinctCaptures, downloadCanvas,
  generateImage, scanCaptures, validateBbox,
} from "./wayback.js";

const $ = id => document.getElementById(id);
const fmt = v => v.toFixed(6);
const form = $("form");

// ---------------------------------------------------------------------------
// Form persistence (values survive a reload; there is no server round trip)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "wayback-imagery-form";
const FIELDS = ["label", "date", "select_by", "mode", "release_id", "area_mode", "start_lat", "start_lon",
  "end_lat", "end_lon", "margin_m", "markers", "west", "south", "east", "north", "zoom", "max_px"];

function saveForm() {
  const data = {};
  for (const name of FIELDS) {
    const el = form.elements[name];
    if (!el) continue;
    data[name] = el instanceof RadioNodeList ? el.value : el.type === "checkbox" ? el.checked : el.value;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function restoreForm() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return; }
  for (const [name, value] of Object.entries(data)) {
    const el = form.elements[name];
    if (!el) continue;
    if (el instanceof RadioNodeList) el.value = value;
    else if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value ?? "";
  }
}

form.addEventListener("input", saveForm);
form.addEventListener("change", saveForm);
restoreForm();

// ---------------------------------------------------------------------------
// Form parsing (mirrors _float/_int/_resolve_area in app.py)
// ---------------------------------------------------------------------------

function num(name, required = true) {
  const raw = (form.elements[name]?.value ?? "").trim();
  if (!raw) {
    if (required) throw new Error(`Missing value for '${name}'.`);
    return null;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`'${name}' must be a number (got '${raw}').`);
  return v;
}

// Returns { bbox, points } from either the bbox fields or the segment fields.
function resolveArea() {
  if (form.elements.area_mode.value === "bbox") {
    return { bbox: [num("west"), num("south"), num("east"), num("north")], points: null };
  }
  const start = [num("start_lat"), num("start_lon")];
  const end = [num("end_lat"), num("end_lon")];
  const margin = num("margin_m", false) ?? 150;
  return { bbox: bboxFromSegment(start, end, margin), points: form.elements.markers.checked ? [start, end] : null };
}

function readParams() {
  const date = form.elements.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date is required (YYYY-MM-DD).");
  const { bbox, points } = resolveArea();
  const rid = num("release_id", false);
  return {
    bbox, points, date,
    label: form.elements.label.value.trim() || "imagery",
    selectBy: form.elements.select_by.value,
    mode: form.elements.mode.value,
    releaseId: rid ? Math.trunc(rid) : null,
    zoom: num("zoom", false) ? Math.trunc(num("zoom", false)) : null,
    maxPx: num("max_px", false) ?? 4096,
  };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map("map").setView([36.5, -119.5], 6);
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Esri World Imagery (current)" });
L.control.layers({ OpenStreetMap: osm, "Esri imagery (current)": esri }).addTo(map);

// Rectangle drawing -> bbox fields
const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw: { polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
          rectangle: { shapeOptions: { color: "#e6a100", weight: 2 } } },
  edit: { featureGroup: drawn, remove: true },
}));
let rect = null, drawing = false, footprint = null;
map.on("draw:drawstart", () => { drawing = true; });
map.on("draw:drawstop", () => { drawing = false; });

function setBBoxInputs(b) {
  $("west").value = fmt(b.getWest()); $("east").value = fmt(b.getEast());
  $("south").value = fmt(b.getSouth()); $("north").value = fmt(b.getNorth());
  saveForm();
}
function drawRect(bounds) {
  if (rect) drawn.removeLayer(rect);
  rect = L.rectangle(bounds, { color: "#e6a100", weight: 2 });
  drawn.addLayer(rect);
}
map.on(L.Draw.Event.CREATED, e => { drawRect(e.layer.getBounds()); setBBoxInputs(rect.getBounds()); $("mode-bbox").checked = true; saveForm(); });
map.on(L.Draw.Event.EDITED, e => e.layers.eachLayer(l => { if (l === rect) setBBoxInputs(l.getBounds()); }));
map.on(L.Draw.Event.DELETED, e => e.layers.eachLayer(l => { if (l === rect) rect = null; }));

["west", "south", "east", "north"].forEach(id => $(id).addEventListener("change", () => {
  const w = parseFloat($("west").value), s = parseFloat($("south").value),
        e = parseFloat($("east").value), n = parseFloat($("north").value);
  if ([w, s, e, n].every(Number.isFinite)) drawRect([[s, w], [n, e]]);
}));

// Segment clicks -> start/end fields
const markers = { start: null, end: null };
let nextPoint = "start";
function setPoint(which, latlng) {
  $(`${which}_lat`).value = fmt(latlng.lat); $(`${which}_lon`).value = fmt(latlng.lng);
  if (markers[which]) map.removeLayer(markers[which]);
  markers[which] = L.circleMarker(latlng, { radius: 7, color: which === "start" ? "#2a9d3f" : "#d62828", weight: 3 })
    .bindTooltip(which, { permanent: true, direction: "top" }).addTo(map);
  saveForm();
}
map.on("click", e => {
  if (drawing || !$("mode-segment").checked) return;
  setPoint(nextPoint, e.latlng);
  nextPoint = nextPoint === "start" ? "end" : "start";
});
["start", "end"].forEach(which => ["_lat", "_lon"].forEach(suffix =>
  $(which + suffix).addEventListener("change", () => {
    const lat = parseFloat($(`${which}_lat`).value), lon = parseFloat($(`${which}_lon`).value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) setPoint(which, L.latLng(lat, lon));
  })));

// Rebuild markers/rectangle from restored field values.
["start", "end"].forEach(which => $(`${which}_lat`).dispatchEvent(new Event("change")));
$("west").dispatchEvent(new Event("change"));
if (rect) map.fitBounds(rect.getBounds().pad(0.3));
else if (markers.start) map.setView(markers.start.getLatLng(), 15);

function showFootprint([w, s, e, n]) {
  if (footprint) map.removeLayer(footprint);
  footprint = L.rectangle([[s, w], [n, e]], { color: "#1a5fb4", weight: 2, fill: false, dashArray: "6 4" }).addTo(map);
  map.fitBounds(footprint.getBounds().pad(0.2));
}

// ---------------------------------------------------------------------------
// Status and errors
// ---------------------------------------------------------------------------

const status = $("status"), errorBox = $("error");
function setStatus(text) { status.textContent = text; }
function showError(err) { errorBox.textContent = err.message || String(err); errorBox.hidden = false; }
function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }
function setBusy(busy) { for (const b of form.querySelectorAll("button")) b.disabled = busy; }

// ---------------------------------------------------------------------------
// Capture-date listing
// ---------------------------------------------------------------------------

$("list-captures").addEventListener("click", async () => {
  const out = $("captures");
  clearError(); setBusy(true);
  try {
    const { bbox: raw } = resolveArea();
    const bbox = validateBbox(raw);
    const zoom = num("zoom", false) || chooseZoom(bbox, num("max_px", false) ?? 4096);
    const [lon, lat] = bboxCenter(bbox);
    out.textContent = "Scanning releases...";
    const caps = distinctCaptures(await scanCaptures(lon, lat, zoom, (d, t) => { out.textContent = `Scanning releases ${d}/${t}`; }));
    if (!caps.length) { out.textContent = "No capture-date metadata found here."; return; }
    const rows = caps.map(c =>
      `<tr><td>${c.captureDate}</td><td>${c.release.date}<br><small>id ${c.release.id}</small></td>` +
      `<td>${c.resolutionM ?? ""}</td><td>${c.provider ?? ""}</td>` +
      `<td><button type="button" data-id="${c.release.id}" data-date="${c.captureDate}">Use</button></td></tr>`).join("");
    out.innerHTML = `<div class="hint">${caps.length} distinct photos at center (zoom ${zoom})</div>` +
      `<table class="caps"><tr><th>Captured</th><th>Release</th><th>Res (m)</th><th>Provider</th><th></th></tr>${rows}</table>`;
    out.querySelectorAll("button[data-id]").forEach(b => b.addEventListener("click", () => {
      $("release_id").value = b.dataset.id; $("date").value = b.dataset.date; saveForm();
    }));
  } catch (err) {
    out.textContent = ""; showError(err);
  } finally {
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// Fetch image
// ---------------------------------------------------------------------------

let current = null; // { canvas, filename, meta } of the last result

form.addEventListener("submit", async ev => {
  ev.preventDefault();
  clearError(); setBusy(true); setStatus("Starting");
  try {
    const params = readParams();
    current = await generateImage(params, setStatus);
    renderResult(current);
    showFootprint(current.meta.bbox);
    setStatus("Done");
  } catch (err) {
    setStatus(""); showError(err);
  } finally {
    setBusy(false);
  }
});

function renderResult({ canvas, filename, meta }) {
  $("result").hidden = false;
  $("result-filename").textContent = filename;
  $("result-captured").textContent = meta.captureDate || "unknown";
  const extra = [];
  if (meta.captureResolutionM) extra.push(`${meta.captureResolutionM} m`);
  if (meta.captureProvider) extra.push(meta.captureProvider);
  $("result-capture-extra").textContent = extra.length ? `(${extra.join(", ")})` : "";
  $("result-selection").textContent = meta.selection;
  $("result-release").textContent = `${meta.releaseDate} (id ${meta.releaseId})`;
  $("result-requested").textContent = meta.requestedDate;
  $("result-zoom").textContent = meta.zoom;
  $("result-size").textContent = `${meta.width}×${meta.height}`;
  $("result-tiles").textContent = `${meta.tilesMissing} of ${meta.tilesTotal}`;
  $("result-mixed").hidden = !meta.mixedCapture;
  $("result-mixed-dates").textContent = meta.captureDatesInBbox.join(", ");

  const holder = $("result-image");
  holder.replaceChildren(canvas);
  canvas.style.maxWidth = "100%"; canvas.style.height = "auto";
}

$("download").addEventListener("click", async () => {
  if (!current) return;
  try { await downloadCanvas(current.canvas, current.filename); } catch (err) { showError(err); }
});