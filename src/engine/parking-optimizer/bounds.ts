// 駐車台数の数学的上限（配置アルゴリズムに依存しない保証値）
import type { Obstacle, ParkingSettings, StallType, UpperBounds, Vec2 } from '@/types';
import { convexPolygonsOverlap, polygonArea, rectCorners, signedArea } from '@/engine/geometry/polygon';

/** 凸多角形 clip で subject を切り取る（Sutherland–Hodgman）。subject が凹でも面積は正しい */
export function clipPolygon(subject: Vec2[], clip: Vec2[]): Vec2[] {
  const ccw = signedArea(clip) > 0;
  const inside = (p: Vec2, a: Vec2, b: Vec2): boolean => {
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    return ccw ? c >= 0 : c <= 0;
  };
  const inter = (p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const A1 = q.y - p.y, B1 = p.x - q.x, C1 = A1 * p.x + B1 * p.y;
    const A2 = b.y - a.y, B2 = a.x - b.x, C2 = A2 * a.x + B2 * a.y;
    const det = A1 * B2 - A2 * B1;
    if (Math.abs(det) < 1e-15) return q;
    return { x: (B2 * C1 - B1 * C2) / det, y: (A1 * C2 - A2 * C1) / det };
  };
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p, a, b);
      const qin = inside(q, a, b);
      if (qin) {
        if (!pin) out.push(inter(p, q, a, b));
        out.push(q);
      } else if (pin) out.push(inter(p, q, a, b));
    }
  }
  return out;
}

/**
 * 上限値の計算。
 * 1) 面積上限：駐車枠は互いに重ならず敷地内（障害物外）にあるので N·w·d ≤ 利用可能面積。無条件に成り立つ。
 * 2) 通路考慮上限：各枠は前面に幅 w・奥行 A/2 以上の専用通路領域を持つ（通路は両側の枠で共有するのが最良）
 *    と仮定すると N·w·(d + A/2) ≤ 利用可能面積。A は探索対象の角度で最も狭い通路幅。
 * 障害物は互いに重ならない分だけ控除する（重複控除で上限が過小になるのを防ぐ）。
 */
export function upperBounds(site: Vec2[], obstacles: Obstacle[], st: StallType, s: ParkingSettings): UpperBounds {
  const siteArea = polygonArea(site);
  const polys = obstacles.map(rectCorners).map((p) => ({ p, a: polygonArea(clipPolygon(site, p)) })).sort((x, y) => y.a - x.a);
  const used: Vec2[][] = [];
  let removed = 0;
  for (const o of polys) {
    if (o.a <= 0) continue;
    if (used.some((u) => convexPolygonsOverlap(u, o.p, 0))) continue;
    used.push(o.p);
    removed += o.a;
  }
  const usable = Math.max(0, siteArea - removed);
  const angles = s.angles.length ? s.angles : [90];
  const aisleFor = (a: number): number => (a < 89.5 ? s.onewayAisleWidth : s.twowayAisleWidth);
  const minAisle = Math.min(...angles.map(aisleFor));
  const w = st.width + 0; // 枠間隔は上限を緩める方向なので無視（保証を崩さない）
  const EPS = 1e-9;
  const areaBound = Math.floor(usable / (w * st.depth) + EPS);
  const accessBound = Math.min(areaBound, Math.floor(usable / (w * (st.depth + minAisle / 2)) + EPS));
  return {
    usableArea: usable,
    areaBound,
    accessBound,
    assumptions: [
      `面積上限 ${areaBound}台：利用可能面積 ${usable.toFixed(2)}㎡ ÷ 枠面積 ${(w * st.depth).toFixed(2)}㎡（無条件に保証）`,
      `通路考慮上限 ${accessBound}台：各枠が前面に幅${w.toFixed(2)}m×奥行${(minAisle / 2).toFixed(2)}m（通路幅${minAisle.toFixed(2)}mの半分）の専用通路領域を持つ前提`,
    ],
  };
}
