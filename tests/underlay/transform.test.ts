import { describe, expect, it } from 'vitest';
import type { UnderlayMeta } from '@/types';
import {
  applyFit, displayMatrix, fitSimilarity, keepPivot, landFromReadings, newUnderlay, normalizeTraceOrder, pxToWorld,
  rotationToAlign, scaleFromDpi, scaleFromPdf, scaleFromReference, traceReadings, worldToPx,
} from '@/engine/underlay/transform';
import { solveLand } from '@/engine/constraints/solver';
import { emptyLand } from '@/services/projectFactory';
import { dist, polygonArea } from '@/engine/geometry/polygon';

const base = (): UnderlayMeta => newUnderlay({ originalAssetId: 'o', displayAssetId: 'd', fileName: 'a.png', source: 'image/png', pxWidth: 2000, pxHeight: 1500, rasterScale: 1 });

describe('下絵の座標変換', () => {
  it('画像座標 ↔ 実寸座標が往復で一致（回転・縮尺・平行移動あり）', () => {
    const m = { ...base(), scale: 0.0125, rotation: 23.5, tx: 4, ty: -7 };
    const p = { u: 812.3, v: 401.9 };
    const q = worldToPx(m, pxToWorld(m, p));
    expect(q.u).toBeCloseTo(p.u, 9);
    expect(q.v).toBeCloseTo(p.v, 9);
  });
  it('画面表示用の行列は表示空間 (x,−y) への変換と一致', () => {
    const m = { ...base(), scale: 0.02, rotation: -31, tx: 3, ty: 5 };
    const [a, b, c, d, e, f] = displayMatrix(m);
    const p = { u: 100, v: 250 };
    const w = pxToWorld(m, p);
    expect(a * p.u + c * p.v + e).toBeCloseTo(w.x, 9);
    expect(b * p.u + d * p.v + f).toBeCloseTo(-w.y, 9);
  });
  it('画像の下方向は実寸では南（y 減少）', () => {
    const m = { ...base(), scale: 0.01, rotation: 0, tx: 0, ty: 0 };
    expect(pxToWorld(m, { u: 0, v: 100 }).y).toBeCloseTo(-1, 12);
  });
});

describe('縮尺合わせ', () => {
  it('基準寸法：1600px が 20m → 0.0125 m/px', () => {
    expect(scaleFromReference({ u: 200, v: 1300 }, { u: 1800, v: 1300 }, 20)).toBeCloseTo(0.0125, 12);
    expect(scaleFromReference({ u: 1, v: 1 }, { u: 1, v: 1 }, 20)).toBeNull();
    expect(scaleFromReference({ u: 0, v: 0 }, { u: 10, v: 0 }, 0)).toBeNull();
  });
  it('PDF の図面縮尺：A3横(420mm)を 4200px で描画、1/250 → 1px=0.1mm=0.025m', () => {
    expect(scaleFromPdf(420, 4200, 250)).toBeCloseTo(0.025, 12);
  });
  it('スキャン解像度：300dpi・1/500、表示用に 1/2 縮小 → 1px = 25.4/300·500/1000·2 m', () => {
    expect(scaleFromDpi(300, 500, 0.5)).toBeCloseTo((25.4 / 300) * 0.5 * 2, 12);
  });
});

describe('回転補正', () => {
  it('2点が水平になる回転角を求め、適用後は同じ高さになる', () => {
    const m = { ...base(), scale: 0.01 };
    const a = { u: 100, v: 900 };
    const b = { u: 1700, v: 760 }; // 右上がり
    const r = rotationToAlign(m, a, b, 0);
    const m2 = { ...m, rotation: r };
    expect(pxToWorld(m2, a).y).toBeCloseTo(pxToWorld(m2, b).y, 9);
    expect(pxToWorld(m2, b).x).toBeGreaterThan(pxToWorld(m2, a).x);
    const v = rotationToAlign(m, a, b, 90);
    expect(pxToWorld({ ...m, rotation: v }, a).x).toBeCloseTo(pxToWorld({ ...m, rotation: v }, b).x, 9);
  });
  it('回転・縮尺変更時に基点が画面上で動かない', () => {
    const m = { ...base(), scale: 0.01, rotation: 10, tx: 2, ty: 3 };
    const pivot = pxToWorld(m, { u: 500, v: 500 });
    const next = { scale: 0.02, rotation: 40 };
    const t = keepPivot(m, next, pivot);
    const after = pxToWorld({ ...m, ...next, ...t }, { u: 500, v: 500 });
    expect(after.x).toBeCloseTo(pivot.x, 9);
    expect(after.y).toBeCloseTo(pivot.y, 9);
  });
});

