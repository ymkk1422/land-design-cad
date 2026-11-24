// 下絵（測量図画像）の幾何：画像座標 ↔ 実寸座標、縮尺合わせ、回転補正、トレース寸法、CADとの位置合わせ
import type { LandInput, PxPoint, UnderlayMeta, Vec2 } from '@/types';
import { deg, dist, rad, signedArea } from '@/engine/geometry/polygon';
import { newId } from '@/engine/parking-optimizer/stallOps';

/** 画像座標 → 実寸（ワールド）座標 */
export function pxToWorld(m: Pick<UnderlayMeta, 'scale' | 'rotation' | 'tx' | 'ty'>, p: PxPoint): Vec2 {
  const t = rad(m.rotation);
  const x = m.scale * p.u;
  const y = -m.scale * p.v;
  return { x: m.tx + x * Math.cos(t) - y * Math.sin(t), y: m.ty + x * Math.sin(t) + y * Math.cos(t) };
}

/** 実寸（ワールド）座標 → 画像座標 */
export function worldToPx(m: Pick<UnderlayMeta, 'scale' | 'rotation' | 'tx' | 'ty'>, w: Vec2): PxPoint {
  const t = rad(-m.rotation);
  const dx = w.x - m.tx;
  const dy = w.y - m.ty;
  const x = dx * Math.cos(t) - dy * Math.sin(t);
  const y = dx * Math.sin(t) + dy * Math.cos(t);
  return { u: x / m.scale, v: -y / m.scale };
}

/** 画面表示（表示空間 = (x, −y)）用の SVG matrix(a b c d e f) */
export function displayMatrix(m: Pick<UnderlayMeta, 'scale' | 'rotation' | 'tx' | 'ty'>): [number, number, number, number, number, number] {
  const t = rad(m.rotation);
  const s = m.scale;
  return [s * Math.cos(t), -s * Math.sin(t), s * Math.sin(t), s * Math.cos(t), m.tx, -m.ty];
}

export const pxDist = (a: PxPoint, b: PxPoint): number => Math.hypot(a.u - b.u, a.v - b.v);

/** 基準寸法：画像上の2点間が length(m) → 縮尺 m/px */
export function scaleFromReference(a: PxPoint, b: PxPoint, length: number): number | null {
  const d = pxDist(a, b);
  if (!(d > 1e-6) || !(length > 0)) return null;
  return length / d;
}

/**
 * PDFの図面縮尺：用紙幅 paperMmW のページを pxWidth 画素で描画、縮尺 1/denominator
 * 1px = paperMmW/pxWidth mm（紙上） = その × denominator / 1000 m（実寸）
 */
export function scaleFromPdf(paperMmW: number, pxWidth: number, denominator: number): number {
  return ((paperMmW / pxWidth) * denominator) / 1000;
}

/** スキャン解像度：dpi で読み取った縮尺 1/denominator の図面（rasterScale は表示用ラスタの縮小率） */
export function scaleFromDpi(dpi: number, denominator: number, rasterScale = 1): number {
  return ((25.4 / dpi) * denominator) / 1000 / rasterScale;
}

/** 2点を結ぶ線が実寸で水平（angleDeg=0）／垂直（90）になる回転角 */
export function rotationToAlign(m: Pick<UnderlayMeta, 'rotation'>, a: PxPoint, b: PxPoint, angleDeg = 0): number {
  // 画像上での方向（v を上向きに反転）
  const imgAngle = deg(Math.atan2(-(b.v - a.v), b.u - a.u));
  let r = angleDeg - imgAngle;
  r = ((r % 360) + 540) % 360 - 180;
  void m;
  return r;
}

/** 回転・縮尺を変えたとき、画面上の基点（ワールド座標 pivotW）が動かないよう平行移動を補正 */
export function keepPivot(old: UnderlayMeta, next: Pick<UnderlayMeta, 'scale' | 'rotation'>, pivotW: Vec2): { tx: number; ty: number } {
  const px = worldToPx(old, pivotW);
  const moved = pxToWorld({ ...next, tx: 0, ty: 0 }, px);
  return { tx: pivotW.x - moved.x, ty: pivotW.y - moved.y };
}

export interface TraceReading {
  label: string;
  a: number;
  b: number;
  kind: 'side' | 'diagonal';
  /** 画像からの読取値（m） */
  measured: number;
  /** 読取の不確かさ（±m）：1点あたり ±pxTol 画素の配置誤差を想定 */
  uncertainty: number;
}

