import { describe, expect, it } from 'vitest';
import type { Aisle, Obstacle, Stall } from '@/types';
import { optimizeParkingDetailed, entranceGeometry } from '@/engine/parking-optimizer/optimizer';
import { checkInterference, stallCorners } from '@/engine/validation/interference';
import { sweptPath, routeClearance } from '@/engine/validation/turning';
import { upperBounds } from '@/engine/parking-optimizer/bounds';
import { analyzeReachability, buildBaseGrid } from '@/engine/parking-optimizer/reachability';
import { polygonArea, polygonInsidePolygon, rectCorners, offsetPolygonInward } from '@/engine/geometry/polygon';
import { SITES, STD, SETTINGS } from './fixtures';

const MIN_EXPECTED: Record<string, number> = { 長方形30x20: 20, 台形: 18, 三角形: 16, L字: 32, 凹凸五角形: 15, 斜め平行四辺形: 17 };

/** 独立検証：出入口から車体半幅+0.25mを確保して各枠の前面まで到達できるか */
function independentlyReachable(site: { x: number; y: number }[], stalls: Stall[], entrances: typeof SITES['台形']['entrances']): boolean {
  const grid = buildBaseGrid(site, [], 200000);
  const ents = entrances.map((e) => ({ ...entranceGeometry(site, e), width: e.width }));
  const reach = analyzeReachability(grid, stalls.map(stallCorners), ents, SETTINGS.vehicle.width / 2 + 0.25);
  return stalls.every((s) => {
    const th = (s.angle * Math.PI) / 180;
    const back = { x: -Math.sin(th), y: Math.cos(th) }; // 奥行き方向（背）
    const front = { x: s.cx - back.x * (s.depth / 2 + 1.2), y: s.cy - back.y * (s.depth / 2 + 1.2) };
    return reach.reachable(front);
  });
}

describe('変形地での自動配置', () => {
  for (const [name, f] of Object.entries(SITES)) {
    it(`${name}：全案が干渉なし・通路が敷地内・全枠に到達可能・上限以下`, async () => {
      const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: SETTINGS }, { yieldEvery: 1e9 });
      expect(r.plans.length).toBeGreaterThanOrEqual(2);
      const best = Math.max(...r.plans.map((p) => p.metrics.count));
      expect(best).toBeGreaterThanOrEqual(MIN_EXPECTED[name]);
      expect(r.bounds.accessBound).toBeLessThanOrEqual(r.bounds.areaBound);
      for (const p of r.plans) {
        const rep = checkInterference(f.site, p.stalls, [], p.aisles, SETTINGS, p.stallAngle, f.entrances);
        expect({ plan: p.name, ...rep, narrowAisles: [] }).toMatchObject({ outOfSite: [], overlapping: [], aisleHits: [], aislesOutOfSite: [], entranceBlocked: [] });
        expect(p.metrics.count).toBe(p.stalls.length);
        expect(p.metrics.count).toBeLessThanOrEqual(r.bounds.accessBound);
        expect(independentlyReachable(f.site, p.stalls, f.entrances)).toBe(true);
        // 案ごとに通路幅と問題点（少なくとも通路幅判定と最適性の区分）が付く
        expect(p.aisleWidths.length).toBeGreaterThan(0);
        expect(p.issues.some((i) => i.code.startsWith('aisle'))).toBe(true);
        expect(p.issues.some((i) => ['optimal', 'optimal-model', 'heuristic'].includes(i.code))).toBe(true);
      }
      // 90/60/45 の比較
      expect(r.angleSummary.map((a) => a.angle)).toEqual([90, 60, 45]);
      r.angleSummary.forEach((a) => expect(a.bestCount).toBeGreaterThan(0));
    }, 60000);
  }

  it('任意角度（30°・75°）も比較できる', async () => {
    const f = SITES['台形'];
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: { ...SETTINGS, angles: [75, 30] } }, { yieldEvery: 1e9 });
    expect(r.angleSummary.map((a) => a.angle)).toEqual([75, 30]);
    expect(r.plans.every((p) => [75, 30].includes(p.stallAngle))).toBe(true);
  }, 60000);

  it('障害物（建物）のある変形地でも障害物と干渉しない', async () => {
    const f = SITES['L字'];
    const building: Obstacle = { id: 'b', kind: 'building', cx: 8, cy: 26, w: 8, h: 6, angle: 0 };
    const pole: Obstacle = { id: 'p', kind: 'pole', cx: 30, cy: 8, w: 0.4, h: 0.4, angle: 0 };
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [building, pole], entrances: f.entrances, stallType: STD, settings: SETTINGS }, { yieldEvery: 1e9 });
    for (const p of r.plans) expect(checkInterference(f.site, p.stalls, [building, pole], p.aisles, SETTINGS, 90, f.entrances).obstacleHits).toEqual([]);
    expect(r.bounds.usableArea).toBeCloseTo(polygonArea(f.site) - 48 - 0.16, 6);
  }, 60000);
});

