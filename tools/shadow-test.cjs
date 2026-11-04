#!/usr/bin/env node
/*
 * Tests for the Directional Blur Shadow port:  node tools/shadow-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Shadow = require(path.join(__dirname, "..", "plugin", "shadow.js"));

/* ------------------------------------------------------------------ fake Photon */

function fakeApi(options) {
  const opts = options || {};
  const calls = [];
  let nextId = 0;
  // index 0 = topmost (Photon shows layers top-first in its panel)
  const layers = [{ id: "src", name: "Subject" }, { id: "bg", name: "Background" }];
  let groupId = null;

  const api = {
    calls,
    documents: {
      active: async () => ({
        id: "doc-1",
        width: 800,
        height: 600,
        layers: layers.map((layer) => {
          if (layer.id === "src") return { ...layer, bounds: { x: 100, y: 100, width: 200, height: 200 } };
          return { ...layer };
        }),
      }),
      execute: async (operation, params, documentId) => {
        calls.push({ operation, params, documentId });
        if (operation === "layer.duplicate") {
          const source = params.layerIds[0];
          const id = "dup" + ++nextId;
          layers.unshift({ id, name: id });
          return { layerIds: [id] };
        }
        if (operation === "layer.group") {
          groupId = "group1";
          const ids = new Set(params.layerIds);
          for (let index = layers.length - 1; index >= 0; index -= 1) {
            if (ids.has(layers[index].id)) layers.splice(index, 1);
          }
          layers.unshift({ id: groupId, name: "Group" });
          return { layerIds: [groupId] };
        }
        if (operation === "layer.rasterize") return { layerIds: params.layerIds };
        return { ok: true };
      },
    },
  };
  return { api, calls, layers, groupId: () => groupId };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("planLayers defaults to 5 layers and eases the ramps", () => {
  assert.equal(Shadow.DEFAULTS.steps, 5);
  const { params, layers } = Shadow.planLayers({ steps: 5, distance: 150, blur: 26, startOpacity: 100, endOpacity: 5 });
  assert.equal(params.steps, 5);
  assert.equal(layers.length, 5);
  const far = layers[0];
  const near = layers[layers.length - 1];
  assert.ok(Math.abs(far.target - 0.05) < 1e-9, "farthest layer sits on endOpacity");
  assert.ok(Math.abs(near.target - 1) < 1e-9, "nearest layer lands exactly on startOpacity");
  assert.ok(far.blur > near.blur, "farther layers blur more");
  for (let index = 1; index < layers.length; index += 1) {
    assert.ok(layers[index].opacity >= layers[index - 1].opacity, "opacity grows towards the object");
  }
});

test("offsets and blur follow the Beautiful Shadows ramps", () => {
  const { layers } = Shadow.planLayers({ steps: 5, distance: 150, blur: 26, angle: 0 });
  const offsets = layers.map((layer) => Math.round(layer.dx));
  assert.deepEqual(offsets, [150, 96, 54, 24, 6], "quadratic distance ramp (t^2 * 150)");
  const blurs = layers.map((layer) => Math.round(layer.blur));
  assert.deepEqual(blurs, [26, 22, 18, 14, 8], "blur eases with t^0.7");
});

test("direct mode uses the ramp value, composite mode normalises", () => {
  const direct = Shadow.planLayers({ steps: 5, startOpacity: 100, endOpacity: 5 }, "direct").layers[0];
  const composite = Shadow.planLayers({ steps: 5, startOpacity: 100, endOpacity: 5 }).layers[0];
  assert.ok(Math.abs(direct.opacity - 0.05) < 1e-9, "direct mode keeps the ramp opacity");
  assert.ok(composite.opacity < direct.opacity, "composite mode divides the load across layers");
});

test("step count does not darken the composite (Beer-Lambert normalisation)", () => {
  const composite = (steps) => {
    const { layers } = Shadow.planLayers({ steps, startOpacity: 50, endOpacity: 50, darkness: 100 });
    // alpha-over of N equally opaque layers: 1 - (1 - a)^N
    const alpha = layers[0].opacity;
    return 1 - Math.pow(1 - alpha, layers.length);
  };
  assert.ok(Math.abs(composite(3) - 0.5) < 1e-9, "3 layers compose to 0.5");
  assert.ok(Math.abs(composite(10) - 0.5) < 1e-9, "10 layers compose to 0.5");
  assert.ok(Math.abs(composite(30) - 0.5) < 1e-9, "30 layers compose to 0.5");
});

test("darkness deepens without clipping the gradient", () => {
  const at = (darkness) => Shadow.planLayers({ steps: 4, startOpacity: 50, endOpacity: 50, darkness }).layers[0].opacity;
  const base = at(100);
  const doubled = at(200);
  const extreme = at(300);
  // 1 - (1 - raw)^k: deeper, strictly increasing, always < 1
  assert.ok(Math.abs(doubled - (1 - Math.pow(1 - base, 2))) < 1e-9);
  assert.ok(doubled > base && extreme > doubled);
  assert.ok(extreme < 1, "300 % does not clip to fully opaque");
});

test("angle: 0° points right, 90° points down", () => {
  const right = Shadow.planLayers({ angle: 0, distance: 100, steps: 5 }).layers[0];
  const down = Shadow.planLayers({ angle: 90, distance: 100, steps: 5 }).layers[0];
  assert.ok(Math.abs(right.dx - 100) < 1e-9 && Math.abs(right.dy) < 1e-9);
  assert.ok(Math.abs(down.dy - 100) < 1e-9 && Math.abs(down.dx) < 1e-9);
});

test("taperMatrix is identity at scale 1 and keeps the pivot fixed", () => {
  assert.deepEqual(Shadow.taperMatrix(0.7, 1, 50, 60), [1, 0, 0, 1, 0, 0]);
  const angle = Math.PI / 5;
  const [a, b, c, d, e, f] = Shadow.taperMatrix(angle, 0.6, 200, 150);
  const px = 200;
  const py = 150;
  assert.ok(Math.abs(a * px + c * py + e - px) < 1e-9, "pivot x stays");
  assert.ok(Math.abs(b * px + d * py + f - py) < 1e-9, "pivot y stays");
  // a point along the shadow direction keeps its distance (scale is perpendicular)
  const along = { x: px + Math.cos(angle) * 100, y: py + Math.sin(angle) * 100 };
  const moved = {
    x: a * along.x + c * along.y + e,
    y: b * along.x + d * along.y + f,
  };
  assert.ok(Math.abs(moved.x - along.x) < 1e-9);
  assert.ok(Math.abs(moved.y - along.y) < 1e-9);
});

test("rgba() converts hex to Photon colour", () => {
  assert.deepEqual(Shadow.rgba("#000000"), { space: "rgb", r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(Shadow.rgba("#ffffff"), { space: "rgb", r: 1, g: 1, b: 1, a: 1 });
  const half = Shadow.rgba("#336699", 0.5);
  assert.ok(Math.abs(half.r - 0x33 / 255) < 1e-9);
  assert.equal(half.a, 0.5);
});

test("normalise clamps ranges and rejects junk colour", () => {
  const params = Shadow.normalise({ angle: -10, distance: 99999, steps: 1, blur: 0, startOpacity: 500, endOpacity: -5, darkness: 900, taperEnd: 0, colour: "red" });
  assert.equal(params.angle, 0);
  assert.equal(params.distance, 2000);
  assert.equal(params.steps, 3);
  assert.equal(params.blur, 0.1);
  assert.equal(params.startOpacity, 100);
  assert.equal(params.endOpacity, 0);
  assert.equal(params.darkness, 300);
  assert.equal(params.taperEnd, 1);
  assert.equal(params.colour, "#000000");
});

test("buildShadow runs the full pipeline per layer", async () => {
  const { api, calls } = fakeApi();
  const result = await Shadow.buildShadow(api, {
    documentId: "doc-1",
    sourceLayerId: "src",
    params: { steps: 4, angle: 0, distance: 100, blur: 20, taper: false, rasterize: true },
  });
  assert.equal(result.layerIds.length, 4);
  assert.equal(result.groupId, "group1");

  const ops = calls.map((call) => call.operation);
  assert.equal(ops.filter((op) => op === "layer.duplicate").length, 4, "one duplicate per step");
  assert.equal(ops.filter((op) => op === "pixels.fill").length, 4);
  assert.equal(ops.filter((op) => op === "filter.blur.gaussianBlur").length, 4);
  assert.equal(ops.filter((op) => op === "layer.update").length, 5, "opacity per layer + group rename");
  assert.equal(ops.filter((op) => op === "layer.translate").length, 4);
  assert.equal(ops.filter((op) => op === "layer.move").length, 4);
  assert.equal(ops.filter((op) => op === "layer.group").length, 1);
  assert.equal(ops.filter((op) => op === "layer.rasterize").length, 1);

  const fills = calls.filter((call) => call.operation === "pixels.fill");
  assert.deepEqual(fills[0].params.color, { space: "rgb", r: 0, g: 0, b: 0, a: 1 });
  assert.equal(fills[0].params.preserveTransparency, true);

  const blurs = calls.filter((call) => call.operation === "filter.blur.gaussianBlur");
  assert.ok(blurs[0].params.params.radius > blurs[blurs.length - 1].params.params.radius, "far layer blurs more");

  const rename = calls.filter((call) => call.operation === "layer.update").pop();
  assert.equal(rename.params.properties.name, Shadow.GROUP_NAME);

  const moves = calls.filter((call) => call.operation === "layer.move");
  const indices = moves.map((call) => call.params.placement.index);
  assert.deepEqual(indices, [2, 3, 4, 5], "shadow layers land directly under the source, in order");
  assert.equal(result.topFirst, true);
});

test("buildShadow honours taper and skips rasterize", async () => {
  const { api, calls } = fakeApi();
  await Shadow.buildShadow(api, {
    documentId: "doc-1",
    sourceLayerId: "src",
    params: { steps: 3, taper: true, taperEnd: 50, rasterize: false },
  });
  assert.equal(calls.filter((call) => call.operation === "core.canvas.applyLayerTransform").length, 3);
  assert.equal(calls.filter((call) => call.operation === "layer.rasterize").length, 0);
  const transform = calls.find((call) => call.operation === "core.canvas.applyLayerTransform");
  assert.equal(transform.params.matrix.length, 6);
});

test("removeShadow deletes the group once", async () => {
  const { api, calls } = fakeApi();
  await Shadow.removeShadow(api, "doc-1", ["dup1", "dup2"], "group1");
  const deletes = calls.filter((call) => call.operation === "layer.delete");
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].params.layerIds, ["group1"]);
});

test("removeShadow tolerates a missing layer", async () => {
  const api = {
    documents: {
      execute: async () => {
        throw new Error("not found");
      },
    },
  };
  await Shadow.removeShadow(api, "doc-1", [], null);
  await Shadow.removeShadow(api, "doc-1", ["x"], null);
});


/* --------------------------------------------------------------- effects mode */

function effectsApi(options) {
  const settings = options || {};
  const calls = [];
  const layer = { id: "src" };
  if (settings.styles) layer.styles = settings.styles;
  const layers = [layer, { id: "bg" }];
  const api = {
    calls,
    documents: {
      active: async () => ({ id: "doc-1", width: 800, height: 600, layers: layers.map((l) => ({ ...l })) }),
      execute: async (operation, params) => {
        calls.push({ operation, params });
        if (operation === "effect.describe") return DESCRIBED;
        return { ok: true };
      },
    },
  };
  return api;
}

const DESCRIBED = {
  params: [
    { name: "blendMode", default: "normal" },
    { name: "opacity", default: 75 },
    { name: "angle", default: 120 },
    { name: "distance", default: 5 },
    { name: "spread", default: 0 },
    { name: "size", default: 5 },
    { name: "color", default: "000000" },
  ],
};

test("describeToMap walks nested wrappers and flat maps", () => {
  const nested = Shadow.describeToMap({ descriptor: { parameters: [{ name: "opacity", default: 0.5 }] } });
  assert.equal(nested.size, 1);
  assert.equal(nested.get("opacity").value, 0.5);

  const flat = Shadow.describeToMap({ params: { angle: 30, size: 5, color: "000000" } });
  assert.equal(flat.size, 3);
  assert.equal(flat.get("size").value, 5);

  const deep = Shadow.describeToMap({ kind: "dropShadow", meta: { version: 1, params: [{ key: "blur", default: 14 }] } });
  assert.equal(deep.size, 1);
  assert.equal(deep.get("blur").name, "blur");
});

test("effectParams maps onto the host's parameter names", () => {
  const out = Shadow.effectParams(DESCRIBED, { distance: 42, blur: 12, opacity: 0.4, dx: 0, dy: 0 }, { angle: 90, colour: "#112233" });
  assert.equal(out.angle, 270, "host angle is the light direction: shadow angle 90 becomes 270");
  assert.equal(out.distance, 42);
  assert.equal(out.size, 12);
  assert.equal(out.opacity, 40, "percent host");
  assert.equal(out.color, "112233", "string colour default means bare hex");
});

test("effectParams throws when describe is unavailable", () => {
  assert.throws(
    () => Shadow.effectParams(null, { distance: 10, blur: 3, opacity: 0.5 }, { angle: 45, colour: "#000000" }),
    /effect.describe returned nothing/,
  );
});

test("effectParams supports positional X/Y hosts (Beautiful Shadows style)", () => {
  const host = {
    params: [
      { name: "x", default: 2 },
      { name: "y", default: 6 },
      { name: "blur", default: 14 },
      { name: "spread", default: 0 },
      { name: "color", default: "000000" },
      { name: "opacity", default: 44 },
    ],
  };
  const out = Shadow.effectParams(host, { distance: 150, blur: 26, opacity: 0.38 }, { angle: 0, colour: "#000000" });
  assert.ok(Math.abs(out.x - 150) < 1e-9, "angle 0 puts the shadow to the right");
  assert.ok(Math.abs(out.y) < 1e-9);
  assert.equal(out.blur, 26);
  assert.equal(out.spread, 0);
  assert.equal(out.color, "000000");
  assert.equal(out.opacity, 38, "percent host");
  assert.equal(out.angle, undefined, "no angle parameter in this host");
});

test("unmappable parameters report the discovered keys", () => {
  const host = { params: [{ name: "zap", default: 1 }, { name: "zop", default: 2 }] };
  try {
    Shadow.effectParams(host, { distance: 10, blur: 3, opacity: 0.5 }, { angle: 0, colour: "#000000" });
    assert.fail("should have thrown");
  } catch (error) {
    assert.match(error.message, /zap, zop/);
    assert.equal(error.code, "EFFECT_MAPPING_EMPTY");
  }
});

test("applyLayerStyles writes drop shadows onto the selected layer, no duplicate", async () => {
  const api = effectsApi();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { steps: 5, angle: 30, distance: 150, blur: 26 },
  });

  assert.equal(result.mode, "effects");
  assert.equal(result.effects, 5);
  assert.equal(api.calls.filter((c) => c.operation === "layer.duplicate").length, 0, "no duplicate layer");
  assert.equal(api.calls.filter((c) => c.operation === "layer.effects.clear").length, 0);

  const sets = api.calls.filter((c) => c.operation === "layer.effects.set");
  assert.equal(sets.length, 1, "a single atomic write");
  assert.deepEqual(sets[0].params.layerIds, ["src"]);
  const shadows = sets[0].params.styles.dropShadows;
  assert.equal(shadows.length, 5);
  assert.equal(sets[0].params.styles.enabled, true);
  for (const shadow of shadows) {
    assert.ok(shadow.distance > 0);
    assert.ok(shadow.size > 0);
    assert.ok(shadow.opacity > 0 && shadow.opacity <= 100);
  }
  assert.ok(shadows[0].distance > shadows[4].distance, "far shadow travels further");
  assert.equal(shadows[4].opacity, 44, "nearest shadow lands on startOpacity");
});

