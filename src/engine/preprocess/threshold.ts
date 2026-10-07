/**
 * T50 — Seuil « Noir et blanc » (comme l'option du même nom d'Illustrator) : luminance relative
 * Rec. 709 (`0,2126 R + 0,7152 V + 0,0722 B`, sur les valeurs sRGB 8 bits) ; sous le seuil →
 * noir, sinon → blanc. Fonction PURE sur tableaux typés : `out` reçoit le résultat (il peut être
 * `src`), l'alpha est recopié tel quel et un pixel transparent (`opaque[i] === 0`) n'est pas
 * touché : il reste transparent. Seuil 0 : tout blanc ; seuil 256 et plus : tout noir.
 */
export function thresholdPixels(
  src: ArrayLike<number>,
  out: Uint8ClampedArray,
  n: number,
  threshold: number,
  opaque: Uint8Array | null,
): void {
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (opaque !== null && opaque[i] === 0) {
      if (out !== src) {
        out[p] = src[p]!;
        out[p + 1] = src[p + 1]!;
        out[p + 2] = src[p + 2]!;
      }
    } else {
      // Entiers (× 10 000) : le blanc pur vaut exactement 255 (pas 254,999…).
      const y = 2126 * src[p]! + 7152 * src[p + 1]! + 722 * src[p + 2]!;
      const v = y < threshold * 10000 ? 0 : 255;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
    }
    out[p + 3] = src[p + 3]!;
  }
}

/**
 * Seuil effectif : `null`/absent/non fini = désactivé ; `'auto'` (T52) reste `'auto'` (Otsu,
 * calculé par `preprocess` sur l'image de travail) ; sinon borné à 0..255 et arrondi.
 */
export function effectiveThreshold(t: number | 'auto' | null | undefined): number | 'auto' | null {
  if (t === 'auto') return 'auto';
  if (t === null || t === undefined || !Number.isFinite(t)) return null;
  return Math.max(0, Math.min(255, Math.round(t)));
}

/** Seuil de repli quand l'histogramme ne sépare rien (image uniforme ou vide). */
export const OTSU_FALLBACK = 128;

/**
 * T62 — Écart minimal (en niveaux de luminance) entre les moyennes des deux classes d'Otsu pour
 * qu'elles soient deux NIVEAUX distincts. En deçà, l'histogramme n'a qu'un niveau (une encre
 * seule sur fond transparent, bruitée de ±1 par l'anti-aliasing) : Otsu le couperait quand même
 * en deux, et les pixels de bord ou isolés deviendraient un liseré et des îles de l'autre couleur.
 */
export const OTSU_MIN_GAP = 32;

/**
 * T52 — Histogramme (256 classes) de la luminance Rec. 709 des pixels OPAQUES : la classe `b`
 * compte les pixels de luminance dans `[b, b + 1)`, la même échelle entière que
 * `thresholdPixels` (un seuil `t` envoie au noir exactement les classes `< t`). Un pixel
 * transparent (`opaque[i] === 0`) n'est pas compté. Fonction PURE.
 */
export function luminanceHistogram(
  src: ArrayLike<number>,
  n: number,
  opaque: Uint8Array | null,
): Uint32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    if (opaque !== null && opaque[i] === 0) continue;
    const p = i * 4;
    const y = 2126 * src[p]! + 7152 * src[p + 1]! + 722 * src[p + 2]!;
    hist[Math.min(255, Math.floor(y / 10000))]!++;
  }
  return hist;
}

/**
 * T52 — Seuil d'Otsu (1979) : la coupure qui maximise la variance INTER-classes de
 * l'histogramme (256 classes). Renvoie `t` tel que les classes `< t` vont au noir (1 à 255).
 * Quand plusieurs coupures font jeu égal (deux niveaux nets séparés par des classes vides),
 * le MILIEU du plateau : le seuil tombe à mi-chemin des deux niveaux, pas collé au plus
 * sombre. Aucune séparation possible (moins de deux classes non vides) : `OTSU_FALLBACK`.
 * T62 — UN seul niveau (moyennes des deux classes à moins de `OTSU_MIN_GAP`) : aucune coupure
 * dans la masse ; `OTSU_FALLBACK` s'il la laisse déjà d'un seul côté, sinon le seuil passe
 * juste au-delà de la masse, du côté de sa moyenne (sombre → tout noir, claire → tout blanc).
 * Renvoie un seuil de 0 à 255. Fonction PURE.
 */
export function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  let sumAll = 0;
  for (let b = 0; b < 256; b++) {
    total += hist[b]!;
    sumAll += b * hist[b]!;
  }
  if (total === 0) return OTSU_FALLBACK;
  let w0 = 0;
  let sum0 = 0;
  let best = 0;
  let first = -1;
  let last = -1;
  for (let k = 0; k < 255; k++) {
    w0 += hist[k]!;
    sum0 += k * hist[k]!;
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const d = sum0 / w0 - (sumAll - sum0) / w1;
    const between = w0 * w1 * d * d;
    // Égalité à l'arrondi près : les sommes sont entières, l'écart relatif suffit.
    if (between > best * (1 + 1e-12)) {
      best = between;
      first = k;
      last = k;
    } else if (first >= 0 && between >= best * (1 - 1e-12)) {
      last = k;
    }
  }
  if (first < 0 || best === 0) return OTSU_FALLBACK;
  // Classe 0 = [0, k] : le seuil est k + 1.
  const t = Math.floor((first + last) / 2) + 1;
  let wDark = 0;
  let sDark = 0;
  let lo = 255;
  let hi = 0;
  for (let b = 0; b < 256; b++) {
    if (hist[b]! === 0) continue;
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
    if (b < t) {
      wDark += hist[b]!;
      sDark += b * hist[b]!;
    }
  }
  const gap = (sumAll - sDark) / (total - wDark) - sDark / wDark;
  if (gap >= OTSU_MIN_GAP) return t;
  // Un seul niveau : la masse entière d'un côté du seuil.
  if (hi < OTSU_FALLBACK || lo >= OTSU_FALLBACK) return OTSU_FALLBACK;
  return sumAll / total < OTSU_FALLBACK ? Math.min(255, hi + 1) : lo;
}
