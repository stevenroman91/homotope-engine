/**
 * T04 — Ajustement de cubiques de Bézier à des points numérisés, d'après
 * P. J. Schneider, « An Algorithm for Automatically Fitting Digitized Curves »
 * (Graphics Gems, 1990) — réécrit, aucune copie de code tiers.
 *
 * Deux jeux de points de même indexation :
 *  - `sx, sy` : points LISSÉS, sur lesquels se font le paramétrage, les moindres
 *    carrés et le re-paramétrage ;
 *  - `ox, oy` : points ORIGINAUX (coins de treillis), sur lesquels se mesure
 *    l'erreur d'acceptation. La tolérance borne donc l'écart réel à l'image.
 *
 * Fonctions pures sur tableaux typés ; l'espace de travail est préalloué.
 */

import {
  bezierPoint,
  chordLengthParameterize,
  newtonStep,
  pointSegmentDistance,
} from './bezier.ts';

/** Un morceau ajusté couvrant les points [i0, i1]. */
export interface Span {
  i0: number;
  i1: number;
  cubic: boolean;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  /** Tangente unitaire au départ (vers l'intérieur du morceau). */
  t1x: number;
  t1y: number;
  /** Tangente unitaire à l'arrivée, orientée vers l'ARRIÈRE (vers l'intérieur). */
  t2x: number;
  t2y: number;
}

/** Espace de travail réutilisable (évite les allocations par morceau). */
export class FitWorkspace {
  u = new Float64Array(64);
  c = new Float64Array(8);
  best = new Float64Array(8);
  bestU = new Float64Array(64);
  tmp = new Float64Array(2);
  tangents = new Float64Array(4);
  /** Résultat de `measure` : erreur max et indice correspondant. */
  err = 0;
  split = 0;

  private pool: Float64Array[] = [];

  /** k-ième tampon de travail, de capacité ≥ n (contenu indéfini, longueur ≥ n). */
  buffer(k: number, n: number): Float64Array {
    let b = this.pool[k];
    if (!b || b.length < n) {
      b = new Float64Array(Math.max(n, 2 * (b?.length ?? 32)));
      this.pool[k] = b;
    }
    return b;
  }

  ensure(n: number): void {
    if (this.u.length < n) {
      let m = this.u.length;
      while (m < n) m *= 2;
      this.u = new Float64Array(m);
      this.bestU = new Float64Array(m);
    }
  }
}

/** Nombre d'itérations de Newton-Raphson par tentative. */
const MAX_ITERATIONS = 4;

/**
 * Moindres carrés pour les longueurs de poignée α1, α2 (extrémités et
 * tangentes imposées). Écrit la cubique dans `c`. Si α est négatif, quasi nul
 * ou démesuré, heuristique de Wu-Barsky : α = dist / 3.
 */
export function generateBezier(
  sx: Float64Array,
  sy: Float64Array,
  first: number,
  last: number,
  u: Float64Array,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  arcLength: number,
  c: Float64Array,
): void {
  const p0x = sx[first]!;
  const p0y = sy[first]!;
  const p3x = sx[last]!;
  const p3y = sy[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  const n = last - first;
  for (let i = 0; i <= n; i++) {
    const t = u[i]!;
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * s * s * t;
    const b2 = 3 * s * t * t;
    const b3 = t * t * t;
    const a1x = t1x * b1;
    const a1y = t1y * b1;
    const a2x = t2x * b2;
    const a2y = t2y * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const rx = sx[first + i]! - (p0x * (b0 + b1) + p3x * (b2 + b3));
    const ry = sy[first + i]! - (p0y * (b0 + b1) + p3y * (b2 + b3));
    x0 += a1x * rx + a1y * ry;
    x1 += a2x * rx + a2y * ry;
  }
  const det = c00 * c11 - c01 * c01;
  const segLength = Math.hypot(p3x - p0x, p3y - p0y);
  const scale = Math.max(segLength, arcLength * 0.5);
  let al = 0;
  let ar = 0;
  let ok = false;
  if (Math.abs(det) > 1e-12 * Math.max(1, c00 * c11)) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
    const eps = 1e-6 * scale;
    const big = Math.max(2 * segLength, arcLength);
    ok = al > eps && ar > eps && al < big && ar < big;
  }
  if (!ok) {
    // Wu-Barsky : sur une boucle fermée (corde nulle), l'échelle est l'arc.
    al = ar = scale / 3;
  }
  c[0] = p0x;
  c[1] = p0y;
  c[2] = p0x + t1x * al;
  c[3] = p0y + t1y * al;
  c[4] = p3x + t2x * ar;
  c[5] = p3y + t2y * ar;
  c[6] = p3x;
  c[7] = p3y;
}