/** トレースした頂点の寸法読取：全辺＋形状確定に必要な対角線（頂点Aからの扇形、n−3本） */
export function traceReadings(m: Pick<UnderlayMeta, 'scale'>, pts: PxPoint[], pxTol = 2): TraceReading[] {
  const n = pts.length;
  const name = (i: number): string => String.fromCharCode(65 + i);
  const out: TraceReading[] = [];
  const unc = Math.SQRT2 * pxTol * m.scale;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push({ label: `${name(i)}${name(j)}`, a: i, b: j, kind: 'side', measured: pxDist(pts[i], pts[j]) * m.scale, uncertainty: unc });
  }
  for (let j = 2; j <= n - 2; j++) out.push({ label: `A${name(j)}`, a: 0, b: j, kind: 'diagonal', measured: pxDist(pts[0], pts[j]) * m.scale, uncertainty: unc });
  return out;
}

/**
 * 実寸で反時計回りになるよう頂点順を正規化（A は固定）。
 * 時計回りのまま辺長だけで解くと鏡像の土地になってしまうため。
 */
export function normalizeTraceOrder(m: Pick<UnderlayMeta, 'scale' | 'rotation' | 'tx' | 'ty'>, pts: PxPoint[]): { pts: PxPoint[]; reversed: boolean } {
  const w = pts.map((p) => pxToWorld(m, p));
  if (signedArea(w) >= 0) return { pts, reversed: false };
  return { pts: [pts[0], ...pts.slice(1).reverse()], reversed: true };
}

/** 確認済みの寸法から土地入力を作る（座標は入れず、寸法のみ。形状はソルバーで計算） */
export function landFromReadings(n: number, values: { a: number; b: number; kind: 'side' | 'diagonal'; value: number }[], base: LandInput): LandInput {
  const sides: (number | null)[] = new Array(n).fill(null);
  const diagonals = [];
  for (const v of values) {
    if (v.kind === 'side') sides[v.a] = v.value;
    else diagonals.push({ id: newId('d'), a: v.a, b: v.b, length: v.value });
  }
  return { ...base, vertexCount: n, sides, diagonals, angles: new Array(n).fill(null), coords: new Array(n).fill(null) };
}

/**
 * 相似変換（回転・一様縮尺・平行移動、鏡映なし）で src を dst に最小二乗で合わせる。
 * 下絵をCAD形状に重ねるために使用。
 */
export function fitSimilarity(src: Vec2[], dst: Vec2[]): { k: number; theta: number; tx: number; ty: number; rms: number; max: number } {
  const n = src.length;
  const cs = { x: src.reduce((a, p) => a + p.x, 0) / n, y: src.reduce((a, p) => a + p.y, 0) / n };
  const cd = { x: dst.reduce((a, p) => a + p.x, 0) / n, y: dst.reduce((a, p) => a + p.y, 0) / n };
  let sxx = 0, sxy = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const a = { x: src[i].x - cs.x, y: src[i].y - cs.y };
    const b = { x: dst[i].x - cd.x, y: dst[i].y - cd.y };
    sxx += a.x * b.x + a.y * b.y;
    sxy += a.x * b.y - a.y * b.x;
    ss += a.x * a.x + a.y * a.y;
  }
  const theta = Math.atan2(sxy, sxx);
  const k = ss > 0 ? Math.hypot(sxx, sxy) / ss : 1;
  const c = Math.cos(theta), s = Math.sin(theta);
  const tx = cd.x - k * (c * cs.x - s * cs.y);
  const ty = cd.y - k * (s * cs.x + c * cs.y);
  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const q = { x: tx + k * (c * src[i].x - s * src[i].y), y: ty + k * (s * src[i].x + c * src[i].y) };
    const e = dist(q, dst[i]);
    sum += e * e;
    max = Math.max(max, e);
  }
  return { k, theta, tx, ty, rms: Math.sqrt(sum / n), max };
}

/** 位置合わせ結果を下絵の変換に反映（下絵を動かしてCADに重ねる） */
export function applyFit(m: UnderlayMeta, fit: { k: number; theta: number; tx: number; ty: number }): Pick<UnderlayMeta, 'scale' | 'rotation' | 'tx' | 'ty'> {
  const c = Math.cos(fit.theta), s = Math.sin(fit.theta);
  return {
    scale: m.scale * fit.k,
    rotation: m.rotation + deg(fit.theta),
    tx: fit.tx + fit.k * (c * m.tx - s * m.ty),
    ty: fit.ty + fit.k * (s * m.tx + c * m.ty),
  };
}

export function newUnderlay(p: { originalAssetId: string; displayAssetId: string; fileName: string; source: UnderlayMeta['source']; pxWidth: number; pxHeight: number; rasterScale: number; pdfPage?: number; pdfPageCount?: number; paperMm?: { w: number; h: number } }): UnderlayMeta {
  return {
    ...p,
    // 縮尺未設定の仮値：画像の幅を 40m として表示（基準寸法で必ず合わせる）
    scale: 40 / p.pxWidth,
    scaleMethod: 'none',
    rotation: 0,
    tx: 0,
    ty: (40 / p.pxWidth) * p.pxHeight,
    opacity: 0.6,
    visible: true,
    locked: false,
    calibration: null,
    trace: [],
    measure: [],
  };
}
