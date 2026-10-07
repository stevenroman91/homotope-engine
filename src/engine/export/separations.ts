/**
 * T34 — Séparations de couleur : une couche par couleur, pour la sérigraphie, la broderie,
 * l'impression et la découpe de vinyle. Tout part du SVG émis par `exportSvg` (comme T32) :
 *
 *  - `layeredSvg` : le MÊME SVG, ses éléments regroupés en calques Inkscape
 *    (`<g id="couleur-…" inkscape:groupmode="layer" inkscape:label="…">`, repris par
 *    Illustrator), un calque par SÉRIE CONTIGUË d'éléments de même couleur : l'ordre de peinture
 *    ne change jamais, le rendu est celui du SVG d'origine (en mode découpé avec fusion par
 *    couleur, une série par couleur) ; le masque de gomme (F1) reste en tête, hors calque ;
 *  - `separationFiles` : un fichier par couleur (SVG, PDF, EPS ou DXF), `<image>-<nom>.<ext>`,
 *    à mettre dans un ZIP (`zipStore`). Chaque fichier est la ZONE VISIBLE de sa couleur
 *    (défonce) : les fichiers sont disjoints. Il faut pour cela la géométrie DÉCOUPÉE (mode
 *    `cut` : aucune forme n'en chevauche une autre) ; le `<rect>` de fond, peint sous tout le
 *    reste, devient le rectangle MOINS les formes des autres couleurs (tracé `evenodd`) ; le
 *    trait anti-liseré (une repasse de contour, remède d'affichage) est omis. En mode empilé
 *    (`stacked`), la zone visible d'une couleur n'est pas dans le SVG : `SeparationError`.
 *
 * Couleur d'un élément : son remplissage, à défaut son trait. Pur, sans DOM.
 */
import { colorKey, writeDxf, type DxfOptions } from './dxf.ts';
import { writeEps } from './eps.ts';
import { writePdf } from './pdf.ts';
import {
  fmtNum,
  parseColor,
  sceneFromSvg,
  SceneError,
  type SceneItem,
  type VectorScene,
} from './scene.ts';
import type { ParsedSubpath } from '../svg/parse.ts';
import { zipStore } from './zip.ts';

/** Noms de nuancier : `#rrggbb` minuscule → nom affiché. */
export type ColorNames = Readonly<Record<string, string>>;

export const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';

/** Élément de premier niveau du SVG : un `<path>` / `<rect>` peint, ou un `<mask>` (défini). */
interface TopElement {
  raw: string;
  /** `#rrggbb` de l'élément peint ; `null` pour un `<mask>`. */
  color: string | null;
}

interface SplitSvg {
  /** Balise ouvrante `<svg …>` (prologue XML éventuel compris). */
  open: string;
  elements: TopElement[];
}

