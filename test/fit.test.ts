import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { presetOptions } from '../src/engine/presets.ts';
import { preprocess } from '../src/engine/preprocess/index.ts';
import {
  fitChain,
  fitChains,
  maxDeviation,
  maxDeviationFromCurve,
  thinTolerances,
  reverseFittedChain,
  sampleFittedChain,
} from '../src/engine/fit/index.ts';
import { curveFaithful } from '../src/engine/fit/schneider.ts';
import { segment } from '../src/engine/segment/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import type {
  BoundaryChain,
  BoundaryGraph,
  FitOptions,
  FittedChain,
  ProgressEvent,
} from '../src/engine/types.ts';
import { CancelledError } from '../src/engine/types.ts';
import { labelsFromAscii, randomQuant, rng } from './label-helpers.ts';
import { assertWithinBudget, measureReference, perfBudget, printBudget } from './perf-budget.ts';

/** Ajustement de base (T04) : sans la portée du lissage ni les droites robustes (T43). */
const LOGO: FitOptions = {
  tolerance: 1,
  cornerAngle: 60,
  smoothing: 0.5,
  lineTolerance: 0.5,
  smoothingReach: 0,
  robustLines: false,
  exactShapes: false,
  pixelArt: false,
};
const PIXEL: FitOptions = { ...LOGO, pixelArt: true, smoothing: 0 };

/** Carte ASCII 'a'/'b' : 'a' là où le centre du pixel vérifie `inside`. */
function grid(w: number, h: number, inside: (x: number, y: number) => boolean): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += inside(x + 0.5, y + 0.5) ? 'a' : 'b';
    rows.push(s);
  }
  return rows;
}

function graphOf(rows: string[]): BoundaryGraph {
  return buildBoundaryGraph(labelsFromAscii(rows));
}

/** Chaînes entre deux régions (pas contre le bord de l'image). */
function innerChains(g: BoundaryGraph): BoundaryChain[] {
  return g.chains.filter((c) => c.left >= 0 && c.right >= 0);
}

function endOf(fc: FittedChain): [number, number] {
  const s = fc.segments[fc.segments.length - 1]!;
  return [s.x, s.y];
}

/** Tangente unitaire au départ (sens avant) et à l'arrivée (sens avant) d'une chaîne ajustée. */
function tangents(fc: FittedChain): { t0: [number, number]; t1: [number, number] } {
  const unit = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return [x / l, y / l];
  };
  const f = fc.segments[0]!;
  const t0 =
    f.kind === 'cubic'
      ? unit(f.c1x - fc.start[0], f.c1y - fc.start[1])
      : unit(f.x - fc.start[0], f.y - fc.start[1]);
  const n = fc.segments.length;
  const l = fc.segments[n - 1]!;
  const prev = n > 1 ? fc.segments[n - 2]! : { x: fc.start[0], y: fc.start[1] };
  const t1 = l.kind === 'cubic' ? unit(l.x - l.c2x, l.y - l.c2y) : unit(l.x - prev.x, l.y - prev.y);
  return { t0, t1 };
}

