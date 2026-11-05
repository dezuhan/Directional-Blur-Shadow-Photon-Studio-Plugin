#!/usr/bin/env node
/*
 * Tests for the Directional Shadow plugin:  node tools/shadow-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Shadow = require(path.join(__dirname, "..", "plugin", "shadow.js"));

/* ------------------------------------------------------------------ fake Photon */

const DESCRIBED = {
  kind: "dropShadow",
  parameters: {
    type: "object",
    properties: {
      angle: { type: "number" },
      distance: { type: "number" },
      size: { type: "number" },
      opacity: { type: "number" },
      spread: { type: "number" },
      useGlobalLight: { type: "boolean" },
      color: { type: "object" },
      blendMode: { type: "string" },
      enabled: { type: "boolean" },
      present: { type: "boolean" },
    },
  },
  defaults: {
    angle: 120,
    distance: 5,
    size: 5,
    opacity: 0.75,
    spread: 0,
    useGlobalLight: false,
    color: { space: "rgb", r: 0, g: 0, b: 0 },
    blendMode: "normal",
    enabled: true,
    present: true,
  },
};

/**
 * Fake host with the real `layer.effect.set` semantics: index 0-4 patches or appends one effect
 * array, every other effect array is left alone. `documents.batch` runs the steps in order.
 */
