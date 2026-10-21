/**
 * T95 — Contour de découpe pour stickers : l'enveloppe EXTÉRIEURE du dessin, avec une marge,
 * qui enjambe les creux étroits et ignore les trous intérieurs. Pur (tableaux typés, aucun DOM),
 * n'importe rien hors de `src/engine`.
 *
 * Étapes, sur une grille rembourrée de `bouchage + marge` (un dessin qui touche le bord garde sa
 * marge) :
 *  1. masque « encre » relu dans la scène du SVG (`raster.ts`, fond = règle de l'export) ;
 *  2. fermeture par un disque de rayon `closeMm` (transformée de distance, `morph.ts`) ;
 *  3. trous bouchés (`fillHoles`) ; îlots sous `MIN_STICKER_MM2` ignorés et COMPTÉS ;
 *  4. marge : dilatation de `marginMm`, trous rebouchés ;
 *  5. une composante = un sticker ; anneaux EXTÉRIEURS par `buildBoundaryGraph` (carte de
 *     labels : une région par composante, fond transparent), lissés par `fitChains`, assemblés
 *     par `assembleRing` (l'assembleur d'anneaux du moteur), ramenés en px de l'image.
 *
 * Mode « un seul » : le plus petit bouchage (pas de 0,5 mm, au moins celui demandé, au plus
 * `MAX_CLOSE_MM`) qui ramène à UNE composante ; borne atteinte : mode REFUSÉ (`refused` = nombre
 * de morceaux restants à 30 mm), le contour rendu est celui des stickers séparés. Jamais une
 * enveloppe convexe. Le mm → px passe par `dxfMmPerPx` (largeur réelle du DXF).
 */
import { DEFAULT_ISLAND_MM2 } from '../cutcheck/report.ts';
import { dxfMmPerPx } from '../export/dxf.ts';
import { type VectorScene, sceneFromSvg, sceneImageWidth } from '../export/scene.ts';
import { fitChains } from '../fit/index.ts';
import { assembleRing, indexFitted, type SubPath } from '../svg/rings.ts';
import { buildBoundaryGraph, ringSignedArea } from '../topology/index.ts';
import type { FitOptions, LabelMap, Region } from '../types.ts';
import { TRANSPARENT } from '../types.ts';
import { closeFromDistance, dilateMask, edt2, fillHoles, labelComponents } from './morph.ts';
import { inkMask, type MaskGrid } from './raster.ts';

export {
  closeFromDistance,
  closeMask,
  countComponents,
  dilateMask,
  edt2,
  erodeMask,
  fillHoles,
} from './morph.ts';
export { labelComponents, type Components } from './morph.ts';
export { inkMask, paperColor, visibleItems, type MaskGrid } from './raster.ts';

/** Bouchage maximal du mode « un seul » (mm) : au-delà, le mode est refusé. */
export const MAX_CLOSE_MM = 30;
/**
 * Aire (mm²) sous laquelle un morceau du dessin n'est pas un sticker : ignoré et compté. Même
 * grandeur que le « petit îlot » du contrôle de découpe (`island_mm2`, T35).
 */
export const MIN_STICKER_MM2 = DEFAULT_ISLAND_MM2;
/** Bornes des réglages (atelier ET API v1 / MCP) : marge 0,5–10 mm, bouchage 0–20 mm. */
export const STICKER_MARGIN_MIN_MM = 0.5;
export const STICKER_MARGIN_MAX_MM = 10;
export const STICKER_CLOSE_MIN_MM = 0;
export const STICKER_CLOSE_MAX_MM = 20;
/** Pas des curseurs, et de la recherche du mode « un seul » (mm). */
export const STICKER_STEP_MM = 0.5;

export type StickerMode = 'single' | 'separate';
export const STICKER_MODES: readonly StickerMode[] = ['single', 'separate'];

export type StickerPresetName = 'fin' | 'standard' | 'large';
/**
 * Préréglages « fin / standard / large » (marge, bouchage en mm). Défauts standard 2 mm / 3 mm,
 * à valider en production par Steven avant d'être figés (ticket T95, décision a).
 */
export const STICKER_PRESETS: Readonly<
  Record<StickerPresetName, { marginMm: number; closeMm: number }>
> = {
  fin: { marginMm: 1, closeMm: 1.5 },
  standard: { marginMm: 2, closeMm: 3 },
  large: { marginMm: 4, closeMm: 6 },
};
export const STICKER_PRESET_NAMES: readonly StickerPresetName[] = ['fin', 'standard', 'large'];
export const DEFAULT_STICKER_PRESET: StickerPresetName = 'standard';

/**
 * Pixels de la grille de calcul au plus, rembourrage compris (≈ 0,2 mm par pixel pour un dessin de
 * 200 mm : sous la précision d'une lame de découpe, et le lissage efface l'escalier).
 */
export const STICKER_GRID_MAX_PIXELS = 1 << 20;
/**
 * Grille de la RECHERCHE du mode « un seul » (dichotomie sur le bouchage) : plus grossière ; le
 * bouchage trouvé est ensuite vérifié, et au besoin relevé, sur la grille complète.
 */
