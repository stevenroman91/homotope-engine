import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeJpeg, decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import {
  convertSvg,
  flattenSubpath,
  layerName,
  MM_PER_PX,
  SceneError,
  sceneFromSvg,
  writeDxf,
  writeEps,
  writePdf,
} from '../src/engine/export/index.ts';
import { fmtNum, paintedItems } from '../src/engine/export/scene.ts';
import { nearestAci } from '../src/engine/export/dxf.ts';
import { parsePathData, type ParsedSubpath } from '../src/engine/svg/parse.ts';
import type { PresetName, RasterImage } from '../src/engine/types.ts';

// T32 — Exports PDF, EPS et DXF : bien formés, sous-chemins conservés, sommets reparsés à
// 1e-6 près de ceux du SVG, aucun NaN, taille du même ordre que le SVG. Le SVG est relu ici
// par une extraction INDÉPENDANTE de `sceneFromSvg` (expressions régulières + `parsePathData`).

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
];

function load(file: string): RasterImage {
  const bytes = new Uint8Array(readFileSync(`test/fixtures/${file}`));
  return /\.jpe?g$/i.test(file) ? decodeJpeg(bytes) : decodePng(bytes);
}

interface Expected {
  width: number;
  height: number;
  evenodd: boolean;
  /** Sous-tracés de chaque élément peint, dans l'ordre, avec ses attributs. */
  items: {
    fill: string | null;
    stroke: boolean;
    masked: boolean;
    rect: boolean;
    subpaths: ParsedSubpath[];
  }[];
}

/** Extraction indépendante du SVG (le masque F1 est retiré avant). */
function expectedOf(svg: string): Expected {
  const root = /<svg\b([^>]*)>/.exec(svg)![1]!;
  const attr = (s: string, n: string): string | undefined =>
    new RegExp(`\\s${n}="([^"]*)"`).exec(s)?.[1];
  const width = Number(attr(root, 'width'));
  const height = Number(attr(root, 'height'));
  const body = svg.replace(/<mask\b[\s\S]*?<\/mask>/g, '');
  const items: Expected['items'] = [];
  for (const m of body.matchAll(/<(rect|path)\b([^>]*)\/>/g)) {
    const a = m[2]!;
    const fill = attr(a, 'fill') ?? null;
    const sub: ParsedSubpath[] =
      m[1] === 'rect'
        ? [
            {
              start: [0, 0],
              segments: [
                { kind: 'line', x: width, y: 0 },
                { kind: 'line', x: width, y: height },
                { kind: 'line', x: 0, y: height },
              ],
              closed: true,
            },
          ]
        : parsePathData(attr(a, 'd')!);
    items.push({
      fill: fill === 'none' ? null : fill,
      stroke: attr(a, 'stroke') !== undefined,
      masked: attr(a, 'mask') !== undefined,
      rect: m[1] === 'rect',
      subpaths: sub,
    });
  }
  return { width, height, evenodd: / fill-rule="evenodd"/.test(root), items };
}

/** Points de contrôle et d'ancrage, dans l'ordre (départ, puis c1, c2, fin de chaque segment). */
function controlPoints(sp: ParsedSubpath): number[] {
  const out = [sp.start[0], sp.start[1]];
  for (const s of sp.segments) {
    if (s.kind === 'cubic') out.push(s.c1x, s.c1y, s.c2x, s.c2y);
    out.push(s.x, s.y);
  }
  return out;
}

/** Relecture des opérateurs de tracé `m l c h` (PDF ou PostScript), Y ré-inversé. */
function readOps(text: string, height: number): { subpaths: number[][]; closed: boolean[] } {
  const subpaths: number[][] = [];
  const closed: boolean[] = [];
  let stack: number[] = [];
  for (const tok of text.split(/\s+/)) {
    if (tok === '') continue;
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      stack.push(Number(tok));
      continue;
    }
    const pts: number[] = [];
    for (let k = 0; k + 1 < stack.length; k += 2) pts.push(stack[k]!, height - stack[k + 1]!);
    if (tok === 'm') {
      subpaths.push(pts.slice(-2));
      closed.push(false);
    } else if (tok === 'l') subpaths[subpaths.length - 1]!.push(...pts.slice(-2));
    else if (tok === 'c') subpaths[subpaths.length - 1]!.push(...pts.slice(-6));
    else if (tok === 'h') closed[closed.length - 1] = true;
    stack = [];
  }
  return { subpaths, closed };
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string): void {
  expect(actual.length, label).toBe(expected.length);
  for (let k = 0; k < expected.length; k++)
    if (!(Math.abs(actual[k]! - expected[k]!) <= 1e-6))
      throw new Error(`${label} : coordonnée ${k} = ${actual[k]} au lieu de ${expected[k]}`);
}

