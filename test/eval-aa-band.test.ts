import { describe, expect, it } from 'vitest';
import { rgbToOklab } from '../src/engine/color/oklab.ts';
import { fitChains } from '../src/engine/fit/index.ts';
import { segment } from '../src/engine/segment/index.ts';
import { exportSvg } from '../src/engine/svg/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import type { Palette, RasterImage, Rgb } from '../src/engine/types.ts';
import { compareTopology, detectSeams, rasterizeSvg, requantize } from '../src/eval/metrics.ts';
import { quantFromAscii } from './label-helpers.ts';

// T08 — Preuve d'un faux positif du harnais : une bande d'anti-aliasing d'un
// pixel de large entre deux couleurs (ici marine / blanc) dont la teinte
// intermédiaire est plus proche d'une TROISIÈME couleur de la palette
// (sarcelle) formait une « composante » sarcelle alors qu'aucun tracé
// sarcelle n'est là. Cas construit : le SVG a exactement la topologie de la
// source (un rectangle marine, un rectangle sarcelle), décalé d'un demi-pixel.
const WHITE: Rgb = [255, 255, 255];
const NAVY: Rgb = [29, 53, 87];
const TEAL: Rgb = [42, 157, 143];

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
      data.set([c[0], c[1], c[2], 255], p);
    }
  }
  return { width: w, height: h, data };
}

describe('topologie — bandes d’anti-aliasing (T08)', () => {
  const N = 40;
  const palette = makePalette([WHITE, NAVY, TEAL]);
  const source = imageFrom(N, N, (x, y) =>
    x >= 5 && x < 35 && y >= 10 && y < 20
      ? NAVY
      : x >= 5 && x < 35 && y >= 28 && y < 36
        ? TEAL
        : WHITE,
  );
  const ref = segment({ palette, colorIndex: requantize(source, palette) }, N, N, {
    minRegionArea: 1,
    connectivity: 4,
  });
  const svg = (navyTop: number): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">` +
    `<path fill="#fff" d="M0 0H${N}V${N}H0Z"/>` +
    `<path fill="#1d3557" d="M5 ${navyTop}H35V20H5Z"/>` +
    `<path fill="#2a9d8f" d="M5 28H35V36H5Z"/></svg>`;

  it('la teinte intermédiaire marine/blanc est bien plus proche de la sarcelle', () => {
    const render = rasterizeSvg(svg(9.5), N);
    const q = requantize(render, palette);
    expect(q[9 * N + 20]).toBe(2); // la bande y = 9 « est » sarcelle une fois re-quantifiée
  });

  it('décalage d’un demi-pixel : topologie identique, aucune composante parasite', () => {
    const t = compareTopology(rasterizeSvg(svg(9.5), N), ref, palette, 8);
    expect(t.diffs).toEqual([]);
    expect(t.exact).toBe(true);
  });

  it('une vraie composante sarcelle en trop reste détectée', () => {
    const extra = svg(10).replace('</svg>', '<path fill="#2a9d8f" d="M5 2H15V6H5Z"/></svg>');
    const t = compareTopology(rasterizeSvg(extra, N), ref, palette, 8);
    expect(t.exact).toBe(false);
    expect(t.diffs.find((d) => d.colorId === 2)!.render.components).toBe(2);
  });
});

describe('liserés — source translucide (T08)', () => {
  // Preuve d'un faux positif : le détecteur jugeait « découvert » tout pixel
  // rendu sous 0,7 de couverture, même quand la SOURCE y est elle-même
  // translucide. Un SVG exact (même couleur, même opacité) sortait des liserés.
  const N = 20;
  const GREEN: Rgb = [60, 170, 90];
  const palette = makePalette([GREEN]);
  const source: RasterImage = (() => {
    const img = imageFrom(N, N, () => GREEN);
    for (let i = 0; i < N * N; i++) img.data[i * 4 + 3] = 153; // 60 %
    return img;
  })();
  const quant = new Int16Array(N * N); // tout « vert », opaque au seuil 128
  const svg = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">${body}</svg>`;

  it('rendu exact (fill-opacity) : aucun liseré', () => {
    const render = rasterizeSvg(
      svg(`<path fill="#3caa5a" fill-opacity=".6" d="M0 0H20V20H0Z"/>`),
      N,
    );
    expect(detectSeams(render, source, quant, palette).count).toBe(0);
  });

  it('un vrai trou dans la forme translucide reste un liseré', () => {
    const render = rasterizeSvg(
      svg(`<path fill="#3caa5a" fill-opacity=".6" d="M0 0H20V20H0ZM9 0V20H10V0Z"/>`),
      N,
    );
    expect(detectSeams(render, source, quant, palette).count).toBeGreaterThanOrEqual(18);
  });
});

describe('trait anti-liseré au rendu (T08)', () => {
  // Deux faces jointives sur une frontière fractionnaire : sans trait, resvg
  // laisse passer le fond (couverture 1 − a(1 − a) < 1) ; avec, plus rien.
  const run = (seamStroke: number): RasterImage => {
    const rows = Array.from({ length: 12 }, () => 'AAAAAAAAABBBBBBBBB');
    const { q, width, height } = quantFromAscii(rows);
    const map = segment(q, width, height, { minRegionArea: 1, connectivity: 4 });
    const graph = buildBoundaryGraph(map);
    // Frontière déplacée d'un demi-pixel (x = 9 → 9,5) : couverture partielle.
    const fitted = fitChains(graph.chains, {
      tolerance: 1,
      cornerAngle: 60,
      smoothing: 0,
      lineTolerance: 0.5,
      smoothingReach: 0,
      robustLines: false,
      exactShapes: false,
      pixelArt: true,
    }).map((fc) => ({
      ...fc,
      start: [fc.start[0] === 9 ? 9.5 : fc.start[0], fc.start[1]] as [number, number],
      segments: fc.segments.map((s) => (s.x === 9 ? { ...s, x: 9.5 } : s)),
    }));
    const palette = makePalette([NAVY, TEAL]);
    const { svg } = exportSvg(
      graph,
      fitted,
      palette,
      { width, height, scale: 1 },
      { mode: 'cut', precision: 2, mergeByColor: true, backgroundRect: false, seamStroke },
    );
    return rasterizeSvg(svg, width);
  };
  const minAlpha = (img: RasterImage): number => {
    let m = 255;
    for (let i = 3; i < img.data.length; i += 4) m = Math.min(m, img.data[i]!);
    return m;
  };

  it('sans trait : un jour d’anti-aliasing sur la frontière', () => {
    expect(minAlpha(run(0))).toBeLessThan(250);
  });

  it('avec trait d’1 px : couverture totale, frontière inchangée', () => {
    const with1 = run(1);
    expect(minAlpha(with1)).toBe(255);
    // Colonnes loin de la frontière : couleurs exactes.
    const px = (x: number) =>
      Array.from(with1.data.subarray((5 * 18 + x) * 4, (5 * 18 + x) * 4 + 3));
    expect(px(4)).toEqual([...NAVY]);
    expect(px(14)).toEqual([...TEAL]);
  });
});