function fakeApi() {
  const calls = [];
  const layer = { id: "src", dropShadows: [], innerShadows: [] };
  const documents = {
    active: async () => ({ id: "doc-1", revision: 10, selectedLayerIds: ["src"], layers: [{ id: "src" }] }),
    batch: async (documentId, label, steps, revision) => {
      calls.push({ operation: "batch", params: { label, steps, revision } });
      const out = [];
      for (const step of steps) out.push(await documents.execute(step.operation, step.params));
      return out;
    },
    execute: async (operation, params) => {
      calls.push({ operation, params });
      if (operation === "effect.describe") return DESCRIBED;
      if (operation === "layer.effect.set") {
        const key = params.kind === "innerShadow" ? "innerShadows" : "dropShadows";
        const list = layer[key];
        const index = params.index || 0;
        if (index > list.length) throw new Error("Use an existing effect index, or the count to append.");
        list[index] = {
          ...DESCRIBED.defaults,
          kind: params.kind,
          ...(list[index] || {}),
          ...(params.params || {}),
        };
        return { layerIds: params.layerIds, kind: params.kind, index };
      }
      if (operation === "layer.effects.clear") {
        layer.dropShadows = [];
        layer.innerShadows = [];
        return { ok: true };
      }
      return { ok: true };
    },
  };
  return {
    calls,
    layer,
    documents,
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------------ maths */

test("planLayers always produces the 5-step Figma preset", () => {
  assert.equal(Shadow.STEPS, 5);
  const { layers } = Shadow.planLayers({ distance: 150, soft: 75, darkness: 100 });
  assert.equal(layers.length, 5);
  assert.deepEqual(layers.map((l) => Math.round(l.opacity * 100)), [2, 15, 50, 85, 98]);
});

test("offsets follow the distance preset", () => {
  const { layers } = Shadow.planLayers({ distance: 150, angle: 0 });
  assert.deepEqual(layers.map((l) => Math.round(l.dx)), [150, 96, 54, 24, 6]);
});

test("every shadow has its own blur, derived from distance and softness", () => {
  const atSoft = (soft) => Shadow.planLayers({ distance: 163, soft }).layers.map((l) => Math.round(l.blur));
  assert.deepEqual(atSoft(100), [46, 42, 35, 26, 14], "soft 100 % reproduces the Figma blur column");
  assert.deepEqual(atSoft(75), [35, 32, 26, 20, 11], "softness scales every blur");
  const blurs = atSoft(100);
  assert.equal(new Set(blurs).size, 5);
});

test("lighting scales every layer and caps at 100 %", () => {
  const at = (darkness) => Shadow.planLayers({ darkness }).layers.map((l) => Math.round(l.opacity * 100));
  assert.deepEqual(at(100), [2, 15, 50, 85, 98]);
  assert.deepEqual(at(45), [1, 7, 23, 38, 44]);
  assert.equal(Shadow.normalise({ darkness: 300 }).darkness, 100);
});

test("normalise clamps ranges and rejects junk values", () => {
  const params = Shadow.normalise({ angle: -10, distance: 99999, soft: 0, darkness: 900, colour: "red", kind: "glow" });
  assert.equal(params.angle, 0);
  assert.equal(params.distance, 300);
  assert.equal(params.soft, 1);
  assert.equal(params.darkness, 100);
  assert.equal(params.colour, "#000000");
  assert.equal(params.kind, "dropShadow");
  assert.equal(Shadow.DEFAULTS.soft, 75);
});

test("vectorToAngleDistance maps a drag to angle and distance", () => {
  assert.deepEqual(Shadow.vectorToAngleDistance(100, 0, 2000), { angle: 0, distance: 100 });
  assert.deepEqual(Shadow.vectorToAngleDistance(0, 50, 2000), { angle: 90, distance: 50 });
  assert.equal(Shadow.vectorToAngleDistance(5000, 0, 150).distance, 150);
});

/* ------------------------------------------------------------------ effect payloads */

test("effectColour returns the typed 0-1 colour without alpha", () => {
  assert.deepEqual(Shadow.effectColour("#FFA8A8"), {
    space: "rgb",
    r: 1,
    g: 168 / 255,
    b: 168 / 255,
  });
});

test("effectBlend converts the panel's kebab names to the schema's camelCase", () => {
  assert.equal(Shadow.effectBlend("normal"), "normal");
  assert.equal(Shadow.effectBlend("soft-light"), "softLight");
  assert.equal(Shadow.effectBlend("color-burn"), "colorBurn");
  assert.equal(Shadow.effectBlend("linear-dodge"), "linearDodge");
});

test("describeToMap walks nested wrappers, flat maps and descriptors without defaults", () => {
  const nested = Shadow.describeToMap({ descriptor: { parameters: [{ name: "opacity", default: 0.5 }] } });
  assert.equal(nested.size, 1);
  const flat = Shadow.describeToMap({ params: { angle: 30, size: 5 } });
  assert.equal(flat.size, 2);
  const real = Shadow.describeToMap(DESCRIBED);
  assert.equal(real.get("opacity").value, 0.75);
});

test("effectParams maps onto the typed effect schema", () => {
  const out = Shadow.effectParams(
    DESCRIBED,
    { distance: 42, blur: 12, opacity: 0.4 },
    { angle: 90, colour: "#112233", blend: "soft-light" },
  );
  assert.equal(out.angle, 90, "light angle for a downward shadow");
  assert.equal(out.distance, 42);
  assert.equal(out.size, 12);
  assert.equal(out.opacity, 0.4, "typed effect opacity is a fraction");
  assert.equal(out.spread, 0);
  assert.equal(out.useGlobalLight, false);
  assert.equal(out.enabled, true, "re-applying turns a removed effect back on");
  assert.equal(out.present, true, "re-applying puts it back in the layer list");
  assert.equal(out.blendMode, "softLight");
  assert.deepEqual(out.color, {
    space: "rgb",
    r: 0x11 / 255,
    g: 0x22 / 255,
    b: 0x33 / 255,
  });
});

test("effectParams throws when describe is unavailable", () => {
  assert.throws(
    () => Shadow.effectParams(null, { distance: 10, blur: 3, opacity: 0.5 }, { angle: 45, colour: "#000000" }),
    /effect.describe returned nothing/,
  );
});

test("effectAngle maps screen angles onto Photon's y-up dial", () => {
  assert.equal(Shadow.effectAngle(0), 180);
  assert.equal(Shadow.effectAngle(90), 90);
  assert.equal(Shadow.effectAngle(180), 0);
  assert.equal(Shadow.effectAngle(270), 270);
});

/* ------------------------------------------------------------------ writes */

test("applyLayerStyles writes five layer.effect.set steps in one batch", async () => {
  const api = fakeApi();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { angle: 30, distance: 150, soft: 75 },
  });

  assert.equal(result.kind, "dropShadow");
  assert.equal(result.effects, 5);
  const batch = api.calls.find((call) => call.operation === "batch");
  assert.ok(batch, "one batch");
  assert.equal(batch.params.steps.length, 5);
  assert.equal(batch.params.revision, 10);
  assert.equal(api.calls.filter((call) => call.operation === "layer.effects.set").length, 0, "never replaces all styles");
  assert.equal(api.calls.filter((call) => call.operation === "layer.duplicate").length, 0);

  assert.equal(api.layer.dropShadows.length, 5);
  assert.deepEqual(
    batch.params.steps.map((step) => step.params.index),
    [0, 1, 2, 3, 4],
  );
  for (const step of batch.params.steps) {
    assert.equal(step.operation, "layer.effect.set");
    assert.equal(step.params.kind, "dropShadow");
    assert.deepEqual(step.params.layerIds, ["src"]);
    assert.equal(step.params.params.enabled, true);
  }
  assert.ok(api.layer.dropShadows[0].distance > api.layer.dropShadows[4].distance);
  assert.equal(api.layer.dropShadows[4].opacity, 0.98);
});

