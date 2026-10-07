import type {
  BoundaryGraph,
  ExportOptions,
  Face,
  FittedChain,
  Palette,
  Ring,
  Segment,
  SvgStats,
  VectorizeContext,
} from '../types.ts';
import { IMAGE_BORDER, TRANSLUCENT_ALPHA, TRANSPARENT } from '../types.ts';
import { reverseFittedChain } from '../fit/index.ts';
import { checkCancel, globalProgress } from '../pipeline.ts';
import { ringSignedArea } from '../topology/index.ts';
import { assembleRing, indexFitted, type SubPath } from './rings.ts';
import { serializeSubpaths } from './path.ts';

export { RingAssemblyError, assembleRing, indexFitted, type SubPath } from './rings.ts';
export { formatTicks, serializeSubpaths } from './path.ts';

export interface SvgOutput {
  svg: string;
  stats: SvgStats;
}

/** Nœuds attribués à un `<rect>` de fond (ses quatre coins). */
export const RECT_NODES = 4;

/** Couleur `#rrggbb`, raccourcie en `#rgb` quand chaque canal a ses deux chiffres égaux. */
export function hexColor(rgb: readonly [number, number, number]): string {
  const h = rgb.map((v) => {
    const c = Math.min(255, Math.max(0, Math.round(v)));
    return c.toString(16).padStart(2, '0');
  });
  if (h.every((x) => x[0] === x[1])) return `#${h[0]![0]}${h[1]![0]}${h[2]![0]}`;
  return `#${h.join('')}`;
}

/** Tracé à émettre : une couleur, des faces (dans l'ordre), des sous-tracés. */
interface Group {
  colorId: number;
  faces: number[];
}

/**
 * T05 — Assemblage des anneaux à partir des chaînes ajustées (partagées), modes
 * `cut` / `stacked`, fusion par couleur, précision, SVG minimal et valide.
 * `scale` divise les coordonnées (facteur travail / origine : > 1 en
 * suréchantillonnage, < 1 pour une image réduite, T12) ; `scaleY`, s'il est
 * donné, divise les ordonnées (sinon `scale`) ; `width`/`height` sont ceux de
 * l'image d'ORIGINE.
 *
 *  - `cut` : chaque face = extérieur + trous, `fill-rule="evenodd"` (posé une
 *    fois sur `<svg>`, il est hérité). Ordre : `colorId`, puis aire décroissante.
 *  - `stacked` : ordre de peinture = profondeur de contenance, puis aire de
 *    l'extérieur décroissante ; extérieur seul, SAUF les trous dont l'intérieur
 *    contient du transparent (sinon la face parente peindrait la transparence) :
 *    ceux-là sont gardés, orientés à l'inverse de l'extérieur, et la règle
 *    `nonzero` par défaut les évide. La fusion ne regroupe que des faces
 *    consécutives dans l'ordre de peinture.
 *  - `backgroundRect` : seulement sans aucune transparence. La couleur retenue
 *    est celle des faces racines (profondeur 0) d'aire extérieure totale
 *    maximale ; un `<rect>` peint en premier remplace en `stacked` ces faces
 *    racines, en `cut` TOUTES les faces de cette couleur (les autres faces,
 *    découpées, ne recouvrent jamais leur emplacement).
 */
