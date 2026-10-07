/**
 * T33 — Du squelette d'un pixel au GRAPHE DE TRAITS : nœuds (extrémités,
 * jonctions, coins, ancres de boucle) et arêtes (chaînes de pixels).
 *
 * Étapes (toutes pures, sur le masque paddé du squelette et la transformée de
 * distance de l'encre) :
 *  1. degrés (voisins 8-connexes) : 1 = extrémité, ≥ 3 = pixel de jonction
 *     (les pixels de jonction voisins forment UN nœud), 2 = chemin ;
 *  2. arêtes : marche d'un nœud au suivant ; les boucles sans nœud reçoivent
 *     une ancre ;
 *  3. nettoyage jusqu'à stabilité : contraction des arêtes internes plus
 *     courtes que le rayon de la jonction, élagage des barbules (branche
 *     terminale qui dépasse de moins de `spurLength` le trait qu'elle quitte),
 *     fusion des nœuds devenus de degré 2, suppression des traits isolés et
 *     des boucles plus courts que `spurLength` ;
 *  4. découpe aux coins (virage > `cornerAngle`) ;
 *  5. recalage des jonctions et des coins à l'intersection (moindres carrés)
 *     des axes des branches, puis rognage des pixels déformés par la jonction ;
 *  6. épaisseur de chaque arête : moyenne de l'épaisseur locale mesurée par la
 *     transformée de distance.
 */
import type { StrokeEdge, StrokeGraph, StrokeNode, StrokeNodeKind } from '../types.ts';
import { IntStack } from './binarize.ts';
import { neighborOffsets, POPCOUNT, neighborCode } from './thin.ts';

export interface GraphOptions {
  /** Longueur de barbule (px de travail). */
  spurLength: number;
  /** Angle de coin (degrés). */
  cornerAngle: number;
}

interface WNode {
  kind: StrokeNodeKind;
  x: number;
  y: number;
  radius: number;
  /** Arêtes incidentes (une boucle u → u figure deux fois). */
  edges: number[];
  alive: boolean;
}

interface WEdge {
  a: number;
  b: number;
  /** Points intérieurs (sans les nœuds), entrelacés x, y, orientés de a vers b. */
  pts: number[];
  /** Épaisseur locale par point intérieur (NaN : point hérité d'un nœud fusionné). */
  wid: number[];
  closed: boolean;
  alive: boolean;
}

/** Graphe de travail, muté par les étapes de nettoyage. */
export interface WorkGraph {
  nodes: WNode[];
  edges: WEdge[];
}

/**
 * Étapes 1–2 : nœuds et arêtes du squelette. `mask` (paddé, 1 = squelette) est
 * MODIFIÉ (pixels parcourus marqués 2). `skeleton` : pixels du squelette ;
 * `dist2` : distances² de l'encre (sans bordure, voir `distance.ts`).
 */
