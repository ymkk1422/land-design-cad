// 土地形状 制約ソルバー
// 辺長・対角線・内角・座標を同時に扱い、レーベンバーグ・マーカート法（非線形最小二乗）で解く。
// - 自由度（ヤコビ行列のランク）で形状が一意に決まるかを判定
// - マルチスタート探索で複数解（凹凸の反転・折り返し）と鏡像を検出
// - 残差で厳密解／近似解（測量誤差内）／矛盾を区別
import type { ConstraintResidual, LandInput, SolutionCandidate, SolveResult, Vec2 } from '@/types';
import {
  deg,
  dist,
  interiorAngleAt,
  isConvex,
  isSelfIntersecting,
  rad,
  signedArea,
  vertexName,
} from '@/engine/geometry/polygon';
import { mulberry32, normalEquations, numericRank, solveLinear, type Matrix } from '@/engine/geometry/linalg';

interface Row {
  kind: ConstraintResidual['kind'] | 'gauge';
  label: string;
  target: number;
  /** 残差と勾配（2n成分のうち非ゼロ）を計算 */
  eval: (X: number[]) => { r: number; grad: [number, number][]; actual: number };
}

const TWO_PI = 2 * Math.PI;

function wrapPi(a: number): number {
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  if (x < -Math.PI) x += TWO_PI;
  return x;
}

export interface SolveOptions {
  /**
   * 形状のヒント（前回選択していた形状、下絵からトレースした形状など）。
   * 最初の探索初期値に使い、複数解のときはヒントに最も近い形状を候補の先頭にする。
   * 寸法を少し直しただけで別の解（三角形の折り返し）へ形状が飛ぶのを防ぐ。
   */
  hint?: Vec2[] | null;
  /** 表示する候補の上限 */
  maxCandidates?: number;
  /** 探索の時間予算（ms）。少なくとも1つ解が得られた後に適用。既定 700ms（画面が固まらないように） */
  timeBudgetMs?: number;
  starts?: number;
  seed?: number;
  maxIterations?: number;
}

export function validateLandInput(land: LandInput): string[] {
  const errs: string[] = [];
  const n = land.vertexCount;
  if (!Number.isInteger(n) || n < 3) errs.push('頂点数は3以上の整数にしてください。');
  if (n > 40) errs.push('頂点数は40以下にしてください。');
  land.sides.forEach((s, i) => {
    if (s !== null && !(Number.isFinite(s) && s > 0)) errs.push(`辺${vertexName(i)}${vertexName((i + 1) % n)}の長さが不正です。`);
  });
  land.diagonals.forEach((d) => {
    if (d.a === d.b || d.a < 0 || d.b < 0 || d.a >= n || d.b >= n) errs.push('対角線の頂点指定が不正です。');
    else if (!(Number.isFinite(d.length) && d.length > 0)) errs.push(`対角線${vertexName(d.a)}${vertexName(d.b)}の長さが不正です。`);
  });
  land.angles.forEach((a, i) => {
    if (a !== null && !(Number.isFinite(a) && a > 0 && a < 360)) errs.push(`頂点${vertexName(i)}の角度は0〜360度の範囲で入力してください。`);
  });
  land.coords.forEach((c, i) => {
    if (c && !(Number.isFinite(c.x) && Number.isFinite(c.y))) errs.push(`頂点${vertexName(i)}の座標が不正です。`);
  });
  if (!(land.tolerance >= 0)) errs.push('許容誤差が不正です。');
  return errs;
}

