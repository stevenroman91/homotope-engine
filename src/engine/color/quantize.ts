import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  PaletteColor,
  PreprocessResult,
  QuantizeOptions,
  QuantizeResult,
  Rgb,
  VectorizeContext,
  VectorizeOptions,
} from '../types.ts';
import { TRANSLUCENT_ALPHA } from '../types.ts';
import { normalizeRgb, OklabCache, oklabToRgb, rgbToOklab } from './oklab.ts';
import {
  applyConstraints,
  coveredRgb,
  ditherAll,
  fixedColors,
  recolorPalette,
  type BaseColor,
} from './palette-ops.ts';
import { mulberry32 } from './prng.ts';

// T125c — Palette imposée et contraintes : `palette-ops.ts` (le plugin Figma les retire).
export { coveredColors, ditherPixels, fixedColors, reassignPixels } from './palette-ops.ts';

/** Nombre maximal de pixels échantillonnés pour le k-means (l'assignation finale couvre TOUS les pixels). */
export const MAX_SAMPLE = 50_000;
/** Taille du sous-échantillon sur lequel le mode `auto` cherche k. */
export const SEARCH_SAMPLE = 12_500;
/** Pixels assignés entre deux points d'annulation / de progression (~1 Mpx). */
const ASSIGN_CHUNK = 1 << 20;
/** Nombre maximal d'itérations de Lloyd. */
export const MAX_ITERATIONS = 30;
/** Convergence : déplacement maximal d'un centroïde (distance OKLab) sous ce seuil. */
export const EPSILON = 1e-3;
/** Valeurs de k essayées en mode `auto` (bornées par `maxColors`, qui est ajouté en dernier). */
export const AUTO_K_SEQUENCE: readonly number[] = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/**
 * T02 — Quantification des couleurs dans l'espace OKLab : k-means++ (graine
 * fixe), nombre de couleurs automatique ou réglable, contraintes utilisateur
 * (verrouiller / fusionner / retirer).
 *
 * Déroulé :
 *  1. OKLab calculé à la volée par couleur RGB exacte (`OklabCache`, T12 :
 *     aucun tableau OKLab de toute l'image) ; les pixels transparents
 *     (`input.opaque[i] === 0`) sont ignorés et reçoivent l'index -1 ;
 *  2. échantillon déterministe (≤ `MAX_SAMPLE` pixels opaques, stratifié,
 *     graine `options.seed`), dédoublonné en couleurs uniques pondérées ;
 *  3. k-means++ pondéré sur l'échantillon (Lloyd jusqu'à un déplacement
 *     < `EPSILON` ou `MAX_ITERATIONS`) ; les couleurs `constraints.locked`
 *     sont des centroïdes imposés qui ne bougent jamais et comptent dans k ;
 *     en `auto`, k croît selon `AUTO_K_SEQUENCE` (démarrage à chaud depuis le
 *     k précédent) jusqu'à ce que l'erreur moyenne (distance OKLab
 *     pixel→centroïde, mesurée sur un sous-échantillon de `SEARCH_SAMPLE`
 *     pixels) soit ≤ `autoTolerance`, puis le k retenu est affiné sur
 *     l'échantillon complet ;
 *  4. assignation de TOUS les pixels (`assignPixels`, fonction pure) ;
 *  5. palette « de base » triée par `count` décroissant (ids 0..k-1) ;
 *  6. contraintes `merged` / `removed`, puis `transparent` (T50), puis nouveau tri par
 *     `count` ; enfin `recolor` (T50) change la couleur de SORTIE, sans toucher aux pixels.
 *
 * T34 — Palette IMPOSÉE (`options.fixedPalette`) : le chemin des verrous, sans k-means.
 * Les couleurs imposées sont les `k = n` centroïdes verrouillés (étapes 2 et 3 sautées,
 * aucun tirage aléatoire), l'assignation (étape 4) est celle de toujours, ou le tramage
 * `ditherPixels` ; le seuil de couverture retire ensuite les couleurs trop rares et
 * réassigne l'image avec les restantes ; `merged` et `locked` sont ignorés (une fusion
 * inventerait une couleur), `removed` s'applique. Aucune couleur n'est donc inventée.
 *
 * CONVENTION DES IDS de `constraints.merged` et `constraints.removed` : ils
 * désignent la palette de base, c'est-à-dire celle que renverrait `quantize`
 * avec les mêmes options (même graine, même `colors`, mêmes `locked`) mais
 * avec `merged` et `removed` vides. L'interface conserve donc cette palette
 * de base pour exprimer les fusions et retraits.
 *
 * Règles de résolution des contraintes :
 *  - ids hors bornes ignorés ; un id retiré est aussi ôté des groupes de fusion ;
 *    un id déjà pris par un groupe précédent est ignoré dans les suivants ;
 *  - si `removed` retirerait toutes les couleurs, il est ignoré ;
 *  - un groupe fusionné prend la moyenne OKLab pondérée par `count` de ses
 *    membres, SAUF s'il contient une couleur verrouillée : il prend alors la
 *    (première) couleur verrouillée, car un verrou ne bouge jamais ;
 *  - les pixels d'une couleur retirée vont, pixel par pixel, à la couleur
 *    restante la plus proche en OKLab ;
 *  - T50 : les pixels d'un id `transparent` prennent l'index -1 (aucune face), qu'il soit
 *    aussi retiré ou fusionné ; l'id sort des groupes de fusion et de la palette. Si
 *    `transparent` couvrirait toutes les couleurs, il est ignoré ; si `removed` et
 *    `transparent` ensemble couvriraient tout, c'est `removed` qui est ignoré ;
 *  - T50 : `recolor` remplace `rgb` de la couleur finale de l'id (de son groupe s'il est
 *    fusionné, premier recoloriage gagnant) et pose `sourceRgb` ; `oklab`, `count` et
 *    `colorIndex` sont inchangés : deux recoloriages identiques ne fusionnent rien.
 */
