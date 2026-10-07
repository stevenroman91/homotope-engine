/**
 * T35 — Contrôle « prêt pour la découpe » d'une géométrie de découpe (`geometry.ts`). Pur, sur
 * tableaux typés ; coût borné : tous les tests de paires passent par la grille uniforme
 * (`grid.ts`), jamais un O(n²) sur les segments.
 *
 * Détails trop fins (README « Décisions ») : DISTANCE ENTRE LIGNES DE DÉCOUPE, sans grille
 * raster. Deux segments à moins du diamètre de l'outil l'un de l'autre délimitent une bande de
 * matière plus étroite que l'outil (pièce ou chute) — SAUF s'ils se rejoignent tout près : un
 * coin, une jonction. D'où le critère : distance euclidienne < d ET distance le long des lignes
 * de découpe (géodésique, réseau `network.ts`) > `GEODESIC_FACTOR`·d. Un coin d'angle θ n'est
 * signalé que si sin(θ/2) < 1/3 (θ < 39°) : une pointe que l'outil émousse sur plus de d.
 */
import { MM_PER_PX } from '../export/polyline.ts';
import { bboxOf, polygonArea, type CutGeometry, type CutPolyline } from './geometry.ts';
import { SegmentGrid } from './grid.ts';
import { buildNetwork, mergedPolylines, segLength, type Network } from './network.ts';
import {
  CUT_ISSUE_KINDS,
  DEFAULT_ISLAND_MM2,
  DEFAULT_MAX_NODES,
  DEFAULT_TOOL_MM,
  MAX_ISLAND_MM2,
  MAX_LISTED_PER_KIND,
  MAX_MAX_NODES,
  MAX_TOOL_MM,
  SEVERITY_RANK,
  MIN_ISLAND_MM2,
  MIN_MAX_NODES,
  MIN_TOOL_MM,
  clampParam,
  colorHex,
  emptyTotals,
  fmtCount,
  fmtMm,
  type CutBox,
  type CutColorNodes,
  type CutIssue,
  type CutReport,
} from './report.ts';

export interface CutCheckOptions {
  /** Diamètre de l'outil (mm), 0,2 par défaut. */
  toolMm?: number;
  /** Aire d'un petit îlot (mm²), 1 par défaut. */
  islandMm2?: number;
  /** Nœuds au-delà desquels un contour est signalé, 1 000 par défaut. */
  maxNodes?: number;
  /** Échelle de l'export (mm par px), `MM_PER_PX` (1 px = 1 pt) par défaut. */
  mmPerPx?: number;
  /** Le DXF fusionnera les frontières communes : aucun segment n'y est découpé deux fois. */
  mergeShared?: boolean;
  /**
   * Budget de TRAVAIL (unités : paire testée, case de grille lue, sommet visité ou arête relâchée
   * par la recherche géodésique). Épuisé : l'analyse s'arrête proprement, `truncated: true`.
   */
  workBudget?: number;
  /** Budget de TEMPS (ms) à partir de l'appel ; même arrêt propre. */
  budgetMs?: number;
  /** Échéance absolue (`performance.now()`), partagée par plusieurs analyses (simplification). */
  deadline?: number;
  /**
   * Sortie (jamais sérialisée) : travail consommé, en unités du budget. Sert aux tests, qui
   * vérifient la borne en unités de travail plutôt qu'en secondes (déterministe).
   */
  stats?: { work: number };
}

/** Facteur du critère géodésique des détails fins (voir l'en-tête). */
export const GEODESIC_FACTOR = 3;
/**
 * Budget de travail par défaut : 4,3 s au plus dans Node (mesuré, README « Décisions »). Il compte
 * TOUT le travail des paires (cases lues, paires testées, visites géodésiques), pas seulement les
 * paires : un outil large (10 mm) multiplie les voisins et les recherches.
 */
export const DEFAULT_WORK_BUDGET = 30_000_000;
/** Cas de détails fins retenus au plus avant regroupement. */
const MAX_THIN_CANDIDATES = 400_000;
/** Sommets explorés au plus par une recherche géodésique (au-delà : considérés reliés). */
const MAX_GEODESIC_VISITS = 1024;
/** Contact (sommet partagé, effleurement) : pas une bande de matière. */
const CONTACT_EPS = 1e-6;

