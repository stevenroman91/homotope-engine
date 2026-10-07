import type { Oklab, Rgb } from '../types.ts';

// Formules de Björn Ottosson (https://bottosson.github.io/posts/oklab/) :
// sRGB 8 bits → sRGB linéaire → LMS (matrice M1) → racine cubique → OKLab (M2).

/** Composante sRGB normalisée (0..1) → linéaire. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Composante linéaire → sRGB normalisée (0..1), non écrêtée. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Table de linéarisation précalculée pour les 256 valeurs d'un octet sRGB. */
const LINEAR_LUT: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

function linearRgbToOklabInto(
  r: number,
  g: number,
  b: number,
  out: Float32Array | Float64Array,
  o: number,
): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** Conversion sRGB 8 bits → OKLab (via linéaire). */
export function rgbToOklab(rgb: Rgb): Oklab {
  const tmp = new Float64Array(3);
  linearRgbToOklabInto(
    LINEAR_LUT[clampByte(rgb[0])]!,
    LINEAR_LUT[clampByte(rgb[1])]!,
    LINEAR_LUT[clampByte(rgb[2])]!,
    tmp,
    0,
  );
  return { L: tmp[0]!, a: tmp[1]!, b: tmp[2]! };
}

/** Conversion OKLab → sRGB 8 bits (écrêté, arrondi). */
export function oklabToRgb(lab: Oklab): Rgb {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [toByte(linearToSrgb(r)), toByte(linearToSrgb(g)), toByte(linearToSrgb(b))];
}

/**
 * Convertit une image RGBA entière en OKLab : 3 flottants (L, a, b) par pixel
 * dans `out` (longueur ≥ nPixels * 3). L'alpha est ignoré. Sans allocation.
 */
export function rgbaToOklabArray(data: Uint8ClampedArray, out: Float32Array): void {
  const n = data.length >> 2;
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 4, o += 3) {
    linearRgbToOklabInto(
      LINEAR_LUT[data[p]!]!,
      LINEAR_LUT[data[p + 1]!]!,
      LINEAR_LUT[data[p + 2]!]!,
      out,
      o,
    );
  }
}

/** Nombre d'entrées du cache OKLab (puissance de 2). */
const CACHE_BITS = 16;

/**
 * T12 — OKLab d'un pixel, calculé à la volée avec un cache à correspondance
 * directe par couleur RGB exacte (2^16 entrées, 1 Mo) : remplace le tableau
 * OKLab de toute l'image (3 flottants par pixel, 580 Mo à 48 Mpx). Les valeurs
 * sont arrondies en Float32 comme l'était ce tableau : résultats identiques.
 * Usage : `const o = cache.slot(data, p)` puis `cache.lab[o]`, `[o + 1]`, `[o + 2]`.
 */
export class OklabCache {
  /** Clé RGB 24 bits de chaque entrée, -1 = vide. */
  private readonly keys = new Int32Array(1 << CACHE_BITS).fill(-1);
  /** L, a, b de chaque entrée. */
  readonly lab = new Float32Array(3 << CACHE_BITS);

  /** Indice dans `lab` de la couleur du pixel dont l'octet rouge est `data[p]`. */
  slot(data: ArrayLike<number>, p: number): number {
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    const key = (r << 16) | (g << 8) | b;
    const h = Math.imul(key, 0x9e3779b1) >>> (32 - CACHE_BITS);
    const o = h * 3;
    if (this.keys[h] !== key) {
      this.keys[h] = key;
      linearRgbToOklabInto(LINEAR_LUT[r]!, LINEAR_LUT[g]!, LINEAR_LUT[b]!, this.lab, o);
    }
    return o;
  }
}

/** Distance euclidienne en OKLab (perceptuellement uniforme). */
export function oklabDistance(a: Oklab, b: Oklab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function toByte(c: number): number {
  return clampByte(c * 255);
}
