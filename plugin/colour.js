/*
 * Colour maths for the panel's custom picker.
 *
 * The picker is drawn by the plugin (no native <input type="color">), so the conversions live here
 * and are unit-tested: hex ↔ rgb, rgb ↔ hsv, and the map from the picker rectangles to values.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonColour = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  function normaliseHex(input) {
    let value = String(input || "").trim().replace(/^#/, "").toUpperCase();
    if (/^[0-9A-F]{3}$/.test(value)) {
      value = value
        .split("")
        .map((character) => character + character)
        .join("");
    }
    return /^[0-9A-F]{6}$/.test(value) ? "#" + value : null;
  }

  function hexToRgb(hex) {
    const value = normaliseHex(hex) || "#000000";
    return {
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16),
    };
  }

  function rgbToHex(rgb) {
    const part = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
    return ("#" + part(rgb.r) + part(rgb.g) + part(rgb.b)).toUpperCase();
  }

  /** rgb (0-255) → {h: 0-360, s: 0-1, v: 0-1}. */
  function rgbToHsv(rgb) {
    const r = clamp(rgb.r, 0, 255) / 255;
    const g = clamp(rgb.g, 0, 255) / 255;
    const b = clamp(rgb.b, 0, 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : delta / max, v: max };
  }

  /** hsv → rgb (0-255). */
  function hsvToRgb(hsv) {
    const h = ((clamp(hsv.h, 0, 360) % 360) + 360) % 360;
    const s = clamp(hsv.s, 0, 1);
    const v = clamp(hsv.v, 0, 1);
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  /**
   * Map a click inside the saturation/value square to {s, v}.
   * x: 0 = left (no saturation) → 1 = right (full saturation); y: 0 = top (full value) → 1 = bottom.
   */
  function pointToSaturation(x, y, width, height) {
    return {
      s: clamp(width ? x / width : 0, 0, 1),
      v: 1 - clamp(height ? y / height : 0, 0, 1),
    };
  }

  /** Map a click on the hue strip to a hue in degrees (0 at the top). */
  function pointToHue(y, height) {
    return clamp(height ? y / height : 0, 0, 1) * 360;
  }

  return {
    clamp,
    normaliseHex,
    hexToRgb,
    rgbToHex,
    rgbToHsv,
    hsvToRgb,
    pointToSaturation,
    pointToHue,
  };
});