export function traceSkeleton(
  mask: Uint8Array,
  skeleton: Int32Array,
  w: number,
  h: number,
  dist2: Uint16Array,
): WorkGraph {
  const W = w + 2;
  const off = neighborOffsets(W);
  const nodes: WNode[] = [];
  const edges: WEdge[] = [];
  const nodeOf = new Map<number, number>();
  const px = (p: number): number => (p % W) - 0.5;
  const py = (p: number): number => Math.floor(p / W) - 0.5;
  const d2 = (p: number): number => dist2[(Math.floor(p / W) - 1) * w + (p % W) - 1]!;
  const deg = (p: number): number => POPCOUNT[neighborCode(mask, p, off)]!;

  // Nœuds : extrémités et grappes de pixels de jonction.
  const stack = new IntStack();
  for (const p of skeleton) {
    if (nodeOf.has(p)) continue;
    const d = deg(p);
    if (d === 1) {
      nodeOf.set(p, nodes.length);
      nodes.push({
        kind: 'end',
        x: px(p),
        y: py(p),
        radius: Math.sqrt(d2(p)),
        edges: [],
        alive: true,
      });
    } else if (d >= 3) {
      const id = nodes.length;
      let sx = 0;
      let sy = 0;
      let count = 0;
      let r2 = 0;
      nodeOf.set(p, id);
      stack.length = 0;
      stack.push(p);
      while (stack.length > 0) {
        const q = stack.pop();
        sx += px(q);
        sy += py(q);
        count++;
        r2 = Math.max(r2, d2(q));
        for (let k = 0; k < 8; k++) {
          const r = q + off[k]!;
          if (mask[r] === 1 && !nodeOf.has(r) && deg(r) >= 3) {
            nodeOf.set(r, id);
            stack.push(r);
          }
        }
      }
      nodes.push({
        kind: 'junction',
        x: sx / count,
        y: sy / count,
        radius: Math.sqrt(r2),
        edges: [],
        alive: true,
      });
    }
  }

  const addEdge = (
    a: number,
    b: number,
    path: number[],
    from: number,
    to: number,
    closed: boolean,
  ): void => {
    const pts: number[] = [];
    const wid: number[] = [];
    const m = path.length;
    // Pixel de rang i, extrémités (pixels des nœuds) comprises : -1 = from, m = to.
    const at = (i: number): number => (i < 0 ? from : i >= m ? to : path[i]!);
    for (let i = 0; i < m; i++) {
      const p = path[i]!;
      const q0 = at(Math.max(-1, i - 2));
      const q1 = at(Math.min(m, i + 2));
      const lw = localWidth(p, q0, q1);
      pts.push(px(p) + lw.sx, py(p) + lw.sy);
      wid.push(lw.width);
    }
    const id = edges.length;
    edges.push({ a, b, pts, wid, closed, alive: true });
    nodes[a]!.edges.push(id);
    nodes[b]!.edges.push(id);
  };

  // Épaisseur locale au pixel p du squelette, direction locale q0 → q1, normale n.
  // Le long de n, la distance au papier est une « tente » f(t) = H − |t − c| :
  // f(−1) + f(+1) = 2H − 2 quel que soit le décalage c de la crête, donc
  // H = (f(−1) + f(+1)) / 2 + 1 et c = (f(+1) − f(−1)) / 2 (f lue par
  // interpolation bilinéaire de la transformée de distance). Le bord de l'encre
  // est à mi-chemin entre centres de pixels : épaisseur 2·(H − s(n)), s(n) =
  // ½ / (|nx| + |ny|) (½ sur les axes). Le point est recentré de c·n : la crête
  // de deux pixels d'un trait d'épaisseur paire retombe sur l'axe vrai.
  const dAt = (x: number, y: number): number => distanceAt(dist2, w, h, x + 0.5, y + 0.5);
  const localWidth = (
    p: number,
    q0: number,
    q1: number,
  ): { width: number; sx: number; sy: number } => {
    const dx = (q1 % W) - (q0 % W);
    const dy = Math.floor(q1 / W) - Math.floor(q0 / W);
    const l = Math.hypot(dx, dy);
    const nx = l > 0 ? -dy / l : 0;
    const ny = l > 0 ? dx / l : 1;
    const cx = (p % W) - 1;
    const cy = Math.floor(p / W) - 1;
    const fm = dAt(cx - nx, cy - ny);
    const fp = dAt(cx + nx, cy + ny);
    const H = (fm + fp) / 2 + 1;
    const s = 0.5 / (Math.abs(nx) + Math.abs(ny));
    const c = Math.max(-0.5, Math.min(0.5, (fp - fm) / 2));
    return { width: Math.max(1, 2 * (H - s)), sx: c * nx, sy: c * ny };
  };

  // Arêtes depuis chaque nœud.
  const direct = new Set<string>();
  const walk = (start: number, from: number, first: number): void => {
    const path: number[] = [];
    let prev = from;
    let cur = first;
    for (;;) {
      if (nodeOf.has(cur)) {
        addEdge(start, nodeOf.get(cur)!, path, from, cur, false);
        return;
      }
      mask[cur] = 2;
      path.push(cur);
      let next = -1;
      for (let k = 0; k < 8 && next < 0; k++) {
        const r = cur + off[k]!;
        if (r === prev || mask[r] === 0) continue;
        if (nodeOf.has(r) || mask[r] === 1) next = r;
      }
      if (next < 0) {
        // Impasse (ne devrait pas arriver sur un squelette nettoyé) : extrémité.
        const id = nodes.length;
        nodes.push({
          kind: 'end',
          x: px(cur),
          y: py(cur),
          radius: Math.sqrt(d2(cur)),
          edges: [],
          alive: true,
        });
        path.pop();
        addEdge(start, id, path, from, cur, false);
        return;
      }
      prev = cur;
      cur = next;
    }
  };
  {
    // Pixels de chaque nœud (aucun nœud n'est ajouté à `nodeOf` pendant ce parcours).
    for (const [p, u] of nodeOf) {
      for (let k = 0; k < 8; k++) {
        const q = p + off[k]!;
        if (mask[q] === 0) continue;
        const v = nodeOf.get(q);
        if (v !== undefined) {
          if (v === u) continue;
          const key = p < q ? `${p},${q}` : `${q},${p}`;
          if (direct.has(key)) continue;
          direct.add(key);
          addEdge(u, v, [], p, q, false);
        } else if (mask[q] === 1) walk(u, p, q);
      }
    }
  }
  // Extrémités d'un trait horizontal ou vertical recentrées sur l'axe, comme
  // les points des arêtes (crête de deux pixels d'une épaisseur paire). En
  // oblique, près d'un bout rond, la distance au papier est radiale : la
  // « tente » ne vaut plus, l'extrémité reste au centre de son pixel.
  for (const [p, u] of nodeOf) {
    const n = nodes[u]!;
    if (n.kind !== 'end') continue;
    for (let k = 0; k < 8; k += 2) {
      const q = p + off[k]!;
      if (mask[q] === 0) continue;
      const lw = localWidth(p, q, p);
      n.x += lw.sx;
      n.y += lw.sy;
      break;
    }
  }
  // Boucles sans nœud.
  for (const p of skeleton) {
    if (mask[p] !== 1 || nodeOf.has(p)) continue;
    const id = nodes.length;
    nodeOf.set(p, id);
    nodes.push({
      kind: 'loop',
      x: px(p),
      y: py(p),
      radius: Math.sqrt(d2(p)),
      edges: [],
      alive: true,
    });
    let q = -1;
    for (let k = 0; k < 8 && q < 0; k++) if (mask[p + off[k]!] === 1) q = p + off[k]!;
    if (q < 0) {
      nodes[id]!.alive = false;
      continue;
    }
    const before = edges.length;
    walk(id, p, q);
    if (edges.length > before) edges[edges.length - 1]!.closed = true;
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Géométrie des arêtes de travail
// ---------------------------------------------------------------------------

/** Points complets d'une arête (nœuds compris), entrelacés, orientés de a vers b. */
function fullPoints(g: WorkGraph, e: WEdge): number[] {
  const a = g.nodes[e.a]!;
  const b = g.nodes[e.b]!;
  return [a.x, a.y, ...e.pts, b.x, b.y];
}

export function polylineLength(p: ArrayLike<number>): number {
  let len = 0;
  for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
  return len;
}

function edgeLength(g: WorkGraph, e: WEdge): number {
  return polylineLength(fullPoints(g, e));
}

function degree(n: WNode): number {
  return n.edges.length;
}

function detach(n: WNode, e: number): void {
  const i = n.edges.indexOf(e);
  if (i >= 0) n.edges.splice(i, 1);
}

/** Arête `e` orientée pour FINIR au nœud x (points intérieurs et largeurs, autre extrémité). */
function towards(e: WEdge, x: number): { pts: number[]; wid: number[]; other: number } {
  if (e.b === x) return { pts: e.pts.slice(), wid: e.wid.slice(), other: e.a };
  const pts: number[] = [];
  for (let i = e.pts.length - 2; i >= 0; i -= 2) pts.push(e.pts[i]!, e.pts[i + 1]!);
  return { pts, wid: e.wid.slice().reverse(), other: e.b };
}

/** Fusionne un nœud de degré 2 dans l'arête qui le traverse (ou referme une boucle). */
function mergeThrough(g: WorkGraph, x: number): void {
  const n = g.nodes[x]!;
  const [i1, i2] = n.edges as [number, number];
  if (i1 === i2) {
    // Boucle u → u seule : elle devient une boucle sans jonction, ancrée en u.
    n.kind = 'loop';
    g.edges[i1]!.closed = true;
    return;
  }
  const e1 = g.edges[i1]!;
  const e2 = g.edges[i2]!;
  const t1 = towards(e1, x);
  const t2 = towards(e2, x);
  // e2 doit PARTIR de x : on renverse sa version « vers x ».
  const p2: number[] = [];
  for (let i = t2.pts.length - 2; i >= 0; i -= 2) p2.push(t2.pts[i]!, t2.pts[i + 1]!);
  const id = g.edges.length;
  g.edges.push({
    a: t1.other,
    b: t2.other,
    pts: [...t1.pts, n.x, n.y, ...p2],
    wid: [...t1.wid, NaN, ...t2.wid.slice().reverse()],
    closed: false,
    alive: true,
  });
  e1.alive = false;
  e2.alive = false;
  n.alive = false;
  n.edges = [];
  for (const end of [t1.other, t2.other]) {
    const m = g.nodes[end]!;
    m.edges = m.edges.map((k) => (k === i1 || k === i2 ? id : k));
  }
}

/**
 * Étape 3 : nettoyage jusqu'à stabilité. `spurLength` en px de travail.
 */
export function simplifyGraph(g: WorkGraph, spurLength: number): void {
  const k = spurLength;
  for (let changed = true; changed;) {
    changed = false;
    // a. Contraction des arêtes internes plus courtes que le rayon de la jonction.
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i]!;
      if (!e.alive || e.closed || e.a === e.b) continue;
      const a = g.nodes[e.a]!;
      const b = g.nodes[e.b]!;
      if (a.kind !== 'junction' || b.kind !== 'junction') continue;
      if (edgeLength(g, e) > Math.max(a.radius, b.radius, 1.5)) continue;
      e.alive = false;
      detach(a, i);
      detach(b, i);
      const wa = degree(a);
      const wb = degree(b);
      a.x = wa + wb > 0 ? (a.x * (wa + 1) + b.x * (wb + 1)) / (wa + wb + 2) : (a.x + b.x) / 2;
      a.y = wa + wb > 0 ? (a.y * (wa + 1) + b.y * (wb + 1)) / (wa + wb + 2) : (a.y + b.y) / 2;
      a.radius = Math.max(a.radius, b.radius);
      for (const f of b.edges) {
        const ef = g.edges[f]!;
        if (ef.a === e.b) ef.a = e.a;
        if (ef.b === e.b) ef.b = e.a;
        a.edges.push(f);
      }
      b.edges = [];
      b.alive = false;
      changed = true;
    }
    // b. Barbules : branches terminales qui dépassent de moins de k la jonction.
    for (let u = 0; u < g.nodes.length; u++) {
      const n = g.nodes[u]!;
      if (!n.alive || n.kind !== 'junction' || degree(n) < 3) continue;
      const spurs: { e: number; len: number }[] = [];
      for (const i of n.edges) {
        const e = g.edges[i]!;
        const v = e.a === u ? e.b : e.a;
        if (v === u) continue;
        const m = g.nodes[v]!;
        if (m.kind !== 'end') continue;
        const len = edgeLength(g, e);
        if (len < k + n.radius) spurs.push({ e: i, len });
      }
      if (spurs.length === 0) continue;
      spurs.sort((p, q) => p.len - q.len);
      const d = degree(n);
      // Fourche au bout d'un trait (toutes les branches sauf une sont des
      // barbules) : toutes partent ; si TOUT est barbule, la plus longue reste.
      // Sinon une seule, la plus courte, à chaque passe.
      let remove = spurs;
      if (spurs.length === d) remove = spurs.slice(0, d - 1);
      else if (spurs.length < d - 1) remove = spurs.slice(0, 1);
      for (const { e: i } of remove) {
        const e = g.edges[i]!;
        const v = e.a === u ? e.b : e.a;
        e.alive = false;
        detach(n, i);
        g.nodes[v]!.alive = false;
        g.nodes[v]!.edges = [];
      }
      changed = true;
    }
    // c. Nœuds de jonction devenus de degré 2 (fusion), 1 (extrémité) ou 0.
    for (let u = 0; u < g.nodes.length; u++) {
      const n = g.nodes[u]!;
      if (!n.alive || n.kind !== 'junction') continue;
      const d = degree(n);
      if (d === 2) {
        mergeThrough(g, u);
        changed = true;
      } else if (d === 1) {
        n.kind = 'end';
        changed = true;
      } else if (d === 0) {
        n.alive = false;
        changed = true;
      }
    }
    // d. Traits isolés et boucles plus courts que k.
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i]!;
      if (!e.alive) continue;
      const a = g.nodes[e.a]!;
      const b = g.nodes[e.b]!;
      const isolated = e.closed ? a.kind === 'loop' : a.kind === 'end' && b.kind === 'end';
      if (!isolated || edgeLength(g, e) >= k) continue;
      e.alive = false;
      a.alive = false;
      b.alive = false;
      a.edges = [];
      b.edges = [];
      changed = true;
    }
  }
}

