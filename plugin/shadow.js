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
    steps: 5,
    blur: 26,
    colour: "#000000",
    startOpacity: 100,
    endOpacity: 5,
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

  /**
   * Per-layer plan, farthest first (index 0 = end of the shadow). Pure.
   *
   * Ramps follow the "Beautiful Shadows" behaviour: the offset grows quadratically with the
   * distance (2,6 / 10,24 / 22,55 / 39,97 / 61,152 for 5 layers), the blur eases with t^0.7 and
   * the opacity falls off as (1 - t)^2 from startOpacity to endOpacity.
   *
   * opacityMode "direct"     → per-layer opacity is the ramp value (drop-shadow layer styles:
   *                            each style renders independently, like the Figma plugin).
   * opacityMode "composite"  → per-layer opacity is normalised for stacked copies
   *                            (1 - (1 - target)^(1/steps)), see the Affinity port notes.
   */
  function planLayers(input, opacityMode) {
    const params = normalise(input);
    const direct = opacityMode === "direct";
    const angleRad = (params.angle * Math.PI) / 180;
    const nx = Math.cos(angleRad);
    const ny = Math.sin(angleRad);
    const start = params.startOpacity / 100;
    const end = params.endOpacity / 100;
    const darkness = params.darkness / 100;
    const layers = [];

    for (let step = params.steps; step >= 1; step -= 1) {
      const t = step / params.steps;
      const easedDistance = t * t;
      const easedBlur = Math.pow(t, 0.7);
      const target = clamp(end + (start - end) * Math.pow(1 - t, 2), 0, 1);
      const raw = direct ? target : 1 - Math.pow(1 - target, 1 / params.steps);
      layers.push({
        step,
        t,
        dx: nx * params.distance * easedDistance,
        dy: ny * params.distance * easedDistance,
        blur: Math.max(0.1, params.blur * easedBlur),
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
        map.set(String(name).toLowerCase(), {
          name: String(name),
          value: entry.default,
          type: entry.type,
          unit: entry.unit,
          min: entry.min,
          max: entry.max,
        });
      }
    } else if (payload && typeof payload === "object") {
      for (const [name, value] of Object.entries(payload)) {
        const meta = value && typeof value === "object" && "default" in value ? value : { default: value };
        map.set(String(name).toLowerCase(), {
          name,
          value: meta.default,
          type: meta.type,
          unit: meta.unit,
          min: meta.min,
          max: meta.max,
        });
      }
    }
    return map;
  }

  /** Pick the first available parameter matching one of the patterns, in priority order. */
  function pickParam(map, patterns) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of list) {
      for (const [key, entry] of map) {
        if (pattern.test(key)) return entry.name;
      }
    }
    return null;
  }

  /** Convert a drag vector into { angle, distance } for the direction handle. */
  function vectorToAngleDistance(dx, dy, maxDistance) {
    const distance = Math.hypot(dx, dy);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const limit = Number(maxDistance) || 2000;
    return {
      angle: Math.round(angle * 10) / 10,
      distance: Math.max(1, Math.min(limit, Math.round(distance * 10) / 10)),
    };
  }

  /**
   * Build one dropShadow effect payload from the host's parameter names.
   * Taper is not representable with a layer style, so it is ignored in effects mode.
   */
  function effectDefaults(described) {
    const map = describeToMap(described);
    const defaults = {};
    for (const meta of map.values()) defaults[meta.name] = meta.value;
    return { map, defaults };
  }

  /**
   * Build a dropShadow payload that the host will accept.
   *
   * The registry validates this payload strictly ("Invalid dropShadow parameters; inspect
   * effect.describe"), so this function:
   *   - only sends keys that `effect.describe` actually lists;
   *   - infers units from the host's own defaults: an opacity default of 75 means percent,
   *     0.75 means a fraction; a string colour default means hex, an object means rgb;
   *   - refuses to guess when the description is missing, instead of sending invalid params.
   */
  function effectParams(described, entry, params) {
    const { map } = effectDefaults(described);
    const distance = entry.distance !== undefined ? entry.distance : Math.hypot(entry.dx || 0, entry.dy || 0);
    const blur = Math.max(0.1, entry.blur);
    const wantOpacity = Math.max(0, Math.min(1, entry.opacity));

    if (map.size === 0) {
      const error = new Error(
        "dropShadow parameters are unknown: effect.describe returned nothing. Open Diagnostics → Inspect effect parameters and check the log.",
      );
      error.code = "EFFECT_DESCRIBE_MISSING";
      throw error;
    }

    const out = {};
    const assigned = new Set();
    const find = (patterns) => pickParam(map, patterns);

    const angleName = find([/^(angle|direction)$/]);
    if (angleName) {
      out[angleName] = params.angle;
      assigned.add(angleName);
    }

    const distanceName = find([/distance|offset/]);
    if (distanceName) {
      out[distanceName] = distance;
      assigned.add(distanceName);
    }

    const sizeName = find([/blur/, /radius/, /softness/, /^size$/]);
    if (sizeName) {
      out[sizeName] = blur;
      assigned.add(sizeName);
    }

    const opacityName = find([/opacity/]);
    if (opacityName) {
      const meta = map.get(opacityName.toLowerCase());
      const defaultValue = meta && typeof meta.value === "number" ? meta.value : 1;
      out[opacityName] = defaultValue > 1 ? wantOpacity * 100 : wantOpacity;
      assigned.add(opacityName);
    }

    const colourName = find([/colou?r/]);
    if (colourName) {
      const meta = map.get(colourName.toLowerCase());
      const defaultValue = meta && meta.value;
      out[colourName] =
        typeof defaultValue === "string"
          ? String(params.colour).toUpperCase()
          : rgba(params.colour);
      assigned.add(colourName);
    }

    const blendName = find([/blend/]);
    if (blendName) {
      const meta = map.get(blendName.toLowerCase());
      out[blendName] = typeof meta.value === "string" ? meta.value : "normal";
      assigned.add(blendName);
    }

    const spreadName = find([/spread/]);
    if (spreadName) {
      out[spreadName] = 0;
      assigned.add(spreadName);
    }

    const globalName = find([/use.*global/]);
    if (globalName) {
      out[globalName] = false;
      assigned.add(globalName);
    }

    if (!assigned.size) {
      const error = new Error(
        "None of the dropShadow parameters could be mapped. Diagnostics → Inspect effect parameters lists the real names.",
      );
      error.code = "EFFECT_MAPPING_EMPTY";
      throw error;
    }
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
    const plan = planLayers(options.params, "direct");
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

    const payloads = plan.layers.map((entry) =>
      effectParams(described, { distance: Math.hypot(entry.dx, entry.dy), blur: entry.blur, opacity: entry.opacity }, plan.params),
    );

    // Append one drop shadow per step. If the host rejects a payload, surface the exact payload so
    // Diagnostics can show what it did not like instead of repeating the error N times.
    for (let index = 0; index < payloads.length; index += 1) {
      try {
        await execute(api, documentId, "layer.effect.set", {
          layerIds: [layerId],
          kind: "dropShadow",
          index,
          params: payloads[index],
        });
      } catch (error) {
        const wrapped = new Error(String((error && error.message) || error));
        wrapped.code = "EFFECT_REJECTED";
        wrapped.payload = { index, params: payloads[index] };
        throw wrapped;
      }
      onStep(index + 1, payloads.length);
    }

    const after = await api.documents.active();
    const sourceIndex = (after.layers || []).findIndex((item) => item.id === sourceLayerId);
    const copyIndex = (after.layers || []).findIndex((item) => item.id === layerId);
    const topFirst = copyIndex < sourceIndex;
    return {
      layerIds: [layerId],
      groupId: layerId,
      mode: "effects",
      effects: payloads.length,
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
    vectorToAngleDistance,
  };
});