function buildRows(land: LandInput, lengthScale: number, ccw: boolean): { rows: Row[]; gauge: number } {
  const n = land.vertexCount;
  const rows: Row[] = [];
  const P = (X: number[], i: number): Vec2 => ({ x: X[2 * i], y: X[2 * i + 1] });

  const distRow = (kind: 'side' | 'diagonal', i: number, j: number, L: number): Row => ({
    kind,
    label: `${vertexName(i)}${vertexName(j)}`,
    target: L,
    eval: (X) => {
      const a = P(X, i);
      const b = P(X, j);
      const d = Math.max(dist(a, b), 1e-12);
      const ux = (a.x - b.x) / d;
      const uy = (a.y - b.y) / d;
      return { r: d - L, actual: d, grad: [[2 * i, ux], [2 * i + 1, uy], [2 * j, -ux], [2 * j + 1, -uy]] };
    },
  });

  land.sides.forEach((s, i) => {
    if (s !== null) rows.push(distRow('side', i, (i + 1) % n, s));
  });
  land.diagonals.forEach((d) => rows.push(distRow('diagonal', d.a, d.b, d.length)));

  land.angles.forEach((angDeg, i) => {
    if (angDeg === null) return;
    const ip = (i - 1 + n) % n;
    const inx = (i + 1) % n;
    const target = rad(angDeg);
    const sgn = ccw ? 1 : -1;
    rows.push({
      kind: 'angle',
      label: vertexName(i),
      target: angDeg,
      eval: (X) => {
        const p = P(X, i);
        const a = { x: X[2 * inx] - p.x, y: X[2 * inx + 1] - p.y };
        const b = { x: X[2 * ip] - p.x, y: X[2 * ip + 1] - p.y };
        const phiA = Math.atan2(a.y, a.x);
        const phiB = Math.atan2(b.y, b.x);
        let theta = phiB - phiA; // a から b へ反時計回り
        theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
        const interior = ccw ? theta : TWO_PI - theta;
        const la = Math.max(a.x * a.x + a.y * a.y, 1e-18);
        const lb = Math.max(b.x * b.x + b.y * b.y, 1e-18);
        // dθ/da = (ay, -ax)/|a|², dθ/db = (-by, bx)/|b|²
        const dax = (a.y / la) * sgn * lengthScale;
        const day = (-a.x / la) * sgn * lengthScale;
        const dbx = (-b.y / lb) * sgn * lengthScale;
        const dby = (b.x / lb) * sgn * lengthScale;
        return {
          r: wrapPi(interior - target) * lengthScale,
          actual: deg(interior),
          grad: [
            [2 * inx, dax],
            [2 * inx + 1, day],
            [2 * ip, dbx],
            [2 * ip + 1, dby],
            [2 * i, -(dax + dbx)],
            [2 * i + 1, -(day + dby)],
          ],
        };
      },
    });
  });

  const coordIdx: number[] = [];
  land.coords.forEach((c, i) => {
    if (!c) return;
    coordIdx.push(i);
    rows.push({
      kind: 'coord',
      label: `${vertexName(i)}.X`,
      target: c.x,
      eval: (X) => ({ r: X[2 * i] - c.x, actual: X[2 * i], grad: [[2 * i, 1]] }),
    });
    rows.push({
      kind: 'coord',
      label: `${vertexName(i)}.Y`,
      target: c.y,
      eval: (X) => ({ r: X[2 * i + 1] - c.y, actual: X[2 * i + 1], grad: [[2 * i + 1, 1]] }),
    });
  });

  // ゲージ固定（剛体移動の自由度を除去）
  let gauge = 0;
  if (coordIdx.length === 0) {
    rows.push({ kind: 'gauge', label: 'A.x=0', target: 0, eval: (X) => ({ r: X[0], actual: X[0], grad: [[0, 1]] }) });
    rows.push({ kind: 'gauge', label: 'A.y=0', target: 0, eval: (X) => ({ r: X[1], actual: X[1], grad: [[1, 1]] }) });
    rows.push({ kind: 'gauge', label: 'AB水平', target: 0, eval: (X) => ({ r: X[3] - X[1], actual: X[3], grad: [[3, 1], [1, -1]] }) });
    gauge = 3;
  } else if (coordIdx.length === 1) {
    const c = coordIdx[0];
    const nx = (c + 1) % n;
    rows.push({
      kind: 'gauge',
      label: '辺方向固定',
      target: 0,
      eval: (X) => ({ r: X[2 * nx + 1] - X[2 * c + 1], actual: 0, grad: [[2 * nx + 1, 1], [2 * c + 1, -1]] }),
    });
    gauge = 1;
  }
  return { rows, gauge };
}