export function exportSvg(
  graph: BoundaryGraph,
  fitted: FittedChain[],
  palette: Palette,
  dims: { width: number; height: number; scale: number; scaleY?: number },
  options: ExportOptions,
  ctx?: VectorizeContext,
): SvgOutput {
  const progress = (p: number): void => ctx?.onProgress?.(globalProgress('export', p));
  progress(0);
  const { faces, chains } = graph;
  const byChain = indexFitted(fitted, chains.length);
  const colorOf = new Map<number, readonly [number, number, number]>();
  // T08 : couleurs translucides (mode alpha `keep`), écrites en `fill-opacity`.
  const alphaOf = new Map<number, number>();
  for (const c of palette.colors) {
    colorOf.set(c.id, c.rgb);
    if (c.alpha !== undefined && c.alpha < TRANSLUCENT_ALPHA) alphaOf.set(c.id, c.alpha);
  }
  const translucent = (region: number): boolean =>
    region >= 0 && alphaOf.has(faces[region]!.colorId);

  const outerArea = faces.map((f) => (f.rings[0] ? ringSignedArea(graph, f.rings[0]) : 0));
  const hasTransparent = chains.some((c) => c.left === TRANSPARENT || c.right === TRANSPARENT);
  const stacked = options.mode === 'stacked';

  // --- Fond -----------------------------------------------------------------
  let bgColor = -1;
  // Un fond sous une face translucide se verrait au travers : pas de `<rect>`.
  if (options.backgroundRect && !hasTransparent && alphaOf.size === 0) {
    const rootArea = new Map<number, number>();
    for (const f of faces)
      if (f.depth === 0)
        rootArea.set(f.colorId, (rootArea.get(f.colorId) ?? 0) + outerArea[f.region]!);
    // À aire égale, la couleur de plus petit id gagne, quel que soit l'ordre des
    // faces : `bgColor` est la couleur déjà retenue (testé, #18 point 4).
    let best = -Infinity;
    for (const [c, a] of rootArea)
      if (a > best || (a === best && c < bgColor)) {
        best = a;
        bgColor = c;
      }
  }
  const replaced = (f: Face): boolean =>
    bgColor >= 0 && f.colorId === bgColor && (!stacked || f.depth === 0);

  // --- Ordre et groupes -----------------------------------------------------
  const order = faces.filter((f) => f.rings.length > 0 && !replaced(f)).map((f) => f.region);
  const groups: Group[] = [];
  if (stacked) {
    order.sort(
      (a, b) =>
        faces[a]!.depth - faces[b]!.depth ||
        outerArea[b]! - outerArea[a]! ||
        faces[a]!.colorId - faces[b]!.colorId ||
        a - b,
    );
    for (const f of order) {
      const c = faces[f]!.colorId;
      const last = groups[groups.length - 1];
      if (options.mergeByColor && last && last.colorId === c) last.faces.push(f);
      else groups.push({ colorId: c, faces: [f] });
    }
  } else {
    const area = faces.map((f) => f.rings.reduce((s, r) => s + ringSignedArea(graph, r), 0));
    order.sort((a, b) => faces[a]!.colorId - faces[b]!.colorId || area[b]! - area[a]! || a - b);
    for (const f of order) {
      const c = faces[f]!.colorId;
      const last = groups[groups.length - 1];
      if (options.mergeByColor && last && last.colorId === c) last.faces.push(f);
      else groups.push({ colorId: c, faces: [f] });
    }
  }
  const keepHole =
    stacked && (hasTransparent || alphaOf.size > 0) ? transparentHoles(graph, translucent) : null;

  // --- Sérialisation --------------------------------------------------------
  const colorHex = (id: number): string => {
    const rgb = colorOf.get(id);
    if (!rgb) throw new Error(`exportSvg : couleur ${id} absente de la palette`);
    return hexColor(rgb);
  };
  const W = fmtDim(dims.width);
  const H = fmtDim(dims.height);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${
      stacked ? '' : ' fill-rule="evenodd"'
    }>`,
  ];
  let paths = 0;
  let nodes = 0;
  const used = new Set<number>();
  // Rang de peinture de chaque face (−1 : non peinte, ou remplacée par le fond).
  const rank = new Int32Array(faces.length).fill(-1);
  groups.forEach((g, i) => {
    for (const f of g.faces) rank[f] = i;
  });
  const seamW = options.seamStroke && options.seamStroke > 0 ? options.seamStroke : 0;
  if (bgColor >= 0) {
    parts.push(`<rect width="100%" height="100%" fill="${colorHex(bgColor)}"/>`);
    paths++;
    nodes += RECT_NODES;
    used.add(bgColor);
  }
  const sw = seamW > 0 ? fmtDim(seamW) : '';
  // Traits anti-liseré à part, posés après le remplissage de leur groupe ; le
  // masque (F1) n'est connu qu'une fois tous les traits calculés.
  const strokeAt: { at: number; hex: string; runs: SubPath[] }[] = [];
  for (let g = 0; g < groups.length; g++) {
    if ((g & 63) === 0) {
      checkCancel(ctx);
      progress(g / groups.length);
    }
    const group = groups[g]!;
    const subs: SubPath[] = [];
    for (const f of group.faces) {
      const face = faces[f]!;
      face.rings.forEach((ring, ri) => {
        if (ri > 0 && stacked && !keepHole?.[f]?.[ri]) return;
        subs.push(assembleRing(graph, byChain, ring));
      });
    }
    const ser = serializeSubpaths(subs, dims.scale, options.precision, dims.scaleY);
    if (ser.subpaths === 0) continue;
    const hex = colorHex(group.colorId);
    const alpha = alphaOf.get(group.colorId);
    const fillOpacity = alpha === undefined ? '' : ` fill-opacity="${fmtOpacity(alpha)}"`;
    // Un trait sur une face translucide doublerait son opacité : aucun.
    const seams =
      seamW > 0 && alpha === undefined
        ? seamRuns(graph, byChain, group.faces, rank, g, stacked, keepHole, translucent)
        : null;
    // Le masque (F1) ne peut viser le trait seul d'un tracé qui porte aussi le
    // remplissage : avec de la transparence, le trait est toujours à part.
    const whole = seams?.whole === true && !hasTransparent;
    if (whole) {
      // Toutes les frontières vont sous des faces peintes après (ou au bord) : le
      // tracé lui-même porte le trait, sans aucun nœud de plus.
      parts.push(
        `<path fill="${hex}" stroke="${hex}" stroke-width="${sw}" stroke-linejoin="round" d="${ser.d}"/>`,
      );
    } else parts.push(`<path fill="${hex}"${fillOpacity} d="${ser.d}"/>`);
    paths++;
    nodes += ser.nodes;
    used.add(group.colorId);
    if (seams && !whole && seams.runs.length > 0) {
      strokeAt.push({ at: parts.length, hex, runs: seams.runs });
      parts.push('');
    }
  }
  const mask =
    hasTransparent && strokeAt.length > 0
      ? seamMask(
          graph,
          byChain,
          strokeAt.flatMap((s) => s.runs),
          seamW * dims.scale,
        )
      : [];
  let maskRef = '';
  if (mask.length > 0) {
    const st = serializeSubpaths(mask, dims.scale, options.precision, dims.scaleY);
    if (st.subpaths > 0) {
      parts[0] +=
        `<mask id="t" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
        '<rect width="100%" height="100%" fill="#fff"/>' +
        `<path fill="none" stroke="#000" stroke-width="${fmtDim(2 * seamW)}" stroke-linecap="round" stroke-linejoin="round" d="${st.d}"/></mask>`;
      paths += 2;
      nodes += RECT_NODES + st.nodes;
      maskRef = ' mask="url(#t)"';
    }
  }
  for (const { at, hex, runs } of strokeAt) {
    const st = serializeSubpaths(runs, dims.scale, options.precision, dims.scaleY);
    if (st.subpaths === 0) continue;
    parts[at] =
      `<path fill="none" stroke="${hex}" stroke-width="${sw}" stroke-linejoin="round"${maskRef} d="${st.d}"/>`;
    paths++;
    nodes += st.nodes;
  }
  parts.push('</svg>');
  const svg = parts.join('');
  progress(1);
  return {
    svg,
    stats: {
      paths,
      nodes,
      bytes: new TextEncoder().encode(svg).length,
      colors: used.size,
      regions: faces.length,
    },
  };
}