const ELEMENT = /<(path|rect)\b((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*\/>/y;

function attr(raw: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(raw)?.[1];
}

/**
 * Découpe le SVG en éléments de premier niveau. Le SVG est d'abord relu par `sceneFromSvg`
 * (sous-ensemble d'Homotope, sinon `SceneError`) : la découpe ne voit donc que `<path>`,
 * `<rect>` auto-fermants et des `<mask>…</mask>`.
 */
function splitSvg(svg: string): SplitSvg {
  sceneFromSvg(svg);
  const start = svg.search(/<svg\b/);
  const openEnd = svg.indexOf('>', start) + 1;
  const close = svg.lastIndexOf('</svg>');
  const elements: TopElement[] = [];
  let i = openEnd;
  while (i < close) {
    const lt = svg.indexOf('<', i);
    if (lt < 0 || lt >= close) break;
    if (svg.startsWith('<mask', lt)) {
      const end = svg.indexOf('</mask>', lt);
      if (end < 0) throw new SceneError('</mask> absent');
      elements.push({ raw: svg.slice(lt, end + 7), color: null });
      i = end + 7;
      continue;
    }
    ELEMENT.lastIndex = lt;
    const m = ELEMENT.exec(svg);
    if (!m) throw new SceneError(`élément illisible en ${lt}`);
    i = ELEMENT.lastIndex;
    const fill = parseColor(attr(m[2]!, 'fill') ?? '#000');
    const stroke = parseColor(attr(m[2]!, 'stroke'));
    const rgb = fill ?? stroke;
    if (rgb) elements.push({ raw: m[0], color: colorKey(rgb) });
  }
  return { open: svg.slice(0, openEnd), elements };
}

/** Couleurs peintes du SVG, dans l'ordre de première peinture (`#rrggbb`). */
export function separationColors(svg: string): string[] {
  const out: string[] = [];
  for (const e of splitSvg(svg).elements) if (e.color && !out.includes(e.color)) out.push(e.color);
  return out;
}

/** Échappement d'une valeur d'attribut XML (nom saisi par l'utilisateur). */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Suffixe ASCII d'un nom (accents retirés, minuscules, `a-z 0-9` et tirets), ou l'hexadécimal
 * sans `#` si le nom est absent ou vide une fois nettoyé ; 48 caractères au plus.
 */
export function colorSlug(color: string, names: ColorNames = {}): string {
  const slug = (names[color] ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || color.slice(1);
}

/** Suffixes uniques, dans l'ordre des couleurs (un doublon prend l'hexadécimal). */
function uniqueSlugs(colors: readonly string[], names: ColorNames): string[] {
  const used = new Set<string>();
  return colors.map((c) => {
    let s = colorSlug(c, names);
    if (used.has(s)) s = `${s}-${c.slice(1)}`;
    used.add(s);
    return s;
  });
}

/** Libellé d'un calque : le nom du nuancier, sinon l'hexadécimal majuscule (`#E30613`). */
export function colorLabel(color: string, names: ColorNames = {}): string {
  const n = names[color]?.trim();
  return n ? n : color.toUpperCase();
}

/** Séparations impossibles (un fichier par couleur d'un SVG empilé). */
export class SeparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeparationError';
  }
}

export const STACKED_SEPARATIONS_MESSAGE =
  'Un fichier par couleur exige le mode « découpé » : en mode « empilé », les formes se ' +
  'recouvrent et la zone visible de chaque couleur n’est pas connue.';

/**
 * SVG en mode EMPILÉ : la racine n'a pas `fill-rule="evenodd"` (posé par le mode découpé) ET un
 * `<path>` est rempli (un tracé centre-ligne, T33, n'a que des traits : pas de recouvrement de
 * surfaces). Lecture légère (expressions régulières, aucun parcours de la scène) : le serveur la
 * fait dans la boucle d'événements avant d'occuper un thread.
 */
export function svgIsStacked(svg: string): boolean {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  if (/\sfill-rule="evenodd"/.test(root)) return false;
  return /<path\b[^>]*\sfill="#/.test(svg);
}

/**
 * Préfixe des fichiers d'un ZIP, assaini (défense en profondeur ; l'appelant passe déjà un nom
 * nettoyé) : séparateurs `/` `\`, contrôles et `:` remplacés par `_`, `..` neutralisé, points et
 * espaces de tête retirés, 100 caractères ; vide → `image`.
 */
export function safeStem(stem: string): string {
  const s = stem
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:\u0000-\u001f\u007f]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 100)
    .trimEnd();
  return s || 'image';
}

