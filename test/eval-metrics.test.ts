import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/engine/color/prng.ts';
import { rgbToOklab } from '../src/engine/color/oklab.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { segment } from '../src/engine/segment/index.ts';
import { fitChains } from '../src/engine/fit/index.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { exportSvg } from '../src/engine/svg/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import type { LabelMap, Palette, RasterImage, Rgb } from '../src/engine/types.ts';
import {
  compareTopology,
  detectSeams,
  downsampleColors,
  percentile,
  pixelError,
  rasterizeSvg,
  requantize,
  ssim,
} from '../src/eval/metrics.ts';
import {
  caseOptions,
  checkThresholds,
  evaluateCase,
  type EvalCase,
  type Thresholds,
} from '../src/eval/run.ts';

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function makePalette(colors: Rgb[]): Palette {
  return {
    colors: colors.map((rgb, id) => ({ id, rgb, oklab: rgbToOklab(rgb), count: 0, locked: false })),
  };
}

function imageFrom(w: number, h: number, f: (x: number, y: number) => Rgb): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = f(x, y);
      const p = (y * w + x) * 4;
      data[p] = c[0];
      data[p + 1] = c[1];
      data[p + 2] = c[2];
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function svgOf(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
}

/** Carte de labels (après segmentation sans absorption) d'une image à couleurs exactes. */
function labelMapOf(img: RasterImage, palette: Palette): LabelMap {
  const colorIndex = requantize(img, palette);
  return segment({ palette, colorIndex }, img.width, img.height, {
    minRegionArea: 1,
    connectivity: 4,
  });
}

describe('rastérisation resvg', () => {
  it('carré rouge 10×10 : pixels exacts, fond transparent conservé', () => {
    const img = rasterizeSvg(svgOf(12, 12, '<path fill="#f00" d="M1 1H11V11H1Z"/>'), 12);
    expect([img.width, img.height]).toEqual([12, 12]);
    let red = 0;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const p = (y * 12 + x) * 4;
        const px = Array.from(img.data.slice(p, p + 4));
        const inside = x >= 1 && x < 11 && y >= 1 && y < 11;
        if (inside) {
          expect(px).toEqual([255, 0, 0, 255]);
          red++;
        } else expect(px[3]).toBe(0);
      }
    }
    expect(red).toBe(100);
  });

  it('dé-prémultiplie les pixels semi-transparents', () => {
    const img = rasterizeSvg(
      svgOf(2, 2, '<path fill="#f00" fill-opacity="0.5" d="M0 0H2V2H0Z"/>'),
      2,
    );
    expect(img.data[0]).toBeGreaterThanOrEqual(254);
    expect(img.data[3]).toBeGreaterThan(120);
    expect(img.data[3]).toBeLessThan(135);
  });
});

describe('SSIM', () => {
  const structured = imageFrom(64, 64, (x, y) => {
    const v = (x * 4 + y * 2) % 256;
    return (x - 32) ** 2 + (y - 32) ** 2 < 200 ? [255 - v, 40, v] : [v, v, v];
  });

  it('SSIM(image, image) = 1', () => {
    expect(ssim(structured, structured)).toBeCloseTo(1, 10);
  });

  it('SSIM(image, bruit) < 0,5', () => {
    const rnd = mulberry32(7);
    const noise = imageFrom(64, 64, () => {
      const v = Math.floor(rnd() * 256);
      return [v, v, v];
    });
    expect(ssim(structured, noise)).toBeLessThan(0.5);
  });

  it('refuse une image plus petite que la fenêtre', () => {
    const tiny = imageFrom(5, 5, () => WHITE);
    expect(() => ssim(tiny, tiny)).toThrow();
  });
});

