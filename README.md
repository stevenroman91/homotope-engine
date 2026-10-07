# @homotope/engine

Raster-to-vector engine in pure TypeScript: turns a PNG or JPEG (any RGBA pixel buffer) into a
clean **SVG**, and from that SVG into **DXF**, **PDF** or **EPS**. It is the engine behind
[Homotope](https://homotope.app), an online image vectorizer, released under the MIT license.

- **No DOM, no runtime dependencies.** The core runs unchanged in a Web Worker, in the main
  thread and in Node. Pixel data stays on the machine: nothing is uploaded anywhere.
- **Topology first.** The image is quantized in OKLab, segmented into regions, and every shared
  boundary is fitted **once**: two neighbouring shapes never overlap and never leave a gap. Holes
  are kept (an "O" stays an "O").
- **Presets** for logos, illustrations, pixel art, line art, black & white, photos, and a
  **centerline** mode that traces strokes as single open paths (plotters, engraving, embroidery).
- **Fabrication exports**: DXF (layers per colour, shared edges cut once), PDF, EPS, colour
  separations, and a cut-readiness check (tiny islands, too-close edges, node counts).
- An alternative to Potrace: no GPL code, full colour, exact shared borders.

## Install

```bash
npm install @homotope/engine
# Node only, to decode PNG/JPEG files (optional peer dependencies):
npm install pngjs jpeg-js
```

Requires an ES2022 runtime (Node ≥ 22, any current browser). ESM only.

## Entry points

| Import                      | What                                                               | Dependencies       |
| --------------------------- | ------------------------------------------------------------------ | ------------------ |
| `@homotope/engine`          | `vectorize`, `presetOptions`, `PRESET_NAMES`, all types            | none               |
| `@homotope/engine/export`   | `convertSvg` (SVG → PDF, DXF, EPS), `exportLayers`, `sceneFromSvg` | none               |
| `@homotope/engine/cutcheck` | `checkSvg`, `simplifySvg`: cut-readiness report for cutters        | none               |
| `@homotope/engine/node`     | `decodePng`, `decodeJpeg`, `encodePng`, `encodeJpeg`               | `pngjs`, `jpeg-js` |

Browser bundles only receive what they import: the core never imports `pngjs` or `jpeg-js`.

## Node example

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { vectorize, presetOptions } from '@homotope/engine';
import { convertSvg } from '@homotope/engine/export';
import { decodePng } from '@homotope/engine/node';

const image = decodePng(new Uint8Array(readFileSync('logo.png')));
const result = vectorize(image, presetOptions('logo'), {
  onProgress: (e) => process.stdout.write(`\r${e.stage} ${Math.round(e.progress * 100)}%`),
});

writeFileSync('logo.svg', result.svg);
writeFileSync('logo.dxf', convertSvg(result.svg, 'dxf'));
console.log(`\n${result.palette.colors.length} colours, ${result.stats.paths} paths`);
```

## Browser example (Web Worker)

`vectorize` is synchronous on purpose: run it in a worker so the page stays responsive. Its
input is any `ImageData`-like object `{ width, height, data: Uint8ClampedArray }` (RGBA, not
premultiplied).

```ts
// main.ts
const bitmap = await createImageBitmap(file);
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
const ctx = canvas.getContext('2d')!;
ctx.drawImage(bitmap, 0, 0);
const { width, height, data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

const worker = new Worker(new URL('./vectorize.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent<{ svg: string }>) => {
  const url = URL.createObjectURL(new Blob([e.data.svg], { type: 'image/svg+xml' }));
  document.querySelector<HTMLImageElement>('#preview')!.src = url; // or offer it as a download
};
worker.postMessage({ width, height, data }, [data.buffer]);
```

```ts
// vectorize.worker.ts
import { vectorize, presetOptions, type RasterImage } from '@homotope/engine';

self.onmessage = (e: MessageEvent<RasterImage>) => {
  const { svg } = vectorize(e.data, presetOptions('illustration'));
  self.postMessage({ svg });
};
```

Cancellation is cooperative: pass `{ cancel: { cancelled: boolean } }` as the third argument
(for example backed by a `SharedArrayBuffer`); `vectorize` then throws a `CancelledError`
between and inside stages.

## Presets

`presetOptions(name)` returns a full, independent options object that you can tweak.

| Preset         | For                                                                 |
| -------------- | ------------------------------------------------------------------- |
| `logo`         | Flat colours, crisp corners, straight lines kept straight           |
| `illustration` | Up to 32 colours, smoother curves, light gradients, stacked shapes  |
| `pixel-art`    | Exact pixel grid, no curves, zero error                             |
| `line-art`     | Ink drawings and text: two colours, filled shapes                   |
| `centerline`   | Strokes traced as single open paths (plotter, laser engraving)      |
| `black-white`  | Two colours from an automatic (Otsu) threshold                      |
| `photo`        | Up to 64 colours, denoising, small regions absorbed, stacked shapes |

```ts
import { presetOptions, vectorize } from '@homotope/engine';

const options = presetOptions('logo');
options.quantize.colors = 4; // fixed number of colours instead of 'auto'
options.export.precision = 1; // decimals in path data
options.export.mode = 'stacked'; // fewer nodes: shapes stacked instead of cut out
const { svg } = vectorize(image, options);
```

Every option is typed and documented in `VectorizeOptions` (`preprocess`, `quantize`,
`segment`, `fit`, `export`, `centerline`).

## SVG output

- `viewBox` in the pixel coordinates of the original image, cubic Béziers, one `<path>` per
  colour by default (`export.mergeByColor`).
- `export.mode: 'cut'` (default): every region is an exact path with its holes
  (`fill-rule="evenodd"`), no overlap; `'stacked'`: shapes stacked by depth, fewer nodes.
- Transparent pixels (`preprocess.alphaMode: 'keep'`) produce no path.
- `result.palette` lists the colours (sRGB and OKLab, pixel counts); `result.stats` the number
  of paths and nodes; `result.timings` the time spent per stage.

## Hosted version and API

[homotope.app](https://homotope.app) runs this engine in the browser with a visual editor
(palette, presets, before/after), plus optional server processing, a REST API and an MCP
server for AI assistants: see the [API documentation](https://homotope.app/en/docs/api).

## Development

```bash
npm install
npm test           # Vitest, no DOM
npm run typecheck
npm run lint
npm run eval       # renders every fixture and measures the error (Resvg)
npm run build      # dist/ (ESM + .d.ts)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
