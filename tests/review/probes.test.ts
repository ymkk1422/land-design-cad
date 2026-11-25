import { it } from 'vitest';
import { polygonArea, signedArea, rectCorners } from '@/engine/geometry/polygon';
import { solveLand } from '@/engine/constraints/solver';
import { emptyLand, createProject, migrateProject } from '@/services/projectFactory';
import { checkInterference } from '@/engine/validation/interference';
import { buildModel, currentSite } from '@/engine/export/drawingModel';
import { optimizeParkingDetailed } from '@/engine/parking-optimizer/optimizer';
import type { Stall } from '@/types';
const out = (...a: unknown[]): void => void process.stdout.write(a.join(' ') + '\n');

it('probes', async () => {
  // 1. 大きな座標（平面直角座標系の値）での面積
  for (const off of [0, 1e4, 1e5, 1e6, 1e7]) {
    const r = [{ x: off, y: off }, { x: off + 20.123, y: off }, { x: off + 20.123, y: off + 15.017 }, { x: off, y: off + 15.017 }];
    out('AREA off', off, (polygonArea(r) - 20.123 * 15.017).toExponential(2));
  }
  // 2. 大座標の座標入力でソルバー
  for (const off of [1e5, 1e6]) {
    const l = emptyLand(4);
    l.coords = [{ x: off, y: -off }, { x: off + 20, y: -off }, { x: off + 20, y: -off + 15 }, { x: off, y: -off + 15 }];
    const t0 = performance.now();
    const s = solveLand(l);
    out('SOLVE bigcoord', off, s.status, s.candidates[0] ? (polygonArea(s.candidates[0].points) - 300).toExponential(2) : '-', (performance.now() - t0).toFixed(0) + 'ms');
  }
  // 3. 頂点数とソルバー時間
  for (const n of [4, 8, 12, 16, 24, 32, 40]) {
    const pts = Array.from({ length: n }, (_, i) => ({ x: 30 * Math.cos((2 * Math.PI * i) / n), y: 20 * Math.sin((2 * Math.PI * i) / n) }));
    const l = emptyLand(n);
    l.sides = pts.map((p, i) => Math.hypot(p.x - pts[(i + 1) % n].x, p.y - pts[(i + 1) % n].y));
    l.diagonals = Array.from({ length: n - 3 }, (_, k) => ({ id: 'd' + k, a: 0, b: k + 2, length: Math.hypot(pts[0].x - pts[k + 2].x, pts[0].y - pts[k + 2].y) }));
    const t0 = performance.now();
    const s = solveLand(l);
    out('SOLVE n', n, s.status, s.candidates.length, (performance.now() - t0).toFixed(0) + 'ms');
  }
  // 4/5. 干渉判定・図面モデルの時間（600台）
  const stalls: Stall[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 20; j++) stalls.push({ id: `s${i}_${j}`, typeId: 'standard', cx: 1.25 + i * 2.5, cy: 2.5 + j * 5.5, width: 2.5, depth: 5, angle: 0 });
  const big = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 120 }, { x: 0, y: 120 }];
  let t0 = performance.now();
  checkInterference(big, stalls, [], [], { boundaryMargin: 0, vehicle: { length: 4.7, width: 1.7, wheelbase: 2.7, minTurningRadius: 5.5 } });
  out('INTERFERENCE 600', (performance.now() - t0).toFixed(0) + 'ms');
  const doc = createProject('p');
  doc.stalls = stalls;
  t0 = performance.now();
  for (let k = 0; k < 10; k++) buildModel(doc, { mode: 'cad', textUnit: 0.05 + k * 0.001, sitePoints: big });
  out('MODEL 600 x10', (performance.now() - t0).toFixed(0) + 'ms');
  // 6. 保存サイズ
  const d2 = createProject('size');
  const site = currentSite(d2)!;
  const r = await optimizeParkingDetailed({ site, obstacles: [], entrances: d2.entrances, stallType: d2.stallTypes[0], settings: d2.parking }, { yieldEvery: 1e9 });
  d2.stalls = r.plans[0].stalls;
  d2.aisles = r.plans[0].aisles;
  const j = JSON.stringify(d2);
  out('DOC bytes', j.length, 'solution bytes', JSON.stringify(d2.solution).length, 'x15 versions', j.length * 15);
  // 7. 斜め駐車案の通路幅判定（通路ごとの駐車角度で判定）
  const p45 = r.plans.find((p) => p.stallAngle < 90);
  if (p45) {
    const rep = checkInterference(site, p45.stalls, [], p45.aisles, d2.parking, undefined, d2.entrances);
    out('AISLE angled plan', p45.stallAngle, 'narrow (per-aisle angle):', rep.narrowAisles.length, 'of', p45.aisles.length);
  }
  // 8. 凹形地の入隅頂点と枠の辺の離隔
  const L = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  // 入隅(10,10)の近く：枠の四隅は境界から1m以上離れているが、辺は入隅に0.3mまで近い
  const s8: Stall = { id: 'm', typeId: 'standard', cx: 11.5, cy: 10.3 + 0 - 1.55 - 0.3, width: 6, depth: 2.5, angle: 45 };
  void s8;
  const sm: Stall = { id: 'm', typeId: 'standard', cx: 8.2, cy: 8.2, width: 2.5, depth: 5, angle: 45 };
  const c = rectCorners({ cx: sm.cx, cy: sm.cy, w: sm.width, h: sm.depth, angle: sm.angle });
  const rep8 = checkInterference(L, [sm], [], [], { boundaryMargin: 1.0, vehicle: d2.parking.vehicle });
  out('MARGIN corners', JSON.stringify(c.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)])), 'outOfSite(margin1m):', rep8.outOfSite.length);
  // 9. 配列長が不正なデータ
  try {
    const bad = { ...createProject('bad'), land: { ...emptyLand(5), sides: [20, 15], angles: [], coords: [] } };
    const m = migrateProject(JSON.parse(JSON.stringify(bad)));
    out('MIGRATE short arrays ->', m.solution?.status, m.land.sides.length);
  } catch (e) {
    out('MIGRATE short arrays threw', (e as Error).message);
  }
  try {
    const m = migrateProject({ id: 'x', land: { vertexCount: 1e9 }, stalls: [{ cx: 'a' }] });
    out('MIGRATE huge vertexCount ->', m.solution?.status);
  } catch (e) {
    out('MIGRATE huge threw', (e as Error).message);
  }
  void signedArea;
}, 120000);
