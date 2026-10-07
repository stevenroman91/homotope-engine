import { describe, expect, it } from 'vitest';
import { reverseFittedChain } from '../src/engine/fit/index.ts';
import type { FittedChain } from '../src/engine/types.ts';

describe('reverseFittedChain', () => {
  it('inverse une chaîne mixte ligne/cubique en conservant la géométrie', () => {
    const fc: FittedChain = {
      chain: 7,
      start: [0, 0],
      segments: [
        { kind: 'line', x: 10, y: 0 },
        { kind: 'cubic', c1x: 12, c1y: 3, c2x: 12, c2y: 7, x: 10, y: 10 },
      ],
    };
    const r = reverseFittedChain(fc);
    expect(r.start).toEqual([10, 10]);
    expect(r.segments).toEqual([
      { kind: 'cubic', c1x: 12, c1y: 7, c2x: 12, c2y: 3, x: 10, y: 0 },
      { kind: 'line', x: 0, y: 0 },
    ]);
    // Involution : inverser deux fois rend la chaîne d'origine.
    expect(reverseFittedChain(r)).toEqual(fc);
  });

  it('gère une chaîne vide', () => {
    const fc: FittedChain = { chain: 1, start: [3, 4], segments: [] };
    expect(reverseFittedChain(fc)).toEqual(fc);
  });
});
