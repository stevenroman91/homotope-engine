import { describe, expect, it } from 'vitest';
import { vectorize, workingOptions } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import {
  FAST_PIXEL_BUDGET,
  MEGAPIXEL,
  clampUpsample,
  workingSize,
} from '../src/engine/preprocess/limits.ts';
import { OklabCache, rgbaToOklabArray } from '../src/engine/color/oklab.ts';
import { serializeSubpaths } from '../src/engine/svg/path.ts';
import type { FittedChain } from '../src/engine/types.ts';
import { pixelError, rasterizeSvg } from '../src/eval/metrics.ts';
import { flatShapes, normalizedScene } from './large-helpers.ts';

/** Toutes les coordonnées (ancres et poignées) d'une chaîne ajustée. */
function coords(fc: FittedChain): { xs: number[]; ys: number[] } {
  const xs = [fc.start[0]];
  const ys = [fc.start[1]];
  for (const s of fc.segments) {
    xs.push(s.x);
    ys.push(s.y);
    if (s.kind === 'cubic') {
      xs.push(s.c1x, s.c2x);
      ys.push(s.c1y, s.c2y);
    }
  }
  return { xs, ys };
}

describe('T12 — taille de travail', () => {
  it('par défaut : la taille d’origine, jamais de réduction', () => {
    for (const [w, h] of [
      [7087, 4724],
      [2204, 8192],
      [16384, 2953],
      [50, 50],
    ] as const) {
      expect(workingSize(w, h)).toEqual({ width: w, height: h, factor: 1, reduced: false });
    }
  });

  it('calcul rapide : sous le budget, proportions conservées', () => {
    const cases: [number, number][] = [
      [7087, 4724],
      [2204, 8192],
      [16384, 2953],
    ];
    for (const [w, h] of cases) {
      const r = workingSize(w, h, FAST_PIXEL_BUDGET);
      expect(r.reduced).toBe(true);
      expect(r.width * r.height).toBeLessThanOrEqual(FAST_PIXEL_BUDGET);
      // Au plus près du budget : une ligne ou une colonne de plus le dépasserait presque.
      expect(r.width * r.height).toBeGreaterThan(FAST_PIXEL_BUDGET * 0.999);
      expect(Math.abs(r.width / r.height - w / h) / (w / h)).toBeLessThan(0.001);
      expect(r.width).toBeLessThan(w);
      expect(r.height).toBeLessThan(h);
      expect(r.factor).toBeCloseTo(Math.sqrt((r.width * r.height) / (w * h)), 12);
    }
    expect(workingSize(7087, 4724, FAST_PIXEL_BUDGET)).toMatchObject({ width: 5017, height: 3344 });
  });

  it('jamais d’agrandissement ; une petite image reste inchangée', () => {
    expect(workingSize(50, 50, FAST_PIXEL_BUDGET)).toMatchObject({ width: 50, height: 50 });
    expect(workingSize(4096, 4096, FAST_PIXEL_BUDGET).reduced).toBe(false);
    expect(workingSize(4097, 4096, FAST_PIXEL_BUDGET).reduced).toBe(true);
    // Bande extrême : au moins 1 px de côté.
    const thin = workingSize(1_000_000, 40, 4 * MEGAPIXEL);
    expect(thin.height).toBeGreaterThanOrEqual(1);
    expect(thin.width * thin.height).toBeLessThanOrEqual(4 * MEGAPIXEL);
  });

  it('le suréchantillonnage automatique reste ×1 sur une image réduite', () => {
    const r = workingSize(7087, 4724, FAST_PIXEL_BUDGET);
    expect(clampUpsample(r.width, r.height, 2)).toBe(1);
  });
});

describe('T12 — options à l’échelle d’une image réduite', () => {
  it('aires × scale², longueurs jamais sous leur valeur en pixels de travail', () => {
    const o = presetOptions('logo');
    const w = workingOptions(o, 0.5);
    expect(w.segment.minRegionArea).toBe(o.segment.minRegionArea * 0.25);
    expect(w.fit.tolerance).toBe(o.fit.tolerance);
    expect(w.fit.lineTolerance).toBe(o.fit.lineTolerance);
    expect(w.segment.blendBand).toBe(o.segment.blendBand);
    // Suréchantillonnage : inchangé (longueurs × scale).
    expect(workingOptions(o, 2).fit.tolerance).toBe(o.fit.tolerance * 2);
  });

  it('serializeSubpaths : facteur distinct par axe', () => {
    const sq = {
      start: [0, 0] as const,
      segments: [
        { kind: 'line' as const, x: 500, y: 0 },
        { kind: 'line' as const, x: 500, y: 333 },
        { kind: 'line' as const, x: 0, y: 333 },
      ],
    };
    expect(serializeSubpaths([sq], 500 / 1001, 0, 333 / 667).d).toBe('M0 0h1001v667H0Z');
  });
});

