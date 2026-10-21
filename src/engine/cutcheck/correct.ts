/**
 * T63 — Corrections ponctuelles d'une géométrie de découpe, demandées point par point
 * (« Corriger ») : une NOUVELLE géométrie, jamais le résultat de l'atelier (règle T35).
 *
 * - Petit îlot : son contour et ses copies exactes (le trou de la face voisine) disparaissent ;
 *   si un autre contour suit encore son bord (îlot posé contre deux faces), la correction
 *   n'est pas possible ici (la simplification, par le réseau, la fait).
 * - Aller-retour (double découpe d'une même polyligne) : le repli est retiré (le tracé revient
 *   sur ses pas, la partie repliée n'est pas découpée).
 * - Filet sous l'outil : les sommets des deux flancs, dans la boîte du point, sont écartés de la
 *   moitié de ce qui manque pour atteindre `WIDEN_TARGET`·d (quelques passes). Un même sommet
 *   (mêmes coordonnées au bit près) bouge partout à la fois : une frontière commune reste commune.
 *
 * Pur, sur tableaux typés ; la vérification (problème résolu, aucun croisement nouveau) est celle
 * de `correctScene` (`index.ts`), qui relance l'analyse.
 */
import { Geodesic, GEODESIC_FACTOR, vertexAdjacency, WorkBudget } from './analyze.ts';
import { bboxOf, polygonArea, type CutGeometry, type CutPolyline } from './geometry.ts';
import { SegmentGrid } from './grid.ts';
import { buildNetwork } from './network.ts';
import type { CutBox, CutFix } from './report.ts';

/** Largeur visée par l'élargissement d'un filet : 10 % au-dessus du diamètre de l'outil. */
export const WIDEN_TARGET = 1.1;
/** Passes d'élargissement au plus (chacune relit les écarts après la précédente). */
const WIDEN_PASSES = 3;
/** Égalité des boîtes du rapport (arrondies au millième de px). */
const BOX_EPS = 2e-3;
/** Colinéarité d'un repli (px). */
const FOLD_EPS = 1e-6;

export interface FixGeometryOptions {
  /** Diamètre de l'outil (px). */
  d: number;
  /** Aire d'un petit îlot (px²). */
  islandPx2: number;
}

export interface FixGeometryResult {
  geometry: CutGeometry;
  /** Par correction demandée : appliquée (à vérifier par l'analyse), ou impossible ici. */
  applied: boolean[];
}

const inBox = (x: number, y: number, b: CutBox, m: number): boolean =>
  x >= b.x - m && x <= b.x + b.width + m && y >= b.y - m && y <= b.y + b.height + m;

const sameBox = (a: [number, number, number, number], b: CutBox): boolean =>
  Math.abs(a[0] - b.x) <= BOX_EPS &&
  Math.abs(a[1] - b.y) <= BOX_EPS &&
  Math.abs(a[2] - a[0] - b.width) <= BOX_EPS &&
  Math.abs(a[3] - a[1] - b.height) <= BOX_EPS;

