import { describe, expect, it } from 'vitest';
import { globalProgress, STAGE_WEIGHTS, checkCancel } from '../src/engine/pipeline.ts';
import { CancelledError, STAGES } from '../src/engine/types.ts';

describe('progression du pipeline', () => {
  it('les poids des étapes somment à 1', () => {
    const sum = STAGES.reduce((s, st) => s + STAGE_WEIGHTS[st], 0);
    expect(sum).toBeCloseTo(1, 9);
  });
  it('est monotone à travers les étapes', () => {
    let last = -1;
    for (const st of STAGES) {
      for (const p of [0, 0.5, 1]) {
        const g = globalProgress(st, p).progress;
        expect(g).toBeGreaterThanOrEqual(last);
        last = g;
      }
    }
    expect(last).toBeCloseTo(1, 9);
  });
  it('checkCancel lève CancelledError sur un jeton annulé', () => {
    expect(() => checkCancel({ cancel: { cancelled: true } })).toThrow(CancelledError);
    expect(() => checkCancel({ cancel: { cancelled: false } })).not.toThrow();
    expect(() => checkCancel()).not.toThrow();
  });
});
