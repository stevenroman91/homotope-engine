// T43 — Préréglage Logo net au rendu agrandi, JPEG ou PNG : portée du lissage (grands arcs) et
// droites robustes (bords d'étoile), fonctions pures puis régression sur la démo de l'accueil
// (`public/accueil/src/logo-web.jpg`, préréglage Logo SEUL).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quantize } from '../src/engine/color/quantize.ts';
import { flattenSubpath } from '../src/engine/export/polyline.ts';
import { fitChains, maxDeviationFromCurve, thinTolerances } from '../src/engine/fit/index.ts';
import { leastSquaresLine, reachRadius, smoothCyclic } from '../src/engine/fit/polyline.ts';
import { decodeJpeg } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import { preprocess } from '../src/engine/preprocess/index.ts';
import { segment } from '../src/engine/segment/index.ts';
import { buildBoundaryGraph } from '../src/engine/topology/index.ts';
import { parsePathData, type ParsedSubpath } from '../src/engine/svg/parse.ts';
import type { RasterImage, VectorizeOptions } from '../src/engine/types.ts';
import { logoSource } from '../scripts/lib/demo-sources.ts';

/** Contour de treillis (coins de pixels) d'un disque de rayon r centré en (c, c), sens direct. */
function digitalCircle(r: number, c: number): { x: Float64Array; y: Float64Array } {
  const inside = (px: number, py: number) => Math.hypot(px + 0.5 - c, py + 0.5 - c) <= r;
  // Suivi du bord : pour chaque pixel de bord, ses arêtes extérieures, chaînées.
  const next = new Map<string, [number, number]>();
  const lo = Math.floor(c - r - 2);
  const hi = Math.ceil(c + r + 2);
  for (let py = lo; py <= hi; py++) {
    for (let px = lo; px <= hi; px++) {
      if (!inside(px, py)) continue;
      // Arêtes orientées, l'intérieur à gauche (repère y vers le bas).
      if (!inside(px, py - 1)) next.set(`${px + 1},${py}`, [px, py]);
      if (!inside(px - 1, py)) next.set(`${px},${py}`, [px, py + 1]);
      if (!inside(px, py + 1)) next.set(`${px},${py + 1}`, [px + 1, py + 1]);
      if (!inside(px + 1, py)) next.set(`${px + 1},${py + 1}`, [px + 1, py]);
    }
  }
  const [k0] = next.keys();
  const xs: number[] = [];
  const ys: number[] = [];
  let k = k0!;
  do {
    const [a, b] = k.split(',').map(Number) as [number, number];
    xs.push(a);
    ys.push(b);
    const [nx, ny] = next.get(k)!;
    k = `${nx},${ny}`;
  } while (k !== k0 && xs.length < 100_000);
  return { x: Float64Array.from(xs), y: Float64Array.from(ys) };
}

describe('reachRadius (T43)', () => {
  it('grand cercle : rayon étendu ; arrondi serré : rayon de base', () => {
    const big = digitalCircle(185, 200);
    const n = big.x.length;
    // Les coins isolés du treillis gardent le rayon de base ; les trois quarts des points au moins
    // montent à 8 ou plus (mesuré : 79 %).
    let wide = 0;
    for (let i = 0; i < n; i++) if (reachRadius(big.x, big.y, i, 12, n) >= 8) wide++;
    expect(wide / n).toBeGreaterThan(0.75);
    // Arrondi de 6 px : rayon moyen sous 2,5 (mesuré 1,8 ; le déplacement reste de plus plafonné
    // par `maxShift`).
    const small = digitalCircle(6, 20);
    const m = small.x.length;
    let sum = 0;
    for (let i = 0; i < m; i++) sum += reachRadius(small.x, small.y, i, 12, m);
    expect(sum / m).toBeLessThan(2.5);
  });

  it('droite en escalier : portée maximale', () => {
    // Droite de pente 1/3 numérisée : paliers de 3 px.
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i <= 120; i++) {
      x.push(i);
      y.push(Math.floor(i / 3));
    }
    const fx = Float64Array.from(x);
    const fy = Float64Array.from(y);
    for (let i = 20; i <= 100; i++) expect(reachRadius(fx, fy, i, 12, 0)).toBe(12);
  });

  it('smoothCyclic avec portée : le grand cercle numérisé sort plus rond', () => {
    const { x, y } = digitalCircle(185, 200);
    const n = x.length;
    const spread = (reach: number) => {
      const sx = new Float64Array(n);
      const sy = new Float64Array(n);
      smoothCyclic(x, y, sx, sy, n, 2, 0.5, reach);
      // Écart quadratique du rayon à sa moyenne.
      const r = Array.from({ length: n }, (_, i) => Math.hypot(sx[i]! - 200, sy[i]! - 200));
      const mean = r.reduce((a, b) => a + b, 0) / n;
      return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    };
    const base = spread(0);
    const reached = spread(12);
    // Mesuré : 0,135 → 0,099 px.
    expect(reached).toBeLessThan(0.8 * base);
  });
});

