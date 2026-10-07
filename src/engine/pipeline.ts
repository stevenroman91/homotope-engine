import { medianStrokeWidth, skeletonize, strokeChains, strokeGraph } from './centerline/index.ts';
import { effectiveQuantize, quantize } from './color/quantize.ts';
import { fitChains, thinTolerances } from './fit/index.ts';
import { preprocess } from './preprocess/index.ts';
import { borderColorIds } from './segment/border.ts';
import { segment } from './segment/index.ts';
import { exportSvg } from './svg/index.ts';
import { exportStrokes } from './svg/strokes.ts';
import { buildBoundaryGraph } from './topology/index.ts';
import type {
  FittedChain,
  LabelMap,
  PreprocessResult,
  ProgressEvent,
  QuantizeResult,
  RasterImage,
  Stage,
  VectorizeContext,
  VectorizeOptions,
  VectorizeResult,
} from './types.ts';
import { CancelledError, STAGES } from './types.ts';

/** Poids relatif de chaque étape dans la progression globale. */
export const STAGE_WEIGHTS: Record<Stage, number> = {
  preprocess: 0.1,
  quantize: 0.3,
  segment: 0.15,
  topology: 0.15,
  fit: 0.25,
  export: 0.05,
};

/** Convertit une progression d'étape en progression globale. */
export function globalProgress(stage: Stage, stageProgress: number): ProgressEvent {
  let before = 0;
  for (const s of STAGES) {
    if (s === stage) break;
    before += STAGE_WEIGHTS[s];
  }
  const p = Math.min(1, Math.max(0, stageProgress));
  return { stage, stageProgress: p, progress: before + STAGE_WEIGHTS[stage] * p };
}

/** Lève `CancelledError` si le jeton est annulé. À appeler aux points de reprise. */
export function checkCancel(ctx?: VectorizeContext): void {
  if (ctx?.cancel?.cancelled) throw new CancelledError();
}

/**
 * Options à l'échelle de TRAVAIL. L'utilisateur exprime `fit.tolerance`,
 * `fit.lineTolerance`, `segment.blendBand` (pixels) et `segment.minRegionArea` (pixels²) dans
 * l'image D'ORIGINE ; le pipeline travaille sur une image `scale` fois plus grande
 * (suréchantillonnage, `scale` > 1) ou plus petite (image réduite, T12, `scale` < 1).
 *
 *  - Aires × scale² dans les deux sens : une tache de 8 px² d'origine en couvre
 *    2 dans une image réduite de moitié.
 *  - Longueurs × scale en suréchantillonnage, mais JAMAIS sous leur valeur en
 *    pixels de travail quand l'image est réduite (× max(1, scale)) : une
 *    tolérance d'ajustement, une droite ou une bande d'anti-aliasing ne
 *    descendent pas sous la résolution de l'image analysée (l'escalier d'un
 *    contour fait ~0,5 px de travail ; une tolérance de 0,5 px de travail
 *    ajusterait l'escalier lui-même). En pixels d'origine, elles valent alors
 *    leur valeur / scale : la précision perdue par la réduction.
 */
export function workingOptions(options: VectorizeOptions, scale: number): VectorizeOptions {
  if (scale === 1) return options;
  const len = Math.max(1, scale);
  return {
    ...options,
    segment: {
      ...options.segment,
      minRegionArea: options.segment.minRegionArea * scale * scale,
      ...(options.segment.blendBand !== undefined && {
        blendBand: options.segment.blendBand * len,
      }),
    },
    fit: {
      ...options.fit,
      tolerance: options.fit.tolerance * len,
      lineTolerance: options.fit.lineTolerance * len,
    },
    // T33 : longueurs du tracé centre-ligne (section absente des options enregistrées avant
    // T33). `minWidth` reste en pixels d'origine : c'est l'épaisseur ÉCRITE dans le SVG.
    ...(options.centerline && {
      centerline: {
        ...options.centerline,
        spurLength: options.centerline.spurLength * len,
        tolerance: options.centerline.tolerance * len,
      },
    }),
  };
}

/** Chaîne ajustée divisée par (`sx`, `sy`) (coordonnées de l'image d'origine). */
function unscaleFitted(fc: FittedChain, sx: number, sy: number): FittedChain {
  const kx = 1 / sx;
  const ky = 1 / sy;
  return {
    chain: fc.chain,
    start: [fc.start[0] * kx, fc.start[1] * ky],
    segments: fc.segments.map((s) =>
      s.kind === 'line'
        ? { kind: 'line', x: s.x * kx, y: s.y * ky }
        : {
            kind: 'cubic',
            c1x: s.c1x * kx,
            c1y: s.c1y * ky,
            c2x: s.c2x * kx,
            c2y: s.c2y * ky,
            x: s.x * kx,
            y: s.y * ky,
          },
    ),
  };
}

