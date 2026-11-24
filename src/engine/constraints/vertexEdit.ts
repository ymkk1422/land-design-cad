// 頂点の追加・削除・移動（図面上の直接編集）。編集後は座標を正として全入力値を整合させる
import type { Entrance, LandInput, Road, Vec2 } from '@/types';
import { landFromPoints } from './solver';

export function moveVertexLand(land: LandInput, pts: Vec2[], idx: number, p: Vec2): LandInput {
  const next = pts.map((q, i) => (i === idx ? p : q));
  return landFromPoints(next, land);
}

export function insertVertexLand(land: LandInput, pts: Vec2[], edge: number): { land: LandInput; map: (i: number) => number } {
  const n = pts.length;
  const a = pts[edge];
  const b = pts[(edge + 1) % n];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const next = [...pts.slice(0, edge + 1), mid, ...pts.slice(edge + 1)];
  const map = (i: number): number => (i > edge ? i + 1 : i);
  const base: LandInput = {
    ...land,
    diagonals: land.diagonals.map((d) => ({ ...d, a: map(d.a), b: map(d.b) })),
    angles: [...land.angles.slice(0, edge + 1), null, ...land.angles.slice(edge + 1)],
  };
  return { land: landFromPoints(next, base), map };
}

export function deleteVertexLand(land: LandInput, pts: Vec2[], idx: number): { land: LandInput; map: (i: number) => number } | null {
  if (pts.length <= 3) return null;
  const next = pts.filter((_, i) => i !== idx);
  const map = (i: number): number => (i > idx ? i - 1 : i);
  const base: LandInput = {
    ...land,
    diagonals: land.diagonals.filter((d) => d.a !== idx && d.b !== idx).map((d) => ({ ...d, a: map(d.a), b: map(d.b) })),
    angles: land.angles.filter((_, i) => i !== idx),
  };
  const out = landFromPoints(next, base);
  // 隣接となった対角線（＝辺）は削除
  const n = next.length;
  out.diagonals = out.diagonals.filter((d) => Math.abs(d.a - d.b) !== 1 && Math.abs(d.a - d.b) !== n - 1);
  return { land: out, map };
}

/** 辺インデックスの付け替え（道路・出入口） */
export function remapEdges<T extends Road | Entrance>(items: T[], kind: 'insert' | 'delete', at: number, n: number): T[] {
  return items
    .map((it) => {
      if (kind === 'insert') return { ...it, edgeIndex: it.edgeIndex > at ? it.edgeIndex + 1 : it.edgeIndex };
      if (it.edgeIndex === at || it.edgeIndex === (at - 1 + n) % n) return { ...it, edgeIndex: Math.max(0, Math.min(it.edgeIndex, n - 2)) };
      return { ...it, edgeIndex: it.edgeIndex > at ? it.edgeIndex - 1 : it.edgeIndex };
    })
    .filter((it) => it.edgeIndex >= 0);
}