describe('leastSquaresLine (T43)', () => {
  it('droite exacte : écart nul, direction retrouvée', () => {
    const x = Float64Array.from([0, 3, 6, 9, 12]);
    const y = Float64Array.from([1, 2, 3, 4, 5]);
    const out = new Float64Array(4);
    expect(leastSquaresLine(x, y, 0, 4, out)).toBeLessThan(1e-9);
    expect(Math.abs(out[2]! * 1 - out[3]! * 3)).toBeLessThan(1e-9); // parallèle à (3, 1)
    expect(out[0]).toBeCloseTo(6);
    expect(out[1]).toBeCloseTo(3);
  });

  it('escalier : écart d’un demi-palier, pas de la corde', () => {
    // Corde inclinée par un coin décalé d'un pixel : la droite des moindres carrés, elle, suit
    // l'escalier.
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i <= 60; i++) {
      x.push(i);
      y.push(Math.floor(i / 2));
    }
    y[0] = -1;
    const out = new Float64Array(4);
    expect(leastSquaresLine(Float64Array.from(x), Float64Array.from(y), 0, 60, out)).toBeLessThan(
      1,
    );
    expect(leastSquaresLine(Float64Array.from([0, 1]), Float64Array.from([0, 0]), 0, 0, out)).toBe(
      Infinity,
    );
  });
});

// --- Régression : la démo « logo récupéré sur le web » ----------------------------------------

/** Géométrie de `logoSource` (dessin décrit sur 320 px, rendu à 400 px : × 1,25). */
const K = 1.25;
const C = 160;
const STAR: [number, number][] = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 === 0 ? 60 : 25;
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  return [(C + r * Math.cos(a)) * K, (C - 30 + r * Math.sin(a)) * K];
});

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Sous-tracés du `<path>` rempli dont la couleur est la plus proche de `rgb`. */
function pathOf(svg: string, rgb: [number, number, number]): ParsedSubpath[] {
  let best: ParsedSubpath[] = [];
  let bestD = Infinity;
  for (const m of svg.matchAll(/<path fill="#([0-9a-f]{6})" d="([^"]*)"/g)) {
    const c = hexRgb(m[1]!);
    const d = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]);
    if (d < bestD) {
      bestD = d;
      best = parsePathData(m[2]!);
    }
  }
  return best;
}

/**
 * Bord extérieur de l'anneau (rayon 185 px) : écart crête à crête du rayon, et somme des
 * virages CONCAVES (degrés) le long du bord rééchantillonné tous les 2 px. Un cercle : 0 ; une
 * couronne bosselée en compte à chaque bosse.
 */
