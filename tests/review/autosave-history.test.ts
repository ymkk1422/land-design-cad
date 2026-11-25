import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProject } from '@/stores/projectStore';
import { createProject } from '@/services/projectFactory';
import { createAutosave } from '@/services/autosave';
import type { ProjectDoc } from '@/types';

function fakeStorage() {
  const calls: { doc: ProjectDoc; snapshot: boolean }[] = [];
  let failNext = 0;
  let gate: (() => void) | null = null;
  let hold = false;
  return {
    calls,
    failTimes: (n: number) => void (failNext = n),
    holdNext: () => void (hold = true),
    release: () => {
      gate?.();
      gate = null;
    },
    async save(doc: ProjectDoc, o?: { snapshot?: boolean }) {
      if (hold) {
        hold = false;
        await new Promise<void>((r) => (gate = r));
      }
      if (failNext > 0) {
        failNext--;
        throw new Error('network');
      }
      calls.push({ doc, snapshot: !!o?.snapshot });
    },
  };
}
const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('自動保存', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useProject.getState().load(createProject('auto'));
  });
  afterEach(() => vi.useRealTimers());

  it('編集が止まってから保存し、連続編集は1回にまとめる', async () => {
    const st = fakeStorage();
    const ctl = createAutosave(st, useProject);
    for (let i = 0; i < 5; i++) {
      useProject.getState().commit('名称変更', (d) => ({ ...d, name: 'n' + i }));
      await tick(300);
    }
    expect(st.calls).toHaveLength(0);
    await tick(1600);
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].doc.name).toBe('n4');
    expect(useProject.getState().saveState).toBe('saved');
    ctl.dispose();
  });

  it('保存中に編集された内容も、保存完了後に必ず保存する', async () => {
    const st = fakeStorage();
    const ctl = createAutosave(st, useProject);
    st.holdNext();
    useProject.getState().commit('a', (d) => ({ ...d, name: 'first' }));
    await tick(1600); // 保存開始（保留中）
    useProject.getState().commit('b', (d) => ({ ...d, name: 'second' }));
    await tick(1600); // 保存中なので待機
    st.release();
    await tick(2000);
    expect(st.calls.map((c) => c.doc.name)).toEqual(['first', 'second']);
    expect(useProject.getState().saveState).toBe('saved');
    ctl.dispose();
  });

  it('保存に失敗したら自動で再試行する', async () => {
    const st = fakeStorage();
    const ctl = createAutosave(st, useProject);
    st.failTimes(2);
    useProject.getState().commit('a', (d) => ({ ...d, name: 'x' }));
    await tick(1600);
    expect(useProject.getState().saveState).toBe('error');
    await tick(2100); // 1回目の再試行（失敗）
    expect(useProject.getState().saveState).toBe('error');
    await tick(4100); // 2回目の再試行（成功）
    expect(st.calls).toHaveLength(1);
    expect(useProject.getState().saveState).toBe('saved');
    ctl.dispose();
  });

  it('画面を閉じる時、変更が無ければ版を作らない／変更があれば版を作る', async () => {
    const st = fakeStorage();
    const ctl = createAutosave(st, useProject);
    await ctl.flush(true);
    expect(st.calls).toHaveLength(0);
    useProject.getState().commit('a', (d) => ({ ...d, name: 'y' }));
    await ctl.flush(true);
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0].snapshot).toBe(true);
    await ctl.flush(true);
    expect(st.calls).toHaveLength(1);
    ctl.dispose();
  });

  it('ドラッグ中の途中状態も未保存として扱う', async () => {
    const st = fakeStorage();
    const ctl = createAutosave(st, useProject);
    const s = useProject.getState();
    s.beginLive('移動');
    s.live((d) => ({ ...d, name: 'dragging' }));
    expect(useProject.getState().saveState).toBe('dirty');
    await tick(1600);
    expect(st.calls.at(-1)!.doc.name).toBe('dragging');
    ctl.dispose();
  });
});

describe('元に戻す・やり直す', () => {
  beforeEach(() => useProject.getState().load(createProject('hist')));

  it('文字入力は1つの履歴にまとめ、他の操作は個別の履歴にする', () => {
    const s = useProject.getState();
    for (const ch of ['駐', '駐車', '駐車場']) s.commit('名称変更', (d) => ({ ...d, name: ch }), { coalesce: true });
    expect(useProject.getState().past).toHaveLength(1);
    s.commit('モード切替', (d) => ({ ...d, mode: 'proposal' }));
    s.commit('モード切替', (d) => ({ ...d, mode: 'cad' }));
    expect(useProject.getState().past).toHaveLength(3);
    s.undo();
    s.undo();
    expect(useProject.getState().doc!.name).toBe('駐車場');
    s.undo();
    expect(useProject.getState().doc!.name).toBe('hist');
    s.redo();
    expect(useProject.getState().doc!.name).toBe('駐車場');
    // 元に戻した後の文字入力は、直前の入力とまとめず新しい履歴になる
    s.undo();
    s.commit('名称変更', (d) => ({ ...d, name: 'A' }), { coalesce: true });
    expect(useProject.getState().future).toHaveLength(0);
    s.undo();
    expect(useProject.getState().doc!.name).toBe('hist');
  });

  it('ドラッグ操作は1回の履歴、取り消しで元に戻る', () => {
    const s = useProject.getState();
    const before = useProject.getState().doc!;
    s.beginLive('移動');
    for (let i = 0; i < 10; i++) s.live((d) => ({ ...d, northAngle: i }));
    s.endLive();
    expect(useProject.getState().past).toHaveLength(1);
    s.undo();
    expect(useProject.getState().doc!.northAngle).toBe(before.northAngle);
    s.beginLive('移動');
    s.live((d) => ({ ...d, northAngle: 99 }));
    s.cancelLive();
    expect(useProject.getState().doc!.northAngle).toBe(before.northAngle);
    expect(useProject.getState().past).toHaveLength(0);
  });

  it('履歴は上限で打ち切られ、メモリを使い続けない', () => {
    const s = useProject.getState();
    for (let i = 0; i < 200; i++) s.commit('x', (d) => ({ ...d, northAngle: i % 360 }));
    expect(useProject.getState().past.length).toBeLessThanOrEqual(80);
  });
});
