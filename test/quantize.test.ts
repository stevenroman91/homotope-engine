import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { mulberry32 } from '../src/engine/color/prng.ts';
import { rgbToOklab, oklabDistance } from '../src/engine/color/oklab.ts';
import type {
  PaletteConstraints,
  PreprocessResult,
  ProgressEvent,
  QuantizeOptions,
  Rgb,
} from '../src/engine/types.ts';
import { CancelledError } from '../src/engine/types.ts';

const RED: Rgb = [220, 30, 40];
const GREEN: Rgb = [40, 180, 70];
const BLUE: Rgb = [30, 60, 200];
const YELLOW: Rgb = [240, 220, 30];

/** Bandes verticales : `widths[i]!` colonnes de `colors[i]!`, `h` lignes. */
function bands(colors: Rgb[], widths: number[], h: number, noise = 0, seed = 1): PreprocessResult {
  const w = widths.reduce((s, x) => s + x, 0);
  const data = new Uint8ClampedArray(w * h * 4);
  const rng = mulberry32(seed);
  for (let y = 0; y < h; y++) {
    let x = 0;
    for (let c = 0; c < colors.length; c++) {
      for (let j = 0; j < widths[c]!; j++, x++) {
        const p = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          data[p + k] = colors[c]![k]! + (noise ? Math.round((rng() * 2 - 1) * noise) : 0);
        }
        data[p + 3] = 255;
      }
    }
  }
  return { image: { width: w, height: h, data }, scale: 1, opaque: null };
}

function opts(
  over: Partial<QuantizeOptions> = {},
  c: Partial<PaletteConstraints> = {},
): QuantizeOptions {
  return {
    colors: 'auto',
    maxColors: 16,
    autoTolerance: 0.02,
    seed: 42,
    ...over,
    constraints: { locked: [], merged: [], removed: [], ...c },
  };
}

function near(a: Rgb, b: Rgb, tol = 1): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= tol);
}

/** Vérifie la cohérence générale d'un résultat. */
function checkConsistency(res: ReturnType<typeof quantize>, nOpaque: number): void {
  const { colors } = res.palette;
  colors.forEach((c, i) => expect(c.id).toBe(i));
  for (let i = 1; i < colors.length; i++) {
    expect(colors[i - 1]!.count).toBeGreaterThanOrEqual(colors[i]!.count);
  }
  const counts = new Array(colors.length).fill(0);
  for (const ci of res.colorIndex) if (ci >= 0) counts[ci]++;
  expect(counts).toEqual(colors.map((c) => c.count));
  expect(counts.reduce((s, x) => s + x, 0)).toBe(nOpaque);
}

