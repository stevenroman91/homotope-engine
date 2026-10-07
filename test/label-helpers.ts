import type { BoundaryGraph, LabelMap, PaletteColor, QuantizeResult } from '../src/engine/types.ts';
import { segment } from '../src/engine/segment/index.ts';
import { sidePixels } from '../src/engine/topology/index.ts';
import { IMAGE_BORDER } from '../src/engine/types.ts';

/**
 * Carte de couleurs depuis de l'ASCII : chaque caractère est une couleur de
 * palette (dans l'ordre d'apparition dans `colors`, ou de première apparition),
 * `.` = transparent. Les couleurs OKLab sont fournies ou réparties sur L.
 */
export function quantFromAscii(
  rows: string[],
  colors: Record<string, [number, number, number]> = {},
): { q: QuantizeResult; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]!.length;
  const ids = new Map<string, number>();
  for (const ch of Object.keys(colors)) ids.set(ch, ids.size);
  const colorIndex = new Int16Array(width * height);
  rows.forEach((row, y) => {
    if (row.length !== width) throw new Error(`ligne ${y} de longueur ${row.length}`);
    for (let x = 0; x < width; x++) {
      const ch = row[x]!;
      if (ch === '.') {
        colorIndex[y * width + x] = -1;
        continue;
      }
      if (!ids.has(ch)) ids.set(ch, ids.size);
      colorIndex[y * width + x] = ids.get(ch)!;
    }
  });
  const palette: PaletteColor[] = [];
  for (const [ch, id] of ids) {
    const lab = colors[ch] ?? [id / Math.max(1, ids.size), 0, 0];
    palette.push({
      id,
      rgb: [0, 0, 0],
      oklab: { L: lab[0], a: lab[1], b: lab[2] },
      count: 0,
      locked: false,
    });
  }
  return { q: { palette: { colors: palette }, colorIndex }, width, height };
}

/** Carte de régions (4-connexes, sans absorption) depuis de l'ASCII. */
export function labelsFromAscii(rows: string[]): LabelMap {
  const { q, width, height } = quantFromAscii(rows);
  return segment(q, width, height, { minRegionArea: 1, connectivity: 4 });
}

/** Rendu ASCII d'une carte de régions (pour les messages d'échec). */
export function labelsToAscii(map: LabelMap): string {
  const out: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let s = '';
    for (let x = 0; x < map.width; x++) {
      const l = map.labels[y * map.width + x]!;
      s += l < 0 ? '.' : String.fromCharCode(l < 26 ? 65 + l : 97 + ((l - 26) % 26));
    }
    out.push(s);
  }
  return out.join('\n');
}

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Carte de couleurs aléatoire seedée : Voronoï de `seeds` germes + bruit. */
export function randomQuant(
  width: number,
  height: number,
  nColors: number,
  seed: number,
  opts: { seeds?: number; noise?: number; transparent?: number } = {},
): QuantizeResult {
  const rand = rng(seed);
  const nSeeds = opts.seeds ?? 0;
  const sx: number[] = [];
  const sy: number[] = [];
  const sc: number[] = [];
  for (let i = 0; i < nSeeds; i++) {
    sx.push(rand() * width);
    sy.push(rand() * height);
    // Une graine sur 8 peut être transparente si demandé.
    sc.push(opts.transparent && rand() < opts.transparent ? -1 : Math.floor(rand() * nColors));
  }
  const colorIndex = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: number;
      if (nSeeds === 0 || rand() < (opts.noise ?? 0)) {
        c = Math.floor(rand() * nColors);
        if (opts.transparent && nSeeds === 0 && rand() < opts.transparent) c = -1;
      } else {
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < nSeeds; i++) {
          const dx = sx[i]! - x;
          const dy = sy[i]! - y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        c = sc[best]!;
      }
      colorIndex[y * width + x] = c;
    }
  }
  const colors: PaletteColor[] = [];
  for (let id = 0; id < nColors; id++) {
    colors.push({
      id,
      rgb: [0, 0, 0],
      oklab: { L: rand(), a: rand() * 0.4 - 0.2, b: rand() * 0.4 - 0.2 },
      count: 0,
      locked: false,
    });
  }
  return { palette: { colors }, colorIndex };
}

/**
 * Vérifie, pas à pas, que les labels `left` / `right` de chaque chaîne
 * correspondent aux pixels de part et d'autre. Renvoie les écarts.
 */
export function sideMismatches(map: LabelMap, graph: BoundaryGraph): string[] {
  const errs: string[] = [];
  const lab = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= map.width || y >= map.height
      ? IMAGE_BORDER
      : map.labels[y * map.width + x]!;
  for (const ch of graph.chains) {
    const p = ch.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2]! - p[i]!;
      const dy = p[i + 3]! - p[i + 1]!;
      const d = dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
      const [l, r] = sidePixels(p[i]!, p[i + 1]!, d);
      if (lab(l[0], l[1]) !== ch.left || lab(r[0], r[1]) !== ch.right) {
        errs.push(`chaîne ${ch.id} pas ${i / 2}`);
        break;
      }
    }
  }
  return errs;
}
