// 干渉判定・通路幅検証（駐車場最適化・手動編集で共通利用）
import type { Aisle, Entrance, Obstacle, ParkingSettings, RectShape, Stall, Vec2 } from '@/types';
import {
  convexOverlapsPolygon,
  convexPolygonsOverlap,
  distanceToBoundary,
  polygonInsidePolygon,
  pointSegmentDistance,
  rectCorners,
  signedArea,
} from '@/engine/geometry/polygon';

export const stallRect = (s: Stall): RectShape => ({ cx: s.cx, cy: s.cy, w: s.width, h: s.depth, angle: s.angle });
export const stallCorners = (s: Stall): Vec2[] => rectCorners(stallRect(s));

/** 障害物のうち駐車不可として扱う範囲（すべての種類が対象） */
export const obstaclePolygon = (o: Obstacle): Vec2[] => rectCorners(o);

export { requiredAisleWidth, sweptPath } from './turning';
import { requiredAisleWidth, sweptPath } from './turning';

export interface InterferenceReport {
  outOfSite: string[];
  overlapping: [string, string][];
  obstacleHits: { stallId: string; obstacleId: string }[];
  aisleHits: { stallId: string; aisleId: string }[];
  /** 必要幅に満たない通路（required は旋回軌跡幅と、面する枠の角度による必要幅の大きい方） */
  narrowAisles: { aisleId: string; width: number; required: number; stallAngle?: number }[];
  /** 敷地からはみ出した通路 */
  aislesOutOfSite: string[];
  /** 出入口の前（車両の進入に必要な範囲）をふさぐ枠 */
  entranceBlocked: string[];
  ok: boolean;
}