function evaluate(rows: Row[], X: number[], cols: number): { r: number[]; J: Matrix } {
  const r: number[] = [];
  const J: Matrix = [];
  for (const row of rows) {
    const e = row.eval(X);
    r.push(e.r);
    const line = new Array<number>(cols).fill(0);
    for (const [k, v] of e.grad) line[k] += v;
    J.push(line);
  }
  return { r, J };
}

const cost = (r: number[]): number => r.reduce((s, v) => s + v * v, 0);

/** 残差と疎なヤコビ行列（各行の非ゼロは最大6個）から正規方程式 JᵀJ・Jᵀr を直接組み立てる */
function sparseNormal(rows: Row[], X: number[], cols: number): { A: Matrix; g: number[]; c: number } {
  const A: Matrix = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const g = new Array<number>(cols).fill(0);
  let c = 0;
  for (const row of rows) {
    const e = row.eval(X);
    c += e.r * e.r;
    const gr = e.grad;
    for (let a = 0; a < gr.length; a++) {
      const [i, vi] = gr[a];
      g[i] += vi * e.r;
      for (let b = 0; b < gr.length; b++) A[i][gr[b][0]] += vi * gr[b][1];
    }
  }
  return { A, g, c };
}

function costOnly(rows: Row[], X: number[]): number {
  let c = 0;
  for (const row of rows) {
    const r = row.eval(X).r;
    c += r * r;
  }
  return c;
}

function levenbergMarquardt(rows: Row[], X0: number[], maxIter: number): { X: number[]; cost: number } {
  const cols = X0.length;
  let X = X0.slice();
  let { A, g, c } = sparseNormal(rows, X, cols);
  let lambda = 1e-3;
  for (let it = 0; it < maxIter; it++) {
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v + 1e-9) : v)));
      const step = solveLinear(M, g.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const Xn = X.map((v, i) => v + step[i]);
      const cn = costOnly(rows, Xn);
      if (cn < c) {
        const stepNorm = Math.sqrt(step.reduce((s2, v) => s2 + v * v, 0));
        const rel = (c - cn) / Math.max(c, 1e-300);
        X = Xn;
        ({ A, g, c } = sparseNormal(rows, X, cols));
        lambda = Math.max(lambda / 3, 1e-12);
        improved = true;
        if (stepNorm < 1e-12 || c < 1e-26 || rel < 1e-15) return { X, cost: c };
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { X, cost: c };
}

/** 初期形状：入力済みの辺・角度で折れ線をたどる（未入力は平均値・正多角形角で補完） */
function traverseInitial(land: LandInput, rand: () => number | null, angleNoiseDeg: number, meanSide: number): number[] {
  const n = land.vertexCount;
  const regular = ((n - 2) * 180) / n;
  const pts: Vec2[] = [{ x: 0, y: 0 }];
  let heading = 0;
  for (let i = 0; i < n - 1; i++) {
    const L = land.sides[i] ?? meanSide;
    const noiseL = rand ? (rand()! - 0.5) * 0.4 * L : 0;
    const p = pts[i];
    pts.push({ x: p.x + Math.cos(heading) * (L + noiseL), y: p.y + Math.sin(heading) * (L + noiseL) });
    const ang = land.angles[(i + 1) % n] ?? regular;
    const noise = rand ? (rand()! - 0.5) * 2 * angleNoiseDeg : 0;
    // 凹頂点の探索のため確率的に反転
    const a = rand && land.angles[(i + 1) % n] === null && rand()! < 0.2 ? 360 - ang : ang;
    heading += Math.PI - rad(a + noise);
  }
  return pts.flatMap((p) => [p.x, p.y]);
}

function placeCoords(X: number[], land: LandInput): number[] {
  // 座標入力済みの頂点がある場合、初期形状をその位置へ合わせる（最初の座標点で平行移動）
  const idx = land.coords.findIndex((c) => c !== null);
  if (idx < 0) return X;
  const c = land.coords[idx]!;
  const dx = c.x - X[2 * idx];
  const dy = c.y - X[2 * idx + 1];
  const Y = X.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
  land.coords.forEach((cc, i) => {
    if (cc) {
      Y[2 * i] = cc.x;
      Y[2 * i + 1] = cc.y;
    }
  });
  return Y;
}

function toPoints(X: number[]): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < X.length; i += 2) pts.push({ x: X[i], y: X[i + 1] });
  return pts;
}

