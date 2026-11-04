/*
 * Directional Shadow — Photon plugin.
 *
 * Adds N dropShadow layer styles to the SELECTED layer (no duplicate) through one
 * `layer.effects.set` call, merging the layer's existing styles so nothing the user made is lost.
 * The styles are snapshotted first, so a preview can be reverted with `restoreLayerStyles`.
 *
 * Five fixed steps, preset from the Figma "Beautiful Shadows" plugin:
 *   offset  = distance × [1, .64, .36, .16, .04]
 *   blur    = softness × [1, .91, .76, .57, .3]
 *   opacity = lighting × [.02, .15, .50, .85, .98]
 *
 * Photon's drop-shadow angle is the LIGHT direction on a Photoshop dial (0° right, 90° up), so a
 * shadow pointing at θ needs light = 180 − θ.
 *
 * Pure maths and an injected `api` keep this testable in Node.
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
    blur: 26,
    colour: "#000000",
    darkness: 100,
  };

  const STEPS = 5;
  const DISTANCE_FACTORS = [1, 0.64, 0.36, 0.16, 0.04];
  const BLUR_FACTORS = [1, 0.91, 0.76, 0.57, 0.3];
  const OPACITY_FACTORS = [0.02, 0.15, 0.5, 0.85, 0.98];

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  function normalise(input) {
    const params = { ...DEFAULTS, ...(input || {}) };
    return {
      angle: ((clamp(params.angle, 0, 360) % 360) + 360) % 360,
      distance: clamp(params.distance, 1, 300),
      blur: clamp(params.blur, 0.1, 300),
      colour: /^#[0-9a-f]{6}$/i.test(String(params.colour)) ? params.colour : DEFAULTS.colour,
      darkness: clamp(params.darkness, 1, 100),
    };
  }

  /** Farthest → nearest plan. Pure. */
  function planLayers(input) {
    const params = normalise(input);
    const angleRad = (params.angle * Math.PI) / 180;
    const nx = Math.cos(angleRad);
    const ny = Math.sin(angleRad);
    const lighting = params.darkness / 100;
    const layers = [];

    for (let index = 0; index < STEPS; index += 1) {
      layers.push({
        step: STEPS - index,
        dx: nx * params.distance * DISTANCE_FACTORS[index],
        dy: ny * params.distance * DISTANCE_FACTORS[index],
        blur: Math.max(0.1, params.blur * BLUR_FACTORS[index]),
        opacity: Math.min(1, lighting * OPACITY_FACTORS[index]),
      });
    }
    return { params, layers, direction: { nx, ny, angleRad } };
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

  async function execute(api, documentId, operation, params) {
    return api.documents.execute(operation, params, documentId);
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
    if (!hasName) return false;
    const hasValue = keys.some((key) => key === "default" || key === "value" || key === "type");
    if (hasValue) return true;
    return keys.every((key) => {
      const value = node[key];
      return value === null || typeof value !== "object";
    });
  }

  /** Normalise effect.describe(kind:"dropShadow") into name → metadata, whatever the wrapper. */
  function describeToMap(described) {
    const map = new Map();

    const addDescriptor = (entry) => {
      const name = entry.name || entry.key || entry.id || entry.param;
      if (!name) return;
      map.set(String(name).toLowerCase(), {
        name: String(name),
        value: "default" in entry ? entry.default : entry.value,
        type: entry.type,
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

  function pickParam(map, patterns) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of list) {
      for (const [key, entry] of map) {
        if (pattern.test(key)) return entry.name;
      }
    }
    return null;
  }

  /** Our screen angle (0° right, 90° down) → Photon's y-up Photoshop light dial. */
  function effectAngle(shadowAngle) {
    const theta = ((Number(shadowAngle) % 360) + 360) % 360;
    return ((180 - theta) % 360 + 360) % 360;
  }

  /** Convert a drag vector into { angle, distance } for the light handle (angle = shadow direction). */
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

  function colourValue(hex, format) {
    const bare = String(hex).replace("#", "").toUpperCase();
    if (format === "hex") return "#" + bare;
    if (format === "hex-bare") return bare;
    return rgba(hex);
  }

  /**
   * Build one dropShadow payload. Only parameter names listed by `effect.describe` are sent, units
   * follow the host's own defaults, and the colour encoding is chosen by the caller because Photon
   * does not document which one a layer style stores.
   */
  function effectParams(described, entry, params, options) {
    const map = describeToMap(described);
    if (map.size === 0) {
      const error = new Error("effect.describe returned nothing, so dropShadow parameters are unknown");
      error.code = "EFFECT_DESCRIBE_MISSING";
      throw error;
    }

    const format = (options && options.colourFormat) || "rgb";
    const distance = entry.distance !== undefined ? entry.distance : Math.hypot(entry.dx || 0, entry.dy || 0);
    const blur = Math.max(0.1, entry.blur);
    const wantOpacity = clamp(entry.opacity, 0, 1);
    const out = {};
    const find = (patterns) => pickParam(map, patterns);

    const angleName = find([/angle/, /direction/, /rotation/]);
    const distanceName = find([/distance/, /offset(?!x|y)/]);
    const xName = find([/^(x|posx|positionx|offsetx)$/]);
    const yName = find([/^(y|posy|positiony|offsety)$/]);
    const sizeName = find([/blur/, /radius/, /softness/, /^size$/]);
    const opacityName = find([/opacity/, /alpha/, /transparency/]);
    const colourName = find([/colou?r/, /tint/]);
    const blendName = find([/blend/, /^mode$/]);
    const spreadName = find([/spread/]);
    const globalName = find([/use.*global/]);

    const angleRad = (params.angle * Math.PI) / 180;
    if (xName) out[xName] = Math.cos(angleRad) * distance;
    if (yName) out[yName] = Math.sin(angleRad) * distance;
    if (distanceName) out[distanceName] = distance;
    if (angleName) out[angleName] = effectAngle(params.angle);
    if (sizeName) out[sizeName] = blur;
    if (spreadName) out[spreadName] = 0;
    if (globalName) out[globalName] = false;

    if (opacityName) {
      const meta = map.get(opacityName.toLowerCase());
      const defaultValue = meta && typeof meta.value === "number" ? meta.value : 1;
      out[opacityName] = defaultValue > 1 ? wantOpacity * 100 : wantOpacity;
    }
    if (colourName) out[colourName] = colourValue(params.colour, format);
    if (blendName) {
      const meta = map.get(blendName.toLowerCase());
      out[blendName] = typeof meta.value === "string" ? meta.value : "normal";
    }

    return out;
  }

  /* ------------------------------------------------------------------ layer styles */

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

  function stylesFromLayer(layer) {
    if (!layer) return null;
    const source = layer.styles || layer.effects || layer.layerEffects || layer.layerStyle || null;
    if (!source || typeof source !== "object") return null;
    if (!Array.isArray(source.dropShadows) && !Array.isArray(source.strokes)) return null;
    return { ...emptyStyles(), ...source, dropShadows: [...(source.dropShadows || [])] };
  }

  function sameColour(left, right) {
    if (left && right && typeof left === "object" && typeof right === "object") {
      const keys = ["r", "g", "b", "a"];
      return keys.every((key) => Math.abs((left[key] || 0) - (right[key] || 0)) < 0.01);
    }
    return String(left).replace("#", "").toUpperCase() === String(right).replace("#", "").toUpperCase();
  }

  /**
   * Effects mode: append the 5 shadows to the SELECTED layer.
   *
   * Photon does not document the colour encoding for a layer style, so the write is verified by
   * reading the styles back and trying the next encoding when the colour did not take. When the
   * document model does not expose styles there is nothing to verify against, so the first encoding
   * (an {space:"rgb"} object, the same shape `pixels.fill` accepts) is kept.
   */
  async function applyLayerStyles(api, options) {
    const documentId = options.documentId;
    const layerId = options.layerId;
    const plan = planLayers(options.params);
    const formats = ["rgb", "hex-bare", "hex"];

    const doc = await api.documents.active();
    const layer = (doc.layers || []).find((item) => item.id === layerId);
    const stylesBefore = stylesFromLayer(layer);

    let described = null;
    try {
      described = await execute(api, documentId, "effect.describe", { kind: "dropShadow" });
    } catch {
      described = null;
    }

    const base = stylesBefore || emptyStyles();
    let usedFormat = formats[0];
    let payloads = [];

    for (const format of formats) {
      payloads = plan.layers.map((entry) =>
        effectParams(
          described,
          { distance: Math.hypot(entry.dx, entry.dy), blur: entry.blur, opacity: entry.opacity },
          plan.params,
          { colourFormat: format },
        ),
      );
      const styles = { ...base, dropShadows: [...(base.dropShadows || []), ...payloads] };
      await execute(api, documentId, "layer.effects.set", { layerIds: [layerId], styles });
      usedFormat = format;

      let stored = null;
      try {
        const after = await api.documents.active();
        stored = stylesFromLayer((after.layers || []).find((item) => item.id === layerId));
      } catch {
        stored = null;
      }
      if (!stored) break;
      const colourKey = Object.keys(payloads[0]).find((key) => /colou?r|tint/i.test(key));
      if (!colourKey) break;
      const written = stored.dropShadows[stored.dropShadows.length - payloads.length];
      if (!written) break;
      if (sameColour(written[colourKey], payloads[0][colourKey])) break;
    }

    return {
      layerIds: [layerId],
      mode: "effects",
      effects: payloads.length,
      colourFormat: usedFormat,
      payloads,
      stylesBefore,
      plan,
    };
  }

  /** Undo a preview by writing the snapshot back. */
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
    STEPS,
    DISTANCE_FACTORS,
    BLUR_FACTORS,
    OPACITY_FACTORS,
    clamp,
    normalise,
    planLayers,
    rgba,
    execute,
    describeToMap,
    effectParams,
    effectAngle,
    vectorToAngleDistance,
    emptyStyles,
    stylesFromLayer,
    sameColour,
    applyLayerStyles,
    restoreLayerStyles,
  };
});
