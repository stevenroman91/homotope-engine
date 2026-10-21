/**
 * T06 — Métriques de l'évaluation automatique (Node uniquement).
 *
 * Toutes les fonctions sont pures sur `RasterImage` / tableaux typés, sauf
 * `rasterizeSvg` qui délègue à `@resvg/resvg-js` (MPL-2.0, dépendance de
 * développement : jamais livrée dans l'application).
 */
import { Resvg } from '@resvg/resvg-js';
import { rgbaToOklabArray, rgbToOklab } from '../engine/color/oklab.ts';
import { flattenSubpath } from '../engine/export/polyline.ts';
import { segment } from '../engine/segment/index.ts';
import { parsePathData, type ParsedSubpath } from '../engine/svg/parse.ts';
import { countHoles } from '../engine/topology/index.ts';
import type { LabelMap, Palette, RasterImage, Rgb } from '../engine/types.ts';

// ---------------------------------------------------------------------------
// Rastérisation
// ---------------------------------------------------------------------------

/**
 * Rastérise un SVG à `width` px de large (hauteur selon le viewBox) avec resvg.
 * Fond transparent conservé ; resvg rend du RGBA PRÉMULTIPLIÉ, on le
 * dé-prémultiplie pour respecter le contrat `RasterImage`.
 */
export function rasterizeSvg(svg: string, width: number): RasterImage {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
    logLevel: 'off',
  }).render();
  const src = rendered.pixels;
  const data = new Uint8ClampedArray(src.length);
  for (let p = 0; p < src.length; p += 4) {
    const a = src[p + 3]!;
    data[p + 3] = a;
    if (a === 0) continue;
    if (a === 255) {
      data[p] = src[p]!;
      data[p + 1] = src[p + 1]!;
      data[p + 2] = src[p + 2]!;
    } else {
      data[p] = Math.round((src[p]! * 255) / a);
      data[p + 1] = Math.round((src[p + 1]! * 255) / a);
      data[p + 2] = Math.round((src[p + 2]! * 255) / a);
    }
  }
  return { width: rendered.width, height: rendered.height, data };
}

