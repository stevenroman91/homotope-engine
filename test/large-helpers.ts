import type { RasterImage } from '../src/engine/types.ts';

const COLORS: readonly (readonly [number, number, number])[] = [
  [240, 238, 230],
  [200, 40, 50],
  [30, 90, 160],
  [250, 190, 30],
  [40, 140, 80],
  [20, 20, 30],
];

/**
 * Aplats synthétiques de `w × h` (T12) : fond, grille de disques et de
 * rectangles de six couleurs, bords nets. Généré à la volée, déterministe ;
 * la taille des formes suit celle de l'image.
 */
export function flatShapes(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const cell = Math.max(8, Math.round(Math.min(w, h) / 12));
  const r2 = (cell * 0.35) ** 2;
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell);
    const fy = (y % cell) - cell / 2;
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell);
      const fx = (x % cell) - cell / 2;
      const k = (cx * 7 + cy * 3) % 5;
      let c = 0;
      if ((cx + cy) % 2 === 0) {
        if (fx * fx + fy * fy < r2) c = 1 + k;
      } else if (Math.abs(fx) < cell * 0.3 && Math.abs(fy) < cell * 0.2) c = 1 + ((k + 2) % 5);
      const [r, g, b] = COLORS[c]!;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/**
 * Scène en coordonnées NORMALISÉES (0..1 sur chaque axe), rendue à `w × h` :
 * la même image à toute résolution, pour comparer une vectorisation d'image
 * réduite à la scène à sa taille d'origine. Un bandeau touche le bord droit.
 */
export function normalizedScene(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      let c = 0;
      if (((u - 0.5) / 0.3) ** 2 + ((v - 0.45) / 0.25) ** 2 < 1) c = 1;
      else if (u > 0.05 && u < 0.25 && v > 0.6 && v < 0.95) c = 2;
      else if (u > 0.85 && v > 0.1 && v < 0.3) c = 3;
      const [r, g, b] = COLORS[c]!;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
