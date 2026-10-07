/**
 * T35 — Réseau des lignes de découpe : les polylignes d'une `CutGeometry` découpées en segments
 * entre sommets IDENTIFIÉS (mêmes coordonnées au bit près = même sommet), avec un nœud partout
 * où un sommet tombe à l'intérieur d'un autre segment (jonction en T, droites colinéaires
 * fusionnées du pixel art). Après ce découpage, deux tracés superposés partagent exactement les
 * mêmes segments : un doublon se reconnaît à sa paire de sommets, sans tolérance.
 *
 * Sert au contrôle (doublons, croisements, distances), à la fusion des frontières communes du
 * DXF et à la simplification. Pur, sur tableaux typés.
 */
import type { CutGeometry, CutPolyline } from './geometry.ts';
import { SegmentGrid } from './grid.ts';

/** Distance (px) sous laquelle un sommet est SUR un segment (1e-6 px ≈ 0,35 nm à 1 px = 1 pt). */
export const ON_EPS = 1e-6;

export interface Network {
  nv: number;
  vx: Float64Array;
  vy: Float64Array;
  ns: number;
  /** Segment `s` : sommet de départ, d'arrivée (sens de parcours de sa polyligne). */
  sa: Int32Array;
  sb: Int32Array;
  /** Polyligne qui parcourt le segment. */
  spoly: Int32Array;
  /** Premier segment de même paire de sommets (dans un sens ou l'autre), sinon -1. */
  dupOf: Int32Array;
  /** Segments de la polyligne `p`, dans l'ordre de parcours : `[polyStart[p], polyStart[p+1])`. */
  polyStart: Int32Array;
}

/** Construit le réseau (sommets identifiés, nœuds en T, doublons). */
export function buildNetwork(geom: CutGeometry): Network {
  // 1. Sommets identifiés par leurs coordonnées exactes.
  const ids = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const vertexOf = (x: number, y: number): number => {
    const k = `${x} ${y}`;
    let v = ids.get(k);
    if (v === undefined) {
      v = xs.length;
      ids.set(k, v);
      xs.push(x);
      ys.push(y);
    }
    return v;
  };
  const ra: number[] = [];
  const rb: number[] = [];
  const rpoly: number[] = [];
  const rawStart = new Int32Array(geom.polylines.length + 1);
  geom.polylines.forEach((pl, p) => {
    const vs: number[] = [];
    for (let k = 0; k < pl.pts.length; k += 2) {
      const v = vertexOf(pl.pts[k]!, pl.pts[k + 1]!);
      if (vs[vs.length - 1] !== v) vs.push(v);
    }
    if (pl.closed && vs.length > 1 && vs[0] === vs[vs.length - 1]) vs.pop();
    for (let k = 0; k + 1 < vs.length; k++) {
      ra.push(vs[k]!);
      rb.push(vs[k + 1]!);
      rpoly.push(p);
    }
    if (pl.closed && vs.length > 1) {
      ra.push(vs[vs.length - 1]!);
      rb.push(vs[0]!);
      rpoly.push(p);
    }
    rawStart[p + 1] = ra.length;
  });
  const nv = xs.length;
  const vx = Float64Array.from(xs);
  const vy = Float64Array.from(ys);
  const nr = ra.length;

  // 2. Nœuds en T : un sommet posé à l'intérieur d'un segment le coupe.
  const ax = new Float64Array(nr);
  const ay = new Float64Array(nr);
  const bx = new Float64Array(nr);
  const by = new Float64Array(nr);
  for (let e = 0; e < nr; e++) {
    ax[e] = vx[ra[e]!]!;
    ay[e] = vy[ra[e]!]!;
    bx[e] = vx[rb[e]!]!;
    by[e] = vy[rb[e]!]!;
  }
  const all = new Int32Array(nr);
  for (let e = 0; e < nr; e++) all[e] = e;
  const grid = new SegmentGrid(all, ax, ay, bx, by, ON_EPS);
  const splitE: number[] = [];
  const splitT: number[] = [];
  const splitV: number[] = [];
  for (let v = 0; v < nv; v++) {
    const c = grid.cellAt(vx[v]!, vy[v]!);
    if (c < 0) continue;
    for (let k = grid.start[c]!; k < grid.start[c + 1]!; k++) {
      const e = grid.items[k]!;
      if (ra[e] === v || rb[e] === v) continue;
      const dx = bx[e]! - ax[e]!;
      const dy = by[e]! - ay[e]!;
      const len = Math.hypot(dx, dy);
      if (len <= 2 * ON_EPS) continue;
      const px = vx[v]! - ax[e]!;
      const py = vy[v]! - ay[e]!;
      const along = (px * dx + py * dy) / len;
      if (along <= ON_EPS || along >= len - ON_EPS) continue;
      if (Math.abs(px * dy - py * dx) / len > ON_EPS) continue;
      splitE.push(e);
      splitT.push(along);
      splitV.push(v);
    }
  }
  const order = Array.from(splitE.keys()).sort(
    (i, j) => splitE[i]! - splitE[j]! || splitT[i]! - splitT[j]!,
  );

  // 3. Segments finaux, dans l'ordre de parcours de chaque polyligne.
  const sa: number[] = [];
  const sb: number[] = [];
  const spoly: number[] = [];
  const polyStart = new Int32Array(geom.polylines.length + 1);
  let q = 0;
  for (let p = 0; p < geom.polylines.length; p++) {
    for (let e = rawStart[p]!; e < rawStart[p + 1]!; e++) {
      let prev = ra[e]!;
      while (q < order.length && splitE[order[q]!]! === e) {
        const v = splitV[order[q]!]!;
        q++;
        if (v === prev) continue;
        sa.push(prev);
        sb.push(v);
        spoly.push(p);
        prev = v;
      }
      if (prev !== rb[e]!) {
        sa.push(prev);
        sb.push(rb[e]!);
        spoly.push(p);
      }
    }
    polyStart[p + 1] = sa.length;
  }
  const ns = sa.length;

  // 4. Doublons : même paire de sommets, quel que soit le sens.
  const dupOf = new Int32Array(ns).fill(-1);
  const first = new Map<number, number>();
  for (let s = 0; s < ns; s++) {
    const a = sa[s]!;
    const b = sb[s]!;
    const key = a < b ? a * nv + b : b * nv + a;
    const f = first.get(key);
    if (f === undefined) first.set(key, s);
    else dupOf[s] = f;
  }

  return {
    nv,
    vx,
    vy,
    ns,
    sa: Int32Array.from(sa),
    sb: Int32Array.from(sb),
    spoly: Int32Array.from(spoly),
    dupOf,
    polyStart,
  };
}

