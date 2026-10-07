/**
 * T32 — PDF 1.4 vectoriel minimal, écrit à la main (aucune dépendance), depuis la scène du
 * SVG (`scene.ts`). Une page, `MediaBox` à la taille de l'image, 1 px = 1 pt ; flux de contenu
 * non compressé, ASCII seul (les décalages de la table `xref` sont donc des longueurs de
 * chaîne). Remplissage `f*` (pair-impair, mode découpé) ou `f` (non nul, mode empilé), couleurs
 * RVB, `fill-opacity` par un état graphique `/ca`, trait anti-liseré en `S` (joint rond) ;
 * trait d'axe du centre-ligne (T33) en `S` à bouts ronds (`1 J`), sous-tracés ouverts.
 */
import { fmtNum, paintedItems, pathOps, unit, type VectorScene } from './scene.ts';

export const PDF_MIME = 'application/pdf';

/** Écrit le PDF d'une scène (chaîne ASCII). */
export function writePdf(scene: VectorScene): string {
  const H = scene.height;
  const eo = scene.fillRule === 'evenodd' ? '*' : '';
  const alphas: number[] = [];
  const gsOf = (o: number): string => {
    let k = alphas.indexOf(o);
    if (k < 0) k = alphas.push(o) - 1;
    return `/G${k}`;
  };
  const body: string[] = ['1 j'];
  for (const it of paintedItems(scene)) {
    const [r, g, b] = it.rgb.map(unit) as [string, string, string];
    const stroke = it.stroke !== undefined;
    const ops: string[] = [];
    if (it.opacity !== undefined) ops.push('q', `${gsOf(it.opacity)} gs`);
    if (it.fill) ops.push(`${r} ${g} ${b} rg`);
    if (stroke) ops.push(`${r} ${g} ${b} RG`, `${fmtNum(it.stroke!)} w`);
    if (it.centerline) ops.push('1 J');
    ops.push(pathOps(it.subpaths, H));
    ops.push(it.fill ? (stroke ? `B${eo}` : `f${eo}`) : 'S');
    if (it.centerline) ops.push('0 J');
    if (it.opacity !== undefined) ops.push('Q');
    body.push(ops.join('\n'));
  }
  const content = body.join('\n') + '\n';

  const W = fmtNum(scene.width);
  const Hs = fmtNum(H);
  const gsBase = 5;
  const extG = alphas.length
    ? ` /ExtGState << ${alphas.map((_, k) => `/G${k} ${gsBase + k} 0 R`).join(' ')} >>`
    : '';
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hs}] /Resources <<${extG} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ...alphas.map((o) => `<< /Type /ExtGState /ca ${fmtNum(o, 4)} >>`),
    '<< /Producer (Homotope) >>',
  ];
  const infoId = objects.length;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, k) => {
    offsets.push(out.length);
    out += `${k + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return out;
}
