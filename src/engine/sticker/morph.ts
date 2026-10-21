/**
 * T95 — Morphologie binaire du contour de découpe sticker, sur `Uint8Array` (1 = encre, 0 =
 * fond), row-major `w × h`. Pur : tableaux typés, aucun DOM.
 *
 * Dilatation et érosion par un DISQUE de rayon `r` (px) passent par la transformée de distance
 * euclidienne EXACTE (Meijster, Roerdink et Hesselink, 2000) : deux passes linéaires, quel que
 * soit le rayon, jamais un noyau O(r²) par pixel. Le disque discret est
 * `{ (dx, dy) : dx² + dy² ≤ r² }` : la distance au carré, entière, se compare à `r²` sans
 * arrondi, d'où l'ÉGALITÉ exacte avec une morphologie naïve (testée). Les pixels hors de la
 * grille ne comptent ni comme encre ni comme fond : l'appelant rembourre la grille (`r + marge`)
 * pour qu'un dessin qui touche le bord garde sa marge.
 */

/** Distance « infinie » d'une transformée sur une grille `w × h` (au carré : `(w + h)²`). */
function inf(w: number, h: number): number {
  return w + h + 1;
}

/**
 * Distance euclidienne AU CARRÉ de chaque pixel au plus proche pixel valant `target` (Meijster).
 * Aucun pixel cible : `(w + h + 1)²` partout. Entiers exacts (`Int32Array`), grille jusqu'à
 * ~20 000 px de côté.
 */
export function edt2(mask: Uint8Array, w: number, h: number, target: 0 | 1): Int32Array {
  const INF = inf(w, h);
  const g = new Int32Array(w * h);
  // Passe 1 : par colonne, distance verticale à la cible la plus proche (parcours par lignes,
  // toutes les colonnes à la fois : accès mémoire contigus).
  for (let x = 0; x < w; x++) g[x] = mask[x] === target ? 0 : INF;
  for (let y = 1; y < h; y++) {
    const row = y * w;
    for (let i = row; i < row + w; i++) {
      if (mask[i] === target) g[i] = 0;
      else {
        const d = g[i - w]! + 1;
        g[i] = d < INF ? d : INF;
      }
    }
  }
  for (let y = h - 2; y >= 0; y--) {
    const row = y * w;
    for (let i = row; i < row + w; i++) {
      const below = g[i + w]! + 1;
      if (below < g[i]!) g[i] = below;
    }
  }
  // Passe 2 : par ligne, enveloppe inférieure des paraboles (x − i)² + g(i)².
  const out = new Int32Array(w * h);
  const s = new Int32Array(w);
  const t = new Int32Array(w);
  const gi = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = g[row + x]!;
      gi[x] = v * v;
    }
    let q = 0;
    s[0] = 0;
    t[0] = 0;
    for (let u = 1; u < w; u++) {
      while (q >= 0) {
        const tq = t[q]!;
        const a = tq - s[q]!;
        const b = tq - u;
        if (a * a + gi[s[q]!]! <= b * b + gi[u]!) break;
        q--;
      }
      if (q < 0) {
        q = 0;
        s[0] = u;
      } else {
        const i = s[q]!;
        const sep = Math.floor((u * u - i * i + gi[u]! - gi[i]!) / (2 * (u - i)));
        const wv = 1 + sep;
        if (wv < w) {
          q++;
          s[q] = u;
          t[q] = wv;
        }
      }
    }
    for (let u = w - 1; u >= 0; u--) {
      const i = s[q]!;
      out[row + u] = (u - i) * (u - i) + gi[i]!;
      if (u === t[q]) q--;
    }
  }
  return out;
}

/** Dilatation par le disque de rayon `r` (px) : pixel à distance ≤ r d'un pixel d'encre. */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (r <= 0) {
    out.set(mask);
    return out;
  }
  const d = edt2(mask, w, h, 1);
  const r2 = r * r;
  for (let i = 0; i < d.length; i++) out[i] = d[i]! <= r2 ? 1 : 0;
  return out;
}

/** Érosion par le disque de rayon `r` (px) : pixel d'encre à distance > r de tout fond. */
export function erodeMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (r <= 0) {
    out.set(mask);
    return out;
  }
  const d = edt2(mask, w, h, 0);
  const r2 = r * r;
  for (let i = 0; i < d.length; i++) out[i] = mask[i] === 1 && d[i]! > r2 ? 1 : 0;
  return out;
}

