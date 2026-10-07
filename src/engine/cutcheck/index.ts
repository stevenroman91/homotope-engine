/**
 * T35 — Contrôle « prêt pour la découpe » : analyse PURE de la scène d'export (celle du DXF de
 * T32, relue dans le SVG par `sceneFromSvg` : aucun second assembleur), et simplification
 * proposée. Tourne dans un worker de l'atelier et dans le thread de conversion du serveur.
 */
import { DXF_DEFAULT_TOLERANCE, dxfTolerance, writeDxfPolylines } from '../export/dxf.ts';
import { cutItems } from '../export/polyline.ts';
import { sceneFromSvg, type VectorScene } from '../export/scene.ts';
import { analyzeCut, cutParams, deadlineOf, type CutCheckOptions } from './analyze.ts';
import { cutGeometry, type CutGeometry } from './geometry.ts';
import type { CutBox, CutReport, CutSimplifySummary } from './report.ts';
import { simplifyGeometry } from './simplify.ts';

export {
  analyzeCut,
  cutParams,
  DEFAULT_WORK_BUDGET,
  GEODESIC_FACTOR,
  type CutCheckOptions,
} from './analyze.ts';
export { cutGeometry, type CutGeometry, type CutPolyline } from './geometry.ts';
export { buildNetwork, mergedPolylines } from './network.ts';
export * from './report.ts';
export { simplifyGeometry } from './simplify.ts';

export interface CutSceneOptions extends CutCheckOptions {
  /** Tolérance d'aplatissement des courbes (px), celle du DXF : 0,1 par défaut. */
  tolerance?: number;
  /** Le DXF gardera le rectangle de fond (cadre). */
  includeBackground?: boolean;
}

function geometryOf(scene: VectorScene, o: CutSceneOptions): CutGeometry {
  return cutGeometry(scene, {
    tolerance: dxfTolerance(o.tolerance ?? DXF_DEFAULT_TOLERANCE),
    includeBackground: o.includeBackground === true,
  });
}

/** Rapport d'une scène. */
export function checkScene(scene: VectorScene, options: CutSceneOptions = {}): CutReport {
  return analyzeCut(geometryOf(scene, options), options);
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
  const options: CutSimplifyOptions = { ...opts, deadline: deadlineOf(opts) };
  const prm = cutParams(options);
  const geom = geometryOf(scene, options);
  const before = analyzeCut(geom, options);
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
