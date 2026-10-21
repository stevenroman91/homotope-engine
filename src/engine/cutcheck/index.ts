/**
 * T35 — Contrôle « prêt pour la découpe » : analyse PURE de la scène d'export (celle du DXF de
 * T32, relue dans le SVG par `sceneFromSvg` : aucun second assembleur), et simplification
 * proposée. Tourne dans un worker de l'atelier et dans le thread de conversion du serveur.
 */
import {
  DXF_DEFAULT_TOLERANCE,
  dxfMmPerPx,
  dxfTolerance,
  writeDxfPolylines,
} from '../export/dxf.ts';
import { cutItems } from '../export/polyline.ts';
import { sceneFromSvg, sceneImageWidth, type VectorScene } from '../export/scene.ts';
import { analyzeCut, cutParams, deadlineOf, type CutCheckOptions } from './analyze.ts';
import { fixGeometry } from './correct.ts';
import { cutGeometry, type CutGeometry } from './geometry.ts';
import type { CutBox, CutFix, CutIssue, CutReport, CutSimplifySummary } from './report.ts';
import { simplifyGeometry } from './simplify.ts';

export {
  analyzeCut,
  cutParams,
  DEFAULT_WORK_BUDGET,
  GEODESIC_FACTOR,
  isWedge,
  THIN_MARGIN,
  TIP_WEDGE,
  typicalWidth,
  type CutCheckOptions,
} from './analyze.ts';
export { fixGeometry, unfold, WIDEN_TARGET } from './correct.ts';
export { cutGeometry, type CutGeometry, type CutPolyline } from './geometry.ts';
export { buildNetwork, mergedPolylines } from './network.ts';
export * from './report.ts';
export { simplifyGeometry } from './simplify.ts';

export interface CutSceneOptions extends CutCheckOptions {
  /** Tolérance d'aplatissement des courbes (px), celle du DXF : 0,1 par défaut. */
  tolerance?: number;
  /** Le DXF gardera le rectangle de fond (cadre). */
  includeBackground?: boolean;
  /**
   * T63 — Largeur RÉELLE du dessin (mm), celle du DXF : l'échelle en découle
   * (`mmPerPx` = `widthMm` / largeur du SVG) et prend le pas sur `mmPerPx`.
   */
  widthMm?: number;
}

/** Corrections demandées au plus (au-delà : ignorées). */
export const MAX_FIXES = 500;

/** Options d'une scène : `widthMm` résolu en `mmPerPx`, exactement comme le DXF. */
function scaled<T extends CutSceneOptions>(scene: VectorScene, o: T): T {
  const w = o.widthMm;
  if (w === undefined || !Number.isFinite(w) || !(scene.width > 0)) return o;
  return { ...o, mmPerPx: dxfMmPerPx(sceneImageWidth(scene), w) };
}

function geometryOf(scene: VectorScene, o: CutSceneOptions): CutGeometry {
  return cutGeometry(scene, {
    tolerance: dxfTolerance(o.tolerance ?? DXF_DEFAULT_TOLERANCE),
    includeBackground: o.includeBackground === true,
  });
}

/** Rapport d'une scène. */
export function checkScene(scene: VectorScene, options: CutSceneOptions = {}): CutReport {
  const o = scaled(scene, options);
  return analyzeCut(geometryOf(scene, o), o);
}

/** Rapport d'un SVG d'Homotope (lève `SceneError` hors du sous-ensemble). */
export function checkSvg(svg: string, options: CutSceneOptions = {}): CutReport {
  return checkScene(sceneFromSvg(svg), options);
}

export interface CutSimplifyOptions extends CutSceneOptions {
  /**
   * Tolérance de lissage (px d'origine) de la réduction des nœuds : celle de l'atelier
   * (`fit.tolerance`, ou `centerline.tolerance` pour un tracé centre-ligne).
   */
  smoothing: number;
  /** T63 — Corrections demandées point par point, appliquées avant la simplification. */
  fixes?: readonly CutFix[];
}

export interface CutCorrectOptions extends CutSceneOptions {
  fixes: readonly CutFix[];
}

export interface CutCorrection {
  /** Rapport de la géométrie corrigée (la liste « recalculée »). */
  report: CutReport;
  /** Par correction demandée : faite et vérifiée, ou impossible (le point reste tel quel). */
  applied: boolean[];
}

const near = (a: CutBox, b: CutBox, m: number): boolean =>
  a.x <= b.x + b.width + m &&
  b.x <= a.x + a.width + m &&
  a.y <= b.y + b.height + m &&
  b.y <= a.y + a.height + m;

/**
 * Corrections vérifiées : appliquées, analysées ; une correction dont le problème reste à sa
 * place, ou qui crée un croisement (ou une auto-intersection) absent avant à cet endroit, est
 * retirée (deux tours au plus). Rend la géométrie corrigée et l'issue de chaque correction.
 */
