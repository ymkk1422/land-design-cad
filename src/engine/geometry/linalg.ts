// 小規模密行列演算（幾何ソルバー用）

export type Matrix = number[][];

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

/** JᵀJ と Jᵀr を計算 */
export function normalEquations(J: Matrix, r: number[], cols: number): { A: Matrix; g: number[] } {
  const A = zeros(cols, cols);
  const g = new Array<number>(cols).fill(0);
  for (let k = 0; k < J.length; k++) {
    const row = J[k];
    for (let i = 0; i < cols; i++) {
      const ri = row[i];
      if (ri === 0) continue;
      g[i] += ri * r[k];
      for (let j = i; j < cols; j++) A[i][j] += ri * row[j];
    }
  }
  for (let i = 0; i < cols; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  return { A, g };
}

/** 部分ピボット付きガウス消去で Ax=b を解く。特異なら null */
export function solveLinear(Ain: Matrix, bin: number[]): number[] | null {
  const n = bin.length;
  const A = Ain.map((row) => row.slice());
  const b = bin.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-300) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** 対称行列の固有値（ヤコビ法） */
export function symmetricEigenvalues(Ain: Matrix, maxSweeps = 100): number[] {
  const n = Ain.length;
  const A = Ain.map((row) => row.slice());
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((row, i) => row[i]);
}

/** 行列のランク（JᵀJ の固有値から） */
export function numericRank(J: Matrix, cols: number, relTol = 1e-9): number {
  const { A } = normalEquations(J, new Array<number>(J.length).fill(0), cols);
  const ev = symmetricEigenvalues(A);
  const maxEv = Math.max(...ev.map(Math.abs), 1e-300);
  return ev.filter((e) => Math.abs(e) > relTol * maxEv).length;
}

/** 決定論的な擬似乱数（テスト再現性のため） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