describe('fitChain — formes de référence', () => {
  const disk = grid(120, 120, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 50 * 50);

  it('cercle r = 50 : ≤ 8 cubiques, écart < tolérance', () => {
    const [c] = innerChains(graphOf(disk));
    expect(c!.closed).toBe(true);
    const fc = fitChain(c!, LOGO);
    expect(fc.segments.length).toBeLessThanOrEqual(8);
    expect(fc.segments.every((s) => s.kind === 'cubic')).toBe(true);
    expect(maxDeviation(c!, fc)).toBeLessThan(1);
  });

  it('cercle r = 50, tolérance 0,5 : plus de segments, écart < 0,5', () => {
    const [c] = innerChains(graphOf(disk));
    const loose = fitChain(c!, LOGO);
    const fc = fitChain(c!, { ...LOGO, tolerance: 0.5 });
    expect(fc.segments.length).toBeGreaterThan(loose.segments.length);
    expect(maxDeviation(c!, fc)).toBeLessThan(0.5);
  });

  it('île lisse : tangente continue à l’ancre (pas de coin parasite)', () => {
    for (const r of [12, 25, 50]) {
      const [c] = innerChains(
        graphOf(grid(120, 120, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < r * r)),
      );
      const fc = fitChain(c!, LOGO);
      expect(fc.segments.length).toBeGreaterThan(1);
      expect(endOf(fc)).toEqual([fc.start[0], fc.start[1]]);
      const { t0, t1 } = tangents(fc);
      const cross = t0[0] * t1[1] - t0[1] * t1[0];
      const dot = t0[0] * t1[0] + t0[1] * t1[1];
      expect(Math.abs(cross)).toBeLessThan(1e-6);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('carré 40×40 : exactement 4 lignes sur les coins', () => {
    const [c] = innerChains(graphOf(grid(60, 60, (x, y) => x > 10 && x < 50 && y > 10 && y < 50)));
    const fc = fitChain(c!, LOGO);
    expect(fc.segments.map((s) => s.kind)).toEqual(['line', 'line', 'line', 'line']);
    const pts = [fc.start, ...fc.segments.map((s) => [s.x, s.y] as const)];
    for (const [x, y] of pts) {
      expect([10, 50]).toContain(x);
      expect([10, 50]).toContain(y);
    }
    // Angles droits : côtés successifs perpendiculaires.
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      const [cx, cy] = pts[(i + 2) % 4]!;
      expect(Math.abs((bx - ax) * (cx - bx) + (by - ay) * (cy - by))).toBe(0);
    }
  });

  it('droite à 30° anti-aliasée (escalier) : 1 ligne', () => {
    // Couverture 4×4 sous-échantillons, seuillée à 50 % (quantification à 2 couleurs).
    const t = Math.tan(Math.PI / 6);
    const w = 97; // 10 + 97·tan 30° ≈ 66,0 : extrémités proches de la droite
    const rows = grid(w, 80, (x, y) => {
      let cov = 0;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++)
          if (y - 0.5 + (j + 0.5) / 4 > 10 + (x - 0.5 + (i + 0.5) / 4) * t) cov++;
      return cov >= 8;
    });
    const [c] = innerChains(graphOf(rows));
    expect(c!.closed).toBe(false);
    const fc = fitChain(c!, LOGO);
    expect(fc.segments).toHaveLength(1);
    expect(fc.segments[0]!.kind).toBe('line');
    expect(maxDeviation(c!, fc)).toBeLessThan(LOGO.tolerance);
  });

  it('cornerAngle = 0 : tout est coin (polyligne)', () => {
    const [c] = innerChains(graphOf(grid(30, 30, (x, y) => (x - 15) ** 2 + (y - 15) ** 2 < 64)));
    const fc = fitChain(c!, { ...LOGO, cornerAngle: 0 });
    expect(fc.segments.every((s) => s.kind === 'line')).toBe(true);
  });
});

describe('fitChain — pixel art', () => {
  it('un « L » donne 6 coins aux coordonnées entières exactes', () => {
    const rows = ['bbbbbb', 'baabbb', 'baabbb', 'baabbb', 'baaaab', 'baaaab', 'bbbbbb'];
    const [c] = innerChains(graphOf(rows));
    expect(c!.closed).toBe(true);
    const fc = fitChain(c!, PIXEL);
    expect(fc.segments).toHaveLength(6);
    expect(fc.segments.every((s) => s.kind === 'line')).toBe(true);
    const pts = fc.segments.map((s) => [s.x, s.y]);
    expect(endOf(fc)).toEqual([fc.start[0], fc.start[1]]);
    expect(new Set(pts.map((p) => p.join(','))).size).toBe(6);
    for (const [x, y] of pts) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
    expect(pts.map((p) => p.join(',')).sort()).toEqual(
      ['1,1', '3,1', '3,4', '5,4', '5,6', '1,6'].sort(),
    );
    expect(maxDeviation(c!, fc)).toBe(0);
  });

  it('chaîne ouverte : extrémités conservées, colinéaires fusionnés', () => {
    const chain: BoundaryChain = {
      id: 0,
      points: Float64Array.from([0, 0, 1, 0, 2, 0, 2, 1, 2, 2, 3, 2]),
      start: 0,
      end: 1,
      left: 0,
      right: 1,
      closed: false,
    };
    const fc = fitChain(chain, PIXEL);
    expect(fc.start).toEqual([0, 0]);
    expect(fc.segments).toEqual([
      { kind: 'line', x: 2, y: 0 },
      { kind: 'line', x: 2, y: 2 },
      { kind: 'line', x: 3, y: 2 },
    ]);
  });
});

describe('fitChain — invariants sur carte aléatoire', () => {
  const q = randomQuant(80, 60, 5, 1234, { seeds: 14, noise: 0.03 });
  const map = segment(q, 80, 60, { minRegionArea: 4, connectivity: 4 });
  const g = buildBoundaryGraph(map);

  for (const [name, opts] of [
    ['logo', LOGO],
    ['lissage fort', { ...LOGO, smoothing: 1, tolerance: 2 }],
    ['pixel art', PIXEL],
  ] as const) {
    it(`extrémités strictement conservées, écart < tolérance (${name})`, () => {
      expect(g.chains.length).toBeGreaterThan(20);
      const fitted = fitChains(g.chains, opts);
      expect(fitted).toHaveLength(g.chains.length);
      fitted.forEach((fc, i) => {
        const c = g.chains[i]!;
        const p = c.points;
        const n = p.length / 2;
        expect(fc.chain).toBe(c.id);
        expect(fc.segments.length).toBeGreaterThan(0);
        for (const s of fc.segments) {
          for (const v of Object.values(s))
            if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        }
        if (c.closed) {
          expect(endOf(fc)).toEqual([fc.start[0], fc.start[1]]);
        } else {
          expect(fc.start[0]).toBe(p[0]);
          expect(fc.start[1]).toBe(p[1]);
          expect(endOf(fc)).toEqual([p[2 * n - 2], p[2 * n - 1]]);
        }
        expect(maxDeviation(c, fc)).toBeLessThan(opts.pixelArt ? 1e-12 : opts.tolerance);
      });
    });
  }

  it('reverseFittedChain : même géométrie échantillonnée à rebours', () => {
    for (const c of g.chains.slice(0, 40)) {
      const fc = fitChain(c, LOGO);
      const a = sampleFittedChain(fc, 8);
      const b = sampleFittedChain(reverseFittedChain(fc), 8);
      expect(b.length).toBe(a.length);
      const m = a.length / 2;
      for (let i = 0; i < m; i++) {
        expect(b[2 * i]).toBeCloseTo(a[2 * (m - 1 - i)]!, 9);
        expect(b[2 * i + 1]).toBeCloseTo(a[2 * (m - 1 - i) + 1]!, 9);
      }
    }
  });

  it('une jonction en boucle (start === end, non fermée) garde son ancre', () => {
    const rows = ['bbbbbbb', 'baaaabb', 'baaaabb', 'baaaabb', 'bbbbbcc', 'bbbbbcc'];
    const graph = graphOf(rows);
    const loops = graph.chains.filter((c) => c.start === c.end && !c.closed);
    expect(loops.length).toBeGreaterThan(0);
    for (const c of loops) {
      const fc = fitChain(c, { ...LOGO, smoothing: 1 });
      expect([fc.start[0], fc.start[1]]).toEqual([c.points[0], c.points[1]]);
      expect(endOf(fc)).toEqual([c.points[0], c.points[1]]);
    }
  });
});

describe('fitChains — progression, annulation, performance', () => {
  it('émet la progression de l’étape fit jusqu’à 1 et s’annule', () => {
    const g = graphOf(grid(40, 40, (x, y) => (x - 20) ** 2 + (y - 20) ** 2 < 100));
    const events: ProgressEvent[] = [];
    fitChains(g.chains, LOGO, { onProgress: (e) => events.push(e) });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === 'fit')).toBe(true);
    expect(events[events.length - 1]!.stageProgress).toBe(1);
    expect(() => fitChains(g.chains, LOGO, { cancel: { cancelled: true } })).toThrow(
      CancelledError,
    );
  });

  it('10 000 chaînes de 50 points en < 1 s (× facteur de la machine, T102)', () => {
    // Chemins de treillis (pas unitaires) suivant une direction qui tourne doucement.
    const rand = rng(7);
    const chains: BoundaryChain[] = [];
    for (let k = 0; k < 10000; k++) {
      const pts = new Float64Array(100);
      let x = 0;
      let y = 0;
      let a = rand() * Math.PI * 2;
      const da = (rand() - 0.5) * 0.15;
      let ex = 0;
      let ey = 0;
      for (let i = 1; i < 50; i++) {
        a += da;
        ex += Math.cos(a);
        ey += Math.sin(a);
        if (Math.abs(ex) >= Math.abs(ey)) {
          const s = Math.sign(ex);
          x += s;
          ex -= s;
        } else {
          const s = Math.sign(ey);
          y += s;
          ey -= s;
        }
        pts[2 * i] = x;
        pts[2 * i + 1] = y;
      }
      chains.push({
        id: k,
        points: pts,
        start: 2 * k,
        end: 2 * k + 1,
        left: 0,
        right: 1,
        closed: false,
      });
    }
    fitChains(chains.slice(0, 500), LOGO); // échauffement du JIT
    // T102 : budget nominal 1 000 ms × facteur de la machine (référence chronométrée juste avant).
    const budget = perfBudget(1000, measureReference());
    const t0 = performance.now();
    const out = fitChains(chains, LOGO);
    const dt = performance.now() - t0;
    expect(out).toHaveLength(10000);
    printBudget(assertWithinBudget('fitChains, 10 000 chaînes', dt, budget));
  });
});

