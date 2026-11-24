// 干渉判定・通路幅検証（駐車場最適化・手動編集で共通利用）
import type { Aisle, Entrance, Obstacle, ParkingSettings, RectShape, Stall, Vec2 } from '@/types';
import {
  convexOverlapsPolygon,
  convexPolygonsOverlap,
  distanceToBoundary,
  polygonInsidePolygon,
  rectCorners,
  signedArea,
} from '@/engine/geometry/polygon';

export const stallRect = (s: Stall): RectShape => ({ cx: s.cx, cy: s.cy, w: s.width, h: s.depth, angle: s.angle });
export const stallCorners = (s: Stall): Vec2[] => rectCorners(stallRect(s));

/** 障害物のうち駐車不可として扱う範囲（すべての種類が対象） */
export const obstaclePolygon = (o: Obstacle): Vec2[] => rectCorners(o);

export { requiredAisleWidth, sweptPath } from './turning';
import { requiredAisleWidth } from './turning';

export interface InterferenceReport {
  outOfSite: string[];
  overlapping: [string, string][];
  obstacleHits: { stallId: string; obstacleId: string }[];
  aisleHits: { stallId: string; aisleId: string }[];
  narrowAisles: { aisleId: string; width: number; required: number }[];
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
  stallAngle = 90,
  entrances: Entrance[] = [],
): InterferenceReport {
  const outOfSite: string[] = [];
  const overlapping: [string, string][] = [];
  const obstacleHits: { stallId: string; obstacleId: string }[] = [];
  const aisleHits: { stallId: string; aisleId: string }[] = [];
  const corners = stalls.map(stallCorners);
  const obsPolys = obstacles.map(obstaclePolygon);
  const aislePolys = aisles.map((a) => rectCorners(a));
  stalls.forEach((s, i) => {
    const c = corners[i];
    const inside = site.length >= 3 && polygonInsidePolygon(c, site, 1e-6);
    const marginOk = settings.boundaryMargin <= 0 || c.every((p) => distanceToBoundary(p, site) >= settings.boundaryMargin - 1e-6);
    if (!inside || !marginOk) outOfSite.push(s.id);
    for (let j = i + 1; j < stalls.length; j++) {
      if (convexPolygonsOverlap(c, corners[j], 1e-4)) overlapping.push([s.id, stalls[j].id]);
    }
    obsPolys.forEach((op, k) => {
      if (convexPolygonsOverlap(c, op, 1e-4)) obstacleHits.push({ stallId: s.id, obstacleId: obstacles[k].id });
    });
    aislePolys.forEach((ap, k) => {
      if (aisles[k].kind !== 'pedestrian' && convexPolygonsOverlap(c, ap, 1e-3)) aisleHits.push({ stallId: s.id, aisleId: aisles[k].id });
    });
  });
  const narrowAisles = aisles
    .filter((a) => a.kind !== 'pedestrian')
    .map((a) => ({ aisleId: a.id, width: Math.min(a.w, a.h), required: requiredAisleWidth(stallAngle, settings.vehicle) }))
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
