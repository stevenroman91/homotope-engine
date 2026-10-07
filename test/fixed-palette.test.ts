// T34 — Palette imposée : aucune couleur inventée, image déjà dans la palette intacte, seuil de
// couverture, tramage, contraintes, invariants topologiques. Sans DOM.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/engine/color/prng.ts';
import {
  coveredColors,
  ditherPixels,
  effectiveQuantize,
  fixedColors,
  quantize,
} from '../src/engine/color/quantize.ts';
import { OklabCache, rgbToOklab, oklabDistance } from '../src/engine/color/oklab.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { PRESET_NAMES, presetOptions } from '../src/engine/presets.ts';
import { segment } from '../src/engine/segment/index.ts';
import {
  buildBoundaryGraph,
  countHoles,
  ringSignedArea,
  validateGraph,
} from '../src/engine/topology/index.ts';
import type {
  FixedPalette,
  PreprocessResult,
  QuantizeOptions,
  RasterImage,
  Rgb,
  VectorizeOptions,
} from '../src/engine/types.ts';
import { pixelError, rasterizeSvg } from '../src/eval/metrics.ts';
import { sideMismatches } from './label-helpers.ts';

const INKS: Rgb[] = [
  [227, 6, 19],
  [0, 87, 184],
  [255, 255, 255],
  [20, 20, 20],
];

const hex = (c: Rgb) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

function fixed(colors: Rgb[], over: Partial<FixedPalette> = {}): FixedPalette {
  return { colors, dither: false, minCoverage: 0, ...over };
}

function qopts(fp: FixedPalette, removed: number[] = [], merged: number[][] = []): QuantizeOptions {
  return {
    colors: 'auto',
    maxColors: 16,
    autoTolerance: 0.02,
    seed: 42,
    constraints: { locked: [[1, 2, 3]], merged, removed },
    fixedPalette: fp,
  };
}

/** Image de bruit coloré (aucune couleur de la palette, à coup sûr). */
function noise(w: number, h: number, seed = 7, alpha = false): RasterImage {
  const rng = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // Blocs de 4×4 de même couleur : des régions, pas seulement du bruit.
    const x = (i % w) >> 2;
    const y = Math.floor(i / w) >> 2;
    const r = mulberry32(seed * 1000 + y * 97 + x)();
    data[i * 4] = Math.floor(r * 256);
    data[i * 4 + 1] = Math.floor(((r * 7) % 1) * 256);
    data[i * 4 + 2] = Math.floor(rng() * 256);
    data[i * 4 + 3] = alpha && x % 3 === 0 && y % 2 === 0 ? 0 : 255;
  }
  return { width: w, height: h, data };
}

/** Image peinte avec les couleurs `colors` (motif de disques et bandes, sans anti-aliasing). */
function painted(w: number, h: number, colors: Rgb[]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = colors[Math.floor((x * colors.length) / w)]!;
      if ((x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 4) ** 2) c = colors[colors.length - 1 - 0]!;
      if ((x - w / 4) ** 2 + (y - h / 3) ** 2 < 25) c = colors[1]!;
      const p = (y * w + x) * 4;
      data.set([c[0], c[1], c[2], 255], p);
    }
  }
  return { width: w, height: h, data };
}

const pre = (image: RasterImage, opaque: Uint8Array | null = null): PreprocessResult => ({
  image,
  scale: 1,
  opaque,
});

/** Couleurs (`fill` et `stroke`) écrites dans un SVG. */
function svgColors(svg: string): Set<string> {
  return new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((m) => m[1]!));
}

function withPalette(preset: (typeof PRESET_NAMES)[number], fp: FixedPalette): VectorizeOptions {
  const o = presetOptions(preset);
  o.quantize.fixedPalette = fp;
  return o;
}

