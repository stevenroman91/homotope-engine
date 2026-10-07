// T50 — Préréglage « Noir et blanc » : un SEUIL de luminosité (Rec. 709), pas un k-means à 2
// couleurs. Fonction pure (seuils 0, 128, 255, image unie, alpha), prétraitement (appliqué
// après le suréchantillonnage, entrée jamais écrite) et sortie à exactement 2 couleurs.
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { preprocess } from '../src/engine/preprocess/index.ts';
import { effectiveThreshold, thresholdPixels } from '../src/engine/preprocess/threshold.ts';
import { DEFAULT_OPTIONS, presetOptions } from '../src/engine/presets.ts';
import type { PreprocessOptions, RasterImage, Rgb } from '../src/engine/types.ts';

const px = (colors: Array<[...Rgb, number]>): Uint8ClampedArray =>
  Uint8ClampedArray.from(colors.flat());

describe('thresholdPixels (pur)', () => {
  // Luminances : (100,100,100) → 100 ; rouge pur → 54,2 ; vert pur → 182,4 ; bleu pur → 18,4.
  const src = px([
    [100, 100, 100, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [127, 128, 128, 255],
  ]);
  const run = (t: number, opaque: Uint8Array | null = null) => {
    const out = new Uint8ClampedArray(src.length);
    thresholdPixels(src, out, 5, t, opaque);
    return Array.from({ length: 5 }, (_, i) => out[i * 4]);
  };

  it('Rec. 709 : sous le seuil → noir, sinon → blanc (vert clair, rouge et bleu sombres)', () => {
    expect(run(128)).toEqual([0, 0, 255, 0, 0]);
    // 127,7 < 128 : noir ; à 127, blanc.
    expect(run(127)[4]).toBe(255);
  });

  it('seuil 0 : tout blanc ; 255 : tout noir sauf le blanc pur', () => {
    expect(run(0)).toEqual([255, 255, 255, 255, 255]);
    expect(run(255)).toEqual([0, 0, 0, 0, 0]);
    const white = px([[255, 255, 255, 255]]);
    thresholdPixels(white, white, 1, 255, null);
    expect(Array.from(white)).toEqual([255, 255, 255, 255]);
  });

  it('pixels transparents inchangés, alpha recopié, sortie = entrée admise', () => {
    const a = px([
      [10, 10, 10, 0],
      [200, 200, 200, 255],
    ]);
    thresholdPixels(a, a, 2, 128, Uint8Array.from([0, 1]));
    expect(Array.from(a)).toEqual([10, 10, 10, 0, 255, 255, 255, 255]);
  });

  it('effectiveThreshold : null/absent/NaN désactivé, borné et arrondi', () => {
    expect(effectiveThreshold(null)).toBeNull();
    expect(effectiveThreshold(undefined)).toBeNull();
    expect(effectiveThreshold(Number.NaN)).toBeNull();
    expect(effectiveThreshold(-5)).toBe(0);
    expect(effectiveThreshold(300)).toBe(255);
    expect(effectiveThreshold(127.6)).toBe(128);
  });
});

/** Dégradé horizontal de gris, 64 × 8, opaque. */
function gradient(): RasterImage {
  const w = 64;
  const h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data.set([x * 4, x * 4, x * 4, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

const pre = (o: Partial<PreprocessOptions>): PreprocessOptions => ({
  ...DEFAULT_OPTIONS.preprocess,
  denoise: 'none',
  ...o,
});

describe('preprocess — seuil', () => {
  it('absent ou null : sortie identique (données partagées, comme avant)', () => {
    const img = gradient();
    expect(preprocess(img, pre({ upsample: 1 })).image.data).toBe(img.data);
    expect(preprocess(img, pre({ upsample: 1, threshold: null })).image.data).toBe(img.data);
  });

  it('seuil : que du noir et du blanc, APRÈS le suréchantillonnage ; entrée jamais écrite', () => {
    const img = gradient();
    const copy = Uint8ClampedArray.from(img.data);
    const r = preprocess(img, pre({ upsample: 3, threshold: 128 }));
    expect(r.scale).toBe(3);
    const values = new Set<number>();
    for (let i = 0; i < r.image.data.length; i += 4) values.add(r.image.data[i]!);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    expect(Array.from(img.data)).toEqual(Array.from(copy));
  });

  it('alpha `keep` : un pixel transparent reste transparent', () => {
    const img: RasterImage = {
      width: 2,
      height: 1,
      data: px([
        [0, 0, 0, 0],
        [30, 30, 30, 255],
      ]),
    };
    const r = preprocess(img, pre({ upsample: 1, threshold: 128 }));
    expect(Array.from(r.opaque!)).toEqual([0, 1]);
    expect(Array.from(r.image.data)).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
  });
});

describe('préréglage « Noir et blanc »', () => {
  const o = presetOptions('black-white');

  it('seuil automatique (T52), 2 couleurs ; DEFAULT_OPTIONS sans seuil', () => {
    expect(o.preprocess.threshold).toBe('auto');
    expect(o.quantize.colors).toBe(2);
    expect('threshold' in DEFAULT_OPTIONS.preprocess).toBe(false);
  });

  it('un dégradé de gris sort en EXACTEMENT noir et blanc, aucune teinte inventée', () => {
    const r = vectorize(gradient(), o);
    expect(r.palette.colors.map((c) => c.rgb).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const fills = new Set([...r.svg.matchAll(/fill="(#[0-9a-f]+)"/g)].map((m) => m[1]));
    expect([...fills].sort()).toEqual(['#000', '#fff']);
  });

  it('une image en couleurs (rouge, bleu, jaune) : 2 couleurs seulement en sortie', () => {
    const w = 30;
    const data = new Uint8ClampedArray(w * 10 * 4);
    const cols: Rgb[] = [
      [220, 30, 40],
      [30, 60, 200],
      [250, 230, 60],
    ];
    for (let i = 0; i < w * 10; i++) data.set([...cols[Math.floor((i % w) / 10)]!, 255], i * 4);
    const r = vectorize({ width: w, height: 10, data }, o);
    expect(r.palette.colors).toHaveLength(2);
    for (const c of r.palette.colors) expect([0, 255]).toContain(c.rgb[0]);
  });

  it('image unie : une seule couleur peinte, sans invention', () => {
    const data = new Uint8ClampedArray(16 * 16 * 4).fill(40);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const pre1 = preprocess({ width: 16, height: 16, data }, { ...o.preprocess, upsample: 1 });
    const q = quantize(pre1, o.quantize);
    // k = 2 imposé : le second centroïde est vide ; aucune teinte hors du noir.
    expect(q.palette.colors.filter((c) => c.count > 0).map((c) => c.rgb)).toEqual([[0, 0, 0]]);
    for (const c of q.palette.colors) expect(c.rgb).toEqual([0, 0, 0]);
  });
});
