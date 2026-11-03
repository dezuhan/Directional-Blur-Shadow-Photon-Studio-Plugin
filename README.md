# Directional Shadow — Photon Studio plugin

Port of the **Directional Blur Shadow** macro for Affinity Photo (original concept by
`rbonelli`, v1.2.0) to Photon Studio's plugin API. It builds a shadow that moves away from the
selected layer in a chosen direction, blurring, fading and optionally tapering as it goes.

- MIT licensed, free and open source.
- **Preview first**: build the whole shadow, look at it, discard it if you do not like it.
- Everything runs through Photon's own operations — no service, no network, no extra binary.

## Controls

| Control | Range | Default | Meaning |
| --- | --- | --- | --- |
| Angle (°) | 0–360 | 30 | 0° = right, 90° = down (clockwise on screen) |
| Distance (px) | 1–2000 | 150 | How far the shadow travels from the layer |
| Layers | 3–30 | 10 | Number of stacked copies; more = smoother, never darker |
| Max blur (px) | 1–300 | 25 | Blur at the far end of the shadow |
| Colour | hex | #000000 | Silhouette colour |
| Overall darkness (%) | 10–300 | 100 | Multiplies the whole falloff |
| Start opacity (%) | 1–100 | 100 | Opacity target nearest the layer |
| End opacity (%) | 0–100 | 30 | Opacity target at the far end |
| Taper (narrow/expand) | on/off | off | Scales each copy perpendicular to the direction |
| Size at tip (%) | 1–500 | 90 | Taper amount at the far end |
| Rasterize into one layer | on/off | on | Applied only when you press Apply |

## How it maps to Photon operations

| Affinity (JSX) | Photon plugin operation |
| --- | --- |
| `createTransform(..., {duplicateNodes:true})` | `layer.duplicate` |
| `ColourOverlayLayerEffect` | `pixels.fill` with `preserveTransparency: true` |
| `GaussianBlurLayerEffect` | `filter.blur.gaussianBlur` (`params.radius`) |
| `createSetOpacity` | `layer.update` (`properties.opacity`) |
| `createTransform` translate | `layer.translate` |
| taper (rotate → scale → rotate) | `core.canvas.applyLayerTransform` (6-value affine matrix) |
| `AddChildNodesCommandBuilder` container | `layer.group` + `layer.update` (rename) |
| `createRasteriseObjects` | `layer.rasterize` (`target: "layer"`) |
| "place behind the object" | `layer.move` with the index computed from the detected stack order |

The opacity curve is the same one the Affinity version converged on: each layer gets
`raw = 1 − (1 − target)^(1 / steps)` and the overall darkness is applied **after** that
normalisation, so adding layers only smooths the gradient and never darkens it.

## Using it

1. Select one layer (raster, text, shape — anything Photon can duplicate).
2. Open **Plugins → Directional Blur Shadow…** (or `Ctrl+Shift+D`).
3. Tune the controls, press **Preview**.
4. Press **Apply** to keep it, or **Remove preview** to throw it away.
5. The result is a group named `Directional Blur Shadow` placed directly behind the source
   layer; with *Rasterize* on, Apply flattens the group into a single layer.

The last used values are remembered in the plugin's settings.

## Layout detection

Photon does not document whether the layer list is stored top-first or bottom-first, so the
plugin duplicates the source once, reads the resulting indices, and derives the insertion index
from that. The shadow therefore lands directly behind the subject in either convention.

## Limits / notes

- Text and shape layers are duplicated as-is; Photon keeps them editable. Rasterize on Apply if
  you want a single raster layer.
- Taper uses an affine transform, so a very large taper on a non-square layer resamples once more
  than the other steps do.
- The preview lives in the document until you Apply or Remove it. Closing the panel with a
  preview on screen leaves it behind — press **Remove preview** first.

## Testing

```powershell
node tools/shadow-test.cjs     # 11 tests: opacity law, angle maths, taper matrix, pipeline
```

The pipeline test runs against a fake Photon SDK (`tools/shadow-test.cjs`) and asserts the exact
operation sequence, the placement indices and the rasterize step.

## License

MIT — see [LICENSE](LICENSE). The original Affinity macro concept is by `rbonelli`; this is an
independent reimplementation for Photon Studio's operation-based plugin API.