/** Le PDF est bien formé : en-tête, objets, `xref` aux décalages EXACTS, `startxref`, fin. */
function checkPdfStructure(pdf: string): { content: string } {
  expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
  expect(pdf.endsWith('%%EOF\n')).toBe(true);
  // eslint-disable-next-line no-control-regex
  expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(pdf), 'ASCII seul').toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  expect(pdf.slice(startxref, startxref + 5)).toBe('xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(pdf.slice(startxref))!;
  const n = Number(head[1]);
  let at = startxref + head[0].length;
  const entry = (k: number) => pdf.slice(at + 20 * k, at + 20 * (k + 1));
  expect(entry(0)).toBe('0000000000 65535 f \n');
  for (let k = 1; k < n; k++) {
    const e = entry(k);
    expect(e, `entrée ${k}`).toMatch(/^\d{10} 00000 n \n$/);
    const off = Number(e.slice(0, 10));
    expect(pdf.slice(off, off + `${k} 0 obj\n`.length), `objet ${k}`).toBe(`${k} 0 obj\n`);
  }
  at += 20 * n;
  expect(pdf.slice(at)).toMatch(
    new RegExp(`^trailer\\n<< /Size ${n} /Root 1 0 R /Info \\d+ 0 R >>`),
  );
  const s = /<< \/Length (\d+) >>\nstream\n/.exec(pdf)!;
  const begin = s.index + s[0].length;
  const content = pdf.slice(begin, begin + Number(s[1]));
  expect(pdf.slice(begin + Number(s[1]), begin + Number(s[1]) + 9)).toBe('endstream');
  return { content };
}

/** Paires (code, valeur) d'un DXF ASCII ; lève si le nombre de lignes est impair. */
function dxfPairs(dxf: string): [number, string][] {
  const lines = dxf.split('\r\n');
  expect(lines.pop()).toBe('');
  expect(lines.length % 2).toBe(0);
  const out: [number, string][] = [];
  for (let k = 0; k < lines.length; k += 2) {
    const code = Number(lines[k]!.trim());
    expect(Number.isInteger(code), `code ${lines[k]}`).toBe(true);
    out.push([code, lines[k + 1]!]);
  }
  return out;
}

interface DxfPolyline {
  layer: string;
  flags: number;
  /** Sommets en px du SVG (Y vers le bas). */
  pts: number[];
}