/** Budget commun : travail compté, échéance lue toutes les 65 536 unités. */
export class WorkBudget {
  used = 0;
  private nextClock = 65_536;
  private readonly limit: number;
  private readonly deadline: number;
  exhausted = false;
  constructor(limit: number, deadline: number) {
    this.limit = limit;
    this.deadline = deadline;
  }
  /** Dépense `n` unités ; faux (et `exhausted`) une fois le budget ou l'échéance dépassés. */
  spend(n: number): boolean {
    if (this.exhausted) return false;
    this.used += n;
    if (this.used > this.limit) this.exhausted = true;
    else if (this.used >= this.nextClock) {
      this.nextClock = this.used + 65_536;
      if (this.deadline !== Infinity && performance.now() > this.deadline) this.exhausted = true;
    }
    return !this.exhausted;
  }
}

/** Échéance d'options (`deadline` absolue, sinon `budgetMs` à partir de maintenant). */
export function deadlineOf(o: CutCheckOptions): number {
  if (o.deadline !== undefined && Number.isFinite(o.deadline)) return o.deadline;
  if (o.budgetMs !== undefined && o.budgetMs > 0) return performance.now() + o.budgetMs;
  return Infinity;
}

type CutParams = Required<Omit<CutCheckOptions, 'workBudget' | 'budgetMs' | 'deadline' | 'stats'>>;

/** Paramètres effectifs (bornés), partagés par l'analyse et la simplification. */
export function cutParams(o: CutCheckOptions): CutParams {
  return {
    toolMm: clampParam(o.toolMm, DEFAULT_TOOL_MM, MIN_TOOL_MM, MAX_TOOL_MM),
    islandMm2: clampParam(o.islandMm2, DEFAULT_ISLAND_MM2, MIN_ISLAND_MM2, MAX_ISLAND_MM2),
    maxNodes: Math.round(clampParam(o.maxNodes, DEFAULT_MAX_NODES, MIN_MAX_NODES, MAX_MAX_NODES)),
    mmPerPx: clampParam(o.mmPerPx, MM_PER_PX, 1e-4, 1e3),
    mergeShared: o.mergeShared === true,
  };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function boxOf(x0: number, y0: number, x1: number, y1: number): CutBox {
  return { x: r3(x0), y: r3(y0), width: r3(x1 - x0), height: r3(y1 - y0) };
}

/** Boîte cumulée [x0, y0, x1, y1]. */
type Acc = [number, number, number, number];
const newAcc = (): Acc => [Infinity, Infinity, -Infinity, -Infinity];
function grow(a: Acc, x: number, y: number): void {
  if (x < a[0]) a[0] = x;
  if (y < a[1]) a[1] = y;
  if (x > a[2]) a[2] = x;
  if (y > a[3]) a[3] = y;
}

/** Point le plus proche de p sur [a, b] : paramètre 0..1. */
function closestT(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return 0;
  return Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2));
}