describe('上限値と最適性の区別', () => {
  it('上限に一致した案だけを「証明済み」とする（12.5m×15.5m：10台＝通路考慮上限）', async () => {
    const site = [{ x: 0, y: 0 }, { x: 12.5, y: 0 }, { x: 12.5, y: 15.5 }, { x: 0, y: 15.5 }];
    const entrances = [{ id: 'e', edgeIndex: 3, t: 0.5, width: 5 }];
    const r = await optimizeParkingDetailed({ site, obstacles: [], entrances, stallType: STD, settings: { ...SETTINGS, angles: [90] } }, { yieldEvery: 1e9 });
    expect(r.bounds.accessBound).toBe(10);
    expect(r.bounds.areaBound).toBe(15);
    const best = r.plans.reduce((a, b) => (b.metrics.count > a.metrics.count ? b : a));
    expect(best.metrics.count).toBe(10);
    expect(best.optimality).toBe('model-proven');
    expect(best.provenOptimal).toBe(true);
  }, 60000);

  it('上限に達しない案は「探索による最良案」と表示し、差を示す', async () => {
    const f = SITES['三角形'];
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: SETTINGS }, { yieldEvery: 1e9 });
    const p = r.plans[0];
    expect(p.optimality).toBe('heuristic');
    expect(p.provenOptimal).toBe(false);
    expect(p.issues.find((i) => i.code === 'heuristic')!.message).toContain(`${r.bounds.accessBound - p.metrics.count}台の差`);
  }, 60000);

  it('上限は面積から厳密に導かれ、重なる障害物は二重に控除しない', () => {
    const site = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
    const o1: Obstacle = { id: '1', kind: 'building', cx: 5, cy: 5, w: 4, h: 4, angle: 0 };
    const o2: Obstacle = { id: '2', kind: 'building', cx: 6, cy: 5, w: 4, h: 4, angle: 0 }; // o1 と重なる
    const out: Obstacle = { id: '3', kind: 'building', cx: 25, cy: 5, w: 4, h: 4, angle: 0 }; // 敷地外
    const b = upperBounds(site, [o1, o2, out], STD, { ...SETTINGS, angles: [90] });
    expect(b.usableArea).toBeCloseTo(200 - 16, 9);
    expect(b.areaBound).toBe(Math.floor(184 / 12.5));
    expect(b.accessBound).toBe(Math.floor(184 / (2.5 * (5 + 2.75))));
  });
});

