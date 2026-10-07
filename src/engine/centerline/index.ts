/**
 * T33 — Tracé centre-ligne : de l'image quantifiée au graphe de traits.
 *
 *   binarisation (encre / papier) → nettoyage des taches → transformée de
 *   distance → amincissement de Guo-Hall → squelette d'un pixel → graphe
 *   (élagage, coins, jonctions recalées, épaisseurs) → passages d'une seule passe.
 *
 * Étape PURE sur tableaux typés : elle tourne dans le worker et dans Node.
 * Les fonctions lentes (`removeSpecks`, `squaredDistance`, `guoHallThin`,
 * `cleanSkeleton`, `traceSkeleton`) sont isolées pour un portage WebAssembly
 * futur ; rien n'est porté.
 */
import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  BoundaryChain,
  CenterlineOptions,
  QuantizeResult,
  StrokeGraph,
  VectorizeContext,
} from '../types.ts';
import { TRANSPARENT } from '../types.ts';
import { chooseInk, inkMask, removeSpecks } from './binarize.ts';
import { squaredDistance } from './distance.ts';
import { buildStrokeGraph } from './graph.ts';
import { chainRuns } from './runs.ts';
import { cleanSkeleton, guoHallThin } from './thin.ts';

export { chooseInk, inkMask, removeSpecks } from './binarize.ts';
export { squaredDistance, DIST_CAP } from './distance.ts';
export { buildStrokeGraph, polylineLength } from './graph.ts';
export { chainRuns, THROUGH_COS } from './runs.ts';
export { cleanSkeleton, guoHallThin } from './thin.ts';
export { medianStrokeWidth, THICK_STROKE_PX } from './width.ts';

/** Squelette d'un pixel de l'encre, avec ce qu'il faut pour en faire un graphe. */
export interface Skeleton {
  readonly width: number;
  readonly height: number;
  /** Masque paddé (w + 2) × (h + 2), 1 = squelette. */
  mask: Uint8Array;
  /** Indices (paddés) des pixels du squelette. */
  pixels: Int32Array;
  /** Distances² de l'encre d'ORIGINE au papier (w·h, voir `distance.ts`). */
  dist2: Uint16Array;
  inkColor: number;
  paperColor: number;
}

/**
 * Aire (px de travail) d'une tache d'encre effacée : moins qu'un carré de
 * côté `spurLength` (son squelette, plus court que `spurLength`, serait de
 * toute façon élagué). Un trou de papier plus petit que le quart de cette
 * aire est bouché (bruit dans un aplat d'encre, qui ferait une boucle).
 */
export function speckAreas(spurLength: number): { ink: number; hole: number } {
  const ink = Math.ceil(spurLength * spurLength);
  return { ink, hole: Math.ceil(ink / 4) };
}

/** Binarisation, nettoyage, transformée de distance, amincissement (étape « segment »). */
export function skeletonize(
  q: QuantizeResult,
  w: number,
  h: number,
  options: CenterlineOptions,
  ctx?: VectorizeContext,
): Skeleton {
  let transparent = 0;
  for (let i = 0; i < q.colorIndex.length; i++) if (q.colorIndex[i] === TRANSPARENT) transparent++;
  const { ink, inkColor, paperColor } = chooseInk(q.palette, transparent);
  const mask = inkMask(q.colorIndex, w, h, ink);
  return { ...skeletonizeMask(mask, w, h, options, ctx), inkColor, paperColor };
}

/**
 * Comme `skeletonize`, depuis un masque d'encre paddé déjà binarisé (MODIFIÉ en
 * place : il devient le squelette). Encre et papier : -1.
 */
export function skeletonizeMask(
  mask: Uint8Array,
  w: number,
  h: number,
  options: CenterlineOptions,
  ctx?: VectorizeContext,
): Skeleton {
  const areas = speckAreas(options.spurLength);
  removeSpecks(mask, w, h, areas.ink, areas.hole);
  checkCancel(ctx);
  ctx?.onProgress?.(globalProgress('segment', 0.2));
  const dist2 = squaredDistance(mask, w, h);
  checkCancel(ctx);
  ctx?.onProgress?.(globalProgress('segment', 0.4));
  guoHallThin(mask, w, h, (it) => {
    checkCancel(ctx);
    ctx?.onProgress?.(globalProgress('segment', 0.4 + 0.5 * (1 - 1 / (1 + it / 4))));
  });
  const pixels = cleanSkeleton(mask, w, h);
  return { width: w, height: h, mask, pixels, dist2, inkColor: -1, paperColor: -1 };
}

/** Graphe de traits et passages (étape « topology »). Le masque du squelette est consommé. */
export function strokeGraph(
  sk: Skeleton,
  options: CenterlineOptions,
  cornerAngle: number,
): StrokeGraph {
  const g = buildStrokeGraph(sk.mask, sk.pixels, sk.width, sk.height, sk.dist2, {
    spurLength: options.spurLength,
    cornerAngle,
  });
  return { ...g, runs: chainRuns(g), inkColor: sk.inkColor, paperColor: sk.paperColor };
}

/**
 * Arêtes vues comme des chaînes, pour réutiliser l'ajustement de `fit/` tel
 * quel (extrémités FIXES : ce sont les nœuds). `left`/`right` n'ont pas de sens
 * pour un trait : TRANSPARENT des deux côtés.
 */
export function strokeChains(graph: StrokeGraph): BoundaryChain[] {
  return graph.edges.map((e) => ({
    id: e.id,
    points: e.points,
    start: e.start,
    end: e.end,
    left: TRANSPARENT,
    right: TRANSPARENT,
    closed: e.closed,
  }));
}
