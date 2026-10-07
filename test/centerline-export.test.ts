import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertSvg, sceneFromSvg } from '../src/engine/export/index.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import { parsePathData } from '../src/engine/svg/parse.ts';

/**
 * T33 × T32 — Les exports PDF, EPS et DXF d'un tracé centre-ligne (fixture `line-drawing`)
 * gardent les TRAITS : polylignes ouvertes dans le DXF, `S` à bouts ronds dans le PDF et
 * l'EPS, avec leur épaisseur.
 */
const image = decodePng(new Uint8Array(readFileSync('test/fixtures/line-drawing.png')));
const result = vectorize(image, presetOptions('centerline'));
const svg = result.svg;

/** Sous-tracés du SVG : ouverts et fermés (boucles). */
const subpaths = [...svg.matchAll(/ d="([^"]*)"/g)].flatMap((m) => parsePathData(m[1]!));
const open = subpaths.filter((s) => !s.closed).length;
const closed = subpaths.length - open;

describe('T33 — exports du tracé centre-ligne', () => {
  it('la scène lit les traits d’axe (sans remplissage, avec leur épaisseur)', () => {
    const scene = sceneFromSvg(svg);
    expect(scene.items.length).toBeGreaterThan(0);
    for (const it of scene.items) {
      expect(it.fill).toBe(false);
      expect(it.centerline).toBe(true);
      expect(it.stroke).toBeGreaterThan(0);
    }
    expect(open).toBeGreaterThan(10);
    expect(closed).toBeGreaterThan(0); // anneau du soleil, cœur de la fleur
    expect(open + closed).toBe(result.stats.strokes);
  });

  it('DXF : une POLYLINE par passage, ouverte (70 = 0) sauf les boucles, couche de l’encre', () => {
    const dxf = convertSvg(svg, 'dxf');
    const lines = dxf.split('\r\n');
    const flags: string[] = [];
    lines.forEach((l, k) => {
      if (l === 'POLYLINE') {
        const at = lines.indexOf('70', k);
        flags.push(lines[at + 1]!);
      }
    });
    expect(flags).toHaveLength(open + closed);
    expect(flags.filter((f) => f === '0')).toHaveLength(open);
    expect(flags.filter((f) => f === '1')).toHaveLength(closed);
    expect(dxf).toContain('\r\n18161C\r\n'); // couche = couleur de l'encre
  });

  it('PDF : trait `S` à bouts ronds, épaisseur, aucun remplissage', () => {
    const pdf = convertSvg(svg, 'pdf');
    const content = /stream\n([\s\S]*?)endstream/.exec(pdf)![1]!;
    expect(content).toContain('1 J');
    expect(content.match(/^S$/gm)?.length).toBe(sceneFromSvg(svg).items.length);
    expect(content).not.toMatch(/^f\*?$/m);
    for (const w of new Set([...svg.matchAll(/stroke-width="([^"]*)"/g)].map((m) => m[1]!)))
      expect(content).toContain(`${Number(w)} w`);
    // Sous-tracés ouverts : un `h` par boucle seulement.
    expect(content.match(/^h$/gm)?.length ?? 0).toBe(closed);
  });

  it('EPS : `stroke` à bouts ronds, aucun remplissage', () => {
    const eps = convertSvg(svg, 'eps');
    expect(eps).toContain('1 setlinecap');
    expect(eps).not.toMatch(/\beofill\b|^fill$/m);
    expect(eps.match(/setlinewidth stroke/g)?.length).toBe(sceneFromSvg(svg).items.length);
  });

  it('un trait anti-liseré (logo) reste une simple repasse : absent du DXF, bouts inchangés', () => {
    const logo = vectorize(
      decodePng(new Uint8Array(readFileSync('test/fixtures/logo-aa.png'))),
      presetOptions('logo'),
    ).svg;
    expect(sceneFromSvg(logo).items.some((it) => it.centerline)).toBe(false);
    expect(convertSvg(logo, 'pdf')).not.toContain('1 J');
  });
});
