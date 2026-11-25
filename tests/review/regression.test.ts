import { describe, it, expect } from 'vitest';
import { polygonArea } from '@/engine/geometry/polygon';
import { solveLand } from '@/engine/constraints/solver';
import { emptyLand, createProject, migrateProject, storable } from '@/services/projectFactory';
import { checkInterference, servedStallAngles, requiredAisleWidth } from '@/engine/validation/interference';
import { currentSite } from '@/engine/export/drawingModel';
import { optimizeParkingDetailed } from '@/engine/parking-optimizer/optimizer';
import type { Stall } from '@/types';

describe('品質レビューで見つかった不具合の回帰テスト', () => {
  it('大きな座標値（平面直角座標系）でも面積が正確', () => {
    for (const off of [1e5, 1e6, 1e7]) {
      const r = [{ x: off, y: off }, { x: off + 20.123, y: off }, { x: off + 20.123, y: off + 15.017 }, { x: off, y: off + 15.017 }];
      expect(Math.abs(polygonArea(r) - 20.123 * 15.017)).toBeLessThan(1e-6);
    }
  });

  it('斜め駐車案の通路は、その駐車角度の必要幅で判定する（90°基準で判定しない）', async () => {
    const d = createProject('a');
    const site = currentSite(d)!;
    const r = await optimizeParkingDetailed({ site, obstacles: [], entrances: d.entrances, stallType: d.stallTypes[0], settings: d.parking }, { yieldEvery: 1e9 });
    const angled = r.plans.filter((p) => p.stallAngle < 90);
    expect(angled.length).toBeGreaterThan(0);
    for (const p of angled) {
      const req = requiredAisleWidth(p.stallAngle, d.parking.vehicle);
      expect(req).toBeLessThan(requiredAisleWidth(90, d.parking.vehicle));
      const rep = checkInterference(site, p.stalls, [], p.aisles, d.parking, undefined, d.entrances);
      for (const n of rep.narrowAisles) expect(n.required).toBeCloseTo(Math.max(req, 0), 6);
      // 編集画面の判定と、配置案の評価（aisle-narrow 警告）が一致する
      const planSaysNarrow = p.issues.some((i) => i.code === 'aisle-narrow' || i.code === 'aisle-swept');
      expect(rep.narrowAisles.length > 0).toBe(planSaysNarrow);
      // 通路に角度情報が無い旧データでも、面している枠から推定した角度は配置角度を超えない
      for (const a of p.aisles) {
        const served = servedStallAngles({ ...a, stallAngle: undefined }, p.stalls);
        if (served.length) expect(Math.max(...served)).toBeLessThanOrEqual(p.stallAngle + 0.5);
      }
    }
  }, 120000);

  it('90°枠に面した幅5.5mの通路は幅不足として検出する', () => {
    const site = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }];
    const stalls: Stall[] = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i, typeId: 'standard', cx: 5 + i * 2.5, cy: 2.5, width: 2.5, depth: 5, angle: 0 }));
    const aisle = { id: 'ai', kind: 'twoway' as const, cx: 20, cy: 7.75, w: 40, h: 5.5, angle: 0, direction: 1 as const };
    const rep = checkInterference(site, stalls, [], [aisle], createProject('x').parking);
    expect(rep.narrowAisles).toHaveLength(1);
    expect(rep.narrowAisles[0].stallAngle).toBeCloseTo(90, 5);
  });

  it('凹形地の入隅が枠の辺に近い場合も境界離隔違反として検出する', () => {
    const L = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    // 奥行き方向を入隅(10,10)へ向けた枠：四隅は境界から1m以上離れているが、手前の辺が入隅に0.4mまで近づく
    const sm: Stall = { id: 'm', typeId: 'standard', cx: 7.95, cy: 7.95, width: 2.5, depth: 5, angle: -45 };
    const v = createProject('x').parking.vehicle;
    expect(checkInterference(L, [sm], [], [], { boundaryMargin: 1.0, vehicle: v }).outOfSite).toEqual(['m']);
    expect(checkInterference(L, [sm], [], [], { boundaryMargin: 0, vehicle: v }).outOfSite).toEqual([]);
  });

  it('多数の枠でも重なり判定が正しく速い（外接矩形で絞り込み）', () => {
    const stalls: Stall[] = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 30; j++) stalls.push({ id: `s${i}_${j}`, typeId: 'standard', cx: 1.25 + i * 2.5, cy: 2.5 + j * 5.5, width: 2.5, depth: 5, angle: 0 });
    stalls.push({ id: 'dup', typeId: 'standard', cx: 2.0, cy: 2.5, width: 2.5, depth: 5, angle: 10 });
    const big = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 170 }, { x: 0, y: 170 }];
    const t0 = performance.now();
    const rep = checkInterference(big, stalls, [], [], { boundaryMargin: 0, vehicle: createProject('x').parking.vehicle });
    const ms = performance.now() - t0;
    expect(rep.overlapping.map((p) => [...p].sort().join(',')).sort()).toEqual(['dup,s0_0', 'dup,s1_0']);
    expect(ms).toBeLessThan(200);
  });

  it('壊れたデータ（配列長の不足・異常な頂点数）は読み込み時に検出・補正する', () => {
    const bad = { ...createProject('bad'), land: { ...emptyLand(5), sides: [20, 15], angles: [], coords: [] } };
    const m = migrateProject(JSON.parse(JSON.stringify(bad)));
    expect(m.land.sides).toHaveLength(5);
    expect(m.land.angles).toHaveLength(5);
    expect(() => migrateProject({ id: 'x', land: { vertexCount: 1e9 }, stalls: [{ cx: 'a' }] })).toThrow();
    expect(() => migrateProject(null)).toThrow();
    expect(() => migrateProject({ id: '../etc' })).toThrow();
  });

  it('選択した形状候補（鏡像の別解）が保存→読込で維持される', () => {
    // 4辺＋対角線1本の四角形は、対角線で折り返した2通りの形が成り立つ
    const pts = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 12, y: 13 }, { x: 0, y: 16 }];
    const d = createProject('hint');
    const land = emptyLand(4);
    land.sides = pts.map((p, i) => Math.hypot(p.x - pts[(i + 1) % 4].x, p.y - pts[(i + 1) % 4].y));
    land.diagonals = [{ id: 'd1', a: 1, b: 3, length: Math.hypot(pts[1].x - pts[3].x, pts[1].y - pts[3].y) }];
    const sol = solveLand(land);
    expect(sol.candidates.length).toBeGreaterThanOrEqual(2);
    for (const k of [0, 1]) {
      const doc = { ...d, land, solution: sol, selectedCandidate: k };
      const saved = JSON.parse(JSON.stringify(storable(doc, true)));
      const back = migrateProject(saved);
      const got = back.solution!.candidates[back.selectedCandidate].points;
      const want = sol.candidates[k].points;
      for (let i = 0; i < 4; i++) {
        expect(got[i].x).toBeCloseTo(want[i].x, 3);
        expect(got[i].y).toBeCloseTo(want[i].y, 3);
      }
      expect(polygonArea(got)).toBeCloseTo(polygonArea(want), 3);
    }
  });

  it('ソルバーは頂点数が多くても時間内に収まる', () => {
    const n = 24;
    const pts = Array.from({ length: n }, (_, i) => ({ x: 30 * Math.cos((2 * Math.PI * i) / n), y: 20 * Math.sin((2 * Math.PI * i) / n) }));
    const l = emptyLand(n);
    l.sides = pts.map((p, i) => Math.hypot(p.x - pts[(i + 1) % n].x, p.y - pts[(i + 1) % n].y));
    l.diagonals = Array.from({ length: n - 3 }, (_, k) => ({ id: 'd' + k, a: 0, b: k + 2, length: Math.hypot(pts[0].x - pts[k + 2].x, pts[0].y - pts[k + 2].y) }));
    const t0 = performance.now();
    const s = solveLand(l);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(['exact', 'multiple']).toContain(s.status);
    expect(s.candidates.length).toBeLessThanOrEqual(12);
  }, 30000);

  it('成り立たない対角線（三角不等式違反）は「不足」ではなく「矛盾」と判定する', () => {
    const d = createProject('x');
    for (const L of [36, 40, 60]) {
      const l = { ...d.land, diagonals: [{ id: 'a', a: 0, b: 2, length: L }] };
      expect(solveLand(l).status).toBe('inconsistent');
      expect(solveLand(l, { hint: d.solution!.candidates[0].points }).status).toBe('inconsistent');
    }
    expect(solveLand({ ...d.land, diagonals: [] }).status).toBe('underdetermined');
  });
});
