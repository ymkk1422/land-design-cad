// ===== LAND DESIGN CAD 共通型定義 =====
// 座標はすべて実寸（メートル）。画面座標とは分離して扱う。
// 座標系: 数学座標（X=東, Y=北）。将来の平面直角座標系・緯度経度は CoordinateSystem で拡張。

export interface Vec2 {
  x: number;
  y: number;
}

export type LengthUnit = 'm' | 'cm' | 'mm';

export type CoordinateSystem =
  | { kind: 'local' }
  // 将来対応: 平面直角座標系（系番号）。測量のX(北)/Y(東)の入れ替えは変換層で処理する。
  | { kind: 'jgd2011-plane'; zone: number }
  | { kind: 'latlon'; origin: { lat: number; lon: number } };

/** 対角線（任意の2頂点間距離） */
export interface DiagonalInput {
  id: string;
  a: number; // 頂点インデックス
  b: number;
  length: number; // m
}

/** 土地形状の入力データ（4方式を同時保持） */
export interface LandInput {
  vertexCount: number;
  /** sides[i] = 頂点i → 頂点i+1 の距離（m）。null は未入力 */
  sides: (number | null)[];
  diagonals: DiagonalInput[];
  /** 内角（度、10進）。null は未入力 */
  angles: (number | null)[];
  /** 座標（m）。null は未入力 */
  coords: (Vec2 | null)[];
  coordinateSystem: CoordinateSystem;
  /** 測量誤差の許容値（m）。これ以内の残差は「近似解（誤差内）」とする */
  tolerance: number;
}

export type SolveStatus =
  | 'exact' // 厳密解（残差≒0、一意）
  | 'approximate' // 最小二乗による近似解（冗長な測量値の誤差が許容内）
  | 'multiple' // 複数の厳密解候補あり（選択が必要）
  | 'underdetermined' // 情報不足（形状が一意に定まらない）
  | 'inconsistent' // 矛盾（誤差が許容値を超える／解なし）
  | 'invalid'; // 入力不正

export interface ConstraintResidual {
  kind: 'side' | 'diagonal' | 'angle' | 'coord';
  label: string;
  target: number;
  actual: number;
  error: number; // actual - target（m または 度）
}

export interface SolutionCandidate {
  points: Vec2[];
  rms: number; // 長さ換算の残差RMS（m）
  maxError: number; // 長さ系の最大誤差（m）
  maxAngleError: number; // 角度の最大誤差（度）
  residuals: ConstraintResidual[];
  selfIntersecting: boolean;
  mirrorOf?: number; // 他候補の鏡像である場合そのインデックス
}

export interface SolveResult {
  status: SolveStatus;
  candidates: SolutionCandidate[];
  /** 必要な独立条件数 2n-3 に対する不足数（推定） */
  missingConstraints: number;
  constraintCount: number;
  rank: number;
  messages: string[];
  solvedAt: string;
}

// ===== 駐車場 =====
export type StallCategory = 'standard' | 'kei' | 'large' | 'wheelchair' | 'custom';

export interface StallType {
  id: string;
  name: string;
  category: StallCategory;
  width: number; // m
  depth: number; // m
  color: string;
}

export interface Stall {
  id: string;
  typeId: string;
  cx: number; // 中心座標（m）
  cy: number;
  width: number;
  depth: number;
  /** 回転角（度、反時計回り）。0 のとき奥行き方向=+Y */
  angle: number;
}

export type AisleKind = 'oneway' | 'twoway' | 'pedestrian';

/** 矩形要素の共通形（中心・幅・高さ・角度） */
export interface RectShape {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number; // 度
}

export interface Aisle extends RectShape {
  id: string;
  kind: AisleKind;
  /** 一方通行の進行方向（矩形のローカル +X 方向 = 1, 逆 = -1） */
  direction: 1 | -1;
}

export type ObstacleKind =
  | 'building'
  | 'pole'
  | 'tree'
  | 'sign'
  | 'fence'
  | 'retainingWall'
  | 'waterway'
  | 'gutter'
  | 'planting'
  | 'structure'
  | 'setback'
  | 'noParking';

export interface Obstacle extends RectShape {
  id: string;
  kind: ObstacleKind;
  label?: string;
}

export type SiteElementKind = 'arrow' | 'wheelStop' | 'turningSpace' | 'gate' | 'pedestrianPath';