/** Fenêtre minimale (px) de mesure d'un virage. */
export const CORNER_REACH = 4;

/**
 * Coins d'une polyligne de squelette : virage entre p_i − p_b et p_f − p_i, b
 * et f étant les premiers points à `reach` px (longueur d'arc) de part et
 * d'autre ; pics au-dessus de `cornerAngle` (degrés), maxima sur ±`reach`.
 * Fenêtre proportionnelle à l'épaisseur du trait : l'amincissement émousse le
 * coin d'un trait épais en un chanfrein d'environ une demi-épaisseur, qu'une
 * fenêtre de quelques pixels verrait comme deux virages de 45°. Ouverte : aucun
 * coin à moins de `reach` d'une extrémité. Indices croissants.
 */
export function strokeCorners(
  x: Float64Array,
  y: Float64Array,
  n: number,
  closed: boolean,
  cornerAngle: number,
  reach: number,
): number[] {
  if (n < 3) return [];
  const s = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const j = i % n;
    if (i === n && !closed) break;
    s[i] = s[i - 1]! + Math.hypot(x[j]! - x[i - 1]!, y[j]! - y[i - 1]!);
  }
  const total = closed ? s[n]! : s[n - 1]!;
  if (closed && total < 4 * reach) return [];
  // Abscisse curviligne « dépliée » (fermée : modulo total).
  const arc = (i: number): number => {
    if (!closed) return s[i]!;
    const k = Math.floor(i / n);
    return s[((i % n) + n) % n]! + k * total;
  };
  const px = (i: number): number => x[((i % n) + n) % n]!;
  const py = (i: number): number => y[((i % n) + n) % n]!;
  const cosT = Math.cos((cornerAngle * Math.PI) / 180);
  const cs = new Float64Array(n).fill(2);
  let b = 0;
  let f = 0;
  for (let i = 0; i < n; i++) {
    const si = arc(i);
    if (!closed && (si < reach || total - si < reach)) continue;
    b = closed ? i - 1 : Math.min(b, i - 1);
    while ((closed || b > 0) && si - arc(b) < reach) b--;
    f = Math.max(f, i + 1);
    while ((closed || f < n - 1) && arc(f) - si < reach) f++;
    if (si - arc(b) < reach || arc(f) - si < reach) continue;
    const bx = px(i) - px(b);
    const by = py(i) - py(b);
    const fx = px(f) - px(i);
    const fy = py(f) - py(i);
    const l = Math.sqrt((bx * bx + by * by) * (fx * fx + fy * fy));
    if (l > 0) cs[i] = (bx * fx + by * fy) / l;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ci = cs[i]!;
    if (!(ci < cosT)) continue;
    let peak = true;
    for (let d = 1; peak && d < n; d++) {
      for (const j of [i - d, i + d]) {
        if (!closed && (j < 0 || j >= n)) continue;
        if (Math.abs(arc(j) - arc(i)) > reach) continue;
        const cj = cs[((j % n) + n) % n]!;
        if (cj < ci || (cj === ci && j < i)) peak = false;
      }
      if (Math.abs(arc(i + d) - arc(i)) > reach && Math.abs(arc(i - d) - arc(i)) > reach) break;
    }
    if (peak) out.push(i);
  }
  return out;
}

