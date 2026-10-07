// T52 — Préréglages lisibles : seuil d'Otsu du « Noir et blanc » (fonction pure, prétraitement,
// cas de la testeuse saumon sur crème) et épaisseur médiane des traits (« Trait unique » guidé).
import { describe, expect, it } from 'vitest';
import {
  medianStrokeWidth,
  skeletonizeMask,
  THICK_STROKE_PX,
} from '../src/engine/centerline/index.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { preprocess } from '../src/engine/preprocess/index.ts';
import {
  effectiveThreshold,
  luminanceHistogram,
  OTSU_FALLBACK,
  OTSU_MIN_GAP,
  otsuThreshold,
} from '../src/engine/preprocess/threshold.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type { RasterImage } from '../src/engine/types.ts';
import { salmonOnCream } from './salmon-fixture.ts';

const hist = (bins: Array<[bin: number, count: number]>): Uint32Array => {
  const h = new Uint32Array(256);
  for (const [b, c] of bins) h[b] = c;
  return h;
};

/** Otsu par force brute (référence) : toutes les coupures, variance inter-classes maximale. */
function bruteBest(h: Uint32Array): number[] {
  let best = -1;
  const ks: number[] = [];
  for (let k = 0; k < 255; k++) {
    let w0 = 0;
    let s0 = 0;
    let w1 = 0;
    let s1 = 0;
    for (let b = 0; b < 256; b++) {
      if (b <= k) {
        w0 += h[b]!;
        s0 += b * h[b]!;
      } else {
        w1 += h[b]!;
        s1 += b * h[b]!;
      }
    }
    if (w0 === 0 || w1 === 0) continue;
    const v = w0 * w1 * (s0 / w0 - s1 / w1) ** 2;
    if (v > best + 1e-6) {
      best = v;
      ks.length = 0;
    }
    if (Math.abs(v - best) <= 1e-6) ks.push(k + 1);
  }
  return ks;
}

describe('otsuThreshold (pur)', () => {
  it('bimodal net : le seuil tombe au milieu des deux niveaux', () => {
    const t = otsuThreshold(
      hist([
        [150, 800],
        [226, 9200],
      ]),
    );
    expect(t).toBeGreaterThan(150);
    expect(t).toBeLessThanOrEqual(226);
    expect(Math.abs(t - 188)).toBeLessThanOrEqual(1);
  });

  it('bimodal bruité : égal à la référence par force brute', () => {
    const h = new Uint32Array(256);
    for (let d = -8; d <= 8; d++) {
      h[60 + d] = 100 - Math.abs(d) * 10;
      h[200 + d] = 300 - Math.abs(d) * 30;
    }
    const t = otsuThreshold(h);
    expect(bruteBest(h)).toContain(t);
    expect(t).toBeGreaterThan(68);
    expect(t).toBeLessThanOrEqual(192);
  });

  it('image uniforme ou vide : repli 128', () => {
    expect(OTSU_FALLBACK).toBe(128);
    expect(otsuThreshold(hist([[40, 1000]]))).toBe(128);
    expect(otsuThreshold(new Uint32Array(256))).toBe(128);
  });

  it('T62 — un seul niveau bruité (encre ±1) : jamais coupé en deux', () => {
    // Encre bleu nuit (≈ 33) dont l'anti-aliasing décale le RGB de ±1 : Otsu seul coupait à 34.
    expect(
      otsuThreshold(
        hist([
          [32, 300],
          [33, 9000],
          [34, 400],
        ]),
      ),
    ).toBe(128);
    // Masse à cheval sur 128 : le seuil passe au-delà, du côté de sa moyenne.
    const dark = hist([
      [120, 5000],
      [130, 1000],
    ]);
    expect(otsuThreshold(dark)).toBe(131);
    const light = hist([
      [126, 1000],
      [136, 5000],
    ]);
    expect(otsuThreshold(light)).toBe(126);
    expect(OTSU_MIN_GAP).toBe(32);
  });

  it('trois niveaux : la coupure de la force brute, entre deux niveaux', () => {
    const h = hist([
      [30, 500],
      [120, 2000],
      [230, 6000],
    ]);
    const t = otsuThreshold(h);
    const plateau = bruteBest(h);
    expect(t).toBeGreaterThanOrEqual(Math.min(...plateau));
    expect(t).toBeLessThanOrEqual(Math.max(...plateau));
    // Le niveau du milieu, plus proche du sombre que du clair en effectif pondéré, va au noir.
    expect(t).toBeGreaterThan(120);
    expect(t).toBeLessThanOrEqual(230);
  });

  it('les extrêmes : 0 et 255 seuls → un seuil qui les sépare', () => {
    const t = otsuThreshold(
      hist([
        [0, 10],
        [255, 10],
      ]),
    );
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(255);
  });
});