test("a second apply patches the same five effects instead of stacking", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { distance: 150 } });
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { distance: 60 } });
  assert.equal(api.layer.dropShadows.length, 5, "still one ramp");
  assert.equal(api.layer.innerShadows.length, 0);
});

test("drop and inner shadows can live on the same layer", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "dropShadow" } });
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "innerShadow" } });
  assert.equal(api.layer.dropShadows.length, 5);
  assert.equal(api.layer.innerShadows.length, 5);
});

test("effectGroups lays out the 3D mode", () => {
  assert.equal(Shadow.normalise({ kind: "3dShadow" }).kind, "3dShadow");
  const params = Shadow.normalise({ angle: 30, colour: "#000000" });
  const groups = Shadow.effectGroups(
    "3dShadow",
    params,
    { dropShadow: "#ff0000", innerShadow: "#00ff00", lighting: "#ffffff" },
    {
      lighting: "screen",
      dropShadow: "multiply",
      innerShadow: "overlay",
    },
  );
  assert.deepEqual(
    groups.map((group) => [group.kind, group.offset, group.role]),
    [
      ["dropShadow", 0, "shadow"],
      ["innerShadow", 0, "shadow"],
      ["innerShadow", 5, "light"],
    ],
  );
  assert.deepEqual(
    groups.map((group) => group.blend),
    ["multiply", "overlay", "screen"],
    "each bevel keeps its own blend mode",
  );
  assert.deepEqual(
    groups.map((group) => group.colour),
    ["#ff0000", "#00ff00", "#ffffff"],
    "each bevel keeps its own colour",
  );
  assert.equal(groups[1].angle, 210, "dark bevel points away from the light");
  assert.equal(groups[2].angle, 30, "lighting ramp points at the light");
  assert.equal(groups[2].colour, "#ffffff");
});

test("3D mode writes a drop ramp and a dark plus light inner ramp", async () => {
  const api = fakeApi();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { kind: "3dShadow", angle: 30, colour: "#000000" },
    colours: { dropShadow: "#ff0000", innerShadow: "#00ff00", lighting: "#0000ff" },
    blends: { lighting: "screen", dropShadow: "multiply", innerShadow: "overlay" },
  });

  assert.equal(result.effects, 15);
  const batch = api.calls.find((call) => call.operation === "batch");
  assert.equal(batch.params.steps.length, 15);
  const drop = batch.params.steps.filter((step) => step.params.kind === "dropShadow");
  const inner = batch.params.steps.filter((step) => step.params.kind === "innerShadow");
  assert.ok(drop.every((step) => step.params.params.blendMode === "multiply"), "drop uses Blend DS");
  for (const step of inner.filter((entry) => entry.params.index < 5)) {
    assert.equal(step.params.params.blendMode, "overlay", "inner bevel uses Blend IS");
  }
  for (const step of inner.filter((entry) => entry.params.index >= 5)) {
    assert.equal(step.params.params.blendMode, "screen", "lighting uses Blend L");
  }
  assert.deepEqual(drop.map((step) => step.params.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(inner.map((step) => step.params.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const step of drop) {
    assert.deepEqual(step.params.params.color, { space: "rgb", r: 1, g: 0, b: 0 }, "drop ramp uses the drop colour");
  }
  for (const step of inner.filter((entry) => entry.params.index >= 5)) {
    assert.deepEqual(step.params.params.color, { space: "rgb", r: 0, g: 0, b: 1 }, "light ramp uses the lighting colour");
    assert.equal(step.params.params.angle, 150, "lighting ramp uses the light dial side");
  }
  for (const step of inner.filter((entry) => entry.params.index < 5)) {
    assert.deepEqual(step.params.params.color, { space: "rgb", r: 0, g: 1, b: 0 }, "dark ramp uses the inner colour");
    assert.equal(step.params.params.angle, 330, "dark ramp sits opposite the light");
  }
  assert.equal(api.layer.dropShadows.length, 5);
  assert.equal(api.layer.innerShadows.length, 10);
});

test("switching from 3D to drop removes the inner ramps in the same batch", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "3dShadow" } });
  api.calls.length = 0;
  await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { kind: "dropShadow" },
    previousKind: "3dShadow",
  });

  const batch = api.calls.find((call) => call.operation === "batch");
  const removed = batch.params.steps.filter((step) => step.params.params.present === false);
  assert.equal(removed.length, 10, "dark and light inner ramps are removed");
  assert.equal(api.layer.innerShadows.filter((effect) => effect.present === false).length, 10);
  assert.equal(api.layer.dropShadows.filter((effect) => effect.present === false).length, 0);
});