export function quantize(
  input: PreprocessResult,
  options: QuantizeOptions,
  ctx?: VectorizeContext,
): QuantizeResult {
  const { width, height, data } = input.image;
  const n = width * height;
  const opaque = input.opaque;
  const lab = new OklabCache();

  // Une palette imposée vide (hors contrat : 2 couleurs au moins) est sans effet.
  const fixed = options.fixedPalette?.colors.length ? options.fixedPalette : undefined;
  // T62 — Seuil « Noir et blanc » actif : les classes sont les NIVEAUX présents, sans k-means.
  const levels =
    !fixed && input.threshold !== undefined
      ? thresholdLevels(data, opaque, n, options.colors === 1)
      : null;
  let lockedRgb = fixed
    ? fixedColors(fixed)
    : (levels ?? options.constraints.locked.map(normalizeRgb));
  const nLocked = lockedRgb.length;
  const lockedLab = labOf(lockedRgb);
  // T62 — Sous un seuil, un verrou de l'utilisateur sur l'un des niveaux présents est honoré
  // (`locked: true`) ; un verrou d'une autre couleur est ignoré (il n'y a que des niveaux).
  const levelLocked = levels
    ? new Set(options.constraints.locked.map((c) => normalizeRgb(c).join(',')))
    : null;

  const km =
    fixed || levels
      ? { k: nLocked, centroids: lockedLab, error: 0 }
      : kmeansPalette(input, options, lab, lockedLab, nLocked, ctx);
  let k = km.k;
  let centroids = km.centroids;

  // --- Assignation de tous les pixels ---------------------------------------
  const colorIndex = new Int16Array(n);
  let counts = new Int32Array(k);
  const assignAll = (progress: boolean): void => {
    checkCancel(ctx);
    if (fixed?.dither) {
      ditherAll(
        data,
        lab,
        opaque,
        centroids,
        k,
        width,
        height,
        colorIndex,
        counts,
        ASSIGN_CHUNK,
        progress,
        ctx,
      );
      return;
    }
    // Par tranches d'environ 1 Mpx : annulation et progression dans la boucle longue.
    for (let start = 0; start < n; start += ASSIGN_CHUNK) {
      const end = Math.min(n, start + ASSIGN_CHUNK);
      assignPixels(data, lab, opaque, centroids, k, colorIndex, counts, start, end);
      checkCancel(ctx);
      if (progress) ctx?.onProgress?.(globalProgress('quantize', 0.9 + (0.08 * end) / n));
    }
  };
  assignAll(true);

  // T34 — Seuil de couverture : les couleurs imposées trop rares sont retirées, puis l'image
  // est réassignée (un seul passage) aux restantes, qui deviennent la palette de base.
  const kept = fixed ? coveredRgb(counts, fixed.minCoverage, lockedRgb) : null;
  if (kept) {
    lockedRgb = kept;
    centroids = labOf(kept);
    k = kept.length;
    counts = new Int32Array(k);
    assignAll(false);
  }

  // --- Palette de base triée par count décroissant --------------------------
  const base: BaseColor[] = [];
  for (let c = 0; c < k; c++) {
    const imposed = c < nLocked;
    base.push({
      L: centroids[c * 3]!,
      a: centroids[c * 3 + 1]!,
      b: centroids[c * 3 + 2]!,
      count: counts[c]!,
      // T62 : un niveau du seuil garde son RGB exact sans être un verrou de l'utilisateur,
      // sauf si l'utilisateur a verrouillé ce niveau même.
      locked: imposed && (!levelLocked || levelLocked.has(lockedRgb[c]!.join(','))),
      rgb: imposed ? lockedRgb[c]! : null,
    });
  }
  const baseOrder = sortedOrder(base.map((c) => c.count));
  const sortedBase = baseOrder.map((c) => base[c]!);
  const rank = new Int16Array(k);
  for (let i = 0; i < k; i++) rank[baseOrder[i]!] = i;
  remap(colorIndex, rank);
  refineCoreColors(sortedBase, colorIndex, data, lab, width, height);

  // --- Contraintes merged / removed / transparent ----------------------------
  // Niveaux du seuil (T62) : seuls les verrous posés sur un niveau présent comptent (ci-dessus).
  const constraints = fixed
    ? {
        locked: [],
        merged: [],
        removed: options.constraints.removed,
        transparent: options.constraints.transparent ?? [],
      }
    : options.constraints;
  // Sans aucune contrainte, `applyConstraints` rendrait la palette telle quelle : il n'est pas
  // appelé (T125c : aucun préréglage n'en pose, le plugin Figma ne l'embarque pas).
  const { out: final, groupOf } =
    constraints.merged.length > 0 ||
    constraints.removed.length > 0 ||
    (constraints.transparent?.length ?? 0) > 0
      ? applyConstraints(sortedBase, constraints, data, lab, colorIndex)
      : { out: sortedBase, groupOf: Int32Array.from({ length: k }, (_, i) => i) };

  // --- Tri final, ids denses -------------------------------------------------
  const finalCounts = new Int32Array(final.length);
  for (let i = 0; i < n; i++) if (colorIndex[i]! >= 0) finalCounts[colorIndex[i]!]!++;
  const order = sortedOrder(Array.from(finalCounts));
  const finalRank = new Int16Array(final.length);
  for (let i = 0; i < order.length; i++) finalRank[order[i]!] = i;
  remap(colorIndex, finalRank);

  const colors: PaletteColor[] = order.map((c, id) => {
    const f = final[c]!;
    const rgb = f.rgb ?? oklabToRgb(f);
    return {
      id,
      rgb,
      oklab: f.rgb ? rgbToOklab(f.rgb) : { L: f.L, a: f.a, b: f.b },
      count: finalCounts[c]!,
      locked: f.locked,
    };
  });
  if (opaque !== null) setTranslucency(colors, colorIndex, data);
  if (!fixed && options.constraints.recolor?.length) {
    const finalOf = (id: number): number => {
      const g = Number.isInteger(id) && id >= 0 && id < k ? groupOf[id]! : -1;
      return g < 0 ? -1 : finalRank[g]!;
    };
    recolorPalette(colors, options.constraints.recolor, finalOf);
  }
  ctx?.onProgress?.(globalProgress('quantize', 1));
  return { palette: { colors }, colorIndex };
}

