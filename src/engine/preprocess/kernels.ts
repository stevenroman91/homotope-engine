/**
 * Noyaux de prétraitement : fonctions PURES sur tableaux typés (RGBA 8 bits
 * row-major), sans allocation dans les boucles internes. Ce sont les cibles
 * d'un futur portage WebAssembly : aucune dépendance au reste du moteur.
 *
 * Convention de masque : `mask[i] = 1` → le pixel i participe (opaque) ;
 * `mask = null` → tous les pixels participent.
 */

/** Masque d'opacité : 1 si alpha ≥ `threshold`. */
export function alphaMask(
  src: Uint8ClampedArray,
  n: number,
  threshold: number,
  out: Uint8Array,
): void {
  for (let i = 0; i < n; i++) out[i] = src[i * 4 + 3]! >= threshold ? 1 : 0;
}

/**
 * Composition « over » sur un fond opaque, en sRGB 8 bits (comme le fait un
 * navigateur). Résultat entièrement opaque.
 */
export function flattenOnto(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  n: number,
  bgR: number,
  bgG: number,
  bgB: number,
): void {
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = src[p + 3]! / 255;
    const ia = 1 - a;
    dst[p] = src[p]! * a + bgR * ia;
    dst[p + 1] = src[p + 1]! * a + bgG * ia;
    dst[p + 2] = src[p + 2]! * a + bgB * ia;
    dst[p + 3] = 255;
  }
}

/**
 * Filtre bilatéral en RGB 8 bits (sRGB, non linéarisé).
 *
 * Poids = exp(-d²/2σs²) · exp(-‖Δrgb‖²/2σc²), noyau (2r+1)² tronqué au bord de
 * l'image. Les pixels hors masque ne sont ni modifiés ni utilisés comme
 * voisins (pas de « bavure » des zones transparentes). L'alpha est recopié.
 * Seules les lignes `[rowStart, rowEnd)` sont écrites (traitement par bandes, T12).
 */
export function bilateralFilter(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array | null,
  radius: number,
  sigmaSpatial: number,
  sigmaColor: number,
  rowStart = 0,
  rowEnd = height,
): void {
  const side = 2 * radius + 1;
  const spatial = new Float64Array(side * side);
  const ks = -1 / (2 * sigmaSpatial * sigmaSpatial);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial[(dy + radius) * side + (dx + radius)] = Math.exp((dx * dx + dy * dy) * ks);
    }
  }
  // Table du poids couleur indexée par la distance² entière (max 3·255²).
  const maxD2 = 3 * 255 * 255;
  const colorLut = new Float64Array(maxD2 + 1);
  const kc = -1 / (2 * sigmaColor * sigmaColor);
  for (let d2 = 0; d2 <= maxD2; d2++) colorLut[d2] = Math.exp(d2 * kc);

  for (let y = rowStart; y < rowEnd; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= height ? height - 1 : y + radius;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const r0 = src[p]!;
      const g0 = src[p + 1]!;
      const b0 = src[p + 2]!;
      dst[p + 3] = src[p + 3]!;
      if (mask !== null && mask[i] === 0) {
        dst[p] = r0;
        dst[p + 1] = g0;
        dst[p + 2] = b0;
        continue;
      }
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= width ? width - 1 : x + radius;
      let sw = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const krow = (yy - y + radius) * side + radius - x;
        for (let xx = x0; xx <= x1; xx++) {
          const j = yy * width + xx;
          if (mask !== null && mask[j] === 0) continue;
          const q = j * 4;
          const r = src[q]!;
          const g = src[q + 1]!;
          const b = src[q + 2]!;
          const dr = r - r0;
          const dg = g - g0;
          const db = b - b0;
          const w = spatial[krow + xx]! * colorLut[dr * dr + dg * dg + db * db]!;
          sw += w;
          sr += w * r;
          sg += w * g;
          sb += w * b;
        }
      }
      // sw ≥ poids du pixel central = 1 > 0.
      dst[p] = sr / sw;
      dst[p + 1] = sg / sw;
      dst[p + 2] = sb / sw;
    }
  }
}

/** Médiane d'un tampon de `n` octets (tri par insertion en place, n ≤ 81). */
function medianOf(buf: Uint8Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i]!;
    let j = i - 1;
    while (j >= 0 && buf[j]! > v) {
      buf[j + 1] = buf[j]!;
      j--;
    }
    buf[j + 1] = v;
  }
  // n pair : moyenne des deux valeurs centrales.
  return n & 1 ? buf[n >> 1]! : (buf[(n >> 1) - 1]! + buf[n >> 1]!) / 2;
}

/**
 * Médian par canal sur une fenêtre (2r+1)², tronquée au bord, voisins hors
 * masque exclus. Sortie = src + strength · (médiane − src). L'alpha est recopié.
 * Seules les lignes `[rowStart, rowEnd)` sont écrites (traitement par bandes, T12).
 */
