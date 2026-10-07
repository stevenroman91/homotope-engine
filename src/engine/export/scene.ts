/**
 * T32 — Scène vectorielle commune aux exports PDF, EPS et DXF.
 *
 * SOURCE UNIQUE : la scène est relue dans le SVG émis par `exportSvg` (le seul assembleur
 * d'anneaux du moteur), jamais reconstruite depuis le graphe. Elle porte donc exactement la
 * même géométrie (anneaux assemblés, sous-tracés, cubiques, coordonnées arrondies à la
 * précision choisie) et le même ordre de peinture que le SVG : l'atelier et l'API (qui n'a
 * que le SVG stocké) produisent le même fichier. Pur, sans DOM.
 *
 * Seul le sous-ensemble émis par Homotope est accepté : `<svg>` racine, `<rect>` de fond,
 * `<path>` (remplissage, trait anti-liseré, ou les deux) et un `<mask>` de gomme (T08/F1),
 * sauté. Tout autre élément lève `SceneError` (jamais d'export silencieusement faux).
 */
import { parsePathData, type ParsedSubpath } from '../svg/parse.ts';

export type Rgb = readonly [number, number, number];

/** Un `<path>` (ou le `<rect>` de fond) du SVG, dans l'ordre de peinture. */
export interface SceneItem {
  /** Couleur du remplissage ou, à défaut, du trait. */
  rgb: Rgb;
  /** Opacité du remplissage 0..1 (`fill-opacity`) ; absente : opaque. */
  opacity?: number;
  /** Le tracé est rempli. */
  fill: boolean;
  /** Largeur du trait (unités du SVG = px d'origine) ; absente : aucun trait. */
  stroke?: number;
  /** Trait soumis au masque de gomme (F1) : il ne doit jamais couvrir la transparence. */
  masked?: boolean;
  /**
   * T33 — Trait d'AXE du tracé centre-ligne (`fill="none"`, `stroke-linecap="round"`) : le
   * trait EST la forme (bouts ronds en PDF / EPS, polyligne ouverte à découper en DXF), à la
   * différence d'un trait anti-liseré, simple repasse d'un contour.
   */
  centerline?: true;
  /**
   * `<rect>` de fond (`backgroundRect`) : un rectangle de la taille de l'image, peint en PDF et
   * en EPS, mais qui n'est PAS une forme à découper (DXF : omis par défaut).
   */
  background?: true;
  /** Sous-tracés en coordonnées ABSOLUES du SVG (Y vers le bas). */
  subpaths: ParsedSubpath[];
}

export interface VectorScene {
  /** Dimensions du SVG (px d'origine). */
  width: number;
  height: number;
  /** Règle de remplissage héritée de `<svg>` : `evenodd` en mode découpé, `nonzero` empilé. */
  fillRule: 'evenodd' | 'nonzero';
  items: SceneItem[];
}

/** SVG hors du sous-ensemble émis par Homotope. */
export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneError';
  }
}

const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/y;
const ATTR = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function attrsOf(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of raw.matchAll(ATTR)) m.set(a[1]!, a[2]!);
  return m;
}

/** `#rgb` ou `#rrggbb` → [r, g, b] 0..255 ; `none` → null. */
export function parseColor(v: string | undefined): Rgb | null {
  if (v === undefined || v === 'none') return null;
  const s = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
  if (!s) throw new SceneError(`couleur non prise en charge : « ${v.slice(0, 24)} »`);
  const h = s.length === 3 ? [...s].map((c) => c + c) : [s.slice(0, 2), s.slice(2, 4), s.slice(4)];
  return [parseInt(h[0]!, 16), parseInt(h[1]!, 16), parseInt(h[2]!, 16)];
}

function positive(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new SceneError(`${what} invalide : « ${v ?? ''} »`);
  return n;
}

/** Rectangle fermé (4 lignes, retour implicite au départ). */
function rectSubpath(x: number, y: number, w: number, h: number): ParsedSubpath {
  return {
    start: [x, y],
    segments: [
      { kind: 'line', x: x + w, y },
      { kind: 'line', x: x + w, y: y + h },
      { kind: 'line', x, y: y + h },
    ],
    closed: true,
  };
}

