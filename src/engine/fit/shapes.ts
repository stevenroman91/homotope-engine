/**
 * T43, T125a, T125c — Formes reconnues d'un tronçon, partagées par l'ajustement d'une chaîne
 * (`snapCorners`, `exactShape`) et la passe des sommets partagés (`vertices.ts`) : mêmes
 * critères, mêmes constantes. Pur, sur tableaux typés.
 */

import type { FitOptions } from '../types.ts';
import { fitCircle, radialError } from './circle.ts';
import { leastSquaresLine } from './polyline.ts';

/**
 * T43 — Droites robustes (`robustLines`) : déplacement max d'un coin recalé, en fraction de
 * `tolerance`. Sous 1 : la courbe reste à moins de `tolerance` de la polyligne (garantie F1).
 */
export const ROBUST_SNAP = 0.95;
/** Points minimum d'un tronçon pour que sa droite des moindres carrés soit fiable. */
export const ROBUST_LINE_MIN_POINTS = 16;
/**
 * T125a — Formes exactes (`exactShapes`) : rayon minimal (px de travail) d'un cercle posé, sous
 * lequel l'escalier du treillis rend la forme ambiguë ; balayage minimal d'un arc (un arc plus
 * court se confond avec une droite ou une courbe quelconque) ; points minimum d'un tronçon.
 */
export const EXACT_MIN_RADIUS = 6;
export const EXACT_MIN_SWEEP = (20 * Math.PI) / 180;
export const EXACT_MIN_POINTS = 8;
/** Points des bouts d'un tronçon exclus du test lissé : la moyenne y est tronquée (`smoothRange`). */
export const EXACT_END_WINDOW = 3;

/**
 * T43 — Le tronçon [a, b] (≥ `ROBUST_LINE_MIN_POINTS` points) est droit au sens des moindres
 * carrés : ses points ORIGINAUX tiennent autour de leur droite (x̄, ȳ, ux, uy, écrite dans `out`
 * à partir de `at`) sous la limite de `isStraightPiece`.
 */
export function straightLine(
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  opts: FitOptions,
  out: Float64Array,
  at = 0,
): boolean {
  if (b - a < ROBUST_LINE_MIN_POINTS) return false;
  const err = leastSquaresLine(ox, oy, a, b, out, at);
  const band = Math.abs(out[at + 2]!) + Math.abs(out[at + 3]!);
  return err < Math.min(opts.lineTolerance + 0.5 * band, opts.tolerance);
}

/**
 * T125a — Le tronçon [a, b] tient dans le cercle de Kåsa (cx, cy, r écrits dans `c`) de ses
 * points ORIGINAUX : ceux-ci à moins de `tolerance`, les points LISSÉS à ≤ `lineTolerance` hors
 * des `EXACT_END_WINDOW` points de chaque bout, r ≥ `EXACT_MIN_RADIUS`, ≥ `EXACT_MIN_POINTS`
 * points. Le balayage est testé par l'appelant.
 */
export function exactCircle(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  opts: FitOptions,
  c: Float64Array,
): boolean {
  const w = EXACT_END_WINDOW;
  return (
    b - a >= EXACT_MIN_POINTS &&
    fitCircle(ox, oy, a, b, c) < opts.tolerance &&
    // Garde : sans ce test, le contrôle de découpe de badge.png (logo) passe au rouge.
    radialError(sx, sy, a + w, b - w, c) <= opts.lineTolerance &&
    c[2]! >= EXACT_MIN_RADIUS
  );
}