function correctedGeometry(
  scene: VectorScene,
  o: CutSceneOptions,
  fixes: readonly CutFix[],
  before: CutReport,
): { geometry: CutGeometry; report: CutReport; applied: boolean[] } {
  const prm = cutParams(o);
  const geom = geometryOf(scene, o);
  const d = prm.toolMm / prm.mmPerPx;
  const list = fixes.slice(0, MAX_FIXES);
  const active = list.map(() => true);
  const crossing = (it: CutIssue): boolean =>
    it.kind === 'crossing' || it.kind === 'self-intersection';
  for (let round = 0; ; round++) {
    const chosen = list.filter((_, k) => active[k]);
    const fixed = fixGeometry(geom, chosen, { d, islandPx2: prm.islandMm2 / prm.mmPerPx ** 2 });
    const report = analyzeCut(fixed.geometry, o);
    const applied = list.map(() => false);
    let failed = false;
    let c = 0;
    list.forEach((f, k) => {
      if (!active[k]) return;
      const ok = fixed.applied[c++]!;
      const stays = report.issues.some(
        (it) =>
          it.kind === f.kind &&
          it.severity !== 'info' &&
          (f.kind === 'island' ? near(it.box, f.box, 1e-3) : near(it.box, f.box, d)),
      );
      const created = report.issues.some(
        (it) =>
          crossing(it) &&
          near(it.box, f.box, d) &&
          !before.issues.some((b) => b.kind === it.kind && near(b.box, it.box, d)),
      );
      // Analyse tronquée : rien n'est vérifiable, la correction est rendue impossible.
      const good = ok && !stays && !created && !report.truncated;
      applied[k] = good;
      if (!good) {
        active[k] = false;
        if (ok) failed = true;
      }
    });
    if (!failed || round >= 1) {
      if (failed) {
        const kept = list.filter((_, k) => active[k]);
        const g = fixGeometry(geom, kept, { d, islandPx2: prm.islandMm2 / prm.mmPerPx ** 2 });
        return { geometry: g.geometry, report: analyzeCut(g.geometry, o), applied };
      }
      return { geometry: fixed.geometry, report, applied };
    }
  }
}

/**
 * T63 — « Corriger » : les corrections demandées (élargir un filet, retirer un aller-retour ou un
 * îlot), vérifiées, puis la nouvelle analyse. Aucun DXF n'est écrit ici : il l'est par la
 * simplification (`simplifyScene`, avec `fixes`), comptée comme un export de fabrication.
 */
export function correctScene(scene: VectorScene, options: CutCorrectOptions): CutCorrection {
  const o = scaled(scene, { ...options, deadline: deadlineOf(options) });
  const before = analyzeCut(geometryOf(scene, o), o);
  const { report, applied } = correctedGeometry(scene, o, options.fixes, before);
  return { report, applied };
}

export function correctSvg(svg: string, options: CutCorrectOptions): CutCorrection {
  return correctScene(sceneFromSvg(svg), options);
}

export interface CutSimplification {
  before: CutReport;
  after: CutReport;
  summary: CutSimplifySummary;
  /** DXF R12 de la géométrie simplifiée (frontières fusionnées). */
  dxf: string;
}

/**
 * « Simplifier pour la découpe » : petits îlots retirés, nœuds réduits à la tolérance de
 * lissage, frontières communes fusionnées ; puis nouvelle analyse. Le SVG n'est pas touché :
 * le résultat est un DXF à part.
 */
export function simplifyScene(scene: VectorScene, opts: CutSimplifyOptions): CutSimplification {
  // Une seule échéance pour toutes les analyses (avant, garde, après).
  const options: CutSimplifyOptions = scaled(scene, { ...opts, deadline: deadlineOf(opts) });
  const prm = cutParams(options);
  const before = analyzeCut(geometryOf(scene, options), options);
  // T63 — Corrections demandées, vérifiées, appliquées d'abord.
  const geom = options.fixes?.length
    ? correctedGeometry(scene, options, options.fixes, before).geometry
    : geometryOf(scene, options);
  const smoothing = Number.isFinite(options.smoothing)
    ? Math.min(10, Math.max(0, options.smoothing))
    : 0;
  // Garde : un problème de géométrie (croisement, détail fin) qui n'existait pas avant, à cet
  // endroit, fait revenir les chaînes simplifiées qui le touchent à leurs sommets d'origine.
  const d = prm.toolMm / prm.mmPerPx;
  const watched = new Set(['crossing', 'self-intersection', 'thin']);
  const old = before.issues.filter((it) => watched.has(it.kind));
  const touches = (a: CutBox, b: CutBox): boolean =>
    a.x <= b.x + b.width + d &&
    b.x <= a.x + a.width + d &&
    a.y <= b.y + b.height + d &&
    b.y <= a.y + a.height + d;
  const out = simplifyGeometry(geom, {
    islandPx2: prm.islandMm2 / (prm.mmPerPx * prm.mmPerPx),
    tolerance: smoothing,
    guardMargin: d,
    guard: (g) => {
      const r = analyzeCut(g, { ...options, mergeShared: true });
      // Analyse tronquée : rien n'est garanti, toutes les chaînes reprennent leurs sommets.
      if (r.truncated) return [[-Infinity, -Infinity, Infinity, Infinity]];
      return r.issues
        .filter(
          (it) =>
            watched.has(it.kind) && !old.some((o) => o.kind === it.kind && touches(o.box, it.box)),
        )
        .map((it) => [it.box.x, it.box.y, it.box.x + it.box.width, it.box.y + it.box.height]);
    },
  });
  // Dernière géométrie (la garde a pu la reconstruire après sa dernière analyse).
  const after = analyzeCut(out.geometry, { ...options, mergeShared: true });
  const dxf = writeDxfPolylines(
    scene.width,
    scene.height,
    cutItems(scene, options.includeBackground === true).map((it) => it.rgb),
    out.geometry.polylines.map((pl) => ({
      rgb: out.geometry.items[pl.item]!.rgb,
      pts: pl.pts,
      closed: pl.closed,
    })),
    undefined,
    prm.mmPerPx,
  );
  const sum = (r: CutReport) => ({
    issues: r.blocking + r.check,
    blocking: r.blocking,
    nodes: r.nodes.total,
  });
  return {
    before,
    after,
    summary: {
      before: sum(before),
      after: sum(after),
      removedIslands: out.removedIslands,
      mergedSegments: out.mergedSegments,
    },
    dxf,
  };
}

export function simplifySvg(svg: string, options: CutSimplifyOptions): CutSimplification {
  return simplifyScene(sceneFromSvg(svg), options);
}
