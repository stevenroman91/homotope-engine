/**
 * T35 — « Simplifier pour la découpe » : une NOUVELLE géométrie, jamais le résultat de l'atelier.
 *
 * 1. Réseau (`network.ts`) : frontières communes identifiées, chaque segment gardé une fois.
 * 2. Petits îlots retirés : pour un contour fermé sous le seuil, les segments qu'il partage avec
 *    son plus grand voisin (ou qu'il est seul à parcourir) disparaissent ; la zone rejoint ce
 *    voisin, ses autres bords restent des frontières entre voisins.
 * 3. Chaînes : suites de segments entre nœuds (sommet de degré ≠ 2, ou changement de forme
 *    propriétaire) ; chacune est simplifiée UNE fois (Douglas-Peucker, extrémités fixes) à la
 *    tolérance de lissage : deux faces voisines gardent exactement la même frontière.
 * 4. Polylignes fusionnées (`buildRuns`) : chaque chaîne écrite une fois, bout à bout.
 * Pur, sur tableaux typés.
 */
import { polygonArea, type CutGeometry } from './geometry.ts';
import { SegmentGrid } from './grid.ts';
import { buildNetwork, buildRuns, segLength } from './network.ts';

export interface SimplifyOptions {
  /** Aire sous laquelle un contour fermé est retiré, en px² (l'appelant convertit les mm²). */
  islandPx2: number;
  /** Écart maximal de la simplification (px d'origine) ; 0 : aucune réduction de nœuds. */
  tolerance: number;
  /**
   * Garde : boîtes [x0, y0, x1, y1] des problèmes que la simplification a CRÉÉS (absents avant).
   * Les chaînes simplifiées qui les touchent reprennent leurs sommets d'origine, puis la garde
   * est rappelée (quelques tours au plus).
   */
  guard?: (geometry: CutGeometry) => [number, number, number, number][];
  /** Marge (px) autour des boîtes de la garde. */
  guardMargin?: number;
}

export interface SimplifyResult {
  geometry: CutGeometry;
  removedIslands: number;
  /** Segments écrits une fois au lieu de deux (frontières communes, doublons). */
  mergedSegments: number;
}

