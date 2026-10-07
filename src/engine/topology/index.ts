import type {
  BoundaryChain,
  BoundaryGraph,
  BoundaryVertex,
  Face,
  LabelMap,
  Ring,
  RingEdge,
  VectorizeContext,
} from '../types.ts';
import { IMAGE_BORDER, TRANSPARENT } from '../types.ts';
import { checkCancel, globalProgress } from '../pipeline.ts';

/**
 * T03 — Graphe planaire des frontières : sommets (jonctions), chaînes partagées
 * (left/right), faces avec anneaux (extérieur + trous), arbre de contenance.
 *
 * Conventions (repère écran, y vers le bas) :
 *  - directions 0 = E (+x), 1 = S (+y), 2 = O (−x), 3 = N (−y) ;
 *  - la GAUCHE d'une direction (dx, dy) est la normale (−dy, dx) prise dans les
 *    coordonnées brutes : à gauche de E se trouve le pixel du DESSOUS. Ainsi un
 *    anneau qui laisse sa face à gauche a une aire de lacet (shoelace)
 *    `Σ (x_i·y_{i+1} − x_{i+1}·y_i) / 2` POSITIVE ; à l'écran il tourne dans le
 *    sens horaire. Un trou a une aire négative. La somme des aires signées des
 *    anneaux d'une face vaut exactement l'aire de la région ;
 *  - une arête de treillis est une frontière si les pixels qu'elle sépare ont
 *    des labels différents dont au moins un est une région (≥ 0) : la limite
 *    TRANSPARENT | IMAGE_BORDER ne porte aucun tracé ;
 *  - au coin d'un « damier », chaque face contourne SON pixel (on tourne
 *    d'abord à gauche, donc on colle à la face) : deux pixels d'une même face en
 *    diagonale ne sont jamais reliés par le coin. Topologiquement, les régions
 *    sont 4-connexes et leur complémentaire 8-connexe.
 *
 * Sommets : coins de degré 3 ou 4 ; coins d'image touchés par une frontière
 * (degré 2, gardés pour figer les angles du cadre) ; coins du cadre de degré 2
 * où le label extérieur change (IMAGE_BORDER ↔ TRANSPARENT) ; ancre (coin le
 * plus haut puis le plus à gauche) de chaque boucle sans jonction, qui devient
 * une chaîne fermée.
 */