/** Relit la scène d'un SVG émis par `exportSvg`. Lève `SceneError` hors sous-ensemble. */
export function sceneFromSvg(svg: string): VectorScene {
  let i = svg.search(/<svg\b/);
  if (i < 0) throw new SceneError('élément <svg> absent');
  if (
    svg
      .slice(0, i)
      .replace(/<\?xml[^>]*\?>/, '')
      .trim() !== ''
  )
    throw new SceneError('contenu avant <svg>');
  let scene: VectorScene | null = null;
  let maskDepth = 0;
  let closed = false;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt < 0) {
      if (svg.slice(i).trim() !== '') throw new SceneError('texte hors balise');
      break;
    }
    if (svg.slice(i, lt).trim() !== '') throw new SceneError('texte hors balise');
    TAG.lastIndex = lt;
    const m = TAG.exec(svg);
    if (!m) throw new SceneError(`balise illisible en ${lt}`);
    i = TAG.lastIndex;
    const [, close, name, rawAttrs, self] = m;
    if (closed) throw new SceneError('contenu après </svg>');
    if (close) {
      if (name === 'mask') maskDepth--;
      else if (name === 'svg') closed = true;
      else throw new SceneError(`</${name!}> inattendu`);
      continue;
    }
    const a = attrsOf(rawAttrs!);
    if (!scene) {
      if (name !== 'svg') throw new SceneError('racine <svg> attendue');
      scene = {
        width: positive(a.get('width'), 'largeur'),
        height: positive(a.get('height'), 'hauteur'),
        fillRule: a.get('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero',
        items: [],
      };
      continue;
    }
    if (name === 'mask') {
      if (!self) maskDepth++;
      continue;
    }
    if (maskDepth > 0) continue; // contenu de la gomme : ni peint ni découpé
    if (name !== 'rect' && name !== 'path')
      throw new SceneError(`élément <${name!}> non pris en charge`);
    if (!self) throw new SceneError(`<${name}> non vide`);
    const fill = parseColor(a.get('fill') ?? '#000');
    const strokeRgb = parseColor(a.get('stroke'));
    const opacityRaw = a.get('fill-opacity');
    const item: SceneItem = {
      rgb: fill ?? strokeRgb ?? [0, 0, 0],
      fill: fill !== null,
      subpaths: [],
    };
    if (opacityRaw !== undefined) {
      const o = Number(opacityRaw);
      if (!(o >= 0 && o <= 1)) throw new SceneError(`fill-opacity invalide : « ${opacityRaw} »`);
      if (o < 1) item.opacity = o;
    }
    if (strokeRgb) {
      if (
        fill &&
        (strokeRgb[0] !== fill[0] || strokeRgb[1] !== fill[1] || strokeRgb[2] !== fill[2])
      )
        throw new SceneError('trait et remplissage de couleurs différentes');
      item.stroke = positive(a.get('stroke-width'), 'stroke-width');
      if (a.has('mask')) item.masked = true;
      else if (!fill && a.get('stroke-linecap') === 'round') item.centerline = true;
    }
    if (!item.fill && item.stroke === undefined) continue; // invisible
    if (name === 'rect') {
      const len = (v: string | undefined, full: number): number =>
        v === undefined ? 0 : v === '100%' ? full : Number(v);
      const x = len(a.get('x'), 0);
      const y = len(a.get('y'), 0);
      const w = len(a.get('width'), scene.width);
      const h = len(a.get('height'), scene.height);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
        throw new SceneError('<rect> invalide');
      item.subpaths.push(rectSubpath(x, y, w, h));
      item.background = true;
    } else {
      try {
        item.subpaths = parsePathData(a.get('d') ?? '');
      } catch (e) {
        throw new SceneError(e instanceof Error ? e.message : String(e));
      }
    }
    if (item.subpaths.length > 0) scene.items.push(item);
  }
  if (!scene) throw new SceneError('élément <svg> absent');
  if (!closed) throw new SceneError('</svg> absent');
  return scene;
}

/**
 * Nombre décimal sans exposant (PDF, PostScript et DXF n'en veulent pas), arrondi à
 * `decimals` : supprime le bruit flottant de `H − y` sans toucher aux décimales du SVG (4 au
 * plus). `-0` s'écrit `0`.
 */
export function fmtNum(v: number, decimals = 6): string {
  if (!Number.isFinite(v)) throw new SceneError(`coordonnée non finie : ${v}`);
  const k = 10 ** decimals;
  const r = Math.round(v * k) / k;
  if (r === 0) return '0';
  const s = r.toFixed(decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Sous-tracés peints d'une scène (remplissages et traits). */
export function countSubpaths(scene: VectorScene, filter?: (it: SceneItem) => boolean): number {
  let n = 0;
  for (const it of scene.items) if (!filter || filter(it)) n += it.subpaths.length;
  return n;
}

/**
 * Éléments peints en PDF et en EPS : un trait masqué (F1) est omis, faute de masque simple
 * dans ces formats ; il ne doit jamais couvrir la transparence (README « Décisions », T32).
 */
export function paintedItems(scene: VectorScene): SceneItem[] {
  const out: SceneItem[] = [];
  for (const it of scene.items) {
    if (!it.masked) out.push(it);
    else if (it.fill) {
      const fillOnly: SceneItem = { rgb: it.rgb, fill: true, subpaths: it.subpaths };
      if (it.opacity !== undefined) fillOnly.opacity = it.opacity;
      out.push(fillOnly);
    }
  }
  return out;
}

/**
 * Opérateurs de tracé communs au PDF et au PostScript (le prologue EPS définit `m l c h`) :
 * `x y m`, `x y l`, `x1 y1 x2 y2 x y c`, `h`. Axe Y inversé : `y' = height − y`.
 */
export function pathOps(subpaths: readonly ParsedSubpath[], height: number): string {
  const y = (v: number): string => fmtNum(height - v);
  const x = (v: number): string => fmtNum(v);
  const out: string[] = [];
  for (const sp of subpaths) {
    out.push(`${x(sp.start[0])} ${y(sp.start[1])} m`);
    for (const s of sp.segments) {
      if (s.kind === 'line') out.push(`${x(s.x)} ${y(s.y)} l`);
      else out.push(`${x(s.c1x)} ${y(s.c1y)} ${x(s.c2x)} ${y(s.c2y)} ${x(s.x)} ${y(s.y)} c`);
    }
    if (sp.closed) out.push('h');
  }
  return out.join('\n');
}

/** Composante 0..255 → 0..1, 4 décimales (×255 puis arrondi redonne l'entier). */
export function unit(c: number): string {
  return fmtNum(c / 255, 4);
}
