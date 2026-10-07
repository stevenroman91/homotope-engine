import { describe, expect, it } from 'vitest';
import { formatTicks, serializeSubpaths } from '../src/engine/svg/path.ts';
import { hexColor } from '../src/engine/svg/index.ts';
import type { SubPath } from '../src/engine/svg/rings.ts';
import { countNodes, parsePathData, PathParseError, samplePath } from '../src/engine/svg/parse.ts';
import { wellFormedErrors } from '../src/engine/svg/wellformed.ts';
import { rng } from './label-helpers.ts';

const line = (x: number, y: number) => ({ kind: 'line' as const, x, y });

describe('formatTicks', () => {
  it('supprime les zéros inutiles et le -0', () => {
    expect(formatTicks(0, 2)).toBe('0');
    expect(formatTicks(150, 2)).toBe('1.5');
    expect(formatTicks(100, 2)).toBe('1');
    expect(formatTicks(5, 1)).toBe('.5');
    expect(formatTicks(-5, 2)).toBe('-.05');
    expect(formatTicks(-1234, 0)).toBe('-1234');
    expect(formatTicks(10203, 3)).toBe('10.203');
  });
});

describe('hexColor', () => {
  it('raccourcit #rrggbb en #rgb quand possible', () => {
    expect(hexColor([255, 255, 255])).toBe('#fff');
    expect(hexColor([17, 34, 51])).toBe('#123');
    expect(hexColor([18, 34, 51])).toBe('#122233');
    expect(hexColor([300, -4, 127.6])).toBe('#ff0080');
  });
});

describe('serializeSubpaths', () => {
  it('sous-tracé ouvert (T08) : ni Z ni ligne finale retirée ; « m » relatif à sa fin', () => {
    const back: SubPath = { start: [0, 0], segments: [line(10, 0), line(0, 0)], open: true };
    expect(serializeSubpaths([back], 1, 2).d).toBe('M0 0h10H0');
    const a: SubPath = { start: [0, 0], segments: [line(100, 0)], open: true };
    const b: SubPath = { start: [101, 2], segments: [line(101, 6)], open: true };
    const r = serializeSubpaths([a, b], 1, 2);
    expect(r.d).toBe('M0 0h100m1 2v4');
    expect(r.nodes).toBe(4);
    expect(r.subpaths).toBe(2);
  });

  it('h / v relatifs, lettre implicite, Z sans ligne finale', () => {
    const sq: SubPath = { start: [0, 0], segments: [line(10, 0), line(10, 10), line(0, 10)] };
    const r = serializeSubpaths([sq], 1, 2);
    expect(r.d).toBe('M0 0h10v10H0Z');
    expect(r.nodes).toBe(4);
    expect(r.subpaths).toBe(1);
  });

  it('séparateurs minimaux : pas d’espace avant « - » ni avant « . » après un décimal', () => {
    const sp: SubPath = {
      start: [100.5, 100.5],
      segments: [line(99.75, 101.25), line(100.25, 100.75)],
    };
    const r = serializeSubpaths([sp], 1, 2);
    expect(r.d).toBe('M100.5 100.5l-.75.75.5-.5Z');
    expect(parsePathData(r.d)[0]!.segments).toEqual(sp.segments);
    // Absolu quand il est plus court.
    const abs = serializeSubpaths(
      [{ start: [0.5, 0.5], segments: [line(-1, 2.25), line(1, 1)] }],
      1,
      2,
    );
    expect(abs.d).toBe('M.5.5L-1 2.25 1 1Z');
  });

  it('segments de longueur nulle après arrondi omis ; sous-tracé vide supprimé', () => {
    const sp: SubPath = { start: [0, 0], segments: [line(0.001, 0), line(4, 0), line(4, 4)] };
    const tiny: SubPath = { start: [1, 1], segments: [line(1.001, 1), line(1, 1.002)] };
    const r = serializeSubpaths([sp, tiny], 1, 1);
    expect(r.d).toBe('M0 0h4v4Z');
    expect(r.subpaths).toBe(1);
    expect(r.nodes).toBe(3);
  });

  it('m relatif au départ du sous-tracé précédent quand plus court', () => {
    const a: SubPath = { start: [1000, 1000], segments: [line(1010, 1000), line(1010, 1010)] };
    const b: SubPath = { start: [1002, 1002], segments: [line(1003, 1002), line(1003, 1003)] };
    const r = serializeSubpaths([a, b], 1, 0);
    expect(r.d).toBe('M1000 1000h10v10Zm2 2h1v1Z');
    const p = parsePathData(r.d);
    expect(p[1]!.start).toEqual([1002, 1002]);
  });

  it('cubiques : relatif ou absolu, le plus court ; division par scale', () => {
    const sp: SubPath = {
      start: [200, 200],
      segments: [
        { kind: 'cubic', c1x: 202, c1y: 204, c2x: 206, c2y: 208, x: 210, y: 200 },
        line(200, 220),
      ],
    };
    const r = serializeSubpaths([sp], 2, 0);
    expect(r.d).toBe('M100 100c1 2 3 4 5 0l-5 10Z');
  });

  it('aller-retour aléatoire : relire d redonne les points à la précision près', () => {
    const rand = rng(42);
    for (let trial = 0; trial < 40; trial++) {
      const precision = trial % 5;
      const scale = 1 + (trial % 3);
      const subs: SubPath[] = [];
      for (let s = 0; s < 3; s++) {
        const start: [number, number] = [rand() * 400 - 50, rand() * 400 - 50];
        const segments: SubPath['segments'] = [];
        for (let k = 0; k < 6; k++) {
          const p = (): number => rand() * 400 - 50;
          segments.push(
            rand() < 0.5
              ? line(p(), p())
              : { kind: 'cubic', c1x: p(), c1y: p(), c2x: p(), c2y: p(), x: p(), y: p() },
          );
        }
        segments.push({ kind: 'cubic', c1x: 1, c1y: 2, c2x: 3, c2y: 4, x: start[0], y: start[1] });
        subs.push({ start, segments });
      }
      const r = serializeSubpaths(subs, scale, precision);
      const parsed = parsePathData(r.d);
      expect(countNodes(parsed)).toBe(r.nodes);
      expect(parsed).toHaveLength(3);
      const tol = 0.5 * 10 ** -precision + 1e-9;
      parsed.forEach((sp, i) => {
        const src = subs[i]!;
        expect(Math.abs(sp.start[0] - src.start[0] / scale)).toBeLessThanOrEqual(tol);
        expect(Math.abs(sp.start[1] - src.start[1] / scale)).toBeLessThanOrEqual(tol);
        expect(sp.closed).toBe(true);
        sp.segments.forEach((seg, k) => {
          const o = src.segments[k]!;
          expect(Math.abs(seg.x - o.x / scale)).toBeLessThanOrEqual(tol);
          expect(Math.abs(seg.y - o.y / scale)).toBeLessThanOrEqual(tol);
        });
      });
      // Pas de -0, pas de zéro de tête, pas de zéro final, pas d'espace inutile.
      expect(r.d).not.toMatch(/-0(?![.\d])|(?<![\d.])0\d|\.\d*0(?!\d)| -|Z |[A-Za-z] /);
    }
  });
});

