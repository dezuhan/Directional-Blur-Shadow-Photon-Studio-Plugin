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

/**
 * Fake host. `acceptColour(kind)` decides whether the simulated host stores the colour for that
 * encoding, which is how the verification loop inside applyLayerStyles is exercised.
 */
function fakeApi(options) {
  const settings = options || {};
  const calls = [];
  const layer = { id: "src" };
  if (settings.styles) layer.styles = JSON.parse(JSON.stringify(settings.styles));
  const layers = [layer, { id: "bg" }];
  const accept = settings.acceptColour || (() => true);

  const api = {
    calls,
    documents: {
      active: async () => ({ id: "doc-1", width: 800, height: 600, layers: layers.map((l) => ({ id: l.id })) }),
      execute: async (operation, params) => {
        calls.push({ operation, params });
        if (operation === "effect.describe") return DESCRIBED;
        if (operation === "inspect") {
          return {
            layers: layers.map((l) =>
              l.styles ? { id: l.id, styles: JSON.parse(JSON.stringify(l.styles)) } : { id: l.id },
            ),
          };
        }
        if (operation === "layer.effects.set") {
          const previous = layer.styles
            ? JSON.parse(JSON.stringify(layer.styles))
            : { dropShadows: [], innerShadows: [] };
          const key =
            (params.styles.innerShadows || []).length > (previous.innerShadows || []).length
              ? "innerShadows"
              : "dropShadows";
          const added = params.styles[key].slice((previous[key] || []).length);
          const first = added[0] || {};
          const value = first.color === undefined ? first.colour : first.color;
          const encoding =
            typeof value === "object"
              ? value.r > 1 || value.a > 1
                ? "rgb255"
                : "rgb"
              : String(value).startsWith("#")
                ? "hex"
                : "hex-bare";
          const stored = JSON.parse(JSON.stringify(params.styles));
          if (!accept(encoding)) {
            const start = (previous[key] || []).length;
            for (let index = start; index < stored[key].length; index += 1) {
              stored[key][index] = { ...stored[key][index], color: "000000", colour: "000000" };
            }
          }
          layer.styles = stored;
          return { ok: true };
        }
        if (operation === "layer.effects.clear") {
          delete layer.styles;
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };
  return api;
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
  assert.deepEqual(atSoft(50), [23, 21, 18, 13, 7]);
  // blur is per shadow, not one shared value
  const blurs = atSoft(100);
  assert.equal(new Set(blurs).size, 5);
  for (let index = 1; index < blurs.length; index += 1) {
    assert.ok(blurs[index] < blurs[index - 1], "nearer shadows blur less");
  }
});

test("lighting scales every layer and caps at 100 %", () => {
  const at = (darkness) => Shadow.planLayers({ darkness }).layers.map((l) => Math.round(l.opacity * 100));
  assert.deepEqual(at(100), [2, 15, 50, 85, 98]);
  assert.deepEqual(at(45), [1, 7, 23, 38, 44], "matches the Figma plugin at Brightness 45 %");
  assert.equal(Shadow.normalise({ darkness: 300 }).darkness, 100);
  assert.deepEqual(at(300), at(100));
});

test("normalise clamps ranges and rejects junk values", () => {
  const params = Shadow.normalise({ angle: -10, distance: 99999, soft: 0, darkness: 900, colour: "red", kind: "glow" });
  assert.equal(params.angle, 0, "angles are clamped, not wrapped");
  assert.equal(params.distance, 300);
  assert.equal(params.soft, 1);
  assert.equal(params.darkness, 100);
  assert.equal(params.colour, "#000000");
  assert.equal(params.kind, "dropShadow", "unknown kinds fall back to drop shadow");
  assert.equal(Shadow.normalise({ soft: 999 }).soft, 100, "softness is a percentage");
  assert.equal(Shadow.DEFAULTS.soft, 75);
  assert.equal(Shadow.DEFAULTS.kind, "dropShadow");
});

test("rgba() converts hex to Photon colour", () => {
  assert.deepEqual(Shadow.rgba("#000000"), { space: "rgb", r: 0, g: 0, b: 0, a: 1 });
  const half = Shadow.rgba("#336699", 0.5);
  assert.ok(Math.abs(half.r - 0x33 / 255) < 1e-9);
  assert.equal(half.a, 0.5);
});

test("vectorToAngleDistance maps a drag to angle and distance", () => {
  assert.deepEqual(Shadow.vectorToAngleDistance(100, 0, 2000), { angle: 0, distance: 100 });
  assert.deepEqual(Shadow.vectorToAngleDistance(0, 50, 2000), { angle: 90, distance: 50 });
  assert.equal(Shadow.vectorToAngleDistance(-10, -10, 2000).angle, 225);
  assert.equal(Shadow.vectorToAngleDistance(5000, 0, 150).distance, 150);
});

/* ------------------------------------------------------------------ effect description */

test("describeToMap walks nested wrappers, flat maps and descriptors without defaults", () => {
  const nested = Shadow.describeToMap({ descriptor: { parameters: [{ name: "opacity", default: 0.5 }] } });
  assert.equal(nested.size, 1);

  const flat = Shadow.describeToMap({ params: { angle: 30, size: 5, color: "000000" } });
  assert.equal(flat.size, 3);

  const noDefault = Shadow.describeToMap({ params: [{ name: "color" }, { name: "angle", default: 120 }] });
  assert.equal(noDefault.size, 2);
});

test("effectParams maps onto the host's parameter names", () => {
  const out = Shadow.effectParams(DESCRIBED, { distance: 42, blur: 12, opacity: 0.4 }, { angle: 90, colour: "#112233" });
  assert.equal(out.angle, 90, "light angle for a downward shadow");
  assert.equal(out.distance, 42);
  assert.equal(out.size, 12);
  assert.equal(out.opacity, 40, "percent host");
  assert.equal(out.spread, 0);
});

test("normalise keeps a supported blend mode and falls back to normal", () => {
  assert.equal(Shadow.normalise({ blend: "multiply" }).blend, "multiply");
  assert.equal(Shadow.normalise({ blend: "nope" }).blend, "normal");
  assert.ok(Shadow.BLEND_MODES.includes("color-dodge"));
  assert.ok(Shadow.BLEND_MODES.includes("luminosity"));
});

test("effectParams forwards the selected blend mode", () => {
  const out = Shadow.effectParams(
    DESCRIBED,
    { distance: 10, blur: 4, opacity: 0.5 },
    { angle: 0, colour: "#000000", blend: "multiply" },
  );
  assert.equal(out.blendMode, "multiply");

  const fallback = Shadow.effectParams(DESCRIBED, { distance: 10, blur: 4, opacity: 0.5 }, { angle: 0, colour: "#000000" });
  assert.equal(fallback.blendMode, "normal", "uses the host default when no blend is selected");
});

test("effectParams supports positional X/Y hosts", () => {
  const host = {
    params: [
      { name: "x", default: 2 },
      { name: "y", default: 6 },
      { name: "blur", default: 14 },
      { name: "color", default: "000000" },
      { name: "opacity", default: 44 },
    ],
  };
  const out = Shadow.effectParams(host, { distance: 100, blur: 20, opacity: 0.4 }, { angle: 90, colour: "#000000" });
  assert.ok(Math.abs(out.x) < 1e-9 && Math.abs(out.y - 100) < 1e-9);
  assert.equal(out.blur, 20);
  assert.equal(out.angle, undefined);
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
  assert.ok(Math.abs(Shadow.effectAngle(32.1) - 147.9) < 1e-9);
});

test("colour encodings are all available", () => {
  const at = (format) =>
    Shadow.effectParams(DESCRIBED, { distance: 5, blur: 5, opacity: 0.5 }, { angle: 0, colour: "#ff0000" }, { colourFormat: format })
      .color;
  assert.equal(at("hex"), "#FF0000");
  assert.equal(at("hex-bare"), "FF0000");
  assert.deepEqual(at("rgb"), { space: "rgb", r: 1, g: 0, b: 0, a: 1 });
});

test("sameColour compares strings and objects", () => {
  assert.equal(Shadow.sameColour("ff0000", "#FF0000"), true);
  assert.equal(Shadow.sameColour({ space: "rgb", r: 1, g: 0, b: 0, a: 1 }, { space: "rgb", r: 1, g: 0, b: 0, a: 1 }), true);
  assert.equal(Shadow.sameColour("ff0000", "000000"), false);
});

/* ------------------------------------------------------------------ layer styles */

test("applyLayerStyles writes five drop shadows onto the selected layer", async () => {
  const api = fakeApi();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { angle: 30, distance: 150, soft: 75 },
  });

  assert.equal(result.kind, "dropShadow");
  assert.equal(result.effects, 5);
  assert.equal(result.colourFormat, "rgb255", "PSD-style 0-255 colour is tried first");
  assert.equal(api.calls.filter((c) => c.operation === "layer.duplicate").length, 0, "no duplicate layer");
  assert.equal(api.calls.find((c) => c.operation === "effect.describe").params.kind, "dropShadow");

  const sets = api.calls.filter((c) => c.operation === "layer.effects.set");
  assert.equal(sets.length, 1, "one atomic write");
  const shadows = sets[0].params.styles.dropShadows;
  assert.equal(shadows.length, 5);
  assert.ok(shadows[0].distance > shadows[4].distance);
  assert.equal(shadows[4].opacity, 98);
  assert.ok(shadows[0].size > shadows[4].size, "farther shadow blurs more");
  assert.equal(sets[0].params.styles.innerShadows.length, 0, "drop shadow mode leaves inner shadows alone");
});