/**
 * Bouts de trait redressés : l'amincissement courbe le bout d'un trait épais
 * vers un coin de son extrémité (crochet d'une demi-épaisseur). Les points à
 * moins de r d'une extrémité sont retirés et l'extrémité est projetée sur la
 * droite ajustée au tronçon suivant (entre r et r + max(4, 2r)).
 */
export function straightenEnds(g: WorkGraph, dist2: Uint16Array, w: number, h: number): void {
  for (let u = 0; u < g.nodes.length; u++) {
    const n = g.nodes[u]!;
    if (!n.alive || n.kind !== 'end' || n.edges.length !== 1 || n.radius < 1.5) continue;
    const e = g.edges[n.edges[0]!]!;
    if (e.a === e.b) continue;
    const fromStart = e.a === u;
    const p = outward(g, e, fromStart);
    const line = fitLine(p, n.x, n.y, n.radius, n.radius + Math.max(4, 2 * n.radius));
    if (!line) continue;
    const t = (n.x - line.cx) * line.dx + (n.y - line.cy) * line.dy;
    const fx = line.cx + t * line.dx;
    const fy = line.cy + t * line.dy;
    // Projection sur l'axe seulement pour un vrai crochet (écart > ½ rayon) :
    // sur un trait courbe, l'axe ajusté passe à côté du bout (flèche de l'arc).
    const hook = Math.hypot(fx - n.x, fy - n.y) > HOOK_FACTOR * n.radius;
    let nx = hook ? fx : n.x;
    let ny = hook ? fy : n.y;
    if (hook) trim(e, fromStart, n.x, n.y, n.radius);
    // Longueur : le bout ROND du tracé (rayon = demi-épaisseur H) doit finir où
    // finit l'encre. On avance depuis l'extrémité, le long de l'axe, jusqu'au
    // bord de l'encre (distance interpolée ½ : mi-chemin entre centres) ;
    // l'extrémité est placée à H en deçà.
    const H = meanWidth(e) / 2;
    const ux = (Math.sign(t) || 1) * line.dx;
    const uy = (Math.sign(t) || 1) * line.dy;
    let tip = 0;
    const limit = 2 * n.radius + 2;
    while (tip < limit && distanceAt(dist2, w, h, nx + tip * ux, ny + tip * uy) > 0.5) tip += 0.25;
    const shift = Math.max(-H, Math.min(n.radius, tip - H));
    nx += shift * ux;
    ny += shift * uy;
    n.x = nx;
    n.y = ny;
  }
}