/** Longueur du segment `s`. */
export function segLength(net: Network, s: number): number {
  return Math.hypot(
    net.vx[net.sb[s]!]! - net.vx[net.sa[s]!]!,
    net.vy[net.sb[s]!]! - net.vy[net.sa[s]!]!,
  );
}

/**
 * Morceaux de découpe, chacun ÉMIS UNE FOIS par la première polyligne qui le parcourt (ordre du
 * DXF : ordre de peinture), regroupés en polylignes continues : pour chaque polyligne `p`, les
 * unités qu'elle possède sont mises bout à bout tant que la fin de l'une est le début de la
 * suivante ; une polyligne fermée entièrement possédée reste fermée. `units(p, visit)` parcourt
 * les unités de `p` dans l'ordre (`rev` : parcourue à l'envers de `pointsOf(unit)`).
 */
export function buildRuns(
  geom: CutGeometry,
  unitCount: number,
  ownerOf: (unit: number) => number,
  units: (p: number, visit: (unit: number, rev: boolean) => void) => void,
  pointsOf: (unit: number) => ArrayLike<number>,
): CutPolyline[] {
  const emitted = new Uint8Array(unitCount);
  const out: CutPolyline[] = [];
  geom.polylines.forEach((pl, p) => {
    const runs: number[][] = [];
    units(p, (u, rev) => {
      if (ownerOf(u) !== p || emitted[u]) return;
      emitted[u] = 1;
      const src = pointsOf(u);
      const pts: number[] = [];
      if (rev) for (let k = src.length - 2; k >= 0; k -= 2) pts.push(src[k]!, src[k + 1]!);
      else for (let k = 0; k < src.length; k++) pts.push(src[k]!);
      const cur = runs[runs.length - 1];
      if (cur && cur[cur.length - 2] === pts[0] && cur[cur.length - 1] === pts[1]) {
        for (let k = 2; k < pts.length; k++) cur.push(pts[k]!);
      } else runs.push(pts);
    });
    // Polyligne fermée : le dernier morceau rejoint le premier s'il y aboutit.
    if (pl.closed && runs.length > 1) {
      const head = runs[0]!;
      const tail = runs[runs.length - 1]!;
      if (tail[tail.length - 2] === head[0] && tail[tail.length - 1] === head[1]) {
        runs[0] = tail.concat(head.slice(2));
        runs.pop();
      }
    }
    for (const r of runs) {
      const n = r.length;
      const loop = n >= 6 && r[0] === r[n - 2] && r[1] === r[n - 1];
      if (loop) r.length = n - 2;
      out.push({ item: pl.item, pts: Float64Array.from(r), closed: loop, merged: true });
    }
  });
  return out;
}

/**
 * Polylignes du DXF « frontières communes fusionnées » : chaque segment du réseau n'est émis
 * qu'une fois (par la première forme qui le parcourt), les doublons disparaissent.
 */
export function mergedPolylines(
  geom: CutGeometry,
  net: Network = buildNetwork(geom),
): CutPolyline[] {
  const rootOf = (s: number): number => (net.dupOf[s]! < 0 ? s : net.dupOf[s]!);
  return buildRuns(
    geom,
    net.ns,
    (u) => net.spoly[u]!,
    (p, visit) => {
      for (let s = net.polyStart[p]!; s < net.polyStart[p + 1]!; s++) {
        const u = rootOf(s);
        visit(u, net.sa[s] !== net.sa[u]);
      }
    },
    (u) => [net.vx[net.sa[u]!]!, net.vy[net.sa[u]!]!, net.vx[net.sb[u]!]!, net.vy[net.sb[u]!]!],
  );
}