/**
 * Erreur max des points ORIGINAUX [first, last] à la cubique : pour chaque
 * point, distance à B(t) avec t = u (paramètre du point lissé) affiné d'un pas
 * de Newton vers le point original — majorant de la distance vraie, donc sûr.
 * Écrit `ws.err` et `ws.split` (indice absolu du pire point intérieur).
 */
export function measureError(
  c: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  first: number,
  last: number,
  u: Float64Array,
  ws: FitWorkspace,
): void {
  const tmp = ws.tmp;
  let worst = -1;
  let worstI = (first + last) >> 1;
  const n = last - first;
  for (let i = 0; i <= n; i++) {
    const px = ox[first + i]!;
    const py = oy[first + i]!;
    const t = u[i]!;
    bezierPoint(c, 0, t, tmp);
    let d = (tmp[0]! - px) ** 2 + (tmp[1]! - py) ** 2;
    // Le pas de Newton ne peut que réduire d : inutile s'il ne changerait pas le max.
    if (d > worst && d > 1e-12) {
      const t2 = newtonStep(c, 0, px, py, t);
      bezierPoint(c, 0, t2, tmp);
      const d2 = (tmp[0]! - px) ** 2 + (tmp[1]! - py) ** 2;
      if (d2 < d) d = d2;
    }
    if (d > worst) {
      worst = d;
      if (i > 0 && i < n) worstI = first + i;
    }
  }
  ws.err = Math.sqrt(Math.max(0, worst));
  ws.split = worstI;
}

/** Échantillons de la courbe (t = k / n) pour l'écart courbe → polyligne. */
export const BACK_SAMPLES = 32;

/**
 * F1 (#18, point 2) — L'autre sens de la garantie : `measureError` borne
 * l'écart des points ORIGINAUX à la courbe, pas celui de la courbe à la
 * polyligne. Une cubique dont une poignée dépasse l'extrémité (projection sur
 * la corde au-delà de l'autre bout) fait une micro-boucle qui passe encore près
 * de chaque point. Vrai si la cubique `c` est acceptable : aucune poignée ne
 * dépasse, et chaque échantillon B(k / `BACK_SAMPLES`) est à moins de
 * `tolerance` de la polyligne [first, last] de `ox, oy`. Pur.
 */
export function curveFaithful(
  c: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  first: number,
  last: number,
  tolerance: number,
  tmp: Float64Array,
): boolean {
  const dx = c[6]! - c[0]!;
  const dy = c[7]! - c[1]!;
  const l2 = dx * dx + dy * dy;
  if (l2 > 1e-12) {
    const p1 = ((c[2]! - c[0]!) * dx + (c[3]! - c[1]!) * dy) / l2;
    const p2 = ((c[6]! - c[4]!) * dx + (c[7]! - c[5]!) * dy) / l2;
    if (p1 > 1 || p2 > 1) return false;
  }
  if (last <= first) return true;
  let hint = first;
  for (let k = 1; k < BACK_SAMPLES; k++) {
    bezierPoint(c, 0, k / BACK_SAMPLES, tmp);
    const px = tmp[0]!;
    const py = tmp[1]!;
    let best = pointSegmentDistance(px, py, ox[hint]!, oy[hint]!, ox[hint + 1]!, oy[hint + 1]!);
    for (let i = first; i < last && best >= tolerance; i++) {
      const ax = ox[i]!;
      const ay = oy[i]!;
      const bx = ox[i + 1]!;
      const by = oy[i + 1]!;
      // Boîte de l'arête déjà plus loin que le meilleur : inutile.
      if (Math.max(Math.min(ax, bx) - px, px - Math.max(ax, bx)) >= best) continue;
      if (Math.max(Math.min(ay, by) - py, py - Math.max(ay, by)) >= best) continue;
      const d = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (d < best) {
        best = d;
        hint = i;
      }
    }
    if (!(best < tolerance)) return false;
  }
  return true;
}

