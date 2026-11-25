import type { Aisle, DisplaySettings, Entrance, LandInput, Obstacle, ObstacleKind, ParkingSettings, ProjectDoc, PxPoint, Road, SiteElement, SiteElementKind, Stall, StallType, UnderlayMeta, Vec2 } from '@/types';
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

// ===== 読み込みデータの検証・修復（破損・改ざんデータから保護） =====
// 保存データ・バックアップ・クラウドの値はすべて信頼しない。型・範囲を検査し、不正な要素は捨てるか既定値に戻す。
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, def: number, min = -Infinity, max = Infinity): number => (fin(v) && v >= min && v <= max ? v : def);
const str = (v: unknown, def: string, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : def);
const arr = (v: unknown, max = 5000): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const pt = (v: unknown): Vec2 | null => (isObj(v) && fin(v.x) && fin(v.y) ? { x: v.x, y: v.y } : null);
const rectOk = (o: Record<string, unknown>): boolean => fin(o.cx) && fin(o.cy) && fin(o.w) && fin(o.h) && (o.w as number) > 0 && (o.h as number) > 0 && fin(o.angle);
const OBST: ObstacleKind[] = ['building', 'pole', 'tree', 'sign', 'fence', 'retainingWall', 'waterway', 'gutter', 'planting', 'structure', 'setback', 'noParking'];
const ELEM: SiteElementKind[] = ['arrow', 'wheelStop', 'turningSpace', 'gate', 'pedestrianPath'];

export function sanitizeLand(raw: unknown): LandInput {
  if (!isObj(raw)) throw new Error('土地データが壊れています');
  const n = raw.vertexCount;
  if (!fin(n) || !Number.isInteger(n) || n < 3 || n > 40) throw new Error('頂点数が不正です（3〜40）');
  const fit = <T,>(v: unknown, f: (x: unknown) => T | null): (T | null)[] => {
    const a = Array.isArray(v) ? v : [];
    return Array.from({ length: n }, (_, i) => (i < a.length ? f(a[i]) : null));
  };
  return {
    vertexCount: n,
    sides: fit(raw.sides, (x) => (fin(x) && x > 0 && x < 1e6 ? x : null)),
    angles: fit(raw.angles, (x) => (fin(x) && x > 0 && x < 360 ? x : null)),
    coords: fit(raw.coords, pt),
    diagonals: arr(raw.diagonals, 200)
      .filter(isObj)
      .filter((d) => Number.isInteger(d.a) && Number.isInteger(d.b) && (d.a as number) >= 0 && (d.b as number) >= 0 && (d.a as number) < n && (d.b as number) < n && d.a !== d.b && fin(d.length) && (d.length as number) > 0)
      .map((d) => ({ id: str(d.id, newId('d'), 80), a: d.a as number, b: d.b as number, length: d.length as number })),
    coordinateSystem: { kind: 'local' },
    tolerance: num(raw.tolerance, 0.01, 0, 1),
  };
}

