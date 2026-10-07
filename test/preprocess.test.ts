import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/engine/presets.ts';
import {
  clampUpsample,
  MAX_WORK_PIXELS,
  preprocess,
  resolveUpsample,
} from '../src/engine/preprocess/index.ts';
import { createRaster, fillRaster, getPixel, setPixel } from '../src/engine/image/raster.ts';
import type { PreprocessOptions, RasterImage } from '../src/engine/types.ts';
import { gaussian, mulberry32 } from '../scripts/lib/draw.ts';

function opts(o: Partial<PreprocessOptions> = {}): PreprocessOptions {
  return { ...DEFAULT_OPTIONS.preprocess, upsample: 1, ...o };
}

/** Marche verticale : gauche `lo`, droite `hi` (gris), bruit gaussien seedé optionnel. */
function step(w: number, h: number, lo: number, hi: number, sigma = 0, seed = 1): RasterImage {
  const img = createRaster(w, h);
  const rng = mulberry32(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x < w / 2 ? lo : hi) + sigma * gaussian(rng);
      setPixel(img, x, y, [v, v, v, 255]);
    }
  }
  return img;
}

function maxAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** Écart-type du canal rouge sur un rectangle. */
function stdDev(img: RasterImage, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = getPixel(img, x, y)[0];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const m = s / n;
  return Math.sqrt(s2 / n - m * m);
}

describe('preprocess — bilatéral', () => {
  it.each([
    [50, 200],
    [100, 160],
  ])('préserve une marche nette %i→%i (écart < 2)', (lo, hi) => {
    for (const radius of [1, 2, 4]) {
      for (const strength of [0.3, 0.5]) {
        const img = step(32, 16, lo, hi);
        const out = preprocess(
          img,
          opts({ denoise: 'bilateral', denoiseRadius: radius, denoiseStrength: strength }),
        );
        expect(maxAbsDiff(out.image.data, img.data)).toBeLessThan(2);
      }
    }
  });

  it('réduit un bruit seedé tout en gardant la marche', () => {
    const noisy = step(64, 64, 50, 200, 8, 7);
    const out = preprocess(
      noisy,
      opts({ denoise: 'bilateral', denoiseRadius: 2, denoiseStrength: 0.3 }),
    );
    const before = stdDev(noisy, 4, 4, 28, 60);
    const after = stdDev(out.image, 4, 4, 28, 60);
    expect(after).toBeLessThan(before * 0.6);
    // La marche reste nette : colonnes de part et d'autre du bord proches des niveaux d'origine.
    for (let y = 4; y < 60; y++) {
      expect(Math.abs(getPixel(out.image, 31, y)[0] - 50)).toBeLessThan(12);
      expect(Math.abs(getPixel(out.image, 32, y)[0] - 200)).toBeLessThan(12);
    }
  });

  it("ne modifie pas l'image d'entrée", () => {
    const img = step(16, 16, 0, 255, 10);
    const copy = new Uint8ClampedArray(img.data);
    preprocess(img, opts({ denoise: 'bilateral' }));
    preprocess(img, opts({ denoise: 'median', upsample: 2 }));
    expect(img.data).toEqual(copy);
  });
});

describe('preprocess — médian', () => {
  it('supprime un pixel isolé', () => {
    const img = createRaster(9, 9);
    fillRaster(img, [40, 80, 120]);
    setPixel(img, 4, 4, [255, 0, 255, 255]);
    const out = preprocess(img, opts({ denoise: 'median', denoiseRadius: 1, denoiseStrength: 1 }));
    expect(getPixel(out.image, 4, 4)).toEqual([40, 80, 120, 255]);
  });

  it('mélange selon denoiseStrength', () => {
    const img = createRaster(9, 9);
    fillRaster(img, [0, 0, 0]);
    setPixel(img, 4, 4, [200, 200, 200, 255]);
    const out = preprocess(
      img,
      opts({ denoise: 'median', denoiseRadius: 1, denoiseStrength: 0.5 }),
    );
    expect(getPixel(out.image, 4, 4)).toEqual([100, 100, 100, 255]);
  });

  it('none laisse les pixels intacts', () => {
    const img = step(16, 16, 0, 255, 10);
    const out = preprocess(img, opts({ denoise: 'none' }));
    expect(out.image.data).toEqual(img.data);
  });
});

