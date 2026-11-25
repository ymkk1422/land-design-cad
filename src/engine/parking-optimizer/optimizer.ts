// 駐車場自動配置エンジン（v2）
//
// 探索の流れ
//  1. 主配置：配置方向 × 駐車角度 × 列オフセット（等間隔・出入口正面・境界合わせ）× 横断通路有無 で
//     「枠列 + 通路 + 枠列」の帯を並べる。列ごとに枠の並び位置（u方向オフセット）を最適化。
//     通路は敷地内にクリップする。
//  2. 上位候補を精査：
//     a) 外周充填 … 敷地の各辺に沿って背中合わせの枠列を追加（台形・三角形の斜辺のデッドスペース対策）
//     b) 2方向ゾーン … 凹形地などで、残り領域に別方向の配置を重ねる
//     c) 到達性解析 … 車両旋回軌跡幅を確保した経路で出入口から各枠前面へ到達できない枠を除外
//     d) 行き止まり通路 … 検出し、転回広場（ハンマーヘッド）を設けた案も生成
//  3. 評価・多様な案を選び、問題点と数学的上限との関係（証明済み最適／探索解）を付与。
//
// 台数はすべて幾何検証済みの枠のみ。数学的上限は bounds.ts を参照。
import type {
  Aisle,
  AngleSummary,
  Entrance,
  LayoutMetrics,
  LayoutPlan,
  Obstacle,
  Optimality,
  ParkingSettings,
  PlanIssue,
  Stall,
  StallType,
  UpperBounds,
  Vec2,
} from '@/types';
import {
  bbox,
  convexOverlapsPolygon,
  convexPolygonsOverlap,
  deg,
  dist,
  distanceToBoundary,
  isCCW,
  isConvex,
  offsetPolygonInward,
  pointInPolygon,
  polygonArea,
  polygonInsidePolygon,
  rad,
  rectCorners,
  rotate,
  sub,
} from '@/engine/geometry/polygon';
import { analyzeReachability, buildBaseGrid, type Grid, type ReachResult } from './reachability';
import { checkInterference, obstaclePolygon } from '@/engine/validation/interference';
import { requiredAisleWidth, routeClearance, sweptPath } from '@/engine/validation/turning';
import { upperBounds } from './bounds';

export interface OptimizeInput {
  site: Vec2[];
  obstacles: Obstacle[];
  entrances: Entrance[];
  stallType: StallType;
  settings: ParkingSettings;
  /** 配置方向を固定する場合（度）。未指定は自動探索 */
  fixedOrientations?: number[];
}

export interface OptimizeOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, bestCount: number) => void;
  maxPlans?: number;
  yieldEvery?: number;
}

export interface OptimizeResult {
  plans: LayoutPlan[];
  bounds: UpperBounds;
  angleSummary: AngleSummary[];
  stats: { candidates: number; refined: number; ms: number };
}

export class OptimizeCancelled extends Error {
  constructor() {
    super('自動配置をキャンセルしました');
  }
}

type WStall = Stall & { access: Vec2; row: string; front: Vec2 };

interface Layout {
  orientation: number;
  stallAngle: number;
  stalls: WStall[];
  aisles: Aisle[];
  strategy: string[];
  aisleWidth: number;
  turnaround: boolean;
}

interface Evaluated {
  layout: Layout;
  metrics: LayoutMetrics;
  issues: PlanIssue[];
  deadEnds: number;
  unreachable: number;
}

let uid = 0;
const nid = (p: string): string => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

/** 出入口の位置・内向き法線 */
export function entranceGeometry(site: Vec2[], e: Entrance): { point: Vec2; inward: Vec2; tangent: Vec2 } {
  const n = site.length;
  const a = site[((e.edgeIndex % n) + n) % n];
  const b = site[(e.edgeIndex + 1) % n];
  const point = { x: a.x + (b.x - a.x) * e.t, y: a.y + (b.y - a.y) * e.t };
  const L = dist(a, b) || 1;
  const tangent = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const inward = isCCW(site) ? { x: -tangent.y, y: tangent.x } : { x: tangent.y, y: -tangent.x };
  return { point, inward, tangent };
}

