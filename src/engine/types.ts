/**
 * Contrats partagés du moteur Homotope.
 *
 * RÈGLES :
 *  - Ce fichier est la source de vérité des structures qui traversent les étapes
 *    du pipeline. Chaque ticket implémente SON étape contre ces types ; une
 *    modification de ce fichier se discute dans la PR qui la porte.
 *  - Tout ici est PUR : aucun type DOM. Le moteur tourne dans un Web Worker et
 *    dans Node (tests unitaires, évaluation automatique).
 *  - Les tableaux typés sont privilégiés (transférables entre threads sans copie).
 */

// ---------------------------------------------------------------------------
// 1. Image
// ---------------------------------------------------------------------------

/** Image RGBA 8 bits, row-major, 4 octets par pixel (comme ImageData). */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** Longueur = width * height * 4. Alpha non prémultiplié. */
  readonly data: Uint8ClampedArray;
}

export type Rgb = readonly [r: number, g: number, b: number];

// ---------------------------------------------------------------------------
// 2. Prétraitement
// ---------------------------------------------------------------------------

export interface PreprocessOptions {
  /** `bilateral` préserve les bords (défaut logos/illustrations), `median` tue le bruit JPEG. */
  denoise: 'none' | 'bilateral' | 'median';
  /** Rayon du noyau en pixels (1 à 4). */
  denoiseRadius: number;
  /** Force (0 à 1) : écart-type couleur du bilatéral, ou mélange pour le médian. */
  denoiseStrength: number;
  /**
   * Transparence :
   *  - `keep`    : les pixels dont alpha < `alphaThreshold` forment une région
   *                TRANSPARENTE (label -1) qui ne produit aucun tracé ;
   *  - `flatten` : composition sur `background` avant tout traitement.
   */
  alphaMode: 'keep' | 'flatten';
  /** 0 à 255 ; un pixel sous ce seuil est transparent en mode `keep`. */
  alphaThreshold: number;
  /** Couleur de fond pour `flatten` (et pour l'aperçu PNG). */
  background: Rgb;
  /**
   * Suréchantillonnage des petites images : `auto` monte à ×2/×3 sous 256 px de
   * côté. Le facteur retenu est renvoyé dans `PreprocessResult.scale` et le SVG
   * final est exprimé dans les coordonnées de l'image D'ORIGINE (division).
   * Plafond : si `largeur·hauteur·facteur²` dépasse 16 Mpx (`MAX_WORK_PIXELS`), le
   * facteur est réduit au plus grand qui tient, jusqu'à ×1 (`clampUpsample`, jamais
   * d'erreur) ; c'est ce facteur réduit que renvoie `PreprocessResult.scale`.
   */
  upsample: 'auto' | 1 | 2 | 3 | 4;
  /**
   * T50 — Seuil « Noir et blanc » (0 à 255) : luminance relative Rec. 709 sous le seuil → noir,
   * sinon → blanc, appliqué EN DERNIER (après le suréchantillonnage) ; les pixels transparents
   * (mode `keep`) restent transparents. `null` ou absent = désactivé (sortie identique à l'octet).
   * T52 — `'auto'` : seuil d'Otsu (`otsuThreshold`) de la luminance des pixels opaques de l'image
   * de travail, calculé une fois par image ; le seuil retenu est renvoyé
   * (`PreprocessResult.threshold`, puis `VectorizeResult.diagnostics.threshold`).
   */
  threshold?: number | 'auto' | null;
}

export interface PreprocessResult {
  /**
   * Image de travail. Peut PARTAGER les données de l'image d'entrée (mode
   * `keep` sans débruitage ni suréchantillonnage, T12 : aucune copie) : les
   * étapes suivantes la lisent sans jamais l'écrire.
   */
  image: RasterImage;
  /** Facteur appliqué (1 = aucun), après plafond de pixels de travail. Les coordonnées vectorielles seront divisées par ce facteur. */
  scale: number;
  /** Masque de transparence (1 = opaque) en mode `keep`, sinon `null`. Longueur = width*height. */
  opaque: Uint8Array | null;
  /** T52 — Seuil « Noir et blanc » effectivement appliqué (0 à 255) ; absent si désactivé. */
  threshold?: number;
}

