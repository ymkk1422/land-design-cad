import { describe, expect, it } from 'vitest';
import type { LandInput, Vec2 } from '@/types';
import { solveLand, isDrawable, landFromPoints } from '@/engine/constraints/solver';
import { dist, interiorAngles, isConvex, isConcave, isSelfIntersecting, perimeter, polygonArea } from '@/engine/geometry/polygon';
import { landMetrics, parseAngle, parseLength, formatDMS, TSUBO_M2 } from '@/engine/area-calculation';

function emptyLand(n: number): LandInput {
  return {
    vertexCount: n,
    sides: new Array(n).fill(null),
    diagonals: [],
    angles: new Array(n).fill(null),
    coords: new Array(n).fill(null),
    coordinateSystem: { kind: 'local' },
    tolerance: 0.01,
  };
}

function fromTruth(pts: Vec2[], diags: [number, number][]): LandInput {
  const n = pts.length;
  const land = emptyLand(n);
  land.sides = pts.map((p, i) => dist(p, pts[(i + 1) % n]));
  land.diagonals = diags.map(([a, b], k) => ({ id: `d${k}`, a, b, length: dist(pts[a], pts[b]) }));
  return land;
}

/** 合同判定（全頂点間距離の一致） */
function congruent(a: Vec2[], b: Vec2[], tol = 1e-5): boolean {
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.abs(dist(a[i], a[j]) - dist(b[i], b[j])) > tol) return false;
  return true;
}

describe('土地作図：辺の長さ・対角線', () => {
  it('1/4. 四角形を辺の長さ＋対角線から作図できる（20×15、AC=25）', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, 20, 15];
    land.diagonals = [{ id: 'd', a: 0, b: 2, length: 25 }];
    const r = solveLand(land);
    expect(r.status).toBe('exact');
    expect(r.candidates).toHaveLength(1);
    const m = landMetrics(r.candidates[0].points);
    expect(m.area).toBeCloseTo(300, 6);
    expect(m.perimeter).toBeCloseTo(70, 6);
    m.angles.forEach((a) => expect(a).toBeCloseTo(90, 5));
  });

  it('2. 五角形を作図できる', () => {
    const truth = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 26, y: 12 }, { x: 12, y: 22 }, { x: -3, y: 14 }];
    const r = solveLand(fromTruth(truth, [[0, 2], [0, 3]]));
    expect(isDrawable(r)).toBe(true);
    expect(r.candidates.some((c) => congruent(c.points, truth))).toBe(true);
    const c = r.candidates.find((c) => congruent(c.points, truth))!;
    expect(polygonArea(c.points)).toBeCloseTo(polygonArea(truth), 6);
  });

  it('3. 六角形・八角形を作図できる', () => {
    const hex = Array.from({ length: 6 }, (_, i) => ({ x: 10 * Math.cos((i * Math.PI) / 3) + (i === 2 ? 1 : 0), y: 8 * Math.sin((i * Math.PI) / 3) }));
    const r6 = solveLand(fromTruth(hex, [[0, 2], [0, 3], [0, 4]]));
    expect(isDrawable(r6)).toBe(true);
    expect(r6.candidates.some((c) => congruent(c.points, hex))).toBe(true);

    const oct = Array.from({ length: 8 }, (_, i) => ({ x: 15 * Math.cos((i * Math.PI) / 4), y: 11 * Math.sin((i * Math.PI) / 4) }));
    const r8 = solveLand(fromTruth(oct, [[0, 2], [0, 3], [0, 4], [0, 5], [0, 6]]));
    expect(isDrawable(r8)).toBe(true);
    expect(r8.candidates.some((c) => congruent(c.points, oct))).toBe(true);
  });

  it('5. 対角線を複数入力して一意に作図できる（冗長）', () => {
    const truth = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 15 }, { x: 5, y: 20 }];
    const r = solveLand(fromTruth(truth, [[0, 2], [1, 3]]));
    expect(r.status).toBe('exact');
    expect(congruent(r.candidates[0].points, truth)).toBe(true);
  });
});

describe('土地作図：角度・座標・組み合わせ', () => {
  it('6. 角度から作図できる（AB=20, BC=15, A=B=C=90°）', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, null, null];
    land.angles = [90, 90, 90, null];
    const r = solveLand(land);
    expect(r.status).toBe('exact');
    expect(polygonArea(r.candidates[0].points)).toBeCloseTo(300, 6);
  });

  it('6b. 度分秒の角度入力を解釈できる', () => {
    expect(parseAngle('90°30\'15"')).toBeCloseTo(90.504166667, 8);
    expect(parseAngle('85-15-00')).toBeCloseTo(85.25, 10);
    expect(parseAngle('95度0分36秒')).toBeCloseTo(95.01, 10);
    expect(parseAngle('abc')).toBeNull();
    expect(formatDMS(90.504166667)).toBe('90°30′15.0″');
  });

  it('7. 座標から作図でき、シューレース公式で面積が正確', () => {
    const land = emptyLand(4);
    land.coords = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 15 }, { x: 5, y: 20 }];
    const r = solveLand(land);
    expect(r.status).toBe('exact');
    expect(polygonArea(r.candidates[0].points)).toBeCloseTo(362.5, 9);
    r.candidates[0].points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(land.coords[i]!.x, 6);
      expect(p.y).toBeCloseTo(land.coords[i]!.y, 6);
    });
  });

  it('8. 複数の入力方式を組み合わせられる（辺＋対角線＋角度＋座標）', () => {
    const truth = [{ x: 100, y: 50 }, { x: 120, y: 50 }, { x: 125, y: 65 }, { x: 105, y: 70 }];
    const land = fromTruth(truth, [[0, 2]]);
    land.angles[1] = interiorAngles(truth)[1];
    land.angles[0] = interiorAngles(truth)[0];
    land.coords[0] = truth[0];
    land.coords[1] = truth[1];
    const r = solveLand(land);
    expect(r.status).toBe('exact');
    r.candidates[0].points.forEach((p, i) => expect(dist(p, truth[i])).toBeLessThan(1e-5));
  });

  it('入力方式を後から座標で補正すると最小二乗の近似解になる', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, 20, 15];
    land.diagonals = [{ id: 'a', a: 0, b: 2, length: 25.004 }, { id: 'b', a: 1, b: 3, length: 24.998 }];
    const r = solveLand(land);
    expect(r.status).toBe('approximate');
    expect(r.candidates[0].maxError).toBeGreaterThan(0);
    expect(r.candidates[0].maxError).toBeLessThan(0.01);
  });
});

