// 自動保存コントローラ（UI から独立。単体テスト可能）
// - 編集が止まって 1.5 秒後に保存（デバウンス）
// - 保存中に編集されたら、保存完了後に改めて保存
// - 失敗したら 2,4,8,…最大60秒の間隔で自動再試行（編集があれば通常の間隔で再保存）
// - 版（スナップショット）は 5 分ごと、または画面を閉じる時に「前回の版から変更がある場合のみ」作成
import type { ProjectDoc } from '@/types';
import type { SaveState } from '@/stores/projectStore';

export interface AutosaveStore {
  getState(): { doc: ProjectDoc | null; saveState: SaveState; setSaveState(s: SaveState, err?: string): void; markSaved(at: string): void };
  subscribe(fn: (s: { doc: ProjectDoc | null; saveState: SaveState }, prev: { doc: ProjectDoc | null; saveState: SaveState }) => void): () => void;
}
export interface AutosaveTarget {
  save(doc: ProjectDoc, opts?: { snapshot?: boolean; label?: string }): Promise<void>;
}
export interface AutosaveOptions {
  debounceMs?: number;
  snapshotEveryMs?: number;
  now?: () => number;
}

export function createAutosave(storage: AutosaveTarget, store: AutosaveStore, opts: AutosaveOptions = {}): { flush(snapshot?: boolean): Promise<void>; dispose(): void } {
  const debounce = opts.debounceMs ?? 1500;
  const snapEvery = opts.snapshotEveryMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let failures = 0;
  let changedSinceSnap = false;
  let lastSnap = now();
  let disposed = false;

  const schedule = (ms: number): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), ms);
  };

  async function flush(snapshot = false): Promise<void> {
    const s = store.getState();
    if (!s.doc || saving) return;
    // 保存済みなら何もしない（終了時の版保存も、変更が無ければ作らない）
    if (s.saveState === 'saved' || s.saveState === 'saving') return;
    if (timer) clearTimeout(timer);
    timer = null;
    saving = true;
    const d = s.doc;
    s.setSaveState('saving');
    try {
      const snap = changedSinceSnap && (snapshot || now() - lastSnap > snapEvery);
      await storage.save(d, { snapshot: snap, label: snapshot ? '終了時の自動保存' : '自動保存' });
      failures = 0;
      if (snap) {
        lastSnap = now();
        changedSinceSnap = false;
      }
      const cur = store.getState();
      if (cur.doc === d) cur.markSaved(new Date(now()).toISOString());
      else cur.setSaveState('dirty');
    } catch (e) {
      failures++;
      store.getState().setSaveState('error', (e as Error).message || '保存に失敗しました');
    } finally {
      saving = false;
    }
    const after = store.getState();
    if (!after.doc) return;
    if (after.saveState === 'dirty') schedule(Math.min(debounce, 400));
    else if (after.saveState === 'error') schedule(Math.min(60000, 2000 * 2 ** Math.min(5, failures - 1)));
  }

  const unsub = store.subscribe((s, prev) => {
    if (s.doc === prev.doc) return;
    if (s.doc && prev.doc && s.doc.id !== prev.doc.id) {
      // 別の図面を開いた
      changedSinceSnap = false;
      failures = 0;
      lastSnap = now();
    }
    if (s.saveState === 'dirty') {
      changedSinceSnap = true;
      schedule(debounce);
    }
  });

  return {
    flush,
    dispose(): void {
      disposed = true;
      unsub();
      if (timer) clearTimeout(timer);
    },
  };
}