function horizontalIntervals(poly: Vec2[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const a = poly[i];
    const c = poly[k];
    if (a.y > y !== c.y > y) xs.push(((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x);
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let s = 0; s + 1 < xs.length; s += 2) out.push([xs[s], xs[s + 1]]);
  return out;
}

/** 帯 [y0,y1] 全体で敷地内となる x 区間（帯の上下端と、帯内の全頂点高さでの走査線の共通部分） */
function bandIntervals(poly: Vec2[], y0: number, y1: number): [number, number][] {
  const e = 1e-7;
  const ys = [y0 + e, (y0 + y1) / 2, y1 - e, ...poly.map((p) => p.y).filter((y) => y > y0 + e && y < y1 - e).flatMap((y) => [y - 1e-6, y + 1e-6])];
  let cur = horizontalIntervals(poly, ys[1]);
  for (const y of ys) {
    if (y === ys[1]) continue;
    const other = horizontalIntervals(poly, y);
    const next: [number, number][] = [];
    for (const [a, b] of cur) for (const [c, d] of other) {
      const lo = Math.max(a, c);
      const hi = Math.min(b, d);
      if (hi - lo > 0.05) next.push([lo, hi]);
    }
    cur = next;
  }
  return cur.map(([a, b]) => [a + 1e-4, b - 1e-4] as [number, number]);
}

interface Ctx {
  site: Vec2[];
  st: StallType;
  s: ParkingSettings;
  obstacles: Vec2[][];
  entrances: { point: Vec2; inward: Vec2; tangent: Vec2; width: number }[];
  zones: Vec2[][]; // 出入口前の確保領域（ワールド座標）
  clearance: number;
}

function entranceZones(ent: Ctx['entrances'], s: ParkingSettings): Vec2[][] {
  return ent.map((e) => {
    const hw = e.width / 2;
    const depth = Math.max(s.twowayAisleWidth, s.onewayAisleWidth);
    const t = e.tangent;
    return [
      { x: e.point.x + t.x * hw, y: e.point.y + t.y * hw },
      { x: e.point.x - t.x * hw, y: e.point.y - t.y * hw },
      { x: e.point.x - t.x * hw + e.inward.x * depth, y: e.point.y - t.y * hw + e.inward.y * depth },
      { x: e.point.x + t.x * hw + e.inward.x * depth, y: e.point.y + t.y * hw + e.inward.y * depth },
    ];
  });
}

/** 枠の配置可否（敷地・離隔・障害物・出入口・既存ブロッカー） */
function stallFits(corners: Vec2[], ctx: Ctx, siteL: Vec2[], obsL: Vec2[][], zonesL: Vec2[][], extra: Vec2[][] = []): boolean {
  if (!polygonInsidePolygon(corners, siteL, 1e-6)) return false;
  const m = ctx.s.boundaryMargin;
  if (m > 0 && corners.some((p) => distanceToBoundary(p, siteL) < m - 1e-9)) return false;
  for (const o of obsL) if (convexPolygonsOverlap(corners, o, 1e-6) || convexOverlapsPolygon(corners, o, 1e-6)) return false;
  for (const z of zonesL) if (convexPolygonsOverlap(corners, z, 1e-6)) return false;
  for (const x of extra) if (convexPolygonsOverlap(corners, x, 1e-4)) return false;
  return true;
}

/**
 * 帯状配置（ローカル座標：列方向=+X）。blockers は既存の枠・通路（2方向ゾーン用）
 */
/** 横断通路の位置指定：'e' = 出入口の正面、数値 = 敷地の列方向範囲に対する割合（0〜1） */
export type CrossSpec = ('e' | number)[];

/**
 * align: 数値なら全列で枠の並び位置を揃える（列の揃いを優先）、undefined なら列ごとに台数最大の位置を選ぶ
 */
function stripLayout(ctx: Ctx, orientation: number, stallAngle: number, vOffset: number, crossAt: CrossSpec, blockers: Vec2[][] = [], align?: number): { stalls: WStall[]; aisles: Aisle[] } {
  const { st, s } = ctx;
  const theta = rad(orientation);
  const toL = (p: Vec2): Vec2 => rotate(p, -theta);
  const toW = (p: Vec2): Vec2 => rotate(p, theta);
  const siteL = ctx.site.map(toL);
  const obsL = ctx.obstacles.map((o) => o.map(toL));
  const zonesL = ctx.zones.map((z) => z.map(toL));
  const blkL = blockers.map((b) => b.map(toL));
  const entL = ctx.entrances.map((e) => ({ point: toL(e.point), width: e.width }));
  const a = rad(stallAngle);
  const sinA = Math.sin(a);
  const cosA = Math.cos(a);
  const angled = stallAngle < 89.5;
  const A = angled ? s.onewayAisleWidth : s.twowayAisleWidth;
  const D = st.depth * sinA + st.width * cosA;
  const pitch = (st.width + s.gap) / sinA;
  const b = bbox(siteL);
  const period = 2 * D + A;
  const stalls: WStall[] = [];
  const aisles: Aisle[] = [];

  // 横断通路の帯（列を貫いて各通路を連結する）
  const cw = Math.max(A, 2 * ctx.clearance + 0.6);
  const crossBands: [number, number][] = [];
  for (const c of crossAt) {
    if (c === 'e') for (const e of entL) crossBands.push([e.point.x - Math.max(cw, e.width) / 2, e.point.x + Math.max(cw, e.width) / 2]);
    else {
      const x = b.minX + cw / 2 + (b.maxX - b.minX - cw) * c;
      crossBands.push([x - cw / 2, x + cw / 2]);
    }
  }

  let rowSeq = 0;
  const tryRow = (vEdge: number, side: 'below' | 'above'): WStall[] => {
    const beta = side === 'below' ? -a : a;
    const angDeg = deg(beta) - 90;
    const dirInto = { x: Math.cos(beta), y: Math.sin(beta) };
    const proto = rectCorners({ cx: 0, cy: 0, w: st.width, h: st.depth, angle: angDeg });
    const edgeV = side === 'below' ? Math.max(...proto.map((p) => p.y)) : Math.min(...proto.map((p) => p.y));
    const cy = vEdge - edgeV;
    const hu = (Math.max(...proto.map((p) => p.x)) - Math.min(...proto.map((p) => p.x))) / 2;
    const aisleDir = side === 'below' ? 1 : -1;
    const rowId = `${orientation}:${stallAngle}:${rowSeq++}`;
    // 列ごとに並び位置を最適化（区間ごとに左端合わせ＋均等サンプル）
    const starts = new Set<number>();
    if (align !== undefined) starts.add(b.minX + hu + align * pitch - pitch);
    else {
      for (let k = 0; k < 6; k++) starts.add(b.minX + hu + (k / 6) * pitch - pitch);
      for (const [lo] of horizontalIntervals(siteL, cy)) starts.add(lo + hu - pitch * Math.ceil((lo - b.minX) / pitch + 1));
    }
    let best: WStall[] = [];
    for (const start of starts) {
      const row: WStall[] = [];
      for (let u = start; u <= b.maxX + pitch; u += pitch) {
        const corners = rectCorners({ cx: u, cy, w: st.width, h: st.depth, angle: angDeg });
        const cb = bbox(corners);
        if (cb.maxX < b.minX || cb.minX > b.maxX) continue;
        if (crossBands.some(([l, r]) => cb.maxX > l && cb.minX < r)) continue;
        if (!stallFits(corners, ctx, siteL, obsL, zonesL, blkL)) continue;
        const front = { x: u - dirInto.x * (st.depth / 2), y: cy - dirInto.y * (st.depth / 2) };
        const access = { x: front.x, y: vEdge + aisleDir * Math.min(A / 2, ctx.clearance + 0.2) };
        if (!pointInPolygon(access, siteL)) continue;
        if (obsL.some((o) => pointInPolygon(access, o)) || blkL.some((o) => pointInPolygon(access, o))) continue;
        const c = toW({ x: u, y: cy });
        row.push({ id: '', typeId: st.id, cx: c.x, cy: c.y, width: st.width, depth: st.depth, angle: angDeg + orientation, access: toW(access), front: toW(front), row: rowId });
      }
      if (row.length > best.length) best = row;
    }
    return best;
  };

  const pushAisle = (y0: number, y1: number, servedU: number[]): void => {
    for (const [l, r] of bandIntervals(siteL, y0, y1)) {
      const us = servedU.filter((u) => u >= l - 0.01 && u <= r + 0.01);
      if (!us.length) continue;
      let lo = Math.max(l, Math.min(...us) - pitch / 2 - 0.5);
      let hi = Math.min(r, Math.max(...us) + pitch / 2 + 0.5);
      // 出入口がこの帯の延長上にあれば通路を出入口まで伸ばす
      for (const e of entL) if (e.point.y >= y0 - 0.5 && e.point.y <= y1 + 0.5 && e.point.x >= l && e.point.x <= r) {
        lo = Math.min(lo, Math.max(l, e.point.x - e.width / 2));
        hi = Math.max(hi, Math.min(r, e.point.x + e.width / 2));
      }
      if (hi - lo < 0.5) continue;
      const c = toW({ x: (lo + hi) / 2, y: (y0 + y1) / 2 });
      aisles.push({ id: '', kind: angled ? 'oneway' : 'twoway', cx: c.x, cy: c.y, w: hi - lo, h: y1 - y0, angle: orientation, direction: 1, stallAngle });
    }
  };

  for (let v0 = b.minY + vOffset - period; v0 < b.maxY + period; v0 += period) {
    const vA0 = v0 + D;
    const vA1 = vA0 + A;
    const below = tryRow(vA0, 'below');
    const above = tryRow(vA1, 'above');
    if (below.length + above.length) {
      stalls.push(...below, ...above);
      pushAisle(vA0, vA1, [...below, ...above].map((x) => toL(x.access).x));
    }
  }
  // 横断通路（出入口から列に直交して敷地を貫く）
  if (crossBands.length) {
    for (const [l, r] of crossBands) {
      // 縦方向の区間：回転して同じ関数を使う
      const rot90 = (p: Vec2): Vec2 => ({ x: p.y, y: -p.x });
      const siteR = siteL.map(rot90);
      for (const [lo, hi] of bandIntervals(siteR, -r, -l)) {
        if (hi - lo < 1) continue;
        // siteR の x = siteL の y
        const c = toW({ x: (l + r) / 2, y: (lo + hi) / 2 });
        aisles.push({ id: '', kind: angled ? 'oneway' : 'twoway', cx: c.x, cy: c.y, w: hi - lo, h: r - l, angle: orientation + 90, direction: 1 });
      }
    }
  }
  return { stalls, aisles };
}

const stallPoly = (x: Stall): Vec2[] => rectCorners({ cx: x.cx, cy: x.cy, w: x.width, h: x.depth, angle: x.angle });

/** 外周充填：各辺に背を向けた 90°枠を追加（ワールド座標） */
function perimeterInfill(ctx: Ctx, base: Layout): Layout {
  const { st, s, site } = ctx;
  const ccw = isCCW(site);
  const existing = [...base.stalls.map(stallPoly), ...base.aisles.map((a) => rectCorners(a))];
  const added: WStall[] = [];
  const edges = site.map((p, i) => ({ i, a: p, b: site[(i + 1) % site.length], L: dist(p, site[(i + 1) % site.length]) })).sort((x, y) => y.L - x.L);
  for (const e of edges) {
    if (e.L < st.width) continue;
    const t = { x: (e.b.x - e.a.x) / e.L, y: (e.b.y - e.a.y) / e.L };
    const n = ccw ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
    const angDeg = deg(Math.atan2(n.x, -n.y)); // 奥行き方向（背）= −n
    const pitch = st.width + s.gap;
    let best: WStall[] = [];
    for (const k of [0, 0.25, 0.5, 0.75]) {
      const row: WStall[] = [];
      const blockers = [...existing, ...added.map(stallPoly)];
      for (let pos = k * pitch; pos + st.width <= e.L + 1e-9; pos += pitch) {
        const c = { x: e.a.x + t.x * (pos + st.width / 2) + n.x * (s.boundaryMargin + st.depth / 2 + 0.001), y: e.a.y + t.y * (pos + st.width / 2) + n.y * (s.boundaryMargin + st.depth / 2 + 0.001) };
        const corners = rectCorners({ cx: c.x, cy: c.y, w: st.width, h: st.depth, angle: angDeg });
        if (!stallFits(corners, ctx, site, ctx.obstacles, ctx.zones, [...blockers, ...row.map(stallPoly)])) continue;
        const front = { x: c.x + n.x * (st.depth / 2), y: c.y + n.y * (st.depth / 2) };
        const access = { x: front.x + n.x * (ctx.clearance + 0.2), y: front.y + n.y * (ctx.clearance + 0.2) };
        if (!pointInPolygon(access, site)) continue;
        if ([...ctx.obstacles, ...blockers].some((o) => pointInPolygon(access, o))) continue;
        row.push({ id: '', typeId: st.id, cx: c.x, cy: c.y, width: st.width, depth: st.depth, angle: angDeg, access, front, row: `edge${e.i}` });
      }
      if (row.length > best.length) best = row;
    }
    added.push(...best);
  }
  if (!added.length) return base;
  return { ...base, stalls: [...base.stalls, ...added], strategy: [...base.strategy, `外周充填+${added.length}台`] };
}

/**
 * 外周配置（変形地向け）：敷地の各辺に沿って背を向けた枠列 → その内側に周回通路 → 中央部に帯状配置。
 * 中央部の通路は両端が周回通路へ抜けるため行き止まりになりにくい。
 */
function ringLayout(ctx: Ctx, coreOrientation: number, coreOffset: number): Layout | null {
  const { st, s } = ctx;
  const A = s.twowayAisleWidth;
  const empty: Layout = { orientation: coreOrientation, stallAngle: 90, stalls: [], aisles: [], strategy: [], aisleWidth: A, turnaround: false };
  const per = perimeterInfill(ctx, empty);
  const ringStalls = per.stalls;
  const core = offsetPolygonInward(ctx.site, s.boundaryMargin + st.depth + A);
  let coreStalls: WStall[] = [];
  let coreAisles: Aisle[] = [];
  if (core) {
    const coreCtx: Ctx = { ...ctx, site: core, s: { ...s, boundaryMargin: 0 } };
    const g = stripLayout(coreCtx, coreOrientation, 90, coreOffset, [], ringStalls.map(stallPoly));
    // 中央の枠は敷地本体の制約（障害物・出入口）も満たすこと
    coreStalls = g.stalls.filter((x) => stallFits(stallPoly(x), ctx, ctx.site, ctx.obstacles, ctx.zones, ringStalls.map(stallPoly)));
    coreAisles = g.aisles;
  }
  // 周回通路：各辺から枠の奥行きだけ内側の帯（描画用。辺ごとの矩形）
  const ring: Aisle[] = [];
  const inner = offsetPolygonInward(ctx.site, s.boundaryMargin + st.depth);
  if (inner) {
    const n = inner.length;
    for (let i = 0; i < n; i++) {
      const a = inner[i];
      const b = inner[(i + 1) % n];
      const L = dist(a, b);
      if (L < A) continue;
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const nrm = isCCW(ctx.site) ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
      const len = L - A;
      if (len < 2) continue;
      const c = { x: (a.x + b.x) / 2 + nrm.x * (A / 2), y: (a.y + b.y) / 2 + nrm.y * (A / 2) };
      const rect = { id: '', kind: 'twoway' as const, cx: c.x, cy: c.y, w: len, h: A, angle: deg(Math.atan2(t.y, t.x)), direction: 1 as const };
      const allStalls = [...ringStalls, ...coreStalls].map(stallPoly);
      if (polygonInsidePolygon(rectCorners(rect), ctx.site, 1e-3) && !allStalls.some((p) => convexPolygonsOverlap(rectCorners(rect), p, 1e-3))) ring.push(rect);
    }
  }
  const stalls = [...ringStalls, ...coreStalls];
  if (!stalls.length) return null;
  return { orientation: coreOrientation, stallAngle: 90, stalls, aisles: [...ring, ...coreAisles], strategy: [coreStalls.length ? '外周配置＋周回通路＋中央帯状配置' : '外周配置＋周回通路'], aisleWidth: A, turnaround: false };
}

/** 到達できない枠を除外（除外で空いた空間を考慮して反復） */
function pruneUnreachable(ctx: Ctx, grid: Grid, layout: Layout): { layout: Layout; removed: number; reach: ReachResult | null } {
  if (!ctx.entrances.length) return { layout, removed: 0, reach: null };
  let cur = layout;
  let removed = 0;
  let reach: ReachResult | null = null;
  for (let iter = 0; iter < 4; iter++) {
    reach = analyzeReachability(grid, cur.stalls.map(stallPoly), ctx.entrances, ctx.clearance);
    const keep = cur.stalls.filter((x) => reach!.reachable(x.access));
    if (keep.length === cur.stalls.length) break;
    removed += cur.stalls.length - keep.length;
    cur = { ...cur, stalls: keep };
  }
  return { layout: cur, removed, reach };
}

/** 通路の端が行き止まりか（端の先に車両が通れる空きがない） */
function deadEndInfo(ctx: Ctx, layout: Layout, reach: ReachResult | null): { aisle: Aisle; end: Vec2; dir: Vec2 }[] {
  const out: { aisle: Aisle; end: Vec2; dir: Vec2 }[] = [];
  const blockers = layout.stalls.map(stallPoly);
  for (const a of layout.aisles) {
    if (a.kind === 'pedestrian') continue;
    const th = rad(a.angle);
    const dir = { x: Math.cos(th), y: Math.sin(th) };
    // 枠が面していない通路（横断通路など）は対象外
    const served = layout.stalls.filter((x) => pointInPolygon(x.access, rectCorners({ ...a, w: a.w + 0.2, h: a.h + 0.2 })));
    if (!served.length) continue;
    for (const sg of [-1, 1]) {
      const end = { x: a.cx + dir.x * sg * (a.w / 2), y: a.cy + dir.y * sg * (a.w / 2) };
      const probe = { x: end.x + dir.x * sg * (ctx.clearance + 0.6), y: end.y + dir.y * sg * (ctx.clearance + 0.6) };
      let open = pointInPolygon(probe, ctx.site) && !blockers.some((p) => pointInPolygon(probe, p)) && !ctx.obstacles.some((p) => pointInPolygon(probe, p));
      if (open && reach) open = reach.clearanceAt(probe) >= ctx.clearance * 0.9;
      // 出入口に直結している端は行き止まりではない
      if (!open && ctx.entrances.some((e) => dist(e.point, end) < e.width / 2 + ctx.clearance + 1)) open = true;
      if (!open) out.push({ aisle: a, end, dir: { x: dir.x * sg, y: dir.y * sg } });
    }
  }
  return out;
}

/** 行き止まり端に転回広場（ハンマーヘッド）を設ける：端から車長分の範囲で片側の枠を外す */
function addTurnarounds(ctx: Ctx, layout: Layout, ends: ReturnType<typeof deadEndInfo>): Layout {
  if (!ends.length) return layout;
  const v = ctx.s.vehicle;
  const reach = v.length + 0.8;
  const remove = new Set<WStall>();
  for (const e of ends) {
    const nrm = { x: -e.dir.y, y: e.dir.x };
    const near = layout.stalls.filter((x) => {
      const d = sub(x.access, e.end);
      const along = -(d.x * e.dir.x + d.y * e.dir.y);
      const across = Math.abs(d.x * nrm.x + d.y * nrm.y);
      return along >= -0.5 && along <= reach && across <= e.aisle.h / 2 + 0.5;
    });
    // 片側（枠数の少ない側）を外す
    const sideOf = (x: WStall): number => Math.sign((x.access.x - e.end.x) * nrm.x + (x.access.y - e.end.y) * nrm.y) || 1;
    const left = near.filter((x) => sideOf(x) > 0);
    const right = near.filter((x) => sideOf(x) < 0);
    const pick = left.length && (left.length <= right.length || !right.length) ? left : right;
    pick.forEach((x) => remove.add(x));
  }
  if (!remove.size) return layout;
  return { ...layout, stalls: layout.stalls.filter((x) => !remove.has(x)), turnaround: true, strategy: [...layout.strategy, `転回広場${ends.length}箇所`] };
}

function evaluate(ctx: Ctx, layout: Layout, siteArea: number, reach: ReachResult | null, unreachable: number): Evaluated {
  const { s } = ctx;
  const count = layout.stalls.length;
  const stallArea = layout.stalls.reduce((acc, x) => acc + x.width * x.depth, 0);
  const aisleArea = Math.min(siteArea - stallArea, layout.aisles.reduce((acc, x) => acc + x.w * x.h, 0));
  const rows = new Map<string, number>();
  layout.stalls.forEach((x) => rows.set(x.row, (rows.get(x.row) ?? 0) + 1));
  const alignment = count ? [...rows.values()].filter((c) => c >= 3).reduce((a, c) => a + c, 0) / count : 0;
  const b = bbox(ctx.site);
  const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  const dists = reach ? layout.stalls.map((x) => reach.pathDistance(x.access)).filter(Number.isFinite) : [];
  const meanDist = dists.length ? dists.reduce((a, d) => a + d, 0) / dists.length : diag;
  let accessibility = Math.max(0, 1 - meanDist / (1.5 * diag));
  const issues: PlanIssue[] = [];
  const A = layout.aisleWidth;
  const req = requiredAisleWidth(layout.stallAngle, s.vehicle);
  const sw = sweptPath(s.vehicle);
  if (A + 1e-6 < sw.width) {
    issues.push({ level: 'error', code: 'aisle-swept', message: `通路幅${A.toFixed(2)}mは車両の旋回軌跡幅${sw.width.toFixed(2)}mより狭く、通行できません。` });
    accessibility *= 0.5;
  } else if (A + 1e-6 < req) {
    issues.push({ level: 'warning', code: 'aisle-narrow', message: `通路幅${A.toFixed(2)}m：${layout.stallAngle}°駐車の必要幅${req.toFixed(2)}m（簡易判定・最小回転半径${s.vehicle.minTurningRadius}m）に不足。切り返しが必要になります。` });
    accessibility *= 0.85;
  } else {
    issues.push({ level: 'info', code: 'aisle-ok', message: `通路幅${A.toFixed(2)}m：${layout.stallAngle}°駐車の必要幅${req.toFixed(2)}mを満たします。` });
  }
  const ends = deadEndInfo(ctx, layout, reach);
  const deadEnds = ends.length;
  if (deadEnds) {
    const oneway = ends.some((e) => e.aisle.kind === 'oneway');
    if (oneway) issues.push({ level: 'error', code: 'oneway-deadend', message: `一方通行通路の行き止まりが${deadEnds}箇所あります。周回動線が成立しません。` });
    else if (layout.turnaround) issues.push({ level: 'info', code: 'deadend-turn', message: `行き止まり通路${deadEnds}箇所に転回広場を確保しています。` });
    else issues.push({ level: 'warning', code: 'deadend', message: `行き止まり通路が${deadEnds}箇所あります。最奥の枠では後退出庫・切り返しが必要です（転回広場案と比較してください）。` });
  }
  for (const e of ctx.entrances) {
    if (e.width + 1e-6 < sw.width + 0.5) issues.push({ level: 'warning', code: 'entrance-narrow', message: `出入口幅${e.width.toFixed(2)}mは旋回軌跡幅＋余裕（${(sw.width + 0.5).toFixed(2)}m）に不足しています。` });
  }
  if (!ctx.entrances.length) issues.push({ level: 'warning', code: 'no-entrance', message: '出入口が未設定のため、車両の到達性を検証していません。' });
  if (unreachable) issues.push({ level: 'info', code: 'unreachable', message: `出入口から旋回軌跡幅（${(ctx.clearance * 2).toFixed(2)}m）を確保して到達できない枠${unreachable}台を除外しました。` });
  if (layout.stallAngle < 89.5) issues.push({ level: 'info', code: 'oneway', message: '斜め駐車は一方通行の周回動線が前提です。進行方向矢印を確認してください。' });
  const utilization = stallArea / siteArea;
  // デッドスペース＝枠でも、出入口から車両が実際に通れる通行領域でもない面積（到達性解析に基づく）
  const circulation = reach ? reach.circulationArea : Math.max(0, aisleArea);
  const deadSpaceRatio = Math.min(1, Math.max(0, 1 - (stallArea + circulation) / siteArea));
  if (deadSpaceRatio > 0.3) issues.push({ level: 'warning', code: 'deadspace', message: `デッドスペースが${(deadSpaceRatio * 100).toFixed(0)}%あります。` });
  const ease = (alignment + accessibility + (1 - deadSpaceRatio)) / 3;
  let score = count * (0.88 + 0.12 * ease);
  if (issues.some((i) => i.code === 'oneway-deadend' || i.code === 'aisle-swept')) score -= Math.max(2, count * 0.15);
  if (deadEnds && !layout.turnaround) score -= 0.4 * deadEnds;
  return { layout, metrics: { count, stallArea, aisleArea: Math.max(0, reach ? reach.circulationArea : aisleArea), siteArea, utilization, deadSpaceRatio, alignment, accessibility, score }, issues, deadEnds, unreachable };
}

function makeCtx(input: OptimizeInput): Ctx {
  const ents = input.entrances.map((e) => ({ ...entranceGeometry(input.site, e), width: e.width }));
  const s = input.settings;
  const angles = s.angles.length ? s.angles : [90];
  const minAisle = Math.min(...angles.map((a) => (a < 89.5 ? s.onewayAisleWidth : s.twowayAisleWidth)));
  return {
    site: input.site,
    st: input.stallType,
    s,
    obstacles: input.obstacles.map(obstaclePolygon),
    entrances: ents,
    zones: entranceZones(ents, s),
    clearance: routeClearance(s.vehicle, minAisle),
  };
}

export async function optimizeParkingDetailed(input: OptimizeInput, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  const t0 = Date.now();
  const { site, stallType: st, settings: s } = input;
  const bounds = upperBounds(site, input.obstacles, st, s);
  if (site.length < 3) return { plans: [], bounds, angleSummary: [], stats: { candidates: 0, refined: 0, ms: 0 } };
  const ctx = makeCtx(input);
  const siteArea = polygonArea(site);
  const convex = isConvex(site);

  const orientSet = new Set<number>();
  const edgeDirs: number[] = [];
  site.forEach((p, i) => {
    const q = site[(i + 1) % site.length];
    const o = Math.round((((deg(Math.atan2(q.y - p.y, q.x - p.x)) % 180) + 180) % 180) * 10) / 10;
    edgeDirs.push(o);
  });
  if (input.fixedOrientations?.length) input.fixedOrientations.forEach((o) => orientSet.add(((Math.round(o * 10) / 10) % 180 + 180) % 180));
  else {
    edgeDirs.forEach((o) => {
      orientSet.add(o);
      orientSet.add((o + 90) % 180);
    });
    for (let o = 0; o < 180; o += Math.max(5, s.orientationStepDeg)) orientSet.add(o);
  }
  const orientations = [...orientSet];
  const angles = [...new Set(s.angles.filter((a) => a >= 20 && a <= 90))];
  if (!angles.length) angles.push(90);
  const vSteps = 4;
  const crossOptions: CrossSpec[] = ctx.entrances.length
    ? [[], ['e'], [0.5], [0], [1], ['e', 0], ['e', 1], [0, 1]]
    : [[], [0.5], [0], [1], [0, 1]];
  const crossName = (c: CrossSpec): string => (c.length ? `横断通路(${c.map((x) => (x === 'e' ? '出入口' : x === 0 ? '始端' : x === 1 ? '終端' : '中央')).join('+')})` : '帯状配置');
  const total = orientations.length * angles.length * (vSteps + ctx.entrances.length + 1) * crossOptions.length;
  const yieldEvery = opts.yieldEvery ?? 20;

  // ---- 1. 主配置の粗探索 ----
  const raws: Layout[] = [];
  let done = 0;
  let bestRaw = 0;
  for (const orientation of orientations) {
    const theta = rad(orientation);
    const bL = bbox(site.map((p) => rotate(p, -theta)));
    for (const stallAngle of angles) {
      const D = st.depth * Math.sin(rad(stallAngle)) + st.width * Math.cos(rad(stallAngle));
      const A = stallAngle < 89.5 ? s.onewayAisleWidth : s.twowayAisleWidth;
      const period = 2 * D + A;
      const offsets = Array.from({ length: vSteps }, (_, vi) => (period * vi) / vSteps);
      for (const e of ctx.entrances) {
        const ey = rotate(e.point, -theta).y;
        offsets.push((((ey - bL.minY - D - A / 2) % period) + period) % period);
      }
      offsets.push((((bL.maxY - bL.minY) % period) + period) % period);
      for (const vOff of offsets) {
        for (const cross of crossOptions) {
          if (opts.signal?.aborted) throw new OptimizeCancelled();
          for (const align of [undefined, 0]) {
            const g = stripLayout(ctx, orientation, stallAngle, vOff, cross, [], align);
            raws.push({ orientation, stallAngle, stalls: g.stalls, aisles: g.aisles, strategy: [crossName(cross) + (align === undefined ? '' : '・列揃え')], aisleWidth: A, turnaround: false });
            bestRaw = Math.max(bestRaw, g.stalls.length);
          }
          done++;
          if (done % yieldEvery === 0) {
            opts.onProgress?.(done, total + 1, bestRaw);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
    }
  }

  // ---- 2a. 到達性による一次選抜（粗いグリッド）----
  // 生の台数だけで選ぶと、通路が孤立して到達できない案が残るため、各（角度×横断通路）の上位を粗く検証する
  const quick = buildBaseGrid(site, ctx.obstacles, 12000);
  const groups = new Map<string, Layout[]>();
  for (const r of raws) {
    if (!r.stalls.length) continue;
    const key = `${r.stallAngle}|${r.strategy[0]}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const screened: { layout: Layout; reachable: number }[] = [];
  let gi = 0;
  for (const g of groups.values()) {
    g.sort((p, q) => q.stalls.length - p.stalls.length);
    const seenG = new Set<string>();
    for (const r of g) {
      const key = `${r.orientation}:${r.stalls.length}`;
      if (seenG.has(key)) continue;
      seenG.add(key);
      if (seenG.size > 4) break;
      if (opts.signal?.aborted) throw new OptimizeCancelled();
      const pr = pruneUnreachable(ctx, quick, r);
      screened.push({ layout: r, reachable: pr.layout.stalls.length });
    }
    if (++gi % 4 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  screened.sort((p, q) => q.reachable - p.reachable || q.layout.stalls.length - p.layout.stalls.length);
  const shortlist: Layout[] = [];
  const perAngle = new Map<number, number>();
  for (const { layout: r } of screened) {
    const k = perAngle.get(r.stallAngle) ?? 0;
    if (k >= 6) continue;
    perAngle.set(r.stallAngle, k + 1);
    shortlist.push(r);
  }

  // ---- 2b. 上位候補の精査 ----
  const coarse = buildBaseGrid(site, ctx.obstacles, 50000);
  const pool: Evaluated[] = [];
  const consider = (layout: Layout): Evaluated => {
    const pr = pruneUnreachable(ctx, coarse, layout);
    const ev = evaluate(ctx, pr.layout, siteArea, pr.reach, pr.removed);
    pool.push(ev);
    return ev;
  };
  let refined = 0;
  for (let i = 0; i < shortlist.length; i++) {
    if (opts.signal?.aborted) throw new OptimizeCancelled();
    const base = shortlist[i];
    const variants: Layout[] = [base, perimeterInfill(ctx, base)];
    // 凹形地・デッドスペースの多い案は別方向ゾーンを重ねる
    if (!convex || base.stalls.length * st.width * st.depth < siteArea * 0.35) {
      const blockers = [...base.stalls.map(stallPoly), ...base.aisles.map((a) => rectCorners(a))];
      const dirs = [...new Set(edgeDirs.map((o) => Math.round(o)))].filter((o) => Math.min(Math.abs(o - base.orientation), 180 - Math.abs(o - base.orientation)) > 10).slice(0, 4);
      for (const o2 of dirs) {
        let bestSec: Layout | null = null;
        const D = st.depth * Math.sin(rad(base.stallAngle)) + st.width * Math.cos(rad(base.stallAngle));
        const period = 2 * D + base.aisleWidth;
        for (const vo of [0, period / 3, (2 * period) / 3]) {
          const g = stripLayout(ctx, o2, base.stallAngle, vo, [], blockers);
          const primaryPolys = base.stalls.map(stallPoly);
          const aisles2 = g.aisles.filter((a) => !primaryPolys.some((p) => convexPolygonsOverlap(rectCorners(a), p, 1e-3)));
          if (g.stalls.length && (!bestSec || g.stalls.length > bestSec.stalls.length)) {
            bestSec = { ...base, stalls: [...base.stalls, ...g.stalls], aisles: [...base.aisles, ...aisles2], strategy: [...base.strategy, `2方向ゾーン(${o2}°)+${g.stalls.length}台`] };
          }
        }
        if (bestSec) {
          variants.push(bestSec);
          variants.push(perimeterInfill(ctx, bestSec));
        }
      }
    }
    for (const v of variants) {
      const ev = consider(v);
      refined++;
      // 行き止まりがあれば転回広場案も評価
      if (ev.deadEnds) {
        const pr = pruneUnreachable(ctx, coarse, ev.layout);
        const ends = deadEndInfo(ctx, pr.layout, pr.reach);
        consider(addTurnarounds(ctx, pr.layout, ends));
      }
    }
    opts.onProgress?.(total, total + 1, Math.max(bestRaw, ...pool.map((e) => e.metrics.count)));
    if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
  }

  // ---- 2c. 外周配置（周回通路）案 ----
  if (angles.includes(90)) {
    const dirs = [...new Set(edgeDirs.map((o) => Math.round(o)))].slice(0, 6);
    const D = st.depth;
    const period = 2 * D + s.twowayAisleWidth;
    for (const o of dirs) {
      for (const off of [0, period / 3, (2 * period) / 3]) {
        if (opts.signal?.aborted) throw new OptimizeCancelled();
        const r = ringLayout(ctx, o, off);
        if (r) {
          const ev = consider(r);
          refined++;
          if (ev.deadEnds) {
            const pr = pruneUnreachable(ctx, coarse, ev.layout);
            consider(addTurnarounds(ctx, pr.layout, deadEndInfo(ctx, pr.layout, pr.reach)));
          }
        }
      }
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  // ---- 3. 案の選定（多様性）と高精度での最終検証 ----
  pool.sort((p, q) => q.metrics.score - p.metrics.score);
  const picks: Evaluated[] = [];
  const maxPlans = opts.maxPlans ?? 6;
  // 同一配置（枠の位置が同じ）の重複を除く
  const signature = (e: Evaluated): string => {
    let sx = 0, sy = 0;
    for (const x of e.layout.stalls) {
      sx += x.cx;
      sy += x.cy;
    }
    return `${e.metrics.count}:${Math.round(sx * 10)}:${Math.round(sy * 10)}`;
  };
  const similar = (p: Evaluated, e: Evaluated): boolean =>
    signature(p) === signature(e) ||
    (p.metrics.count === e.metrics.count && p.layout.stallAngle === e.layout.stallAngle && Math.abs(p.layout.orientation - e.layout.orientation) < 1 && p.layout.turnaround === e.layout.turnaround);
  const pushUnique = (e: Evaluated | undefined): void => {
    if (!e || !e.metrics.count || picks.length >= maxPlans) return;
    if (picks.some((p) => p === e || similar(p, e))) return;
    picks.push(e);
  };
  pushUnique(pool[0]);
  pushUnique([...pool].sort((p, q) => q.metrics.count - p.metrics.count || q.metrics.score - p.metrics.score)[0]);
  for (const ang of angles) pushUnique(pool.find((e) => e.layout.stallAngle === ang));
  pushUnique(pool.find((e) => e.layout.turnaround));
  pushUnique(pool.find((e) => e.layout.strategy.some((x) => x.startsWith('2方向'))));
  pushUnique(pool.find((e) => e.layout.strategy.some((x) => x.startsWith('外周配置'))));
  for (const e of pool) pushUnique(e);

  const fine = buildBaseGrid(site, ctx.obstacles, 160000);
  const finals = picks.map((e) => {
    const pr = pruneUnreachable(ctx, fine, e.layout);
    const ev = evaluate(ctx, pr.layout, siteArea, pr.reach, e.unreachable + pr.removed);
    // 最終の干渉検証（構成上起きないはずだが、起きたら問題として表示）
    const rep = checkInterference(site, ev.layout.stalls, input.obstacles, ev.layout.aisles, s, ev.layout.stallAngle, input.entrances);
    if (!rep.ok) ev.issues.unshift({ level: 'error', code: 'interference', message: `干渉があります（はみ出し${rep.outOfSite.length}・重なり${rep.overlapping.length}・障害物${rep.obstacleHits.length}・通路${rep.aisleHits.length}・出入口${rep.entranceBlocked.length}・通路はみ出し${rep.aislesOutOfSite.length}）。` });
    return ev;
  });
  finals.sort((p, q) => q.metrics.score - p.metrics.score);

  const plans = finals.map((e, i): LayoutPlan => {
    const c = e.metrics.count;
    const optimality: Optimality = c >= bounds.areaBound ? 'proven' : c >= bounds.accessBound ? 'model-proven' : 'heuristic';
    const issues = [...e.issues];
    issues.push(
      optimality === 'proven'
        ? { level: 'info', code: 'optimal', message: `台数${c}台は面積上限に一致：数学的に最大と証明されています。` }
        : optimality === 'model-proven'
          ? { level: 'info', code: 'optimal-model', message: `台数${c}台は通路考慮上限に一致：前提条件の下で最大と証明されています。` }
          : { level: 'info', code: 'heuristic', message: `探索による最良案です（通路考慮上限${bounds.accessBound}台まで最大${bounds.accessBound - c}台の差。上限に達する配置が存在するとは限りません）。` },
    );
    const widths = [...new Set(e.layout.aisles.filter((a) => a.kind !== 'pedestrian').map((a) => Math.round(a.h * 100) / 100))].sort((x, y) => y - x);
    return {
      id: nid('plan'),
      name: `${String.fromCharCode(65 + i)}案`,
      stallAngle: e.layout.stallAngle,
      orientation: e.layout.orientation,
      aisleKind: e.layout.stallAngle < 89.5 ? 'oneway' : 'twoway',
      aisleWidths: widths.length ? widths : [e.layout.aisleWidth],
      stalls: e.layout.stalls.map(({ access: _a, row: _r, front: _f, ...x }) => ({ ...x, id: nid('s') })),
      aisles: e.layout.aisles.map((x) => ({ ...x, id: nid('a') })),
      metrics: e.metrics,
      issues,
      warnings: issues.filter((x) => x.level !== 'info').map((x) => x.message),
      strategy: e.layout.strategy,
      deadEnds: e.deadEnds,
      turnaround: e.layout.turnaround,
      bounds,
      optimality,
      provenOptimal: optimality !== 'heuristic',
    };
  });

  const angleSummary: AngleSummary[] = angles
    .map((a) => {
      const best = pool.filter((e) => e.layout.stallAngle === a).sort((p, q) => q.metrics.count - p.metrics.count)[0];
      const plan = plans.find((p) => p.stallAngle === a && p.metrics.count === best?.metrics.count);
      return { angle: a, bestCount: best?.metrics.count ?? 0, aisleWidth: a < 89.5 ? s.onewayAisleWidth : s.twowayAisleWidth, requiredAisle: requiredAisleWidth(a, s.vehicle), planName: plan?.name };
    })
    .sort((p, q) => q.angle - p.angle);

  opts.onProgress?.(total + 1, total + 1, plans[0]?.metrics.count ?? 0);
  return { plans, bounds, angleSummary, stats: { candidates: raws.length, refined, ms: Date.now() - t0 } };
}

/** 互換API：配置案のみ返す */
export async function optimizeParking(input: OptimizeInput, opts: OptimizeOptions = {}): Promise<LayoutPlan[]> {
  return (await optimizeParkingDetailed(input, opts)).plans;
}

/** 互換API：通路考慮上限 */
export function theoreticalUpperBound(siteArea: number, st: StallType, aisleWidth: number): number {
  return Math.floor(siteArea / (st.width * (st.depth + aisleWidth / 2)) + 1e-9);
}

export { sub };