test("applyLayerStyles keeps the layer's existing effects", async () => {
  const existing = {
    enabled: true,
    scale: 1,
    strokes: [],
    innerShadows: [],
    colorOverlays: [],
    gradientOverlays: [],
    patternOverlays: [],
    dropShadows: [{ distance: 9, size: 4, angle: 100, opacity: 20, color: "000000" }],
  };
  const api = effectsApi({ styles: existing });
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { steps: 3 },
  });

  const set = api.calls.find((c) => c.operation === "layer.effects.set");
  assert.equal(set.params.styles.dropShadows.length, 4, "existing shadow kept + 3 new");
  assert.deepEqual(set.params.styles.dropShadows[0], existing.dropShadows[0]);
  assert.equal(result.stylesBefore.dropShadows.length, 1, "the snapshot holds the original styles");
});

test("restoreLayerStyles puts the snapshot back", async () => {
  const existing = Shadow.emptyStyles();
  existing.dropShadows = [{ distance: 9 }];
  const api = effectsApi({ styles: existing });
  await Shadow.restoreLayerStyles(api, "doc-1", "src", existing);
  const set = api.calls.find((c) => c.operation === "layer.effects.set");
  assert.deepEqual(set.params.styles, existing);

  const cleared = effectsApi();
  await Shadow.restoreLayerStyles(cleared, "doc-1", "src", null);
  assert.equal(cleared.calls.filter((c) => c.operation === "layer.effects.clear").length, 1, "clears when there was nothing to restore");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (error) {
      failed += 1;
      console.log("  FAIL " + name + "\n       " + (error && error.message));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " tests passed");
  process.exit(failed ? 1 : 0);
})();