/** Contrôle complet. `geom` : polylignes du DXF (non fusionnées). */
export function analyzeCut(geom: CutGeometry, options: CutCheckOptions = {}): CutReport {
  const prm = cutParams(options);
  const d = prm.toolMm / prm.mmPerPx; // diamètre de l'outil, px
  const islandPx2 = prm.islandMm2 / (prm.mmPerPx * prm.mmPerPx);
  const mm = (px: number): number => px * prm.mmPerPx;
  const issues: CutIssue[] = [];
  const colorOfItem = (item: number): string => colorHex(geom.items[item]!.rgb);
  const isStroke = (pl: CutPolyline): boolean => geom.items[pl.item]!.stroke;
  let truncated = false;
  const budget = new WorkBudget(
    options.workBudget !== undefined && options.workBudget >= 0
      ? options.workBudget
      : DEFAULT_WORK_BUDGET,
    deadlineOf(options),
  );

  // --- Contours ouverts (remplissages seulement : un trait du centre-ligne est ouvert) -----
  for (const pl of geom.polylines) {
    if (pl.closed || pl.merged || isStroke(pl)) continue;
    const n = pl.pts.length;
    const gap = Math.hypot(pl.pts[n - 2]! - pl.pts[0]!, pl.pts[n - 1]! - pl.pts[1]!);
    if (gap <= CONTACT_EPS) continue; // revient au départ : seul le `Z` manque
    const [x0, y0, x1, y1] = bboxOf(pl.pts);
    issues.push({
      kind: 'open',
      severity: 'blocking',
      box: boxOf(x0, y0, x1, y1),
      value: r3(mm(gap)),
      color: colorOfItem(pl.item),
      message: `Contour ouvert : la découpeuse le fermera par un segment droit de ${fmtMm(mm(gap))} mm.`,
    });
  }

  const net = buildNetwork(geom);

  // --- Doubles découpes : segments identiques (après nœuds en T) --------------------------
  if (!prm.mergeShared) {
    const pairs = new Map<
      number,
      { a: number; b: number; len: number; opposite: boolean; box: Acc }
    >();
    const np = geom.polylines.length;
    for (let s = 0; s < net.ns; s++) {
      const f = net.dupOf[s]!;
      if (f < 0) continue;
      const a = net.spoly[f]!;
      const b = net.spoly[s]!;
      const key = a * np + b;
      let g = pairs.get(key);
      if (!g) {
        g = { a, b, len: 0, opposite: true, box: newAcc() };
        pairs.set(key, g);
      }
      g.len += segLength(net, s);
      if (net.sa[s] === net.sa[f]) g.opposite = false;
      grow(g.box, net.vx[net.sa[s]!]!, net.vy[net.sa[s]!]!);
      grow(g.box, net.vx[net.sb[s]!]!, net.vy[net.sb[s]!]!);
    }
    for (const g of pairs.values()) {
      const ia = geom.polylines[g.a]!.item;
      const ib = geom.polylines[g.b]!.item;
      const len = fmtMm(mm(g.len));
      const shared = g.opposite && g.a !== g.b;
      issues.push({
        kind: 'overlap',
        severity: shared ? 'info' : 'blocking',
        box: boxOf(...g.box),
        value: r3(mm(g.len)),
        ...(ia === ib ? { color: colorOfItem(ia) } : {}),
        message:
          g.a === g.b
            ? `Tracé parcouru deux fois sur ${len} mm (aller-retour) : double découpe.`
            : shared
              ? `Frontière commune de deux formes voisines (${len} mm), coupée une fois par chacune : « Fusionner les frontières communes » la coupe une seule fois.`
              : `Contours superposés : ${len} mm découpés deux fois.`,
      });
    }
  }

  // --- Croisements et détails fins : paires de segments voisins (grille) ------------------
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
  const strokeSeg = (s: number): boolean => isStroke(geom.polylines[net.spoly[s]!]!);
  const grid = new SegmentGrid(ids, ax, ay, bx, by, d / 2 + CONTACT_EPS);
  const adjacency = vertexAdjacency(net, ids);
  const crossings = new Map<number, { a: number; b: number; n: number; box: Acc }>();
  const thin: ThinCase[] = [];
  const stamp = new Int32Array(net.ns).fill(-1);
  const geodesic = new Geodesic(net, adjacency, budget);
  const near = new Float64Array(5);
  const np = geom.polylines.length;

  outer: for (const i of ids) {
    let stop = false;
    grid.forEachCell(ax[i]!, ay[i]!, bx[i]!, by[i]!, (c) => {
      if (stop) return;
      const k0 = grid.start[c]!;
      const k1 = grid.start[c + 1]!;
      // Cases lues : comptées même quand la paire est écartée (outil large, grille dense).
      if (!budget.spend(k1 - k0)) {
        stop = true;
        return;
      }
      for (let k = k0; k < k1; k++) {
        const j = grid.items[k]!;
        if (j <= i || stamp[j] === i) continue;
        stamp[j] = i;
        // Boîtes séparées d'au moins d : ni croisement ni bande trop fine (rejet sans calcul).
        if (
          Math.max(ax[i]!, bx[i]!) + d <= Math.min(ax[j]!, bx[j]!) ||
          Math.max(ax[j]!, bx[j]!) + d <= Math.min(ax[i]!, bx[i]!) ||
          Math.max(ay[i]!, by[i]!) + d <= Math.min(ay[j]!, by[j]!) ||
          Math.max(ay[j]!, by[j]!) + d <= Math.min(ay[i]!, by[i]!)
        )
          continue;
        const ai = net.sa[i]!;
        const bi = net.sb[i]!;
        const aj = net.sa[j]!;
        const bj = net.sb[j]!;
        if (ai === aj || ai === bj || bi === aj || bi === bj) {
          // Jointifs (même sommet v) : seule une pointe aiguë est un détail fin. Aux points à s
          // de v, l'écart vaut 2s·sin(θ/2) et le chemin 2s : critère atteint si sin(θ/2) < 1/K
          // et si les deux segments dépassent K·d/2.
          // Un « V » dessiné par un même trait du centre-ligne est le dessin, pas un défaut.
          if (strokeSeg(i) && net.spoly[i] === net.spoly[j]) continue;
          const v = ai === aj || ai === bj ? ai : bi;
          const oi = v === ai ? bi : ai;
          const oj = v === aj ? bj : aj;
          const ux = net.vx[oi]! - net.vx[v]!;
          const uy = net.vy[oi]! - net.vy[v]!;
          const wx = net.vx[oj]! - net.vx[v]!;
          const wy = net.vy[oj]! - net.vy[v]!;
          const lu = Math.hypot(ux, uy);
          const lw = Math.hypot(wx, wy);
          const sinHalf = Math.sqrt(Math.max(0, (1 - (ux * wx + uy * wy) / (lu * lw)) / 2));
          if (
            oi === oj ||
            !(sinHalf * GEODESIC_FACTOR < 1) ||
            Math.min(lu, lw) <= (GEODESIC_FACTOR * d) / 2
          )
            continue;
          if (thin.length >= MAX_THIN_CANDIDATES) {
            truncated = true;
            continue;
          }
          // Partie émoussée : jusqu'à l'écart d (ou au bout du plus court segment).
          const reach = Math.min(lu, lw, sinHalf > 0 ? d / (2 * sinHalf) : Infinity);
          const x0 = net.vx[v]!;
          const y0 = net.vy[v]!;
          thin.push({
            w: GEODESIC_FACTOR * d * sinHalf,
            seg: [
              x0,
              y0,
              x0 + (ux / lu) * reach,
              y0 + (uy / lu) * reach,
              x0,
              y0,
              x0 + (wx / lw) * reach,
              y0 + (wy / lw) * reach,
              x0,
              y0,
              x0,
              y0,
            ],
            ia: geom.polylines[net.spoly[i]!]!.item,
            ib: geom.polylines[net.spoly[j]!]!.item,
            stroke: strokeSeg(i) && strokeSeg(j),
          });
          continue;
        }
        // Croisement franc (intérieurs) : orientations strictement opposées des deux côtés.
        const dxi = bx[i]! - ax[i]!;
        const dyi = by[i]! - ay[i]!;
        const dxj = bx[j]! - ax[j]!;
        const dyj = by[j]! - ay[j]!;
        const li = Math.hypot(dxi, dyi);
        const lj = Math.hypot(dxj, dyj);
        const o1 = (dxi * (ay[j]! - ay[i]!) - dyi * (ax[j]! - ax[i]!)) / li;
        const o2 = (dxi * (by[j]! - ay[i]!) - dyi * (bx[j]! - ax[i]!)) / li;
        const o3 = (dxj * (ay[i]! - ay[j]!) - dyj * (ax[i]! - ax[j]!)) / lj;
        const o4 = (dxj * (by[i]! - ay[j]!) - dyj * (bx[i]! - ax[j]!)) / lj;
        const eps = CONTACT_EPS;
        if (
          ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
          ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
        ) {
          // Des traits du centre-ligne qui se croisent : un dessin, pas un défaut.
          if (strokeSeg(i) || strokeSeg(j)) continue;
          const t = o3 / (o3 - o4);
          const px = ax[i]! + t * dxi;
          const py = ay[i]! + t * dyi;
          const pa = net.spoly[i]!;
          const pb = net.spoly[j]!;
          const key = Math.min(pa, pb) * np + Math.max(pa, pb);
          let g = crossings.get(key);
          if (!g) {
            g = { a: Math.min(pa, pb), b: Math.max(pa, pb), n: 0, box: newAcc() };
            crossings.set(key, g);
          }
          g.n++;
          grow(g.box, px, py);
          continue;
        }
        // Distance entre segments sans croisement : la plus courte des 4 extrémités.
        segSegClosest(ax[i]!, ay[i]!, bx[i]!, by[i]!, ax[j]!, ay[j]!, bx[j]!, by[j]!, near);
        const best = near[0]!;
        const p1x = near[1]!;
        const p1y = near[2]!;
        const p2x = near[3]!;
        const p2y = near[4]!;
        if (!(best < d) || best <= CONTACT_EPS) continue;
        if (thin.length >= MAX_THIN_CANDIDATES) {
          truncated = true;
          continue;
        }
        const linked = geodesic.linked(i, p1x, p1y, j, p2x, p2y, GEODESIC_FACTOR * d);
        if (budget.exhausted) {
          stop = true;
          return;
        }
        if (linked) continue;
        // Portions des deux segments à moins de d l'une de l'autre : la boîte du cas.
        const pi = nearPortion(ax[i]!, ay[i]!, bx[i]!, by[i]!, ax[j]!, ay[j]!, bx[j]!, by[j]!, d);
        const pj = nearPortion(ax[j]!, ay[j]!, bx[j]!, by[j]!, ax[i]!, ay[i]!, bx[i]!, by[i]!, d);
        thin.push({
          w: best,
          seg: [...pi, ...pj, p1x, p1y, p2x, p2y],
          ia: geom.polylines[net.spoly[i]!]!.item,
          ib: geom.polylines[net.spoly[j]!]!.item,
          stroke: strokeSeg(i) && strokeSeg(j),
        });
      }
    });
    if (stop) {
      truncated = true;
      break outer;
    }
  }

  for (const g of crossings.values()) {
    const self = g.a === g.b;
    const pts = `${fmtCount(g.n)} point${g.n > 1 ? 's' : ''}`;
    const ia = geom.polylines[g.a]!.item;
    const ib = geom.polylines[g.b]!.item;
    issues.push({
      kind: self ? 'self-intersection' : 'crossing',
      severity: 'blocking',
      box: boxOf(...g.box),
      value: g.n,
      ...(ia === ib ? { color: colorOfItem(ia) } : {}),
      message: self
        ? `Le contour se recoupe lui-même (${pts}) : la découpe détachera des morceaux imprévus.`
        : `Deux contours se croisent (${pts}) : les formes se chevauchent.`,
    });
  }

  // --- Petits îlots (contours fermés de faible aire ; une copie inversée ne compte pas ; l'aire
  // d'un contour qui se recoupe n'a pas de sens) --------------------------------------------
  const selfCrossing = new Set<number>();
  for (const g of crossings.values()) if (g.a === g.b) selfCrossing.add(g.a);
  const seenIslands = new Map<string, CutIssue>();
  geom.polylines.forEach((pl, p) => {
    if (!pl.closed || isStroke(pl) || selfCrossing.has(p)) return;
    const area = Math.abs(polygonArea(pl.pts));
    if (area >= islandPx2) return;
    const [x0, y0, x1, y1] = bboxOf(pl.pts);
    const key = [x0, y0, x1, y1, area].map((v) => Math.round(v * 1e4)).join(' ');
    const copy = seenIslands.get(key);
    if (copy) {
      // Copie (trou de la face voisine) d'une autre couleur : laquelle est l'îlot ? Aucune.
      if (copy.color !== colorOfItem(pl.item)) delete copy.color;
      return;
    }
    const issue: CutIssue = {
      kind: 'island',
      severity: 'check',
      box: boxOf(x0, y0, x1, y1),
      value: r3(area * prm.mmPerPx * prm.mmPerPx),
      color: colorOfItem(pl.item),
      message: `Petit îlot de ${fmtMm(area * prm.mmPerPx * prm.mmPerPx)} mm² (seuil ${fmtMm(prm.islandMm2)} mm²) : il risque de se perdre ou de bouger pendant la découpe.`,
    };
    seenIslands.set(key, issue);
    issues.push(issue);
  });

  // Détails fins : cas voisins (à moins de d) regroupés en un seul.
  for (const g of clusterThin(thin, d)) {
    const w = fmtMm(mm(g.w));
    issues.push({
      kind: 'thin',
      severity: 'check',
      box: boxOf(...g.box),
      value: r3(mm(g.w)),
      ...(g.color !== null ? { color: colorOfItem(g.color) } : {}),
      message: g.stroke
        ? `Trait retracé à ${w} mm d’un autre, sous le diamètre de l’outil (${fmtMm(prm.toolMm)} mm) : risque de double passage.`
        : `Largeur de ${w} mm, sous le diamètre de l’outil (${fmtMm(prm.toolMm)} mm) : ce détail sera brûlé ou arraché.`,
    });
  }

  // --- Nœuds : sommets des polylignes envoyées (fusionnées si le DXF fusionne) -------------
  const sent = prm.mergeShared ? mergedPolylines(geom, net) : geom.polylines;
  const byColor = new Map<string, CutColorNodes>();
  let total = 0;
  let maxPer = 0;
  for (const pl of sent) {
    const n = pl.pts.length / 2;
    total += n;
    if (n > maxPer) maxPer = n;
    const color = colorOfItem(pl.item);
    const c = byColor.get(color) ?? { color, nodes: 0, contours: 0 };
    c.nodes += n;
    c.contours++;
    byColor.set(color, c);
    if (n > prm.maxNodes) {
      const [x0, y0, x1, y1] = bboxOf(pl.pts);
      issues.push({
        kind: 'nodes',
        severity: 'check',
        box: boxOf(x0, y0, x1, y1),
        value: n,
        color,
        message: `Contour de ${fmtCount(n)} nœuds (seuil ${fmtCount(prm.maxNodes)}) : à alléger, la lame le suivra par à-coups.`,
      });
    }
  }

  // --- Totaux, tri, plafond de la liste ------------------------------------------------
  const totals = emptyTotals();
  let blocking = 0;
  let check = 0;
  let info = 0;
  for (const it of issues) {
    totals[it.kind]++;
    if (it.severity === 'blocking') blocking++;
    else if (it.severity === 'check') check++;
    else info++;
  }
  const bySeverity = (a: CutIssue, b: CutIssue): number =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  const rankOf = (it: CutIssue): number =>
    it.kind === 'thin' || it.kind === 'island' ? it.value : -it.value;
  const listed: CutIssue[] = [];
  for (const kind of CUT_ISSUE_KINDS) {
    const group = issues
      .filter((it) => it.kind === kind)
      .sort(
        (a, b) =>
          bySeverity(a, b) || rankOf(a) - rankOf(b) || a.box.y - b.box.y || a.box.x - b.box.x,
      );
    listed.push(...group.slice(0, MAX_LISTED_PER_KIND));
  }
  listed.sort(bySeverity);

  if (options.stats) options.stats.work = budget.used;
  let strokes = 0;
  let closed = 0;
  for (const pl of geom.polylines) {
    if (isStroke(pl)) strokes++;
    if (pl.closed) closed++;
  }
  return {
    toolMm: prm.toolMm,
    islandMm2: prm.islandMm2,
    maxNodes: prm.maxNodes,
    mmPerPx: prm.mmPerPx,
    mergeShared: prm.mergeShared,
    contours: {
      total: geom.polylines.length,
      closed,
      open: geom.polylines.length - closed,
      strokes,
    },
    nodes: { total, maxPerContour: maxPer, byColor: [...byColor.values()] },
    totals,
    blocking,
    check,
    info,
    issues: listed,
    truncated,
  };
}

