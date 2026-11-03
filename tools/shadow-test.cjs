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
  // t = 0.2 → target = 0.05 + 0.95 * (0.8)^2 = 0.658
  assert.ok(Math.abs(near.target - 0.658) < 1e-3, "nearest layer sits on the eased ramp");
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

test("darkness scales after normalisation and clamps at 1", () => {
  const base = Shadow.planLayers({ steps: 4, startOpacity: 50, endOpacity: 50, darkness: 100 }).layers[0].opacity;
  const dark = Shadow.planLayers({ steps: 4, startOpacity: 50, endOpacity: 50, darkness: 200 }).layers[0].opacity;
  const extreme = Shadow.planLayers({ steps: 4, startOpacity: 100, endOpacity: 100, darkness: 300 }).layers[0].opacity;
  assert.ok(Math.abs(dark - Math.min(1, base * 2)) < 1e-9);
  assert.equal(extreme, 1);
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

function effectsApi(described) {
  const calls = [];
  let duplicateCount = 0;
  const layers = [{ id: "src" }, { id: "bg" }];
  const api = {
    calls,
    documents: {
      active: async () => ({ id: "doc-1", width: 800, height: 600, layers: layers.map((l) => ({ ...l })) }),
      execute: async (operation, params) => {
        calls.push({ operation, params });
        if (operation === "effect.describe") return described;
        if (operation === "layer.duplicate") {
          duplicateCount += 1;
          const id = "fx" + duplicateCount;
          layers.unshift({ id });
          return { layerIds: [id] };
        }
        return { ok: true };
      },
    },
  };
  return { api, calls };
}

const DESCRIBED = {
  params: [
    { name: "blendMode", default: "normal" },
    { name: "opacity", default: 0.75 },
    { name: "angle", default: 120 },
    { name: "distance", default: 5 },
    { name: "spread", default: 0 },
    { name: "size", default: 5 },
    { name: "color", default: { space: "rgb", r: 0, g: 0, b: 0, a: 1 } },
    { name: "noise", default: 0 },
  ],
};

test("describeToMap reads array and object payloads", () => {
  const fromArray = Shadow.describeToMap(DESCRIBED);
  assert.equal(fromArray.size, 8);
  assert.equal(fromArray.get("distance").name, "distance");
  const fromObject = Shadow.describeToMap({ params: { angle: 30, size: 5 } });
  assert.equal(fromObject.size, 2);
  assert.equal(fromObject.get("size").value, 5);
});

test("effectParams maps onto the host's parameter names", () => {
  const out = Shadow.effectParams(DESCRIBED, { distance: 42, blur: 12, opacity: 0.4, dx: 0, dy: 0 }, { angle: 90, colour: "#112233" });
  assert.equal(out.angle, 90);
  assert.equal(out.distance, 42);
  assert.equal(out.size, 12);
  assert.equal(out.opacity, 0.4);
  assert.deepEqual(out.color, { space: "rgb", r: 0x11 / 255, g: 0x22 / 255, b: 0x33 / 255, a: 1 });
});

test("effectParams falls back to canonical names when describe is unavailable", () => {
  const out = Shadow.effectParams(null, { distance: 10, blur: 3, opacity: 0.5 }, { angle: 45, colour: "#000000" });
  assert.equal(out.angle, 45);
  assert.equal(out.distance, 10);
  assert.equal(out.size, 3);
  assert.equal(out.opacity, 0.5);
  assert.deepEqual(out.color, { space: "rgb", r: 0, g: 0, b: 0, a: 1 });
});

test("buildWithEffects appends one drop shadow per step on a single hidden-copy layer", async () => {
  const { api, calls } = effectsApi(DESCRIBED);
  const result = await Shadow.buildWithEffects(api, {
    documentId: "doc-1",
    sourceLayerId: "src",
    params: { steps: 6, angle: 30, distance: 120, blur: 20, startOpacity: 100, endOpacity: 25 },
  });

  assert.equal(result.mode, "effects");
  assert.equal(result.effects, 6);
  assert.equal(calls.filter((c) => c.operation === "layer.duplicate").length, 1, "only one duplicated layer");
  assert.equal(calls.filter((c) => c.operation === "layer.group").length, 0, "no group needed");

  const update = calls.find((c) => c.operation === "layer.update");
  assert.equal(update.params.properties.fillOpacity, 0, "the copy's own pixels are hidden");
  assert.equal(update.params.properties.name, Shadow.GROUP_NAME);

  const effects = calls.filter((c) => c.operation === "layer.effect.set");
  assert.equal(effects.length, 6);
  assert.deepEqual(effects.map((c) => c.params.index), [0, 1, 2, 3, 4, 5], "appended in order");
  for (const call of effects) {
    assert.equal(call.params.kind, "dropShadow");
    assert.deepEqual(call.params.layerIds, ["fx1"]);
    assert.ok(call.params.params.distance > 0);
    assert.ok(call.params.params.size > 0);
    assert.ok(call.params.params.opacity > 0 && call.params.params.opacity <= 1);
  }
  const distances = effects.map((c) => c.params.params.distance);
  assert.ok(distances[0] > distances[distances.length - 1], "far shadow travels further");
});

test("buildWithEffects still works when describe fails", async () => {
  const { api, calls } = effectsApi(undefined);
  const result = await Shadow.buildWithEffects(api, {
    documentId: "doc-1",
    sourceLayerId: "src",
    params: { steps: 3 },
  });
  assert.equal(result.effects, 3);
  const effects = calls.filter((c) => c.operation === "layer.effect.set");
  assert.equal(effects[0].params.params.angle, 30);
  assert.ok("size" in effects[0].params.params);
});


test("vectorToAngleDistance maps a drag to angle and distance", () => {
  const right = Shadow.vectorToAngleDistance(100, 0, 2000);
  assert.equal(right.angle, 0);
  assert.equal(right.distance, 100);
  const down = Shadow.vectorToAngleDistance(0, 50, 2000);
  assert.equal(down.angle, 90);
  assert.equal(down.distance, 50);
  const upLeft = Shadow.vectorToAngleDistance(-10, -10, 2000);
  assert.equal(upLeft.angle, 225);
  assert.ok(Math.abs(upLeft.distance - Math.hypot(10, 10)) < 0.1, "distance is rounded to 0.1");
  const clamped = Shadow.vectorToAngleDistance(5000, 0, 150);
  assert.equal(clamped.distance, 150);
});

test("effectParams prefers an explicit blur parameter over size", () => {
  const described = {
    params: [
      { name: "blur", default: 4 },
      { name: "size", default: 4 },
      { name: "distance", default: 5 },
      { name: "opacity", default: 0.7 },
      { name: "angle", default: 120 },
      { name: "color", default: { space: "rgb", r: 0, g: 0, b: 0, a: 1 } },
    ],
  };
  const out = Shadow.effectParams(described, { distance: 30, blur: 17, opacity: 0.5 }, { angle: 45, colour: "#000000" });
  assert.equal(out.blur, 17, "blur is used for softness");
  assert.equal(out.size, undefined, "size is not touched when blur exists");
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