/** Composition « over » sur un fond uni (alpha résultant = 255). */
export function compositeOver(img: RasterImage, bg: Rgb): RasterImage {
  const n = img.width * img.height;
  const d = img.data;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n * 4; p += 4) {
    const a = d[p + 3]! / 255;
    out[p] = d[p]! * a + bg[0] * (1 - a);
    out[p + 1] = d[p + 1]! * a + bg[1] * (1 - a);
    out[p + 2] = d[p + 2]! * a + bg[2] * (1 - a);
    out[p + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

function assertSameSize(a: RasterImage, b: RasterImage, what: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${what} : ${a.width}×${a.height} ≠ ${b.width}×${b.height}`);
  }
}

// ---------------------------------------------------------------------------
// Erreur par pixel
// ---------------------------------------------------------------------------

export interface PixelError {
  /** Distance euclidienne RGB 8 bits (0..441), moyenne puis 95e centile. */
  meanRgb: number;
  p95Rgb: number;
  maxRgb: number;
  /** Distance euclidienne OKLab, moyenne puis 95e centile. */
  meanOklab: number;
  p95Oklab: number;
  /** Pixels mesurés (opaques dans la source). */
  pixels: number;
  /** Pixels dont la couleur diffère (distance RGB > 0). */
  differing: number;
  /** Distance RGB par pixel (0 hors masque) : sert à la carte d'erreur. */
  perPixel: Float32Array;
}

/**
 * Erreur entre `render` et `source`, tous deux composés sur `background`,
 * mesurée sur les pixels dont l'alpha SOURCE ≥ `alphaMin` (« opaques »).
 * Un pixel non couvert par le SVG ressort donc en couleur de fond : il compte.
 */
export function pixelError(
  render: RasterImage,
  source: RasterImage,
  background: Rgb = [255, 255, 255],
  alphaMin = 128,
): PixelError {
  assertSameSize(render, source, 'pixelError');
  const n = source.width * source.height;
  const r = compositeOver(render, background).data;
  const s = compositeOver(source, background).data;
  const labR = new Float32Array(n * 3);
  const labS = new Float32Array(n * 3);
  rgbaToOklabArray(r, labR);
  rgbaToOklabArray(s, labS);
  const perPixel = new Float32Array(n);
  const rgbList: number[] = [];
  const labList: number[] = [];
  let sumRgb = 0;
  let sumLab = 0;
  let maxRgb = 0;
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (source.data[i * 4 + 3]! < alphaMin) continue;
    const p = i * 4;
    const dr = r[p]! - s[p]!;
    const dg = r[p + 1]! - s[p + 1]!;
    const db = r[p + 2]! - s[p + 2]!;
    const dRgb = Math.sqrt(dr * dr + dg * dg + db * db);
    const o = i * 3;
    const dL = labR[o]! - labS[o]!;
    const da = labR[o + 1]! - labS[o + 1]!;
    const dB = labR[o + 2]! - labS[o + 2]!;
    const dLab = Math.sqrt(dL * dL + da * da + dB * dB);
    perPixel[i] = dRgb;
    rgbList.push(dRgb);
    labList.push(dLab);
    sumRgb += dRgb;
    sumLab += dLab;
    if (dRgb > maxRgb) maxRgb = dRgb;
    if (dRgb > 0) differing++;
  }
  const m = rgbList.length;
  return {
    meanRgb: m ? sumRgb / m : 0,
    p95Rgb: percentile(rgbList, 0.95),
    maxRgb,
    meanOklab: m ? sumLab / m : 0,
    p95Oklab: percentile(labList, 0.95),
    pixels: m,
    differing,
    perPixel,
  };
}

/** Centile par rang le plus proche (0 si vide). */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[k]!;
}

// ---------------------------------------------------------------------------
// SSIM
// ---------------------------------------------------------------------------

/** Luminance (Rec. 601) d'une image composée sur `background`, 0..255. */
export function toGray(img: RasterImage, background: Rgb = [255, 255, 255]): Float64Array {
  const c = compositeOver(img, background).data;
  const n = img.width * img.height;
  const g = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = 0.299 * c[p]! + 0.587 * c[p + 1]! + 0.114 * c[p + 2]!;
  }
  return g;
}

const SSIM_RADIUS = 3; // fenêtre 7×7
const SSIM_SIGMA = 1.5;
const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

const GAUSS7: Float64Array = (() => {
  const k = new Float64Array(2 * SSIM_RADIUS + 1);
  let s = 0;
  for (let i = -SSIM_RADIUS; i <= SSIM_RADIUS; i++) {
    const v = Math.exp(-(i * i) / (2 * SSIM_SIGMA * SSIM_SIGMA));
    k[i + SSIM_RADIUS] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / s;
  return k;
})();

/**
 * Flou gaussien séparable 7×7, fenêtres VALIDES uniquement (pas de bord) :
 * sortie (w−6)×(h−6).
 */
function blurValid(src: Float64Array, w: number, h: number): Float64Array {
  const R = SSIM_RADIUS;
  const ow = w - 2 * R;
  const oh = h - 2 * R;
  const tmp = new Float64Array(ow * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let k = 0; k <= 2 * R; k++) s += GAUSS7[k]! * src[row + x + k]!;
      tmp[y * ow + x] = s;
    }
  }
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let k = 0; k <= 2 * R; k++) s += GAUSS7[k]! * tmp[(y + k) * ow + x]!;
      out[y * ow + x] = s;
    }
  }
  return out;
}

/**
 * SSIM moyen (Wang et al. 2004) entre deux images en niveaux de gris (0..255) :
 * fenêtre gaussienne 7×7, σ = 1,5, C1 = (0,01·255)², C2 = (0,03·255)²,
 * moyenne sur toutes les fenêtres entièrement dans l'image.
 */
export function ssimGray(a: Float64Array, b: Float64Array, w: number, h: number): number {
  if (a.length !== w * h || b.length !== w * h) throw new Error('ssimGray : tailles incohérentes');
  if (w < 2 * SSIM_RADIUS + 1 || h < 2 * SSIM_RADIUS + 1) {
    throw new Error(`ssimGray : image ${w}×${h} plus petite que la fenêtre 7×7`);
  }
  const n = w * h;
  const aa = new Float64Array(n);
  const bb = new Float64Array(n);
  const ab = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    aa[i] = a[i]! * a[i]!;
    bb[i] = b[i]! * b[i]!;
    ab[i] = a[i]! * b[i]!;
  }
  const mA = blurValid(a, w, h);
  const mB = blurValid(b, w, h);
  const sAA = blurValid(aa, w, h);
  const sBB = blurValid(bb, w, h);
  const sAB = blurValid(ab, w, h);
  let sum = 0;
  for (let i = 0; i < mA.length; i++) {
    const ma = mA[i]!;
    const mb = mB[i]!;
    const va = sAA[i]! - ma * ma;
    const vb = sBB[i]! - mb * mb;
    const cov = sAB[i]! - ma * mb;
    sum +=
      ((2 * ma * mb + SSIM_C1) * (2 * cov + SSIM_C2)) /
      ((ma * ma + mb * mb + SSIM_C1) * (va + vb + SSIM_C2));
  }
  return sum / mA.length;
}

/** SSIM de deux `RasterImage` (luminance après composition sur `background`). */
export function ssim(a: RasterImage, b: RasterImage, background: Rgb = [255, 255, 255]): number {
  assertSameSize(a, b, 'ssim');
  return ssimGray(toGray(a, background), toGray(b, background), a.width, a.height);
}

// ---------------------------------------------------------------------------
// Re-quantification et référence
// ---------------------------------------------------------------------------

/** Les métriques indexent la palette par `id` : on exige ids = 0..n-1 dans l'ordre. */
export function assertDenseIds(palette: Palette): void {
  palette.colors.forEach((c, k) => {
    if (c.id !== k) throw new Error(`palette : la couleur d'index ${k} a l'id ${c.id}`);
  });
}

/** OKLab des couleurs RGB de la palette (celles que le SVG peint réellement). */
export function paletteOklab(palette: Palette): Float64Array {
  assertDenseIds(palette);
  const out = new Float64Array(palette.colors.length * 3);
  palette.colors.forEach((c, k) => {
    const lab = rgbToOklab(c.rgb);
    out[3 * k] = lab.L;
    out[3 * k + 1] = lab.a;
    out[3 * k + 2] = lab.b;
  });
  return out;
}

/**
 * Plus proche couleur de palette (OKLab) de chaque pixel ; -1 si alpha < `alphaMin`.
 * Renvoie l'id de couleur (ids denses, voir `assertDenseIds`).
 */
export function requantize(img: RasterImage, palette: Palette, alphaMin = 128): Int16Array {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  rgbaToOklabArray(img.data, lab);
  const pal = paletteOklab(palette);
  const K = palette.colors.length;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3]! < alphaMin) {
      out[i] = -1;
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < K; k++) {
      const dL = lab[3 * i]! - pal[3 * k]!;
      const da = lab[3 * i + 1]! - pal[3 * k + 1]!;
      const db = lab[3 * i + 2]! - pal[3 * k + 2]!;
      const d = dL * dL + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    out[i] = best;
  }
  return out;
}

/** Index de couleur par pixel d'une carte de labels (-1 = transparent). */
export function labelColors(map: LabelMap): Int16Array {
  const out = new Int16Array(map.labels.length);
  for (let i = 0; i < out.length; i++) {
    const l = map.labels[i]!;
    out[i] = l < 0 ? -1 : map.regions[l]!.colorId;
  }
  return out;
}

/**
 * Réduit une carte de couleurs de `scale` (vote majoritaire par bloc s×s,
 * égalité → plus petit index ; -1 compte comme une couleur).
 */
export function downsampleColors(
  colors: Int16Array,
  width: number,
  height: number,
  scale: number,
): Int16Array {
  if (scale === 1) return colors.slice();
  const ow = Math.floor(width / scale);
  const oh = Math.floor(height / scale);
  const out = new Int16Array(ow * oh);
  const votes = new Map<number, number>();
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      votes.clear();
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const c = colors[(y * scale + dy) * width + x * scale + dx]!;
          votes.set(c, (votes.get(c) ?? 0) + 1);
        }
      }
      let best = -1;
      let bestV = -1;
      for (const [c, v] of votes) {
        if (v > bestV || (v === bestV && c < best)) {
          best = c;
          bestV = v;
        }
      }
      out[y * ow + x] = best;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Liserés
// ---------------------------------------------------------------------------

export interface SeamOptions {
  /** Distance OKLab sous laquelle une couleur « est » une couleur de palette (défaut 0,05). */
  delta: number;
  /**
   * Couverture minimale : un pixel du rendu d'alpha < `minCoverage` alors que la
   * source est opaque est un trou dans le tracé (défaut 0,7). 0,75 est la
   * couverture minimale produite par la « conflation » de l'anti-aliasing de
   * deux tracés jointifs (1 − a(1 − a)) : on ne la compte pas.
   */
  minCoverage: number;
}

/** Sous cette couverture, la couleur dé-prémultipliée d'un pixel n'est pas fiable. */
const MIN_ALPHA_FOR_COLOR = 0.25;

export const DEFAULT_SEAM_OPTIONS: SeamOptions = { delta: 0.05, minCoverage: 0.7 };

export interface SeamResult {
  count: number;
  /** count / pixels examinés. */
  fraction: number;
  /** Pixels examinés : source opaque ET proche (< Δ) de sa couleur de palette. */
  examined: number;
  /** Pixels du rendu partiellement découverts (minCoverage ≤ α < 1) : information seulement. */
  conflation: number;
  /** 1 = liseré. */
  mask: Uint8Array;
}

/**
 * Liserés : pixels « d'aucune couleur » apparus entre deux régions.
 *
 * Un pixel p est EXAMINÉ si la source quantifiée y est opaque et si la couleur
 * source y est à moins de Δ de sa couleur de palette (sinon la source est
 * elle-même ambiguë, typiquement un pixel anti-aliasé). Il est un LISERÉ si :
 *  - le rendu y est découvert (alpha < `minCoverage` × alpha source : une source
 *    translucide n'exige que sa propre opacité, T08) alors qu'aucun pixel
 *    transparent n'est dans son voisinage 3×3 de la source quantifiée (contre
 *    la transparence, aucun tracé ne doit jointer : une couverture partielle y
 *    est l'anti-aliasing du contour, pas un vide), OU
 *  - sa couverture est ≥ 0,25 (couleur fiable) et sa couleur (dé-prémultipliée)
 *    est à plus de Δ de TOUTE couleur de palette ET du mélange sRGB le plus
 *    proche (projection exacte) de toute paire de couleurs présentes dans le
 *    voisinage 3×3 de la source quantifiée (l'anti-aliasing du rastériseur entre
 *    deux régions voisines est ainsi exclu, sans éroder les frontières : un
 *    vide d'un pixel entre deux régions reste détecté).
 *
 * `quantSource` : index de palette par pixel (-1 = transparent), à la taille
 * de `render` et `source`.
 */
export function detectSeams(
  render: RasterImage,
  source: RasterImage,
  quantSource: Int16Array,
  palette: Palette,
  options: SeamOptions = DEFAULT_SEAM_OPTIONS,
): SeamResult {
  assertSameSize(render, source, 'detectSeams');
  const { width: W, height: H } = render;
  const n = W * H;
  if (quantSource.length !== n) throw new Error('detectSeams : quantSource de mauvaise taille');
  const delta2 = options.delta * options.delta;
  const pal = paletteOklab(palette);
  const K = palette.colors.length;
  const labR = new Float32Array(n * 3);
  const labS = new Float32Array(n * 3);
  rgbaToOklabArray(render.data, labR);
  rgbaToOklabArray(source.data, labS);

  // Mélange sRGB d'une paire le plus proche du rendu : projection exacte du
  // pixel sur le segment [ci, cj] en sRGB (un échantillonnage laisserait des
  // vides près des couleurs sombres, où OKLab est très dilaté).
  const rgbR = render.data;
  const blendLab = new Float64Array(3);
  const nearestBlend = (i: number, j: number, p: number): Float64Array => {
    const ci = palette.colors[i]!.rgb;
    const cj = palette.colors[j]!.rgb;
    const dr = cj[0] - ci[0];
    const dg = cj[1] - ci[1];
    const db = cj[2] - ci[2];
    const len2 = dr * dr + dg * dg + db * db;
    let t = 0;
    if (len2 > 0) {
      t =
        ((rgbR[p]! - ci[0]) * dr + (rgbR[p + 1]! - ci[1]) * dg + (rgbR[p + 2]! - ci[2]) * db) /
        len2;
      t = Math.min(1, Math.max(0, t));
    }
    const lab = rgbToOklab([ci[0] + t * dr, ci[1] + t * dg, ci[2] + t * db]);
    blendLab[0] = lab.L;
    blendLab[1] = lab.a;
    blendLab[2] = lab.b;
    return blendLab;
  };
  const near = (arr: Float32Array | Float64Array, o: number, ref: ArrayLike<number>, r: number) => {
    const dL = arr[o]! - ref[r]!;
    const da = arr[o + 1]! - ref[r + 1]!;
    const db = arr[o + 2]! - ref[r + 2]!;
    return dL * dL + da * da + db * db <= delta2;
  };

  const mask = new Uint8Array(n);
  const neigh: number[] = [];
  let examined = 0;
  let count = 0;
  let conflation = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = quantSource[i]!;
      if (c < 0) continue;
      if (!near(labS, 3 * i, pal, 3 * c)) continue;
      examined++;
      const alpha = render.data[i * 4 + 3]! / 255;
      neigh.length = 0;
      let touchesTransparent = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = quantSource[yy * W + xx]!;
          if (q < 0) touchesTransparent = true;
          else if (!neigh.includes(q)) neigh.push(q);
        }
      }
      // Bord contre la transparence : aucun autre tracé ne doit y jointer, une
      // couverture partielle est l'anti-aliasing du contour, pas un vide.
      // Couverture relative à l'opacité de la SOURCE (T08) : une forme
      // translucide rendue à sa propre opacité n'est pas « découverte ».
      const srcAlpha = source.data[i * 4 + 3]! / 255;
      let seam = alpha < options.minCoverage * srcAlpha && !touchesTransparent;
      if (!seam && alpha >= options.minCoverage * srcAlpha && alpha < srcAlpha) conflation++;
      if (!seam && alpha >= MIN_ALPHA_FOR_COLOR) {
        let explained = false;
        for (let k = 0; k < K && !explained; k++) explained = near(labR, 3 * i, pal, 3 * k);
        for (let a = 0; a < neigh.length && !explained; a++) {
          for (let b = a + 1; b < neigh.length && !explained; b++) {
            explained = near(labR, 3 * i, nearestBlend(neigh[a]!, neigh[b]!, 4 * i), 0);
          }
        }
        seam = !explained;
      }
      if (seam) {
        mask[i] = 1;
        count++;
      }
    }
  }
  return { count, fraction: examined ? count / examined : 0, examined, conflation, mask };
}

// ---------------------------------------------------------------------------
// Conservation de la topologie (composantes, trous)
// ---------------------------------------------------------------------------

export interface ColorTopology {
  colorId: number;
  components: number;
  holes: number;
}

/** Composantes et trous par couleur d'une carte de labels. */
export function topologyByColor(map: LabelMap, colors: number): ColorTopology[] {
  const holes = countHoles(map);
  const out: ColorTopology[] = [];
  for (let k = 0; k < colors; k++) out.push({ colorId: k, components: 0, holes: 0 });
  for (const r of map.regions) {
    const t = out[r.colorId]!;
    t.components++;
    t.holes += holes[r.id]!;
  }
  return out;
}

export interface TopologyDiff {
  colorId: number;
  rgb: Rgb;
  source: { components: number; holes: number };
  render: { components: number; holes: number };
}

export interface TopologyResult {
  /** Vrai si, pour chaque couleur, composantes et trous sont identiques. */
  exact: boolean;
  /** Couleurs en écart. */
  diffs: TopologyDiff[];
  sourceHoles: number;
  renderHoles: number;
  sourceComponents: number;
  renderComponents: number;
}

/**
 * T08 — Pixels d'anti-aliasing du rendu : un pixel opaque dont la couleur est à
 * plus de `delta` (OKLab) de toute couleur de palette n'« est » aucune couleur ;
 * sa plus proche couleur peut être une TROISIÈME teinte (le mi-ton marine/blanc
 * re-quantifié en sarcelle), et une bande d'un pixel le long d'un bord décalé
 * d'un demi-pixel devenait une composante parasite (cas construit dans
 * `test/eval-aa-band.test.ts`). Ces pixels prennent la couleur majoritaire de
 * leurs 4-voisins non ambigus (égalité : la plus proche en OKLab), par passes
 * successives ; un pixel sans voisin résolu garde sa plus proche couleur.
 * Modifie `colorIndex` en place.
 */
export function resolveBlends(
  render: RasterImage,
  colorIndex: Int16Array,
  palette: Palette,
  delta = DEFAULT_SEAM_OPTIONS.delta,
): void {
  const { width: W, height: H } = render;
  const n = W * H;
  const lab = new Float32Array(n * 3);
  rgbaToOklabArray(render.data, lab);
  const pal = paletteOklab(palette);
  const dist2 = (i: number, k: number): number =>
    (lab[3 * i]! - pal[3 * k]!) ** 2 +
    (lab[3 * i + 1]! - pal[3 * k + 1]!) ** 2 +
    (lab[3 * i + 2]! - pal[3 * k + 2]!) ** 2;
  const d2 = delta * delta;
  let pending: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = colorIndex[i]!;
    if (c >= 0 && dist2(i, c) > d2) pending.push(i);
  }
  const unresolved = new Uint8Array(n);
  for (const i of pending) unresolved[i] = 1;
  const votes = new Map<number, number>();
  while (pending.length > 0) {
    const next: number[] = [];
    const assign: [number, number][] = [];
    for (const i of pending) {
      const x = i % W;
      const y = (i - x) / W;
      votes.clear();
      const vote = (j: number): void => {
        const c = colorIndex[j]!;
        if (c >= 0 && !unresolved[j]) votes.set(c, (votes.get(c) ?? 0) + 1);
      };
      if (x > 0) vote(i - 1);
      if (x + 1 < W) vote(i + 1);
      if (y > 0) vote(i - W);
      if (y + 1 < H) vote(i + W);
      let best = -1;
      let bestV = 0;
      for (const [c, v] of votes) {
        if (v > bestV || (v === bestV && dist2(i, c) < dist2(i, best))) {
          best = c;
          bestV = v;
        }
      }
      if (best < 0) next.push(i);
      else assign.push([i, best]);
    }
    if (assign.length === 0) break; // îlots sans voisin résolu : plus proche couleur
    for (const [i, c] of assign) {
      colorIndex[i] = c;
      unresolved[i] = 0;
    }
    pending = next;
  }
}

/**
 * Compare, couleur par couleur, composantes 4-connexes et trous du rendu
 * re-quantifié à la palette avec ceux de la source quantifiée (`reference`,
 * après absorption des petites régions). Le rendu re-quantifié subit la MÊME
 * segmentation (absorption des régions < `minRegionArea`) que la source :
 * des pixels d'anti-aliasing isolés ne comptent pas comme des composantes ; les
 * pixels d'anti-aliasing sont d'abord rendus à leurs voisins (`resolveBlends`).
 * `render` doit avoir la taille de `reference`.
 */
export function compareTopology(
  render: RasterImage,
  reference: LabelMap,
  palette: Palette,
  minRegionArea: number,
): TopologyResult {
  if (render.width !== reference.width || render.height !== reference.height) {
    throw new Error(
      `compareTopology : rendu ${render.width}×${render.height} ≠ référence ${reference.width}×${reference.height}`,
    );
  }
  const K = palette.colors.length;
  const colorIndex = requantize(render, palette);
  resolveBlends(render, colorIndex, palette);
  const rendered = segment({ palette, colorIndex }, render.width, render.height, {
    minRegionArea,
    connectivity: 4,
  });
  const src = topologyByColor(reference, K);
  const dst = topologyByColor(rendered, K);
  const diffs: TopologyDiff[] = [];
  let sh = 0;
  let rh = 0;
  let sc = 0;
  let rc = 0;
  for (let k = 0; k < K; k++) {
    const s = src[k]!;
    const d = dst[k]!;
    sh += s.holes;
    rh += d.holes;
    sc += s.components;
    rc += d.components;
    if (s.components !== d.components || s.holes !== d.holes) {
      diffs.push({
        colorId: k,
        rgb: palette.colors[k]!.rgb,
        source: { components: s.components, holes: s.holes },
        render: { components: d.components, holes: d.holes },
      });
    }
  }
  return {
    exact: diffs.length === 0,
    diffs,
    sourceHoles: sh,
    renderHoles: rh,
    sourceComponents: sc,
    renderComponents: rc,
  };
}

// ---------------------------------------------------------------------------
// Carte d'erreur
// ---------------------------------------------------------------------------

/**
 * Carte d'erreur lisible : la source en gris pâle, l'erreur RGB en rouge
 * (saturée à `saturate`), les liserés en magenta plein.
 */
export function diffImage(
  source: RasterImage,
  error: Float32Array,
  seams: Uint8Array | null,
  saturate = 64,
): RasterImage {
  const n = source.width * source.height;
  const gray = toGray(source);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const base = 200 + gray[i]! * (55 / 255);
    const e = Math.min(1, error[i]! / saturate);
    if (seams && seams[i]) {
      out[p] = 255;
      out[p + 1] = 0;
      out[p + 2] = 255;
    } else {
      out[p] = base + (255 - base) * e;
      out[p + 1] = base * (1 - e);
      out[p + 2] = base * (1 - e);
    }
    out[p + 3] = 255;
  }
  return { width: source.width, height: source.height, data: out };
}

// ---------------------------------------------------------------------------
// Formes exactes (T125b) : écart au cercle parfait, virages concaves, écart à la droite
// ---------------------------------------------------------------------------

/** Cercle attendu (coordonnées du SVG = pixels de l'image source), peint de `fill` dans la source. */
export interface ExpectedCircle {
  cx: number;
  cy: number;
  r: number;
  /** Couleur source `#rrggbb` : on lit le `<path>` du SVG de couleur la plus proche. */
  fill: string;
}

/** Segment de droite attendu, peint de `fill` dans la source (même règle que le cercle). */
export interface ExpectedLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill: string;
}

/** Géométrie attendue d'un cas d'évaluation (`EvalCase.expected`). */
export interface ExpectedShapes {
  circles?: ExpectedCircle[];
  lines?: ExpectedLine[];
}

/**
 * Bande d'attribution (px du SVG) : un point du tracé compte pour la forme attendue la plus
 * proche s'il en est à moins de `SHAPE_BAND`. Au-delà, c'est une autre forme (un coin, une
 * contre-forme) ; un écart réel plus grand qu'elle sortirait de la mesure (voir README).
 */
export const SHAPE_BAND = 2;
/** Pas du rééchantillonnage avant les virages (px), celui de `test/logo-robust.test.ts`. */
const TURN_STEP = 2;
/**
 * Plancher d'un virage concave (rad), lié à la précision du SVG émis : à 2 décimales
 * (`export.precision` des préréglages), chaque point est à ±0,005 px près ; un virage mesuré
 * sur trois points espacés de `TURN_STEP` (2 px) en est faussé d'au plus 4 × 0,005 / 2 =
 * 0,01 rad (≈ 0,57°). Un polygone fin d'un cercle de rayon 600 arrondi ainsi comptait 15,7° de
 * « virages concaves » sans aucun défaut (test). Une vraie bosse d'un pixel tourne d'un ordre de
 * grandeur de plus (≈ 5° par pas) ; l'ondulation fine reste vue par l'écart au cercle.
 */
const TURN_EPS = 0.01;
/** Tolérance de l'aplatissement des cubiques (px), celle de `test/logo-robust.test.ts`. */
const FLATTEN_TOLERANCE = 0.01;
/** Espacement maximal des points le long d'une arête droite (px). */
const DENSIFY_STEP = 0.25;

/** Suite de points d'une forme, dans l'ordre du tracé ; `cyclic` : la suite se referme. */
export interface ShapeRun {
  pts: number[];
  cyclic: boolean;
}

export interface CircleMeasure {
  cx: number;
  cy: number;
  r: number;
  /** Points du tracé attribués au cercle (0 : forme perdue, écart infini). */
  points: number;
  /** Rayon crête à crête (max − min de la distance au centre attendu), px. */
  deviation: number;
  /** Somme des virages concaves (degrés) le long des arcs attribués. */
  concaveTurns: number;
}

export interface LineMeasure {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  points: number;
  /** Écart max (px) d'un point attribué à la droite attendue. */
  deviation: number;
}

export interface ShapeReport {
  /** Pire rayon crête à crête parmi les cercles attendus (0 sans cercle). */
  circleDeviationMax: number;
  /** Somme des virages concaves de tous les cercles attendus (degrés). */
  concaveTurns: number;
  /** Pire écart à une droite attendue (0 sans droite). */
  lineDeviationMax: number;
  circles: CircleMeasure[];
  lines: LineMeasure[];
}

/** Distance du point (px, py) au segment [a, b]. */
function segmentDistance(px: number, py: number, l: ExpectedLine): number {
  const vx = l.x1 - l.x0;
  const vy = l.y1 - l.y0;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - l.x0) * vx + (py - l.y0) * vy) / l2)) : 0;
  return Math.hypot(px - l.x0 - t * vx, py - l.y0 - t * vy);
}