/** Segments uniques incidents à chaque sommet (CSR). */
function vertexAdjacency(net: Network, ids: Int32Array): { start: Int32Array; segs: Int32Array } {
  const start = new Int32Array(net.nv + 1);
  for (const s of ids) {
    start[net.sa[s]! + 1]!++;
    start[net.sb[s]! + 1]!++;
  }
  for (let v = 0; v < net.nv; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, net.nv);
  const segs = new Int32Array(start[net.nv]!);
  for (const s of ids) {
    segs[fill[net.sa[s]!]!++] = s;
    segs[fill[net.sb[s]!]!++] = s;
  }
  return { start, segs };
}

/** Point de [s, t] le plus proche de q, s'il bat `out[0]` : `out` mis à jour. */
function closerPoint(
  qx: number,
  qy: number,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  fromFirst: boolean,
  out: Float64Array,
): void {
  const t = closestT(qx, qy, sx, sy, tx, ty);
  const kx = sx + t * (tx - sx);
  const ky = sy + t * (ty - sy);
  const dd = Math.hypot(qx - kx, qy - ky);
  if (dd >= out[0]!) return;
  out[0] = dd;
  out[1] = fromFirst ? qx : kx;
  out[2] = fromFirst ? qy : ky;
  out[3] = fromFirst ? kx : qx;
  out[4] = fromFirst ? ky : qy;
}

