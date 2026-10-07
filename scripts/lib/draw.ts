/**
 * Petit rasteriseur de formes pour générer les fixtures, sans dépendance
 * canvas. Déterministe : mêmes appels → mêmes pixels.
 *
 * Repère : le pixel (x, y) occupe [x, x+1] × [y, y+1]. La couverture d'un
 * pixel est estimée par `ss × ss` échantillons répartis régulièrement ;
 * `ss = 1` échantillonne le centre seul → AUCUN anti-aliasing.
 */
import type { RasterImage, Rgb } from '../../src/engine/types.ts';

export type BBox = readonly [x0: number, y0: number, x1: number, y1: number];

export interface Shape {
  /** Boîte englobante (continue) de la forme. */
  readonly bbox: BBox;
  contains(x: number, y: number): boolean;
}

export type Paint = Rgb | ((x: number, y: number) => Rgb);

// ---------------------------------------------------------------------------
// Formes
// ---------------------------------------------------------------------------

export function rect(x0: number, y0: number, x1: number, y1: number): Shape {
  return { bbox: [x0, y0, x1, y1], contains: (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 };
}

export function disk(cx: number, cy: number, r: number): Shape {
  const r2 = r * r;
  return {
    bbox: [cx - r, cy - r, cx + r, cy + r],
    contains: (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) < r2,
  };
}

/** Anneau elliptique (rayons extérieurs rx, ry ; intérieurs irx, iry). */
export function ellipseRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  irx: number,
  iry: number,
): Shape {
  return {
    bbox: [cx - rx, cy - ry, cx + rx, cy + ry],
    contains: (x, y) => {
      const ox = (x - cx) / rx;
      const oy = (y - cy) / ry;
      if (ox * ox + oy * oy >= 1) return false;
      const ix = (x - cx) / irx;
      const iy = (y - cy) / iry;
      return ix * ix + iy * iy >= 1;
    },
  };
}

export function ring(cx: number, cy: number, rInner: number, rOuter: number): Shape {
  return ellipseRing(cx, cy, rOuter, rOuter, rInner, rInner);
}

/**
 * Polygone à plusieurs contours (`[x0, y0, x1, y1, …]` chacun), règle
 * pair-impair : un contour intérieur fait un trou.
 */
export function polygon(...contours: number[][]): Shape {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours) {
    for (let i = 0; i < c.length; i += 2) {
      x0 = Math.min(x0, c[i]!);
      x1 = Math.max(x1, c[i]!);
      y0 = Math.min(y0, c[i + 1]!);
      y1 = Math.max(y1, c[i + 1]!);
    }
  }
  return {
    bbox: [x0, y0, x1, y1],
    contains: (x, y) => {
      let inside = false;
      for (const c of contours) {
        const n = c.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = c[2 * i]!;
          const yi = c[2 * i + 1]!;
          const xj = c[2 * j]!;
          const yj = c[2 * j + 1]!;
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      return inside;
    },
  };
}

/**
 * (T33) Trait d'épaisseur `width` le long d'une polyligne `[x0, y0, x1, y1, …]`
 * (bouts ronds) : points à moins de `width / 2` d'un de ses segments.
 */
export function strokeLine(points: readonly number[], width: number, closed = false): Shape {
  const r = width / 2;
  const r2 = r * r;
  const p = closed ? [...points, points[0]!, points[1]!] : [...points];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]!);
    x1 = Math.max(x1, p[i]!);
    y0 = Math.min(y0, p[i + 1]!);
    y1 = Math.max(y1, p[i + 1]!);
  }
  return {
    bbox: [x0 - r, y0 - r, x1 + r, y1 + r],
    contains: (x, y) => {
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i]!;
        const ay = p[i + 1]!;
        const dx = p[i + 2]! - ax;
        const dy = p[i + 3]! - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const ex = ax + t * dx - x;
        const ey = ay + t * dy - y;
        if (ex * ex + ey * ey < r2) return true;
      }
      return false;
    },
  };
}

/** (T33) Échantillonne une cubique de Bézier en `steps` segments : `[x0, y0, …]`. */
export function cubicPoints(
  x0: number,
  y0: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x1: number,
  y1: number,
  steps = 32,
): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push(
      u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1,
      u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1,
    );
  }
  return out;
}