/** Rayon crête à crête des points des suites autour du centre (cx, cy) ; Infinity sans point. */
export function circleDeviation(runs: readonly ShapeRun[], c: { cx: number; cy: number }): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const run of runs) {
    for (let i = 0; i < run.pts.length; i += 2) {
      const d = Math.hypot(run.pts[i]! - c.cx, run.pts[i + 1]! - c.cy);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
  }
  return hi >= lo ? hi - lo : Infinity;
}

/**
 * Somme des virages CONCAVES (degrés) le long des suites, rééchantillonnées tous les
 * `TURN_STEP` px : un virage est concave s'il tourne à l'opposé du sens de parcours autour du
 * centre (un arc de cercle ne tourne que d'un côté, une bosse ou un creux tourne des deux).
 * Indépendant du sens du tracé et de la face (bord extérieur ou contre-forme).
 */
export function concaveTurns(runs: readonly ShapeRun[], c: { cx: number; cy: number }): number {
  let total = 0;
  for (const run of runs) {
    const p = run.pts;
    if (p.length < 6) continue;
    const q: [number, number][] = [[p[0]!, p[1]!]];
    for (let i = 2; i < p.length; i += 2) {
      const [lx, ly] = q[q.length - 1]!;
      if (Math.hypot(p[i]! - lx, p[i + 1]! - ly) >= TURN_STEP) q.push([p[i]!, p[i + 1]!]);
    }
    if (run.cyclic) {
      while (
        q.length > 3 &&
        Math.hypot(q.at(-1)![0] - q[0]![0], q.at(-1)![1] - q[0]![1]) < TURN_STEP * 0.75
      ) {
        q.pop();
      }
    } else {
      const last: [number, number] = [p[p.length - 2]!, p[p.length - 1]!];
      const [lx, ly] = q[q.length - 1]!;
      if (lx !== last[0] || ly !== last[1]) q.push(last);
    }
    const n = q.length;
    if (n < 3) continue;
    const from = run.cyclic ? 0 : 1;
    const to = run.cyclic ? n : n - 1;
    for (let i = from; i < to; i++) {
      const a = q[(i - 1 + n) % n]!;
      const b = q[i]!;
      const d = q[(i + 1) % n]!;
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const vx = d[0] - b[0];
      const vy = d[1] - b[1];
      const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      // Sens de parcours autour du centre, de a à d.
      const around = (a[0] - c.cx) * (d[1] - c.cy) - (a[1] - c.cy) * (d[0] - c.cx);
      if (turn * around < 0 && Math.abs(turn) > TURN_EPS) total += (Math.abs(turn) * 180) / Math.PI;
    }
  }
  return total;
}