describe('quantize : palette imposée', () => {
  it('au plus N couleurs, toutes dans la palette, RGB exact ; tout pixel opaque assigné', () => {
    const img = noise(64, 48);
    const r = quantize(pre(img), qopts(fixed(INKS)));
    expect(r.palette.colors.length).toBeLessThanOrEqual(INKS.length);
    const inks = new Set(INKS.map(hex));
    for (const c of r.palette.colors) {
      expect(inks.has(hex(c.rgb))).toBe(true);
      expect(c.locked).toBe(true);
    }
    const n = img.width * img.height;
    const counts = new Array(r.palette.colors.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = r.colorIndex[i]!;
      expect(c).toBeGreaterThanOrEqual(0);
      counts[c]++;
    }
    expect(counts).toEqual(r.palette.colors.map((c) => c.count));
  });

  it('chaque pixel va à la couleur imposée la plus proche en OKLab', () => {
    const img = noise(32, 32, 3);
    const r = quantize(pre(img), qopts(fixed(INKS)));
    const labs = INKS.map(rgbToOklab);
    for (let i = 0; i < 32 * 32; i++) {
      const px = rgbToOklab([img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!]);
      const d = labs.map((l) => oklabDistance(px, l));
      const got = hex(r.palette.colors[r.colorIndex[i]!]!.rgb);
      expect(oklabDistance(px, rgbToOklab(INKS.find((c) => hex(c) === got)!))).toBeCloseTo(
        Math.min(...d),
        5,
      );
    }
  });

  it('une image déjà dans la palette est rendue pixel pour pixel', () => {
    const img = painted(40, 30, INKS);
    const r = quantize(pre(img), qopts(fixed(INKS)));
    for (let i = 0; i < 40 * 30; i++) {
      const c = r.palette.colors[r.colorIndex[i]!]!.rgb;
      expect([...c]).toEqual([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
    }
  });

  it('déterministe, sans tirage : graine, colors et maxColors sans effet', () => {
    const img = noise(30, 20);
    const a = quantize(pre(img), qopts(fixed(INKS)));
    const b = quantize(pre(img), { ...qopts(fixed(INKS)), seed: 7, colors: 3, maxColors: 2 });
    expect(b.palette).toEqual(a.palette);
    expect(b.colorIndex).toEqual(a.colorIndex);
  });

  it('doublons exacts retirés, octets normalisés, 64 couleurs au plus', () => {
    expect(fixedColors(fixed([[1, 2, 3], [1, 2, 3], [300, -4, 2.6] as unknown as Rgb]))).toEqual([
      [1, 2, 3],
      [255, 0, 3],
    ]);
    const many = Array.from({ length: 80 }, (_, i): Rgb => [i, i, i]);
    expect(fixedColors(fixed(many))).toHaveLength(64);
  });

  it('palette vide : sans effet (comportement historique)', () => {
    const img = noise(20, 20);
    const base = qopts(fixed([]));
    const without = { ...base };
    delete without.fixedPalette;
    expect(quantize(pre(img), base)).toEqual(quantize(pre(img), without));
  });

  it('transparence : -1 conservé, couleurs toujours dans la palette', () => {
    const img = noise(24, 24, 5, true);
    const opaque = new Uint8Array(24 * 24);
    for (let i = 0; i < opaque.length; i++) opaque[i] = img.data[i * 4 + 3]! >= 128 ? 1 : 0;
    const r = quantize(pre(img, opaque), qopts(fixed(INKS)));
    for (let i = 0; i < opaque.length; i++) {
      if (!opaque[i]) expect(r.colorIndex[i]).toBe(-1);
      else expect(r.colorIndex[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('`removed` s’applique, `merged` et `locked` sont ignorés', () => {
    const img = painted(40, 30, INKS);
    const base = quantize(pre(img), qopts(fixed(INKS)));
    const gone = base.palette.colors[1]!;
    const r = quantize(pre(img), qopts(fixed(INKS), [1], [[0, 2]]));
    const got = r.palette.colors.map((c) => hex(c.rgb));
    expect(got).not.toContain(hex(gone.rgb));
    expect(got.length).toBe(base.palette.colors.length - 1);
    for (const h of got) expect(INKS.map(hex)).toContain(h);
  });
});

describe('seuil de couverture', () => {
  it('coveredColors : seuil inclusif, jamais vide', () => {
    expect(coveredColors(Int32Array.from([50, 3, 47]), 0.05)).toEqual([0, 2]);
    expect(coveredColors(Int32Array.from([5, 5]), 0.5)).toEqual([0, 1]);
    expect(coveredColors(Int32Array.from([1, 9, 9]), 0.9)).toEqual([1]);
    expect(coveredColors(Int32Array.from([0, 0]), 0.1)).toEqual([0]);
  });

  it('une couleur sous le seuil disparaît, ses pixels vont à la plus proche restante', () => {
    // 95 % rouge, 5 % rouge sombre (proche du rouge), palette avec un bleu inutile.
    const w = 100;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c: Rgb = i % w < 95 ? [227, 6, 19] : [150, 10, 20];
      data.set([...c, 255], i * 4);
    }
    const palette: Rgb[] = [
      [227, 6, 19],
      [140, 10, 20],
      [0, 87, 184],
    ];
    const without = quantize(pre({ width: w, height: h, data }), qopts(fixed(palette)));
    expect(without.palette.colors.map((c) => c.count)).toEqual([950, 50, 0]);
    const r = quantize(
      pre({ width: w, height: h, data }),
      qopts(fixed(palette, { minCoverage: 0.06 })),
    );
    expect(r.palette.colors.map((c) => hex(c.rgb))).toEqual(['#e30613']);
    expect(r.palette.colors[0]!.count).toBe(1000);
  });
});

describe('tramage (Floyd–Steinberg dans OKLab)', () => {
  /** Dégradé horizontal du noir au blanc. */
  function gradient(w: number, h: number): RasterImage {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = Math.round((x / (w - 1)) * 255);
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    return { width: w, height: h, data };
  }
  const BW: Rgb[] = [
    [0, 0, 0],
    [255, 255, 255],
  ];

  it('mélange les deux encres sur un dégradé ; sans tramage, une seule frontière', () => {
    const img = gradient(64, 16);
    const plain = quantize(pre(img), qopts(fixed(BW)));
    const dith = quantize(pre(img), qopts(fixed(BW, { dither: true })));
    const transitions = (ci: Int16Array) => {
      let t = 0;
      for (let y = 0; y < 16; y++)
        for (let x = 1; x < 64; x++) if (ci[y * 64 + x] !== ci[y * 64 + x - 1]) t++;
      return t;
    };
    expect(transitions(plain.colorIndex)).toBe(16);
    expect(transitions(dith.colorIndex)).toBeGreaterThan(100);
    for (const c of dith.palette.colors) expect(BW.map(hex)).toContain(hex(c.rgb));
    // Deux colonnes du milieu : des deux encres.
    const mid = new Set<number>();
    for (let y = 0; y < 16; y++) mid.add(dith.colorIndex[y * 64 + 32]!);
    expect(mid.size).toBe(2);
  });

  it('une image déjà dans la palette n’est pas tramée (erreur nulle)', () => {
    const img = painted(40, 30, INKS);
    const a = quantize(pre(img), qopts(fixed(INKS)));
    const b = quantize(pre(img), qopts(fixed(INKS, { dither: true })));
    expect(b.colorIndex).toEqual(a.colorIndex);
  });

  it('ditherPixels par tranches de lignes = d’un seul tenant', () => {
    const img = gradient(20, 9);
    const lab = new OklabCache();
    const cent = Float64Array.from(BW.flatMap((c) => Object.values(rgbToOklab(c))));
    const one = new Int16Array(180);
    const parts = new Int16Array(180);
    const counts = new Int32Array(2);
    const err = new Float32Array(20 * 6);
    ditherPixels(img.data, lab, null, cent, 2, 20, 0, 9, one, counts, err);
    const c1 = Array.from(counts);
    for (const [y0, y1] of [
      [0, 2],
      [2, 3],
      [3, 9],
    ] as const)
      ditherPixels(img.data, lab, null, cent, 2, 20, y0, y1, parts, counts, err);
    expect(parts).toEqual(one);
    expect(Array.from(counts)).toEqual(c1);
  });
});

describe('vectorize : palette imposée', () => {
  // Centre-ligne (T33) : palette imposée ignorée, voir le bloc dédié plus bas.
  for (const preset of PRESET_NAMES.filter((p) => p !== 'centerline')) {
    for (const dither of [false, true]) {
      it(`${preset}${dither ? ' tramé' : ''} : SVG avec au plus N couleurs, toutes imposées`, () => {
        const img = noise(48, 40, 11);
        const r = vectorize(img, withPalette(preset, fixed(INKS, { dither })));
        const used = svgColors(r.svg);
        expect(used.size).toBeGreaterThan(0);
        expect(used.size).toBeLessThanOrEqual(INKS.length);
        for (const c of used) expect(INKS.map(hex)).toContain(c);
        for (const c of r.palette.colors) expect(INKS.map(hex)).toContain(hex(c.rgb));
      });
    }
  }

  it('pixel-art : image déjà dans la palette → même SVG que sans palette, rendu exact', () => {
    const img = painted(40, 30, INKS);
    const o = presetOptions('pixel-art');
    const without = vectorize(img, o);
    const withP = vectorize(img, withPalette('pixel-art', fixed(INKS)));
    expect(withP.svg).toBe(without.svg);
    const err = pixelError(rasterizeSvg(withP.svg, 40), img, o.preprocess.background);
    expect(err.differing).toBe(0);
  });

  it('logo : image déjà dans la palette → exactement les couleurs de l’image', () => {
    const img = decodePng(new Uint8Array(readFileSync('test/fixtures/logo-flat.png')));
    const colors = new Map<string, Rgb>();
    for (let i = 0; i < img.data.length; i += 4) {
      const c: Rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
      colors.set(hex(c), c);
    }
    expect(colors.size).toBeLessThanOrEqual(64);
    const r = vectorize(img, withPalette('logo', fixed([...colors.values()])));
    for (const c of svgColors(r.svg)) expect(colors.has(c)).toBe(true);
  });
});

describe('invariants topologiques avec une palette imposée', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`graine ${seed} : chaînes partagées par deux faces, trous conservés`, () => {
      const img = noise(36, 28, seed, seed % 2 === 0);
      const opaque = new Uint8Array(36 * 28);
      for (let i = 0; i < opaque.length; i++) opaque[i] = img.data[i * 4 + 3]! >= 128 ? 1 : 0;
      const q = quantize(pre(img, opaque), qopts(fixed(INKS, { dither: seed > 2 })));
      const map = segment(q, 36, 28, { minRegionArea: 2, connectivity: 4 });
      const graph = buildBoundaryGraph(map);
      expect(validateGraph(graph)).toEqual([]);
      expect(sideMismatches(map, graph)).toEqual([]);
      const refs = graph.chains.map(() => 0);
      for (const face of graph.faces)
        for (const ring of face.rings) for (const e of ring.edges) refs[e.chain]!++;
      graph.chains.forEach((ch, c) => {
        const sides = (ch.left >= 0 ? 1 : 0) + (ch.right >= 0 ? 1 : 0);
        expect(refs[c]).toBe(sides);
      });
      const holes = countHoles(map);
      graph.faces.forEach((face, f) => {
        expect(face.rings.length - 1).toBe(holes[f]);
        const area = face.rings.reduce((s, r) => s + ringSignedArea(graph, r), 0);
        expect(area).toBe(map.regions[f]!.area);
        expect(INKS.map(hex)).toContain(hex(q.palette.colors[face.colorId]!.rgb));
      });
    });
  }
});

describe('T34 × T33 : palette imposée ignorée en tracé centre-ligne', () => {
  const line = () => decodePng(new Uint8Array(readFileSync('test/fixtures/line-drawing.png')));

  it('effectiveQuantize : retirée sous centre-ligne seulement, même objet sinon', () => {
    const plain = presetOptions('logo');
    expect(effectiveQuantize(plain)).toBe(plain.quantize);
    const logo = withPalette('logo', fixed(INKS));
    expect(effectiveQuantize(logo)).toBe(logo.quantize);
    const cl = withPalette('centerline', fixed(INKS));
    const q = effectiveQuantize(cl);
    expect('fixedPalette' in q).toBe(false);
    expect(cl.quantize.fixedPalette).toBeDefined(); // l'entrée n'est pas modifiée
    expect(q).toEqual(presetOptions('centerline').quantize);
  });

  it('centre-ligne : même SVG avec ou sans palette imposée', () => {
    const img = line();
    const without = vectorize(img, presetOptions('centerline'));
    const withP = vectorize(img, withPalette('centerline', fixed(INKS, { dither: true })));
    expect(withP.svg).toBe(without.svg);
  });
});
