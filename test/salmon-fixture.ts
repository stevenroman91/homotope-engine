import { mulberry32 } from '../src/engine/color/prng.ts';
import type { RasterImage } from '../src/engine/types.ts';

/**
 * T52 — Cas de la testeuse, synthétique (aucune image binaire) : dessin au crayon SAUMON
 * (luminance ≈ 150) sur papier CRÈME (≈ 226), photographié au téléphone (grain ± 6, léger
 * vignetage), avec des lettres du verso qui transparaissent (≈ 205). Le dessin : un cercle et
 * une vague, trait de `stroke` px. Renvoie l'image et le masque du dessin (1 = crayon).
 */
export function salmonOnCream(
  w = 240,
  h = 180,
  stroke = 5,
): { image: RasterImage; drawing: Uint8Array } {
  const rng = mulberry32(52);
  const data = new Uint8ClampedArray(w * h * 4);
  const drawing = new Uint8Array(w * h);
  const cx = w * 0.38;
  const cy = h * 0.5;
  const R = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ring = Math.abs(Math.hypot(px - cx, py - cy) - R) < stroke / 2;
      const waveY = h * 0.5 + Math.sin((px / w) * Math.PI * 4) * h * 0.18;
      const wave = px > w * 0.62 && px < w * 0.95 && Math.abs(py - waveY) < stroke / 2;
      // Verso : trois « lettres » (barres pâles) en haut à droite.
      const verso =
        y > h * 0.08 && y < h * 0.2 && x > w * 0.6 && x < w * 0.9 && Math.floor(x / 6) % 2 === 0;
      const ink = ring || wave;
      drawing[y * w + x] = ink ? 1 : 0;
      const vignette = 1 - 0.04 * (Math.hypot(px - w / 2, py - h / 2) / Math.hypot(w / 2, h / 2));
      const grain = (rng() - 0.5) * 12;
      // Saumon (250, 128, 114) → 152,9 ; crème (240, 225, 195) → 226,0 ; verso (215, 205, 180).
      const base = ink ? [250, 128, 114] : verso ? [215, 205, 180] : [240, 225, 195];
      const p = (y * w + x) * 4;
      data[p] = base[0]! * vignette + grain;
      data[p + 1] = base[1]! * vignette + grain;
      data[p + 2] = base[2]! * vignette + grain;
      data[p + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data }, drawing };
}