describe('quantize', () => {
  const flat = bands([RED, GREEN, BLUE], [30, 20, 10], 40);

  it('3 couleurs plates → palette de 3 en auto, count exacts, triée', () => {
    const res = quantize(flat, opts());
    expect(res.colorIndex).toBeInstanceOf(Int16Array);
    expect(res.palette.colors.map((c) => c.count)).toEqual([1200, 800, 400]);
    expect(res.palette.colors.map((c) => c.rgb)).toEqual([RED, GREEN, BLUE]);
    expect(res.palette.colors.every((c) => !c.locked)).toBe(true);
    checkConsistency(res, 2400);
  });

  it('3 couleurs + bruit léger → toujours 3', () => {
    const noisy = bands([RED, GREEN, BLUE], [30, 20, 10], 40, 6, 99);
    const res = quantize(noisy, opts());
    expect(res.palette.colors.map((c) => c.count)).toEqual([1200, 800, 400]);
    expect(near(res.palette.colors[0]!.rgb, RED, 2)).toBe(true);
    expect(near(res.palette.colors[1]!.rgb, GREEN, 2)).toBe(true);
    expect(near(res.palette.colors[2]!.rgb, BLUE, 2)).toBe(true);
  });

  it('grande image (sous-échantillon de recherche + affinage) + bruit → 3', () => {
    const big = bands([RED, GREEN, BLUE], [150, 100, 50], 200, 6, 5);
    const res = quantize(big, opts());
    expect(res.palette.colors.map((c) => c.count)).toEqual([30000, 20000, 10000]);
  });

  it('auto borné par maxColors', () => {
    const res = quantize(
      bands([RED, GREEN, BLUE, YELLOW], [10, 10, 10, 10], 10),
      opts({ maxColors: 2 }),
    );
    expect(res.palette.colors).toHaveLength(2);
    checkConsistency(res, 400);
  });

  it('colors: 5 sur 3 couleurs → 5 entrées, somme des count = pixels opaques', () => {
    const res = quantize(flat, opts({ colors: 5 }));
    expect(res.palette.colors).toHaveLength(5);
    checkConsistency(res, 2400);
  });

  it('colors: 2 sur 3 couleurs → 2', () => {
    const res = quantize(flat, opts({ colors: 2 }));
    expect(res.palette.colors).toHaveLength(2);
    checkConsistency(res, 2400);
  });

  it('locked : couleur conservée telle quelle, verrouillée, comptée dans k', () => {
    const lockedColor: Rgb = [200, 50, 60];
    const res = quantize(flat, opts({ colors: 3 }, { locked: [lockedColor] }));
    expect(res.palette.colors).toHaveLength(3);
    const locked = res.palette.colors.filter((c) => c.locked);
    expect(locked).toHaveLength(1);
    expect(locked[0]!.rgb).toEqual(lockedColor);
    // Les pixels rouges vont au verrou le plus proche.
    expect(locked[0]!.count).toBe(1200);
    checkConsistency(res, 2400);
  });

  it('locked en auto : présent même si inutile', () => {
    const lockedColor: Rgb = [0, 0, 0];
    const res = quantize(flat, opts({}, { locked: [lockedColor] }));
    const locked = res.palette.colors.find((c) => c.locked);
    expect(locked?.rgb).toEqual(lockedColor);
    expect(locked?.count).toBe(0);
    expect(res.palette.colors.filter((c) => c.count > 0).map((c) => c.count)).toEqual([
      1200, 800, 400,
    ]);
  });

  it('merged : réduit la palette, moyenne pondérée, réassigne', () => {
    const img = bands([RED, GREEN, BLUE, YELLOW], [40, 30, 20, 10], 10);
    const base = quantize(img, opts({ colors: 4 }));
    expect(base.palette.colors.map((c) => c.count)).toEqual([400, 300, 200, 100]);
    // Fusionne vert (id 1) et jaune (id 3).
    const res = quantize(img, opts({ colors: 4 }, { merged: [[1, 3]] }));
    expect(res.palette.colors.map((c) => c.count)).toEqual([400, 400, 200]);
    const g = rgbToOklab(GREEN);
    const y = rgbToOklab(YELLOW);
    const expected = {
      L: (g.L * 300 + y.L * 100) / 400,
      a: (g.a * 300 + y.a * 100) / 400,
      b: (g.b * 300 + y.b * 100) / 400,
    };
    expect(oklabDistance(res.palette.colors[1]!.oklab, expected)).toBeLessThan(1e-6);
    // Les pixels verts et jaunes partagent désormais le même index.
    const w = img.image.width;
    expect(res.colorIndex[45]).toBe(res.colorIndex[95]!);
    expect(res.colorIndex[45]).toBe(1);
    expect(res.colorIndex[0]).toBe(0);
    expect(res.colorIndex[w + 75]).toBe(2);
    checkConsistency(res, 1000);
  });

  it('merged avec une couleur verrouillée : le verrou ne bouge pas', () => {
    const img = bands([RED, GREEN, BLUE, YELLOW], [40, 30, 20, 10], 10);
    const lockedColor: Rgb = [250, 225, 20];
    const base = quantize(img, opts({ colors: 4 }, { locked: [lockedColor] }));
    const lockedId = base.palette.colors.findIndex((c) => c.locked);
    const greenId = base.palette.colors.findIndex((c) => near(c.rgb, GREEN));
    const res = quantize(
      img,
      opts({ colors: 4 }, { locked: [lockedColor], merged: [[lockedId, greenId]] }),
    );
    expect(res.palette.colors).toHaveLength(3);
    const locked = res.palette.colors.find((c) => c.locked);
    expect(locked?.rgb).toEqual(lockedColor);
    expect(locked?.count).toBe(400);
  });

  it('removed : réassigne au plus proche', () => {
    const img = bands([RED, GREEN, BLUE, YELLOW], [40, 30, 20, 10], 10);
    // Retire le jaune (id 3) : plus proche en OKLab du vert ou du rouge ?
    const yl = rgbToOklab(YELLOW);
    const others = [RED, GREEN, BLUE].map((c) => oklabDistance(yl, rgbToOklab(c)));
    const nearest = others.indexOf(Math.min(...others));
    const res = quantize(img, opts({ colors: 4 }, { removed: [3] }));
    expect(res.palette.colors).toHaveLength(3);
    const expectedCounts = [400, 300, 200];
    expectedCounts[nearest]! += 100;
    expect(res.palette.colors.map((c) => c.count).sort((a, b) => b - a)).toEqual(
      [...expectedCounts].sort((a, b) => b - a),
    );
    const target = res.colorIndex[0 + 95]!;
    expect(res.palette.colors[target]!.rgb).toEqual([RED, GREEN, BLUE][nearest]!);
    checkConsistency(res, 1000);
  });

  it('removed de toutes les couleurs : ignoré', () => {
    const res = quantize(flat, opts({ colors: 3 }, { removed: [0, 1, 2] }));
    expect(res.palette.colors).toHaveLength(3);
    checkConsistency(res, 2400);
  });

  it('removed + merged combinés, ids hors bornes ignorés', () => {
    const img = bands([RED, GREEN, BLUE, YELLOW], [40, 30, 20, 10], 10);
    const res = quantize(
      img,
      opts(
        { colors: 4 },
        {
          merged: [
            [0, 2],
            [7, 1],
          ],
          removed: [3, 99],
        },
      ),
    );
    expect(res.palette.colors).toHaveLength(2);
    checkConsistency(res, 1000);
  });

  it('pixels transparents → -1, ignorés par la palette', () => {
    const img = bands([RED, GREEN, BLUE], [30, 20, 10], 40);
    const n = img.image.width * img.image.height;
    const opaque = new Uint8Array(n).fill(1);
    // Rend transparente toute la bande bleue et un pixel rouge.
    for (let y = 0; y < 40; y++) for (let x = 50; x < 60; x++) opaque[y * 60 + x] = 0;
    opaque[0] = 0;
    const res = quantize({ ...img, opaque }, opts());
    expect(res.colorIndex[0]).toBe(-1);
    expect(res.colorIndex[55]).toBe(-1);
    expect(res.palette.colors.map((c) => c.count)).toEqual([1199, 800]);
    checkConsistency(res, 1999);
  });

  it('image entièrement transparente → palette vide, tout à -1', () => {
    const img = bands([RED], [5], 5);
    const res = quantize({ ...img, opaque: new Uint8Array(25) }, opts());
    expect(res.palette.colors).toHaveLength(0);
    expect(Array.from(res.colorIndex).every((v) => v === -1)).toBe(true);
  });

  it('reproductible : même graine → résultats identiques', () => {
    const img = gradientNoise(300, 200, 5);
    const a = quantize(img, opts({ colors: 12 }));
    const b = quantize(img, opts({ colors: 12 }));
    expect(a.palette).toEqual(b.palette);
    expect(a.colorIndex).toEqual(b.colorIndex);
  });

  it('progression et annulation', () => {
    const events: ProgressEvent[] = [];
    quantize(flat, opts(), { onProgress: (e) => events.push(e) });
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.stage === 'quantize')).toBe(true);
    expect(events[events.length - 1]!.stageProgress).toBe(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.progress).toBeGreaterThanOrEqual(events[i - 1]!.progress);
    }
    expect(() => quantize(flat, opts(), { cancel: { cancelled: true } })).toThrow(CancelledError);
  });

  it('performance : 1000×1000 à 16 couleurs en < 1,5 s', () => {
    const img = gradientNoise(1000, 1000, 3);
    quantize(gradientNoise(64, 64, 4), opts({ colors: 16 })); // échauffement JIT
    const t0 = performance.now();
    const res = quantize(img, opts({ colors: 16 }));
    const dt = performance.now() - t0;
    expect(res.palette.colors).toHaveLength(16);
    checkConsistency(res, 1_000_000);
    expect(dt).toBeLessThan(1500);
  }, 30_000);
});

