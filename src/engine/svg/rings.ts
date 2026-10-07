import type { BoundaryGraph, FittedChain, Ring, Segment } from '../types.ts';
import { reverseFittedChain } from '../fit/index.ts';

/**
 * Sous-tracé : départ + segments. Fermé par défaut (le retour au départ est
 * implicite, `Z`) ; `open` : polyligne ouverte, sans `Z` (traits anti-liseré, T08).
 */
export interface SubPath {
  start: readonly [number, number];
  segments: Segment[];
  open?: boolean;
}

/** Anneau impossible à assembler sans produire un tracé faux. */
export class RingAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RingAssemblyError';
  }
}

/**
 * Écart toléré entre la fin d'une chaîne et le début de la suivante. Les
 * extrémités sont des sommets de treillis que l'ajustement ne bouge jamais :
 * elles coïncident exactement ; la marge n'absorbe que le bruit flottant.
 */
const JOIN_EPS = 1e-6;

/** Index chaîne → chaîne ajustée (le tableau `fitted` n'est pas forcément trié). */
export function indexFitted(
  fitted: readonly FittedChain[],
  chainCount: number,
): (FittedChain | undefined)[] {
  const byChain: (FittedChain | undefined)[] = new Array(chainCount);
  for (const fc of fitted) {
    if (fc.chain < 0 || fc.chain >= chainCount)
      throw new RingAssemblyError(`chaîne ajustée ${fc.chain} hors du graphe`);
    if (byChain[fc.chain]) throw new RingAssemblyError(`chaîne ${fc.chain} ajustée deux fois`);
    byChain[fc.chain] = fc;
  }
  return byChain;
}

function endOf(fc: FittedChain): readonly [number, number] {
  const last = fc.segments[fc.segments.length - 1];
  return last ? [last.x, last.y] : fc.start;
}

/**
 * Concatène les chaînes ajustées d'un anneau (inversées quand `reversed`), en
 * vérifiant chaque raccord : fin d'une chaîne = début de la suivante, et fin
 * de la dernière = départ de l'anneau. Un raccord manqué lève
 * `RingAssemblyError` (jamais de tracé silencieusement faux). Le dernier
 * segment est retiré s'il s'agit d'une ligne qui revient au départ : `Z` la
 * trace déjà.
 */
export function assembleRing(
  graph: BoundaryGraph,
  byChain: readonly (FittedChain | undefined)[],
  ring: Ring,
): SubPath {
  if (ring.edges.length === 0) throw new RingAssemblyError('anneau vide');
  let start: readonly [number, number] | null = null;
  let cur: readonly [number, number] = [0, 0];
  const segments: Segment[] = [];
  for (const e of ring.edges) {
    const raw = byChain[e.chain];
    if (!raw || !graph.chains[e.chain])
      throw new RingAssemblyError(`chaîne ${e.chain} absente des chaînes ajustées`);
    const fc = e.reversed ? reverseFittedChain(raw) : raw;
    if (start === null) start = fc.start;
    else if (!near(cur, fc.start))
      throw new RingAssemblyError(
        `raccord rompu avant la chaîne ${e.chain} : (${cur[0]}, ${cur[1]}) ≠ (${fc.start[0]}, ${fc.start[1]})`,
      );
    for (const s of fc.segments) segments.push(s);
    cur = endOf(fc);
  }
  const s0 = start!;
  if (!near(cur, s0))
    throw new RingAssemblyError(
      `anneau non fermé : fin (${cur[0]}, ${cur[1]}) ≠ départ (${s0[0]}, ${s0[1]})`,
    );
  const last = segments[segments.length - 1];
  if (last && last.kind === 'line') segments.pop();
  return { start: s0, segments };
}

function near(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= JOIN_EPS && Math.abs(a[1] - b[1]) <= JOIN_EPS;
}
