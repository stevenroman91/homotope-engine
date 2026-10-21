// T71 — Dégradation reproductible des exemples (`scripts/lib/degrade.ts`) : fonctions pures sur
// tableaux typés, seedées, sans modifier leur entrée.
import { describe, expect, it } from 'vitest';
import {
  addNoise,
  blurByRescale,
  distinctColors,
  downscale,
  rng,
  rotate,
  scanPaper,
  upscaleBilinear,
  upscaleNearest,
} from '../scripts/lib/degrade.ts';
import type { RasterImage } from '../src/engine/types.ts';

function image(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set([...f(x, y), 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const px = (img: RasterImage, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];
/** Moitié gauche noire, moitié droite blanche. */
const edge = image(40, 20, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255]));

describe('degrade', () => {
  it('rng : seedé, dans [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    const xs = Array.from({ length: 200 }, () => a());
    expect(xs).toEqual(Array.from({ length: 200 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(rng(8)()).not.toBe(rng(7)());
  });

  it('downscale : moyenne de boîte', () => {
    const checker = image(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(px(downscale(checker, 1, 1), 0, 0)).toEqual([128, 128, 128, 255]);
    const flat = image(9, 6, () => [10, 20, 30]);
    const small = downscale(flat, 4, 3);
    expect([small.width, small.height]).toEqual([4, 3]);
    expect(distinctColors(small)).toBe(1);
  });

  it('agrandissements : plus proche voisin (carrés), bilinéaire (rampe)', () => {
    const two = image(2, 1, (x) => (x ? [255, 255, 255] : [0, 0, 0]));
    const n = upscaleNearest(two, 4);
    expect([n.width, n.height]).toEqual([8, 4]);
    expect(distinctColors(n)).toBe(2);
    expect(px(n, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(px(n, 4, 0)).toEqual([255, 255, 255, 255]);
    const b = upscaleBilinear(two, 8, 4);
    expect(distinctColors(b)).toBeGreaterThan(2);
  });

  it('blurByRescale : même taille, un bord net devient une rampe', () => {
    const blurred = blurByRescale(edge, 2);
    expect([blurred.width, blurred.height]).toEqual([40, 20]);
    expect(distinctColors(edge)).toBe(2);
    expect(distinctColors(blurred)).toBeGreaterThan(2);
    // Loin du bord, les couleurs restent.
    expect(px(blurred, 2, 10)).toEqual([0, 0, 0, 255]);
    expect(px(blurred, 37, 10)).toEqual([255, 255, 255, 255]);
  });

  it('addNoise : seedé, borné, alpha gardé, entrée intacte', () => {
    const grey = image(30, 30, () => [128, 128, 128]);
    const copy = grey.data.slice();
    const a = addNoise(grey, 3, 1, 2);
    expect(a.data).toEqual(addNoise(grey, 3, 1, 2).data);
    expect(a.data).not.toEqual(addNoise(grey, 3, 2, 2).data);
    expect(grey.data).toEqual(copy);
    for (let i = 0; i < a.data.length; i += 4) {
      for (let c = 0; c < 3; c++) expect(Math.abs(a.data[i + c]! - 128)).toBeLessThanOrEqual(5);
      expect(a.data[i + 3]).toBe(255);
    }
    // Sans bruit coloré : R = G = B.
    const mono = addNoise(grey, 3, 1);
    for (let i = 0; i < mono.data.length; i += 4) {
      expect(mono.data[i]).toBe(mono.data[i + 1]);
    }
  });

  it('rotate : 0° ne change rien, les coins découverts prennent le fond', () => {
    expect(rotate(edge, 0, [9, 9, 9]).data).toEqual(edge.data);
    const square = image(40, 40, () => [255, 255, 255]);
    const r = rotate(square, 45, [9, 9, 9]);
    expect(px(r, 0, 0)).toEqual([9, 9, 9, 255]);
    expect(px(r, 20, 20)).toEqual([255, 255, 255, 255]);
  });

  it('scanPaper : blanc → papier, encre → teinte d’encre adoucie, seedé', () => {
    const o = {
      paper: [240, 235, 220] as const,
      paperEdge: [240, 235, 220] as const,
      ink: [40, 40, 60] as const,
      contrast: 0.8,
      grain: 0,
      vignette: 0,
      seed: 3,
    };
    const s = scanPaper(edge, o);
    expect(s.data).toEqual(scanPaper(edge, o).data);
    const paper = px(s, 35, 10);
    const ink = px(s, 5, 10);
    // Éclairage de 0,96 à 1 : le papier reste proche de sa teinte.
    expect(Math.abs(paper[0]! - 240)).toBeLessThanOrEqual(10);
    // Contraste 0,8 : l'encre n'atteint pas sa teinte pleine (un gris, pas un noir).
    expect(ink[0]!).toBeGreaterThan(40);
    expect(ink[0]!).toBeLessThan(110);
    const grainy = scanPaper(edge, { ...o, grain: 8 });
    expect(distinctColors(grainy)).toBeGreaterThan(distinctColors(s));
  });

  it('distinctColors : compte les RVB, ignore l’alpha', () => {
    const img = image(3, 1, (x) => (x === 2 ? [1, 2, 3] : [0, 0, 0]));
    img.data[3] = 0;
    expect(distinctColors(img)).toBe(2);
  });
});
