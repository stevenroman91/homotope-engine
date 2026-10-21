// T102 : budgets de performance CALIBRÉS sur la machine qui exécute les tests.
//
// Une référence PURE et déterministe (travail CPU fixe sur un `Float64Array`) est chronométrée
// juste avant la mesure, après échauffement. Le facteur `max(1, mesure / nominal)`, plafonné à
// `MAX_PERF_FACTOR`, multiplie le budget nominal du test : sur une machine normale rien ne change,
// sur un runner deux fois plus lent le budget suit, et une vraie régression (×5) reste ROUGE.
// Jamais relâché par l'environnement (aucune variable lue) ; les budgets nominaux sont inchangés.

/**
 * Durée de `referenceWork()` sur une machine au repos, figée le 2026-10-14 : médiane de 5
 * appels de `measureReference()` (60,31 / 56,86 / 58,74 / 58,77 / 58,59 ms ; conteneur de
 * développement : « Intel(R) Xeon(R) Processor », 4 cœurs, Node v22.22.0, charge 0,09). Une
 * autre machine mesure autre chose (un relecteur : 83–96 ms sur un Xeon 2,8 GHz à 4 cœurs, Node
 * 22) ; c'est le but du facteur. À remesurer seulement si la référence change.
 *
 * Compromis : le test honnête occupe 35 à 65 % de son budget selon la machine (fit 35–40 %,
 * segment 42–53 % ici). Une régression ×3 et au-delà reste rouge sur toute machine ; ×1,5 à ×2
 * peut passer selon la marge. Au-delà du plafond ×4 (machine ≈ 6 fois plus lente que le nominal),
 * le test honnête échoue lui-même.
 */
export const NOMINAL_REFERENCE_MS = 58.7;

/** Plafond du facteur : au-delà, la lenteur n'est plus celle de la machine. */
export const MAX_PERF_FACTOR = 4;

const N = 1 << 20;
const PASSES = 8;

/** Travail CPU fixe (tableau typé, lectures voisines, racines) ; renvoie une somme de contrôle. */
export function referenceWork(): number {
  const a = new Float64Array(N);
  for (let i = 0; i < N; i++) a[i] = ((Math.imul(i, 2654435761) >>> 0) / 4294967296) * 2 - 1;
  let acc = 0;
  for (let p = 0; p < PASSES; p++) {
    for (let i = 1; i < N; i++) {
      const v = a[i]! * 0.5 + a[i - 1]! * 0.25 + Math.sqrt(Math.abs(a[i]!) + 1) * 0.125;
      a[i] = v - Math.floor(v);
      acc += a[i]!;
    }
  }
  return acc;
}

/** Médiane de `runs` chronométrages de la référence, après `warmup` passages (JIT). */
export function measureReference(runs = 5, warmup = 2): number {
  let sink = 0;
  for (let i = 0; i < warmup; i++) sink += referenceWork();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    sink += referenceWork();
    times.push(performance.now() - t0);
  }
  if (Number.isNaN(sink)) throw new Error('référence de performance : somme invalide');
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)]!;
}

/** Facteur de lenteur de la machine : 1 sous le nominal, proportionnel au-dessus, plafonné. */
export function perfFactor(referenceMs: number, nominalMs = NOMINAL_REFERENCE_MS): number {
  return Math.min(MAX_PERF_FACTOR, Math.max(1, referenceMs / nominalMs));
}

export interface PerfBudget {
  /** Durée de la référence mesurée sur cette machine. */
  referenceMs: number;
  factor: number;
  /** Budget nominal du test (machine normale). */
  nominalMs: number;
  /** Budget appliqué : nominal × facteur. */
  budgetMs: number;
}

/** Budget d'un test pour une référence mesurée (`measureReference()`). */
export function perfBudget(nominalMs: number, referenceMs: number): PerfBudget {
  const factor = perfFactor(referenceMs);
  return { referenceMs, factor, nominalMs, budgetMs: nominalMs * factor };
}

/** Message lisible : mesure, référence, facteur et budget. */
export function describeBudget(label: string, measuredMs: number, b: PerfBudget): string {
  const ms = (x: number) => `${Math.round(x)} ms`;
  return (
    `${label} : ${ms(measuredMs)} mesurés pour un budget de ${ms(b.budgetMs)} ` +
    `(nominal ${ms(b.nominalMs)} × facteur ${b.factor.toFixed(2)} ; référence ` +
    `${b.referenceMs.toFixed(1)} ms sur cette machine, nominale ${NOMINAL_REFERENCE_MS} ms, ` +
    `facteur plafonné à ×${MAX_PERF_FACTOR})`
  );
}

/** Échoue (message lisible) si `measuredMs` dépasse le budget ; sinon renvoie le message. */
export function assertWithinBudget(label: string, measuredMs: number, b: PerfBudget): string {
  const text = describeBudget(label, measuredMs, b);
  if (!(measuredMs < b.budgetMs)) throw new Error(`hors budget — ${text}`);
  return text;
}

/** Imprime la mesure (stderr : Vitest tait la console des tests qui passent). */
export function printBudget(text: string): void {
  process.stderr.write(`[perf-budget] ${text}\n`);
}
