import { describe, expect, it } from 'vitest';
import type { Entrance, Obstacle, ParkingSettings, Stall, StallType, Vec2 } from '@/types';
import { optimizeParking, OptimizeCancelled, theoreticalUpperBound } from '@/engine/parking-optimizer/optimizer';
import { checkInterference, requiredAisleWidth, stallCorners } from '@/engine/validation/interference';
import { alignStalls, distributeStalls, duplicateStalls, moveStalls, rotateStalls } from '@/engine/parking-optimizer/stallOps';
import { convexPolygonsOverlap, polygonArea, rectCorners } from '@/engine/geometry/polygon';

const site: Vec2[] = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }];
const standard: StallType = { id: 'std', name: '普通車', category: 'standard', width: 2.5, depth: 5.0, color: '#0b5d63' };
const kei: StallType = { id: 'kei', name: '軽自動車', category: 'kei', width: 2.0, depth: 3.6, color: '#3a7' };
const settings: ParkingSettings = {
  stallTypeId: 'std',
  gap: 0,
  onewayAisleWidth: 3.5,
  twowayAisleWidth: 5.5,
  angles: [90, 60, 45],
  boundaryMargin: 0,
  vehicle: { length: 4.7, width: 1.7, wheelbase: 2.7, minTurningRadius: 5.5 },
  allowSingleRows: true,
  orientationStepDeg: 30,
};
const entrance: Entrance = { id: 'e1', edgeIndex: 0, t: 0.5, width: 5 };

function assertValid(stalls: Stall[], obstacles: Obstacle[] = []): void {
  const rep = checkInterference(site, stalls, obstacles, [], settings);
  expect(rep.outOfSite).toEqual([]);
  expect(rep.overlapping).toEqual([]);
  expect(rep.obstacleHits).toEqual([]);
}

describe('駐車場 自動配置', () => {
  it('14. 30m×20mの敷地に自動配置でき、全枠が敷地内・非干渉', async () => {
    const plans = await optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: standard, settings }, { yieldEvery: 1e9 });
    expect(plans.length).toBeGreaterThan(0);
    const best = plans[0];
    expect(best.metrics.count).toBe(best.stalls.length);
    expect(best.metrics.count).toBeGreaterThanOrEqual(18);
    expect(best.metrics.count).toBeLessThanOrEqual(theoreticalUpperBound(polygonArea(site), standard, 3.5));
    expect(best.metrics.count).toBeLessThanOrEqual(best.bounds.accessBound);
    expect(best.provenOptimal).toBe(best.optimality !== 'heuristic');
    plans.forEach((p) => assertValid(p.stalls));
  }, 60000);

  it('15. 複数案（A案・B案…）を生成し比較できる', async () => {
    const plans = await optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: standard, settings }, { yieldEvery: 1e9 });
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans[0].name).toBe('A案');
    expect(plans[1].name).toBe('B案');
    for (let i = 1; i < plans.length; i++) expect(plans[i - 1].metrics.score).toBeGreaterThanOrEqual(plans[i].metrics.score);
    expect(new Set(plans.map((p) => p.stallAngle)).size).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('13. 駐車枠の寸法変更で台数が変わる（軽自動車は普通車より多い）', async () => {
    const a = await optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: standard, settings: { ...settings, angles: [90] } }, { yieldEvery: 1e9 });
    const b = await optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: kei, settings: { ...settings, angles: [90] } }, { yieldEvery: 1e9 });
    expect(b[0].metrics.count).toBeGreaterThan(a[0].metrics.count);
    b[0].stalls.forEach((s) => {
      expect(s.width).toBe(2.0);
      expect(s.depth).toBe(3.6);
    });
  }, 60000);

  it('障害物（建物）を自動配置から除外する', async () => {
    const building: Obstacle = { id: 'b1', kind: 'building', cx: 15, cy: 14, w: 10, h: 8, angle: 0 };
    const plans = await optimizeParking({ site, obstacles: [building], entrances: [entrance], stallType: standard, settings }, { yieldEvery: 1e9 });
    const bc = rectCorners(building);
    plans[0].stalls.forEach((s) => expect(convexPolygonsOverlap(stallCorners(s), bc, 1e-4)).toBe(false));
    assertValid(plans[0].stalls, [building]);
  }, 60000);

  it('大規模処理をキャンセルできる', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: standard, settings }, { signal: ctrl.signal })).rejects.toBeInstanceOf(OptimizeCancelled);
  });

  it('進捗を通知する', async () => {
    let calls = 0;
    await optimizeParking({ site, obstacles: [], entrances: [entrance], stallType: standard, settings: { ...settings, angles: [90] } }, { onProgress: () => calls++, yieldEvery: 10 });
    expect(calls).toBeGreaterThan(0);
  }, 60000);
});

