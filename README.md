# Directional Shadow — Photon Studio plugin

Port of the **Directional Blur Shadow** macro for Affinity Photo (original concept by `rbonelli`,
v1.2.0), rebuilt for Photon Studio's operation API and modelled on the Figma plugin
**Beautiful Shadows**.

- Adds **five cascaded drop shadows** to the **selected layer** — no duplicate layer.
- One `layer.effects.set` call, so the result is a single undo step and stays editable in Photon's
  Layer Style panel.
- The layer's existing styles are merged, never replaced.
- **Preview** can be undone: the styles are snapshotted first and `Remove preview` writes them back.
- MIT licensed, no service, no network, no extra binaries.

## Panel

A paper stage with a draggable **light handle** (sun with rays) and a floating **Drop Shadow** sheet:

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `A °` | 0–360 | 30 | Shadow direction: 0° right, 90° down |
| `D px` | 1–300 | 150 | How far the shadow travels |
| `Light %` | 1–100 | 100 | Scales every layer's opacity (Figma's Brightness) |
| `Soft %` | 1–100 | 75 | Scales the blur of every step |
| `Type` | Drop shadow / Inner shadow | Drop shadow | Which layer style to write |
| **Apply** | button | — | Writes the five shadows to the selected layer |

Drag the sun to aim: the shadow falls on the **opposite** side, and an `angle° · distance px` chip
follows the pointer. The bottom bar holds the **colour swatch** and **Apply**; clicking the swatch
opens the plugin's own colour picker (saturation/brightness square, hue strip, hex field, OK/Cancel).

Nothing is written to the document until Apply is pressed; **Remove shadows** restores the styles
from before the last Apply. A second Apply replaces the previous result instead of stacking.

## Five fixed steps

The step count is fixed at 5 and the ramp is the Beautiful Shadows preset (farthest → nearest):

| Step | Offset | Blur | Opacity at Light 100 % |
| --- | --- | --- | --- |
| 1 (far) | distance × 1.00 | distance × 0.283 × soft | 2 % |
| 2 | distance × 0.64 | distance × 0.258 × soft | 15 % |
| 3 | distance × 0.36 | distance × 0.215 × soft | 50 % |
| 4 | distance × 0.16 | distance × 0.160 × soft | 85 % |
| 5 (near) | distance × 0.04 | distance × 0.086 × soft | 98 % |

Every shadow carries its **own** blur, derived from its distance — there is no single blur value.
At `D 163 px` and `Soft 100 %` the column is 46 / 42 / 35 / 26 / 14 px, which is exactly the Figma
plugin's blur column; dropping Soft to 50 % halves all five.

Opacity is `Light × preset`, so Light 45 % gives 1 / 7 / 23 / 38 / 44 %.

## How it talks to Photon

```
documents.active()                        → read the selected layer and its current styles
effect.describe({kind:"dropShadow"})      → learn the real parameter names and units
layer.effects.set({layerIds, styles})     → write the merged styles (existing effects + 5 new)
```

Three details that took measurement rather than guessing:

1. **Parameter names are discovered, not assumed.** Only names listed by `effect.describe` are sent;
   units follow the host's own defaults (opacity default `75` means percent, `0.75` means a fraction).
   Positional hosts (`x`/`y`, like the Figma plugin) are supported too.
2. **Angle is the light direction on a Photoshop dial** (0° right, 90° up), so a shadow pointing at
   θ is written as `180 − θ`. `effectAngle` is unit-tested for 0/90/180/270 and 32.1 → 147.9.
3. **Colour encoding is verified.** The first attempt is the PSD-style `{r,g,b,a}` object with
   **0–255** integers (how a Photoshop-family document stores a layer style), then the 0–1
   `{space:"rgb"}` object, then bare `RRGGBB`, then `#RRGGBB` — see next point. `layer.effects.set` does not document its colour shape, so the
   write is read back: if the colour did not stick, the plugin retries with the next encoding
   (`{space:"rgb"}` object → bare `RRGGBB` → `#RRGGBB`) and stops at the first one the host keeps.
   When the document model does not expose styles, the RGB object (the same shape `pixels.fill`
   accepts) is kept.