// ---------------------------------------------------------------------------
// 3. Couleurs (OKLab)
// ---------------------------------------------------------------------------

export interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

export interface PaletteColor {
  /** Index stable dans la palette (0..n-1). */
  id: number;
  rgb: Rgb;
  oklab: Oklab;
  /** Nombre de pixels assignés. */
  count: number;
  /** Verrouillée par l'utilisateur : le centroïde ne bouge pas. */
  locked: boolean;
  /**
   * Opacité moyenne (0..255) des pixels de cette couleur, posée par `quantize`
   * en mode alpha `keep` quand elle est < `TRANSLUCENT_ALPHA` ; absente = opaque.
   * L'export l'écrit en `fill-opacity` (T08). Les couleurs se regroupent sans
   * tenir compte de l'alpha : c'est une moyenne par couleur, pas par région.
   */
  alpha?: number;
  /**
   * T50 — Couleur mesurée AVANT recoloriage (`constraints.recolor`), posée seulement
   * quand la couleur a été recolorée : `rgb` est alors la couleur de sortie, `oklab`
   * reste celui de `sourceRgb`.
   */
  sourceRgb?: Rgb;
}

/** Sous cette opacité moyenne (0..255), une couleur est translucide (`PaletteColor.alpha`). */
export const TRANSLUCENT_ALPHA = 250;

export interface Palette {
  colors: PaletteColor[];
}

/** Interventions utilisateur sur la palette, appliquées APRÈS le k-means. */
export interface PaletteConstraints {
  /** Couleurs imposées (centroïdes fixes, jamais déplacés). */
  locked: Rgb[];
  /** Groupes d'ids à fusionner ; la couleur résultante est la moyenne pondérée. */
  merged: number[][];
  /** Ids retirés ; leurs pixels vont à la couleur restante la plus proche en OKLab. */
  removed: number[];
  /**
   * T50 — Ids rendus TRANSPARENTS (même convention que `removed`) : leurs pixels prennent
   * l'index -1, comme un pixel d'alpha nul en mode `keep` (aucune face, aucun tracé).
   * Appliqué après `merged`/`removed`, avant le tri final ; ignoré s'il rendrait toute
   * l'image transparente. Absent ou vide = sortie identique à l'octet.
   */
  transparent?: number[];
  /**
   * T50 — Recoloriage (ids de la palette de base) : seule la couleur de SORTIE change
   * (`PaletteColor.rgb`), jamais la géométrie (`oklab` reste la couleur mesurée, que
   * lisent segmentation et centre-ligne). Un id fusionné recolore son groupe (le premier
   * recoloriage du groupe gagne) ; un id retiré ou transparent est ignoré. Deux ids
   * recolorés vers la même couleur restent deux couleurs de palette (aucune fusion).
   * Ignoré avec `fixedPalette` (les encres imposées sont exactes).
   */
  recolor?: Array<{ id: number; rgb: Rgb }>;
}

export interface QuantizeOptions {
  /** Nombre de couleurs, ou `auto` (choisi par seuil d'erreur, borné par `maxColors`). */
  colors: number | 'auto';
  /** Borne haute en mode `auto` (2 à 64). */
  maxColors: number;
  /** Erreur maximale tolérée en mode `auto` : distance OKLab moyenne pixel→centroïde. */
  autoTolerance: number;
  constraints: PaletteConstraints;
  /** Graine du k-means++ : résultats reproductibles (tests, évaluation). */
  seed: number;
  /**
   * T34 — Palette IMPOSÉE (nuancier client, encres disponibles). Absente = comportement
   * historique, à l'octet près. Présente : aucun k-means, aucune couleur inventée ; chaque
   * pixel va à la couleur imposée la plus proche en OKLab (« k = n, tout verrouillé »).
   * `colors`, `maxColors`, `autoTolerance`, `seed`, `constraints.locked` et
   * `constraints.merged` sont alors ignorés (une fusion inventerait une moyenne) ;
   * `constraints.removed` s'applique (ids de la palette de base, convention T02).
   */
  fixedPalette?: FixedPalette;
}

