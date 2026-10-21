// T34, T50 — Palette imposée (`quantize.fixedPalette` : couleurs, couverture, tramage) et
// contraintes de palette (`constraints.merged` / `removed` / `transparent` / `recolor`), sorties
// de `quantize.ts` (T125c) : aucun préréglage ne les active, et le plugin Figma (qui n'appelle le
// moteur QUE par un préréglage) remplace ce module par un bouchon à sa construction.
// `quantize.ts` les ré-exporte. Pur, sur tableaux typés.
import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  FixedPalette,
  PaletteColor,
  PaletteConstraints,
  Rgb,
  VectorizeContext,
} from '../types.ts';
import { FIXED_PALETTE_MAX } from '../types.ts';
import { normalizeRgb, type OklabCache } from './oklab.ts';

/**
 * T34 — Couleurs d'une palette imposée : normalisées (octets), doublons exacts retirés (le
 * premier compte), `FIXED_PALETTE_MAX` au plus (l'index de couleur est un `Int16Array`).
 */
export function fixedColors(fixed: FixedPalette): Rgb[] {
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const c of fixed.colors) {
    const rgb = normalizeRgb(c);
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rgb);
    if (out.length === FIXED_PALETTE_MAX) break;
  }
  return out;
}

/**
 * T34 — Index (croissants) des couleurs qui couvrent au moins `minCoverage` des pixels
 * assignés ; jamais vide : à défaut, la couleur la plus couvrante (la première à égalité).
 */
export function coveredColors(counts: Int32Array, minCoverage: number): number[] {
  let total = 0;
  for (let c = 0; c < counts.length; c++) total += counts[c]!;
  const kept: number[] = [];
  for (let c = 0; c < counts.length; c++) {
    if (total > 0 && counts[c]! >= minCoverage * total) kept.push(c);
  }
  if (kept.length > 0 || counts.length === 0) return kept;
  let best = 0;
  for (let c = 1; c < counts.length; c++) if (counts[c]! > counts[best]!) best = c;
  return [best];
}

/**
 * T34 — Seuil de couverture d'une palette imposée : ses couleurs (`rgb`) qui couvrent au moins
 * `minCoverage` des pixels assignés (`coveredColors`), ou null si aucune n'est retirée.
 */
export function coveredRgb(counts: Int32Array, minCoverage: number, rgb: Rgb[]): Rgb[] | null {
  if (!(minCoverage > 0)) return null;
  const kept = coveredColors(counts, minCoverage);
  return kept.length < rgb.length ? kept.map((c) => rgb[c]!) : null;
}

/**
 * T34 — Tramage Floyd–Steinberg dans OKLab : comme `assignPixels`, mais l'écart entre le
 * pixel (plus l'erreur reçue) et la couleur choisie est diffusé aux voisins (7/16 à droite,
 * 3/16, 5/16 et 1/16 sur la ligne suivante). Lignes `[y0, y1)` ; à appeler dans l'ordre des
 * lignes avec le MÊME `err` (2 lignes × 3 flottants : `width * 6`), remis à zéro, comme
 * `counts`, quand `y0` = 0. Un pixel transparent reçoit -1 et ne diffuse rien. Pure, sans
 * allocation.
 */
export function ditherPixels(
  data: ArrayLike<number>,
  lab: OklabCache,
  mask: Uint8Array | null,
  centroids: Float64Array,
  k: number,
  width: number,
  y0: number,
  y1: number,
  out: Int16Array,
  counts: Int32Array,
  err: Float32Array,
): void {
  if (y0 === 0) {
    counts.fill(0);
    err.fill(0);
  }
  const t = lab.lab;
  const row = width * 3;
  for (let y = y0; y < y1; y++) {
    const cur = (y & 1) * row;
    const nxt = ((y + 1) & 1) * row;
    err.fill(0, nxt, nxt + row);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask !== null && mask[i]! === 0) {
        out[i] = -1;
        continue;
      }
      const o = lab.slot(data, i * 4);
      const e = cur + x * 3;
      const L = t[o]! + err[e]!;
      const a = t[o + 1]! + err[e + 1]!;
      const b = t[o + 2]! + err[e + 2]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0, q = 0; c < k; c++, q += 3) {
        const dL = L - centroids[q]!;
        const da = a - centroids[q + 1]!;
        const db = b - centroids[q + 2]!;
        const d = dL * dL + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      out[i] = best;
      counts[best]!++;
      const q = best * 3;
      const r0 = L - centroids[q]!;
      const r1 = a - centroids[q + 1]!;
      const r2 = b - centroids[q + 2]!;
      if (x + 1 < width) addError(err, e + 3, r0, r1, r2, 7 / 16);
      if (x > 0) addError(err, nxt + (x - 1) * 3, r0, r1, r2, 3 / 16);
      addError(err, nxt + x * 3, r0, r1, r2, 5 / 16);
      if (x + 1 < width) addError(err, nxt + (x + 1) * 3, r0, r1, r2, 1 / 16);
    }
  }
}

