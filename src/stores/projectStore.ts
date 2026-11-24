// 編集状態ストア（Zustand）。Undo/Redo はドキュメント全体のスナップショットで管理
import { create } from 'zustand';
import type { AngleSummary, LandInput, LayoutPlan, ProjectDoc, UpperBounds } from '@/types';
import { solveLand } from '@/engine/constraints/solver';
import { optimizeParkingDetailed, OptimizeCancelled } from '@/engine/parking-optimizer/optimizer';
import { currentSite } from '@/engine/export/drawingModel';
import type { StorageAdapter } from '@/services/storage';

export type SelKind = 'stall' | 'obstacle' | 'aisle' | 'element' | 'vertex' | 'entrance' | null;
export type Tool = 'select' | 'pan' | 'addStall' | 'addObstacle' | 'addElement' | 'vertex' | 'addAisle';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const HISTORY_LIMIT = 80;

interface OptimizeState {
  done: number;
  total: number;
  best: number;
}

interface State {
  doc: ProjectDoc | null;
  past: ProjectDoc[];
  future: ProjectDoc[];
  selKind: SelKind;
  selIds: string[];
  tool: Tool;
  addKind: string;
  snap: number;
  multiSelect: boolean;
  locked: boolean;
  plans: LayoutPlan[];
  bounds: UpperBounds | null;
  angleSummary: AngleSummary[];
  optimizeStats: { candidates: number; refined: number; ms: number } | null;
  optimizing: OptimizeState | null;
  optimizeError: string | null;
  storage: StorageAdapter | null;
  saveState: SaveState;
  saveError: string | null;
  lastSavedAt: string | null;
  // actions
  setStorage(s: StorageAdapter): void;
  load(doc: ProjectDoc): void;
  close(): void;
  commit(label: string, fn: (d: ProjectDoc) => ProjectDoc): void;
  beginLive(label: string): void;
  live(fn: (d: ProjectDoc) => ProjectDoc): void;
  endLive(): void;
  setLand(land: LandInput, label?: string): void;
  undo(): void;
  redo(): void;
  select(kind: SelKind, ids: string[], additive?: boolean): void;
  clearSelection(): void;
  setTool(t: Tool, addKind?: string): void;
  setSnap(v: number): void;
  setMultiSelect(v: boolean): void;
  setLocked(v: boolean): void;
  runOptimize(fixedOrientations?: number[]): Promise<void>;
  cancelOptimize(): void;
  applyPlan(plan: LayoutPlan): void;
  markSaved(at: string): void;
  setSaveState(s: SaveState, err?: string | null): void;
}

let abort: AbortController | null = null;
let liveBase: { label: string; doc: ProjectDoc } | null = null;

const stamp = (d: ProjectDoc, label: string): ProjectDoc => ({
  ...d,
  updatedAt: new Date().toISOString(),
  historyLog: [...(d.historyLog ?? []), { label, at: new Date().toISOString() }].slice(-100),
});