function outerRing(svg: string): { peakToPeak: number; concave: number } {
  const sp = pathOf(svg, [27, 42, 92]).find(
    (s) => Math.hypot(s.start[0] - 200, s.start[1] - 200) > 172.5,
  )!;
  const p = flattenSubpath(sp, 0.01);
  let lo = Infinity;
  let hi = -Infinity;
  const q: [number, number][] = [[p[0]!, p[1]!]];
  for (let i = 0; i < p.length; i += 2) {
    const r = Math.hypot(p[i]! - 200, p[i + 1]! - 200);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
    const [lx, ly] = q[q.length - 1]!;
    if (Math.hypot(p[i]! - lx, p[i + 1]! - ly) >= 2) q.push([p[i]!, p[i + 1]!]);
  }
  while (q.length > 3 && Math.hypot(q.at(-1)![0] - q[0]![0], q.at(-1)![1] - q[0]![1]) < 1.5) {
    q.pop();
  }
  let area = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  let concave = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[(i - 1 + q.length) % q.length]!;
    const b = q[i]!;
    const c = q[(i + 1) % q.length]!;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * Math.sign(area);
    if (turn < 0) concave += (-turn * 180) / Math.PI;
  }
  return { peakToPeak: hi - lo, concave };
}

function segDist(px: number, py: number, a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy);
}

/** Étoile jaune : segments droits, et écart max (px) du contour à l'étoile dessinée. */
function star(svg: string): { lines: number; segments: number; maxDev: number } {
  const sp = pathOf(svg, [250, 204, 44])[0]!;
  const p = flattenSubpath(sp, 0.02);
  let maxDev = 0;
  for (let i = 0; i < p.length; i += 2) {
    let d = Infinity;
    for (let k = 0; k < 10; k++)
      d = Math.min(d, segDist(p[i]!, p[i + 1]!, STAR[k]!, STAR[(k + 1) % 10]!));
    maxDev = Math.max(maxDev, d);
  }
  return {
    lines: sp.segments.filter((s) => s.kind === 'line').length,
    segments: sp.segments.length,
    maxDev,
  };
}

/** Préréglage Logo tel qu'avant T43 (T42) : la mesure doit le distinguer. */
function beforeT43(): VectorizeOptions {
  const o = presetOptions('logo');
  o.fit.cornerAngle = 60;
  o.fit.smoothingReach = 0;
  o.fit.robustLines = false;
  return o;
}

const jpeg = decodeJpeg(new Uint8Array(readFileSync('public/accueil/src/logo-web.jpg')));
const png: RasterImage = logoSource();

describe('préréglage Logo seul, logo-web (T43)', () => {
  for (const [name, image] of [
    ['JPEG servi (logo-web.jpg)', jpeg],
    ['même dessin sans JPEG', png],
  ] as const) {
    it(`${name} : couronne ronde, étoile à bords droits, 5 couleurs`, () => {
      const { svg } = vectorize(image, presetOptions('logo'));
      const ring = outerRing(svg);
      expect(ring.peakToPeak).toBeLessThanOrEqual(1.6);
      expect(ring.concave).toBeLessThan(1);
      const s = star(svg);
      expect(s.lines).toBeGreaterThanOrEqual(10);
      expect(s.segments).toBeLessThanOrEqual(14);
      expect(s.maxDev).toBeLessThan(0.6);
      const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]{3,6})"/g)].map((m) => m[1]));
      expect(fills.size).toBe(5);
    });
  }

  it('la mesure distingue le préréglage d’avant T43 : couronne bosselée, étoile courbe', () => {
    const { svg } = vectorize(jpeg, beforeT43());
    // L'écart crête à crête, lui, était déjà sous 1,6 px : les bosses sont des inflexions.
    expect(outerRing(svg).concave).toBeGreaterThan(10);
    expect(star(svg).lines).toBeLessThan(6);
  });

  it('garantie F1 : coins recalés compris, la courbe reste à moins de la tolérance de la polyligne', () => {
    for (const image of [jpeg, png]) {
      const o = presetOptions('logo');
      const pre = preprocess(image, o.preprocess);
      const map = segment(quantize(pre, o.quantize), pre.image.width, pre.image.height, o.segment);
      const g = buildBoundaryGraph(map);
      const tol = thinTolerances(
        g.chains,
        map.regions.map((r) => r.area),
        o.fit.tolerance,
      );
      let worst = 0;
      for (const fc of fitChains(g.chains, o.fit, undefined, tol)) {
        const c = g.chains[fc.chain]!;
        worst = Math.max(
          worst,
          maxDeviationFromCurve(c, fc) / Math.min(o.fit.tolerance, tol[c.id]!),
        );
      }
      expect(worst).toBeLessThan(1);
    }
  });
});
