/*
 * Directional Shadow — Photon plugin.
 *
 * Adds five typed layer effects to the SELECTED layer with one batched `layer.effect.set` per step.
 * `layer.effect.set` adds or patches a single effect and leaves every other effect on the layer
 * alone, so drop shadow and inner shadow can coexist on the same layer.
 *
 * Five fixed steps, modelled on the Figma "Beautiful Shadows" plugin:
 *   offset  = distance × [1, .64, .36, .16, .04]
 *   blur    = distance × [.283, .258, .215, .16, .086] × soft%     (soft 100 % at D 163 px gives
 *             the plugin's own 46 / 42 / 35 / 26 / 14 px column)
 *   opacity = lighting × [.02, .15, .50, .85, .98]
 *
 * Photon's shadow angle is the LIGHT direction on a Photoshop dial (0° right, 90° up), so a shadow
 * pointing at θ needs light = 180 − θ.
 *
 * Both drop shadow and inner shadow are supported; each write works on its own effect array, so
 * applying one never removes the other.
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
    soft: 75,
    colour: "#000000",
    darkness: 100,
    kind: "dropShadow",
    blend: "normal",
  };

  const KINDS = ["dropShadow", "innerShadow"];
  const BLEND_MODES = [
    "normal",
    "dissolve",
    "darken",
    "multiply",
    "color-burn",
    "linear-burn",
    "darker-color",
    "lighten",
    "screen",
    "color-dodge",
    "linear-dodge",
    "lighter-color",
    "overlay",
    "soft-light",
    "hard-light",
    "vivid-light",
    "linear-light",
    "pin-light",
    "hard-mix",
    "difference",
    "exclusion",
    "subtract",
    "divide",
    "hue",
    "saturation",
    "color",
    "luminosity",
  ];
  const STEPS = 5;
  const DISTANCE_FACTORS = [1, 0.64, 0.36, 0.16, 0.04];
  // blur / distance ratios, farthest → nearest (Figma's 46/42/35/26/14 px at 163 px)
  const BLUR_FACTORS = [0.283, 0.258, 0.215, 0.16, 0.086];
  const OPACITY_FACTORS = [0.02, 0.15, 0.5, 0.85, 0.98];

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  function normalise(input) {
    const params = { ...DEFAULTS, ...(input || {}) };
    return {
      angle: Math.round((((clamp(params.angle, 0, 360) % 360) + 360) % 360) * 10) / 10,
      distance: Math.round(clamp(params.distance, 1, 300) * 10) / 10,
      soft: clamp(params.soft, 1, 100),
      colour: /^#[0-9a-f]{6}$/i.test(String(params.colour)) ? params.colour : DEFAULTS.colour,
      darkness: clamp(params.darkness, 1, 100),
      kind: KINDS.includes(params.kind) ? params.kind : DEFAULTS.kind,
      blend: BLEND_MODES.includes(String(params.blend)) ? String(params.blend) : DEFAULTS.blend,
    };
  }

  /** Farthest → nearest plan. Pure. */
  function planLayers(input) {
    const params = normalise(input);
    const angleRad = (params.angle * Math.PI) / 180;
    const nx = Math.cos(angleRad);
    const ny = Math.sin(angleRad);
    const lighting = params.darkness / 100;
    const softness = params.soft / 100;
    const layers = [];

    for (let index = 0; index < STEPS; index += 1) {
      layers.push({
        step: STEPS - index,
        distance: params.distance * DISTANCE_FACTORS[index],
        dx: nx * params.distance * DISTANCE_FACTORS[index],
        dy: ny * params.distance * DISTANCE_FACTORS[index],
        // every shadow carries its own blur, scaled by how far it sits from the layer
        blur: Math.max(0.1, params.distance * BLUR_FACTORS[index] * softness),
        opacity: Math.min(1, lighting * OPACITY_FACTORS[index]),
      });
    }
    return { params, layers, direction: { nx, ny, angleRad } };
  }

  /** Hex → typed effect colour (0-1 channels, no alpha; opacity is its own field). */
  function effectColour(hex) {
    const value = String(hex || "#000000").replace("#", "");
    return {
      space: "rgb",
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
    };
  }

  /** CSS-style blend name ("soft-light") → the effect schema's camelCase ("softLight"). */
  function effectBlend(name) {
    const value = String(name || "normal");
    if (!value.includes("-")) return value;
    return value
      .split("-")
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");
  }

  async function execute(api, documentId, operation, params) {
    return api.documents.execute(operation, params, documentId);
  }

  /** One undoable batch when the SDK has it, sequential operations otherwise. */
  async function batch(api, documentId, label, steps, revision) {
    if (typeof api.documents.batch === "function") {
      return api.documents.batch(documentId, label, steps, revision);
    }
    const output = [];
    for (const step of steps) output.push(await execute(api, documentId, step.operation, step.params));
    return output;
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

  /** Normalise effect.describe(kind) into name → metadata, whatever the wrapper looks like. */
  function describeToMap(described) {
    const map = new Map();

    // The live host returns { kind, parameters: { properties }, defaults }; use it directly so the
    // colour object is read as one parameter instead of being flattened into its rgb channels.
    const properties = described && described.parameters && described.parameters.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const defaults = described.defaults && typeof described.defaults === "object" ? described.defaults : {};
      for (const [name, schema] of Object.entries(properties)) {
        map.set(String(name).toLowerCase(), {
          name,
          value: Object.prototype.hasOwnProperty.call(defaults, name) ? defaults[name] : schema && schema.default,
          type: schema && schema.type,
        });
      }
      for (const [name, value] of Object.entries(defaults)) {
        if (!map.has(String(name).toLowerCase())) map.set(String(name).toLowerCase(), { name, value });
      }
      return map;
    }

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
    return (((180 - theta) % 360) + 360) % 360;
  }

  /** Convert a drag vector into { angle, distance } for the light handle (angle = shadow direction). */
  function vectorToAngleDistance(dx, dy, maxDistance) {
    const distance = Math.hypot(dx, dy);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const limit = Number(maxDistance) || 300;
    return {
      angle: Math.round(angle * 10) / 10,
      distance: Math.max(1, Math.min(limit, Math.round(distance * 10) / 10)),
    };
  }

  /**
   * Build one typed effect payload. Only parameter names listed by `effect.describe` are sent,
   * so a host that renames a field still gets a valid object.
   */
  function effectParams(described, entry, params) {
    const map = describeToMap(described);
    if (map.size === 0) {
      const error = new Error("effect.describe returned nothing, so the shadow parameters are unknown");
      error.code = "EFFECT_DESCRIBE_MISSING";
      throw error;
    }

    const distance = entry.distance !== undefined ? entry.distance : Math.hypot(entry.dx || 0, entry.dy || 0);
    const blur = Math.max(0.1, entry.blur);
    const wantOpacity = clamp(entry.opacity, 0, 1);
    const out = {};
    const find = (patterns) => pickParam(map, patterns);

    const angleName = find([/angle/, /direction/, /rotation/]);
    const distanceName = find([/distance/, /offset(?!x|y)/]);
    const sizeName = find([/blur/, /radius/, /softness/, /^size$/]);
    const opacityName = find([/opacity/, /alpha/, /transparency/]);
    const colourName = find([/colou?r/, /tint/]);
    const blendName = find([/blend/, /^mode$/]);
    const spreadName = find([/spread/]);
    const globalName = find([/use.*global/]);
    const enabledName = find([/^enabled$/]);
    const presentName = find([/^present$/]);

    if (distanceName) out[distanceName] = distance;
    if (angleName) out[angleName] = effectAngle(params.angle);
    if (sizeName) out[sizeName] = blur;
    if (spreadName) out[spreadName] = 0;
    if (globalName) out[globalName] = false;
    if (enabledName) out[enabledName] = true;
    if (presentName) out[presentName] = true;

    if (opacityName) {
      const meta = map.get(opacityName.toLowerCase());
      const defaultValue = meta && typeof meta.value === "number" ? meta.value : 1;
      out[opacityName] = defaultValue > 1 ? wantOpacity * 100 : wantOpacity;
    }
    if (colourName) out[colourName] = effectColour(params.colour);
    if (blendName) {
      const meta = map.get(blendName.toLowerCase());
      out[blendName] = effectBlend(params.blend || (typeof meta.value === "string" ? meta.value : "normal"));
    }

    return out;
  }

  /* ------------------------------------------------------------------ layer effects */

  /**
   * Write the five shadows of one kind onto the selected layer.
   *
   * `layer.effect.set` keeps every other effect, and index 0-4 patches that kind in place or
   * appends when the array is shorter, so re-applying never stacks a second copy. The five calls
   * share one batch, which is one undo step.
   */
  async function applyLayerStyles(api, options) {
    const documentId = options.documentId;
    const layerId = options.layerId;
    const plan = planLayers(options.params);
    const kind = plan.params.kind;

    let described = null;
    try {
      described = await execute(api, documentId, "effect.describe", { kind });
    } catch {
      described = null;
    }

    const payloads = plan.layers.map((entry) =>
      effectParams(described, { distance: entry.distance, blur: entry.blur, opacity: entry.opacity }, plan.params),
    );
    const steps = payloads.map((params, index) => ({
      operation: "layer.effect.set",
      params: { layerIds: [layerId], kind, index, params },
    }));

    let revision;
    try {
      const doc = await api.documents.active();
      revision = doc && doc.revision;
    } catch {
      revision = undefined;
    }

    await batch(api, documentId, "Plugin: " + kind, steps, revision);
    return { layerIds: [layerId], kind, effects: payloads.length, payloads };
  }

  /**
   * Remove the five shadows of one kind from the layer list. The plugin API has no single-effect
   * delete, so this clears the `present` and `enabled` flags: Photon drops the effects from the
   * Layers panel and the render, and a later apply patches them back on.
   */
  async function disableLayerShadows(api, options) {
    const steps = [];
    for (let index = 0; index < STEPS; index += 1) {
      steps.push({
        operation: "layer.effect.set",
        params: { layerIds: [options.layerId], kind: options.kind, index, params: { enabled: false, present: false } },
      });
    }

    let revision;
    try {
      const doc = await api.documents.active();
      revision = doc && doc.revision;
    } catch {
      revision = undefined;
    }

    await batch(api, options.documentId, "Plugin: hide shadows", steps, revision);
  }

  return {
    DEFAULTS,
    STEPS,
    KINDS,
    BLEND_MODES,
    DISTANCE_FACTORS,
    BLUR_FACTORS,
    OPACITY_FACTORS,
    clamp,
    normalise,
    planLayers,
    effectColour,
    effectBlend,
    execute,
    describeToMap,
    effectParams,
    effectAngle,
    vectorToAngleDistance,
    applyLayerStyles,
    disableLayerShadows,
  };
});
