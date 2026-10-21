// T71 — Dégradation REPRODUCTIBLE des images d'exemple : l'« avant » qu'on reçoit vraiment (logo
// récupéré sur le web, scan d'un croquis, sprite agrandi puis recompressé). Code PUR sur tableaux
// typés : aucun fichier, aucun aléa non seedé, aucune dépendance (le JPEG, dernière étape, est
// fait par l'appelant avec le codec du dépôt, `jpeg-js`). Testé par `test/degrade.test.ts`.
import type { RasterImage } from '../../src/engine/types.ts';

/** Générateur pseudo-aléatoire seedé (mulberry32), dans [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function blank(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Échantillon bilinéaire (bords prolongés) du canal `c` au point continu (x, y) en pixels. */
function bilinear(img: RasterImage, x: number, y: number, c: number): number {
  const { width: w, height: h, data } = img;
  const fx = Math.min(Math.max(x - 0.5, 0), w - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[(y0 * w + x0) * 4 + c]!;
  const b = data[(y0 * w + x1) * 4 + c]!;
  const d = data[(y1 * w + x0) * 4 + c]!;
  const e = data[(y1 * w + x1) * 4 + c]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}

/**
 * Réduction par MOYENNE de boîte (chaque pixel de sortie moyenne la zone qu'il couvre) : ce que
 * fait un export « pour le web ». `width`, `height` plus petits que l'image.
 */
export function downscale(img: RasterImage, width: number, height: number): RasterImage {
  const out = blank(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      const acc = [0, 0, 0, 0];
      let total = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const wgt = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
          const o = (py * img.width + px) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += img.data[o + c]! * wgt;
          total += wgt;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = clamp8(acc[c]! / total);
    }
  }
  return out;
}

/** Agrandissement BILINÉAIRE (le « flou » d'une image agrandie par un logiciel ordinaire). */
export function upscaleBilinear(img: RasterImage, width: number, height: number): RasterImage {
  const out = blank(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++)
        out.data[o + c] = clamp8(bilinear(img, (x + 0.5) * sx, (y + 0.5) * sy, c));
    }
  }
  return out;
}

/** Agrandissement au PLUS PROCHE VOISIN d'un facteur entier (les pixels restent des carrés). */
export function upscaleNearest(img: RasterImage, factor: number): RasterImage {
  const out = blank(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      out.data.set(img.data.subarray(i, i + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/**
 * Flou d'une image passée par une petite taille : réduite d'un facteur `factor` (> 1) puis
 * ré-agrandie à sa taille d'origine. Les bords nets deviennent une rampe de `factor` pixels.
 */
export function blurByRescale(img: RasterImage, factor: number): RasterImage {
  const w = Math.max(1, Math.round(img.width / factor));
  const h = Math.max(1, Math.round(img.height / factor));
  return upscaleBilinear(downscale(img, w, h), img.width, img.height);
}

/**
 * Bruit léger (capteur, recompressions) : écart uniforme ±`amount` commun à R, G, B, plus un
 * écart propre à chaque canal de ±`chroma` (le bruit coloré d'un capteur).
 */
export function addNoise(img: RasterImage, amount: number, seed: number, chroma = 0): RasterImage {
  const rand = rng(seed);
  const out = blank(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() * 2 - 1) * amount;
    out.data[i] = clamp8(img.data[i]! + n + (rand() * 2 - 1) * chroma);
    out.data[i + 1] = clamp8(img.data[i + 1]! + n + (rand() * 2 - 1) * chroma);
    out.data[i + 2] = clamp8(img.data[i + 2]! + n + (rand() * 2 - 1) * chroma);
    out.data[i + 3] = img.data[i + 3]!;
  }
  return out;
}

/**
 * Rotation de `degrees` (sens horaire) autour du centre, rééchantillonnage bilinéaire ; les coins
 * découverts prennent la couleur `fill` (le capot du scanner).
 */
export function rotate(
  img: RasterImage,
  degrees: number,
  fill: readonly [number, number, number],
): RasterImage {
  const out = blank(img.width, img.height);
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = img.width / 2;
  const cy = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      // Point source : rotation inverse du centre du pixel de sortie.
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      const o = (y * img.width + x) * 4;
      if (sx < 0 || sy < 0 || sx > img.width || sy > img.height) {
        out.data[o] = fill[0];
        out.data[o + 1] = fill[1];
        out.data[o + 2] = fill[2];
      } else {
        for (let c = 0; c < 3; c++) out.data[o + c] = clamp8(bilinear(img, sx, sy, c));
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Numérisation d'un dessin à l'encre (fond blanc) : l'encre prend la teinte `ink`, le blanc
 * celle du papier, qui jaunit vers le bas à droite (`paper` → `paperEdge`) ; contraste ramené à
 * `contrast` (0..1 : l'encre la plus noire devient un gris), grain fin seedé de ±`grain`, fibres
 * (bruit lent), vignettage (`vignette` : assombrissement relatif des coins, 0..1) et éclairage
 * plus faible en haut à gauche.
 */
export function scanPaper(
  img: RasterImage,
  o: {
    paper: readonly [number, number, number];
    paperEdge: readonly [number, number, number];
    ink: readonly [number, number, number];
    contrast: number;
    grain: number;
    vignette: number;
    seed: number;
  },
): RasterImage {
  const rand = rng(o.seed);
  const { width: w, height: h } = img;
  // Fibres : bruit de valeur sur une grille grossière (8 px), interpolé.
  const G = 8;
  const gw = Math.ceil(w / G) + 2;
  const gh = Math.ceil(h / G) + 2;
  const coarse = new Float32Array(gw * gh);
  for (let i = 0; i < coarse.length; i++) coarse[i] = rand() * 2 - 1;
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / G;
      const gy = y / G;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const f =
        (coarse[y0 * gw + x0]! * (1 - tx) + coarse[y0 * gw + x0 + 1]! * tx) * (1 - ty) +
        (coarse[(y0 + 1) * gw + x0]! * (1 - tx) + coarse[(y0 + 1) * gw + x0 + 1]! * tx) * ty;
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h - 0.5;
      const light =
        (1 - o.vignette * Math.min(1, (u * u + v * v) * 2)) * (0.96 + 0.04 * ((u + v + 1) / 2));
      const age = (u + v + 1) / 2;
      const n = (rand() * 2 - 1) * o.grain + f * o.grain * 0.8;
      const i = (y * w + x) * 4;
      const lum =
        (img.data[i]! * 0.299 + img.data[i + 1]! * 0.587 + img.data[i + 2]! * 0.114) / 255;
      const k = (1 - lum) * o.contrast;
      for (let c = 0; c < 3; c++) {
        const p = o.paper[c]! + (o.paperEdge[c]! - o.paper[c]!) * age;
        out.data[i + c] = clamp8((p + (o.ink[c]! - p) * k) * light + n);
      }
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/** Nombre de couleurs RVB distinctes d'une image (l'alpha est ignoré). */
export function distinctColors(img: RasterImage): number {
  const seen = new Uint8Array(1 << 21);
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const k = (img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!;
    const byte = k >>> 3;
    const bit = 1 << (k & 7);
    if (!(seen[byte]! & bit)) {
      seen[byte]! |= bit;
      n++;
    }
  }
  return n;
}