describe('luminanceHistogram (pur)', () => {
  it('Rec. 709 par classes entières ; pixels transparents ignorés', () => {
    const src = Uint8ClampedArray.from([
      ...[100, 100, 100, 255],
      ...[255, 255, 255, 255],
      ...[0, 0, 0, 0],
      ...[0, 255, 0, 255],
    ]);
    const h = luminanceHistogram(src, 4, Uint8Array.from([1, 1, 0, 1]));
    expect(h[100]).toBe(1);
    expect(h[255]).toBe(1);
    expect(h[182]).toBe(1); // vert pur : 182,4
    expect(h[0]).toBe(0); // transparent : pas compté
    expect(h.reduce((a, b) => a + b, 0)).toBe(3);
    // Sans masque : tout compte.
    expect(luminanceHistogram(src, 4, null)[0]).toBe(1);
  });

  it('pixels transparents ignorés par le seuil automatique', () => {
    // Moitié transparente noire (ignorée), moitié opaque 80 / 220.
    const n = 40;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = i < 20 ? 0 : i < 30 ? 80 : 220;
      data.set([v, v, v, i < 20 ? 0 : 255], i * 4);
    }
    const r = preprocess(
      { width: n, height: 1, data },
      { ...presetOptions('black-white').preprocess, denoise: 'none', upsample: 1 },
    );
    expect(r.threshold).toBeGreaterThan(80);
    expect(r.threshold).toBeLessThanOrEqual(220);
  });
});

describe("preprocess — threshold: 'auto'", () => {
  it("effectiveThreshold laisse passer 'auto'", () => {
    expect(effectiveThreshold('auto')).toBe('auto');
  });

  it('seuil renvoyé : le nombre retenu (auto) ou fixé ; absent si désactivé', () => {
    const { image } = salmonOnCream(60, 40);
    const base = { ...presetOptions('black-white').preprocess, upsample: 1 as const };
    expect(preprocess(image, base).threshold).toBeGreaterThan(153);
    expect(preprocess(image, { ...base, threshold: 90 }).threshold).toBe(90);
    expect(preprocess(image, { ...base, threshold: null }).threshold).toBeUndefined();
  });
});

/** Pixels noirs du résultat de prétraitement (image de travail, ramenés à l'échelle d'origine). */
function blackArea(image: RasterImage, threshold: number | 'auto'): number {
  const o = presetOptions('black-white');
  const r = preprocess(image, { ...o.preprocess, threshold });
  let n = 0;
  for (let i = 0; i < r.image.data.length; i += 4) if (r.image.data[i] === 0) n++;
  return n / (r.scale * r.scale);
}

