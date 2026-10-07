// T50 — Contrainte `transparent` : les pixels d'un id de base prennent l'index -1 (aucune face,
// aucun tracé), après `merged`/`removed`, avant le tri ; ignorée si elle rendrait tout
// transparent. Invariants topologiques vérifiés sur la carte produite.
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import { borderColorIds } from '../src/engine/segment/border.ts';
import { segment } from '../src/engine/segment/index.ts';
import { buildBoundaryGraph, countHoles, validateGraph } from '../src/engine/topology/index.ts';
import type {
  PaletteConstraints,
  PreprocessResult,
  QuantizeOptions,
  RasterImage,
  Rgb,
  VectorizeOptions,
} from '../src/engine/types.ts';
import { IMAGE_BORDER, TRANSPARENT } from '../src/engine/types.ts';
import { labelsFromAscii, sideMismatches } from './label-helpers.ts';
import { COLORS, SCENE, rasterFromAscii } from './palette-scene.ts';

const pre = (img: RasterImage): PreprocessResult => ({ image: img, scale: 1, opaque: null });

function qopts(c: Partial<PaletteConstraints> = {}): QuantizeOptions {
  return {
    colors: 4,
    maxColors: 16,
    autoTolerance: 0.02,
    seed: 42,
    constraints: { locked: [], merged: [], removed: [], ...c },
  };
}

const idOf = (rgb: readonly number[], colors: { rgb: Rgb; id: number }[]): number =>
  colors.find((c) => c.rgb.every((v, i) => Math.abs(v - rgb[i]!) <= 2))!.id;

const IMG = rasterFromAscii(SCENE);
const BASE = quantize(pre(IMG), qopts());
const W = idOf(COLORS.W, BASE.palette.colors);
const R = idOf(COLORS.R, BASE.palette.colors);
const B = idOf(COLORS.B, BASE.palette.colors);
const G = idOf(COLORS.G, BASE.palette.colors);

describe('quantize — transparent (T50)', () => {
  it('base : 4 couleurs, le blanc est la plus grande (id 0)', () => {
    expect(BASE.palette.colors).toHaveLength(4);
    expect(W).toBe(0);
  });

  it('ses pixels passent à -1, la couleur sort de la palette, les autres pixels gardent la leur', () => {
    const q = quantize(pre(IMG), qopts({ transparent: [W] }));
    expect(q.palette.colors).toHaveLength(3);
    expect(q.palette.colors.some((c) => c.rgb.every((v) => v > 240))).toBe(false);
    for (let i = 0; i < q.colorIndex.length; i++) {
      const was = BASE.colorIndex[i]!;
      if (was === W) expect(q.colorIndex[i]).toBe(TRANSPARENT);
      else {
        expect(q.colorIndex[i]).toBeGreaterThanOrEqual(0);
        expect(q.palette.colors[q.colorIndex[i]!]!.rgb).toEqual(BASE.palette.colors[was]!.rgb);
      }
    }
    // Ids denses, triés par count.
    q.palette.colors.forEach((c, i) => expect(c.id).toBe(i));
  });

  it('absent ou vide : sortie identique (palette et index)', () => {
    const q = quantize(pre(IMG), qopts({ transparent: [] }));
    expect(q.palette).toEqual(BASE.palette);
    expect(Array.from(q.colorIndex)).toEqual(Array.from(BASE.colorIndex));
  });

  it('tout transparent : ignoré ; transparent + retrait couvrant tout : retrait ignoré', () => {
    const all = quantize(pre(IMG), qopts({ transparent: [W, R, B, G] }));
    expect(all.palette).toEqual(BASE.palette);
    const mixed = quantize(pre(IMG), qopts({ transparent: [W], removed: [R, B, G] }));
    expect(mixed.palette.colors).toHaveLength(3);
    expect(Array.from(mixed.colorIndex).filter((c) => c === TRANSPARENT).length).toBe(
      BASE.palette.colors[W]!.count,
    );
  });

  it('id transparent dans un groupe de fusion : il en sort, ses pixels restent transparents', () => {
    const q = quantize(pre(IMG), qopts({ merged: [[W, R]], transparent: [W] }));
    expect(q.palette.colors).toHaveLength(3);
    const red = q.palette.colors.find((c) => c.rgb[0] > 200 && c.rgb[1] < 60)!;
    // Le rouge n'a pas été moyenné avec le blanc.
    expect(red.rgb).toEqual(BASE.palette.colors[R]!.rgb);
    expect(Array.from(q.colorIndex).filter((c) => c === TRANSPARENT).length).toBe(
      BASE.palette.colors[W]!.count,
    );
  });

  it('ids hors bornes ignorés ; un id à la fois retiré et transparent est transparent', () => {
    expect(quantize(pre(IMG), qopts({ transparent: [99, -1, 1.5] })).palette).toEqual(BASE.palette);
    const q = quantize(pre(IMG), qopts({ transparent: [G], removed: [G] }));
    expect(Array.from(q.colorIndex).filter((c) => c === TRANSPARENT).length).toBe(
      BASE.palette.colors[G]!.count,
    );
  });

  it('palette imposée : transparent s’applique aussi', () => {
    const fixed = { colors: Object.values(COLORS), dither: false, minCoverage: 0 };
    const base = quantize(pre(IMG), { ...qopts(), fixedPalette: fixed });
    const w = idOf(COLORS.W, base.palette.colors);
    const q = quantize(pre(IMG), { ...qopts({ transparent: [w] }), fixedPalette: fixed });
    expect(q.palette.colors).toHaveLength(3);
    expect(Array.from(q.colorIndex).filter((c) => c === TRANSPARENT).length).toBe(
      base.palette.colors[w]!.count,
    );
  });
});

