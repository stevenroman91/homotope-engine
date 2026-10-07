# Changelog

All notable changes to `@homotope/engine`. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0

First public release of the engine that powers [homotope.app](https://homotope.app).

- `vectorize(image, options, ctx?)`: raster (RGBA) → SVG, with progress and cooperative
  cancellation; topology-preserving (shared boundaries fitted once, holes kept).
- Presets: `logo`, `illustration`, `pixel-art`, `line-art`, `centerline`, `black-white`, `photo`.
- `@homotope/engine/export`: SVG → PDF, DXF (layers per colour, shared edges merged), EPS;
  colour layers and separations.
- `@homotope/engine/cutcheck`: cut-readiness report and simplification for cutting machines.
- `@homotope/engine/node`: PNG and JPEG codecs for Node (`pngjs`, `jpeg-js`, optional peers).