export function migrateProject(raw: unknown): ProjectDoc {
  if (!isObj(raw)) throw new Error('図面データが壊れています');
  const id = raw.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('図面データの形式が不正です（ID）');
  const land = sanitizeLand(raw.land);
  const n = land.vertexCount;
  const now = new Date().toISOString();
  const iso = (v: unknown): string => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : now);

  const rp = isObj(raw.parking) ? raw.parking : {};
  const rv = isObj(rp.vehicle) ? rp.vehicle : {};
  const angles = arr(rp.angles, 10).filter((a): a is number => fin(a) && a >= 20 && a <= 90);
  const parking: ParkingSettings = {
    stallTypeId: str(rp.stallTypeId, DEFAULT_PARKING.stallTypeId, 80),
    gap: num(rp.gap, 0, 0, 5),
    onewayAisleWidth: num(rp.onewayAisleWidth, 3.5, 0.5, 30),
    twowayAisleWidth: num(rp.twowayAisleWidth, 5.5, 0.5, 30),
    angles: angles.length ? angles : [...DEFAULT_PARKING.angles],
    boundaryMargin: num(rp.boundaryMargin, 0, 0, 20),
    vehicle: {
      length: num(rv.length, 4.7, 1, 30),
      width: num(rv.width, 1.7, 0.5, 5),
      wheelbase: num(rv.wheelbase, 2.7, 0.5, 20),
      minTurningRadius: num(rv.minTurningRadius, 5.5, 1, 30),
    },
    allowSingleRows: rp.allowSingleRows !== false,
    orientationStepDeg: num(rp.orientationStepDeg, 15, 5, 90),
  };
  const stallTypes: StallType[] = arr(raw.stallTypes, 50)
    .filter(isObj)
    .filter((t) => typeof t.id === 'string' && fin(t.width) && fin(t.depth) && (t.width as number) > 0 && (t.depth as number) > 0)
    .map((t) => ({
      id: str(t.id, newId('t'), 80),
      name: str(t.name, '枠', 40),
      category: (['standard', 'kei', 'large', 'wheelchair', 'custom'].includes(t.category as string) ? t.category : 'custom') as StallType['category'],
      width: t.width as number,
      depth: t.depth as number,
      color: typeof t.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#0b5d63',
    }));
  const rd = isObj(raw.display) ? raw.display : {};
  const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
  const display: DisplaySettings = {
    showDimensions: bool(rd.showDimensions, true),
    showDiagonals: bool(rd.showDiagonals, true),
    showAngles: bool(rd.showAngles, true),
    showCoords: bool(rd.showCoords, false),
    showVertexNames: bool(rd.showVertexNames, true),
    showStallNumbers: bool(rd.showStallNumbers, true),
    showAisles: bool(rd.showAisles, true),
    decimals: Math.round(num(rd.decimals, 2, 0, 6)),
    unit: rd.unit === 'cm' || rd.unit === 'mm' ? rd.unit : 'm',
  };
  const stalls: Stall[] = arr(raw.stalls)
    .filter(isObj)
    .filter((x) => fin(x.cx) && fin(x.cy) && fin(x.width) && fin(x.depth) && fin(x.angle) && (x.width as number) > 0 && (x.depth as number) > 0)
    .map((x) => ({ id: str(x.id, newId('s'), 80), typeId: str(x.typeId, 'standard', 80), cx: x.cx as number, cy: x.cy as number, width: x.width as number, depth: x.depth as number, angle: x.angle as number }));
  const aisles: Aisle[] = arr(raw.aisles, 2000)
    .filter(isObj)
    .filter(rectOk)
    .map((a) => ({ id: str(a.id, newId('a'), 80), kind: (['oneway', 'twoway', 'pedestrian'].includes(a.kind as string) ? a.kind : 'twoway') as Aisle['kind'], cx: a.cx as number, cy: a.cy as number, w: a.w as number, h: a.h as number, angle: a.angle as number, direction: a.direction === -1 ? -1 : 1, ...(fin(a.stallAngle) ? { stallAngle: a.stallAngle as number } : {}) }));
  const obstacles: Obstacle[] = arr(raw.obstacles, 2000)
    .filter(isObj)
    .filter((o) => rectOk(o) && OBST.includes(o.kind as ObstacleKind))
    .map((o) => ({ id: str(o.id, newId('o'), 80), kind: o.kind as ObstacleKind, cx: o.cx as number, cy: o.cy as number, w: o.w as number, h: o.h as number, angle: o.angle as number, ...(typeof o.label === 'string' ? { label: o.label.slice(0, 30) } : {}) }));
  const elements: SiteElement[] = arr(raw.elements, 2000)
    .filter(isObj)
    .filter((o) => rectOk(o) && ELEM.includes(o.kind as SiteElementKind))
    .map((o) => ({ id: str(o.id, newId('x'), 80), kind: o.kind as SiteElementKind, cx: o.cx as number, cy: o.cy as number, w: o.w as number, h: o.h as number, angle: o.angle as number }));
  const edge = (v: unknown): number => Math.min(n - 1, Math.max(0, Math.round(num(v, 0))));
  const roads: Road[] = arr(raw.roads, 20).filter(isObj).map((r) => ({ id: str(r.id, newId('r'), 80), edgeIndex: edge(r.edgeIndex), width: num(r.width, 6, 0.5, 100), name: str(r.name, '道路', 30) }));
  const entrances: Entrance[] = arr(raw.entrances, 20).filter(isObj).map((e) => ({ id: str(e.id, newId('e'), 80), edgeIndex: edge(e.edgeIndex), t: num(e.t, 0.5, 0, 1), width: num(e.width, 5, 1, 50) }));

  // 選択していた形状：保存された shapeHint → 旧データの解 の順に復元
  const sol = isObj(raw.solution) ? raw.solution : null;
  const oldSel = Math.round(num(raw.selectedCandidate, 0, 0, 1000));
  const oldPts = sol && Array.isArray(sol.candidates) && isObj(sol.candidates[oldSel]) ? (sol.candidates[oldSel] as Record<string, unknown>).points : null;
  const hintRaw = Array.isArray(raw.shapeHint) ? raw.shapeHint : Array.isArray(oldPts) ? oldPts : null;
  const hintPts = hintRaw ? hintRaw.map(pt) : null;
  const shapeHint = hintPts && hintPts.length === n && hintPts.every(Boolean) ? (hintPts as Vec2[]) : null;
  const solution = solveLand(land, { hint: shapeHint });

  return {
    id,
    name: str(raw.name, '図面', 120) || '図面',
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
    land,
    solution,
    selectedCandidate: 0,
    stallTypes: stallTypes.length ? stallTypes : DEFAULT_STALL_TYPES.map((t) => ({ ...t })),
    parking,
    stalls,
    aisles,
    obstacles,
    elements,
    roads,
    entrances,
    mode: raw.mode === 'proposal' ? 'proposal' : 'cad',
    display,
    northAngle: num(raw.northAngle, 0, -360, 360),
    notes: str(raw.notes, '', 2000),
    activePlanName: typeof raw.activePlanName === 'string' ? raw.activePlanName.slice(0, 20) : undefined,
    historyLog: arr(raw.historyLog, 100)
      .filter(isObj)
      .map((h) => ({ label: str(h.label, '', 60), at: iso(h.at) })),
    underlay: sanitizeUnderlay(raw.underlay),
    assetIds: arr(raw.assetIds, 500).filter((a): a is string => typeof a === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(a)),
    shapeHint: solution.candidates[0]?.points ?? shapeHint,
    schemaVersion: SCHEMA_VERSION,
  };
}