export const useProject = create<State>((set, get) => ({
  doc: null,
  past: [],
  future: [],
  selKind: null,
  selIds: [],
  tool: 'select',
  addKind: 'standard',
  snap: 0.1,
  multiSelect: false,
  locked: false,
  plans: [],
  bounds: null,
  angleSummary: [],
  optimizeStats: null,
  optimizing: null,
  optimizeError: null,
  storage: null,
  saveState: 'saved',
  saveError: null,
  lastSavedAt: null,

  setStorage: (s) => set({ storage: s }),
  load: (doc) => set({ doc, past: [], future: [], selKind: null, selIds: [], plans: [], bounds: null, angleSummary: [], saveState: 'saved', optimizeError: null }),
  close: () => {
    abort?.abort();
    set({ doc: null, past: [], future: [], plans: [], selIds: [], selKind: null, optimizing: null });
  },

  commit: (label, fn) => {
    const cur = get().doc;
    if (!cur) return;
    const next = stamp(fn(cur), label);
    set((s) => ({ doc: next, past: [...s.past, cur].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' }));
  },
  beginLive: (label) => {
    const cur = get().doc;
    if (cur) liveBase = { label, doc: cur };
  },
  live: (fn) => {
    const cur = get().doc;
    if (!cur) return;
    set({ doc: fn(cur) });
  },
  endLive: () => {
    const base = liveBase;
    liveBase = null;
    const cur = get().doc;
    if (!base || !cur || base.doc === cur) return;
    set((s) => ({ doc: stamp(cur, base.label), past: [...s.past, base.doc].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' }));
  },

  setLand: (land, label = '土地寸法の変更') => {
    get().commit(label, (d) => {
      const solution = solveLand(land);
      const sel = solution.candidates.length ? Math.min(d.selectedCandidate, solution.candidates.length - 1) : 0;
      return { ...d, land, solution, selectedCandidate: sel };
    });
  },

  undo: () => {
    const { past, doc, future } = get();
    if (!past.length || !doc) return;
    const prev = past[past.length - 1];
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], saveState: 'dirty', selIds: [], selKind: null });
  },
  redo: () => {
    const { past, doc, future } = get();
    if (!future.length || !doc) return;
    const next = future[0];
    set({ doc: next, past: [...past, doc], future: future.slice(1), saveState: 'dirty', selIds: [], selKind: null });
  },

  select: (kind, ids, additive) => {
    const s = get();
    if ((additive || s.multiSelect) && kind === s.selKind) {
      const setIds = new Set(s.selIds);
      ids.forEach((id) => (setIds.has(id) ? setIds.delete(id) : setIds.add(id)));
      set({ selIds: [...setIds], selKind: setIds.size ? kind : null });
    } else set({ selKind: kind, selIds: ids });
  },
  clearSelection: () => set({ selKind: null, selIds: [] }),
  setTool: (t, addKind) => set({ tool: t, ...(addKind ? { addKind } : {}) }),
  setSnap: (v) => set({ snap: v }),
  setMultiSelect: (v) => set({ multiSelect: v }),
  setLocked: (v) => set({ locked: v }),

  runOptimize: async (fixedOrientations) => {
    const d = get().doc;
    if (!d) return;
    const site = currentSite(d);
    if (!site) {
      set({ optimizeError: '土地形状が確定していないため自動配置できません。土地の寸法を確定してください。' });
      return;
    }
    abort?.abort();
    abort = new AbortController();
    const stallType = d.stallTypes.find((t) => t.id === d.parking.stallTypeId) ?? d.stallTypes[0];
    set({ optimizing: { done: 0, total: 1, best: 0 }, optimizeError: null, plans: [], bounds: null, angleSummary: [] });
    try {
      const res = await optimizeParkingDetailed(
        { site, obstacles: d.obstacles, entrances: d.entrances, stallType, settings: d.parking, fixedOrientations },
        { signal: abort.signal, onProgress: (done, total, best) => set({ optimizing: { done, total, best } }) },
      );
      const plans = res.plans;
      set({ plans, bounds: res.bounds, angleSummary: res.angleSummary, optimizeStats: res.stats, optimizing: null, optimizeError: plans.length ? null : '条件を満たす配置が見つかりませんでした。枠寸法・通路幅・障害物・出入口を確認してください。' });
    } catch (e) {
      set({ optimizing: null, optimizeError: e instanceof OptimizeCancelled ? 'キャンセルしました' : String((e as Error).message) });
    }
  },
  cancelOptimize: () => abort?.abort(),
  applyPlan: (plan) =>
    get().commit(`${plan.name}を適用`, (d) => ({ ...d, stalls: plan.stalls.map((s) => ({ ...s })), aisles: plan.aisles.map((a) => ({ ...a })), activePlanName: plan.name })),
  markSaved: (at) => set({ saveState: 'saved', lastSavedAt: at, saveError: null }),
  setSaveState: (s, err = null) => set({ saveState: s, saveError: err }),
}));