export function medianFilter(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array | null,
  radius: number,
  strength: number,
  rowStart = 0,
  rowEnd = height,
): void {
  const cap = (2 * radius + 1) * (2 * radius + 1);
  const br = new Uint8Array(cap);
  const bg = new Uint8Array(cap);
  const bb = new Uint8Array(cap);
  for (let y = rowStart; y < rowEnd; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= height ? height - 1 : y + radius;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const r0 = src[p]!;
      const g0 = src[p + 1]!;
      const b0 = src[p + 2]!;
      dst[p + 3] = src[p + 3]!;
      if (mask !== null && mask[i] === 0) {
        dst[p] = r0;
        dst[p + 1] = g0;
        dst[p + 2] = b0;
        continue;
      }
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= width ? width - 1 : x + radius;
      let n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const j = yy * width + xx;
          if (mask !== null && mask[j] === 0) continue;
          const q = j * 4;
          br[n] = src[q]!;
          bg[n] = src[q + 1]!;
          bb[n] = src[q + 2]!;
          n++;
        }
      }
      dst[p] = r0 + strength * (medianOf(br, n) - r0);
      dst[p + 1] = g0 + strength * (medianOf(bg, n) - g0);
      dst[p + 2] = b0 + strength * (medianOf(bb, n) - b0);
    }
  }
}

/**
 * Suréchantillonnage bilinéaire d'un facteur entier `scale` (centres de
 * pixels alignés : x_src = (X + ½)/scale − ½, bord répliqué).
 *
 * - La couleur est interpolée en ne pondérant QUE les voisins du masque (une
 *   couleur transparente ne bave pas sur une opaque) ; à défaut de voisin
 *   opaque, interpolation simple.
 * - L'alpha est interpolé normalement.
 * - Si `mask` et `maskOut` sont fournis, `maskOut` = masque interpolé ≥ 0,5.
 */
export function upsampleBilinear(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  mask: Uint8Array | null,
  dst: Uint8ClampedArray,
  maskOut: Uint8Array | null,
): void {
  const ow = width * scale;
  const oh = height * scale;
  // Tables par colonne (hors boucle interne).
  const xa = new Int32Array(ow);
  const xb = new Int32Array(ow);
  const fxs = new Float64Array(ow);
  for (let X = 0; X < ow; X++) {
    const sx = (X + 0.5) / scale - 0.5;
    const f = Math.floor(sx);
    fxs[X] = sx - f;
    xa[X] = f < 0 ? 0 : f >= width ? width - 1 : f;
    xb[X] = f + 1 < 0 ? 0 : f + 1 >= width ? width - 1 : f + 1;
  }
  for (let Y = 0; Y < oh; Y++) {
    const sy = (Y + 0.5) / scale - 0.5;
    const fy0 = Math.floor(sy);
    const fy = sy - fy0;
    const ya = fy0 < 0 ? 0 : fy0 >= height ? height - 1 : fy0;
    const yb = fy0 + 1 < 0 ? 0 : fy0 + 1 >= height ? height - 1 : fy0 + 1;
    for (let X = 0; X < ow; X++) {
      const fx = fxs[X]!;
      const i00 = ya * width + xa[X]!;
      const i10 = ya * width + xb[X]!;
      const i01 = yb * width + xa[X]!;
      const i11 = yb * width + xb[X]!;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      let m00 = w00;
      let m10 = w10;
      let m01 = w01;
      let m11 = w11;
      if (mask !== null) {
        m00 *= mask[i00]!;
        m10 *= mask[i10]!;
        m01 *= mask[i01]!;
        m11 *= mask[i11]!;
      }
      const maskSum = m00 + m10 + m01 + m11;
      let sw = maskSum;
      if (sw <= 1e-12) {
        m00 = w00;
        m10 = w10;
        m01 = w01;
        m11 = w11;
        sw = 1;
      }
      const o = (Y * ow + X) * 4;
      const p00 = i00 * 4;
      const p10 = i10 * 4;
      const p01 = i01 * 4;
      const p11 = i11 * 4;
      for (let c = 0; c < 3; c++) {
        dst[o + c] =
          (m00 * src[p00 + c]! + m10 * src[p10 + c]! + m01 * src[p01 + c]! + m11 * src[p11 + c]!) /
          sw;
      }
      dst[o + 3] =
        w00 * src[p00 + 3]! + w10 * src[p10 + 3]! + w01 * src[p01 + 3]! + w11 * src[p11 + 3]!;
      if (maskOut !== null && mask !== null) {
        maskOut[Y * ow + X] = maskSum >= 0.5 - 1e-9 ? 1 : 0;
      }
    }
  }
}