/**
 * Plus courte distance entre deux segments qui ne se croisent pas (la plus courte des quatre
 * distances extrémité → segment) : `out` = [distance, p1x, p1y (sur le 1er), p2x, p2y].
 */
function segSegClosest(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  out: Float64Array,
): void {
  out[0] = Infinity;
  closerPoint(ax, ay, cx, cy, ex, ey, true, out);
  closerPoint(bx, by, cx, cy, ex, ey, true, out);
  closerPoint(cx, cy, ax, ay, bx, by, false, out);
  closerPoint(ex, ey, ax, ay, bx, by, false, out);
}

/**
 * Distances le long des lignes de découpe. Pour un segment i, DEUX recherches de Dijkstra bornées
 * (depuis chacune de ses extrémités, rayon K·d), faites une fois et réutilisées pour toutes les
 * paires (i, j) : le chemin de p1 (sur i) à p2 (sur j) vaut min |p1 − e| + D_e(f) + |f − p2|, e
 * extrémité de i, f de j — exactement la recherche depuis p1. Tableaux typés réutilisés
 * (distances marquées par un tampon, tas binaire) ; chaque sommet visité et chaque arête relâchée
 * dépensent le budget commun.
 */
class Geodesic {
  private readonly dist: [Float64Array, Float64Array];
  private readonly seen: [Int32Array, Int32Array];
  private readonly done: Int32Array;
  private readonly stampOf: [number, number] = [0, 0];
  private run = 0;
  private prepared = -1;
  /** Une recherche a atteint son plafond de visites : sa zone n'est pas entièrement connue. */
  private capped = false;
  private heapV = new Int32Array(64);
  private heapD = new Float64Array(64);
  private size = 0;

