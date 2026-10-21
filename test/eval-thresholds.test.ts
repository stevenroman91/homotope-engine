import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Thresholds } from '../src/eval/run.ts';

/**
 * T08 — Garde des seuils d'évaluation : les exigences atteintes par T08 sont
 * figées ici. Élargir un seuil au-delà fait échouer ce test (on corrige
 * l'algorithme, pas le seuil).
 */
const { fixtures } = JSON.parse(readFileSync('scripts/eval-thresholds.json', 'utf8')) as {
  fixtures: Record<string, Thresholds>;
};
const cases = (
  JSON.parse(readFileSync('scripts/eval-cases.json', 'utf8')) as { cases: { name: string }[] }
).cases.map((c) => c.name);

describe('seuils T08', () => {
  it('chaque cas a ses seuils', () => {
    for (const name of cases) expect(fixtures[name], name).toBeDefined();
  });

  it('0 liseré partout', () => {
    for (const name of cases) expect(fixtures[name]!.seamsMax, name).toBe(0);
  });

  it('topologie exacte (composantes ET trous)', () => {
    const exact = [
      'logo-flat',
      'logo-aa',
      'logo-jpeg',
      'text',
      'pixel-art',
      'alpha',
      'illustration',
      'photo',
      'icon-64',
      'line-drawing',
      'anneau',
      'anneau-barre',
      'lettres-geo',
      'text-nb',
      'logo-aa-nb',
    ];
    for (const name of exact) expect(fixtures[name]!.holesExact, name).toBe(true);
  });

  it('SSIM minimal : cibles du ticket', () => {
    const min: Record<string, number> = {
      'logo-flat': 0.97,
      'logo-aa': 0.97,
      'logo-jpeg': 0.97,
      text: 0.97,
      alpha: 0.97,
      illustration: 0.95,
      'pixel-art': 0.9999,
      // T33 : tracé centre-ligne, seuil fixé sur le prototype mesuré.
      'line-drawing': 0.97,
    };
    for (const [name, v] of Object.entries(min)) {
      expect(fixtures[name]!.ssimMin, name).toBeGreaterThanOrEqual(v);
    }
    expect(fixtures['pixel-art']!.meanErrorMax).toBe(0);
  });

  it('nœuds : au plus +20 % sur les mesures T07 (logos, texte, alpha)', () => {
    const t07: Record<string, number> = {
      'logo-flat': 62,
      'logo-aa': 62,
      'logo-jpeg': 64,
      text: 266,
      alpha: 49,
    };
    for (const [name, v] of Object.entries(t07)) {
      expect(fixtures[name]!.nodesMax, name).toBeLessThanOrEqual(Math.floor(v * 1.2));
    }
  });
});

/**
 * R3 — Ligne de base de TOUS les seuils (valeurs de T08). Un seuil ne peut que se
 * resserrer : pour le resserrer, mettre à jour cette ligne de base dans la même PR.
 * Les gardes ci-dessus ne couvraient que quelques champs (bytesMax, nodesMax de six
 * cas, ssimMin de sept cas…) : élargir `photo.bytesMax` passait inaperçu.
 */
// T125d : tous les cas resserrés aux valeurs du moteur T125a–c (mêmes règles, jamais élargis).
const BASELINE: Record<string, Thresholds> = {
  'logo-flat': {
    ssimMin: 0.989,
    meanErrorMax: 1.24,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 45,
    bytesMax: 985,
    circleDeviationMax: 0.025,
    concaveTurnsMax: 0,
  },
  'logo-aa': {
    ssimMin: 0.996,
    meanErrorMax: 0.67,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 45,
    bytesMax: 987,
    circleDeviationMax: 0.025,
    concaveTurnsMax: 0,
  },
  'logo-jpeg': {
    ssimMin: 0.978,
    meanErrorMax: 2.43,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 43,
    bytesMax: 907,
    circleDeviationMax: 0.088,
    concaveTurnsMax: 0,
  },
  text: {
    ssimMin: 0.97,
    meanErrorMax: 3.69,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 169,
    bytesMax: 3221,
  },
  'pixel-art': {
    ssimMin: 0.9999,
    meanErrorMax: 0,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 112,
    bytesMax: 730,
  },
  illustration: {
    ssimMin: 0.954,
    meanErrorMax: 8.57,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 166,
    bytesMax: 3790,
  },
  photo: {
    ssimMin: 0.775,
    meanErrorMax: 11.66,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 1688,
    bytesMax: 24836,
  },
  alpha: {
    ssimMin: 0.993,
    meanErrorMax: 0.96,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 58,
    bytesMax: 1536,
    circleDeviationMax: 1.143,
    concaveTurnsMax: 160.2,
  },
  badge: {
    ssimMin: 0.955,
    meanErrorMax: 8.79,
    seamsMax: 0,
    holesExact: false,
    nodesMax: 215,
    bytesMax: 2946,
  },
  'icon-64': {
    ssimMin: 0.95,
    meanErrorMax: 12.93,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 111,
    bytesMax: 2649,
  },
  // T33 — Tracé centre-ligne, posé sur le prototype mesuré (même règle que T08).
  'line-drawing': {
    ssimMin: 0.98,
    meanErrorMax: 3.24,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 123,
    bytesMax: 3723,
  },
  // T125b — Formes exactes, posées sur le moteur ACTUEL (seuils généraux : règle de T08 ;
  // formes : mesure × 1,1). T125a/T125c les resserrent, jamais ne les élargissent.
  anneau: {
    ssimMin: 0.998,
    meanErrorMax: 0.31,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 16,
    bytesMax: 588,
    circleDeviationMax: 0.042,
    concaveTurnsMax: 0,
  },
  'anneau-barre': {
    ssimMin: 0.998,
    meanErrorMax: 0.44,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 72,
    bytesMax: 1101,
    circleDeviationMax: 0.623,
    concaveTurnsMax: 0,
    lineDeviationMax: 0.509,
  },
  'lettres-geo': {
    ssimMin: 0.991,
    meanErrorMax: 1.42,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 42,
    bytesMax: 1224,
    circleDeviationMax: 1.365,
    concaveTurnsMax: 52.2,
    lineDeviationMax: 0.81,
  },
  // T125a : Noir et blanc, mesuré sur le moteur sans `fit.exactShapes` (règles de T08).
  'text-nb': {
    ssimMin: 0.965,
    meanErrorMax: 3.93,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 328,
    bytesMax: 5850,
  },
  'logo-aa-nb': {
    ssimMin: 0.622,
    meanErrorMax: 61.34,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 78,
    bytesMax: 1547,
    circleDeviationMax: 0.025,
    concaveTurnsMax: 0,
  },
};

