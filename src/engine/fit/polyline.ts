/**
 * T04 — Préparation de la polyligne : dédoublonnage, détection des coins,
 * lissage. Fonctions pures sur tableaux typés.
 */

import { pointLineDistance } from './bezier.ts';

/**
 * Tolérance (pixels) du Douglas-Peucker local qui affine la position d'un coin
 * dans sa fenêtre : 1 px ignore un émoussé d'un pixel.
 */
export const CORNER_DP_TOLERANCE = 1;
/** Demi-fenêtre max k (en points) de mesure de l'angle de virage. */
export const CORNER_WINDOW = 6;

/**
 * Coordonnées séparées dans `x`, `y` (capacité ≥ points.length / 2), doublons
 * consécutifs retirés. Pour une chaîne fermée, le point de fermeture
 * (répétition du premier) est retiré : n points cycliques. Renvoie n.
 */
export function splitPoints(
  points: Float64Array,
  closed: boolean,
  x: Float64Array,
  y: Float64Array,
): number {
  const m = points.length >> 1;
  let n = 0;
  for (let i = 0; i < m; i++) {
    const px = points[2 * i]!;
    const py = points[2 * i + 1]!;
    if (n > 0 && x[n - 1] === px && y[n - 1] === py) continue;
    x[n] = px;
    y[n] = py;
    n++;
  }
  if (closed) while (n > 1 && x[n - 1] === x[0] && y[n - 1] === y[0]) n--;
  return n;
}

/**
 * Sommets de Douglas-Peucker (pile explicite) sur [a, b] d'un tableau
 * indexé modulo n. Pousse dans `out` les indices intérieurs retenus (non triés).
 */
function douglasPeucker(
  x: Float64Array,
  y: Float64Array,
  n: number,
  a: number,
  b: number,
  tol: number,
  out: number[],
): void {
  const stack = [a, b];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    if (hi - lo < 2) continue;
    const ax = x[lo % n]!;
    const ay = y[lo % n]!;
    const bx = x[hi % n]!;
    const by = y[hi % n]!;
    let worst = tol;
    let wi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointLineDistance(x[i % n]!, y[i % n]!, ax, ay, bx, by);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (wi < 0) continue;
    out.push(wi);
    stack.push(lo, wi, wi, hi);
  }
}

/** Angle (degrés, 0 = tout droit) entre les directions arrière et avant en i (indices modulo n). */
function turnAngle(
  x: Float64Array,
  y: Float64Array,
  n: number,
  i: number,
  back: number,
  fwd: number,
): number {
  return (Math.acos(turnCos(x, y, n, i, back, fwd)) * 180) / Math.PI;
}

/** Cosinus de l'angle entre (p_i − p_{i−back}) et (p_{i+fwd} − p_i), indices modulo n ; 1 si dégénéré. */
function turnCos(
  x: Float64Array,
  y: Float64Array,
  n: number,
  i: number,
  back: number,
  fwd: number,
): number {
  const ii = ((i % n) + n) % n;
  const ia = (((i - back) % n) + n) % n;
  const ib = (((i + fwd) % n) + n) % n;
  const bx = x[ii]! - x[ia]!;
  const by = y[ii]! - y[ia]!;
  const fx = x[ib]! - x[ii]!;
  const fy = y[ib]! - y[ii]!;
  const l = Math.sqrt((bx * bx + by * by) * (fx * fx + fy * fy));
  if (l === 0) return 1;
  const c = (bx * fx + by * fy) / l;
  return c < -1 ? -1 : c > 1 ? 1 : c;
}

/** Demi-fenêtre k (en points) de détection des coins : 2 à 6 selon la longueur. */
export function cornerWindow(n: number): number {
  return Math.max(2, Math.min(CORNER_WINDOW, n >> 3));
}

/**
 * Coins de la polyligne BRUTE (n points utiles).
 *
 * 1. Angle « k-cosinus » en chaque point : entre p_i − p_{i−k} et p_{i+k} − p_i,
 *    k = `cornerWindow(n)` (fenêtre tronquée près des extrémités d'une chaîne
 *    ouverte, ignorée si < 2). Moyenné sur k pas, l'escalier du treillis (ou
 *    celui, à 2–3 px, d'une image suréchantillonnée) ne compte plus.
 * 2. Pics : maxima locaux sur ±k dépassant `cornerAngle`.
 * 3. Affinage de chaque pic sur sa fenêtre [i − k, i + k] : Douglas-Peucker à
 *    `CORNER_DP_TOLERANCE` ; si 1 ou 2 sommets y font un angle > `cornerAngle`
 *    (coin net, ou deux coins rapprochés : bout d'une barre fine), ce sont les
 *    coins ; sinon (coin émoussé par l'anti-aliasing), le point le plus éloigné
 *    de la corde de la fenêtre.
 *
 * Ouverte : les extrémités ne sont jamais renvoyées (ce sont des sommets
 * fixes de toute façon). Fermée : indices cycliques 0..n−1.
 * Renvoie les indices triés et leurs angles (degrés, pour choisir l'ancre).
 */
