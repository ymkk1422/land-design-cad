import type { DisplaySettings, LandInput, ParkingSettings, ProjectDoc, StallType } from '@/types';
import { newId } from '@/engine/parking-optimizer/stallOps';
import { solveLand } from '@/engine/constraints/solver';

export const SCHEMA_VERSION = 1;

export const DEFAULT_STALL_TYPES: StallType[] = [
  { id: 'standard', name: '普通車', category: 'standard', width: 2.5, depth: 5.0, color: '#0b5d63' },
  { id: 'kei', name: '軽自動車', category: 'kei', width: 2.0, depth: 3.6, color: '#2f8f5b' },
  { id: 'large', name: '大型車', category: 'large', width: 3.25, depth: 12.0, color: '#7a5c12' },
  { id: 'wheelchair', name: '車椅子使用者用', category: 'wheelchair', width: 3.5, depth: 6.0, color: '#1f5fbf' },
  { id: 'custom', name: '任意寸法', category: 'custom', width: 2.5, depth: 5.0, color: '#6b6f76' },
];

export const DEFAULT_PARKING: ParkingSettings = {
  stallTypeId: 'standard',
  gap: 0,
  onewayAisleWidth: 3.5,
  twowayAisleWidth: 5.5,
  angles: [90, 60, 45],
  boundaryMargin: 0,
  vehicle: { length: 4.7, width: 1.7, wheelbase: 2.7, minTurningRadius: 5.5 },
  allowSingleRows: true,
  orientationStepDeg: 15,
};

export const DEFAULT_DISPLAY: DisplaySettings = {
  showDimensions: true,
  showDiagonals: true,
  showAngles: true,
  showCoords: false,
  showVertexNames: true,
  showStallNumbers: true,
  showAisles: true,
  decimals: 2,
  unit: 'm',
};

export function emptyLand(n: number): LandInput {
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

/** 頂点数の変更（既存入力を保持） */
export function resizeLand(land: LandInput, n: number): LandInput {
  const fit = <T,>(arr: T[], fill: T): T[] => Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : fill));
  const sides = fit(land.sides, null);
  // 閉合辺は頂点数が変わると意味が変わるため最終辺はクリア
  if (n !== land.vertexCount) sides[n - 1] = n > land.vertexCount ? null : sides[n - 1];
  return {
    ...land,
    vertexCount: n,
    sides,
    angles: fit(land.angles, null),
    coords: fit(land.coords, null),
    diagonals: land.diagonals.filter((d) => d.a < n && d.b < n),
  };
}

export function createProject(name = '新規土地図面', land?: LandInput): ProjectDoc {
  const now = new Date().toISOString();
  const l = land ?? sampleLand();
  return {
    id: newId('p'),
    name,
    createdAt: now,
    updatedAt: now,
    land: l,
    solution: solveLand(l),
    selectedCandidate: 0,
    stallTypes: DEFAULT_STALL_TYPES.map((t) => ({ ...t })),
    parking: { ...DEFAULT_PARKING, vehicle: { ...DEFAULT_PARKING.vehicle }, angles: [...DEFAULT_PARKING.angles] },
    stalls: [],
    aisles: [],
    obstacles: [],
    elements: [],
    roads: [{ id: newId('r'), edgeIndex: 0, width: 6, name: '前面道路' }],
    entrances: [{ id: newId('e'), edgeIndex: 0, t: 0.5, width: 5 }],
    mode: 'cad',
    display: { ...DEFAULT_DISPLAY },
    northAngle: 0,
    notes: '',
    schemaVersion: SCHEMA_VERSION,
  };
}

/** 初期サンプル（指示書の入力例に近い四角形：辺4本＋対角線1本） */
export function sampleLand(): LandInput {
  const land = emptyLand(4);
  land.sides = [20, 15, 20, 15];
  land.diagonals = [{ id: newId('d'), a: 0, b: 2, length: 25 }];
  return land;
}

/** 読み込んだデータの検証・移行（破損データから保護） */
export function migrateProject(raw: unknown): ProjectDoc {
  if (!raw || typeof raw !== 'object') throw new Error('図面データが壊れています');
  const p = raw as Partial<ProjectDoc>;
  if (typeof p.id !== 'string' || !p.land || typeof p.land.vertexCount !== 'number') throw new Error('図面データの形式が不正です');
  const base = createProject(p.name ?? '図面', p.land);
  return {
    ...base,
    ...p,
    id: p.id,
    stallTypes: p.stallTypes?.length ? p.stallTypes : base.stallTypes,
    parking: { ...base.parking, ...(p.parking ?? {}), vehicle: { ...base.parking.vehicle, ...(p.parking?.vehicle ?? {}) } },
    display: { ...base.display, ...(p.display ?? {}) },
    stalls: Array.isArray(p.stalls) ? p.stalls : [],
    aisles: Array.isArray(p.aisles) ? p.aisles : [],
    obstacles: Array.isArray(p.obstacles) ? p.obstacles : [],
    elements: Array.isArray(p.elements) ? p.elements : [],
    roads: Array.isArray(p.roads) ? p.roads : base.roads,
    entrances: Array.isArray(p.entrances) ? p.entrances : base.entrances,
    solution: solveLand(p.land),
    schemaVersion: SCHEMA_VERSION,
  } as ProjectDoc;
}
