![Directional Shadow applied in Photon Studio](docs/photon.png)

# Directional Shadow — Photon Studio plugin

Soft directional shadow for any layer, modelled on the Figma plugin **Beautiful Shadows** and the
Affinity Photo macro *Directional Blur Shadow* (original concept by `rbonelli`).

Apply adds **five cascaded layer styles** to the selected layer in one `layer.effects.set` call, so
the result is a single undo step, stays editable in Photon's Layer Style panel, and never duplicates
the layer.

## Screenshots

| Drop shadow (default) | Colour picker | Inner shadow |
| --- | --- | --- |
| ![Drop shadow panel](docs/panel.png) | ![Colour picker](docs/picker.png) | ![Inner shadow mode](docs/inner.png) |

## Design system

Panel styling, components and tokens follow [`../design-system`](../design-system/README.md):
24 px controls, 7 px control radius, 12 px floating surfaces, the canonical `select.js`
dropdown and the shared header/footer contract.

## Install

1. Photon Studio → **Preferences → Plug-ins → Install plugin** → select this repository's
   `plugin/` folder.
2. Select a layer and open **Plugins → Directional Blur Shadow…** (`Ctrl+Shift+D`).

No service, no network, no dependencies.

## Use

Drag the sun to aim the shadow (it falls on the opposite side), then press **Apply**.
**Remove shadows** restores the styles from before the last Apply; applying again replaces the
previous result instead of stacking.

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `A °` | 0–360 | 30 | Shadow direction: 0° right, 90° down |
| `D px` | 1–300 | 150 | How far the shadow travels |
| `Light %` | 1–100 | 100 | Scales every layer's opacity |
| `Soft %` | 1–100 | 75 | Scales the blur of every step |
| `Type` | Drop / Inner shadow | Drop | Which layer style to write |
| swatch | picker | black | Shadow colour (own HSV picker, verified against Photon) |

Five fixed steps (farthest → nearest). Offsets are `distance × 1 / .64 / .36 / .16 / .04`, opacities
`lighting × 2 / 15 / 50 / 85 / 98 %`, and each shadow has its **own blur**:
`distance × .283 / .258 / .215 / .160 / .086 × soft`. At `D 163 px` and `Soft 100 %` that is
46 / 42 / 35 / 26 / 14 px — the Figma plugin's own column.

Photon's shadow angle is the **light** direction on a Photoshop dial (0° right, 90° up), so a shadow
pointing at θ is written as `180 − θ`.

## Testing

```powershell
node tools/shadow-test.cjs     # 21 tests: presets, angle, payloads, styles
node tools/colour-test.cjs     # 6 tests: hex/rgb/hsv maths for the picker
node tools/bench.cjs           # operation counts and maths timings
```

An Apply sends four operations: `documents.active` ×2, `effect.describe`, `layer.effects.set`.

## Limits

- Use **Apply** to commit; the canvas preview is an approximation, not a render of the result.
- Layer styles cannot be removed individually by the plugin API, so **Remove shadows** restores the
  whole styles snapshot.

MIT licensed — see [LICENSE](LICENSE).

## Changelog

### 0.14.3

- Removed the dashed guide line between the card and the light handle; the handle and sun rays
  stay, and the preview is cleaner.

### 0.14.2

- Header now carries the design-system activity word (`Idle · Ready`) alongside the badge.
- The shadow Type dropdown uses the canonical `select.js` component (custom glass menu)
  instead of the native OS menu.