/** Dégradé 2D + bruit : beaucoup de couleurs uniques (cas « photo »). */
function gradientNoise(w: number, h: number, seed: number): PreprocessResult {
  const rng = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = (x / w) * 255 + (rng() - 0.5) * 20;
      data[p + 1] = (y / h) * 255 + (rng() - 0.5) * 20;
      data[p + 2] = ((x + y) / (w + h)) * 255 + (rng() - 0.5) * 20;
      data[p + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data }, scale: 1, opaque: null };
}

describe('quantize — opacité (T08)', () => {
  it('mode keep : opacité médiane par couleur, absente pour une couleur opaque', () => {
    const img = bands([RED, GREEN], [10, 10], 10);
    const opaque = new Uint8Array(200).fill(1);
    for (let y = 0; y < 10; y++) {
      for (let x = 10; x < 20; x++) img.image.data[(y * 20 + x) * 4 + 3] = 153; // vert à 60 %
      img.image.data[(y * 20 + 9) * 4 + 3] = 140; // bord anti-aliasé du rouge
    }
    const res = quantize({ ...img, opaque }, opts({ colors: 2 }));
    const red = res.palette.colors.find((c) => near(c.rgb, RED, 3))!;
    const green = res.palette.colors.find((c) => near(c.rgb, GREEN, 3))!;
    expect(red.alpha).toBeUndefined(); // médiane 255 malgré le bord
    expect(green.alpha).toBe(153);
  });

  it('mode flatten (opaque = null) : aucune opacité', () => {
    const res = quantize(bands([RED, GREEN], [10, 10], 10), opts({ colors: 2 }));
    expect(res.palette.colors.every((c) => c.alpha === undefined)).toBe(true);
  });
});

describe('quantize — couleurs de cœur (T08)', () => {
  it('les pixels d’anti-aliasing ne tirent pas la couleur : palette exacte', () => {
    // Rouge | colonne mélangée 50/50 | vert : la colonne rejoint l'une des deux
    // couleurs, dont le centroïde k-means se décale ; le cœur, lui, est exact.
    const mid: Rgb = [130, 105, 55];
    const img = bands([RED, mid, GREEN], [10, 1, 10], 12);
    const res = quantize(img, opts({ colors: 2 }));
    const rgbs = res.palette.colors.map((c) => c.rgb);
    expect(rgbs.some((c) => near(c, RED))).toBe(true);
    expect(rgbs.some((c) => near(c, GREEN))).toBe(true);
  });
});