/**
 * Étapes 2 et 3 : échantillon, choix de k et k-means (centroïdes verrouillés en tête).
 * Inchangées depuis T02/T12 ; la palette imposée (T34) les saute.
 */
function kmeansPalette(
  input: PreprocessResult,
  options: QuantizeOptions,
  lab: OklabCache,
  lockedLab: Float64Array,
  nLocked: number,
  ctx?: VectorizeContext,
): KMeansResult {
  const { width, height, data } = input.image;
  const n = width * height;
  const opaque = input.opaque;
  const rng = mulberry32(options.seed);
  const sample = buildSample(data, lab, opaque, n, MAX_SAMPLE, rng);
  const auto = options.colors === 'auto';
  // En auto, la recherche de k se fait sur un sous-échantillon plus petit
  // (coût ∝ Σk × itérations × taille), puis le k retenu est affiné sur
  // l'échantillon complet en repartant des centroïdes trouvés.
  const search =
    auto && sample.totalWeight > SEARCH_SAMPLE
      ? buildSample(data, lab, opaque, n, SEARCH_SAMPLE, rng)
      : sample;
  const refine = search !== sample;
  const searchShare = refine ? 0.7 : 0.9;

  // --- Choix de k et k-means ---------------------------------------------------
  const candidates = kCandidates(options);
  const runs = candidates.length;
  let best: KMeansResult | null = null;
  let lastK = -1;
  for (let r = 0; r < runs; r++) {
    let k = Math.max(candidates[r]!, nLocked);
    // En auto, k au-delà du nombre de couleurs uniques (+ verrous) n'apporte rien.
    if (auto) k = Math.max(Math.min(k, search.unique + nLocked), nLocked);
    // Aucun pixel opaque : la palette se réduit aux verrous.
    if (search.unique === 0) k = nLocked;
    if (k === lastK) continue;
    lastK = k;
    // Démarrage à chaud : les centroïdes du k précédent sont repris tels quels.
    const init = best ? best.centroids : lockedLab;
    const nInit = best ? best.k : nLocked;
    best = kmeans(search, k, init, nInit, nLocked, rng, (iter) => {
      checkCancel(ctx);
      const p = (searchShare * (r + iter / MAX_ITERATIONS)) / runs;
      ctx?.onProgress?.(globalProgress('quantize', p));
    });
    if (!auto || best.error <= options.autoTolerance) break;
  }
  if (refine && best) {
    const k = best.k;
    best = kmeans(sample, k, best.centroids, k, nLocked, rng, (iter) => {
      checkCancel(ctx);
      ctx?.onProgress?.(globalProgress('quantize', 0.7 + (0.2 * iter) / MAX_ITERATIONS));
    });
  }
  return best as KMeansResult;
}

