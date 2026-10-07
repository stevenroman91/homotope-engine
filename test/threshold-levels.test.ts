// T62 — Noir et blanc sur fond transparent : après le seuil, la quantification prend les
// NIVEAUX présents (noir, blanc) parmi les pixels opaques, jamais un k-means à 2 couleurs qui
// couperait une classe unique en deux teintes jumelles (ou laisserait une couleur sans pixel).
import { describe, expect, it } from 'vitest';
import { checkSvg } from '../src/engine/cutcheck/index.ts';
import { oklabDistance } from '../src/engine/color/oklab.ts';
import { mulberry32 } from '../src/engine/color/prng.ts';
import { quantize, thresholdLevels } from '../src/engine/color/quantize.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { preprocess } from '../src/engine/preprocess/index.ts';
import { DEFAULT_OPTIONS, presetOptions } from '../src/engine/presets.ts';
import type { RasterImage, VectorizeOptions } from '../src/engine/types.ts';

const W = 160;
const H = 96;

/**
 * Silhouettes bleu nuit (#1d222d) sur fond TRANSPARENT : bords anti-aliasés (alpha partiel,
 * RGB décalé d'un cran (#1e232e) comme après le dé-prémultiplié d'un canevas), et des îlots
 * semi-transparents de cette teinte voisine À L'INTÉRIEUR. `paper` : fond blanc opaque
 * au lieu du transparent.
 */
function forest(paper = false): RasterImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Bande anti-aliasée de 3 px (image d'origine réduite pour l'atelier).
      const a1 = Math.min(1, Math.max(0, (34.5 - Math.hypot(x - 48, y - 48)) / 3));
      const a2 = Math.min(1, Math.max(0, (24.5 - Math.hypot(x - 118, y - 52)) / 3));
      const a = Math.max(a1, a2);
      const edge = a > 0 && a < 1;
      const rgb = edge ? [0x1e, 0x23, 0x2e] : [0x1d, 0x22, 0x2d];
      if (paper) {
        // Mélange sur papier blanc : niveaux de gris anti-aliasés, tout opaque.
        data[i] = Math.round(rgb[0]! * a + 255 * (1 - a));
        data[i + 1] = Math.round(rgb[1]! * a + 255 * (1 - a));
        data[i + 2] = Math.round(rgb[2]! * a + 255 * (1 - a));
        data[i + 3] = 255;
      } else {
        data[i] = rgb[0]!;
        data[i + 1] = rgb[1]!;
        data[i + 2] = rgb[2]!;
        data[i + 3] = Math.round(255 * a);
      }
    }
  // Îlots intérieurs de teinte voisine, semi-transparents (au-dessus du seuil alpha) : des
  // amas de 4 × 4 (plus grands que `minRegionArea`) et des pixels isolés.
  const islands: Array<readonly [number, number, number]> = [
    [40, 40, 4],
    [55, 58, 4],
    [112, 48, 4],
    [30, 50, 1],
    [122, 60, 1],
  ];
  for (const [x0, y0, size] of islands)
    for (let y = y0; y < y0 + size; y++)
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * W + x) * 4;
        data[i] = 0x1e;
        data[i + 1] = 0x23;
        data[i + 2] = 0x2e;
        if (!paper) data[i + 3] = 200;
      }
  return { width: W, height: H, data };
}

const fills = (svg: string): string[] =>
  [...svg.matchAll(/<path fill="(#[0-9a-f]+)"/g)].map((m) => m[1]!);

