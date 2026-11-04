/*
 * Directional Blur Shadow — Photon port of the Affinity Photo macro.
 *
 * Two build modes:
 *   effects  — append N dropShadow layer styles to the SELECTED layer (no duplicate), via one
 *              `layer.effects.set` call on a merged styles snapshot. Preview can be reverted by
 *              writing the snapshot back.
 *   copies   — duplicate the layer N times (fill → blur → opacity → move), group them, optionally
 *              rasterize. Supports taper.
 *
 * Ramps follow the "Beautiful Shadows" plugin: offset t², blur t^0.7, opacity (1 − t)² normalised so
 * the nearest layer lands on startOpacity. Lighting deepens with 1 − (1 − raw)^darkness, which stays
 * monotonic and never clips.
 *
 * Photon's drop-shadow angle is the LIGHT direction, so the effect receives angle + 180 while the
 * plan's dx/dy describe where the shadow itself falls.
 *
 * Pure maths and an injected `api` keep everything testable in Node.
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
    startOpacity: 44,
    endOpacity: 1,
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
   * opacityMode "direct"    → ramp value as-is (independent layer styles, like the Figma plugin).
   * opacityMode "composite" → normalised for stacked copies (1 − (1 − target)^(1/steps)).
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
      const rampT = params.steps === 1 ? 0 : (t - 1 / params.steps) / (1 - 1 / params.steps);
      const target = clamp(end + (start - end) * Math.pow(1 - rampT, 2), 0, 1);
      const raw = direct ? target : 1 - Math.pow(1 - target, 1 / params.steps);
      const shaded = darkness === 1 ? raw : 1 - Math.pow(1 - raw, darkness);
      layers.push({
        step,
        t,
        dx: nx * params.distance * t * t,
        dy: ny * params.distance * t * t,
        blur: Math.max(0.1, params.blur * Math.pow(t, 0.7)),
        target,
        opacity: Math.min(1, shaded),
        perpScale: 1 + (params.taperEnd / 100 - 1) * t,
      });
    }
    return { params, layers, direction: { nx, ny, angleRad } };
  }

  /** Affine matrix [a,b,c,d,e,f] = rotate(-θ) · scale(1,k) · rotate(θ) about a pivot. Pure. */
  function taperMatrix(angleRad, perpScale, pivotX, pivotY) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
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

  /* ------------------------------------------------------------------ copies mode */

  /**
   * Duplicate the layer N times, turn each copy into a blurred silhouette and place it behind the
   * source. Returns the created layer ids plus the group id.
   */
  async function buildShadow(api, options) {
    const documentId = options.documentId;
    const sourceLayerId = options.sourceLayerId;
    const plan = planLayers(options.params);
    const onStep = options.onStep || (() => {});
    const layerIds = [];

    const probe = await execute(api, documentId, "layer.duplicate", { layerIds: [sourceLayerId] });
    const firstShadowId = firstId(probe);
    if (!firstShadowId) throw new Error("Photon did not return the duplicated layer id.");
    layerIds.push(firstShadowId);

    const afterProbe = await api.documents.active();
    const sourceIndex = (afterProbe.layers || []).findIndex((item) => item.id === sourceLayerId);
    const probeIndex = (afterProbe.layers || []).findIndex((item) => item.id === firstShadowId);
    const topFirst = probeIndex < sourceIndex;
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
      await execute(api, documentId, "layer.move", { layerIds: [layerId], placement: { index: base + slot } });
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

    return { layerIds, groupId, mode: "copies", topFirst, base, plan };
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

  /* ------------------------------------------------------------------ effect description */

  const WRAPPER_KEYS = new Set([
    "params",
    "parameters",
    "properties",
    "values",
    "defaults",
    "descriptor",
    "descriptors",
    "kind",
    "kinds",
    "effect",
    "effects",
    "meta",
    "version",
    "schema",
    "inputSchema",
  ]);

  function looksLikeDescriptor(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const keys = Object.keys(node);
    const hasName = keys.some((key) => key === "name" || key === "key" || key === "id" || key === "param");
    const hasValue = keys.some((key) => key === "default" || key === "value" || key === "type");
    return hasName && hasValue;
  }

  /**
   * Normalise effect.describe(kind:"dropShadow") into name → metadata. The wrapper is not part of the
   * public contract, so the whole payload is walked: descriptor arrays, nested wrappers and flat
   * name → value maps all work.
   */
  function describeToMap(described) {
    const map = new Map();

    const addDescriptor = (entry) => {
      const name = entry.name || entry.key || entry.id || entry.param;
      if (!name) return;
      map.set(String(name).toLowerCase(), {
        name: String(name),
        value: "default" in entry ? entry.default : entry.value,
        type: entry.type,
        unit: entry.unit,
        min: entry.min,
        max: entry.max,
      });
    };

    const addPair = (name, value) => {
      if (WRAPPER_KEYS.has(String(name).toLowerCase())) return;
      if (value && typeof value === "object" && !Array.isArray(value) && "default" in value) {
        addDescriptor({ name, ...value });
        return;
      }
      map.set(String(name).toLowerCase(), { name: String(name), value });
    };

    const walk = (node, depth) => {
      if (node == null || depth > 6) return;
      if (Array.isArray(node)) {
        for (const entry of node) {
          if (looksLikeDescriptor(entry)) addDescriptor(entry);
          else walk(entry, depth + 1);
        }
        return;
      }
      if (typeof node !== "object") return;
      if (looksLikeDescriptor(node)) {
        addDescriptor(node);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") walk(value, depth + 1);
        else addPair(key, value);
      }
    };

    walk(described, 0);
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

  function effectDefaults(described) {
    const map = describeToMap(described);
    const defaults = {};
    for (const meta of map.values()) defaults[meta.name] = meta.value;
    return { map, defaults };
  }

  /**
   * Build a dropShadow payload the host accepts.
   *
   * `layer.effect.set` validates strictly ("Invalid dropShadow parameters"), so only parameter names
   * that `effect.describe` lists are sent, units are inferred from the host's own defaults, and
   * Photon's light-angle convention is applied (shadow angle + 180).
   */
  const ANGLE_MODES = ["light-yup", "shadow-ydown"];

  /**
   * Convert our screen-space shadow angle (0° = right, 90° = down) into the angle the host expects.
   *
   * Photon's dial follows Photoshop: the angle is the LIGHT direction, measured counter-clockwise
   * with 0° at the right and 90° pointing up. In screen coordinates the shadow of light angle L
   * falls at (-cos L, +sin L), so a desired shadow direction θ needs L = 180° − θ.
   *
   * "shadow-ydown" is the escape hatch: hosts that read the angle as the shadow offset itself get θ.
   */
  function effectAngle(shadowAngle, angleMode) {
    const theta = ((Number(shadowAngle) % 360) + 360) % 360;
    const mode = ANGLE_MODES.includes(angleMode) ? angleMode : ANGLE_MODES[0];
    const value = mode === "shadow-ydown" ? theta : 180 - theta;
    return ((value % 360) + 360) % 360;
  }

  function effectParams(described, entry, params, options) {
    const { map } = effectDefaults(described);
    const distance = entry.distance !== undefined ? entry.distance : Math.hypot(entry.dx || 0, entry.dy || 0);
    const blur = Math.max(0.1, entry.blur);
    const wantOpacity = Math.max(0, Math.min(1, entry.opacity));
    const lightAngle = effectAngle(params.angle, options && options.angleMode);

    if (map.size === 0) {
      const error = new Error(
        "dropShadow parameters are unknown: effect.describe returned nothing. Open Advanced → Inspect effect parameters and check the log.",
      );
      error.code = "EFFECT_DESCRIBE_MISSING";
      throw error;
    }

    const out = {};
    const find = (patterns) => pickParam(map, patterns);
    const angleRad = (params.angle * Math.PI) / 180;

    const angleName = find([/angle/, /direction/, /rotation/]);
    const distanceName = find([/distance/, /offset(?!x|y)/, /radius$/]);
    const xName = find([/^(x|posx|positionx|offsetx)$/]);
    const yName = find([/^(y|posy|positiony|offsety)$/]);
    const sizeName = find([/blur/, /radius/, /softness/, /^size$/]);
    const opacityName = find([/opacity/, /alpha/, /transparency/]);
    const colourName = find([/colou?r/, /tint/]);
    const blendName = find([/blend/, /^mode$/]);
    const spreadName = find([/spread/]);
    const globalName = find([/use.*global/]);

    // positional hosts receive the shadow offset directly
    if (xName || yName) {
      if (xName) out[xName] = Math.cos(angleRad) * distance;
      if (yName) out[yName] = Math.sin(angleRad) * distance;
    }
    if (distanceName) out[distanceName] = distance;
    if (angleName) out[angleName] = lightAngle;
    if (sizeName) out[sizeName] = blur;
    if (spreadName) out[spreadName] = 0;
    if (globalName) out[globalName] = false;

    if (opacityName) {
      const meta = map.get(opacityName.toLowerCase());
      const defaultValue = meta && typeof meta.value === "number" ? meta.value : 1;
      out[opacityName] = defaultValue > 1 ? wantOpacity * 100 : wantOpacity;
    }
    if (colourName) {
      const meta = map.get(colourName.toLowerCase());
      const defaultValue = meta && meta.value;
      if (typeof defaultValue === "string") {
        const hex = String(params.colour).replace("#", "").toUpperCase();
        out[colourName] = defaultValue.startsWith("#") ? "#" + hex : hex;
      } else {
        out[colourName] = rgba(params.colour);
      }
    }
    if (blendName) {
      const meta = map.get(blendName.toLowerCase());
      out[blendName] = typeof meta.value === "string" ? meta.value : "normal";
    }

    if (!Object.keys(out).length) {
      const error = new Error(
        "None of the dropShadow parameters could be mapped. Discovered parameters: " + [...map.keys()].join(", "),
      );
      error.code = "EFFECT_MAPPING_EMPTY";
      error.discovered = [...map.keys()];
      throw error;
    }
    return out;
  }

  /* ------------------------------------------------------------------ effects mode */

  /** Documented shape of a layer-styles object (see layer.effects.set). */
  function emptyStyles() {
    return {
      enabled: true,
      scale: 1,
      strokes: [],
      innerShadows: [],
      colorOverlays: [],
      gradientOverlays: [],
      patternOverlays: [],
      dropShadows: [],
    };
  }

  /** Read a layer's current styles if the document model exposes them. */
  function stylesFromLayer(layer) {
    if (!layer) return null;
    const source = layer.styles || layer.effects || layer.layerEffects || layer.layerStyle || null;
    if (!source || typeof source !== "object") return null;
    if (!Array.isArray(source.dropShadows) && !Array.isArray(source.strokes)) return null;
    return { ...emptyStyles(), ...source, dropShadows: [...(source.dropShadows || [])] };
  }

  /**
   * Effects mode: append N dropShadow styles to the SELECTED layer — no duplicate.
   *
   * `layer.effects.set` replaces the whole styles object, so the current styles are read first and
   * merged: the user's own effects survive, and the snapshot lets `restoreLayerStyles` undo a
   * preview.
   */
  async function applyLayerStyles(api, options) {
    const documentId = options.documentId;
    const layerId = options.layerId;
    const plan = planLayers(options.params, "direct");
    const onStep = options.onStep || (() => {});
    const doc = await api.documents.active();
    const layer = (doc.layers || []).find((item) => item.id === layerId);
    const stylesBefore = stylesFromLayer(layer);

    let described = null;
    try {
      described = await execute(api, documentId, "effect.describe", { kind: "dropShadow" });
    } catch {
      described = null;
    }

    const payloads = plan.layers.map((entry) =>
      effectParams(
        described,
        { distance: Math.hypot(entry.dx, entry.dy), blur: entry.blur, opacity: entry.opacity },
        plan.params,
        { angleMode: options.angleMode },
      ),
    );

    const base = stylesBefore || emptyStyles();
    const styles = { ...base, dropShadows: [...(base.dropShadows || []), ...payloads] };
    await execute(api, documentId, "layer.effects.set", { layerIds: [layerId], styles });
    onStep(payloads.length, payloads.length);

    return {
      layerIds: [layerId],
      groupId: null,
      mode: "effects",
      effects: payloads.length,
      stylesBefore,
      plan,
    };
  }

  /** Undo an effects-mode preview by writing the snapshot back. */
  async function restoreLayerStyles(api, documentId, layerId, stylesBefore) {
    try {
      if (stylesBefore) {
        await execute(api, documentId, "layer.effects.set", { layerIds: [layerId], styles: stylesBefore });
      } else {
        await execute(api, documentId, "layer.effects.clear", { layerIds: [layerId] });
      }
    } catch {
      /* document closed or layer gone */
    }
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
    applyLayerStyles,
    restoreLayerStyles,
    removeShadow,
    describeToMap,
    effectParams,
    effectAngle,
    ANGLE_MODES,
    vectorToAngleDistance,
    emptyStyles,
    stylesFromLayer,
  };
});
