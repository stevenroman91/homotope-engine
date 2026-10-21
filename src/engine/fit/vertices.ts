/**
 * T125c — Sommets partagés posés sur les formes exactes (`exactShapes`).
 *
 * Un sommet du graphe (extrémité commune de deux ou trois chaînes ouvertes) est sur le treillis
 * entier, à ≈ 0,5 px du point où se rencontrent les formes que l'œil voit (droite, cercle). Avant
 * l'ajustement par chaîne, chaque chaîne reconnaît la forme de ses deux tronçons TERMINAUX (entre
 * son extrémité et son premier coin) : droite des moindres carrés (critère de `snapCorners`, T43)
 * ou cercle de Kåsa (critères de `exactShape`, T125a). Chaque sommet de degré 2 ou 3 est ensuite
 * posé UNE fois : moyenne des intersections bien conditionnées de ses formes deux à deux (racine
 * la plus proche du sommet), sinon projection sur sa forme UNIQUE, rien sinon ; un candidat à
 * plus de la tolérance la plus large de ses chaînes est écarté, le déplacement plafonné à
 * `ROBUST_SNAP` × la plus stricte (garantie F1 sur les points ORIGINAUX). La position
 * est la même pour toutes les chaînes du sommet : les faces de part et d'autre gardent des
 * coordonnées identiques. Sommet de degré > 3, sur le bord de l'image, en pointe fine ou
 * extrémité d'une chaîne fermée : inchangé. Fonctions pures sur tableaux typés ; O(points des tronçons terminaux).
 */

import { checkCancel } from '../pipeline.ts';
import type { BoundaryChain, FitOptions, VectorizeContext } from '../types.ts';
import { IMAGE_BORDER } from '../types.ts';
import { TAU, angularProgress } from './circle.ts';
import { detectCorners, smoothRange, smoothingRadius, splitPoints } from './polyline.ts';
import {
  EXACT_MIN_POINTS,
  EXACT_MIN_SWEEP,
  ROBUST_SNAP,
  exactCircle,
  straightLine,
} from './shapes.ts';

/** Forme d'un bout de chaîne : aucune, droite (x, y, ux, uy) ou cercle (cx, cy, r). */
export const NONE = 0;
export const LINE = 1;
export const CIRCLE = 2;

/**
 * Angle minimal (radians) entre deux formes à leur intersection pour qu'elle soit retenue : en
 * dessous, l'erreur de position (∝ 1 / sin θ) d'une forme presque tangente à l'autre dépasse ce
 * que le sommet y gagne (deux arcs d'un même cercle de part et d'autre d'une barre).
 */
const VERTEX_MIN_ANGLE = (30 * Math.PI) / 180;

/** Tampons réutilisés d'une chaîne à l'autre : x, y, lissés, progression angulaire. */
type Buffers = [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];

/** Chaînes traitées entre deux points de reprise (annulation). */
const CANCEL_EVERY = 256;

/**
 * Positions des extrémités recalées : `out[4i..4i+3]` = (xDébut, yDébut, xFin, yFin) de la
 * chaîne i, NaN pour une extrémité inchangée. `optionsOf(i)` : options effectives de la chaîne i
 * (tolérance resserrée par `thinTolerances` comprise). `corners[i]` reçoit les coins de la chaîne
 * ouverte i (`detectCorners` sur `splitPoints`), que l'ajustement réutilise. Renvoie null si aucun
 * sommet ne bouge.
 */
