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

test("planLayers ramps from endOpacity (far) to startOpacity (near)", () => {
  const { params, layers } = Shadow.planLayers({ steps: 10, startOpacity: 100, endOpacity: 30 });
  assert.equal(params.steps, 10);
  assert.equal(layers.length, 10);
  const far = layers[0];
  const near = layers[layers.length - 1];
  assert.ok(Math.abs(far.target - 0.3) < 1e-9, "farthest layer targets end opacity");
  // t runs from 1 (far) down to 1/steps (near), so the nearest layer lands one ramp step
  // above endOpacity, not exactly on startOpacity.
  assert.ok(Math.abs(near.target - (1 + (0.3 - 1) / 10)) < 1e-9, "near layer is one ramp step in");
  assert.ok(near.target > far.target, "near layer is more opaque than the far one");
  assert.ok(far.blur > near.blur, "farther layers blur more");
  for (let index = 1; index < layers.length; index += 1) {
    assert.ok(layers[index].opacity >= layers[index - 1].opacity, "opacity grows towards the object");
  }
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