describe('topologie avec un fond transparent (cartes synthétiques)', () => {
  const opts = { minRegionArea: 1, connectivity: 4 as const };

  it('chaînes valides, chacune partagée par deux faces ou une face et le transparent ; trous conservés', () => {
    const q = quantize(pre(IMG), qopts({ transparent: [W] }));
    const map = segment(q, IMG.width, IMG.height, opts);
    const graph = buildBoundaryGraph(map);
    expect(validateGraph(graph)).toEqual([]);
    expect(sideMismatches(map, graph)).toEqual([]);
    const refs = graph.chains.map(() => 0);
    for (const f of graph.faces) for (const r of f.rings) for (const e of r.edges) refs[e.chain]!++;
    graph.chains.forEach((ch, c) => {
      const regions = [ch.left, ch.right].filter((l) => l >= 0).length;
      expect(refs[c]).toBe(regions);
      if (regions === 1)
        expect([ch.left, ch.right].some((l) => l === TRANSPARENT || l === IMAGE_BORDER)).toBe(true);
    });
    expect(graph.chains.some((ch) => ch.left === TRANSPARENT || ch.right === TRANSPARENT)).toBe(
      true,
    );
    // Anneau rouge (1 trou : le bleu), carré bleu et tache verte : 3 faces, aucune blanche.
    expect(graph.faces).toHaveLength(3);
    const holes = countHoles(map);
    const red = map.regions.find((r) => q.palette.colors[r.colorId]!.rgb[0] > 200)!;
    expect(holes[red.id]).toBe(1);
    graph.faces.forEach((f, i) => expect(f.rings.length - 1).toBe(holes[i]));
  });

  it('carte ASCII : une région bordée seulement par le transparent garde ses trous', () => {
    const map = labelsFromAscii(['.....', '.AAA.', '.ABA.', '.AAA.', '.....']);
    const graph = buildBoundaryGraph(map);
    expect(validateGraph(graph)).toEqual([]);
    expect(Array.from(countHoles(map))).toEqual([1, 0]);
  });
});

describe('vectorize — fond transparent (T50)', () => {
  const options = (c: Partial<PaletteConstraints> = {}): VectorizeOptions => {
    const o = presetOptions('logo');
    o.preprocess.denoise = 'none';
    o.preprocess.upsample = 1;
    o.quantize.colors = 4;
    o.quantize.constraints = { ...o.quantize.constraints, ...c };
    return o;
  };

  it('aucune forme blanche ni `<rect>` de fond ; les autres couleurs restent', () => {
    const plain = vectorize(IMG, options());
    expect(plain.svg).toMatch(/<rect /);
    const r = vectorize(IMG, options({ transparent: [W] }));
    expect(r.svg).not.toMatch(/<rect /);
    expect(r.svg.toLowerCase()).not.toContain('#ffffff');
    expect(r.palette.colors).toHaveLength(3);
    expect(r.stats.regions).toBe(3);
  });

  it('borderColors : ids (sortie) des régions qui touchent le bord', () => {
    const r = vectorize(IMG, options());
    const w = idOf(COLORS.W, r.palette.colors);
    const g = idOf(COLORS.G, r.palette.colors);
    expect(r.borderColors).toEqual([w, g].sort((a, b) => a - b));
  });
});

describe('borderColorIds (pur)', () => {
  it('bords seuls, transparent ignoré, triés sans doublon', () => {
    const map = labelsFromAscii(['.AA', 'BCA', 'BBA']);
    // labelsFromAscii : une région par composante, colorId = id de région.
    const ids = borderColorIds(map);
    const c = map.labels[4]!; // centre
    expect(ids).not.toContain(map.regions[c]!.colorId);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
    expect(borderColorIds(labelsFromAscii(['...']))).toEqual([]);
  });
});
