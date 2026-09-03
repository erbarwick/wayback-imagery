/*
 * UI wiring for index.html. Replaces app.py and the Jinja logic of the Flask
 * template. All work happens in the browser via wayback.js.
 */

import {
  bboxCenter, bboxFromSegment, chooseCorridorZoom, chooseZoom, corridorGeometry, distinctCaptures,
  downloadCanvas, generateImage, lonlatToPixel, metresPerWorldUnit, pixelToLonlat, rotatedBoxGeometry,
  scanCaptures, validateBbox,
} from "./wayback.js";

const $ = id => document.getElementById(id);
const fmt = v => v.toFixed(6);
const form = $("form");

// ---------------------------------------------------------------------------
// Form persistence (values survive a reload; there is no server round trip)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "wayback-imagery-form";
const FIELDS = ["label", "date", "select_by", "mode", "release_id", "area_mode", "start_lat", "start_lon",
  "end_lat", "end_lon", "margin_m", "markers", "west", "south", "east", "north", "bbox_angle", "zoom", "max_px",
  "aligned", "half_width_m", "pad_m", ];

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

// Returns { bbox, rotation, points, corridor, geom }.
//  - bbox mode: bbox is the user's box BEFORE rotation; geom is set when rotation != 0.
//  - segment mode: bbox is the fetched box; corridor/geom are set in aligned mode.
function resolveArea() {
  if (form.elements.area_mode.value === "bbox") {
    const bbox = [num("west"), num("south"), num("east"), num("north")];
    const rotation = num("bbox_angle", false) ?? 0;
    const geom = Math.abs(rotation) < 0.05 ? null : rotatedBoxGeometry(bbox, rotation);
    return { bbox, rotation, points: null, corridor: null, geom };
  }
  const start = [num("start_lat"), num("start_lon")];
  const end = [num("end_lat"), num("end_lon")];
  const points = form.elements.markers.checked ? [start, end] : null;
  if (form.elements.aligned.checked) {
    const corridor = { start, end, halfWidthM: num("half_width_m", false) ?? 20, padM: num("pad_m", false) ?? 30 };
    const geom = corridorGeometry(start, end, corridor.halfWidthM, corridor.padM);
    return { bbox: geom.envelope, rotation: 0, points, corridor, geom };
  }
  const margin = num("margin_m", false) ?? 150;
  return { bbox: bboxFromSegment(start, end, margin), rotation: 0, points, corridor: null, geom: null };
}