function sanitizeUnderlay(raw: unknown): UnderlayMeta | null {
  if (!isObj(raw)) return null;
  const idOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
  if (!idOk(raw.originalAssetId) || !idOk(raw.displayAssetId)) return null;
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(raw.source as string)) return null;
  const W = num(raw.pxWidth, 0, 1, 20000);
  const H = num(raw.pxHeight, 0, 1, 20000);
  const scale = num(raw.scale, 0, 1e-9, 1e3);
  if (!W || !H || !scale) return null;
  const px = (v: unknown): PxPoint | null => (isObj(v) && fin(v.u) && fin(v.v) ? { u: v.u, v: v.v } : null);
  const pts = (v: unknown): PxPoint[] => arr(v, 200).map(px).filter((x): x is PxPoint => !!x);
  const cal = isObj(raw.calibration) ? raw.calibration : null;
  const ca = cal ? px(cal.a) : null;
  const cb = cal ? px(cal.b) : null;
  const paper = isObj(raw.paperMm) && fin(raw.paperMm.w) && fin(raw.paperMm.h) ? { w: raw.paperMm.w, h: raw.paperMm.h } : undefined;
  return {
    originalAssetId: raw.originalAssetId,
    displayAssetId: raw.displayAssetId,
    fileName: str(raw.fileName, 'drawing', 200),
    source: raw.source as UnderlayMeta['source'],
    ...(fin(raw.pdfPage) ? { pdfPage: Math.max(1, Math.round(raw.pdfPage)) } : {}),
    ...(fin(raw.pdfPageCount) ? { pdfPageCount: Math.max(1, Math.round(raw.pdfPageCount)) } : {}),
    ...(paper ? { paperMm: paper } : {}),
    pxWidth: W,
    pxHeight: H,
    rasterScale: num(raw.rasterScale, 1, 1e-6, 1),
    scale,
    scaleMethod: (['none', 'reference', 'pdf-scale', 'dpi'].includes(raw.scaleMethod as string) ? raw.scaleMethod : 'none') as UnderlayMeta['scaleMethod'],
    rotation: num(raw.rotation, 0, -360, 360),
    tx: num(raw.tx, 0),
    ty: num(raw.ty, 0),
    opacity: num(raw.opacity, 0.6, 0, 1),
    visible: raw.visible !== false,
    locked: raw.locked === true,
    calibration: ca && cb && cal ? { a: ca, b: cb, length: num(cal.length, 0, 0, 1e6) } : null,
    trace: pts(raw.trace),
    measure: pts(raw.measure).slice(0, 2),
    ...(fin(raw.fitError) ? { fitError: raw.fitError } : {}),
  };
}

/** 保存用の形：選択中の形状を shapeHint に記録（クラウドでは解は保存せず再計算） */
export function storable(doc: ProjectDoc, stripSolution: boolean): ProjectDoc {
  const sol = doc.solution;
  const sel = sol && sol.candidates.length ? sol.candidates[Math.min(doc.selectedCandidate, sol.candidates.length - 1)] : null;
  const ok = !!sol && ['exact', 'approximate', 'multiple'].includes(sol.status);
  return { ...doc, shapeHint: ok && sel ? sel.points : doc.shapeHint ?? null, ...(stripSolution ? { solution: null } : {}) };
}
