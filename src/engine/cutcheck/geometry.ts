/**
 * T35 — Géométrie de découpe : les polylignes que la découpeuse recevra (celles du DXF de T32),
 * lues dans la scène du SVG (`sceneFromSvg`, le seul assembleur d'anneaux reste `exportSvg`).
 * Pur, sans DOM.
 */
import type { ParsedSubpath } from '../svg/parse.ts';
import { cutItems, flattenSubpath } from '../export/polyline.ts';
import type { Rgb, VectorScene } from '../export/scene.ts';

export interface CutPolyline {
  /** Index dans `CutGeometry.items` (couche, couleur). */
  item: number;
  /** Points entrelacés [x0, y0, …], coordonnées de l'image (px d'origine). */
  pts: Float64Array;
  closed: boolean;
  /**
   * Issue d'une fusion des frontières communes (ou d'une simplification) : un morceau de
   * frontière, OUVERT par nature ; jamais signalé comme contour ouvert.
   */
  merged?: true;
}

export interface CutItem {
  rgb: Rgb;
  /** Trait d'axe du centre-ligne (T33) : une passe ouverte, normale. */
  stroke: boolean;
}

export interface CutGeometry {
  width: number;
  height: number;
  items: CutItem[];
  polylines: CutPolyline[];
}

export interface CutGeometryOptions {
  /** Tolérance d'aplatissement des cubiques (px d'origine), celle du DXF. */
  tolerance: number;
  /** Garder le `<rect>` de fond (cadre), comme `includeBackground` du DXF. */
  includeBackground?: boolean;
}

/**
 * Crans de recalage : 1e-6 px. Les coordonnées du SVG ont au plus 4 décimales, mais les
 * chemins relatifs (`l`, `c`…) se relisent par sommes successives : un même sommet parcouru par
 * deux faces peut différer de 1e-13. Recalées au millionième, elles redeviennent identiques au
 * bit près (l'écart est très loin de la demi-graduation).
 */
const SNAP = 1e6;
const snap = (v: number): number => Math.round(v * SNAP) / SNAP;

function snapSubpath(sp: ParsedSubpath): ParsedSubpath {
  return {
    start: [snap(sp.start[0]), snap(sp.start[1])],
    closed: sp.closed,
    segments: sp.segments.map((s) =>
      s.kind === 'line'
        ? { kind: 'line', x: snap(s.x), y: snap(s.y) }
        : {
            kind: 'cubic',
            c1x: snap(s.c1x),
            c1y: snap(s.c1y),
            c2x: snap(s.c2x),
            c2y: snap(s.c2y),
            x: snap(s.x),
            y: snap(s.y),
          },
    ),
  };
}

/**
 * Polylignes découpées d'une scène, dans l'ordre du DXF (ordre de peinture, sous-tracés dans
 * l'ordre). Cubiques aplaties dans leur sens canonique : une frontière commune parcourue par
 * ses deux faces donne deux suites de points identiques (inversées).
 */
export function cutGeometry(scene: VectorScene, options: CutGeometryOptions): CutGeometry {
  const items: CutItem[] = [];
  const polylines: CutPolyline[] = [];
  for (const it of cutItems(scene, options.includeBackground === true)) {
    const item = items.push({ rgb: it.rgb, stroke: !it.fill }) - 1;
    for (const sp of it.subpaths) {
      const pts = flattenSubpath(snapSubpath(sp), options.tolerance, true);
      if (pts.length < 4) continue; // un point isolé : rien à découper
      // Un remplissage est fermé par le DXF (drapeau 1) ; seul un trait garde son ouverture.
      polylines.push({ item, pts, closed: sp.closed });
    }
  }
  return { width: scene.width, height: scene.height, items, polylines };
}

/** Aire signée (formule du lacet) d'une polyligne fermée, px². */
export function polygonArea(pts: Float64Array): number {
  const n = pts.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += pts[2 * j]! * pts[2 * i + 1]! - pts[2 * i]! * pts[2 * j + 1]!;
  }
  return a / 2;
}

export function bboxOf(pts: Float64Array): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k]!;
    const y = pts[k + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