export interface SiteElement extends RectShape {
  id: string;
  kind: SiteElementKind;
}

/** 前面道路（敷地の辺に接する） */
export interface Road {
  id: string;
  edgeIndex: number;
  width: number; // 幅員 m
  name: string;
}

/** 車両出入口（辺上の位置 t:0..1 と幅） */
export interface Entrance {
  id: string;
  edgeIndex: number;
  t: number;
  width: number;
}

export interface VehicleSpec {
  length: number;
  width: number;
  wheelbase: number;
  minTurningRadius: number; // 最小回転半径（外側前輪）
}

export type ParkingAngleMode = 90 | 60 | 45 | number;

export interface ParkingSettings {
  stallTypeId: string;
  gap: number; // 枠間隔
  onewayAisleWidth: number; // 3.5
  twowayAisleWidth: number; // 5.5
  angles: number[]; // 探索する駐車角度
  boundaryMargin: number; // 境界からの離隔
  vehicle: VehicleSpec;
  allowSingleRows: boolean;
  orientationStepDeg: number;
}

export interface LayoutMetrics {
  count: number;
  stallArea: number;
  aisleArea: number;
  siteArea: number;
  utilization: number; // 駐車枠面積 / 敷地面積
  deadSpaceRatio: number; // 1 - (枠+通路)/敷地
  alignment: number; // 0..1 列の揃い具合
  accessibility: number; // 0..1 出入口からの到達性/動線
  score: number;
}

export interface PlanIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** 数学的に保証された上限値（どんな配置でもこれを超えない） */
export interface UpperBounds {
  usableArea: number; // 敷地 − 障害物（重複なし分のみ控除）
  /** 無条件の上限：枠同士・敷地外にはみ出さないだけで成り立つ（面積÷枠面積） */
  areaBound: number;
  /** 通路考慮の上限：各枠が前面に専用の通路領域（幅×通路幅/2）を持つという前提での上限 */
  accessBound: number;
  assumptions: string[];
}

/**
 * proven       … 台数が無条件の上限に一致＝数学的に最大と証明済み
 * model-proven … 通路考慮の上限に一致＝前提条件の下で最大と証明済み
 * heuristic    … 探索による最良案（最大の保証なし）
 */
export type Optimality = 'proven' | 'model-proven' | 'heuristic';

export interface LayoutPlan {
  id: string;
  name: string;
  stallAngle: number; // 駐車角度
  orientation: number; // 配置方向（度）
  aisleKind: AisleKind;
  /** 使用した通路幅（m、重複除去済み） */
  aisleWidths: number[];
  stalls: Stall[];
  aisles: Aisle[];
  metrics: LayoutMetrics;
  issues: PlanIssue[];
  /** 互換用（issues のメッセージ） */
  warnings: string[];
  strategy: string[];
  deadEnds: number;
  turnaround: boolean;
  bounds: UpperBounds;
  optimality: Optimality;
  /** 数学的に最大と証明できた場合のみ true（それ以外は探索による最良案） */
  provenOptimal: boolean;
}

export interface AngleSummary {
  angle: number;
  bestCount: number;
  aisleWidth: number;
  requiredAisle: number;
  planName?: string;
}

export type DrawingMode = 'cad' | 'proposal';

export interface DisplaySettings {
  showDimensions: boolean;
  showDiagonals: boolean;
  showAngles: boolean;
  showCoords: boolean;
  showVertexNames: boolean;
  showStallNumbers: boolean;
  showAisles: boolean;
  decimals: number;
  unit: LengthUnit;
}

export interface ProjectDoc {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  land: LandInput;
  solution: SolveResult | null;
  selectedCandidate: number;
  stallTypes: StallType[];
  parking: ParkingSettings;
  stalls: Stall[];
  aisles: Aisle[];
  obstacles: Obstacle[];
  elements: SiteElement[];
  roads: Road[];
  entrances: Entrance[];
  mode: DrawingMode;
  display: DisplaySettings;
  northAngle: number; // 方位（度）。0=図面上方向が北
  notes: string;
  activePlanName?: string;
  /** 編集履歴（操作ログ。全状態はバージョン保存で保持） */
  historyLog?: { label: string; at: string }[];
  schemaVersion: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  area: number;
  stallCount: number;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string; // SVG 文字列
}
