#!/usr/bin/env node
/*
 * Performance check for the Directional Shadow plugin.
 *   node tools/bench.cjs
 *
 * Measures the pure maths, the operation count each action sends to Photon, and a simulated
 * round-trip cost so the hot paths are visible instead of guessed.
 */
"use strict";

const path = require("node:path");
const Shadow = require(path.join(__dirname, "..", "plugin", "shadow.js"));

function time(label, iterations, fn) {
  fn(); // warm up
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const perCallMs = elapsedMs / iterations;
  console.log(
    label.padEnd(38) +
      String(iterations).padStart(7) + "x  " +
      perCallMs.toFixed(4).padStart(8) + " ms/call  " +
      (perCallMs * 1000).toFixed(1).padStart(8) + " us/call",
  );
  return perCallMs;
}

/* ---------------- fake API that counts operations ---------------- */

function countingApi(latencyMs) {
  const calls = [];
  let nextId = 0;
  const layers = [{ id: "src" }, { id: "bg" }];
  const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs || 0));
  return {
    calls,
    documents: {
      active: async () => {
        calls.push("documents.active");
        await wait();
        return { id: "doc-1", width: 1080, height: 1350, layers: layers.map((l) => ({ ...l })) };
      },
      execute: async (operation, params) => {
        calls.push(operation);
        await wait();
        if (operation === "effect.describe") {
          return {
            params: [
              { name: "blendMode", default: "normal" },
              { name: "opacity", default: 75 },
              { name: "angle", default: 120 },
              { name: "distance", default: 5 },
              { name: "spread", default: 0 },
              { name: "size", default: 5 },
              { name: "color", default: "#000000" },
            ],
          };
        }
        if (operation === "layer.duplicate") {
          const id = "dup" + ++nextId;
          layers.unshift({ id });
          return { layerIds: [id] };
        }
        if (operation === "layer.group") return { layerIds: ["group1"] };
        return { ok: true };
      },
    },
  };
}

(async () => {
  console.log("=== pure maths ===");
  time("planLayers (5 layers)", 20000, () => Shadow.planLayers({ steps: 5 }));
  time("planLayers (30 layers)", 20000, () => Shadow.planLayers({ steps: 30 }));
  time("planLayers direct mode", 20000, () => Shadow.planLayers({ steps: 5 }, "direct"));
  time("taperMatrix", 50000, () => Shadow.taperMatrix(0.5, 0.9, 100, 100));
  time("vectorToAngleDistance", 50000, () => Shadow.vectorToAngleDistance(30, 40, 2000));

  console.log("\n=== operations per action (5 layers) ===");
  for (const steps of [3, 5, 10, 30]) {
    const fx = countingApi(0);
    await Shadow.buildWithEffects(fx, {
      documentId: "doc-1",
      sourceLayerId: "src",
      params: { steps },
    });
    const counts = fx.calls.reduce((acc, op) => ((acc[op] = (acc[op] || 0) + 1), acc), {});
    const total = fx.calls.length;
    const effectSets = counts["layer.effect.set"] || 0;
    console.log(
      "effects mode  steps=" + String(steps).padStart(2) +
        "  total ops=" + String(total).padStart(3) +
        "  effect.set=" + String(effectSets).padStart(2) +
        "  duplicate=" + (counts["layer.duplicate"] || 0) +
        "  describe=" + (counts["effect.describe"] || 0),
    );
  }

  for (const steps of [5, 10]) {
    const fx = countingApi(0);
    await Shadow.buildShadow(fx, {
      documentId: "doc-1",
      sourceLayerId: "src",
      params: { steps, taper: false, rasterize: true },
    });
    const counts = fx.calls.reduce((acc, op) => ((acc[op] = (acc[op] || 0) + 1), acc), {});
    console.log(
      "copies mode   steps=" + String(steps).padStart(2) +
        "  total ops=" + String(fx.calls.length).padStart(3) +
        "  fill=" + (counts["pixels.fill"] || 0) +
        "  blur=" + (counts["filter.blur.gaussianBlur"] || 0) +
        "  update=" + (counts["layer.update"] || 0) +
        "  move=" + (counts["layer.move"] || 0),
    );
  }

  console.log("\n=== simulated latency (effects mode, 5 layers) ===");
  for (const latency of [0, 1, 3, 8, 20]) {
    const fx = countingApi(latency);
    const started = process.hrtime.bigint();
    await Shadow.buildWithEffects(fx, {
      documentId: "doc-1",
      sourceLayerId: "src",
      params: { steps: 5 },
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      "round-trip " + String(latency).padStart(2) + " ms/op  →  " +
        String(fx.calls.length).padStart(2) + " ops  →  " + ms.toFixed(1) + " ms per Preview",
    );
  }

  console.log("\n=== shadow ramp actually sent (direct mode, defaults) ===");
  const { layers } = Shadow.planLayers({ steps: 5, distance: 150, blur: 26 }, "direct");
  for (const layer of layers) {
    console.log(
      "offset " + String(Math.round(Math.hypot(layer.dx, layer.dy))).padStart(4) + " px" +
        "  blur " + String(Math.round(layer.blur)).padStart(3) + " px" +
        "  opacity " + (layer.opacity * 100).toFixed(0).padStart(3) + "%",
    );
  }
})();
