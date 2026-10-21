import type { PresetName, VectorizeOptions } from './types.ts';

/**
 * Options de base, partagées par les préréglages ; « logo » y ajoute ses réglages T43
 * (`presetOptions`), éteints ici comme le tracé centre-ligne (T33).
 */
export const DEFAULT_OPTIONS: VectorizeOptions = {
  preprocess: {
    denoise: 'bilateral',
    denoiseRadius: 2,
    denoiseStrength: 0.3,
    alphaMode: 'keep',
    alphaThreshold: 128,
    background: [255, 255, 255],
    upsample: 'auto',
  },
  quantize: {
    colors: 'auto',
    maxColors: 16,
    autoTolerance: 0.02,
    constraints: { locked: [], merged: [], removed: [] },
    seed: 42,
  },
  // T08 : bandes d'anti-aliasing d'au plus 1,3 px absorbées.
  segment: { minRegionArea: 8, blendBand: 1.3, connectivity: 4 },
  // T43 : portée du lissage et droites robustes, inactives hors du préréglage « Logo ».
  // T125a : formes exactes, allumées par Logo et Noir et blanc seulement (Dessin au trait : la
  // mesure sur text.png régressait, réglage éteint).
  fit: {
    tolerance: 1.0,
    cornerAngle: 60,
    smoothing: 0.5,
    lineTolerance: 0.5,
    smoothingReach: 0,
    robustLines: false,
    exactShapes: false,
    pixelArt: false,
  },
  // T08 : fond en `<rect>` (images opaques seulement) et trait anti-liseré d'1 px.
  export: { mode: 'cut', precision: 2, mergeByColor: true, backgroundRect: true, seamStroke: 1 },
  // T33 : inactif hors du préréglage « Trait unique ».
  centerline: { enabled: false, minWidth: 1, spurLength: 4, tolerance: 0.6 },
};

function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Préréglages. Les valeurs sont un point de départ ; T07/T08 les ajustent sur
 * le jeu d'évaluation. Toute valeur se retrouve dans le panneau « Avancé ».
 */
export function presetOptions(name: PresetName): VectorizeOptions {
  const o = deepClone(DEFAULT_OPTIONS);
  switch (name) {
    case 'logo':
      // T43 — Contours nets au rendu agrandi (×4), JPEG ou PNG : les grands arcs gardent une
      // courbure régulière (portée 12), les branches d'une étoile restent droites (droites
      // robustes) et ses coins rentrants à 72° (mesurés 56 à 66° après anti-aliasing) restent
      // des coins (55° au lieu de 60°). Mesures : README, « Décisions › Préréglage Logo (T43) ».
      o.fit.cornerAngle = 55;
      o.fit.smoothingReach = 12;
      o.fit.robustLines = true;
      o.fit.exactShapes = true;
      return o;
    case 'illustration':
      o.quantize.maxColors = 32;
      o.quantize.autoTolerance = 0.015;
      o.segment.minRegionArea = 12;
      // T08 : 1,5 px laissait déborder les pointes (collines) d'un pixel et demi.
      o.fit.tolerance = 1.0;
      o.fit.smoothing = 0.7;
      // T08 : empilé — les formes du dessous n'ont pas de trous (−19 % de nœuds),
      // le trait anti-liseré comble les jointures ; SSIM identique.
      o.export.mode = 'stacked';
      return o;
    case 'pixel-art':
      o.preprocess.denoise = 'none';
      o.preprocess.upsample = 1;
      o.quantize.maxColors = 64;
      o.quantize.autoTolerance = 0.005;
      o.segment.minRegionArea = 1;
      o.segment.blendBand = 0;
      o.fit.pixelArt = true;
      o.fit.smoothing = 0;
      o.export.precision = 0;
      // Bords sur le treillis : aucun anti-aliasing, donc aucun jour à combler.
      o.export.seamStroke = 0;
      return o;
    case 'line-art':
      o.preprocess.denoise = 'median';
      o.preprocess.denoiseRadius = 1;
      o.quantize.colors = 2;
      o.quantize.maxColors = 2;
      o.segment.minRegionArea = 4;
      o.fit.tolerance = 0.8;
      o.fit.cornerAngle = 75;
      return o;
    case 'centerline':
      // T33 — Trait unique (laser, traceur, broderie) : squelette de l'encre,
      // chemins `stroke` d'une seule passe ; pas de fond (rien à découper).
      o.preprocess.denoise = 'median';
      o.preprocess.denoiseRadius = 1;
      o.quantize.colors = 2;
      o.quantize.maxColors = 2;
      o.fit.cornerAngle = 60;
      o.fit.smoothing = 0.5;
      o.export.backgroundRect = false;
      o.export.seamStroke = 0;
      o.centerline.enabled = true;
      return o;
    case 'black-white':
      // T50 — Noir et blanc (comme l'option d'Illustrator) : un SEUIL de luminosité, pas un
      // k-means à 2 couleurs (qui sortirait deux teintes arbitraires) : sombre → noir, clair →
      // blanc, la quantification ne trouve que ces deux couleurs. Contours de « Logo » (T43) ;
      // chaque couleur est une vraie forme (ni `<rect>` de fond ni trait anti-liseré). Le fond
      // transparent et le recoloriage (Pro) viennent ensuite dans la palette.
      o.preprocess.denoise = 'median';
      o.preprocess.denoiseRadius = 1;
      // T52 — Seuil AUTOMATIQUE (Otsu) : un crayon saumon (≈ 150) sur papier crème (≈ 225)
      // passait tout entier au blanc sous un seuil fixe de 128.
      o.preprocess.threshold = 'auto';
      o.quantize.colors = 2;
      o.quantize.maxColors = 2;
      o.fit.cornerAngle = 55;
      o.fit.smoothingReach = 12;
      o.fit.robustLines = true;
      o.fit.exactShapes = true;
      o.export.backgroundRect = false;
      o.export.seamStroke = 0;
      return o;
    case 'photo':
      o.preprocess.denoise = 'bilateral';
      o.preprocess.denoiseRadius = 3;
      o.preprocess.denoiseStrength = 0.5;
      o.preprocess.upsample = 1;
      o.quantize.colors = 24;
      o.quantize.maxColors = 64;
      o.segment.minRegionArea = 24;
      o.fit.tolerance = 2.0;
      o.fit.smoothing = 0.8;
      o.export.mode = 'stacked';
      // T08 : un dixième de pixel suffit à une photo (−20 % d'octets, SSIM identique).
      o.export.precision = 1;
      return o;
  }
}

export const PRESET_NAMES: readonly PresetName[] = [
  'logo',
  'illustration',
  'pixel-art',
  'line-art',
  'centerline',
  'black-white',
  'photo',
];
