import { checkCancel, globalProgress } from '../pipeline.ts';
import type {
  FixedPalette,
  PaletteColor,
  PaletteConstraints,
  PreprocessResult,
  QuantizeOptions,
  QuantizeResult,
  Rgb,
  VectorizeContext,
  VectorizeOptions,
} from '../types.ts';
import { FIXED_PALETTE_MAX, TRANSLUCENT_ALPHA } from '../types.ts';
import { OklabCache, oklabToRgb, rgbToOklab } from './oklab.ts';
import { mulberry32 } from './prng.ts';

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
      const err = new Float32Array(width * 6);
      const rows = Math.max(1, Math.floor(ASSIGN_CHUNK / Math.max(width, 1)));
      for (let y0 = 0; y0 < height; y0 += rows) {
        const y1 = Math.min(height, y0 + rows);
        ditherPixels(data, lab, opaque, centroids, k, width, y0, y1, colorIndex, counts, err);
        checkCancel(ctx);
        if (progress) ctx?.onProgress?.(globalProgress('quantize', 0.9 + (0.08 * y1) / height));
      }
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
  if (fixed && fixed.minCoverage > 0) {
    const kept = coveredColors(counts, fixed.minCoverage);
    if (kept.length < k) {
      lockedRgb = kept.map((c) => lockedRgb[c]!);
      centroids = labOf(lockedRgb);
      k = kept.length;
      counts = new Int32Array(k);
      assignAll(false);
    }
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
  const { out: final, groupOf } = applyConstraints(sortedBase, constraints, data, lab, colorIndex);

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
// Contraintes
// ---------------------------------------------------------------------------

interface BaseColor {
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
function applyConstraints(
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
function recolorPalette(
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

function normalizeRgb(rgb: Rgb): Rgb {
  const c = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
  return [c(rgb[0]), c(rgb[1]), c(rgb[2])];
}
