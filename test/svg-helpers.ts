import type {
  BoundaryChain,
  BoundaryGraph,
  FittedChain,
  LabelMap,
  Palette,
  QuantizeResult,
  Segment,
} from '../src/engine/types.ts';
import { segment } from '../src/engine/segment/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import { hexColor } from '../src/engine/svg/index.ts';
import { parsePathData, samplePath } from '../src/engine/svg/parse.ts';
import { quantFromAscii } from './label-helpers.ts';

/**
 * Chaîne ajustée « triviale » : une ligne par pas de treillis (ou par tronçon
 * droit si `merge`), extrémités exactes. Remplace `fitChain` (T04) dans les tests.
 */
export function polylineToFitted(chain: BoundaryChain, merge = false): FittedChain {
  const p = chain.points;
  const segments: Segment[] = [];
  const n = p.length / 2;
  for (let i = 1; i < n; i++) {
    const x = p[2 * i]!;
    const y = p[2 * i + 1]!;
    if (merge && i < n - 1) {
      const dx0 = x - p[2 * i - 2]!;
      const dy0 = y - p[2 * i - 1]!;
      const dx1 = p[2 * i + 2]! - x;
      const dy1 = p[2 * i + 3]! - y;
      if (dx0 === dx1 && dy0 === dy1) continue;
    }
    segments.push({ kind: 'line', x, y });
  }
  return { chain: chain.id, start: [p[0]!, p[1]!], segments };
}

/** Palette de test : couleurs distinctes et lisibles par id. */
export const TEST_RGB: [number, number, number][] = [
  [255, 255, 255],
  [255, 0, 0],
  [0, 0, 255],
  [0, 128, 0],
  [17, 34, 51],
  [200, 100, 50],
  [0, 0, 0],
  [255, 255, 0],
];

export function withRgb(q: QuantizeResult): Palette {
  return {
    colors: q.palette.colors.map((c) => ({ ...c, rgb: TEST_RGB[c.id % TEST_RGB.length]! })),
  };
}

export interface Scene {
  map: LabelMap;
  graph: BoundaryGraph;
  fitted: FittedChain[];
  palette: Palette;
}

export function sceneFromQuant(
  q: QuantizeResult,
  width: number,
  height: number,
  merge = false,
): Scene {
  const map = segment(q, width, height, { minRegionArea: 1, connectivity: 4 });
  const graph = buildBoundaryGraph(map);
  const fitted = graph.chains.map((c) => polylineToFitted(c, merge));
  return { map, graph, fitted, palette: withRgb(q) };
}

/** Scène depuis de l'ASCII (`.` = transparent), éventuellement agrandie ×`up`. */
export function sceneFromAscii(rows: string[], merge = false, up = 1): Scene {
  const big = rows.flatMap((r) => {
    const line = [...r].map((c) => c.repeat(up)).join('');
    return Array.from({ length: up }, () => line);
  });
  const { q, width, height } = quantFromAscii(big);
  return sceneFromQuant(q, width, height, merge);
}

/** Couleur attendue par pixel ('' = transparent). */
export function expectedColors(scene: Scene): string[] {
  const hex = new Map(scene.palette.colors.map((c) => [c.id, hexColor(c.rgb)]));
  return Array.from(scene.map.labels, (l) =>
    l < 0 ? '' : hex.get(scene.map.regions[l]!.colorId)!,
  );
}

/** Éléments `<path>` / `<rect>` du SVG émis (format contrôlé : regex suffisante). */
export function svgElements(svg: string): { tag: string; fill: string; d: string }[] {
  const out: { tag: string; fill: string; d: string }[] = [];
  for (const m of svg.matchAll(/<(path|rect)\b([^>]*)\/>/g)) {
    const attr = (n: string): string => new RegExp(`\\s${n}="([^"]*)"`).exec(m[2]!)?.[1] ?? '';
    out.push({ tag: m[1]!, fill: attr('fill'), d: attr('d') });
  }
  return out;
}

/** Nombre d'enroulement d'une polyligne fermée autour de (px, py). */
function winding(poly: Float64Array, px: number, py: number): number {
  let w = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = poly[2 * i]!;
    const y0 = poly[2 * i + 1]!;
    const j = (i + 1) % n;
    const x1 = poly[2 * j]!;
    const y1 = poly[2 * j + 1]!;
    if (y0 <= py) {
      if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++;
    } else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) w--;
  }
  return w;
}

/**
 * Rendu « au centre des pixels » : pour chaque pixel de la grille W×H, la
 * couleur du dernier élément qui le couvre (règle `fill-rule` du `<svg>`).
 * `s` = facteur entre la grille échantillonnée et les coordonnées du SVG.
 */
export function renderCenters(svg: string, W: number, H: number, s = 1): string[] {
  const evenodd = /<svg[^>]*fill-rule="evenodd"/.test(svg);
  const out: string[] = new Array(W * H).fill('');
  for (const el of svgElements(svg)) {
    if (el.fill === 'none') continue; // trait anti-liseré (T08) : aucun remplissage
    if (el.tag === 'rect') {
      out.fill(el.fill);
      continue;
    }
    const polys = samplePath(parsePathData(el.d), 16);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const px = (x + 0.5) / s;
        const py = (y + 0.5) / s;
        let w = 0;
        for (const p of polys) w += evenodd ? Math.abs(winding(p, px, py)) : winding(p, px, py);
        if (evenodd ? w % 2 === 1 : w !== 0) out[y * W + x] = el.fill;
      }
  }
  return out;
}
