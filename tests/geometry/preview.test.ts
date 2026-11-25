import { describe, it, expect } from 'vitest';
import { solveLand } from '@/engine/constraints/solver';
import { emptyLand, migrateProject, createProject } from '@/services/projectFactory';
import { interiorAngles, polygonArea, signedArea } from '@/engine/geometry/polygon';
import type { LandInput } from '@/types';

const rect = (): LandInput => ({ ...emptyLand(4), sides: [20, 15, 20, 15], diagonals: [], angles: [null, null, null, null] });
const side = (p: { x: number; y: number }[], i: number): number => Math.hypot(p[(i + 1) % p.length].x - p[i].x, p[(i + 1) % p.length].y - p[i].y);

describe('寸法不足・不一致のときの仮の形', () => {
  it('寸法不足：入力した辺は満たし、未入力の角を直角に近づけた仮の形を出す', () => {
    const s = solveLand(rect());
    expect(s.status).toBe('underdetermined');
    expect(s.candidates).toHaveLength(0); // 計算・出力には使わない
    const p = s.preview!;
    expect(p.kind).toBe('auto');
    expect(p.autoAngles).toEqual([0, 1, 2, 3]);
    [20, 15, 20, 15].forEach((L, i) => expect(side(p.points, i)).toBeCloseTo(L, 6));
    interiorAngles(p.points).forEach((a) => expect(a).toBeCloseTo(90, 4));
  });

  it('寸法不足：一部の角を入力すると、その角は守り、残りを自動調整する', () => {
    const l = { ...rect(), sides: [20, 15, 18, null], angles: [null, 80, null, null] };
    const s = solveLand(l);
    expect(s.status).toBe('underdetermined');
    const p = s.preview!;
    expect(p.kind).toBe('auto');
    expect(interiorAngles(p.points)[1]).toBeCloseTo(80, 4);
    [20, 15, 18].forEach((L, i) => expect(side(p.points, i)).toBeCloseTo(L, 6));
    expect(p.autoAngles).toEqual([0, 2, 3]);
    expect(p.autoSides).toEqual([3]);
  });

  it('未入力の辺も仮の長さで補う', () => {
    const p = solveLand({ ...rect(), sides: [20, null, 20, 15] }).preview!;
    expect(p.kind).toBe('auto');
    expect(p.autoSides).toEqual([1]);
    expect(side(p.points, 0)).toBeCloseTo(20, 6);
  });

  it('矛盾：合わない寸法を1つに特定し、それを除いた形を仮に出す', () => {
    const s = solveLand({ ...rect(), diagonals: [{ id: 'd', a: 0, b: 2, length: 40 }] });
    expect(s.status).toBe('inconsistent');
    const p = s.preview!;
    expect(p.kind).toBe('mismatch');
    expect(p.conflict?.kind).toBe('diagonal');
    expect(p.conflict?.label).toBe('AC');
    expect(p.conflict?.actual).toBeCloseTo(25, 4);
    expect(polygonArea(p.points)).toBeCloseTo(300, 3); // 潰れた形ではなく、他の寸法を満たす形
  });

  it('矛盾（寸法不足と同時）：成り立たない辺を特定する', () => {
    const p = solveLand({ ...rect(), sides: [20, 15, 50, 15] }).preview!;
    expect(p.kind).toBe('mismatch');
    expect(p.conflict?.label).toBe('CD');
  });

  it('入力ミスの辺を特定する（対角線2本あり）', () => {
    const p = solveLand({ ...rect(), sides: [20, 15, 2, 15], diagonals: [{ id: 'd', a: 0, b: 2, length: 25 }, { id: 'e', a: 1, b: 3, length: 25 }] }).preview!;
    expect(p.conflict?.label).toBe('CD');
    expect(p.conflict?.actual).toBeCloseTo(20, 3);
  });

  it('形が確定していれば仮の形は出さない', () => {
    const s = solveLand({ ...rect(), diagonals: [{ id: 'd', a: 0, b: 2, length: 25 }] });
    expect(s.status).toBe('exact');
    expect(s.preview ?? null).toBeNull();
  });
});

describe('頂点の回る向き', () => {
  it('時計回りを指定すると、同じ寸法で左右が反転した形（時計回り）になる', () => {
    const l = { ...rect(), diagonals: [{ id: 'd', a: 0, b: 2, length: 25 }] };
    const ccw = solveLand(l).candidates[0].points;
    const cw = solveLand({ ...l, order: 'cw' }).candidates[0].points;
    expect(signedArea(ccw)).toBeGreaterThan(0);
    expect(signedArea(cw)).toBeLessThan(0);
    // A は原点、B は右（+x）
    expect(cw[0].x).toBeCloseTo(0, 6);
    expect(cw[1].x).toBeCloseTo(20, 6);
    expect(cw[1].y).toBeCloseTo(0, 6);
    expect(cw[2].y).toBeCloseTo(-15, 6);
  });

  it('時計回りでも角度の入力が正しく効く', () => {
    const l = { ...rect(), sides: [20, 15, 18, 14], angles: [90, null, null, null], order: 'cw' as const };
    const s = solveLand(l);
    expect(['exact', 'multiple']).toContain(s.status);
    expect(interiorAngles(s.candidates[0].points)[0]).toBeCloseTo(90, 4);
    expect(signedArea(s.candidates[0].points)).toBeLessThan(0);
  });

  it('回る向きは保存→読込で保たれる', () => {
    const d = createProject('o');
    const back = migrateProject(JSON.parse(JSON.stringify({ ...d, land: { ...d.land, order: 'cw' } })));
    expect(back.land.order).toBe('cw');
    expect(migrateProject(JSON.parse(JSON.stringify({ ...d, land: { ...d.land, order: 'weird' } }))).land.order).toBeUndefined();
  });
});