/** ゲージ固定時の鏡像を反時計回りへ正規化 */
function normalizeOrientation(input: Vec2[], land: LandInput): Vec2[] {
  const k = land.coords.filter(Boolean).length;
  if (k >= 2) return input; // 座標で向きが確定
  let pts = input;
  // ゲージ辺の向き（180°回転の不定性）を正規化
  {
    const ci = k === 1 ? land.coords.findIndex(Boolean) : 0;
    const nx = (ci + 1) % pts.length;
    if (pts[nx].x < pts[ci].x) {
      const o = pts[ci];
      pts = pts.map((p) => ({ x: 2 * o.x - p.x, y: 2 * o.y - p.y }));
    }
  }
  if (signedArea(pts) >= 0) return pts;
  const hasAngles = land.angles.some((a) => a !== null);
  if (hasAngles) return pts; // 角度は向き依存なので解として扱わない（後で残差で除外）
  const ci = k === 1 ? land.coords.findIndex(Boolean) : 0;
  const y0 = pts[ci].y;
  return pts.map((p) => ({ x: p.x, y: 2 * y0 - p.y }));
}

function residualReport(rows: Row[], X: number[]): ConstraintResidual[] {
  return rows
    .filter((r) => r.kind !== 'gauge')
    .map((row) => {
      const e = row.eval(X);
      const isAngle = row.kind === 'angle';
      let error = e.actual - row.target;
      if (isAngle) error = deg(wrapPi(rad(error)));
      return { kind: row.kind as ConstraintResidual['kind'], label: row.label, target: row.target, actual: e.actual, error };
    });
}

function pairwiseSignature(pts: Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) out.push(dist(pts[i], pts[j]));
  return out;
}

/** 入力から必要な独立条件数（2n-3）に対する現在の条件数 */
export function constraintSummary(land: LandInput): { count: number; required: number } {
  const n = land.vertexCount;
  const k = land.coords.filter(Boolean).length;
  const count =
    land.sides.filter((s) => s !== null).length +
    land.diagonals.length +
    land.angles.filter((a) => a !== null).length +
    2 * k;
  // 座標が2点以上あれば剛体自由度も確定させる必要がある
  const required = k >= 2 ? 2 * n : k === 1 ? 2 * n - 1 : 2 * n - 3;
  return { count, required };
}

