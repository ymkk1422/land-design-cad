// 面積・外周・単位換算・表示整形（計算精度と表示桁数を分離）
import type { LengthUnit, Vec2 } from '@/types';
import { interiorAngles, perimeter, polygonArea, sideLengths } from '@/engine/geometry/polygon';

export const TSUBO_M2 = 3.305785; // 1坪 = 3.305785㎡（指示書の換算基準）

export const m2ToTsubo = (m2: number): number => m2 / TSUBO_M2;

export interface LandMetrics {
  area: number; // ㎡（倍精度のまま保持）
  tsubo: number;
  perimeter: number;
  sides: number[];
  angles: number[];
}

export function landMetrics(pts: Vec2[]): LandMetrics {
  const area = polygonArea(pts);
  return { area, tsubo: m2ToTsubo(area), perimeter: perimeter(pts), sides: sideLengths(pts), angles: interiorAngles(pts) };
}

const UNIT_FACTOR: Record<LengthUnit, number> = { m: 1, cm: 100, mm: 1000 };

export const toUnit = (meters: number, unit: LengthUnit): number => meters * UNIT_FACTOR[unit];
export const fromUnit = (value: number, unit: LengthUnit): number => value / UNIT_FACTOR[unit];

export function formatLength(meters: number, unit: LengthUnit, decimals: number): string {
  const d = unit === 'mm' ? Math.max(0, decimals - 3) : unit === 'cm' ? Math.max(0, decimals - 2) : decimals;
  return `${toUnit(meters, unit).toFixed(d)}${unit}`;
}

export const formatArea = (m2: number, decimals = 2): string => `${m2.toFixed(decimals)}㎡`;
export const formatTsubo = (m2: number, decimals = 2): string => `${m2ToTsubo(m2).toFixed(decimals)}坪`;

/** 度・分・秒 → 10進度。"90", "90.5", "90°30'15\"", "90-30-15", "90 30 15", "90度30分15秒" に対応 */
export function parseAngle(input: string): number | null {
  const s = input.trim().replace(/[度°]/g, ' ').replace(/[分'′]/g, ' ').replace(/[秒"″]/g, ' ').replace(/[-:]/g, ' ');
  if (!s) return null;
  const parts = s.split(/\s+/).filter(Boolean).map(Number);
  if (parts.some((p) => !Number.isFinite(p)) || parts.length > 3) return null;
  const [d, m = 0, sec = 0] = parts;
  if (parts.length > 1 && (m < 0 || m >= 60 || sec < 0 || sec >= 60)) return null;
  const sign = d < 0 || input.trim().startsWith('-') ? -1 : 1;
  return sign * (Math.abs(d) + m / 60 + sec / 3600);
}

export function formatDMS(degrees: number): string {
  let d = Math.floor(degrees);
  let mFloat = (degrees - d) * 60;
  let m = Math.floor(mFloat);
  let s = Math.round((mFloat - m) * 60 * 10) / 10;
  if (s >= 60) {
    s = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    d += 1;
  }
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}

/** 長さ入力（単位付き文字列も可） → m */
export function parseLength(input: string, defaultUnit: LengthUnit): number | null {
  const t = input.trim().replace(/[,，]/g, '').replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m)?$/i);
  if (!m) return null;
  const v = Number(m[1]);
  const u = (m[2]?.toLowerCase() as LengthUnit | undefined) ?? defaultUnit;
  return fromUnit(v, u);
}