function readDxf(dxf: string, height: number): { layers: string[]; polylines: DxfPolyline[] } {
  const pairs = dxfPairs(dxf);
  expect(pairs[0]).toEqual([0, 'SECTION']);
  expect(pairs[pairs.length - 1]).toEqual([0, 'EOF']);
  // SECTION / ENDSEC équilibrés, jamais imbriqués.
  let open = false;
  const sections: string[] = [];
  pairs.forEach(([c, v], k) => {
    if (c !== 0) return;
    if (v === 'SECTION') {
      expect(open).toBe(false);
      open = true;
      sections.push(pairs[k + 1]![1]);
      expect(pairs[k + 1]![0]).toBe(2);
    } else if (v === 'ENDSEC') {
      expect(open).toBe(true);
      open = false;
    }
  });
  expect(open).toBe(false);
  expect(sections).toEqual(['HEADER', 'TABLES', 'ENTITIES']);
  expect(dxf).toContain('$ACADVER\r\n1\r\nAC1009\r\n');

  const layers: string[] = [];
  const polylines: DxfPolyline[] = [];
  let cur: DxfPolyline | null = null;
  let vertex: number[] | null = null;
  let entity = '';
  let inLayerTable = false;
  for (const [c, v] of pairs) {
    if (c === 0) {
      if (vertex) cur!.pts.push(...vertex);
      vertex = null;
      entity = v;
      if (v === 'POLYLINE') {
        cur = { layer: '', flags: 0, pts: [] };
        polylines.push(cur);
      } else if (v === 'VERTEX') {
        expect(cur).not.toBeNull();
        vertex = [NaN, NaN];
      } else if (v === 'SEQEND') cur = null;
      else if (v === 'ENDTAB') inLayerTable = false;
      continue;
    }
    if (entity === 'TABLE' && c === 2 && v === 'LAYER') inLayerTable = true;
    if (inLayerTable && entity === 'LAYER' && c === 2) layers.push(v);
    if (entity === 'POLYLINE' && cur) {
      if (c === 8) cur.layer = v;
      if (c === 70) cur.flags = Number(v);
    }
    if (entity === 'VERTEX' && vertex) {
      if (c === 10) vertex[0] = Number(v) / MM_PER_PX;
      if (c === 20) vertex[1] = height - Number(v) / MM_PER_PX;
    }
  }
  return { layers, polylines };
}

function hex6(fill: string): string {
  const s = fill.slice(1);
  return (s.length === 3 ? [...s].map((c) => c + c).join('') : s).toUpperCase();
}