describe('トレースから作図', () => {
  const m = { ...base(), scale: 0.0125, rotation: 0, tx: 0, ty: 0 };
  const rect = [{ u: 200, v: 1300 }, { u: 1800, v: 1300 }, { u: 1800, v: 100 }, { u: 200, v: 100 }];
  it('頂点間距離（全辺＋対角線）と読取誤差', () => {
    const r = traceReadings(m, rect);
    expect(r.map((x) => x.label)).toEqual(['AB', 'BC', 'CD', 'DA', 'AC']);
    expect(r[0].measured).toBeCloseTo(20, 9);
    expect(r[1].measured).toBeCloseTo(15, 9);
    expect(r[4].measured).toBeCloseTo(25, 9);
    expect(r[0].uncertainty).toBeCloseTo(Math.SQRT2 * 2 * 0.0125, 12);
  });
  it('時計回りにトレースした場合は反時計回りに並べ替え（鏡像防止、A は固定）', () => {
    const cw = [rect[0], rect[3], rect[2], rect[1]];
    const r = normalizeTraceOrder(m, cw);
    expect(r.reversed).toBe(true);
    expect(r.pts).toEqual(rect);
    expect(normalizeTraceOrder(m, rect).reversed).toBe(false);
  });
  it('確認済み寸法から土地を作成すると、トレース形状と合同な厳密解になる（五角形）', () => {
    const pent = [{ u: 100, v: 900 }, { u: 900, v: 950 }, { u: 1100, v: 500 }, { u: 700, v: 150 }, { u: 150, v: 400 }];
    const { pts } = normalizeTraceOrder(m, pent);
    const vals = traceReadings(m, pts).map((x) => ({ ...x, value: Math.round(x.measured * 1000) / 1000 }));
    const land = landFromReadings(5, vals, emptyLand(5));
    expect(land.diagonals).toHaveLength(2);
    const sol = solveLand({ ...land, tolerance: 0.01 });
    expect(['exact', 'approximate', 'multiple']).toContain(sol.status);
    const w = pts.map((p) => pxToWorld(m, p));
    const cand = sol.candidates.find((c) => c.points.every((p, i) => c.points.every((q, j) => Math.abs(dist(p, q) - dist(w[i], w[j])) < 0.01)));
    expect(cand).toBeTruthy();
    expect(polygonArea(cand!.points)).toBeCloseTo(polygonArea(w), 1);
  });
  it('下絵をCAD形状に位置合わせ（相似変換）', () => {
    const w = rect.map((p) => pxToWorld(m, p));
    // CAD は A を原点・AB 水平、かつ寸法が 0.5% 大きい（ユーザーが修正した想定）
    const dst = w.map((p) => ({ x: (p.x - w[0].x) * 1.005, y: (p.y - w[0].y) * 1.005 }));
    const fit = fitSimilarity(w, dst);
    expect(fit.k).toBeCloseTo(1.005, 9);
    expect(fit.max).toBeLessThan(1e-9);
    const m2 = { ...m, ...applyFit(m, fit) };
    rect.forEach((p, i) => {
      const q = pxToWorld(m2, p);
      expect(q.x).toBeCloseTo(dst[i].x, 9);
      expect(q.y).toBeCloseTo(dst[i].y, 9);
    });
  });
});
