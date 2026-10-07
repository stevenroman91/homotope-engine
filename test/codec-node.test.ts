import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg, decodePng, encodeJpeg, encodePng } from '../src/engine/image/codec-node.ts';
import { createRaster } from '../src/engine/image/raster.ts';
import type { RasterImage } from '../src/engine/types.ts';
import { mulberry32 } from '../scripts/lib/draw.ts';
import { FIXTURES, LOGO_COLORS, PIXEL_ART_COLORS } from '../scripts/lib/fixtures.ts';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

function randomImage(w: number, h: number, seed: number): RasterImage {
  const img = createRaster(w, h);
  const rng = mulberry32(seed);
  for (let i = 0; i < img.data.length; i++) img.data[i] = Math.floor(rng() * 256);
  return img;
}

function distinctColors(img: RasterImage): Set<number> {
  const s = new Set<number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) s.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
  return s;
}

function readFixture(file: string): RasterImage {
  const bytes = readFileSync(join(FIXTURE_DIR, file));
  return file.endsWith('.jpg') ? decodeJpeg(bytes) : decodePng(bytes);
}

describe('codecs Node', () => {
  it('aller-retour PNG exact (RGBA, alpha compris)', () => {
    const img = randomImage(37, 23, 3);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(37);
    expect(back.height).toBe(23);
    expect(back.data).toEqual(img.data);
  });

  it('aller-retour JPEG approché, alpha opaque', () => {
    const img = createRaster(32, 32);
    for (let i = 0; i < img.data.length; i += 4) {
      const x = (i / 4) % 32;
      img.data[i] = x * 8;
      img.data[i + 1] = 100;
      img.data[i + 2] = 255 - x * 8;
      img.data[i + 3] = 255;
    }
    const back = decodeJpeg(encodeJpeg(img, 95));
    expect(back.width).toBe(32);
    expect(back.height).toBe(32);
    let err = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) err += Math.abs(back.data[i + c]! - img.data[i + c]!);
      expect(back.data[i + 3]).toBe(255);
    }
    expect(err / (32 * 32 * 3)).toBeLessThan(3);
  });
});

describe('fixtures', () => {
  it.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s : présente, relisible et identique à sa génération',
    (file, spec) => {
      const path = join(FIXTURE_DIR, file);
      expect(existsSync(path), `${file} manquant : lancer npm run fixtures`).toBe(true);
      const onDisk = readFixture(file);
      const built = spec.build();
      expect(onDisk.width).toBe(built.width);
      expect(onDisk.height).toBe(built.height);
      if (spec.format === 'png') {
        expect(onDisk.data).toEqual(built.data);
      } else {
        expect(onDisk.data).toEqual(decodeJpeg(encodeJpeg(built, spec.quality)).data);
      }
    },
  );

  it('logo-flat : exactement 4 couleurs, opaque', () => {
    const img = readFixture('logo-flat.png');
    const expected = new Set(
      Object.values(LOGO_COLORS).map(([r, g, b]) => (r << 16) | (g << 8) | b),
    );
    expect(distinctColors(img)).toEqual(expected);
  });

  it('logo-aa / text : anti-aliasés (couleurs intermédiaires)', () => {
    expect(distinctColors(readFixture('logo-aa.png')).size).toBeGreaterThan(4);
    expect(distinctColors(readFixture('text.png')).size).toBeGreaterThan(2);
  });

  it('pixel-art : 32×32, 8 couleurs, aucun anti-aliasing', () => {
    const img = readFixture('pixel-art.png');
    expect([img.width, img.height]).toEqual([32, 32]);
    const expected = new Set(PIXEL_ART_COLORS.map(([r, g, b]) => (r << 16) | (g << 8) | b));
    expect(distinctColors(img)).toEqual(expected);
  });

  it('alpha : transparence totale, partielle et opacité', () => {
    const img = readFixture('alpha.png');
    let zero = 0;
    let partial = 0;
    let full = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      const a = img.data[i]!;
      if (a === 0) zero++;
      else if (a === 255) full++;
      else partial++;
    }
    expect(zero).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  });
});
