// T125a — Formes exactes : cercles, arcs et droites posés exactement (`fit.exactShapes`).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fitChain,
  fitChains,
  maxDeviation,
  maxDeviationFromCurve,
  reverseFittedChain,
  sampleFittedChain,
} from '../src/engine/fit/index.ts';
import { fitCircle } from '../src/engine/fit/circle.ts';
import { decodeJpeg, decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { DEFAULT_OPTIONS, presetOptions } from '../src/engine/presets.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import type { BoundaryChain, FitOptions, FittedChain, PresetName } from '../src/engine/types.ts';
import { labelsFromAscii } from './label-helpers.ts';
import { assertWithinBudget, measureReference, perfBudget, printBudget } from './perf-budget.ts';

const EXACT: FitOptions = { ...presetOptions('logo').fit, exactShapes: true };
const OFF: FitOptions = { ...EXACT, exactShapes: false };

/** Carte ASCII : la lettre de `paint` au centre de chaque pixel. */
function grid(w: number, h: number, paint: (x: number, y: number) => string): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += paint(x + 0.5, y + 0.5);
    rows.push(s);
  }
  return rows;
}

const chainsOf = (rows: string[]): BoundaryChain[] =>
  buildBoundaryGraph(labelsFromAscii(rows)).chains.filter((c) => c.left >= 0 && c.right >= 0);