export function checkInterference(
  site: Vec2[],
  stalls: Stall[],
  obstacles: Obstacle[],
  aisles: Aisle[],
  settings: Pick<ParkingSettings, 'boundaryMargin' | 'vehicle'> & Partial<Pick<ParkingSettings, 'onewayAisleWidth' | 'twowayAisleWidth'>>,
  /** 通路の駐車角度が通路にも周辺の枠からも分からない場合に使う既定角度（未指定なら旋回軌跡幅のみで判定） */
  defaultStallAngle?: number,
  entrances: Entrance[] = [],
): InterferenceReport {
  const outOfSite: string[] = [];
  const overlapping: [string, string][] = [];
  const obstacleHits: { stallId: string; obstacleId: string }[] = [];
  const aisleHits: { stallId: string; aisleId: string }[] = [];
  const corners = stalls.map(stallCorners);
  const obsPolys = obstacles.map(obstaclePolygon);
  const aislePolys = aisles.map((a) => rectCorners(a));
  // 境界との離隔：枠の隅→境界 と 境界の頂点（凹部の入隅）→枠の辺 の両方を確認
  const margin = settings.boundaryMargin;
  const marginOk = (c: Vec2[]): boolean => {
    if (margin <= 0) return true;
    if (c.some((p) => distanceToBoundary(p, site) < margin - 1e-6)) return false;
    for (const q of site) for (let k = 0; k < c.length; k++) if (pointSegmentDistance(q, c[k], c[(k + 1) % c.length]) < margin - 1e-6) return false;
    return true;
  };
  // 外接矩形で候補を絞ってから厳密判定（スイープ法：台数が多くても高速）
  const boxes = corners.map((c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of c) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  });
  const order = stalls.map((_, i) => i).sort((a, b) => boxes[a].x0 - boxes[b].x0);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (boxes[j].x0 > boxes[i].x1) break;
      if (boxes[j].y0 > boxes[i].y1 || boxes[j].y1 < boxes[i].y0) continue;
      if (convexPolygonsOverlap(corners[i], corners[j], 1e-4)) overlapping.push(i < j ? [stalls[i].id, stalls[j].id] : [stalls[j].id, stalls[i].id]);
    }
  }
  const boxOf = (c: Vec2[]): { x0: number; y0: number; x1: number; y1: number } => ({ x0: Math.min(...c.map((p) => p.x)), y0: Math.min(...c.map((p) => p.y)), x1: Math.max(...c.map((p) => p.x)), y1: Math.max(...c.map((p) => p.y)) });
  const obsBoxes = obsPolys.map(boxOf);
  const aisleBoxes = aislePolys.map(boxOf);
  const hitBox = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  stalls.forEach((s, i) => {
    const c = corners[i];
    const inside = site.length >= 3 && polygonInsidePolygon(c, site, 1e-6);
    if (!inside || !marginOk(c)) outOfSite.push(s.id);
    obsPolys.forEach((op, k) => {
      if (hitBox(boxes[i], obsBoxes[k]) && convexPolygonsOverlap(c, op, 1e-4)) obstacleHits.push({ stallId: s.id, obstacleId: obstacles[k].id });
    });
    aislePolys.forEach((ap, k) => {
      if (aisles[k].kind !== 'pedestrian' && hitBox(boxes[i], aisleBoxes[k]) && convexPolygonsOverlap(c, ap, 1e-3)) aisleHits.push({ stallId: s.id, aisleId: aisles[k].id });
    });
  });
  overlapping.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  // 通路幅：通路ごとに、面している枠の駐車角度から必要幅を求める（斜め駐車の通路を90°基準で誤判定しない）
  const sw = sweptPath(settings.vehicle).width;
  const narrowAisles = aisles
    .filter((a) => a.kind !== 'pedestrian')
    .map((a) => {
      const width = a.h; // 通路矩形：w=長さ、h=幅員
      let served = a.stallAngle !== undefined ? [a.stallAngle] : servedStallAngles(a, stalls);
      if (!served.length && defaultStallAngle !== undefined) served = [defaultStallAngle];
      const reqAngle = served.length ? Math.max(...served) : null;
      const required = Math.max(sw, reqAngle === null ? 0 : requiredAisleWidth(reqAngle, settings.vehicle));
      return { aisleId: a.id, width, required, stallAngle: reqAngle ?? undefined };
    })
    .filter((x) => x.width + 1e-6 < x.required);
  const aislesOutOfSite = site.length >= 3 ? aisles.filter((a) => !polygonInsidePolygon(rectCorners(a), site, 1e-3)).map((a) => a.id) : [];
  const entranceBlocked: string[] = [];
  if (site.length >= 3 && entrances.length) {
    const ccw = signedArea(site) > 0;
    const depth = Math.max(settings.twowayAisleWidth ?? 5.5, settings.onewayAisleWidth ?? 3.5);
    for (const e of entrances) {
      const n = site.length;
      const a = site[((e.edgeIndex % n) + n) % n];
      const b = site[(e.edgeIndex + 1) % n];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const inw = ccw ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
      const p = { x: a.x + (b.x - a.x) * e.t, y: a.y + (b.y - a.y) * e.t };
      const hw = e.width / 2;
      const zone = [
        { x: p.x - t.x * hw, y: p.y - t.y * hw },
        { x: p.x + t.x * hw, y: p.y + t.y * hw },
        { x: p.x + t.x * hw + inw.x * depth, y: p.y + t.y * hw + inw.y * depth },
        { x: p.x - t.x * hw + inw.x * depth, y: p.y - t.y * hw + inw.y * depth },
      ];
      stalls.forEach((st, i) => {
        if (convexPolygonsOverlap(corners[i], zone, 1e-4) && !entranceBlocked.includes(st.id)) entranceBlocked.push(st.id);
      });
    }
  }
  return {
    outOfSite,
    overlapping,
    obstacleHits,
    aisleHits,
    narrowAisles,
    aislesOutOfSite,
    entranceBlocked,
    ok: !outOfSite.length && !overlapping.length && !obstacleHits.length && !aisleHits.length && !aislesOutOfSite.length && !entranceBlocked.length,
  };
}

export { convexOverlapsPolygon };

/**
 * 通路に面している枠の駐車角度（度、0〜90）。
 * 枠の手前側（入庫口）が通路の中（幅方向に少し広げた範囲）にある枠を「面している」とみなし、
 * 枠の奥行き方向と通路の進行方向のなす角を駐車角度とする。
 */
export function servedStallAngles(a: Aisle, stalls: Stall[]): number[] {
  // 通路を幅方向に片側0.3m広げた帯と重なる枠を「通路に面している」とみなす
  const zone = rectCorners({ cx: a.cx, cy: a.cy, w: a.w, h: a.h + 0.6, angle: a.angle });
  const t = (a.angle * Math.PI) / 180;
  const dir = { x: Math.cos(t), y: Math.sin(t) };
  const out: number[] = [];
  for (const s of stalls) {
    const c = rectCorners({ cx: s.cx, cy: s.cy, w: s.width, h: s.depth, angle: s.angle });
    if (!convexPolygonsOverlap(c, zone, 1e-4)) continue;
    const th = (s.angle * Math.PI) / 180;
    const back = { x: -Math.sin(th), y: Math.cos(th) }; // 枠の奥行き方向
    const dot = Math.abs(back.x * dir.x + back.y * dir.y);
    out.push(Math.round(((Math.acos(Math.min(1, dot)) * 180) / Math.PI) * 10) / 10);
  }
  return out;
}