export function buildBoundaryGraph(map: LabelMap, ctx?: VectorizeContext): BoundaryGraph {
  const { width: W, height: H, labels } = map;
  if (labels.length !== W * H) {
    throw new Error(`buildBoundaryGraph : labels de longueur ${labels.length}, attendu ${W * H}`);
  }
  const progress = (p: number): void => ctx?.onProgress?.(globalProgress('topology', p));
  /** Point de reprise des boucles longues (~1 Mpx) : annulation et progression (T12). */
  const tick = (p: number): void => {
    checkCancel(ctx);
    progress(p);
  };
  progress(0);
  const W1 = W + 1;
  const H1 = H + 1;
  const lab = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? IMAGE_BORDER : labels[y * W + x]!;

  // --- Arêtes frontières ---------------------------------------------------
  // hb[y*W + x] : arête horizontale (x,y)→(x+1,y), y ∈ 0..H (pixel dessus / dessous).
  // vb[y*W1 + x] : arête verticale (x,y)→(x,y+1), x ∈ 0..W (pixel gauche / droite).
  const hb = new Uint8Array(W * H1);
  const vb = new Uint8Array(W1 * H);
  for (let y = 0; y <= H; y++) {
    if ((y & 63) === 0) tick(0.075 * (y / H1));
    for (let x = 0; x < W; x++) {
      const a = y > 0 ? labels[(y - 1) * W + x]! : IMAGE_BORDER;
      const b = y < H ? labels[y * W + x]! : IMAGE_BORDER;
      if (a !== b && (a >= 0 || b >= 0)) hb[y * W + x] = 1;
    }
  }
  for (let y = 0; y < H; y++) {
    if ((y & 63) === 0) tick(0.075 + 0.075 * (y / H));
    const row = y * W;
    for (let x = 0; x <= W; x++) {
      const a = x > 0 ? labels[row + x - 1]! : IMAGE_BORDER;
      const b = x < W ? labels[row + x]! : IMAGE_BORDER;
      if (a !== b && (a >= 0 || b >= 0)) vb[y * W1 + x] = 1;
    }
  }
  const has = (x: number, y: number, d: number): boolean => {
    switch (d) {
      case 0:
        return x < W && hb[y * W + x] === 1;
      case 1:
        return y < H && vb[y * W1 + x] === 1;
      case 2:
        return x > 0 && hb[y * W + x - 1] === 1;
      default:
        return y > 0 && vb[(y - 1) * W1 + x] === 1;
    }
  };
  progress(0.15);

  // --- Sommets ---------------------------------------------------------------
  const vid = new Int32Array(W1 * H1).fill(-1);
  const vx: number[] = [];
  const vy: number[] = [];
  const addVertex = (x: number, y: number): number => {
    const id = vx.length;
    vx.push(x);
    vy.push(y);
    vid[y * W1 + x] = id;
    return id;
  };
  for (let y = 0; y <= H; y++) {
    if ((y & 63) === 0) tick(0.15 + 0.15 * (y / H1));
    for (let x = 0; x <= W; x++) {
      const deg = +has(x, y, 0) + +has(x, y, 1) + +has(x, y, 2) + +has(x, y, 3);
      if (deg === 0) continue;
      let isVertex = deg !== 2;
      if (!isVertex && (x === 0 || x === W || y === 0 || y === H)) {
        if ((x === 0 || x === W) && (y === 0 || y === H)) isVertex = true;
        else {
          // Sur le cadre, un coin de degré 2 peut séparer IMAGE_BORDER et TRANSPARENT.
          const q0 = lab(x - 1, y - 1);
          const q1 = lab(x, y - 1);
          const q2 = lab(x - 1, y);
          const q3 = lab(x, y);
          let distinct = 1;
          if (q1 !== q0) distinct++;
          if (q2 !== q0 && q2 !== q1) distinct++;
          if (q3 !== q0 && q3 !== q1 && q3 !== q2) distinct++;
          isVertex = distinct >= 3;
        }
      }
      if (isVertex) addVertex(x, y);
    }
  }
  progress(0.3);

  // --- Chaînes -------------------------------------------------------------
  const hv = new Uint8Array(W * H1); // arêtes déjà parcourues
  const vv = new Uint8Array(W1 * H);
  const markVisited = (x: number, y: number, d: number): boolean => {
    // Renvoie true si l'arête était déjà visitée.
    let arr: Uint8Array;
    let idx: number;
    switch (d) {
      case 0:
        arr = hv;
        idx = y * W + x;
        break;
      case 1:
        arr = vv;
        idx = y * W1 + x;
        break;
      case 2:
        arr = hv;
        idx = y * W + x - 1;
        break;
      default:
        arr = vv;
        idx = (y - 1) * W1 + x;
    }
    if (arr[idx] === 1) return true;
    arr[idx] = 1;
    return false;
  };

  const chains: BoundaryChain[] = [];
  const firstDir: number[] = [];
  const lastDir: number[] = [];
  const twiceArea: number[] = []; // Σ (x_i·y_{i+1} − x_{i+1}·y_i) le long de la chaîne
  const vout: number[] = []; // vout[v*4 + d] = usage sortant (2c ou 2c+1) dans la direction d
  const pts: number[] = [];

  const walk = (sv: number, d0: number, closedAnchor: boolean): void => {
    let x = vx[sv]!;
    let y = vy[sv]!;
    const [left, right] = sides(lab, x, y, d0);
    pts.length = 0;
    pts.push(x, y);
    let d = d0;
    let area2 = 0;
    let ev: number;
    for (;;) {
      markVisited(x, y, d);
      const nx = x + DX[d]!;
      const ny = y + DY[d]!;
      area2 += x * ny - nx * y;
      x = nx;
      y = ny;
      pts.push(x, y);
      const v = vid[y * W1 + x]!;
      if (v >= 0) {
        ev = v;
        break;
      }
      // Coin de degré 2 hors sommet : une seule autre arête (pas de demi-tour).
      const l = (d + 1) & 3;
      const r = (d + 3) & 3;
      d = has(x, y, l) ? l : has(x, y, d) ? d : r;
    }
    const id = chains.length;
    chains.push({
      id,
      points: Float64Array.from(pts),
      start: sv,
      end: ev,
      left,
      right,
      closed: closedAnchor,
    });
    firstDir.push(d0);
    lastDir.push(d);
    twiceArea.push(area2);
    vout[sv * 4 + d0] = 2 * id;
    vout[ev * 4 + ((d + 2) & 3)] = 2 * id + 1;
  };

  const nv0 = vx.length;
  for (let k = 0; k < nv0 * 4; k++) vout.push(-1);
  for (let v = 0; v < nv0; v++) {
    if ((v & 4095) === 0) tick(0.3 + 0.15 * (v / nv0));
    const x = vx[v]!;
    const y = vy[v]!;
    for (let d = 0; d < 4; d++) {
      if (!has(x, y, d) || isVisited(hv, vv, W, W1, x, y, d)) continue;
      walk(v, d, false);
    }
  }
  // Boucles sans jonction : l'ancre est le premier coin rencontré en balayage
  // (le plus haut, puis le plus à gauche) ; il n'a que les arêtes E et S.
  for (let y = 0; y < H; y++) {
    if ((y & 63) === 0) tick(0.45 + 0.1 * (y / H));
    for (let x = 0; x < W; x++) {
      const e = y * W + x;
      if (hb[e] === 1 && hv[e] === 0) {
        const v = addVertex(x, y);
        vout.push(-1, -1, -1, -1);
        walk(v, 0, true);
      }
    }
  }
  progress(0.55);

  const vertices: BoundaryVertex[] = new Array(vx.length);
  const degree = new Int32Array(vx.length);
  for (const c of chains) {
    degree[c.start]!++;
    degree[c.end]!++;
  }
  for (let v = 0; v < vx.length; v++) {
    vertices[v] = { id: v, x: vx[v]!, y: vy[v]!, degree: degree[v]! };
  }

  // --- Anneaux -------------------------------------------------------------
  // Un « usage » u = 2c (chaîne c dans son sens, face = left) ou 2c+1 (inversée,
  // face = right). En arrivant à un sommet, on prend la première arête frontière
  // en tournant à gauche, puis tout droit, puis à droite : elle garde la même
  // face à gauche (la face est collée), donc l'usage suivant est le bon.
  const R = map.regions.length;
  const C = chains.length;
  const used = new Uint8Array(2 * C);
  const ringsOf: { edges: RingEdge[]; area2: number }[][] = [];
  for (let r = 0; r < R; r++) ringsOf.push([]);
  const useRing = new Int32Array(2 * C).fill(-1); // index d'anneau dans sa face
  for (let u0 = 0; u0 < 2 * C; u0++) {
    if ((u0 & 4095) === 0) tick(0.55 + 0.2 * (u0 / (2 * C)));
    if (used[u0] === 1) continue;
    const c0 = chains[u0 >> 1]!;
    const face = u0 & 1 ? c0.right : c0.left;
    if (face < 0) continue;
    if (face >= R) throw new Error(`buildBoundaryGraph : label ${face} hors de regions`);
    const edges: RingEdge[] = [];
    let area2 = 0;
    const ringIndex = ringsOf[face]!.length;
    let u = u0;
    do {
      if (used[u] === 1) throw new Error('buildBoundaryGraph : anneau incohérent');
      used[u] = 1;
      useRing[u] = ringIndex;
      const ci = u >> 1;
      const rev = (u & 1) === 1;
      edges.push({ chain: ci, reversed: rev });
      const ch = chains[ci]!;
      area2 += rev ? -twiceArea[ci]! : twiceArea[ci]!;
      const v = rev ? ch.start : ch.end;
      const d = rev ? (firstDir[ci]! + 2) & 3 : lastDir[ci]!;
      const x = vx[v]!;
      const y = vy[v]!;
      const l = (d + 1) & 3;
      const r = (d + 3) & 3;
      const nd = has(x, y, l) ? l : has(x, y, d) ? d : r;
      u = vout[v * 4 + nd]!;
      if (u === undefined || u < 0) throw new Error('buildBoundaryGraph : sommet sans sortie');
    } while (u !== u0);
    ringsOf[face]!.push({ edges, area2 });
  }
  progress(0.75);

  // Extérieur = aire signée maximale (positive) ; il passe en tête.
  const faces: Face[] = new Array(R);
  const holeUse = new Uint8Array(2 * C);
  for (let f = 0; f < R; f++) {
    const rs = ringsOf[f]!;
    let ext = 0;
    for (let i = 1; i < rs.length; i++) if (rs[i]!.area2 > rs[ext]!.area2) ext = i;
    const rings: Ring[] = [];
    if (rs.length > 0) rings.push({ edges: rs[ext]!.edges, isHole: false });
    for (let i = 0; i < rs.length; i++) {
      if (i === ext) continue;
      rings.push({ edges: rs[i]!.edges, isHole: true });
      for (const e of rs[i]!.edges) holeUse[2 * e.chain + (e.reversed ? 1 : 0)] = 1;
    }
    faces[f] = { region: f, colorId: map.regions[f]!.colorId, rings, parent: -1, depth: 0 };
  }

  computeContainment(map, chains, firstDir, holeUse, faces, (p) => tick(0.75 + 0.25 * p));
  progress(1);
  return { width: W, height: H, vertices, chains, faces };
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Labels [gauche, droite] de l'arête partant de (x, y) dans la direction d. */
function sides(
  lab: (x: number, y: number) => number,
  x: number,
  y: number,
  d: number,
): [number, number] {
  const [l, r] = sidePixels(x, y, d);
  return [lab(l[0], l[1]), lab(r[0], r[1])];
}

/** Pixels [gauche, droite] de l'arête partant du coin (x, y) dans la direction d. */
export function sidePixels(x: number, y: number, d: number): [[number, number], [number, number]] {
  switch (d) {
    case 0:
      return [
        [x, y],
        [x, y - 1],
      ];
    case 1:
      return [
        [x - 1, y],
        [x, y],
      ];
    case 2:
      return [
        [x - 1, y - 1],
        [x - 1, y],
      ];
    default:
      return [
        [x, y - 1],
        [x - 1, y - 1],
      ];
  }
}

function isVisited(
  hv: Uint8Array,
  vv: Uint8Array,
  W: number,
  W1: number,
  x: number,
  y: number,
  d: number,
): boolean {
  switch (d) {
    case 0:
      return hv[y * W + x] === 1;
    case 1:
      return vv[y * W1 + x] === 1;
    case 2:
      return hv[y * W + x - 1] === 1;
    default:
      return vv[(y - 1) * W1 + x] === 1;
  }
}

/**
 * Arbre de contenance. Méthode (sans géométrie) :
 *  - si une chaîne de l'anneau EXTÉRIEUR de f appartient à un TROU de g, alors
 *    g est le parent immédiat de f (une face intermédiaire séparerait f du trou) ;
 *  - si elle appartient à l'anneau extérieur de g, f et g sont SŒURS (même
 *    parent) : on les réunit (union-find) ; idem avec IMAGE_BORDER (groupe
 *    racine) et avec chaque composante 8-connexe de pixels TRANSPARENTS, qui se
 *    comporte comme une sœur sans tracé (le parent d'une face posée dans un trou
 *    transparent est la région qui entoure ce transparent) ;
 *  - le parent d'un groupe est la région dont un trou touche un de ses membres ;
 *    un groupe qui contient IMAGE_BORDER est racine.
 * Ainsi un disque posé à cheval sur deux fonds côte à côte est sœur des deux
 * fonds et hérite de leur parent commun.
 */
function computeContainment(
  map: LabelMap,
  chains: BoundaryChain[],
  firstDir: number[],
  holeUse: Uint8Array,
  faces: Face[],
  tick?: (p: number) => void,
): void {
  const { width: W, height: H, labels } = map;
  const R = faces.length;
  const BORDER_NODE = R;
  // Composantes 8-connexes des pixels transparents (seulement si nécessaire).
  let tcomp: Int32Array | null = null;
  let tCount = 0;
  const tTouchesBorder: boolean[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === TRANSPARENT) {
      tcomp = new Int32Array(labels.length).fill(-1);
      break;
    }
  }
  if (tcomp) {
    const stack: number[] = [];
    for (let s = 0; s < labels.length; s++) {
      if ((s & 0xfffff) === 0) tick?.(0.5 * (s / labels.length));
      if (labels[s] !== TRANSPARENT || tcomp[s] !== -1) continue;
      const id = tCount++;
      let border = false;
      tcomp[s] = id;
      stack.push(s);
      while (stack.length > 0) {
        const i = stack.pop()!;
        const x = i % W;
        const y = (i - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const j = ny * W + nx;
            if (labels[j] === TRANSPARENT && tcomp[j] === -1) {
              tcomp[j] = id;
              stack.push(j);
            }
          }
        }
      }
      tTouchesBorder.push(border);
    }
  }
  const N = R + 1 + tCount;
  const uf = new Int32Array(N);
  for (let i = 0; i < N; i++) uf[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (uf[r] !== r) r = uf[r]!;
    while (uf[a] !== r) {
      const nx = uf[a]!;
      uf[a] = r;
      a = nx;
    }
    return r;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) uf[ra] = rb;
  };
  for (let t = 0; t < tCount; t++) if (tTouchesBorder[t]) unite(R + 1 + t, BORDER_NODE);

  const nodeOf = (label: number, px: [number, number]): number => {
    if (label >= 0) return label;
    if (label === IMAGE_BORDER) return BORDER_NODE;
    return R + 1 + tcomp![px[1] * W + px[0]]!;
  };
  const childParent: number[] = []; // paires (nœud enfant, région parente)
  for (const ch of chains) {
    const d = firstDir[ch.id]!;
    const [lp, rp] = sidePixels(ch.points[0]!, ch.points[1]!, d);
    const l = ch.left;
    const r = ch.right;
    const lHole = l >= 0 && holeUse[2 * ch.id] === 1;
    const rHole = r >= 0 && holeUse[2 * ch.id + 1] === 1;
    if (lHole) childParent.push(nodeOf(r, rp), l);
    if (rHole) childParent.push(nodeOf(l, lp), r);
    if (!lHole && !rHole) unite(nodeOf(l, lp), nodeOf(r, rp));
  }
  const groupParent = new Int32Array(N).fill(-1);
  for (let i = 0; i < childParent.length; i += 2) {
    groupParent[find(childParent[i]!)] = childParent[i + 1]!;
  }
  const borderRoot = find(BORDER_NODE);
  for (let f = 0; f < R; f++) {
    const g = find(f);
    faces[f]!.parent = g === borderRoot ? -1 : groupParent[g]!;
  }
  // Profondeurs (itératif, l'arbre peut être profond).
  const depth = new Int32Array(R).fill(-1);
  const path: number[] = [];
  for (let f = 0; f < R; f++) {
    let cur = f;
    path.length = 0;
    while (cur >= 0 && depth[cur] === -1 && path.length <= R) {
      path.push(cur);
      cur = faces[cur]!.parent;
    }
    let d = cur >= 0 ? depth[cur]! : -1;
    for (let i = path.length - 1; i >= 0; i--) {
      d++;
      depth[path[i]!] = d;
      faces[path[i]!]!.depth = d;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilitaires purs (tests, évaluation T06)
// ---------------------------------------------------------------------------

/**
 * Aire signée d'un anneau (formule du lacet en coordonnées de treillis) :
 * positive pour un extérieur (face à gauche), négative pour un trou.
 */
export function ringSignedArea(graph: BoundaryGraph, ring: Ring): number {
  let s = 0;
  for (const e of ring.edges) {
    const p = graph.chains[e.chain]!.points;
    let a = 0;
    for (let i = 0; i + 3 < p.length; i += 2) a += p[i]! * p[i + 3]! - p[i + 2]! * p[i + 1]!;
    s += e.reversed ? -a : a;
  }
  return s / 2;
}

/**
 * Nombre de trous de chaque région, calculé SANS le graphe (caractéristique
 * d'Euler en 4-connexité : χ = pixels − paires 4-adjacentes + blocs 2×2 pleins ;
 * une région 4-connexe a χ = 1 − trous, les trous étant les composantes
 * 8-connexes bornées de son complémentaire). Suppose chaque région 4-connexe.
 */
export function countHoles(map: LabelMap): Int32Array {
  const { width: W, height: H, labels } = map;
  const R = map.regions.length;
  const chi = new Int32Array(R);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = labels[i]!;
      if (a < 0) continue;
      chi[a]!++;
      const right = x + 1 < W && labels[i + 1] === a;
      const down = y + 1 < H && labels[i + W] === a;
      if (right) chi[a]!--;
      if (down) chi[a]!--;
      if (right && down && labels[i + W + 1] === a) chi[a]!++;
    }
  }
  const holes = new Int32Array(R);
  for (let r = 0; r < R; r++) holes[r] = 1 - chi[r]!;
  return holes;
}

