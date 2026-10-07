/**
 * T06 — Évaluation automatique : `npm run eval [-- --check] [--only <nom>]`.
 *
 * Pour chaque cas de `scripts/eval-cases.json` : vectorise la fixture, rastérise
 * le SVG (resvg), mesure, écrit `.eval-out/<nom>.svg|.png|-diff.png` et
 * `.eval-out/report.json`, affiche un tableau Markdown. `--check` compare aux
 * seuils de `scripts/eval-thresholds.json` et sort en code 1 s'il y a au moins
 * un dépassement (tous sont listés).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJpeg, decodePng, encodePng } from '../src/engine/image/codec-node.ts';
import { vectorize } from '../src/engine/pipeline.ts';
import {
  checkThresholds,
  evaluateCase,
  formatTable,
  type CaseReport,
  type EvalCase,
  type Thresholds,
} from '../src/eval/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.eval-out');

const args = process.argv.slice(2);
const check = args.includes('--check');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

const { cases } = JSON.parse(readFileSync(join(root, 'scripts/eval-cases.json'), 'utf8')) as {
  cases: EvalCase[];
};
const thresholds = JSON.parse(readFileSync(join(root, 'scripts/eval-thresholds.json'), 'utf8')) as {
  fixtures: Record<string, Thresholds>;
};

const selected = cases.filter((c) => !only || c.name === only);
if (selected.length === 0) {
  console.error(`Aucun cas sélectionné${only ? ` (--only ${only})` : ''}.`);
  process.exit(2);
}

const vectorizeFn = (
  image: Parameters<typeof vectorize>[0],
  options: Parameters<typeof vectorize>[1],
) => vectorize(image, options);

mkdirSync(outDir, { recursive: true });
const reports: CaseReport[] = [];
const failures: string[] = [];
for (const c of selected) {
  const bytes = new Uint8Array(readFileSync(join(root, 'test/fixtures', c.fixture)));
  const image = /\.jpe?g$/i.test(c.fixture) ? decodeJpeg(bytes) : decodePng(bytes);
  const out = evaluateCase(c, image, vectorizeFn);
  reports.push(out.report);
  writeFileSync(join(outDir, `${c.name}.svg`), out.svg);
  writeFileSync(join(outDir, `${c.name}.png`), encodePng(out.render));
  writeFileSync(join(outDir, `${c.name}-diff.png`), encodePng(out.diff));
  if (check) {
    const t = thresholds.fixtures[c.name];
    if (!t) failures.push(`${c.name} : aucun seuil dans scripts/eval-thresholds.json`);
    else failures.push(...checkThresholds(out.report, t));
  }
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify({ reports }, null, 2) + '\n');
console.log(formatTable(reports));
console.log(`\nSorties : ${outDir}`);
if (check) {
  if (failures.length > 0) {
    console.error(`\n${failures.length} dépassement(s) de seuil :`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nTous les seuils sont respectés.');
}
