// T42 — Image SOURCE procédurale de l'ancienne démonstration « logo récupéré sur le web » de
// l'accueil : emblème à 5 couleurs, déterministe, aucune image tierce. T71 : l'accueil part
// désormais des exemples réalistes (`exemples.ts`) ; cet emblème reste la régression du préréglage
// Logo (T43, `test/logo-robust.test.ts`, qui recalcule son JPEG de qualité 70).
import type { RasterImage } from '../../src/engine/types.ts';

type Rgb = readonly [number, number, number];
/** Distance signée : négative dedans, en pixels. */
type Sdf = (x: number, y: number) => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Couverture anti-crénelée d'un pixel par une forme (bord flou d'un pixel). */
const cover = (d: number) => clamp01(0.5 - d);

// --- Primitives (distances signées) ------------------------------------------------------------

const circle =
  (cx: number, cy: number, r: number): Sdf =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;
const box =
  (x0: number, y0: number, x1: number, y1: number): Sdf =>
  (x, y) => {
    const dx = Math.max(x0 - x, x - x1);
    const dy = Math.max(y0 - y, y - y1);
    return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
  };
const inter =
  (...s: Sdf[]): Sdf =>
  (x, y) =>
    Math.max(...s.map((f) => f(x, y)));
const minus =
  (a: Sdf, b: Sdf): Sdf =>
  (x, y) =>
    Math.max(a(x, y), -b(x, y));
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
/** Polygone simple (exact) : distance aux arêtes, signe par parité. */
const polygon =
  (pts: readonly (readonly [number, number])[]): Sdf =>
  (x, y) => {
    let d = Infinity;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[j]!;
      d = Math.min(d, segDist(x, y, ax, ay, bx, by));
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside ? -d : d;
  };
/** Rotation d'une forme d'un angle a (radians) autour de (cx, cy). */
const rotate =
  (f: Sdf, cx: number, cy: number, a: number): Sdf =>
  (x, y) => {
    const c = Math.cos(-a);
    const s = Math.sin(-a);
    const dx = x - cx;
    const dy = y - cy;
    return f(cx + dx * c - dy * s, cy + dx * s + dy * c);
  };

// --- Rendu -------------------------------------------------------------------------------------

/** Couche peinte dans l'ordre : `shade` (facultatif) choisit la variante sombre de la teinte. */
interface Layer {
  shape: Sdf;
  color: Rgb;
  /** Distance signée de la zone d'ombre (aplat sombre) à l'intérieur de la forme. */
  shade?: { shape: Sdf; color: Rgb };
  /** Cerne sombre intérieur de cette épaisseur (px). */
  outline?: { width: number; color: Rgb };
}

/**
 * Peint les couches sur un fond, couverture analytique (un pixel de flou au bord) : c'est
 * l'anti-aliasing d'un export ordinaire. Échantillonné au centre du pixel.
 */
function paint(
  width: number,
  height: number,
  bg: Rgb,
  layers: readonly Layer[],
  /** Décalage vertical du dessin (px, positif = vers le haut). */
  lift = 0,
  /** Échelle du rendu : le dessin est décrit à l'échelle 1, rendu `scale` fois plus grand. */
  scale = 1,
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale + lift;
      let r = bg[0];
      let g = bg[1];
      let b = bg[2];
      for (const l of layers) {
        const d = l.shape(px, py) * scale;
        if (d > 1) continue;
        const mix = (c: Rgb, k: number) => {
          r += (c[0] - r) * k;
          g += (c[1] - g) * k;
          b += (c[2] - b) * k;
        };
        if (l.outline) {
          mix(l.outline.color, cover(d));
          const inner = cover(d + l.outline.width);
          if (inner === 0) continue;
          if (l.shade) {
            const s = cover(l.shade.shape(px, py) * scale);
            mix(l.color, inner * (1 - s));
            mix(l.shade.color, inner * s);
          } else mix(l.color, inner);
        } else {
          const k = cover(d);
          if (l.shade) {
            const s = cover(l.shade.shape(px, py) * scale);
            mix(l.color, k * (1 - s));
            mix(l.shade.color, k * s);
          } else mix(l.color, k);
        }
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(r);
      data[o + 1] = Math.round(g);
      data[o + 2] = Math.round(b);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Étoile à n branches. */
function star(cx: number, cy: number, ro: number, ri: number, n: number, a0: number): Sdf {
  const pts: [number, number][] = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = a0 + (i * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return polygon(pts);
}

// --- 1. Logo récupéré sur le web ---------------------------------------------------------------

export const LOGO_SIZE = 400;
/** Qualité JPEG de la recompression (le codec du dépôt, `jpeg-js`). */
export const LOGO_JPEG_QUALITY = 70;

/**
 * Emblème à 5 couleurs sur fond blanc : anneau marine, liseré blanc, disque sarcelle, bande
 * orange en diagonale, étoile jaune à cinq branches. Le JPEG (`encodeJpeg`, qualité 70)
 * est fait par l'appelant : c'est lui qui ajoute les blocs et la bavure autour des bords.
 */
export function logoSource(size = LOGO_SIZE): RasterImage {
  // Dessin décrit sur 320 px, rendu à `size` px.
  const c = 160;
  const navy: Rgb = [27, 42, 92];
  const teal: Rgb = [22, 150, 140];
  const orange: Rgb = [228, 78, 46];
  const yellow: Rgb = [250, 204, 44];
  const white: Rgb = [255, 255, 255];
  const disc = circle(c, c, 112);
  return paint(
    size,
    size,
    white,
    [
      { shape: minus(circle(c, c, 148), circle(c, c, 128)), color: navy },
      { shape: disc, color: teal },
      // Bande diagonale sous l'étoile, découpée par le disque.
      {
        shape: inter(disc, rotate(box(c - 200, c + 34, c + 200, c + 66), c, c, -0.2)),
        color: orange,
      },
      { shape: star(c, c - 30, 60, 25, 5, -Math.PI / 2), color: yellow },
    ],
    0,
    size / 320,
  );
}