/**
 * Fermeture morphologique (dilatation puis érosion) par le disque de rayon `rPx` : bouche les
 * creux et les passages plus étroits que le disque sans grossir le dessin. Deux transformées de
 * distance, coût linéaire en pixels quel que soit le rayon.
 */
export function closeMask(mask: Uint8Array, w: number, h: number, rPx: number): Uint8Array {
  if (rPx <= 0) return Uint8Array.from(mask);
  return closeFromDistance(edt2(mask, w, h, 1), w, h, rPx);
}

/**
 * La MÊME fermeture, depuis la transformée de distance à l'encre déjà calculée (`edt2(mask, 1)`) :
 * la dilatation n'est qu'un seuil sur cette distance, puis l'érosion. C'est la fonction que
 * `closeMask` (garde « fermeture = naïve ») ET le contour sticker (`Evaluator`) exécutent : une
 * seule copie, prouvée une fois.
 */
export function closeFromDistance(dInk: Int32Array, w: number, h: number, rPx: number): Uint8Array {
  const dilated = new Uint8Array(w * h);
  if (rPx <= 0) {
    for (let i = 0; i < dilated.length; i++) dilated[i] = dInk[i] === 0 ? 1 : 0;
    return dilated;
  }
  const r2 = rPx * rPx;
  for (let i = 0; i < dilated.length; i++) dilated[i] = dInk[i]! <= r2 ? 1 : 0;
  return erodeMask(dilated, w, h, rPx);
}

/**
 * Bouche les trous : les composantes 4-connexes du fond qui ne touchent PAS le bord de la grille
 * deviennent encre. Seul le fond relié au bord reste fond. En place ; rend `mask`.
 */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  // 0 = fond non atteint, 1 = encre, 2 = fond relié au bord.
  const stack = new Int32Array(w * h);
  let n = 0;
  const last = w * (h - 1);
  const seed = (i: number): void => {
    if (mask[i] === 0) {
      mask[i] = 2;
      stack[n++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed(last + x);
  }
  for (let y = 1; y < h - 1; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (n > 0) {
    const i = stack[--n]!;
    const x = i % w;
    if (x > 0 && mask[i - 1] === 0) {
      mask[i - 1] = 2;
      stack[n++] = i - 1;
    }
    if (x < w - 1 && mask[i + 1] === 0) {
      mask[i + 1] = 2;
      stack[n++] = i + 1;
    }
    if (i >= w && mask[i - w] === 0) {
      mask[i - w] = 2;
      stack[n++] = i - w;
    }
    if (i < last && mask[i + w] === 0) {
      mask[i + w] = 2;
      stack[n++] = i + w;
    }
  }
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 2 ? 0 : 1;
  return mask;
}

/** Composantes 4-connexes de l'encre : label par pixel (−1 = fond), aires. */
export interface Components {
  labels: Int32Array;
  areas: number[];
}

/**
 * Étiquette les composantes 4-connexes de l'encre (la connexité des régions du graphe des
 * frontières, T03), dans l'ordre de balayage.
 */
export function labelComponents(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const areas: number[] = [];
  const last = w * (h - 1);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    const id = areas.length;
    let area = 0;
    let n = 0;
    labels[start] = id;
    stack[n++] = start;
    while (n > 0) {
      const i = stack[--n]!;
      area++;
      const x = i % w;
      if (x > 0 && mask[i - 1] === 1 && labels[i - 1] === -1) {
        labels[i - 1] = id;
        stack[n++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] === 1 && labels[i + 1] === -1) {
        labels[i + 1] = id;
        stack[n++] = i + 1;
      }
      if (i >= w && mask[i - w] === 1 && labels[i - w] === -1) {
        labels[i - w] = id;
        stack[n++] = i - w;
      }
      if (i < last && mask[i + w] === 1 && labels[i + w] === -1) {
        labels[i + w] = id;
        stack[n++] = i + w;
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}

/** Nombre de composantes 4-connexes de l'encre (compteur « N stickers détectés »). */
export function countComponents(mask: Uint8Array, w: number, h: number): number {
  return labelComponents(mask, w, h).areas.length;
}
