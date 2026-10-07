/**
 * T32 — EPS 3.0 (PostScript niveau 2) depuis la scène du SVG (`scene.ts`), sans dépendance.
 * 1 px = 1 pt ; `%%BoundingBox` entière (arrondie vers l'extérieur) et `%%HiResBoundingBox`
 * exacte ; rognage à la boîte (le SVG rogne au `viewBox`). `eofill` (pair-impair) ou `fill`
 * (non nul) selon la règle du SVG. PostScript n'a pas de transparence : une couleur
 * translucide (`fill-opacity`) est peinte opaque (README « Décisions », T32). Trait d'axe du
 * centre-ligne (T33) : `stroke` à bouts ronds (`1 setlinecap`), sous-tracés ouverts.
 */
import { fmtNum, paintedItems, pathOps, unit, type VectorScene } from './scene.ts';

export const EPS_MIME = 'application/postscript';

/** Écrit l'EPS d'une scène (chaîne ASCII, lignes de 255 caractères au plus). */
export function writeEps(scene: VectorScene): string {
  const W = fmtNum(scene.width);
  const H = fmtNum(scene.height);
  const fill = scene.fillRule === 'evenodd' ? 'eofill' : 'fill';
  const out: string[] = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(scene.width)} ${Math.ceil(scene.height)}`,
    `%%HiResBoundingBox: 0 0 ${W} ${H}`,
    '%%Creator: Homotope',
    '%%LanguageLevel: 2',
    '%%EndComments',
    '%%BeginProlog',
    '/m /moveto load def /l /lineto load def /c /curveto load def /h /closepath load def',
    '%%EndProlog',
    'gsave',
    `newpath 0 0 m ${W} 0 l ${W} ${H} l 0 ${H} l h clip newpath`,
    '1 setlinejoin',
  ];
  for (const it of paintedItems(scene)) {
    const [r, g, b] = it.rgb.map(unit) as [string, string, string];
    out.push(`${r} ${g} ${b} setrgbcolor`, 'newpath', pathOps(it.subpaths, scene.height));
    if (it.stroke === undefined) out.push(fill);
    else {
      const cap = it.centerline ? ['1 setlinecap ', ' 0 setlinecap'] : ['', ''];
      const w = `${cap[0]}${fmtNum(it.stroke)} setlinewidth stroke${cap[1]}`;
      out.push(it.fill ? `gsave ${fill} grestore ${w}` : w);
    }
  }
  out.push('grestore', 'showpage', '%%Trailer', '%%EOF');
  return out.join('\n') + '\n';
}