  private readonly net: Network;
  private readonly adj: { start: Int32Array; segs: Int32Array };
  private readonly budget: WorkBudget;

  constructor(net: Network, adj: { start: Int32Array; segs: Int32Array }, budget: WorkBudget) {
    this.net = net;
    this.adj = adj;
    this.budget = budget;
    this.dist = [new Float64Array(net.nv), new Float64Array(net.nv)];
    this.seen = [new Int32Array(net.nv), new Int32Array(net.nv)];
    this.done = new Int32Array(net.nv);
  }

  private push(v: number, dv: number): void {
    if (this.size === this.heapV.length) {
      const nv = new Int32Array(this.size * 2);
      nv.set(this.heapV);
      const nd = new Float64Array(this.size * 2);
      nd.set(this.heapD);
      this.heapV = nv;
      this.heapD = nd;
    }
    let k = this.size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.heapD[p]! <= dv) break;
      this.heapV[k] = this.heapV[p]!;
      this.heapD[k] = this.heapD[p]!;
      k = p;
    }
    this.heapV[k] = v;
    this.heapD[k] = dv;
  }

  private pop(): number {
    const top = this.heapV[0]!;
    const lastV = this.heapV[--this.size]!;
    const lastD = this.heapD[this.size]!;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.heapD[r]! < this.heapD[l]! ? r : l;
      if (this.heapD[c]! >= lastD) break;
      this.heapV[k] = this.heapV[c]!;
      this.heapD[k] = this.heapD[c]!;
      k = c;
    }
    this.heapV[k] = lastV;
    this.heapD[k] = lastD;
    return top;
  }

  private nextRun(): number {
    if (++this.run === 0x7fffffff) {
      for (const a of this.seen) a.fill(0);
      this.done.fill(0);
      this.run = 1;
    }
    return this.run;
  }

  /** Dijkstra borné depuis `src` ; distances dans `dist[slot]`, marquées `seen[slot] = run`. */
  private explore(src: number, slot: 0 | 1, radius: number): void {
    const { net, adj, budget } = this;
    const run = this.nextRun();
    this.stampOf[slot] = run;
    const dist = this.dist[slot];
    const seen = this.seen[slot];
    this.size = 0;
    seen[src] = run;
    dist[src] = 0;
    this.push(src, 0);
    let visits = 0;
    while (this.size > 0) {
      const v = this.pop();
      if (this.done[v] === run) continue;
      this.done[v] = run;
      const k0 = adj.start[v]!;
      const k1 = adj.start[v + 1]!;
      if (++visits > MAX_GEODESIC_VISITS || !budget.spend(1 + k1 - k0)) {
        this.capped = true;
        return;
      }
      const dv = dist[v]!;
      for (let k = k0; k < k1; k++) {
        const s = adj.segs[k]!;
        const w = net.sa[s] === v ? net.sb[s]! : net.sa[s]!;
        if (this.done[w] === run) continue;
        const dw = dv + Math.hypot(net.vx[w]! - net.vx[v]!, net.vy[w]! - net.vy[v]!);
        if (dw > radius || (seen[w] === run && dist[w]! <= dw)) continue;
        seen[w] = run;
        dist[w] = dw;
        this.push(w, dw);
      }
    }
  }

  /**
   * p1 (sur i) et p2 (sur j) sont-ils reliés par un chemin ≤ `radius` ? Une recherche plafonnée
   * (zone trop dense) ou un budget épuisé répondent « reliés » : on ne signale pas (prudence).
   */
  linked(
    i: number,
    p1x: number,
    p1y: number,
    j: number,
    p2x: number,
    p2y: number,
    radius: number,
  ): boolean {
    const { net } = this;
    if (this.prepared !== i) {
      this.prepared = i;
      this.capped = false;
      this.explore(net.sa[i]!, 0, radius);
      if (!this.budget.exhausted) this.explore(net.sb[i]!, 1, radius);
    }
    if (this.capped || this.budget.exhausted) return true;
    for (const f of [net.sa[j]!, net.sb[j]!]) {
      const tail = Math.hypot(net.vx[f]! - p2x, net.vy[f]! - p2y);
      for (const slot of [0, 1] as const) {
        if (this.seen[slot][f] !== this.stampOf[slot]) continue;
        const e = slot === 0 ? net.sa[i]! : net.sb[i]!;
        const head = Math.hypot(net.vx[e]! - p1x, net.vy[e]! - p1y);
        if (head + this.dist[slot][f]! + tail <= radius) return true;
      }
    }
    return false;
  }
}

