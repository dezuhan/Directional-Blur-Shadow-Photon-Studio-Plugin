"use strict";

/*
 * Directional Shadow panel.
 * The pipeline lives in shadow.js; this file reads the controls, draws the direction preview and
 * talks to the document. Nothing is written until Preview or Apply is pressed.
 */

const SDK = globalThis.__photonSdk;
const Shadow = globalThis.PhotonShadow;

const el = {
  badge: document.getElementById("badge"),
  angle: document.getElementById("angle"),
  distance: document.getElementById("distance"),
  blur: document.getElementById("blur"),
  darkness: document.getElementById("darkness"),
  colour: document.getElementById("colour"),
  preview: document.getElementById("preview"),
  apply: document.getElementById("apply"),
  removePreview: document.getElementById("removePreview"),
  hint: document.getElementById("hint"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  previewCanvas: document.getElementById("previewCanvas"),
};

let api = null;
let preview = null; // { layerIds, effects, colourFormat, stylesBefore }
let busy = false;
let dragging = false;
let drawFrame = null;
let lastParams = { ...Shadow.DEFAULTS };

function badge(text, kind) {
  el.badge.textContent = text;
  el.badge.className = "badge " + (kind || "ok");
}

function setStatus(text) {
  el.status.textContent = text;
}

function errText(error) {
  return String((error && error.message) || error || "unknown error");
}

function readParams() {
  return Shadow.normalise({
    angle: el.angle.value,
    distance: el.distance.value,
    blur: el.blur.value,
    colour: el.colour.value,
    darkness: el.darkness.value,
  });
}

function applyParamsToUi(params) {
  el.angle.value = String(params.angle);
  el.distance.value = String(params.distance);
  el.blur.value = String(params.blur);
  el.darkness.value = String(params.darkness);
  el.colour.value = params.colour;
}

function setBusy(value) {
  busy = value;
  el.preview.disabled = value;
  el.apply.disabled = value;
  el.removePreview.disabled = value;
}

/* ---------- direction preview ---------- */

const CARD = { width: 112, height: 82 };
const SCALE = 0.42;

function canvasCentre() {
  return { x: el.previewCanvas.width / 2, y: el.previewCanvas.height / 2 - 30 };
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

  for (const layer of plan.layers) {
    ctx.save();
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

  ctx.save();
  ctx.fillStyle = "#f7f7f7";
  roundRect(ctx, centre.x - CARD.width / 2, centre.y - CARD.height / 2, CARD.width, CARD.height, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // light handle: the sun sits opposite the shadow
  const reach = Math.min(74, Math.max(26, params.distance * SCALE));
  const lightRad = ((params.angle + 180) * Math.PI) / 180;
  const hx = centre.x + Math.cos(lightRad) * reach;
  const hy = centre.y + Math.sin(lightRad) * reach;

  ctx.save();
  ctx.strokeStyle = "rgba(43,108,246,0.35)";
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centre.x, centre.y);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.setLineDash([]);

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

function handlePointer(event) {
  const canvas = el.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const centre = canvasCentre();
  const vector = Shadow.vectorToAngleDistance((x - centre.x) / SCALE, (y - centre.y) / SCALE, 2000);
  // the handle is the light: dragging it up-right throws the shadow down-left
  el.angle.value = String(Math.round(((vector.angle + 180) % 360) * 10) / 10);
  el.distance.value = String(vector.distance);
  scheduleDraw();
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
  el.meta.textContent = elapsed + " ms · " + result.effects + " shadows · " + result.colourFormat;
  return result;
}

async function runPreview() {
  if (busy) return;
  setBusy(true);
  badge("Working…", "busy");
  try {
    lastParams = readParams();
    await dropPreview();
    setStatus("adding " + Shadow.STEPS + " drop shadows…");
    await build();
    badge("Preview", "busy");
    setStatus("preview on the selected layer — Apply keeps it, Remove preview undoes it");
  } catch (error) {
    badge("Failed", "danger");
    setStatus(errText(error));
  } finally {
    setBusy(false);
  }
}

async function runApply() {
  if (busy) return;
  setBusy(true);
  badge("Working…", "busy");
  try {
    lastParams = readParams();
    if (preview) {
      preview = null; // keep what is already on the layer, stop offering undo
      markPreview();
    } else {
      setStatus("adding " + Shadow.STEPS + " drop shadows…");
      await build();
      preview = null;
      markPreview();
    }
    await api.settings.set({ shadow: lastParams }).catch(() => {});
    badge("Applied", "ok");
    setStatus("shadow applied to the selected layer");
  } catch (error) {
    badge("Failed", "danger");
    setStatus(errText(error));
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
  const canvas = el.previewCanvas;
  if (canvas) {
    canvas.addEventListener("pointerdown", (event) => {
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

  for (const input of [el.angle, el.distance, el.blur, el.darkness, el.colour]) {
    input.addEventListener("input", () => scheduleDraw());
  }
  el.preview.addEventListener("click", () => void runPreview());
  el.apply.addEventListener("click", () => void runApply());
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
  badge("Ready", "ok");
  setStatus("drag the light, then Preview");
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