## Using it

1. Select one layer (raster, text, shape — anything with a silhouette).
2. Open **Plugins → Directional Blur Shadow…** (`Ctrl+Shift+D`).
3. Drag the sun or type values, press **Preview**.
4. **Apply** keeps the result; **Remove preview** restores the styles from before the preview.
5. The last values are remembered in the plugin's settings.

## Limits

- There is no "remove one effect" operation in the API, so `Remove preview` restores the whole
  styles snapshot rather than deleting individual effects.
- Preview writes to the layer immediately; that is the trade-off for not duplicating it.
- Shadows are layer styles, so a very large `Soft` value is limited by the host's blur range.

## Testing

```powershell
node tools/shadow-test.cjs     # 18 tests
node tools/bench.cjs           # pure-maths µs and operation counts
```

The suite covers the preset maths (including the Figma opacity column at 100/45 %), the angle
conversion, parameter mapping for angular and positional hosts, the colour-encoding retry loop, the
styles snapshot/restore, and the single-write pipeline. A Preview sends **4 operations** in total
(`documents.active` ×2, `effect.describe`, `layer.effects.set`).

## Changelog

### 0.14.1

- If `effect.describe` lists only the numeric parameters, the colour is still written under the
  documented Photoshop key `color` (then verified/retried like the described case) instead of being
  dropped from the payload — a payload without a colour key is why a picked colour could keep the
  host's black default.

### 0.14.0

- **Custom colour picker.** The native `<input type="color">` is gone: the swatch now opens a panel
  picker with a saturation/brightness square, a hue strip, a hex field and OK/Cancel
  (`plugin/colour.js`, unit-tested).
- **The colour is sent as a PSD-style `{r,g,b,a}` 0–255 object first**, then the 0–1 rgb object, then
  bare hex, then `#hex`; each attempt is read back and the next is tried when the colour did not
  stick. `sameColour` compares both scales.
- Tests: 26 (20 shadow + 6 colour).

### 0.13.1

- **Preview removed.** With the styles written in a single call, Apply and Preview did the same work;
  there is now one **Apply** button, and **Remove shadows** restores the snapshot taken before it.
  Applying again replaces the previous result instead of stacking shadows.

### 0.13.0

- **Blur per shadow, derived from distance.** Each of the five steps now gets
  `distance × ratio × soft`, with the Figma ratios 0.283 / 0.258 / 0.215 / 0.160 / 0.086. At
  `D 163 px` and `Soft 100 %` that reproduces the plugin's 46 / 42 / 35 / 26 / 14 px column.
- **Soft is a percentage (1–100 %, default 75)**, not pixels: it scales all five blurs at once.
- New **Type** dropdown: **Drop shadow** (default) or **Inner shadow**. Inner shadows are written to
  `styles.innerShadows` instead of `styles.dropShadows`, and the canvas preview clips them inside the
  card.
- Tests: 19.

### 0.12.2

- Softness is now **75 px** by default and capped at **75 px** (was 1–300).

### 0.12.1

- Distance is capped at **300 px** (was 2000): the field, the clamp and the drag handle all agree.

### 0.12.0

- **Advanced section removed.** No mode switch, no angle-convention switch, no colour-format switch,
  no taper/rasterize fields — the panel is the stage, the Drop Shadow sheet and three actions.
- The copies mode is gone with it: the plugin always writes drop-shadow layer styles to the selected
  layer, which is what the panel promised.
- Colour is now sent as an `{space:"rgb"}` object first and **verified by reading the styles back**,
  falling back to bare hex and `#hex` only when the host did not keep it.
- Preview is down to **4 operations**.
- Tests: 18.

### 0.11.0

- Five steps fixed (Layers field removed), presets for offset/blur/opacity, Lighting capped at 100 %.

### 0.10.x

- Effects applied to the selected layer through `layer.effects.set` (no duplicate), styles snapshot
  for undo, Photoshop light-angle conversion (`180 − θ`), colour-parameter discovery.

## License

MIT — see [LICENSE](LICENSE). The original Affinity macro concept is by `rbonelli`; this is an
independent reimplementation for Photon Studio.
