/**
 * T01 — Génère `test/fixtures/` de façon reproductible (aucun aléa non seedé).
 * Usage : `npm run fixtures`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJpeg, encodePng } from '../src/engine/image/codec-node.ts';
import { FIXTURES } from './lib/fixtures.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

for (const spec of FIXTURES) {
  const img = spec.build();
  const bytes = spec.format === 'png' ? encodePng(img) : encodeJpeg(img, spec.quality);
  writeFileSync(join(outDir, spec.file), bytes);
  console.log(`${spec.file.padEnd(18)} ${img.width}×${img.height}  ${bytes.length} o`);
}