describe('erreur par pixel', () => {
  it('décalage de couleur connu', () => {
    const a = imageFrom(10, 10, () => [100, 100, 100]);
    const b = imageFrom(10, 10, () => [110, 100, 100]);
    const e = pixelError(b, a);
    expect(e.meanRgb).toBeCloseTo(10, 10);
    expect(e.p95Rgb).toBeCloseTo(10, 10);
    expect(e.pixels).toBe(100);
    expect(e.differing).toBe(100);
    expect(e.meanOklab).toBeGreaterThan(0);
  });

  it("décalage d'un pixel d'un bord vertical noir/blanc", () => {
    const a = imageFrom(20, 10, (x) => (x < 10 ? BLACK : WHITE));
    const b = imageFrom(20, 10, (x) => (x < 11 ? BLACK : WHITE));
    const e = pixelError(b, a);
    const full = Math.sqrt(3) * 255;
    expect(e.differing).toBe(10);
    expect(e.meanRgb).toBeCloseTo((full * 10) / 200, 6);
    expect(e.maxRgb).toBeCloseTo(full, 6);
    expect(e.p95Rgb).toBe(0); // 5 % des pixels seulement sont faux
  });

  it('ignore les pixels transparents de la source, compte les vides du rendu', () => {
    const src = imageFrom(4, 1, () => RED);
    src.data[3] = 0; // pixel 0 transparent dans la source
    const render = rasterizeSvg(svgOf(4, 1, '<path fill="#f00" d="M0 0H3V1H0Z"/>'), 4);
    const e = pixelError(render, src);
    expect(e.pixels).toBe(3);
    expect(e.differing).toBe(1); // pixel 3 non couvert → fond blanc
  });

  it('centile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe('liserés', () => {
  const W = 20;
  const H = 10;
  const palette = makePalette([RED, BLUE]);
  const source = imageFrom(W, H, (x) => (x < 10 ? RED : BLUE));
  const quant = requantize(source, palette);

  it('deux rectangles jointifs → 0 liseré', () => {
    const svg = svgOf(
      W,
      H,
      '<path fill="#f00" d="M0 0H10V10H0Z"/><path fill="#00f" d="M10 0H20V10H10Z"/>',
    );
    const s = detectSeams(rasterizeSvg(svg, W), source, quant, palette);
    expect(s.count).toBe(0);
    expect(s.examined).toBe(W * H);
  });

  it('vide de 1 px entre les deux tracés → liseré sur toute la colonne', () => {
    const svg = svgOf(
      W,
      H,
      '<path fill="#f00" d="M0 0H9V10H0Z"/><path fill="#00f" d="M10 0H20V10H10Z"/>',
    );
    const s = detectSeams(rasterizeSvg(svg, W), source, quant, palette);
    expect(s.count).toBe(H);
    for (let y = 0; y < H; y++) expect(s.mask[y * W + 9]).toBe(1);
  });

  it("frontière à mi-pixel : l'anti-aliasing (et sa conflation) n'est pas un liseré", () => {
    const svg = svgOf(
      W,
      H,
      '<path fill="#f00" d="M0 0H9.5V10H0Z"/><path fill="#00f" d="M9.5 0H20V10H9.5Z"/>',
    );
    const s = detectSeams(rasterizeSvg(svg, W), source, quant, palette);
    expect(s.count).toBe(0);
    expect(s.conflation).toBe(H);
  });

  it('conflation sombre (noir à 89 % sur blanc) : pas un liseré', () => {
    // Régression T07 : pixel observé sur text.png, rendu (4,4,4) d'alpha 227
    // (blanc couvrant 11 % peint d'abord, puis noir 89 %). En OKLab il est à 0,1
    // du noir (racine cubique) et plus loin encore du premier mélange
    // échantillonné (1/16) : le mélange doit être projeté, pas échantillonné.
    const bw = makePalette([WHITE, BLACK]);
    const src = imageFrom(W, H, (x) => (x < 10 ? BLACK : WHITE));
    const render = imageFrom(W, H, (x) => (x < 10 ? BLACK : WHITE));
    for (let y = 0; y < H; y++) render.data.set([4, 4, 4, 227], (y * W + 9) * 4);
    const s = detectSeams(render, src, requantize(src, bw), bw);
    expect(s.count).toBe(0);
    expect(s.conflation).toBe(H);
  });

  it('bord contre la transparence partiellement couvert : pas un liseré (T07)', () => {
    // Régression T07 : un contour lissé couvre partiellement les pixels du bord
    // d'une forme sur fond transparent ; aucun tracé voisin ne peut y laisser de vide.
    const red = makePalette([RED]);
    const src = imageFrom(W, H, () => RED);
    for (let y = 0; y < H; y++) for (let x = 10; x < W; x++) src.data[(y * W + x) * 4 + 3] = 0;
    const quantRed = requantize(src, red);
    const svg = svgOf(W, H, '<path fill="#f00" d="M0 0H9.5V10H0Z"/>');
    expect(detectSeams(rasterizeSvg(svg, W), src, quantRed, red).count).toBe(0);
    // Le même vide entre deux tracés opaques reste un liseré (test ci-dessus).
    const gap = svgOf(W, H, '<path fill="#f00" d="M0 0H8.5V10H0Z"/>');
    expect(detectSeams(rasterizeSvg(gap, W), src, quantRed, red).count).toBe(H);
  });

  it('une couleur étrangère au voisinage est un liseré, même couvrante', () => {
    const svg = svgOf(
      W,
      H,
      '<path fill="#f00" d="M0 0H9V10H0Z"/><path fill="#0f0" d="M9 0H10V10H9Z"/><path fill="#00f" d="M10 0H20V10H10Z"/>',
    );
    const s = detectSeams(rasterizeSvg(svg, W), source, quant, palette);
    expect(s.count).toBe(H);
  });

  it('réduction majoritaire de la carte de couleurs', () => {
    const c = Int16Array.from([0, 0, 1, 1, 0, 1, 1, 1, 2, 2, -1, -1, 2, 2, -1, -1]);
    expect(Array.from(downsampleColors(c, 4, 4, 2))).toEqual([0, 1, 2, -1]);
  });
});

describe('conservation des trous', () => {
  const N = 20;
  const palette = makePalette([WHITE, BLACK]);
  // « O » : anneau noir carré, trou blanc au centre.
  const inRing = (x: number, y: number): boolean =>
    x >= 4 && x < 16 && y >= 4 && y < 16 && !(x >= 8 && x < 12 && y >= 8 && y < 12);
  const source = imageFrom(N, N, (x, y) => (inRing(x, y) ? BLACK : WHITE));
  const ref = labelMapOf(source, palette);

  it('« O » rendu correctement → aucun écart', () => {
    const graph = buildBoundaryGraph(ref);
    const fitted = fitChains(graph.chains, {
      tolerance: 1,
      cornerAngle: 60,
      smoothing: 0,
      lineTolerance: 0.5,
      smoothingReach: 0,
      robustLines: false,
      pixelArt: true,
    });
    const { svg } = exportSvg(
      graph,
      fitted,
      palette,
      { width: N, height: N, scale: 1 },
      { mode: 'cut', precision: 0, mergeByColor: true, backgroundRect: false },
    );
    const t = compareTopology(rasterizeSvg(svg, N), ref, palette, 1);
    expect(t.exact).toBe(true);
    expect(t.diffs).toEqual([]);
    expect(t.sourceHoles).toBe(2); // fond : 1 trou (l'anneau) ; anneau : 1 trou
    expect(t.renderHoles).toBe(2);
  });

  it('« O » dont le trou est bouché → écart signalé', () => {
    const svg = svgOf(
      N,
      N,
      '<path fill="#fff" d="M0 0H20V20H0Z"/><path fill="#000" d="M4 4H16V16H4Z"/>',
    );
    const t = compareTopology(rasterizeSvg(svg, N), ref, palette, 1);
    expect(t.exact).toBe(false);
    const black = t.diffs.find((d) => d.colorId === 1)!;
    expect(black.source).toEqual({ components: 1, holes: 1 });
    expect(black.render).toEqual({ components: 1, holes: 0 });
    const white = t.diffs.find((d) => d.colorId === 0)!;
    expect(white.source.components).toBe(2);
    expect(white.render.components).toBe(1);
  });
});

describe('harnais', () => {
  it('surcharges d’options sur un préréglage', () => {
    const o = caseOptions({ preset: 'logo', options: { segment: { minRegionArea: 3 } } });
    expect(o.segment.minRegionArea).toBe(3);
    expect(o.segment.connectivity).toBe(4);
    expect(o.fit.pixelArt).toBe(false);
  });

  it('checkThresholds liste tous les dépassements', () => {
    const t: Thresholds = {
      ssimMin: 0.99,
      meanErrorMax: 1,
      seamsMax: 0,
      holesExact: true,
      nodesMax: 10,
      bytesMax: 10,
    };
    const report = {
      name: 'x',
      ssim: 0.5,
      error: { meanRgb: 2 },
      seams: { count: 1 },
      topology: { exact: false, diffs: [] },
      stats: { nodes: 11, bytes: 11 },
    } as unknown as Parameters<typeof checkThresholds>[0];
    expect(checkThresholds(report, t)).toHaveLength(6);
  });

  it('vectorize passe --check sur logo-flat.png', { timeout: 30_000 }, () => {
    const cases = JSON.parse(readFileSync('scripts/eval-cases.json', 'utf8')) as {
      cases: EvalCase[];
    };
    const thresholds = JSON.parse(readFileSync('scripts/eval-thresholds.json', 'utf8')) as {
      fixtures: Record<string, Thresholds>;
    };
    const c = cases.cases.find((x) => x.name === 'logo-flat')!;
    const image = decodePng(new Uint8Array(readFileSync(`test/fixtures/${c.fixture}`)));
    const { report } = evaluateCase(c, image, (img, o) => vectorize(img, o));
    expect(checkThresholds(report, thresholds.fixtures['logo-flat']!)).toEqual([]);
    expect(report.seams.count).toBe(0);
    expect(report.topology.exact).toBe(true);
    expect(report.topology.sourceHoles).toBeGreaterThanOrEqual(2); // O et A
  });
});
