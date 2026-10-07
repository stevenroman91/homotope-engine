/**
 * T32 — DXF R12 ASCII (AC1009) depuis la scène du SVG (`scene.ts`), sans dépendance.
 *
 * R12 est la version que lisent TOUS les logiciels de découpe (LightBurn, Silhouette Studio,
 * Inkscape, LibreCAD…) ; R2000 apporte `LWPOLYLINE` et `SPLINE`, que Silhouette et plusieurs
 * pilotes de découpe lisent mal. Chaque sous-tracé devient une `POLYLINE` FERMÉE (drapeau 1) ;
 * les cubiques sont aplaties à `tolerance` près (écart maximal à la courbe, en px d'origine),
 * les sommets d'ancrage du SVG sont conservés tels quels. Une couche (`LAYER`) par couleur,
 * nommée par sa valeur hexadécimale (`FF8800`), ou par son nom de nuancier (T34, `names`) ; trous et extérieurs sont des contours fermés
 * comme les autres (la découpe suit le contour). Le DXF n'a pas de remplissage : seul le
 * contour compte ; le trait anti-liseré (une repasse du même contour) est omis, et le `<rect>`
 * de fond aussi (sauf `includeBackground`) : la découpeuse couperait un cadre autour du motif.
 * T33 — Un trait d'axe du centre-ligne est, lui, la forme à tracer : chaque sous-tracé devient
 * une `POLYLINE` OUVERTE (drapeau 0 ; fermée seulement pour une boucle `Z`), une passe ;
 * l'épaisseur n'est pas écrite (c'est celle de l'outil).
 *
 * Unité : millimètre (`$INSUNITS` = 4), 1 px = 1 pt = 25,4 / 72 mm, comme le PDF et l'EPS ;
 * Y vers le haut (`y' = height − y`).
 */
import { cutGeometry } from '../cutcheck/geometry.ts';
import { mergedPolylines } from '../cutcheck/network.ts';
import { cutItems, flattenSubpath, MM_PER_PX } from './polyline.ts';
import { fmtNum, type Rgb, type VectorScene } from './scene.ts';

export { flattenSubpath, MM_PER_PX } from './polyline.ts';

export const DXF_MIME = 'application/dxf';
/** Tolérance d'aplatissement par défaut (px d'origine) : 0,035 mm à 1 px = 1 pt. */
export const DXF_DEFAULT_TOLERANCE = 0.1;
/** Bornes de la tolérance (px). */
export const DXF_MIN_TOLERANCE = 0.001;
export const DXF_MAX_TOLERANCE = 10;
/** Décimales en mm : 1e-7 mm ≈ 3e-7 px, sous la tolérance 1e-6 des tests. */
const MM_DECIMALS = 7;

export interface DxfOptions {
  /** Écart maximal (px d'origine) entre la polyligne et la cubique ; défaut 0,1. */
  tolerance?: number;
  /**
   * Garder le `<rect>` de fond comme contour (défaut : NON). Ce n'est pas une forme : un
   * cadre de la taille de l'image que la découpeuse couperait autour du motif. Sans lui, les
   * frontières des faces de fond restent tracées par les contours de leurs voisines.
   */
  includeBackground?: boolean;
  /**
   * T34 — Noms de nuancier par couleur (`#rrggbb` minuscule → nom) : la couche d'une couleur
   * nommée porte ce nom, ramené aux caractères d'un nom R12 (`dxfLayerNames`).
   */
  names?: Readonly<Record<string, string>>;
  /**
   * T35 — Fusionner les frontières communes : un segment parcouru par deux formes (frontière
   * de deux faces voisines en mode « Découpé », contours superposés) n'est écrit qu'UNE fois,
   * sur la couche de la première forme dans l'ordre de peinture ; les contours deviennent des
   * polylignes ouvertes là où leur frontière a déjà été écrite (README « Prêt pour la découpe »).
   */
  mergeShared?: boolean;
}

/** Polyligne à écrire : couleur (couche), points [x0, y0, …] en px du SVG, fermeture. */
export interface DxfPolyline {
  rgb: Rgb;
  pts: Float64Array;
  closed: boolean;
}

