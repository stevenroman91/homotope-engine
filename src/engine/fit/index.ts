import type {
  BoundaryChain,
  FitOptions,
  FittedChain,
  Segment,
  VectorizeContext,
} from '../types.ts';
import { checkCancel, globalProgress } from '../pipeline.ts';
import {
  bezierPoint,
  chordLengthParameterize,
  newtonStep,
  pointSegmentDistance,
} from './bezier.ts';
import {
  detectCorners,
  smoothCyclic,
  smoothingRadius,
  smoothRange,
  splitPoints,
} from './polyline.ts';
import { TAU, angularProgress, arcCubics } from './circle.ts';
import { EXACT_MIN_SWEEP, ROBUST_SNAP, exactCircle, straightLine } from './shapes.ts';
import { sharedVertexPositions } from './vertices.ts';
import type { Span } from './schneider.ts';
import {
  FitWorkspace,
  fitCubicRange,
  fitSingleCubic,
  fitSingleCubicMin,
  lineSpan,
  measureError,
  setCubic,
} from './schneider.ts';

/** Chaînes ajustées entre deux points de reprise (annulation, progression). */
const CANCEL_EVERY = 256;
/** Nombre max de passes de fusion des morceaux adjacents. */
const MERGE_SWEEPS = 4;
/** Passes de raffinement des jonctions (tangentes et positions), voir `refineSpans`. */
const REFINE_SWEEPS = 1;
/** Rotations essayées des tangentes de jonction (radians : ≈ 3°, 0,7°). */
const REFINE_ANGLES = [0.05, -0.05, 0.012, -0.012];
/**
 * Erreur (points lissés, fraction de `tolerance`) sous laquelle une jonction
 * n'est pas raffinée : l'écart n'est plus visible, inutile de payer le calcul.
 */
const REFINE_GOAL = 0.55;
/**
 * Longueur minimale (points) d'un morceau raffiné : sur un morceau court,
 * l'écart possible est petit et le bruit du treillis domine (coût inutile).
 */
const REFINE_MIN_POINTS = 32;
/**
 * Rayon (px de travail) sous lequel une cubique d'arc de 90° reste à moins de 0,01 px du cercle
 * (écart max 0,027 % du rayon, toujours vers l'extérieur) ; au-delà, un arc prend des cubiques
 * plus courtes. Sans cela, sur `anneau-barre` (r = 100), l'écart au cercle de T125b montait.
 */
const EXACT_ARC_REF = 37;
/**
 * T04 — Ajustement d'UNE chaîne : lissage (sommets fixes), détection des coins,
 * segments droits, cubiques de Bézier (Schneider) avec tolérance, nœuds minimaux.
 *
 * Les extrémités d'une chaîne ouverte (sommets partagés) ne bougent jamais.
 * Une chaîne fermée (île sans jonction) prend pour ancre son coin le plus net,
 * ou, sans coin, garde une ancre à tangente continue (qui peut glisser lors de
 * la fusion finale).
 */
export function fitChain(chain: BoundaryChain, options: FitOptions): FittedChain {
  return fitChainWith(chain, options, new FitWorkspace());
}

/**
 * T04 — Ajuste toutes les chaînes d'un graphe (chacune UNE fois).
 * `tolerances` (T08, optionnel) : tolérance propre à chaque chaîne (indexée par
 * id), retenue si elle est plus stricte que `options.tolerance` (voir
 * `thinTolerances`).
 *
 * T125c — `exactShapes` (hors pixel art) : passe globale AVANT l'ajustement, les sommets
 * partagés sont posés sur les formes exactes de leurs chaînes (`sharedVertexPositions`), une
 * position par sommet écrite dans toutes ses chaînes ; le graphe n'est pas modifié.
 */
export function fitChains(
  chains: BoundaryChain[],
  options: FitOptions,
  ctx?: VectorizeContext,
  tolerances?: ArrayLike<number>,
): FittedChain[] {
  const ws = new FitWorkspace();
  const out: FittedChain[] = new Array<FittedChain>(chains.length);
  const n = chains.length;
  const optionsOf = (i: number): FitOptions => {
    const t = tolerances?.[chains[i]!.id];
    return t !== undefined && t < options.tolerance
      ? { ...options, tolerance: t, lineTolerance: Math.min(options.lineTolerance, t) }
      : options;
  };
  const corners: (number[] | undefined)[] = [];
  const ends =
    options.exactShapes && !options.pixelArt
      ? sharedVertexPositions(chains, optionsOf, corners, ctx)
      : null;
  for (let i = 0; i < n; i++) {
    if (i % CANCEL_EVERY === 0) {
      checkCancel(ctx);
      ctx?.onProgress?.(globalProgress('fit', i / n));
    }
    out[i] = fitChainWith(chains[i]!, optionsOf(i), ws, corners[i], ends, i);
  }
  checkCancel(ctx);
  ctx?.onProgress?.(globalProgress('fit', 1));
  return out;
}

/** Part de l'épaisseur de la face la plus mince accordée à la tolérance d'une chaîne. */
export const THIN_FACTOR = 0.25;

/**
 * T08 — Tolérance par chaîne bornée par la MINCEUR des faces qu'elle borde :
 * une forme de 2 px ajustée à ±1 px ondule, se pince ou disparaît (anneau fin
 * de l'icône 64×64, petite région de dégradé pincée entre deux fûts). Épaisseur
 * d'une région = 2 × aire / périmètre (≈ largeur d'une bande) ; tolérance =
 * clamp(`THIN_FACTOR` × épaisseur, `tolerance` / 3, `tolerance`). Pur ;
 * `regionArea[r]` = aire de la région r (pixels de travail).
 */