/** Vérifie les invariants du graphe ; renvoie la liste (vide si tout va bien) des violations. */
export function validateGraph(graph: BoundaryGraph): string[] {
  const errs: string[] = [];
  const { width: W, height: H, vertices, chains, faces } = graph;
  const ends = new Int32Array(vertices.length);
  const anchors = new Uint8Array(vertices.length);
  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c]!;
    const p = ch.points;
    if (ch.id !== c) errs.push(`chaîne ${c} : id ${ch.id}`);
    if (p.length < 4 || p.length % 2 !== 0) {
      errs.push(`chaîne ${c} : ${p.length / 2} points`);
      continue;
    }
    const sv = vertices[ch.start];
    const ev = vertices[ch.end];
    if (!sv || !ev) {
      errs.push(`chaîne ${c} : sommet inconnu`);
      continue;
    }
    ends[ch.start]!++;
    ends[ch.end]!++;
    if (ch.closed) anchors[ch.start] = 1;
    if (p[0] !== sv.x || p[1] !== sv.y) errs.push(`chaîne ${c} : début ≠ sommet ${ch.start}`);
    if (p[p.length - 2] !== ev.x || p[p.length - 1] !== ev.y)
      errs.push(`chaîne ${c} : fin ≠ sommet ${ch.end}`);
    // Une boucle passant par une jonction a start === end sans être `closed` (ancre figée).
    if (ch.closed && ch.start !== ch.end) errs.push(`chaîne ${c} : fermée mais start ≠ end`);
    if (ch.left === ch.right) errs.push(`chaîne ${c} : même label des deux côtés`);
    if (ch.left < 0 && ch.right < 0) errs.push(`chaîne ${c} : aucune région de part et d'autre`);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = Math.abs(p[i + 2]! - p[i]!);
      const dy = Math.abs(p[i + 3]! - p[i + 1]!);
      if (dx + dy !== 1) {
        errs.push(`chaîne ${c} : pas non unitaire au point ${i / 2}`);
        break;
      }
    }
  }
  for (const v of vertices) {
    if (v.degree !== ends[v.id]) errs.push(`sommet ${v.id} : degré ${v.degree} ≠ ${ends[v.id]}`);
    const onFrame = v.x === 0 || v.y === 0 || v.x === W || v.y === H;
    if (v.degree === 2 && !onFrame && anchors[v.id] !== 1)
      errs.push(`sommet ${v.id} : degré 2 hors cadre et hors ancre`);
    if (v.degree < 2) errs.push(`sommet ${v.id} : degré ${v.degree}`);
  }
  // Chaque usage (chaîne, sens) doit apparaître une fois exactement, dans la bonne face.
  const seen = new Uint8Array(2 * chains.length);
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    if (face.region !== f) errs.push(`face ${f} : region ${face.region}`);
    if (face.rings.length === 0) errs.push(`face ${f} : aucun anneau`);
    face.rings.forEach((ring, ri) => {
      if (ring.isHole !== ri > 0) errs.push(`face ${f} anneau ${ri} : isHole incohérent`);
      const a = ringSignedArea(graph, ring);
      if (ri === 0 && !(a > 0)) errs.push(`face ${f} : extérieur d'aire ${a}`);
      if (ri > 0 && !(a < 0)) errs.push(`face ${f} trou ${ri} : aire ${a}`);
      const n = ring.edges.length;
      for (let k = 0; k < n; k++) {
        const e = ring.edges[k]!;
        const ch = chains[e.chain];
        if (!ch) {
          errs.push(`face ${f} : chaîne ${e.chain} inconnue`);
          return;
        }
        const u = 2 * e.chain + (e.reversed ? 1 : 0);
        if (seen[u]!++ > 0) errs.push(`chaîne ${e.chain} (${e.reversed ? '←' : '→'}) répétée`);
        const side = e.reversed ? ch.right : ch.left;
        if (side !== f) errs.push(`face ${f} : chaîne ${e.chain} n'a pas la face à gauche`);
        const next = ring.edges[(k + 1) % n]!;
        const nch = chains[next.chain];
        const endV = e.reversed ? ch.start : ch.end;
        const startV = nch ? (next.reversed ? nch.end : nch.start) : -1;
        if (endV !== startV) errs.push(`face ${f} anneau ${ri} : rupture après ${e.chain}`);
      }
    });
    if (face.parent < -1 || face.parent >= faces.length || face.parent === f)
      errs.push(`face ${f} : parent ${face.parent} invalide`);
    else {
      const pd = face.parent < 0 ? -1 : faces[face.parent]!.depth;
      if (face.depth !== pd + 1) errs.push(`face ${f} : profondeur ${face.depth} ≠ ${pd + 1}`);
    }
  }
  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c]!;
    if (ch.left >= 0 && seen[2 * c] !== 1) errs.push(`chaîne ${c} : absente de la face ${ch.left}`);
    if (ch.right >= 0 && seen[2 * c + 1] !== 1)
      errs.push(`chaîne ${c} : absente (inversée) de la face ${ch.right}`);
  }
  return errs;
}
