/**
 * T35 — Rapport du contrôle « prêt pour la découpe » : types, bornes et textes (français).
 * Pur, sans DOM ; sérialisable tel quel en JSON (worker, API, MCP).
 */
import type { Rgb } from '../export/scene.ts';

/** Diamètre de l'outil par défaut (mm) : faisceau laser fin, lame de traceur courante. */
export const DEFAULT_TOOL_MM = 0.2;
export const MIN_TOOL_MM = 0.01;
export const MAX_TOOL_MM = 10;
/** Aire sous laquelle un contour fermé est un « petit îlot » (mm²), par défaut. */
export const DEFAULT_ISLAND_MM2 = 1;
export const MIN_ISLAND_MM2 = 0;
export const MAX_ISLAND_MM2 = 1000;
/**
 * Nœuds (sommets de la polyligne découpée) au-delà desquels un contour est signalé. 1 000 : un
 * contour de forme ordinaire (lettre, pictogramme) en compte quelques dizaines à quelques
 * centaines une fois les courbes aplaties ; au-delà, c'est presque toujours du bruit de pixels
 * tracé, que les logiciels de découpe (Silhouette Studio, Cricut Design Space) ralentissent à
 * charger et que la lame suit par à-coups (README « Prêt pour la découpe »).
 */
export const DEFAULT_MAX_NODES = 1000;
export const MIN_MAX_NODES = 10;
export const MAX_MAX_NODES = 1_000_000;
/**
 * T63 — Longueur minimale d'un filet (mm) : une largeur sous l'outil n'est signalée que si elle
 * PERSISTE sur cette longueur. Absente : le diamètre de l'outil.
 */
export const MIN_THIN_MM = 0;
export const MAX_THIN_MM = 1000;
/**
 * T63 — Dessin au trait : part de la longueur des lignes de découpe (remplissages) qui borde un
 * filet plus fin que l'outil, au-delà de laquelle le contrôle le dit en tête.
 */
export const LINE_ART_SHARE = 0.5;
/** Problèmes LISTÉS au plus par type (les totaux restent exacts). */
export const MAX_LISTED_PER_KIND = 100;

export type CutIssueKind =
  'open' | 'overlap' | 'crossing' | 'self-intersection' | 'thin' | 'island' | 'nodes';

/** Ordre d'affichage des groupes (et des totaux). */
export const CUT_ISSUE_KINDS: readonly CutIssueKind[] = [
  'open',
  'crossing',
  'self-intersection',
  'overlap',
  'thin',
  'island',
  'nodes',
];

/**
 * `blocking` : la découpe sera fausse ; `check` : à vérifier selon la machine et la matière ;
 * `info` : normal pour ce type de fichier, réglable par une option (frontière commune de deux
 * faces voisines : « Fusionner les frontières communes ») — hors du compte des points.
 */
export type CutSeverity = 'blocking' | 'check' | 'info';

/** Rang d'affichage : bloquants, puis à vérifier, puis informations. */
export const SEVERITY_RANK: Readonly<Record<CutSeverity, number>> = {
  blocking: 0,
  check: 1,
  info: 2,
};

/** Boîte en coordonnées de l'image (px d'origine, Y vers le bas), comme le `viewBox` du SVG. */
export interface CutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CutIssue {
  kind: CutIssueKind;
  severity: CutSeverity;
  box: CutBox;
  /** Phrase en français, autonome. */
  message: string;
  /**
   * Mesure du cas : largeur (mm) pour `thin`, aire (mm²) pour `island`, longueur (mm) pour
   * `overlap` et `open`, nœuds pour `nodes`, points de croisement pour les intersections.
   */
  value: number;
  /** Couleur (hexadécimal `RRGGBB`, nom de la couche DXF) du contour en cause, s'il est unique. */
  color?: string;
  /** T63 — `thin` : longueur du filet (mm), le long de la bande trop étroite. */
  length?: number;
  /** T63 — `island` : dimensions de sa boîte (mm). */
  size?: { width: number; height: number };
  /**
   * T63 — Le moteur sait le corriger (`correctScene`) : élargir un filet, retirer un aller-retour
   * ou un îlot. Absent : aucune correction proposée.
   */
  fixable?: true;
}