/** Rayon crête à crête de la courbe (échantillonnée finement) autour de (cx, cy). */
function radialPeakToPeak(fc: FittedChain, cx: number, cy: number, from = 0, to = Infinity) {
  const p = sampleFittedChain(fc, 256);
  let lo = Infinity;
  let hi = -Infinity;
  const steps = 256;
  for (let i = 0; i < p.length; i += 2) {
    const seg = Math.floor((i / 2 - 1) / steps);
    if (i > 0 && (seg < from || seg >= to)) continue;
    if (i === 0 && from > 0) continue;
    const r = Math.hypot(p[i]! - cx, p[i + 1]! - cy);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  return hi - lo;
}

const cubics = (fc: FittedChain): number => fc.segments.filter((s) => s.kind === 'cubic').length;

function expectFaithful(c: BoundaryChain, fc: FittedChain, tol: number): void {
  expect(maxDeviation(c, fc)).toBeLessThan(tol);
  expect(maxDeviationFromCurve(c, fc)).toBeLessThan(tol);
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

const disk = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  Math.hypot(x - cx, y - cy) < r ? 'a' : 'b';

describe('T125a — cercle exact', () => {
  it('disque r = 50 : exactement 4 cubiques, rayon crête à crête < 0,05 px, F1', () => {
    const [c] = chainsOf(grid(120, 120, disk(60, 60, 50)));
    const before = fitChain(c!, OFF);
    const fc = fitChain(c!, EXACT);
    expect(fc.segments).toHaveLength(4);
    expect(cubics(fc)).toBe(4);
    const p2p = radialPeakToPeak(fc, 60, 60);
    expect(p2p).toBeLessThan(0.05);
    // Le chemin habituel ondule nettement plus (garde : la mesure distingue).
    expect(radialPeakToPeak(before, 60, 60)).toBeGreaterThan(5 * p2p);
    // Nœuds aux quatre extrema, départ à l'angle 0 (point le plus à droite).
    expect(fc.start[0]).toBeCloseTo(110, 1);
    expect(fc.start[1]).toBeCloseTo(60, 6);
    expectFaithful(c!, fc, EXACT.tolerance);
    expectReversible(fc);
  });

  it('anneau (deux cercles) : chaque bord est un cercle exact', () => {
    const rows = grid(140, 140, (x, y) => {
      const r = Math.hypot(x - 70, y - 70);
      return r < 30 ? 'c' : r < 60 ? 'a' : 'b';
    });
    const chains = chainsOf(rows);
    expect(chains).toHaveLength(2);
    for (const c of chains) {
      const fc = fitChain(c, EXACT);
      expect(cubics(fc)).toBe(4);
      expect(radialPeakToPeak(fc, 70, 70)).toBeLessThan(0.05);
      expectFaithful(c, fc, EXACT.tolerance);
      expectReversible(fc);
    }
  });

  it('petit disque r = 4 : pas reconnu (rayon minimal), sortie inchangée', () => {
    const [c] = chainsOf(grid(16, 16, disk(8, 8, 4)));
    expect(fitChain(c!, EXACT)).toEqual(fitChain(c!, OFF));
  });

  it('ellipse franche (60 × 40) : pas un cercle, sortie inchangée', () => {
    const [c] = chainsOf(
      grid(140, 100, (x, y) => (((x - 70) / 60) ** 2 + ((y - 50) / 40) ** 2 < 1 ? 'a' : 'b')),
    );
    expect(fitChain(c!, EXACT)).toEqual(fitChain(c!, OFF));
  });
});

describe('T125a — arc exact entre deux droites', () => {
  // Part de tarte de 120° (rayon 50, sommet en (60, 70)) coupée par la bande 'c' sous y = 55 :
  // la chaîne a|b est OUVERTE (extrémités = jonctions avec 'c') : droite, arc de 120°, droite.
  const rows = grid(120, 90, (x, y) => {
    if (y > 55) return 'c';
    const dx = x - 60;
    const dy = y - 70;
    const ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
    return Math.hypot(dx, dy) < 50 && ang > 30 && ang < 150 ? 'a' : 'b';
  });
  // La chaîne a|b est la seule qui monte au sommet de l'arc (y = 20).
  const ab = chainsOf(rows).filter((ch) => ch.points.some((v, i) => i % 2 === 1 && v <= 21));

  it('droite, 2 cubiques de 60° sur le cercle, droite ; extrémités conservées ; F1', () => {
    expect(ab).toHaveLength(1);
    const ch = ab[0]!;
    expect(ch.closed).toBe(false);
    const fc = fitChain(ch, EXACT);
    const before = fitChain(ch, OFF);
    const kinds = fc.segments.map((s) => s.kind).join(',');
    expect(kinds).toBe('line,cubic,cubic,line');
    const n = ch.points.length;
    expect(fc.start).toEqual([ch.points[0], ch.points[1]]);
    const end = fc.segments.at(-1)!;
    expect([end.x, end.y]).toEqual([ch.points[n - 2], ch.points[n - 1]]);
    // Arc ROND : moitié centrale, rayon crête à crête autour de son propre cercle de Kåsa. Les
    // extrémités restent sur le treillis (T125c les posera sur le cercle).
    const central = (f: FittedChain): number => {
      const p = sampleFittedChain(f, 256).subarray(2 * (1 + 256 + 128), 2 * (1 + 3 * 256 - 128));
      const n = p.length >> 1;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) [x[i], y[i]] = [p[2 * i]!, p[2 * i + 1]!];
      const c = new Float64Array(3);
      return 2 * fitCircle(x, y, 0, n - 1, c);
    };
    // Mesuré : 0,056 px (le raccord de 0,26 px aux extrémités s'éteint le long des cubiques),
    // contre 0,109 px sans le réglage.
    expect(central(fc)).toBeLessThan(0.08);
    expect(central(fc)).toBeLessThan(0.6 * central(before));
    // Les deux cubiques de l'arc sont tangentes (G1) à leur jonction.
    const c1 = fc.segments[1]!;
    const c2 = fc.segments[2]!;
    if (c1.kind !== 'cubic' || c2.kind !== 'cubic') throw new Error('cubiques attendues');
    const u = [c1.x - c1.c2x, c1.y - c1.c2y];
    const v = [c2.c1x - c1.x, c2.c1y - c1.y];
    const sin =
      Math.abs(u[0]! * v[1]! - u[1]! * v[0]!) / Math.hypot(u[0]!, u[1]!) / Math.hypot(v[0]!, v[1]!);
    expect(sin).toBeLessThan(1e-9);
    expectFaithful(ch, fc, EXACT.tolerance);
    expectReversible(fc);
  });
});

/** Sinus des angles aux nœuds entre cubiques consécutives (0 = raccord G1 exact). */
function joinSines(fc: FittedChain, closed: boolean): number[] {
  const s = fc.segments;
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const a = s[i]!;
    const b = s[(i + 1) % s.length]!;
    if (!closed && i === s.length - 1) break;
    if (a.kind !== 'cubic' || b.kind !== 'cubic') continue;
    const u = [a.x - a.c2x, a.y - a.c2y] as const;
    const v = [b.c1x - a.x, b.c1y - a.y] as const;
    out.push(Math.abs(u[0] * v[1] - u[1] * v[0]) / Math.hypot(...u) / Math.hypot(...v));
  }
  return out;
}

