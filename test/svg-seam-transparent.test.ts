import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { segment } from '../src/engine/segment/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import { exportSvg } from '../src/engine/svg/index.ts';
import { wellFormedErrors } from '../src/engine/svg/wellformed.ts';
import { fitChains, thinTolerances } from '../src/engine/fit/index.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type { Palette } from '../src/engine/types.ts';
import { randomQuant } from './label-helpers.ts';

// F1 (#18, point 1) : le trait anti-liseré ne couvre jamais la transparence,
// ni aux jonctions (bout de trait, jointure) ni le long d'une face mince.
const pal = (n: number): Palette => ({
  colors: Array.from({ length: n }, (_, id) => ({
    id,
    rgb: [(id * 53 + 20) % 256, (id * 97 + 50) % 256, (id * 29 + 120) % 256] as [
      number,
      number,
      number,
    ],
    oklab: { L: 0, a: 0, b: 0 },
    count: 0,
    locked: false,
  })),
});
const render = (svg: string, w: number): Uint8Array =>
  new Resvg(svg, { fitTo: { mode: 'width', value: w }, logLevel: 'off' }).render().pixels;

describe('trait anti-liseré et transparence (#18)', () => {
  it('20 graines × cut/stacked, rendu 8×, seamStroke 1 et 3 : 0 sous-pixel peint sur le transparent', () => {
    const W = 48;
    const H = 48;
    const k = 8;
    const o = presetOptions('logo');
    let leaks = 0;
    let masked = 0;
    for (let seed = 0; seed < 20; seed++) {
      const q = randomQuant(W, H, 3, seed, { seeds: 9, noise: 0, transparent: 0.3 });
      const map = segment(q, W, H, { minRegionArea: 6, connectivity: 4 });
      const g = buildBoundaryGraph(map);
      const fit = fitChains(
        g.chains,
        o.fit,
        undefined,
        thinTolerances(
          g.chains,
          map.regions.map((r) => r.area),
          o.fit.tolerance,
        ),
      );
      for (const mode of ['cut', 'stacked'] as const) {
        const ex = (s: number): string =>
          exportSvg(
            g,
            fit,
            pal(3),
            { width: W, height: H, scale: 1 },
            { mode, precision: 2, mergeByColor: true, backgroundRect: true, seamStroke: s },
          ).svg;
        const a = render(ex(0), W * k);
        for (const sw of [1, 3]) {
          const svg = ex(sw);
          expect(wellFormedErrors(svg)).toEqual([]);
          if (svg.includes('<mask')) masked++;
          const b = render(svg, W * k);
          for (let y = 0; y < H * k; y++)
            for (let x = 0; x < W * k; x++) {
              const i = y * W * k + x;
              const src = map.labels[((y / k) | 0) * W + ((x / k) | 0)]!;
              if (src < 0 && a[4 * i + 3] === 0 && b[4 * i + 3]! > 0) leaks++;
            }
        }
      }
    }
    expect(masked).toBeGreaterThan(0);
    expect(leaks).toBe(0);
  }, 60_000);
});
