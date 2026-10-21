import { describe, expect, it } from 'vitest';
import {
  checkSvg,
  correctSvg,
  cutParams,
  isWedge,
  LINE_ART_SHARE,
  isLineArt,
  simplifySvg,
  typicalWidth,
  unfold,
  type CutFix,
  type CutReport,
} from '../src/engine/cutcheck/index.ts';
import { convertSvg } from '../src/engine/export/index.ts';
import { dxfMmPerPx } from '../src/engine/export/dxf.ts';
import {
  clampMmPerPx,
  MAX_MM_PER_PX,
  MIN_MM_PER_PX,
  MM_PER_PX,
} from '../src/engine/export/polyline.ts';

/**
 * T63 — Contrôle de découpe : les pointes ne sont pas des détails fins, les vrais filets le sont
 * (avec leur longueur), un aller-retour court au bout d'une pointe n'est pas une double découpe,
 * dessin au trait reconnu, échelle réelle, corrections point par point. Échelle des cas : 1 px =
 * 0,1 mm (outil de 0,2 mm = 2 px), comme `cutcheck.test.ts`.
 */
const MM = 0.1;
const svg = (body: string, w = 100, h = 100): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill-rule="evenodd">${body}</svg>`;
const check = (body: string, o: Parameters<typeof checkSvg>[1] = {}): CutReport =>
  checkSvg(svg(body), { mmPerPx: MM, ...o });
const issuesOf = (r: CutReport, kind: string) => r.issues.filter((i) => i.kind === kind);
const fixesOf = (r: CutReport): CutFix[] =>
  r.issues.filter((i) => i.fixable).map((i) => ({ kind: i.kind as CutFix['kind'], box: i.box }));

/** Deux blocs reliés par un filet de `w` px de large et `len` px de long. */
const strand = (w: number, len: number): string =>
  `<path fill="#000" d="M0 0H20V${10 - w / 2}H${20 + len}V0H${40 + len}V20H${20 + len}V${10 + w / 2}H20V20H0Z"/>`;

describe('pointes : jamais des détails fins', () => {
  it('triangle pointu à base plus large que l’outil : aucune alerte, quel que soit l’angle', () => {
    for (const d of [
      'M10 90L50 10L18 90Z', // ~5°
      'M10 90L50 10L30 90Z', // ~14°
      'M10 90L50 2L16 90Z', // ~3,5°, base de 0,6 mm
    ])
      expect(check(`<path fill="#000" d="${d}"/>`, { toolMm: 0.5 }).totals.thin, d).toBe(0);
  });
  it('coin dont la base reste sous l’outil (~0,7°, base de 0,1 mm) : un filet, signalé', () => {
    const r = check('<path fill="#000" d="M10 90L50 2L11 90Z"/>', { toolMm: 0.5 });
    expect(r.totals.thin).toBe(1);
    expect(issuesOf(r, 'thin')[0]!.length!).toBeGreaterThan(5);
  });
  it('pointe émoussée (sommet plat) et pointe à flancs courbes : aucune alerte', () => {
    expect(
      check('<path fill="#000" d="M10 90L50 10L50.5 10L18 90Z"/>', { toolMm: 0.5 }).totals.thin,
    ).toBe(0);
    expect(
      check('<path fill="#000" d="M10 90C30 60 45 30 50 10C45 40 30 70 22 90Z"/>', { toolMm: 0.5 })
        .totals.thin,
    ).toBe(0);
  });
  it('profil : coin (w ∝ s) oui ; filet (w constant) ou feuille (w retombe) non', () => {
    const profile = (f: (s: number) => number): number[] =>
      Array.from({ length: 20 }, (_, k) => [k + 1, 0, f(k + 1)]).flat();
    expect(
      isWedge(
        profile((s) => 0.1 * s),
        0,
        0,
        0.5,
      ),
    ).toBe(true);
    expect(
      isWedge(
        profile(() => 1),
        0,
        0,
        0.5,
      ),
    ).toBe(false);
    expect(
      isWedge(
        profile((s) => s * (21 - s) * 0.01),
        0,
        0,
        0.5,
      ),
    ).toBe(false);
    // Tous à la même distance : aucune pente mesurable.
    expect(isWedge([5, 0, 1, 0, 5, 2, -5, 0, 3], 0, 0, 0.5)).toBe(false);
    // Largeur courante : la médiane de l'enveloppe basse (un écart parasite ne compte pas).
    expect(typicalWidth([0, 0, 1, 1, 0, 1, 2, 0, 1, 2, 0, 5, 3, 0, 1], 0.5)).toBe(1);
  });
});

describe('filets : signalés s’ils persistent, avec leur longueur', () => {
  it('filet de 1 px sur 100 px : détail trop fin, largeur ET longueur', () => {
    const r = checkSvg(svg(strand(1, 100), 150, 30), { mmPerPx: MM });
    expect(r.totals.thin).toBe(1);
    const [t] = issuesOf(r, 'thin');
    expect(t!.value).toBeCloseTo(0.1, 6);
    expect(t!.length).toBeCloseTo(10, 1);
    expect(t!.fixable).toBe(true);
    expect(t!.message).toBe(
      'Filet de 0,1 mm de large sur 10 mm, sous le diamètre de l’outil (0,2 mm) : ce détail sera brûlé ou arraché.',
    );
  });
  it('plus court que la longueur minimale (le diamètre par défaut) : rien', () => {
    // Filet de 4 mm : signalé à 3 mm de longueur minimale, pas à 5.
    expect(check(strand(1, 40), { minThinMm: 3 }).totals.thin).toBe(1);
    const r = check(strand(1, 40), { minThinMm: 5 });
    expect(r.minThinMm).toBe(5);
    expect(r.totals.thin).toBe(0);
    expect(check(strand(1, 40)).minThinMm).toBe(0.2); // défaut : le diamètre de l'outil
  });
  it('filet terminé en pointe : signalé, par sa largeur courante (pas celle de son bout)', () => {
    const hair = '<path fill="#000" d="M0 0H20V9.5H60L90 10L60 10.5H20V20H0Z"/>';
    const [t] = issuesOf(check(hair), 'thin');
    expect(t!.value).toBeCloseTo(0.1, 6);
    expect(t!.length!).toBeGreaterThan(4);
  });
  // Relecture T63 : un coin dont la base reste sous l'outil n'est pas une pointe, c'est un filet.
  const needle = 'M10 100L310 102L10 104Z'; // base 0,4 mm, longueur 30 mm
  it('aiguille de base 0,4 mm sous outil 0,5 mm, longue de 30 mm : détail fin, avec longueur', () => {
    const r = checkSvg(svg(`<path fill="#000" d="${needle}"/>`, 330, 200), {
      mmPerPx: MM,
      toolMm: 0.5,
    });
    expect(r.totals.thin).toBe(1);
    const [t] = issuesOf(r, 'thin');
    expect(t!.value).toBeLessThan(0.45);
    expect(t!.length!).toBeGreaterThan(20);
    expect(t!.message).toMatch(/^Filet de .* mm de large sur .* mm, sous le diamètre/);
  });
  it('la même aiguille posée sur un bloc : détail fin', () => {
    const r = checkSvg(
      svg(`<path fill="#000" d="M0 60H10V100L310 102L10 104V140H0Z"/>`, 330, 200),
      { mmPerPx: MM, toolMm: 0.5 },
    );
    expect(r.totals.thin).toBe(1);
    expect(issuesOf(r, 'thin')[0]!.length!).toBeGreaterThan(20);
  });
  it('triangle de base 5 mm, long de 30 mm, outil 0,5 mm : rien (vraie pointe)', () => {
    const r = checkSvg(svg('<path fill="#000" d="M10 100L310 125L10 150Z"/>', 330, 200), {
      mmPerPx: MM,
      toolMm: 0.5,
    });
    expect(r.totals.thin).toBe(0);
    expect(r.blocking).toBe(0);
  });
  it('forme entière plus fine que l’outil (feuille) : signalée', () => {
    const leaf = '<path fill="#000" d="M10 50C40 49.2 60 49.2 90 50C60 50.8 40 50.8 10 50Z"/>';
    expect(check(leaf).totals.thin).toBe(1);
  });
});

describe('doubles découpes : aller-retour', () => {
  it('long (au-delà du diamètre) : bloquant ; court au bout d’une pointe : rien', () => {
    const long = check('<path fill="#000" d="M10 10H50V40H80H50V90H10Z"/>');
    expect(long.totals.overlap).toBe(1);
    const [o] = issuesOf(long, 'overlap');
    expect(o!.severity).toBe('blocking');
    expect(o!.value).toBeCloseTo(3, 6);
    expect(o!.fixable).toBe(true);
    const short = check('<path fill="#000" d="M10 10H50V40H51.5H50V90H10Z"/>');
    expect(short.totals.overlap).toBe(0);
    expect(short.blocking).toBe(0);
  });
  it('deux allers-retours d’un même contour : comptés par tronçon, pas ensemble', () => {
    // 3 mm et 0,1 mm : seul le long reste (la somme aurait tout gardé).
    const r = check('<path fill="#000" d="M10 10H50V40H80H50V60H51H50V90H10Z"/>');
    expect(r.totals.overlap).toBe(1);
    expect(issuesOf(r, 'overlap')[0]!.value).toBeCloseTo(3, 6);
  });
});

describe('petits îlots : les dimensions plutôt que « 0 mm² »', () => {
  it('message et mesure', () => {
    const r = check('<path fill="#000" d="M40 40H43V41H40Z"/>');
    const [i] = issuesOf(r, 'island');
    expect(i!.size).toEqual({ width: 0.3, height: 0.1 });
    expect(i!.message).toBe(
      'Petit îlot de 0,3 × 0,1 mm (0,03 mm², seuil 1 mm²) : il risque de se perdre ou de bouger pendant la découpe.',
    );
  });
});

describe('dessin au trait', () => {
  it('seuil pur', () => {
    expect(LINE_ART_SHARE).toBe(0.5);
    expect(isLineArt(0.51)).toBe(true);
    expect(isLineArt(0.5)).toBe(false);
    expect(isLineArt(0)).toBe(false);
  });
  it('traits pleins plus fins que l’outil : reconnu ; formes pleines : non', () => {
    let bars = '';
    for (let k = 0; k < 8; k++) bars += `M10 ${10 + 10 * k}H90V${11 + 10 * k}H10Z`;
    const art = check(`<path fill="#000" d="${bars}"/>`);
    expect(art.lineArt).toBe(true);
    expect(art.thinShare).toBeGreaterThan(0.9);
    const solid = check(strand(1, 40));
    expect(solid.lineArt).toBe(false);
    expect(solid.thinShare).toBeGreaterThan(0);
    expect(check('<path fill="#000" d="M10 10H90V90H10Z"/>').thinShare).toBe(0);
  });
});

describe('échelle réelle (largeur du dessin)', () => {
  it('le contrôle et le DXF lisent la même largeur', () => {
    const body = '<path fill="#000" d="M10 10H90V90H10Z"/>';
    const r = checkSvg(svg(body, 100, 50), { widthMm: 200 });
    expect(r.mmPerPx).toBe(2);
    expect(r.drawing).toEqual({ width: 200, height: 100 });
    expect(dxfMmPerPx(100, 200)).toBe(2);
    const dxf = convertSvg(svg(body, 100, 50), 'dxf', { widthMm: 200 });
    expect(dxf).toContain('$EXTMAX\r\n10\r\n200\r\n20\r\n100\r\n');
    // Sans largeur : 1 px = 1 pt, DXF inchangé.
    expect(convertSvg(svg(body, 100, 50), 'dxf')).toBe(convertSvg(svg(body, 100, 50), 'dxf', {}));
    expect(checkSvg(svg(body)).mmPerPx).toBe(MM_PER_PX);
    // Bornée (1 mm à 100 m), invalide : 1 px = 1 pt.
    expect(dxfMmPerPx(100, 0)).toBe(0.01);
    expect(dxfMmPerPx(100, Number.NaN)).toBe(MM_PER_PX);
  });
  it('un seul jeu de bornes d’échelle, partagé par le DXF et le contrôle', () => {
    expect(clampMmPerPx(0)).toBe(MIN_MM_PER_PX);
    expect(clampMmPerPx(1e9)).toBe(MAX_MM_PER_PX);
    // Dessin d'un million de px sur 1 mm, ou d'un px sur 100 m : bornes atteintes des deux côtés.
    for (const [px, mm] of [
      [1e6, 1],
      [1, 100_000],
      [100, 200],
    ] as const) {
      const scale = dxfMmPerPx(px, mm);
      expect(scale).toBe(clampMmPerPx(scale));
      expect(cutParams({ mmPerPx: mm / px }).mmPerPx).toBe(scale);
    }
    expect(cutParams({ mmPerPx: 1e-9 }).mmPerPx).toBe(MIN_MM_PER_PX);
    expect(cutParams({ mmPerPx: 1e9 }).mmPerPx).toBe(MAX_MM_PER_PX);
  });
});

describe('corriger point par point', () => {
  it('filet élargi : plus de détail fin, aucun croisement créé', () => {
    const r = check(strand(1, 40));
    const c = correctSvg(svg(strand(1, 40)), { mmPerPx: MM, fixes: fixesOf(r) });
    expect(c.applied).toEqual([true]);
    expect(c.report.totals.thin).toBe(0);
    expect(c.report.blocking).toBe(0);
  });
  it('aller-retour retiré ; îlot retiré (et son trou) ; tous ensemble', () => {
    const body =
      '<path fill="#000" d="M10 10H50V40H80H50V90H10ZM20 20V25H25V20Z"/><path fill="#f00" d="M20 20H25V25H20Z"/>';
    const r = check(body);
    expect(r.totals.overlap).toBeGreaterThanOrEqual(1);
    expect(r.totals.island).toBe(1);
    const c = correctSvg(svg(body), { mmPerPx: MM, fixes: fixesOf(r) });
    expect(c.applied.every(Boolean)).toBe(true);
    expect(c.report.totals.island).toBe(0);
    expect(c.report.blocking).toBe(0);
  });
  it('îlot posé contre deux faces : pas de correction ici (le point reste)', () => {
    const body =
      '<path fill="#000" d="M10 10H50V40H46V45H50V90H10Z"/>' +
      '<path fill="#f00" d="M50 10H90V90H50V45H51V40H50Z"/><path fill="#00f" d="M46 40H51V45H46Z"/>';
    const r = check(body);
    const c = correctSvg(svg(body), { mmPerPx: MM, fixes: fixesOf(r) });
    expect(c.applied).toEqual([false]);
    expect(c.report.totals.island).toBe(1);
  });
  it('repli retiré : a → b → a redevient a ; sans repli dans la boîte, rien ne change', () => {
    const pts = Float64Array.from([0, 0, 10, 0, 10, 5, 20, 5, 10, 5, 10, 10, 0, 10]);
    const box = { x: 9, y: 4, width: 12, height: 2 };
    expect([...unfold(pts, true, box)]).toEqual([0, 0, 10, 0, 10, 5, 10, 10, 0, 10]);
    expect(unfold(pts, true, { x: 50, y: 50, width: 1, height: 1 })).toBe(pts);
  });
  it('le DXF simplifié inclut les corrections ; le SVG n’est jamais touché', () => {
    const body = strand(1, 40);
    const r = check(body);
    const s = simplifySvg(svg(body), { mmPerPx: MM, smoothing: 0, fixes: fixesOf(r) });
    expect(s.before.totals.thin).toBe(1);
    expect(s.after.totals.thin).toBe(0);
    expect(s.after.blocking).toBe(0);
  });
});
