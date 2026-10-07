import type {
  LabelMap,
  QuantizeResult,
  Region,
  SegmentOptions,
  VectorizeContext,
} from '../types.ts';
import { checkCancel, globalProgress } from '../pipeline.ts';

/**
 * T03 — Segmentation en régions connexes (4-connexité) puis absorption des
 * régions minuscules par la voisine la plus proche en couleur.
 *
 * 1. `connectedComponents4` : union-find en une passe (racine = plus petit
 *    index, compression de chemin), puis relabel dense dans l'ordre de balayage.
 * 2. `absorbSmallRegions` : file de priorité par aire croissante ; une région
 *    d'aire < `minRegionArea` est fusionnée dans la voisine 4-adjacente opaque
 *    qui minimise `distance OKLab / longueur de frontière partagée` (égalités :
 *    frontière la plus longue, puis plus petit id). La région absorbante garde
 *    sa couleur. Après fusion, l'absorbante est réévaluée si elle reste petite ;
 *    on boucle jusqu'à ce qu'aucune région petite n'ait de voisine opaque.
 * 2b. `absorbBlendBands` (T08) : une bande d'anti-aliasing (épaisseur ≤
 *    `blendBand`) dont la couleur est un mélange de deux voisines est rendue à
 *    la plus proche des deux (si `minRegionArea` > 1 et `blendBand` > 0).
 * 2c. `mergeSameColor` (T08) : une absorption peut rendre 4-adjacentes deux
 *    régions de MÊME couleur (le parasite qui les séparait a rejoint l'une) ;
 *    elles fusionnent : une région reste une composante connexe d'une couleur.
 * 3. Relabel dense 0..n-1 (ordre de première apparition en balayage), aires,
 *    boîtes englobantes et `colorId` exacts.
 *
 * `colorIndex` contient des ids de palette (`PaletteColor.id`), -1 = transparent.
 */
export function segment(
  input: QuantizeResult,
  width: number,
  height: number,
  options: SegmentOptions,
  ctx?: VectorizeContext,
): LabelMap {
  const n = width * height;
  const colorIndex = input.colorIndex;
  if (colorIndex.length !== n) {
    throw new Error(`segment : colorIndex de longueur ${colorIndex.length}, attendu ${n}`);
  }
  const progress = (p: number): void => ctx?.onProgress?.(globalProgress('segment', p));
  progress(0);

  const comp = new Int32Array(n);
  const count = connectedComponents4(colorIndex, width, height, comp, ctx);
  progress(0.35);

  // Couleur et aire de chaque composante.
  const compColor = new Int32Array(count);
  const compArea = new Int32Array(count);
  for (let i = 0; i < n; i++) {
    const c = comp[i]!;
    if (c < 0) continue;
    compColor[c] = colorIndex[i]!;
    compArea[c]!++;
  }

  // rep[c] = composante absorbante (union-find), identité par défaut.
  const rep = new Int32Array(count);
  for (let c = 0; c < count; c++) rep[c] = c;

  if (options.minRegionArea > 1) {
    const lab = paletteLab(input);
    absorbSmallRegions(
      comp,
      width,
      height,
      compColor,
      compArea,
      rep,
      lab,
      options.minRegionArea,
      ctx,
    );
    if (options.blendBand && options.blendBand > 0) {
      absorbBlendBands(comp, width, height, compColor, compArea, rep, lab, options.blendBand, ctx);
    }
    mergeSameColor(comp, width, height, compColor, rep, ctx);
  }
  progress(0.8);
  checkCancel(ctx);

  // Résolution des représentants puis relabel dense dans l'ordre de balayage,
  // EN PLACE dans `comp` (T12 : un seul tableau Int32 par pixel).
  const finalId = new Int32Array(count).fill(-1);
  const labels = comp;
  const regions: Region[] = [];
  for (let i = 0; i < n; i++) {
    if ((i & 0xfffff) === 0) tick(ctx, 0.8 + 0.2 * (i / n));
    const c = comp[i]!;
    if (c < 0) continue; // -1 : transparent, déjà en place
    const r = findRep(rep, c);
    let id = finalId[r]!;
    const x = i % width;
    const y = (i - x) / width;
    if (id < 0) {
      id = regions.length;
      finalId[r] = id;
      regions.push({ id, colorId: compColor[r]!, area: 0, bbox: [x, y, x, y] });
    }
    labels[i] = id;
    const reg = regions[id]!;
    reg.area++;
    const b = reg.bbox;
    if (x < b[0]) b[0] = x;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y; // y0 est fixé par la première apparition
  }
  progress(1);
  return { width, height, labels, regions };
}