/** T34 — Bornes d'une palette imposée (nombre de couleurs, doublons exacts retirés). */
export const FIXED_PALETTE_MIN = 2;
export const FIXED_PALETTE_MAX = 64;
/** T34 — Seuil de couverture maximal (fraction des pixels opaques). */
export const FIXED_MIN_COVERAGE_MAX = 0.25;

/** T34 — Palette imposée et ses réglages (un seul objet : le contrat reste additif). */
export interface FixedPalette {
  /** 2 à 64 couleurs sRGB 8 bits ; un doublon exact est ignoré (le premier compte). */
  colors: Rgb[];
  /**
   * Tramage Floyd–Steinberg dans OKLab (désactivé par défaut) : simule les teintes
   * intermédiaires par un motif de points, au prix de nombreuses petites régions.
   */
  dither: boolean;
  /**
   * Seuil de couverture, fraction (0 à `FIXED_MIN_COVERAGE_MAX`) des pixels opaques : une
   * couleur imposée qui en couvre moins est retirée et ses pixels vont à la plus proche
   * des restantes (un seul passage). 0 = désactivé.
   */
  minCoverage: number;
}

export interface QuantizeResult {
  palette: Palette;
  /**
   * Index de couleur par pixel (longueur width*height) ; -1 = transparent.
   * Ce n'est PAS encore une région : la segmentation vient ensuite.
   */
  colorIndex: Int16Array;
}

// ---------------------------------------------------------------------------
// 4. Segmentation en régions
// ---------------------------------------------------------------------------

export interface SegmentOptions {
  /**
   * Aire (pixels de l'image D'ORIGINE) sous laquelle une région est absorbée
   * par la voisine la plus proche en couleur. `vectorize` la multiplie par
   * `scale²` avant `segment`, qui la reçoit en pixels de travail.
   */
  minRegionArea: number;
  /**
   * T08 — Épaisseur max (pixels de l'image D'ORIGINE ; `vectorize` la
   * multiplie par `scale`) d'une BANDE d'anti-aliasing : une région aussi mince
   * dont la couleur est le mélange de deux voisines est rendue à la plus
   * proche (voir `absorbBlendBands`). 0 ou absent = aucune.
   */
  blendBand?: number;
  /**
   * Connexité des régions. 4 est OBLIGATOIRE pour que le graphe des frontières
   * soit planaire et manifold ; 8 n'est pas supporté par la topologie.
   */
  connectivity: 4;
}

export interface Region {
  /** Id de région (0..n-1), dense après absorption. */
  id: number;
  /** Index dans la palette. */
  colorId: number;
  area: number;
  /** Boîte englobante inclusive en pixels : [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
}

export interface LabelMap {
  readonly width: number;
  readonly height: number;
  /** Id de région par pixel ; -1 = transparent (aucun tracé). Longueur = width*height. */
  labels: Int32Array;
  regions: Region[];
}

