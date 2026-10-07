import { describe, expect, it } from 'vitest';
import { segment } from '../src/engine/segment/index.ts';
import {
  buildBoundaryGraph,
  countHoles,
  ringSignedArea,
  validateGraph,
} from '../src/engine/topology/index.ts';
import type { BoundaryGraph, LabelMap, ProgressEvent, Ring } from '../src/engine/types.ts';
import { CancelledError, IMAGE_BORDER, TRANSPARENT } from '../src/engine/types.ts';
import { labelsFromAscii, randomQuant, sideMismatches } from './label-helpers.ts';

/** Point dans un anneau (parité), pour un point qui n'est jamais sur le treillis. */
function pointInRing(graph: BoundaryGraph, ring: Ring, px: number, py: number): boolean {
  let inside = false;
  for (const e of ring.edges) {
    const p = graph.chains[e.chain]!.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i]!;
      const y0 = p[i + 1]!;
      const y1 = p[i + 3]!;
      // arêtes verticales seulement (un rayon horizontal ne croise qu'elles)
      if (x0 !== p[i + 2]! || x0 < px) continue;
      if (py > Math.min(y0, y1) && py < Math.max(y0, y1)) inside = !inside;
    }
  }
  return inside;
}

/**
 * Parent « par force brute » : parmi les trous de toutes les faces qui
 * contiennent le centre d'un pixel de f, celui de plus petite aire.
 */
function bruteParent(map: LabelMap, graph: BoundaryGraph, f: number): number {
  const i = map.labels.indexOf(f);
  const px = (i % map.width) + 0.5;
  const py = Math.floor(i / map.width) + 0.5;
  let best = -1;
  let bestArea = Infinity;
  graph.faces.forEach((face, g) => {
    if (g === f) return;
    for (const ring of face.rings.slice(1)) {
      const a = -ringSignedArea(graph, ring);
      if (a < bestArea && pointInRing(graph, ring, px, py)) {
        bestArea = a;
        best = g;
      }
    }
  });
  return best;
}

/** Tous les invariants du ticket. */
function checkInvariants(map: LabelMap, graph: BoundaryGraph): void {
  expect(validateGraph(graph)).toEqual([]);
  expect(sideMismatches(map, graph)).toEqual([]);
  expect(graph.faces.length).toBe(map.regions.length);
  // Chaque chaîne : exactement deux références (une par côté), une fois par sens.
  const refs = graph.chains.map(() => [0, 0]);
  for (const face of graph.faces)
    for (const ring of face.rings)
      for (const e of ring.edges) refs[e.chain]![e.reversed ? 1 : 0]!++;
  graph.chains.forEach((ch, c) => {
    expect(refs[c]![0]).toBe(ch.left >= 0 ? 1 : 0);
    expect(refs[c]![1]).toBe(ch.right >= 0 ? 1 : 0);
    // un seul côté non-région → l'autre est la limite image/transparent
    const total = refs[c]![0]! + refs[c]![1]!;
    if (total === 1)
      expect([ch.left, ch.right].some((l) => l === IMAGE_BORDER || l === TRANSPARENT)).toBe(true);
    else expect(total).toBe(2);
  });
  const holes = countHoles(map);
  graph.faces.forEach((face, f) => {
    // Somme des aires signées = aire de la région.
    const sum = face.rings.reduce((s, r) => s + ringSignedArea(graph, r), 0);
    expect(sum).toBe(map.regions[f]!.area);
    // Exactement un extérieur, en tête.
    expect(face.rings.filter((r) => !r.isHole).length).toBe(1);
    expect(face.rings[0]!.isHole).toBe(false);
    // trous = anneaux − 1 = Euler
    expect(face.rings.length - 1).toBe(holes[f]);
    // parent conforme à la géométrie
    expect(face.parent).toBe(bruteParent(map, graph, f));
  });
}

function build(rows: string[]): { map: LabelMap; graph: BoundaryGraph } {
  const map = labelsFromAscii(rows);
  const graph = buildBoundaryGraph(map);
  checkInvariants(map, graph);
  return { map, graph };
}

const vertexAt = (g: BoundaryGraph, x: number, y: number) =>
  g.vertices.find((v) => v.x === x && v.y === y);

