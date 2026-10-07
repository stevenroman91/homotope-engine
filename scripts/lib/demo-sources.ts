// T42 — Images SOURCES des démonstrations « Avant, après » de l'accueil, PROCÉDURALES et
// déterministes : formes géométriques et tracés, aucune image tierce, aucune police, aucun aléa
// non seedé. Elles imitent ce qu'on reçoit vraiment : un logo récupéré sur le web (petit, lissé,
// recompressé en JPEG), une illustration en aplats ombrés cernée de sombre, un croquis au trait
// scanné (papier gris, grain, éclairage inégal). Écrites par `npm run accueil`, contrôlées par
// le test de l'accueil.
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
/** Ellipse : distance approchée au premier ordre (k − 1) / |∇k|, juste à un pixel près du bord. */
const ellipse =
  (cx: number, cy: number, rx: number, ry: number): Sdf =>
  (x, y) => {
    const u = (x - cx) / rx;
    const v = (y - cy) / ry;
    const k = Math.hypot(u, v);
    const g = Math.hypot(u / rx, v / ry) / Math.max(k, 1e-9);
    return (k - 1) / Math.max(g, 1e-9);
  };
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
/** Demi-plan à gauche de la droite orientée (ax, ay) → (bx, by). */
const half =
  (ax: number, ay: number, bx: number, by: number): Sdf =>
  (x, y) => {
    const l = Math.hypot(bx - ax, by - ay);
    return ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / l;
  };

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

/** Générateur pseudo-aléatoire seedé (mulberry32), dans [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// --- 2. Illustration : plante en pot -----------------------------------------------------------

export const ILLUSTRATION_SIZE = 600;

/**
 * Plante en pot, aplats ombrés (deux valeurs par teinte), cerne brun foncé de 5 px : fond crème,
 * ombre portée, pot terre cuite (clair / sombre), rebord, terreau, feuilles vertes (clair /
 * sombre), tige. Onze couleurs, anti-crénelage aux bords.
 */
export function illustrationSource(): RasterImage {
  const S = ILLUSTRATION_SIZE;
  const ink: Rgb = [52, 36, 30];
  const outline = { width: 5, color: ink };
  const cream: Rgb = [247, 238, 220];
  const floor: Rgb = [206, 186, 168];
  const clay: Rgb = [214, 112, 70];
  const clayDark: Rgb = [166, 76, 48];
  const soil: Rgb = [126, 86, 58];
  const leaf: Rgb = [112, 178, 92];
  const leafDark: Rgb = [58, 128, 72];
  const stem: Rgb = [146, 132, 58];
  const sun: Rgb = [250, 184, 40];
  const cx = 300;
  const base = 322;
  // Ombre à droite de la ligne verticale x0 (lumière venant de la gauche).
  const right = (x0: number): Sdf => half(x0, 600, x0, 0);
  /**
   * Feuille au bout d'une tige partant de (cx, base) : lentille entre deux cercles, d'axe la
   * direction de la tige, moitié droite de la nervure dans l'ombre.
   */
  const stems: [number, number][] = [
    [-128, 236],
    [-64, 176],
    [4, 156],
    [70, 172],
    [126, 240],
  ];
  const plant: Layer[] = [];
  for (const [dx, y] of stems) {
    const x = cx + dx;
    const ang = Math.atan2(y - base, x - cx);
    const len = Math.hypot(x - cx, y - base);
    plant.push({
      shape: rotate(box(cx, base - 7, cx + len, base + 7), cx, base, ang),
      color: stem,
      outline: { width: 3, color: ink },
    });
  }
  for (const [dx, y] of stems) {
    const x = cx + dx;
    const ang = Math.atan2(y - base, x - cx);
    const L = 60;
    const lx = x + Math.cos(ang) * (L - 12);
    const ly = y + Math.sin(ang) * (L - 12);
    const R = L * 1.2;
    const e = R - L * 0.42;
    plant.push({
      shape: rotate(inter(circle(lx, ly - e, R), circle(lx, ly + e, R)), lx, ly, ang),
      color: leaf,
      shade: { shape: rotate(half(lx - 200, ly, lx + 200, ly), lx, ly, ang), color: leafDark },
      outline,
    });
  }
  const layers: Layer[] = [
    // Soleil dans le coin, pour une teinte de plus sans dégradé.
    { shape: circle(500, 84, 40), color: sun, outline },
    { shape: ellipse(cx + 24, 540, 196, 24), color: floor },
    ...plant,
    // Terreau (seule sa moitié haute dépasse du rebord), pot (trapèze), rebord.
    { shape: ellipse(cx, base, 124, 16), color: soil, outline },
    {
      shape: polygon([
        [cx - 120, 360],
        [cx + 120, 360],
        [cx + 90, 540],
        [cx - 90, 540],
      ]),
      color: clay,
      shade: { shape: right(cx + 40), color: clayDark },
      outline,
    },
    {
      shape: box(cx - 140, base, cx + 140, 372),
      color: clay,
      shade: { shape: right(cx + 60), color: clayDark },
      outline,
    },
  ];
  // Remonté de 30 px : l'étiquette des cartes de l'accueil couvre le bas de l'image.
  return paint(S, S, cream, layers, 30);
}

// --- 3. Croquis scanné -------------------------------------------------------------------------

export const SKETCH_SIZE = 700;
/** Qualité JPEG du « scan » (réglage courant d'un scanner de bureau). */
export const SKETCH_JPEG_QUALITY = 80;

/**
 * Lampe d'architecte dessinée au feutre, scannée : traits de 2 à 4 px d'épaisseur variable et
 * légèrement tremblés, sur un papier gris clair avec grain et éclairage inégal du scanner
 * (plus sombre en haut à gauche). Le tracé est une liste de polylignes ; l'encre est un gris
 * très foncé, pas un noir pur.
 */