/** Champs d'un seuil `current` plus larges que ceux de `base` (vide = rien d'élargi). */
function widened(base: Thresholds, current: Thresholds): string[] {
  const out: string[] = [];
  if (!(current.ssimMin >= base.ssimMin)) out.push('ssimMin');
  if (!(current.meanErrorMax <= base.meanErrorMax)) out.push('meanErrorMax');
  if (!(current.seamsMax <= base.seamsMax)) out.push('seamsMax');
  if (base.holesExact && !current.holesExact) out.push('holesExact');
  if (!(current.nodesMax <= base.nodesMax)) out.push('nodesMax');
  if (!(current.bytesMax <= base.bytesMax)) out.push('bytesMax');
  // T125b : un seuil de forme de la ligne de base ne disparaît pas et ne grandit pas.
  for (const k of ['circleDeviationMax', 'concaveTurnsMax', 'lineDeviationMax'] as const) {
    const b = base[k];
    const c = current[k];
    if (b !== undefined && !(c !== undefined && c <= b)) out.push(k);
  }
  return out;
}

describe('seuils : jamais élargis (R3)', () => {
  it('la ligne de base couvre exactement les cas du harnais', () => {
    expect(Object.keys(BASELINE).sort()).toEqual([...cases].sort());
    expect(Object.keys(fixtures).sort()).toEqual([...cases].sort());
  });

  it('aucun champ de aucun cas n’est plus large que la ligne de base', () => {
    for (const name of cases) expect(widened(BASELINE[name]!, fixtures[name]!), name).toEqual([]);
  });

  it('le détecteur signale chaque champ élargi', () => {
    const b = BASELINE['photo']!;
    expect(widened(b, { ...b, ssimMin: b.ssimMin - 0.01 })).toEqual(['ssimMin']);
    expect(widened(b, { ...b, meanErrorMax: b.meanErrorMax + 1 })).toEqual(['meanErrorMax']);
    expect(widened(b, { ...b, seamsMax: 1 })).toEqual(['seamsMax']);
    expect(widened(b, { ...b, holesExact: false })).toEqual(['holesExact']);
    expect(widened(b, { ...b, nodesMax: b.nodesMax + 1 })).toEqual(['nodesMax']);
    expect(widened(b, { ...b, bytesMax: b.bytesMax * 10 })).toEqual(['bytesMax']);
    expect(widened(b, { ...b, bytesMax: b.bytesMax - 1 })).toEqual([]);
    const r = BASELINE['anneau-barre']!;
    expect(widened(r, { ...r, circleDeviationMax: r.circleDeviationMax! + 0.01 })).toEqual([
      'circleDeviationMax',
    ]);
    expect(widened(r, { ...r, concaveTurnsMax: 1 })).toEqual(['concaveTurnsMax']);
    const withoutLine: Thresholds = { ...r };
    delete withoutLine.lineDeviationMax;
    expect(widened(r, withoutLine)).toEqual(['lineDeviationMax']);
    expect(widened(r, { ...r, circleDeviationMax: 0.1 })).toEqual([]);
  });

  it('seuils de formes exactes (T125b) : exactement les cas qui déclarent `expected`', () => {
    const all = (
      JSON.parse(readFileSync('scripts/eval-cases.json', 'utf8')) as {
        cases: { name: string; expected?: { circles?: unknown[]; lines?: unknown[] } }[];
      }
    ).cases;
    for (const c of all) {
      const t = fixtures[c.name]!;
      const circles = (c.expected?.circles ?? []).length > 0;
      const lines = (c.expected?.lines ?? []).length > 0;
      expect(t.circleDeviationMax !== undefined, `${c.name} circleDeviationMax`).toBe(circles);
      expect(t.concaveTurnsMax !== undefined, `${c.name} concaveTurnsMax`).toBe(circles);
      expect(t.lineDeviationMax !== undefined, `${c.name} lineDeviationMax`).toBe(lines);
    }
    for (const name of ['anneau', 'anneau-barre', 'lettres-geo', 'logo-aa']) {
      expect(fixtures[name]!.circleDeviationMax, name).toBeDefined();
    }
  });
});
