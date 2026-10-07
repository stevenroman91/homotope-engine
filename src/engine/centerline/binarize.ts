/**
 * T33 — Binarisation de l'encre et nettoyage des taches. Fonctions PURES sur
 * tableaux typés (portage WebAssembly possible, rien de porté).
 *
 * Masque « paddé » : (w + 2) × (h + 2), une bordure de papier tout autour ; le
 * pixel (x, y) est à l'indice (y + 1)·(w + 2) + x + 1. Les voisinages 3 × 3 de
 * l'amincissement et du graphe se lisent alors sans test de bord.
 */
import type { Palette } from '../types.ts';

/** Couleurs d'encre et de papier d'une palette quantifiée. */
export interface InkChoice {
  /** `ink[id]` = 1 si la couleur d'id `id` est de l'encre. */
  ink: Uint8Array;
  /** Couleur d'encre majoritaire (celle du trait), -1 si aucune. */
  inkColor: number;
  /** Couleur du papier, -1 si le papier est la transparence. */
  paperColor: number;
}

/**
 * Le PAPIER est la couleur majoritaire (ou la transparence si elle couvre plus
 * de pixels que toute couleur) ; l'ENCRE regroupe les couleurs dont la clarté
 * OKLab s'écarte de celle du papier de plus de la moitié de l'étendue des
 * clartés. Deux couleurs : l'encre est la minoritaire, claire ou foncée.
 * Papier transparent : toute couleur opaque est de l'encre.
 */
export function chooseInk(palette: Palette, transparentCount: number): InkChoice {
  const colors = palette.colors;
  let maxId = -1;
  for (const c of colors) maxId = Math.max(maxId, c.id);
  const ink = new Uint8Array(maxId + 1);
  if (colors.length === 0) return { ink, inkColor: -1, paperColor: -1 };
  let paper = colors[0]!;
  for (const c of colors)
    if (c.count > paper.count || (c.count === paper.count && c.id < paper.id)) paper = c;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of colors) {
    lo = Math.min(lo, c.oklab.L);
    hi = Math.max(hi, c.oklab.L);
  }
  const transparentPaper = transparentCount > paper.count;
  const half = (hi - lo) / 2;
  let inkColor = -1;
  let best = -1;
  for (const c of colors) {
    const isInk = transparentPaper || (half > 0 && Math.abs(c.oklab.L - paper.oklab.L) > half);
    if (!isInk) continue;
    ink[c.id] = 1;
    if (c.count > best) {
      best = c.count;
      inkColor = c.id;
    }
  }
  return { ink, inkColor, paperColor: transparentPaper ? -1 : paper.id };
}

/** Masque paddé (1 = encre) depuis l'index de couleur par pixel (-1 = transparent = papier). */
export function inkMask(colorIndex: Int16Array, w: number, h: number, ink: Uint8Array): Uint8Array {
  const W = w + 2;
  const mask = new Uint8Array(W * (h + 2));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const out = (y + 1) * W + 1;
    for (let x = 0; x < w; x++) {
      const c = colorIndex[row + x]!;
      if (c >= 0 && ink[c] === 1) mask[out + x] = 1;
    }
  }
  return mask;
}

/** Pile d'entiers extensible (parcours de composantes sans récursion). */
export class IntStack {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  pop(): number {
    return this.data[--this.length]!;
  }
}

/**
 * Nettoyage des taches (masque paddé, en place) : une composante d'encre
 * 8-connexe de moins de `inkArea` pixels est effacée, un trou de papier
 * 4-connexe (ne touchant pas le bord) de moins de `holeArea` pixels est bouché.
 * Renvoie le nombre de pixels modifiés.
 */
export function removeSpecks(
  mask: Uint8Array,
  w: number,
  h: number,
  inkArea: number,
  holeArea: number,
): number {
  if (inkArea <= 1 && holeArea <= 1) return 0;
  const W = w + 2;
  const H = h + 2;
  // 2 = encre visitée, 3 = papier visité, 4 = bordure ; remis à 1 / 0 à la fin.
  for (let x = 0; x < W; x++) {
    mask[x] = 4;
    mask[(H - 1) * W + x] = 4;
  }
  for (let y = 0; y < H; y++) {
    mask[y * W] = 4;
    mask[y * W + W - 1] = 4;
  }
  const stack = new IntStack();
  const comp = new IntStack();
  const n8 = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  const n4 = [-W, -1, 1, W];
  let changed = 0;
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const p = y * W + x;
      const v = mask[p]!;
      if (v > 1) continue;
      const ink = v === 1;
      const mark = ink ? 2 : 3;
      const nb = ink ? n8 : n4;
      const minArea = ink ? inkArea : holeArea;
      mask[p] = mark;
      stack.length = 0;
      comp.length = 0;
      stack.push(p);
      let area = 0;
      let border = false;
      while (stack.length > 0) {
        const q = stack.pop();
        area++;
        if (area < minArea) comp.push(q);
        for (const d of nb) {
          const r = q + d;
          const m = mask[r]!;
          if (m === v) {
            mask[r] = mark;
            stack.push(r);
          } else if (m === 4) border = true; // un papier qui touche le bord n'est pas un trou
        }
      }
      if (area < minArea && (ink || !border)) {
        const fill = ink ? 3 : 2; // l'encre devient papier (visité), le trou devient encre
        for (let i = 0; i < comp.length; i++) mask[comp.data[i]!] = fill;
        changed += comp.length;
      }
    }
  }
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 2 ? 1 : 0;
  return changed;
}