/**
 * T62 — Niveaux présents après le seuil « Noir et blanc » (`thresholdPixels`) parmi les pixels
 * OPAQUES : noir puis blanc, chacun seulement s'il a au moins un pixel (1 ou 2 couleurs ; aucune
 * si rien n'est opaque). Le k-means à 2 couleurs coupait une classe unique (noir sur fond
 * transparent) en deux amas arbitraires, ou laissait une couleur fantôme sans pixel. Un pixel
 * opaque d'une autre valeur (hors contrat du seuil) compte pour le niveau le plus proche.
 * `single` (`quantize.colors === 1`) : le niveau MAJORITAIRE seul (le noir à égalité), et
 * l'assignation y envoie tous les pixels opaques. Fonction PURE.
 */
export function thresholdLevels(
  data: ArrayLike<number>,
  opaque: Uint8Array | null,
  n: number,
  single = false,
): Rgb[] {
  let black = 0;
  let white = 0;
  for (let i = 0; i < n; i++) {
    if (opaque !== null && opaque[i] === 0) continue;
    const p = i * 4;
    if (data[p]! + data[p + 1]! + data[p + 2]! < 383) black++;
    else white++;
  }
  const out: Rgb[] = [];
  if (black > 0 && !(single && white > black)) out.push([0, 0, 0]);
  if (white > 0 && !(single && black >= white)) out.push([255, 255, 255]);
  return out;
}

/** OKLab de couleurs RGB (3 flottants par couleur). */
function labOf(colors: readonly Rgb[]): Float64Array {
  const out = new Float64Array(colors.length * 3);
  colors.forEach((c, i) => {
    const o = rgbToOklab(c);
    out[i * 3] = o.L;
    out[i * 3 + 1] = o.a;
    out[i * 3 + 2] = o.b;
  });
  return out;
}

/**
 * T34 — Options de quantification effectives : la palette imposée est IGNORÉE en tracé
 * centre-ligne (T33), qui fond toutes les encres en un seul masque tracé d'une seule couleur
 * (`chooseInk`) : un trait rouge y serait peint dans l'encre sombre, pas dans l'imposée la plus
 * proche (README « Décisions »). Sans palette imposée : `options.quantize` tel quel.
 */