export function thinTolerances(
  chains: readonly BoundaryChain[],
  regionArea: ArrayLike<number>,
  tolerance: number,
): Float64Array {
  const per = new Float64Array(regionArea.length);
  for (const c of chains) {
    const len = (c.points.length >> 1) - 1;
    if (c.left >= 0) per[c.left] = per[c.left]! + len;
    if (c.right >= 0) per[c.right] = per[c.right]! + len;
  }
  const thick = (r: number): number =>
    r >= 0 && per[r]! > 0 ? (2 * regionArea[r]!) / per[r]! : Infinity;
  const out = new Float64Array(chains.length);
  for (const c of chains) {
    const t = THIN_FACTOR * Math.min(thick(c.left), thick(c.right));
    out[c.id] = Math.min(tolerance, Math.max(tolerance / 3, t));
  }
  return out;
}

// Tampons de l'espace de travail (réutilisés d'une chaîne à l'autre).
const BX = 0;
const BY = 1;
const BRX = 2;
const BRY = 3;
const BSX = 4;
const BSY = 5;
const BEXT = 6; // 6..9 : tableaux déroulés d'une île lisse
const BTAU = 10; // 10..11 (T125a) : progression angulaire ; cubiques d'arc, puis le cercle
const BARC = 11;

/**
 * `corners` : coins de la chaîne ouverte déjà détectés (T125c), sinon calculés ici. `ends` (T125c) :
 * extrémités recalées de la chaîne `at` (`ends[4 at..4 at + 3]`, NaN = inchangée).
 */
function fitChainWith(
  chain: BoundaryChain,
  options: FitOptions,
  ws: FitWorkspace,
  corners?: number[],
  ends?: Float64Array | null,
  at = 0,
): FittedChain {
  const p = chain.points;
  const cap = (p.length >> 1) + 1;
  const x = ws.buffer(BX, cap);
  const y = ws.buffer(BY, cap);
  let n = splitPoints(p, chain.closed, x, y);
  // Chaîne réduite à un point : jamais une chaîne ouverte du graphe (≥ 2 points distincts), donc
  // jamais un sommet recalé par T125c (`ends` n'est lu que par `fitOpen`).
  if (n <= 1) return { chain: chain.id, start: [p[0] ?? 0, p[1] ?? 0], segments: [] };
  let closed = chain.closed;
  if (closed && n < 3) {
    // Boucle dégénérée : on la traite comme une polyligne ouverte refermée.
    x[n] = x[0]!;
    y[n] = y[0]!;
    n++;
    closed = false;
  }
  if (options.pixelArt) return pixelArtChain(chain.id, x, y, n, closed);
  if (!closed) {
    const index = corners ?? detectCorners(x, y, n, false, options.cornerAngle).index;
    return fitOpen(chain.id, x, y, n, [0, ...index, n - 1], options, ws, false, ends, 4 * at);
  }
  const { index, angle } = detectCorners(x, y, n, true, options.cornerAngle);
  if (index.length === 0) return fitClosedSmooth(chain.id, x, y, n, options, ws);
  // Île à coins : l'ancre devient le coin le plus net, puis comme une chaîne ouverte.
  let best = 0;
  for (let j = 1; j < angle.length; j++) if (angle[j]! > angle[best]!) best = j;
  const a = index[best]!;
  const [rx, ry] = unroll(x, y, n, a, ws);
  const breaks = index.map((i) => (i - a + n) % n).filter((i) => i > 0);
  breaks.sort((u, v) => u - v);
  return fitOpen(chain.id, rx, ry, n + 1, [0, ...breaks, n], options, ws, true);
}

/** Île de n points rouverte au point `a` : n + 1 points (fermeture comprise) dans `BRX`/`BRY`. */
function unroll(
  x: Float64Array,
  y: Float64Array,
  n: number,
  a: number,
  ws: FitWorkspace,
): [Float64Array, Float64Array] {
  const rx = ws.buffer(BRX, n + 1);
  const ry = ws.buffer(BRY, n + 1);
  for (let k = 0; k <= n; k++) {
    rx[k] = x[(a + k) % n]!;
    ry[k] = y[(a + k) % n]!;
  }
  return [rx, ry];
}

/**
 * Chaîne ouverte de n points (ou île rouverte à son ancre, `cyclic`) découpée en tronçons aux
 * `breaks`.
 */
function fitOpen(
  id: number,
  ox: Float64Array,
  oy: Float64Array,
  n: number,
  breaks: number[],
  opts: FitOptions,
  ws: FitWorkspace,
  cyclic = false,
  ends?: Float64Array | null,
  at = 0,
): FittedChain {
  const sx = ws.buffer(BSX, n);
  const sy = ws.buffer(BSY, n);
  sx.set(ox.subarray(0, n));
  sy.set(oy.subarray(0, n));
  const r = smoothingRadius(opts.smoothing);
  const maxShift = 0.5 * Math.max(0, opts.tolerance);
  if (r > 0 && maxShift > 0) {
    for (let j = 0; j + 1 < breaks.length; j++) {
      smoothRange(ox, oy, sx, sy, breaks[j]!, breaks[j + 1]!, r, maxShift, opts.smoothingReach);
    }
  }
  if (opts.robustLines) snapCorners(ox, oy, sx, sy, breaks, opts, cyclic);
  // T125c — Sommets partagés recalés (`sharedVertexPositions`) ; les points ORIGINAUX restent.
  for (let k = 0; ends && k < 2; k++) {
    const i = k * (n - 1);
    const v = ends[at + 2 * k]!;
    // NaN : extrémité inchangée.
    if (v === v) {
      sx[i] = v;
      sy[i] = ends[at + 2 * k + 1]!;
    }
  }
  const spans: Span[] = [];
  const t = ws.tangents;
  for (let j = 0; j + 1 < breaks.length; j++) {
    const a = breaks[j]!;
    const b = breaks[j + 1]!;
    const piece: Span[] = [];
    endTangents(sx, sy, a, b, t);
    // Arc exact (T125a) : posé tel quel, ni fusion ni raffinement.
    if (fitPiece(sx, sy, ox, oy, a, b, t[0]!, t[1]!, t[2]!, t[3]!, opts, ws, piece)) {
      for (const s of piece) spans.push(s);
      continue;
    }
    mergeSpans(piece, sx, sy, ox, oy, opts, ws);
    if (refineSpans(piece, sx, sy, ox, oy, opts.tolerance, ws, 0)) {
      mergeSpans(piece, sx, sy, ox, oy, opts, ws);
      refineSpans(piece, sx, sy, ox, oy, opts.tolerance, ws, 0);
    }
    for (const s of piece) spans.push(s);
  }
  // sx[0] = ox[0], sauf ancre d'île recalée (T43).
  return toFitted(id, sx[0]!, sy[0]!, spans, sx, sy);
}