// ---------------------------------------------------------------------------
// 5. Topologie : graphe planaire des frontières
// ---------------------------------------------------------------------------
//
// Repère : les sommets vivent sur le treillis des COINS de pixels, coordonnées
// entières (0..width, 0..height). Le pixel (x, y) occupe [x, x+1] × [y, y+1].
//
// Un SOMMET (BoundaryVertex) est un coin de pixel où au moins trois labels se
// rencontrent (ou un coin d'image touché par une frontière) : son degré est
// différent de 2.
//
// Une CHAÎNE (BoundaryChain) est la polyligne de coins de pixels entre deux
// sommets, le long de laquelle exactement deux labels se font face : `left` et
// `right` (dans le sens de parcours, y vers le bas). Une île sans jonction
// (région entièrement contenue dans une autre) donne une chaîne FERMÉE dont le
// premier et le dernier point coïncident ; son ancre est arbitraire.
//
// Une FACE est une région ; ses anneaux sont des suites de chaînes orientées.
// L'anneau 0 est le contour extérieur ; les suivants sont des TROUS. Chaque
// chaîne appartient à exactement deux faces (ou une face + l'extérieur/transparent,
// label -1 ou IMAGE_BORDER) : c'est ce qui garantit l'absence de liseré.
//
// Invariants (vérifiés par les tests) :
//  - chaque chaîne est référencée par exactement deux anneaux (un par côté),
//    une fois dans chaque sens ;
//  - pour chaque face, nombre d'anneaux - 1 = nombre de trous, et ce nombre est
//    identique avant/après vectorisation (conservation de la topologie) ;
//  - parcourir un anneau extérieur laisse la face à GAUCHE (sens horaire en
//    repère écran, y vers le bas) ; un trou la laisse à DROITE.

/** Label virtuel du bord de l'image (côté extérieur d'une chaîne au bord). */
export const IMAGE_BORDER = -2;
/** Label des pixels transparents (mode alpha `keep`). */
export const TRANSPARENT = -1;

export interface BoundaryVertex {
  id: number;
  x: number;
  y: number;
  /** Nombre de chaînes incidentes (≠ 2 par construction, sauf ancre d'une chaîne fermée). */
  degree: number;
}

export interface BoundaryChain {
  id: number;
  /** Coordonnées de treillis entrelacées [x0, y0, x1, y1, …] ; premier et dernier points = sommets. */
  points: Float64Array;
  start: number; // id de sommet
  end: number; // id de sommet (= start si fermée)
  /** Label de région à gauche du sens de parcours (ou TRANSPARENT / IMAGE_BORDER). */
  left: number;
  /** Label de région à droite du sens de parcours (ou TRANSPARENT / IMAGE_BORDER). */
  right: number;
  closed: boolean;
}

export interface RingEdge {
  chain: number;
  /** true = la chaîne est parcourue de `end` vers `start`. */
  reversed: boolean;
}

export interface Ring {
  edges: RingEdge[];
  isHole: boolean;
}

export interface Face {
  region: number;
  /**
   * Index dans la palette (copie de `Region.colorId`) : le graphe se suffit à
   * lui-même pour l'export SVG, qui ne reçoit pas la `LabelMap`.
   */
  colorId: number;
  /** rings[0] = contour extérieur, rings[1..] = trous. */
  rings: Ring[];
  /** Région qui contient immédiatement cette face (celle dont un trou l'entoure), ou -1 au niveau racine. */
  parent: number;
  /** Profondeur dans l'arbre de contenance (0 = racine). Ordre de peinture en mode `stacked`. */
  depth: number;
}

export interface BoundaryGraph {
  readonly width: number;
  readonly height: number;
  vertices: BoundaryVertex[];
  chains: BoundaryChain[];
  /** Indexé par id de région. */
  faces: Face[];
}

// ---------------------------------------------------------------------------
// 6. Ajustement de courbes
// ---------------------------------------------------------------------------