/**
 * T07 — Orchestration : preprocess → quantize → segment → topology → fit →
 * export, avec progression pondérée, annulation coopérative et chronométrage.
 * Synchrone volontairement (le worker l'isole du thread principal) ; les points
 * de reprise sont des appels à `checkCancel` entre étapes ET dans les boucles longues.
 *
 * Chaque étape est encadrée par une progression 0 puis 1 (les étapes émettent
 * en plus leur progression interne) : la suite des `progress` est monotone et
 * se termine à 1. Une image vide (0 pixel) ou entièrement transparente donne
 * un SVG valide sans tracé. `debug.fitted` (coordonnées d'origine) est rendu si
 * `ctx.debug` est vrai.
 *
 * T12 — Image réduite : si `ctx.original` donne des dimensions d'origine
 * différentes de celles de `image`, `image` en est une réduction ; le
 * suréchantillonnage est désactivé, le `viewBox` et toutes les coordonnées
 * sont exprimés dans les dimensions d'ORIGINE (facteurs par axe
 * `travail / origine`), et les tolérances suivent `workingOptions`.
 * Mémoire : chaque tampon par pixel est lâché dès que l'étape suivante n'en a
 * plus besoin (image prétraitée après la quantification, index de couleur
 * après la segmentation, labels après la topologie).
 */
export function vectorize(
  image: RasterImage,
  options: VectorizeOptions,
  ctx?: VectorizeContext,
): VectorizeResult {
  const width = ctx?.original?.width ?? image.width;
  const height = ctx?.original?.height ?? image.height;
  const reduced = width !== image.width || height !== image.height;
  const timings: Partial<Record<Stage, number>> = {};
  const run = <T>(stage: Stage, f: () => T): T => {
    checkCancel(ctx);
    ctx?.onProgress?.(globalProgress(stage, 0));
    const t0 = performance.now();
    const r = f();
    timings[stage] = performance.now() - t0;
    checkCancel(ctx);
    ctx?.onProgress?.(globalProgress(stage, 1));
    return r;
  };

  const preOptions =
    reduced && options.preprocess.upsample !== 1
      ? { ...options.preprocess, upsample: 1 as const }
      : options.preprocess;
  let pre: PreprocessResult | null = run('preprocess', () => preprocess(image, preOptions, ctx));
  const w = pre.image.width;
  const h = pre.image.height;
  // Facteurs travail / origine par axe ; égaux (et entiers) sans réduction.
  const sx = width > 0 ? w / width : 1;
  const sy = height > 0 ? h / height : 1;
  const scale = sx === sy ? sx : Math.sqrt(sx * sy);
  const opts = workingOptions(options, scale);
  // T52 — Mesures rendues à l'interface (seuil effectif, épaisseur des traits).
  const diagnostics: NonNullable<VectorizeResult['diagnostics']> = {};
  if (pre.threshold !== undefined) diagnostics.threshold = pre.threshold;
  // T34 : palette imposée ignorée en tracé centre-ligne (`effectiveQuantize`).
  let q: QuantizeResult | null = run('quantize', () =>
    quantize(pre!, effectiveQuantize(opts), ctx),
  );
  pre = null;
  const palette = q.palette;
  if (opts.centerline?.enabled === true) {
    // T33 — Tracé centre-ligne : mêmes étapes (mêmes noms pour la progression),
    // mais un graphe de TRAITS au lieu du graphe des frontières.
    const cl = opts.centerline;
    const sk = run('segment', () => skeletonize(q!, w, h, cl, ctx));
    q = null;
    // Mesurée en px de travail, rendue en px d'origine (comme `stroke-width`).
    diagnostics.strokeWidth = medianStrokeWidth(sk.pixels, sk.dist2, w) / scale;
    const graph = run('topology', () => strokeGraph(sk, cl, opts.fit.cornerAngle));
    const fitted = run('fit', () =>
      fitChains(
        strokeChains(graph),
        {
          ...opts.fit,
          tolerance: cl.tolerance,
          lineTolerance: Math.min(opts.fit.lineTolerance, cl.tolerance),
          pixelArt: false,
        },
        ctx,
      ),
    );
    const { svg, stats } = run('export', () =>
      exportStrokes(
        graph,
        fitted,
        palette,
        { width, height, scale: sx, scaleY: sy },
        opts.export,
        cl.minWidth,
        ctx,
      ),
    );
    const result: VectorizeResult = { svg, stats, palette, width, height, timings, diagnostics };
    if (ctx?.debug) {
      result.debug = {
        fitted: sx === 1 && sy === 1 ? fitted : fitted.map((f) => unscaleFitted(f, sx, sy)),
      };
    }
    return result;
  }
  let map: LabelMap | null = run('segment', () => segment(q!, w, h, opts.segment, ctx));
  q = null;
  const graph = run('topology', () => buildBoundaryGraph(map!, ctx));
  const areas = map.regions.map((r) => r.area);
  const borderColors = borderColorIds(map);
  map = null;
  const fitted = run('fit', () => {
    // T08 : tolérance resserrée sur les chaînes qui bordent une forme mince.
    const tol = opts.fit.pixelArt
      ? undefined
      : thinTolerances(graph.chains, areas, opts.fit.tolerance);
    return fitChains(graph.chains, opts.fit, ctx, tol);
  });
  const { svg, stats } = run('export', () =>
    exportSvg(graph, fitted, palette, { width, height, scale: sx, scaleY: sy }, opts.export, ctx),
  );

  const result: VectorizeResult = { svg, stats, palette, width, height, timings, borderColors };
  if (Object.keys(diagnostics).length > 0) result.diagnostics = diagnostics;
  if (ctx?.debug) {
    result.debug = {
      fitted: sx === 1 && sy === 1 ? fitted : fitted.map((f) => unscaleFitted(f, sx, sy)),
    };
  }
  return result;
}