export function detectCorners(
  x: Float64Array,
  y: Float64Array,
  n: number,
  closed: boolean,
  cornerAngle: number,
): { index: number[]; angle: number[] } {
  const index: number[] = [];
  const angle: number[] = [];
  if (n < 3) return { index, angle };
  if (cornerAngle <= 0) {
    // « 0 = tout est coin » : chaque point est une discontinuité de tangente.
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      index.push(i);
      angle.push(turnAngle(x, y, n, i, 1, 1));
    }
    return { index, angle };
  }
  const k = cornerWindow(n);
  const cosT = Math.cos((cornerAngle * Math.PI) / 180);
  // cs[i] = cosinus de l'angle de virage (2 = non mesuré).
  const cs = new Float64Array(n).fill(2);
  for (let i = 0; i < n; i++) {
    const kk = closed ? Math.min(k, (n - 1) >> 1) : Math.min(k, i, n - 1 - i);
    if (kk >= 2) cs[i] = turnCos(x, y, n, i, kk, kk);
  }
  const found = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const ci = cs[i]!;
    if (!(ci < cosT)) continue;
    let peak = true;
    for (let d = -k; d <= k && peak; d++) {
      if (d === 0) continue;
      let j = i + d;
      if (closed) j = (j + n) % n;
      else if (j < 0 || j >= n) continue;
      if (j === i) continue;
      const cj = cs[j]!;
      // Plateau : on garde le premier point (dans le sens de parcours).
      if (cj < ci || (cj === ci && d < 0)) peak = false;
    }
    if (peak) refineCorner(x, y, n, closed, i, k, cornerAngle, cs, found);
  }
  const keys = [...found.keys()].sort((p, q) => p - q);
  for (const i of keys) {
    index.push(i);
    angle.push(found.get(i)!);
  }
  return { index, angle };
}

/** Étape 3 de `detectCorners` : remplit `found` (indice → angle en degrés). */
function refineCorner(
  x: Float64Array,
  y: Float64Array,
  n: number,
  closed: boolean,
  i: number,
  k: number,
  cornerAngle: number,
  cs: Float64Array,
  found: Map<number, number>,
): void {
  // Indices « virtuels » croissants (décalés de n pour rester positifs si fermée).
  let lo = i - k;
  let hi = i + k;
  if (closed) {
    lo += n;
    hi += n;
    if (hi - lo >= n) hi = lo + n - 1;
  } else {
    lo = Math.max(0, lo);
    hi = Math.min(n - 1, hi);
  }
  const v: number[] = [lo, hi];
  douglasPeucker(x, y, n, lo, hi, CORNER_DP_TOLERANCE, v);
  v.sort((p, q) => p - q);
  const sharp: number[] = [];
  const sharpAngle: number[] = [];
  for (let j = 1; j + 1 < v.length; j++) {
    const a = turnAngle(x, y, n, v[j]!, v[j]! - v[j - 1]!, v[j + 1]! - v[j]!);
    if (a > cornerAngle) {
      sharp.push(v[j]! % n);
      sharpAngle.push(a);
    }
  }
  if (sharp.length === 1 || sharp.length === 2) {
    for (let j = 0; j < sharp.length; j++) found.set(sharp[j]!, sharpAngle[j]!);
    return;
  }
  // Coin émoussé : point le plus éloigné de la corde de la fenêtre.
  const ax = x[lo % n]!;
  const ay = y[lo % n]!;
  const bx = x[hi % n]!;
  const by = y[hi % n]!;
  let best = i;
  let bd = -1;
  for (let j = lo + 1; j < hi; j++) {
    const d = pointLineDistance(x[j % n]!, y[j % n]!, ax, ay, bx, by);
    if (d > bd) {
      bd = d;
      best = j % n;
    }
  }
  found.set(best, (Math.acos(Math.min(1, cs[i]!)) * 180) / Math.PI);
}

/** Rayon (en points) de la moyenne glissante pour un lissage 0..1. */
export function smoothingRadius(smoothing: number): number {
  return Math.max(0, Math.min(3, Math.round(smoothing * 3)));
}

/**
 * Moyenne glissante pondérée (poids triangulaires r+1−|j|) des points
 * strictement intérieurs à [a, b] ; a et b ne bougent pas. Fenêtre symétrique
 * tronquée près des bords (pas de biais). Déplacement plafonné à `maxShift`.
 */