export interface FitOptions {
  /**
   * Erreur max (pixels de l'image D'ORIGINE) entre la polyligne et la courbe.
   * `vectorize` la multiplie par le facteur de suréchantillonnage avant
   * `fitChains`, qui, elle, la reçoit en pixels de travail.
   */
  tolerance: number;
  /** Angle (degrés) au-dessus duquel un point est un COIN (tangente discontinue). 0 = tout est coin. */
  cornerAngle: number;
  /** Lissage de la polyligne avant ajustement (0 = aucun, 1 = fort). Les sommets de jonction ne bougent JAMAIS. */
  smoothing: number;
  /** Tolérance (pixels d'origine, × `scale` par `vectorize`) pour reconnaître un segment DROIT. */
  lineTolerance: number;
  /**
   * T43 — Portée du lissage (points de contour, 0 = aucune) : sur un arc DOUX, le rayon de la
   * moyenne glissante monte de `smoothing` jusqu'à cette valeur tant que le rétrécissement
   * estimé de l'arc reste sous 0,1 px (`reachRadius`). Gomme l'escalier des pixels des grands
   * cercles (un palier de 19 px au sommet d'un cercle de 185 px) sans arrondir un coin serré.
   */
  smoothingReach: number;
  /**
   * T43 — Droites robustes : un coin entre deux tronçons droits au sens des moindres carrés va
   * vers l'intersection de leurs droites (vers la projection sur la droite si un seul voisin
   * est droit), de 0,95 × `tolerance` au plus. L'anti-aliasing émousse les pointes d'un pixel :
   * sans cela, la corde entre coins penche et un bord droit sort en courbe.
   */
  robustLines: boolean;
  /**
   * Mode pixel art : aucun lissage, aucune cubique ; la chaîne devient une
   * polyligne aux coordonnées de treillis exactes, points colinéaires fusionnés.
   */
  pixelArt: boolean;
}

