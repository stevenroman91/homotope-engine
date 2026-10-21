/**
 * T95 — Masque « encre » d'un dessin, relu dans la SCÈNE du SVG émis (`sceneFromSvg`, T32) :
 * l'atelier (calcul local OU serveur, résultat rouvert de la galerie) et l'API n'ont en commun
 * que ce SVG ; le masque se calcule donc partout pareil, sans carte de labels.
 *
 * Fond : la règle de la scène d'export. Le `<rect>` de fond (couleur du papier, `exportSvg`) et
 * ce qui n'est pas peint (région transparente en `alphaMode: keep`) sont du fond. Sans `<rect>`
 * ni transparence au bord (préréglages « Noir et blanc », sans `<rect>`), le papier est la couleur
 * VISIBLE majoritaire sur le bord de l'image ; tout ce qui est peint d'une autre couleur est de
 * l'encre (README, « Décisions › Contour de découpe sticker (T95) »).
 *
 * Rendu au peintre (ordre du SVG) : le dernier élément qui couvre le centre d'un pixel en donne
 * la couleur visible. Remplissages par balayage de lignes (règle `evenodd` / `nonzero` de la
 * scène) ; traits d'axe du centre-ligne (T33) à leur épaisseur ; traits anti-liseré, gomme et
 * contour de découpe ignorés. Pur, tableaux typés.
 */
import { colorKey } from '../export/dxf.ts';
import { flattenSubpath } from '../export/polyline.ts';
import type { SceneItem, VectorScene } from '../export/scene.ts';

/** Grille du masque : `px = x · scale + pad` (x en px de l'image d'origine). */
export interface MaskGrid {
  width: number;
  height: number;
  scale: number;
  pad: number;
}

/** Aplatissement des courbes : écart max à la courbe, en px de la grille. */
const FLATTEN_PX = 0.25;

/** Index de l'élément VISIBLE par pixel de la grille (−1 : rien de peint). */
export function visibleItems(scene: VectorScene, grid: MaskGrid): Int32Array {
  const vis = new Int32Array(grid.width * grid.height).fill(-1);
  scene.items.forEach((it, k) => {
    if (it.cutcontour) return;
    if (it.fill) fillItem(it, k, scene.fillRule, grid, vis);
    else if (it.centerline) strokeItem(it, k, grid, vis);
  });
  return vis;
}

/** Remplit (au peintre) les pixels dont le centre est dans le tracé. */
function fillItem(
  it: SceneItem,
  k: number,
  rule: VectorScene['fillRule'],
  g: MaskGrid,
  vis: Int32Array,
): void {
  const tol = FLATTEN_PX / g.scale;
  // Arêtes : y0 < y1, x en y0, pente, sens (+1 descendant, −1 montant).
  const ey0: number[] = [];
  const ey1: number[] = [];
  const ex0: number[] = [];
  const edx: number[] = [];
  const edir: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const sp of it.subpaths) {
    const pts = flattenSubpath(sp, tol);
    const n = pts.length / 2;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const xa = pts[2 * i]! * g.scale + g.pad;
      const ya = pts[2 * i + 1]! * g.scale + g.pad;
      const xb = pts[2 * j]! * g.scale + g.pad;
      const yb = pts[2 * j + 1]! * g.scale + g.pad;
      if (ya === yb) continue;
      const down = ya < yb;
      const y0 = down ? ya : yb;
      const y1 = down ? yb : ya;
      ey0.push(y0);
      ey1.push(y1);
      ex0.push(down ? xa : xb);
      edx.push((xb - xa) / (yb - ya));
      edir.push(down ? 1 : -1);
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
    }
  }
  const m = ey0.length;
  if (m === 0) return;
  const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => ey0[a]! - ey0[b]!);
  const W = g.width;
  const rowFirst = Math.max(0, Math.ceil(minY - 0.5));
  const rowLast = Math.min(g.height - 1, Math.floor(maxY - 0.5));
  let next = 0;
  let active: number[] = [];
  const xs: number[] = [];
  const ds: number[] = [];
  const idx: number[] = [];
  for (let row = rowFirst; row <= rowLast; row++) {
    const yc = row + 0.5;
    while (next < m && ey0[order[next]!]! <= yc) active.push(order[next++]!);
    active = active.filter((e) => ey1[e]! > yc);
    if (active.length === 0) continue;
    xs.length = 0;
    ds.length = 0;
    idx.length = 0;
    for (const e of active) {
      if (ey0[e]! > yc) continue;
      xs.push(ex0[e]! + (yc - ey0[e]!) * edx[e]!);
      ds.push(edir[e]!);
      idx.push(idx.length);
    }
    idx.sort((a, b) => xs[a]! - xs[b]!);
    let wind = 0;
    for (let q = 0; q < idx.length - 1; q++) {
      const c = idx[q]!;
      wind += rule === 'evenodd' ? 1 : ds[c]!;
      const inside = rule === 'evenodd' ? (wind & 1) === 1 : wind !== 0;
      if (!inside) continue;
      const xa = xs[c]!;
      const xb = xs[idx[q + 1]!]!;
      const i0 = Math.max(0, Math.ceil(xa - 0.5));
      const i1 = Math.min(W - 1, Math.ceil(xb - 0.5) - 1);
      const base = row * W;
      for (let i = i0; i <= i1; i++) vis[base + i] = k;
    }
  }
}