describe('buildBoundaryGraph — cas synthétiques', () => {
  it('damier 2×2 : sommet central de degré 4, 4 faces, 0 trou', () => {
    const { graph, map } = build(['AB', 'BA']);
    expect(graph.faces.length).toBe(4);
    expect(vertexAt(graph, 1, 1)?.degree).toBe(4);
    for (const f of graph.faces) {
      expect(f.rings.length).toBe(1);
      expect(f.parent).toBe(-1);
      expect(f.depth).toBe(0);
    }
    expect(Array.from(countHoles(map))).toEqual([0, 0, 0, 0]);
    // Les deux pixels A sont deux faces distinctes, chacune d'aire 1.
    expect(graph.faces.map((f) => ringSignedArea(graph, f.rings[0]!))).toEqual([1, 1, 1, 1]);
  });

  it('damier dans un damier : jamais de liaison par le coin', () => {
    build(['ABAB', 'BABA', 'ABAB', 'BABA']);
    build(['AAAA', 'ABAA', 'AABA', 'AAAA']);
  });

  it('disque dans un fond : 2 faces, 1 chaîne fermée, 1 trou, parent = fond', () => {
    const { graph } = build(['AAAAAA', 'AABBAA', 'ABBBBA', 'AABBAA', 'AAAAAA']);
    expect(graph.faces.length).toBe(2);
    const closed = graph.chains.filter((c) => c.closed);
    expect(closed.length).toBe(1);
    const disk = closed[0]!;
    expect(disk.start).toBe(disk.end);
    // Ancre = coin le plus haut-gauche de l'île, sommet de degré 2.
    const anchor = graph.vertices[disk.start]!;
    expect([anchor.x, anchor.y, anchor.degree]).toEqual([2, 1, 2]);
    // Fond : 1 trou ; disque : parent fond, profondeur 1.
    expect(graph.faces[0]!.rings.length).toBe(2);
    expect(graph.faces[1]!.rings.length).toBe(1);
    expect(graph.faces[1]!.parent).toBe(0);
    expect(graph.faces[1]!.depth).toBe(1);
    expect(graph.faces[0]!.parent).toBe(-1);
    // Le trou du fond est négatif, d'aire = aire du disque.
    expect(ringSignedArea(graph, graph.faces[0]!.rings[1]!)).toBe(-8);
    // Fond touchant le cadre : 4 coins d'image, 4 chaînes de cadre.
    expect(graph.chains.length).toBe(5);
  });

  it('« O » : fond extérieur + anneau + fond intérieur', () => {
    const { graph } = build(['AAAAAAA', 'ABBBBBA', 'ABCCCBA', 'ABCCCBA', 'ABBBBBA', 'AAAAAAA']);
    expect(graph.faces.length).toBe(3);
    const [outer, ring, inner] = graph.faces;
    expect(outer!.parent).toBe(-1);
    expect(ring!.parent).toBe(0);
    expect(ring!.depth).toBe(1);
    expect(ring!.rings.length).toBe(2);
    expect(inner!.parent).toBe(1);
    expect(inner!.depth).toBe(2);
    expect(inner!.rings.length).toBe(1);
  });

  it('deux régions côte à côte touchant le bord : sommets de degré 3 au bord', () => {
    const { graph } = build(['AABBB', 'AABBB', 'AABBB']);
    expect(vertexAt(graph, 2, 0)?.degree).toBe(3);
    expect(vertexAt(graph, 2, 3)?.degree).toBe(3);
    for (const [x, y] of [
      [0, 0],
      [5, 0],
      [0, 3],
      [5, 3],
    ] as const)
      expect(vertexAt(graph, x, y)?.degree).toBe(2);
    const shared = graph.chains.filter((c) => c.left >= 0 && c.right >= 0);
    expect(shared.length).toBe(1);
    expect(graph.faces.every((f) => f.parent === -1 && f.rings.length === 1)).toBe(true);
  });

  it('trois régions en Y : un sommet de degré 3', () => {
    const { graph } = build(['AAAABBBB', 'AAAABBBB', 'CCCCCCCC', 'CCCCCCCC']);
    const interior = graph.vertices.filter(
      (v) => v.x > 0 && v.y > 0 && v.x < graph.width && v.y < graph.height,
    );
    expect(interior.length).toBe(1);
    expect([interior[0]!.x, interior[0]!.y, interior[0]!.degree]).toEqual([4, 2, 3]);
    // Trois chaînes internes, chacune entre deux régions.
    expect(graph.chains.filter((c) => c.left >= 0 && c.right >= 0).length).toBe(3);
  });

  it('région touchant TRANSPARENT : la limite transparent/cadre ne porte aucun tracé', () => {
    const { graph } = build(['..AA', '..AA', '....']);
    expect(graph.faces.length).toBe(1);
    expect(graph.faces[0]!.parent).toBe(-1);
    const sides = graph.chains.map((c) => [c.left, c.right].sort((a, b) => a - b).join(','));
    expect(sides.every((s) => s === `${IMAGE_BORDER},0` || s === `${TRANSPARENT},0`)).toBe(true);
    // Le passage cadre → transparent est un sommet (labels left/right constants).
    expect(vertexAt(graph, 2, 0)?.degree).toBe(2);
    expect(vertexAt(graph, 4, 2)?.degree).toBe(2);
  });

  it('région dans un trou transparent : parent = la région qui entoure le transparent', () => {
    const { graph } = build(['AAAAAAA', 'A.....A', 'A.BBB.A', 'A.....A', 'AAAAAAA']);
    expect(graph.faces[1]!.parent).toBe(0);
    expect(graph.faces[1]!.depth).toBe(1);
    expect(graph.faces[0]!.rings.length).toBe(2);
  });

  it('disque posé sur deux fonds côte à côte : sœur des deux fonds', () => {
    const { graph, map } = build([
      'CCCCCCCCCC',
      'CAAAABBBBC',
      'CAAADDBBBC',
      'CAAADDBBBC',
      'CAAAABBBBC',
      'CCCCCCCCCC',
    ]);
    const id = (ch: string) => map.labels[[...'CAAAABBBBC'].indexOf(ch) + 10]!;
    const D = map.labels[2 * 10 + 4]!;
    expect(graph.faces[id('A')]!.parent).toBe(id('C'));
    expect(graph.faces[id('B')]!.parent).toBe(id('C'));
    expect(graph.faces[D]!.parent).toBe(id('C'));
    expect(graph.faces[D]!.depth).toBe(1);
  });

  it('anneau pincé en diagonale : le coin ne ferme pas la boucle', () => {
    // B est 4-entouré de A, mais touche C en diagonale au coin (4,3) où A est pincé.
    const { graph, map } = build(['AAAAA.', 'ABBBA.', 'ABBBA.', 'AAAAC.', '......']);
    const holes = countHoles(map);
    expect(holes[0]).toBe(0);
    expect(graph.faces[0]!.rings.length).toBe(1);
    expect(vertexAt(graph, 4, 3)?.degree).toBe(4);
    // B n'est pas dans un trou de A : sœur de A.
    expect(graph.faces[1]!.parent).toBe(-1);
    // Le contour de B est une boucle qui part et revient au sommet de jonction :
    // start === end mais closed === false (ancre figée pour l'ajustement).
    const loop = graph.chains.filter((c) => c.left === 1 || c.right === 1);
    expect(loop.length).toBe(1);
    expect(loop[0]!.start).toBe(loop[0]!.end);
    expect(loop[0]!.closed).toBe(false);
  });

  it('progression monotone et annulation', () => {
    const map = labelsFromAscii(['AAB', 'ACB', 'CCB']);
    const ev: ProgressEvent[] = [];
    buildBoundaryGraph(map, { onProgress: (e) => ev.push(e) });
    expect(ev.every((e) => e.stage === 'topology')).toBe(true);
    for (let i = 1; i < ev.length; i++)
      expect(ev[i]!.progress).toBeGreaterThanOrEqual(ev[i - 1]!.progress);
    expect(ev[ev.length - 1]!.stageProgress).toBe(1);
    expect(() => buildBoundaryGraph(map, { cancel: { cancelled: true } })).toThrow(CancelledError);
  });
});