/** Île sans coin (n points cycliques) : ancre à tangente continue, fusion possible par-dessus l'ancre. */
function fitClosedSmooth(
  id: number,
  x: Float64Array,
  y: Float64Array,
  n: number,
  opts: FitOptions,
  ws: FitWorkspace,
): FittedChain {
  const sx0 = ws.buffer(BSX, n);
  const sy0 = ws.buffer(BSY, n);
  sx0.set(x.subarray(0, n));
  sy0.set(y.subarray(0, n));
  const r = smoothingRadius(opts.smoothing);
  const maxShift = 0.5 * Math.max(0, opts.tolerance);
  if (r > 0 && maxShift > 0) smoothCyclic(x, y, sx0, sy0, n, r, maxShift, opts.smoothingReach);
  const exact: Span[] = [];
  if (opts.exactShapes && exactShape(sx0, sy0, x, y, 0, n - 1, true, opts, ws, exact)) {
    return toFitted(id, exact[3]!.ex!, exact[3]!.ey!, exact, x, y);
  }
  // T08 — Ancre là où la tangente est la plus DIAGONALE : le point 0 d'une île
  // est son coin le plus haut à gauche, au milieu d'un palier d'extremum où le
  // lissage est biaisé ; une ancre (point de passage imposé) y faisait déborder
  // la courbe d'un demi-pixel (sommet du « O » de logo-aa).
  const a = diagonalAnchor(sx0, sy0, n);
  // Tableaux déroulés deux fois (2n + 1 points) depuis l'ancre : indices
  // continus par-dessus elle.
  const m2 = 2 * n + 1;
  const sx = ws.buffer(BEXT, m2);
  const sy = ws.buffer(BEXT + 1, m2);
  const ox = ws.buffer(BEXT + 2, m2);
  const oy = ws.buffer(BEXT + 3, m2);
  for (let k = 0; k < m2; k++) {
    const i = (a + k) % n;
    sx[k] = sx0[i]!;
    sy[k] = sy0[i]!;
    ox[k] = x[i]!;
    oy[k] = y[i]!;
  }
  // Tangente à l'ancre, partagée par le premier et le dernier morceau.
  let tx = 0;
  let ty = 0;
  for (let m = Math.min(3, (n - 1) >> 1); m >= 1 && tx === 0 && ty === 0; m--) {
    const dx = sx[m]! - sx[n - m]!;
    const dy = sy[m]! - sy[n - m]!;
    const l = Math.hypot(dx, dy);
    if (l > 1e-9) {
      tx = dx / l;
      ty = dy / l;
    }
  }
  if (tx === 0 && ty === 0) tx = 1;
  let spans: Span[] = [];
  fitCubicRange(sx, sy, ox, oy, 0, n, tx, ty, -tx, -ty, opts.tolerance, ws, spans);
  mergeSpans(spans, sx, sy, ox, oy, opts, ws);
  if (spans.length >= 2) {
    // Fusion par-dessus l'ancre : dernier morceau + premier (décalé de n).
    const last = spans[spans.length - 1]!;
    const first = spans[0]!;
    const merged = tryMerge(last, shift(first, n), sx, sy, ox, oy, opts, ws);
    if (merged) {
      const rest = spans.slice(1, -1).map((s) => shift(s, n));
      spans = [merged, ...rest];
      mergeSpans(spans, sx, sy, ox, oy, opts, ws);
    }
  }
  if (refineSpans(spans, sx, sy, ox, oy, opts.tolerance, ws, m2 - 1)) {
    mergeSpans(spans, sx, sy, ox, oy, opts, ws);
    refineSpans(spans, sx, sy, ox, oy, opts.tolerance, ws, m2 - 1);
  }
  const s0 = spans[0]!.i0;
  return toFitted(id, sx[s0]!, sy[s0]!, spans, sx, sy);
}

/** Indice (cyclique) dont la tangente lissée, sur ±3 points, est la plus proche de 45°. */
function diagonalAnchor(sx: Float64Array, sy: Float64Array, n: number): number {
  const m = Math.min(3, (n - 1) >> 1);
  if (m < 1) return 0;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < n; i++) {
    const dx = sx[(i + m) % n]! - sx[(i - m + n) % n]!;
    const dy = sy[(i + m) % n]! - sy[(i - m + n) % n]!;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) continue;
    const score = Math.abs(dx * dy) / l2; // 0,5 à 45°, 0 sur un axe
    if (score > bestScore + 1e-9) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

function shift(s: Span, d: number): Span {
  return { ...s, i0: s.i0 + d, i1: s.i1 + d };
}

/**
 * Tangentes d'extrémité d'un tronçon [a, b] : direction vers un point situé à
 * quelques pas (et pas le voisin immédiat : l'escalier du treillis la
 * fausserait). t[0..1] au départ (vers l'avant), t[2..3] à l'arrivée (vers l'arrière).
 */
function endTangents(
  sx: Float64Array,
  sy: Float64Array,
  a: number,
  b: number,
  t: Float64Array,
): void {
  const len = b - a;
  const m = Math.max(1, Math.min(len, 6, Math.max(2, Math.round(len / 4))));
  dir(sx, sy, a, a + m, b, t, 0);
  dir(sx, sy, b, b - m, a, t, 2);
}