/** T63 — Correction demandée pour un problème listé, repéré par son type et sa boîte. */
export type CutFixKind = 'thin' | 'island' | 'overlap';

export interface CutFix {
  kind: CutFixKind;
  box: CutBox;
}

export interface CutColorNodes {
  /** Hexadécimal `RRGGBB` (couche DXF). */
  color: string;
  nodes: number;
  contours: number;
}

export interface CutReport {
  /** Paramètres effectifs (bornés). */
  toolMm: number;
  islandMm2: number;
  maxNodes: number;
  mmPerPx: number;
  /** T63 — Longueur minimale d'un filet signalé (mm). */
  minThinMm: number;
  /** T63 — Dimensions du dessin à cette échelle (mm). */
  drawing: { width: number; height: number };
  /**
   * T63 — Part (0 à 1) de la longueur des lignes de découpe des remplissages qui borde un filet
   * plus fin que l'outil ; `lineArt` au-delà de `LINE_ART_SHARE`.
   */
  thinShare: number;
  lineArt: boolean;
  /** Frontières communes fusionnées (chaque segment n'est découpé qu'une fois). */
  mergeShared: boolean;
  /** Contours découpés : fermés, ouverts (traits du centre-ligne compris). */
  contours: { total: number; closed: number; open: number; strokes: number };
  /** Sommets des polylignes envoyées à la découpeuse. */
  nodes: { total: number; maxPerContour: number; byColor: CutColorNodes[] };
  /** Nombre de problèmes par type (exact, même si la liste est tronquée). */
  totals: Record<CutIssueKind, number>;
  blocking: number;
  check: number;
  /** Informations (frontières communes non fusionnées), hors de `blocking` et de `check`. */
  info: number;
  /** Problèmes listés (au plus `MAX_LISTED_PER_KIND` par type), bloquants d'abord. */
  issues: CutIssue[];
  /** Budget de calcul atteint : certaines paires n'ont pas été testées (le total est un minimum). */
  truncated: boolean;
}

/** Résumé d'une simplification (avant / après). */
export interface CutSimplifySummary {
  before: { issues: number; blocking: number; nodes: number };
  after: { issues: number; blocking: number; nodes: number };
  /** Îlots retirés, segments dédoublonnés. */
  removedIslands: number;
  mergedSegments: number;
}

export function colorHex(rgb: Rgb): string {
  return rgb
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

const nf = (digits: number) =>
  new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const nf2 = nf(2);
const nf0 = nf(0);

/** Millimètres lisibles : 2 décimales au plus (« 0,08 mm »), jamais « 0 » pour un écart réel. */
export function fmtMm(mm: number): string {
  if (mm > 0 && mm < 0.005) return '< 0,01';
  return nf2.format(mm);
}

export function fmtCount(n: number): string {
  return nf0.format(n);
}

/** Libellé d'un groupe, au pluriel selon le nombre. */
export function kindLabel(kind: CutIssueKind, n: number): string {
  const many = n > 1;
  switch (kind) {
    case 'open':
      return many ? 'Contours ouverts' : 'Contour ouvert';
    case 'overlap':
      return many ? 'Doubles découpes' : 'Double découpe';
    case 'crossing':
      return many ? 'Chevauchements' : 'Chevauchement';
    case 'self-intersection':
      return many ? 'Auto-intersections' : 'Auto-intersection';
    case 'thin':
      return many ? 'Détails trop fins' : 'Détail trop fin';
    case 'island':
      return many ? 'Petits îlots' : 'Petit îlot';
    case 'nodes':
      return many ? 'Contours trop chargés' : 'Contour trop chargé';
  }
}

export function emptyTotals(): Record<CutIssueKind, number> {
  return {
    open: 0,
    overlap: 0,
    crossing: 0,
    'self-intersection': 0,
    thin: 0,
    island: 0,
    nodes: 0,
  };
}

/** T63 — Dessin au trait : la majorité des lignes de découpe borde des filets sous l'outil. */
export function isLineArt(thinShare: number): boolean {
  return thinShare > LINE_ART_SHARE;
}

/** Borne un nombre (NaN ou absent → défaut). */
export function clampParam(v: number | undefined, def: number, min: number, max: number): number {
  return v === undefined || !Number.isFinite(v) ? def : Math.min(max, Math.max(min, v));
}
