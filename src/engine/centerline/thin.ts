/**
 * T33 — Squelettisation : amincissement parallèle de Guo et Hall (1989, deux
 * sous-itérations), puis nettoyage des points SIMPLES pour un squelette d'un
 * pixel exactement (8-connexe minimal). Fonctions PURES sur masque paddé
 * (voir `binarize.ts`), en place.
 *
 * Voisins, numérotation classique : P2 = N, P3 = NE, P4 = E, P5 = SE, P6 = S,
 * P7 = SO, P8 = O, P9 = NO ; code 8 bits b = P2 | P3 << 1 | … | P9 << 7.
 */
import { IntStack } from './binarize.ts';

/** Décalages des voisins P2..P9 dans un masque de largeur `W`. */
export function neighborOffsets(W: number): Int32Array {
  return Int32Array.of(-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1);
}

/** Code 8 bits du voisinage de `p`. */
export function neighborCode(mask: Uint8Array, p: number, off: Int32Array): number {
  let b = 0;
  for (let k = 0; k < 8; k++) if (mask[p + off[k]!] === 1) b |= 1 << k;
  return b;
}

const bit = (b: number, k: number): number => (b >> k) & 1;

/** Tables de Guo-Hall : `GUO_HALL[s][b]` = 1 si le pixel est effaçable à la sous-itération s. */
export const GUO_HALL: readonly [Uint8Array, Uint8Array] = (() => {
  const t: [Uint8Array, Uint8Array] = [new Uint8Array(256), new Uint8Array(256)];
  for (let b = 0; b < 256; b++) {
    const p2 = bit(b, 0);
    const p3 = bit(b, 1);
    const p4 = bit(b, 2);
    const p5 = bit(b, 3);
    const p6 = bit(b, 4);
    const p7 = bit(b, 5);
    const p8 = bit(b, 6);
    const p9 = bit(b, 7);
    const c = (+!p2 & (p3 | p4)) + (+!p4 & (p5 | p6)) + (+!p6 & (p7 | p8)) + (+!p8 & (p9 | p2));
    const n1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
    const n2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
    const n = Math.min(n1, n2);
    for (let s = 0; s < 2; s++) {
      const m = s === 0 ? (p6 | p7 | +!p9) & p8 : (p2 | p3 | +!p5) & p4;
      t[s]![b] = c === 1 && n >= 2 && n <= 3 && m === 0 ? 1 : 0;
    }
  }
  return t;
})();

/** Positions (dx, dy) des voisins P2..P9. */
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * Point SIMPLE (topologie 8 / 4) : effacer le pixel ne change ni le nombre de
 * composantes d'encre (8-connexes) ni celui des trous (papier 4-connexe) ; soit
 * une seule composante d'encre parmi les 8 voisins et une seule composante de
 * papier 4-adjacente au pixel.
 */
export const SIMPLE: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const fg = (k: number): boolean => bit(b, k) === 1;
    // Composantes d'encre 8-connexes parmi les voisins.
    const seen = new Uint8Array(8);
    let fgComp = 0;
    for (let k = 0; k < 8; k++) {
      if (!fg(k) || seen[k]) continue;
      fgComp++;
      const st = [k];
      seen[k] = 1;
      while (st.length > 0) {
        const a = st.pop()!;
        for (let j = 0; j < 8; j++) {
          if (!fg(j) || seen[j]) continue;
          if (Math.abs(DX[a]! - DX[j]!) <= 1 && Math.abs(DY[a]! - DY[j]!) <= 1) {
            seen[j] = 1;
            st.push(j);
          }
        }
      }
    }
    // Composantes de papier 4-connexes (dans le 3 × 3, sans le centre) qui touchent un 4-voisin.
    const seenB = new Uint8Array(8);
    let bgComp = 0;
    for (const k of [0, 2, 4, 6]) {
      if (fg(k) || seenB[k]) continue;
      bgComp++;
      const st = [k];
      seenB[k] = 1;
      while (st.length > 0) {
        const a = st.pop()!;
        for (let j = 0; j < 8; j++) {
          if (fg(j) || seenB[j]) continue;
          if (Math.abs(DX[a]! - DX[j]!) + Math.abs(DY[a]! - DY[j]!) === 1) {
            seenB[j] = 1;
            st.push(j);
          }
        }
      }
    }
    t[b] = fgComp === 1 && bgComp === 1 ? 1 : 0;
  }
  return t;
})();

