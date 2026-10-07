import { describe, expect, it } from 'vitest';
import { exportSvg, RECT_NODES, RingAssemblyError, hexColor } from '../src/engine/svg/index.ts';
import { countNodes, parsePathData, samplePath } from '../src/engine/svg/parse.ts';
import { wellFormedErrors } from '../src/engine/svg/wellformed.ts';
import type { ExportOptions, FittedChain, ProgressEvent } from '../src/engine/types.ts';
import { CancelledError } from '../src/engine/types.ts';
import { quantFromAscii, randomQuant } from './label-helpers.ts';
import {
  expectedColors,
  renderCenters,
  sceneFromAscii,
  sceneFromQuant,
  svgElements,
  type Scene,
} from './svg-helpers.ts';

const BASE: ExportOptions = {
  mode: 'cut',
  precision: 2,
  mergeByColor: true,
  backgroundRect: false,
};
const ALL_OPTIONS: ExportOptions[] = [];
for (const mode of ['cut', 'stacked'] as const)
  for (const mergeByColor of [false, true])
    for (const backgroundRect of [false, true])
      ALL_OPTIONS.push({ mode, precision: 2, mergeByColor, backgroundRect });

function run(scene: Scene, options: Partial<ExportOptions> = {}, scale = 1) {
  return exportSvg(
    scene.graph,
    scene.fitted,
    scene.palette,
    { width: scene.map.width / scale, height: scene.map.height / scale, scale },
    { ...BASE, ...options },
  );
}

/** Le rendu au centre des pixels redonne exactement la carte de couleurs source. */
function expectFaithful(scene: Scene, options: Partial<ExportOptions>, scale = 1): void {
  const { svg } = run(scene, options, scale);
  expect(wellFormedErrors(svg)).toEqual([]);
  expect(renderCenters(svg, scene.map.width, scene.map.height, scale)).toEqual(
    expectedColors(scene),
  );
}

const O_ROWS = ['AAAAAAAAA', 'ABBBBBBBA', 'ABBAAABBA', 'ABBAAABBA', 'ABBBBBBBA', 'AAAAAAAAA'];

// Anneau mince (B, aire 24) contenant un disque plus grand que lui (C, aire 25).
const THIN_RING = [
  'AAAAAAAAA',
  'ABBBBBBBA',
  'ABCCCCCBA',
  'ABCCCCCBA',
  'ABCCCCCBA',
  'ABCCCCCBA',
  'ABCCCCCBA',
  'ABBBBBBBA',
  'AAAAAAAAA',
];

