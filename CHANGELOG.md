# Changelog

All notable changes to `@homotope/engine`. Versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0

### Breaking

- `FitOptions.exactShapes` is a new **required** boolean. Code that builds a `FitOptions`
  object by hand must add it (`false` keeps the 0.1.0 output byte for byte); code that starts
  from a preset or from the defaults is unaffected.

### Added

- Exact shapes (`fit.exactShapes`, on in the `logo` and `black-white` presets, off elsewhere):
  a run between two corners whose points fit a circular arc within the tolerance is laid
  exactly on that arc, and a closed island without corners that fits a circle becomes an exact
  circle (4 cubics, nodes at the extrema). Arcs are emitted as tangent cubics of at most 90°
  (deviation from the circle ≤ 0.03 % of the radius), each one checked against the original
  pixels. No new segment type: the SVG, PDF, DXF and EPS outputs keep their format.
- Shared vertices: an endpoint common to two or three boundary chains is moved once, for every
  face that uses it, onto the intersection of its neighbouring exact shapes (line ∩ line,
  line ∩ circle, circle ∩ circle) or its projection on the only one, within a bounded snap.
- Measured on the evaluation suite (peak-to-peak radius, in pixels): logo “O” 0.756 → 0.022,
  ring 0.499 → 0.038, ring cut by a bar 0.715 → 0.566; outer ring of the homotope.app logo
  0.93 → 0.32. The other presets produce identical output.
- `@homotope/engine/export`: CutContour layer for sticker cutting (`withCutContour`,
  `hasCutContour`, `stripCutContour`, `cutContourItems`, `withoutCutContour`), DXF width
  helpers (`dxfMmPerPx`, `DXF_MIN_WIDTH_MM`, `DXF_MAX_WIDTH_MM`).
- `@homotope/engine/cutcheck`: point-by-point corrections (`correctScene`, `correctSvg`,
  `fixGeometry`, `unfold`), `widthMm` option (scale taken from the real drawing width, as in
  the DXF).

## 0.1.0

First public release of the engine that powers [homotope.app](https://homotope.app).

- `vectorize(image, options, ctx?)`: raster (RGBA) → SVG, with progress and cooperative
  cancellation; topology-preserving (shared boundaries fitted once, holes kept).
- Presets: `logo`, `illustration`, `pixel-art`, `line-art`, `centerline`, `black-white`, `photo`.
- `@homotope/engine/export`: SVG → PDF, DXF (layers per colour, shared edges merged), EPS;
  colour layers and separations.
- `@homotope/engine/cutcheck`: cut-readiness report and simplification for cutting machines.
- `@homotope/engine/node`: PNG and JPEG codecs for Node (`pngjs`, `jpeg-js`, optional peers).
