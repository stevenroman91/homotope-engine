/**
 * Vérification simple de bonne formation XML (sans dépendance) : balises
 * équilibrées et bien imbriquées, une seule racine, noms valides, attributs
 * cités et non répétés, entités connues, aucun texte hors racine. Suffisant
 * pour le SVG émis par Homotope ; ce n'est pas un parseur XML complet (ni
 * DOCTYPE, ni CDATA, ni instructions de traitement autres que `<?xml …?>`).
 * Renvoie la liste des problèmes (vide si bien formé).
 */
export function wellFormedErrors(xml: string): string[] {
  const errs: string[] = [];
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const NAME = /^[A-Za-z_:][\w:.-]*$/;
  const ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos);/y;

  const checkText = (text: string, at: number): void => {
    for (let k = 0; k < text.length; k++) {
      if (text[k] !== '&') continue;
      ENTITY.lastIndex = k;
      if (!ENTITY.test(text)) errs.push(`entité invalide en ${at + k}`);
    }
  };

  if (xml.startsWith('<?xml')) {
    const e = xml.indexOf('?>');
    if (e < 0) return ['déclaration XML non fermée'];
    i = e + 2;
  }
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (text.includes('>')) errs.push(`« > » isolé en ${i}`);
    if (stack.length === 0 && text.trim() !== '') errs.push(`texte hors racine en ${i}`);
    checkText(text, i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) {
        errs.push(`commentaire non fermé en ${lt}`);
        break;
      }
      i = e + 3;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) {
      errs.push(`balise non fermée en ${lt}`);
      break;
    }
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open !== name) errs.push(`</${name}> ferme <${open ?? '∅'}> en ${lt}`);
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
    if (!m || !NAME.test(m[1]!)) {
      errs.push(`nom de balise invalide en ${lt}`);
      continue;
    }
    const name = m[1]!;
    const attrs = m[2]!;
    const seen = new Set<string>();
    const ATTR = /\s+([^\s=]+)\s*=\s*("([^"<]*)"|'([^'<]*)')|(\S+)/g;
    for (const a of attrs.matchAll(ATTR)) {
      if (a[5]) {
        errs.push(`attribut mal formé « ${a[5]} » dans <${name}>`);
        continue;
      }
      const an = a[1]!;
      if (!NAME.test(an)) errs.push(`nom d'attribut invalide « ${an} »`);
      if (seen.has(an)) errs.push(`attribut ${an} répété dans <${name}>`);
      seen.add(an);
      checkText(a[3] ?? a[4] ?? '', lt);
    }
    if (stack.length === 0) {
      roots++;
      if (roots > 1) errs.push(`seconde racine <${name}> en ${lt}`);
    }
    if (!selfClose) stack.push(name);
  }
  if (stack.length > 0) errs.push(`balises non fermées : ${stack.join(', ')}`);
  if (roots === 0) errs.push('aucun élément racine');
  return errs;
}

/** Fin de balise (`>`) en ignorant les `>` à l'intérieur des valeurs citées. */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let k = from; k < xml.length; k++) {
    const c = xml[k]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return k;
    else if (c === '<') return -1;
  }
  return -1;
}