describe('« Noir et blanc » sur un crayon saumon photographié (retour testeuse)', () => {
  const { image, drawing } = salmonOnCream();
  const drawn = drawing.reduce((a, b) => a + b, 0);

  it('régression : un seuil fixe de 128 efface le dessin', () => {
    expect(blackArea(image, 128)).toBeLessThan(drawn * 0.05);
  });

  it('seuil automatique : le dessin devient NOIR, surface comparable au dessin', () => {
    const a = blackArea(image, 'auto');
    expect(a).toBeGreaterThan(drawn * 0.8);
    expect(a).toBeLessThan(drawn * 1.25);
  });

  it('vectorize : une forme noire de surface comparable, seuil effectif dans les diagnostics', () => {
    const r = vectorize(image, presetOptions('black-white'));
    const t = r.diagnostics?.threshold;
    expect(t).toBeGreaterThan(153);
    expect(t).toBeLessThan(226);
    const black = r.palette.colors.find((c) => c.rgb[0] === 0);
    expect(black).toBeDefined();
    // `count` est en pixels de travail (suréchantillonnage auto des petites images).
    const scale =
      (r.palette.colors.reduce((a, c) => a + c.count, 0) / (image.width * image.height)) ** 0.5;
    const area = black!.count / (scale * scale);
    expect(area).toBeGreaterThan(drawn * 0.8);
    expect(area).toBeLessThan(drawn * 1.25);
    expect(r.svg).toMatch(/fill="#000"/);
  });

  it('sans seuil (autres préréglages) : aucun diagnostic de seuil', () => {
    const r = vectorize(salmonOnCream(60, 40).image, presetOptions('logo'));
    expect(r.diagnostics?.threshold).toBeUndefined();
  });
});

/** Masque paddé d'un trait horizontal d'épaisseur `N` (et de longueur `len`). */
function barMask(w: number, h: number, N: number, len: number): Uint8Array {
  const W = w + 2;
  const m = new Uint8Array(W * (h + 2));
  const y0 = Math.floor((h - N) / 2);
  const x0 = Math.floor((w - len) / 2);
  for (let y = y0; y < y0 + N; y++) for (let x = x0; x < x0 + len; x++) m[(y + 1) * W + x + 1] = 1;
  return m;
}

const CL = { enabled: true, minWidth: 1, spurLength: 4, tolerance: 0.6 };

describe('medianStrokeWidth (pur)', () => {
  it.each([1, 3, 5, 9, 14])('trait de %i px : épaisseur médiane ≈ %i', (N) => {
    const w = 120;
    const h = 40;
    const sk = skeletonizeMask(barMask(w, h, N, 80), w, h, CL);
    const m = medianStrokeWidth(sk.pixels, sk.dist2, w);
    expect(Math.abs(m - N)).toBeLessThanOrEqual(1);
  });

  it('squelette vide : 0', () => {
    expect(medianStrokeWidth(new Int32Array(0), new Uint16Array(4), 2)).toBe(0);
  });

  it('seuil « traits épais » à 6 px', () => {
    expect(THICK_STROKE_PX).toBe(6);
  });
});

describe('« Trait unique » : épaisseur rendue dans les diagnostics (px d’origine)', () => {
  it('traits fins (2 px) sous le seuil ; traits épais (12 px) au-dessus', () => {
    const fine = vectorize(salmonOnCream(240, 180, 2).image, presetOptions('centerline'));
    const thick = vectorize(salmonOnCream(240, 180, 12).image, presetOptions('centerline'));
    expect(fine.diagnostics?.strokeWidth).toBeLessThan(THICK_STROKE_PX);
    expect(thick.diagnostics?.strokeWidth).toBeGreaterThan(THICK_STROKE_PX);
    expect(Math.abs(thick.diagnostics!.strokeWidth! - 12)).toBeLessThanOrEqual(2);
  });

  it('l’aperçu du centre-ligne est le TRAIT exporté : chemins `stroke`, aucun remplissage', () => {
    const r = vectorize(salmonOnCream(240, 180, 12).image, presetOptions('centerline'));
    const paths = [...r.svg.matchAll(/<path [^>]*>/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toMatch(/fill="none"/);
      expect(p).toMatch(/stroke-width="/);
    }
    expect(r.svg).not.toMatch(/<rect/);
  });
});