/** Aire signée d'une chaîne ajustée échantillonnée (sens de parcours). */
function signedArea(fc: FittedChain): number {
  const p = sampleFittedChain(fc, 16);
  let a = 0;
  for (let i = 0; i + 3 < p.length; i += 2) a += p[i]! * p[i + 3]! - p[i + 2]! * p[i + 1]!;
  return a / 2;
}

describe('T125a — gardes', () => {
  it('cercle de Kåsa accepté mais F1 en échec sur une cubique : sortie de Schneider, fidèle', () => {
    const [c] = chainsOf(grid(120, 120, disk(60, 60, 50)));
    const n = c!.points.length >> 1;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) [x[i], y[i]] = [c!.points[2 * i]!, c!.points[2 * i + 1]!];
    const rho = fitCircle(x, y, 0, n - 1, new Float64Array(3));
    // Tolérance à peine au-dessus du résidu radial : le cercle passe `circleOf`, mais l'écart
    // des cubiques (vers l'extérieur) fait échouer F1 (`arcCubics` rend 0).
    const tight: FitOptions = { ...EXACT, tolerance: rho + 0.005, lineTolerance: rho + 0.005 };
    const fc = fitChain(c!, tight);
    expect(fc).toEqual(fitChain(c!, { ...tight, exactShapes: false }));
    expectFaithful(c!, fc, tight.tolerance);
    // Témoin : avec un peu de marge, le même cercle est posé (le refus venait bien de F1).
    const loose: FitOptions = { ...tight, tolerance: rho + 0.1, lineTolerance: rho + 0.1 };
    expect(cubics(fitChain(c!, loose))).toBe(4);
    expect(fitChain(c!, loose).segments).toHaveLength(4);
  });

  it('arc de 270° de rayon 60 (> EXACT_ARC_REF) : ≥ 3 cubiques tangentes sur le cercle, F1', () => {
    // « Pac-Man » : disque r = 60 moins un quart (île à coins) : droites puis un arc de 270°.
    const [c] = chainsOf(
      grid(140, 140, (x, y) => {
        const dx = x - 70;
        const dy = y - 70;
        return Math.hypot(dx, dy) < 60 && !(dx > 0 && Math.abs(dy) < dx) ? 'a' : 'b';
      }),
    );
    const fc = fitChain(c!, EXACT);
    const k = cubics(fc);
    expect(k).toBeGreaterThanOrEqual(3);
    for (const sn of joinSines(fc, true)) expect(sn).toBeLessThan(1e-9);
    // Nœuds intérieurs de l'arc (hors extrémités, sommets du treillis) sur le cercle dessiné.
    const nodes = fc.segments
      .map((s, i) => ({ s, next: fc.segments[(i + 1) % fc.segments.length]! }))
      .filter(({ s, next }) => s.kind === 'cubic' && next.kind === 'cubic')
      .map(({ s }) => Math.hypot(s.x - 70, s.y - 70));
    expect(nodes.length).toBe(k - 1);
    // Écart du centre de Kåsa au centre dessiné : < 0,01 px.
    expect(Math.max(...nodes) - Math.min(...nodes)).toBeLessThan(0.01);
    expectFaithful(c!, fc, EXACT.tolerance);
    expectReversible(fc);
  });

  it('île parcourue dans les deux sens : cercle exact, sens gardé', () => {
    const [c] = chainsOf(grid(120, 120, disk(60, 60, 50)));
    const m = c!.points.length >> 1;
    const rev = new Float64Array(c!.points.length);
    for (let i = 0; i < m; i++) {
      rev[2 * i] = c!.points[2 * (m - 1 - i)]!;
      rev[2 * i + 1] = c!.points[2 * (m - 1 - i) + 1]!;
    }
    const r = { ...c!, points: rev };
    const a = fitChain(c!, EXACT);
    const b = fitChain(r, EXACT);
    for (const [ch, fc] of [
      [c!, a],
      [r, b],
    ] as const) {
      expect(cubics(fc)).toBe(4);
      expect(radialPeakToPeak(fc, 60, 60)).toBeLessThan(0.05);
      for (const sn of joinSines(fc, true)) expect(sn).toBeLessThan(1e-9);
      expectFaithful(ch, fc, EXACT.tolerance);
    }
    expect(Math.sign(signedArea(a))).toBe(-Math.sign(signedArea(b)));
    expect(Math.abs(signedArea(a))).toBeCloseTo(Math.PI * 50 * 50, -2);
  });

  it('image réduite sur un seul axe (sx ≠ sy) : ellipse exacte, raccords G1 conservés', () => {
    const rows = grid(120, 120, disk(60, 60, 50));
    const img = {
      width: 120,
      height: 120,
      data: new Uint8ClampedArray(120 * 120 * 4).map((_, i) => {
        const p = i >> 2;
        const ink = rows[Math.floor(p / 120)]![p % 120] === 'a';
        return i % 4 === 3 ? 255 : ink ? 20 : 240;
      }),
    };
    const o = presetOptions('logo');
    o.quantize.colors = 2;
    o.preprocess.upsample = 1;
    // Image d'origine 240 × 120 réduite à 120 × 120 : sx = 1/2, sy = 1.
    const res = vectorize(img, o, { debug: true, original: { width: 240, height: 120 } });
    const fc = res.debug!.fitted!.find((f) => f.segments.length === 4 && cubics(f) === 4)!;
    expect(fc).toBeDefined();
    for (const sn of joinSines(fc, true)) expect(sn).toBeLessThan(1e-9);
    // Ellipse de demi-axes 100 et 50 : (x / 2, y) est le cercle exact de rayon 50.
    const p = sampleFittedChain(fc, 256);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const r = Math.hypot(p[i]! / 2 - 60, p[i + 1]! - 60);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(hi - lo).toBeLessThan(0.05);
  });
});