/**
 * T08 — Chaînes d'un groupe qui reçoivent le trait anti-liseré : celles de ses
 * anneaux PEINTS dont la face d'en face est peinte APRÈS (rang supérieur) ; le
 * bord d'image est neutre (le trait y est rogné par le `viewBox`) ; jamais sous
 * une face translucide. Les chaînes
 * consécutives d'un anneau forment une polyligne ouverte (fermée si l'anneau
 * entier est concerné). `whole` : TOUTES les chaînes peintes du groupe sont
 * concernées ou au bord, le trait peut alors aller sur le tracé lui-même.
 */
function seamRuns(
  graph: BoundaryGraph,
  byChain: readonly (FittedChain | undefined)[],
  groupFaces: readonly number[],
  rank: Int32Array,
  g: number,
  stacked: boolean,
  keepHole: boolean[][] | null,
  translucent: (region: number) => boolean,
): { whole: boolean; runs: SubPath[] } {
  const { faces, chains } = graph;
  const runs: SubPath[] = [];
  let whole = true;
  let any = false;
  const kind = (ring: Ring, k: number): 0 | 1 | 2 => {
    const e = ring.edges[k]!;
    const ch = chains[e.chain]!;
    const other = e.reversed ? ch.left : ch.right;
    if (other === IMAGE_BORDER) return 2; // neutre
    // Sous une face translucide, le trait se verrait : jamais.
    return other >= 0 && rank[other]! > g && !translucent(other) ? 1 : 0;
  };
  for (const f of groupFaces) {
    faces[f]!.rings.forEach((ring, ri) => {
      if (ri > 0 && stacked && !keepHole?.[f]?.[ri]) return; // trou recouvert, non peint
      const n = ring.edges.length;
      const ks = ring.edges.map((_, k) => kind(ring, k));
      if (ks.some((x) => x === 0)) whole = false;
      if (!ks.some((x) => x === 1)) return;
      any = true;
      const first = ks.findIndex((x) => x !== 1);
      if (first < 0) {
        runs.push({ ...assembleRing(graph, byChain, ring) });
        return;
      }
      let cur: SubPath | null = null;
      for (let j = 1; j <= n; j++) {
        const k = (first + j) % n;
        if (ks[k] !== 1) {
          cur = null;
          continue;
        }
        const e = ring.edges[k]!;
        const raw = byChain[e.chain]!;
        const fc = e.reversed ? reverseFittedChain(raw) : raw;
        if (!cur) {
          cur = { start: fc.start, segments: [], open: true };
          runs.push(cur);
        }
        for (const s of fc.segments) cur.segments.push(s);
      }
    });
  }
  return { whole: whole && any, runs };
}