/**
 * T34 — Assignation TRAMÉE de toute l'image (`ditherPixels`), par tranches de lignes d'environ
 * `chunk` pixels : annulation et, si `progress`, progression de l'étape dans la boucle longue.
 */
export function ditherAll(
  data: ArrayLike<number>,
  lab: OklabCache,
  mask: Uint8Array | null,
  centroids: Float64Array,
  k: number,
  width: number,
  height: number,
  out: Int16Array,
  counts: Int32Array,
  chunk: number,
  progress: boolean,
  ctx?: VectorizeContext,
): void {
  const err = new Float32Array(width * 6);
  const rows = Math.max(1, Math.floor(chunk / Math.max(width, 1)));
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows);
    ditherPixels(data, lab, mask, centroids, k, width, y0, y1, out, counts, err);
    checkCancel(ctx);
    if (progress) ctx?.onProgress?.(globalProgress('quantize', 0.9 + (0.08 * y1) / height));
  }
}

function addError(err: Float32Array, j: number, r0: number, r1: number, r2: number, w: number) {
  err[j] = err[j]! + r0 * w;
  err[j + 1] = err[j + 1]! + r1 * w;
  err[j + 2] = err[j + 2]! + r2 * w;
}

/**
 * Réassigne au centroïde le plus proche les pixels dont l'index courant est
 * marqué dans `removed` (`removed[index] !== 0`). `target` donne la nouvelle
 * palette (3 flottants par couleur, `k` couleurs). Pure, sans allocation.
 */