test("disableLayerShadows removes all three 3D ramps", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "3dShadow" } });
  await Shadow.disableLayerShadows(api, { documentId: "doc-1", layerId: "src", kind: "3dShadow" });
  assert.equal(api.layer.dropShadows.filter((effect) => effect.present === false).length, 5);
  assert.equal(api.layer.innerShadows.filter((effect) => effect.present === false).length, 10);
});

test("2D modes write their own blend and colour slot", async () => {
  const api = fakeApi();
  const blends = { lighting: "screen", dropShadow: "multiply", innerShadow: "overlay" };
  const colours = { dropShadow: "#ff0000", innerShadow: "#00ff00", lighting: "#0000ff" };
  await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { kind: "dropShadow" },
    blends,
    colours,
  });
  let batch = api.calls.find((call) => call.operation === "batch");
  assert.ok(
    batch.params.steps.every((step) => step.params.params.blendMode === "multiply"),
    "drop shadow mode uses Blend DS",
  );
  assert.ok(
    batch.params.steps.every((step) => step.params.params.color.r === 1),
    "drop shadow mode uses the drop colour",
  );

  api.calls.length = 0;
  await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { kind: "innerShadow" },
    blends,
    colours,
  });
  batch = api.calls.find((call) => call.operation === "batch");
  assert.ok(
    batch.params.steps.every((step) => step.params.params.blendMode === "overlay"),
    "inner shadow mode uses Blend IS",
  );
  assert.ok(
    batch.params.steps.every((step) => step.params.params.color.g === 1),
    "inner shadow mode uses the inner colour",
  );
});

test("disableLayerShadows removes the five effects from the layer list", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "dropShadow" } });
  await Shadow.disableLayerShadows(api, { documentId: "doc-1", layerId: "src", kind: "dropShadow" });

  assert.equal(api.layer.dropShadows.length, 5, "effects stay in the styles array");
  assert.equal(api.layer.dropShadows.filter((effect) => effect.present === false).length, 5);
  assert.equal(api.layer.dropShadows.filter((effect) => effect.enabled === false).length, 5);

  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "dropShadow" } });
  assert.equal(api.layer.dropShadows.filter((effect) => effect.present === false).length, 0, "apply puts them back");
  assert.equal(api.layer.dropShadows.filter((effect) => effect.enabled === false).length, 0);
  assert.equal(api.layer.dropShadows.length, 5);
});

test("disableLayerShadows only touches its own kind", async () => {
  const api = fakeApi();
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "dropShadow" } });
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: { kind: "innerShadow" } });
  await Shadow.disableLayerShadows(api, { documentId: "doc-1", layerId: "src", kind: "innerShadow" });
  assert.equal(api.layer.dropShadows.filter((effect) => effect.enabled === false).length, 0);
  assert.equal(api.layer.innerShadows.filter((effect) => effect.enabled === false).length, 5);
});

/* ------------------------------------------------------------------ runner */

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