/**
 * F1 (#18, point 1) — Gomme des traits anti-liseré : un trait ne doit jamais
 * couvrir la transparence. Près d'un sommet qui touche le transparent, le bout
 * ou la jonction d'un trait déborde ; le long d'une face plus mince que la
 * demi-largeur du trait aussi. Or tout point peint à tort est à moins de
 * `reach / 2` (demi-largeur du trait, px de travail) du trait ET du transparent :
 * le segment qui le relie au trait traverse une chaîne qui borde TRANSPARENT,
 * en un point lui-même à moins de `reach / 2` du trait. Un masque qui efface une
 * bande de demi-largeur `reach` autour de ces chaînes les retire donc tous,
 * quelle que soit la géométrie. Seuls les morceaux de chaîne dont la boîte
 * (enveloppe des points de contrôle) passe à moins de `reach` d'un trait sont
 * gardés (grille de cases) : le masque reste léger.
 */
function seamMask(
  graph: BoundaryGraph,
  byChain: readonly (FittedChain | undefined)[],
  strokes: readonly SubPath[],
  reach: number,
): SubPath[] {
  const cs = Math.max(1, reach);
  const gw = Math.ceil(graph.width / cs) + 1;
  const gh = Math.ceil(graph.height / cs) + 1;
  const hot = new Uint8Array(gw * gh);
  const cx = (x: number): number => Math.min(gw - 1, Math.max(0, Math.floor(x / cs)));
  const cy = (y: number): number => Math.min(gh - 1, Math.max(0, Math.floor(y / cs)));
  const box = new Float64Array(4);
  const segBox = (x0: number, y0: number, sg: Segment): void => {
    box[0] = Math.min(x0, sg.x);
    box[1] = Math.min(y0, sg.y);
    box[2] = Math.max(x0, sg.x);
    box[3] = Math.max(y0, sg.y);
    if (sg.kind === 'cubic') {
      box[0] = Math.min(box[0]!, sg.c1x, sg.c2x);
      box[1] = Math.min(box[1]!, sg.c1y, sg.c2y);
      box[2] = Math.max(box[2]!, sg.c1x, sg.c2x);
      box[3] = Math.max(box[3]!, sg.c1y, sg.c2y);
    }
  };
  for (const run of strokes) {
    let [x, y] = run.start;
    for (const sg of run.segments) {
      segBox(x, y, sg);
      for (let j = cy(box[1]! - reach); j <= cy(box[3]! + reach); j++)
        for (let i = cx(box[0]! - reach); i <= cx(box[2]! + reach); i++) hot[j * gw + i] = 1;
      x = sg.x;
      y = sg.y;
    }
  }
  const out: SubPath[] = [];
  for (const c of graph.chains) {
    if (c.left !== TRANSPARENT && c.right !== TRANSPARENT) continue;
    const fc = byChain[c.id]!;
    let [x, y] = fc.start;
    let cur: SubPath | null = null;
    for (const sg of fc.segments) {
      segBox(x, y, sg);
      let near = false;
      for (let j = cy(box[1]!); j <= cy(box[3]!) && !near; j++)
        for (let i = cx(box[0]!); i <= cx(box[2]!); i++)
          if (hot[j * gw + i]) {
            near = true;
            break;
          }
      if (!near) cur = null;
      else {
        if (!cur) {
          cur = { start: [x, y], segments: [], open: true };
          out.push(cur);
        }
        cur.segments.push(sg);
      }
      x = sg.x;
      y = sg.y;
    }
  }
  return out;
}