function dir(
  sx: Float64Array,
  sy: Float64Array,
  from: number,
  to: number,
  fallback: number,
  t: Float64Array,
  o: number,
): void {
  let dx = sx[to]! - sx[from]!;
  let dy = sy[to]! - sy[from]!;
  let l = Math.hypot(dx, dy);
  if (l < 1e-9) {
    dx = sx[fallback]! - sx[from]!;
    dy = sy[fallback]! - sy[from]!;
    l = Math.hypot(dx, dy);
  }
  if (l < 1e-9) {
    dx = 1;
    dy = 0;
    l = 1;
  }
  t[o] = dx / l;
  t[o + 1] = dy / l;
}

/**
 * Un tronçon est DROIT si ses points lissés restent à ≤ `lineTolerance` de la
 * corde ET ses points originaux à < `tolerance` (la fidélité reste bornée).
 */
function isLine(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  opts: FitOptions,
): boolean {
  if (b - a < 2) return true;
  const ax = sx[a]!;
  const ay = sy[a]!;
  const bx = sx[b]!;
  const by = sy[b]!;
  if (Math.hypot(bx - ax, by - ay) < 1e-9) return false;
  for (let i = a + 1; i < b; i++) {
    if (pointSegmentDistance(sx[i]!, sy[i]!, ax, ay, bx, by) > opts.lineTolerance) return false;
    if (pointSegmentDistance(ox[i]!, oy[i]!, ax, ay, bx, by) >= opts.tolerance) return false;
  }
  return true;
}

/**
 * Test de droite d'un tronçon ENTIER (entre coins/extrémités). Les coins de
 * treillis d'une droite numérisée de pente m ≤ 1 s'étalent sur une bande de
 * hauteur ≤ 1 + m, soit (|cos θ| + |sin θ|) en distance perpendiculaire. On
 * tolère `lineTolerance` + la moitié de cette bande, sans jamais atteindre
 * `tolerance` (la fidélité aux points originaux reste garantie).
 */
function isStraightPiece(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  opts: FitOptions,
): boolean {
  if (isLine(sx, sy, ox, oy, a, b, opts)) return true;
  // Extrémités lissées : égales aux originales (le lissage ne bouge pas un coin), sauf coin
  // recalé par `snapCorners` (T43).
  const ax = sx[a]!;
  const ay = sy[a]!;
  const bx = sx[b]!;
  const by = sy[b]!;
  const l = Math.hypot(bx - ax, by - ay);
  if (l < 1e-9) return false;
  const band = (Math.abs(bx - ax) + Math.abs(by - ay)) / l;
  const lim = Math.min(opts.lineTolerance + 0.5 * band, opts.tolerance);
  for (let i = a + 1; i < b; i++) {
    const d = pointSegmentDistance(ox[i]!, oy[i]!, ax, ay, bx, by);
    if (!(d < lim)) return false;
  }
  return true;
}

/**
 * T43 — Droites robustes. Un tronçon d'au moins `ROBUST_LINE_MIN_POINTS` points est droit au
 * sens des moindres carrés si ses points tiennent autour de leur droite la mieux ajustée sous
 * la limite de `isStraightPiece`. Un coin INTÉRIEUR (jamais une extrémité de chaîne ouverte,
 * sommet partagé) entre deux tels tronçons va vers l'intersection de leurs droites ; entre un
 * tel tronçon et une courbe (ou le méplat de quelques points d'une pointe émoussée), vers sa
 * projection sur la droite. Le déplacement est plafonné à `ROBUST_SNAP` × `tolerance`.
 * L'anti-aliasing émousse une pointe d'un pixel : la corde entre coins de treillis penchait
 * alors et le tronçon, pourtant droit, sortait en courbe ; recalé, il suit sa droite. Écrit
 * dans `sx`/`sy` aux coins seulement. `cyclic` : île rouverte à son ancre (`breaks[0]` et le
 * dernier coin sont le même point).
 */
function snapCorners(
  ox: Float64Array,
  oy: Float64Array,
  sx: Float64Array,
  sy: Float64Array,
  breaks: number[],
  opts: FitOptions,
  cyclic: boolean,
): void {
  const m = breaks.length - 1;
  if (m < 2) return;
  const line = new Float64Array(4 * m);
  const straight = new Uint8Array(m);
  for (let j = 0; j < m; j++) {
    straight[j] = straightLine(ox, oy, breaks[j]!, breaks[j + 1]!, opts, line, 4 * j) ? 1 : 0;
  }
  const cap = ROBUST_SNAP * opts.tolerance;
  for (let k = cyclic ? 0 : 1; k < m; k++) {
    const p = k === 0 ? m - 1 : k - 1;
    const c = breaks[k]!;
    const cx = ox[c]!;
    const cy = oy[c]!;
    let tx: number;
    let ty: number;
    if (straight[p] && straight[k]) {
      // Intersection de (P + t·u) et (Q + s·v).
      const ux = line[4 * p + 2]!;
      const uy = line[4 * p + 3]!;
      const vx = line[4 * k + 2]!;
      const vy = line[4 * k + 3]!;
      const cross = ux * vy - uy * vx;
      if (Math.abs(cross) < 1e-6) continue;
      const dx = line[4 * k]! - line[4 * p]!;
      const dy = line[4 * k + 1]! - line[4 * p + 1]!;
      const t = (dx * vy - dy * vx) / cross;
      tx = line[4 * p]! + t * ux;
      ty = line[4 * p + 1]! + t * uy;
    } else if (straight[p] || straight[k]) {
      // Un seul voisin droit (l'autre est une courbe ou le méplat d'une pointe émoussée) :
      // projection du coin sur sa droite.
      const j = 4 * (straight[p] ? p : k);
      const ux = line[j + 2]!;
      const uy = line[j + 3]!;
      const t = (cx - line[j]!) * ux + (cy - line[j + 1]!) * uy;
      tx = line[j]! + t * ux;
      ty = line[j + 1]! + t * uy;
    } else continue;
    // Plafond : le coin reste à moins de `cap` de son point de treillis (garantie F1).
    const d = Math.hypot(tx - cx, ty - cy);
    const f = d > cap ? cap / d : 1;
    sx[c] = cx + (tx - cx) * f;
    sy[c] = cy + (ty - cy) * f;
    if (k === 0) {
      sx[breaks[m]!] = sx[c]!;
      sy[breaks[m]!] = sy[c]!;
    }
  }
}

