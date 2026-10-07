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
const BASELINE: Record<string, Thresholds> = {
  'logo-flat': {
    ssimMin: 0.982,
    meanErrorMax: 1.58,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 45,
    bytesMax: 985,
  },
  'logo-aa': {
    ssimMin: 0.991,
    meanErrorMax: 0.99,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 45,
    bytesMax: 987,
  },
  'logo-jpeg': {
    ssimMin: 0.974,
    meanErrorMax: 2.7,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 43,
    bytesMax: 907,
  },
  text: {
    ssimMin: 0.97,
    meanErrorMax: 3.69,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 169,
    bytesMax: 3241,
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
    ssimMin: 0.988,
    meanErrorMax: 1.73,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 58,
    bytesMax: 1536,
  },
  badge: {
    ssimMin: 0.947,
    meanErrorMax: 9.47,
    seamsMax: 0,
    holesExact: false,
    nodesMax: 215,
    bytesMax: 2946,
  },
  'icon-64': {
    ssimMin: 0.939,
    meanErrorMax: 13.53,
    seamsMax: 0,
    holesExact: true,
    nodesMax: 115,
    bytesMax: 2832,
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
  });
});