export const STICKER_SEARCH_MAX_PIXELS = 1 << 18;
/** Suréchantillonnage maximal d'une petite image. */
const MAX_UPSCALE = 2;

export interface StickerOptions {
  /** Marge autour du dessin (mm). */
  marginMm: number;
  /** Rayon de bouchage des creux (mm) ; en mode « un seul », le minimum essayé. */
  closeMm: number;
  mode: StickerMode;
  /** Largeur réelle du dessin (mm) ; absente : 1 px = 1 pt (`dxfMmPerPx`). */
  widthMm?: number;
  /** Tolérance du lissage (px de l'image d'origine), celle du préréglage ; défaut 1. */
  tolerance?: number;
}

export interface StickerContour {
  /** Anneaux extérieurs, fermés, en px de l'image d'origine (un par sticker). */
  rings: SubPath[];
  /** Nombre de stickers (anneaux). */
  count: number;
  /** Morceaux ignorés, sous `MIN_STICKER_MM2`. */
  ignored: number;
  /** Bouchage appliqué (mm) : en mode « un seul », celui trouvé. */
  closeMm: number;
  marginMm: number;
  /** Mode appliqué : `separate` si « un seul » est refusé. */
  mode: StickerMode;
  /** Mode « un seul » refusé : morceaux restants au bouchage maximal (`MAX_CLOSE_MM`). */
  refused?: number;
}

interface Evaluated {
  mask: Uint8Array;
  labels: Int32Array;
  count: number;
  ignored: number;
}

/** Réglage borné (marge, bouchage) ; une valeur non finie prend `fallback`. */
function clampMm(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * Contour de découpe sticker d'une scène (SVG d'Homotope relu). Coût : quelques transformées de
 * distance sur une grille d'au plus `STICKER_GRID_MAX_SIDE` px de côté.
 */
export function stickerContour(scene: VectorScene, options: StickerOptions): StickerContour {
  const std = STICKER_PRESETS.standard;
  const marginMm = clampMm(
    options.marginMm,
    STICKER_MARGIN_MIN_MM,
    STICKER_MARGIN_MAX_MM,
    std.marginMm,
  );
  const closeMm = clampMm(options.closeMm, STICKER_CLOSE_MIN_MM, STICKER_CLOSE_MAX_MM, std.closeMm);
  const single = options.mode === 'single';
  // La largeur réelle est celle de l'IMAGE, même si la page a été agrandie par un contour (T95).
  const mmPerPx = dxfMmPerPx(sceneImageWidth(scene), options.widthMm);
  // Rembourrage (px d'image) : le plus grand bouchage essayé, plus la marge, plus 2 px.
  const padImg = ((single ? MAX_CLOSE_MM : closeMm) + marginMm) / mmPerPx + 2;
  const full = new Evaluator(scene, mmPerPx, marginMm, padImg, STICKER_GRID_MAX_PIXELS);

  let applied = closeMm;
  let mode: StickerMode = single ? 'single' : 'separate';
  let refused: number | undefined;
  let best = full.evaluate(closeMm);
  if (single && best.count > 1) {
    const coarse = new Evaluator(scene, mmPerPx, marginMm, padImg, STICKER_SEARCH_MAX_PIXELS);
    const atMax = coarse.evaluate(MAX_CLOSE_MM);
    if (atMax.count > 1) {
      refused = atMax.count;
      mode = 'separate';
    } else {
      // Plus petit bouchage (pas de 0,5 mm) qui ramène à une composante : dichotomie sur la
      // grille grossière, puis vérification (et au besoin un pas de plus) sur la grille complète.
      const steps = Math.ceil((MAX_CLOSE_MM - closeMm) / STICKER_STEP_MM);
      const value = (k: number): number => Math.min(MAX_CLOSE_MM, closeMm + k * STICKER_STEP_MM);
      let lo = 0;
      let hi = steps;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (coarse.evaluate(value(mid)).count <= 1) hi = mid;
        else lo = mid;
      }
      let k = hi;
      let e = full.evaluate(value(k));
      while (e.count > 1 && k < steps) e = full.evaluate(value(++k));
      if (e.count > 1) {
        refused = e.count;
        mode = 'separate';
      } else {
        best = e;
        applied = value(k);
      }
    }
  }

  const rings = contourRings(best, full.grid, options.tolerance ?? 1);
  const out: StickerContour = {
    rings,
    count: rings.length,
    ignored: best.ignored,
    closeMm: applied,
    marginMm,
    mode,
  };
  if (refused !== undefined) out.refused = refused;
  return out;
}

/**
 * Masque d'encre sur une grille d'au plus `maxPixels` pixels, et sa transformée de distance
 * (calculée une fois : la dilatation du bouchage, quel que soit le rayon, n'est qu'un seuil).
 */
class Evaluator {
  readonly grid: MaskGrid;
  private readonly gridMm: number;
  private readonly minArea: number;
  private readonly marginPx: number;
  private readonly dInk: Int32Array;

