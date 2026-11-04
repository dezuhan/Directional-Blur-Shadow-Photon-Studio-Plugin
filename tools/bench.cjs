#!/usr/bin/env node
/*
 * Performance check for the Directional Shadow plugin:  node tools/bench.cjs
 */
"use strict";

const path = require("node:path");
const Shadow = require(path.join(__dirname, "..", "plugin", "shadow.js"));

function time(label, iterations, fn) {
  fn();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn();
  const us = Number(process.hrtime.bigint() - started) / 1e3 / iterations;
  console.log(label.padEnd(38) + us.toFixed(2).padStart(8) + " us/call");
  return us;
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

function countingApi(latencyMs) {
  const calls = [];
  const layer = { id: "src" };
  const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs || 0));
  return {
    calls,
    documents: {
      active: async () => {
        calls.push("documents.active");
        await wait();
        return { id: "doc-1", layers: [{ ...layer }, { id: "bg" }] };
      },
      execute: async (operation, params) => {
        calls.push(operation);
        await wait();
        if (operation === "effect.describe") return DESCRIBED;
        if (operation === "layer.effects.set") {
          layer.styles = params.styles;
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };
}

(async () => {
  console.log("=== pure maths ===");
  time("planLayers (5 steps)", 20000, () => Shadow.planLayers({}));
  time("effectAngle", 50000, () => Shadow.effectAngle(32.1));
  time("vectorToAngleDistance", 50000, () => Shadow.vectorToAngleDistance(30, 40, 2000));

  console.log("\n=== operations per Preview ===");
  const api = countingApi(0);
  await Shadow.applyLayerStyles(api, { documentId: "doc-1", layerId: "src", params: {} });
  const counts = api.calls.reduce((acc, op) => ((acc[op] = (acc[op] || 0) + 1), acc), {});
  console.log("total ops " + api.calls.length + "  " + JSON.stringify(counts));

  console.log("\n=== simulated latency (5 shadows) ===");
  for (const latency of [0, 1, 3, 8]) {
    const run = countingApi(latency);
    const started = process.hrtime.bigint();
    await Shadow.applyLayerStyles(run, { documentId: "doc-1", layerId: "src", params: {} });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log("round-trip " + String(latency).padStart(2) + " ms/op  ->  " + run.calls.length + " ops  ->  " + ms.toFixed(1) + " ms");
  }
})();
