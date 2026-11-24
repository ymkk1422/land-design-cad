// 評価用の敷地形状（変形地を含む）
import type { Entrance, ParkingSettings, StallType, Vec2 } from '@/types';

export const SITES: Record<string, { site: Vec2[]; entrances: Entrance[] }> = {
  長方形30x20: { site: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.5, width: 5 }] },
  台形: { site: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 30, y: 22 }, { x: 6, y: 22 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.5, width: 5 }] },
  三角形: { site: [{ x: 0, y: 0 }, { x: 45, y: 0 }, { x: 15, y: 32 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.4, width: 5 }] },
  L字: { site: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 16 }, { x: 16, y: 16 }, { x: 16, y: 36 }, { x: 0, y: 36 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.5, width: 5 }] },
  凹凸五角形: { site: [{ x: 0, y: 0 }, { x: 34, y: 3 }, { x: 30, y: 26 }, { x: 14, y: 18 }, { x: 2, y: 28 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.5, width: 5 }] },
  斜め平行四辺形: { site: [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 44, y: 21 }, { x: 12, y: 21 }], entrances: [{ id: 'e', edgeIndex: 0, t: 0.5, width: 5 }] },
};

export const STD: StallType = { id: 'std', name: '普通車', category: 'standard', width: 2.5, depth: 5.0, color: '#0b5d63' };
export const SETTINGS: ParkingSettings = {
  stallTypeId: 'std',
  gap: 0,
  onewayAisleWidth: 3.5,
  twowayAisleWidth: 5.5,
  angles: [90, 60, 45],
  boundaryMargin: 0,
  vehicle: { length: 4.7, width: 1.7, wheelbase: 2.7, minTurningRadius: 5.5 },
  allowSingleRows: true,
  orientationStepDeg: 15,
};