describe('土地作図：不足・矛盾・複数解', () => {
  it('9. 辺の長さだけの四角形は不足情報として検出し、図面を生成しない', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, 20, 15];
    const r = solveLand(land);
    expect(r.status).toBe('underdetermined');
    expect(r.missingConstraints).toBe(1);
    expect(r.candidates).toHaveLength(0);
    expect(isDrawable(r)).toBe(false);
  });

  it('9b. 数は足りていても従属な条件（重複入力）を不足として検出', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, 20, 15];
    land.diagonals = [{ id: 'x', a: 0, b: 1, length: 20 }]; // 辺ABと同じ
    const r = solveLand(land);
    expect(r.status).toBe('underdetermined');
  });

  it('10. 三角不等式に反する三角形は矛盾として検出', () => {
    const land = emptyLand(3);
    land.sides = [3, 4, 10];
    const r = solveLand(land);
    expect(r.status).toBe('inconsistent');
  });

  it('10b. 対角線が大きく矛盾する四角形を検出', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, 20, 15];
    land.diagonals = [{ id: 'a', a: 0, b: 2, length: 25 }, { id: 'b', a: 1, b: 3, length: 27 }];
    const r = solveLand(land);
    expect(r.status).toBe('inconsistent');
    expect(r.messages[0]).toContain('矛盾');
  });

  it('10c. 内角の合計の誤りを報告', () => {
    const land = emptyLand(4);
    land.sides = [20, 15, null, null];
    land.angles = [90, 90, 90, 100];
    const r = solveLand(land);
    expect(r.messages.some((m) => m.includes('内角の合計'))).toBe(true);
    expect(r.status).toBe('inconsistent');
  });

  it('複数解（凸形と凹形）を候補として提示する', () => {
    const truth = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 9 }, { x: 0, y: 10 }];
    const r = solveLand(fromTruth(truth, [[1, 3]]));
    expect(r.status).toBe('multiple');
    expect(r.candidates.length).toBe(2);
    const areas = r.candidates.map((c) => polygonArea(c.points)).sort((a, b) => a - b);
    expect(areas[1]).toBeCloseTo(polygonArea(truth), 6);
    expect(r.candidates.some((c) => isConcave(c.points))).toBe(true);
  });

  it('座標3点以上のとき鏡像形状を検出する', () => {
    // 2点の座標 + 辺のみ（三角形）。C は AB の左右どちらにも置ける＝鏡像
    const land = emptyLand(3);
    land.sides = [10, 8, 6];
    land.coords = [{ x: 0, y: 0 }, { x: 10, y: 0 }, null];
    const r = solveLand(land);
    expect(r.status).toBe('multiple');
    expect(r.candidates.some((c) => c.mirrorOf !== undefined)).toBe(true);
  });
});

describe('面積・外周・多角形判定', () => {
  it('11. 凹多角形（L字）の面積が正確', () => {
    const L = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 25 }, { x: 0, y: 25 }];
    expect(polygonArea(L)).toBeCloseTo(30 * 10 + 10 * 15, 10);
    expect(isConcave(L)).toBe(true);
    expect(isConvex(L)).toBe(false);
    const r = solveLand({ ...emptyLand(6), coords: L });
    expect(r.status).toBe('exact');
    expect(landMetrics(r.candidates[0].points).area).toBeCloseTo(450, 8);
  });

  it('12. 外周が正確・坪換算が正確', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(perimeter(sq)).toBeCloseTo(40, 12);
    expect(landMetrics(sq).tsubo).toBeCloseTo(100 / TSUBO_M2, 10);
  });

  it('自己交差を判定する', () => {
    const bow = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(isSelfIntersecting(bow)).toBe(true);
    expect(isSelfIntersecting([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(false);
  });

  it('長さ入力の単位換算（m/cm/mm・全角）', () => {
    expect(parseLength('2500mm', 'm')).toBeCloseTo(2.5, 12);
    expect(parseLength('250', 'cm')).toBeCloseTo(2.5, 12);
    expect(parseLength('２０．５', 'm')).toBeCloseTo(20.5, 12);
  });

  it('頂点編集後に全入力値が整合する', () => {
    const pts = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 22, y: 14 }, { x: 0, y: 15 }];
    const land = landFromPoints(pts, { ...emptyLand(4), diagonals: [{ id: 'd', a: 0, b: 2, length: 1 }] });
    const r = solveLand(land);
    expect(r.status).toBe('exact');
    expect(polygonArea(r.candidates[0].points)).toBeCloseTo(polygonArea(pts), 3);
  });
});