/** Tronçon ajusté ; vrai s'il est posé en arc exact (T125a). */
function fitPiece(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  opts: FitOptions,
  ws: FitWorkspace,
  out: Span[],
): boolean {
  if (isStraightPiece(sx, sy, ox, oy, a, b, opts)) {
    out.push(lineSpan(a, b, t1x, t1y, t2x, t2y));
    return false;
  }
  if (opts.exactShapes && exactShape(sx, sy, ox, oy, a, b, false, opts, ws, out)) return true;
  fitCubicRange(sx, sy, ox, oy, a, b, t1x, t1y, t2x, t2y, opts.tolerance, ws, out);
  return false;
}

/**
 * T125a — Formes exactes. Tronçon [a, b] (ou île sans coin de n = b + 1 points cycliques,
 * `closed`) posé sur le cercle de Kåsa de ses points ORIGINAUX, retenu si ces points en restent
 * à moins de `tolerance`, les points LISSÉS à ≤ `lineTolerance` (comme `isLine` ; ce test écarte
 * l'arc de compromis, bout droit puis courbe, que les seuls points originaux laisseraient
 * passer ; hors des `EXACT_END_WINDOW` points des bouts d'un tronçon, où la moyenne est
 * tronquée), le rayon ≥ `EXACT_MIN_RADIUS` et le balayage ≥ `EXACT_MIN_SWEEP`. Émis en cubiques
 * exactes de ≤ 90° tangentes entre elles (`arcCubics`, F1 sur chacune), poussées dans `out`
 * (nœuds posés par `ex`/`ey`) ; faux (rien poussé) sinon.
 *
 * Arc : les extrémités A, B (sommets partagés ou coins, recalés compris) ne bougent pas ; la
 * première cubique part de A au lieu de sa projection sur le cercle, la dernière arrive en B,
 * poignées inchangées : l'écart s'éteint en (1 − t)³ (décaler la poignée d'autant, en
 * (1 − t)³ + 3t(1 − t)², échouait F1 sur la couronne de l'accueil). Île : 4 cubiques de 90° (kappa = 4(√2−1)/3), nœuds aux quatre extrema, départ
 * à l'angle 0 (point le plus à droite, comme le cercle d'Illustrator ; l'ancre « diagonale » de
 * T08 ne servait qu'à l'ajustement de Schneider), sens de la chaîne gardé.
 */
function exactShape(
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  a: number,
  b: number,
  closed: boolean,
  opts: FitOptions,
  ws: FitWorkspace,
  out: Span[],
): boolean {
  const tol = opts.tolerance;
  const cub = ws.buffer(BARC, 71);
  const c = cub.subarray(64);
  if (!exactCircle(sx, sy, ox, oy, a, b, opts, c)) return false;
  const cx = c[0]!;
  const cy = c[1]!;
  const tau = ws.buffer(BTAU, b + 2);
  c[3] = sx[a]!;
  c[4] = sy[a]!;
  c[5] = sx[b]!;
  c[6] = sy[b]!;
  let t0 = Math.atan2(c[4] - cy, c[3] - cx);
  // Arc : progression des points LISSÉS (de A à B exactement), qui ordonne aussi les originaux.
  let sweep = angularProgress(sx, sy, a, b, cx, cy, t0, tau);
  let px = ox;
  let py = oy;
  if (closed) {
    // Île : sens, puis polyligne déroulée d'un tour (fermeture comprise) depuis le premier point
    // qui suit l'angle 0 : progressions dans [0, 2π[.
    const sign = Math.sign(sweep - tau[0]!);
    sweep = TAU * sign;
    let best = Infinity;
    let i0 = 0;
    for (let i = a; i <= b; i++) {
      const e = (sign * Math.atan2(oy[i]! - cy, ox[i]! - cx) + TAU) % TAU;
      if (e < best) {
        best = e;
        i0 = i;
      }
    }
    [px, py] = unroll(ox, oy, b + 1, i0, ws);
    t0 = 0;
    angularProgress(px, py, 0, b + 1, cx, cy, t0, tau);
    c[3] = c[5] = cx + c[2]!;
    c[4] = c[6] = cy;
  } else if (!(Math.abs(sweep) >= EXACT_MIN_SWEEP && Math.abs(sweep) < TAU)) return false;
  // Ouverture des cubiques : 90° pour un cercle (4 nœuds aux extrema) ; pour un arc, réduite
  // au-delà de `EXACT_ARC_REF` (écart d'une cubique au cercle ∝ r·φ⁶), au plus 8 cubiques.
  const f = closed ? 1 : Math.min(1, Math.max(0.5, (EXACT_ARC_REF / c[2]!) ** (1 / 6)));
  // Île : la polyligne se referme sur son premier point (b + 1).
  const polyEnd = closed ? b + 1 : b;
  const k = arcCubics(px, py, a, b, polyEnd, tau, c, t0, sweep, (TAU / 4) * f, tol, ws, cub);
  for (let j = 0; j < k; j++) {
    const s = lineSpan(a, b, 0, 0, 0, 0);
    setCubic(s, cub.subarray(8 * j));
    s.ex = cub[8 * j + 6]!;
    s.ey = cub[8 * j + 7]!;
    out.push(s);
  }
  return k > 0;
}

/** Remplace deux morceaux adjacents par un seul (ligne ou cubique) s'il tient dans la tolérance. */
function tryMerge(
  p: Span,
  q: Span,
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  opts: FitOptions,
  ws: FitWorkspace,
): Span | null {
  const s = lineSpan(p.i0, q.i1, p.t1x, p.t1y, q.t2x, q.t2y);
  if (isLine(sx, sy, ox, oy, s.i0, s.i1, opts)) return s;
  const t = opts.tolerance;
  if (!(fitSingleCubic(sx, sy, ox, oy, s.i0, s.i1, s.t1x, s.t1y, s.t2x, s.t2y, t, ws) < t)) {
    return null;
  }
  setCubic(s, ws.best);
  return s;
}