describe('T125a — réglage', () => {
  it('allumé par Logo et Noir et blanc ; éteint ailleurs (Dessin au trait compris)', () => {
    expect(DEFAULT_OPTIONS.fit.exactShapes).toBe(false);
    const on: PresetName[] = ['logo', 'black-white'];
    for (const p of [
      'logo',
      'black-white',
      'line-art',
      'illustration',
      'photo',
      'pixel-art',
      'centerline',
    ] as const) {
      expect(presetOptions(p).fit.exactShapes, p).toBe(on.includes(p));
    }
  });

  // Empreintes figées sur `main` AVANT T125a (révision 65845f6) : CHAQUE fixture dans chacun
  // des préréglages qui n'allument pas le réglage sort identique à l'octet (précédent T43). Un
  // changement VOULU de ces préréglages remet ces empreintes à jour dans sa PR.
  const OFF_PRESETS = ['illustration', 'photo', 'pixel-art', 'centerline', 'line-art'] as const;
  const FROZEN: Record<string, string[]> = {
    'alpha.png': ['846176eb5125', 'ebd8df6c8f4e', 'c0515b3a63c5', '60a244061540', 'b44127b5cf26'],
    'anneau-barre.png': [
      'b6ec73a008e1',
      '3529d9b86aa4',
      '156292191217',
      'd67dc5cf0d32',
      'f8d92ca4f6d2',
    ],
    'anneau.png': ['435bab88b26b', '9c48cd83f662', 'c91526684218', '74776ea9c8b0', '44a91cbf6753'],
    'badge.png': ['9f4f7b32c22a', '577053873114', '565f6d794878', 'a75b12ca2770', 'bfb22d679c3e'],
    'icon-64.png': ['86d44d0dfe58', '057b45272a3a', 'adb4504bf38d', 'e6d70ceee847', '759a8378b0ec'],
    'illustration.png': [
      'c1aadd32b1be',
      '7f18bff3d858',
      'dc7686881938',
      'b2cb492fcf3e',
      '7c389830c93c',
    ],
    'lettres-geo.png': [
      '608663153c91',
      '8a28acca7221',
      '9d7aad6db058',
      'a31be9ab084b',
      '3d3be7619ab8',
    ],
    'line-drawing.png': [
      'faa481a528a4',
      '4ef441d11cad',
      '12dc92b75891',
      '4e66ef25eb19',
      '144b797b698d',
    ],
    'logo-aa.png': ['66e58914be6a', 'e03bfc59792d', 'b5351b557efd', '281386719662', '46467d8b2637'],
    'logo-flat.png': [
      '6b46f2ca385a',
      '954e4c05da10',
      '63d2d51ccf17',
      'e02a3c44dd0b',
      '3191937e8f9a',
    ],
    'logo-jpeg.jpg': [
      '59a95c92dda9',
      '20cfc26171e3',
      'bad9fe22efa1',
      '0c11feda9342',
      '55bebeb3a414',
    ],
    'photo.png': ['a9b4fad1411f', 'e93372a85428', 'acca751cbbac', 'c3b3732b35d1', 'bcc9ab1f226c'],
    'pixel-art.png': [
      '171d5ceb16bf',
      'dbd1921f235f',
      '753a1cc42419',
      '89815659889c',
      'dce8be4a3347',
    ],
    'text.png': ['5bb175d525d3', '3c17c3ea0bc0', '4f76b7a49165', '915ed1f29630', '44706d42ec04'],
  };
  it.each(Object.entries(FROZEN))(
    '%s : SVG identique à l’octet hors Logo et Noir et blanc',
    (file, hashes) => {
      const b = new Uint8Array(readFileSync(`test/fixtures/${file}`));
      const img = file.endsWith('.jpg') ? decodeJpeg(b) : decodePng(b);
      const got = OFF_PRESETS.map((p) =>
        createHash('sha256')
          .update(vectorize(img, presetOptions(p)).svg)
          .digest('hex')
          .slice(0, 12),
      );
      expect(got).toEqual(hashes);
    },
  );

  it('centre-ligne : le réglage forcé reste éteint (un trait n’est pas un bord de forme)', () => {
    const img = decodePng(new Uint8Array(readFileSync('test/fixtures/line-drawing.png')));
    const o = presetOptions('centerline');
    const forced = presetOptions('centerline');
    forced.fit.exactShapes = true;
    expect(vectorize(img, forced).svg).toBe(vectorize(img, o).svg);
  });

  it('budget de performance : 10 000 chaînes courbes, réglage allumé', () => {
    // Arcs de rayons variés (escaliers de treillis), une chaîne ouverte chacun.
    const chains: BoundaryChain[] = [];
    for (let k = 0; k < 10000; k++) {
      const r = 8 + (k % 40);
      const pts: number[] = [];
      let x = Math.round(r);
      let y = 0;
      pts.push(x, y);
      for (let a = 1; a <= 60; a++) {
        const th = (a / 60) * (Math.PI / 2);
        const tx = Math.round(r * Math.cos(th));
        const ty = Math.round(r * Math.sin(th));
        while (x !== tx || y !== ty) {
          if (x !== tx) x += Math.sign(tx - x);
          else y += Math.sign(ty - y);
          if (pts[pts.length - 2] !== x || pts[pts.length - 1] !== y) pts.push(x, y);
        }
      }
      chains.push({
        id: k,
        points: Float64Array.from(pts),
        start: 2 * k,
        end: 2 * k + 1,
        left: 0,
        right: 1,
        closed: false,
      });
    }
    fitChains(chains.slice(0, 500), EXACT);
    const budget = perfBudget(1000, measureReference());
    const t0 = performance.now();
    const out = fitChains(chains, EXACT);
    const dt = performance.now() - t0;
    expect(out).toHaveLength(10000);
    printBudget(assertWithinBudget('fitChains exactShapes, 10 000 arcs', dt, budget));
  });
});
