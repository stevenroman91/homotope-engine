// T50 — Scène synthétique partagée par les tests de palette (transparent, recoloriage).
import type { RasterImage, Rgb } from '../src/engine/types.ts';

export const COLORS = {
  W: [255, 255, 255],
  R: [220, 30, 40],
  B: [30, 60, 200],
  G: [40, 180, 70],
} satisfies Record<string, Rgb>;

/** Image depuis de l'ASCII, chaque caractère agrandi en `k × k` pixels. */
export function rasterFromAscii(rows: string[], k = 4): RasterImage {
  const w = rows[0]!.length * k;
  const h = rows.length * k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = (COLORS as Record<string, Rgb>)[rows[Math.floor(y / k)]![Math.floor(x / k)]!]!;
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

/** Fond blanc (le plus grand), anneau rouge qui entoure un carré bleu, tache verte au bord. */
export const SCENE = [
  'WWWWWWWWWWWW',
  'WRRRRRRWWWWW',
  'WRBBBBRWWWWW',
  'WRBBBBRWWWWG',
  'WRRRRRRWWWWG',
  'WWWWWWWWWWWW',
  'WWWWWWWWWWWW',
];