export function solveLand(land: LandInput, opts: SolveOptions = {}): SolveResult {
  const n = land.vertexCount;
  const solvedAt = new Date().toISOString();
  const errors = validateLandInput(land);
  const { count, required } = constraintSummary(land);
  if (errors.length) {
    return { status: 'invalid', candidates: [], missingConstraints: 0, constraintCount: count, rank: 0, messages: errors, solvedAt };
  }
  const messages: string[] = [];

  // 内角の和チェック
  if (land.angles.every((a) => a !== null)) {
    const sum = (land.angles as number[]).reduce((s, a) => s + a, 0);
    const expected = (n - 2) * 180;
    if (Math.abs(sum - expected) > 1e-6) {
      messages.push(`内角の合計が${sum.toFixed(4)}°です（${n}角形の理論値は${expected}°、差${(sum - expected).toFixed(4)}°）。`);
    }
  }

  const givenLengths = [...land.sides.filter((s): s is number => s !== null), ...land.diagonals.map((d) => d.length)];
  const coordPts = land.coords.filter((c): c is Vec2 => c !== null);
  let meanSide = givenLengths.length ? givenLengths.reduce((s, v) => s + v, 0) / givenLengths.length : 10;
  if (!givenLengths.length && coordPts.length >= 2) meanSide = dist(coordPts[0], coordPts[1]);
  const lengthScale = Math.max(meanSide, 1e-3);

  // 向き：座標3点以上なら与えられた順序の向き、それ以外は反時計回り
  let ccw = true;
  if (coordPts.length >= 3) {
    const ordered = land.coords.map((c, i) => (c ? { ...c, i } : null)).filter(Boolean) as (Vec2 & { i: number })[];
    ccw = signedArea(ordered) >= 0;
  }

  const { rows, gauge } = buildRows(land, lengthScale, ccw);
  const cols = 2 * n;

  if (count < required) {
    const missing = required - count;
    messages.unshift(
      `形状を確定するには独立した寸法があと${missing}個必要です（現在${count}個／必要${required}個）。対角線・角度・座標のいずれかを追加してください。`,
    );
    return { status: 'underdetermined', candidates: [], missingConstraints: missing, constraintCount: count, rank: 0, messages, solvedAt };
  }

  const starts = opts.starts ?? Math.min(80, 24 + 6 * n);
  const rand = mulberry32(opts.seed ?? 12345);
  const maxIter = opts.maxIterations ?? 200;

  const hint = opts.hint && opts.hint.length === n && opts.hint.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? opts.hint : null;
  const raw: { X: number[]; cost: number }[] = [];
  // 早期終了：新しい厳密解（または最良解の改善）が16回続けて見つからなければ打ち切る
  const exactTolEarly = 1e-7 * lengthScale;
  const foundSig: number[][] = [];
  let bestCost = Infinity;
  let lastProgress = 0;
  const tStart = Date.now();
  const budget = opts.timeBudgetMs ?? 700;
  let budgetHit = false;
  for (let s = 0; s < starts; s++) {
    let X0: number[];
    if (s === 0 && hint) X0 = hint.flatMap((p) => [p.x, p.y]);
    else if (s === 0 || (s === 1 && hint)) X0 = traverseInitial(land, () => null, 0, meanSide);
    else if (s === 1) {
      const R = meanSide / (2 * Math.sin(Math.PI / n));
      X0 = Array.from({ length: n }, (_, i) => [R * Math.cos((TWO_PI * i) / n - Math.PI / 2), R * Math.sin((TWO_PI * i) / n - Math.PI / 2)]).flat();
    } else if (s % 4 === 3) {
      X0 = Array.from({ length: 2 * n }, () => (rand() - 0.5) * meanSide * 2);
    } else {
      X0 = traverseInitial(land, rand, 40 + (s % 3) * 25, meanSide);
    }
    if (!(s === 0 && hint)) X0 = placeCoords(X0, land);
    const r = levenbergMarquardt(rows, X0, maxIter);
    raw.push(r);
    const rms = Math.sqrt(r.cost / Math.max(1, rows.length));
    if (rms <= exactTolEarly * 10) {
      const sig = pairwiseSignature(normalizeOrientation(toPoints(r.X), land));
      if (!foundSig.some((f) => f.every((v, k) => Math.abs(v - sig[k]) < 1e-5 * lengthScale))) {
        foundSig.push(sig);
        lastProgress = s;
      }
    } else if (r.cost < bestCost * (1 - 1e-6)) lastProgress = s;
    bestCost = Math.min(bestCost, r.cost);
    if (s >= 20 && s - lastProgress >= 16) break;
    if (s >= 8 && foundSig.length > 0 && Date.now() - tStart > budget) {
      budgetHit = true;
      break;
    }
  }

  raw.sort((a, b) => a.cost - b.cost);
  const realRows = rows.length;
  const best = raw[0];
  const bestRms = Math.sqrt(best.cost / Math.max(1, realRows));
  const exactTol = 1e-7 * lengthScale;

  // 独立な寸法の数（ランク）の判定。
  // 寸法を満たす解が得られた場合はその点で判定する（その形状が動かせるか）。
  // 満たす解が無い（矛盾）場合、最小二乗解は三角形が潰れた退化形になりやすく、その点のランクは
  // 本来より低く出るため「不足」と誤判定してしまう。そこで一般の位置（複数の試行点）での最大ランクで判定する。
  const fitsSomewhere = bestRms <= Math.max(exactTol * 10, land.tolerance);
  let rank = numericRank(evaluate(rows, best.X, cols).J, cols, 1e-10);
  if (!fitsSomewhere && rank < cols) {
    for (const r of raw.slice(1, 6)) rank = Math.max(rank, numericRank(evaluate(rows, r.X, cols).J, cols, 1e-10));
    for (let k = 0; k < 4 && rank < cols; k++) rank = Math.max(rank, numericRank(evaluate(rows, placeCoords(traverseInitial(land, rand, 30, meanSide), land), cols).J, cols, 1e-10));
  }
  if (rank < cols) {
    const missing = cols - rank;
    messages.unshift(
      `寸法の数は足りていますが、一部が従属しているため形状が一意に決まりません（不足${missing}自由度）。別の対角線・角度・座標を追加してください。`,
    );
    return { status: 'underdetermined', candidates: [], missingConstraints: missing, constraintCount: count, rank, messages, solvedAt };
  }

  const buildCandidate = (X: number[]): SolutionCandidate => {
    const pts = normalizeOrientation(toPoints(X), land);
    const Xn = pts.flatMap((p) => [p.x, p.y]);
    const res = residualReport(rows, Xn);
    const lenErr = res.filter((r) => r.kind !== 'angle').map((r) => Math.abs(r.error));
    const angErr = res.filter((r) => r.kind === 'angle').map((r) => Math.abs(r.error));
    const { r } = evaluate(rows, Xn, cols);
    return {
      points: pts,
      rms: Math.sqrt(cost(r.slice(0, r.length - gauge)) / Math.max(1, r.length - gauge)),
      maxError: lenErr.length ? Math.max(...lenErr) : 0,
      maxAngleError: angErr.length ? Math.max(...angErr) : 0,
      residuals: res,
      selfIntersecting: isSelfIntersecting(pts),
    };
  };

  let status: SolveResult['status'];
  let candidates: SolutionCandidate[] = [];

  if (bestRms <= exactTol) {
    // 厳密解をすべて収集して重複除去
    const exact = raw.filter((r) => Math.sqrt(r.cost / Math.max(1, realRows)) <= exactTol * 10).map((r) => buildCandidate(r.X));
    const uniq: SolutionCandidate[] = [];
    const tolPt = 1e-5 * lengthScale;
    for (const c of exact) {
      if (uniq.some((u) => u.points.every((p, i) => dist(p, c.points[i]) < tolPt))) continue;
      uniq.push(c);
    }
    const simple = uniq.filter((c) => !c.selfIntersecting);
    // 並び順：ヒントがあれば最も近い形状を先頭、なければ凸形状→面積の大きい順（一般的な土地を先に）
    if (hint) {
      const hs = pairwiseSignature(hint);
      const d = (c: SolutionCandidate): number => pairwiseSignature(c.points).reduce((a, v, k) => a + Math.abs(v - hs[k]), 0);
      simple.sort((a, b) => d(a) - d(b));
    } else {
      simple.sort((a, b) => Number(isConvex(b.points)) - Number(isConvex(a.points)) || Math.abs(signedArea(b.points)) - Math.abs(signedArea(a.points)));
    }
    const maxC = opts.maxCandidates ?? 12;
    const total = simple.length;
    if (simple.length > maxC) simple.length = maxC;
    if (budgetHit && simple.length > 1) messages.push('候補が多いため探索を時間内で打ち切りました。他にも形状の候補が存在する可能性があります。');
    if (!simple.length) {
      status = 'inconsistent';
      candidates = uniq.slice(0, 1);
      messages.unshift('寸法を満たす形状は辺が交差してしまいます（自己交差）。入力値を確認してください。');
    } else {
      // 鏡像判定（全頂点間距離が一致＝合同）
      simple.forEach((c, i) => {
        const sig = pairwiseSignature(c.points);
        for (let j = 0; j < i; j++) {
          const sj = pairwiseSignature(simple[j].points);
          if (sig.every((v, k) => Math.abs(v - sj[k]) < 1e-5 * lengthScale)) {
            c.mirrorOf = j;
            break;
          }
        }
      });
      candidates = simple;
      status = simple.length > 1 ? 'multiple' : 'exact';
      if (simple.length > 1) {
        messages.unshift(
          total > simple.length
            ? `寸法を満たす形状が${total}通り以上見つかりました（表示は${hint ? '現在の形状に近い' : '凸形状・面積の大きい'}順に${simple.length}件）。角度・座標を追加して一意にしてください。`
            : `寸法を満たす形状が${simple.length}通りあります。候補から正しい形状を選ぶか、対角線・角度を追加して一意にしてください。`,
        );
        if (simple.some((c) => c.mirrorOf !== undefined)) messages.push('候補の中に鏡像（左右反転）形状が含まれます。');
      }
      if (uniq.length > simple.length) messages.push(`自己交差する解${uniq.length - simple.length}件は除外しました。`);
    }
  } else {
    const c = buildCandidate(best.X);
    candidates = [c];
    const angTolDeg = deg(land.tolerance / lengthScale);
    if (c.selfIntersecting) {
      status = 'inconsistent';
      messages.unshift('最小二乗解が自己交差しています。入力値に矛盾があります。');
    } else if (c.maxError <= land.tolerance && c.maxAngleError <= Math.max(angTolDeg, 0.01)) {
      status = 'approximate';
      messages.unshift(
        `入力値にわずかな不整合があります。最小二乗法による近似解です（最大誤差 ${(c.maxError * 1000).toFixed(1)}mm／角度 ${c.maxAngleError.toFixed(4)}°、許容 ${(land.tolerance * 1000).toFixed(0)}mm）。`,
      );
    } else {
      status = 'inconsistent';
      const worst = [...c.residuals].sort((a, b) => Math.abs(b.error) - Math.abs(a.error))[0];
      messages.unshift(
        `入力値が矛盾しています。最も合わない条件：${worst.kind === 'angle' ? '角度' : worst.kind === 'coord' ? '座標' : '寸法'} ${worst.label}（入力 ${worst.target.toFixed(3)} → 計算 ${worst.actual.toFixed(3)}）。`,
      );
    }
  }

  return { status, candidates, missingConstraints: 0, constraintCount: count, rank, messages, solvedAt };
}

/** 解いた形状が描画可能か */
export function isDrawable(result: SolveResult | null): boolean {
  return !!result && (result.status === 'exact' || result.status === 'approximate' || result.status === 'multiple') && result.candidates.length > 0;
}

/** 確定座標から全入力値を整合させる（頂点ドラッグ等の直接編集後） */
export function landFromPoints(pts: Vec2[], prev: LandInput): LandInput {
  const n = pts.length;
  const ccw = signedArea(pts) >= 0;
  return {
    ...prev,
    vertexCount: n,
    sides: pts.map((p, i) => round6(dist(p, pts[(i + 1) % n]))),
    diagonals: prev.diagonals
      .filter((d) => d.a < n && d.b < n)
      .map((d) => ({ ...d, length: round6(dist(pts[d.a], pts[d.b])) })),
    angles: prev.angles.length === n ? pts.map((_, i) => (prev.angles[i] === null ? null : round6(interiorAngleAt(pts, i, ccw)))) : new Array(n).fill(null),
    coords: pts.map((p) => ({ x: round6(p.x), y: round6(p.y) })),
  };
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