/** Erreur (points lissés) d'un morceau cubique tel quel. */
function spanError(s: Span, sx: Float64Array, sy: Float64Array, ws: FitWorkspace): number {
  const n = s.i1 - s.i0 + 1;
  ws.ensure(n);
  chordLengthParameterize(sx, sy, s.i0, s.i1, ws.u);
  const c = ws.c;
  c[0] = sx[s.i0]!;
  c[1] = sy[s.i0]!;
  c[2] = s.c1x;
  c[3] = s.c1y;
  c[4] = s.c2x;
  c[5] = s.c2y;
  c[6] = sx[s.i1]!;
  c[7] = sy[s.i1]!;
  measureError(c, sx, sy, s.i0, s.i1, ws.u, ws);
  return ws.err;
}

/**
 * T08 — Raffinement d'une suite de morceaux SANS changer leur nombre : la
 * fusion gloutonne s'arrête dès qu'un morceau tient dans la tolérance, donc
 * l'erreur finale frôle souvent `tolerance` (un cercle en 4 cubiques sortait à
 * 1 px alors que 0,05 px est atteignable) ; aux extrema d'une forme, l'écart
 * devient un bourrelet d'anti-aliasing qui change la topologie au rendu.
 *
 * Chaque cubique assez longue est d'abord ré-ajustée à erreur MINIMALE (la
 * première acceptable ne suffit plus) ; puis, pour chaque jonction G1 entre
 * deux telles cubiques : rotation de la tangente commune et glissement du point
 * de jonction, retenus s'ils baissent le max des erreurs des deux morceaux.
 * L'objectif se mesure sur les points LISSÉS (le vrai bord, sans l'escalier du
 * treillis) ; toute cubique retenue reste à moins de `tolerance` des points
 * ORIGINAUX (garantie de T04 inchangée). `cyclicEnd` > 0 : île lisse, dont le
 * dernier et le premier morceau partagent l'ancre (indices déroulés,
 * ≤ `cyclicEnd`). Coût borné : morceaux ≥ `REFINE_MIN_POINTS` points dont
 * l'erreur dépasse `REFINE_GOAL × tolerance`, une passe.
 * Renvoie vrai si quelque chose a changé.
 */
function refineSpans(
  spans: Span[],
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  tolerance: number,
  ws: FitWorkspace,
  cyclicEnd: number,
): boolean {
  const k = spans.length;
  if (k === 0) return false;
  const err = new Float64Array(k);
  const goal = REFINE_GOAL * tolerance;
  // Erreur de départ (et meilleure cubique à tangentes inchangées) des morceaux
  // assez longs pour qu'un écart systématique s'y loge.
  for (let i = 0; i < k; i++) {
    const s = spans[i]!;
    if (!s.cubic || s.i1 - s.i0 < REFINE_MIN_POINTS) continue;
    // Estimation en une passe (majorante) : sous l'objectif, rien à gagner.
    err[i] = spanError(s, sx, sy, ws);
    if (err[i]! < goal) continue;
    const e = fitSingleCubicMin(
      sx,
      sy,
      sx,
      sy,
      ox,
      oy,
      s.i0,
      s.i1,
      s.t1x,
      s.t1y,
      s.t2x,
      s.t2y,
      tolerance,
      ws,
    );
    // Cubique d'origine gardée si la version « erreur min » ne tient pas la tolérance.
    if (Number.isFinite(e) && e < err[i]!) {
      setCubic(s, ws.best);
      err[i] = e;
    }
  }
  const ca = new Float64Array(8);
  const fit = (i0: number, i1: number, ax: number, ay: number, bx: number, by: number) =>
    fitSingleCubicMin(sx, sy, sx, sy, ox, oy, i0, i1, ax, ay, bx, by, tolerance, ws);
  let changed = false;
  for (let sweep = 0; sweep < REFINE_SWEEPS; sweep++) {
    let improved = false;
    const junctions = cyclicEnd > 0 && k >= 2 ? k : k - 1;
    for (let j = 0; j < junctions; j++) {
      const A = spans[j]!;
      const ib = (j + 1) % k;
      const B = spans[ib]!;
      if (!A.cubic || !B.cubic || A === B) continue;
      if (A.i1 - A.i0 < REFINE_MIN_POINTS || B.i1 - B.i0 < REFINE_MIN_POINTS) continue;
      const wrap = ib === 0; // jonction par-dessus l'ancre : B est décalé de +n
      const n = wrap ? A.i1 - B.i0 : 0;
      let cur = Math.max(err[j]!, err[ib]!);
      if (cur < goal) continue;
      const tryAt = (jA: number, tx: number, ty: number): boolean => {
        const jB = jA - n;
        if (jA - A.i0 < 3 || B.i1 - jB < 3) return false;
        if (wrap && (jB < 0 || jA > cyclicEnd)) return false;
        const eA = fit(A.i0, jA, A.t1x, A.t1y, tx, ty);
        if (!(eA < cur)) return false;
        ca.set(ws.best);
        const eB = fit(jB, B.i1, -tx, -ty, B.t2x, B.t2y);
        const e = Math.max(eA, eB);
        if (!(e < cur * 0.999)) return false;
        A.i1 = jA;
        A.t2x = tx;
        A.t2y = ty;
        setCubic(A, ca);
        B.i0 = jB;
        B.t1x = -tx;
        B.t1y = -ty;
        setCubic(B, ws.best);
        err[j] = eA;
        err[ib] = eB;
        cur = e;
        return true;
      };
      for (const a of REFINE_ANGLES) {
        const c = Math.cos(a);
        const sn = Math.sin(a);
        if (tryAt(A.i1, A.t2x * c - A.t2y * sn, A.t2x * sn + A.t2y * c)) improved = true;
      }
      const len = Math.min(A.i1 - A.i0, B.i1 - B.i0);
      for (let step = Math.max(1, len >> 2); ; step >>= 1) {
        if (tryAt(A.i1 + step, A.t2x, A.t2y) || tryAt(A.i1 - step, A.t2x, A.t2y)) improved = true;
        if (step <= 1) break;
      }
    }
    if (!improved) break;
    changed = true;
  }
  return changed;
}