test("applyLayerStyles writes inner shadows into styles.innerShadows", async () => {
  const api = fakeApi();
  const result = await Shadow.applyLayerStyles(api, {
    documentId: "doc-1",
    layerId: "src",
    params: { kind: "innerShadow" },
  });

  assert.equal(result.kind, "innerShadow");
  assert.equal(api.calls.find((c) => c.operation === "effect.describe").params.kind, "innerShadow");
  const set = api.calls.find((c) => c.operation === "layer.effects.set");
  assert.equal(set.params.styles.innerShadows.length, 5);
  assert.equal(set.params.styles.dropShadows.length, 0);
});

test("applyLayerStyles keeps the layer's existing effects", async () => {
  const existing = Shadow.emptyStyles();
  existing.dropShadows = [{ distance: 9, size: 4, angle: 100, opacity: 20, color: "000000" }];
  const api = fakeApi({ styles: existing });
  const result = await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: {} });

  const set = api.calls.find((c) => c.operation === "layer.effects.set");
  assert.equal(set.params.styles.dropShadows.length, 6, "existing shadow + 5 new");
  assert.deepEqual(set.params.styles.dropShadows[0], existing.dropShadows[0]);
  assert.equal(result.stylesBefore.dropShadows.length, 1);
});

test("applyLayerStyles retries the colour encoding until it sticks", async () => {
  const api = fakeApi({ acceptColour: (encoding) => encoding === "rgb" });
  const result = await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: {} });

  const sets = api.calls.filter((c) => c.operation === "layer.effects.set");
  assert.equal(sets.length, 2, "rgb255 rejected, the 0-1 rgb object accepted");
  assert.equal(result.colourFormat, "rgb");
});

