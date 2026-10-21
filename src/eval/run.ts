/**
 * T06 — Évaluation d'un cas : vectoriser, rastériser, mesurer, comparer aux
 * seuils. Node uniquement ; aucune entrée/sortie fichier ici (voir
 * `scripts/eval.ts`), pour rester testable.
 */
import { quantize } from '../engine/color/quantize.ts';
import { preprocess } from '../engine/preprocess/index.ts';
import { workingOptions } from '../engine/pipeline.ts';
import { presetOptions } from '../engine/presets.ts';
import { segment } from '../engine/segment/index.ts';
import type {
  LabelMap,
  Palette,
  PresetName,
  RasterImage,
  Stage,
  SvgStats,
  VectorizeOptions,
  VectorizeResult,
} from '../engine/types.ts';
import {
  compareTopology,
  detectSeams,
  diffImage,
  downsampleColors,
  labelColors,
  paletteOklab,
  pixelError,
  rasterizeSvg,
  shapeDeviations,
  ssim,
  type ExpectedShapes,
  type ShapeReport,
  type TopologyDiff,
} from './metrics.ts';

/** Fonction de vectorisation évaluée (`vectorize`, ou une variante injectée par un test). */
export type VectorizeFn = (image: RasterImage, options: VectorizeOptions) => VectorizeResult;

/** Surcharges partielles (récursives) des options d'un préréglage. */
export type OptionOverrides = {
  [K in keyof VectorizeOptions]?: Partial<VectorizeOptions[K]>;
};

export interface EvalCase {
  name: string;
  /** Fichier dans `test/fixtures/`. */
  fixture: string;
  preset: PresetName;
  options?: OptionOverrides;
  /**
   * (T125b) Géométrie dessinée par le générateur de la fixture (cercles, droites) : mesurée
   * sur le SVG émis (`shapeDeviations`). Absente : aucune mesure de forme.
   */
  expected?: ExpectedShapes;
}

export interface Thresholds {
  ssimMin: number;
  /** Erreur RGB moyenne maximale (distance euclidienne 0..441). */
  meanErrorMax: number;
  seamsMax: number;
  /** Composantes et trous par couleur identiques à la source quantifiée. */
  holesExact: boolean;
  nodesMax: number;
  bytesMax: number;
  /** (T125b) Rayon crête à crête maximal d'un cercle attendu (px). Cas avec `expected` seulement. */
  circleDeviationMax?: number;
  /** (T125b) Somme maximale des virages concaves des cercles attendus (degrés). */
  concaveTurnsMax?: number;
  /** (T125b) Écart maximal à une droite attendue (px). */
  lineDeviationMax?: number;
}

export interface CaseReport {
  name: string;
  fixture: string;
  preset: PresetName;
  width: number;
  height: number;
  /** Facteur de suréchantillonnage retenu par le prétraitement. */
  scale: number;
  colors: number;
  ssim: number;
  error: { meanRgb: number; p95Rgb: number; maxRgb: number; meanOklab: number; p95Oklab: number };
  /** Pixels opaques dont le rendu diffère de la source. */
  differingPixels: number;
  seams: { count: number; fraction: number; examined: number; conflation: number };
  topology: {
    exact: boolean;
    sourceComponents: number;
    renderComponents: number;
    sourceHoles: number;
    renderHoles: number;
    diffs: TopologyDiff[];
  };
  stats: SvgStats;
  /** (T125b) Écart aux formes attendues ; absent si le cas n'en déclare pas. */
  shapes?: ShapeReport;
  timings: Partial<Record<Stage, number>>;
  /** Durée totale de la vectorisation (ms), mesurée autour de l'appel. */
  totalMs: number;
}

export interface CaseOutput {
  report: CaseReport;
  svg: string;
  render: RasterImage;
  diff: RasterImage;
}

/** Options d'un cas : préréglage puis surcharges. */
export function caseOptions(c: Pick<EvalCase, 'preset' | 'options'>): VectorizeOptions {
  const o = presetOptions(c.preset);
  if (c.options) {
    for (const k of Object.keys(c.options) as (keyof VectorizeOptions)[]) {
      Object.assign(o[k], c.options[k]);
    }
  }
  return o;
}