/** Fusion gloutonne des morceaux adjacents d'un même tronçon (aucun coin entre eux). */
function mergeSpans(
  spans: Span[],
  sx: Float64Array,
  sy: Float64Array,
  ox: Float64Array,
  oy: Float64Array,
  opts: FitOptions,
  ws: FitWorkspace,
): void {
  for (let sweep = 0; sweep < MERGE_SWEEPS; sweep++) {
    let changed = false;
    for (let i = 0; i + 1 < spans.length;) {
      const m = tryMerge(spans[i]!, spans[i + 1]!, sx, sy, ox, oy, opts, ws);
      if (m) {
        spans.splice(i, 2, m);
        changed = true;
      } else i++;
    }
    if (!changed) break;
  }
}

function toFitted(
  id: number,
  startX: number,
  startY: number,
  spans: Span[],
  sx: Float64Array,
  sy: Float64Array,
): FittedChain {
  const segments: Segment[] = spans.map((s) =>
    s.cubic
      ? {
          kind: 'cubic',
          c1x: s.c1x,
          c1y: s.c1y,
          c2x: s.c2x,
          c2y: s.c2y,
          x: s.ex ?? sx[s.i1]!,
          y: s.ey ?? sy[s.i1]!,
        }
      : { kind: 'line', x: sx[s.i1]!, y: sy[s.i1]! },
  );
  return { chain: id, start: [startX, startY], segments };
}

/** Vrai si le point i (de voisins p et q) est un changement de direction. */
function turns(x: Float64Array, y: Float64Array, p: number, i: number, q: number): boolean {
  const ux = x[i]! - x[p]!;
  const uy = y[i]! - y[p]!;
  const vx = x[q]! - x[i]!;
  const vy = y[q]! - y[i]!;
  return ux * vy - uy * vx !== 0 || ux * vx + uy * vy < 0;
}

/** Pixel art : polyligne aux coordonnées exactes, points colinéaires fusionnés. */
function pixelArtChain(
  id: number,
  x: Float64Array,
  y: Float64Array,
  n: number,
  closed: boolean,
): FittedChain {
  const segments: Segment[] = [];
  if (!closed) {
    for (let i = 1; i < n - 1; i++) {
      if (turns(x, y, i - 1, i, i + 1)) segments.push({ kind: 'line', x: x[i]!, y: y[i]! });
    }
    segments.push({ kind: 'line', x: x[n - 1]!, y: y[n - 1]! });
    return { chain: id, start: [x[0]!, y[0]!], segments };
  }
  // Île : l'ancre glisse sur le premier vrai coin.
  let a = 0;
  while (a < n && !turns(x, y, (a + n - 1) % n, a, (a + 1) % n)) a++;
  if (a === n) a = 0;
  for (let k = 1; k <= n; k++) {
    const i = (a + k) % n;
    if (k === n || turns(x, y, (i + n - 1) % n, i, (i + 1) % n)) {
      segments.push({ kind: 'line', x: x[i]!, y: y[i]! });
    }
  }
  return { chain: id, start: [x[a]!, y[a]!], segments };
}

/**
 * Polyligne échantillonnée d'une chaîne ajustée : le départ, puis
 * `stepsPerSegment` points par segment (t = k / steps, lignes comprises), de
 * sorte que l'échantillonnage d'une chaîne inversée soit exactement l'inverse.
 */
export function sampleFittedChain(fc: FittedChain, stepsPerSegment: number): Float64Array {
  const steps = Math.max(1, Math.floor(stepsPerSegment));
  const out = new Float64Array(2 * (1 + fc.segments.length * steps));
  const c = new Float64Array(8);
  const tmp = new Float64Array(2);
  let px = fc.start[0];
  let py = fc.start[1];
  out[0] = px;
  out[1] = py;
  let o = 2;
  for (const s of fc.segments) {
    c[0] = px;
    c[1] = py;
    if (s.kind === 'cubic') {
      c[2] = s.c1x;
      c[3] = s.c1y;
      c[4] = s.c2x;
      c[5] = s.c2y;
    } else {
      c[2] = px + (s.x - px) / 3;
      c[3] = py + (s.y - py) / 3;
      c[4] = px + ((s.x - px) * 2) / 3;
      c[5] = py + ((s.y - py) * 2) / 3;
    }
    c[6] = s.x;
    c[7] = s.y;
    for (let k = 1; k <= steps; k++) {
      if (k === steps) {
        tmp[0] = s.x;
        tmp[1] = s.y;
      } else bezierPoint(c, 0, k / steps, tmp);
      out[o++] = tmp[0]!;
      out[o++] = tmp[1]!;
    }
    px = s.x;
    py = s.y;
  }
  return out;
}

/** Cubique du segment k d'une chaîne ajustée (une ligne devient une cubique dégénérée). */
function segmentCubic(fc: FittedChain, k: number, c: Float64Array): void {
  const s = fc.segments[k]!;
  const prev = k > 0 ? fc.segments[k - 1]! : null;
  const px = prev ? prev.x : fc.start[0];
  const py = prev ? prev.y : fc.start[1];
  c[0] = px;
  c[1] = py;
  if (s.kind === 'cubic') {
    c[2] = s.c1x;
    c[3] = s.c1y;
    c[4] = s.c2x;
    c[5] = s.c2y;
  } else {
    c[2] = px + (s.x - px) / 3;
    c[3] = py + (s.y - py) / 3;
    c[4] = px + ((s.x - px) * 2) / 3;
    c[5] = py + ((s.y - py) * 2) / 3;
  }
  c[6] = s.x;
  c[7] = s.y;
}