describe('T12 — vectorisation d’une image réduite', () => {
  it(
    '4000 × 4000 réduite à 2000 × 2000 : viewBox et coordonnées d’origine',
    { timeout: 60_000 },
    () => {
      const work = normalizedScene(2000, 2000);
      const r = vectorize(work, presetOptions('logo'), {
        original: { width: 4000, height: 4000 },
        debug: true,
      });
      expect(r.width).toBe(4000);
      expect(r.height).toBe(4000);
      expect(r.svg).toContain('width="4000" height="4000" viewBox="0 0 4000 4000"');
      let maxX = 0;
      let maxY = 0;
      for (const fc of r.debug!.fitted) {
        const { xs, ys } = coords(fc);
        for (const v of [...xs, ...ys]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(4000);
        }
        maxX = Math.max(maxX, ...xs);
        maxY = Math.max(maxY, ...ys);
      }
      // Le bandeau touche le bord droit : coordonnées jusqu'à 4000, pas 2000.
      expect(maxX).toBe(4000);
      expect(maxY).toBeGreaterThan(3000);
      // Rendu à 400 px comparé à la scène : même erreur que la vectorisation de la
      // même image sans réduction (l'écart restant vient de la palette, pas de l'alignement).
      const ref = normalizedScene(400, 400);
      const direct = vectorize(work, presetOptions('logo'));
      const err = pixelError(rasterizeSvg(r.svg, 400), ref).meanRgb;
      expect(err).toBeCloseTo(pixelError(rasterizeSvg(direct.svg, 400), ref).meanRgb, 1);
      expect(err).toBeLessThan(12);
    },
  );

  it('facteurs par axe différents (1001 × 667 réduite à 500 × 333)', () => {
    const r = vectorize(normalizedScene(500, 333), presetOptions('logo'), {
      original: { width: 1001, height: 667 },
      debug: true,
    });
    expect(r.svg).toContain('viewBox="0 0 1001 667"');
    let maxX = 0;
    let maxY = 0;
    for (const fc of r.debug!.fitted) {
      const { xs, ys } = coords(fc);
      maxX = Math.max(maxX, ...xs);
      maxY = Math.max(maxY, ...ys);
    }
    expect(maxX).toBeCloseTo(1001, 9);
    expect(maxY).toBeLessThanOrEqual(667 + 1e-9);
    const err = pixelError(rasterizeSvg(r.svg, 1001), normalizedScene(1001, 667));
    // Désalignée d'un pixel sur un axe, l'erreur moyenne monterait nettement (bords des formes).
    expect(err.meanRgb).toBeLessThan(12);
    expect(err.p95Rgb).toBeLessThan(10);
  });

  it('sans `original` (ou égal) : résultat identique à l’appel sans contexte', () => {
    const img = normalizedScene(120, 90);
    const a = vectorize(img, presetOptions('logo'));
    const b = vectorize(img, presetOptions('logo'), { original: { width: 120, height: 90 } });
    expect(b.svg).toBe(a.svg);
  });
});

describe('T12 — mémoire et réactivité du moteur', () => {
  it('OklabCache : mêmes valeurs Float32 que la conversion de toute l’image', () => {
    // Couleurs pseudo-aléatoires, assez pour provoquer des collisions dans le cache.
    const n = 200_000;
    const data = new Uint8ClampedArray(n * 4);
    let x = 12345;
    for (let i = 0; i < data.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      data[i] = x >>> 24;
    }
    const full = new Float32Array(n * 3);
    rgbaToOklabArray(data, full);
    const cache = new OklabCache();
    for (let i = 0; i < n; i++) {
      const o = cache.slot(data, i * 4);
      expect(cache.lab[o]).toBe(full[i * 3]);
      expect(cache.lab[o + 1]).toBe(full[i * 3 + 1]);
      expect(cache.lab[o + 2]).toBe(full[i * 3 + 2]);
    }
  });

  it('progression et annulation à l’intérieur des étapes longues (~1 Mpx)', () => {
    const img = flatShapes(2048, 2048); // 4 Mpx
    const inner: Record<string, number> = {};
    const token = { cancelled: false };
    vectorize(img, presetOptions('logo'), {
      cancel: token,
      onProgress: (e) => {
        if (e.stageProgress > 0 && e.stageProgress < 1) inner[e.stage] = (inner[e.stage] ?? 0) + 1;
      },
    });
    // Le worker n'est réputé vivant que s'il émet : aucune étape longue ne reste muette.
    for (const stage of ['preprocess', 'quantize', 'segment', 'topology'])
      expect(inner[stage], stage).toBeGreaterThanOrEqual(3);
  });
});

/** Vectorise des aplats de `mpx` Mpx (3:2) et mesure durée et pic mémoire (tas + tampons). */
function bench(mpx: number): { seconds: number; peakMb: number } {
  const w = Math.round(Math.sqrt((mpx * MEGAPIXEL * 3) / 2));
  const h = Math.round((mpx * MEGAPIXEL) / w);
  const image = flatShapes(w, h);
  const base = process.memoryUsage();
  const baseline = base.heapUsed + base.arrayBuffers;
  let peak = 0;
  const sample = (): void => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.heapUsed + m.arrayBuffers);
  };
  const t0 = performance.now();
  const r = vectorize(image, presetOptions('logo'), { onProgress: sample });
  const seconds = (performance.now() - t0) / 1000;
  expect(r.stats.paths).toBeGreaterThan(0);
  expect(r.width).toBe(w);
  // Pic au-dessus de l'état avant le calcul (image d'entrée comprise, déjà allouée).
  return { seconds, peakMb: (peak - baseline + w * h * 4) / MEGAPIXEL };
}

describe('T12 — grandes images à pleine résolution (aplats, préréglage logo)', () => {
  it('16 Mpx en moins de 20 s', { timeout: 120_000 }, () => {
    const r = bench(16);
    console.log(`16 Mpx : ${r.seconds.toFixed(1)} s, pic ≈ ${r.peakMb.toFixed(0)} Mo`);
    expect(r.seconds).toBeLessThan(20);
  });

  it('48 Mpx en moins de 60 s, pic mémoire sous 1,5 Go', { timeout: 180_000 }, () => {
    const r = bench(48);
    console.log(`48 Mpx : ${r.seconds.toFixed(1)} s, pic ≈ ${r.peakMb.toFixed(0)} Mo`);
    expect(r.seconds).toBeLessThan(60);
    expect(r.peakMb).toBeLessThan(1536);
  });
});