/**
 * Source quantifiée de référence, celle que le SVG doit reproduire :
 * preprocess → quantize → segment (après absorption), à l'échelle de travail.
 * Le moteur est déterministe (graine), donc identique à celle du pipeline évalué.
 */
export function referenceSegmentation(
  image: RasterImage,
  options: VectorizeOptions,
): { map: LabelMap; palette: Palette; scale: number } {
  const pre = preprocess(image, options.preprocess);
  const opts = workingOptions(options, pre.scale);
  const q = quantize(pre, opts.quantize);
  const map = segment(q, pre.image.width, pre.image.height, opts.segment);
  return { map, palette: q.palette, scale: pre.scale };
}

/** Pour chaque couleur de `from`, la plus proche (OKLab) de `to`. */
function mapPalette(from: Palette, to: Palette): Int16Array {
  const a = paletteOklab(from);
  const b = paletteOklab(to);
  const out = new Int16Array(from.colors.length);
  for (let i = 0; i < from.colors.length; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < to.colors.length; k++) {
      const d =
        (a[3 * i]! - b[3 * k]!) ** 2 +
        (a[3 * i + 1]! - b[3 * k + 1]!) ** 2 +
        (a[3 * i + 2]! - b[3 * k + 2]!) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    out[i] = best;
  }
  return out;
}

/** Vectorise `image`, rastérise le SVG et calcule toutes les métriques. */
export function evaluateCase(
  c: EvalCase,
  image: RasterImage,
  vectorizeFn: VectorizeFn,
): CaseOutput {
  const options = caseOptions(c);
  const t0 = performance.now();
  const result = vectorizeFn(image, options);
  const totalMs = performance.now() - t0;
  const palette = result.palette;

  // Référence exprimée dans la palette du résultat (identité si les palettes coïncident).
  const ref = referenceSegmentation(image, options);
  const remap = mapPalette(ref.palette, palette);
  const refColors = labelColors(ref.map).map((v) => (v < 0 ? -1 : remap[v]!));
  const refMap = segment({ palette, colorIndex: refColors }, ref.map.width, ref.map.height, {
    minRegionArea: 1,
    connectivity: 4,
  });

  // Rendu à la taille d'origine : erreur, SSIM, liserés.
  const render = rasterizeSvg(result.svg, image.width);
  if (render.height !== image.height) {
    throw new Error(`${c.name} : rendu de hauteur ${render.height}, attendu ${image.height}`);
  }
  const bg = options.preprocess.background;
  const err = pixelError(render, image, bg);
  const s = ssim(render, image, bg);
  const quantOrig = downsampleColors(refColors, ref.map.width, ref.map.height, ref.scale);
  const seams = detectSeams(render, image, quantOrig, palette);

  // Topologie à l'échelle de travail : les coordonnées y sont entières.
  const renderWork = ref.scale === 1 ? render : rasterizeSvg(result.svg, image.width * ref.scale);
  const workArea = workingOptions(options, ref.scale).segment.minRegionArea;
  const topo = compareTopology(renderWork, refMap, palette, workArea);

  const report: CaseReport = {
    name: c.name,
    fixture: c.fixture,
    preset: c.preset,
    width: image.width,
    height: image.height,
    scale: ref.scale,
    colors: palette.colors.length,
    ssim: s,
    error: {
      meanRgb: err.meanRgb,
      p95Rgb: err.p95Rgb,
      maxRgb: err.maxRgb,
      meanOklab: err.meanOklab,
      p95Oklab: err.p95Oklab,
    },
    differingPixels: err.differing,
    seams: {
      count: seams.count,
      fraction: seams.fraction,
      examined: seams.examined,
      conflation: seams.conflation,
    },
    topology: {
      exact: topo.exact,
      sourceComponents: topo.sourceComponents,
      renderComponents: topo.renderComponents,
      sourceHoles: topo.sourceHoles,
      renderHoles: topo.renderHoles,
      diffs: topo.diffs,
    },
    stats: result.stats,
    ...(c.expected ? { shapes: shapeDeviations(result.svg, c.expected) } : {}),
    timings: result.timings,
    totalMs,
  };
  return { report, svg: result.svg, render, diff: diffImage(image, err.perPixel, seams.mask) };
}