export type Segment =
  | { kind: 'line'; x: number; y: number }
  | { kind: 'cubic'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

/**
 * Chaîne ajustée UNE fois, consommée par ses deux faces. Le point de départ est
 * `start` ; chaque segment se termine en (x, y). Inverser une chaîne = inverser
 * l'ordre des segments et échanger c1/c2 (voir `reverseFittedChain`).
 */
export interface FittedChain {
  chain: number;
  start: readonly [number, number];
  segments: Segment[];
}

// ---------------------------------------------------------------------------
// 6 bis. Tracé centre-ligne (T33) : traits d'une seule passe, À CÔTÉ des faces
// ---------------------------------------------------------------------------
//
// Le préréglage « Trait unique » ne produit pas de faces : l'encre est
// binarisée, amincie en squelette d'un pixel, puis le squelette devient un
// GRAPHE DE TRAITS. Repère : celui du graphe des frontières (treillis des coins
// de pixels, pixel (x, y) = [x, x+1] × [y, y+1]) ; un pixel du squelette est
// représenté par son CENTRE (x + 0,5, y + 0,5).
//
// Un NŒUD (StrokeNode) est une extrémité (degré 1), une jonction (degré ≥ 3),
// un coin (degré 2, virage plus net que `fit.cornerAngle`) ou l'ancre d'une
// boucle sans jonction. Une ARÊTE (StrokeEdge) est la chaîne de pixels entre
// deux nœuds, parcourue une fois. Invariants (tests) : chaque pixel du squelette
// élagué appartient à exactement une arête ; aucune arête n'en recouvre une autre.
// Un PASSAGE (StrokeRun) enchaîne des arêtes par les nœuds où le trait continue
// tout droit : c'est un sous-tracé `stroke` d'une seule passe, jamais repassé.

/**
 * Réglages du tracé centre-ligne, en pixels de l'image D'ORIGINE ; `workingOptions`
 * convertit `spurLength` et `tolerance` à l'échelle de travail (`minWidth`, épaisseur
 * écrite dans le SVG, reste en pixels d'origine).
 */
export interface CenterlineOptions {
  /** Active le tracé centre-ligne : traits `stroke` au lieu de faces remplies. */
  enabled: boolean;
  /** Épaisseur minimale d'un trait émis (`stroke-width` plancher, px d'origine). */
  minWidth: number;
  /**
   * Longueur de barbule (px d'origine) : une branche terminale qui dépasse de
   * moins de cette longueur le trait qu'elle quitte est élaguée ; une tache ou
   * un trait isolé plus court disparaît.
   */
  spurLength: number;
  /** Tolérance (px d'origine) de l'ajustement des traits en Bézier. */
  tolerance: number;
}

export type StrokeNodeKind = 'end' | 'junction' | 'corner' | 'loop';

export interface StrokeNode {
  id: number;
  /** Position (coordonnées de travail), centre de jonction recalé à l'intersection des axes. */
  x: number;
  y: number;
  kind: StrokeNodeKind;
  /** Nombre d'extrémités d'arête incidentes (une boucle compte deux fois). */
  degree: number;
  /** Demi-épaisseur de l'encre au nœud (transformée de distance, px de travail). */
  radius: number;
}

export interface StrokeEdge {
  id: number;
  /** Points entrelacés [x0, y0, …] ; premier = nœud `start`, dernier = nœud `end`. */
  points: Float64Array;
  start: number;
  end: number;
  /** Boucle sans jonction : `start = end`, premier et dernier points identiques. */
  closed: boolean;
  /** Épaisseur moyenne mesurée (px de travail). */
  width: number;
}

/** Sous-tracé d'une seule passe : arêtes enchaînées (`chain` = id d'arête). */
export interface StrokeRun {
  edges: RingEdge[];
  closed: boolean;
  /** Épaisseur du passage (moyenne des arêtes pondérée par leur longueur, px de travail). */
  width: number;
}

export interface StrokeGraph {
  readonly width: number;
  readonly height: number;
  nodes: StrokeNode[];
  edges: StrokeEdge[];
  runs: StrokeRun[];
  /** Couleur de l'encre (id de palette) ; -1 si aucune encre. */
  inkColor: number;
  /** Couleur du papier (id de palette) ; -1 si transparent ou absent. */
  paperColor: number;
}

// ---------------------------------------------------------------------------
// 7. Export SVG
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /**
   * `cut`     : chaque région est un tracé exact (extérieur + trous), sans aucun
   *             chevauchement ; `fill-rule="evenodd"` ;
   * `stacked` : formes empilées par profondeur de contenance, trous omis
   *             (couverts par les formes du dessus) : moins de nœuds.
   */
  mode: 'cut' | 'stacked';
  /** Décimales conservées (0 à 4). */
  precision: number;
  /** Fusionner les tracés de même couleur en un seul `<path>`. */
  mergeByColor: boolean;
  /** Émettre un `<rect>` de fond pour la couleur majoritaire au lieu d'un tracé (plus léger). */
  backgroundRect: boolean;
  /**
   * Trait anti-liseré (T08), largeur en pixels de l'image D'ORIGINE ; 0 ou
   * absent = aucun. Deux tracés jointifs anti-aliasés laissent passer le fond
   * le long de leur frontière commune (« conflation »). Une face peinte AVANT
   * une voisine reçoit, le long de leurs seules chaînes communes, un trait de
   * sa couleur que la voisine recouvre : la frontière visible ne bouge pas, le
   * jour disparaît. Jamais vers la transparence ni vers une face peinte avant.
   */
  seamStroke?: number;
}

export interface SvgStats {
  paths: number;
  /** Nœuds = points d'ancrage (fin de segment) sur l'ensemble des tracés. */
  nodes: number;
  /** Octets du SVG en UTF-8. */
  bytes: number;
  colors: number;
  regions: number;
  /** T33 — Tracé centre-ligne : nombre de passages (sous-tracés `stroke`) ; absent sinon. */
  strokes?: number;
}

// ---------------------------------------------------------------------------
// 8. Pipeline
// ---------------------------------------------------------------------------

export type PresetName =
  'logo' | 'illustration' | 'pixel-art' | 'line-art' | 'centerline' | 'black-white' | 'photo';

