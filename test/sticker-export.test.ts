// T95 — Calque `CutContour` : SVG, scène (un seul assembleur), DXF, PDF, séparations, contrôle.
import { describe, expect, it } from 'vitest';
import { checkSvg } from '../src/engine/cutcheck/index.ts';
import {
  convertSvg,
  CUT_CONTOUR,
  hasCutContour,
  layeredSvg,
  separationColors,
  separationFiles,
  stripCutContour,
  withCutContour,
} from '../src/engine/export/index.ts';
import {
  paintedItems,
  sceneFromSvg,
  SceneError,
  sceneImageWidth,
} from '../src/engine/export/scene.ts';
import { writeEps } from '../src/engine/export/eps.ts';
import { stickerContourFromSvg } from '../src/engine/sticker/index.ts';

const BASE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100" fill-rule="evenodd">' +
  '<rect width="100%" height="100%" fill="#fff"/>' +
  '<path fill="#000" d="M20 20H80V80H20Z"/><path fill="#e30613" d="M120 20H180V80H120ZM140 40V60H160V40Z"/></svg>';

const withContour = (): string => {
  const c = stickerContourFromSvg(BASE, { marginMm: 2, closeMm: 3, mode: 'separate' });
  return withCutContour(BASE, c.rings);
};

/** Couches déclarées dans la table `LAYER` d'un DXF R12. */
function dxfLayers(dxf: string): string[] {
  const lines = dxf.split('\r\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length - 2; i++)
    if (lines[i] === '0' && lines[i + 1] === 'LAYER' && lines[i + 2] === '2')
      out.push(lines[i + 3]!);
  return out;
}

/** Couche de chaque `POLYLINE`. */
function polylineLayers(dxf: string): string[] {
  const lines = dxf.split('\r\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length - 3; i++)
    if (lines[i] === '0' && lines[i + 1] === 'POLYLINE' && lines[i + 2] === '8')
      out.push(lines[i + 3]!);
  return out;
}

describe('T95 — groupe CutContour du SVG', () => {
  it('ajouté après le dessin, trait fin sans remplissage, retirable', () => {
    const svg = withContour();
    expect(hasCutContour(svg)).toBe(true);
    expect(svg).toContain(
      `<g id="CutContour" data-homotope="cutcontour"><path fill="none" stroke="${CUT_CONTOUR.hex}"`,
    );
    expect(svg.indexOf('<g id="CutContour"')).toBeGreaterThan(svg.lastIndexOf('fill="#e30613"'));
    expect(stripCutContour(svg)).toBe(BASE);
    // Remplacé, jamais doublé.
    expect(withCutContour(svg, []).length).toBe(BASE.length);
    expect(svg.split('<g ').length).toBe(2);
  });

  it('sceneFromSvg relit le calque comme item `cutcontour` ; paintedItems l’ignore', () => {
    const scene = sceneFromSvg(withContour());
    const cut = scene.items.filter((it) => it.cutcontour);
    expect(cut).toHaveLength(1);
    expect(cut[0]!.fill).toBe(false);
    expect(cut[0]!.rgb).toEqual([...CUT_CONTOUR.rgb]);
    expect(cut[0]!.subpaths.every((sp) => sp.closed)).toBe(true);
    expect(paintedItems(scene).some((it) => it.cutcontour)).toBe(false);
    expect(paintedItems(scene)).toHaveLength(3);
  });

  it('tout autre groupe reste refusé (sous-ensemble d’Homotope)', () => {
    expect(() =>
      sceneFromSvg(BASE.replace('</svg>', '<g id="x"><path d="M0 0H1V1Z"/></g></svg>')),
    ).toThrow(SceneError);
    expect(() =>
      sceneFromSvg(
        BASE.replace(
          '</svg>',
          '<g id="CutContour" data-homotope="cutcontour"><path fill="#f0f" d="M0 0H1V1Z"/></g></svg>',
        ),
      ),
    ).toThrow(SceneError);
  });
});

describe('T95 — DXF', () => {
  it('calque CutContour à côté des couches de couleur, polylignes fermées', () => {
    const dxf = convertSvg(withContour(), 'dxf');
    expect(dxfLayers(dxf)).toEqual(['0', '000000', 'E30613', CUT_CONTOUR.name]);
    const layers = polylineLayers(dxf);
    expect(layers.filter((l) => l === CUT_CONTOUR.name).length).toBeGreaterThan(0);
    expect(layers.indexOf(CUT_CONTOUR.name)).toBeGreaterThan(layers.lastIndexOf('E30613'));
  });

  it('`cutOnly` ne contient QUE le calque CutContour', () => {
    const dxf = convertSvg(withContour(), 'dxf', { cutOnly: true });
    expect(dxfLayers(dxf)).toEqual(['0', CUT_CONTOUR.name]);
    const layers = polylineLayers(dxf);
    expect(layers.length).toBeGreaterThan(0);
    expect(new Set(layers)).toEqual(new Set([CUT_CONTOUR.name]));
    // Même chose avec la fusion des frontières communes (T35) : le calque seul.
    const merged = convertSvg(withContour(), 'dxf', { cutOnly: true, mergeShared: true });
    expect(new Set(polylineLayers(merged))).toEqual(new Set([CUT_CONTOUR.name]));
  });

  it('sans contour : DXF inchangé', () => {
    expect(convertSvg(stripCutContour(withContour()), 'dxf')).toBe(convertSvg(BASE, 'dxf'));
  });
});

describe('T95 — PDF', () => {
  it('trait en couleur d’accompagnement CutContour, dans un calque nommé', () => {
    const pdf = convertSvg(withContour(), 'pdf');
    expect(pdf.startsWith('%PDF-1.5')).toBe(true);
    expect(pdf).toContain('/Separation /CutContour /DeviceCMYK');
    expect(pdf).toContain('<< /Type /OCG /Name (CutContour) >>');
    expect(pdf).toContain('/OC /MC0 BDC');
    expect(pdf).toMatch(/\/CS0 CS\n1 SCN\n0\.5 w\n[^]*\nS\nQ\nEMC/);
  });

  it('sans contour : PDF inchangé à l’octet ; EPS (non-but) sans contour', () => {
    expect(convertSvg(stripCutContour(withContour()), 'pdf')).toBe(convertSvg(BASE, 'pdf'));
    expect(writeEps(sceneFromSvg(withContour()))).toBe(writeEps(sceneFromSvg(BASE)));
  });
});

describe('T95 — séparations et contrôle de découpe sans contour', () => {
  it('séparations : ni couleur ni calque CutContour', () => {
    const svg = withContour();
    expect(separationColors(svg)).toEqual(separationColors(BASE));
    expect(layeredSvg(svg)).toBe(layeredSvg(BASE));
    expect(separationFiles(svg, 'dxf', 'x').map((f) => f.name)).toEqual(
      separationFiles(BASE, 'dxf', 'x').map((f) => f.name),
    );
  });

  it('le contrôle de découpe lit la scène SANS le contour', () => {
    expect(checkSvg(withContour())).toEqual(checkSvg(BASE));
  });
});

describe('T95 — contour qui déborde de l’image (dessin collé au bord)', () => {
  // Carré noir plein cadre sur 100 × 100 px : la marge sort de l'image des quatre côtés.
  const FULL =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fill-rule="evenodd">' +
    '<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="M0 0H100V100H0Z"/></svg>';
  const opts = { marginMm: 2, closeMm: 0, mode: 'separate' as const, widthMm: 100 };
  const grow = (): string => withCutContour(FULL, stickerContourFromSvg(FULL, opts).rings);

  it('la page s’agrandit à la boîte du contour, l’image d’origine est nommée', () => {
    const out = grow();
    const root = /<svg\b[^>]*>/.exec(out)![0];
    const vb = /viewBox="([^"]*)"/.exec(root)![1]!.split(' ').map(Number);
    expect(vb[0]).toBeLessThan(0);
    expect(vb[1]).toBeLessThan(0);
    expect(vb[2]).toBeGreaterThan(103); // 100 + 2 × 2 mm (1 mm = 1 px ici), trait compris
    expect(root).toContain(`width="${vb[2]}"`);
    expect(root).toContain(`height="${vb[3]}"`);
    expect(root).toContain('data-homotope-image="100 100"');
    // Le dessin n'a pas bougé dans le fichier : son tracé est intact.
    expect(out).toContain('d="M0 0H100V100H0Z"');
  });

  it('sceneFromSvg ramène l’origine à 0 : dessin décalé, contour dans la page, mm sur l’image', () => {
    const out = grow();
    const scene = sceneFromSvg(out);
    const vb = /viewBox="([^"]*)"/.exec(out)![1]!.split(' ').map(Number);
    expect(scene.width).toBe(vb[2]);
    expect(scene.height).toBe(vb[3]);
    expect(scene.image).toEqual({ width: 100, height: 100 });
    expect(sceneImageWidth(scene)).toBe(100);
    const ink = scene.items.find((it) => it.fill && !it.background && !it.cutcontour)!;
    expect(ink.subpaths[0]!.start).toEqual([-vb[0]!, -vb[1]!]);
    const cut = scene.items.find((it) => it.cutcontour)!;
    for (const sp of cut.subpaths) {
      expect(sp.start[0]).toBeGreaterThanOrEqual(0);
      expect(sp.start[1]).toBeGreaterThanOrEqual(0);
      for (const s of sp.segments) {
        expect(s.x).toBeLessThanOrEqual(scene.width);
        expect(s.y).toBeLessThanOrEqual(scene.height);
      }
    }
  });

  it('PDF et DXF suivent la page agrandie ; le DXF garde 1 mm = 1 px de l’IMAGE', () => {
    const out = grow();
    const scene = sceneFromSvg(out);
    const pdf = convertSvg(out, 'pdf');
    expect(pdf).toContain(`/MediaBox [0 0 ${scene.width} ${scene.height}]`);
    const dxf = convertSvg(out, 'dxf', { widthMm: 100 });
    const lines = dxf.split('\r\n');
    const at = lines.indexOf('$EXTMAX');
    expect(at).toBeGreaterThan(0);
    // $EXTMAX : code 10 (x) puis 20 (y), en mm : la PAGE (≥ 104 mm), pas 100 mm.
    expect(Number(lines[at + 2])).toBeGreaterThan(103);
    expect(Number(lines[at + 2])).toBeCloseTo(scene.width, 0);
  });

  it('réappliquer un contour sur la page agrandie ne l’agrandit pas une seconde fois', () => {
    const once = grow();
    const again = withCutContour(once, stickerContourFromSvg(once, opts).rings);
    const root = (s: string): string => /<svg\b[^>]*>/.exec(s)![0];
    expect(root(again)).toBe(root(once));
    expect(sceneFromSvg(again).image).toEqual({ width: 100, height: 100 });
  });

  it('sans débordement : la racine du SVG est inchangée', () => {
    const out = withContour();
    expect(/<svg\b[^>]*>/.exec(out)![0]).toBe(/<svg\b[^>]*>/.exec(BASE)![0]);
    expect(sceneFromSvg(out).image).toBeUndefined();
  });

  it('un viewBox illisible est refusé par sceneFromSvg', () => {
    expect(() => sceneFromSvg(BASE.replace('viewBox="0 0 200 100"', 'viewBox="a b"'))).toThrow(
      SceneError,
    );
  });
});