/**
 * Point de reprise d'une boucle longue (~1 Mpx) : annulation, et progression
 * de l'étape `segment` (T12 : le worker reste réputé vivant pendant les calculs longs).
 */
function tick(ctx: VectorizeContext | undefined, p: number): void {
  checkCancel(ctx);
  ctx?.onProgress?.(globalProgress('segment', p));
}

/**
 * Composantes 4-connexes de même couleur. `out[i]` reçoit l'id dense de la
 * composante (ordre de première apparition) ou -1 pour un pixel transparent.
 * Renvoie le nombre de composantes. Pur, sans récursion.
 */
export function connectedComponents4(
  colorIndex: ArrayLike<number>,
  width: number,
  height: number,
  out: Int32Array,
  ctx?: VectorizeContext,
): number {
  const n = width * height;
  // T12 : l'union-find vit dans `out` lui-même (aucun tableau de plus par pixel).
  const parent = out;
  // Passe 1 : union-find, la racine est toujours le plus petit index.
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) tick(ctx, 0.25 * (y / height));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const c = colorIndex[i]!;
      if (c < 0) {
        parent[i] = -1;
        continue;
      }
      parent[i] = i;
      if (x > 0 && colorIndex[i - 1] === c) union(parent, i, i - 1);
      if (y > 0 && colorIndex[i - width] === c) union(parent, i, i - width);
    }
  }
  // Passe 2, en place : parent[i] ≤ i (union par plus petit index, compression
  // vers des index plus petits), donc le parent p d'un pixel i est déjà traité
  // et `out[p]` porte l'id dense de leur composante commune.
  let count = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 0xfffff) === 0) tick(ctx, 0.25 + 0.1 * (i / n));
    const p = parent[i]!;
    out[i] = p < 0 ? -1 : p === i ? count++ : out[p]!;
  }
  return count;
}

function union(parent: Int32Array, a: number, b: number): void {
  let ra = a;
  while (parent[ra] !== ra) {
    const p = parent[ra]!;
    parent[ra] = parent[p]!;
    ra = p;
  }
  let rb = b;
  while (parent[rb] !== rb) {
    const p = parent[rb]!;
    parent[rb] = parent[p]!;
    rb = p;
  }
  if (ra === rb) return;
  if (ra < rb) parent[rb] = ra;
  else parent[ra] = rb;
}

function findRep(rep: Int32Array, c: number): number {
  let r = c;
  while (rep[r] !== r) r = rep[r]!;
  let k = c;
  while (rep[k] !== r) {
    const next = rep[k]!;
    rep[k] = r;
    k = next;
  }
  return r;
}

/** Palette OKLab indexée par id de couleur (L, a, b entrelacés). */
function paletteLab(input: QuantizeResult): Float64Array {
  let maxId = -1;
  for (const c of input.palette.colors) if (c.id > maxId) maxId = c.id;
  const lab = new Float64Array((maxId + 1) * 3);
  for (const c of input.palette.colors) {
    lab[c.id * 3] = c.oklab.L;
    lab[c.id * 3 + 1] = c.oklab.a;
    lab[c.id * 3 + 2] = c.oklab.b;
  }
  return lab;
}

/**
 * Listes d'adjacence fusionnables en tableaux typés (F1, #18 point 3) : chaque
 * région petite possède une liste chaînée d'entrées (voisine, longueur de
 * frontière) dans un pool commun. Une entrée désigne une composante d'ORIGINE ;
 * sa région courante se résout par `findRep` au moment de la lecture, et les
 * doublons s'additionnent alors (`collect`). Fusionner deux régions = raccorder
 * leurs listes. Mémoire : 12 octets par entrée, au lieu d'un `Map` par région
 * (2,6 Go sur un bruit blanc 2048², voir #18).
 */
class AdjacencyPool {
  /** Tête de liste par composante (−1 : vide). */
  head: Int32Array;
  /** Queue de liste par composante (raccord en O(1)). */
  tail: Int32Array;
  next: Int32Array;
  nb: Int32Array;
  len: Int32Array;
  size = 0;