describe('干渉・旋回・動線の判定', () => {
  const L = SITES['L字'].site;
  it('凹部の入隅をまたぐ枠は、4隅が敷地内でも境界干渉として検出', () => {
    // 入隅 (16,16) をまたぐ枠：四隅はすべて L 字の内側だが中央部が敷地外
    const s: Stall = { id: 'x', typeId: 'std', cx: 17.2, cy: 17.2, width: 2.5, depth: 5, angle: 45 };
    const c = stallCorners(s);
    expect(polygonInsidePolygon(c, L)).toBe(false);
    expect(checkInterference(L, [s], [], [], SETTINGS).outOfSite).toEqual(['x']);
  });

  it('出入口の前をふさぐ枠・敷地からはみ出した通路を検出', () => {
    const f = SITES['長方形30x20'];
    const block: Stall = { id: 'b', typeId: 'std', cx: 15, cy: 2.5, width: 2.5, depth: 5, angle: 0 };
    const aisle: Aisle = { id: 'a', kind: 'twoway', cx: 28, cy: 10, w: 8, h: 5.5, angle: 0, direction: 1 };
    const rep = checkInterference(f.site, [block], [], [aisle], SETTINGS, 90, f.entrances);
    expect(rep.entranceBlocked).toEqual(['b']);
    expect(rep.aislesOutOfSite).toEqual(['a']);
    expect(rep.ok).toBe(false);
  });

  it('旋回軌跡（最小回転半径5.5m）：軌跡幅≒3.0m、到達判定のクリアランスは車体半幅以上', () => {
    const sp = sweptPath(SETTINGS.vehicle);
    expect(sp.width).toBeGreaterThan(2.8);
    expect(sp.width).toBeLessThan(3.3);
    expect(sp.outerBodyRadius).toBeGreaterThan(SETTINGS.vehicle.minTurningRadius);
    const c = routeClearance(SETTINGS.vehicle, 3.5);
    expect(c).toBeGreaterThanOrEqual(SETTINGS.vehicle.width / 2 + 0.25);
    expect(c).toBeLessThanOrEqual(3.5 / 2);
    // 小回りの車は軌跡幅が狭い
    expect(sweptPath({ ...SETTINGS.vehicle, minTurningRadius: 4.4, length: 3.4, wheelbase: 2.4, width: 1.48 }).width).toBeLessThan(sp.width);
  });

  it('通路幅が旋回軌跡幅より狭い設定は重大な問題として表示', async () => {
    const f = SITES['長方形30x20'];
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: { ...SETTINGS, angles: [90], twowayAisleWidth: 2.6 } }, { yieldEvery: 1e9 });
    const p = r.plans[0];
    expect(p).toBeTruthy();
    expect(p.issues.some((i) => i.code === 'aisle-swept' && i.level === 'error')).toBe(true);
  }, 60000);

  it('行き止まり通路を検出し、転回広場を設けた案も提示する', async () => {
    const f = SITES['長方形30x20'];
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: { ...SETTINGS, angles: [90] } }, { yieldEvery: 1e9 });
    expect(r.plans.some((p) => p.deadEnds > 0 && p.issues.some((i) => i.code === 'deadend'))).toBe(true);
    const turn = r.plans.find((p) => p.turnaround);
    expect(turn).toBeTruthy();
    expect(turn!.issues.some((i) => i.code === 'deadend-turn')).toBe(true);
  }, 60000);

  it('内側オフセット：長方形・凹形の内側多角形、成立しない距離は null', () => {
    const sq = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
    expect(polygonArea(offsetPolygonInward(sq, 2)!)).toBeCloseTo(16 * 6, 9);
    expect(offsetPolygonInward(sq, 6)).toBeNull();
    const inner = offsetPolygonInward(L, 3)!;
    expect(inner).not.toBeNull();
    expect(polygonInsidePolygon(inner, L)).toBe(true);
  });
});

void rectCorners;

describe('案の重複・通路幅表示', () => {
  it('同じ枠配置の案は重複して提示しない／通路幅は通路の幅員を表示', async () => {
    const f = SITES['L字'];
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: SETTINGS }, { yieldEvery: 1e9 });
    const sigs = r.plans.map((p) => p.stalls.map((s) => `${s.cx.toFixed(2)},${s.cy.toFixed(2)}`).sort().join('|'));
    expect(new Set(sigs).size).toBe(sigs.length);
    for (const p of r.plans) for (const w of p.aisleWidths) expect(w).toBeGreaterThanOrEqual(SETTINGS.onewayAisleWidth - 1e-9);
  }, 60000);
});
