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
| `D px` | 1–2000 | 150 | How far the shadow travels |
| `Light %` | 1–100 | 100 | Scales every layer's opacity (Figma's Brightness) |
| `Soft px` | 1–300 | 26 | Blur at the far end |

Drag the sun to aim: the shadow falls on the **opposite** side, and an `angle° · distance px` chip
follows the pointer. The bottom bar holds the colour swatch, **Preview** and **Apply**.

Nothing is written to the document until Preview or Apply is pressed.

## Five fixed steps

The step count is fixed at 5 and the ramp is the Beautiful Shadows preset (farthest → nearest):

| Step | Offset | Blur | Opacity at Light 100 % |
| --- | --- | --- | --- |
| 1 (far) | distance × 1.00 | softness × 1.00 | 2 % |
| 2 | distance × 0.64 | softness × 0.91 | 15 % |
| 3 | distance × 0.36 | softness × 0.76 | 50 % |
| 4 | distance × 0.16 | softness × 0.57 | 85 % |
| 5 (near) | distance × 0.04 | softness × 0.30 | 98 % |

Opacity is `Light × preset`, so Light 45 % gives 1 / 7 / 23 / 38 / 44 % — the same column the Figma
plugin shows at Brightness 45 %.

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
3. **Colour encoding is verified.** `layer.effects.set` does not document its colour shape, so the
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
