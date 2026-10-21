// T125c — Sommets partagés posés sur les formes exactes (`fit.exactShapes`, passe globale de
// `fitChains`). Cartes de labels synthétiques : anneau coupé par une barre (sommets droite ∩
// cercle), deux disques sécants (cercle ∩ cercle), carrefour de quatre couleurs (degré 4, non
// déplacé). Invariants : une seule position par sommet pour toutes ses chaînes, F1 sur les points
// ORIGINAUX, plafond `ROBUST_SNAP`, entrée intacte, réglage éteint = sortie inchangée.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fitChains,
  maxDeviation,
  maxDeviationFromCurve,
  reverseFittedChain,
  sampleFittedChain,
} from '../src/engine/fit/index.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import { CIRCLE, LINE, NONE, intersect } from '../src/engine/fit/vertices.ts';
import { assembleRing } from '../src/engine/svg/rings.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import type { BoundaryChain, FitOptions, FittedChain } from '../src/engine/types.ts';
import { IMAGE_BORDER } from '../src/engine/types.ts';
import { labelsFromAscii } from './label-helpers.ts';
import { assertWithinBudget, measureReference, perfBudget, printBudget } from './perf-budget.ts';

const EXACT: FitOptions = { ...presetOptions('logo').fit, exactShapes: true };
const OFF: FitOptions = { ...EXACT, exactShapes: false };

function grid(w: number, h: number, paint: (x: number, y: number) => string): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += paint(x + 0.5, y + 0.5);
    rows.push(s);
  }
  return rows;
}

const endOf = (fc: FittedChain): readonly [number, number] => {
  const s = fc.segments.at(-1);
  return s ? [s.x, s.y] : fc.start;
};

/** Position de chaque sommet dans les chaînes ajustées : toutes ses extrémités. */
function vertexEnds(chains: BoundaryChain[], fitted: FittedChain[]) {
  const at = new Map<number, [number, number][]>();
  chains.forEach((c, i) => {
    if (c.closed) return;
    const fc = fitted[i]!;
    for (const [v, p] of [
      [c.start, fc.start],
      [c.end, endOf(fc)],
    ] as const) {
      if (!at.has(v)) at.set(v, []);
      at.get(v)!.push([p[0], p[1]]);
    }
  });
  return at;
}

/** Point de treillis d'origine de chaque sommet. */
function vertexOrigins(chains: BoundaryChain[]) {
  const at = new Map<number, [number, number]>();
  for (const c of chains) {
    if (c.closed) continue;
    const p = c.points;
    at.set(c.start, [p[0]!, p[1]!]);
    at.set(c.end, [p[p.length - 2]!, p[p.length - 1]!]);
  }
  return at;
}

function degrees(chains: BoundaryChain[]) {
  const d = new Map<number, number>();
  for (const c of chains) {
    if (c.closed) continue;
    d.set(c.start, (d.get(c.start) ?? 0) + 1);
    d.set(c.end, (d.get(c.end) ?? 0) + 1);
  }
  return d;
}

function expectReversible(fc: FittedChain): void {
  const a = sampleFittedChain(fc, 8);
  const b = sampleFittedChain(reverseFittedChain(fc), 8);
  const n = a.length >> 1;
  for (let i = 0; i < n; i++) {
    expect(b[2 * i]).toBeCloseTo(a[2 * (n - 1 - i)]!, 9);
    expect(b[2 * i + 1]).toBeCloseTo(a[2 * (n - 1 - i) + 1]!, 9);
  }
  expect(reverseFittedChain(reverseFittedChain(fc))).toEqual(fc);
}

// Anneau (centre (70, 70), rayons 50 et 35) coupé par une barre horizontale y ∈ [64, 76] :
// huit sommets de degré 3, chacun à l'intersection d'une droite y = 64 ou 76 et d'un cercle.
const CX = 70;
const CY = 70;
const R_OUT = 50;
const R_IN = 35;
const BAR = [64, 76] as const;
const ringBar = grid(140, 140, (x, y) => {
  if (y > BAR[0] && y < BAR[1] && x > 8 && x < 132) return 'c';
  const r = Math.hypot(x - CX, y - CY);
  return r < R_OUT && r >= R_IN ? 'a' : 'b';
});
const IDEAL: [number, number][] = [];
for (const y of BAR)
  for (const r of [R_OUT, R_IN])
    for (const s of [-1, 1]) IDEAL.push([CX + s * Math.sqrt(r * r - (y - CY) ** 2), y]);

const nearestIdeal = (p: readonly [number, number]): number =>
  Math.min(...IDEAL.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));