describe('fitChain — raffinement des jonctions (T08)', () => {
  // Régression : l'anneau du « O » de logo-aa (r = 48, tangentes à x = 22 et
  // y = 22) sortait en 4 cubiques à 1 px de tolérance pile ; la courbe
  // débordait de 0,6 px à ses extrema (bande d'anti-aliasing parasite au rendu).
  it('« O » de logo-aa : la courbe ne déborde pas des tangentes de plus de 0,25 px', () => {
    const img = decodePng(new Uint8Array(readFileSync('test/fixtures/logo-aa.png')));
    const o = presetOptions('logo');
    const pre = preprocess(img, o.preprocess);
    const q = quantize(pre, o.quantize);
    const g = buildBoundaryGraph(segment(q, img.width, img.height, o.segment));
    const c = g.chains.find((ch) => {
      for (let i = 0; i < ch.points.length; i += 2) {
        if (ch.points[i] === 22 && ch.points[i + 1] === 70) return true;
      }
      return false;
    })!;
    const fc = fitChain(c, o.fit);
    expect(maxDeviation(c, fc)).toBeLessThan(o.fit.tolerance);
    expect(fc.segments.length).toBeLessThanOrEqual(4);
    const p = sampleFittedChain(fc, 64);
    let minX = Infinity;
    let minY = Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]!);
      minY = Math.min(minY, p[i + 1]!);
    }
    expect(minX).toBeGreaterThan(21.75);
    expect(minY).toBeGreaterThan(21.75);
  });

  it('île lisse : ancre sur une tangente diagonale, pas sur un palier d’extremum', () => {
    const [c] = innerChains(
      graphOf(grid(120, 120, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 40 * 40)),
    );
    const fc = fitChain(c!, LOGO);
    const { t0 } = tangents(fc);
    expect(Math.abs(t0[0] * t0[1])).toBeGreaterThan(0.35); // ≈ 45° (0,5), loin d'un axe (0)
  });
});

