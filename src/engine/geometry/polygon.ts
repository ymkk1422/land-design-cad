// 幾何学基本演算（描画から独立）
import type { RectShape, Vec2 } from '@/types';

export const EPS = 1e-9;

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const deg = (r: number): number => (r * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

export function rotate(p: Vec2, angleRad: number, origin: Vec2 = { x: 0, y: 0 }): Vec2 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}

/** 符号付き面積（シューレース公式）。反時計回りで正 */
export function signedArea(pts: Vec2[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const polygonArea = (pts: Vec2[]): number => Math.abs(signedArea(pts));

export function perimeter(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

export function sideLengths(pts: Vec2[]): number[] {
  return pts.map((p, i) => dist(p, pts[(i + 1) % pts.length]));
}

export function isCCW(pts: Vec2[]): boolean {
  return signedArea(pts) > 0;
}

/**
 * 頂点 i の内角（度）。ccw=true なら反時計回り多角形として計算。
 * 凹頂点では 180° を超える。
 */
export function interiorAngleAt(pts: Vec2[], i: number, ccw = isCCW(pts)): number {
  const n = pts.length;
  const p = pts[i];
  const next = sub(pts[(i + 1) % n], p);
  const prev = sub(pts[(i - 1 + n) % n], p);
  let a = Math.atan2(cross(next, prev), dot(next, prev));
  if (a < 0) a += 2 * Math.PI;
  return ccw ? deg(a) : 360 - deg(a);
}

export function interiorAngles(pts: Vec2[]): number[] {
  const ccw = isCCW(pts);
  return pts.map((_, i) => interiorAngleAt(pts, i, ccw));
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return cross(sub(b, a), sub(c, a));
}

function onSegment(a: Vec2, b: Vec2, p: Vec2, eps: number): boolean {
  return (
    Math.min(a.x, b.x) - eps <= p.x &&
    p.x <= Math.max(a.x, b.x) + eps &&
    Math.min(a.y, b.y) - eps <= p.y &&
    p.y <= Math.max(a.y, b.y) + eps
  );
}

/** 線分交差判定（端点接触も交差とみなす） */
export function segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2, eps = 1e-9): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  if (Math.abs(d1) <= eps && onSegment(q1, q2, p1, eps)) return true;
  if (Math.abs(d2) <= eps && onSegment(q1, q2, p2, eps)) return true;
  if (Math.abs(d3) <= eps && onSegment(p1, p2, q1, eps)) return true;
  if (Math.abs(d4) <= eps && onSegment(p1, p2, q2, eps)) return true;
  return false;
}

/** 自己交差判定（隣接しない辺同士の交差） */
export function isSelfIntersecting(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 4) return n === 3 ? Math.abs(signedArea(pts)) < 1e-12 : false;
  const scaleRef = Math.max(1, perimeter(pts));
  const eps = 1e-10 * scaleRef * scaleRef;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(a1, a2, pts[j], pts[(j + 1) % n], eps)) return true;
    }
  }
  return false;
}

/** 凸多角形判定 */
export function isConvex(pts: Vec2[]): boolean {
  const n = pts.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const c = orient(pts[i], pts[(i + 1) % n], pts[(i + 2) % n]);
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return !isSelfIntersecting(pts);
}

export const isConcave = (pts: Vec2[]): boolean => pts.length > 3 && !isConvex(pts) && !isSelfIntersecting(pts);

/** 点の多角形内判定（境界上は inside 扱い） */
export function pointInPolygon(p: Vec2, poly: Vec2[], eps = 1e-9): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    // 境界上
    if (Math.abs(orient(a, b, p)) <= eps * Math.max(1, dist(a, b)) && onSegment(a, b, p, eps)) return true;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** 線分が真に交差（端点接触は除外） */
function segmentsProperlyCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2, eps: number): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** 多角形 inner が outer に完全に含まれるか（凹多角形対応） */
export function polygonInsidePolygon(inner: Vec2[], outer: Vec2[], eps = 1e-7): boolean {
  for (const p of inner) if (!pointInPolygon(p, outer, eps)) return false;
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    for (let j = 0; j < outer.length; j++) {
      if (segmentsProperlyCross(a, b, outer[j], outer[(j + 1) % outer.length], eps)) return false;
    }
    // 辺の中点も確認（凹部の頂点が辺上に乗るケース）
    if (!pointInPolygon(scale(add(a, b), 0.5), outer, eps)) return false;
  }
  // 外側多角形の頂点が内側に入り込んでいないか
  for (const q of outer) {
    if (pointInPolygonStrict(q, inner, eps)) return false;
  }
  return true;
}

/** 境界上を除いた厳密な内部判定 */
export function pointInPolygonStrict(p: Vec2, poly: Vec2[], eps = 1e-9): boolean {
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (Math.abs(orient(a, b, p)) <= eps * Math.max(1, dist(a, b)) && onSegment(a, b, p, eps)) return false;
  }
  return pointInPolygon(p, poly, eps);
}

/** 回転矩形の4隅（反時計回り） */
export function rectCorners(r: RectShape): Vec2[] {
  const a = rad(r.angle);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hw = r.w / 2;
  const hh = r.h / 2;
  const local: Vec2[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return local.map((p) => ({ x: r.cx + p.x * c - p.y * s, y: r.cy + p.x * s + p.y * c }));
}

/** 凸多角形同士の重なり判定（分離軸定理）。tol>0 なら接触程度の重なりは許容 */
export function convexPolygonsOverlap(a: Vec2[], b: Vec2[], tol = 1e-6): boolean {
  const polys = [a, b];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
      const l = len(axis);
      if (l < EPS) continue;
      axis.x /= l;
      axis.y /= l;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of a) {
        const d = dot(p, axis);
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const p of b) {
        const d = dot(p, axis);
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB + tol || maxB <= minA + tol) return false;
    }
  }
  return true;
}

/** 凸多角形と任意多角形の重なり（辺交差 or 包含） */
export function convexOverlapsPolygon(convex: Vec2[], poly: Vec2[], tol = 1e-6): boolean {
  for (let i = 0; i < convex.length; i++) {
    for (let j = 0; j < poly.length; j++) {
      if (segmentsProperlyCross(convex[i], convex[(i + 1) % convex.length], poly[j], poly[(j + 1) % poly.length], tol)) return true;
    }
  }
  const c = centroid(convex);
  if (pointInPolygonStrict(c, poly)) return true;
  for (const q of poly) if (pointInPolygonStrict(q, convex)) return true;
  return false;
}

export function centroid(pts: Vec2[]): Vec2 {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-12) {
    const s = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return scale(s, 1 / pts.length);
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function bbox(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 点と線分の距離 */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, scale(ab, t)));
}

/** 点から多角形境界までの最短距離 */
export function distanceToBoundary(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export const vertexName = (i: number): string => {
  let s = '';
  let k = i;
  do {
    s = String.fromCharCode(65 + (k % 26)) + s;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return s;
};

/**
 * 多角形の内側オフセット（各辺を内側へ d 平行移動し隣接辺の交点を結ぶ）。
 * 辺が消滅する・自己交差する・向きが反転する場合は null（その距離では成立しない）。
 */
export function offsetPolygonInward(pts: Vec2[], d: number): Vec2[] | null {
  const n = pts.length;
  const ccw = isCCW(pts);
  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    const L = dist(a, b) || 1;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const nrm = ccw ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
    return { p: { x: a.x + nrm.x * d, y: a.y + nrm.y * d }, t };
  });
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    const den = cross(l1.t, l2.t);
    if (Math.abs(den) < 1e-9) {
      out.push(l2.p);
      continue;
    }
    const k = cross(sub(l2.p, l1.p), l2.t) / den;
    out.push({ x: l1.p.x + l1.t.x * k, y: l1.p.y + l1.t.y * k });
  }
  if (isSelfIntersecting(out) || isCCW(out) !== ccw || polygonArea(out) < 1) return null;
  // 元の辺の向きと逆転した辺があれば、その辺は消滅している
  for (let i = 0; i < n; i++) {
    const a = sub(pts[(i + 1) % n], pts[i]);
    const b = sub(out[(i + 1) % n], out[i]);
    if (dot(a, b) <= 0) return null;
  }
  return out;
}
