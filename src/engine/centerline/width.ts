/**
 * T52 — Épaisseur MÉDIANE des traits, pour guider le choix du préréglage « Trait unique »
 * (conçu pour des traits fins : laser, traceur, broderie). Fonction PURE sur tableaux typés.
 *
 * Mesure : sur chaque pixel du squelette, la transformée de distance donne le demi-trait `r`
 * (distance au papier) ; l'épaisseur locale vaut `2r − 1` (la convention de `graph.ts`), au
 * moins 1 px. La médiane résiste aux bouts de trait (amincis) et aux jonctions (épaissies).
 */

/** Épaisseur médiane (px d'ORIGINE) au-delà de laquelle « Trait unique » est déconseillé. */
export const THICK_STROKE_PX = 6;

/**
 * `pixels` : indices PADDÉS (`(w + 2)` par ligne, bordure de 1) des pixels du squelette ;
 * `dist2` : distances² de l'encre (w·h, sans bordure, `squaredDistance`). Squelette vide : 0.
 */
export function medianStrokeWidth(pixels: Int32Array, dist2: Uint16Array, w: number): number {
  const n = pixels.length;
  if (n === 0) return 0;
  const W = w + 2;
  const widths = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pixels[i]!;
    const r = Math.sqrt(dist2[(Math.floor(p / W) - 1) * w + (p % W) - 1]!);
    widths[i] = Math.max(1, 2 * r - 1);
  }
  widths.sort();
  const m = n >> 1;
  return n % 2 === 1 ? widths[m]! : (widths[m - 1]! + widths[m]!) / 2;
}