export function effectiveQuantize(options: VectorizeOptions): QuantizeOptions {
  if (!options.quantize.fixedPalette || options.centerline?.enabled !== true)
    return options.quantize;
  const quantize = { ...options.quantize };
  delete quantize.fixedPalette;
  return quantize;
}

/**
 * T08 — Couleur finale = moyenne OKLab des pixels de CŒUR (les 4 voisins dans
 * l'image ont la même couleur), pas de tous les pixels assignés : les pixels
 * d'anti-aliasing tiraient le centroïde vers les voisines (blanc → #fffdfc,
 * sarcelle de logo-aa décalée de 9 en rouge). Appliquée à la palette DE BASE
 * (avant fusions et retraits, qui en héritent) ; assignation inchangée ; couleurs
 * verrouillées intactes ; sans cœur suffisant (< 1/8 des pixels), centroïde gardé.
 */
function refineCoreColors(
  base: BaseColor[],
  colorIndex: Int16Array,
  data: ArrayLike<number>,
  lab: OklabCache,
  width: number,
  height: number,
): void {
  const K = base.length;
  const sum = new Float64Array(K * 3);
  const cnt = new Int32Array(K);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const c = colorIndex[i]!;
      if (c < 0) continue;
      if (x > 0 && colorIndex[i - 1] !== c) continue;
      if (x + 1 < width && colorIndex[i + 1] !== c) continue;
      if (y > 0 && colorIndex[i - width] !== c) continue;
      if (y + 1 < height && colorIndex[i + width] !== c) continue;
      const o = lab.slot(data, i * 4);
      sum[c * 3] = sum[c * 3]! + lab.lab[o]!;
      sum[c * 3 + 1] = sum[c * 3 + 1]! + lab.lab[o + 1]!;
      sum[c * 3 + 2] = sum[c * 3 + 2]! + lab.lab[o + 2]!;
      cnt[c]!++;
    }
  }
  base.forEach((col, c) => {
    const k = cnt[c]!;
    if (col.locked || k === 0 || k * 8 < col.count) return;
    col.L = sum[c * 3]! / k;
    col.a = sum[c * 3 + 1]! / k;
    col.b = sum[c * 3 + 2]! / k;
  });
}

/**
 * T08 — Mode alpha `keep` : opacité MÉDIANE des pixels de chaque couleur (la
 * moyenne serait tirée vers le bas par l'anti-aliasing des bords) ; `alpha`
 * n'est posé que sous `TRANSLUCENT_ALPHA` (une couleur opaque reste sans).
 */
function setTranslucency(
  colors: PaletteColor[],
  colorIndex: Int16Array,
  data: ArrayLike<number>,
): void {
  const hist = new Int32Array(colors.length * 256);
  for (let i = 0; i < colorIndex.length; i++) {
    const c = colorIndex[i]!;
    if (c >= 0) hist[c * 256 + data[i * 4 + 3]!]!++;
  }
  for (const c of colors) {
    if (c.count === 0) continue;
    let acc = 0;
    let a = 0;
    while (a < 255 && (acc += hist[c.id * 256 + a]!) * 2 < c.count) a++;
    if (a < TRANSLUCENT_ALPHA) c.alpha = a;
  }
}

// ---------------------------------------------------------------------------
// Assignation (boucle chaude, pure, sans allocation : future cible WebAssembly)
// ---------------------------------------------------------------------------

/**
 * Assigne chaque pixel de `[start, end)` au centroïde le plus proche (distance OKLab).
 *
 * @param data       RGBA 8 bits (4 octets par pixel)
 * @param lab        cache OKLab par couleur RGB exacte
 * @param mask       1 = opaque, 0 = transparent (→ -1) ; `null` = tout opaque
 * @param centroids  3 flottants par centroïde, `k` centroïdes
 * @param out        index par pixel (longueur = nombre de pixels)
 * @param counts     incrémenté : nombre de pixels par centroïde (remis à zéro si `start` = 0)
 *
 * À égalité, le centroïde d'index le plus petit l'emporte. Les pixels
 * consécutifs de même couleur RGB réutilisent le résultat précédent.
 */