describe('exportSvg — arêtes partagées', () => {
  it('deux régions adjacentes : mêmes coordonnées exactes sur la frontière commune, en sens inverse', () => {
    const scene = sceneFromAscii(['AAAB', 'AABB', 'ABBB', 'ABBB'], false, 3);
    const { svg } = run(scene, { mergeByColor: false, precision: 0 });
    const els = svgElements(svg);
    expect(els).toHaveLength(2);
    const polys = els.map((e) => {
      const [sp] = parsePathData(e.d);
      return [sp!.start, ...sp!.segments.map((s) => [s.x, s.y])].map((p) => p.join(','));
    });
    const shared = scene.graph.chains.find((c) => c.left >= 0 && c.right >= 0)!;
    const pts: string[] = [];
    for (let i = 0; i < shared.points.length; i += 2)
      pts.push(`${shared.points[i]},${shared.points[i + 1]}`);
    const containsRun = (cyc: string[], run: string[]): boolean => {
      const n = cyc.length;
      for (let s = 0; s < n; s++) if (run.every((p, k) => cyc[(s + k) % n] === p)) return true;
      return false;
    };
    const fwd = polys.filter((p) => containsRun(p, pts));
    const back = polys.filter((p) => containsRun(p, [...pts].reverse()));
    expect(fwd).toHaveLength(1);
    expect(back).toHaveLength(1);
    expect(fwd[0]).not.toBe(back[0]);
  });

  it('une cubique partagée est écrite avec les mêmes points de contrôle des deux côtés', () => {
    const scene = sceneFromAscii(['AABB', 'AABB'], true);
    const shared = scene.graph.chains.find((c) => c.left >= 0 && c.right >= 0)!;
    const p = shared.points;
    const [x0, y0, x1, y1] = [p[0]!, p[1]!, p[p.length - 2]!, p[p.length - 1]!];
    const curved: FittedChain = {
      chain: shared.id,
      start: [x0, y0],
      segments: [
        { kind: 'cubic', c1x: x0 + 0.4, c1y: y0 + 0.5, c2x: x1 - 0.3, c2y: y1 - 0.7, x: x1, y: y1 },
      ],
    };
    const fitted = scene.fitted.map((f) => (f.chain === shared.id ? curved : f));
    const { svg } = exportSvg(
      scene.graph,
      fitted,
      scene.palette,
      { width: 4, height: 2, scale: 1 },
      { ...BASE, mergeByColor: false },
    );
    const cubics = svgElements(svg).map((e) => {
      const c = parsePathData(e.d)[0]!.segments.find((s) => s.kind === 'cubic');
      expect(c).toBeDefined();
      return c!;
    });
    const [a, b] = cubics as Extract<(typeof cubics)[number], { kind: 'cubic' }>[];
    // b est a parcourue à l'envers : contrôles échangés, mêmes valeurs.
    expect([b!.c1x, b!.c1y, b!.c2x, b!.c2y]).toEqual([a!.c2x, a!.c2y, a!.c1x, a!.c1y]);
  });
});

describe('exportSvg — mode cut', () => {
  it('« O » fusionné par couleur : 2 paths, evenodd, fond = extérieur + trou + île', () => {
    const scene = sceneFromAscii(O_ROWS, true);
    expect(scene.graph.faces).toHaveLength(3);
    // Contrat : Face.colorId recopie Region.colorId (l'export ne reçoit pas la LabelMap).
    expect(scene.graph.faces.map((f) => f.colorId)).toEqual(
      scene.map.regions.map((r) => r.colorId),
    );
    const { svg, stats } = run(scene);
    expect(svg).toContain('fill-rule="evenodd"');
    const els = svgElements(svg);
    expect(els).toHaveLength(2);
    const sub = els.map((e) => parsePathData(e.d).length);
    // Couleur A (id 0) d'abord : extérieur du fond, son trou, île intérieure ; puis l'anneau.
    expect(sub).toEqual([3, 2]);
    expect(stats.paths).toBe(2);
    expect(stats.colors).toBe(2);
    expect(stats.regions).toBe(3);
    expectFaithful(scene, {});
  });

  it('« O » sans fusion : 3 paths, un par région', () => {
    const scene = sceneFromAscii(O_ROWS, true);
    const { svg, stats } = run(scene, { mergeByColor: false });
    const els = svgElements(svg);
    expect(els).toHaveLength(3);
    // Ordre : colorId, puis aire décroissante (fond extérieur avant l'île).
    expect(els.map((e) => parsePathData(e.d).length)).toEqual([2, 1, 2]);
    expect(els[0]!.fill).toBe(els[1]!.fill);
    expect(stats.paths).toBe(3);
    expectFaithful(scene, { mergeByColor: false });
  });
});