export function smoothRange(
  ox: Float64Array,
  oy: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  a: number,
  b: number,
  r: number,
  maxShift: number,
  reach = 0,
): void {
  for (let i = a + 1; i < b; i++) {
    let k = Math.min(r, i - a, b - i);
    if (reach > k) k = Math.max(k, reachRadius(ox, oy, i, Math.min(reach, i - a, b - i), 0));
    smoothAt(ox, oy, sx, sy, i, k, 0, maxShift);
  }
}

/**
 * Rétrécissement toléré (pixels de travail) d'un arc par la moyenne glissante de portée
 * étendue : invisible même agrandi ×4 (0,4 px).
 */
export const REACH_SHRINK = 0.08;

/**
 * T43 — Plus grand rayon k ≤ `kmax` de la moyenne glissante au point i qui ne rétrécit pas
 * l'arc de plus de `REACH_SHRINK`. Sur un arc de rayon R, la moyenne à poids triangulaires de
 * rayon k déplace le point d'environ k² / 6R vers le centre ; θ, l'angle entre les cordes
 * [i − k, i] et [i, i + k], vaut ≈ 2k / R, d'où le critère k·θ / 12 ≤ `REACH_SHRINK`. L'escalier
 * du treillis ajoute à θ un bruit ≈ 1 / k, soit k·θ / 12 ≈ 0,08 : un palier droit passe. Un
 * coin ou un arrondi serré fait chuter k (0 : le rayon de base s'applique). `cyclicN` > 0 :
 * indices modulo n (île fermée).
 */
export function reachRadius(
  ox: Float64Array,
  oy: Float64Array,
  i: number,
  kmax: number,
  cyclicN: number,
): number {
  for (let k = kmax; k >= 1; k--) {
    let p = i - k;
    let q = i + k;
    if (cyclicN > 0) {
      p = (p + cyclicN) % cyclicN;
      q = q % cyclicN;
    }
    const ux = ox[i]! - ox[p]!;
    const uy = oy[i]! - oy[p]!;
    const vx = ox[q]! - ox[i]!;
    const vy = oy[q]! - oy[i]!;
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (l < 1e-12) continue;
    const theta = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l)));
    if ((k * theta) / 12 <= REACH_SHRINK) return k;
  }
  return 0;
}

/**
 * T43 — Droite des moindres carrés (totale : distance perpendiculaire, insensible à
 * l'orientation) des points [a, b] : écrit (x̄, ȳ, ux, uy) dans `out` à partir de `at`, renvoie
 * l'écart max des points à cette droite (infini sous 2 points).
 */
export function leastSquaresLine(
  x: Float64Array,
  y: Float64Array,
  a: number,
  b: number,
  out: Float64Array,
  at = 0,
): number {
  const n = b - a + 1;
  if (n < 2) return Infinity;
  let mx = 0;
  let my = 0;
  for (let i = a; i <= b; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = a; i <= b; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  out[at] = mx;
  out[at + 1] = my;
  out[at + 2] = ux;
  out[at + 3] = uy;
  let worst = 0;
  for (let i = a; i <= b; i++) {
    const d = Math.abs((y[i]! - my) * ux - (x[i]! - mx) * uy);
    if (d > worst) worst = d;
  }
  return worst;
}

/** Lissage cyclique de n points (île sans coin) : tous les points peuvent bouger. */
export function smoothCyclic(
  ox: Float64Array,
  oy: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  n: number,
  r: number,
  maxShift: number,
  reach = 0,
): void {
  const k = Math.min(r, (n - 1) >> 1);
  const kr = Math.min(reach, (n - 1) >> 1);
  for (let i = 0; i < n; i++) {
    const ki = kr > k ? Math.max(k, reachRadius(ox, oy, i, kr, n)) : k;
    smoothAt(ox, oy, sx, sy, i, ki, n, maxShift);
  }
}

function smoothAt(
  ox: Float64Array,
  oy: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  i: number,
  k: number,
  cyclicN: number,
  maxShift: number,
): void {
  const x0 = ox[i]!;
  const y0 = oy[i]!;
  if (k <= 0) {
    sx[i] = x0;
    sy[i] = y0;
    return;
  }
  let wx = (k + 1) * x0;
  let wy = (k + 1) * y0;
  let w = k + 1;
  for (let j = 1; j <= k; j++) {
    const wj = k + 1 - j;
    let p = i - j;
    let q = i + j;
    if (cyclicN > 0) {
      p = (p + cyclicN) % cyclicN;
      q = q % cyclicN;
    }
    wx += wj * (ox[p]! + ox[q]!);
    wy += wj * (oy[p]! + oy[q]!);
    w += 2 * wj;
  }
  let dx = wx / w - x0;
  let dy = wy / w - y0;
  const d = Math.hypot(dx, dy);
  if (d > maxShift) {
    const f = maxShift / d;
    dx *= f;
    dy *= f;
  }
  sx[i] = x0 + dx;
  sy[i] = y0 + dy;
}