describe('T62 — Noir et blanc : niveaux du seuil, jamais deux teintes jumelles', () => {
  it('encre sur fond transparent (Conserver) : EXACTEMENT 1 couleur, 1 tracé, aucune île', () => {
    const o = presetOptions('black-white');
    o.preprocess.alphaMode = 'keep';
    const r = vectorize(forest(), o);
    expect(r.palette.colors).toHaveLength(1);
    expect(r.palette.colors[0]!.rgb).toEqual([0, 0, 0]);
    expect(r.palette.colors[0]!.count).toBeGreaterThan(0);
    // Un seul tracé : ni seconde teinte, ni île intérieure, ni liseré de bord.
    expect(fills(r.svg)).toEqual(['#000']);
    expect(r.stats.paths).toBe(1);
    expect(r.stats.colors).toBe(1);
    // Deux silhouettes, aucune région de plus (île intérieure, liseré).
    expect(r.stats.regions).toBe(2);
    // Le seuil automatique ne coupe pas l'encre seule en deux (Otsu, T62).
    expect(r.diagnostics?.threshold).toBe(128);
  });

  it('contrôle de découpe (chemin de l’atelier) : ni frontière commune, ni double découpe, ni îlot, ni détail fin', () => {
    const o = presetOptions('black-white');
    o.preprocess.alphaMode = 'keep';
    const report = checkSvg(vectorize(forest(), o).svg);
    // `overlap` couvre « frontière commune de deux formes voisines » (info) et « double
    // découpe » (bloquant) : une seconde teinte en liseré les produisait le long des bords.
    expect(report.totals.overlap).toBe(0);
    expect(report.totals.island).toBe(0);
    expect(report.totals.thin).toBe(0);
    expect(report.info).toBe(0);
    expect(report.blocking).toBe(0);
    // Deux silhouettes, deux contours fermés.
    expect(report.contours.closed).toBe(2);
  });

  it('encre sur papier blanc opaque : EXACTEMENT 2 couleurs (noir et blanc)', () => {
    const o = presetOptions('black-white');
    const r = vectorize(forest(true), o);
    expect(r.palette.colors.map((c) => c.rgb).sort()).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    expect(r.palette.colors.every((c) => c.count > 0)).toBe(true);
  });

  it('Aplatir sur le fond : le fond blanc est une vraie classe (2 couleurs)', () => {
    const o = presetOptions('black-white');
    o.preprocess.alphaMode = 'flatten';
    const r = vectorize(forest(), o);
    expect(r.palette.colors).toHaveLength(2);
    expect(new Set(fills(r.svg))).toEqual(new Set(['#000', '#fff']));
  });

  it('après un seuil, deux couleurs de la palette ne sont JAMAIS à moins de ΔE 0,02', () => {
    const rng = mulberry32(62);
    for (let trial = 0; trial < 24; trial++) {
      const w = 24;
      const h = 18;
      const data = new Uint8ClampedArray(w * h * 4);
      const base = [Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)];
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) data[i * 4 + c] = base[c]! + Math.floor(rng() * 9) - 4;
        data[i * 4 + 3] = rng() < 0.4 ? 0 : 128 + Math.floor(rng() * 128);
      }
      const options: VectorizeOptions = structuredClone(DEFAULT_OPTIONS);
      options.preprocess = {
        ...options.preprocess,
        alphaMode: trial % 2 ? 'keep' : 'flatten',
        denoise: 'none',
        upsample: 1,
        threshold: trial % 3 ? 'auto' : Math.floor(rng() * 256),
      };
      options.quantize = { ...options.quantize, colors: trial % 4 ? 2 : 8, maxColors: 8 };
      const pre = preprocess({ width: w, height: h, data }, options.preprocess);
      const q = quantize(pre, options.quantize);
      const cols = q.palette.colors;
      expect(cols.length).toBeLessThanOrEqual(2);
      for (const c of cols) expect(c.count).toBeGreaterThan(0);
      for (let a = 0; a < cols.length; a++)
        for (let b = a + 1; b < cols.length; b++)
          expect(oklabDistance(cols[a]!.oklab, cols[b]!.oklab)).toBeGreaterThanOrEqual(0.02);
    }
  });

  it('« Nombre de couleurs » à 1 sous « Noir et blanc » : EXACTEMENT 1 couleur', () => {
    const o = presetOptions('black-white');
    o.quantize.colors = 1;
    // Sur papier blanc (deux niveaux) : le majoritaire seul, tous les pixels opaques y vont.
    const r = vectorize(forest(true), o);
    expect(r.palette.colors).toHaveLength(1);
    expect(r.stats.colors).toBe(1);
    // Tous les pixels de l'image de travail (suréchantillonnée) : aucun ailleurs.
    expect(r.palette.colors[0]!.rgb).toEqual([255, 255, 255]);
    expect(r.stats.paths).toBe(1);
    o.preprocess.alphaMode = 'keep';
    expect(vectorize(forest(), o).palette.colors).toHaveLength(1);
  });

  it('thresholdLevels (pur) : niveaux présents parmi les opaques seulement', () => {
    const d = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 40, 0, 0, 0, 255]);
    expect(thresholdLevels(d, null, 3)).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    expect(thresholdLevels(d, Uint8Array.from([1, 0, 1]), 3)).toEqual([[0, 0, 0]]);
    expect(thresholdLevels(d, Uint8Array.from([0, 1, 0]), 3)).toEqual([[255, 255, 255]]);
    expect(thresholdLevels(d, Uint8Array.from([0, 0, 0]), 3)).toEqual([]);
    // `single` : le niveau majoritaire seul (noir 2 contre blanc 1 ; égalité → noir).
    expect(thresholdLevels(d, null, 3, true)).toEqual([[0, 0, 0]]);
    expect(thresholdLevels(d, Uint8Array.from([1, 1, 0]), 3, true)).toEqual([[0, 0, 0]]);
    expect(thresholdLevels(d, Uint8Array.from([0, 1, 0]), 3, true)).toEqual([[255, 255, 255]]);
  });

  it('image entièrement transparente : palette vide, SVG sans tracé', () => {
    const o = presetOptions('black-white');
    o.preprocess.alphaMode = 'keep';
    const r = vectorize({ width: 8, height: 8, data: new Uint8ClampedArray(256) }, o);
    expect(r.palette.colors).toHaveLength(0);
    expect(fills(r.svg)).toEqual([]);
  });

  it('fond transparent (Pro) et recoloriage restent possibles sur les niveaux', () => {
    const o = presetOptions('black-white');
    const pre = preprocess(forest(true), o.preprocess);
    const base = quantize(pre, o.quantize).palette.colors;
    const white = base.find((c) => c.rgb[0] === 255)!.id;
    const black = base.find((c) => c.rgb[0] === 0)!.id;
    const q = quantize(pre, {
      ...o.quantize,
      constraints: {
        locked: [],
        merged: [],
        removed: [],
        transparent: [white],
        recolor: [{ id: black, rgb: [29, 34, 45] }],
      },
    });
    expect(q.palette.colors).toHaveLength(1);
    expect(q.palette.colors[0]!.rgb).toEqual([29, 34, 45]);
    expect(q.palette.colors[0]!.sourceRgb).toEqual([0, 0, 0]);
  });
  it('verrous sous seuil : un niveau présent verrouillé reste `locked` ; une couleur étrangère est ignorée', () => {
    const o = presetOptions('black-white');
    const pre = preprocess(forest(true), o.preprocess);
    const q = (locked: [number, number, number][]) =>
      quantize(pre, { ...o.quantize, constraints: { ...o.quantize.constraints, locked } }).palette
        .colors;
    const lockedOf = (cols: ReturnType<typeof q>) =>
      cols.map((c) => `${c.rgb.join(',')}:${String(c.locked)}`).sort();
    expect(lockedOf(q([]))).toEqual(['0,0,0:false', '255,255,255:false']);
    expect(lockedOf(q([[0, 0, 0]]))).toEqual(['0,0,0:true', '255,255,255:false']);
    // Couleur étrangère (le bleu nuit d'origine) : ignorée, ni ajoutée ni marquée.
    expect(lockedOf(q([[29, 34, 45]]))).toEqual(['0,0,0:false', '255,255,255:false']);
    expect(
      lockedOf(
        q([
          [29, 34, 45],
          [255, 255, 255],
        ]),
      ),
    ).toEqual(['0,0,0:false', '255,255,255:true']);
  });
});
