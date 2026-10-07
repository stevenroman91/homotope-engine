/**
 * T33 — Transformée de distance euclidienne EXACTE (Felzenszwalb et
 * Huttenlocher, 2012 : deux passes séparables, linéaire). Fonction PURE.
 *
 * Distance d'un pixel d'encre au centre du pixel de papier le plus proche ;
 * le bord de l'image n'est PAS du papier (un trait coupé par le cadre garde son
 * épaisseur). Résultat : distances AU CARRÉ, saturées à `DIST_CAP` (65 535,
 * soit 255 px : un trait plus épais que 510 px est mesuré à 510 px) dans un
 * `Uint16Array` (2 octets par pixel au lieu de 8).
 */

export const DIST_CAP = 65535;

/** `mask` : masque paddé (voir `binarize.ts`), 1 = encre. Renvoie w·h distances² (sans bordure). */
export function squaredDistance(mask: Uint8Array, w: number, h: number): Uint16Array {
  const W = w + 2;
  const out = new Uint16Array(w * h);
  // Passe 1 : distance verticale au papier, par colonne (saturée).
  for (let x = 0; x < w; x++) {
    let d = DIST_CAP;
    for (let y = 0; y < h; y++) {
      d = mask[(y + 1) * W + x + 1] === 1 ? Math.min(DIST_CAP, d + 1) : 0;
      out[y * w + x] = d;
    }
    d = DIST_CAP;
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x;
      d = out[i] === 0 ? 0 : Math.min(DIST_CAP, d + 1);
      if (d < out[i]!) out[i] = d;
    }
  }
  // Passe 2 : enveloppe inférieure des paraboles, par ligne.
  const f = new Float64Array(w);
  const v = new Int32Array(w);
  const z = new Float64Array(w + 1);
  const FAR = 1e12;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const g = out[row + x]!;
      f[x] = g === DIST_CAP ? FAR : g * g;
    }
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < w; q++) {
      let s: number;
      // z[0] = −∞ : la boucle s'arrête au plus tard à k = 0.
      for (;;) {
        const r = v[k]!;
        s = (f[q]! + q * q - (f[r]! + r * r)) / (2 * (q - r));
        if (s <= z[k]!) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < w; q++) {
      while (z[k + 1]! < q) k++;
      const r = v[k]!;
      const d = (q - r) * (q - r) + f[r]!;
      out[row + q] = d >= DIST_CAP ? DIST_CAP : d;
    }
  }
  return out;
}