/**
 * Distance au papier interpolée (bilinéaire) au point (x, y) du repère du
 * treillis (centre du pixel (i, j) en (i + ½, j + ½)) ; 0 hors de l'image.
 */
export function distanceAt(dist2: Uint16Array, w: number, h: number, x: number, y: number): number {
  const gx = x - 0.5;
  const gy = y - 0.5;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const v = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= w || j >= h ? 0 : Math.sqrt(dist2[j * w + i]!);
  return (
    (1 - fy) * ((1 - fx) * v(x0, y0) + fx * v(x0 + 1, y0)) +
    fy * ((1 - fx) * v(x0, y0 + 1) + fx * v(x0 + 1, y0 + 1))
  );
}

/** Épaisseur moyenne des points d'une arête de travail (1 si aucun point mesuré). */
function meanWidth(e: WEdge): number {
  let sum = 0;
  let cnt = 0;
  for (const v of e.wid) {
    if (Number.isFinite(v)) {
      sum += v;
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 1;
}

/** Écart bout / axe (fraction du rayon au bout) au-delà duquel le bout est un crochet à redresser. */
export const HOOK_FACTOR = 0.5;

/** Droite (centre, direction unitaire) ajustée aux points à une distance dans ]lo, hi] de (ox, oy), parcourus dans l'ordre. */
function fitLine(
  p: readonly number[],
  ox: number,
  oy: number,
  lo: number,
  hi: number,
): { cx: number; cy: number; dx: number; dy: number } | null {
  const sel: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const d = Math.hypot(p[i]! - ox, p[i + 1]! - oy);
    if (d > hi) break;
    if (d > lo) sel.push(p[i]!, p[i + 1]!);
  }
  const m = sel.length >> 1;
  if (m < 3) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < m; i++) {
    cx += sel[2 * i]!;
    cy += sel[2 * i + 1]!;
  }
  cx /= m;
  cy /= m;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < m; i++) {
    const dx = sel[2 * i]! - cx;
    const dy = sel[2 * i + 1]! - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(th), dy: Math.sin(th) };
}

