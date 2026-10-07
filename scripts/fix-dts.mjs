// TypeScript rewrites `.ts` → `.js` in emitted JavaScript (`rewriteRelativeImportExtensions`)
// but not in `.d.ts` files: align them so that consumers resolve the declarations without
// `allowImportingTsExtensions`. Usage: `node scripts/fix-dts.mjs [dist]`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPORT_TS = /((?:\bfrom\s*|\bimport\s*\(\s*)['"])(\.{1,2}\/[^'"\n]+?)\.ts(['"])/g;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.d.ts')) {
      const before = readFileSync(path, 'utf8');
      const after = before.replace(IMPORT_TS, '$1$2.js$3');
      if (after !== before) writeFileSync(path, after);
    }
  }
}

walk(process.argv[2] ?? 'dist');
