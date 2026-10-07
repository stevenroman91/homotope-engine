// T34 — Séparations : la somme des couches redonne la scène, chaque couche n'a qu'une couleur ;
// SVG à calques Inkscape, un fichier par couleur, ZIP relu par une lib indépendante (fflate),
// couches DXF nommées par le nuancier. Sans DOM.
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  colorKey,
  colorSlug,
  crc32,
  dxfLayerLabel,
  dxfLayerNames,
  exportLayers,
  layeredSvg,
  layersAreZip,
  sceneFromSvg,
  safeStem,
  SeparationError,
  separationColors,
  separationFiles,
  separationScenes,
  separationsZip,
  STACKED_SEPARATIONS_MESSAGE,
  svgIsStacked,
  writeDxf,
  zipStore,
} from '../src/engine/export/index.ts';
import { decodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import { presetOptions } from '../src/engine/presets.ts';
import type { PresetName, RasterImage, Rgb } from '../src/engine/types.ts';
import { rasterizeSvg } from '../src/eval/metrics.ts';

const INKS: Rgb[] = [
  [227, 6, 19],
  [0, 87, 184],
  [255, 255, 255],
  [20, 20, 20],
  [250, 200, 0],
];
const NAMES = {
  '#e30613': 'Rouge client',
  '#0057b8': 'Bleu « nuit » & <co>',
  '#ffffff': 'Blanc',
};

function load(file: string): RasterImage {
  return decodePng(new Uint8Array(readFileSync(`test/fixtures/${file}`)));
}

function svgOf(file: string, preset: PresetName, palette = true): string {
  const o = presetOptions(preset);
  if (palette) o.quantize.fixedPalette = { colors: INKS, dither: false, minCoverage: 0 };
  return vectorize(load(file), o).svg;
}

/** Éléments peints (`<path>`, `<rect>`) d'un SVG, texte brut, dans l'ordre. */
function painted(svg: string): string[] {
  const noMask = svg.replace(/<mask\b[\s\S]*?<\/mask>/g, '');
  return [...noMask.matchAll(/<(?:path|rect)\b[^>]*\/>/g)].map((m) => m[0]);
}

/** Couleur d'un élément (remplissage, sinon trait), en `#rrggbb`. */
function colorOf(raw: string): string {
  const fill = /\sfill="([^"]*)"/.exec(raw)?.[1];
  const c = fill && fill !== 'none' ? fill : /\sstroke="([^"]*)"/.exec(raw)![1]!;
  return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
}

/** Mode découpé : séparations par fichier possibles. */
const CUT: [string, PresetName][] = [
  ['logo-flat.png', 'logo'],
  ['alpha.png', 'logo'],
  ['badge.png', 'logo'],
  ['pixel-art.png', 'pixel-art'],
  ['illustration.png', 'logo'],
];
/**
 * Écart de RENDU toléré (fraction des pixels) : deux formes voisines partagent la MÊME courbe,
 * mais resvg aplatit une cubique différemment selon son sens de parcours ; en rendu net, un
 * pixel dont le centre frôle la courbe peut tomber des deux côtés ou d'aucun. Nul sur les
 * logos et le pixel art (testé à 0) ; borné sur une illustration très courbe.
 */
const RASTER_SLACK: Record<string, number> = { 'illustration.png': 0.002 };
/** Mode empilé (illustration, photo) : calques par séries contiguës seulement. */
const STACKED: [string, PresetName][] = [
  ['logo-flat.png', 'illustration'],
  ['badge.png', 'illustration'],
  ['illustration.png', 'illustration'],
];