/** Écart max des points des suites au segment attendu ; Infinity sans point. */
export function lineDeviation(runs: readonly ShapeRun[], l: ExpectedLine): number {
  let hi = -Infinity;
  for (const run of runs) {
    for (let i = 0; i < run.pts.length; i += 2) {
      hi = Math.max(hi, segmentDistance(run.pts[i]!, run.pts[i + 1]!, l));
    }
  }
  return hi >= 0 ? hi : Infinity;
}

function hexRgb(h: string): Rgb {
  const s = h.replace(/^#/, '');
  const full = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Sous-tracés du `<path>` rempli du SVG dont la couleur est la plus proche de `fill` (RGB). Le
 * PREMIER chemin de cette couleur seulement (précédent `pathOf`) : les préréglages fusionnent
 * les tracés d'une couleur (`export.mergeByColor`) ; avec `mergeByColor: false`, les autres
 * chemins de la même couleur ne seraient pas lus.
 */
export function subpathsOfFill(svg: string, fill: string): ParsedSubpath[] {
  const want = hexRgb(fill);
  let best: ParsedSubpath[] = [];
  let bestD = Infinity;
  for (const m of svg.matchAll(
    /<path\b[^>]*?\bfill="#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})"[^>]*?\bd="([^"]*)"/g,
  )) {
    const c = hexRgb(m[1]!);
    const d = Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2]);
    if (d < bestD) {
      bestD = d;
      best = parsePathData(m[2]!);
    }
  }
  return best;
}

