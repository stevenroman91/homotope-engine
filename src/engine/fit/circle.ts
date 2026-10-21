/**
 * T125a — Formes exactes : cercle des moindres carrés et arcs en cubiques exactes.
 *
 * Fonctions pures sur tableaux typés. Un cercle (ou un arc) reconnu est émis en cubiques
 * tangentes de ≤ 90° chacune, poignées de longueur (4/3)·tan(φ/4)·r (kappa = 4(√2−1)/3 à 90°) :
 * écart au vrai cercle ≤ 0,03 % du rayon, toujours vers l'extérieur.
 */

import type { FitWorkspace } from './schneider.ts';
import { curveFaithful, measureError } from './schneider.ts';

/** Un tour (radians). */
export const TAU = 2 * Math.PI;

/**
 * Cercle de Kåsa (moindres carrés algébriques, données centrées) des points [a, b] : écrit
 * (cx, cy, r) dans `out`, renvoie l'écart radial max des points (NaN si dégénéré).
 */
export function fitCircle(
  x: Float64Array,
  y: Float64Array,
  a: number,
  b: number,
  out: Float64Array,
): number {
  const n = b - a + 1;
  let mx = 0;
  let my = 0;
  for (let i = a; i <= b; i++) {
    mx += x[i]! / n;
    my += y[i]! / n;
  }
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let ru = 0;
  let rv = 0;
  for (let i = a; i <= b; i++) {
    const u = x[i]! - mx;
    const v = y[i]! - my;
    const q = (u * u + v * v) / 2;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    ru += u * q;
    rv += v * q;
  }
  const det = suu * svv - suv * suv;
  const uc = (ru * svv - rv * suv) / det;
  const vc = (rv * suu - ru * suv) / det;
  out[0] = mx + uc;
  out[1] = my + vc;
  out[2] = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return radialError(x, y, a, b, out);
}

/** Écart radial max des points [a, b] au cercle (cx, cy, r) de `c`. */
export function radialError(
  x: Float64Array,
  y: Float64Array,
  a: number,
  b: number,
  c: Float64Array,
): number {
  let worst = 0;
  for (let i = a; i <= b; i++) {
    worst = Math.max(worst, Math.abs(Math.hypot(x[i]! - c[0]!, y[i]! - c[1]!) - c[2]!));
  }
  return worst;
}

/**
 * Progression angulaire des points [a, b] autour de (cx, cy) depuis l'angle `t0` (radians,
 * cumulée, signée ; le premier point est pris à moins d'un demi-tour de `t0`) écrite dans `tau` (indice i − a) ;
 * renvoie celle du dernier point.
 */
export function angularProgress(
  x: Float64Array,
  y: Float64Array,
  a: number,
  b: number,
  cx: number,
  cy: number,
  t0: number,
  tau: Float64Array,
): number {
  let px = x[a]! - cx;
  let py = y[a]! - cy;
  let acc = Math.atan2(py, px) - t0;
  tau[0] = acc;
  for (let i = a + 1; i <= b; i++) {
    const qx = x[i]! - cx;
    const qy = y[i]! - cy;
    acc += Math.atan2(px * qy - py * qx, px * qx + py * qy);
    tau[i - a] = acc;
    px = qx;
    py = qy;
  }
  return acc;
}

/**
 * Arc exact du cercle `c` (cx, cy, r, puis ax, ay, bx, by), de l'angle `t0` sur `sweep`
 * (|sweep| < 2π, ou un tour), en k = ⌈|sweep| / `step`⌉ cubiques égales (≤ 8 si `step` ≥ π/4)
 * écrites dans `cub` (8 nombres chacune : x0, y0, c1x, c1y, c2x, c2y, x1, y1), tangentes entre
 * elles, le départ posé en (ax, ay) et l'arrivée en (bx, by), poignées inchangées. F1 sur CHAQUE
 * cubique : les points ORIGINAUX [a, b] (progression `tau` depuis `t0`, indice i − a) restent à
 * moins de `tolerance` de leur cubique (majorant de `measureError`, paramètre = fraction d'angle,
 * borné à [0, 1] : la première et la dernière cubique prennent aussi les points dont la
 * progression sort de [0, sweep], mesurés à leur extrémité) et la cubique à moins de
 * `tolerance` de la polyligne [a, `polyEnd`] (`curveFaithful`, élargie d'une arête de chaque
 * côté). Renvoie k, 0 si une cubique échoue ou n'a plus aucun point (points clairsemés).
 */
export function arcCubics(
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  polyEnd: number,
  tau: Float64Array,
  c: Float64Array,
  t0: number,
  sweep: number,
  step: number,
  tolerance: number,
  ws: FitWorkspace,
  cub: Float64Array,
): number {
  const k = Math.ceil(Math.abs(sweep) / step - 1e-9); // ≥ 1 : balayage ≥ 20°
  const phi = sweep / k;
  const h = (4 / 3) * Math.tan(phi / 4) * c[2]!;
  let first = a;
  for (let j = 0; j < k; j++) {
    const q = cub.subarray(8 * j, 8 * j + 8);
    for (let e = 0; e < 2; e++) {
      // Nœud (e = 0 : départ, 1 : arrivée) et sa poignée, tangente au cercle.
      const t = t0 + (j + e) * phi;
      const px = c[0]! + c[2]! * Math.cos(t);
      const py = c[1]! + c[2]! * Math.sin(t);
      q[6 * e] = px;
      q[6 * e + 1] = py;
      q[2 + 2 * e] = px - (1 - 2 * e) * h * Math.sin(t);
      q[3 + 2 * e] = py + (1 - 2 * e) * h * Math.cos(t);
    }
    if (j === 0) {
      q[0] = c[3]!;
      q[1] = c[4]!;
    }
    if (first > b) return 0;
    let last = b;
    if (j === k - 1) {
      q[6] = c[5]!;
      q[7] = c[6]!;
    } else {
      last = first;
      while (last < b && (tau[last + 1 - a]! - (j + 1) * phi) * phi <= 0) last++;
    }
    ws.ensure(last - first + 1);
    for (let m = first; m <= last; m++) {
      ws.u[m - first] = Math.min(1, Math.max(0, (tau[m - a]! - j * phi) / phi));
    }
    measureError(q, ox, oy, first, last, ws.u, ws);
    if (!(ws.err < tolerance)) return 0;
    const p1 = Math.min(polyEnd, last + 1);
    if (!curveFaithful(q, ox, oy, Math.max(a, first - 1), p1, tolerance, ws.tmp)) return 0;
    first = last + 1;
  }
  return k;
}