/**
 * Cas de détail fin : largeur, portions proches des deux segments [x0, y0, x1, y1] ×2 puis la
 * paire de points les plus proches, couleurs des deux contours.
 */
interface ThinCase {
  w: number;
  seg: number[];
  ia: number;
  ib: number;
  /** Deux traits du centre-ligne : un trait retracé tout près, pas une bande de matière. */
  stroke: boolean;
}

/** Portion de [a, b] proche de [c, e] : projections de c et e, extrémités à moins de d. */
function nearPortion(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  d: number,
): [number, number, number, number] {
  let t0 = Math.min(closestT(cx, cy, ax, ay, bx, by), closestT(ex, ey, ax, ay, bx, by));
  let t1 = Math.max(closestT(cx, cy, ax, ay, bx, by), closestT(ex, ey, ax, ay, bx, by));
  const near = (px: number, py: number): boolean => {
    const t = closestT(px, py, cx, cy, ex, ey);
    return Math.hypot(px - cx - t * (ex - cx), py - cy - t * (ey - cy)) < d;
  };
  if (near(ax, ay)) t0 = 0;
  if (near(bx, by)) t1 = 1;
  return [ax + t0 * (bx - ax), ay + t0 * (by - ay), ax + t1 * (bx - ax), ay + t1 * (by - ay)];
}