/** Trait d'axe (T33) : pixels dont le centre est à ≤ demi-épaisseur de la polyligne. */
function strokeItem(it: SceneItem, k: number, g: MaskGrid, vis: Int32Array): void {
  const hw = Math.max(0.5, ((it.stroke ?? 1) / 2) * g.scale);
  const hw2 = hw * hw;
  const W = g.width;
  const H = g.height;
  for (const sp of it.subpaths) {
    const pts = flattenSubpath(sp, FLATTEN_PX / g.scale);
    const n = pts.length / 2;
    const segs = sp.closed ? n : n - 1;
    for (let i = 0; i < Math.max(1, segs); i++) {
      const j = Math.min(n - 1, sp.closed ? (i + 1) % n : i + 1);
      const ax = pts[2 * i]! * g.scale + g.pad;
      const ay = pts[2 * i + 1]! * g.scale + g.pad;
      const bx = pts[2 * j]! * g.scale + g.pad;
      const by = pts[2 * j + 1]! * g.scale + g.pad;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + hw));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + hw));
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * dx - px;
          const qy = ay + t * dy - py;
          if (qx * qx + qy * qy <= hw2) vis[y * W + x] = k;
        }
      }
    }
  }
}

/**
 * Couleur du papier (`#rrggbb`), ou `null` quand le fond est la seule transparence : le
 * `<rect>` de fond s'il existe ; sinon, la couleur visible la plus fréquente sur le bord de
 * l'image (échantillonné à 1 px d'origine), sauf si c'est « rien de peint ».
 */
export function paperColor(scene: VectorScene, vis: Int32Array, grid: MaskGrid): string | null {
  const rect = scene.items.find((it) => it.background);
  if (rect) return colorKey(rect.rgb);
  const w = Math.max(1, Math.round(scene.width));
  const h = Math.max(1, Math.round(scene.height));
  const counts = new Map<string, number>();
  const sample = (x: number, y: number): void => {
    const i = Math.min(grid.width - 1, Math.floor((x + 0.5) * grid.scale + grid.pad));
    const j = Math.min(grid.height - 1, Math.floor((y + 0.5) * grid.scale + grid.pad));
    const v = vis[j * grid.width + i]!;
    const key = v < 0 ? '' : colorKey(scene.items[v]!.rgb);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    sample(x, 0);
    if (h > 1) sample(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    sample(0, y);
    if (w > 1) sample(w - 1, y);
  }
  let best = '';
  let bestN = counts.get('') ?? 0;
  for (const [key, n] of counts) if (key !== '' && n > bestN) [best, bestN] = [key, n];
  return best === '' ? null : best;
}

/**
 * Masque « encre » (1 = pixel visible qui n'est PAS le fond) sur la grille `grid`. Le fond suit
 * la règle de la scène d'export (voir l'en-tête).
 */
export function inkMask(scene: VectorScene, grid: MaskGrid): Uint8Array {
  const vis = visibleItems(scene, grid);
  const paper = paperColor(scene, vis, grid);
  const ink = new Uint8Array(vis.length);
  const isInk = scene.items.map(
    (it) => !it.background && !it.cutcontour && colorKey(it.rgb) !== paper,
  );
  for (let i = 0; i < vis.length; i++) {
    const v = vis[i]!;
    if (v >= 0 && isInk[v]) ink[i] = 1;
  }
  return ink;
}
