// T50 — Recoloriage : seule la couleur de SORTIE change (`rgb`, `sourceRgb`), jamais la
// géométrie (`oklab`, `colorIndex`, régions) ; deux ids recolorés vers la même couleur restent
// deux régions ; repris par tous les exports (SVG, PNG, PDF, EPS, DXF, séparations).
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { convertSvg, separationColors, separationFiles } from '../src/engine/export/index.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type {
  PaletteConstraints,
  PreprocessResult,
  QuantizeOptions,
  RasterImage,
  Rgb,
  VectorizeOptions,
} from '../src/engine/types.ts';
import { rasterizeSvg } from '../src/eval/metrics.ts';
import { SCENE, rasterFromAscii } from './palette-scene.ts';

const IMG = rasterFromAscii(SCENE);
const pre = (img: RasterImage): PreprocessResult => ({ image: img, scale: 1, opaque: null });
const qopts = (c: Partial<PaletteConstraints> = {}): QuantizeOptions => ({
  colors: 4,
  maxColors: 16,
  autoTolerance: 0.02,
  seed: 42,
  constraints: { locked: [], merged: [], removed: [], ...c },
});
const BASE = quantize(pre(IMG), qopts());
const isRed = (rgb: Rgb) => rgb[0] > 200 && rgb[1] < 60;
const isBlue = (rgb: Rgb) => rgb[2] > 180 && rgb[0] < 60;
const R = BASE.palette.colors.find((c) => isRed(c.rgb))!.id;
const B = BASE.palette.colors.find((c) => isBlue(c.rgb))!.id;
const PINK: Rgb = [250, 10, 170];
const LIME: Rgb = [10, 250, 20];

describe('quantize — recolor (T50)', () => {
  it('rgb remplacé, sourceRgb posé ; oklab, count et colorIndex inchangés', () => {
    const q = quantize(pre(IMG), qopts({ recolor: [{ id: R, rgb: PINK }] }));
    expect(Array.from(q.colorIndex)).toEqual(Array.from(BASE.colorIndex));
    q.palette.colors.forEach((c, i) => {
      const b = BASE.palette.colors[i]!;
      expect(c.oklab).toEqual(b.oklab);
      expect(c.count).toBe(b.count);
      if (i === R) {
        expect(c.rgb).toEqual(PINK);
        expect(c.sourceRgb).toEqual(b.rgb);
      } else {
        expect(c.rgb).toEqual(b.rgb);
        expect(c.sourceRgb).toBeUndefined();
      }
    });
  });

  it('deux ids vers la même couleur : deux couleurs de palette, deux régions (aucune fusion)', () => {
    const q = quantize(
      pre(IMG),
      qopts({
        recolor: [
          { id: R, rgb: LIME },
          { id: B, rgb: LIME },
        ],
      }),
    );
    expect(q.palette.colors).toHaveLength(BASE.palette.colors.length);
    expect(Array.from(q.colorIndex)).toEqual(Array.from(BASE.colorIndex));
    expect(q.palette.colors[R]!.rgb).toEqual(LIME);
    expect(q.palette.colors[B]!.rgb).toEqual(LIME);
  });

  it('id fusionné : son groupe est recoloré (premier gagnant) ; retiré, transparent, hors bornes : ignorés', () => {
    const merged = quantize(
      pre(IMG),
      qopts({
        merged: [[R, B]],
        recolor: [
          { id: B, rgb: PINK },
          { id: R, rgb: LIME },
        ],
      }),
    );
    expect(merged.palette.colors.filter((c) => c.sourceRgb)).toHaveLength(1);
    expect(merged.palette.colors.some((c) => c.rgb.join() === PINK.join())).toBe(true);
    for (const c of [{ removed: [R] }, { transparent: [R] }]) {
      const q = quantize(pre(IMG), qopts({ ...c, recolor: [{ id: R, rgb: PINK }] }));
      expect(q.palette.colors.some((x) => x.sourceRgb)).toBe(false);
    }
    const out = quantize(pre(IMG), qopts({ recolor: [{ id: 42, rgb: PINK }] }));
    expect(out.palette).toEqual(BASE.palette);
  });

  it('valeurs normalisées (bornes, arrondi) ; même couleur que la mesure : rien', () => {
    const q = quantize(pre(IMG), qopts({ recolor: [{ id: R, rgb: [300, -4, 10.6] }] }));
    expect(q.palette.colors[R]!.rgb).toEqual([255, 0, 11]);
    const same = quantize(
      pre(IMG),
      qopts({ recolor: [{ id: R, rgb: BASE.palette.colors[R]!.rgb }] }),
    );
    expect(same.palette).toEqual(BASE.palette);
  });

  it('palette imposée : recolor ignoré (encres exactes)', () => {
    const fixed = {
      colors: [
        [255, 255, 255],
        [220, 30, 40],
        [30, 60, 200],
        [40, 180, 70],
      ] as Rgb[],
      dither: false,
      minCoverage: 0,
    };
    const q = quantize(pre(IMG), {
      ...qopts({ recolor: [{ id: 1, rgb: PINK }] }),
      fixedPalette: fixed,
    });
    expect(q.palette.colors.some((c) => c.sourceRgb)).toBe(false);
  });
});