export function sketchSource(): RasterImage {
  const S = SKETCH_SIZE;
  const rand = rng(42);
  const strokes: [number, number][][] = [];
  /** Courbe paramétrée échantillonnée tous les ~3 px, avec un tremblement lent de la main. */
  const curve = (f: (t: number) => [number, number], len: number) => {
    const n = Math.max(2, Math.ceil(len / 3));
    const phase = rand() * 6.28;
    const amp = 0.6 + rand() * 0.6;
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [x, y] = f(t);
      const w = amp * Math.sin(phase + t * len * 0.045);
      // Remonté de 60 px : l'étiquette des cartes de l'accueil couvre le bas de l'image.
      pts.push([x + w, y + w * 0.7 - 60]);
    }
    strokes.push(pts);
  };
  const line = (ax: number, ay: number, bx: number, by: number) =>
    curve((t) => [ax + (bx - ax) * t, ay + (by - ay) * t], Math.hypot(bx - ax, by - ay));
  const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number) =>
    curve(
      (t) => [cx + rx * Math.cos(a0 + (a1 - a0) * t), cy + ry * Math.sin(a0 + (a1 - a0) * t)],
      Math.abs(a1 - a0) * Math.max(rx, ry),
    );

  // Socle : ellipse (dessus) et tranche.
  arc(240, 600, 130, 30, 0, 2 * Math.PI);
  line(110, 600, 110, 624);
  line(370, 600, 370, 624);
  arc(240, 624, 130, 30, 0, Math.PI);
  /**
   * Bras : deux traits parallèles à ±h de l'axe A → B, arrêtés sur les cercles de rayon rA et rB
   * (articulations) : des jonctions nettes, comme un dessinateur soigneux.
   */
  const arm = (
    ax: number,
    ay: number,
    ra: number,
    bx: number,
    by: number,
    rb: number,
    h: number,
  ) => {
    const l = Math.hypot(bx - ax, by - ay);
    const [ux, uy] = [(bx - ax) / l, (by - ay) / l];
    const sa = Math.sqrt(Math.max(0, ra * ra - h * h));
    const sb = Math.sqrt(Math.max(0, rb * rb - h * h));
    for (const k of [-h, h]) {
      line(
        ax + ux * sa - uy * k,
        ay + uy * sa + ux * k,
        bx - ux * sb - uy * k,
        by - uy * sb + ux * k,
      );
    }
  };
  // Bras inférieur, articulation, bras supérieur ; bouton sur le socle.
  arm(242, 594, 0, 328, 326, 22, 10);
  arc(328, 326, 22, 22, 0, 2 * Math.PI);
  arm(328, 326, 22, 462, 182, 14, 8);
  arc(186, 598, 9, 5, 0, 2 * Math.PI);
  // Abat-jour : cône d'axe d (vers le bas à droite) partant de la tête, ouverture elliptique.
  const [hx, hy] = [462, 182];
  const d = [Math.cos(1.05), Math.sin(1.05)] as const;
  const p = [d[1], -d[0]] as const;
  const at = (s: number, q: number): [number, number] => [
    hx + d[0] * s + p[0] * q,
    hy + d[1] * s + p[1] * q,
  ];
  /** Ellipse dans le repère (d, p) : centre à s le long de l'axe, demi-axes q (travers), w. */
  const ring = (s: number, q: number, w: number, a0: number, a1: number) =>
    curve(
      (t) => {
        const a = a0 + (a1 - a0) * t;
        return at(s + w * Math.sin(a), q * Math.cos(a));
      },
      Math.abs(a1 - a0) * q,
    );
  line(...at(0, 22), ...at(120, 74));
  line(...at(0, -22), ...at(120, -74));
  ring(0, 22, 8, 0, 2 * Math.PI);
  ring(120, 74, 22, 0, 2 * Math.PI);
  // Rayons de lumière : trois traits courts dans l'axe.
  line(...at(178, -40), ...at(226, -56));
  line(...at(184, 0), ...at(236, 0));
  line(...at(178, 40), ...at(226, 56));

  // Encre : distance au trait le plus proche, rayon variable le long du trait (2 à 4 px).
  const ink = new Float32Array(S * S).fill(-1);
  for (const pts of strokes) {
    const r0 = 1 + rand() * 0.6;
    const r1 = 1.4 + rand() * 0.6;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      const t = i / pts.length;
      const radius = r0 + (r1 - r0) * Math.sin(t * Math.PI) + 0.25 * Math.sin(i * 0.9);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 2));
      const x1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx) + radius + 2));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius - 2));
      const y1 = Math.min(S - 1, Math.ceil(Math.max(ay, by) + radius + 2));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = cover(segDist(x + 0.5, y + 0.5, ax, ay, bx, by) - radius);
          const o = y * S + x;
          if (k > ink[o]!) ink[o] = k;
        }
      }
    }
  }

  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Papier : gris clair, plus sombre en haut à gauche (éclairage du scanner), grain.
      const light = 0.5 * (x / S) + 0.5 * (y / S);
      const grain = (rand() - 0.5) * 18;
      const paper = 214 + 26 * light + grain;
      const inkTone = 46 + (rand() - 0.5) * 16;
      const k = Math.max(0, ink[y * S + x]!);
      const v = paper + (inkTone - paper) * k;
      const o = (y * S + x) * 4;
      data[o] = Math.round(v + 3);
      data[o + 1] = Math.round(v + 1);
      data[o + 2] = Math.round(v - 4);
      data[o + 3] = 255;
    }
  }
  return { width: S, height: S, data };
}
