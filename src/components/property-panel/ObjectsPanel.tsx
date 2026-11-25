'use client';
import type { JSX } from 'react';
// 道路・出入口・通路・建物・障害物・設備の配置と数値編集
import type { AisleKind, ObstacleKind, ProjectDoc, RectShape, SiteElementKind } from '@/types';
import { useProject } from '@/stores/projectStore';
import { Btn, LengthInput, NumInput, Section, Select, cx } from '@/components/ui';
import { OBSTACLE_STYLE, ELEMENT_NAMES, currentSite } from '@/engine/export/drawingModel';
import { vertexName, dist, centroid } from '@/engine/geometry/polygon';
import { newId } from '@/engine/parking-optimizer/stallOps';

export function ObjectsPanel(): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const { commit, setTool, tool, addKind, select, selIds } = useProject();
  const site = currentSite(doc);
  const n = site?.length ?? doc.land.vertexCount;
  const unit = doc.display.unit;
  const edgeOpts = Array.from({ length: n }, (_, i) => ({ value: i, label: `辺${vertexName(i)}${vertexName((i + 1) % n)}${site ? `（${dist(site[i], site[(i + 1) % n]).toFixed(2)}m）` : ''}` }));
  const c = site ? centroid(site) : { x: 0, y: 0 };

  return (
    <div data-testid="objects-panel">
      <Section title="前面道路">
        {doc.roads.map((r) => (
          <div key={r.id} className="mb-2 space-y-1 rounded-md border border-neutral-200 p-2">
            <div className="grid grid-cols-[1fr_auto] gap-1">
              <input className="h-10 rounded border border-neutral-300 px-2 text-[16px]" value={r.name} onChange={(e) => commit('道路名', (d) => ({ ...d, roads: d.roads.map((x) => (x.id === r.id ? { ...x, name: e.target.value.slice(0, 30) } : x)) }), { coalesce: true })} aria-label="道路名" />
              <Btn variant="ghost" title="道路を削除" onClick={() => commit('道路の削除', (d) => ({ ...d, roads: d.roads.filter((x) => x.id !== r.id) }))}>
                ✕
              </Btn>
            </div>
            <Select label="接道辺" value={r.edgeIndex} options={edgeOpts} onChange={(v) => commit('接道辺の変更', (d) => ({ ...d, roads: d.roads.map((x) => (x.id === r.id ? { ...x, edgeIndex: v } : x)) }))} />
            <LengthInput label="幅員" unit={unit} value={r.width} allowEmpty={false} min={0.5} onChange={(v) => v !== null && commit('幅員の変更', (d) => ({ ...d, roads: d.roads.map((x) => (x.id === r.id ? { ...x, width: v } : x)) }))} />
            {site && <div className="text-[12px] text-neutral-500">接道長さ {dist(site[r.edgeIndex % n], site[(r.edgeIndex + 1) % n]).toFixed(2)}m</div>}
          </div>
        ))}
        <Btn onClick={() => commit('道路の追加', (d) => ({ ...d, roads: [...d.roads, { id: newId('r'), edgeIndex: 0, width: 4, name: `道路${d.roads.length + 1}` }] }))}>＋ 道路を追加</Btn>
      </Section>

      <Section title="車両出入口">
        {doc.entrances.map((e, k) => (
          <div key={e.id} className="mb-2 space-y-1 rounded-md border border-neutral-200 p-2">
            <div className="flex items-center justify-between text-[13px] font-bold">
              出入口{k + 1}
              <Btn variant="ghost" title="出入口を削除" onClick={() => commit('出入口の削除', (d) => ({ ...d, entrances: d.entrances.filter((x) => x.id !== e.id) }))}>
                ✕
              </Btn>
            </div>
            <Select label="位置の辺" value={e.edgeIndex} options={edgeOpts} onChange={(v) => commit('出入口の変更', (d) => ({ ...d, entrances: d.entrances.map((x) => (x.id === e.id ? { ...x, edgeIndex: v } : x)) }))} />
            <LengthInput
              label="始点から"
              unit={unit}
              value={site ? e.t * dist(site[e.edgeIndex % n], site[(e.edgeIndex + 1) % n]) : null}
              allowEmpty={false}
              onChange={(v) => {
                if (v === null || !site) return;
                const L = dist(site[e.edgeIndex % n], site[(e.edgeIndex + 1) % n]);
                commit('出入口の変更', (d) => ({ ...d, entrances: d.entrances.map((x) => (x.id === e.id ? { ...x, t: Math.max(0, Math.min(1, v / L)) } : x)) }));
              }}
            />
            <LengthInput label="幅" unit={unit} value={e.width} allowEmpty={false} min={1} onChange={(v) => v !== null && commit('出入口の変更', (d) => ({ ...d, entrances: d.entrances.map((x) => (x.id === e.id ? { ...x, width: v } : x)) }))} />
          </div>
        ))}
        <Btn onClick={() => commit('出入口の追加', (d) => ({ ...d, entrances: [...d.entrances, { id: newId('e'), edgeIndex: 0, t: 0.5, width: 5 }] }))}>＋ 出入口を追加</Btn>
      </Section>

      <Section title="通路">
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              ['oneway', '一方通行'],
              ['twoway', '双方向'],
              ['pedestrian', '歩行者'],
            ] as [AisleKind, string][]
          ).map(([k, l]) => (
            <Btn
              key={k}
              onClick={() => {
                const id = newId('a');
                const w = k === 'oneway' ? doc.parking.onewayAisleWidth : k === 'twoway' ? doc.parking.twowayAisleWidth : 1.5;
                commit('通路の追加', (d) => ({ ...d, aisles: [...d.aisles, { id, kind: k, cx: c.x, cy: c.y, w: 12, h: w, angle: 0, direction: 1 }] }));
                select('aisle', [id]);
              }}
            >
              ＋{l}
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-[12px] text-neutral-500">自動配置では通路が自動生成されます。図面上でドラッグ移動、「選択」タブで寸法・向きを変更できます。</p>
      </Section>

      <Section title="建物・障害物（自動配置から除外）">
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(OBSTACLE_STYLE) as ObstacleKind[]).map((k) => (
            <Btn key={k} active={tool === 'addObstacle' && addKind === k} onClick={() => setTool(tool === 'addObstacle' && addKind === k ? 'select' : 'addObstacle', k)} className="px-1 text-[13px]" testId={`add-obstacle-${k}`}>
              {OBSTACLE_STYLE[k].name}
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-[12px] text-neutral-500">種類を選んで図面をタップすると配置します。</p>
        <ObjectList doc={doc} kind="obstacle" selIds={selIds} />
      </Section>

      <Section title="設備（矢印・車止め・門扉ほか）">
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(ELEMENT_NAMES) as SiteElementKind[]).map((k) => (
            <Btn key={k} active={tool === 'addElement' && addKind === k} onClick={() => setTool(tool === 'addElement' && addKind === k ? 'select' : 'addElement', k)} className="px-1 text-[13px]">
              {ELEMENT_NAMES[k]}
            </Btn>
          ))}
        </div>
        <ObjectList doc={doc} kind="element" selIds={selIds} />
      </Section>

      <Section title="方位">
        <NumInput label="北の向き" value={doc.northAngle} suffix="°（図面上から時計回り）" digits={2} onChange={(v) => v !== null && commit('方位の変更', (d) => ({ ...d, northAngle: v }))} />
      </Section>
    </div>
  );
}