export function simplifyGeometry(geom: CutGeometry, options: SimplifyOptions): SimplifyResult {
  const net = buildNetwork(geom);
  const { ns, nv, sa, sb, spoly, dupOf, polyStart, vx, vy } = net;
  const root = (s: number): number => (dupOf[s]! < 0 ? s : dupOf[s]!);
  let mergedSegments = 0;
  for (let s = 0; s < ns; s++) if (dupOf[s]! >= 0) mergedSegments++;

  // Polylignes qui parcourent chaque segment unique (CSR, avec répétition).
  const ownStart = new Int32Array(ns + 1);
  for (let s = 0; s < ns; s++) ownStart[root(s) + 1]!++;
  for (let u = 0; u < ns; u++) ownStart[u + 1]! += ownStart[u]!;
  const ownFill = ownStart.slice(0, ns);
  const owners = new Int32Array(ns);
  for (let s = 0; s < ns; s++) owners[ownFill[root(s)]!++] = spoly[s]!;

  // --- Îlots, du plus petit au plus grand --------------------------------------------------
  const removed = new Uint8Array(ns);
  const islands: { p: number; area: number }[] = [];
  geom.polylines.forEach((pl, p) => {
    if (!pl.closed || geom.items[pl.item]!.stroke) return;
    const area = Math.abs(polygonArea(pl.pts));
    if (area < options.islandPx2) islands.push({ p, area });
  });
  islands.sort((a, b) => a.area - b.area);
  let removedIslands = 0;
  for (const { p } of islands) {
    const shared = new Map<number, number>();
    let alive = 0;
    for (let s = polyStart[p]!; s < polyStart[p + 1]!; s++) {
      const u = root(s);
      if (removed[u]) continue;
      alive++;
      for (let k = ownStart[u]!; k < ownStart[u + 1]!; k++) {
        const q = owners[k]!;
        if (q !== p) shared.set(q, (shared.get(q) ?? 0) + segLength(net, u));
      }
    }
    if (alive === 0) continue; // déjà retiré avec sa copie (trou de la face voisine)
    let neighbor = -1;
    let best = -1;
    for (const [q, len] of shared) {
      if (len > best || (len === best && q < neighbor)) {
        best = len;
        neighbor = q;
      }
    }
    for (let s = polyStart[p]!; s < polyStart[p + 1]!; s++) {
      const u = root(s);
      let only = true;
      for (let k = ownStart[u]!; k < ownStart[u + 1]!; k++) {
        const q = owners[k]!;
        if (q !== p && q !== neighbor) only = false;
      }
      if (only) removed[u] = 1;
    }
    removedIslands++;
  }

  // --- Chaînes entre nœuds ----------------------------------------------------------------
  const live: number[] = [];
  for (let u = 0; u < ns; u++) if (dupOf[u]! < 0 && !removed[u]) live.push(u);
  const adjStart = new Int32Array(nv + 1);
  for (const u of live) {
    adjStart[sa[u]! + 1]!++;
    adjStart[sb[u]! + 1]!++;
  }
  for (let v = 0; v < nv; v++) adjStart[v + 1]! += adjStart[v]!;
  const adjFill = adjStart.slice(0, nv);
  const adj = new Int32Array(adjStart[nv]!);
  for (const u of live) {
    adj[adjFill[sa[u]!]!++] = u;
    adj[adjFill[sb[u]!]!++] = u;
  }
  const degree = (v: number): number => adjStart[v + 1]! - adjStart[v]!;
  /** Nœud : degré ≠ 2, ou les deux segments n'ont pas la même forme propriétaire. */
  const isNode = (v: number): boolean => {
    if (degree(v) !== 2) return true;
    const a = adj[adjStart[v]!]!;
    const b = adj[adjStart[v]! + 1]!;
    return spoly[a] !== spoly[b] || a === b;
  };
  const chainOf = new Int32Array(ns).fill(-1);
  /** Sens du segment dans sa chaîne : 1 = de `sa` vers `sb`. */
  const forward = new Uint8Array(ns);
  /** Sommets de chaque chaîne (tous), et ceux que la simplification garde. */
  const chainVerts: number[][] = [];
  const chainKept: number[][] = [];
  const chainOwner: number[] = [];

  const walk = (startV: number, firstSeg: number): void => {
    const c = chainVerts.length;
    const verts: number[] = [startV];
    let v = startV;
    let u = firstSeg;
    for (;;) {
      chainOf[u] = c;
      const fwd = sa[u] === v;
      forward[u] = fwd ? 1 : 0;
      v = fwd ? sb[u]! : sa[u]!;
      verts.push(v);
      if (v === startV || isNode(v)) break;
      const k = adjStart[v]!;
      const next = adj[k] === u ? adj[k + 1]! : adj[k]!;
      if (chainOf[next]! >= 0) break;
      u = next;
    }
    const closed = verts.length > 2 && verts[0] === verts[verts.length - 1];
    chainVerts.push(verts);
    chainKept.push(simplifyChain(verts, vx, vy, options.tolerance, closed));
    chainOwner.push(spoly[firstSeg]!);
  };
  for (let v = 0; v < nv; v++) {
    if (!isNode(v)) continue;
    for (let k = adjStart[v]!; k < adjStart[v + 1]!; k++) {
      const u = adj[k]!;
      if (chainOf[u]! < 0) walk(v, u);
    }
  }
  // Boucles sans nœud (îlot isolé, contour fermé seul) : départ au premier segment.
  for (const u of live) if (chainOf[u]! < 0) walk(sa[u]!, u);

  // Garde topologique : une chaîne simplifiée qui en croise une autre (ou se recoupe) reprend
  // ses sommets d'origine, jusqu'à ce qu'aucune simplification ne crée de croisement.
  // Les croisements déjà présents (traits du centre-ligne qui se croisent…) ne comptent pas.
  const before = crossingPairs(chainVerts, vx, vy);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [key, [c1, c2]] of crossingPairs(chainKept, vx, vy)) {
      if (before.has(key)) continue;
      for (const c of [c1, c2]) {
        if (chainKept[c] === chainVerts[c]) continue;
        chainKept[c] = chainVerts[c]!;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Un îlot reste dans sa face : la zone balayée par une chaîne simplifiée (entre sa version
  // d'origine et sa version simplifiée) ne doit contenir aucune boucle voisine, sinon l'îlot
  // passerait de l'autre côté de la frontière sans la croiser (aucun croisement strict).
  sweptGuard(chainVerts, chainKept, vx, vy);
  const build = (): CutGeometry => {
    const chainPts = chainKept.map((kept) => {
      const pts = new Float64Array(kept.length * 2);
      kept.forEach((v, k) => {
        pts[2 * k] = vx[v]!;
        pts[2 * k + 1] = vy[v]!;
      });
      return pts;
    });
    const polylines = buildRuns(
      geom,
      chainPts.length,
      (c) => chainOwner[c]!,
      (p, visit) => {
        for (let s = polyStart[p]!; s < polyStart[p + 1]!; s++) {
          const u = root(s);
          const c = chainOf[u]!;
          if (removed[u] || c < 0) continue;
          // La polyligne parcourt u de sa[s] vers sb[s] ; la chaîne, dans le sens de `forward`.
          const alongU = sa[s] === sa[u];
          visit(c, alongU !== (forward[u] === 1));
        }
      },
      (c) => chainPts[c]!,
    );
    return { width: geom.width, height: geom.height, items: geom.items, polylines };
  };

  let geometry = build();
  const margin = options.guardMargin ?? 0;
  for (let round = 0; options.guard && round < 4; round++) {
    const boxes = options.guard(geometry);
    let changed = false;
    chainVerts.forEach((verts, c) => {
      if (chainKept[c] === verts) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const v of verts) {
        x0 = Math.min(x0, vx[v]!);
        x1 = Math.max(x1, vx[v]!);
        y0 = Math.min(y0, vy[v]!);
        y1 = Math.max(y1, vy[v]!);
      }
      for (const b of boxes) {
        if (
          x0 <= b[2] + margin &&
          b[0] - margin <= x1 &&
          y0 <= b[3] + margin &&
          b[1] - margin <= y1
        ) {
          chainKept[c] = verts;
          changed = true;
          return;
        }
      }
    });
    if (!changed) break;
    geometry = build();
  }

  return {
    geometry,
    removedIslands,
    mergedSegments,
  };
}

/**
 * Douglas-Peucker sur une suite de sommets, extrémités fixes. Une boucle (`closed`, premier =
 * dernier) est coupée en deux à son sommet le plus éloigné du départ ; elle garde au moins un
 * triangle (jamais une boucle aplatie).
 */
function simplifyChain(
  verts: number[],
  vx: Float64Array,
  vy: Float64Array,
  tol: number,
  closed: boolean,
): number[] {
  if (!(tol > 0) || verts.length <= 2) return verts;
  const n = verts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const dp = (i0: number, i1: number): void => {
    const stack: [number, number][] = [[i0, i1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      if (b - a < 2) continue;
      const ax = vx[verts[a]!]!;
      const ay = vy[verts[a]!]!;
      const dx = vx[verts[b]!]! - ax;
      const dy = vy[verts[b]!]! - ay;
      const len = Math.hypot(dx, dy);
      let far = -1;
      let farD = -1;
      for (let k = a + 1; k < b; k++) {
        const px = vx[verts[k]!]! - ax;
        const py = vy[verts[k]!]! - ay;
        const dd = len > 0 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
        if (dd > farD) {
          farD = dd;
          far = k;
        }
      }
      if (farD > tol) {
        keep[far] = 1;
        stack.push([a, far], [far, b]);
      }
    }
  };
  if (closed) {
    // Sommet le plus éloigné du départ : la boucle est simplifiée en deux moitiés.
    let far = 1;
    let farD = -1;
    for (let k = 1; k < n - 1; k++) {
      const dd = Math.hypot(vx[verts[k]!]! - vx[verts[0]!]!, vy[verts[k]!]! - vy[verts[0]!]!);
      if (dd > farD) {
        farD = dd;
        far = k;
      }
    }
    keep[far] = 1;
    dp(0, far);
    dp(far, n - 1);
    let count = 0;
    for (let k = 0; k < n - 1; k++) count += keep[k]!;
    if (count < 3) return verts; // une boucle aplatie ne se découpe pas : intacte
  } else dp(0, n - 1);
  const kept = verts.filter((_, k) => keep[k] === 1);
  return kept.length === n ? verts : kept;
}

/** Paires de chaînes (suites de sommets) qui se croisent franchement (une chaîne avec elle-même : elle se recoupe). */
function crossingPairs(
  chains: number[][],
  vx: Float64Array,
  vy: Float64Array,
): Map<string, [number, number]> {
  const segA: number[] = [];
  const segB: number[] = [];
  const segC: number[] = [];
  chains.forEach((verts, c) => {
    for (let k = 0; k + 1 < verts.length; k++) {
      segA.push(verts[k]!);
      segB.push(verts[k + 1]!);
      segC.push(c);
    }
  });
  const n = segA.length;
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ax[i] = vx[segA[i]!]!;
    ay[i] = vy[segA[i]!]!;
    bx[i] = vx[segB[i]!]!;
    by[i] = vy[segB[i]!]!;
  }
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) ids[i] = i;
  const grid = new SegmentGrid(ids, ax, ay, bx, by, 1e-9);
  const stamp = new Int32Array(n).fill(-1);
  const out = new Map<string, [number, number]>();
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  for (let i = 0; i < n; i++) {
    grid.forEachCell(ax[i]!, ay[i]!, bx[i]!, by[i]!, (cell) => {
      for (let k = grid.start[cell]!; k < grid.start[cell + 1]!; k++) {
        const j = grid.items[k]!;
        if (j <= i || stamp[j] === i) continue;
        stamp[j] = i;
        const a = segA[i]!;
        const b = segB[i]!;
        if (a === segA[j] || a === segB[j] || b === segA[j] || b === segB[j]) continue;
        const o1 = orient(ax[i]!, ay[i]!, bx[i]!, by[i]!, ax[j]!, ay[j]!);
        const o2 = orient(ax[i]!, ay[i]!, bx[i]!, by[i]!, bx[j]!, by[j]!);
        const o3 = orient(ax[j]!, ay[j]!, bx[j]!, by[j]!, ax[i]!, ay[i]!);
        const o4 = orient(ax[j]!, ay[j]!, bx[j]!, by[j]!, bx[i]!, by[i]!);
        if (o1 * o2 < 0 && o3 * o4 < 0) {
          const c1 = Math.min(segC[i]!, segC[j]!);
          const c2 = Math.max(segC[i]!, segC[j]!);
          out.set(`${c1} ${c2}`, [c1, c2]);
        }
      }
    });
  }
  return out;
}