export function reassignPixels(
  data: ArrayLike<number>,
  lab: OklabCache,
  colorIndex: Int16Array,
  removed: Uint8Array,
  target: Float64Array,
  k: number,
): void {
  const n = colorIndex.length;
  const t = lab.lab;
  for (let i = 0; i < n; i++) {
    const ci = colorIndex[i]!;
    if (ci < 0 || removed[ci]! === 0) continue;
    const o = lab.slot(data, i * 4);
    let best = 0;
    let bestD = Infinity;
    for (let c = 0, q = 0; c < k; c++, q += 3) {
      const dL = t[o]! - target[q]!;
      const da = t[o + 1]! - target[q + 1]!;
      const db = t[o + 2]! - target[q + 2]!;
      const d = dL * dL + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    colorIndex[i] = best;
  }
}

// ---------------------------------------------------------------------------
// Contraintes
// ---------------------------------------------------------------------------

export interface BaseColor {
  L: number;
  a: number;
  b: number;
  count: number;
  locked: boolean;
  /** RGB exact d'une couleur verrouillée (conservé tel quel), sinon `null`. */
  rgb: Rgb | null;
}

/**
 * Applique `merged`, `removed` puis `transparent` (T50) sur la palette de base (ids triés).
 * Modifie `colorIndex` en place pour pointer dans la palette renvoyée (non triée) ; les
 * pixels d'un id transparent passent à -1. `groupOf[id]` = index dans `out` de la couleur
 * qui porte l'id de base, -1 s'il est retiré ou transparent.
 */
export function applyConstraints(
  base: BaseColor[],
  constraints: PaletteConstraints,
  data: ArrayLike<number>,
  lab: OklabCache,
  colorIndex: Int16Array,
): { out: BaseColor[]; groupOf: Int32Array } {
  const k = base.length;
  const valid = (id: number): boolean => Number.isInteger(id) && id >= 0 && id < k;

  const clearFlag = new Uint8Array(k);
  let nClear = 0;
  for (const id of constraints.transparent ?? [])
    if (valid(id) && !clearFlag[id]!) {
      clearFlag[id] = 1;
      nClear++;
    }
  if (nClear === k) {
    clearFlag.fill(0);
    nClear = 0;
  }
  const removedFlag = new Uint8Array(k);
  for (const id of constraints.removed) if (valid(id) && !clearFlag[id]!) removedFlag[id] = 1;
  let nRemoved = 0;
  for (let i = 0; i < k; i++) nRemoved += removedFlag[i]!;
  if (nRemoved + nClear === k) {
    removedFlag.fill(0);
    nRemoved = 0;
  }
  if (nRemoved === 0 && nClear === 0 && constraints.merged.length === 0)
    return { out: base, groupOf: Int32Array.from({ length: k }, (_, i) => i) };
  const n = colorIndex.length;
  if (nClear > 0)
    for (let i = 0; i < n; i++) {
      const ci = colorIndex[i]!;
      if (ci >= 0 && clearFlag[ci]!) colorIndex[i] = -1;
    }
  // Une couleur transparente est, pour la suite, une couleur retirée SANS pixels.
  const goneFlag = new Uint8Array(k);
  for (let i = 0; i < k; i++) goneFlag[i] = removedFlag[i]! | clearFlag[i]!;

  // Groupe d'appartenance de chaque id de base (-1 = pas encore attribué).
  const group = new Int32Array(k).fill(-1);
  const groups: number[][] = [];
  // Représentant (plus petit id) du groupe de fusion de chaque id de base.
  const rep = Int32Array.from({ length: k }, (_, i) => i);
  const taken = new Uint8Array(k);
  for (const g of constraints.merged) {
    const members = [...new Set(g)].filter((id) => valid(id) && !goneFlag[id]! && !taken[id]!);
    if (members.length < 2) continue;
    const r = Math.min(...members);
    for (const id of members) {
      taken[id] = 1;
      rep[id] = r;
    }
  }
  // Groupes ordonnés par leur plus petit id (départage stable des ex æquo au tri final).
  for (let id = 0; id < k; id++) {
    if (goneFlag[id]!) continue;
    if (rep[id]! === id) {
      group[id] = groups.length;
      groups.push([id]);
    } else {
      group[id] = group[rep[id]!]!;
      groups[group[id]!]!.push(id);
    }
  }

  const out: BaseColor[] = groups.map((members) => {
    const lockedMember = members.find((id) => base[id]!.locked);
    let count = 0;
    for (const id of members) count += base[id]!.count;
    if (lockedMember !== undefined) return { ...base[lockedMember]!, count };
    // T62 : couleur seule de RGB exact (niveau du seuil) gardée telle quelle.
    if (members.length === 1 && base[members[0]!]!.rgb) return { ...base[members[0]!]!, count };
    let L = 0;
    let a = 0;
    let b = 0;
    let wsum = 0;
    for (const id of members) {
      // Groupe entièrement vide : moyenne simple.
      const wi = count > 0 ? base[id]!.count : 1;
      L += base[id]!.L * wi;
      a += base[id]!.a * wi;
      b += base[id]!.b * wi;
      wsum += wi;
    }
    return { L: L / wsum, a: a / wsum, b: b / wsum, count, locked: false, rgb: null };
  });

  // Les couleurs retirées gardent temporairement leur index de base ; on les
  // réassigne au plus proche parmi les couleurs restantes.
  if (nRemoved > 0) {
    const target = new Float64Array(out.length * 3);
    out.forEach((c, i) => {
      target[i * 3] = c.L;
      target[i * 3 + 1] = c.a;
      target[i * 3 + 2] = c.b;
    });
    // D'abord les pixels non retirés vers leur groupe, marqués en négatif décalé
    // pour ne pas les confondre avec des ids de base.
    for (let i = 0; i < n; i++) {
      const ci = colorIndex[i]!;
      if (ci >= 0 && !removedFlag[ci]!) colorIndex[i] = -2 - group[ci]!;
    }
    reassignPixels(data, lab, colorIndex, removedFlag, target, out.length);
    for (let i = 0; i < n; i++) if (colorIndex[i]! <= -2) colorIndex[i] = -2 - colorIndex[i]!;
  } else {
    for (let i = 0; i < n; i++) if (colorIndex[i]! >= 0) colorIndex[i] = group[colorIndex[i]!]!;
  }
  return { out, groupOf: group };
}

/**
 * T50 — Recoloriage : `finalOf(id de base)` donne l'id final (-1 = retiré ou transparent).
 * Seuls `rgb` et `sourceRgb` changent ; le premier recoloriage d'une couleur finale gagne.
 */
export function recolorPalette(
  colors: PaletteColor[],
  recolor: ReadonlyArray<{ id: number; rgb: Rgb }>,
  finalOf: (id: number) => number,
): void {
  const done = new Set<number>();
  for (const r of recolor) {
    const f = finalOf(r.id);
    if (f < 0 || done.has(f) || !isRgbLike(r.rgb)) continue;
    done.add(f);
    const c = colors[f]!;
    const rgb = normalizeRgb(r.rgb);
    if (rgb[0] === c.rgb[0] && rgb[1] === c.rgb[1] && rgb[2] === c.rgb[2]) continue;
    c.sourceRgb = c.rgb;
    c.rgb = rgb;
  }
}

function isRgbLike(v: unknown): v is Rgb {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}