  constructor(count: number, capacity: number) {
    this.head = new Int32Array(count).fill(-1);
    this.tail = new Int32Array(count).fill(-1);
    this.next = new Int32Array(Math.max(16, capacity));
    this.nb = new Int32Array(this.next.length);
    this.len = new Int32Array(this.next.length);
  }

  /** Ajoute (b, l) en fin de liste de a. */
  add(a: number, b: number, l: number): void {
    if (this.size === this.next.length) this.grow();
    const e = this.size++;
    this.nb[e] = b;
    this.len[e] = l;
    this.next[e] = -1;
    if (this.tail[a]! < 0) this.head[a] = e;
    else this.next[this.tail[a]!] = e;
    this.tail[a] = e;
  }

  /** Vide la liste de a (ses entrées restent dans le pool, inutilisées). */
  clear(a: number): void {
    this.head[a] = -1;
    this.tail[a] = -1;
  }

  private grow(): void {
    const cap = this.next.length * 2;
    const next = new Int32Array(cap);
    next.set(this.next);
    const nb = new Int32Array(cap);
    nb.set(this.nb);
    const len = new Int32Array(cap);
    len.set(this.len);
    this.next = next;
    this.nb = nb;
    this.len = len;
  }
}

/**
 * Voisines distinctes (régions courantes, hors `self`) de la liste de `self`,
 * longueurs additionnées : écrit les ids dans `out` (renvoie leur nombre) et
 * les longueurs dans `acc` (indexé par id, à remettre à zéro par l'appelant).
 * Pur sur tableaux typés.
 */
function collect(
  pool: AdjacencyPool,
  rep: Int32Array,
  self: number,
  acc: Int32Array,
  out: Int32Array,
): number {
  let k = 0;
  for (let e = pool.head[self]!; e >= 0; e = pool.next[e]!) {
    const m = findRep(rep, pool.nb[e]!);
    if (m === self) continue;
    if (acc[m] === 0) out[k++] = m;
    acc[m] = acc[m]! + pool.len[e]!;
  }
  return k;
}

/**
 * Absorption itérative des petites régions (fonction pure sur tableaux typés).
 * Seules les composantes petites tiennent une liste d'adjacence (voisine →
 * longueur de frontière partagée, `AdjacencyPool`) : une grande région n'est
 * jamais absorbée, inutile de connaître ses voisines. Modifie `compArea` et `rep`.
 */
export function absorbSmallRegions(
  comp: Int32Array,
  width: number,
  height: number,
  compColor: Int32Array,
  compArea: Int32Array,
  rep: Int32Array,
  lab: Float64Array,
  minArea: number,
  ctx?: VectorizeContext,
): void {
  const count = compArea.length;
  const small = new Uint8Array(count);
  let smallCount = 0;
  let smallArea = 0;
  for (let c = 0; c < count; c++) {
    if (compArea[c]! < minArea) {
      small[c] = 1;
      smallCount++;
      smallArea += compArea[c]!;
    }
  }
  if (smallCount === 0) return;

  // Au plus 4 arêtes par pixel d'une région petite, plus les listes compactées.
  const pool = new AdjacencyPool(count, 4 * smallArea + 16);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) tick(ctx, 0.35 + 0.15 * (y / height));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = comp[i]!;
      if (a < 0) continue;
      if (x + 1 < width) {
        const b = comp[i + 1]!;
        if (b >= 0 && b !== a) {
          if (small[a]) pool.add(a, b, 1);
          if (small[b]) pool.add(b, a, 1);
        }
      }
      if (y + 1 < height) {
        const b = comp[i + width]!;
        if (b >= 0 && b !== a) {
          if (small[a]) pool.add(a, b, 1);
          if (small[b]) pool.add(b, a, 1);
        }
      }
    }
  }

  const heap = new MinHeap();
  for (let c = 0; c < count; c++) if (small[c]) heap.push(compArea[c]!, c);

  const acc = new Int32Array(count);
  let ns = new Int32Array(64);
  let iter = 0;
  while (heap.size > 0) {
    if ((++iter & 4095) === 0) tick(ctx, 0.5);
    const area = heap.topKey();
    const r = heap.pop();
    if (rep[r] !== r || compArea[r] !== area || area >= minArea) continue; // entrée périmée
    // Liste brute au plus 4 × aire + entrées compactées : `ns` suffit à la borne.
    if (ns.length < 4 * area + 64) ns = new Int32Array(8 * area + 64);
    const k = collect(pool, rep, r, acc, ns);
    if (k === 0) continue; // aucune voisine opaque : la région reste
    const cr = compColor[r]!;
    let best = -1;
    let bestScore = Infinity;
    let bestLen = 0;
    for (let j = 0; j < k; j++) {
      const m = ns[j]!;
      const len = acc[m]!;
      const cm = compColor[m]!;
      const dL = lab[cr * 3]! - lab[cm * 3]!;
      const da = lab[cr * 3 + 1]! - lab[cm * 3 + 1]!;
      const db = lab[cr * 3 + 2]! - lab[cm * 3 + 2]!;
      const score = Math.sqrt(dL * dL + da * da + db * db) / len;
      if (
        score < bestScore ||
        (score === bestScore && (len > bestLen || (len === bestLen && m < best)))
      ) {
        best = m;
        bestScore = score;
        bestLen = len;
      }
    }
    // Fusion r → best. Les listes des petites voisines de r désignent r : la
    // résolution par `findRep` les redirige vers best.
    rep[r] = best;
    compArea[best] = compArea[best]! + area;
    pool.clear(r);
    if (small[best]) {
      // best hérite des voisines de r, compactées (une entrée par voisine).
      for (let j = 0; j < k; j++) {
        const m = ns[j]!;
        if (m !== best) pool.add(best, m, acc[m]!);
      }
      if (compArea[best]! < minArea) heap.push(compArea[best]!, best);
      else {
        small[best] = 0; // devenue grande : plus jamais absorbée
        pool.clear(best);
      }
    }
    for (let j = 0; j < k; j++) acc[ns[j]!] = 0;
  }
}