/** Liste des dépassements de seuil d'un rapport (vide = tout passe). */
export function checkThresholds(r: CaseReport, t: Thresholds): string[] {
  const out: string[] = [];
  const fail = (what: string, got: string, want: string): void => {
    out.push(`${r.name} : ${what} = ${got} (seuil ${want})`);
  };
  if (!(r.ssim >= t.ssimMin)) fail('SSIM', r.ssim.toFixed(4), `≥ ${t.ssimMin}`);
  if (!(r.error.meanRgb <= t.meanErrorMax)) {
    fail('erreur moyenne', r.error.meanRgb.toFixed(3), `≤ ${t.meanErrorMax}`);
  }
  if (!(r.seams.count <= t.seamsMax)) fail('liserés', String(r.seams.count), `≤ ${t.seamsMax}`);
  if (t.holesExact && !r.topology.exact) {
    const d = r.topology.diffs
      .map(
        (x) =>
          `couleur ${x.colorId} : composantes ${x.source.components}→${x.render.components}, trous ${x.source.holes}→${x.render.holes}`,
      )
      .join(' ; ');
    fail('topologie', d, 'exacte');
  }
  if (!(r.stats.nodes <= t.nodesMax)) fail('nœuds', String(r.stats.nodes), `≤ ${t.nodesMax}`);
  if (!(r.stats.bytes <= t.bytesMax)) fail('octets', String(r.stats.bytes), `≤ ${t.bytesMax}`);
  // T125b : un seuil de forme sans géométrie mesurée échoue (jamais un passage muet).
  const shape = (what: string, got: number | undefined, max: number | undefined, unit: string) => {
    if (max === undefined) return;
    if (got === undefined) fail(what, 'non mesuré (aucune forme attendue)', `≤ ${max}${unit}`);
    else if (!(got <= max)) fail(what, `${got.toFixed(3)}${unit}`, `≤ ${max}${unit}`);
  };
  shape('écart au cercle', r.shapes?.circleDeviationMax, t.circleDeviationMax, ' px');
  shape('virages concaves', r.shapes?.concaveTurns, t.concaveTurnsMax, '°');
  shape('écart à la droite', r.shapes?.lineDeviationMax, t.lineDeviationMax, ' px');
  return out;
}

/** Tableau Markdown du rapport. */
export function formatTable(reports: CaseReport[]): string {
  const head =
    '| fixture | préréglage | SSIM | erreur moy. | p95 | liserés | trous | composantes | nœuds | octets | cercle (px) | concave (°) | droite (px) | ms |';
  const sep = '|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|';
  const shape = (v: number | undefined, digits: number, has: boolean): string =>
    v === undefined || !has ? '—' : v.toFixed(digits);
  const rows = reports.map((r) =>
    [
      r.name,
      r.preset,
      r.ssim.toFixed(4),
      r.error.meanRgb.toFixed(2),
      r.error.p95Rgb.toFixed(1),
      String(r.seams.count),
      `${r.topology.exact ? 'ok' : 'KO'} (${r.topology.sourceHoles}→${r.topology.renderHoles})`,
      `${r.topology.sourceComponents}→${r.topology.renderComponents}`,
      String(r.stats.nodes),
      String(r.stats.bytes),
      shape(r.shapes?.circleDeviationMax, 3, (r.shapes?.circles.length ?? 0) > 0),
      shape(r.shapes?.concaveTurns, 1, (r.shapes?.circles.length ?? 0) > 0),
      shape(r.shapes?.lineDeviationMax, 3, (r.shapes?.lines.length ?? 0) > 0),
      r.totalMs.toFixed(0),
    ].join(' | '),
  );
  return [head, sep, ...rows.map((x) => `| ${x} |`)].join('\n');
}
