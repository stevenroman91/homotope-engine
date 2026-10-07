/**
 * T33 — Export SVG des TRAITS (tracé centre-ligne), à côté de l'export des
 * faces (`index.ts`, inchangé). Chaque passage devient un sous-tracé ouvert
 * (ou fermé par `Z` pour une boucle) d'une seule passe, peint par
 * `<path fill="none" stroke=…>` ; son `stroke-width` est l'épaisseur moyenne
 * mesurée (transformée de distance), jamais sous `minWidth`. Les passages de
 * même épaisseur affichée partagent un `<path>` si `mergeByColor`.
 */
import { reverseFittedChain } from '../fit/index.ts';
import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  ExportOptions,
  FittedChain,
  Palette,
  StrokeGraph,
  VectorizeContext,
} from '../types.ts';
import { TRANSLUCENT_ALPHA } from '../types.ts';
import { clampPrecision, formatTicks, serializeSubpaths } from './path.ts';
import type { SubPath } from './rings.ts';
import { hexColor, RECT_NODES, type SvgOutput } from './index.ts';

/**
 * Épaisseur affichée, au dixième de pixel (à l'unité si `precision` vaut 0),
 * zéros inutiles retirés, jamais nulle. Un dixième suffit à un outil
 * (diamètre de buse, faisceau, fil) et regroupe les passages d'épaisseur voisine.
 */
export function formatWidth(v: number, precision: number): string {
  const p = Math.min(1, clampPrecision(precision));
  return formatTicks(Math.max(1, Math.round(v * 10 ** p)), p);
}

/** Sous-tracé d'un passage : ses arêtes ajustées, bout à bout. */
export function runSubPath(
  graph: StrokeGraph,
  byEdge: readonly FittedChain[],
  run: StrokeGraph['runs'][number],
): SubPath {
  const sub: SubPath = { start: [0, 0], segments: [], open: !run.closed };
  run.edges.forEach((re, i) => {
    const raw = byEdge[re.chain]!;
    const fc = re.reversed ? reverseFittedChain(raw) : raw;
    if (i === 0) sub.start = fc.start;
    for (const s of fc.segments) sub.segments.push(s);
  });
  if (run.edges.length === 0) sub.start = [graph.nodes[0]?.x ?? 0, graph.nodes[0]?.y ?? 0];
  return sub;
}

/**
 * `fitted` : arêtes ajustées, indexées par id d'arête. `dims` comme `exportSvg`
 * (coordonnées divisées par `scale`/`scaleY`) ; `minWidth` en px d'ORIGINE.
 */
export function exportStrokes(
  graph: StrokeGraph,
  fitted: readonly FittedChain[],
  palette: Palette,
  dims: { width: number; height: number; scale: number; scaleY?: number },
  options: ExportOptions,
  minWidth: number,
  ctx?: VectorizeContext,
): SvgOutput {
  const progress = (p: number): void => ctx?.onProgress?.(globalProgress('export', p));
  progress(0);
  const byEdge: FittedChain[] = [];
  for (const fc of fitted) byEdge[fc.chain] = fc;
  const color = (id: number) => palette.colors.find((c) => c.id === id);
  const W = fmtDim(dims.width);
  const H = fmtDim(dims.height);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  ];
  let paths = 0;
  let nodes = 0;
  let colors = 0;
  let strokes = 0;
  const paper = graph.paperColor >= 0 ? color(graph.paperColor) : undefined;
  if (options.backgroundRect && paper) {
    parts.push(`<rect width="100%" height="100%" fill="${hexColor(paper.rgb)}"/>`);
    paths++;
    nodes += RECT_NODES;
    colors++;
  }
  const ink = graph.inkColor >= 0 ? color(graph.inkColor) : undefined;
  if (ink && graph.runs.length > 0) {
    const sy = dims.scaleY ?? dims.scale;
    const unit = (dims.scale + sy) / 2;
    // Groupes par épaisseur affichée, la plus épaisse d'abord (ordre stable).
    const groups = new Map<string, SubPath[]>();
    graph.runs.forEach((run, i) => {
      if ((i & 255) === 0) {
        checkCancel(ctx);
        progress(i / graph.runs.length);
      }
      const label = formatWidth(Math.max(minWidth, run.width / unit), options.precision);
      const key = options.mergeByColor ? label : `${label}#${i}`;
      const list = groups.get(key) ?? [];
      list.push(runSubPath(graph, byEdge, run));
      groups.set(key, list);
    });
    const keys = [...groups.keys()].sort(
      (a, b) => parseFloat(b) - parseFloat(a) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const hex = hexColor(ink.rgb);
    const opacity =
      ink.alpha !== undefined && ink.alpha < TRANSLUCENT_ALPHA
        ? ` stroke-opacity="${String(Math.round((ink.alpha / 255) * 100) / 100).replace(/^0\./, '.')}"`
        : '';
    for (const key of keys) {
      const ser = serializeSubpaths(groups.get(key)!, dims.scale, options.precision, dims.scaleY);
      if (ser.subpaths === 0) continue;
      const label = key.split('#')[0]!;
      parts.push(
        `<path fill="none" stroke="${hex}"${opacity} stroke-width="${label}" stroke-linecap="round" stroke-linejoin="round" d="${ser.d}"/>`,
      );
      paths++;
      nodes += ser.nodes;
      strokes += ser.subpaths;
    }
    if (strokes > 0) colors++;
  }
  parts.push('</svg>');
  const svg = parts.join('');
  progress(1);
  return {
    svg,
    stats: {
      paths,
      nodes,
      bytes: new TextEncoder().encode(svg).length,
      colors,
      regions: 0,
      strokes,
    },
  };
}

function fmtDim(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}