/**
 * Points intermédiaires tous les `DENSIFY_STEP` px au plus sur chaque arête de la polyligne :
 * `flattenSubpath` n'échantillonne que les cubiques, une corde droite (`L`) posée sur un arc
 * n'aurait que ses deux bouts, sur le cercle, et sa flèche échapperait à la mesure.
 */
function densify(p: Float64Array, closed: boolean): Float64Array {
  const n = p.length / 2;
  const out: number[] = [];
  const edges = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const x = p[2 * i]!;
    const y = p[2 * i + 1]!;
    out.push(x, y);
    if (i >= edges) continue;
    const j = (i + 1) % n;
    const dx = p[2 * j]! - x;
    const dy = p[2 * j + 1]! - y;
    const steps = Math.ceil(Math.hypot(dx, dy) / DENSIFY_STEP);
    for (let k = 1; k < steps; k++) out.push(x + (dx * k) / steps, y + (dy * k) / steps);
  }
  return Float64Array.from(out);
}

/**
 * Suites de points d'une forme : chaque point aplati (`flattenSubpath`, 0,01 px) est attribué
 * (puis densifié, `densify`) à la forme attendue la PLUS PROCHE (cercle : |distance au centre − r| ; droite : distance au
 * segment) si elle est à moins de `band` ; les points consécutifs attribués à `target` forment
 * une suite (un sous-tracé fermé entièrement attribué est une suite cyclique).
 */
