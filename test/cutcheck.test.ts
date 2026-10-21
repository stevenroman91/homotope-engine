import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyzeCut,
  buildNetwork,
  checkSvg,
  cutGeometry,
  DEFAULT_TOOL_MM,
  DEFAULT_WORK_BUDGET,
  MAX_LISTED_PER_KIND,
  mergedPolylines,
  simplifySvg,
  type CutReport,
} from '../src/engine/cutcheck/index.ts';
import { convertSvg, sceneFromSvg } from '../src/engine/export/index.ts';
import { flattenSubpath, MM_PER_PX } from '../src/engine/export/polyline.ts';
import { decodeJpeg, decodePng } from '../src/engine/image/codec-node.ts';
import { simplifyGeometry } from '../src/engine/cutcheck/simplify.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type { ParsedSubpath } from '../src/engine/svg/parse.ts';
import type { PresetName } from '../src/engine/types.ts';

/**
 * T35 — Contrôle « prêt pour la découpe » sur des scènes synthétiques (SVG écrits à la main,
 * relus par `sceneFromSvg` comme ceux du moteur) et sur les fixtures. Échelle des cas
 * synthétiques : 1 px = 0,1 mm (outil de 0,2 mm = 2 px).
 */
const MM = 0.1;
const svg = (body: string, w = 100, h = 100): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill-rule="evenodd">${body}</svg>`;
const check = (body: string, o: Parameters<typeof checkSvg>[1] = {}): CutReport =>
  checkSvg(svg(body), { mmPerPx: MM, ...o });
const issuesOf = (r: CutReport, kind: string) => r.issues.filter((i) => i.kind === kind);
const sumTotals = (r: CutReport): number => Object.values(r.totals).reduce((a, b) => a + b, 0);

/** Haltère : deux blocs de 20 px reliés par un passage de largeur `w` px (x de 20 à 60). */
const dumbbell = (w: number): string =>
  `<path fill="#000" d="M0 0H20V${10 - w / 2}H60V0H80V20H60V${10 + w / 2}H20V20H0Z"/>`;

/** Polylignes d'un DXF R12 : [couche, fermée, points en mm]. */
function dxfPolylines(dxf: string): { layer: string; closed: boolean; pts: number[] }[] {
  const lines = dxf.split('\r\n');
  const out: { layer: string; closed: boolean; pts: number[] }[] = [];
  let cur: { layer: string; closed: boolean; pts: number[] } | null = null;
  for (let k = 0; k + 1 < lines.length; k += 2) {
    const code = lines[k]!.trim();
    const value = lines[k + 1]!;
    if (code === '0' && value === 'POLYLINE') {
      cur = { layer: '', closed: false, pts: [] };
      out.push(cur);
    } else if (code === '0' && value === 'SEQEND') cur = null;
    else if (cur && code === '8' && cur.layer === '') cur.layer = value;
    else if (cur && code === '70') cur.closed = value === '1';
    else if (cur && (code === '10' || code === '20') && !(cur.pts.length === 0 && value === '0'))
      cur.pts.push(Number(value));
  }
  return out;
}

/** Segments non orientés (clé arrondie) d'une liste de polylignes DXF. */
function dxfSegments(polys: { closed: boolean; pts: number[] }[]): string[] {
  const segs: string[] = [];
  const key = (a: number[], b: number[]): string => {
    const [p, q] = [a.map((v) => v.toFixed(3)).join(','), b.map((v) => v.toFixed(3)).join(',')];
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  for (const pl of polys) {
    const n = pl.pts.length / 2;
    const at = (k: number) => [pl.pts[2 * k]!, pl.pts[2 * k + 1]!];
    for (let k = 0; k + 1 < n; k++) segs.push(key(at(k), at(k + 1)));
    if (pl.closed && n > 2) segs.push(key(at(n - 1), at(0)));
  }
  return segs;
}

describe('contrôle de découpe : cas synthétiques', () => {
  it('un carré fermé : aucun problème', () => {
    const r = check('<path fill="#000" d="M10 10H90V90H10Z"/>');
    expect(sumTotals(r)).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.contours).toEqual({ total: 1, closed: 1, open: 0, strokes: 0 });
    expect(r.nodes.total).toBe(4);
    expect(r.nodes.byColor).toEqual([{ color: '000000', nodes: 4, contours: 1 }]);
    expect(r.toolMm).toBe(DEFAULT_TOOL_MM);
  });

  it('un contour ouvert en mode plein : signalé, bloquant, avec l’écart', () => {
    const r = check('<path fill="#000" d="M10 10H90V90H10"/>');
    expect(r.totals.open).toBe(1);
    const [it] = issuesOf(r, 'open');
    expect(it!.severity).toBe('blocking');
    expect(it!.value).toBeCloseTo(8, 6); // 80 px de retour au départ, à 0,1 mm/px
    expect(it!.box).toEqual({ x: 10, y: 10, width: 80, height: 80 });
    expect(it!.message).toMatch(/^Contour ouvert/);
    // Seul le `Z` manque (retour exact au départ) : rien à signaler.
    expect(check('<path fill="#000" d="M10 10H90V90H10V10"/>').totals.open).toBe(0);
  });

  it('deux carrés superposés : double découpe bloquante ; décalés : chevauchement', () => {
    const sq = 'd="M10 10H90V90H10Z"';
    const r = check(`<path fill="#000" ${sq}/><path fill="#f00" ${sq}/>`);
    expect(r.totals.overlap).toBe(1);
    expect(issuesOf(r, 'overlap')[0]!.severity).toBe('blocking');
    expect(issuesOf(r, 'overlap')[0]!.value).toBeCloseTo(32, 6); // 4 × 80 px
    const c = check(
      '<path fill="#000" d="M10 10H60V60H10Z"/><path fill="#f00" d="M30 30H80V80H30Z"/>',
    );
    expect(c.totals.crossing).toBe(1);
    const [x] = issuesOf(c, 'crossing');
    expect(x!.severity).toBe('blocking');
    expect(x!.value).toBe(2);
    expect(x!.box).toEqual({ x: 30, y: 30, width: 30, height: 30 }); // (60,30) et (30,60)
  });

  it('chevauchement partiel colinéaire : nœuds en T, double découpe sur la seule partie commune', () => {
    // Le carré de droite (pixel art : côtés fusionnés) partage x = 50 de y 30 à 70 seulement.
    const r = check(
      '<path fill="#000" d="M10 10H50V90H10Z"/><path fill="#f00" d="M50 30H90V70H50Z"/>',
    );
    const [o] = issuesOf(r, 'overlap');
    expect(r.totals.overlap).toBe(1);
    expect(o!.value).toBeCloseTo(4, 6); // 40 px
    expect(o!.box).toEqual({ x: 50, y: 30, width: 0, height: 40 });
  });

  describe('deux faces adjacentes (mode découpé)', () => {
    const body = '<path fill="#000" d="M10 10H50V90H10Z"/><path fill="#f00" d="M50 10H90V90H50Z"/>';
    it('la frontière commune est une INFORMATION (hors des comptes), avec l’option de fusion', () => {
      const r = check(body);
      expect(r.totals.overlap).toBe(1);
      // Aplat bicolore sans autre défaut : « prêt », avec une information.
      expect([r.blocking, r.check, r.info]).toEqual([0, 0, 1]);
      const [o] = issuesOf(r, 'overlap');
      expect(o!.severity).toBe('info');
      expect(o!.message).toContain('Fusionner les frontières communes');
      expect(o!.value).toBeCloseTo(8, 6);
      expect(check(body, { mergeShared: true }).totals.overlap).toBe(0);
    });
    it('fusionnée, elle n’est coupée qu’UNE fois dans le DXF (et deux fois sans)', () => {
      // Frontière x = 50, de y = 10 à 90 (DXF en mm, Y vers le haut).
      const [shared] = dxfSegments([
        { closed: false, pts: [50, 100 - 10, 50, 100 - 90].map((v) => v * MM_PER_PX) },
      ]);
      const count = (dxf: string) =>
        dxfSegments(dxfPolylines(dxf)).filter((s) => s === shared).length;
      const plain = convertSvg(svg(body), 'dxf');
      const merged = convertSvg(svg(body), 'dxf', { mergeShared: true });
      expect(count(plain)).toBe(2);
      expect(count(merged)).toBe(1);
      // Aucun autre segment perdu ni doublé : 8 côtés, 7 segments distincts.
      const segs = dxfSegments(dxfPolylines(merged));
      expect(segs.length).toBe(7);
      expect(new Set(segs).size).toBe(7);
      // La seconde forme garde sa couche, en polyligne ouverte (sa frontière gauche est déjà écrite).
      const polys = dxfPolylines(merged);
      expect(polys.map((p) => [p.layer, p.closed])).toEqual([
        ['000000', true],
        ['FF0000', false],
      ]);
      // Sans l'option, le DXF de T32 est inchangé à l'octet près.
      expect(convertSvg(svg(body), 'dxf', { mergeShared: false })).toBe(plain);
    });
  });

  it('frontière commune COURBE (cubique parcourue dans les deux sens) : reconnue, fusionnée', () => {
    const body =
      '<path fill="#000" d="M10 10H50C70 40 30 60 50 90H10Z"/>' +
      '<path fill="#f00" d="M50 10H90V90H50C30 60 70 40 50 10Z"/>';
    const r = check(body);
    expect(r.totals.overlap).toBe(1);
    expect(issuesOf(r, 'overlap')[0]!.severity).toBe('info');
    expect(r.totals.crossing).toBe(0);
    const merged = check(body, { mergeShared: true });
    expect(sumTotals(merged)).toBe(0);
    expect(merged.nodes.total).toBeLessThan(r.nodes.total);
  });

  describe('détails trop fins (outil 0,2 mm)', () => {
    it('un passage de 0,1 mm est signalé, un passage de 0,3 mm ne l’est pas', () => {
      const r = check(dumbbell(1));
      expect(r.totals.thin).toBe(1);
      const [t] = issuesOf(r, 'thin');
      expect(t!.severity).toBe('check');
      expect(t!.value).toBeCloseTo(0.1, 6);
      // La boîte couvre tout le passage (x de 20 à 60), pas un seul point.
      expect(t!.box.x).toBeCloseTo(20, 6);
      expect(t!.box.x + t!.box.width).toBeCloseTo(60, 6);
      expect(t!.box.y).toBeCloseTo(9.5, 6);
      expect(t!.box.height).toBeCloseTo(1, 6);
      expect(t!.message).toContain('0,1 mm');
      expect(t!.message).toContain('0,2 mm');
      expect(check(dumbbell(3)).totals.thin).toBe(0);
    });
    it('le diamètre de l’outil et l’échelle comptent', () => {
      expect(check(dumbbell(3), { toolMm: 0.4 }).totals.thin).toBe(1);
      expect(check(dumbbell(1), { toolMm: 0.05 }).totals.thin).toBe(0);
      // Même géométrie, image deux fois plus petite : 3 px = 0,15 mm < 0,2 mm.
      expect(check(dumbbell(3), { mmPerPx: 0.05 }).totals.thin).toBe(1);
      // Exactement le diamètre : la lame passe.
      expect(check(dumbbell(2)).totals.thin).toBe(0);
    });
    it('les coins droits, les jonctions et (T63) les pointes ne sont pas des détails fins', () => {
      // Carré : coins à 90°.
      expect(check('<path fill="#000" d="M10 10H40V40H10Z"/>', { toolMm: 2 }).totals.thin).toBe(0);
      // Trois faces en Y (120°).
      const y =
        '<path fill="#000" d="M50 50L50 0H0V79Z"/><path fill="#0f0" d="M50 50L0 79V100H100V79Z"/>' +
        '<path fill="#00f" d="M50 50L100 79V0H50Z"/>';
      expect(check(y, { toolMm: 2 }).totals.thin).toBe(0);
      // Pointe de ~5° (dent de scie) : T35 la signalait ; T63 : l'outil l'arrondit, ce n'est pas
      // un défaut (une pointe a toujours une largeur qui tend vers zéro à son bout).
      const spike = '<path fill="#000" d="M10 90L50 10L18 90Z"/>';
      expect(check(spike, { toolMm: 0.5 }).totals.thin).toBe(0);
      // Pointe de 60° : non.
      const tri = '<path fill="#000" d="M10 90L50 20.72L90 90Z"/>';
      expect(check(tri, { toolMm: 0.5 }).totals.thin).toBe(0);
    });
    it('deux formes trop proches (bande de matière entre elles) : signalé', () => {
      const r = check(
        '<path fill="#000" d="M10 10H45V90H10Z"/><path fill="#f00" d="M46 10H90V90H46Z"/>',
      );
      expect(r.totals.thin).toBe(1);
      expect(issuesOf(r, 'thin')[0]!.color).toBeUndefined(); // deux couleurs en cause
    });
  });

  describe('petits îlots', () => {
    // Un carré de 5 px (0,25 mm²) dans un trou du grand carré (copie inversée, comme le moteur).
    const body =
      '<path fill="#000" d="M10 10H90V90H10ZM40 40V45H45V40Z"/><path fill="#f00" d="M40 40H45V45H40Z"/>';
    it('un îlot minuscule est signalé une fois (le trou de la face voisine est sa copie)', () => {
      const r = check(body);
      expect(r.totals.island).toBe(1);
      const [i] = issuesOf(r, 'island');
      expect(i!.value).toBeCloseTo(0.25, 6);
      expect(i!.box).toEqual({ x: 40, y: 40, width: 5, height: 5 });
      // Deux copies de couleurs différentes (îlot rouge, trou noir) : aucune couleur imputée.
      expect(i!.color).toBeUndefined();
      expect(check(body, { islandMm2: 0.2 }).totals.island).toBe(0);
    });
    it('puis retiré par la simplification (îlot et trou disparaissent du DXF)', () => {
      const s = simplifySvg(svg(body), { mmPerPx: MM, smoothing: 1 });
      expect(s.before.totals.island).toBe(1);
      expect(s.after.totals.island).toBe(0);
      expect(s.summary.removedIslands).toBe(1);
      expect(s.summary.after.issues).toBe(0);
      expect(s.summary.after.nodes).toBeLessThan(s.summary.before.nodes);
      const polys = dxfPolylines(s.dxf);
      expect(polys).toHaveLength(1);
      expect(polys[0]!.pts).toHaveLength(8);
    });
    it('un îlot qui touche deux faces rejoint la plus grande voisine', () => {
      // Îlot 0,25 mm² posé contre la frontière de deux faces : ses bords avec la face noire
      // (la plus longue frontière commune) disparaissent, celui avec la rouge reste.
      const two =
        '<path fill="#000" d="M10 10H50V90H10ZM46 40V45H50V40Z"/>' +
        '<path fill="#f00" d="M50 10H90V90H50ZM50 40V45H51V40Z"/>' +
        '<path fill="#00f" d="M46 40H51V45H46Z"/>';
      const s = simplifySvg(svg(two), { mmPerPx: MM, smoothing: 0 });
      expect(s.summary.removedIslands).toBeGreaterThanOrEqual(1);
      expect(s.after.totals.island).toBe(0);
      expect(s.after.blocking).toBe(0);
      const segs = dxfSegments(dxfPolylines(s.dxf));
      expect(new Set(segs).size).toBe(segs.length); // chaque segment une fois
    });
  });

  it('centre-ligne : les traits ouverts ne sont pas des erreurs', () => {
    const r = check(
      '<path fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" d="M10 10L90 10M10 50C30 20 60 80 90 50"/>' +
        '<path fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" d="M10 80H90M50 60V95"/>',
    );
    expect(r.contours).toEqual({ total: 4, closed: 0, open: 4, strokes: 4 });
    expect(sumTotals(r)).toBe(0); // ouverts, et les traits qui se croisent : un dessin
    // Le même tracé en remplissage, sans `Z` : signalé.
    expect(check('<path fill="#000" d="M10 10L90 10L50 60"/>').totals.open).toBe(1);
  });

  it('centre-ligne : deux traits trop proches, un message de double passage', () => {
    const strokes =
      '<path fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" d="M10 10H90"/>' +
      '<path fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" d="M10 11H90"/>';
    const [t] = issuesOf(check(strokes), 'thin');
    expect(t!.message).toMatch(/^Trait retracé à 0,1 mm d’un autre.*double passage/);
    const [f] = issuesOf(check(dumbbell(1)), 'thin');
    expect(f!.message).toMatch(/brûlé ou arraché/);
  });

  it('un contour en 8 : auto-intersection (et pas d’îlot d’aire nulle)', () => {
    const r = check('<path fill="#000" d="M10 10L50 50L10 50L50 10Z"/>');
    expect(r.totals['self-intersection']).toBe(1);
    const [s] = issuesOf(r, 'self-intersection');
    expect(s!.severity).toBe('blocking');
    expect(s!.box).toEqual({ x: 30, y: 30, width: 0, height: 0 });
    expect(r.totals.island).toBe(0);
    expect(r.totals.crossing).toBe(0);
  });

  it('nombre de nœuds : par contour, par couleur, seuil', () => {
    const k = 0.5523 * 40;
    const circle = `M90 50C90 ${50 + k} ${50 + k} 90 50 90C${50 - k} 90 10 ${50 + k} 10 50C10 ${50 - k} ${50 - k} 10 50 10C${50 + k} 10 90 ${50 - k} 90 50Z`;
    const body = `<path fill="#000" d="${circle}"/>`;
    const r = check(body, { maxNodes: 20 });
    expect(r.nodes.total).toBeGreaterThan(20);
    expect(r.totals.nodes).toBe(1);
    expect(issuesOf(r, 'nodes')[0]!.value).toBe(r.nodes.total);
    expect(check(body, { maxNodes: 10_000 }).totals.nodes).toBe(0);
  });

  it('bloquants d’abord ; liste plafonnée par type, totaux exacts', () => {
    let squares = '';
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) squares += `M${i * 8} ${j * 8}h1v1h-1Z`;
    const r = check(
      `<path fill="#000" d="${squares}"/><path fill="#000" d="M150 150L155 155L150 155L155 150Z"/>`,
      {},
    );
    expect(r.totals.island).toBe(144);
    expect(issuesOf(r, 'island')).toHaveLength(MAX_LISTED_PER_KIND);
    expect(r.issues[0]!.kind).toBe('self-intersection');
    expect(r.blocking).toBe(1);
    expect(r.check).toBe(144);
  });

  it('paramètres bornés (NaN, hors plage)', () => {
    const r = check('<path fill="#000" d="M10 10H90V90H10Z"/>', {
      toolMm: Number.NaN,
      islandMm2: -5,
      maxNodes: 1e12,
    });
    expect(r.toolMm).toBe(DEFAULT_TOOL_MM);
    expect(r.islandMm2).toBe(0);
    expect(r.maxNodes).toBe(1_000_000);
    expect(r.mmPerPx).toBe(MM);
  });
});

describe('géométrie de découpe', () => {
  it('une cubique et sa copie inversée donnent les mêmes points au bit près (aplatissement canonique)', () => {
    const fwd: ParsedSubpath = {
      start: [1.1, 2.3],
      segments: [{ kind: 'cubic', c1x: 40.7, c1y: -3.3, c2x: 77.1, c2y: 91.9, x: 13.3, y: 60.1 }],
      closed: false,
    };
    const rev: ParsedSubpath = {
      start: [13.3, 60.1],
      segments: [{ kind: 'cubic', c1x: 77.1, c1y: 91.9, c2x: 40.7, c2y: -3.3, x: 1.1, y: 2.3 }],
      closed: false,
    };
    const a = flattenSubpath(fwd, 0.01, true);
    const b = flattenSubpath(rev, 0.01, true);
    expect(a.length).toBeGreaterThan(20);
    const back: number[] = [];
    for (let k = b.length - 2; k >= 0; k -= 2) back.push(b[k]!, b[k + 1]!);
    expect(Array.from(a)).toEqual(back);
    // Sans l'option : le calcul de T32 (sens du tracé), inchangé.
    expect(Array.from(flattenSubpath(fwd, 0.01))).toEqual(Array.from(a));
  });

  it('chemins relatifs : les sommets d’une frontière commune sont identifiés', () => {
    // Même frontière écrite en absolu d'un côté, en relatif (sommes flottantes) de l'autre.
    const body =
      '<path fill="#000" d="M0.1 0.2H50.3V90.7H0.1Z"/><path fill="#f00" d="M50.3 90.7v-90.5h.1v.1h40V90.7Z"/>';
    const geom = cutGeometry(sceneFromSvg(svg(body)), { tolerance: 0.1 });
    const net = buildNetwork(geom);
    let dups = 0;
    for (let s = 0; s < net.ns; s++) if (net.dupOf[s]! >= 0) dups++;
    expect(dups).toBe(1);
    expect(mergedPolylines(geom, net).length).toBe(2);
  });

  it('le fond (cadre) n’est pas analysé, sauf s’il est exporté', () => {
    const body =
      '<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="M10 10H90V90H10Z"/>';
    expect(checkSvg(svg(body)).contours.total).toBe(1);
    expect(checkSvg(svg(body), { includeBackground: true }).contours.total).toBe(2);
  });

  it('analyse et DXF partent de la même géométrie : nœuds = sommets du DXF', () => {
    const body =
      '<path fill="#000" d="M10 10C30 0 70 0 90 10V90H10Z"/><path fill="#f00" d="M90 10H99V90H90Z"/>';
    for (const mergeShared of [false, true]) {
      const r = checkSvg(svg(body), { mergeShared });
      const dxf = convertSvg(svg(body), 'dxf', { mergeShared });
      const vertices = (dxf.match(/\r\nVERTEX\r\n/g) ?? []).length;
      expect(r.nodes.total).toBe(vertices);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures : le moteur produit des fichiers sans défaut bloquant
// ---------------------------------------------------------------------------

const FIXTURES: [file: string, preset: PresetName][] = [
  ['logo-flat.png', 'logo'],
  ['logo-aa.png', 'logo'],
  ['logo-jpeg.jpg', 'logo'],
  ['text.png', 'line-art'],
  ['pixel-art.png', 'pixel-art'],
  ['illustration.png', 'illustration'],
  ['photo.png', 'photo'],
  ['alpha.png', 'logo'],
  ['badge.png', 'logo'],
  ['icon-64.png', 'logo'],
  ['line-drawing.png', 'centerline'],
];

const load = (file: string) => {
  const buf = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
  return file.endsWith('.jpg') ? decodeJpeg(buf) : decodePng(buf);
};

describe('contrôle de découpe sur les fixtures', () => {
  for (const [file, preset] of FIXTURES) {
    it(`${file} (${preset})`, { timeout: 30_000 }, () => {
      const options = presetOptions(preset);
      const { svg: out } = vectorize(load(file), options);
      const r = checkSvg(out);
      // Ni contour ouvert, ni croisement, ni auto-intersection : le moteur est sain.
      expect(r.blocking).toBe(0);
      expect(r.truncated).toBe(false);
      if (preset === 'centerline') expect(r.contours.strokes).toBe(r.contours.total);
      const merged = checkSvg(out, { mergeShared: true });
      expect(merged.totals.overlap).toBe(0);
      expect(merged.nodes.total).toBeLessThanOrEqual(r.nodes.total);
      const smoothing = options.centerline.enabled
        ? options.centerline.tolerance
        : options.fit.tolerance;
      const s = simplifySvg(out, { smoothing });
      expect(s.after.blocking).toBe(0);
      expect(s.after.totals.overlap).toBe(0);
      expect(s.summary.after.nodes).toBeLessThan(s.summary.before.nodes);
      expect(s.summary.after.issues).toBeLessThanOrEqual(s.summary.before.issues);
      // La simplification ne touche jamais le SVG : elle produit un DXF à part.
      expect(s.dxf.startsWith('0\r\nSECTION')).toBe(true);
    });
  }
});

describe('simplification : un îlot reste dans sa face', () => {
  it('Douglas-Peucker ne fait pas passer une boucle de l’autre côté d’une frontière', () => {
    // Frontière en « bosse » de 0,8 px (sous la tolérance de 1 px) ; un îlot loge dans la bosse.
    // Simplifiée seule, la frontière deviendrait la droite y = 50 et l'îlot changerait de face.
    const g = cutGeometry(
      sceneFromSvg(
        svg(
          '<path fill="#000" d="M10 10H90V50H60L50 50.8L40 50H10Z"/>' +
            '<path fill="#f00" d="M10 50H40L50 50.8L60 50H90V90H10Z"/>' +
            '<path fill="#00f" d="M49.8 50.4H50.2V50.6H49.8Z"/>',
        ),
      ),
      { tolerance: 0.1 },
    );
    const out = simplifyGeometry(g, { islandPx2: 0, tolerance: 1 });
    const bump = out.geometry.polylines.some((pl) => {
      for (let k = 0; k < pl.pts.length; k += 2)
        if (pl.pts[k] === 50 && pl.pts[k + 1] === 50.8) return true;
      return false;
    });
    expect(bump).toBe(true); // la bosse est gardée
  });
});

describe('coût borné', () => {
  it('budget de travail : épuisé, l’analyse s’arrête proprement (truncated)', () => {
    const r = check(dumbbell(1), { workBudget: 10 });
    expect(r.truncated).toBe(true);
    expect(check(dumbbell(1)).truncated).toBe(false);
    // Échéance déjà passée : arrêt dès la première lecture de l'horloge.
    let squares = '';
    for (let i = 0; i < 300; i++)
      for (let j = 0; j < 300; j++) squares += `M${i * 3} ${j * 3}h2v2h-2Z`;
    const many = checkSvg(svg(`<path fill="#000" d="${squares}"/>`, 900, 900), {
      deadline: performance.now() - 1,
    });
    expect(many.truncated).toBe(true);
  });

  it(
    'photo en pixel art, outil de 10 mm : arrêt au budget de TRAVAIL (déterministe), marquée partielle',
    {
      timeout: 60_000,
    },
    () => {
      const { svg: out } = vectorize(load('photo.png'), presetOptions('pixel-art'));
      // Garde déterministe : le travail consommé (unités du budget, pas des secondes) reste sous
      // le budget injecté, au dépassement d'une seule dépense près. Échéance de 30 s : simple filet,
      // qui fait aussi échouer VITE une mutation « budget ignoré » (travail ≫ budget).
      const workBudget = 2_000_000;
      const stats = { work: 0 };
      const t0 = performance.now();
      const r = checkSvg(out, { toolMm: 10, workBudget, stats, deadline: t0 + 30_000 });
      expect(r.truncated).toBe(true);
      expect(stats.work).toBeGreaterThan(workBudget);
      expect(stats.work).toBeLessThan(workBudget + 100_000);
      expect(performance.now() - t0).toBeLessThan(30_000);
      // Budget par défaut : même arrêt, en unités de travail (mesuré ~3 s ; plus de 5 min avant).
      const def = { work: 0 };
      expect(checkSvg(out, { toolMm: 10, stats: def, deadline: t0 + 60_000 }).truncated).toBe(true);
      expect(def.work).toBeLessThan(DEFAULT_WORK_BUDGET + 100_000);
    },
  );

  it('10 000 contours (cercles en cubiques) : analysés sans troncature, en quelques secondes', () => {
    const circ = (cx: number, cy: number, r: number): string => {
      const k = 0.5523 * r;
      return `M${cx + r} ${cy}C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r}C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r}C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy}Z`;
    };
    let d = '';
    for (let i = 0; i < 100; i++)
      for (let j = 0; j < 100; j++) d += circ(10 + 20 * i, 10 + 20 * j, 7);
    const big = svg(`<path fill="#000" d="${d}"/>`, 2000, 2000);
    const t0 = performance.now();
    const r = checkSvg(big);
    const ms = performance.now() - t0;
    expect(r.contours.total).toBe(10_000);
    expect(r.truncated).toBe(false);
    expect(sumTotals(r)).toBe(0);
    // Mesuré ~1 s (README « Prêt pour la découpe ») ; la borne large tolère une CI chargée.
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it('10 000 carrés jointifs (damier) : frontières communes fusionnées', () => {
    let a = '';
    let b = '';
    for (let i = 0; i < 100; i++)
      for (let j = 0; j < 100; j++) {
        const s = `M${i * 10} ${j * 10}h10v10h-10Z`;
        if ((i + j) % 2) a += s;
        else b += s;
      }
    const board = svg(`<path fill="#000" d="${a}"/><path fill="#f00" d="${b}"/>`, 1000, 1000);
    const r = checkSvg(board);
    expect(r.totals.overlap).toBe(19_800); // 2 × 99 × 100 côtés intérieurs
    expect(r.issues.filter((i) => i.kind === 'overlap')).toHaveLength(MAX_LISTED_PER_KIND);
    const m = analyzeCut(cutGeometry(sceneFromSvg(board), { tolerance: 0.1 }), {
      mergeShared: true,
    });
    expect(m.totals.overlap).toBe(0);
    // Chaque côté du quadrillage une fois : 2 × 100 × 101 segments, 20 398 sommets écrits.
    expect(m.nodes.total).toBe(20_398);
  }, 60_000);
});