describe('recolor repris par tous les exports (T50)', () => {
  const options = (c: Partial<PaletteConstraints> = {}): VectorizeOptions => {
    const o = presetOptions('logo');
    o.preprocess.denoise = 'none';
    o.preprocess.upsample = 1;
    o.quantize.colors = 4;
    o.quantize.constraints = { ...o.quantize.constraints, ...c };
    return o;
  };
  const plain = vectorize(IMG, options());
  const pink = vectorize(IMG, options({ recolor: [{ id: R, rgb: PINK }] }));
  const red = plain.palette.colors[R]!.rgb;
  const hex = (rgb: Rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  it('SVG : nouvelle couleur, l’ancienne absente ; même géométrie (tracés et nœuds)', () => {
    expect(pink.svg).toContain(`fill="${hex(PINK)}"`);
    expect(pink.svg).not.toContain(hex(red));
    expect(pink.stats.regions).toBe(plain.stats.regions);
    expect(pink.stats.nodes).toBe(plain.stats.nodes);
    expect(pink.svg.replaceAll(hex(PINK), hex(red))).toBe(plain.svg);
  });

  it('deux recoloriages identiques : régions inchangées (pas de fusion implicite)', () => {
    const two = vectorize(
      IMG,
      options({
        recolor: [
          { id: R, rgb: LIME },
          { id: B, rgb: LIME },
        ],
      }),
    );
    expect(two.stats.regions).toBe(plain.stats.regions);
    expect(two.palette.colors).toHaveLength(plain.palette.colors.length);
  });

  it('PNG : le pixel de l’anneau rendu est rose', () => {
    const r = rasterizeSvg(pink.svg, IMG.width);
    // Pixel au centre de la case (1, 3) de la scène : anneau rouge.
    const i = ((3 * 4 + 2) * r.width + (1 * 4 + 2)) * 4;
    expect([r.data[i], r.data[i + 1], r.data[i + 2]]).toEqual([...PINK]);
  });

  it('PDF et EPS : la couleur de remplissage est la nouvelle', () => {
    const f = (v: number) => String(Math.round((v / 255) * 1000) / 1000);
    const pdf = convertSvg(pink.svg, 'pdf');
    const eps = convertSvg(pink.svg, 'eps');
    const ops = (txt: string, op: string) =>
      [...txt.matchAll(new RegExp(`([\\d.]+) ([\\d.]+) ([\\d.]+) ${op}`, 'g'))].map((m) =>
        [m[1], m[2], m[3]].map((x) => Math.round(Number(x) * 255)),
      );
    expect(ops(pdf, 'rg')).toContainEqual([...PINK]);
    expect(ops(eps, 'setrgbcolor')).toContainEqual([...PINK]);
    expect(ops(pdf, 'rg')).not.toContainEqual([...red]);
    expect(f(0)).toBe('0');
  });

  it('DXF : calque nommé d’après la nouvelle couleur, aucun calque de l’ancienne', () => {
    const dxf = convertSvg(pink.svg, 'dxf');
    expect(dxf).toContain('FA0AAA');
    expect(dxf).not.toContain(hex(red).slice(1).toUpperCase());
  });

  it('séparations : la couleur et le nom de fichier sont les nouveaux', () => {
    expect(separationColors(pink.svg)).toContain(hex(PINK));
    expect(separationColors(pink.svg)).not.toContain(hex(red));
    const files = separationFiles(pink.svg, 'svg', 'logo');
    expect(files.some((f) => f.name.includes('fa0aaa'))).toBe(true);
    expect(files.some((f) => f.name.includes(hex(red).slice(1)))).toBe(false);
  });
});