describe('駐車枠 手動編集・干渉判定', () => {
  const s1: Stall = { id: 'a', typeId: 'std', cx: 5, cy: 5, width: 2.5, depth: 5, angle: 0 };
  const s2: Stall = { id: 'b', typeId: 'std', cx: 7.5, cy: 5, width: 2.5, depth: 5, angle: 0 };

  it('16. 手動で移動できる（スナップ付き）', () => {
    const out = moveStalls([s1, s2], new Set(['a']), 1.234, 0.0, 0.1);
    expect(out[0].cx).toBeCloseTo(6.2, 10);
    expect(out[1].cx).toBe(7.5);
  });

  it('17. 回転できる（一括回転は重心まわり）', () => {
    const out = rotateStalls([s1, s2], new Set(['a', 'b']), 90);
    expect(out[0].angle).toBe(90);
    expect(out[0].cx).toBeCloseTo(6.25, 10);
    expect(out[0].cy).toBeCloseTo(3.75, 10);
  });

  it('18. 複製できる', () => {
    const { stalls, newIds } = duplicateStalls([s1], new Set(['a']));
    expect(stalls).toHaveLength(2);
    expect(newIds).toHaveLength(1);
    expect(stalls[1].cx).toBeCloseTo(7.5, 10);
  });

  it('19. 敷地境界との干渉（はみ出し）を検出できる', () => {
    const out: Stall = { ...s1, id: 'x', cx: 29.5 };
    const rep = checkInterference(site, [out], [], [], settings);
    expect(rep.outOfSite).toEqual(['x']);
  });

  it('20. 駐車枠同士の干渉を検出できる（接するだけなら干渉なし）', () => {
    expect(checkInterference(site, [s1, s2], [], [], settings).overlapping).toEqual([]);
    const s3 = { ...s2, id: 'c', cx: 6.5 };
    expect(checkInterference(site, [s1, s3], [], [], settings).overlapping).toEqual([['a', 'c']]);
  });

  it('21. 通路幅を検証できる', () => {
    const v = settings.vehicle;
    expect(requiredAisleWidth(90, v)).toBeCloseTo(6.0, 6);
    expect(requiredAisleWidth(45, v)).toBeLessThan(requiredAisleWidth(60, v));
    const rep = checkInterference(site, [], [], [{ id: 'ai', kind: 'twoway', cx: 15, cy: 10, w: 30, h: 5.5, angle: 0, direction: 1 }], settings, 90);
    expect(rep.narrowAisles).toHaveLength(1);
    expect(rep.narrowAisles[0].required).toBeCloseTo(6.0, 6);
  });

  it('整列・等間隔配置', () => {
    const s3: Stall = { ...s1, id: 'c', cx: 12, cy: 5.7 };
    const aligned = alignStalls([s1, { ...s2, cy: 4.2 }, s3], new Set(['a', 'b', 'c']), 'row');
    const ys = aligned.map((s) => s.cy);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-9);
    const dist = distributeStalls(aligned, new Set(['a', 'b', 'c']));
    expect(dist[1].cx).toBeCloseTo((5 + 12) / 2, 9);
  });
});