/** Distance OKLab max entre la couleur de la bande et le segment [voisine A, voisine B]. */
export const BAND_BLEND_DELTA = 0.08;
/** Part minimale du périmètre de la bande partagée avec CHACUNE des deux voisines. */
const BAND_MIN_SHARE = 0.2;

/**
 * T08 — Absorption des bandes d'anti-aliasing (fonction pure sur tableaux typés).
 * Le long d'un bord anti-aliasé entre A et B, les pixels de transition peuvent
 * se quantifier en une TROISIÈME couleur C qui forme une bande d'un pixel,
 * assez longue pour échapper à `minRegionArea`. Le tracé en fait un ruban
 * minuscule (ou l'écrase : topologie fausse). Une région est une telle bande si
 * son épaisseur 2A/P (≈ largeur d'une bande longue) ≤ `maxThickness` (pixels
 * de travail), si elle partage au moins
 * `BAND_MIN_SHARE` de son périmètre avec deux voisines A et B, et si sa couleur
 * se projette sur le segment OKLab [A, B] (paramètre t ∈ [0,1 ; 0,9], distance
 * ≤ `BAND_BLEND_DELTA`). Elle est alors fusionnée dans A (t < 0,5) ou B.
 * Un liseré de contour volontaire (noir entre un aplat et le fond) n'est pas
 * un mélange de ses voisines : il reste. Modifie `compArea` et `rep`.
 */
