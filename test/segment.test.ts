import { describe, expect, it } from 'vitest';
import { segment } from '../src/engine/segment/index.ts';
import { rgbToOklab } from '../src/engine/color/oklab.ts';
import { mulberry32 } from '../src/engine/color/prng.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type { LabelMap, ProgressEvent, QuantizeResult } from '../src/engine/types.ts';
import { CancelledError } from '../src/engine/types.ts';
import { labelsToAscii, quantFromAscii, randomQuant } from './label-helpers.ts';

const OPT = (minRegionArea: number) => ({ minRegionArea, connectivity: 4 as const });

function seg(rows: string[], min: number, colors = {}): LabelMap {
  const { q, width, height } = quantFromAscii(rows, colors);
  return segment(q, width, height, OPT(min));
}

/** Vérifie relabel dense, aires, bbox et 4-connexité de chaque région. */
function checkRegions(map: LabelMap): void {
  const { width: W, height: H, labels, regions } = map;
  const area = new Array<number>(regions.length).fill(0);
  const bbox = regions.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  let maxSeen = -1;
  for (let i = 0; i < W * H; i++) {
    const l = labels[i]!;
    if (l < 0) continue;
    // ordre de première apparition
    if (l > maxSeen) {
      expect(l).toBe(maxSeen + 1);
      maxSeen = l;
    }
    area[l]!++;
    const x = i % W;
    const y = Math.floor(i / W);
    const b = bbox[l]!;
    b[0] = Math.min(b[0]!, x);
    b[1] = Math.min(b[1]!, y);
    b[2] = Math.max(b[2]!, x);
    b[3] = Math.max(b[3]!, y);
  }
  expect(maxSeen).toBe(regions.length - 1);
  regions.forEach((r, id) => {
    expect(r.id).toBe(id);
    expect(r.area).toBe(area[id]);
    expect(r.bbox).toEqual(bbox[id]);
  });
  // 4-connexité : un parcours depuis le premier pixel atteint toute la région.
  const seen = new Uint8Array(W * H);
  const start = new Int32Array(regions.length).fill(-1);
  for (let i = W * H - 1; i >= 0; i--) if (labels[i]! >= 0) start[labels[i]!] = i;
  regions.forEach((r, id) => {
    const stack = [start[id]!];
    seen[start[id]!] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
      for (const j of nb) {
        if (j < 0 || j >= W * H || seen[j] || labels[j] !== id) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    expect(n).toBe(r.area);
  });
}

describe('segment — composantes 4-connexes', () => {
  it('deux zones de même couleur séparées → deux régions', () => {
    const m = seg(['AABAA', 'AABAA'], 1);
    expect(m.regions.length).toBe(3);
    expect(labelsToAscii(m)).toBe('AABCC\nAABCC');
    expect(m.regions[0]!.colorId).toBe(m.regions[2]!.colorId);
    checkRegions(m);
  });

  it('la diagonale ne relie pas (4-connexité)', () => {
    const m = seg(['AB', 'BA'], 1);
    expect(m.regions.length).toBe(4);
    checkRegions(m);
  });

  it('minRegionArea: 1 n’absorbe rien', () => {
    const m = seg(['ABAB', 'BABA', 'ABAB'], 1);
    expect(m.regions.length).toBe(12);
    checkRegions(m);
  });

  it('transparent ignoré : reste -1, ne forme pas de région, n’absorbe pas', () => {
    const m = seg(['..AAAA', '..AAAA', 'B.AAAA', '......'], 4);
    expect(labelsToAscii(m)).toBe('..AAAA\n..AAAA\nB.AAAA\n......');
    // B (1 px) n'a aucune voisine opaque : il reste.
    expect(m.regions.length).toBe(2);
    expect(m.regions[1]!.area).toBe(1);
    checkRegions(m);
  });

  it('un parasite contre le transparent est absorbé par la voisine opaque', () => {
    const m = seg(['.AAAA', '.BAAA', '.AAAA'], 3);
    expect(labelsToAscii(m)).toBe('.AAAA\n.AAAA\n.AAAA');
  });

  it('bbox et aires exactes, relabel dense', () => {
    const m = seg(['....', '.AA.', '.A..', 'BBBB'], 1);
    expect(m.regions).toEqual([
      { id: 0, colorId: 0, area: 3, bbox: [1, 1, 2, 2] },
      { id: 1, colorId: 1, area: 4, bbox: [0, 3, 3, 3] },
    ]);
  });
});

describe('segment — absorption des petites régions', () => {
  // A : grand fond loin en couleur ; B : plus petit, proche du parasite c.
  const colors = {
    A: [0.2, 0, 0] as [number, number, number],
    B: [0.8, 0, 0] as [number, number, number],
    c: [0.75, 0, 0] as [number, number, number],
  };
  const rows = ['AAAAAAAABBB', 'AAAAAAAcBBB', 'AAAAAAAcBBB', 'AAAAAAAcBBB', 'AAAAAAAABBB'];

  it('parasite de 3 px absorbé par la voisine la plus proche en couleur, pas la plus grande', () => {
    const m = seg(rows, 4, colors);
    expect(m.regions.length).toBe(2);
    expect(labelsToAscii(m)).toBe(
      ['AAAAAAAABBB', 'AAAAAAABBBB', 'AAAAAAABBBB', 'AAAAAAABBBB', 'AAAAAAAABBB'].join('\n'),
    );
    expect(m.regions[1]!.colorId).toBe(1); // couleur de B conservée
    expect(m.regions[1]!.area).toBe(15 + 3);
    checkRegions(m);
  });

  it('la longueur de frontière pondère le choix', () => {
    // c touche A sur 1 px seulement : B (à peine plus loin) l'emporte nettement.
    const m = seg(['AAAAAA', 'AcBBBB', 'BBBBBB'], 2, {
      A: [0.5, 0, 0],
      B: [0.6, 0, 0],
      c: [0.52, 0, 0],
    });
    // c : voisins A (haut 1 + gauche 1 = 2), B (droite 1 + bas 1 = 2) → A (plus proche).
    expect(labelsToAscii(m)).toBe('AAAAAA\nAABBBB\nBBBBBB');
    const m2 = seg(['AAAAAA', 'BcBBBB', 'BBBBBB'], 2, {
      A: [0.5, 0, 0],
      B: [0.6, 0, 0],
      c: [0.53, 0, 0],
    });
    // A : 1 (haut) → 0.03 ; B : 3 → 0.07/3 ≈ 0.023 → B.
    expect(labelsToAscii(m2)).toBe('AAAAAA\nBBBBBB\nBBBBBB');
  });

  it('fusions en cascade jusqu’à stabilité : aucune petite région ne subsiste', () => {
    const q = randomQuant(48, 40, 5, 7);
    const m = segment(q, 48, 40, OPT(6));
    checkRegions(m);
    for (const r of m.regions) expect(r.area).toBeGreaterThanOrEqual(6);
  });

  it('région isolée par le transparent conservée même petite', () => {
    const q = randomQuant(40, 40, 4, 3, { transparent: 0.3 });
    const m = segment(q, 40, 40, OPT(5));
    checkRegions(m);
    const { width: W, height: H, labels } = m;
    for (const r of m.regions) {
      if (r.area >= 5) continue;
      // aucune voisine opaque d'un autre label
      for (let i = 0; i < W * H; i++) {
        if (labels[i] !== r.id) continue;
        const x = i % W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
        for (const j of nb) {
          if (j < 0 || j >= W * H) continue;
          expect(labels[j] === -1 || labels[j] === r.id).toBe(true);
        }
      }
    }
  });

  it('reproductible et ne touche pas aux pixels transparents', () => {
    const q = randomQuant(30, 30, 4, 11, { transparent: 0.2 });
    const a = segment(q, 30, 30, OPT(4));
    const b = segment(q, 30, 30, OPT(4));
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
    for (let i = 0; i < 900; i++) expect(a.labels[i]! < 0).toBe(q.colorIndex[i]! < 0);
  });

  it('progression monotone de l’étape segment, annulation', () => {
    const q = randomQuant(20, 20, 3, 1);
    const ev: ProgressEvent[] = [];
    segment(q, 20, 20, OPT(3), { onProgress: (e) => ev.push(e) });
    expect(ev.length).toBeGreaterThan(1);
    expect(ev.every((e) => e.stage === 'segment')).toBe(true);
    for (let i = 1; i < ev.length; i++)
      expect(ev[i]!.progress).toBeGreaterThanOrEqual(ev[i - 1]!.progress);
    expect(ev[ev.length - 1]!.stageProgress).toBe(1);
    expect(() => segment(q, 20, 20, OPT(3), { cancel: { cancelled: true } })).toThrow(
      CancelledError,
    );
  });
});

describe('segment — bandes d’anti-aliasing (T08)', () => {
  // A et B : deux aplats ; m : bande d'un pixel entre eux, de couleur MÉLANGE
  // (ici 40 % de B) ; k : liseré noir volontaire (pas un mélange de A et B).
  const colors = {
    A: [0.9, 0.05, 0] as [number, number, number],
    B: [0.4, -0.05, 0.1] as [number, number, number],
    m: [0.7, 0.01, 0.04] as [number, number, number],
    k: [0.05, 0, 0] as [number, number, number],
  };
  const segB = (rows: string[], min: number, blendBand = 1.3): LabelMap => {
    const { q, width, height } = quantFromAscii(rows, colors);
    return segment(q, width, height, { ...OPT(min), blendBand });
  };
  const band = (ch: string): string[] => Array.from({ length: 12 }, () => `AAAAAAAA${ch}BBBBBBBB`);

  it('une bande de mélange d’un pixel, plus longue que minRegionArea, est absorbée', () => {
    const m = segB(band('m'), 4);
    expect(m.regions.length).toBe(2);
    // t = 0,4 < 0,5 : la bande rejoint A, la plus proche.
    expect(labelsToAscii(m).split('\n')[0]).toBe('AAAAAAAAABBBBBBBB');
    checkRegions(m);
  });

  it('un liseré noir entre deux aplats n’est pas un mélange : il reste', () => {
    const m = segB(band('k'), 4);
    expect(m.regions.length).toBe(3);
  });

  it('une bande épaisse (3 px) n’est pas une bande d’anti-aliasing', () => {
    const rows = Array.from({ length: 12 }, () => 'AAAAAAAAmmmBBBBBBBB');
    expect(segB(rows, 4).regions.length).toBe(3);
  });

  it('blendBand absent ou 0 : aucune absorption de bande', () => {
    expect(seg(band('m'), 4, colors).regions.length).toBe(3);
    expect(segB(band('m'), 4, 0).regions.length).toBe(3);
  });

  it('épaisseur relative : une bande de 3 px passe avec blendBand = 3 (×3)', () => {
    const rows = Array.from({ length: 12 }, () => 'AAAAAAAAmmmBBBBBBBB');
    expect(segB(rows, 4, 3).regions.length).toBe(2);
  });

  it('minRegionArea = 1 (pixel art) : rien n’est absorbé', () => {
    expect(segB(band('m'), 1).regions.length).toBe(3);
  });
});

describe('segment — fusion des régions de même couleur après absorption (T08)', () => {
  it('le parasite qui séparait deux régions A est absorbé : une seule région A', () => {
    const m = seg(['AAcAA', 'AAcAA', 'AAcAA'], 4, { A: [0.5, 0, 0], c: [0.52, 0, 0] });
    expect(m.regions.length).toBe(1);
    expect(m.regions[0]!.area).toBe(15);
    checkRegions(m);
  });
});

describe('absorbSmallRegions en tableaux typés (F1, #18 point 3)', () => {
  it('2 160 cas : labels et aires identiques à l’implémentation à `Map` (empreinte)', () => {
    // Empreinte FNV-1a des labels et des aires sur les 2 160 cas de #18,
    // calculée avec l'ancienne implémentation (un `Map` par petite région)
    // avant son remplacement : toute dérive de l'absorption la change.
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
      h = Math.imul(h ^ (v >>> 16), 0x01000193) >>> 0;
    };
    let cases = 0;
    for (const nc of [2, 5, 12])
      for (const tr of [0, 0.3])
        for (let seed = 0; seed < 12; seed++)
          for (const mra of [2, 4, 30, 500, 100000])
            for (const bb of [0, 1.3, 3])
              for (const kind of ['vor', 'noise']) {
                const opts =
                  kind === 'vor'
                    ? { seeds: 12, noise: 0.15, transparent: tr }
                    : { transparent: tr };
                const q = randomQuant(64, 40, nc, seed, opts);
                const m = segment(q, 64, 40, {
                  minRegionArea: mra,
                  blendBand: bb,
                  connectivity: 4,
                });
                for (const v of m.labels) mix(v);
                for (const r of m.regions) mix(r.area);
                cases++;
              }
    expect(cases).toBe(2160);
    expect(h).toBe(649803089);
  });

  it('(lent) bruit blanc 24 niveaux 2048² : segment < 10 s, pic de tas < 1 Go', () => {
    const S = 2048;
    const rand = mulberry32(1);
    const colorIndex = new Int16Array(S * S);
    for (let i = 0; i < colorIndex.length; i++) colorIndex[i] = Math.floor(rand() * 24);
    const q: QuantizeResult = {
      colorIndex,
      palette: {
        colors: Array.from({ length: 24 }, (_, id) => {
          const rgb: [number, number, number] = [(id * 53) % 256, (id * 97) % 256, (id * 29) % 256];
          return { id, rgb, oklab: rgbToOklab(rgb), count: 0, locked: false };
        }),
      },
    };
    // Le tas est échantillonné à chaque point de reprise (`checkCancel`).
    let peak = process.memoryUsage().heapUsed;
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    const ctx = {
      onProgress: sample,
      cancel: {
        get cancelled(): boolean {
          sample();
          return false;
        },
      },
    };
    const t0 = performance.now();
    const map = segment(q, S, S, presetOptions('logo').segment, ctx);
    const ms = performance.now() - t0;
    sample();
    expect(map.regions.length).toBe(208494);
    expect(ms).toBeLessThan(10_000);
    expect(peak).toBeLessThan(1e9);
  }, 60_000);
});