/** Retire les points intérieurs à moins de r de (ox, oy) depuis l'extrémité indiquée. */
function trim(e: WEdge, fromStart: boolean, ox: number, oy: number, r: number): void {
  const m = e.pts.length >> 1;
  const near = (k: number): boolean => Math.hypot(e.pts[2 * k]! - ox, e.pts[2 * k + 1]! - oy) <= r;
  let cut = 0;
  if (fromStart) {
    while (cut < m && near(cut)) cut++;
    e.pts.splice(0, 2 * cut);
    e.wid.splice(0, cut);
  } else {
    while (cut < m && near(m - 1 - cut)) cut++;
    e.pts.splice(2 * (m - cut), 2 * cut);
    e.wid.splice(m - cut, cut);
  }
}

/**
 * Étape 4 : découpe aux coins (virage plus net que `cornerAngle`, détection
 * de `fit/polyline.ts`). Une boucle à coins perd son ancre arbitraire : ses
 * coins deviennent ses nœuds.
 */
export function splitCorners(g: WorkGraph, cornerAngle: number): void {
  const count = g.edges.length;
  for (let i = 0; i < count; i++) {
    const e = g.edges[i]!;
    if (!e.alive) continue;
    const full = fullPoints(g, e);
    const wid = [NaN, ...e.wid, NaN];
    let n = full.length >> 1;
    if (e.closed) n--; // le dernier point répète l'ancre
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      x[j] = full[2 * j]!;
      y[j] = full[2 * j + 1]!;
    }
    const reach = Math.max(CORNER_REACH, meanWidth(e));
    const index = strokeCorners(x, y, n, e.closed, cornerAngle, reach);
    if (index.length === 0) continue;
    const at = (j: number): { x: number; y: number; w: number } => ({
      x: x[j % n]!,
      y: y[j % n]!,
      w: wid[j % n]!,
    });
    const corner = (j: number): number => {
      const p = at(j);
      const id = g.nodes.length;
      const r = Number.isFinite(p.w) ? (p.w + 1) / 2 : 1;
      g.nodes.push({ kind: 'corner', x: p.x, y: p.y, radius: r, edges: [], alive: true });
      return id;
    };
    const piece = (a: number, b: number, from: number, to: number): void => {
      const pts: number[] = [];
      const ws: number[] = [];
      for (let j = from + 1; j < to; j++) {
        const p = at(j);
        pts.push(p.x, p.y);
        ws.push(p.w);
      }
      const id = g.edges.length;
      g.edges.push({ a, b, pts, wid: ws, closed: false, alive: true });
      g.nodes[a]!.edges.push(id);
      g.nodes[b]!.edges.push(id);
    };
    e.alive = false;
    const na = g.nodes[e.a]!;
    const nb = g.nodes[e.b]!;
    detach(na, i);
    detach(nb, i);
    if (!e.closed) {
      let prev = e.a;
      let prevIdx = 0;
      for (const j of index) {
        const c = corner(j);
        piece(prev, c, prevIdx, j);
        prev = c;
        prevIdx = j;
      }
      piece(prev, e.b, prevIdx, n - 1);
    } else {
      na.alive = false; // ancre arbitraire remplacée par les coins
      const ids = index.map(corner);
      for (let m = 0; m < ids.length; m++) {
        const j0 = index[m]!;
        const j1 = m + 1 < ids.length ? index[m + 1]! : index[0]! + n;
        piece(ids[m]!, ids[(m + 1) % ids.length]!, j0, j1);
      }
      if (ids.length === 1) g.edges[g.edges.length - 1]!.closed = true;
    }
  }
}