/** Couche d'une couleur : hexadécimal majuscule à 6 chiffres (nom R12 valide). */
export function layerName(rgb: Rgb): string {
  return rgb
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** T34 — Clé d'une couleur dans une table de noms : `#rrggbb` minuscule. */
export function colorKey(rgb: Rgb): string {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * T34 — Nom de couche R12 d'un nom de nuancier : accents retirés, majuscules, 31 caractères
 * parmi `A-Z 0-9 $ _ -` (le reste devient `_`) ; vide si rien n'en reste.
 */
export function dxfLayerLabel(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9$_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 31);
}

/**
 * T34 — Noms de couche, dans l'ordre des couleurs : le nom de nuancier s'il existe et reste
 * libre, sinon l'hexadécimal (`layerName`) ; jamais `0` (couche par défaut) ni un doublon.
 */
export function dxfLayerNames(
  colors: readonly Rgb[],
  names: Readonly<Record<string, string>> = {},
): string[] {
  const used = new Set(['0']);
  return colors.map((rgb) => {
    const named = names[colorKey(rgb)];
    let name = named ? dxfLayerLabel(named) : '';
    if (!name || used.has(name)) name = layerName(rgb);
    for (let i = 2; used.has(name); i++) name = `${layerName(rgb)}_${i}`;
    used.add(name);
    return name;
  });
}

/** Couleurs ACI 1..9 (R12 n'a pas de couleur vraie) ; 7 = blanc OU noir selon le fond. */
const ACI: [number, Rgb][] = [
  [1, [255, 0, 0]],
  [2, [255, 255, 0]],
  [3, [0, 255, 0]],
  [4, [0, 255, 255]],
  [5, [0, 0, 255]],
  [6, [255, 0, 255]],
  [7, [255, 255, 255]],
  [7, [0, 0, 0]],
  [8, [128, 128, 128]],
  [9, [192, 192, 192]],
];

/** Couleur ACI la plus proche (affichage seulement : la couche porte la couleur exacte). */
export function nearestAci(rgb: Rgb): number {
  let best = 7;
  let bestD = Infinity;
  for (const [aci, c] of ACI) {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = aci;
    }
  }
  return best;
}

/** Bornée à [DXF_MIN_TOLERANCE, DXF_MAX_TOLERANCE] ; absente ou invalide : le défaut. */
export function dxfTolerance(raw: number | undefined): number {
  const t = raw ?? DXF_DEFAULT_TOLERANCE;
  return Math.min(
    DXF_MAX_TOLERANCE,
    Math.max(DXF_MIN_TOLERANCE, Number.isFinite(t) ? t : DXF_DEFAULT_TOLERANCE),
  );
}

/** Écrit le DXF R12 d'une scène (chaîne ASCII, fins de ligne `\r\n` comme AutoCAD). */
export function writeDxf(scene: VectorScene, options: DxfOptions = {}): string {
  const tolerance = dxfTolerance(options.tolerance);
  const filled = cutItems(scene, options.includeBackground === true);
  const polylines: DxfPolyline[] = [];
  if (options.mergeShared === true) {
    const geom = cutGeometry(scene, {
      tolerance,
      includeBackground: options.includeBackground === true,
    });
    for (const pl of mergedPolylines(geom))
      polylines.push({ rgb: geom.items[pl.item]!.rgb, pts: pl.pts, closed: pl.closed });
  } else {
    for (const it of filled)
      for (const sp of it.subpaths)
        polylines.push({
          rgb: it.rgb,
          pts: flattenSubpath(sp, tolerance),
          closed: it.fill || sp.closed,
        });
  }
  return writeDxfPolylines(
    scene.width,
    scene.height,
    filled.map((it) => it.rgb),
    polylines,
    options.names,
  );
}

/**
 * Écrit un DXF R12 depuis des polylignes déjà calculées (`writeDxf`, et la simplification pour
 * la découpe de T35). `layerColors` : couleurs des couches, dans l'ordre de peinture ; `names` :
 * noms de nuancier (T34).
 */
export function writeDxfPolylines(
  width: number,
  H: number,
  layerColors: readonly Rgb[],
  polylines: readonly DxfPolyline[],
  layerNames?: Readonly<Record<string, string>>,
): string {
  const mm = (v: number): string => fmtNum(v * MM_PER_PX, MM_DECIMALS);
  const out: string[] = [];
  const g = (code: number, value: string | number): void => {
    out.push(String(code), String(value));
  };

  // Couches dans l'ordre de première apparition (ordre de peinture).
  const byColor = new Map<string, Rgb>();
  for (const rgb of layerColors) {
    const key = colorKey(rgb);
    if (!byColor.has(key)) byColor.set(key, rgb);
  }
  const names = dxfLayerNames([...byColor.values()], layerNames);
  const layerOf = new Map([...byColor.keys()].map((k, i) => [k, names[i]!]));
  const layers = new Map([...byColor.values()].map((rgb, i) => [names[i]!, rgb]));

  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, 4);
  g(9, '$EXTMIN');
  g(10, 0);
  g(20, 0);
  g(30, 0);
  g(9, '$EXTMAX');
  g(10, mm(width));
  g(20, mm(H));
  g(30, 0);
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, 1);
  g(0, 'LTYPE');
  g(2, 'CONTINUOUS');
  g(70, 0);
  g(3, 'Solid line');
  g(72, 65);
  g(73, 0);
  g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layers.size + 1);
  for (const [name, rgb] of [['0', [255, 255, 255]] as [string, Rgb], ...layers]) {
    g(0, 'LAYER');
    g(2, name);
    g(70, 0);
    g(62, name === '0' ? 7 : nearestAci(rgb));
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const pl of polylines) {
    const layer = layerOf.get(colorKey(pl.rgb))!;
    const pts = pl.pts;
    g(0, 'POLYLINE');
    g(8, layer);
    g(66, 1);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(70, pl.closed ? 1 : 0);
    for (let k = 0; k < pts.length; k += 2) {
      g(0, 'VERTEX');
      g(8, layer);
      g(10, mm(pts[k]!));
      g(20, mm(H - pts[k + 1]!));
      g(30, 0);
    }
    g(0, 'SEQEND');
    g(8, layer);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