/**
 * Distance max des points ORIGINAUX de la chaîne à la courbe ajustée : arête
 * la plus proche d'un échantillonnage fin, puis quelques pas de Newton sur la
 * vraie cubique (résultat = distance à un point de la courbe, donc exacte ou
 * légèrement majorée, jamais minorée).
 */
export function maxDeviation(chain: BoundaryChain, fc: FittedChain): number {
  const STEPS = 32;
  const poly = sampleFittedChain(fc, STEPS);
  const m = (poly.length >> 1) - 1; // nombre d'arêtes ; l'arête e appartient au segment ⌊e / STEPS⌋
  const pts = chain.points;
  if (m <= 0) {
    let worst = 0;
    for (let i = 0; i < pts.length; i += 2) {
      worst = Math.max(worst, Math.hypot(pts[i]! - fc.start[0], pts[i + 1]! - fc.start[1]));
    }
    return worst;
  }
  // Blocs d'arêtes avec boîte englobante : élagage des blocs trop lointains.
  const B = 16;
  const nb = Math.ceil(m / B);
  const box = new Float64Array(nb * 4);
  for (let b = 0; b < nb; b++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let e = b * B; e <= Math.min(m, (b + 1) * B); e++) {
      x0 = Math.min(x0, poly[2 * e]!);
      x1 = Math.max(x1, poly[2 * e]!);
      y0 = Math.min(y0, poly[2 * e + 1]!);
      y1 = Math.max(y1, poly[2 * e + 1]!);
    }
    box[4 * b] = x0;
    box[4 * b + 1] = y0;
    box[4 * b + 2] = x1;
    box[4 * b + 3] = y1;
  }
  let bestEdge = 0;
  const blockDist = (b: number, px: number, py: number, cur: number): number => {
    let best = cur;
    const e1 = Math.min(m, (b + 1) * B);
    for (let e = b * B; e < e1; e++) {
      const d = pointSegmentDistance(
        px,
        py,
        poly[2 * e]!,
        poly[2 * e + 1]!,
        poly[2 * e + 2]!,
        poly[2 * e + 3]!,
      );
      if (d < best) {
        best = d;
        bestEdge = e;
      }
    }
    return best;
  };
  const c = new Float64Array(8);
  const q = new Float64Array(2);
  let worst = 0;
  let hint = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i]!;
    const py = pts[i + 1]!;
    let best = blockDist(hint, px, py, Infinity);
    for (let b = 0; b < nb; b++) {
      if (b === hint) continue;
      const dx = Math.max(box[4 * b]! - px, 0, px - box[4 * b + 2]!);
      const dy = Math.max(box[4 * b + 1]! - py, 0, py - box[4 * b + 3]!);
      if (dx * dx + dy * dy >= best * best) continue;
      const before = best;
      best = blockDist(b, px, py, best);
      if (best < before) hint = b;
    }
    // Affinage sur la vraie courbe autour de l'arête retenue.
    const k = Math.floor(bestEdge / STEPS);
    segmentCubic(fc, k, c);
    let t = ((bestEdge % STEPS) + 0.5) / STEPS;
    for (let it = 0; it < 4; it++) t = newtonStep(c, 0, px, py, t);
    bezierPoint(c, 0, t, q);
    const dn = Math.hypot(q[0]! - px, q[1]! - py);
    if (dn < best) best = dn;
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * F1 (#18, point 2) — L'autre sens de `maxDeviation` : distance max de la
 * courbe ajustée (échantillonnée à `stepsPerSegment` points par segment) à la
 * polyligne ORIGINALE de la chaîne. Avec `maxDeviation`, la garantie est
 * bilatérale : chaque point près de la courbe, et la courbe près des points.
 */
export function maxDeviationFromCurve(
  chain: BoundaryChain,
  fc: FittedChain,
  stepsPerSegment = 32,
): number {
  const s = sampleFittedChain(fc, stepsPerSegment);
  const p = chain.points;
  let worst = 0;
  let hint = 0;
  for (let i = 0; i < s.length; i += 2) {
    const px = s[i]!;
    const py = s[i + 1]!;
    if (p.length < 4) {
      worst = Math.max(worst, Math.hypot(px - p[0]!, py - p[1]!));
      continue;
    }
    let best = pointSegmentDistance(px, py, p[hint]!, p[hint + 1]!, p[hint + 2]!, p[hint + 3]!);
    for (let j = 0; j + 3 < p.length; j += 2) {
      const ax = p[j]!;
      const ay = p[j + 1]!;
      const bx = p[j + 2]!;
      const by = p[j + 3]!;
      if (Math.max(Math.min(ax, bx) - px, px - Math.max(ax, bx)) >= best) continue;
      if (Math.max(Math.min(ay, by) - py, py - Math.max(ay, by)) >= best) continue;
      const d = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (d < best) {
        best = d;
        hint = j;
      }
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Inverse une chaîne ajustée : le nouveau départ est l'ancienne fin, les segments
 * sont parcourus à rebours, les points de contrôle c1/c2 échangés. La géométrie
 * est STRICTEMENT la même : c'est ce qui permet aux deux faces d'une chaîne de
 * partager le même tracé sans liseré.
 * Implémenté ici (T00) car partagé par T04 (tests) et T05 (assemblage des anneaux).
 */
export function reverseFittedChain(fc: FittedChain): FittedChain {
  const segs = fc.segments;
  if (segs.length === 0) return { chain: fc.chain, start: fc.start, segments: [] };
  const last = segs[segs.length - 1]!;
  const out: Segment[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    const prev = segs[i - 1];
    const px = prev ? prev.x : fc.start[0];
    const py = prev ? prev.y : fc.start[1];
    if (s.kind === 'line') out.push({ kind: 'line', x: px, y: py });
    else out.push({ kind: 'cubic', c1x: s.c2x, c1y: s.c2y, c2x: s.c1x, c2y: s.c1y, x: px, y: py });
  }
  return { chain: fc.chain, start: [last.x, last.y], segments: out };
}
