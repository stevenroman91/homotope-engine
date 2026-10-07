import type { RasterImage, Rgb } from '../types.ts';

/** Crée une image RGBA vide (transparente). */
export function createRaster(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Remplit toute l'image d'une couleur opaque (utilitaire des tests et des fixtures). */
export function fillRaster(img: RasterImage, rgb: Rgb): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgb[0];
    d[i + 1] = rgb[1];
    d[i + 2] = rgb[2];
    d[i + 3] = 255;
  }
}

export function getPixel(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

export function setPixel(img: RasterImage, x: number, y: number, rgba: readonly number[]): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0]!;
  img.data[i + 1] = rgba[1]!;
  img.data[i + 2] = rgba[2]!;
  img.data[i + 3] = rgba[3] ?? 255;
}
