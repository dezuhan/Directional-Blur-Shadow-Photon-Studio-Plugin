"use strict";

/*
 * Directional Shadow panel — UI layer.
 * The pipeline lives in shadow.js (pure math + injected Photon SDK), so this file only reads
 * the controls, keeps the preview state and talks to the document.
 */

const SDK = globalThis.__photonSdk;
const Shadow = globalThis.PhotonShadow;

const el = {
  badge: document.getElementById("badge"),
  mode: document.getElementById("mode"),
  modeHint: document.getElementById("modeHint"),
  angle: document.getElementById("angle"),
  distance: document.getElementById("distance"),
  steps: document.getElementById("steps"),
  blur: document.getElementById("blur"),
  colour: document.getElementById("colour"),
  darkness: document.getElementById("darkness"),
  startOpacity: document.getElementById("startOpacity"),
  endOpacity: document.getElementById("endOpacity"),
  taper: document.getElementById("taper"),
  taperEnd: document.getElementById("taperEnd"),
  rasterize: document.getElementById("rasterize"),
  preview: document.getElementById("preview"),
  apply: document.getElementById("apply"),
  removePreview: document.getElementById("removePreview"),
  hint: document.getElementById("hint"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
};

let api = null;
let preview = null; // { layerIds, groupId, mode, effects } of the current preview
let busy = false;
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

function readMode() {
  return el.mode.value === "copies" ? "copies" : "effects";
}

function readParams() {
  return Shadow.normalise({
    angle: el.angle.value,
    distance: el.distance.value,
    steps: el.steps.value,
    blur: el.blur.value,
    colour: el.colour.value,
    startOpacity: el.startOpacity.value,
    endOpacity: el.endOpacity.value,
    darkness: el.darkness.value,
    taper: el.taper.checked,
    taperEnd: el.taperEnd.value,
    rasterize: el.rasterize.checked,
  });
}

function applyParamsToUi(params) {
  el.angle.value = String(params.angle);
  el.distance.value = String(params.distance);
  el.steps.value = String(params.steps);
  el.blur.value = String(params.blur);
  el.colour.value = params.colour;
  el.darkness.value = String(params.darkness);
  el.startOpacity.value = String(params.startOpacity);
  el.endOpacity.value = String(params.endOpacity);
  el.taper.checked = Boolean(params.taper);
  el.taperEnd.value = String(params.taperEnd);
  el.taperEnd.disabled = !params.taper;
  el.rasterize.checked = Boolean(params.rasterize);
}

function setBusy(value) {
  busy = value;
  for (const button of [el.preview, el.apply]) button.disabled = value;
  el.removePreview.disabled = value;
}

async function buildFor(doc, layerId, params, mode) {
  if (mode === "effects") {
    return Shadow.buildWithEffects(api, {
      documentId: doc.id,
      sourceLayerId: layerId,
      params,
      onStep: (done, total) => setStatus("shadow " + done + " / " + total),
    });
  }
  return Shadow.buildShadow(api, {
    documentId: doc.id,
    sourceLayerId: layerId,
    params: { ...params, rasterize: false },
    onStep: (done, total) => setStatus("layer " + done + " / " + total),
  });
}

async function selectedLayer() {
  const doc = await api.documents.active();
  if (!doc) throw new Error("No active document. Open an image in Photon first.");
  const ids = doc.selectedLayerIds || [];
  const layerId = ids[ids.length - 1];
  if (!layerId) throw new Error("Select one layer in the Layers panel first.");
  return { doc, layerId };
}

async function markPreview() {
  el.removePreview.hidden = !preview;
  el.meta.textContent = preview ? (preview.layerIds || []).length + " layer(s) in preview" : "";
}

async function dropPreview() {
  if (!preview) return;
  const id = preview.groupId;
  const ids = preview.layerIds || [];
  try {
    const doc = await api.documents.active();
    if (doc) await Shadow.removeShadow(api, doc.id, ids, id);
  } catch {
    /* document closed; nothing to clean */
  }
  preview = null;
  await markPreview();
}

async function runPreview() {
  if (busy) return;
  setBusy(true);
  badge("Working…", "busy");
  try {
    lastParams = readParams();
    await dropPreview();
    const { doc, layerId } = await selectedLayer();
    const mode = readMode();
    setStatus(mode === "effects" ? "adding " + lastParams.steps + " drop shadows…" : "building " + lastParams.steps + " layers…");
    preview = await buildFor(doc, layerId, lastParams, mode);
    preview.mode = mode;
    badge("Preview", "busy");
    setStatus(
      mode === "effects"
        ? "preview ready — " + preview.effects + " drop shadows on one layer"
        : "preview ready — Apply to keep it",
    );
    await markPreview();
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
    const { doc, layerId } = await selectedLayer();

    const mode = readMode();
    if (!preview) {
      setStatus(mode === "effects" ? "adding " + lastParams.steps + " drop shadows…" : "building " + lastParams.steps + " layers…");
      preview = await buildFor(doc, layerId, lastParams, mode);
      preview.mode = mode;
    }

    if (mode === "copies" && lastParams.rasterize && preview.groupId) {
      setStatus("rasterizing…");
      await api.documents.execute(
        "layer.rasterize",
        { layerIds: [preview.groupId], target: "layer" },
        doc.id,
      );
    }
    await api.settings.set({ shadow: lastParams }).catch(() => {});
    badge("Applied", "ok");
    setStatus("shadow placed behind the selected layer");
    const kept = preview;
    preview = null; // applied, nothing left to "remove"
    await markPreview();
    if (!kept.groupId) setStatus("applied");
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

function wire() {
  el.taper.addEventListener("change", () => {
    el.taperEnd.disabled = !el.taper.checked || readMode() === "effects";
  });
  el.mode.addEventListener("change", () => {
    const effects = readMode() === "effects";
    el.rasterize.disabled = effects;
    el.taper.disabled = false;
    el.taperEnd.disabled = effects || !el.taper.checked;
    el.modeHint.textContent = effects
      ? "One layer with N drop shadows: editable in the Layer Style panel, no taper."
      : "N duplicated layers: supports taper, rasterize optional.";
    setStatus(effects ? "effects mode" : "copies mode");
  });
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
  setStatus("select a layer, then Preview");
  await markPreview();
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
