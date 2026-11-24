// 車両到達性解析：敷地をグリッド化し、通路クリアランス（車幅相当の半径）を確保した空間を
// 出入口から塗りつぶし探索して、各駐車枠の前面に車両が到達できるかを判定する。
import type { Vec2 } from '@/types';
import { bbox, pointInPolygon } from '@/engine/geometry/polygon';

export interface Grid {
  minX: number;
  minY: number;
  h: number;
  nx: number;
  ny: number;
  base: Uint8Array; // 1 = 敷地内かつ障害物外
}

export function buildBaseGrid(site: Vec2[], obstacles: Vec2[][], maxCells = 160000): Grid {
  const b = bbox(site);
  const w = b.maxX - b.minX;
  const hgt = b.maxY - b.minY;
  const h = Math.max(0.2, Math.sqrt((w * hgt) / maxCells));
  const nx = Math.ceil(w / h) + 1;
  const ny = Math.ceil(hgt / h) + 1;
  const base = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = b.minY + (j + 0.5) * h;
    // 走査線で内外判定（高速化）
    const xs: number[] = [];
    for (let i = 0, k = site.length - 1; i < site.length; k = i++) {
      const a = site[i];
      const c = site[k];
      if (a.y > y !== c.y > y) xs.push(((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x);
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - b.minX) / h - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[s + 1] - b.minX) / h - 0.5));
      for (let i = i0; i <= i1; i++) base[j * nx + i] = 1;
    }
  }
  const grid: Grid = { minX: b.minX, minY: b.minY, h, nx, ny, base };
  for (const o of obstacles) paintPolygon(grid, base, o, 0);
  return grid;
}

export function paintPolygon(g: Grid, arr: Uint8Array, poly: Vec2[], value: number): void {
  const b = bbox(poly);
  const i0 = Math.max(0, Math.floor((b.minX - g.minX) / g.h));
  const i1 = Math.min(g.nx - 1, Math.ceil((b.maxX - g.minX) / g.h));
  const j0 = Math.max(0, Math.floor((b.minY - g.minY) / g.h));
  const j1 = Math.min(g.ny - 1, Math.ceil((b.maxY - g.minY) / g.h));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const p = { x: g.minX + (i + 0.5) * g.h, y: g.minY + (j + 0.5) * g.h };
      if (pointInPolygon(p, poly)) arr[j * g.nx + i] = value;
    }
  }
}

/** 2パス距離変換（8近傍の面取り距離, m） */
function distanceTransform(g: Grid, free: Uint8Array): Float32Array {
  const { nx, ny, h } = g;
  const INF = 1e9;
  const d = new Float32Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = free[k] ? INF : 0;
  const diag = Math.SQRT2 * h;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + h);
      else v = Math.min(v, h);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + h);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + diag);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + diag);
      } else v = Math.min(v, h);
      d[k] = v;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + 1] + h);
      else v = Math.min(v, h);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + h);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + diag);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + diag);
      } else v = Math.min(v, h);
      d[k] = v;
    }
  }
  return d;
}

export interface ReachResult {
  reachable: (p: Vec2) => boolean;
  /** 出入口からの経路距離（m）。到達不可は Infinity */
  pathDistance: (p: Vec2) => number;
  /** その点の空きクリアランス（最寄りの障害・枠・境界までの距離, m） */
  clearanceAt: (p: Vec2) => number;
  /** 到達可能な通行領域の面積（車両中心の軌跡, ㎡） */
  reachableArea: number;
  /** 車両が実際に使える通行面積（到達可能な軌跡を車両半幅で膨らませた範囲, ㎡） */
  circulationArea: number;
}

/**
 * clearance: 車両中心が通れる必要最小距離（通路幅/2 程度）
 * 出入口は境界上の点。敷地外の道路から進入する想定で、出入口付近は敷地外側も通行可とする。
 */
