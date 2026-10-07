import type { SubPath } from './rings.ts';

/**
 * Sérialisation minimale d'un attribut `d`.
 *
 * Les coordonnées sont d'abord arrondies en « crans » entiers (1 cran =
 * 10^-precision unité d'origine) : l'absolu et le relatif se calculent sur ces
 * entiers, donc aucune dérive ne s'accumule et une même coordonnée de sommet
 * s'écrit toujours à l'identique quelle que soit la face qui la parcourt.
 *
 * Pour chaque segment, la plus courte des variantes équivalentes est retenue
 * (`L`/`l`/`H`/`h`/`V`/`v`, `C`/`c`, `M`/`m`), la lettre est omise quand elle
 * répète la commande précédente, et les séparateurs sont minimaux (aucun
 * espace avant un `-`, ni avant un `.` qui suit un nombre déjà décimal, ni
 * autour d'une lettre).
 */

/** Résultat : attribut `d` + nombre de nœuds (un par `M`, un par segment émis). */
export interface SerializedPath {
  d: string;
  nodes: number;
  subpaths: number;
}

/** Formate un nombre de crans : `-0` → `0`, zéros inutiles retirés (`0.50` → `.5`). */
export function formatTicks(t: number, precision: number): string {
  if (t === 0) return '0';
  const neg = t < 0;
  let s = String(Math.abs(t));
  if (precision > 0) {
    if (s.length <= precision) s = '0'.repeat(precision - s.length + 1) + s;
    let int = s.slice(0, s.length - precision);
    const frac = s.slice(s.length - precision).replace(/0+$/, '');
    if (int === '0') int = '';
    s = frac ? `${int}.${frac}` : int;
  }
  return neg ? `-${s}` : s;
}

/** Précision bornée à un entier 0..4. */
export function clampPrecision(p: number): number {
  return Math.min(4, Math.max(0, Math.round(Number.isFinite(p) ? p : 0)));
}

interface WriterState {
  /** Dernière lettre de commande écrite (implicite ou non), '' au début. */
  cmd: string;
  /** Dernier nombre écrit, ou null si le dernier jeton est une lettre. */
  num: string | null;
}

/** Morceau de `d` pour une commande, selon l'état courant (lettre implicite, séparateurs). */
function piece(state: WriterState, cmd: string, nums: string[]): { text: string; num: string } {
  let text = '';
  let prev = state.num;
  // Répétition implicite : interdite pour M/m (elle signifierait L/l).
  if (cmd !== state.cmd || cmd === 'M' || cmd === 'm' || prev === null) {
    text = cmd;
    prev = null;
  }
  for (const n of nums) {
    if (prev !== null && n[0] !== '-' && !(n[0] === '.' && prev.includes('.'))) text += ' ';
    text += n;
    prev = n;
  }
  return { text, num: prev! };
}

/**
 * Sérialise des sous-tracés (fermés par `Z`, sauf `open`) en un attribut `d`. Les abscisses sont
 * divisées par `scale`, les ordonnées par `scaleY` (= `scale` par défaut ; T12 : une image
 * réduite a des facteurs par axe légèrement différents, à l'arrondi de ses dimensions près). Les segments de longueur nulle APRÈS arrondi sont
 * omis, ainsi qu'une ligne finale revenant au départ (`Z` la trace) ; un
 * sous-tracé qui n'a plus aucun segment disparaît.
 */
export function serializeSubpaths(
  subpaths: readonly SubPath[],
  scale: number,
  precision: number,
  scaleY: number = scale,
): SerializedPath {
  const p = clampPrecision(precision);
  const k = 10 ** p / scale;
  const ky = 10 ** p / scaleY;
  const q = (v: number): number => {
    const t = Math.round(v * k);
    return t === 0 ? 0 : t; // pas de -0
  };
  const qy = (v: number): number => {
    const t = Math.round(v * ky);
    return t === 0 ? 0 : t;
  };
  const fmt = (t: number): string => formatTicks(t, p);
  const state: WriterState = { cmd: '', num: null };
  let d = '';
  let nodes = 0;
  let count = 0;
  // Point courant (crans) : départ du sous-tracé précédent après `Z`.
  let cx = 0;
  let cy = 0;
  const write = (cands: [string, number[]][]): void => {
    let best: { text: string; num: string; cmd: string } | null = null;
    for (const [cmd, vals] of cands) {
      const r = piece(state, cmd, vals.map(fmt));
      if (!best || r.text.length < best.text.length) best = { ...r, cmd };
    }
    d += best!.text;
    state.cmd = best!.cmd;
    state.num = best!.num;
  };

  for (const sp of subpaths) {
    const sx = q(sp.start[0]);
    const sy = qy(sp.start[1]);
    // Segments en crans, absolus ; longueur nulle omise.
    const segs: number[][] = [];
    let px = sx;
    let py = sy;
    for (const s of sp.segments) {
      const x = q(s.x);
      const y = qy(s.y);
      if (s.kind === 'line') {
        if (x === px && y === py) continue;
        segs.push([x, y]);
      } else {
        const c1x = q(s.c1x);
        const c1y = qy(s.c1y);
        const c2x = q(s.c2x);
        const c2y = qy(s.c2y);
        if (x === px && y === py && c1x === px && c1y === py && c2x === px && c2y === py) continue;
        segs.push([c1x, c1y, c2x, c2y, x, y]);
      }
      px = x;
      py = y;
    }
    // Ligne finale vers le départ : `Z` suffit (sous-tracé fermé seulement).
    while (!sp.open && segs.length > 0) {
      const last = segs[segs.length - 1]!;
      if (last.length === 2 && last[0] === sx && last[1] === sy) segs.pop();
      else break;
    }
    if (segs.length === 0) continue;

    if (count === 0) write([['M', [sx, sy]]]);
    else
      write([
        ['M', [sx, sy]],
        ['m', [sx - cx, sy - cy]],
      ]);
    px = sx;
    py = sy;
    for (const s of segs) {
      if (s.length === 2) {
        const [x, y] = s as [number, number];
        const dx = x - px;
        const dy = y - py;
        const cands: [string, number[]][] = [];
        if (dy === 0) cands.push(['h', [dx]], ['H', [x]]);
        else if (dx === 0) cands.push(['v', [dy]], ['V', [y]]);
        else cands.push(['l', [dx, dy]], ['L', [x, y]]);
        write(cands);
        px = x;
        py = y;
      } else {
        const [c1x, c1y, c2x, c2y, x, y] = s as [number, number, number, number, number, number];
        write([
          ['c', [c1x - px, c1y - py, c2x - px, c2y - py, x - px, y - py]],
          ['C', [c1x, c1y, c2x, c2y, x, y]],
        ]);
        px = x;
        py = y;
      }
    }
    if (sp.open) {
      // Point courant : fin de la polyligne.
      cx = px;
      cy = py;
    } else {
      write([['Z', []]]);
      state.num = null;
      cx = sx;
      cy = sy;
    }
    nodes += 1 + segs.length;
    count++;
  }
  return { d, nodes, subpaths: count };
}
