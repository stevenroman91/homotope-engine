/**
 * Lecture d'un attribut `d` (sous-ensemble émis par Homotope : `M L H V C Z`,
 * absolus et relatifs, répétition implicite). Sert aux tests (aller-retour) et
 * à l'évaluation T06. Pur, sans DOM.
 */

export type ParsedSegment =
  | { kind: 'line'; x: number; y: number }
  | { kind: 'cubic'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

export interface ParsedSubpath {
  start: [number, number];
  /** Segments en coordonnées ABSOLUES. */
  segments: ParsedSegment[];
  closed: boolean;
}

export class PathParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathParseError';
  }
}

const TOKEN = /([MmLlHhVvCcZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0 };

/** Découpe `d` en sous-tracés absolus. Lève `PathParseError` sur une syntaxe inattendue. */
export function parsePathData(d: string): ParsedSubpath[] {
  const tokens: (string | number)[] = [];
  for (const m of d.matchAll(TOKEN)) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
    else if (m[4]) throw new PathParseError(`caractère inattendu « ${m[4]} » en ${m.index}`);
  }
  const out: ParsedSubpath[] = [];
  let cur: ParsedSubpath | null = null;
  let x = 0;
  let y = 0;
  let cmd = '';
  let i = 0;
  const num = (): number => {
    const v = tokens[i++];
    if (typeof v !== 'number') throw new PathParseError(`nombre attendu après ${cmd}`);
    return v;
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (typeof t === 'string') {
      cmd = t;
      i++;
    } else if (cmd === '' || cmd === 'Z' || cmd === 'z') {
      throw new PathParseError(`nombre ${t} sans commande`);
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (ARITY[up] === undefined) throw new PathParseError(`commande ${cmd} non prise en charge`);
    if (up === 'Z') {
      if (!cur) throw new PathParseError('Z sans sous-tracé');
      cur.closed = true;
      [x, y] = cur.start;
      continue;
    }
    if (up === 'M') {
      x = (rel ? x : 0) + num();
      y = (rel ? y : 0) + num();
      cur = { start: [x, y], segments: [], closed: false };
      out.push(cur);
      cmd = rel ? 'l' : 'L'; // répétition implicite après M = lineto
      continue;
    }
    if (!cur) throw new PathParseError(`${cmd} avant tout M`);
    if (up === 'L') {
      x = (rel ? x : 0) + num();
      y = (rel ? y : 0) + num();
      cur.segments.push({ kind: 'line', x, y });
    } else if (up === 'H') {
      x = (rel ? x : 0) + num();
      cur.segments.push({ kind: 'line', x, y });
    } else if (up === 'V') {
      y = (rel ? y : 0) + num();
      cur.segments.push({ kind: 'line', x, y });
    } else {
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      const c1x = ox + num();
      const c1y = oy + num();
      const c2x = ox + num();
      const c2y = oy + num();
      x = ox + num();
      y = oy + num();
      cur.segments.push({ kind: 'cubic', c1x, c1y, c2x, c2y, x, y });
    }
  }
  return out;
}

/** Nœuds au sens de `SvgStats.nodes` : un par `M`, un par segment. */
export function countNodes(subpaths: readonly ParsedSubpath[]): number {
  let n = 0;
  for (const s of subpaths) n += 1 + s.segments.length;
  return n;
}

/**
 * Polyligne échantillonnée de chaque sous-tracé : départ, puis chaque fin de
 * segment, les cubiques étant découpées en `steps` pas réguliers en t. Un
 * sous-tracé fermé est refermé sur son départ s'il n'y revient pas déjà.
 * Points entrelacés [x0, y0, x1, y1, …].
 */
export function samplePath(subpaths: readonly ParsedSubpath[], steps = 8): Float64Array[] {
  return subpaths.map((sp) => {
    const pts: number[] = [sp.start[0], sp.start[1]];
    let px = sp.start[0];
    let py = sp.start[1];
    for (const s of sp.segments) {
      if (s.kind === 'cubic') {
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const e = t * t * t;
          pts.push(
            a * px + b * s.c1x + c * s.c2x + e * s.x,
            a * py + b * s.c1y + c * s.c2y + e * s.y,
          );
        }
      }
      pts.push(s.x, s.y);
      px = s.x;
      py = s.y;
    }
    if (sp.closed && (px !== sp.start[0] || py !== sp.start[1])) pts.push(sp.start[0], sp.start[1]);
    return Float64Array.from(pts);
  });
}