describe('exportSvg — mode stacked', () => {
  it("un anneau mince est peint AVANT le disque plus grand qu'il contient ; trous omis", () => {
    const scene = sceneFromAscii(THIN_RING, true);
    const { map, graph } = scene;
    const area = (l: number): number => map.regions[l]!.area;
    const ring = map.labels[1 * 9 + 1]!;
    const disk = map.labels[4 * 9 + 4]!;
    expect(area(disk)).toBeGreaterThan(area(ring));
    expect(graph.faces[disk]!.depth).toBeGreaterThan(graph.faces[ring]!.depth);
    const { svg } = run(scene, { mode: 'stacked', mergeByColor: false });
    expect(svg).not.toContain('evenodd');
    const els = svgElements(svg);
    expect(els).toHaveLength(3);
    for (const e of els) expect(parsePathData(e.d)).toHaveLength(1);
    const hex = (l: number): string => hexColor(scene.palette.colors[map.regions[l]!.colorId]!.rgb);
    const order = els.map((e) => e.fill);
    expect(order.indexOf(hex(ring))).toBeLessThan(order.indexOf(hex(disk)));
    expectFaithful(scene, { mode: 'stacked', mergeByColor: false });
  });

  it('la fusion ne regroupe que des faces consécutives dans l’ordre de peinture', () => {
    // A (racine) ⊃ B ⊃ A' : A et A' ne doivent PAS être fusionnés (B les sépare).
    const scene = sceneFromAscii(O_ROWS, true);
    const { svg } = run(scene, { mode: 'stacked', mergeByColor: true });
    const els = svgElements(svg);
    expect(els.map((e) => e.fill)).toEqual(['#fff', '#f00', '#fff']);
    expectFaithful(scene, { mode: 'stacked', mergeByColor: true });
  });

  it('un trou transparent est conservé (sinon la face parente le peindrait)', () => {
    const scene = sceneFromAscii(['AAAAA', 'A...A', 'A.B.A', 'A...A', 'AAAAA'], true);
    const { svg } = run(scene, { mode: 'stacked', mergeByColor: false });
    const els = svgElements(svg);
    expect(els.map((e) => parsePathData(e.d).length)).toEqual([2, 1]);
    expectFaithful(scene, { mode: 'stacked', mergeByColor: false });
  });

  it('du transparent enfermé par plusieurs enfants est détecté dans le trou parent', () => {
    // Le transparent central ne touche que B et C, eux-mêmes dans un trou de A.
    const scene = sceneFromAscii(['AAAAAAA', 'ABBBBBA', 'ABB.CCA', 'ABCCCCA', 'AAAAAAA'], true);
    expectFaithful(scene, { mode: 'stacked', mergeByColor: false });
    expectFaithful(scene, { mode: 'stacked', mergeByColor: true });
  });
});

describe('exportSvg — transparence et fond', () => {
  it("rien n'est émis pour le transparent", () => {
    const scene = sceneFromAscii(['..AA..', '.AAAA.', '..AA..'], true);
    const { svg, stats } = run(scene);
    expect(svgElements(svg)).toHaveLength(1);
    expect(stats.colors).toBe(1);
    expectFaithful(scene, {});
    const empty = sceneFromAscii(['...', '...']);
    const out = run(empty, { backgroundRect: true });
    expect(out.stats.paths).toBe(0);
    expect(wellFormedErrors(out.svg)).toEqual([]);
  });

  it('backgroundRect : rect présent, rendu identique, moins de nœuds', () => {
    for (const mode of ['cut', 'stacked'] as const) {
      const scene = sceneFromAscii(O_ROWS, true);
      const without = run(scene, { mode, mergeByColor: false });
      const withRect = run(scene, { mode, mergeByColor: false, backgroundRect: true });
      const els = svgElements(withRect.svg);
      expect(els[0]).toEqual({ tag: 'rect', fill: '#fff', d: '' });
      expect(withRect.svg).toContain('<rect width="100%" height="100%" fill="#fff"/>');
      // Le cadre du fond (4 nœuds) devient un rect (compté 4) : jamais plus de nœuds.
      expect(withRect.stats.nodes).toBeLessThanOrEqual(without.stats.nodes);
      expect(renderCenters(withRect.svg, 9, 6)).toEqual(renderCenters(without.svg, 9, 6));
      // Nœuds restants = nœuds des paths + 4 pour le rect.
      const pathNodes = els
        .filter((e) => e.tag === 'path')
        .reduce((s, e) => s + countNodes(parsePathData(e.d)), 0);
      expect(withRect.stats.nodes).toBe(pathNodes + RECT_NODES);
    }
  });

  it('backgroundRect : à aire égale, la couleur de plus petit id gagne, quel que soit l’ordre des faces (#18)', () => {
    // B a l'id 0 dans les deux cas ; sa face est la première ou la seconde.
    for (const rows of [
      ['AAABBB', 'AAABBB'],
      ['BBBAAA', 'BBBAAA'],
    ]) {
      const { q, width, height } = quantFromAscii(rows, { B: [0.2, 0, 0], A: [0.8, 0, 0] });
      const scene = sceneFromQuant(q, width, height);
      expect(scene.graph.faces.map((f) => f.colorId)).toEqual(
        rows[0]![0] === 'A' ? [1, 0] : [0, 1],
      );
      for (const mode of ['cut', 'stacked'] as const) {
        const els = svgElements(run(scene, { mode, backgroundRect: true }).svg);
        expect(els[0]).toEqual({ tag: 'rect', fill: '#fff', d: '' }); // couleur 0
        expect(els.slice(1).map((e) => e.fill)).toEqual(['#f00']);
      }
    }
  });

  it('backgroundRect est ignoré dès que l’image contient du transparent', () => {
    const scene = sceneFromAscii(['AAA.', 'ABAA', 'AAAA'], true);
    const { svg } = run(scene, { backgroundRect: true });
    expect(svg).not.toContain('<rect');
  });
});