describe('T125c — sommets partagés posés sur les formes', () => {
  const graph = buildBoundaryGraph(labelsFromAscii(ringBar));
  const chains = graph.chains;

  it('anneau coupé par une barre : chaque sommet droite ∩ cercle posé à < 0,15 px de l’idéal', () => {
    const deg = degrees(chains);
    const on = vertexEnds(chains, fitChains(chains, EXACT));
    const off = vertexEnds(chains, fitChains(chains, OFF));
    let worstOn = 0;
    let worstOff = 0;
    let seen = 0;
    for (const [v, ends] of on) {
      if (nearestIdeal(ends[0]!) > 1.5 || deg.get(v) !== 3) continue;
      seen++;
      worstOn = Math.max(worstOn, nearestIdeal(ends[0]!));
      worstOff = Math.max(worstOff, nearestIdeal(off.get(v)![0]!));
    }
    expect(seen).toBe(8);
    // Mesuré : treillis entier 0,36 à 0,48 px de l'idéal ; posés : 0,012 px sur le cercle
    // extérieur, 0,105 sur l'intérieur (le cercle de Kåsa d'un trou garde le biais du treillis).
    expect(worstOff).toBeGreaterThan(0.3);
    expect(worstOn).toBeLessThan(0.15);
  });

  it('UNE position par sommet, écrite dans toutes ses chaînes (mêmes coordonnées à l’octet)', () => {
    const fitted = fitChains(chains, EXACT);
    let moved = 0;
    const origin = vertexOrigins(chains);
    for (const [v, ends] of vertexEnds(chains, fitted)) {
      for (const p of ends) expect(p).toEqual(ends[0]);
      const o = origin.get(v)!;
      if (ends[0]![0] !== o[0] || ends[0]![1] !== o[1]) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(8);
  });

  it('plafond : un sommet ne s’éloigne pas de plus de 0,95 × tolérance de son point de treillis', () => {
    const origin = vertexOrigins(chains);
    for (const [v, ends] of vertexEnds(chains, fitChains(chains, EXACT))) {
      const o = origin.get(v)!;
      expect(Math.hypot(ends[0]![0] - o[0], ends[0]![1] - o[1])).toBeLessThanOrEqual(
        0.95 * EXACT.tolerance + 1e-12,
      );
    }
  });

  it('F1 sur les points ORIGINAUX de chaque chaîne, inversion exacte', () => {
    const fitted = fitChains(chains, EXACT);
    chains.forEach((c, i) => {
      expect(maxDeviation(c, fitted[i]!), `chaîne ${c.id}`).toBeLessThan(EXACT.tolerance);
      expect(maxDeviationFromCurve(c, fitted[i]!), `chaîne ${c.id}`).toBeLessThan(EXACT.tolerance);
      expectReversible(fitted[i]!);
    });
  });

  it('anneaux de chaque face assemblés sous JOIN_EPS', () => {
    const fitted = fitChains(chains, EXACT);
    const byChain: FittedChain[] = [];
    for (const fc of fitted) byChain[fc.chain] = fc;
    let rings = 0;
    for (const face of graph.faces)
      for (const ring of face.rings) {
        expect(() => assembleRing(graph, byChain, ring)).not.toThrow();
        rings++;
      }
    expect(rings).toBeGreaterThan(4);
  });

  it('entrée intacte : les points du graphe ne sont pas modifiés', () => {
    const copy = chains.map((c) => Float64Array.from(c.points));
    fitChains(chains, EXACT);
    chains.forEach((c, i) => expect(c.points).toEqual(copy[i]));
  });

  it('réglage éteint : extrémités sur le treillis', () => {
    const origin = vertexOrigins(chains);
    for (const [v, ends] of vertexEnds(chains, fitChains(chains, OFF)))
      for (const p of ends) expect(p).toEqual(origin.get(v));
  });
});

describe('T125c — cercle ∩ cercle et degré 4', () => {
  it('deux disques sécants : sommets à < 0,1 px de l’intersection des deux cercles', () => {
    // Disques de rayon 40 centrés en (60, 70) et (110, 70) : 'a' seul, 'c' seul, 'd' commun. Le
    // treillis sépare chaque croisement en DEUX sommets de degré 3 à 1 px l'un de l'autre.
    const rows = grid(170, 140, (x, y) => {
      const a = Math.hypot(x - 60, y - 70) < 40;
      const c = Math.hypot(x - 110, y - 70) < 40;
      return a && c ? 'd' : a ? 'a' : c ? 'c' : 'b';
    });
    const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
    const h = Math.sqrt(40 * 40 - 25 * 25);
    const ideal: [number, number][] = [
      [85, 70 - h],
      [85, 70 + h],
    ];
    const near = (p: readonly [number, number]) =>
      Math.min(...ideal.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
    const on = vertexEnds(chains, fitChains(chains, EXACT));
    const off = vertexEnds(chains, fitChains(chains, OFF));
    let seen = 0;
    for (const [v, ends] of on) {
      if (near(ends[0]!) > 1.5) continue;
      seen++;
      for (const p of ends) expect(p).toEqual(ends[0]);
      // Mesuré : 0,026 et 0,056 px (treillis : 0,775 et 0,225).
      expect(near(ends[0]!)).toBeLessThan(0.1);
      expect(near(ends[0]!)).toBeLessThan(near(off.get(v)![0]!));
    }
    expect(seen).toBe(4);
  });

  it('carrefour de quatre couleurs (degré 4) : sommet NON déplacé', () => {
    const rows = grid(120, 120, (x, y) => {
      const r = Math.hypot(x - 60, y - 60);
      if (r >= 45) return 'e';
      return x < 60 ? (y < 60 ? 'a' : 'b') : y < 60 ? 'c' : 'd';
    });
    const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
    const deg = degrees(chains);
    const origin = vertexOrigins(chains);
    const ends = vertexEnds(chains, fitChains(chains, EXACT));
    const four = [...deg].filter(([, d]) => d === 4).map(([v]) => v);
    expect(four.length).toBe(1);
    for (const p of ends.get(four[0]!)!) expect(p).toEqual(origin.get(four[0]!));
  });
});

describe('T125c — préréglage Logo de bout en bout', () => {
  it('anneau-barre.png : vectorise, et le réglage forcé hors Logo reste sans effet (centre-ligne)', () => {
    const img = decodePng(new Uint8Array(readFileSync('test/fixtures/anneau-barre.png')));
    expect(vectorize(img, presetOptions('logo')).svg).toMatch(/^<svg /);
    const o = presetOptions('centerline');
    const forced = presetOptions('centerline');
    forced.fit.exactShapes = true;
    expect(vectorize(img, forced).svg).toBe(vectorize(img, o).svg);
  });
});

describe('T125c — de bout en bout (vectorize, Logo)', () => {
  /** Image RGB de la carte `ringBar` : anneau, barre, fond. */
  const COLORS: Record<string, [number, number, number]> = {
    a: [29, 53, 87],
    b: [255, 255, 255],
    c: [230, 57, 70],
  };
  const img = {
    width: 140,
    height: 140,
    data: new Uint8ClampedArray(140 * 140 * 4).map((_, i) => {
      const p = i >> 2;
      const ch = ringBar[Math.floor(p / 140)]![p % 140]!;
      return i % 4 === 3 ? 255 : COLORS[ch]![i % 4]!;
    }),
  };

  /** Extrémités des chaînes ouvertes ; chacune doit être celle d'une AUTRE chaîne, à l'octet. */
  function unsharedEnds(fitted: FittedChain[]): number {
    const key = (p: readonly [number, number]) => `${p[0]},${p[1]}`;
    const count = new Map<string, number>();
    const open = fitted.filter((f) => key(f.start) !== key(endOf(f)));
    for (const f of open)
      for (const p of [f.start, endOf(f)]) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
    return [...count.values()].filter((n) => n < 2).length;
  }

  it('sommets posés hors du treillis, partagés à l’octet par leurs chaînes (sx = sy, puis sx ≠ sy)', () => {
    const o = presetOptions('logo');
    o.preprocess.upsample = 1;
    for (const original of [undefined, { width: 280, height: 140 }]) {
      const res = vectorize(img, o, { debug: true, ...(original ? { original } : {}) });
      const fitted = res.debug!.fitted!;
      expect(unsharedEnds(fitted), JSON.stringify(original)).toBe(0);
      const sx = original ? 2 : 1;
      const offLattice = fitted.filter((f) => !Number.isInteger(f.start[0] / sx));
      expect(offLattice.length).toBeGreaterThan(0);
    }
  });
});

describe('T125c — performance', () => {
  it('budget : 900 anneaux coupés (≈ 7 000 sommets partagés), réglage allumé', () => {
    // Tuiles de 40 px : anneau (rayons 15 et 9) coupé par une barre, ×30 × 30.
    const rows = grid(1200, 1200, (x, y) => {
      const u = x % 40;
      const v = y % 40;
      if (v > 17 && v < 23 && u > 2 && u < 38) return 'c';
      const r = Math.hypot(u - 20, v - 20);
      return r < 15 && r >= 9 ? 'a' : 'b';
    });
    const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
    expect(chains.length).toBeGreaterThan(9000);
    fitChains(chains.slice(0, 500), EXACT);
    // Mesuré (médiane de 7, même machine) : ≈ 180 ms sur `main`, ≈ 340 ms avec la passe (+85 %).
    const budget = perfBudget(1000, measureReference());
    const t0 = performance.now();
    const out = fitChains(chains, EXACT);
    const dt = performance.now() - t0;
    expect(out).toHaveLength(chains.length);
    printBudget(assertWithinBudget('fitChains exactShapes, sommets partagés', dt, budget));
  });
});

// Relecture T125c : chaque décision de la passe a son test.
describe('T125c — tolérances par chaîne, bord, droite ∩ droite, replis, pointe fine', () => {
  const ringBarGraph = buildBoundaryGraph(labelsFromAscii(ringBar));

  it('candidat accepté sous la tolérance la plus LARGE, déplacement plafonné par la plus STRICTE', () => {
    const chains = ringBarGraph.chains;
    // Sommet (36, 64) : treillis à 0,377 px de son point posé (barre ∩ cercle intérieur).
    const v = chains.find((c) => !c.closed && c.points[0] === 36 && c.points[1] === 64)!.start;
    const at = chains.filter((c) => !c.closed && (c.start === v || c.end === v));
    expect(at).toHaveLength(3);
    // Une chaîne droite du sommet, resserrée à 0,33 (bande mince, T08) ; les autres à 1,0.
    const thin = at.find((c) => c.points[3] === 64 && c.points[c.points.length - 1] === 64)!;
    const tolerances = new Float64Array(chains.length + 1).fill(1);
    tolerances[thin.id] = 0.33;
    const fitted = fitChains(chains, EXACT, undefined, tolerances);
    const p = vertexEnds(chains, fitted).get(v)![0]!;
    // 0,377 > 0,33 : rejeté si le seuil d'acceptation était la plus stricte ; 0,95 × 0,33 sinon.
    expect(Math.hypot(p[0] - 36, p[1] - 64)).toBeCloseTo(0.95 * 0.33, 9);
  });

  it('sommet d’une chaîne du bord de l’image : non déplacé', () => {
    // Disque coupé par le bord gauche : ses sommets sont sur des chaînes IMAGE_BORDER.
    const rows = grid(100, 100, (x, y) => (Math.hypot(x + 10.4, y - 50.3) < 40 ? 'a' : 'b'));
    const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
    const border = new Set<number>();
    for (const c of chains)
      if (c.left === IMAGE_BORDER || c.right === IMAGE_BORDER) border.add(c.start).add(c.end);
    const origin = vertexOrigins(chains);
    let seen = 0;
    for (const [v, ends] of vertexEnds(chains, fitChains(chains, EXACT))) {
      if (!border.has(v)) continue;
      seen++;
      for (const p of ends) expect(p).toEqual(origin.get(v));
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('droite ∩ droite : trois secteurs droits, sommet posé sur leur point commun', () => {
    // Trois demi-droites issues de (60,4 ; 60,7), à 90°, 210° et 330°, dans un disque.
    const C = [60.4, 60.7] as const;
    const rows = grid(120, 120, (x, y) => {
      if (Math.hypot(x - 60, y - 60) >= 50) return 'e';
      const a = (Math.atan2(y - C[1], x - C[0]) * 180) / Math.PI;
      return a >= -90 && a < 30 ? 'a' : a >= 30 && a < 150 ? 'b' : 'c';
    });
    const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
    const near = (p: readonly [number, number]) => Math.hypot(p[0] - C[0], p[1] - C[1]);
    const on = vertexEnds(chains, fitChains(chains, EXACT));
    const off = vertexEnds(chains, fitChains(chains, OFF));
    const center = [...on].filter(([, e]) => near(e[0]!) < 2);
    expect(center).toHaveLength(1);
    const [v, ends] = center[0]!;
    for (const p of ends) expect(p).toEqual(ends[0]);
    expect(near(ends[0]!)).toBeLessThan(near(off.get(v)![0]!));
    expect(near(ends[0]!)).toBeLessThan(0.3);
  });

  it('replis de l’intersection : parallèles, sans racine, cercles disjoints ou concentriques, angle rasant', () => {
    const kind = new Uint8Array([LINE, LINE, CIRCLE, CIRCLE, NONE]);
    const pt = new Float64Array(2);
    const run = (e: number, f: number, s: number[]) =>
      intersect(kind, Float64Array.from(s), e, f, 0, 0, pt);
    const L = (x: number, y: number, ux: number, uy: number) => [x, y, ux, uy];
    const C = (x: number, y: number, r: number) => [x, y, r, 0];
    // Droites parallèles.
    expect(run(0, 1, [...L(0, 0, 1, 0), ...L(0, 1, 1, 0), ...C(0, 0, 1), ...C(0, 0, 1)])).toBe(
      false,
    );
    // Droite qui manque le cercle.
    expect(run(0, 2, [...L(0, 5, 1, 0), ...L(0, 0, 1, 0), ...C(0, 0, 1), ...C(0, 0, 1)])).toBe(
      false,
    );
    // Cercles disjoints, puis concentriques.
    expect(run(2, 3, [...L(0, 0, 1, 0), ...L(0, 0, 1, 0), ...C(0, 0, 1), ...C(5, 0, 1)])).toBe(
      false,
    );
    expect(run(2, 3, [...L(0, 0, 1, 0), ...L(0, 0, 1, 0), ...C(0, 0, 1), ...C(0, 0, 2)])).toBe(
      false,
    );
    // Droites à 10° : sous VERTEX_MIN_ANGLE.
    const t = (10 * Math.PI) / 180;
    expect(
      run(0, 1, [
        ...L(0, 0, 1, 0),
        ...L(0, 0, Math.cos(t), Math.sin(t)),
        ...C(0, 0, 1),
        0,
        0,
        0,
        0,
      ]),
    ).toBe(false);
    // Forme absente.
    expect(
      run(0, 4, [...L(0, 0, 1, 0), ...L(0, 0, 0, 1), ...C(0, 0, 1), 0, 0, 0, 0, 0, 0, 0, 0]),
    ).toBe(false);
    // Témoins : droite ∩ droite à 90°, droite ∩ cercle.
    expect(run(0, 1, [...L(0, 2, 1, 0), ...L(3, 0, 0, 1), ...C(0, 0, 1), 0, 0, 0, 0])).toBe(true);
    expect([...pt]).toEqual([3, 2]);
    expect(run(0, 2, [...L(0, 0, 1, 0), ...L(0, 0, 1, 0), ...C(0, 0, 2), 0, 0, 0, 0])).toBe(true);
    expect(pt[0]).toBeCloseTo(2, 12);
  });

  it('replis de bout en bout : aucune coordonnée non finie dans les chaînes ajustées', () => {
    const graphs = [ringBar, grid(80, 80, (x, y) => (x < 40 ? (y < 40 ? 'a' : 'b') : 'c'))];
    for (const rows of graphs) {
      const chains = buildBoundaryGraph(labelsFromAscii(rows)).chains;
      for (const fc of fitChains(chains, EXACT)) {
        const xs = [fc.start[0], fc.start[1]];
        for (const s of fc.segments)
          xs.push(s.x, s.y, ...(s.kind === 'cubic' ? [s.c1x, s.c1y, s.c2x, s.c2y] : []));
        for (const v of xs) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('pointe fine (< 30°, tolérances additionnées ≥ écart) : sommet non déplacé', () => {
    // Sommet 0 en (0, 0) : A et B partent vers la gauche à 1 px l'une de l'autre (sans forme,
    // 11 points), C est une droite y ≈ 0,95 (21 points) sur laquelle il serait projeté.
    const chain = (id: number, pts: number[], end: number): BoundaryChain => ({
      id,
      points: Float64Array.from(pts),
      start: 0,
      end,
      left: 0,
      right: 1,
      closed: false,
    });
    const a: number[] = [];
    const b: number[] = [0, 0, 0, -1];
    const c: number[] = [0, 0];
    for (let i = 0; i <= 10; i++) a.push(0 - i || 0, 0);
    for (let i = 1; i <= 10; i++) b.push(-i, -1);
    for (let i = 1; i <= 20; i++) c.push(i, 1);
    const chains = [chain(0, a, 1), chain(1, b, 2), chain(2, c, 3)];
    const ends = vertexEnds(chains, fitChains(chains, EXACT)).get(0)!;
    for (const p of ends) expect(p).toEqual([0, 0]);
    // Témoin : sans la chaîne B (pas de pointe), le même sommet bouge vers la droite de C.
    const two = [chains[0]!, chains[2]!];
    const moved = vertexEnds(two, fitChains(two, EXACT)).get(0)![0]!;
    expect(moved[1]).toBeGreaterThan(0.5);
  });
});