/** SVG à calques : un `<g>` Inkscape par série contiguë de même couleur (ordre de peinture gardé). */
export function layeredSvg(svg: string, names: ColorNames = {}): string {
  const { open, elements } = splitSvg(svg);
  const colors: string[] = [];
  for (const e of elements) if (e.color && !colors.includes(e.color)) colors.push(e.color);
  const slugs = new Map(uniqueSlugs(colors, names).map((sl, i) => [colors[i]!, sl]));
  const head = open.includes('xmlns:inkscape=')
    ? open
    : open.replace(/<svg\b/, `<svg xmlns:inkscape="${INKSCAPE_NS}"`);
  const parts = [head, ...elements.filter((e) => e.color === null).map((e) => e.raw)];
  const runs = new Map<string, number>();
  let current: string | null = null;
  for (const e of elements) {
    if (e.color === null) continue;
    if (e.color !== current) {
      if (current !== null) parts.push('</g>');
      current = e.color;
      const n = (runs.get(current) ?? 0) + 1;
      runs.set(current, n);
      const id = `couleur-${slugs.get(current)!}${n > 1 ? `-${n}` : ''}`;
      parts.push(
        `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${escAttr(colorLabel(current, names))}">`,
      );
    }
    parts.push(e.raw);
  }
  if (current !== null) parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

export type SeparationFormat = 'svg' | 'pdf' | 'eps' | 'dxf';

export interface SeparationFile {
  name: string;
  /** Texte du fichier (UTF-8 pour le SVG, ASCII pour PDF, EPS et DXF). */
  text: string;
}

/**
 * Scènes par couleur, ZONES VISIBLES (mode découpé), dans l'ordre de première peinture :
 *  - remplissages de la couleur (sans leur trait anti-liseré) et traits d'axe (T33) ;
 *  - trait anti-liseré seul : omis (repasse d'un contour, pas une surface) ;
 *  - `<rect>` de fond : le rectangle plus TOUS les sous-tracés remplis des autres couleurs, en
 *    `evenodd` : en mode découpé ces formes ne se chevauchent pas, la parité retire exactement
 *    leur surface (un îlot de la couleur du fond dans un trou d'une autre forme reste peint).
 * Lève `SeparationError` en mode empilé.
 */
export function separationScenes(svg: string): { color: string; scene: VectorScene }[] {
  if (svgIsStacked(svg)) throw new SeparationError(STACKED_SEPARATIONS_MESSAGE);
  const scene = sceneFromSvg(svg);
  const colors: string[] = [];
  for (const it of scene.items) {
    const c = colorKey(it.rgb);
    if (!colors.includes(c)) colors.push(c);
  }
  const filled = scene.items.filter((it) => it.fill && !it.background);
  return colors.map((color) => {
    const items: SceneItem[] = [];
    for (const it of scene.items) {
      if (colorKey(it.rgb) !== color) continue;
      if (it.background) {
        const others = filled.filter((o) => colorKey(o.rgb) !== color);
        items.push({
          rgb: it.rgb,
          fill: true,
          background: true,
          subpaths: [...it.subpaths, ...others.flatMap((o) => o.subpaths)],
          ...(it.opacity !== undefined ? { opacity: it.opacity } : {}),
        });
      } else if (it.fill) {
        items.push({
          rgb: it.rgb,
          fill: true,
          subpaths: it.subpaths,
          ...(it.opacity !== undefined ? { opacity: it.opacity } : {}),
        });
      } else if (it.centerline) {
        items.push(it);
      }
    }
    return { color, scene: { ...scene, fillRule: 'evenodd', items } };
  });
}

/** `d` d'un tracé en coordonnées absolues (4 décimales : celles du SVG, au plus). */
function pathData(subpaths: readonly ParsedSubpath[]): string {
  const n = (v: number) => fmtNum(v, 4);
  const out: string[] = [];
  for (const sp of subpaths) {
    out.push(`M${n(sp.start[0])} ${n(sp.start[1])}`);
    for (const s of sp.segments) {
      out.push(
        s.kind === 'line'
          ? `L${n(s.x)} ${n(s.y)}`
          : `C${n(s.c1x)} ${n(s.c1y)} ${n(s.c2x)} ${n(s.c2y)} ${n(s.x)} ${n(s.y)}`,
      );
    }
    if (sp.closed) out.push('Z');
  }
  return out.join('');
}

/** SVG d'une scène de séparation (sous-ensemble d'Homotope : relisible par `sceneFromSvg`). */
export function sceneToSvg(scene: VectorScene): string {
  const w = fmtNum(scene.width, 4);
  const h = fmtNum(scene.height, 4);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${scene.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}>`,
  ];
  for (const it of scene.items) {
    const hex = colorKey(it.rgb);
    const op = it.opacity !== undefined ? ` fill-opacity="${fmtNum(it.opacity, 4)}"` : '';
    parts.push(
      it.fill
        ? `<path fill="${hex}"${op} d="${pathData(it.subpaths)}"/>`
        : `<path fill="none" stroke="${hex}" stroke-width="${fmtNum(it.stroke ?? 1, 4)}" stroke-linecap="round" stroke-linejoin="round" d="${pathData(it.subpaths)}"/>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Un fichier par couleur peinte, `<stem>-<nom|hex>.<ext>` : la zone visible de la couleur
 * (`separationScenes`), en SVG, PDF, EPS ou DXF. DXF : le fond n'est pas une forme (T32), sa
 * couleur n'a de fichier que si `includeBackground`. Lève `SeparationError` en mode empilé.
 */
export function separationFiles(
  svg: string,
  format: SeparationFormat,
  stem: string,
  names: ColorNames = {},
  dxf: DxfOptions = {},
): SeparationFile[] {
  const scenes = separationScenes(svg);
  const slugs = uniqueSlugs(
    scenes.map((s) => s.color),
    names,
  );
  const prefix = safeStem(stem);
  const out: SeparationFile[] = [];
  scenes.forEach(({ scene }, i) => {
    const name = `${prefix}-${slugs[i]!}.${format}`;
    if (format === 'svg') out.push({ name, text: sceneToSvg(scene) });
    else if (format === 'pdf') out.push({ name, text: writePdf(scene) });
    else if (format === 'eps') out.push({ name, text: writeEps(scene) });
    else {
      // Formes à tracer : remplissages et traits d'axe du centre-ligne (T33), comme `writeDxf`.
      const shapes = scene.items.some(
        (it) => (it.fill || it.centerline === true) && (dxf.includeBackground || !it.background),
      );
      if (shapes) out.push({ name, text: writeDxf(scene, { ...dxf, names }) });
    }
  });
  return out;
}

/** Octets d'un fichier : UTF-8 pour le SVG, octet par caractère (ASCII) pour les autres. */
export function fileBytes(text: string, format: SeparationFormat): Uint8Array {
  if (format === 'svg') return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Séparations en ZIP : un fichier par couleur. Lève `SeparationError` en mode empilé. */
export function separationsZip(
  svg: string,
  format: SeparationFormat,
  stem: string,
  names: ColorNames = {},
  dxf: DxfOptions = {},
): Uint8Array {
  return zipStore(
    separationFiles(svg, format, stem, names, dxf).map((f) => ({
      name: f.name,
      data: fileBytes(f.text, format),
    })),
  );
}