/** Re-paramétrage : un pas de Newton par point (lissé) vers la courbe. */
export function reparameterize(
  c: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  first: number,
  last: number,
  u: Float64Array,
): void {
  const n = last - first;
  for (let i = 1; i < n; i++) u[i] = newtonStep(c, 0, sx[first + i]!, sy[first + i]!, u[i]!);
}

/**
 * Meilleure cubique unique pour [first, last] (tangentes imposées) :
 * moindres carrés + au plus `MAX_ITERATIONS` re-paramétrages si l'erreur
 * initiale est raisonnable. Laisse la meilleure cubique dans `ws.best`,
 * son erreur dans `ws.err`, le point de coupe dans `ws.split`.
 */
export function fitSingleCubic(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  first: number,
  last: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  tolerance: number,
  ws: FitWorkspace,
): number {
  const n = last - first + 1;
  ws.ensure(n);
  const u = ws.u;
  const c = ws.c;
  const arc = chordLengthParameterize(sx, sy, first, last, u);
  generateBezier(sx, sy, first, last, u, t1x, t1y, t2x, t2y, arc, c);
  // Une cubique dans la tolérance mais infidèle dans l'autre sens (F1) compte
  // pour `tolerance` : jamais acceptée, le re-paramétrage peut la corriger.
  const judged = (): number =>
    ws.err < tolerance && !curveFaithful(c, ox, oy, first, last, tolerance, ws.tmp)
      ? tolerance
      : ws.err;
  measureError(c, ox, oy, first, last, u, ws);
  let bestErr = judged();
  let bestSplit = ws.split;
  ws.best.set(c);
  if (bestErr >= tolerance && bestErr < tolerance * 4) {
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      reparameterize(c, sx, sy, first, last, u);
      generateBezier(sx, sy, first, last, u, t1x, t1y, t2x, t2y, arc, c);
      measureError(c, ox, oy, first, last, u, ws);
      const prev = bestErr;
      const e = judged();
      if (e < bestErr) {
        bestErr = e;
        bestSplit = ws.split;
        ws.best.set(c);
      }
      // Arrêt : dans la tolérance, ou le re-paramétrage ne progresse plus.
      if (bestErr < tolerance || bestErr > prev * 0.97) break;
    }
  }
  ws.err = bestErr;
  ws.split = bestSplit;
  return bestErr;
}

/**
 * Cubique d'erreur MINIMALE pour [first, last] (tangentes imposées) : re-paramètre
 * toujours (jusqu'à `MAX_ITERATIONS` pas, tant que l'erreur baisse), l'erreur
 * se mesurant sur `ex, ey` (les points LISSÉS pour le raffinement T08 : ils
 * suivent le vrai bord, l'escalier du treillis en est retiré). Laisse la
 * cubique dans `ws.best`, son paramétrage dans `ws.bestU`. Puis, si
 * `tolerance` est finie, vérifie l'erreur sur les points ORIGINAUX : renvoie
 * `Infinity` si elle n'est pas < `tolerance` (la garantie de T04 tient).
 */
