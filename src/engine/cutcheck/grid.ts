/**
 * T35 — Index spatial des segments : grille uniforme (CSR sur tableaux typés). Chaque segment
 * est inscrit dans les cellules que touche son voisinage carré de demi-côté `pad` (balayage
 * par rangée : coût linéaire en longueur, jamais l'aire de sa boîte). Deux segments à moins de
 * `2·pad` l'un de l'autre partagent donc au moins une cellule : les tests de paires ne
 * parcourent que les cellules, jamais toutes les paires. Pur, isolable (portage WebAssembly).
 */

/** Cellules au plus (16 Mo d'index de cellules). */
export const MAX_GRID_CELLS = 1 << 22;

export class SegmentGrid {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** Début de chaque cellule dans `items` (`cols·rows + 1` entrées). */
  readonly start: Int32Array;
  readonly items: Int32Array;
  readonly pad: number;

  /**
   * Segments `i` de (ax[i], ay[i]) à (bx[i], by[i]) pour chaque `i` de `ids`. Cellule d'au moins
   * `minCell`, de la longueur moyenne des segments, et assez grande pour tenir dans
   * `MAX_GRID_CELLS`.
   */
  constructor(
    ids: Int32Array,
    ax: Float64Array,
    ay: Float64Array,
    bx: Float64Array,
    by: Float64Array,
    pad: number,
    minCell = 0,
  ) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let total = 0;
    for (const i of ids) {
      x0 = Math.min(x0, ax[i]!, bx[i]!);
      x1 = Math.max(x1, ax[i]!, bx[i]!);
      y0 = Math.min(y0, ay[i]!, by[i]!);
      y1 = Math.max(y1, ay[i]!, by[i]!);
      total += Math.hypot(bx[i]! - ax[i]!, by[i]! - ay[i]!);
    }
    if (ids.length === 0) x0 = y0 = x1 = y1 = 0;
    this.pad = pad;
    this.x0 = x0 - pad;
    this.y0 = y0 - pad;
    const w = Math.max(1e-9, x1 - x0 + 2 * pad);
    const h = Math.max(1e-9, y1 - y0 + 2 * pad);
    const mean = ids.length ? total / ids.length : 1;
    let cell = Math.max(minCell, mean, 2 * pad, Math.sqrt((w * h) / MAX_GRID_CELLS), 1e-6);
    while (Math.ceil(w / cell) * Math.ceil(h / cell) > MAX_GRID_CELLS) cell *= 1.25;
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(w / cell));
    this.rows = Math.max(1, Math.ceil(h / cell));
    const n = this.cols * this.rows;
    const count = new Int32Array(n + 1);
    for (const i of ids) {
      this.forEachCell(ax[i]!, ay[i]!, bx[i]!, by[i]!, (c) => {
        count[c + 1]!++;
      });
    }
    for (let c = 0; c < n; c++) count[c + 1]! += count[c]!;
    this.start = count;
    this.items = new Int32Array(count[n]!);
    const fill = count.slice(0, n);
    for (const i of ids) {
      this.forEachCell(ax[i]!, ay[i]!, bx[i]!, by[i]!, (c) => {
        this.items[fill[c]!++] = i;
      });
    }
  }

  /** Cellule du point, ou -1 hors de la grille. */
  cellAt(x: number, y: number): number {
    const cx = Math.floor((x - this.x0) / this.cell);
    const cy = Math.floor((y - this.y0) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /** Cellules touchées par le voisinage (demi-côté `pad`) du segment a → b. */
  forEachCell(ax: number, ay: number, bx: number, by: number, cb: (cell: number) => void): void {
    const { cell, pad, x0, y0, cols, rows } = this;
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - pad - y0) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + pad - y0) / cell));
    const dy = by - ay;
    for (let r = r0; r <= r1; r++) {
      // Partie du segment dont l'ordonnée tombe dans la rangée élargie de `pad`.
      let xa: number;
      let xb: number;
      if (Math.abs(dy) < 1e-12) {
        xa = Math.min(ax, bx);
        xb = Math.max(ax, bx);
      } else {
        const lo = y0 + r * cell - pad;
        const hi = lo + cell + 2 * pad;
        let t0 = (lo - ay) / dy;
        let t1 = (hi - ay) / dy;
        if (t0 > t1) [t0, t1] = [t1, t0];
        t0 = Math.max(0, t0);
        t1 = Math.min(1, t1);
        if (t0 > t1) continue;
        const xt0 = ax + (bx - ax) * t0;
        const xt1 = ax + (bx - ax) * t1;
        xa = Math.min(xt0, xt1);
        xb = Math.max(xt0, xt1);
      }
      const c0 = Math.max(0, Math.floor((xa - pad - x0) / cell));
      const c1 = Math.min(cols - 1, Math.floor((xb + pad - x0) / cell));
      for (let c = c0; c <= c1; c++) cb(r * cols + c);
    }
  }
}
