import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Garde « moteur sans DOM » (relecture R3, #21, point 2) : la règle ESLint de `src/engine/`
// interdit tout global de navigateur hors liste blanche, pas seulement `document`.
describe('ESLint : moteur pur', () => {
  it('refuse ImageData et DOMParser sous src/engine/', { timeout: 30_000 }, async () => {
    const file = join(process.cwd(), 'src/engine', `__garde-dom-${process.pid}.ts`);
    writeFileSync(
      file,
      'export const a = new ImageData(1, 1);\nexport const b = new DOMParser();\n',
    );
    try {
      const [result] = await new ESLint().lintFiles([file]);
      const hits = result!.messages
        .filter((m) => m.ruleId === 'no-restricted-globals')
        .map((m) => m.message);
      expect(result!.errorCount).toBeGreaterThanOrEqual(2);
      expect(hits.some((m) => m.includes('ImageData'))).toBe(true);
      expect(hits.some((m) => m.includes('DOMParser'))).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('laisse passer la liste blanche (performance, structuredClone, console)', async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintText(
      'export const t = performance.now();\nexport const c = structuredClone([1]);\nconsole.log(t, c);\n',
      { filePath: join(process.cwd(), 'src/engine/__virtuel.ts') },
    );
    expect(result!.messages.filter((m) => m.ruleId === 'no-restricted-globals')).toEqual([]);
  });
});