export function absorbBlendBands(
  comp: Int32Array,
  width: number,
  height: number,
  compColor: Int32Array,
  compArea: Int32Array,
  rep: Int32Array,
  lab: Float64Array,
  maxThickness: number,
  ctx?: VectorizeContext,
): void {
  const count = compArea.length;
  const n = width * height;
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = comp[i]! < 0 ? -1 : findRep(rep, comp[i]!);
  // Périmètre de chaque région (arêtes vers une autre région ou la transparence ;
  // le bord d'image ne compte pas : une bande au bord reste une bande).
  const per = new Int32Array(count);
  const edge = (a: number, b: number): void => {
    if (a >= 0) per[a]!++;
    if (b >= 0) per[b]!++;
  };
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) tick(ctx, 0.55 + 0.1 * (y / height));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = root[i]!;
      if (x + 1 < width && root[i + 1] !== a) edge(a, root[i + 1]!);
      if (y + 1 < height && root[i + width] !== a) edge(a, root[i + width]!);
    }
  }
  const adj: (Map<number, number> | undefined)[] = new Array(count);
  let candidates = 0;
  for (let c = 0; c < count; c++) {
    if (rep[c] !== c || per[c] === 0) continue;
    if ((2 * compArea[c]!) / per[c]! <= maxThickness) {
      adj[c] = new Map();
      candidates++;
    }
  }
  if (candidates === 0) return;
  const link = (a: number, b: number): void => {
    const m = adj[a];
    if (m) m.set(b, (m.get(b) ?? 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) tick(ctx, 0.65 + 0.05 * (y / height));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = root[i]!;
      if (a < 0) continue;
      for (const j of [x + 1 < width ? i + 1 : -1, y + 1 < height ? i + width : -1]) {
        if (j < 0) continue;
        const b = root[j]!;
        if (b >= 0 && b !== a) {
          link(a, b);
          link(b, a);
        }
      }
    }
  }
  // Plus petites d'abord ; les voisines sont résolues au moment de la décision.
  const order: number[] = [];
  for (let c = 0; c < count; c++) if (adj[c]) order.push(c);
  order.sort((u, v) => compArea[u]! - compArea[v]! || u - v);
  for (const c of order) {
    if (rep[c] !== c) continue;
    const merged = new Map<number, number>();
    for (const [m, len] of adj[c]!) {
      const r = findRep(rep, m);
      if (r !== c) merged.set(r, (merged.get(r) ?? 0) + len);
    }
    const minLen = BAND_MIN_SHARE * per[c]!;
    const ns = [...merged].filter(([, len]) => len >= minLen).map(([m]) => m);
    const cc = compColor[c]! * 3;
    let target = -1;
    let bestD = BAND_BLEND_DELTA;
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = compColor[ns[i]!]! * 3;
        const b = compColor[ns[j]!]! * 3;
        const dL = lab[b]! - lab[a]!;
        const da = lab[b + 1]! - lab[a + 1]!;
        const db = lab[b + 2]! - lab[a + 2]!;
        const l2 = dL * dL + da * da + db * db;
        if (l2 < 1e-12) continue;
        const vL = lab[cc]! - lab[a]!;
        const va = lab[cc + 1]! - lab[a + 1]!;
        const vb = lab[cc + 2]! - lab[a + 2]!;
        const t = (vL * dL + va * da + vb * db) / l2;
        if (t < 0.1 || t > 0.9) continue;
        const d = Math.hypot(vL - t * dL, va - t * da, vb - t * db);
        if (d <= bestD) {
          bestD = d;
          target = t < 0.5 ? ns[i]! : ns[j]!;
        }
      }
    }
    if (target < 0) continue;
    rep[c] = target;
    compArea[target] = compArea[target]! + compArea[c]!;
  }
}

/**
 * T08 — Fusionne les régions 4-adjacentes de même couleur après absorption
 * (fonction pure sur tableaux typés ; modifie `rep`). Sans elle, absorber le
 * parasite qui séparait deux régions de couleur A dans l'une d'elles laissait
 * deux régions A jointives : carte de labels invalide, trous et composantes
 * faux (référence de l'évaluation comprise).
 */
export function mergeSameColor(
  comp: Int32Array,
  width: number,
  height: number,
  compColor: Int32Array,
  rep: Int32Array,
  ctx?: VectorizeContext,
): void {
  const join = (i: number, j: number): void => {
    const a = comp[i]!;
    const b = comp[j]!;
    if (a < 0 || b < 0) return;
    const ra = findRep(rep, a);
    const rb = findRep(rep, b);
    if (ra === rb || compColor[ra] !== compColor[rb]) return;
    if (ra < rb) rep[rb] = ra;
    else rep[ra] = rb;
  };
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) tick(ctx, 0.7 + 0.1 * (y / height));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (x + 1 < width) join(i, i + 1);
      if (y + 1 < height) join(i, i + width);
    }
  }
}

/** Tas binaire minimal (clé entière, puis valeur) sur tableaux. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  topKey(): number {
    return this.keys[0]!;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(k[p]!, v[p]!, key, val)) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    const len = k.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && less(k[r]!, v[r]!, k[l]!, v[l]!) ? r : l;
        if (!less(k[c]!, v[c]!, lastK, lastV)) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

function less(ka: number, va: number, kb: number, vb: number): boolean {
  return ka < kb || (ka === kb && va < vb);
}