describe('thinTolerances (T08)', () => {
  it('chaîne bordant une forme de 2 px : tolérance resserrée ; entre formes épaisses : intacte', () => {
    // a | bande b de 2 px | c, sur 40 lignes.
    const rows = Array.from({ length: 40 }, () => 'aaaaaaaaaaaaaaaaaaaabbcccccccccccccccccccc');
    const map = labelsFromAscii(rows);
    const g = buildBoundaryGraph(map);
    const tol = thinTolerances(
      g.chains,
      map.regions.map((r) => r.area),
      2,
    );
    const thinB = g.chains.filter((c) => c.left === 1 || c.right === 1);
    expect(thinB.length).toBeGreaterThan(0);
    // épaisseur de b ≈ 2·80 / (2·40 + 4) ≈ 1,9 → 0,25 × 1,9 ≈ 0,48, plancher 2/3.
    for (const c of thinB) expect(tol[c.id]).toBeCloseTo(2 / 3, 5);
    const wide = thinTolerances(
      g.chains,
      map.regions.map(() => 1e6),
      2,
    );
    for (const c of g.chains) expect(wide[c.id]).toBe(2);
  });
});

describe('garantie bilatérale (F1, #18 point 2)', () => {
  /** Vrai si la polyligne échantillonnée se recoupe (arêtes non voisines). */
  function selfIntersects(s: Float64Array): boolean {
    const e = (s.length >> 1) - 1;
    const loop = s[0] === s[s.length - 2] && s[1] === s[s.length - 1];
    const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (let a = 0; a < e; a++)
      for (let b = a + 2; b < e; b++) {
        if (loop && a === 0 && b === e - 1) continue;
        const [x0, y0, x1, y1] = [s[2 * a]!, s[2 * a + 1]!, s[2 * a + 2]!, s[2 * a + 3]!];
        const [x2, y2, x3, y3] = [s[2 * b]!, s[2 * b + 1]!, s[2 * b + 2]!, s[2 * b + 3]!];
        if (
          o(x2, y2, x3, y3, x0, y0) * o(x2, y2, x3, y3, x1, y1) < 0 &&
          o(x0, y0, x1, y1, x2, y2) * o(x0, y0, x1, y1, x3, y3) < 0
        )
          return true;
      }
    return false;
  }

  it('curveFaithful : poignée au-delà de l’extrémité (micro-boucle) ou courbe qui s’écarte → rejet', () => {
    // Polyligne droite (0,0) → (4,0), 5 points.
    const ox = new Float64Array([0, 1, 2, 3, 4]);
    const oy = new Float64Array(5);
    const tmp = new Float64Array(2);
    const cub = (...v: number[]): Float64Array => new Float64Array(v);
    // Cubique droite, poignées au tiers : acceptée.
    expect(curveFaithful(cub(0, 0, 4 / 3, 0, 8 / 3, 0, 4, 0), ox, oy, 0, 4, 0.5, tmp)).toBe(true);
    // c1 projeté au-delà de l'extrémité (cas de photo.png, chaîne 4) : boucle.
    expect(curveFaithful(cub(0, 0, 5, 0.2, 3, -0.2, 4, 0), ox, oy, 0, 4, 0.5, tmp)).toBe(false);
    // Bosse de 0,6 px au milieu : points d'origine à < 0,5 px des extrémités
    // seulement, courbe → polyligne > tolérance.
    expect(curveFaithful(cub(0, 0, 1, 0.8, 3, 0.8, 4, 0), ox, oy, 0, 4, 0.5, tmp)).toBe(false);
    expect(curveFaithful(cub(0, 0, 1, 0.8, 3, 0.8, 4, 0), ox, oy, 0, 4, 1, tmp)).toBe(true);
  });

  it('photo.png en logo / illustration / dessin au trait : 0 auto-intersection, courbe → polyligne < tolérance', () => {
    const img = decodePng(new Uint8Array(readFileSync('test/fixtures/photo.png')));
    for (const name of ['logo', 'illustration', 'line-art'] as const) {
      const o = presetOptions(name);
      const pre = preprocess(img, o.preprocess);
      expect(pre.scale).toBe(1);
      const q = quantize(pre, o.quantize);
      const map = segment(q, img.width, img.height, o.segment);
      const g = buildBoundaryGraph(map);
      const tol = thinTolerances(
        g.chains,
        map.regions.map((r) => r.area),
        o.fit.tolerance,
      );
      const fitted = fitChains(g.chains, o.fit, undefined, tol);
      let crossings = 0;
      let worst = 0;
      for (const fc of fitted) {
        const c = g.chains[fc.chain]!;
        const t = Math.min(o.fit.tolerance, tol[c.id]!);
        worst = Math.max(worst, maxDeviationFromCurve(c, fc) / t);
        if (selfIntersects(sampleFittedChain(fc, 32))) crossings++;
      }
      expect(crossings, name).toBe(0);
      expect(worst, name).toBeLessThan(1);
    }
  }, 30_000);
});
