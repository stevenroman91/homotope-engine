import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  PreprocessOptions,
  PreprocessResult,
  RasterImage,
  VectorizeContext,
} from '../types.ts';
import {
  alphaMask,
  bilateralFilter,
  flattenOnto,
  medianFilter,
  upsampleBilinear,
} from './kernels.ts';
import { clampUpsample } from './limits.ts';
import {
  effectiveThreshold,
  luminanceHistogram,
  otsuThreshold,
  thresholdPixels,
} from './threshold.ts';

export {
  effectiveThreshold,
  luminanceHistogram,
  OTSU_FALLBACK,
  otsuThreshold,
  thresholdPixels,
} from './threshold.ts';
export {
  clampUpsample,
  FAST_PIXEL_BUDGET,
  MAX_WORK_PIXELS,
  MEGAPIXEL,
  workingSize,
} from './limits.ts';

/** Pixels débruités entre deux points d'annulation / de progression (~1 Mpx). */
const BAND_PIXELS = 1 << 20;

/**
 * Facteur de suréchantillonnage retenu : `auto` → ×3 si le plus grand côté est
 * < 96 px, ×2 s'il est < 256 px, sinon ×1 ; une valeur numérique est imposée.
 */
export function resolveUpsample(
  width: number,
  height: number,
  upsample: PreprocessOptions['upsample'],
): number {
  if (upsample !== 'auto') return upsample;
  const side = Math.max(width, height);
  if (side < 96) return 3;
  if (side < 256) return 2;
  return 1;
}

/** Écart-type couleur du bilatéral (niveaux 8 bits) pour une force 0..1. */
export function bilateralSigmaColor(strength: number): number {
  return Math.max(1, 60 * strength);
}

/** Écart-type spatial du bilatéral (pixels), dérivé du rayon. */
export function bilateralSigmaSpatial(radius: number): number {
  return (radius + 1) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * T01 — Prétraitement : débruitage préservant les bords (bilatéral / médian),
 * gestion de la transparence, suréchantillonnage des petites images.
 *
 * Ordre : transparence (masque ou composition) → débruitage à la résolution
 * d'origine (le bruit vit à cette échelle, et c'est moins cher) →
 * suréchantillonnage bilinéaire → seuil noir et blanc (T50, si `threshold`). L'image d'entrée n'est jamais modifiée.
 */
export function preprocess(
  image: RasterImage,
  options: PreprocessOptions,
  ctx?: VectorizeContext,
): PreprocessResult {
  const { width, height } = image;
  const n = width * height;
  if (image.data.length !== n * 4) {
    throw new Error(`preprocess : données de longueur ${image.data.length}, attendu ${n * 4}`);
  }

  // 1. Transparence. En mode `keep`, aucune copie (T12) : l'entrée est lue
  // telle quelle, jamais écrite ; sans débruitage ni suréchantillonnage, le
  // résultat PARTAGE ses données (lecture seule pour les étapes suivantes).
  let rgba: Uint8ClampedArray;
  let opaque: Uint8Array | null = null;
  if (options.alphaMode === 'flatten') {
    rgba = new Uint8ClampedArray(n * 4);
    const [r, g, b] = options.background;
    flattenOnto(image.data, rgba, n, r, g, b);
  } else {
    rgba = image.data;
    opaque = new Uint8Array(n);
    alphaMask(rgba, n, options.alphaThreshold, opaque);
  }

  // 2. Débruitage.
  const radius = Math.round(clamp(options.denoiseRadius, 1, 4));
  const strength = clamp(options.denoiseStrength, 0, 1);
  if (options.denoise !== 'none' && n > 0) {
    const out = new Uint8ClampedArray(n * 4);
    // Par bandes d'environ 1 Mpx : annulation et progression dans la boucle longue.
    const band = Math.max(1, Math.floor(BAND_PIXELS / width));
    for (let y = 0; y < height; y += band) {
      const y1 = Math.min(height, y + band);
      if (options.denoise === 'bilateral') {
        bilateralFilter(
          rgba,
          out,
          width,
          height,
          opaque,
          radius,
          bilateralSigmaSpatial(radius),
          bilateralSigmaColor(strength),
          y,
          y1,
        );
      } else {
        medianFilter(rgba, out, width, height, opaque, radius, strength, y, y1);
      }
      checkCancel(ctx);
      ctx?.onProgress?.(globalProgress('preprocess', (0.9 * y1) / height));
    }
    rgba = out;
  }

  // 3. Suréchantillonnage, plafonné à MAX_WORK_PIXELS pixels de travail.
  const scale =
    n > 0 ? clampUpsample(width, height, resolveUpsample(width, height, options.upsample)) : 1;
  let w = width;
  let h = height;
  let mask = opaque;
  if (scale !== 1) {
    w = width * scale;
    h = height * scale;
    const up = new Uint8ClampedArray(w * h * 4);
    const upMask = opaque !== null ? new Uint8Array(w * h) : null;
    upsampleBilinear(rgba, width, height, scale, opaque, up, upMask);
    rgba = up;
    mask = upMask;
  }

  // 4. T50 — Seuil « Noir et blanc », EN DERNIER : après le suréchantillonnage bilinéaire, qui
  // réintroduirait des gris ; la quantification ne voit que du noir et du blanc.
  // T52 — `'auto'` : seuil d'Otsu sur l'image de travail (débruitée, suréchantillonnée), pixels
  // opaques seuls, calculé UNE fois ; le seuil retenu est renvoyé (`threshold`).
  const eff = effectiveThreshold(options.threshold);
  if (eff !== null) {
    const t = eff === 'auto' ? otsuThreshold(luminanceHistogram(rgba, w * h, mask)) : eff;
    // L'entrée n'est jamais écrite : copie si les données sont encore partagées.
    const out = rgba === image.data ? new Uint8ClampedArray(rgba.length) : rgba;
    thresholdPixels(rgba, out, w * h, t, mask);
    return { image: { width: w, height: h, data: out }, scale, opaque: mask, threshold: t };
  }
  return { image: { width: w, height: h, data: rgba }, scale, opaque: mask };
}