/**
 * Restaure toute chaîne simplifiée dont la zone balayée (polygone : sommets d'origine, puis
 * sommets gardés à rebours) contient un sommet d'une BOUCLE (chaîne fermée sans nœud, un îlot ou
 * un trou isolé). Points des boucles triés par x : seuls ceux de la boîte de la chaîne sont testés.
 */
function sweptGuard(
  chainVerts: number[][],
  chainKept: number[][],
  vx: Float64Array,
  vy: Float64Array,
): void {
  const loops: { x: number; y: number; c: number }[] = [];
  chainVerts.forEach((verts, c) => {
    if (verts.length > 3 && verts[0] === verts[verts.length - 1])
      loops.push({ x: vx[verts[0]!]!, y: vy[verts[0]!]!, c });
  });
  if (loops.length === 0) return;
  loops.sort((a, b) => a.x - b.x);
  chainVerts.forEach((verts, c) => {
    const kept = chainKept[c]!;
    if (kept === verts) return;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const v of verts) {
      x0 = Math.min(x0, vx[v]!);
      x1 = Math.max(x1, vx[v]!);
      y0 = Math.min(y0, vy[v]!);
      y1 = Math.max(y1, vy[v]!);
    }
    // Premier point de boucle d'abscisse ≥ x0 (recherche dichotomique).
    let lo = 0;
    let hi = loops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (loops[mid]!.x < x0) lo = mid + 1;
      else hi = mid;
    }
    const ring = [...verts, ...kept.slice().reverse()];
    for (let k = lo; k < loops.length && loops[k]!.x <= x1; k++) {
      const p = loops[k]!;
      if (p.c === c || p.y < y0 || p.y > y1) continue;
      if (insideRing(p.x, p.y, ring, vx, vy)) {
        chainKept[c] = verts;
        return;
      }
    }
  });
}

/** Point dans un polygone (pair-impair), sommets donnés par indices. */
function insideRing(
  px: number,
  py: number,
  ring: number[],
  vx: Float64Array,
  vy: Float64Array,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = vx[ring[i]!]!;
    const yi = vy[ring[i]!]!;
    const xj = vx[ring[j]!]!;
    const yj = vy[ring[j]!]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
