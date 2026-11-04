"use strict";

/*
 * Directional Shadow panel.
 * The pipeline lives in shadow.js; this file reads the controls, draws the direction preview and
 * talks to the document. Nothing is written until Preview or Apply is pressed.
 */

const SDK = globalThis.__photonSdk;
const Shadow = globalThis.PhotonShadow;
const Colour = globalThis.PhotonColour;

const el = {
  badge: document.getElementById("badge"),
  state: document.getElementById("state"),
  sep: document.getElementById("sep"),
  angle: document.getElementById("angle"),
  distance: document.getElementById("distance"),
  soft: document.getElementById("soft"),
  kind: document.getElementById("kind"),
  blend: document.getElementById("blend"),
  cardSwatchBtn: document.getElementById("cardSwatchBtn"),
  cardSwatchDot: document.getElementById("cardSwatchDot"),
  pickerTitle: document.getElementById("pickerTitle"),
  detailsBtn: document.getElementById("detailsBtn"),
  serviceBtn: document.getElementById("serviceBtn"),
  detailsOverlay: document.getElementById("detailsOverlay"),
  detailsClose: document.getElementById("detailsClose"),
  detailsLog: document.getElementById("detailsLog"),
  darkness: document.getElementById("darkness"),
  colour: document.getElementById("colour"),
  apply: document.getElementById("apply"),
  removePreview: document.getElementById("removePreview"),
  hint: document.getElementById("hint"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  previewCanvas: document.getElementById("previewCanvas"),
  swatchBtn: document.getElementById("swatchBtn"),
  swatchDot: document.getElementById("swatchDot"),
  picker: document.getElementById("picker"),
  svCanvas: document.getElementById("svCanvas"),
  hueCanvas: document.getElementById("hueCanvas"),
  hexInput: document.getElementById("hexInput"),
  colourOk: document.getElementById("colourOk"),
  colourCancel: document.getElementById("colourCancel"),
};

let api = null;
let preview = null; // { layerIds, effects, colourFormat, stylesBefore }
let busy = false;
let dragging = false;
let drawFrame = null;
let lastParams = { ...Shadow.DEFAULTS };
let hsv = { h: 0, s: 0, v: 0 };
let objectColour = "#f7f7f7";

function badge(text, kind) {
  el.badge.textContent = text;
  el.badge.className = "badge " + (kind || "ok");
  const activity = kind === "busy" ? "Working" : kind === "danger" ? "Error" : text === "Applied" ? "Done" : text === "Ready" ? "Idle" : text;
  el.state.textContent = activity;
  el.state.hidden = !activity;
  el.sep.hidden = !activity;
}

function setStatus(text) {
  el.status.textContent = text;
}

let detailsLines = [];

function addDetail(line) {
  const stamp = new Date().toLocaleTimeString();
  detailsLines.unshift("[" + stamp + "] " + line);
  if (detailsLines.length > 200) detailsLines.pop();
  if (!el.detailsOverlay.hidden) renderDetails();
}

function renderDetails() {
  el.detailsLog.textContent = detailsLines.length ? detailsLines.join("\n") : "No log yet.";
}

function openDetails() {
  renderDetails();
  el.detailsOverlay.hidden = false;
}

async function checkService() {
  addDetail("check service…");
  if (!api) {
    addDetail("SDK: unavailable — open the panel inside Photon Studio.");
    openDetails();
    return;
  }
  try {
    const doc = await api.documents.active();
    if (!doc) addDetail("document: none open");
    else {
      addDetail(
        "document: " + (doc.title || doc.id) + " · " + (doc.layers || []).length + " layer(s) · " +
          (doc.selectedLayerIds || []).length + " selected",
      );
    }
  } catch (error) {
    addDetail("check failed: " + errText(error));
  }
  openDetails();
}

function errText(error) {
  return String((error && error.message) || error || "unknown error");
}

function readParams() {
  return Shadow.normalise({
    angle: el.angle.value,
    distance: el.distance.value,
    soft: el.soft.value,
    kind: el.kind.value,
    colour: el.colour.value,
    darkness: el.darkness.value,
    blend: el.blend.value,
  });
}

function applyParamsToUi(params) {
  el.angle.value = String(params.angle);
  el.distance.value = String(params.distance);
  el.soft.value = String(params.soft);
  el.kind.value = params.kind;
  el.darkness.value = String(params.darkness);
  el.colour.value = params.colour;
  el.blend.value = params.blend;
  if (typeof window.syncCustomSelects === "function") window.syncCustomSelects();
}

function setBusy(value) {
  busy = value;
  el.apply.disabled = value;
  el.removePreview.disabled = value;
}

/* ---------- direction preview ---------- */

const CARD = { width: 112, height: 82 };
const SCALE = 0.42;

// Canvas only has a subset of Photoshop's blend modes; the rest map to the nearest compositing op.
const PREVIEW_BLEND = {
  normal: "source-over",
  dissolve: "source-over",
  darken: "darken",
  multiply: "multiply",
  "color-burn": "color-burn",
  "linear-burn": "multiply",
  "darker-color": "darken",
  lighten: "lighten",
  screen: "screen",
  "color-dodge": "color-dodge",
  "linear-dodge": "screen",
  "lighter-color": "lighten",
  overlay: "overlay",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  "vivid-light": "overlay",
  "linear-light": "overlay",
  "pin-light": "overlay",
  "hard-mix": "overlay",
  difference: "difference",
  exclusion: "exclusion",
  subtract: "difference",
  divide: "screen",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

function previewBlend(name) {
  return PREVIEW_BLEND[name] || "source-over";
}

function canvasCentre() {
  return { x: el.previewCanvas.width / 2, y: el.previewCanvas.height / 2 };
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function scheduleDraw() {
  if (drawFrame !== null) return;
  const raf =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback) => setTimeout(callback, 16);
  drawFrame = raf(() => {
    drawFrame = null;
    drawPreview();
  });
}

function drawPreview() {
  const canvas = el.previewCanvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const params = readParams();
  const plan = Shadow.planLayers(params);
  const isInner = plan.params.kind === "innerShadow";
  const centre = canvasCentre();
  const hex = params.colour.replace("#", "");
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);

  // light "paper" so a dark shadow is visible on the near-black panel
  ctx.save();
  ctx.fillStyle = "#eae7e1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  ctx.restore();

  if (!isInner) {
    for (const layer of plan.layers) {
      ctx.save();
      ctx.globalCompositeOperation = previewBlend(params.blend);
      ctx.filter = "blur(" + Math.max(0.5, layer.blur * SCALE) + "px)";
    ctx.fillStyle = "rgba(" + red + "," + green + "," + blue + "," + Math.min(1, layer.opacity).toFixed(3) + ")";
    roundRect(
      ctx,
      centre.x - CARD.width / 2 + layer.dx * SCALE,
      centre.y - CARD.height / 2 + layer.dy * SCALE,
      CARD.width,
      CARD.height,
      10,
    );
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.fillStyle = objectColour;
  roundRect(ctx, centre.x - CARD.width / 2, centre.y - CARD.height / 2, CARD.width, CARD.height, 10);
  ctx.fill();
  const cardRgb = Colour.hexToRgb(objectColour);
  const cardLuma = (cardRgb.r * 299 + cardRgb.g * 587 + cardRgb.b * 114) / 1000;
  ctx.strokeStyle = cardLuma > 140 ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  if (isInner) {
    // inner shadow: a soft edge band inside the card, offset against the light
    ctx.save();
    roundRect(ctx, centre.x - CARD.width / 2, centre.y - CARD.height / 2, CARD.width, CARD.height, 10);
    ctx.clip();
    for (const layer of plan.layers) {
      ctx.save();
      ctx.globalCompositeOperation = previewBlend(params.blend);
      ctx.filter = "blur(" + Math.max(0.5, layer.blur * SCALE) + "px)";
      ctx.lineWidth = Math.max(1.5, layer.blur * SCALE * 1.2);
      ctx.strokeStyle =
        "rgba(" + red + "," + green + "," + blue + "," + Math.min(1, layer.opacity * 0.55).toFixed(3) + ")";
      roundRect(
        ctx,
        centre.x - CARD.width / 2 + layer.dx * SCALE,
        centre.y - CARD.height / 2 + layer.dy * SCALE,
        CARD.width,
        CARD.height,
        10,
      );
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // light handle: the sun sits opposite the shadow. Distance 300 px maps to 126 canvas px
  // (SCALE 0.42); the old 74 px cap stopped the handle early, so let it travel until the sun
  // (plus rays) reaches the canvas edge instead.
  const lightRad = ((params.angle + 180) * Math.PI) / 180;
  const edgeMargin = 18;
  const reachLimit = (() => {
    const cos = Math.cos(lightRad);
    const sin = Math.sin(lightRad);
    const tx = cos > 0 ? (canvas.width - edgeMargin - centre.x) / cos : cos < 0 ? (edgeMargin - centre.x) / cos : Infinity;
    const ty = sin > 0 ? (canvas.height - edgeMargin - centre.y) / sin : sin < 0 ? (edgeMargin - centre.y) / sin : Infinity;
    return Math.max(0, Math.min(tx, ty));
  })();
  const reach = Math.min(Math.max(26, params.distance * SCALE), reachLimit);
  const hx = centre.x + Math.cos(lightRad) * reach;
  const hy = centre.y + Math.sin(lightRad) * reach;

  ctx.save();
  ctx.strokeStyle = "#2b6cf6";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(hx, hy, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 1.3;
  for (let ray = 0; ray < 8; ray += 1) {
    const rayAngle = lightRad + Math.PI / 2 + (ray * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(hx + Math.cos(rayAngle) * 11, hy + Math.sin(rayAngle) * 11);
    ctx.lineTo(hx + Math.cos(rayAngle) * 15, hy + Math.sin(rayAngle) * 15);
    ctx.stroke();
  }
  ctx.restore();

  if (dragging) {
    const label = Math.round(params.angle) + "°  ·  " + Math.round(params.distance) + " px";
    ctx.save();
    ctx.font = "600 10px Inter, system-ui, sans-serif";
    const width = ctx.measureText(label).width + 14;
    ctx.fillStyle = "rgba(43,108,246,0.92)";
    roundRect(ctx, 8, 8, width, 18, 5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 15, 18);
    ctx.restore();
  }
}

function canvasPoint(event) {
  const canvas = el.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function insideCard(point) {
  const centre = canvasCentre();
  return (
    Math.abs(point.x - centre.x) <= CARD.width / 2 &&
    Math.abs(point.y - centre.y) <= CARD.height / 2
  );
}

function handlePointer(event) {
  const point = canvasPoint(event);
  const centre = canvasCentre();
  const vector = Shadow.vectorToAngleDistance((point.x - centre.x) / SCALE, (point.y - centre.y) / SCALE, 300);
  // the handle is the light: dragging it up-right throws the shadow down-left
  el.angle.value = String(Number((((vector.angle + 180) % 360)).toFixed(1)));
  el.distance.value = String(Number(vector.distance.toFixed(1)));
  scheduleDraw();
}

/* ---------- colour picker ---------- */

let pickerTarget = "shadow";
let pickerBefore = null;

function syncSwatches() {
  el.swatchDot.style.background = el.colour.value;
  el.cardSwatchDot.style.background = objectColour;
}

function setColour(hex, options) {
  const normalised = Colour.normaliseHex(hex);
  if (!normalised) return;
  if (pickerTarget === "card") objectColour = normalised;
  else el.colour.value = normalised;
  syncSwatches();
  if (el.hexInput !== document.activeElement) el.hexInput.value = normalised;
  const rgb = Colour.hexToRgb(normalised);
  hsv = Colour.rgbToHsv(rgb);
  drawPicker();
  if (!(options && options.quiet)) scheduleDraw();
}

function drawPicker() {
  const hue = el.hueCanvas.getContext("2d");
  if (hue) {
    const gradient = hue.createLinearGradient(0, 0, 0, el.hueCanvas.height);
    for (let stop = 0; stop <= 6; stop += 1) {
      const rgb = Colour.hsvToRgb({ h: (stop / 6) * 360, s: 1, v: 1 });
      gradient.addColorStop(stop / 6, Colour.rgbToHex(rgb));
    }
    hue.fillStyle = gradient;
    hue.fillRect(0, 0, el.hueCanvas.width, el.hueCanvas.height);
    const y = (hsv.h / 360) * el.hueCanvas.height;
    hue.strokeStyle = "#ffffff";
    hue.lineWidth = 1.5;
    hue.strokeRect(0.75, Math.min(el.hueCanvas.height - 2, Math.max(0, y - 2)), el.hueCanvas.width - 1.5, 4);
  }

  const sv = el.svCanvas.getContext("2d");
  if (sv) {
    const base = Colour.hsvToRgb({ h: hsv.h, s: 1, v: 1 });
    sv.fillStyle = Colour.rgbToHex(base);
    sv.fillRect(0, 0, el.svCanvas.width, el.svCanvas.height);
    const white = sv.createLinearGradient(0, 0, el.svCanvas.width, 0);
    white.addColorStop(0, "rgba(255,255,255,1)");
    white.addColorStop(1, "rgba(255,255,255,0)");
    sv.fillStyle = white;
    sv.fillRect(0, 0, el.svCanvas.width, el.svCanvas.height);
    const black = sv.createLinearGradient(0, 0, 0, el.svCanvas.height);
    black.addColorStop(0, "rgba(0,0,0,0)");
    black.addColorStop(1, "rgba(0,0,0,1)");
    sv.fillStyle = black;
    sv.fillRect(0, 0, el.svCanvas.width, el.svCanvas.height);

    const x = hsv.s * el.svCanvas.width;
    const y = (1 - hsv.v) * el.svCanvas.height;
    sv.beginPath();
    sv.arc(x, y, 5, 0, Math.PI * 2);
    sv.lineWidth = 1.6;
    sv.strokeStyle = "rgba(0,0,0,0.55)";
    sv.stroke();
    sv.strokeStyle = "#ffffff";
    sv.lineWidth = 1;
    sv.stroke();
  }
}

function pickFromSv(event) {
  const rect = el.svCanvas.getBoundingClientRect();
  const point = Colour.pointToSaturation(
    ((event.clientX - rect.left) / rect.width) * el.svCanvas.width,
    ((event.clientY - rect.top) / rect.height) * el.svCanvas.height,
    el.svCanvas.width,
    el.svCanvas.height,
  );
  const next = { h: hsv.h, s: point.s, v: point.v };
  hsv = next;
  setColour(Colour.rgbToHex(Colour.hsvToRgb(next)), { quiet: true });
  scheduleDraw();
}

function pickFromHue(event) {
  const rect = el.hueCanvas.getBoundingClientRect();
  const y = ((event.clientY - rect.top) / rect.height) * el.hueCanvas.height;
  const next = { h: Colour.pointToHue(y, el.hueCanvas.height), s: hsv.s, v: hsv.v };
  hsv = next;
  setColour(Colour.rgbToHex(Colour.hsvToRgb(next)), { quiet: true });
  scheduleDraw();
}

function openPicker(target) {
  pickerTarget = target === "card" ? "card" : "shadow";
  pickerBefore = pickerTarget === "card" ? objectColour : el.colour.value;
  el.pickerTitle.textContent = pickerTarget === "card" ? "Box colour" : "Shadow colour";
  const current = Colour.normaliseHex(pickerTarget === "card" ? objectColour : el.colour.value) || "#000000";
  hsv = Colour.rgbToHsv(Colour.hexToRgb(current));
  if (el.hexInput !== document.activeElement) el.hexInput.value = current;
  drawPicker();
  el.picker.hidden = false;
}

function closePicker() {
  el.picker.hidden = true;
}

function wireColourPicker() {
  const toggle = (target) => {
    if (!el.picker.hidden && pickerTarget === target) closePicker();
    else openPicker(target);
  };
  el.swatchBtn.addEventListener("click", () => toggle("shadow"));
  el.cardSwatchBtn.addEventListener("click", () => toggle("card"));
  el.colourOk.addEventListener("click", closePicker);
  el.colourCancel.addEventListener("click", () => {
    setColour(pickerBefore || (pickerTarget === "card" ? "#f7f7f7" : Shadow.DEFAULTS.colour));
    closePicker();
  });
  el.hexInput.addEventListener("input", () => setColour(el.hexInput.value));

  const drag = (canvas, handler) => {
    canvas.addEventListener("pointerdown", (event) => {
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      handler(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (event.buttons) handler(event);
    });
  };
  drag(el.svCanvas, pickFromSv);
  drag(el.hueCanvas, pickFromHue);
}

/* ---------- document actions ---------- */

async function selectedLayer() {
  const doc = await api.documents.active();
  if (!doc) throw new Error("No active document. Open an image in Photon first.");
  const ids = doc.selectedLayerIds || [];
  const layerId = ids[ids.length - 1];
  if (!layerId) throw new Error("Select one layer in the Layers panel first.");
  return { doc, layerId };
}

function markPreview() {
  el.removePreview.hidden = !preview;
}

async function dropPreview() {
  if (!preview) return;
  const current = preview;
  preview = null;
  try {
    const doc = await api.documents.active();
    if (doc) await Shadow.restoreLayerStyles(api, doc.id, current.layerIds[0], current.stylesBefore);
  } catch {
    /* document closed; nothing to clean */
  }
  markPreview();
}

async function build() {
  const { doc, layerId } = await selectedLayer();
  const startedAt = performance.now();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: doc.id,
    layerId,
    params: lastParams,
  });
  const elapsed = Math.round(performance.now() - startedAt);
  // kept for debugging when a host ignores a parameter: visible in the plugin console
  console.debug("[directional-shadow]", "format=" + result.colourFormat, result.payloads[0]);
  preview = result;
  markPreview();
  const label = result.kind === "innerShadow" ? "inner" : "drop";
  el.meta.textContent = elapsed + " ms · " + result.effects + " " + label + " shadows · " + result.colourFormat;
  return result;
}

async function runApply() {
  if (busy) return;
  setBusy(true);
  badge("Working…", "busy");
  try {
    lastParams = readParams();
    await dropPreview(); // a second Apply replaces the previous result instead of stacking
    setStatus("adding " + Shadow.STEPS + " shadows…");
    await build();
    await api.settings.set({ shadow: lastParams, preview: { objectColour } }).catch(() => {});
    badge("Applied", "ok");
    setStatus("shadow applied to the selected layer");
  } catch (error) {
    badge("Failed", "danger");
    setStatus(errText(error));
    addDetail("apply failed: " + errText(error));
  } finally {
    setBusy(false);
  }
}

async function runRemovePreview() {
  if (busy) return;
  setBusy(true);
  try {
    await dropPreview();
    badge("Ready", "ok");
    setStatus("preview removed");
  } finally {
    setBusy(false);
  }
}

/* ---------- wiring ---------- */

function wire() {
  wireColourPicker();
  const canvas = el.previewCanvas;
  if (canvas) {
    canvas.addEventListener("pointerdown", (event) => {
      const point = canvasPoint(event);
      if (insideCard(point)) {
        openPicker("card");
        return;
      }
      dragging = true;
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      handlePointer(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (dragging) handlePointer(event);
    });
    const stop = () => {
      dragging = false;
      scheduleDraw();
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("pointerleave", stop);
  }

  for (const input of [el.angle, el.distance, el.soft, el.darkness, el.colour]) {
    input.addEventListener("input", () => scheduleDraw());
  }
  el.kind.addEventListener("change", () => scheduleDraw());
  el.blend.addEventListener("change", () => scheduleDraw());
  el.apply.addEventListener("click", () => void runApply());
  el.detailsBtn.addEventListener("click", openDetails);
  el.serviceBtn.addEventListener("click", () => void checkService());
  el.detailsClose.addEventListener("click", () => (el.detailsOverlay.hidden = true));
  el.detailsOverlay.addEventListener("click", (event) => {
    if (event.target === el.detailsOverlay) el.detailsOverlay.hidden = true;
  });
  el.removePreview.addEventListener("click", () => void runRemovePreview());
}

async function init() {
  let stored = {};
  try {
    stored = (await api.settings.get()) || {};
  } catch {
    stored = {};
  }
  applyParamsToUi(Shadow.normalise({ ...Shadow.DEFAULTS, ...(stored.shadow || {}) }));
  const rememberedCard = stored.preview && Colour.normaliseHex(stored.preview.objectColour);
  objectColour = rememberedCard || "#f7f7f7";
  setColour(el.colour.value, { quiet: true });
  badge("Ready", "ok");
  setStatus("drag the light, then Preview");
  addDetail("panel ready · v0.17.1");
  drawPreview();
  markPreview();
}

if (!SDK) {
  badge("Failed", "danger");
  setStatus("Photon Plugin SDK is unavailable — open this panel inside Photon Studio.");
} else if (!Shadow) {
  badge("Failed", "danger");
  setStatus("Plugin scripts failed to load.");
} else {
  wire();
  SDK.activate((sdk) => {
    api = sdk;
    void init().catch((error) => {
      badge("Failed", "danger");
      setStatus("init failed: " + errText(error));
    });
    return {
      dispose() {
        api = null;
        preview = null;
      },
    };
  });
}
