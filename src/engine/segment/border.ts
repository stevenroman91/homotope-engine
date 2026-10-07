import type { LabelMap } from '../types.ts';

/**
 * T50 — Ids de palette des régions qui touchent le bord de l'image (une ligne ou une
 * colonne extrême), triés, sans doublon ; les pixels transparents (-1) sont ignorés.
 * Sert à proposer « Rendre le fond transparent ? » (jamais appliqué automatiquement).
 */
export function borderColorIds(map: LabelMap): number[] {
  const { width: w, height: h, labels, regions } = map;
  const ids = new Set<number>();
  const visit = (i: number): void => {
    const r = labels[i]!;
    if (r >= 0) {
      const c = regions[r]?.colorId;
      if (c !== undefined && c >= 0) ids.add(c);
    }
  };
  if (w > 0 && h > 0) {
    for (let x = 0; x < w; x++) {
      visit(x);
      visit((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      visit(y * w);
      visit(y * w + w - 1);
    }
  }
  return [...ids].sort((a, b) => a - b);
}