describe('exportSvg — sérialisation', () => {
  it('précision 0, 1, 2 respectée ; scale 2 divise ; viewBox d’origine', () => {
    const scene = sceneFromAscii(['AAAA', 'ABBA', 'ABBA', 'AAAA'], false, 2);
    // Île B : cubiques à coordonnées fractionnaires.
    const island = scene.graph.chains.find((c) => c.closed)!;
    const [sx, sy] = [island.points[0]!, island.points[1]!];
    const curvy: FittedChain = {
      chain: island.id,
      start: [sx, sy],
      segments: [
        {
          kind: 'cubic',
          c1x: sx + 1.23456,
          c1y: sy - 0.1,
          c2x: sx + 3.3333,
          c2y: sy,
          x: sx + 4,
          y: sy,
        },
        { kind: 'line', x: sx + 4, y: sy + 4 },
        {
          kind: 'cubic',
          c1x: sx + 2.71828,
          c1y: sy + 4.5,
          c2x: sx + 1,
          c2y: sy + 4.25,
          x: sx,
          y: sy + 4,
        },
        { kind: 'line', x: sx, y: sy },
      ],
    };
    // Sens de l'île : celui de la chaîne (vérifié par le raccord).
    const fitted = scene.fitted.map((f) => (f.chain === island.id ? curvy : f));
    for (const precision of [0, 1, 2]) {
      const { svg } = exportSvg(
        scene.graph,
        fitted,
        scene.palette,
        { width: 4, height: 4, scale: 2 },
        { ...BASE, precision },
      );
      expect(svg).toContain('viewBox="0 0 4 4"');
      expect(svg).toContain('width="4" height="4"');
      for (const e of svgElements(svg)) {
        for (const n of e.d.match(/-?\d*\.?\d+/g)!) {
          const dec = n.includes('.') ? n.split('.')[1]!.length : 0;
          expect(dec).toBeLessThanOrEqual(precision);
        }
        // Toutes les coordonnées (après /2) dans le cadre d'origine (marge des contrôles).
        for (const sp of parsePathData(e.d))
          for (const s of sp.segments) {
            expect(s.x).toBeGreaterThanOrEqual(0);
            expect(s.x).toBeLessThanOrEqual(4);
          }
      }
      // Île B (départ treillis (2, 2) → (1, 1)) : c1x = (2 + 1.23456) / 2 = 1.61728.
      const b = svgElements(svg).find((e) => e.fill === '#f00')!;
      const ctrl = parsePathData(b.d)[0]!.segments.flatMap((s) =>
        s.kind === 'cubic' ? [s.c1x, s.c2x] : [],
      );
      expect(ctrl).toContain([2, 1.6, 1.62][precision]);
    }
  });

  it('bytes = longueur UTF-8 ; nodes = comptage du parseur', () => {
    const scene = sceneFromQuant(randomQuant(30, 24, 5, 7, { seeds: 14, noise: 0.03 }), 30, 24);
    for (const options of ALL_OPTIONS) {
      const { svg, stats } = run(scene, options);
      expect(stats.bytes).toBe(Buffer.byteLength(svg, 'utf8'));
      const els = svgElements(svg);
      expect(stats.paths).toBe(els.length);
      const nodes = els.reduce(
        (s, e) => s + (e.tag === 'rect' ? RECT_NODES : countNodes(parsePathData(e.d))),
        0,
      );
      expect(stats.nodes).toBe(nodes);
      expect(stats.regions).toBe(scene.graph.faces.length);
      expect(stats.colors).toBe(new Set(els.map((e) => e.fill)).size);
    }
  });

  it('aller-retour : le d relu redonne les points de treillis (/scale)', () => {
    const scene = sceneFromAscii(['AAAB', 'ACAB', 'AABB'], false, 2);
    const { svg } = run(scene, { mergeByColor: false, precision: 1 }, 2);
    const lattice = new Set<string>();
    for (const c of scene.graph.chains)
      for (let i = 0; i < c.points.length; i += 2)
        lattice.add(`${c.points[i]! / 2},${c.points[i + 1]! / 2}`);
    for (const e of svgElements(svg))
      for (const poly of samplePath(parsePathData(e.d)))
        for (let i = 0; i < poly.length; i += 2)
          expect(lattice.has(`${poly[i]},${poly[i + 1]}`)).toBe(true);
    expectFaithful(scene, { mergeByColor: false, precision: 1 }, 2);
  });

  it('SVG bien formé, sans métadonnée ni commentaire', () => {
    const scene = sceneFromAscii(O_ROWS, true);
    const { svg } = run(scene);
    expect(wellFormedErrors(svg)).toEqual([]);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="6"')).toBe(
      true,
    );
    expect(svg).not.toMatch(/<!--|<metadata|<\?xml|shape-rendering/);
  });
});

