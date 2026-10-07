/**
 * T33 — Passages d'une seule passe : les arêtes du graphe de traits sont
 * enchaînées par les nœuds où le trait CONTINUE (coin, ancre de boucle, ou
 * jonction traversée presque tout droit par deux branches d'épaisseur voisine).
 * Chaque arête appartient à exactement un passage : rien n'est tracé deux fois.
 * Fonction pure.
 */
import type { StrokeEdge, StrokeGraph, StrokeRun } from '../types.ts';
import { polylineLength } from './graph.ts';

/** Cosinus minimal entre une branche et le prolongement de l'autre pour traverser une jonction (≈ 40°). */
export const THROUGH_COS = 0.75;

/** Direction unitaire sortante d'une arête à son extrémité (a si `atStart`), mesurée à `reach` px. */
function exitDirection(e: StrokeEdge, atStart: boolean, reach: number): [number, number] {
  const p = e.points;
  const m = p.length >> 1;
  const ox = atStart ? p[0]! : p[2 * (m - 1)]!;
  const oy = atStart ? p[1]! : p[2 * (m - 1) + 1]!;
  let tx = 0;
  let ty = 0;
  for (let k = 1; k < m; k++) {
    const i = atStart ? k : m - 1 - k;
    tx = p[2 * i]! - ox;
    ty = p[2 * i + 1]! - oy;
    if (Math.hypot(tx, ty) >= reach) break;
  }
  const l = Math.hypot(tx, ty);
  return l > 0 ? [tx / l, ty / l] : [0, 0];
}

/** Épaisseurs compatibles pour un même passage. */
function similarWidth(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1, 0.35 * Math.min(a, b));
}

export function chainRuns(graph: Pick<StrokeGraph, 'nodes' | 'edges'>): StrokeRun[] {
  const { nodes, edges } = graph;
  // Extrémité k = 2·arête + (0 : côté start, 1 : côté end) ; partner[k] = extrémité appariée.
  const partner = new Int32Array(2 * edges.length).fill(-1);
  const at: number[][] = nodes.map(() => []);
  for (const e of edges) {
    at[e.start]!.push(2 * e.id);
    at[e.end]!.push(2 * e.id + 1);
  }
  for (const n of nodes) {
    const list = at[n.id]!;
    if (list.length === 2) {
      // Coin, ancre de boucle, jonction réduite : le trait continue.
      partner[list[0]!] = list[1]!;
      partner[list[1]!] = list[0]!;
      continue;
    }
    if (list.length < 3) continue;
    const reach = Math.max(3, 2 * n.radius);
    const dirs = list.map((k) => exitDirection(edges[k >> 1]!, (k & 1) === 0, reach));
    const pairs: { i: number; j: number; s: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = -(dirs[i]![0] * dirs[j]![0] + dirs[i]![1] * dirs[j]![1]);
        if (s < THROUGH_COS) continue;
        if (!similarWidth(edges[list[i]! >> 1]!.width, edges[list[j]! >> 1]!.width)) continue;
        pairs.push({ i, j, s });
      }
    }
    pairs.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
    for (const { i, j } of pairs) {
      const a = list[i]!;
      const b = list[j]!;
      if (partner[a] !== -1 || partner[b] !== -1) continue;
      partner[a] = b;
      partner[b] = a;
    }
  }

  const used = new Uint8Array(edges.length);
  const runs: StrokeRun[] = [];
  const length = edges.map((e) => polylineLength(e.points));
  for (const e of edges) {
    if (!used[e.id]) runs.push(walkRun(e.id, edges, partner, used, length));
  }
  return runs;
}

/** Passage contenant l'arête `seed` : remonte au début, puis le parcourt. */
function walkRun(
  seed: number,
  edges: readonly StrokeEdge[],
  partner: Int32Array,
  used: Uint8Array,
  length: readonly number[],
): StrokeRun {
  // Entrée = extrémité par laquelle on entre dans une arête ; sortie = l'autre.
  // Remonter : depuis l'entrée e, l'extrémité appariée p appartient à l'arête
  // précédente, qu'on parcourt en sortant par p (donc en y entrant par p ^ 1).
  let entry = 2 * seed;
  let closed = false;
  for (let guard = 0; guard < edges.length; guard++) {
    const p = partner[entry]!;
    if (p === -1) break;
    const prevEntry = p ^ 1;
    if (prevEntry === 2 * seed) {
      closed = true;
      break;
    }
    entry = prevEntry;
  }
  if (!closed && partner[entry] !== -1) closed = true; // garde dépassée : cycle
  const run: StrokeRun = { edges: [], closed, width: 0 };
  let total = 0;
  let sum = 0;
  const first = entry;
  for (let guard = 0; guard < edges.length; guard++) {
    const e = entry >> 1;
    if (used[e]) break;
    used[e] = 1;
    run.edges.push({ chain: e, reversed: (entry & 1) === 1 });
    total += length[e]!;
    sum += length[e]! * edges[e]!.width;
    const exit = entry ^ 1;
    const p = partner[exit]!;
    if (p === -1 || p === first) break;
    entry = p;
  }
  run.width = total > 0 ? sum / total : edges[seed]!.width;
  return run;
}