/** Applique les corrections demandées (dans l'ordre : îlots, allers-retours, filets). */
export function fixGeometry(
  geom: CutGeometry,
  fixes: readonly CutFix[],
  o: FixGeometryOptions,
): FixGeometryResult {
  const applied = fixes.map(() => false);
  let polylines: CutPolyline[] = geom.polylines.slice();
  const isStroke = (pl: CutPolyline): boolean => geom.items[pl.item]!.stroke;

  // --- Îlots --------------------------------------------------------------------------------
  const removed = new Set<number>();
  const islandOf = new Map<number, number>();
  fixes.forEach((f, k) => {
    if (f.kind !== 'island') return;
    const loops: number[] = [];
    polylines.forEach((pl, p) => {
      if (!pl.closed || isStroke(pl)) return;
      if (Math.abs(polygonArea(pl.pts)) >= o.islandPx2) return;
      if (sameBox(bboxOf(pl.pts), f.box)) loops.push(p);
    });
    if (loops.length === 0) return;
    for (const p of loops) {
      removed.add(p);
      islandOf.set(p, k);
    }
    applied[k] = true;
  });
  if (removed.size) {
    // Un autre contour passe-t-il encore par un sommet de l'îlot ? Alors son bord reste découpé.
    const owner = new Map<string, number>();
    for (const p of removed) {
      const pts = polylines[p]!.pts;
      for (let i = 0; i < pts.length; i += 2)
        owner.set(`${pts[i]} ${pts[i + 1]}`, islandOf.get(p)!);
    }
    polylines.forEach((pl, p) => {
      if (removed.has(p)) return;
      for (let i = 0; i < pl.pts.length; i += 2) {
        const k = owner.get(`${pl.pts[i]} ${pl.pts[i + 1]}`);
        if (k !== undefined) applied[k] = false;
      }
    });
    polylines = polylines.filter((_, p) => !removed.has(p) || !applied[islandOf.get(p)!]);
  }

  // --- Allers-retours -----------------------------------------------------------------------
  fixes.forEach((f, k) => {
    if (f.kind !== 'overlap') return;
    let changed = false;
    polylines = polylines.map((pl) => {
      if (isStroke(pl)) return pl;
      const pts = unfold(pl.pts, pl.closed, f.box);
      if (pts === pl.pts) return pl;
      changed = true;
      return { ...pl, pts };
    });
    applied[k] = changed;
  });

  // --- Filets -------------------------------------------------------------------------------
  const thinBoxes: { k: number; box: CutBox }[] = [];
  fixes.forEach((f, k) => {
    if (f.kind === 'thin') thinBoxes.push({ k, box: f.box });
  });
  let geometry: CutGeometry = { ...geom, polylines };
  if (thinBoxes.length) {
    const moved = widen(
      geometry,
      thinBoxes.map((t) => t.box),
      o.d,
    );
    geometry = moved.geometry;
    thinBoxes.forEach((t, n) => {
      applied[t.k] = moved.moved[n]!;
    });
  }
  return { geometry, applied };
}

/**
 * Retire les replis (le tracé repart en arrière sur sa propre ligne) dont le sommet tombe dans
 * la boîte. Rend le tableau d'origine si rien ne change.
 */
export function unfold(pts: Float64Array, closed: boolean, box: CutBox): Float64Array {
  const n = pts.length / 2;
  if (n < 3) return pts;
  // Une polyligne fermée commence hors de la boîte : son repli n'est pas coupé par le départ.
  let start = 0;
  if (closed) {
    for (let k = 0; k < n; k++) {
      if (!inBox(pts[2 * k]!, pts[2 * k + 1]!, box, FOLD_EPS)) {
        start = k;
        break;
      }
    }
  }
  const out: number[] = [];
  let changed = false;
  const total = closed ? n + 1 : n;
  for (let q = 0; q < total; q++) {
    const k = (start + q) % n;
    out.push(pts[2 * k]!, pts[2 * k + 1]!);
    for (;;) {
      const m = out.length / 2;
      if (m < 3) break;
      const ax = out[2 * m - 6]!;
      const ay = out[2 * m - 5]!;
      const bx = out[2 * m - 4]!;
      const by = out[2 * m - 3]!;
      const cx = out[2 * m - 2]!;
      const cy = out[2 * m - 1]!;
      if (!inBox(bx, by, box, FOLD_EPS) || !isFold(ax, ay, bx, by, cx, cy)) break;
      // Le sommet b est un repli : a → b → c redevient a → c (sur la ligne de a à b).
      out.splice(2 * m - 4, 2);
      changed = true;
      if (out.length >= 4) {
        const l = out.length;
        if (out[l - 4] === out[l - 2] && out[l - 3] === out[l - 1]) out.length = l - 2;
      }
    }
  }
  if (!changed) return pts;
  // Fermée : le dernier point répète le départ.
  if (closed && out.length >= 4) {
    const l = out.length;
    if (out[0] === out[l - 2] && out[1] === out[l - 1]) out.length = l - 2;
  }
  return Float64Array.from(out);
}

/** a → b → c revient sur ses pas : c sur la droite (a, b), du côté de a. */
function isFold(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const ux = bx - ax;
  const uy = by - ay;
  const vx = cx - bx;
  const vy = cy - by;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return lu === 0 && lv === 0 ? false : true;
  return Math.abs(ux * vy - uy * vx) / lu <= FOLD_EPS && ux * vx + uy * vy < 0;
}