/**
 * Regroupe les cas voisins : chaque portion est échantillonnée (pas d/2) dans des cellules de
 * côté d ; deux cas qui touchent des cellules voisines (8-voisinage) ne font qu'un.
 */
function clusterThin(
  thin: ThinCase[],
  d: number,
): { w: number; box: Acc; color: number | null; stroke: boolean }[] {
  const parent = Int32Array.from(thin.keys());
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const cells = new Map<string, number>();
  const mark = (k: number, x: number, y: number): void => {
    const key = `${Math.floor(x / d)} ${Math.floor(y / d)}`;
    const rep = cells.get(key);
    if (rep === undefined) cells.set(key, k);
    else parent[find(k)] = find(rep);
  };
  thin.forEach((t, k) => {
    for (let q = 0; q < 8; q += 4) {
      const [x0, y0, x1, y1] = t.seg.slice(q, q + 4) as [number, number, number, number];
      const steps = Math.min(100_000, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (d / 2)));
      for (let n = 0; n <= steps; n++) {
        const f = steps ? n / steps : 0;
        mark(k, x0 + f * (x1 - x0), y0 + f * (y1 - y0));
      }
    }
  });
  for (const [key, rep] of cells) {
    const [x, y] = key.split(' ').map(Number) as [number, number];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const other = cells.get(`${x + dx} ${y + dy}`);
        if (other !== undefined) parent[find(other)] = find(rep);
      }
  }
  const groups = new Map<number, { w: number; box: Acc; color: number | null; stroke: boolean }>();
  thin.forEach((t, k) => {
    const r = find(k);
    let g = groups.get(r);
    if (!g) {
      g = { w: t.w, box: newAcc(), color: t.ia === t.ib ? t.ia : null, stroke: t.stroke };
      groups.set(r, g);
    }
    if (t.w < g.w) g.w = t.w;
    if (!t.stroke) g.stroke = false;
    for (let q = 0; q < 8; q += 2) grow(g.box, t.seg[q]!, t.seg[q + 1]!);
    if (g.color !== null && (t.ia !== g.color || t.ib !== g.color)) g.color = null;
  });
  return [...groups.values()];
}
