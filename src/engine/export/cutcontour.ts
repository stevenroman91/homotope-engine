/**
 * T95 — Calque du contour de découpe sticker (`CutContour`) : UNE constante pour tous les
 * formats (nom du calque, couleur d'accompagnement, épaisseur), et l'ajout du groupe au SVG émis.
 *
 * Le contour n'est pas une forme peinte : un trait fin sans remplissage, dans un groupe nommé
 * `CutContour` posé APRÈS le dessin. `sceneFromSvg` le relit comme item `cutcontour` (un seul
 * assembleur d'anneaux, T32) ; `paintedItems`, les séparations et le contrôle de découpe
 * l'ignorent ; le DXF l'écrit sur son propre calque, le PDF en couleur d'accompagnement
 * (`/Separation /CutContour`, le nom que lisent les RIP des imprimeurs de stickers). Pur.
 */
import { serializeSubpaths } from '../svg/path.ts';
import type { SubPath } from '../svg/rings.ts';

export const CUT_CONTOUR = {
  /** Nom du calque (DXF), du groupe (SVG, `id`) et de la couleur d'accompagnement (PDF). */
  name: 'CutContour',
  /** Marque du groupe SVG (`data-homotope`), lue par `sceneFromSvg`. */
  marker: 'cutcontour',
  /** Couleur RÉSERVÉE du trait (magenta pur, convention des RIP de découpe). */
  rgb: [255, 0, 255] as const,
  /** La même, en hexadécimal court (attribut `stroke`). */
  hex: '#f0f',
  /** Équivalent CMJN de la couleur d'accompagnement (repli du PDF) : 100 % magenta. */
  cmyk: [0, 1, 0, 0] as const,
  /** Épaisseur du trait, en unités du SVG (px d'origine ; 1 px = 1 pt en PDF) : un filet. */
  strokeWidth: 0.5,
} as const;

/** Décimales du tracé du contour dans le SVG (centième de pixel, comme le préréglage par défaut). */
export const CUT_CONTOUR_PRECISION = 2;

const GROUP_OPEN = `<g id="${CUT_CONTOUR.name}" data-homotope="${CUT_CONTOUR.marker}">`;

/** Vrai si le SVG porte déjà un groupe `CutContour`. */
export function hasCutContour(svg: string): boolean {
  return svg.includes(GROUP_OPEN);
}

/** Retire le groupe `CutContour` (s'il existe) : le SVG redevient le dessin seul. */
export function stripCutContour(svg: string): string {
  const at = svg.indexOf(GROUP_OPEN);
  if (at < 0) return svg;
  const end = svg.indexOf('</g>', at);
  return end < 0 ? svg : svg.slice(0, at) + svg.slice(end + 4);
}

const ATTR = /([\w:-]+)\s*=\s*"([^"]*)"/g;

/** Racine `<svg …>` du fichier : position, balise, attributs. */
function rootOf(svg: string): { at: number; tag: string; attrs: Map<string, string> } {
  const at = svg.search(/<svg\b/);
  if (at < 0) throw new Error('withCutContour : <svg> absent');
  const end = svg.indexOf('>', at);
  if (end < 0) throw new Error('withCutContour : <svg> non fermé');
  const tag = svg.slice(at, end + 1);
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(ATTR)) attrs.set(m[1]!, m[2]!);
  return { at, tag, attrs };
}

/** Boîte englobante des anneaux (points de contrôle compris : elle contient la courbe). */
function bbox(rings: readonly SubPath[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const see = (x: number, y: number): void => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const r of rings) {
    see(r.start[0], r.start[1]);
    for (const s of r.segments) {
      see(s.x, s.y);
      if (s.kind === 'cubic') {
        see(s.c1x, s.c1y);
        see(s.c2x, s.c2y);
      }
    }
  }
  return [x0, y0, x1, y1];
}

function shifted(rings: readonly SubPath[], dx: number, dy: number): SubPath[] {
  if (dx === 0 && dy === 0) return [...rings];
  return rings.map((r) => ({
    ...r,
    start: [r.start[0] + dx, r.start[1] + dy] as const,
    segments: r.segments.map((s) =>
      s.kind === 'cubic'
        ? {
            ...s,
            c1x: s.c1x + dx,
            c1y: s.c1y + dy,
            c2x: s.c2x + dx,
            c2y: s.c2y + dy,
            x: s.x + dx,
            y: s.y + dy,
          }
        : { ...s, x: s.x + dx, y: s.y + dy },
    ),
  }));
}

