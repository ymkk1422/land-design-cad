// 駐車枠の編集操作（純粋関数）。ストアとテストの両方から利用
import type { Stall, Vec2 } from '@/types';
import { rad, rotate } from '@/engine/geometry/polygon';

let seq = 0;
export const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const snapValue = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v);

export function moveStalls(stalls: Stall[], ids: Set<string>, dx: number, dy: number, snap = 0): Stall[] {
  return stalls.map((s) => (ids.has(s.id) ? { ...s, cx: snapValue(s.cx + dx, snap), cy: snapValue(s.cy + dy, snap) } : s));
}

/** 選択枠を一括回転（選択の重心まわり） */
export function rotateStalls(stalls: Stall[], ids: Set<string>, deltaDeg: number): Stall[] {
  const sel = stalls.filter((s) => ids.has(s.id));
  if (!sel.length) return stalls;
  const c: Vec2 = { x: sel.reduce((a, s) => a + s.cx, 0) / sel.length, y: sel.reduce((a, s) => a + s.cy, 0) / sel.length };
  return stalls.map((s) => {
    if (!ids.has(s.id)) return s;
    const p = rotate({ x: s.cx, y: s.cy }, rad(deltaDeg), c);
    return { ...s, cx: p.x, cy: p.y, angle: normAngle(s.angle + deltaDeg) };
  });
}

export const normAngle = (a: number): number => {
  let x = a % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return Math.round(x * 1e6) / 1e6;
};

/** 複製：枠幅方向に隣へずらして配置 */
export function duplicateStalls(stalls: Stall[], ids: Set<string>): { stalls: Stall[]; newIds: string[] } {
  const sel = stalls.filter((s) => ids.has(s.id));
  const newIds: string[] = [];
  const copies = sel.map((s) => {
    const off = rotate({ x: s.width, y: 0 }, rad(s.angle));
    const id = newId('s');
    newIds.push(id);
    return { ...s, id, cx: s.cx + off.x, cy: s.cy + off.y };
  });
  return { stalls: [...stalls, ...copies], newIds };
}

export const deleteStalls = (stalls: Stall[], ids: Set<string>): Stall[] => stalls.filter((s) => !ids.has(s.id));

/** 整列：選択枠の角度方向に沿って横一列に揃える（奥行き方向の位置を揃える） */
export function alignStalls(stalls: Stall[], ids: Set<string>, mode: 'row' | 'left' | 'top'): Stall[] {
  const sel = stalls.filter((s) => ids.has(s.id));
  if (sel.length < 2) return stalls;
  const ref = sel[0];
  const th = rad(ref.angle);
  // ローカル座標（u=幅方向, v=奥行き方向）
  const toL = (s: Stall): Vec2 => rotate({ x: s.cx, y: s.cy }, -th);
  const locals = sel.map(toL);
  const vAvg = locals.reduce((a, p) => a + p.y, 0) / locals.length;
  const uMin = Math.min(...locals.map((p) => p.x));
  const vMax = Math.max(...locals.map((p) => p.y));
  return stalls.map((s) => {
    if (!ids.has(s.id)) return s;
    const p = toL(s);
    const q = mode === 'row' ? { x: p.x, y: vAvg } : mode === 'left' ? { x: uMin, y: p.y } : { x: p.x, y: vMax };
    const w = rotate(q, th);
    return { ...s, cx: w.x, cy: w.y, angle: ref.angle };
  });
}

/** 等間隔配置：両端を固定し、幅方向に均等割り付け（gap 指定時は枠間隔で詰める） */
export function distributeStalls(stalls: Stall[], ids: Set<string>, gap?: number): Stall[] {
  const sel = stalls.filter((s) => ids.has(s.id));
  if (sel.length < 3 && gap === undefined) return stalls;
  if (sel.length < 2) return stalls;
  const th = rad(sel[0].angle);
  const withL = sel.map((s) => ({ s, p: rotate({ x: s.cx, y: s.cy }, -th) })).sort((a, b) => a.p.x - b.p.x);
  const first = withL[0].p;
  const last = withL[withL.length - 1].p;
  const step = gap !== undefined ? withL[0].s.width + gap : (last.x - first.x) / (withL.length - 1);
  const map = new Map<string, Vec2>();
  withL.forEach((e, i) => map.set(e.s.id, rotate({ x: first.x + step * i, y: e.p.y }, th)));
  return stalls.map((s) => (map.has(s.id) ? { ...s, cx: map.get(s.id)!.x, cy: map.get(s.id)!.y } : s));
}