/** Nombre de bits à 1 d'un code 8 bits. */
export const POPCOUNT: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++)
    t[b] =
      bit(b, 0) + bit(b, 1) + bit(b, 2) + bit(b, 3) + bit(b, 4) + bit(b, 5) + bit(b, 6) + bit(b, 7);
  return t;
})();

/**
 * Amincissement de Guo-Hall, en place, jusqu'à stabilité. Seuls les pixels de
 * bord (et ceux qui le deviennent) sont examinés : le coût suit l'encre
 * effacée, pas l'aire de l'image × le nombre d'itérations. `onPass` (optionnel)
 * est appelé après chaque itération complète (annulation, progression).
 * Renvoie le nombre d'itérations.
 */
export function guoHallThin(
  mask: Uint8Array,
  w: number,
  h: number,
  onPass?: (iteration: number) => void,
): number {
  const W = w + 2;
  const off = neighborOffsets(W);
  const inCand = new Uint8Array(mask.length);
  let cand = new IntStack();
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const p = y * W + x;
      if (mask[p] !== 1) continue;
      if (neighborCode(mask, p, off) !== 255) {
        inCand[p] = 1;
        cand.push(p);
      }
    }
  }
  const del = new IntStack();
  let iteration = 0;
  for (;;) {
    let any = false;
    for (let s = 0; s < 2; s++) {
      const table = GUO_HALL[s]!;
      del.length = 0;
      for (let i = 0; i < cand.length; i++) {
        const p = cand.data[i]!;
        if (mask[p] === 1 && table[neighborCode(mask, p, off)] === 1) del.push(p);
      }
      if (del.length === 0) continue;
      any = true;
      for (let i = 0; i < del.length; i++) mask[del.data[i]!] = 0;
      // Candidats suivants : survivants, plus l'encre voisine des pixels effacés.
      const next = new IntStack(Math.max(1024, cand.length));
      for (let i = 0; i < cand.length; i++) {
        const p = cand.data[i]!;
        if (mask[p] === 1) next.push(p);
        else inCand[p] = 0;
      }
      for (let i = 0; i < del.length; i++) {
        const p = del.data[i]!;
        for (let k = 0; k < 8; k++) {
          const q = p + off[k]!;
          if (mask[q] === 1 && inCand[q] === 0) {
            inCand[q] = 1;
            next.push(q);
          }
        }
      }
      cand = next;
    }
    iteration++;
    onPass?.(iteration);
    if (!any) break;
  }
  return iteration;
}

/**
 * Squelette d'un pixel exactement : efface (séquentiellement, jusqu'à
 * stabilité) les points simples qui ne sont pas des extrémités (au moins deux
 * voisins). Les marches d'escalier et les coins doublés disparaissent ; la
 * topologie (composantes, boucles) est conservée. Renvoie les pixels du
 * squelette.
 */
export function cleanSkeleton(mask: Uint8Array, w: number, h: number): Int32Array {
  const W = w + 2;
  const off = neighborOffsets(W);
  let list = new IntStack();
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) if (mask[y * W + x] === 1) list.push(y * W + x);
  }
  for (let changed = true; changed;) {
    changed = false;
    const keep = new IntStack(Math.max(1024, list.length));
    for (let i = 0; i < list.length; i++) {
      const p = list.data[i]!;
      const b = neighborCode(mask, p, off);
      if (POPCOUNT[b]! >= 2 && SIMPLE[b] === 1) {
        mask[p] = 0;
        changed = true;
      } else keep.push(p);
    }
    list = keep;
  }
  return list.data.slice(0, list.length);
}