export function assignPixels(
  data: ArrayLike<number>,
  lab: OklabCache,
  mask: Uint8Array | null,
  centroids: Float64Array,
  k: number,
  out: Int16Array,
  counts: Int32Array,
  start = 0,
  end = out.length,
): void {
  if (start === 0) counts.fill(0);
  const t = lab.lab;
  let pKey = -1;
  let pBest = -1;
  for (let i = start; i < end; i++) {
    if (mask !== null && mask[i]! === 0) {
      out[i] = -1;
      continue;
    }
    const p = i * 4;
    const key = (data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!;
    if (key !== pKey) {
      const o = lab.slot(data, p);
      const L = t[o]!;
      const a = t[o + 1]!;
      const b = t[o + 2]!;
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
      pKey = key;
      pBest = best;
    }
    out[i] = pBest;
    counts[pBest]!++;
  }
}

// ---------------------------------------------------------------------------
// Échantillon
// ---------------------------------------------------------------------------

interface Sample {
  /** Couleurs uniques en OKLab (3 par couleur). */
  lab: Float64Array;
  /** Poids (nombre de pixels échantillonnés) par couleur unique. */
  weight: Float64Array;
  unique: number;
  totalWeight: number;
}

/**
 * Échantillon stratifié déterministe d'au plus `maxSize` pixels opaques
 * (un pixel tiré au hasard dans chaque strate de même taille), dédoublonné
 * par couleur RGB exacte.
 */
function buildSample(
  data: Uint8ClampedArray,
  lab: OklabCache,
  opaque: Uint8Array | null,
  n: number,
  maxSize: number,
  rng: () => number,
): Sample {
  let nOpaque = n;
  let opaqueIdx: Int32Array | null = null;
  if (opaque !== null) {
    nOpaque = 0;
    for (let i = 0; i < n; i++) if (opaque[i]! !== 0) nOpaque++;
    opaqueIdx = new Int32Array(nOpaque);
    for (let i = 0, j = 0; i < n; i++) if (opaque[i]! !== 0) opaqueIdx[j++] = i;
  }
  const size = Math.min(nOpaque, maxSize);
  const index = new Map<number, number>();
  const labOut: number[] = [];
  const weight: number[] = [];
  const step = nOpaque / Math.max(size, 1);
  for (let s = 0; s < size; s++) {
    const r = size === nOpaque ? s : Math.min(nOpaque - 1, Math.floor((s + rng()) * step));
    const px = opaqueIdx ? opaqueIdx[r]! : r;
    const p = px * 4;
    const key = (data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!;
    const u = index.get(key);
    if (u === undefined) {
      index.set(key, weight.length);
      weight.push(1);
      const o = lab.slot(data, p);
      labOut.push(lab.lab[o]!, lab.lab[o + 1]!, lab.lab[o + 2]!);
    } else {
      weight[u]!++;
    }
  }
  return {
    lab: Float64Array.from(labOut),
    weight: Float64Array.from(weight),
    unique: weight.length,
    totalWeight: size,
  };
}

function kCandidates(options: QuantizeOptions): number[] {
  if (options.colors !== 'auto') return [Math.max(1, Math.floor(options.colors))];
  const max = Math.max(1, Math.floor(options.maxColors));
  const ks = AUTO_K_SEQUENCE.filter((k) => k < max);
  ks.push(max);
  return ks;
}

// ---------------------------------------------------------------------------
// k-means++ pondéré
// ---------------------------------------------------------------------------

interface KMeansResult {
  k: number;
  centroids: Float64Array;
  /** Distance OKLab moyenne (pondérée) échantillon → centroïde. */
  error: number;
}

function kmeans(
  sample: Sample,
  k: number,
  initial: Float64Array,
  nInitial: number,
  nLocked: number,
  rng: () => number,
  onIteration: (iter: number) => void,
): KMeansResult {
  const { lab: pts, weight: w, unique: u } = sample;
  const cent = new Float64Array(k * 3);
  // Les `nLocked` premiers centres initiaux sont les verrous ; les suivants
  // (démarrage à chaud) sont libres de bouger.
  cent.set(initial.subarray(0, Math.min(nInitial, k) * 3));
  if (u === 0) {
    // Aucun pixel opaque : seuls les verrous ont un sens ; les autres restent à 0.
    return { k, centroids: cent, error: 0 };
  }

  // --- Initialisation k-means++ ---------------------------------------------
  const d2 = new Float64Array(u).fill(Infinity);
  const updateD2 = (c: number): void => {
    const q = c * 3;
    for (let i = 0, o = 0; i < u; i++, o += 3) {
      const dL = pts[o]! - cent[q]!;
      const da = pts[o + 1]! - cent[q + 1]!;
      const db = pts[o + 2]! - cent[q + 2]!;
      const d = dL * dL + da * da + db * db;
      if (d < d2[i]!) d2[i] = d;
    }
  };
  const nStart = Math.min(nInitial, k);
  for (let c = 0; c < nStart; c++) updateD2(c);
  for (let c = nStart; c < k; c++) {
    let total = 0;
    if (c > 0) for (let i = 0; i < u; i++) total += w[i]! * d2[i]!;
    // Premier centre, ou toutes les couleurs déjà couvertes : tirage selon le poids seul.
    const byWeight = c === 0 || total <= 0;
    if (byWeight) total = sample.totalWeight;
    let target = rng() * total;
    let pick = u - 1;
    for (let i = 0; i < u; i++) {
      target -= byWeight ? w[i]! : w[i]! * d2[i]!;
      if (target < 0) {
        pick = i;
        break;
      }
    }
    cent[c * 3] = pts[pick * 3]!;
    cent[c * 3 + 1] = pts[pick * 3 + 1]!;
    cent[c * 3 + 2] = pts[pick * 3 + 2]!;
    updateD2(c);
  }

  // --- Itérations de Lloyd ----------------------------------------------------
  const assign = new Int32Array(u);
  const sums = new Float64Array(k * 4);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    onIteration(iter);
    assignSample(pts, u, cent, k, assign);
    sums.fill(0);
    for (let i = 0; i < u; i++) {
      const q = assign[i]! * 4;
      const wi = w[i]!;
      sums[q]! += pts[i * 3]! * wi;
      sums[q + 1]! += pts[i * 3 + 1]! * wi;
      sums[q + 2]! += pts[i * 3 + 2]! * wi;
      sums[q + 3]! += wi;
    }
    let shift = 0;
    for (let c = nLocked; c < k; c++) {
      const q = c * 4;
      if (sums[q + 3]! === 0) continue; // cluster vide : le centroïde reste en place
      const L = sums[q]! / sums[q + 3]!;
      const a = sums[q + 1]! / sums[q + 3]!;
      const b = sums[q + 2]! / sums[q + 3]!;
      const dL = L - cent[c * 3]!;
      const da = a - cent[c * 3 + 1]!;
      const db = b - cent[c * 3 + 2]!;
      shift = Math.max(shift, Math.sqrt(dL * dL + da * da + db * db));
      cent[c * 3] = L;
      cent[c * 3 + 1] = a;
      cent[c * 3 + 2] = b;
    }
    if (shift < EPSILON) break;
  }

  // --- Erreur moyenne avec les centroïdes finaux -----------------------------
  assignSample(pts, u, cent, k, assign);
  let err = 0;
  for (let i = 0; i < u; i++) {
    const o = i * 3;
    const q = assign[i]! * 3;
    const dL = pts[o]! - cent[q]!;
    const da = pts[o + 1]! - cent[q + 1]!;
    const db = pts[o + 2]! - cent[q + 2]!;
    err += w[i]! * Math.sqrt(dL * dL + da * da + db * db);
  }
  return { k, centroids: cent, error: err / sample.totalWeight };
}

function assignSample(
  pts: Float64Array,
  u: number,
  cent: Float64Array,
  k: number,
  out: Int32Array,
): void {
  for (let i = 0, o = 0; i < u; i++, o += 3) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0, q = 0; c < k; c++, q += 3) {
      const dL = pts[o]! - cent[q]!;
      const da = pts[o + 1]! - cent[q + 1]!;
      const db = pts[o + 2]! - cent[q + 2]!;
      const d = dL * dL + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    out[i] = best;
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Ordre des indices par valeur décroissante (à égalité, index croissant). */
function sortedOrder(values: ArrayLike<number>): number[] {
  const idx = Array.from({ length: values.length }, (_, i) => i);
  idx.sort((x, y) => values[y]! - values[x]! || x - y);
  return idx;
}

function remap(colorIndex: Int16Array, map: Int16Array): void {
  for (let i = 0; i < colorIndex.length; i++) {
    const c = colorIndex[i]!;
    if (c >= 0) colorIndex[i] = map[c]!;
  }
}