function runsOf(
  subpaths: readonly ParsedSubpath[],
  shapes: readonly ((x: number, y: number) => number)[],
  target: number,
  band: number,
): ShapeRun[] {
  const out: ShapeRun[] = [];
  for (const sp of subpaths) {
    const p = densify(flattenSubpath(sp, FLATTEN_TOLERANCE), sp.closed);
    const n = p.length / 2;
    const mine = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const x = p[2 * i]!;
      const y = p[2 * i + 1]!;
      let best = -1;
      let bestD = band;
      for (let k = 0; k < shapes.length; k++) {
        const d = shapes[k]!(x, y);
        if (d <= bestD) {
          bestD = d;
          best = k; // égalité : la dernière déclarée (une droite après les cercles)
        }
      }
      if (best === target) {
        mine[i] = 1;
        count++;
      }
    }
    if (count === 0) continue;
    if (count === n && sp.closed) {
      out.push({ pts: Array.from(p), cyclic: true });
      continue;
    }
    // Départ sur un point non attribué (sous-tracé fermé) : aucune suite coupée en deux.
    let start = 0;
    if (sp.closed) while (mine[start]) start++;
    let cur: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (mine[i]) cur.push(p[2 * i]!, p[2 * i + 1]!);
      else if (cur.length > 0) {
        out.push({ pts: cur, cyclic: false });
        cur = [];
      }
    }
    if (cur.length > 0) out.push({ pts: cur, cyclic: false });
  }
  return out;
}