const LAYER = /<g id="([^"]+)" inkscape:groupmode="layer" inkscape:label="([^"]*)">(.*?)<\/g>/g;

/** Rendu net (sans anticrénelage) : un pixel est peint ou non, selon son centre. */
const crisp = (svg: string) => svg.replace(/<svg\b/, '<svg shape-rendering="crispEdges"');

const sameRender = (a: string, b: string, w: number) =>
  Buffer.from(rasterizeSvg(a, w).data).equals(Buffer.from(rasterizeSvg(b, w).data));

/** Mutation de référence : regroupement par couleur SANS respecter l'ordre de peinture. */
function groupedByColor(svg: string): string {
  const head = /^[\s\S]*?<svg\b[^>]*>/.exec(svg)![0];
  const els = painted(svg);
  const order: string[] = [];
  for (const e of els) if (!order.includes(colorOf(e))) order.push(colorOf(e));
  const masks = svg.match(/<mask\b[\s\S]*?<\/mask>/g) ?? [];
  return [
    head,
    ...masks,
    ...order.flatMap((c) => els.filter((e) => colorOf(e) === c)),
    '</svg>',
  ].join('');
}

describe('SVG à calques', () => {
  for (const [file, preset] of [...CUT, ...STACKED]) {
    it(`${file} (${preset}) : séries contiguës, ordre de peinture et rendu identiques`, () => {
      const svg = svgOf(file, preset);
      const out = layeredSvg(svg, NAMES);
      expect(out).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
      const layers = [...out.matchAll(LAYER)];
      const all: string[] = [];
      for (const l of layers) {
        const els = painted(l[3]!);
        expect(els.length).toBeGreaterThan(0);
        expect(new Set(els.map(colorOf)).size).toBe(1);
        all.push(...els);
      }
      // Même éléments, dans le MÊME ordre (une couleur regroupée hors ordre rougit ici).
      expect(all).toEqual(painted(svg));
      expect(new Set(layers.map((l) => l[1])).size).toBe(layers.length);
      // Deux calques voisins n'ont jamais la même couleur (séries maximales).
      for (let i = 1; i < layers.length; i++)
        expect(colorOf(painted(layers[i]![3]!)[0]!)).not.toBe(
          colorOf(painted(layers[i - 1]![3]!)[0]!),
        );
      // Le masque de gomme (F1) reste, hors calque.
      expect(out.match(/<mask\b/g)?.length ?? 0).toBe(svg.match(/<mask\b/g)?.length ?? 0);
      expect(sameRender(out, svg, 256)).toBe(true);
    });
  }

  it('mode empilé : une couleur repeinte plus haut a deux calques au même libellé', () => {
    const svg = svgOf('logo-flat.png', 'illustration');
    const layers = [...layeredSvg(svg, NAMES).matchAll(LAYER)];
    const blanc = layers.filter((l) => l[2] === 'Blanc');
    expect(blanc.map((l) => l[1])).toEqual(['couleur-blanc', 'couleur-blanc-2']);
    expect(layers.at(-1)![2]).toBe('Blanc');
  });

  it('la mutation « regrouper par couleur » change le rendu en mode empilé (garde sensible)', () => {
    for (const file of ['logo-flat.png', 'badge.png']) {
      const svg = svgOf(file, 'illustration');
      expect(sameRender(groupedByColor(svg), svg, 256), file).toBe(false);
      expect(sameRender(layeredSvg(svg), svg, 256), file).toBe(true);
    }
  });

  it('noms : identifiants ASCII, libellés échappés, hexadécimal à défaut', () => {
    const out = layeredSvg(svgOf('logo-flat.png', 'logo'), NAMES);
    expect(out).toContain(
      'id="couleur-rouge-client" inkscape:groupmode="layer" inkscape:label="Rouge client"',
    );
    expect(out).toContain('inkscape:label="Bleu « nuit » &amp; &lt;co&gt;"');
    expect(out).toContain('id="couleur-bleu-nuit-co"');
    expect(out).not.toMatch(/inkscape:label="[^"]*[<>]/);
    const plain = layeredSvg(svgOf('logo-flat.png', 'logo'));
    for (const c of separationColors(svgOf('logo-flat.png', 'logo'))) {
      expect(plain).toContain(`id="couleur-${c.slice(1)}"`);
      expect(plain).toContain(`inkscape:label="${c.toUpperCase()}"`);
    }
  });

  it('sans palette imposée aussi (toute couleur du SVG)', () => {
    const svg = svgOf('photo.png', 'photo', false);
    const out = layeredSvg(svg);
    expect(sameRender(out, svg, 200)).toBe(true);
  });

  it('SVG hors du sous-ensemble : refusé', () => {
    expect(() => layeredSvg('<svg width="1" height="1"><circle r="1"/></svg>')).toThrow();
  });
});

describe('un fichier par couleur (zones visibles, mode découpé)', () => {
  for (const [file, preset] of CUT) {
    it(`${file} (${preset}) : une couleur par fichier, disjoints, somme = scène`, () => {
      const img = load(file);
      const o = presetOptions(preset);
      o.quantize.fixedPalette = { colors: INKS, dither: false, minCoverage: 0 };
      // Sans trait anti-liseré : la scène de référence est alors EXACTEMENT ses zones visibles.
      o.export.seamStroke = 0;
      const svg = vectorize(img, o).svg;
      expect(svgIsStacked(svg)).toBe(false);
      const files = separationFiles(svg, 'svg', 'logo', NAMES);
      expect(files.length).toBe(separationColors(svg).length);
      for (const f of files) {
        expect(f.name).toMatch(/^logo-[a-z0-9-]+\.svg$/);
        const scene = sceneFromSvg(f.text);
        expect(new Set(scene.items.map((it) => colorKey(it.rgb))).size).toBe(1);
      }
      for (const w of [256, 512]) {
        const layers = files.map((f) => rasterizeSvg(crisp(f.text), w).data);
        const ref = rasterizeSvg(crisp(svg), w).data;
        let twice = 0;
        let missing = 0;
        let wrong = 0;
        for (let i = 0; i < ref.length; i += 4) {
          const cov = layers.filter((d) => d[i + 3]! > 0);
          if (cov.length > 1) twice++;
          if (ref[i + 3]! > 0 && cov.length === 0) missing++;
          if (cov.length === 1 && [0, 1, 2, 3].some((k) => cov[0]![i + k] !== ref[i + k])) wrong++;
        }
        // Aucun pixel dans deux couches ; leur somme redonne la scène, pixel pour pixel.
        const slack = Math.floor((RASTER_SLACK[file] ?? 0) * (ref.length / 4));
        expect({ w, twice, missing, wrong }, `tolérance ${slack}`).toEqual({
          w,
          twice: Math.min(twice, slack),
          missing: Math.min(missing, slack),
          wrong: Math.min(wrong, slack),
        });
      }
    });
  }

  it('trait anti-liseré omis ; fond = rectangle moins les autres couleurs (evenodd)', () => {
    const svg = svgOf('badge.png', 'logo');
    expect(svg).toMatch(/<path fill="none" stroke=/); // la scène a des traits anti-liseré
    const scenes = separationScenes(svg);
    for (const { scene } of scenes) {
      expect(scene.fillRule).toBe('evenodd');
      for (const it of scene.items) expect(it.fill || it.centerline === true).toBe(true);
    }
    const bg = scenes.find((s) => s.scene.items.some((it) => it.background))!;
    const others = sceneFromSvg(svg).items.filter(
      (it) => it.fill && !it.background && colorKey(it.rgb) !== bg.color,
    );
    expect(bg.scene.items[0]!.subpaths.length).toBe(
      1 + others.reduce((n, it) => n + it.subpaths.length, 0),
    );
  });

  it('mode empilé : refusé avec un message clair (fichiers, ZIP, PDF / EPS « layers »)', () => {
    for (const [file, preset] of STACKED) {
      const svg = svgOf(file, preset);
      expect(svgIsStacked(svg)).toBe(true);
      expect(() => separationFiles(svg, 'svg', 'x')).toThrow(SeparationError);
      expect(() => separationsZip(svg, 'pdf', 'x')).toThrow(STACKED_SEPARATIONS_MESSAGE);
      expect(() => exportLayers(svg, 'eps', 'layers')).toThrow(SeparationError);
      // Le SVG à calques et le DXF à couches restent possibles.
      expect(exportLayers(svg, 'svg', 'layers').ext).toBe('svg');
      expect(exportLayers(svg, 'dxf', 'layers').ext).toBe('dxf');
    }
  });

  it('svgIsStacked : racine evenodd = découpé ; sans tracé rempli (centre-ligne) = non empilé', () => {
    expect(svgIsStacked('<svg fill-rule="evenodd"><path fill="#000" d="M0 0h1v1Z"/></svg>')).toBe(
      false,
    );
    expect(svgIsStacked('<svg><path fill="#000" d="M0 0h1v1Z"/></svg>')).toBe(true);
    expect(
      svgIsStacked(
        '<svg><rect width="100%" height="100%" fill="#fff"/><path fill="none" stroke="#000" stroke-linecap="round" d="M0 0h1"/></svg>',
      ),
    ).toBe(false);
  });

  it('PDF et EPS : une seule couleur de remplissage par fichier', () => {
    const svg = svgOf('badge.png', 'logo');
    for (const format of ['pdf', 'eps'] as const) {
      const files = separationFiles(svg, format, 'img', NAMES);
      expect(files.length).toBe(separationColors(svg).length);
      for (const f of files) {
        const ops = new Set(
          [...f.text.matchAll(/([\d.]+ [\d.]+ [\d.]+) (?:rg|setrgbcolor)/g)].map((m) => m[1]),
        );
        expect(ops.size, f.name).toBe(1);
      }
    }
  });

  it('noms de fichiers uniques même si deux noms se ressemblent', () => {
    const svg = svgOf('logo-flat.png', 'logo');
    const names = { '#e30613': 'Rouge', '#0057b8': 'rouge', '#ffffff': 'Rougé' };
    const files = separationFiles(svg, 'svg', 'x', names);
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
  });

  it('préfixe assaini dans le moteur : ni séparateur, ni « .. », ni contrôle', () => {
    expect(safeStem('../../etc/passwd')).toBe('____etc_passwd');
    expect(safeStem('a\\b/c:d\u0000e')).toBe('a_b_c_d_e');
    expect(safeStem('..')).toBe('_');
    expect(safeStem('  .. ')).toBe('_');
    expect(safeStem('')).toBe('image');
    expect(safeStem('Logo été')).toBe('Logo été');
    const svg = svgOf('logo-flat.png', 'logo');
    for (const f of separationFiles(svg, 'svg', '../x/y')) expect(f.name).not.toMatch(/[\\/]|\.\./);
  });

  it('colorSlug : accents retirés, hexadécimal à défaut', () => {
    expect(colorSlug('#e30613', { '#e30613': 'Rouge Écarlate 485 C' })).toBe(
      'rouge-ecarlate-485-c',
    );
    expect(colorSlug('#e30613', { '#e30613': '***' })).toBe('e30613');
    expect(colorSlug('#e30613')).toBe('e30613');
  });
});

describe('ZIP sans dépendance', () => {
  it('CRC-32 de référence', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('relu par fflate : noms UTF-8 et contenus intacts', () => {
    const zip = zipStore([
      { name: 'a.svg', data: new TextEncoder().encode('<svg/>') },
      { name: 'logo-écarlate.txt', data: new TextEncoder().encode('é€') },
      { name: 'vide', data: new Uint8Array(0) },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['a.svg', 'logo-écarlate.txt', 'vide']);
    expect(strFromU8(files['logo-écarlate.txt']!)).toBe('é€');
    expect(files.vide!.length).toBe(0);
  });

  it('nom en double : refusé ; déterministe', () => {
    const e = { name: 'a', data: new Uint8Array([1]) };
    expect(() => zipStore([e, e])).toThrow();
    expect(zipStore([e])).toEqual(zipStore([e]));
  });

  it('séparations en ZIP : un fichier par couleur, relu', () => {
    const svg = svgOf('badge.png', 'logo');
    for (const format of ['svg', 'pdf', 'eps', 'dxf'] as const) {
      const files = unzipSync(separationsZip(svg, format, 'badge', NAMES));
      const names = Object.keys(files);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toMatch(new RegExp(`^badge-[a-z0-9-]+\\.${format}$`));
      if (format === 'svg') {
        expect(names.length).toBe(separationColors(svg).length);
        for (const n of names) sceneFromSvg(strFromU8(files[n]!));
      }
    }
  });
});

describe('DXF : couches nommées par le nuancier', () => {
  it('dxfLayerLabel : nom R12 valide', () => {
    expect(dxfLayerLabel('Rouge client é')).toBe('ROUGE_CLIENT_E');
    expect(dxfLayerLabel('  ** ')).toBe('');
    expect(dxfLayerLabel('x'.repeat(40))).toHaveLength(31);
  });

  it('dxfLayerNames : nom, sinon hexadécimal, jamais de doublon ni « 0 »', () => {
    const names = dxfLayerNames(
      [
        [227, 6, 19],
        [0, 87, 184],
        [1, 1, 1],
        [2, 2, 2],
      ],
      { '#e30613': 'Rouge', '#0057b8': 'rouge', '#010101': '0' },
    );
    expect(names).toEqual(['ROUGE', '0057B8', '010101', '020202']);
  });

  it('writeDxf : LAYER et entités sous le nom du nuancier', () => {
    const svg = svgOf('logo-flat.png', 'logo');
    const dxf = writeDxf(sceneFromSvg(svg), { names: NAMES });
    expect(dxf).toContain('\r\n2\r\nROUGE_CLIENT\r\n');
    expect(dxf).toContain('\r\n8\r\nROUGE_CLIENT\r\n');
    expect(dxf).not.toContain('\r\n8\r\nE30613\r\n');
    // Sans noms : comme T32.
    expect(writeDxf(sceneFromSvg(svg))).toContain('\r\n8\r\nE30613\r\n');
  });
});

describe('exportLayers', () => {
  const svg = svgOf('logo-flat.png', 'logo');

  it('layers : SVG à calques, DXF nommé ; PDF et EPS en ZIP', () => {
    const s = exportLayers(svg, 'svg', 'layers', { names: NAMES });
    expect(s.ext).toBe('svg');
    expect(new TextDecoder().decode(s.data)).toBe(layeredSvg(svg, NAMES));
    const d = exportLayers(svg, 'dxf', 'layers', { names: NAMES, tolerance: 0.5 });
    expect(d.ext).toBe('dxf');
    expect(strFromU8(d.data, true)).toBe(
      writeDxf(sceneFromSvg(svg), { names: NAMES, tolerance: 0.5 }),
    );
    for (const f of ['pdf', 'eps'] as const) {
      const z = exportLayers(svg, f, 'layers', { stem: 'logo' });
      expect(z).toMatchObject({ ext: 'zip', mime: 'application/zip' });
      expect(Object.keys(unzipSync(z.data)).every((n) => n.endsWith(`.${f}`))).toBe(true);
    }
  });

  it('zip : toujours un ZIP', () => {
    for (const f of ['svg', 'pdf', 'eps', 'dxf'] as const) {
      expect(layersAreZip(f, 'zip')).toBe(true);
      expect(exportLayers(svg, f, 'zip').ext).toBe('zip');
    }
    expect(layersAreZip('svg', 'layers')).toBe(false);
    expect(layersAreZip('dxf', 'layers')).toBe(false);
  });
});

describe('T34 × T33 : séparations d’un tracé centre-ligne', () => {
  /** Centre-ligne avec le fond (couleur du papier) : deux couches, papier et traits. */
  function centerlineSvg(): string {
    const o = presetOptions('centerline');
    o.export.backgroundRect = true;
    return vectorize(load('line-drawing.png'), o).svg;
  }

  it('chaque calque n’a qu’une couleur ; celui de l’encre ne contient que ses traits', () => {
    const svg = centerlineSvg();
    const colors = separationColors(svg);
    expect(colors.length).toBe(2);
    const out = layeredSvg(svg);
    const layers = [...out.matchAll(/<g id="[^"]+" inkscape:groupmode="layer"[^>]*>(.*?)<\/g>/g)];
    expect(layers.length).toBe(2);
    const all: string[] = [];
    for (const l of layers) {
      const els = painted(l[1]!);
      expect(new Set(els.map(colorOf)).size).toBe(1);
      all.push(...els);
    }
    expect(all.sort()).toEqual(painted(svg).sort());
    const ink = painted(layers[1]![1]!);
    expect(ink.length).toBeGreaterThan(0);
    for (const e of ink)
      expect(e).toMatch(/^<path fill="none" stroke="#[0-9a-f]{6}"[^>]*stroke-linecap="round"/);
    expect(Buffer.from(rasterizeSvg(out, 200).data)).toEqual(
      Buffer.from(rasterizeSvg(svg, 200).data),
    );
  });

  it('ZIP DXF : le fichier de l’encre porte ses traits (polylignes ouvertes), le fond non', () => {
    const svg = centerlineSvg();
    const files = separationFiles(svg, 'dxf', 'dessin');
    expect(files.length).toBe(1);
    const ink = separationColors(svg)[1]!;
    expect(files[0]!.name).toBe(`dessin-${ink.slice(1)}.dxf`);
    expect(files[0]!.text).toContain('POLYLINE');
    expect(files[0]!.text).toMatch(/\r\n70\r\n0\r\n/); // au moins une polyligne ouverte
    expect(separationFiles(svg, 'dxf', 'dessin', {}, { includeBackground: true })).toHaveLength(2);
  });
});
