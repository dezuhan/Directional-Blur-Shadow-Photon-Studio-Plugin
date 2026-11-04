#!/usr/bin/env node
/*
 * Tests for the custom colour picker maths:  node tools/colour-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Colour = require(path.join(__dirname, "..", "plugin", "colour.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("normaliseHex accepts #rrggbb, rrggbb and #rgb", () => {
  assert.equal(Colour.normaliseHex("#ffa8a8"), "#FFA8A8");
  assert.equal(Colour.normaliseHex("ffa8a8"), "#FFA8A8");
  assert.equal(Colour.normaliseHex("#f00"), "#FF0000");
  assert.equal(Colour.normaliseHex("nope"), null);
  assert.equal(Colour.normaliseHex(""), null);
});

test("hex <-> rgb round-trips", () => {
  const rgb = Colour.hexToRgb("#FFA8A8");
  assert.deepEqual(rgb, { r: 255, g: 168, b: 168 });
  assert.equal(Colour.rgbToHex(rgb), "#FFA8A8");
});

test("rgb <-> hsv round-trips on the primaries", () => {
  const red = Colour.rgbToHsv({ r: 255, g: 0, b: 0 });
  assert.equal(red.h, 0);
  assert.equal(red.s, 1);
  assert.equal(red.v, 1);

  const green = Colour.rgbToHsv({ r: 0, g: 255, b: 0 });
  assert.equal(green.h, 120);

  const blue = Colour.rgbToHsv({ r: 0, g: 0, b: 255 });
  assert.equal(blue.h, 240);

  const grey = Colour.rgbToHsv({ r: 128, g: 128, b: 128 });
  assert.equal(grey.s, 0);
  assert.equal(Colour.rgbToHex(Colour.hsvToRgb(red)), "#FF0000");
  assert.equal(Colour.rgbToHex(Colour.hsvToRgb(green)), "#00FF00");
  assert.equal(Colour.rgbToHex(Colour.hsvToRgb(blue)), "#0000FF");
});

test("hsvToRgb handles the pink from the picker", () => {
  const rgb = Colour.hexToRgb("#FFA8A8");
  const hsv = Colour.rgbToHsv(rgb);
  assert.ok(Math.abs(hsv.h - 0) < 1e-9);
  assert.ok(Math.abs(hsv.s - 0.3412) < 0.001);
  assert.ok(Math.abs(hsv.v - 1) < 1e-9);
  assert.equal(Colour.rgbToHex(Colour.hsvToRgb(hsv)), "#FFA8A8");
});

test("pointToSaturation maps the square", () => {
  assert.deepEqual(Colour.pointToSaturation(0, 0, 100, 100), { s: 0, v: 1 });
  assert.deepEqual(Colour.pointToSaturation(100, 100, 100, 100), { s: 1, v: 0 });
  const middle = Colour.pointToSaturation(50, 50, 100, 100);
  assert.equal(middle.s, 0.5);
  assert.equal(middle.v, 0.5);
  // out-of-range clicks are clamped
  assert.deepEqual(Colour.pointToSaturation(-10, 200, 100, 100), { s: 0, v: 0 });
});

test("pointToHue maps the strip", () => {
  assert.equal(Colour.pointToHue(0, 120), 0);
  assert.equal(Colour.pointToHue(120, 120), 360);
  assert.equal(Colour.pointToHue(60, 120), 180);
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
