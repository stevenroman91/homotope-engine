/**
 * Définition des images de test (fixtures). Chaque fixture se construit en
 * mémoire de façon déterministe ; `scripts/gen-fixtures.ts` les écrit dans
 * `test/fixtures/` et les tests vérifient que les fichiers commités
 * correspondent exactement à ce que produit ce module.
 */
import type { RasterImage, Rgb } from '../../src/engine/types.ts';
import {
  Canvas,
  circlePoints,
  cubicPoints,
  disk,
  downsampleBox,
  ellipseRing,
  linearGradient,
  mulberry32,
  polygon,
  radialGradient,
  rect,
  ring,
  strokeLine,
  transform,
  union,
  type Shape,
} from './draw.ts';

export interface FixtureSpec {
  /** Nom de fichier dans `test/fixtures/`. */
  file: string;
  format: 'png' | 'jpg';
  /** Qualité JPEG (si `format = 'jpg'`). */
  quality?: number;
  build: () => RasterImage;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

// ---------------------------------------------------------------------------
// Logo (256×256, 4 couleurs)
// ---------------------------------------------------------------------------

export const LOGO_COLORS = {
  background: WHITE,
  navy: [29, 53, 87] as Rgb,
  red: [230, 57, 70] as Rgb,
  teal: [42, 157, 143] as Rgb,
} as const;

/** Formes du logo dans un repère 256×256. */
function logoShapes(): { shape: Shape; color: Rgb }[] {
  const { navy, red, teal } = LOGO_COLORS;
  return [
    // « O » : anneau (un trou).
    { shape: ring(70, 70, 28, 48), color: navy },
    // « A » : contour + contre-forme triangulaire.
    {
      shape: polygon(
        [176, 22, 196, 22, 230, 118, 208, 118, 200, 96, 172, 96, 164, 118, 142, 118],
        [186, 44, 196, 78, 176, 78],
      ),
      color: red,
    },
    // Disque plein.
    { shape: disk(80, 185, 40), color: teal },
    // Rectangle touchant les bords droit et bas.
    { shape: rect(150, 160, 256, 256), color: navy },
  ];
}

/** Rendu du logo à l'échelle k (k = 1 → 256×256), sans anti-aliasing. */
export function renderLogo(k: number): RasterImage {
  const c = new Canvas(256 * k, 256 * k).background(LOGO_COLORS.background);
  for (const { shape, color } of logoShapes()) c.fill(transform(shape, k), color);
  return c.toRaster();
}

// ---------------------------------------------------------------------------
// Glyphes (boîte 60×100, contre-formes en contours intérieurs pair-impair)
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, Shape> = {
  H: union(rect(0, 0, 14, 100), rect(46, 0, 60, 100), rect(14, 43, 46, 57)),
  O: ellipseRing(30, 50, 30, 50, 16, 36),
  B: polygon(
    [0, 0, 40, 0, 56, 10, 56, 40, 48, 48, 60, 58, 60, 90, 46, 100, 0, 100],
    [14, 13, 42, 13, 42, 42, 14, 42],
    [14, 56, 46, 56, 46, 87, 14, 87],
  ),
  A: polygon(
    [22, 0, 38, 0, 60, 100, 45, 100, 40, 76, 20, 76, 15, 100, 0, 100],
    [30, 18, 37, 62, 23, 62],
  ),
  P: polygon(
    [0, 0, 42, 0, 60, 14, 60, 46, 42, 60, 14, 60, 14, 100, 0, 100],
    [14, 13, 40, 13, 46, 20, 46, 40, 40, 47, 14, 47],
  ),
  D: polygon(
    [0, 0, 36, 0, 60, 22, 60, 78, 36, 100, 0, 100],
    [14, 14, 32, 14, 46, 28, 46, 72, 32, 86, 14, 86],
  ),
};

function drawText(c: Canvas, text: string, x: number, y: number, size: number, ss: number): void {
  drawTextColor(c, text, x, y, size, ss, BLACK);
}

function drawTextColor(
  c: Canvas,
  text: string,
  x: number,
  y: number,
  size: number,
  ss: number,
  color: Rgb,
): void {
  const k = size / 100;
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`glyphe inconnu : ${ch}`);
    c.fill(transform(g, k, cx, y), color, { ss });
    cx += 80 * k;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function logoAa(): RasterImage {
  return downsampleBox(renderLogo(4), 4);
}

function text(): RasterImage {
  const c = new Canvas(360, 150).background(WHITE);
  drawText(c, 'BOPA', 20, 10, 70, 4);
  drawText(c, 'HDOBA', 20, 95, 40, 4);
  return c.toRaster();
}

export const PIXEL_ART_COLORS: readonly Rgb[] = [
  [95, 205, 228], // ciel
  [143, 86, 59], // terre
  [106, 190, 48], // herbe
  [251, 242, 54], // soleil
  [217, 87, 99], // murs
  [172, 50, 50], // toit
  [34, 32, 52], // fenêtre
  [102, 57, 49], // porte
];

function pixelArt(): RasterImage {
  const [sky, ground, grass, sun, wall, roof, win, door] = PIXEL_ART_COLORS as Rgb[];
  const c = new Canvas(32, 32).background(sky!);
  c.fill(rect(0, 24, 32, 32), ground!);
  c.fill(rect(0, 22, 32, 24), grass!);
  c.fill(disk(26, 6, 4), sun!);
  c.fill(rect(6, 12, 18, 22), wall!);
  c.fill(polygon([4, 12.5, 12, 4.5, 20, 12.5]), roof!);
  c.fill(rect(8, 14, 11, 17), win!);
  c.fill(rect(13, 16, 16, 22), door!);
  return c.toRaster();
}

function illustration(): RasterImage {
  const ss = 4;
  const c = new Canvas(200, 200).background(
    linearGradient(0, 0, [207, 232, 247], 0, 200, [246, 239, 224]),
  );
  c.fill(disk(150, 50, 28), radialGradient(150, 50, 28, [255, 226, 120], [248, 170, 70]), { ss });
  c.fill(
    polygon([0, 140, 40, 105, 90, 125, 140, 95, 200, 130, 200, 200, 0, 200]),
    linearGradient(0, 95, [120, 170, 90], 0, 200, [70, 120, 60]),
    { ss },
  );
  c.fill(
    polygon([0, 170, 70, 150, 130, 165, 200, 155, 200, 200, 0, 200]),
    linearGradient(0, 150, [95, 145, 75], 0, 200, [55, 95, 50]),
    { ss },
  );
  c.fill(rect(52, 120, 60, 160), [110, 75, 50], { ss });
  c.fill(disk(56, 108, 20), radialGradient(50, 100, 24, [90, 160, 80], [50, 110, 55]), { ss });
  c.fill(ring(150, 50, 34, 38), [250, 200, 110], { ss, opacity: 0.6 });
  return c.toRaster();
}

function photo(): RasterImage {
  const ss = 2;
  const c = new Canvas(256, 256).background(
    linearGradient(0, 0, [120, 160, 210], 0, 160, [225, 200, 180]),
  );
  c.fill(
    polygon([0, 170, 50, 110, 90, 140, 150, 80, 210, 135, 256, 115, 256, 256, 0, 256]),
    linearGradient(0, 80, [100, 105, 120], 0, 256, [60, 70, 65]),
    { ss },
  );
  c.fill(disk(200, 45, 22), radialGradient(200, 45, 22, [255, 245, 220], [245, 210, 160]), { ss });
  c.fill(rect(30, 160, 100, 240), linearGradient(30, 0, [180, 120, 90], 100, 0, [130, 80, 60]), {
    ss,
  });
  c.fill(rect(45, 180, 60, 200), [230, 220, 170], { ss });
  c.fill(rect(70, 180, 85, 200), [230, 220, 170], { ss });
  c.fill(disk(170, 200, 30), radialGradient(160, 190, 36, [90, 140, 70], [40, 80, 40]), { ss });
  c.noise(6, mulberry32(20261003));
  return c.toRaster();
}

function alpha(): RasterImage {
  const ss = 4;
  const c = new Canvas(192, 192);
  c.fill(disk(56, 56, 40), [220, 60, 60], { ss });
  c.fill(ring(140, 56, 18, 36), [40, 90, 200], { ss });
  c.fill(rect(24, 116, 100, 172), [60, 170, 90], { ss, opacity: 0.6 });
  c.fill(
    polygon([
      146, 104, 156, 132, 186, 132, 162, 150, 171, 178, 146, 161, 121, 178, 130, 150, 106, 132, 136,
      132,
    ]),
    [240, 150, 30],
    { ss },
  );
  return c.toRaster();
}

/**
 * T08 — Badge 240×120 : cartouche arrondi en dégradé léger, texte blanc FIN
 * (fûts de 3 px), soulignement de 2 px ; anti-aliasé. Teste les formes minces
 * sur fond non uni (absorption, tolérance, bandes d'anti-aliasing).
 */
function badge(): RasterImage {
  const ss = 4;
  const c = new Canvas(240, 120).background(WHITE);
  const plate = union(
    rect(20, 10, 220, 110),
    rect(10, 20, 230, 100),
    disk(20, 20, 10),
    disk(220, 20, 10),
    disk(20, 100, 10),
    disk(220, 100, 10),
  );
  c.fill(plate, linearGradient(0, 10, [36, 70, 140], 0, 110, [22, 44, 96]), { ss });
  drawTextColor(c, 'HDOBA', 34, 30, 34, ss, WHITE);
  c.fill(rect(34, 80, 206, 82), WHITE, { ss });
  return c.toRaster();
}

/**
 * T08 — Icône 64×64 anti-aliasée (suréchantillonnée ×3 par le prétraitement) :
 * pastille orange, coche blanche épaisse, anneau blanc fin de 2 px, petit point
 * sombre de 5 px de diamètre hors de la pastille. Teste la fidélité aux très
 * petites échelles (formes minces, petit détail d'une couleur à part).
 */
function icon64(): RasterImage {
  const ss = 4;
  const c = new Canvas(64, 64).background(WHITE);
  c.fill(disk(32, 32, 28), [240, 120, 40], { ss });
  c.fill(ring(32, 32, 24, 26), WHITE, { ss });
  c.fill(polygon([18, 33, 23, 28, 29, 34, 42, 21, 47, 26, 29, 44]), WHITE, { ss });
  c.fill(disk(53, 11, 2.5), [40, 40, 40], { ss });
  return c.toRaster();
}

/**
 * T33 — Dessin au trait 256×256 (encre presque noire sur papier crème,
 * anti-aliasé) : maison (coins, jonctions en T), soleil (anneau + rayons
 * isolés), fleur (courbes, jonction en Y), croisement en X, vague et traits
 * de 1,5 à 5 px. Cible du préréglage « Trait unique » (centre-ligne).
 */
function lineDrawing(): RasterImage {
  const ss = 4;
  const ink: Rgb = [24, 22, 28];
  const c = new Canvas(256, 256).background([250, 247, 240]);
  const line = (pts: number[], width: number, closed = false): void => {
    c.fill(strokeLine(pts, width, closed), ink, { ss });
  };
  // Maison : murs (coins), toit (pointe), porte et fenêtre (jonctions en T).
  line([40, 200, 40, 130, 120, 130, 120, 200, 40, 200], 4);
  line([32, 136, 80, 92, 128, 136], 4);
  line([70, 200, 70, 165, 92, 165, 92, 200], 3);
  line([50, 145, 64, 145, 64, 158, 50, 158], 2.5, true);
  line([57, 145, 57, 158], 2);
  // Soleil : anneau et rayons isolés.
  line(circlePoints(200, 56, 20), 3.5, true);
  for (let k = 0; k < 8; k++) {
    const a = (Math.PI * k) / 4;
    line(
      [
        200 + 27 * Math.cos(a),
        56 + 27 * Math.sin(a),
        200 + 38 * Math.cos(a),
        56 + 38 * Math.sin(a),
      ],
      2.5,
    );
  }
  // Fleur : tige courbe, deux feuilles (jonctions en Y), pétales.
  line(cubicPoints(190, 240, 186, 210, 198, 180, 192, 150), 3);
  line(cubicPoints(189, 205, 172, 196, 164, 200, 160, 210), 2.5);
  line(cubicPoints(191, 185, 206, 176, 214, 180, 220, 188), 2.5);
  line(circlePoints(192, 140, 10, 48), 3, true);
  // Croisement en X et vague.
  line([150, 100, 180, 128], 3);
  line([180, 100, 150, 128], 3);
  line(cubicPoints(20, 60, 50, 20, 80, 100, 110, 60), 5);
  line([20, 236, 160, 236], 1.5);
  return c.toRaster();
}

export const FIXTURES: readonly FixtureSpec[] = [
  { file: 'logo-flat.png', format: 'png', build: () => renderLogo(1) },
  { file: 'logo-aa.png', format: 'png', build: logoAa },
  { file: 'logo-jpeg.jpg', format: 'jpg', quality: 70, build: logoAa },
  { file: 'text.png', format: 'png', build: text },
  { file: 'pixel-art.png', format: 'png', build: pixelArt },
  { file: 'illustration.png', format: 'png', build: illustration },
  { file: 'photo.png', format: 'png', build: photo },
  { file: 'alpha.png', format: 'png', build: alpha },
  { file: 'badge.png', format: 'png', build: badge },
  { file: 'icon-64.png', format: 'png', build: icon64 },
  { file: 'line-drawing.png', format: 'png', build: lineDrawing },
];
