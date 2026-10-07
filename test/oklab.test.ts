import { describe, expect, it } from 'vitest';
import {
  oklabDistance,
  oklabToRgb,
  rgbaToOklabArray,
  rgbToOklab,
} from '../src/engine/color/oklab.ts';
import type { Rgb } from '../src/engine/types.ts';
import { mulberry32 } from '../src/engine/color/prng.ts';

describe('OKLab', () => {
  it('blanc → L = 1, a = b = 0', () => {
    const w = rgbToOklab([255, 255, 255]);
    expect(w.L).toBeCloseTo(1, 4);
    expect(Math.abs(w.a)).toBeLessThan(1e-4);
    expect(Math.abs(w.b)).toBeLessThan(1e-4);
  });

  it('noir → 0', () => {
    const k = rgbToOklab([0, 0, 0]);
    expect(k.L).toBe(0);
    expect(k.a).toBe(0);
    expect(k.b).toBe(0);
  });

  it('rouge, vert, bleu contre les valeurs de référence', () => {
    const r = rgbToOklab([255, 0, 0]);
    expect(Math.abs(r.L - 0.628)).toBeLessThan(1e-4);
    expect(Math.abs(r.a - 0.2249)).toBeLessThan(1e-4);
    expect(Math.abs(r.b - 0.1258)).toBeLessThan(1e-4);
    const g = rgbToOklab([0, 255, 0]);
    expect(g.L).toBeCloseTo(0.8664, 3);
    expect(g.a).toBeCloseTo(-0.2339, 3);
    expect(g.b).toBeCloseTo(0.1795, 3);
    const b = rgbToOklab([0, 0, 255]);
    expect(b.L).toBeCloseTo(0.452, 3);
    expect(b.a).toBeCloseTo(-0.0325, 3);
    expect(b.b).toBeCloseTo(-0.3115, 3);
  });

  it('aller-retour exact sur les 256 gris', () => {
    for (let v = 0; v < 256; v++) {
      expect(oklabToRgb(rgbToOklab([v, v, v]))).toEqual([v, v, v]);
    }
  });

  it('aller-retour à ±1 sur un échantillon de couleurs', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const c: Rgb = [(rng() * 256) | 0, (rng() * 256) | 0, (rng() * 256) | 0];
      const back = oklabToRgb(rgbToOklab(c));
      for (let j = 0; j < 3; j++) expect(Math.abs(back[j]! - c[j]!)).toBeLessThanOrEqual(1);
    }
  });

  it('oklabToRgb écrête hors gamut', () => {
    expect(oklabToRgb({ L: 2, a: 0, b: 0 })).toEqual([255, 255, 255]);
    expect(oklabToRgb({ L: -1, a: 0, b: 0 })).toEqual([0, 0, 0]);
  });

  it('rgbaToOklabArray concorde avec rgbToOklab', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 10, 200, 30, 0, 255, 255, 255, 128]);
    const out = new Float32Array(9);
    rgbaToOklabArray(data, out);
    for (let i = 0; i < 3; i++) {
      const ref = rgbToOklab([data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!]);
      expect(out[i * 3]).toBeCloseTo(ref.L, 6);
      expect(out[i * 3 + 1]).toBeCloseTo(ref.a, 6);
      expect(out[i * 3 + 2]).toBeCloseTo(ref.b, 6);
    }
  });

  it('oklabDistance', () => {
    expect(oklabDistance({ L: 0, a: 0, b: 0 }, { L: 0.3, a: 0.4, b: 0 })).toBeCloseTo(0.5, 12);
  });
});

describe('mulberry32', () => {
  it('est déterministe et dans [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});
