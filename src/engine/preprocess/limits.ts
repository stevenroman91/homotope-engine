/**
 * Plafonds de pixels de travail (relecture R3, #21, point 3 ; T12). Partagés par
 * le moteur (`preprocess`) et l'interface (avant l'envoi au worker) : les deux
 * doivent retenir le MÊME facteur de suréchantillonnage et la même taille de travail.
 */

/** Un mégapixel, au sens des réglages : 2^20 pixels (1024²). */
export const MEGAPIXEL = 1_048_576;

/**
 * Pixels de travail maximaux APRÈS suréchantillonnage : 16 Mpx (4096²). Ne
 * plafonne que l'agrandissement des petites images : une image plus grande est
 * traitée à sa taille réelle (T12).
 */
export const MAX_WORK_PIXELS = 16 * MEGAPIXEL;

/** Budget du mode « calcul rapide » (T12) : l'image est réduite à ce nombre de pixels. */
export const FAST_PIXEL_BUDGET = 16 * MEGAPIXEL;

/**
 * Plus grand facteur entier `s ≤ requested` tel que `width·height·s² ≤ maxPixels`, et
 * jamais moins de 1 : une image déjà au-delà du plafond est traitée à ×1, sans erreur.
 */
export function clampUpsample(
  width: number,
  height: number,
  requested: number,
  maxPixels: number = MAX_WORK_PIXELS,
): number {
  let s = Math.max(1, Math.floor(requested));
  const area = width * height;
  while (s > 1 && area * s * s > maxPixels) s--;
  return s;
}

export interface WorkingSize {
  width: number;
  height: number;
  /** Facteur de réduction nominal (≤ 1) : `√(pixels de travail / pixels d'origine)`. */
  factor: number;
  /** Vrai si l'image est réduite. */
  reduced: boolean;
}

/**
 * T12 — Taille de travail d'une image `width × height`. Par défaut (`budget`
 * infini) : la taille d'ORIGINE, jamais de réduction. En mode « calcul
 * rapide », la plus grande taille aux mêmes proportions (arrondi au pixel) dont
 * l'aire tient dans `budget` pixels ; jamais d'agrandissement, au moins 1 px de côté.
 */
export function workingSize(width: number, height: number, budget = Infinity): WorkingSize {
  const area = width * height;
  if (!(area > budget)) return { width, height, factor: 1, reduced: false };
  const k = Math.sqrt(budget / area);
  let w = Math.max(1, Math.round(width * k));
  let h = Math.max(1, Math.round(height * k));
  // L'arrondi peut dépasser le budget d'une ligne ou d'une colonne : on retire au plus large.
  while (w * h > budget && (w > 1 || h > 1)) {
    if (w / width >= h / height && w > 1) w--;
    else h--;
  }
  return { width: w, height: h, factor: Math.sqrt((w * h) / area), reduced: true };
}