/** Opacité 0..255 → `0.6` (deux décimales, zéro initial omis). */
function fmtOpacity(alpha: number): string {
  return String(Math.round((alpha / 255) * 100) / 100).replace(/^0\./, '.');
}

/** Dimension d'origine : entier attendu, sinon 4 décimales au plus. */
function fmtDim(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

/**
 * Mode `stacked` : pour chaque face, les trous dont l'intérieur contient du
 * transparent, ou une face translucide (T08 : la face parente se verrait au
 * travers). Parcours des faces adjacentes depuis le trou, sans jamais
 * repasser par la face elle-même (tout ce qui touche l'intérieur d'un trou est
 * dedans) ; arrêt dès qu'une chaîne borde TRANSPARENT.
 */
function transparentHoles(
  graph: BoundaryGraph,
  translucent: (region: number) => boolean,
): boolean[][] {
  const { faces, chains } = graph;
  const R = faces.length;
  const touchesT = new Uint8Array(R);
  for (let f = 0; f < R; f++) if (translucent(f)) touchesT[f] = 1;
  const adj: number[][] = faces.map(() => []);
  for (const c of chains) {
    if (c.left >= 0 && c.right === TRANSPARENT) touchesT[c.left] = 1;
    if (c.right >= 0 && c.left === TRANSPARENT) touchesT[c.right] = 1;
    if (c.left >= 0 && c.right >= 0) {
      adj[c.left]!.push(c.right);
      adj[c.right]!.push(c.left);
    }
  }
  const mark = new Int32Array(R).fill(-1);
  let stamp = 0;
  return faces.map((face, f) =>
    face.rings.map((ring, ri) => {
      if (ri === 0) return false;
      stamp++;
      mark[f] = stamp;
      const stack: number[] = [];
      for (const e of ring.edges) {
        const ch = chains[e.chain]!;
        const other = e.reversed ? ch.left : ch.right;
        if (other === TRANSPARENT || translucent(other)) return true;
        if (other >= 0 && mark[other] !== stamp) {
          mark[other] = stamp;
          stack.push(other);
        }
      }
      while (stack.length > 0) {
        const g = stack.pop()!;
        if (touchesT[g]) return true;
        for (const h of adj[g]!)
          if (mark[h] !== stamp) {
            mark[h] = stamp;
            stack.push(h);
          }
      }
      return false;
    }),
  );
}
