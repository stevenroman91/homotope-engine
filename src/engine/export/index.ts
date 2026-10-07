/**
 * T32 — Exports PDF, EPS et DXF. Tout part du SVG émis par `exportSvg` (seul assembleur
 * d'anneaux), relu en scène (`sceneFromSvg`) : même géométrie, même ordre de peinture, et le
 * même fichier dans l'atelier et dans l'API (qui n'a que le SVG stocké). Pur, sans DOM.
 */
import { DXF_MIME, writeDxf, type DxfOptions } from './dxf.ts';
import { EPS_MIME, writeEps } from './eps.ts';
import { PDF_MIME, writePdf } from './pdf.ts';
import { sceneFromSvg } from './scene.ts';
import { fileBytes, layeredSvg, separationsZip, type ColorNames } from './separations.ts';
import { ZIP_MIME } from './zip.ts';

export {
  colorKey,
  dxfLayerLabel,
  dxfLayerNames,
  DXF_DEFAULT_TOLERANCE,
  DXF_MAX_TOLERANCE,
  DXF_MIN_TOLERANCE,
  flattenSubpath,
  layerName,
  MM_PER_PX,
  writeDxf,
  type DxfOptions,
} from './dxf.ts';
export { writeEps } from './eps.ts';
export { writePdf } from './pdf.ts';
export { SceneError, sceneFromSvg, type SceneItem, type VectorScene } from './scene.ts';
export {
  colorLabel,
  colorSlug,
  layeredSvg,
  safeStem,
  sceneToSvg,
  SeparationError,
  separationColors,
  separationFiles,
  separationScenes,
  separationsZip,
  STACKED_SEPARATIONS_MESSAGE,
  svgIsStacked,
  type ColorNames,
  type SeparationFile,
} from './separations.ts';
export { crc32, zipStore, ZIP_MIME, type ZipEntry } from './zip.ts';

export const EXPORT_FORMATS = ['svg', 'pdf', 'dxf', 'eps'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Type MIME et extension de chaque format. */
export const FORMAT_INFO: Readonly<Record<ExportFormat, { mime: string; ext: string }>> = {
  svg: { mime: 'image/svg+xml', ext: 'svg' },
  pdf: { mime: PDF_MIME, ext: 'pdf' },
  dxf: { mime: DXF_MIME, ext: 'dxf' },
  eps: { mime: EPS_MIME, ext: 'eps' },
};

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

/** Convertit le SVG d'Homotope dans `format` (texte ASCII, sauf `svg` rendu tel quel). */
export function convertSvg(svg: string, format: ExportFormat, options: DxfOptions = {}): string {
  if (format === 'svg') return svg;
  const scene = sceneFromSvg(svg);
  if (format === 'pdf') return writePdf(scene);
  if (format === 'eps') return writeEps(scene);
  return writeDxf(scene, options);
}

/**
 * T34 — Séparations : `layers` = un seul fichier à calques quand le format en a (SVG à calques
 * Inkscape, DXF à couches nommées), sinon un ZIP (PDF, EPS) ; `zip` = toujours un ZIP d'un
 * fichier par couleur.
 */
export const LAYERS_MODES = ['layers', 'zip'] as const;
export type LayersMode = (typeof LAYERS_MODES)[number];

export interface LayersOptions extends DxfOptions {
  /** Noms de nuancier (`#rrggbb` → nom) : calques, couches et noms de fichiers. */
  names?: ColorNames;
  /** Début des noms de fichiers du ZIP (`<stem>-<nom>.<ext>`) ; défaut `image`. */
  stem?: string;
}

export interface ExportedFile {
  data: Uint8Array;
  mime: string;
  ext: string;
}

/** Vrai si `mode` donne un ZIP pour `format`. */
export function layersAreZip(format: ExportFormat, mode: LayersMode): boolean {
  return mode === 'zip' || format === 'pdf' || format === 'eps';
}

/** Séparations du SVG d'Homotope dans `format` (voir `LayersMode`). */
export function exportLayers(
  svg: string,
  format: ExportFormat,
  mode: LayersMode,
  options: LayersOptions = {},
): ExportedFile {
  const { names = {}, stem = 'image', ...dxf } = options;
  if (layersAreZip(format, mode)) {
    return { data: separationsZip(svg, format, stem, names, dxf), mime: ZIP_MIME, ext: 'zip' };
  }
  const text =
    format === 'svg' ? layeredSvg(svg, names) : convertSvg(svg, 'dxf', { ...dxf, names });
  return {
    data: fileBytes(text, format),
    mime: FORMAT_INFO[format].mime,
    ext: FORMAT_INFO[format].ext,
  };
}