/**
 * Écarte les flancs des filets dont la boîte est donnée : chaque sommet (réseau) d'une boîte
 * (élargie de d) à moins de `WIDEN_TARGET`·d d'un segment qui n'est pas son voisin le long des
 * lignes de découpe (critère géodésique de l'analyse) s'en éloigne de la moitié de l'écart manquant.
 */
function widen(
  geom: CutGeometry,
  boxes: CutBox[],
  d: number,
): { geometry: CutGeometry; moved: boolean[] } {
  const target = WIDEN_TARGET * d;
  const moved = boxes.map(() => false);
  let geometry = geom;
  for (let pass = 0; pass < WIDEN_PASSES; pass++) {
    const net = buildNetwork(geometry);
    const stroke = (s: number): boolean =>
      geometry.items[geometry.polylines[net.spoly[s]!]!.item]!.stroke;
    const uniq: number[] = [];
    for (let s = 0; s < net.ns; s++) if (net.dupOf[s]! < 0) uniq.push(s);
    const ids = Int32Array.from(uniq);
    const ax = new Float64Array(net.ns);
    const ay = new Float64Array(net.ns);
    const bx = new Float64Array(net.ns);
    const by = new Float64Array(net.ns);
    for (const s of ids) {
      ax[s] = net.vx[net.sa[s]!]!;
      ay[s] = net.vy[net.sa[s]!]!;
      bx[s] = net.vx[net.sb[s]!]!;
      by[s] = net.vy[net.sb[s]!]!;
    }
    const grid = new SegmentGrid(ids, ax, ay, bx, by, target / 2);
    const adj = vertexAdjacency(net, ids);
    const geo = new Geodesic(net, adj, new WorkBudget(Infinity, Infinity));
    const stamp = new Int32Array(net.ns).fill(-1);
    const moves = new Map<number, [number, number]>();
    for (let v = 0; v < net.nv; v++) {
      const x = net.vx[v]!;
      const y = net.vy[v]!;
      const b = boxes.findIndex((bx0) => inBox(x, y, bx0, d));
      if (b < 0) continue;
      // Segment incident (remplissage) : l'origine de la recherche géodésique.
      let own = -1;
      for (let k = adj.start[v]!; k < adj.start[v + 1]!; k++) {
        if (!stroke(adj.segs[k]!)) {
          own = adj.segs[k]!;
          break;
        }
      }
      if (own < 0) continue;
      let best: [number, number] | null = null;
      grid.forEachCell(x, y, x, y, (c) => {
        for (let k = grid.start[c]!; k < grid.start[c + 1]!; k++) {
          const s = grid.items[k]!;
          if (stamp[s] === v) continue;
          stamp[s] = v;
          if (net.sa[s] === v || net.sb[s] === v) continue;
          const dx = bx[s]! - ax[s]!;
          const dy = by[s]! - ay[s]!;
          const l2 = dx * dx + dy * dy;
          const t =
            l2 > 0 ? Math.min(1, Math.max(0, ((x - ax[s]!) * dx + (y - ay[s]!) * dy) / l2)) : 0;
          const qx = ax[s]! + t * dx;
          const qy = ay[s]! + t * dy;
          const dist = Math.hypot(x - qx, y - qy);
          if (!(dist < target) || dist <= 1e-9) continue;
          if (geo.linked(own, x, y, s, qx, qy, GEODESIC_FACTOR * d)) continue;
          const need = (target - dist) / 2;
          if (best && Math.hypot(best[0], best[1]) >= need) continue;
          best = [((x - qx) / dist) * need, ((y - qy) / dist) * need];
        }
      });
      if (best) {
        moves.set(v, best);
        moved[b] = true;
      }
    }
    if (moves.size === 0) break;
    const to = new Map<string, [number, number]>();
    for (const [v, [mx, my]] of moves)
      to.set(`${net.vx[v]} ${net.vy[v]}`, [net.vx[v]! + mx, net.vy[v]! + my]);
    geometry = {
      ...geometry,
      polylines: geometry.polylines.map((pl) => {
        let pts: Float64Array | null = null;
        for (let i = 0; i < pl.pts.length; i += 2) {
          const m = to.get(`${pl.pts[i]} ${pl.pts[i + 1]}`);
          if (!m) continue;
          pts ??= pl.pts.slice();
          pts[i] = m[0];
          pts[i + 1] = m[1];
        }
        return pts ? { ...pl, pts } : pl;
      }),
    };
  }
  return { geometry, moved };
}