export interface VectorizeOptions {
  preprocess: PreprocessOptions;
  quantize: QuantizeOptions;
  segment: SegmentOptions;
  fit: FitOptions;
  export: ExportOptions;
  /**
   * T33 — Tracé centre-ligne. Inactif (`enabled: false`) dans tous les
   * préréglages sauf « Trait unique » : les autres sorties sont inchangées.
   * Requis, comme les autres sections : toute option qui entre dans le moteur
   * est complétée par `presetOptions` (`mergeOptions` côté atelier et galerie,
   * `resolveOptions` côté API v1 / MCP / calcul serveur), donc la section est
   * toujours là. Seule exception tolérée : un objet d'options construit à la main
   * sans elle (options figées avant T33) ; `vectorize` et `workingOptions` le
   * lisent alors comme `enabled: false` (testé).
   */
  centerline: CenterlineOptions;
}

export type Stage = 'preprocess' | 'quantize' | 'segment' | 'topology' | 'fit' | 'export';

export const STAGES: readonly Stage[] = [
  'preprocess',
  'quantize',
  'segment',
  'topology',
  'fit',
  'export',
];

export interface ProgressEvent {
  stage: Stage;
  /** Progression GLOBALE 0..1 (les étapes sont pondérées). */
  progress: number;
  /** Progression de l'étape courante 0..1. */
  stageProgress: number;
}

/** Jeton d'annulation coopératif : le pipeline le consulte à chaque point de reprise. */
export interface CancelToken {
  readonly cancelled: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('Vectorisation annulée');
    this.name = 'CancelledError';
  }
}

export interface VectorizeContext {
  onProgress?: (e: ProgressEvent) => void;
  cancel?: CancelToken;
  /**
   * Renvoyer `VectorizeResult.debug` (chaînes ajustées en coordonnées
   * d'origine). Désactivé par défaut : la copie a un coût, et seuls les modes
   * d'affichage « contours » / « nœuds » de l'interface en ont besoin.
   */
  debug?: boolean;
  /**
   * T12 — Dimensions de l'image D'ORIGINE quand l'image passée à `vectorize`
   * en est une RÉDUCTION (mode « calcul rapide » de l'interface). Absent ou
   * égal aux dimensions de l'image : aucune réduction.
   *
   * Convention d'échelle : `scale` = travail / origine. Le suréchantillonnage
   * donne `scale` > 1 (entier, identique sur les deux axes) ; une réduction
   * donne `scale` < 1, par axe (`largeur de travail / largeur d'origine`, de
   * même en hauteur ; ils ne diffèrent que par l'arrondi des dimensions), et
   * désactive le suréchantillonnage. Le `viewBox`, les coordonnées du SVG et
   * `debug.fitted` sont TOUJOURS dans les dimensions d'origine. Les options
   * restent exprimées en pixels d'origine ; `workingOptions` les convertit
   * (aires × scale², longueurs × max(1, scale) : jamais sous un pixel de travail).
   */
  original?: { width: number; height: number };
}

export interface VectorizeResult {
  svg: string;
  stats: SvgStats;
  palette: Palette;
  /** Dimensions de l'image D'ORIGINE (viewBox du SVG). */
  width: number;
  height: number;
  /** Durée par étape, en millisecondes. */
  timings: Partial<Record<Stage, number>>;
  /**
   * T50 — Ids de palette (finale) des régions qui touchent le bord de l'image
   * (`borderColorIds`). Absent en tracé centre-ligne (pas de carte des régions).
   */
  borderColors?: number[];
  /**
   * T52 — Mesures sur l'image, pour l'interface : `threshold` = seuil « Noir et blanc »
   * appliqué (le nombre calculé quand l'option vaut `'auto'`) ; `strokeWidth` = épaisseur
   * MÉDIANE des traits en px d'ORIGINE (tracé centre-ligne seulement, `medianStrokeWidth`).
   * Absent quand rien n'est mesuré.
   */
  diagnostics?: { threshold?: number; strokeWidth?: number };
  /**
   * Chaînes ajustées en coordonnées d'origine (pour les modes d'affichage
   * « contours seuls » et « nœuds visibles » de l'interface).
   */
  debug?: {
    fitted: FittedChain[];
  };
}
