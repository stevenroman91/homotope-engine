/**
 * T32 / T35 — Polylignes de découpe d'une scène : aplatissement des cubiques (DXF) et choix des
 * éléments découpés. Partagé par l'écrivain DXF (`dxf.ts`) et le contrôle « prêt pour la
 * découpe » (`../cutcheck/`) : l'analyse porte exactement sur ce que la découpeuse recevra.
 * Pur, sans DOM.
 */
import type { ParsedSegment, ParsedSubpath } from '../svg/parse.ts';
import type { SceneItem, VectorScene } from './scene.ts';

/** Millimètres par px (1 px = 1 pt), l'unité de tous les exports. */
export const MM_PER_PX = 25.4 / 72;

/** Pas d'aplatissement au plus par cubique (garde contre une tolérance absurde). */
const MAX_STEPS = 256;

/**
 * Éléments découpés (DXF) dans l'ordre de peinture : les remplissages (leur contour) et les
 * traits d'axe du centre-ligne (T33). Le trait anti-liseré (repasse du même contour) n'en est
 * pas ; le `<rect>` de fond non plus, sauf `includeBackground` (un cadre autour du motif).
 */
export function cutItems(scene: VectorScene, includeBackground = false): SceneItem[] {
  return scene.items.filter(
    (it) => (it.fill || it.centerline === true) && (includeBackground || !it.background),
  );
}

type Cubic = Extract<ParsedSegment, { kind: 'cubic' }>;

/**
 * Sens « canonique » d'une cubique p0 → p3 : le plus petit des deux points extrêmes (puis des
 * points de contrôle) dans l'ordre lexicographique. Une cubique et sa copie inversée (frontière
 * commune de deux faces, parcourue une fois par sens) ont le même sens canonique.
 */
function forwardIsCanonical(px: number, py: number, s: Cubic): boolean {
  const a = [px, py, s.c1x, s.c1y];
  const b = [s.x, s.y, s.c2x, s.c2y];
  for (let k = 0; k < 4; k++) if (a[k] !== b[k]) return a[k]! < b[k]!;
  return true;
}

/**
 * Polyligne d'un sous-tracé, points entrelacés [x0, y0, …] en coordonnées du SVG : départ,
 * points intermédiaires des cubiques, fins de segment. Le dernier point est retiré s'il
 * revient sur le départ (la polyligne est fermée). Nombre de pas d'une cubique :
 * √(3·L / (4·tol)), L = max des normes des différences secondes des points de contrôle
 * (borne classique de l'écart d'une cubique à sa corde).
 *
 * `canonical` (T35) : chaque cubique est échantillonnée dans son sens canonique, puis les
 * points remis dans le sens du tracé ; une cubique et sa copie inversée donnent alors
 * EXACTEMENT les mêmes points (au bit près), ce qui permet de reconnaître une frontière
 * commune. Sans lui (DXF ordinaire), le calcul est celui de T32, inchangé.
 */
export function flattenSubpath(
  sp: ParsedSubpath,
  tolerance: number,
  canonical = false,
): Float64Array {
  // Sous-tracé ouvert (T33) : le dernier point n'est jamais retiré.
  const pts: number[] = [sp.start[0], sp.start[1]];
  let px = sp.start[0];
  let py = sp.start[1];
  for (const s of sp.segments) {
    if (s.kind === 'cubic') {
      const ax = px - 2 * s.c1x + s.c2x;
      const ay = py - 2 * s.c1y + s.c2y;
      const bx = s.c1x - 2 * s.c2x + s.x;
      const by = s.c1y - 2 * s.c2y + s.y;
      const L = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt((3 * L) / (4 * tolerance)))));
      if (!canonical || forwardIsCanonical(px, py, s)) {
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const e = t * t * t;
          pts.push(
            a * px + b * s.c1x + c * s.c2x + e * s.x,
            a * py + b * s.c1y + c * s.c2y + e * s.y,
          );
        }
      } else {
        // Échantillonnée de p3 vers p0 (sens canonique), points remis dans le sens du tracé.
        const tmp: number[] = [];
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const e = t * t * t;
          tmp.push(
            a * s.x + b * s.c2x + c * s.c1x + e * px,
            a * s.y + b * s.c2y + c * s.c1y + e * py,
          );
        }
        for (let k = tmp.length - 2; k >= 0; k -= 2) pts.push(tmp[k]!, tmp[k + 1]!);
      }
    }
    pts.push(s.x, s.y);
    px = s.x;
    py = s.y;
  }
  const n = pts.length;
  if (sp.closed && n > 2 && pts[n - 2] === sp.start[0] && pts[n - 1] === sp.start[1])
    pts.length = n - 2;
  return Float64Array.from(pts);
}
