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
| Layers | 3–30 | **5** | Number of stacked shadows (Beautiful Shadows uses 5) |
| Softness (px) | 1–300 | **26** | Blur at the far end of the shadow |
| Colour | hex | #000000 | Silhouette colour |
| Lighting strength (%) | 10–300 | 100 | Multiplies the whole falloff |
| Start opacity (%) | 1–100 | 100 | Opacity target nearest the layer |
| End opacity (%) | 0–100 | **5** | Opacity target at the far end |
| Taper (narrow/expand) | on/off | off | Scales each copy perpendicular to the direction |
| Size at tip (%) | 1–500 | 90 | Taper amount at the far end |
| Rasterize into one layer | on/off | on | Applied only when you press Apply |

## Ramps (matching Beautiful Shadows)

The defaults reproduce the Figma plugin's 5-shadow ramp:

| Layer | Offset (px) | Blur (px) | Opacity |
| --- | --- | --- | --- |
| 1 (far) | 150 | 26 | 5% |
| 2 | 96 | 22 | 14% |
| 3 | 54 | 18 | 34% |
| 4 | 24 | 14 | 62% |
| 5 (near) | 6 | 8 | 100% |

Offset grows with `t²`, blur with `t^0.7`, opacity with `(1 − t)²` (t = 1 at the far end).
Drop-shadow layer styles use the ramp value directly; the copies mode still normalises each
layer's opacity for alpha-over compositing.

## Preview, not live document edits

The canvas preview updates instantly while you drag or type, but **the document is only changed
when you press Preview or Apply** — no silent rebuilding while dragging. Press
**Remove preview** to delete the preview layer.

## Realtime direction preview

The panel draws its own preview on a canvas using the same maths as the document build:

- every shadow step is painted with `blur(radius × scale)` and the per-step opacity, so you see a
  soft stack instead of hard copies;
- the handle at the end of the line can be **dragged** to set angle and distance
  (`vectorToAngleDistance`), and the inputs update live;
- with **Live update** on, dragging the handle also rebuilds the document preview (debounced
  ~220 ms) so the real shadow follows your hand;
- **Diagnostics → Inspect effect parameters** dumps the host's real `dropShadow` parameter names,
  which is how the effect mapping is verified on a given Photon build.

## Two build modes

| Mode | What it builds | Pros | Cons |
| --- | --- | --- | --- |
| **Layer styles** (default) | One duplicate layer whose `fillOpacity` is 0, carrying **N `dropShadow` layer effects** (appended via `layer.effect.set` with increasing `index`) | Stays editable in Photon's **Layer Style** panel, one extra layer only, effects scale with the layer | Taper is not expressible as an effect |
| **Layer copies** | N duplicated layers, each filled, blurred and faded | Full control incl. **taper** | More layers; rasterize on Apply to flatten |

`layer.effect.set` documents `index` as "defaults to zero and may equal the current count to
append", so several drop shadows of the same kind can coexist on one layer — that is what makes
the effects mode possible. The plugin reads the real parameter names from
`effect.describe({kind:"dropShadow"})` at runtime and falls back to canonical names when the host
does not answer.

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

## Changelog

### 0.4.0

- Defaults now match Beautiful Shadows: **5 layers**, distance 150 px, softness 26 px,
  start/end opacity 100/5 %, lighting strength 100 %.
- Eased ramps: offset `t²`, blur `t^0.7`, opacity `(1 − t)²` — the stacked shadows now read as one
  soft gradient instead of separate copies.
- The canvas preview no longer rebuilds the document while dragging; the document changes only on
  **Preview** or **Apply**.
- UI simplified: Lighting strength replaces "Overall darkness", Softness replaces "Max blur", and
  the opacity/taper/rasterize options live under **Advanced**.
- Tests grew to 20 (5-layer default, ramp offsets/blur, direct vs composite opacity).

### 0.3.0

- **Interactive direction preview**: a canvas in the panel paints the soft stack (real blur and
  per-step opacity), with a draggable handle that sets angle and distance.
- **Live update** rebuilds the document preview while dragging (debounced), so the shadow follows
  the handle in Photon.
- Softness fix: the effect mapping now prefers an explicit `blur`/`radius` parameter over `size`,
  which is what made the first builds look like hard stacked copies.
- **Diagnostics → Inspect effect parameters** prints the host's real `dropShadow` parameter names
  and values, so the mapping can be checked on any Photon version.
- Tests grew to 18 (drag vector maths, blur-over-size priority).

### 0.2.0

- New **Layer styles** mode: the shadow is built from N `dropShadow` layer effects stacked on one
  hidden-copy layer (`fillOpacity: 0`), instead of N duplicated layers. Result stays editable in
  Photon's Layer Style panel and keeps the layer stack clean.
- Effect parameter names are discovered at runtime with `effect.describe`, with a canonical
  fallback, so the plugin still works if the host does not answer.
- Mode selector in the panel; taper and rasterize are only offered in **Layer copies** mode
  (taper cannot be expressed as a drop shadow effect).
- Tests grew to 16 (describe parsing, parameter mapping, effects pipeline order and indices).

## Testing

```powershell
node tools/shadow-test.cjs     # 11 tests: opacity law, angle maths, taper matrix, pipeline
```

The pipeline test runs against a fake Photon SDK (`tools/shadow-test.cjs`) and asserts the exact
operation sequence, the placement indices and the rasterize step.

## License

MIT — see [LICENSE](LICENSE). The original Affinity macro concept is by `rbonelli`; this is an
independent reimplementation for Photon Studio's operation-based plugin API.