/** Points sortants d'une extrémité d'arête au nœud u (`fromStart` : extrémité a). */
function outward(g: WorkGraph, e: WEdge, fromStart: boolean): number[] {
  const far = g.nodes[fromStart ? e.b : e.a]!;
  if (fromStart) return [...e.pts, far.x, far.y];
  const out: number[] = [];
  for (let i = e.pts.length - 2; i >= 0; i -= 2) out.push(e.pts[i]!, e.pts[i + 1]!);
  out.push(far.x, far.y);
  return out;
}

/** Extrémités (arête, côté) incidentes au nœud u ; une boucle u → u donne ses deux côtés. */
function ends(g: WorkGraph, u: number): { e: number; fromStart: boolean }[] {
  const out: { e: number; fromStart: boolean }[] = [];
  const seen = new Set<number>();
  for (const i of g.nodes[u]!.edges) {
    if (seen.has(i)) continue;
    seen.add(i);
    const e = g.edges[i]!;
    if (e.a === u) out.push({ e: i, fromStart: true });
    if (e.b === u) out.push({ e: i, fromStart: false });
  }
  return out;
}

/**
 * Étape 5 : jonctions et coins recalés à l'intersection, au sens des moindres
 * carrés, des axes de leurs branches (droite ajustée sur chaque branche entre
 * r + ½ et r + ½ + max(4, 2r) du nœud, r = demi-épaisseur au nœud) ; refus si
 * le point s'éloigne de plus de r + 1,5 px (branches parallèles, courbes).
 * Puis les points de chaque branche à moins de r du nœud (zone déformée par
 * la jonction) sont retirés.
 */