/** (T33) Cercle échantillonné en polygone de `steps` côtés (fermé implicitement). */
export function circlePoints(cx: number, cy: number, r: number, steps = 64): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Union de formes (évite les liserés de couverture partielle entre morceaux). */
export function union(...shapes: Shape[]): Shape {
  return {
    bbox: [
      Math.min(...shapes.map((s) => s.bbox[0])),
      Math.min(...shapes.map((s) => s.bbox[1])),
      Math.max(...shapes.map((s) => s.bbox[2])),
      Math.max(...shapes.map((s) => s.bbox[3])),
    ],
    contains: (x, y) => shapes.some((s) => s.contains(x, y)),
  };
}

/** Mise à l'échelle `k` puis translation (ox, oy) : p' = p·k + o. */
export function transform(shape: Shape, k: number, ox = 0, oy = 0): Shape {
  const [a, b, c, d] = shape.bbox;
  return {
    bbox: [a * k + ox, b * k + oy, c * k + ox, d * k + oy],
    contains: (x, y) => shape.contains((x - ox) / k, (y - oy) / k),
  };
}

// ---------------------------------------------------------------------------
// Peintures
// ---------------------------------------------------------------------------

function mix(c0: Rgb, c1: Rgb, t: number): Rgb {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
}

export function linearGradient(
  x0: number,
  y0: number,
  c0: Rgb,
  x1: number,
  y1: number,
  c1: Rgb,
): Paint {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  return (x, y) => mix(c0, c1, ((x - x0) * dx + (y - y0) * dy) / len2);
}

export function radialGradient(cx: number, cy: number, r: number, c0: Rgb, c1: Rgb): Paint {
  return (x, y) => mix(c0, c1, Math.hypot(x - cx, y - cy) / r);
}

// ---------------------------------------------------------------------------
// Toile
// ---------------------------------------------------------------------------

/** Toile en flottants : couleur 0..255 non prémultipliée, alpha 0..1. */
export class Canvas {
  readonly data: Float64Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Float64Array(width * height * 4);
  }

  /** Remplit toute la toile d'une peinture opaque. */
  background(paint: Paint): this {
    return this.fill(rect(0, 0, this.width, this.height), paint, { ss: 1 });
  }

  /** Composition « over » de la forme peinte, couverture par sur-échantillonnage. */
  fill(shape: Shape, paint: Paint, opts: { ss?: number; opacity?: number } = {}): this {
    const ss = opts.ss ?? 1;
    const opacity = opts.opacity ?? 1;
    const [bx0, by0, bx1, by1] = shape.bbox;
    const x0 = Math.max(0, Math.floor(bx0));
    const y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(this.width, Math.ceil(bx1) + 1);
    const y1 = Math.min(this.height, Math.ceil(by1) + 1);
    const d = this.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            if (shape.contains(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hits++;
          }
        }
        if (hits === 0) continue;
        const as = (hits / (ss * ss)) * opacity;
        const c = typeof paint === 'function' ? paint(x + 0.5, y + 0.5) : paint;
        const p = (y * this.width + x) * 4;
        const ad = d[p + 3]!;
        const ao = as + ad * (1 - as);
        for (let k = 0; k < 3; k++) {
          d[p + k] = (c[k]! * as + d[p + k]! * ad * (1 - as)) / ao;
        }
        d[p + 3] = ao;
      }
    }
    return this;
  }

  /** Ajoute un bruit gaussien (σ en niveaux) aux canaux couleur. */
  noise(sigma: number, rng: () => number): this {
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) d[i + k] = d[i + k]! + sigma * gaussian(rng);
    }
    return this;
  }

  toRaster(): RasterImage {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      out[i + 3] = Math.round(a * 255);
      if (out[i + 3] === 0) continue;
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(d[i + k]!);
    }
    return { width: this.width, height: this.height, data: out };
  }
}

/** Réduction par moyenne de blocs f×f (images opaques). */
export function downsampleBox(img: RasterImage, f: number): RasterImage {
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (let yy = 0; yy < f; yy++) {
          for (let xx = 0; xx < f; xx++)
            s += img.data[((y * f + yy) * img.width + x * f + xx) * 4 + k]!;
        }
        out[(y * w + x) * 4 + k] = Math.round(s / (f * f));
      }
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Aléa seedé
// ---------------------------------------------------------------------------

/** PRNG mulberry32 (domaine public) : uniforme dans [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussienne centrée réduite (Box-Muller). */
export function gaussian(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