  constructor(
    scene: VectorScene,
    mmPerPx: number,
    marginMm: number,
    padImg: number,
    maxPixels: number,
  ) {
    const w = scene.width;
    const h = scene.height;
    const scale = Math.min(
      MAX_UPSCALE,
      Math.sqrt(maxPixels / ((w + 2 * padImg) * (h + 2 * padImg))),
    );
    const pad = Math.ceil(padImg * scale);
    this.grid = {
      width: Math.max(1, Math.ceil(w * scale)) + 2 * pad,
      height: Math.max(1, Math.ceil(h * scale)) + 2 * pad,
      scale,
      pad,
    };
    this.gridMm = mmPerPx / scale; // mm par px de la grille
    this.minArea = MIN_STICKER_MM2 / (this.gridMm * this.gridMm);
    this.marginPx = marginMm / this.gridMm;
    this.dInk = edt2(inkMask(scene, this.grid), this.grid.width, this.grid.height, 1);
  }

  /** Bouchage `rMm`, trous bouchés, îlots retirés, marge : composantes du contour. */
  evaluate(rMm: number): Evaluated {
    const { width: W, height: H } = this.grid;
    const r = rMm / this.gridMm;
    // Fermeture (dilatation puis érosion) : la fonction de `closeMask`, prouvée égale à la
    // fermeture naïve, depuis la distance à l'encre calculée une fois.
    const closed = closeFromDistance(this.dInk, W, H, r);
    fillHoles(closed, W, H);
    const first = labelComponents(closed, W, H);
    let ignored = 0;
    const small = first.areas.map((a) => {
      const s = a < this.minArea;
      if (s) ignored++;
      return s;
    });
    if (ignored > 0)
      for (let i = 0; i < closed.length; i++) {
        const l = first.labels[i]!;
        if (l >= 0 && small[l]) closed[i] = 0;
      }
    const grown = dilateMask(closed, W, H, this.marginPx);
    fillHoles(grown, W, H);
    const comps = labelComponents(grown, W, H);
    return { mask: grown, labels: comps.labels, count: comps.areas.length, ignored };
  }
}

/** Contour sticker du SVG d'Homotope (`sceneFromSvg` : le contour éventuel y est ignoré). */
export function stickerContourFromSvg(svg: string, options: StickerOptions): StickerContour {
  return stickerContour(sceneFromSvg(svg), options);
}

/** Anneaux extérieurs des composantes, lissés, en px de l'image d'origine. */
function contourRings(e: Evaluated, grid: MaskGrid, tolerance: number): SubPath[] {
  if (e.count === 0) return [];
  const { width: W, height: H, scale, pad } = grid;
  const regions: Region[] = [];
  for (let id = 0; id < e.count; id++)
    regions.push({ id, colorId: 0, area: 0, bbox: [W, H, -1, -1] });
  const labels = new Int32Array(W * H);
  const transparent = TRANSPARENT;
  for (let i = 0; i < labels.length; i++) {
    const l = e.labels[i]!;
    labels[i] = l < 0 ? transparent : l;
    if (l >= 0) {
      const r = regions[l]!;
      const x = i % W;
      const y = (i - x) / W;
      r.area++;
      if (x < r.bbox[0]) r.bbox[0] = x;
      if (y < r.bbox[1]) r.bbox[1] = y;
      if (x > r.bbox[2]) r.bbox[2] = x;
      if (y > r.bbox[3]) r.bbox[3] = y;
    }
  }
  const map: LabelMap = { width: W, height: H, labels, regions };
  const graph = buildBoundaryGraph(map);
  // Tolérance en px de grille, jamais sous un pixel (l'escalier d'un contour en fait ~0,5).
  const tol = Math.max(1, tolerance * scale);
  const fit: FitOptions = {
    tolerance: tol,
    cornerAngle: 75,
    smoothing: 0.5,
    lineTolerance: tol / 2,
    smoothingReach: 8,
    robustLines: false,
    exactShapes: false,
    pixelArt: false,
  };
  const fitted = fitChains(graph.chains, fit);
  const byChain = indexFitted(fitted, graph.chains.length);
  const rings: SubPath[] = [];
  for (const face of graph.faces) {
    const outer = face.rings[0];
    if (face.depth !== 0 || !outer || ringSignedArea(graph, outer) <= 0) continue;
    rings.push(toImage(assembleRing(graph, byChain, outer), scale, pad));
  }
  return rings;
}

/** Sous-tracé de la grille → px de l'image d'origine (`x = (X − pad) / scale`). */
function toImage(sp: SubPath, scale: number, pad: number): SubPath {
  const f = (v: number): number => (v - pad) / scale;
  return {
    start: [f(sp.start[0]), f(sp.start[1])],
    segments: sp.segments.map((s) =>
      s.kind === 'line'
        ? { kind: 'line', x: f(s.x), y: f(s.y) }
        : {
            kind: 'cubic',
            c1x: f(s.c1x),
            c1y: f(s.c1y),
            c2x: f(s.c2x),
            c2y: f(s.c2y),
            x: f(s.x),
            y: f(s.y),
          },
    ),
  };
}
