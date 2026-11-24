'use client';
import type { JSX } from 'react';
import { useState } from 'react';
import type { Aisle, Obstacle, SiteElement, Stall } from '@/types';
import { useProject } from '@/stores/projectStore';
import { Btn, LengthInput, NumInput, Section, Select } from '@/components/ui';
import { RectEditor } from './ObjectsPanel';
import { alignStalls, deleteStalls, distributeStalls, duplicateStalls, moveStalls, newId, rotateStalls } from '@/engine/parking-optimizer/stallOps';
import { currentSite, OBSTACLE_STYLE } from '@/engine/export/drawingModel';
import { vertexName } from '@/engine/geometry/polygon';
import { moveVertexLand } from '@/engine/constraints/vertexEdit';
import { deleteSelection } from '@/components/selectionActions';

export function SelectionPanel(): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const { selKind, selIds, commit, clearSelection, select, locked, setLand } = useProject();
  const ids = new Set(selIds);
  const unit = doc.display.unit;
  const [dx, setDx] = useState<number | null>(0);
  const [dy, setDy] = useState<number | null>(0);
  const [gap, setGap] = useState<number | null>(0);

  const del = (): void => deleteSelection();

  if (!selKind || !selIds.length) {
    return (
      <Section title="選択">
        <p className="text-[13px] text-neutral-600" data-testid="no-selection">
          図面上の駐車枠・障害物・通路をタップすると、寸法・角度・座標を数値で編集できます。「複数選択」をオンにすると複数の枠をまとめて操作できます。
        </p>
        <Btn className="mt-2" disabled={!doc.stalls.length} onClick={() => select('stall', doc.stalls.map((s) => s.id))} testId="select-all-stalls">
          全駐車枠を選択
        </Btn>
      </Section>
    );
  }

  if (selKind === 'stall') {
    const sel = doc.stalls.filter((s) => ids.has(s.id));
    const one = sel.length === 1 ? sel[0] : null;
    const upd = (patch: Partial<Stall>): void => commit('駐車枠の編集', (d) => ({ ...d, stalls: d.stalls.map((s) => (ids.has(s.id) ? { ...s, ...patch } : s)) }));
    return (
      <Section title={`駐車枠 ${sel.length}台を選択中`}>
        {one && (
          <div className="space-y-2" data-testid="stall-editor">
            <Select label="種類" value={one.typeId} options={doc.stallTypes.map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => {
              const t = doc.stallTypes.find((x) => x.id === v)!;
              upd({ typeId: v, width: t.width, depth: t.depth });
            }} />
            <RectEditor unit={unit} shape={{ cx: one.cx, cy: one.cy, w: one.width, h: one.depth, angle: one.angle }} onChange={(p) => upd({ ...(p.cx !== undefined && { cx: p.cx }), ...(p.cy !== undefined && { cy: p.cy }), ...(p.w !== undefined && { width: p.w }), ...(p.h !== undefined && { depth: p.h }), ...(p.angle !== undefined && { angle: p.angle }) })} />
          </div>
        )}
        <div className="mt-3 grid grid-cols-4 gap-1">
          <Btn disabled={locked} onClick={() => commit('回転', (d) => ({ ...d, stalls: rotateStalls(d.stalls, ids, 15) }))} title="15°回転" testId="rotate-15">
            ⟲15°
          </Btn>
          <Btn disabled={locked} onClick={() => commit('回転', (d) => ({ ...d, stalls: rotateStalls(d.stalls, ids, -15) }))} title="−15°回転">
            ⟳15°
          </Btn>
          <Btn disabled={locked} onClick={() => commit('回転', (d) => ({ ...d, stalls: rotateStalls(d.stalls, ids, 90) }))} title="90°回転" testId="rotate-90">
            90°
          </Btn>
          <Btn disabled={locked} onClick={() => commit('回転', (d) => ({ ...d, stalls: rotateStalls(d.stalls, ids, 1) }))} title="1°回転">
            ⟲1°
          </Btn>
          <Btn
            disabled={locked}
            testId="duplicate"
            onClick={() => {
              let nid: string[] = [];
              commit('複製', (d) => {
                const r = duplicateStalls(d.stalls, ids);
                nid = r.newIds;
                return { ...d, stalls: r.stalls };
              });
              select('stall', nid);
            }}
          >
            複製
          </Btn>
          <Btn disabled={locked || sel.length < 2} onClick={() => commit('整列', (d) => ({ ...d, stalls: alignStalls(d.stalls, ids, 'row') }))}>
            整列
          </Btn>
          <Btn disabled={locked || sel.length < 3} onClick={() => commit('等間隔配置', (d) => ({ ...d, stalls: distributeStalls(d.stalls, ids) }))}>
            等間隔
          </Btn>
          <Btn variant="danger" disabled={locked} onClick={del} testId="delete-selection">
            削除
          </Btn>
        </div>
        <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-1">
          <NumInput label="ΔX" value={dx} digits={3} onChange={setDx} />
          <NumInput label="ΔY" value={dy} digits={3} onChange={setDy} />
          <Btn disabled={locked} onClick={() => commit('一括移動', (d) => ({ ...d, stalls: moveStalls(d.stalls, ids, dx ?? 0, dy ?? 0) }))} testId="move-by">
            移動
          </Btn>
        </div>
        {sel.length >= 2 && (
          <div className="mt-2 grid grid-cols-[1fr_auto] items-end gap-1">
            <LengthInput label="枠間隔" unit={unit} value={gap} onChange={setGap} />
            <Btn disabled={locked} onClick={() => commit('枠間隔で詰める', (d) => ({ ...d, stalls: distributeStalls(d.stalls, ids, gap ?? 0) }))}>
              間隔で並べる
            </Btn>
          </div>
        )}
      </Section>
    );
  }

  if (selKind === 'vertex') {
    const site = currentSite(doc);
    const i = Number(selIds[0]);
    if (!site || !site[i]) return <Section title="頂点">—</Section>;
    return (
      <Section title={`頂点 ${vertexName(i)}`}>
        <div className="grid grid-cols-2 gap-2">
          <NumInput label="X" value={site[i].x} digits={4} onChange={(v) => v !== null && setLand(moveVertexLand(doc.land, site, i, { x: v, y: site[i].y }), '頂点の移動')} />
          <NumInput label="Y" value={site[i].y} digits={4} onChange={(v) => v !== null && setLand(moveVertexLand(doc.land, site, i, { x: site[i].x, y: v }), '頂点の移動')} />
        </div>
        <Btn variant="danger" className="mt-2" disabled={site.length <= 3 || locked} onClick={del}>
          この頂点を削除
        </Btn>
        <p className="mt-2 text-[12px] text-neutral-500">頂点を直接編集すると、座標を基準に辺・対角線・角度の入力値が更新されます。</p>
      </Section>
    );
  }

  // 障害物・設備・通路
  type R = Obstacle | SiteElement | Aisle;
  const list: R[] = selKind === 'obstacle' ? doc.obstacles : selKind === 'element' ? doc.elements : doc.aisles;
  const one = list.find((o) => o.id === selIds[0]);
  if (!one) return <Section title="選択">—</Section>;
  const key = selKind === 'obstacle' ? 'obstacles' : selKind === 'element' ? 'elements' : 'aisles';
  const upd = (patch: Partial<R>): void => commit('数値編集', (d) => ({ ...d, [key]: (d[key] as R[]).map((o) => (o.id === one.id ? { ...o, ...patch } : o)) }));
  return (
    <Section title={selKind === 'obstacle' ? `障害物：${OBSTACLE_STYLE[(one as Obstacle).kind]?.name}` : selKind === 'aisle' ? '通路' : '設備'}>
      {selKind === 'obstacle' && (
        <div className="mb-2 space-y-2">
          <Select label="種類" value={(one as Obstacle).kind} options={Object.entries(OBSTACLE_STYLE).map(([k, v]) => ({ value: k, label: v.name }))} onChange={(v) => upd({ kind: v } as Partial<R>)} />
          <input className="h-10 w-full rounded border border-neutral-300 px-2 text-[16px]" placeholder="ラベル（任意）" value={(one as Obstacle).label ?? ''} onChange={(e) => upd({ label: e.target.value.slice(0, 30) } as Partial<R>)} />
        </div>
      )}
      {selKind === 'aisle' && (
        <div className="mb-2 grid grid-cols-[1fr_auto] gap-2">
          <Select label="種類" value={(one as Aisle).kind} options={[{ value: 'oneway', label: '一方通行' }, { value: 'twoway', label: '双方向' }, { value: 'pedestrian', label: '歩行者通路' }]} onChange={(v) => upd({ kind: v } as Partial<R>)} />
          <Btn onClick={() => upd({ direction: ((one as Aisle).direction * -1) as 1 | -1 } as Partial<R>)}>向き反転</Btn>
        </div>
      )}
      <RectEditor unit={unit} shape={one} onChange={(p) => upd(p as Partial<R>)} wLabel={selKind === 'aisle' ? '長さ' : '幅'} hLabel={selKind === 'aisle' ? '通路幅' : '奥行'} />
      <div className="mt-2 grid grid-cols-3 gap-1">
        <Btn disabled={locked} onClick={() => upd({ angle: one.angle + 90 })}>90°回転</Btn>
        <Btn
          disabled={locked}
          onClick={() => {
            const id = newId('c');
            commit('複製', (d) => ({ ...d, [key]: [...(d[key] as R[]), { ...one, id, cx: one.cx + 1, cy: one.cy - 1 }] }));
            select(selKind, [id]);
          }}
        >
          複製
        </Btn>
        <Btn variant="danger" disabled={locked} onClick={del}>
          削除
        </Btn>
      </div>
    </Section>
  );
}