describe('buildBoundaryGraph — invariants sur cartes aléatoires seedées', () => {
  const cases: [string, Parameters<typeof randomQuant>[4]][] = [
    ['bruit pur', {}],
    ['Voronoï + bruit', { seeds: 30, noise: 0.08 }],
    ['bruit + transparent', { transparent: 0.25 }],
    ['Voronoï + transparent', { seeds: 25, noise: 0.05, transparent: 0.2 }],
  ];
  for (const [name, opts] of cases) {
    for (const seed of [1, 2, 3]) {
      it(`64×64 à 6 labels — ${name} (graine ${seed})`, () => {
        const q = randomQuant(64, 64, 6, seed, opts);
        const map = segment(q, 64, 64, { minRegionArea: 1, connectivity: 4 });
        const graph = buildBoundaryGraph(map);
        checkInvariants(map, graph);
        // Avec absorption aussi.
        const map2 = segment(q, 64, 64, { minRegionArea: 5, connectivity: 4 });
        checkInvariants(map2, buildBoundaryGraph(map2));
      });
    }
  }
});

describe('performance', () => {
  it('segment + buildBoundaryGraph sur 1000×1000 à 16 labels bruités en < 1,5 s', () => {
    const W = 1000;
    const H = 1000;
    const q = randomQuant(W, H, 16, 2026, { seeds: 60, noise: 0.1 });
    const t0 = performance.now();
    const map = segment(q, W, H, { minRegionArea: 8, connectivity: 4 });
    const graph = buildBoundaryGraph(map);
    const dt = performance.now() - t0;
    expect(graph.faces.length).toBe(map.regions.length);
    expect(dt).toBeLessThan(1500);
    expect(validateGraph(graph)).toEqual([]);
  }, 30_000);
});
