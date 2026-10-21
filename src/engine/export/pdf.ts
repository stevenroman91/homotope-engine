/**
 * T32 — PDF 1.4 vectoriel minimal, écrit à la main (aucune dépendance), depuis la scène du
 * SVG (`scene.ts`). Une page, `MediaBox` à la taille de l'image, 1 px = 1 pt ; flux de contenu
 * non compressé, ASCII seul (les décalages de la table `xref` sont donc des longueurs de
 * chaîne). Remplissage `f*` (pair-impair, mode découpé) ou `f` (non nul, mode empilé), couleurs
 * RVB, `fill-opacity` par un état graphique `/ca`, trait anti-liseré en `S` (joint rond) ;
 * trait d'axe du centre-ligne (T33) en `S` à bouts ronds (`1 J`), sous-tracés ouverts.
 * T95 — Contour de découpe sticker : tracé APRÈS le dessin, sans remplissage, en couleur
 * d'accompagnement `/Separation /CutContour` (repli 100 % magenta), dans le contenu facultatif
 * (calque) nommé `CutContour` ; le fichier passe alors en PDF 1.5 (calques). Sans contour, le
 * fichier est inchangé à l'octet.
 */
import { CUT_CONTOUR } from './cutcontour.ts';
import { cutContourItems, fmtNum, paintedItems, pathOps, unit, type VectorScene } from './scene.ts';

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
  const contour = cutContourItems(scene);
  if (contour.length > 0) {
    body.push(
      ['/OC /MC0 BDC', 'q', '/CS0 CS', '1 SCN', `${fmtNum(CUT_CONTOUR.strokeWidth)} w`]
        .concat(contour.map((it) => `${pathOps(it.subpaths, H)}\nS`))
        .concat(['Q', 'EMC'])
        .join('\n'),
    );
  }
  const content = body.join('\n') + '\n';

  const W = fmtNum(scene.width);
  const Hs = fmtNum(H);
  const gsBase = 5;
  const extG = alphas.length
    ? ` /ExtGState << ${alphas.map((_, k) => `/G${k} ${gsBase + k} 0 R`).join(' ')} >>`
    : '';
  // T95 : calque (groupe de contenu facultatif) et couleur d'accompagnement du contour.
  const ocgId = gsBase + alphas.length;
  const csId = ocgId + 1;
  const cut = contour.length > 0;
  const [c, m, y, k] = CUT_CONTOUR.cmyk;
  const cutRes = cut
    ? ` /ColorSpace << /CS0 ${csId} 0 R >> /Properties << /MC0 ${ocgId} 0 R >>`
    : '';
  const ocProps = cut
    ? ` /OCProperties << /OCGs [${ocgId} 0 R] /D << /Order [${ocgId} 0 R] /ON [${ocgId} 0 R] >> >>`
    : '';
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${ocProps} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hs}] /Resources <<${extG}${cutRes} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ...alphas.map((o) => `<< /Type /ExtGState /ca ${fmtNum(o, 4)} >>`),
    ...(cut
      ? [
          `<< /Type /OCG /Name (${CUT_CONTOUR.name}) >>`,
          `[/Separation /${CUT_CONTOUR.name} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [${c} ${m} ${y} ${k}] /N 1 >>]`,
        ]
      : []),
    '<< /Producer (Homotope) >>',
  ];
  const infoId = objects.length;
  let out = cut ? '%PDF-1.5\n' : '%PDF-1.4\n';
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