export function refineNodes(g: WorkGraph): void {
  for (let u = 0; u < g.nodes.length; u++) {
    const n = g.nodes[u]!;
    if (!n.alive || (n.kind !== 'junction' && n.kind !== 'corner')) continue;
    const list = ends(g, u);
    if (list.length < 2) continue;
    const r = n.radius;
    const lo = r + 0.5;
    const hi = lo + Math.max(4, 2 * r);
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    let lines = 0;
    const fits = list.map(({ e, fromStart }) =>
      fitLine(outward(g, g.edges[e]!, fromStart), n.x, n.y, lo, hi),
    );
    for (const line of fits) {
      if (!line) continue;
      const { cx, cy, dx, dy } = line;
      // Projecteur orthogonal I − d·dᵀ.
      const p11 = 1 - dx * dx;
      const p12 = -dx * dy;
      const p22 = 1 - dy * dy;
      a11 += p11;
      a12 += p12;
      a22 += p22;
      b1 += p11 * cx + p12 * cy;
      b2 += p12 * cx + p22 * cy;
      lines++;
    }
    const det = a11 * a22 - a12 * a12;
    if (lines >= 2 && det > 0.05 * lines * lines) {
      const x = (a22 * b1 - a12 * b2) / det;
      const y = (a11 * b2 - a12 * b1) / det;
      if (Math.hypot(x - n.x, y - n.y) <= r + 1.5) {
        n.x = x;
        n.y = y;
      }
    }
    // Rognage de la zone déformée. Une branche dont l'axe passe à côté du nœud
    // (jonctions voisines contractées en une : toit qui croise l'angle d'un
    // mur) le rejoint par un court segment depuis le pied de la perpendiculaire,
    // au lieu de s'infléchir vers lui : le trait reste droit.
    list.forEach(({ e, fromStart }, k) => {
      const edge = g.edges[e]!;
      trim(edge, fromStart, n.x, n.y, r);
      const line = fits[k];
      if (!line) return;
      const t = (n.x - line.cx) * line.dx + (n.y - line.cy) * line.dy;
      const fx = line.cx + t * line.dx;
      const fy = line.cy + t * line.dy;
      if (Math.hypot(fx - n.x, fy - n.y) <= OFF_AXIS) return;
      if (fromStart) {
        edge.pts.unshift(fx, fy);
        edge.wid.unshift(NaN);
      } else {
        edge.pts.push(fx, fy);
        edge.wid.push(NaN);
      }
    });
  }
}

/** Écart (px) entre un nœud et l'axe d'une branche au-delà duquel la branche le rejoint par un segment. */
export const OFF_AXIS = 0.75;

/** Étapes 1 à 6, puis numérotation dense. */
export function buildStrokeGraph(
  mask: Uint8Array,
  skeleton: Int32Array,
  w: number,
  h: number,
  dist2: Uint16Array,
  options: GraphOptions,
): Pick<StrokeGraph, 'width' | 'height' | 'nodes' | 'edges'> {
  const g = traceSkeleton(mask, skeleton, w, h, dist2);
  simplifyGraph(g, options.spurLength);
  straightenEnds(g, dist2, w, h);
  splitCorners(g, options.cornerAngle);
  refineNodes(g);
  return finalizeGraph(g, w, h);
}

/** Graphe de travail → `StrokeGraph` (ids denses, points complets, épaisseurs). */
export function finalizeGraph(
  g: WorkGraph,
  w: number,
  h: number,
): Pick<StrokeGraph, 'width' | 'height' | 'nodes' | 'edges'> {
  const nodeId = new Int32Array(g.nodes.length).fill(-1);
  const nodes: StrokeNode[] = [];
  const edges: StrokeEdge[] = [];
  for (const e of g.edges) {
    if (!e.alive) continue;
    for (const u of [e.a, e.b]) {
      if (nodeId[u] === -1) {
        const n = g.nodes[u]!;
        nodeId[u] = nodes.length;
        nodes.push({ id: nodes.length, x: n.x, y: n.y, kind: n.kind, degree: 0, radius: n.radius });
      }
    }
    const a = nodeId[e.a]!;
    const b = nodeId[e.b]!;
    nodes[a]!.degree++;
    nodes[b]!.degree++;
    const full = fullPoints(g, e);
    let sum = 0;
    let cnt = 0;
    for (const v of e.wid) {
      if (Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    const na = g.nodes[e.a]!;
    const nb = g.nodes[e.b]!;
    const width = cnt > 0 ? sum / cnt : Math.max(1, Math.min(na.radius, nb.radius) * 2 - 1);
    edges.push({
      id: edges.length,
      points: Float64Array.from(full),
      start: a,
      end: b,
      closed: e.closed,
      width,
    });
  }
  return { width: w, height: h, nodes, edges };
}
