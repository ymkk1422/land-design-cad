// 車両旋回の幾何（アッカーマン近似・低速旋回）
import type { VehicleSpec } from '@/types';
import { rad } from '@/engine/geometry/polygon';

export interface SweptPath {
  /** 後輪軸中心の旋回半径 */
  rearAxleRadius: number;
  /** 車体内側（後部内側角）の最小半径 */
  innerBodyRadius: number;
  /** 車体外側（前部外側角）の最大半径 */
  outerBodyRadius: number;
  /** 最小旋回時の軌跡幅（外側半径 − 内側半径） */
  width: number;
}

/**
 * 最小回転半径 R（外側前輪中心）で旋回したときの車体軌跡。
 * 輪距 ≒ 全幅 − 0.2m、前オーバーハング ≒ (全長 − 軸距) × 0.55 と仮定。
 */
export function sweptPath(v: VehicleSpec): SweptPath {
  const track = Math.max(0.5, v.width - 0.2);
  const fo = Math.max(0, (v.length - v.wheelbase) * 0.55);
  const R = Math.max(v.minTurningRadius, v.wheelbase + 0.1);
  const rearAxleRadius = Math.sqrt(R * R - v.wheelbase * v.wheelbase) - track / 2;
  const innerBodyRadius = Math.max(0, rearAxleRadius - v.width / 2);
  const outerBodyRadius = Math.hypot(rearAxleRadius + v.width / 2, v.wheelbase + fo);
  return { rearAxleRadius, innerBodyRadius, outerBodyRadius, width: outerBodyRadius - innerBodyRadius };
}

/**
 * 駐車角度ごとの必要通路幅（簡易判定）。
 * W(α) = R·(1−cosα) + B·cosα + 0.5m（余裕）。例：R=5.5m・B=1.7m → 90°:6.0m / 60°:4.1m / 45°:3.3m
 */
export function requiredAisleWidth(stallAngleDeg: number, v: VehicleSpec): number {
  const a = rad(Math.min(90, Math.max(0, stallAngleDeg)));
  return v.minTurningRadius * (1 - Math.cos(a)) + v.width * Math.cos(a) + 0.5;
}

/** 到達性解析に使う車両中心の必要クリアランス（半幅） */
export function routeClearance(v: VehicleSpec, minAisle: number): number {
  const body = v.width / 2 + 0.25;
  return Math.max(body, Math.min(sweptPath(v).width / 2, minAisle * 0.45));
}