const num = (v: number): string => String(v);

/**
 * Ajoute (ou remplace) le groupe `CutContour` à la fin du SVG d'Homotope : un `<path>` de trait
 * fin, sans remplissage, par anneau (sous-tracés fermés, en px de la PAGE : les coordonnées de la
 * scène relue par `sceneFromSvg`). Aucun anneau : le SVG sans groupe.
 *
 * Un dessin collé au bord garde sa marge, donc le contour peut DÉBORDER de l'image : la page est
 * alors agrandie à la boîte du contour (`width`, `height`, `viewBox` à origine négative) et la
 * racine porte `data-homotope-image="W H"`, les dimensions de l'image d'origine, pour que la
 * largeur réelle en mm reste celle du dessin (`sceneImageWidth`). Le dessin n'est pas déplacé :
 * `sceneFromSvg` ramène l'origine du `viewBox` à 0 pour tous les exports. Sans débordement, seul
 * le groupe est ajouté.
 */
export function withCutContour(
  svg: string,
  rings: readonly SubPath[],
  precision: number = CUT_CONTOUR_PRECISION,
): string {
  const base = stripCutContour(svg);
  if (rings.length === 0) return base;
  const close = base.lastIndexOf('</svg>');
  if (close < 0) throw new Error('withCutContour : </svg> absent');
  const root = rootOf(base);
  const W = Number(root.attrs.get('width'));
  const H = Number(root.attrs.get('height'));
  if (!(W > 0 && H > 0)) throw new Error('withCutContour : dimensions du SVG illisibles');
  const vb = (root.attrs.get('viewBox') ?? `0 0 ${W} ${H}`)
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite))
    throw new Error('withCutContour : viewBox illisible');
  const [ox, oy, vw, vh] = vb as [number, number, number, number];
  // Anneaux en coordonnées de la page → espace utilisateur du SVG (origine du viewBox).
  const user = shifted(rings, ox, oy);
  const ser = serializeSubpaths(user, 1, precision);
  if (ser.subpaths === 0) return base;
  const group =
    GROUP_OPEN +
    `<path fill="none" stroke="${CUT_CONTOUR.hex}" stroke-width="${CUT_CONTOUR.strokeWidth}" stroke-linejoin="round" d="${ser.d}"/>` +
    '</g>';
  // Débordement : page agrandie à la boîte du contour (trait compris), le dessin reste en place.
  const pad = CUT_CONTOUR.strokeWidth / 2;
  const [bx0, by0, bx1, by1] = bbox(user);
  const nx0 = Math.min(ox, Math.floor(bx0 - pad));
  const ny0 = Math.min(oy, Math.floor(by0 - pad));
  const nx1 = Math.max(ox + vw, Math.ceil(bx1 + pad));
  const ny1 = Math.max(oy + vh, Math.ceil(by1 + pad));
  let head = base.slice(0, close);
  if (nx0 < ox || ny0 < oy || nx1 > ox + vw || ny1 > oy + vh) {
    const nw = nx1 - nx0;
    const nh = ny1 - ny0;
    const image = root.attrs.get('data-homotope-image') ?? `${num(W)} ${num(H)}`;
    let tag = root.tag
      .replace(/\swidth="[^"]*"/, ` width="${num(nw)}"`)
      .replace(/\sheight="[^"]*"/, ` height="${num(nh)}"`);
    const vbAttr = ` viewBox="${num(nx0)} ${num(ny0)} ${num(nw)} ${num(nh)}"`;
    tag = /\sviewBox="[^"]*"/.test(tag)
      ? tag.replace(/\sviewBox="[^"]*"/, vbAttr)
      : tag.replace(/>$/, `${vbAttr}>`);
    tag = /\sdata-homotope-image="[^"]*"/.test(tag)
      ? tag.replace(/\sdata-homotope-image="[^"]*"/, ` data-homotope-image="${image}"`)
      : tag.replace(/>$/, ` data-homotope-image="${image}">`);
    head = tag + base.slice(root.at + root.tag.length, close);
  }
  return head + group + base.slice(close);
}
