/**
 * Codecs PNG / JPEG pour Node UNIQUEMENT (tests, fixtures, évaluation).
 *
 * Ne JAMAIS importer ce fichier depuis le code du navigateur ni depuis le reste du
 * moteur : le navigateur décode avec `createImageBitmap`/canvas. ESLint le garde
 * (`no-restricted-imports`) ; le paquet npm l'expose seul, en `@homotope/engine/node` (T61).
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RasterImage } from '../types.ts';

/** Décode un PNG (toute profondeur / tout type de couleur) en RGBA 8 bits. */
export function decodePng(bytes: Uint8Array): RasterImage {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  data.set(png.data);
  return { width: png.width, height: png.height, data };
}

/** Encode en PNG RGBA 8 bits (sans perte). */
export function encodePng(image: RasterImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height, colorType: 6 });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}

/** Décode un JPEG en RGBA 8 bits (alpha = 255). */
export function decodeJpeg(bytes: Uint8Array): RasterImage {
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const data = new Uint8ClampedArray(raw.width * raw.height * 4);
  data.set(raw.data);
  return { width: raw.width, height: raw.height, data };
}

/** Encode en JPEG (qualité 1..100) ; l'alpha est ignoré. */
export function encodeJpeg(image: RasterImage, quality = 90): Uint8Array {
  const out = jpeg.encode(
    { width: image.width, height: image.height, data: image.data },
    Math.round(Math.min(100, Math.max(1, quality))),
  );
  return new Uint8Array(out.data);
}