describe('exports PDF, EPS et DXF sur les fixtures', () => {
  for (const [file, preset] of FIXTURES) {
    it(`${file} (${preset})`, { timeout: 30_000 }, () => {
      const { svg } = vectorize(load(file), presetOptions(preset));
      const exp = expectedOf(svg);
      const painted = exp.items.filter((it) => !(it.masked && it.fill === null));
      const paintedSubs = painted.flatMap((it) => it.subpaths);
      // DXF : formes remplies, SANS le `<rect>` de fond (pas une forme à découper).
      const cutItems = exp.items.filter((it) => it.fill !== null && !it.rect);
      const filledSubs = cutItems.flatMap((it) => it.subpaths);
      expect(paintedSubs.length).toBeGreaterThan(0);

      // --- PDF ---------------------------------------------------------------
      const pdf = convertSvg(svg, 'pdf');
      expect(pdf).not.toMatch(/NaN|Infinity|\de[-+]?\d/);
      const { content } = checkPdfStructure(pdf);
      expect(pdf).toContain(`/MediaBox [0 0 ${exp.width} ${exp.height}]`);
      const pdfOps = readOps(content.replace(/\/G\d+ gs/g, ''), exp.height);
      expect(pdfOps.subpaths.length).toBe(paintedSubs.length);
      paintedSubs.forEach((sp, k) => {
        expectClose(pdfOps.subpaths[k]!, controlPoints(sp), `PDF ${file} sous-tracé ${k}`);
        expect(pdfOps.closed[k]).toBe(sp.closed);
      });
      const fills = content.match(/^(f\*?|B\*?|S)$/gm) ?? [];
      expect(fills.length).toBe(painted.length);
      for (const f of fills) if (f !== 'S') expect(f.endsWith('*')).toBe(exp.evenodd);

      // --- EPS ---------------------------------------------------------------
      const eps = convertSvg(svg, 'eps');
      expect(eps).not.toMatch(/NaN|Infinity|\de[-+]?\d/);
      const lines = eps.split('\n');
      expect(lines[0]).toBe('%!PS-Adobe-3.0 EPSF-3.0');
      expect(lines[1]).toBe(`%%BoundingBox: 0 0 ${Math.ceil(exp.width)} ${Math.ceil(exp.height)}`);
      expect(eps.endsWith('%%Trailer\n%%EOF\n')).toBe(true);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(255);
      // Après le rognage à la boîte, les sous-tracés peints.
      const body = eps.slice(eps.indexOf('1 setlinejoin'));
      const epsOps = readOps(body.replace(/\S+ \S+ \S+ setrgbcolor\n/g, ''), exp.height);
      expect(epsOps.subpaths.length).toBe(paintedSubs.length);
      paintedSubs.forEach((sp, k) =>
        expectClose(epsOps.subpaths[k]!, controlPoints(sp), `EPS ${file} sous-tracé ${k}`),
      );

      // --- DXF ---------------------------------------------------------------
      const dxf = convertSvg(svg, 'dxf');
      expect(dxf).not.toMatch(/NaN|Infinity|\de[-+]?\d/);
      const { layers, polylines } = readDxf(dxf, exp.height);
      expect(polylines.length).toBe(filledSubs.length);
      const layerOf = cutItems.flatMap((it) => it.subpaths.map(() => hex6(it.fill!)));
      expect(new Set(layers)).toEqual(new Set(['0', ...layerOf]));
      filledSubs.forEach((sp, k) => {
        const pl = polylines[k]!;
        expect(pl.flags & 1, 'polyligne fermée').toBe(1);
        expect(pl.layer).toBe(layerOf[k]);
        // Chaque ancrage du SVG est un sommet de la polyligne, dans l'ordre.
        const anchors = [sp.start[0], sp.start[1], ...sp.segments.flatMap((s) => [s.x, s.y])];
        const n = anchors.length;
        if (anchors[n - 2] === anchors[0] && anchors[n - 1] === anchors[1]) anchors.length = n - 2;
        let at = 0;
        for (let a = 0; a < anchors.length; a += 2) {
          while (
            at < pl.pts.length &&
            !(
              Math.abs(pl.pts[at]! - anchors[a]!) <= 1e-6 &&
              Math.abs(pl.pts[at + 1]! - anchors[a + 1]!) <= 1e-6
            )
          )
            at += 2;
          if (at >= pl.pts.length)
            throw new Error(`DXF ${file} polyligne ${k} : ancrage ${a / 2} absent`);
          at += 2;
        }
        expect(pl.pts.every(Number.isFinite)).toBe(true);
      });
      // Aucun cadre de la taille de l'image : le fond n'est jamais coupé autour du motif.
      for (const pl of polylines) {
        const xs = pl.pts.filter((_, k) => k % 2 === 0);
        const ys = pl.pts.filter((_, k) => k % 2 === 1);
        const frame =
          pl.pts.length === 8 &&
          Math.min(...xs) <= 1e-6 &&
          Math.min(...ys) <= 1e-6 &&
          Math.max(...xs) >= exp.width - 1e-6 &&
          Math.max(...ys) >= exp.height - 1e-6;
        expect(frame, `${file} : cadre de fond dans le DXF`).toBe(false);
      }
      if (exp.items.some((it) => it.rect)) {
        const withBg = readDxf(convertSvg(svg, 'dxf', { includeBackground: true }), exp.height);
        expect(withBg.polylines.length).toBe(polylines.length + 1);
      }

      // --- Taille : du même ordre que le SVG -----------------------------------
      expect(pdf.length).toBeLessThanOrEqual(3 * svg.length + 2048);
      expect(eps.length).toBeLessThanOrEqual(3 * svg.length + 2048);
      // DXF : une ligne par code de groupe et des courbes aplaties (mesuré : 10 à 18 × le SVG).
      expect(dxf.length).toBeLessThanOrEqual(25 * svg.length + 16384);
    });
  }
});

const SQUARE_WITH_HOLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" viewBox="0 0 10 8" fill-rule="evenodd">' +
  '<path fill="#f80" d="M0 0h10v8H0ZM2 2v4h6V2Z"/>' +
  '<path fill="#123456" fill-opacity=".5" d="M3 3C4 3 5 4 5 5L3 5Z"/>' +
  '<path fill="none" stroke="#f80" stroke-width="1" stroke-linejoin="round" d="M2 2v4"/>' +
  '</svg>';