describe('preprocess — transparence', () => {
  /** Moitié gauche opaque (255,0,0), moitié droite transparente de couleur proche (200,0,0). */
  function halfTransparent(): RasterImage {
    const img = createRaster(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        setPixel(img, x, y, x < 8 ? [255, 0, 0, 255] : [200, 0, 0, 0]);
      }
    }
    return img;
  }

  it.each(['bilateral', 'median'] as const)(
    'keep exclut les transparents du noyau (%s)',
    (denoise) => {
      const img = halfTransparent();
      const out = preprocess(
        img,
        opts({
          denoise,
          denoiseRadius: 4,
          denoiseStrength: 1,
          alphaMode: 'keep',
          alphaThreshold: 128,
        }),
      );
      expect(out.opaque).not.toBeNull();
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          expect(out.opaque![y * 16 + x]).toBe(x < 8 ? 1 : 0);
          expect(getPixel(out.image, x, y)).toEqual(x < 8 ? [255, 0, 0, 255] : [200, 0, 0, 0]);
        }
      }
    },
  );

  it('keep : masque selon alphaThreshold', () => {
    const img = createRaster(3, 1);
    setPixel(img, 0, 0, [0, 0, 0, 127]);
    setPixel(img, 1, 0, [0, 0, 0, 128]);
    setPixel(img, 2, 0, [0, 0, 0, 255]);
    const out = preprocess(img, opts({ denoise: 'none', alphaMode: 'keep', alphaThreshold: 128 }));
    expect(Array.from(out.opaque!)).toEqual([0, 1, 1]);
  });

  it('flatten compose sur le fond', () => {
    const img = createRaster(3, 1);
    setPixel(img, 0, 0, [255, 0, 0, 255]);
    setPixel(img, 1, 0, [255, 0, 0, 128]);
    setPixel(img, 2, 0, [255, 0, 0, 0]);
    const out = preprocess(
      img,
      opts({ denoise: 'none', alphaMode: 'flatten', background: [255, 255, 255] }),
    );
    expect(out.opaque).toBeNull();
    expect(getPixel(out.image, 0, 0)).toEqual([255, 0, 0, 255]);
    const mid = getPixel(out.image, 1, 0);
    expect(mid[0]).toBe(255);
    expect(Math.abs(mid[1] - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(mid[2] - 127)).toBeLessThanOrEqual(1);
    expect(mid[3]).toBe(255);
    expect(getPixel(out.image, 2, 0)).toEqual([255, 255, 255, 255]);
  });

  it('flatten sur un fond coloré', () => {
    const img = createRaster(1, 1);
    const out = preprocess(
      img,
      opts({ denoise: 'none', alphaMode: 'flatten', background: [10, 20, 30] }),
    );
    expect(getPixel(out.image, 0, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe('preprocess — suréchantillonnage', () => {
  it('auto : ×3 sous 96 px, ×2 sous 256 px, sinon ×1', () => {
    expect(resolveUpsample(50, 40, 'auto')).toBe(3);
    expect(resolveUpsample(95, 10, 'auto')).toBe(3);
    expect(resolveUpsample(96, 10, 'auto')).toBe(2);
    expect(resolveUpsample(100, 255, 'auto')).toBe(2);
    expect(resolveUpsample(256, 10, 'auto')).toBe(1);
    expect(resolveUpsample(1000, 800, 'auto')).toBe(1);
    expect(resolveUpsample(1000, 800, 4)).toBe(4);
    expect(resolveUpsample(10, 10, 1)).toBe(1);
  });

  it('dimensions et scale', () => {
    const img = step(50, 40, 0, 255);
    const out = preprocess(img, opts({ denoise: 'none', upsample: 'auto' }));
    expect(out.scale).toBe(3);
    expect(out.image.width).toBe(150);
    expect(out.image.height).toBe(120);
    expect(out.image.data.length).toBe(150 * 120 * 4);
    expect(out.opaque!.length).toBe(150 * 120);

    const forced = preprocess(step(300, 300, 0, 255), opts({ denoise: 'none', upsample: 2 }));
    expect(forced.scale).toBe(2);
    expect(forced.image.width).toBe(600);
  });

  it('interpolation bilinéaire (pas de plus proche voisin)', () => {
    const img = step(4, 1, 0, 200);
    const out = preprocess(img, opts({ denoise: 'none', upsample: 2 }));
    const row = Array.from({ length: 8 }, (_, x) => getPixel(out.image, x, 0)[0]);
    // Bords répliqués, transition interpolée au milieu : 0,0,0,50,150,200,200,200.
    expect(row).toEqual([0, 0, 0, 50, 150, 200, 200, 200]);
  });

  it('masque suréchantillonné (seuil 0,5)', () => {
    const img = createRaster(4, 4);
    for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) setPixel(img, x, y, [0, 0, 255, 255]);
    const out = preprocess(img, opts({ denoise: 'none', alphaMode: 'keep', upsample: 2 }));
    const m = out.opaque!;
    expect(m.length).toBe(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
        expect(m[y * 8 + x]).toBe(inside ? 1 : 0);
      }
    }
  });

  it('les couleurs transparentes ne bavent pas sur les opaques', () => {
    const img = createRaster(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) setPixel(img, x, y, x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 0]);
    }
    const out = preprocess(img, opts({ denoise: 'bilateral', alphaMode: 'keep', upsample: 3 }));
    const W = out.image.width;
    for (let y = 0; y < out.image.height; y++) {
      for (let x = 0; x < W; x++) {
        if (out.opaque![y * W + x] === 1) {
          const [r, g, b] = getPixel(out.image, x, y);
          expect([r, g, b]).toEqual([255, 0, 0]);
        }
      }
    }
  });
});

describe('plafond de pixels de travail (#21, point 3)', () => {
  it('clampUpsample : plus grand facteur qui tient, jamais sous 1', () => {
    expect(MAX_WORK_PIXELS).toBe(4096 * 4096);
    expect(clampUpsample(100, 100, 4)).toBe(4);
    expect(clampUpsample(2048, 2048, 4)).toBe(2);
    expect(clampUpsample(2049, 2048, 2)).toBe(1);
    expect(clampUpsample(4096, 4096, 4)).toBe(1);
    expect(clampUpsample(5000, 5000, 3)).toBe(1);
    expect(clampUpsample(10, 10, 4, 1000)).toBe(3);
    expect(clampUpsample(10, 10, 1, 1)).toBe(1);
  });

  it('preprocess réduit le facteur demandé et le renvoie dans scale', () => {
    const img = createRaster(1100, 1100);
    fillRaster(img, [10, 20, 30]);
    const out = preprocess(img, opts({ denoise: 'none', upsample: 4 }));
    expect(out.scale).toBe(3);
    expect(out.image.width).toBe(3300);
    expect(out.image.width * out.image.height).toBeLessThanOrEqual(MAX_WORK_PIXELS);
  });
});