test("readLayerStyles finds a layer nested inside a group", async () => {
  const styles = Shadow.emptyStyles();
  styles.dropShadows = [{ distance: 7 }];
  const api = {
    documents: {
      execute: async (operation) =>
        operation === "inspect"
          ? { layers: [{ id: "group", children: [{ id: "src", styles }] }] }
          : { ok: true },
    },
  };
  const found = await Shadow.readLayerStyles(api, "doc-1", "src");
  assert.equal(found.dropShadows.length, 1);
});

test("restoreLayerStyles puts the snapshot back", async () => {
  const existing = Shadow.emptyStyles();
  existing.dropShadows = [{ distance: 9 }];
  const api = fakeApi({ styles: existing });
  await Shadow.restoreLayerStyles(api, "doc-1", "src", existing);
  const set = api.calls.find((c) => c.operation === "layer.effects.set");
  assert.deepEqual(set.params.styles, existing);

  const cleared = fakeApi();
  await Shadow.restoreLayerStyles(cleared, "doc-1", "src", null);
  assert.equal(cleared.calls.filter((c) => c.operation === "layer.effects.clear").length, 1);
});

/* ------------------------------------------------------------------ runner */


test("colour encodings include the PSD 0-255 form", () => {
  const host = {
    params: [
      { name: "color", default: "000000" },
      { name: "opacity", default: 75 },
      { name: "angle", default: 120 },
      { name: "distance", default: 5 },
      { name: "size", default: 5 },
    ],
  };
  const at = (format) =>
    Shadow.effectParams(host, { distance: 5, blur: 5, opacity: 0.5 }, { angle: 0, colour: "#FFA8A8" }, { colourFormat: format }).color;
  assert.deepEqual(at("rgb255"), { r: 255, g: 168, b: 168, a: 255 });
  assert.equal(at("hex-bare"), "FFA8A8");
  assert.deepEqual(at("rgb"), { space: "rgb", r: 1, g: 168 / 255, b: 168 / 255, a: 1 });
  assert.equal(Shadow.sameColour({ r: 255, g: 168, b: 168, a: 255 }, { r: 255, g: 168, b: 168, a: 255 }), true);
});


test("the colour is still sent when describe lists no colour parameter", () => {
  const host = {
    params: [
      { name: "opacity", default: 75 },
      { name: "angle", default: 120 },
      { name: "distance", default: 5 },
      { name: "size", default: 5 },
    ],
  };
  const out = Shadow.effectParams(host, { distance: 10, blur: 5, opacity: 0.5 }, { angle: 0, colour: "#FFA8A8" }, { colourFormat: "rgb255" });
  assert.deepEqual(out.color, { r: 255, g: 168, b: 168, a: 255 });
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
