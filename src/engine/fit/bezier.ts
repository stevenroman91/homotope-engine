/**
 * T04 — Noyaux numériques sur les cubiques de Bézier : fonctions pures sur
 * tableaux typés, sans allocation dans les boucles (portage WebAssembly futur).
 *
 * Une cubique est rangée dans 8 nombres consécutifs d'un `Float64Array` à
 * partir de `o` : p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y.
 */

/** Évalue B(t) ; écrit x dans out[0], y dans out[1]. */
export function bezierPoint(c: Float64Array, o: number, t: number, out: Float64Array): void {
  const s = 1 - t;
  const b0 = s * s * s;
  const b1 = 3 * s * s * t;
  const b2 = 3 * s * t * t;
  const b3 = t * t * t;
  out[0] = b0 * c[o]! + b1 * c[o + 2]! + b2 * c[o + 4]! + b3 * c[o + 6]!;
  out[1] = b0 * c[o + 1]! + b1 * c[o + 3]! + b2 * c[o + 5]! + b3 * c[o + 7]!;
}

/**
 * Un pas de Newton-Raphson pour rapprocher t du pied de la perpendiculaire
 * abaissée de (px, py) sur la courbe : minimise |B(t) − P|². Renvoie t ∈ [0, 1].
 */
export function newtonStep(c: Float64Array, o: number, px: number, py: number, t: number): number {
  const s = 1 - t;
  const x0 = c[o]!;
  const y0 = c[o + 1]!;
  const x1 = c[o + 2]!;
  const y1 = c[o + 3]!;
  const x2 = c[o + 4]!;
  const y2 = c[o + 5]!;
  const x3 = c[o + 6]!;
  const y3 = c[o + 7]!;
  // B(t)
  const bx = s * s * s * x0 + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * x3;
  const by = s * s * s * y0 + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t * y3;
  // B'(t)
  const dx = 3 * (s * s * (x1 - x0) + 2 * s * t * (x2 - x1) + t * t * (x3 - x2));
  const dy = 3 * (s * s * (y1 - y0) + 2 * s * t * (y2 - y1) + t * t * (y3 - y2));
  // B''(t)
  const ddx = 6 * (s * (x2 - 2 * x1 + x0) + t * (x3 - 2 * x2 + x1));
  const ddy = 6 * (s * (y2 - 2 * y1 + y0) + t * (y3 - 2 * y2 + y1));
  const ex = bx - px;
  const ey = by - py;
  const num = ex * dx + ey * dy;
  const den = dx * dx + dy * dy + ex * ddx + ey * ddy;
  if (!(Math.abs(den) > 1e-12)) return t;
  const r = t - num / den;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * Paramétrage par longueur de corde des points [first, last] : u[0] = 0,
 * u[last − first] = 1. Renvoie la longueur totale (0 si dégénérée, auquel cas
 * u est uniforme).
 */
export function chordLengthParameterize(
  xs: Float64Array,
  ys: Float64Array,
  first: number,
  last: number,
  u: Float64Array,
): number {
  const n = last - first;
  u[0] = 0;
  let acc = 0;
  for (let i = 1; i <= n; i++) {
    const dx = xs[first + i]! - xs[first + i - 1]!;
    const dy = ys[first + i]! - ys[first + i - 1]!;
    acc += Math.sqrt(dx * dx + dy * dy);
    u[i] = acc;
  }
  if (acc > 0) for (let i = 1; i <= n; i++) u[i] = u[i]! / acc;
  else for (let i = 1; i <= n; i++) u[i] = i / n;
  u[n] = 1;
  return acc;
}

/** Distance du point (px, py) au segment [(ax, ay), (bx, by)]. */
export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + t * vx - px;
  const dy = ay + t * vy - py;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance du point (px, py) à la droite portée par (ax, ay) → (bx, by) (segment si dégénérée). */
export function pointLineDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l = Math.sqrt(vx * vx + vy * vy);
  if (l === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(vx * (py - ay) - vy * (px - ax)) / l;
}