export function sharedVertexPositions(
  chains: readonly BoundaryChain[],
  optionsOf: (i: number) => FitOptions,
  corners: (number[] | undefined)[],
  ctx?: VectorizeContext,
): Float64Array | null {
  const n = chains.length;
  // Bouts de chaque sommet : 2i (début de la chaîne i) ou 2i + 1 (fin).
  const at = new Map<number, number[]>();
  const add = (v: number, e: number): void => {
    const ends = at.get(v);
    if (ends) ends.push(e);
    else at.set(v, [e]);
  };
  for (let i = 0; i < n; i++) {
    const c = chains[i]!;
    if (c.closed) continue;
    add(c.start, 2 * i);
    add(c.end, 2 * i + 1);
  }
  // Sommet déplaçable : degré 2 ou 3, aucune chaîne sur le bord de l'image.
  const movable = (v: number): boolean => {
    const ends = at.get(v)!;
    return (
      ends.length >= 2 &&
      ends.length <= 3 &&
      ends.every((e) => {
        const c = chains[e >> 1]!;
        return c.left !== IMAGE_BORDER && c.right !== IMAGE_BORDER;
      })
    );
  };
  // Forme de chaque bout : kind[e], paramètres shape[4e..4e + 3] ; seuls les bouts déplaçables.
  const kind = new Uint8Array(2 * n + 1);
  kind[2 * n] = LINE;
  const shape = new Float64Array(8 * n + 4);
  let buf: Buffers | null = null;
  for (let i = 0; i < n; i++) {
    if (i % CANCEL_EVERY === 0) checkCancel(ctx);
    const c = chains[i]!;
    if (c.closed) continue;
    const atStart = movable(c.start);
    const atEnd = movable(c.end);
    if (!atStart && !atEnd) continue;
    const o = optionsOf(i);
    const p = c.points;
    const cap = (p.length >> 1) + 1;
    if (!buf || buf[0].length < cap)
      buf = [0, 1, 2, 3, 4].map(() => new Float64Array(cap * 2)) as Buffers;
    const m = splitPoints(p, false, buf[0], buf[1]);
    if (m < 3) continue;
    const idx = detectCorners(buf[0], buf[1], m, false, o.cornerAngle).index;
    corners[i] = idx;
    const first = idx.length > 0 ? idx[0]! : m - 1;
    if (atStart) endShape(buf, 0, first, o, kind, shape, 2 * i);
    if (!atEnd) continue;
    if (atStart && first === m - 1) {
      // Un seul tronçon : même forme aux deux bouts.
      kind[2 * i + 1] = kind[2 * i]!;
      shape.copyWithin(8 * i + 4, 8 * i, 8 * i + 4);
    } else
      endShape(buf, idx.length > 0 ? idx[idx.length - 1]! : 0, m - 1, o, kind, shape, 2 * i + 1);
  }
  const out = new Float64Array(4 * n).fill(NaN);
  let moved = false;
  const cand: number[] = [];
  const pt = new Float64Array(2);
  for (const [v, ends] of at) {
    if (!movable(v)) continue;
    // Point de treillis du sommet, lu au bout `ends[0]`.
    const p = chains[ends[0]! >> 1]!.points;
    const q = ends[0]! & 1 ? p.length - 2 : 0;
    const x0 = p[q]!;
    const y0 = p[q + 1]!;
    // Candidat retenu à moins de la tolérance la plus LARGE de ses chaînes (au-delà, la forme
    // ne décrit pas ce sommet) ; déplacement plafonné par la plus STRICTE (bande mince, T08).
    const os = ends.map((e) => optionsOf(e >> 1));
    // Pointe fine : deux chaînes partent du sommet sous moins de `VERTEX_MIN_ANGLE` (vers leur
    // 8e point) et leurs tolérances additionnées atteignent leur écart : leurs courbes pourraient
    // se croiser si le sommet bougeait (`badge.png`, contrôle de découpe). Une bande mince à
    // tolérance resserrée (T08, couronne du logo de l'accueil) bouge.
    const far = ends.map((e) => {
      const c = chains[e >> 1]!.points;
      const k = e & 1 ? Math.max(0, c.length - 18) : Math.min(c.length - 2, 16);
      return [c[k]! - x0, c[k + 1]! - y0] as const;
    });
    if (
      far.some((u, a) =>
        far.some(
          (w, b) =>
            b > a &&
            u[0] * w[0] + u[1] * w[1] >
              Math.cos(VERTEX_MIN_ANGLE) * Math.hypot(...u) * Math.hypot(...w) &&
            os[a]!.tolerance + os[b]!.tolerance >= Math.hypot(u[0] - w[0], u[1] - w[1]),
        ),
      )
    )
      continue;
    const reach = Math.max(...os.map((o) => o.tolerance));
    const tol = Math.min(...os.map((o) => o.tolerance));
    cand.length = 0;
    const keep = (): void => {
      if (Math.hypot(pt[0]! - x0, pt[1]! - y0) < reach) cand.push(pt[0]!, pt[1]!);
    };
    for (let a = 0; a < ends.length; a++)
      for (let b = a + 1; b < ends.length; b++)
        if (intersect(kind, shape, ends[a]!, ends[b]!, x0, y0, pt)) keep();
    // Sans intersection retenue : projection sur la forme UNIQUE du sommet. Deux formes ou plus
    // sans intersection (bords parallèles d'une bande mince, à 0,75 px l'un de l'autre sur
    // `badge.png`) : la moyenne de leurs projections ne serait sur aucune, rien.
    const shaped = ends.filter((e) => kind[e] !== NONE);
    if (cand.length === 0 && shaped.length === 1) {
      // Projection = intersection avec la droite sonde (bout 2n) passant par le sommet :
      // perpendiculaire à la droite, ou radiale pour un cercle.
      const q = 4 * shaped[0]!;
      const line = kind[shaped[0]!] === LINE;
      const dx = line ? -shape[q + 3]! : x0 - shape[q]!;
      const dy = line ? shape[q + 2]! : y0 - shape[q + 1]!;
      const l = Math.hypot(dx, dy);
      shape.set([x0, y0, dx / l, dy / l], 8 * n);
      if (intersect(kind, shape, shaped[0]!, 2 * n, x0, y0, pt)) keep();
    }
    if (cand.length === 0) continue;
    let tx = 0;
    let ty = 0;
    for (let k = 0; k < cand.length; k += 2) {
      tx += cand[k]!;
      ty += cand[k + 1]!;
    }
    tx = tx / (cand.length >> 1) - x0;
    ty = ty / (cand.length >> 1) - y0;
    const d = Math.hypot(tx, ty);
    const f = Math.min(1, (ROBUST_SNAP * tol) / d);
    for (const e of ends) {
      out[2 * e] = x0 + tx * f;
      out[2 * e + 1] = y0 + ty * f;
    }
    moved = true;
  }
  return moved ? out : null;
}

