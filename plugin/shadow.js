/*
 * Directional Blur Shadow — Photon port of the Affinity Photo macro.
 *
 * Pipeline per step (farthest → nearest):
 *   layer.duplicate  →  pixels.fill (silhouette, preserve transparency)  →  filter.blur.gaussianBlur
 *   →  layer.update (opacity)  →  core.canvas.applyLayerTransform (taper)  →  layer.move (below source)
 * Then: layer.group → rename → optional layer.rasterize.
 *
 * Opacity follows the alpha-compositing (Beer–Lambert) law so the falloff does not depend on
 * the step count:  raw = 1 - (1 - target)^(1/steps),  opacity = min(1, raw * darkness).
 *
 * Everything here is pure or takes the SDK as an injected `api`, so it is testable in Node.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonShadow = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    angle: 30,
    distance: 150,
    steps: 10,
    blur: 25,
    colour: "#000000",
    startOpacity: 100,
    endOpacity: 30,
    darkness: 100,
    taper: false,
    taperEnd: 90,
    rasterize: true,
  };

  const GROUP_NAME = "Directional Blur Shadow";

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  function normalise(input) {
    const params = { ...DEFAULTS, ...(input || {}) };
    return {
      angle: clamp(params.angle, 0, 360),
      distance: clamp(params.distance, 1, 2000),
      steps: Math.round(clamp(params.steps, 3, 30)),
      blur: clamp(params.blur, 0.1, 300),
      colour: /^#[0-9a-f]{6}$/i.test(String(params.colour)) ? params.colour : DEFAULTS.colour,
      startOpacity: clamp(params.startOpacity, 1, 100),
      endOpacity: clamp(params.endOpacity, 0, 100),
      darkness: clamp(params.darkness, 10, 300),
      taper: Boolean(params.taper),
      taperEnd: clamp(params.taperEnd, 1, 500),
      rasterize: Boolean(params.rasterize),
    };
  }

  /** Per-layer plan, farthest first (index 0 = end of the shadow). Pure. */
  function planLayers(input) {
    const params = normalise(input);
    const angleRad = (params.angle * Math.PI) / 180;
    const nx = Math.cos(angleRad);
    const ny = Math.sin(angleRad);
    const start = params.startOpacity / 100;
    const end = params.endOpacity / 100;
    const darkness = params.darkness / 100;
    const layers = [];

    for (let step = params.steps; step >= 1; step -= 1) {
      const t = step / params.steps;
      const target = clamp(start + (end - start) * t, 0, 1);
      const raw = 1 - Math.pow(1 - target, 1 / params.steps);
      layers.push({
        step,
        t,
        dx: nx * params.distance * t,
        dy: ny * params.distance * t,
        blur: params.blur * t,
        target,
        opacity: Math.min(1, raw * darkness),
        perpScale: 1 + (params.taperEnd / 100 - 1) * t,
      });
    }
    return { params, layers, direction: { nx, ny, angleRad } };
  }

  /** Affine matrix [a,b,c,d,e,f] = rotate(-θ) · scale(1,k) · rotate(θ) about a pivot. Pure. */
  function taperMatrix(angleRad, perpScale, pivotX, pivotY) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    // R(-θ) * S * R(θ)
    const a = cos * cos + perpScale * sin * sin;
    const b = sin * cos - perpScale * sin * cos;
    const c = b;
    const d = sin * sin + perpScale * cos * cos;
    const e = pivotX - a * pivotX - c * pivotY;
    const f = pivotY - b * pivotX - d * pivotY;
    return [a, b, c, d, e, f];
  }

  function rgba(hex, alpha) {
    const value = String(hex || "#000000").replace("#", "");
    return {
      space: "rgb",
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
      a: alpha === undefined ? 1 : clamp(alpha, 0, 1),
    };
  }

  /** layer.duplicate / layer.group / layer.move return ids in slightly different shapes. */
  function firstId(result) {
    if (!result || typeof result !== "object") return null;
    if (typeof result.layerId === "string") return result.layerId;
    if (Array.isArray(result.layerIds) && result.layerIds.length) return result.layerIds[0];
    if (Array.isArray(result.layers) && result.layers.length) {
      const entry = result.layers[0];
      return typeof entry === "string" ? entry : entry && (entry.id || entry.layerId);
    }
    if (typeof result.groupId === "string") return result.groupId;
    return null;
  }

  function layerBounds(doc, layerId) {
    const layer = (doc.layers || []).find((item) => item.id === layerId);
    const bounds = layer && (layer.bounds || layer.visibleBounds);
    if (bounds && typeof bounds.width === "number") return bounds;
    return { x: 0, y: 0, width: doc.width || 0, height: doc.height || 0 };
  }

  async function execute(api, documentId, operation, params) {
    return api.documents.execute(operation, params, documentId);
  }

  /**
   * Build the shadow. Returns { layerIds, groupId } — nothing is committed by the caller yet.
   * `onStep(index, total)` lets the panel show progress.
   */
  async function buildShadow(api, options) {
    const documentId = options.documentId;
    const sourceLayerId = options.sourceLayerId;
    const plan = planLayers(options.params);
    const onStep = options.onStep || (() => {});
    const doc = await api.documents.active();
    const layerIds = [];

    // 1. First duplicate doubles as an orientation probe: does index 0 sit at the top or bottom?
    const probe = await execute(api, documentId, "layer.duplicate", { layerIds: [sourceLayerId] });
    const firstShadowId = firstId(probe);
    if (!firstShadowId) throw new Error("Photon did not return the duplicated layer id.");
    layerIds.push(firstShadowId);

    const afterProbe = await api.documents.active();
    const sourceIndex = (afterProbe.layers || []).findIndex((item) => item.id === sourceLayerId);
    const probeIndex = (afterProbe.layers || []).findIndex((item) => item.id === firstShadowId);
    const topFirst = probeIndex < sourceIndex; // index 0 = topmost
    const base = topFirst ? sourceIndex + 1 : sourceIndex;
    const bounds = layerBounds(afterProbe, sourceLayerId);
    const pivotX = bounds.x + bounds.width / 2;
    const pivotY = bounds.y + bounds.height / 2;

    async function finishLayer(layerId, entry, slot) {
      await execute(api, documentId, "pixels.fill", {
        layerId,
        color: rgba(plan.params.colour),
        preserveTransparency: true,
        opacity: 1,
        mode: "normal",
      });
      await execute(api, documentId, "filter.blur.gaussianBlur", {
        layerId,
        params: { radius: Math.max(0.1, entry.blur) },
      });
      await execute(api, documentId, "layer.update", {
        layerId,
        properties: { opacity: Math.max(0.001, entry.opacity) },
      });
      if (plan.params.taper && Math.abs(entry.perpScale - 1) > 0.001) {
        await execute(api, documentId, "core.canvas.applyLayerTransform", {
          layerIds: [layerId],
          matrix: taperMatrix(plan.direction.angleRad, entry.perpScale, pivotX, pivotY),
        });
      }
      await execute(api, documentId, "layer.move", {
        layerIds: [layerId],
        placement: { index: base + slot },
      });
      if (entry.dx || entry.dy) {
        await execute(api, documentId, "layer.translate", { layerIds: [layerId], dx: entry.dx, dy: entry.dy });
      }
    }

    await finishLayer(firstShadowId, plan.layers[0], 0);
    onStep(1, plan.params.steps);

    for (let index = 1; index < plan.layers.length; index += 1) {
      const entry = plan.layers[index];
      const result = await execute(api, documentId, "layer.duplicate", { layerIds: [sourceLayerId] });
      const layerId = firstId(result);
      if (!layerId) throw new Error("Photon did not return the duplicated layer id.");
      layerIds.push(layerId);
      await finishLayer(layerId, entry, index);
      onStep(index + 1, plan.params.steps);
    }

    // 2. Group, name, and optionally rasterize.
    let groupId = null;
    if (layerIds.length) {
      const grouped = await execute(api, documentId, "layer.group", { layerIds });
      groupId = firstId(grouped) || layerIds[0];
      await execute(api, documentId, "layer.update", {
        layerId: groupId,
        properties: { name: GROUP_NAME },
      });
      if (plan.params.rasterize) {
        await execute(api, documentId, "layer.rasterize", { layerIds: [groupId], target: "layer" });
      }
    }

    return { layerIds, groupId, topFirst, base, plan };
  }

  async function removeShadow(api, documentId, layerIds, groupId) {
    const ids = groupId ? [groupId] : layerIds || [];
    if (!ids.length) return;
    try {
      await api.documents.execute("layer.delete", { layerIds: ids }, documentId);
    } catch {
      /* already gone */
    }
  }


  /* ------------------------------------------------------------------ layer styles */

  /**
   * Normalise effect.describe(kind:"dropShadow") into a { name -> default } map.
   * The host may answer with an array of parameter descriptors or a plain defaults object.
   */
  function describeToMap(described) {
    const map = new Map();
    const payload = described && (described.params || described.parameters || described);
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        if (!entry) continue;
        const name = entry.name || entry.key || entry.id;
        if (!name) continue;
        map.set(String(name).toLowerCase(), { name: String(name), value: entry.default });
      }
    } else if (payload && typeof payload === "object") {
      for (const [name, value] of Object.entries(payload)) {
        map.set(String(name).toLowerCase(), { name, value });
      }
    }
    return map;
  }

  /** Pick the first available parameter whose name matches the pattern. */
  function pickParam(map, pattern) {
    for (const [key, entry] of map) {
      if (pattern.test(key)) return entry.name;
    }
    return null;
  }

  /**
   * Build one dropShadow effect payload from the host's parameter names.
   * Taper is not representable with a layer style, so it is ignored in effects mode.
   */
  const CANONICAL_EFFECT_KEYS = {
    angle: "angle",
    distance: "distance",
    size: "size",
    opacity: "opacity",
    colour: "color",
  };

  function effectParams(described, entry, params) {
    const map = describeToMap(described);
    const out = {};
    if (map.size === 0) {
      // describe() unavailable: fall back to Photon's documented effect parameter names
      return {
        angle: params.angle,
        distance: Math.hypot(entry.dx || 0, entry.dy || 0) || entry.distance || 0,
        size: Math.max(0.1, entry.blur),
        opacity: Math.max(0.001, entry.opacity),
        color: rgba(params.colour),
      };
    }
    void CANONICAL_EFFECT_KEYS;
    const set = (pattern, value) => {
      const name = pickParam(map, pattern);
      if (name) out[name] = value;
    };
    set(/^(angle|direction)$/, params.angle);
    set(/distance|offset/, entry.distance !== undefined ? entry.distance : Math.hypot(entry.dx || 0, entry.dy || 0));
    set(/^(size|blur|radius)/, Math.max(0.1, entry.blur));
    set(/opacity/, Math.max(0.001, entry.opacity));
    set(/colou?r/, rgba(params.colour));
    set(/blend/, "normal");
    set(/spread/, 0);
    set(/noise/, 0);
    set(/anti/, true);
    set(/knock/, false);
    set(/use.*global/, false);
    return out;
  }

  /**
   * Effects mode: one duplicate layer whose interior is hidden (fillOpacity 0) carrying N
   * dropShadow layer styles. Photon lets `layer.effect.set` append by passing index === count,
   * so several shadows of the same kind can coexist and stay editable in the Layer Style panel.
   */
  async function buildWithEffects(api, options) {
    const documentId = options.documentId;
    const sourceLayerId = options.sourceLayerId;
    const plan = planLayers(options.params);
    const onStep = options.onStep || (() => {});
    const doc = await api.documents.active();

    let described = null;
    try {
      described = await execute(api, documentId, "effect.describe", { kind: "dropShadow" });
    } catch {
      described = null; // fall back to the documented Photoshop-style names
    }

    const duplicated = await execute(api, documentId, "layer.duplicate", { layerIds: [sourceLayerId] });
    const layerId = firstId(duplicated);
    if (!layerId) throw new Error("Photon did not return the duplicated layer id.");

    // Hide the copy's own pixels: only its effects should be visible.
    await execute(api, documentId, "layer.update", {
      layerId,
      properties: { name: GROUP_NAME, fillOpacity: 0 },
    });

    let index = 0;
    for (const entry of plan.layers) {
      const effect = {
        distance: Math.hypot(entry.dx, entry.dy),
        blur: entry.blur,
        opacity: entry.opacity,
      };
      await execute(api, documentId, "layer.effect.set", {
        layerIds: [layerId],
        kind: "dropShadow",
        index,
        params: effectParams(described, effect, plan.params),
      });
      index += 1;
      onStep(index, plan.layers.length);
    }

    const after = await api.documents.active();
    const sourceIndex = (after.layers || []).findIndex((item) => item.id === sourceLayerId);
    const copyIndex = (after.layers || []).findIndex((item) => item.id === layerId);
    const topFirst = copyIndex < sourceIndex;
    return {
      layerIds: [layerId],
      groupId: layerId,
      mode: "effects",
      effects: index,
      topFirst,
      plan,
    };
  }

  return {
    DEFAULTS,
    GROUP_NAME,
    clamp,
    normalise,
    planLayers,
    taperMatrix,
    rgba,
    firstId,
    buildShadow,
    buildWithEffects,
    removeShadow,
    describeToMap,
    effectParams,
  };
});