describe('scène : relecture du SVG', () => {
  it('ordre, couleurs, opacité, trait, règle de remplissage', () => {
    const s = sceneFromSvg(SQUARE_WITH_HOLE);
    expect(s).toMatchObject({ width: 10, height: 8, fillRule: 'evenodd' });
    expect(s.items.map((it) => [it.rgb, it.fill, it.opacity, it.stroke])).toEqual([
      [[255, 136, 0], true, undefined, undefined],
      [[0x12, 0x34, 0x56], true, 0.5, undefined],
      [[255, 136, 0], false, undefined, 1],
    ]);
    expect(s.items[0]!.subpaths).toHaveLength(2);
  });

  it('le masque de gomme est sauté ; un trait masqué est omis en PDF et EPS', () => {
    const svg =
      '<svg width="4" height="4"><mask id="t" maskUnits="userSpaceOnUse" x="0" y="0" width="4" height="4">' +
      '<rect width="100%" height="100%" fill="#fff"/><path fill="none" stroke="#000" stroke-width="2" d="M0 0h4"/></mask>' +
      '<path fill="#000" d="M0 0h4v4Z"/><path fill="none" stroke="#000" stroke-width="1" mask="url(#t)" d="M0 0h4"/></svg>';
    const s = sceneFromSvg(svg);
    expect(s.items).toHaveLength(2);
    expect(s.items[1]!.masked).toBe(true);
    expect(paintedItems(s)).toHaveLength(1);
    expect(writePdf(s)).not.toMatch(/^S$/m);
    expect(writeEps(s)).not.toContain('stroke');
    expect(s.fillRule).toBe('nonzero');
  });

  it('refuse ce qu’Homotope n’émet pas (jamais d’export silencieusement faux)', () => {
    for (const bad of [
      '',
      '<svg width="1" height="1"><circle r="1"/></svg>',
      '<svg width="1" height="1"><path fill="#000" d="M0 0A1 1 0 0 0 1 1Z"/></svg>',
      '<svg width="1" height="1"><path fill="url(#g)" d="M0 0h1v1Z"/></svg>',
      '<svg width="1" height="1">texte</svg>',
      '<svg width="1" height="1"><path fill="#000" d="M0 0h1v1Z"/>',
      '<svg width="0" height="1"></svg>',
      '<svg width="1" height="1"></svg><svg/>',
      '<div/><svg width="1" height="1"></svg>',
    ])
      expect(() => sceneFromSvg(bad), bad).toThrow(SceneError);
  });
});

describe('PDF', () => {
  it('f* en pair-impair, f en non nul ; opacité par /ca ; trait en S', () => {
    const pdf = writePdf(sceneFromSvg(SQUARE_WITH_HOLE));
    checkPdfStructure(pdf);
    expect(pdf).toContain('1 0.5333 0 rg');
    expect(pdf).toMatch(/^f\*$/m);
    expect(pdf).toContain('/ExtGState << /G0 5 0 R >>');
    expect(pdf).toContain('<< /Type /ExtGState /ca 0.5 >>');
    expect(pdf).toMatch(/q\n\/G0 gs\n[\s\S]*?f\*\nQ/);
    expect(pdf).toMatch(/1 0.5333 0 RG\n1 w\n2 6 m\n2 2 l\nS/);
    const nz = writePdf(sceneFromSvg(SQUARE_WITH_HOLE.replace(' fill-rule="evenodd"', '')));
    expect(nz).toMatch(/^f$/m);
    expect(nz).not.toMatch(/^f\*$/m);
  });

  it('remplissage + trait sur le même tracé : B* / B', () => {
    const svg =
      '<svg width="2" height="2" fill-rule="evenodd"><path fill="#000" stroke="#000" stroke-width="1" d="M0 0h2v2Z"/></svg>';
    expect(writePdf(sceneFromSvg(svg))).toMatch(/^B\*$/m);
    expect(writeEps(sceneFromSvg(svg))).toContain('gsave eofill grestore 1 setlinewidth stroke');
  });
});

describe('EPS', () => {
  it('pas de transparence : la couleur translucide est peinte opaque ; boîte arrondie dehors', () => {
    const eps = writeEps(sceneFromSvg(SQUARE_WITH_HOLE.replace(/"10"/g, '"9.5"')));
    expect(eps).toContain('%%BoundingBox: 0 0 10 8');
    expect(eps).toContain('%%HiResBoundingBox: 0 0 9.5 8');
    expect(eps).toContain('0.0706 0.2039 0.3373 setrgbcolor');
    expect(eps).not.toMatch(/opacity|setalpha/i);
  });
});