function ObjectList({ doc, kind, selIds }: { doc: ProjectDoc; kind: 'obstacle' | 'element'; selIds: string[] }): JSX.Element | null {
  const select = useProject((s) => s.select);
  const items = kind === 'obstacle' ? doc.obstacles : doc.elements;
  if (!items.length) return null;
  return (
    <ul className="mt-2 divide-y divide-neutral-100 text-[13px]">
      {items.map((o) => (
        <li key={o.id}>
          <button className={cx('flex min-h-[36px] w-full items-center justify-between px-1 text-left', selIds.includes(o.id) && 'bg-teal-light')} onClick={() => select(kind, [o.id])}>
            <span>{kind === 'obstacle' ? (o as { label?: string }).label || OBSTACLE_STYLE[(o as { kind: string }).kind]?.name : ELEMENT_NAMES[(o as { kind: string }).kind]}</span>
            <span className="font-mono text-neutral-500">
              {o.w.toFixed(2)}×{o.h.toFixed(2)}m
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 矩形要素の数値編集（中心・幅・奥行・角度） */
export function RectEditor({ shape, onChange, unit, wLabel = '幅', hLabel = '奥行' }: { shape: RectShape; onChange: (p: Partial<RectShape>) => void; unit: ProjectDoc['display']['unit']; wLabel?: string; hLabel?: string }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumInput label="X" value={shape.cx} digits={3} onChange={(v) => v !== null && onChange({ cx: v })} testId="sel-x" />
      <NumInput label="Y" value={shape.cy} digits={3} onChange={(v) => v !== null && onChange({ cy: v })} testId="sel-y" />
      <LengthInput label={wLabel} unit={unit} value={shape.w} allowEmpty={false} min={0.05} onChange={(v) => v !== null && onChange({ w: v })} testId="sel-w" />
      <LengthInput label={hLabel} unit={unit} value={shape.h} allowEmpty={false} min={0.05} onChange={(v) => v !== null && onChange({ h: v })} testId="sel-h" />
      <NumInput label="角度" value={shape.angle} suffix="°" digits={3} onChange={(v) => v !== null && onChange({ angle: v })} testId="sel-angle" className="col-span-2" />
    </div>
  );
}
