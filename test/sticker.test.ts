// T95 — Contour de découpe sticker (moteur, `src/engine/sticker/`) : cartes synthétiques, sans DOM.
import { describe, expect, it } from 'vitest';
import { sceneFromSvg } from '../src/engine/export/scene.ts';
import {
  closeMask,
  countComponents,
  dilateMask,
  edt2,
  erodeMask,
  fillHoles,
  inkMask,
  MAX_CLOSE_MM,
  MIN_STICKER_MM2,
  STICKER_PRESETS,
  stickerContour,
  stickerContourFromSvg,
  type StickerContour,
} from '../src/engine/sticker/index.ts';
import { flattenSubpath } from '../src/engine/export/polyline.ts';
import type { SubPath } from '../src/engine/svg/rings.ts';
import { mulberry32 } from '../src/engine/color/prng.ts';

// --- Aides -----------------------------------------------------------------------------------

/** Polygone régulier (disque) en `d` absolu ; `ccw` : sens inverse (trou en `nonzero`). */
function disk(cx: number, cy: number, r: number, ccw = false, n = 96): string {
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? -1 : 1) * 2 * Math.PI * i) / n;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** SVG d'Homotope : fond `<rect>` blanc, encre noire (mode découpé). */
function svgOf(w: number, h: number, d: string, extra = ''): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill-rule="evenodd">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/>${extra}</svg>`
  );
}

/** 400 px pour 200 mm : 0,5 mm par px. */
const W_PX = 400;
const W_MM = 200;
const PX = W_MM / W_PX;

/** Aire (px²) d'un sous-tracé fermé, par sa polyligne. */
function area(sp: SubPath): number {
  const pts = flattenSubpath({ ...sp, start: [sp.start[0], sp.start[1]], closed: true }, 0.01);
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i]! * pts[2 * j + 1]! - pts[2 * j]! * pts[2 * i + 1]!;
  }
  return Math.abs(a) / 2;
}

function bbox(sp: SubPath): [number, number, number, number] {
  const pts = flattenSubpath({ ...sp, start: [sp.start[0], sp.start[1]], closed: true }, 0.01);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  return [x0, y0, x1, y1];
}

function contour(svg: string, o: Partial<Parameters<typeof stickerContour>[1]> = {}) {
  return stickerContourFromSvg(svg, {
    marginMm: 2,
    closeMm: 3,
    mode: 'separate',
    widthMm: W_MM,
    ...o,
  });
}

// --- Morphologie -----------------------------------------------------------------------------

/** Fermeture NAÏVE (disque `dx² + dy² ≤ r²`, pixels hors grille ignorés) : la référence. */
function naiveClose(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const R = Math.floor(r);
  const r2 = r * r;
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -R; dy <= R && !hit; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h || dx * dx + dy * dy > r2) continue;
          if (mask[Y * w + X]) {
            hit = 1;
            break;
          }
        }
      dil[y * w + x] = hit;
    }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!dil[y * w + x]) continue;
      let keep = 1;
      for (let dy = -R; dy <= R && keep; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h || dx * dx + dy * dy > r2) continue;
          if (!dil[Y * w + X]) {
            keep = 0;
            break;
          }
        }
      out[y * w + x] = keep;
    }
  return out;
}

describe('T95 — morphologie par transformée de distance', () => {
  it('edt2 donne la distance euclidienne exacte au carré (force brute)', () => {
    const rnd = mulberry32(7);
    const w = 23;
    const h = 17;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = rnd() < 0.08 ? 1 : 0;
    const d = edt2(m, w, h, 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let j = 0; j < m.length; j++)
          if (m[j]) best = Math.min(best, (x - (j % w)) ** 2 + (y - Math.floor(j / w)) ** 2);
        expect(d[y * w + x]).toBe(best);
      }
  });

  it('fermeture par distance ÉGALE à la fermeture naïve (copie prouvée)', () => {
    const rnd = mulberry32(42);
    for (const [w, h, r, p] of [
      [31, 24, 2, 0.1],
      [40, 33, 3.5, 0.06],
      [29, 29, 5, 0.04],
      [36, 20, 1.5, 0.25],
      [25, 25, 4.2, 0.15],
    ] as const) {
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = rnd() < p ? 1 : 0;
      expect(Array.from(closeMask(m, w, h, r)), `w=${w} r=${r}`).toEqual(
        Array.from(naiveClose(m, w, h, r)),
      );
    }
  });

  it('dilatation et érosion sont celles du disque (rayon 0 = identité)', () => {
    const w = 15;
    const m = new Uint8Array(w * w);
    m[7 * w + 7] = 1;
    const d = dilateMask(m, w, w, 3);
    let n = 0;
    for (let i = 0; i < d.length; i++) n += d[i]!;
    // Disque discret de rayon 3 : 29 pixels.
    expect(n).toBe(29);
    expect(Array.from(erodeMask(d, w, w, 3))).toEqual(Array.from(m));
    expect(Array.from(dilateMask(m, w, w, 0))).toEqual(Array.from(m));
  });

  it('fillHoles bouche les trous, garde le fond relié au bord ; countComponents compte', () => {
    const w = 9;
    const m = new Uint8Array(w * w);
    for (let y = 1; y < 8; y++)
      for (let x = 1; x < 8; x++) m[y * w + x] = x === 1 || x === 7 || y === 1 || y === 7 ? 1 : 0;
    m[4 * w + 4] = 1; // îlot dans le trou
    expect(countComponents(m, w, w)).toBe(2);
    fillHoles(m, w, w);
    expect(countComponents(m, w, w)).toBe(1);
    expect(m[0]).toBe(0);
    expect(m[4 * w + 3]).toBe(1);
  });
});

// --- Contour ---------------------------------------------------------------------------------

describe('T95 — contour de découpe sticker', () => {
  it('un disque troué donne UN anneau, zéro trou', () => {
    const r = contour(svgOf(W_PX, 200, disk(100, 100, 40) + disk(100, 100, 15)));
    expect(r.count).toBe(1);
    expect(r.rings).toHaveLength(1);
    // Aire de l'enveloppe ≈ disque plein de rayon 40 + marge 4 px (2 mm), trou compris.
    const expected = Math.PI * (40 + 2 / PX) ** 2;
    expect(area(r.rings[0]!) / expected).toBeGreaterThan(0.97);
    expect(area(r.rings[0]!) / expected).toBeLessThan(1.03);
  });

  it('deux disques à 2 mm : 2 stickers sans bouchage, 1 avec 3 mm', () => {
    // Rayons 20 px (10 mm), écart 4 px (2 mm) ; marge minimale (0,5 mm) : elle ne les relie pas.
    const svg = svgOf(W_PX, 200, disk(100, 100, 20) + disk(144, 100, 20));
    expect(contour(svg, { closeMm: 0, marginMm: 0.5 }).count).toBe(2);
    expect(contour(svg, { closeMm: 3, marginMm: 0.5 }).count).toBe(1);
  });

  it('mode « un seul » sur trois disques : un anneau ; refusé au-delà de 30 mm', () => {
    const near = svgOf(W_PX, 200, disk(60, 100, 25) + disk(130, 100, 25) + disk(95, 160, 25));
    const one = contour(near, { mode: 'single', closeMm: 0, marginMm: 0.5 });
    expect(one.mode).toBe('single');
    expect(one.count).toBe(1);
    expect(one.rings).toHaveLength(1);
    expect(one.refused).toBeUndefined();
    expect(one.closeMm).toBeGreaterThan(0);
    expect(one.closeMm).toBeLessThanOrEqual(MAX_CLOSE_MM);
    // Le bouchage trouvé est le plus petit au pas de 0,5 mm : un demi-millimètre de moins sépare.
    const less = contour(near, { closeMm: one.closeMm - 0.5, marginMm: 0.5 });
    expect(less.count).toBeGreaterThan(1);

    // Trois disques à 150 mm les uns des autres : aucun bouchage ≤ 30 mm ne les relie.
    const far = svgOf(1200, 200, disk(100, 100, 30) + disk(600, 100, 30) + disk(1100, 100, 30));
    const refused = stickerContourFromSvg(far, {
      marginMm: 2,
      closeMm: 3,
      mode: 'single',
      widthMm: 600,
    });
    expect(refused.refused).toBe(3);
    expect(refused.mode).toBe('separate');
    expect(refused.count).toBe(3);
    expect(refused.closeMm).toBe(3);
  });

  it("l'aire de l'enveloppe croît avec la marge", () => {
    const svg = svgOf(W_PX, 200, disk(100, 100, 30) + disk(170, 110, 20));
    let prev = 0;
    for (const marginMm of [0.5, 1, 2, 4, 8]) {
      const r = contour(svg, { marginMm, closeMm: 3 });
      const a = r.rings.reduce((s, sp) => s + area(sp), 0);
      expect(a, `marge ${marginMm}`).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it('un dessin collé au bord garde sa marge (hors de l’image)', () => {
    const svg = svgOf(W_PX, 200, disk(30, 100, 30)); // touche x = 0
    const r = contour(svg, { marginMm: 2 });
    const [x0] = bbox(r.rings[0]!);
    expect(x0).toBeLessThan(-2 / PX + 0.6);
    expect(x0).toBeGreaterThan(-2 / PX - 0.6);
  });

  it('un îlot sous le seuil est ignoré ET compté', () => {
    // Îlot de 1 px de côté (0,25 mm²) loin du disque : sous MIN_STICKER_MM2.
    const speck = 'M300 100h1v1h-1z';
    expect(PX * PX).toBeLessThan(MIN_STICKER_MM2);
    const r = contour(svgOf(W_PX, 200, disk(100, 100, 30) + speck));
    expect(r.count).toBe(1);
    expect(r.ignored).toBe(1);
  });

  it('fond transparent (rien de peint) et Noir et blanc (papier = couleur du bord)', () => {
    const transparent =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" fill-rule="evenodd">` +
      `<path fill="#c00" d="${disk(100, 100, 40)}"/></svg>`;
    expect(
      stickerContourFromSvg(transparent, { ...STICKER_PRESETS.standard, mode: 'separate' }).count,
    ).toBe(1);
    // Sans `<rect>` : le blanc est une forme ; le papier est la couleur du bord (blanc).
    const bw =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" fill-rule="evenodd">` +
      `<path fill="#fff" d="M0 0H200V200H0Z${disk(100, 100, 40, true)}"/><path fill="#000" d="${disk(100, 100, 40)}"/></svg>`;
    const scene = sceneFromSvg(bw);
    const grid = { width: 200, height: 200, scale: 1, pad: 0 };
    const ink = inkMask(scene, grid);
    expect(ink[100 * 200 + 100]).toBe(1);
    expect(ink[5 * 200 + 5]).toBe(0);
    expect(stickerContour(scene, { ...STICKER_PRESETS.standard, mode: 'separate' }).count).toBe(1);
  });

  it('dessin vide : aucun anneau', () => {
    const empty =
      `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50" fill-rule="evenodd">` +
      `<rect width="100%" height="100%" fill="#fff"/></svg>`;
    const r: StickerContour = stickerContourFromSvg(empty, {
      ...STICKER_PRESETS.standard,
      mode: 'single',
    });
    expect(r.count).toBe(0);
    expect(r.rings).toEqual([]);
  });

  it('un grand dessin (4 000 px, 20 mm de bouchage) tient sous la seconde', () => {
    const svg = svgOf(
      4000,
      4000,
      disk(1000, 1000, 500) + disk(2400, 1000, 500) + disk(1700, 2600, 600),
    ).replace('width="400"', 'width="4000"');
    const t0 = performance.now();
    const r = stickerContourFromSvg(svg, {
      marginMm: 2,
      closeMm: 20,
      mode: 'separate',
      widthMm: 200,
    });
    expect(r.count).toBeGreaterThan(0);
    // Marge large (CI, JIT froid) ; mesuré ~0,3 s.
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