describe('parsePathData', () => {
  it('lit absolu, relatif, h/v, répétition implicite, m après Z', () => {
    const p = parsePathData('M1 1L3 1 3 3h-2zm4 0l1 0 0 1c0 1 1 1 1 0Z');
    expect(p).toHaveLength(2);
    expect(p[0]!.segments).toEqual([line(3, 1), line(3, 3), line(1, 3)]);
    expect(p[1]!.start).toEqual([5, 1]);
    expect(p[1]!.segments[2]).toEqual({
      kind: 'cubic',
      c1x: 6,
      c1y: 3,
      c2x: 7,
      c2y: 3,
      x: 7,
      y: 2,
    });
    // M suivi de coordonnées = L implicite.
    expect(parsePathData('M0 0 2 0 2 2z')[0]!.segments).toEqual([line(2, 0), line(2, 2)]);
    expect(countNodes(p)).toBe(3 + 1 + 3 + 1);
  });

  it('échantillonne les cubiques et referme le sous-tracé', () => {
    const [poly] = samplePath(parsePathData('M0 0C0 1 1 1 1 0Z'), 4);
    expect(poly!.length / 2).toBe(1 + 4 + 1);
    expect([poly![poly!.length - 2], poly![poly!.length - 1]]).toEqual([0, 0]);
  });

  it('rejette une syntaxe inattendue', () => {
    expect(() => parsePathData('M0 0A1 1 0 0 1 2 2')).toThrow(PathParseError);
    expect(() => parsePathData('L1 1')).toThrow(PathParseError);
    expect(() => parsePathData('M0 0L1')).toThrow(PathParseError);
  });
});

describe('wellFormedErrors', () => {
  it('accepte un SVG minimal', () => {
    expect(
      wellFormedErrors(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g><path d="M0 0h1v1Z" fill=\'#f00\'/></g></svg>',
      ),
    ).toEqual([]);
  });

  it('détecte balises déséquilibrées, attributs non cités, entités, racines multiples', () => {
    expect(wellFormedErrors('<svg><path d="M0 0"></svg>')).not.toEqual([]);
    expect(wellFormedErrors('<svg><path d=M0/></svg>')).not.toEqual([]);
    expect(wellFormedErrors('<svg a="1" a="2"/>')).not.toEqual([]);
    expect(wellFormedErrors('<svg a="x&y"/>')).not.toEqual([]);
    expect(wellFormedErrors('<svg/><svg/>')).not.toEqual([]);
    expect(wellFormedErrors('<svg>')).not.toEqual([]);
    expect(wellFormedErrors('texte')).not.toEqual([]);
    expect(wellFormedErrors('<svg a="&amp;"/>')).toEqual([]);
  });
});