describe('DXF', () => {
  it('couche par couleur nommée en hexadécimal, ACI proche, contour fermé, trait omis', () => {
    const dxf = writeDxf(sceneFromSvg(SQUARE_WITH_HOLE));
    const { layers, polylines } = readDxf(dxf, 8);
    expect(layers).toEqual(['0', 'FF8800', '123456']);
    expect(polylines.map((p) => p.layer)).toEqual(['FF8800', 'FF8800', '123456']);
    // Extérieur et trou : deux contours fermés de 4 sommets, exacts.
    expectClose(polylines[0]!.pts, [0, 0, 10, 0, 10, 8, 0, 8], 'extérieur');
    expectClose(polylines[1]!.pts, [2, 2, 2, 6, 8, 6, 8, 2], 'trou');
    expect(polylines.every((p) => p.flags === 1)).toBe(true);
    expect(layerName([255, 136, 0])).toBe('FF8800');
    expect(nearestAci([250, 10, 10])).toBe(1);
    expect(nearestAci([0, 0, 0])).toBe(7);
    expect(nearestAci([255, 255, 255])).toBe(7);
  });

  it('aplatissement : écart à la cubique ≤ tolérance, ancrages exacts, borné', () => {
    const sp = parsePathData('M0 0C0 50 100 50 100 0Z')[0]!;
    for (const tol of [0.01, 0.1, 1]) {
      const pts = flattenSubpath(sp, tol);
      expect([pts[0], pts[1]]).toEqual([0, 0]);
      expect([pts[pts.length - 2], pts[pts.length - 1]]).toEqual([100, 0]);
      // Écart de chaque point fin de la courbe à la polyligne.
      const dist = (x: number, y: number): number => {
        let best = Infinity;
        for (let k = 0; k + 3 < pts.length; k += 2) {
          const [ax, ay, bx, by] = [pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!];
          const t = Math.max(
            0,
            Math.min(
              1,
              ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
            ),
          );
          best = Math.min(best, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
        }
        return best;
      };
      for (let i = 0; i <= 1000; i++) {
        const t = i / 1000;
        const u = 1 - t;
        const x = 3 * u * u * t * 0 + 3 * u * t * t * 100 + t * t * t * 100;
        const y = 3 * u * u * t * 50 + 3 * u * t * t * 50;
        expect(dist(x, y)).toBeLessThanOrEqual(tol);
      }
    }
    // Plus fin = plus de sommets ; borne de pas par cubique.
    expect(flattenSubpath(sp, 0.01).length).toBeGreaterThan(flattenSubpath(sp, 1).length);
    expect(flattenSubpath(sp, 1e-12).length).toBeLessThanOrEqual(2 * 257);
  });

  it('tolérance réglable et bornée ; NaN → défaut', () => {
    const svg =
      '<svg width="100" height="100"><path fill="#000" d="M0 0C0 50 100 50 100 0Z"/></svg>';
    const s = sceneFromSvg(svg);
    const count = (dxf: string) => (dxf.match(/\r\nVERTEX\r\n/g) ?? []).length;
    expect(count(writeDxf(s, { tolerance: 0.01 }))).toBeGreaterThan(count(writeDxf(s)));
    expect(writeDxf(s, { tolerance: Number.NaN })).toBe(writeDxf(s));
    expect(writeDxf(s, { tolerance: 1e6 })).toBe(writeDxf(s, { tolerance: 10 }));
  });
});

describe('nombres', () => {
  it('jamais d’exposant ni de -0 ; arrondi du bruit flottant', () => {
    expect(fmtNum(1e-7)).toBe('0');
    expect(fmtNum(-0)).toBe('0');
    expect(fmtNum(8 - 7.9)).toBe('0.1');
    expect(fmtNum(123456789.5)).toBe('123456789.5');
    expect(fmtNum(0.0000015)).toBe('0.000002');
    expect(() => fmtNum(Number.NaN)).toThrow(SceneError);
  });
});