/**
 * Mesure la géométrie attendue sur le SVG émis : pour chaque forme, les sous-tracés du chemin
 * de sa couleur, puis les points qui lui sont attribués (`runsOf`). Cercle : rayon crête à
 * crête et virages concaves ; droite : écart max. Pur (aucune rastérisation).
 */
export function shapeDeviations(
  svg: string,
  expected: ExpectedShapes,
  band = SHAPE_BAND,
): ShapeReport {
  const circles = expected.circles ?? [];
  const lines = expected.lines ?? [];
  const shapes: ((x: number, y: number) => number)[] = [
    ...circles.map((c) => (x: number, y: number) => Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r)),
    ...lines.map((l) => (x: number, y: number) => segmentDistance(x, y, l)),
  ];
  const byFill = new Map<string, ParsedSubpath[]>();
  const subpaths = (fill: string): ParsedSubpath[] => {
    let s = byFill.get(fill);
    if (!s) byFill.set(fill, (s = subpathsOfFill(svg, fill)));
    return s;
  };
  const circleOut: CircleMeasure[] = circles.map((c, k) => {
    const runs = runsOf(subpaths(c.fill), shapes, k, band);
    return {
      cx: c.cx,
      cy: c.cy,
      r: c.r,
      points: runs.reduce((s, r) => s + r.pts.length / 2, 0),
      deviation: circleDeviation(runs, c),
      concaveTurns: concaveTurns(runs, c),
    };
  });
  const lineOut: LineMeasure[] = lines.map((l, k) => {
    const runs = runsOf(subpaths(l.fill), shapes, circles.length + k, band);
    return {
      x0: l.x0,
      y0: l.y0,
      x1: l.x1,
      y1: l.y1,
      points: runs.reduce((s, r) => s + r.pts.length / 2, 0),
      deviation: lineDeviation(runs, l),
    };
  });
  return {
    circleDeviationMax: circleOut.reduce((m, c) => Math.max(m, c.deviation), 0),
    concaveTurns: circleOut.reduce((s, c) => s + c.concaveTurns, 0),
    lineDeviationMax: lineOut.reduce((m, l) => Math.max(m, l.deviation), 0),
    circles: circleOut,
    lines: lineOut,
  };
}