/** Forme du tronçon terminal [a, b] (points de `buf`), écrite au bout `e`. */
function endShape(
  buf: Buffers,
  a: number,
  b: number,
  o: FitOptions,
  kind: Uint8Array,
  shape: Float64Array,
  e: number,
): void {
  const [x, y, sx, sy, tau] = buf;
  // Paramètres écrits en place ; sans forme reconnue (`kind` NONE), ils ne sont pas lus.
  if (straightLine(x, y, a, b, o, shape, 4 * e)) {
    kind[e] = LINE;
    return;
  }
  if (b - a < EXACT_MIN_POINTS) return;
  // Points lissés comme dans l'ajustement (sommets fixes).
  sx.set(x.subarray(a, b + 1), a);
  sy.set(y.subarray(a, b + 1), a);
  const r = smoothingRadius(o.smoothing);
  const maxShift = 0.5 * Math.max(0, o.tolerance);
  if (r > 0 && maxShift > 0) smoothRange(x, y, sx, sy, a, b, r, maxShift, o.smoothingReach);
  const c = shape.subarray(4 * e, 4 * e + 3);
  if (!exactCircle(sx, sy, x, y, a, b, o, c)) return;
  const t0 = Math.atan2(y[a]! - c[1]!, x[a]! - c[0]!);
  const sweep = Math.abs(angularProgress(x, y, a, b, c[0]!, c[1]!, t0, tau));
  if (sweep >= EXACT_MIN_SWEEP && sweep < TAU) kind[e] = CIRCLE;
}

/**
 * Intersection des formes des bouts `e` et `f` la plus proche de (x0, y0), écrite dans `pt` ;
 * faux si l'une manque, si elles ne se coupent pas ou se coupent sous `VERTEX_MIN_ANGLE`. Deux
 * cercles se coupent sur leur axe radical : ramené à droite ∩ cercle.
 */
export function intersect(
  kind: Uint8Array,
  s: Float64Array,
  e: number,
  f: number,
  x0: number,
  y0: number,
  pt: Float64Array,
): boolean {
  if (kind[e] === NONE || kind[f] === NONE) return false;
  if (kind[e] === CIRCLE && kind[f] === LINE) return intersect(kind, s, f, e, x0, y0, pt);
  const p = 4 * e;
  const q = 4 * f;
  // Droite (px, py, ux, uy) : celle du bout e, ou l'axe radical des deux cercles.
  let px = s[p]!;
  let py = s[p + 1]!;
  let ux = s[p + 2]!;
  let uy = s[p + 3]!;
  if (kind[e] === CIRCLE) {
    const dx = s[q]! - px;
    const dy = s[q + 1]! - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) return false;
    const along = (s[p + 2]! ** 2 - s[q + 2]! ** 2 + d2) / (2 * d2);
    px += along * dx;
    py += along * dy;
    const d = Math.sqrt(d2);
    ux = -dy / d;
    uy = dx / d;
  }
  if (kind[f] === LINE) {
    // Droite ∩ droite.
    const vx = s[q + 2]!;
    const vy = s[q + 3]!;
    const cross = ux * vy - uy * vx;
    if (cross === 0) return false;
    const t = ((s[q]! - px) * vy - (s[q + 1]! - py) * vx) / cross;
    pt[0] = px + t * ux;
    pt[1] = py + t * uy;
  } else {
    // Droite ∩ cercle (C, r) : pied F du centre, puis F ± h·u, racine du côté du sommet.
    const t = (s[q]! - px) * ux + (s[q + 1]! - py) * uy;
    const fx = px + t * ux;
    const fy = py + t * uy;
    const h2 = s[q + 2]! ** 2 - (s[q]! - fx) ** 2 - (s[q + 1]! - fy) ** 2;
    if (h2 <= 0) return false;
    const h = (x0 - fx) * ux + (y0 - fy) * uy >= 0 ? Math.sqrt(h2) : -Math.sqrt(h2);
    pt[0] = fx + h * ux;
    pt[1] = fy + h * uy;
  }
  // Angle entre les deux formes au point : sinus de l'angle de leurs tangentes.
  const [ax, ay] = tangent(kind, s, e, pt);
  const [bx, by] = tangent(kind, s, f, pt);
  return Math.abs(ax * by - ay * bx) >= Math.sin(VERTEX_MIN_ANGLE);
}

/** Tangente unitaire de la forme du bout `e` au point `pt` (sur elle). */
function tangent(kind: Uint8Array, s: Float64Array, e: number, pt: Float64Array): [number, number] {
  const p = 4 * e;
  if (kind[e] === LINE) return [s[p + 2]!, s[p + 3]!];
  return [(s[p + 1]! - pt[1]!) / s[p + 2]!, (pt[0]! - s[p]!) / s[p + 2]!];
}