describe('exportSvg — fidélité topologique (rendu au centre des pixels)', () => {
  it('cartes aléatoires avec transparence, toutes options', () => {
    for (const seed of [1, 2, 3, 4]) {
      const q = randomQuant(28, 20, 4, seed, { seeds: 18, noise: 0.05, transparent: 0.2 });
      const scene = sceneFromQuant(q, 28, 20, seed % 2 === 0);
      for (const options of ALL_OPTIONS) expectFaithful(scene, options);
    }
  });

  it('cartes aléatoires opaques (fond rect effectif), toutes options', () => {
    for (const seed of [5, 6, 7]) {
      const q = randomQuant(24, 24, 3, seed, { seeds: 10, noise: 0.08 });
      const scene = sceneFromQuant(q, 24, 24, true);
      for (const options of ALL_OPTIONS) expectFaithful(scene, options);
      expect(run(scene, { backgroundRect: true }).svg).toContain('<rect');
    }
  });
});

describe('exportSvg — erreurs et contexte', () => {
  it('une chaîne mal raccordée lève RingAssemblyError', () => {
    const scene = sceneFromAscii(['AABB', 'AABB'], true);
    const shared = scene.graph.chains.find((c) => c.left >= 0 && c.right >= 0)!;
    const broken = scene.fitted.map((f) =>
      f.chain === shared.id
        ? { ...f, segments: f.segments.map((s) => ({ ...s, x: s.x + 0.5 })) }
        : f,
    );
    expect(() =>
      exportSvg(scene.graph, broken, scene.palette, { width: 4, height: 2, scale: 1 }, BASE),
    ).toThrow(RingAssemblyError);
    const missing = scene.fitted.filter((f) => f.chain !== shared.id);
    expect(() =>
      exportSvg(scene.graph, missing, scene.palette, { width: 4, height: 2, scale: 1 }, BASE),
    ).toThrow(/absente/);
  });

  it('progression et annulation', () => {
    const scene = sceneFromAscii(O_ROWS, true);
    const events: ProgressEvent[] = [];
    exportSvg(scene.graph, scene.fitted, scene.palette, { width: 9, height: 6, scale: 1 }, BASE, {
      onProgress: (e) => events.push(e),
    });
    expect(events.every((e) => e.stage === 'export')).toBe(true);
    expect(events[events.length - 1]!.stageProgress).toBe(1);
    expect(() =>
      exportSvg(scene.graph, scene.fitted, scene.palette, { width: 9, height: 6, scale: 1 }, BASE, {
        cancel: { cancelled: true },
      }),
    ).toThrow(CancelledError);
  });
});

