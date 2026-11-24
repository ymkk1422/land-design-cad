// 選択中オブジェクトへの共通操作（浮動ツールバー・選択パネル・キーボードから利用）
import type { Aisle, Obstacle, ProjectDoc, SiteElement } from '@/types';
import { useProject } from '@/stores/projectStore';
import { deleteStalls, duplicateStalls, newId, normAngle, rotateStalls } from '@/engine/parking-optimizer/stallOps';
import { deleteSelectedVertex } from '@/components/canvas/DrawingCanvas';

type R = Obstacle | SiteElement | Aisle;
const keyOf = (k: string): 'obstacles' | 'elements' | 'aisles' | null => (k === 'obstacle' ? 'obstacles' : k === 'element' ? 'elements' : k === 'aisle' ? 'aisles' : null);

export function rotateSelection(delta: number): void {
  const s = useProject.getState();
  if (s.locked || !s.selIds.length) return;
  const ids = new Set(s.selIds);
  if (s.selKind === 'stall') s.commit('回転', (d) => ({ ...d, stalls: rotateStalls(d.stalls, ids, delta) }));
  else {
    const key = keyOf(s.selKind ?? '');
    if (key) s.commit('回転', (d) => ({ ...d, [key]: (d[key] as R[]).map((o) => (ids.has(o.id) ? { ...o, angle: normAngle(o.angle + delta) } : o)) }) as ProjectDoc);
  }
}

export function duplicateSelection(): void {
  const s = useProject.getState();
  if (s.locked || !s.selIds.length) return;
  const ids = new Set(s.selIds);
  if (s.selKind === 'stall') {
    let nid: string[] = [];
    s.commit('複製', (d) => {
      const r = duplicateStalls(d.stalls, ids);
      nid = r.newIds;
      return { ...d, stalls: r.stalls };
    });
    s.select('stall', nid);
    return;
  }
  const key = keyOf(s.selKind ?? '');
  if (!key || !s.selKind) return;
  const kind = s.selKind;
  const created: string[] = [];
  s.commit('複製', (d) => {
    const copies = (d[key] as R[]).filter((o) => ids.has(o.id)).map((o) => {
      const id = newId('c');
      created.push(id);
      return { ...o, id, cx: o.cx + 1, cy: o.cy - 1 };
    });
    return { ...d, [key]: [...(d[key] as R[]), ...copies] } as ProjectDoc;
  });
  s.select(kind, created);
}

export function deleteSelection(): void {
  const s = useProject.getState();
  if (s.locked || !s.selIds.length || !s.doc) return;
  const ids = new Set(s.selIds);
  if (s.selKind === 'stall') s.commit('駐車枠の削除', (d) => ({ ...d, stalls: deleteStalls(d.stalls, ids) }));
  else if (s.selKind === 'vertex') {
    const patch = deleteSelectedVertex(s.doc, Number(s.selIds[0]));
    if (patch) s.commit('頂点の削除', (d) => ({ ...d, ...patch }));
  } else {
    const key = keyOf(s.selKind ?? '');
    if (key) s.commit('削除', (d) => ({ ...d, [key]: (d[key] as R[]).filter((o) => !ids.has(o.id)) }) as ProjectDoc);
  }
  s.clearSelection();
}

export const SEL_NAME: Record<string, string> = { stall: '駐車枠', obstacle: '障害物', element: '設備', aisle: '通路', vertex: '頂点', entrance: '出入口' };