export function fitSingleCubicMin(
  sx: Float64Array,
  sy: Float64Array,
  ex: Float64Array,
  ey: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  first: number,
  last: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  tolerance: number,
  ws: FitWorkspace,
): number {
  const n = last - first + 1;
  ws.ensure(n);
  const u = ws.u;
  const c = ws.c;
  const arc = chordLengthParameterize(sx, sy, first, last, u);
  generateBezier(sx, sy, first, last, u, t1x, t1y, t2x, t2y, arc, c);
  measureError(c, ex, ey, first, last, u, ws);
  let bestErr = ws.err;
  ws.best.set(c);
  ws.bestU.set(u.subarray(0, n));
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    reparameterize(c, sx, sy, first, last, u);
    generateBezier(sx, sy, first, last, u, t1x, t1y, t2x, t2y, arc, c);
    measureError(c, ex, ey, first, last, u, ws);
    const prev = bestErr;
    if (ws.err < bestErr) {
      bestErr = ws.err;
      ws.best.set(c);
      ws.bestU.set(u.subarray(0, n));
    }
    if (!(ws.err < prev * 0.995)) break;
  }
  if (Number.isFinite(tolerance)) {
    measureError(ws.best, ox, oy, first, last, ws.bestU, ws);
    if (!(ws.err < tolerance)) return Infinity;
    if (!curveFaithful(ws.best, ox, oy, first, last, tolerance, ws.tmp)) return Infinity;
  }
  ws.err = bestErr;
  return bestErr;
}

/** Tangente unitaire au point intérieur `i`, orientée vers l'arrière (Schneider). */
function centerTangent(
  sx: Float64Array,
  sy: Float64Array,
  first: number,
  last: number,
  i: number,
  out: Float64Array,
): void {
  for (let m = Math.min(3, i - first, last - i); m >= 1; m--) {
    const dx = sx[i - m]! - sx[i + m]!;
    const dy = sy[i - m]! - sy[i + m]!;
    const l = Math.hypot(dx, dy);
    if (l > 1e-9) {
      out[0] = dx / l;
      out[1] = dy / l;
      return;
    }
  }
  const dx = sx[first]! - sx[last]!;
  const dy = sy[first]! - sy[last]!;
  const l = Math.hypot(dx, dy) || 1;
  out[0] = dx / l;
  out[1] = dy / l;
}

function lineSpan(
  i0: number,
  i1: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
): Span {
  return { i0, i1, cubic: false, c1x: 0, c1y: 0, c2x: 0, c2y: 0, t1x, t1y, t2x, t2y };
}

/**
 * Ajuste [first, last] par une suite de cubiques (subdivision au point
 * d'erreur max, tangente continue aux points de coupe) et pousse les morceaux
 * dans `out`, dans l'ordre. Un morceau de 2 points devient une ligne.
 * Pile explicite : aucune récursion (chaînes de milliers de points).
 */
export function fitCubicRange(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  first: number,
  last: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  tolerance: number,
  ws: FitWorkspace,
  out: Span[],
): void {
  // Pile de tâches : [first, last, t1x, t1y, t2x, t2y] × k.
  const stack: number[] = [first, last, t1x, t1y, t2x, t2y];
  const ct = ws.tmp;
  while (stack.length > 0) {
    const b2y = stack.pop()!;
    const b2x = stack.pop()!;
    const a1y = stack.pop()!;
    const a1x = stack.pop()!;
    const l = stack.pop()!;
    const f = stack.pop()!;
    if (l - f < 2) {
      out.push(lineSpan(f, l, a1x, a1y, b2x, b2y));
      continue;
    }
    const err = fitSingleCubic(sx, sy, ox, oy, f, l, a1x, a1y, b2x, b2y, tolerance, ws);
    if (err < tolerance) {
      const b = ws.best;
      out.push({
        i0: f,
        i1: l,
        cubic: true,
        c1x: b[2]!,
        c1y: b[3]!,
        c2x: b[4]!,
        c2y: b[5]!,
        t1x: a1x,
        t1y: a1y,
        t2x: b2x,
        t2y: b2y,
      });
      continue;
    }
    const split = ws.split;
    centerTangent(sx, sy, f, l, split, ct);
    const cx = ct[0]!;
    const cy = ct[1]!;
    // Droite d'abord (traitée en second), gauche ensuite (dépilée en premier).
    stack.push(split, l, -cx, -cy, b2x, b2y);
    stack.push(f, split, a1x, a1y, cx, cy);
  }
}