describe('exportSvg — trait anti-liseré (T08)', () => {
  const strokeOf = (svg: string) =>
    [...svg.matchAll(/<path\b([^>]*)\/>/g)].map((m) => ({
      fill: /\sfill="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
      stroke: /\sstroke="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
      opacity: /\sfill-opacity="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
      d: /\sd="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
    }));
  const xs = (d: string): number[] =>
    samplePath(parsePathData(d), 4).flatMap((p) => Array.from(p).filter((_, i) => i % 2 === 0));

  it('absent ou 0 : aucun trait', () => {
    const scene = sceneFromAscii(['AAABBB', 'AAABBB']);
    expect(run(scene).svg).not.toContain('stroke');
    expect(run(scene, { seamStroke: 0 }).svg).not.toContain('stroke');
  });

  it('face peinte avant toutes ses voisines : le tracé porte le trait, aucun nœud de plus', () => {
    const scene = sceneFromAscii(['AAABBB', 'AAABBB', 'AAABBB']);
    const plain = run(scene);
    const out = run(scene, { seamStroke: 1 });
    const els = strokeOf(out.svg);
    expect(els.map((e) => [e.fill, e.stroke])).toEqual([
      ['#fff', '#fff'], // A (couleur 0) peinte d'abord : trait sous B
      ['#f00', ''], // B peinte en dernier : rien
    ]);
    expect(out.stats.nodes).toBe(plain.stats.nodes);
    expectFaithful(scene, { seamStroke: 1 });
  });

  it('voisine peinte avant ou transparence : trait seulement sur la frontière avec la suivante', () => {
    for (const rows of [
      ['AAABBBCCC', 'AAABBBCCC'],
      ['...BBBCCC', '...BBBCCC'],
    ]) {
      const scene = sceneFromAscii(rows);
      const out = run(scene, { seamStroke: 1 });
      // Trait à 3 px du transparent : hors d'atteinte, aucun masque F1 (#18).
      expect(out.svg).not.toContain('<mask');
      const b = strokeOf(out.svg).filter((e) => e.fill === 'none');
      expect(b).toHaveLength(1);
      expect(b[0]!.stroke).toBe(rows[0]!.startsWith('.') ? '#fff' : '#f00');
      // B | C seulement (x = 6), jamais B | A ni B | transparent (x = 3).
      expect(new Set(xs(b[0]!.d))).toEqual(new Set([6]));
      expect(wellFormedErrors(out.svg)).toEqual([]);
      expectFaithful(scene, { seamStroke: 1 });
    }
  });

  it('couleur translucide : fill-opacity, aucun trait dessous ni dessus, aucun fond', () => {
    const scene = sceneFromAscii(['AAABBB', 'AAABBB']);
    scene.palette.colors[1]!.alpha = 153;
    const out = run(scene, { seamStroke: 1, backgroundRect: true });
    expect(out.svg).not.toContain('<rect');
    expect(out.svg).not.toContain('stroke');
    expect(strokeOf(out.svg).map((e) => e.opacity)).toEqual(['', '.6']);
  });
});
