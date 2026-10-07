import { describe, expect, it } from 'vitest';
import {
  bezierPoint,
  chordLengthParameterize,
  newtonStep,
  pointLineDistance,
  pointSegmentDistance,
} from '../src/engine/fit/bezier.ts';
import type { Span } from '../src/engine/fit/schneider.ts';
import {
  FitWorkspace,
  fitCubicRange,
  fitSingleCubic,
  generateBezier,
} from '../src/engine/fit/schneider.ts';

const C = Float64Array.from([0, 0, 10, 20, 30, 20, 40, 0]);

function sample(c: Float64Array, n: number): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const p = new Float64Array(2);
  for (let i = 0; i < n; i++) {
    bezierPoint(c, 0, i / (n - 1), p);
    x[i] = p[0]!;
    y[i] = p[1]!;
  }
  return { x, y };
}

describe('bezier', () => {
  it('évalue les extrémités et le milieu', () => {
    const p = new Float64Array(2);
    bezierPoint(C, 0, 0, p);
    expect([...p]).toEqual([0, 0]);
    bezierPoint(C, 0, 1, p);
    expect([...p]).toEqual([40, 0]);
    bezierPoint(C, 0, 0.5, p);
    expect(p[0]).toBeCloseTo(20, 12);
    expect(p[1]).toBeCloseTo(15, 12);
  });

  it('Newton-Raphson converge vers le pied de la perpendiculaire', () => {
    const p = new Float64Array(2);
    bezierPoint(C, 0, 0.3, p);
    // Point décalé le long de la normale : la projection reste t = 0,3.
    const h = 1e-6;
    const q = new Float64Array(2);
    bezierPoint(C, 0, 0.3 + h, q);
    const tx = (q[0]! - p[0]!) / h;
    const ty = (q[1]! - p[1]!) / h;
    const l = Math.hypot(tx, ty);
    const px = p[0]! - (ty / l) * 0.5;
    const py = p[1]! + (tx / l) * 0.5;
    let t = 0.2;
    for (let i = 0; i < 8; i++) t = newtonStep(C, 0, px, py, t);
    expect(t).toBeCloseTo(0.3, 6);
  });

  it('paramétrage par longueur de corde', () => {
    const x = Float64Array.from([0, 1, 3, 6]);
    const y = new Float64Array(4);
    const u = new Float64Array(4);
    expect(chordLengthParameterize(x, y, 0, 3, u)).toBe(6);
    expect([...u]).toEqual([0, 1 / 6, 0.5, 1]);
    // Dégénéré : uniforme.
    expect(chordLengthParameterize(new Float64Array(3), new Float64Array(3), 0, 2, u)).toBe(0);
    expect([...u.subarray(0, 3)]).toEqual([0, 0.5, 1]);
  });

  it('distances point-segment et point-droite', () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointSegmentDistance(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(pointLineDistance(13, 4, 0, 0, 10, 0)).toBe(4);
  });
});

describe('schneider', () => {
  it('moindres carrés : retrouve une cubique échantillonnée (tangentes exactes)', () => {
    const { x, y } = sample(C, 40);
    const u = new Float64Array(40);
    for (let i = 0; i < 40; i++) u[i] = i / 39; // paramètres exacts
    const out = new Float64Array(8);
    const l1 = Math.hypot(10, 20);
    const l2 = Math.hypot(10, 20);
    generateBezier(x, y, 0, 39, u, 10 / l1, 20 / l1, -10 / l2, 20 / l2, 50, out);
    for (let k = 0; k < 8; k++) expect(out[k]).toBeCloseTo(C[k]!, 6);
  });

  it('Wu-Barsky quand α est négatif', () => {
    // Points en ligne droite mais tangentes imposées vers l'arrière : α < 0.
    const x = Float64Array.from([0, 1, 2, 3]);
    const y = new Float64Array(4);
    const u = Float64Array.from([0, 1 / 3, 2 / 3, 1]);
    const out = new Float64Array(8);
    generateBezier(x, y, 0, 3, u, -1, 0, 1, 0, 3, out);
    expect(out[2]).toBeCloseTo(-1, 12); // α = 3 / 3
    expect(out[4]).toBeCloseTo(4, 12);
  });

  it('une cubique échantillonnée tient en un seul morceau', () => {
    const { x, y } = sample(C, 60);
    const ws = new FitWorkspace();
    const l = Math.hypot(10, 20);
    const err = fitSingleCubic(x, y, x, y, 0, 59, 10 / l, 20 / l, -10 / l, 20 / l, 0.25, ws);
    expect(err).toBeLessThan(0.25);
    const spans: Span[] = [];
    fitCubicRange(x, y, x, y, 0, 59, 10 / l, 20 / l, -10 / l, 20 / l, 0.25, ws, spans);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.cubic).toBe(true);
  });

  it('subdivise une forme en S serré et couvre tous les points dans l’ordre', () => {
    const n = 200;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i * 0.5;
      y[i] = 10 * Math.sin((i / n) * Math.PI * 4);
    }
    const ws = new FitWorkspace();
    const spans: Span[] = [];
    const d0 = Math.hypot(x[1]! - x[0]!, y[1]! - y[0]!);
    const d1 = Math.hypot(x[n - 2]! - x[n - 1]!, y[n - 2]! - y[n - 1]!);
    fitCubicRange(
      x,
      y,
      x,
      y,
      0,
      n - 1,
      (x[1]! - x[0]!) / d0,
      (y[1]! - y[0]!) / d0,
      (x[n - 2]! - x[n - 1]!) / d1,
      (y[n - 2]! - y[n - 1]!) / d1,
      0.1,
      ws,
      spans,
    );
    expect(spans.length).toBeGreaterThan(2);
    expect(spans[0]!.i0).toBe(0);
    expect(spans[spans.length - 1]!.i1).toBe(n - 1);
    for (let k = 1; k < spans.length; k++) expect(spans[k]!.i0).toBe(spans[k - 1]!.i1);
  });
});