export function analyzeReachability(
  g: Grid,
  blockers: Vec2[][],
  entrances: { point: Vec2; inward: Vec2; width: number }[],
  clearance: number,
): ReachResult {
  const free = g.base.slice();
  for (const b of blockers) paintPolygon(g, free, b, 0);
  // 出入口の道路側（敷地外）を通行可能にして、境界による距離減少を緩和
  for (const e of entrances) {
    const t = { x: -e.inward.y, y: e.inward.x };
    const hw = e.width / 2;
    const out = clearance * 2 + 1;
    const poly = [
      { x: e.point.x + t.x * hw - e.inward.x * out, y: e.point.y + t.y * hw - e.inward.y * out },
      { x: e.point.x - t.x * hw - e.inward.x * out, y: e.point.y - t.y * hw - e.inward.y * out },
      { x: e.point.x - t.x * hw + e.inward.x * 0.3, y: e.point.y - t.y * hw + e.inward.y * 0.3 },
      { x: e.point.x + t.x * hw + e.inward.x * 0.3, y: e.point.y + t.y * hw + e.inward.y * 0.3 },
    ];
    paintPolygon(g, free, poly, 1);
  }
  const d = distanceTransform(g, free);
  const { nx, ny, h } = g;
  const dist = new Float32Array(nx * ny).fill(Infinity);
  const queue: number[] = [];
  const cellOf = (p: Vec2): [number, number] => [Math.floor((p.x - g.minX) / h), Math.floor((p.y - g.minY) / h)];
  const passable = (k: number): boolean => d[k] >= clearance - h * 0.5;
  for (const e of entrances) {
    // 出入口から内側へ進んだ点を起点に、通行可能セルを探す
    for (let s = 0; s <= 8; s++) {
      const p = { x: e.point.x + e.inward.x * (s * 0.5), y: e.point.y + e.inward.y * (s * 0.5) };
      const [i, j] = cellOf(p);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      if (passable(k) && dist[k] === Infinity) {
        dist[k] = 0;
        queue.push(k);
      }
    }
  }
  // ダイクストラ近似（4近傍BFS、セル幅で距離加算）
  let head = 0;
  while (head < queue.length) {
    const k = queue[head++];
    const i = k % nx;
    const j = (k - i) / nx;
    const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const q of nb) {
      if (q < 0 || dist[q] !== Infinity || !passable(q)) continue;
      dist[q] = dist[k] + h;
      queue.push(q);
    }
  }
  const lookup = (p: Vec2): number => {
    const [i0, j0] = cellOf(p);
    let best = Infinity;
    const r = Math.max(1, Math.ceil(0.4 / h));
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        best = Math.min(best, dist[j * nx + i]);
      }
    }
    return best;
  };
  const clearanceAt = (p: Vec2): number => {
    const [i, j] = cellOf(p);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return 0;
    return d[j * nx + i];
  };
  let reached = 0;
  for (let k = 0; k < dist.length; k++) if (dist[k] < Infinity) reached++;
  // 到達セルからの距離（面取り距離変換）→ クリアランス以内の空きセル＝車両が使う通行面積
  const near = new Float32Array(nx * ny);
  for (let k = 0; k < near.length; k++) near[k] = dist[k] < Infinity ? 0 : 1e9;
  const dg = Math.SQRT2 * h;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = near[k];
      if (i > 0) v = Math.min(v, near[k - 1] + h);
      if (j > 0) {
        v = Math.min(v, near[k - nx] + h);
        if (i > 0) v = Math.min(v, near[k - nx - 1] + dg);
        if (i < nx - 1) v = Math.min(v, near[k - nx + 1] + dg);
      }
      near[k] = v;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = near[k];
      if (i < nx - 1) v = Math.min(v, near[k + 1] + h);
      if (j < ny - 1) {
        v = Math.min(v, near[k + nx] + h);
        if (i < nx - 1) v = Math.min(v, near[k + nx + 1] + dg);
        if (i > 0) v = Math.min(v, near[k + nx - 1] + dg);
      }
      near[k] = v;
    }
  let used = 0;
  for (let k = 0; k < near.length; k++) if (g.base[k] && free[k] && near[k] <= clearance + h * 0.5) used++;
  return { reachable: (p) => lookup(p) < Infinity, pathDistance: lookup, clearanceAt, reachableArea: reached * h * h, circulationArea: used * h * h };
}