function readParams() {
  const date = form.elements.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date is required (YYYY-MM-DD).");
  const { bbox, rotation, points, corridor } = resolveArea();
  const rid = num("release_id", false), zoom = num("zoom", false);
  return {
    bbox, rotation, points, corridor, date,
    label: form.elements.label.value.trim() || "imagery",
    selectBy: form.elements.select_by.value,
    mode: form.elements.mode.value,
    releaseId: rid ? Math.trunc(rid) : null,
    zoom: zoom ? Math.trunc(zoom) : null,
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

// ---------------------------------------------------------------------------
// Rotatable bounding box (bbox mode)
// ---------------------------------------------------------------------------
// rbox = { centre: [lat, lon], lengthM (along `bearing`), widthM (across it), bearing (deg, 0 = north) }.
// The W/S/E/N inputs hold the box as it would be at bearing 90 (unrotated, length east-west);
// bbox_angle is the clockwise rotation from there. Everything is computed in zoom-0 pixel units
// so the preview matches corridorGeometry()/extractCorridor() exactly.

map.addControl(new L.Control.Draw({
  draw: { polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
    rectangle: { shapeOptions: { color: "#e6a100", weight: 2 } } },
  edit: false,
}));
let drawing = false, footprint = null;
map.on("draw:drawstart", () => { drawing = true; });
map.on("draw:drawstop", () => { drawing = false; });

let rbox = null;
const rboxUI = { layer: null, poly: null, rotate: null, corners: [] };
const handleIcon = (cls, html = "") =>
    L.divIcon({ className: cls, html, iconSize: cls === "rbox-rotate" ? [22, 22] : [10, 10] });

// W/S/E/N + angle -> box
function boxFromInputs() {
  const w = parseFloat($("west").value), s = parseFloat($("south").value),
      e = parseFloat($("east").value), n = parseFloat($("north").value);
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) return null;
  const [x0, y0] = lonlatToPixel(w, n, 0), [x1, y1] = lonlatToPixel(e, s, 0);
  const [lon, lat] = pixelToLonlat((x0 + x1) / 2, (y0 + y1) / 2, 0);
  const mpu = metresPerWorldUnit(lat);
  const angle = parseFloat($("bbox_angle").value) || 0;
  return { centre: [lat, lon], lengthM: (x1 - x0) * mpu, widthM: (y1 - y0) * mpu, bearing: ((90 + angle) % 360 + 360) % 360 };
}

// box -> W/S/E/N + angle
function boxToInputs(box) {
  const [lat, lon] = box.centre, [cx, cy] = lonlatToPixel(lon, lat, 0), mpu = metresPerWorldUnit(lat);
  const hx = box.lengthM / 2 / mpu, hy = box.widthM / 2 / mpu;
  const [w, n] = pixelToLonlat(cx - hx, cy - hy, 0), [e, s] = pixelToLonlat(cx + hx, cy + hy, 0);
  $("west").value = fmt(w); $("east").value = fmt(e); $("south").value = fmt(s); $("north").value = fmt(n);
  $("bbox_angle").value = (((box.bearing - 90) % 360 + 540) % 360 - 180).toFixed(1); // -180..180
  saveForm();
}

// box -> corridor params { start, end, halfWidthM, padM } for generateImage()
function boxCorridor(box) {
  const [lat, lon] = box.centre, [cx, cy] = lonlatToPixel(lon, lat, 0), mpu = metresPerWorldUnit(lat);
  const t = box.bearing * Math.PI / 180;
  const dx = Math.sin(t) * box.lengthM / 2 / mpu, dy = -Math.cos(t) * box.lengthM / 2 / mpu;
  const [lon1, lat1] = pixelToLonlat(cx - dx, cy - dy, 0), [lon2, lat2] = pixelToLonlat(cx + dx, cy + dy, 0);
  return { start: [lat1, lon1], end: [lat2, lon2], halfWidthM: box.widthM / 2, padM: 0 };
}

// Corner LatLngs (via corridorGeometry) plus the rotate-handle position 30 px past the "end" side.
function boxLayout(box) {
  const c = boxCorridor(box);
  const geom = corridorGeometry(c.start, c.end, c.halfWidthM, 0);
  const u = [Math.cos(geom.theta), Math.sin(geom.theta)], off = 30 / 2 ** map.getZoom();
  const [rlon, rlat] = pixelToLonlat(geom.centre[0] + u[0] * (geom.a + off), geom.centre[1] + u[1] * (geom.a + off), 0);
  return { corners: geom.corners.map(([lon, lat]) => [lat, lon]), rotate: [rlat, rlon] };
}

// Reposition polygon and handles. `skip` = the marker currently being dragged by Leaflet.
function updateBoxLayers(skip = null) {
  const { corners, rotate } = boxLayout(rbox);
  rboxUI.poly.setLatLngs(corners);
  corners.forEach((ll, i) => { if (rboxUI.corners[i] !== skip) rboxUI.corners[i].setLatLng(ll); });
  if (rboxUI.rotate !== skip) rboxUI.rotate.setLatLng(rotate);
}

function drawBox(box) {
  if (rboxUI.layer) { map.removeLayer(rboxUI.layer); rboxUI.layer = null; }
  rbox = box;
  if (!box) return;
  const { corners, rotate } = boxLayout(box);
  const layer = rboxUI.layer = L.layerGroup().addTo(map);
  rboxUI.poly = L.polygon(corners, { color: "#e6a100", weight: 2, fillOpacity: 0.08, className: "rbox-body" }).addTo(layer);

  // Rotate: drag the handle around the centre (Shift snaps to 5°).
  rboxUI.rotate = L.marker(rotate, { draggable: true, icon: handleIcon("rbox-rotate", "↻"), title: "Drag to rotate" }).addTo(layer);
  rboxUI.rotate.on("drag", e => {
    const [lat, lon] = rbox.centre, [cx, cy] = lonlatToPixel(lon, lat, 0);
    const ll = e.target.getLatLng(), [px, py] = lonlatToPixel(ll.lng, ll.lat, 0);
    let b = (Math.atan2(px - cx, -(py - cy)) * 180 / Math.PI + 360) % 360;   // same convention as corridorGeometry.bearing
    if (e.originalEvent?.shiftKey) b = Math.round(b / 5) * 5;
    rbox.bearing = b;
    updateBoxLayers(e.target);
  }).on("dragend", () => { updateBoxLayers(); boxToInputs(rbox); });

  // Resize: drag a corner; centre and rotation are kept.
  rboxUI.corners = corners.map(ll =>
      L.marker(ll, { draggable: true, icon: handleIcon("rbox-corner"), title: "Drag to resize" }).addTo(layer));
  rboxUI.corners.forEach(m => m.on("drag", e => {
    const [lat, lon] = rbox.centre, [cx, cy] = lonlatToPixel(lon, lat, 0), mpu = metresPerWorldUnit(lat);
    const ll = e.target.getLatLng(), [px, py] = lonlatToPixel(ll.lng, ll.lat, 0);
    const t = rbox.bearing * Math.PI / 180, ux = Math.sin(t), uy = -Math.cos(t);   // along-axis unit vector (y down)
    const rx = px - cx, ry = py - cy;
    rbox.lengthM = Math.max(1, 2 * Math.abs(rx * ux + ry * uy) * mpu);
    rbox.widthM = Math.max(1, 2 * Math.abs(-rx * uy + ry * ux) * mpu);
    updateBoxLayers(e.target);
  }).on("dragend", () => { updateBoxLayers(); boxToInputs(rbox); }));

  // Move: drag the polygon body (only meaningful in bbox mode).
  rboxUI.poly.on("mousedown", e => {
    if (!$("mode-bbox").checked) return;
    map.dragging.disable();
    moveFrom = lonlatToPixel(e.latlng.lng, e.latlng.lat, 0);
    centreFrom = lonlatToPixel(rbox.centre[1], rbox.centre[0], 0);
    L.DomEvent.stop(e);
  });
}

let moveFrom = null, centreFrom = null;
map.on("mousemove", e => {
  if (!moveFrom) return;
  const p = lonlatToPixel(e.latlng.lng, e.latlng.lat, 0);
  const [lon, lat] = pixelToLonlat(centreFrom[0] + p[0] - moveFrom[0], centreFrom[1] + p[1] - moveFrom[1], 0);
  rbox.centre = [lat, lon];
  updateBoxLayers();
});
map.on("mouseup", () => { if (moveFrom) { moveFrom = null; map.dragging.enable(); boxToInputs(rbox); } });
map.on("zoomend", () => { if (rbox) updateBoxLayers(); });   // keep the ↻ handle 30 px off the edge

// New rectangle from the draw tool -> unrotated box.
map.on(L.Draw.Event.CREATED, e => {
  const b = e.layer.getBounds();
  $("west").value = fmt(b.getWest()); $("east").value = fmt(b.getEast());
  $("south").value = fmt(b.getSouth()); $("north").value = fmt(b.getNorth());
  $("bbox_angle").value = 0;
  $("mode-bbox").checked = true;
  drawBox(boxFromInputs()); saveForm();
});

// Typing in the fields (or restoring them) rebuilds the box.
["west", "south", "east", "north", "bbox_angle"].forEach(id =>
    $(id).addEventListener("change", () => drawBox(boxFromInputs())));

$("clear-box").addEventListener("click", () => {
  drawBox(null);
  ["west", "south", "east", "north"].forEach(id => { $(id).value = ""; });
  $("bbox_angle").value = 0;
  saveForm();
});

// Segment clicks -> start/end fields
const markers = { start: null, end: null };
let nextPoint = "start";
function setPoint(which, latlng) {
  $(`${which}_lat`).value = fmt(latlng.lat); $(`${which}_lon`).value = fmt(latlng.lng);
  if (markers[which]) map.removeLayer(markers[which]);
  markers[which] = L.circleMarker(latlng, { radius: 7, color: which === "start" ? "#2a9d3f" : "#d62828", weight: 3 })
      .bindTooltip(which, { permanent: true, direction: "top" }).addTo(map);
  saveForm();
  updateCorridorPreview();
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

// Rebuild markers/box from restored field values.
["start", "end"].forEach(which => $(`${which}_lat`).dispatchEvent(new Event("change")));
drawBox(boxFromInputs());
if (rbox) map.fitBounds(rboxUI.poly.getBounds().pad(0.3));

else if (markers.start) map.setView(markers.start.getLatLng(), 15);

function showFootprint(bbox, corners) {
  if (footprint) map.removeLayer(footprint);
  const style = { color: "#1a5fb4", weight: 2, fill: false, dashArray: "6 4" };
  footprint = corners
      ? L.polygon(corners.map(([lon, lat]) => [lat, lon]), style).addTo(map)
      : L.rectangle([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], style).addTo(map);
  map.fitBounds(footprint.getBounds().pad(0.2));
}

// Live preview of the corridor outline while the user adjusts points or widths.
let corridorPreview = null;
function updateCorridorPreview() {
  if (corridorPreview) { map.removeLayer(corridorPreview); corridorPreview = null; }
  if (!$("aligned").checked || !$("mode-segment").checked) return;
  try {
    const { geom } = resolveArea();
    corridorPreview = L.polygon(geom.corners.map(([lon, lat]) => [lat, lon]),
        { color: "#e6a100", weight: 2, fillOpacity: 0.08 }).addTo(map);
  } catch { /* incomplete fields */ }
}
["aligned", "half_width_m", "pad_m", "start_lat", "start_lon", "end_lat", "end_lon", "mode-segment", "mode-bbox"]
    .forEach(id => $(id).addEventListener("change", updateCorridorPreview));
updateCorridorPreview();

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
    const { bbox: raw, geom } = resolveArea();
    const bbox = validateBbox(geom ? geom.envelope : raw);
    const maxPx = num("max_px", false) ?? 4096;
    const zoom = num("zoom", false) || (geom ? chooseCorridorZoom(geom, maxPx) : chooseZoom(bbox, maxPx));
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
    showFootprint(current.meta.bbox, current.corners);
    setStatus("Done");
  } catch (err) {
    setStatus(""); showError(err);
  } finally {
    setBusy(false);
  }
});

function renderResult({ canvas, filename, meta, rotation = null }) {
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
  const rotated = rotation !== null;
  $("result-aligned").hidden = !meta.aligned;
  $("result-rotated").hidden = !meta.rotated;
  if (meta.aligned) $("result-bearing").textContent = Math.round(meta.bearing);
  if (meta.rotated) {
    $("result-rotation").textContent = meta.rotation.toFixed(1);
    $("result-rotation-bearing").textContent = Math.round(meta.bearing);
  }

  const holder = $("result-image");
  holder.replaceChildren(canvas);
  canvas.style.maxWidth = "100%"; canvas.style.height = "auto";
}

$("download").addEventListener("click", async () => {
  if (!current) return;
  try { await downloadCanvas(current.canvas, current.filename); } catch (err) { showError(err); }
});