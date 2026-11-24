'use client';
import type { JSX } from 'react';
import { useState } from 'react';
import type { LayoutPlan, ParkingSettings, StallType } from '@/types';
import { useProject } from '@/stores/projectStore';
import { Btn, LengthInput, NumInput, Section, Select, Toggle, cx } from '@/components/ui';
import { currentSite } from '@/engine/export/drawingModel';
import { requiredAisleWidth, stallCorners } from '@/engine/validation/interference';
import type { InterferenceReport } from '@/engine/validation/interference';

type OrientMode = 'auto' | 'h' | 'v' | 'custom';

export function ParkingPanel({ report }: { report: InterferenceReport | null }): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const { commit, runOptimize, cancelOptimize, optimizing, plans, applyPlan, optimizeError, setTool, tool, addKind, bounds, angleSummary, optimizeStats } = useProject();
  const [orient, setOrient] = useState<OrientMode>('auto');
  const [customOrient, setCustomOrient] = useState(30);
  const [customAngle, setCustomAngle] = useState<number | null>(null);
  const p = doc.parking;
  const unit = doc.display.unit;
  const site = currentSite(doc);
  const setP = (patch: Partial<ParkingSettings>, label = '駐車条件の変更'): void => commit(label, (d) => ({ ...d, parking: { ...d.parking, ...patch } }));
  const setType = (id: string, patch: Partial<StallType>): void =>
    commit('駐車枠寸法の変更', (d) => ({
      ...d,
      stallTypes: d.stallTypes.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      // 既存の枠にも寸法を反映
      stalls: patch.width !== undefined || patch.depth !== undefined ? d.stalls.map((s) => (s.typeId === id ? { ...s, width: patch.width ?? s.width, depth: patch.depth ?? s.depth } : s)) : d.stalls,
    }));
  const angleSet = new Set(p.angles);
  const toggleAngle = (a: number, on: boolean): void => {
    const s = new Set(p.angles);
    if (on) s.add(a);
    else s.delete(a);
    if (!s.size) return;
    setP({ angles: [...s].sort((x, y) => y - x) });
  };
  const fixed = orient === 'auto' ? undefined : orient === 'h' ? [0] : orient === 'v' ? [90] : [customOrient];
  const maxCount = plans.length ? Math.max(...plans.map((x) => x.metrics.count)) : 0;

  return (
    <div data-testid="parking-panel">
      <Section title="駐車枠の種類と寸法">
        <div className="space-y-2">
          {doc.stallTypes.map((t) => (
            <div key={t.id} className={cx('rounded-md border p-2', p.stallTypeId === t.id ? 'border-teal bg-teal-light/40' : 'border-neutral-200')}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[14px] font-bold">
                  <input type="radio" name="stalltype" className="h-5 w-5 accent-[#0b5d63]" checked={p.stallTypeId === t.id} onChange={() => setP({ stallTypeId: t.id }, '自動配置の枠種類')} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: t.color }} />
                  {t.name}
                </label>
                <Btn variant="ghost" active={tool === 'addStall' && addKind === t.id} onClick={() => setTool(tool === 'addStall' && addKind === t.id ? 'select' : 'addStall', t.id)} title={`${t.name}を手動で追加`}>
                  ＋配置
                </Btn>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <LengthInput testId={`stall-w-${t.id}`} label="横幅" unit={unit} value={t.width} allowEmpty={false} min={0.5} onChange={(v) => v !== null && setType(t.id, { width: v })} />
                <LengthInput testId={`stall-d-${t.id}`} label="奥行" unit={unit} value={t.depth} allowEmpty={false} min={0.5} onChange={(v) => v !== null && setType(t.id, { depth: v })} />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="配置条件">
        <div className="space-y-2">
          <LengthInput label="枠間隔" unit={unit} value={p.gap} allowEmpty={false} min={0} onChange={(v) => v !== null && setP({ gap: v })} />
          <div className="grid grid-cols-2 gap-2">
            <LengthInput label="一方通" unit={unit} value={p.onewayAisleWidth} allowEmpty={false} min={1} onChange={(v) => v !== null && setP({ onewayAisleWidth: v })} testId="aisle-oneway" />
            <LengthInput label="双方向" unit={unit} value={p.twowayAisleWidth} allowEmpty={false} min={1} onChange={(v) => v !== null && setP({ twowayAisleWidth: v })} testId="aisle-twoway" />
          </div>
          <LengthInput label="境界離隔" unit={unit} value={p.boundaryMargin} allowEmpty={false} min={0} onChange={(v) => v !== null && setP({ boundaryMargin: v })} />
          <div>
            <div className="text-[13px] text-neutral-600">駐車角度（探索対象）</div>
            <div className="flex flex-wrap gap-x-3">
              {[90, 60, 45].map((a) => (
                <Toggle key={a} label={`${a}°`} checked={angleSet.has(a)} onChange={(v) => toggleAngle(a, v)} />
              ))}
              {p.angles
                .filter((a) => ![90, 60, 45].includes(a))
                .map((a) => (
                  <Toggle key={a} label={`${a}°`} checked onChange={() => toggleAngle(a, false)} />
                ))}
            </div>
            <div className="mt-1 grid grid-cols-[1fr_auto] gap-2">
              <NumInput label="任意" value={customAngle} allowEmpty suffix="°" digits={1} onChange={setCustomAngle} placeholder="30〜89" />
              <Btn disabled={!customAngle || customAngle < 20 || customAngle > 90} onClick={() => customAngle && toggleAngle(customAngle, true)}>
                追加
              </Btn>
            </div>
          </div>
          <Select<OrientMode>
            label="並び方向"
            value={orient}
            onChange={setOrient}
            options={[
              { value: 'auto', label: '自動探索（全方向）' },
              { value: 'h', label: '横並び（X方向）' },
              { value: 'v', label: '縦並び（Y方向）' },
              { value: 'custom', label: '任意角度' },
            ]}
          />
          {orient === 'custom' && <NumInput label="方向" value={customOrient} suffix="°" digits={1} onChange={(v) => v !== null && setCustomOrient(v)} />}
          <details className="text-[13px]">
            <summary className="cursor-pointer py-1 font-bold">車両・旋回条件</summary>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <LengthInput label="全長" unit={unit} value={p.vehicle.length} allowEmpty={false} onChange={(v) => v !== null && setP({ vehicle: { ...p.vehicle, length: v } })} />
              <LengthInput label="全幅" unit={unit} value={p.vehicle.width} allowEmpty={false} onChange={(v) => v !== null && setP({ vehicle: { ...p.vehicle, width: v } })} />
              <LengthInput label="軸距" unit={unit} value={p.vehicle.wheelbase} allowEmpty={false} onChange={(v) => v !== null && setP({ vehicle: { ...p.vehicle, wheelbase: v } })} />
              <LengthInput label="回転半" unit={unit} value={p.vehicle.minTurningRadius} allowEmpty={false} onChange={(v) => v !== null && setP({ vehicle: { ...p.vehicle, minTurningRadius: v } })} />
            </div>
            <p className="mt-1 text-neutral-500">
              必要通路幅（簡易判定）：90° {requiredAisleWidth(90, p.vehicle).toFixed(2)}m / 60° {requiredAisleWidth(60, p.vehicle).toFixed(2)}m / 45° {requiredAisleWidth(45, p.vehicle).toFixed(2)}m
            </p>
          </details>
        </div>
      </Section>

      <Section title="自動配置">
        {!site && <p className="text-[13px] text-amber-800">土地形状が確定すると自動配置できます。</p>}
        {!doc.entrances.length && site && <p className="text-[13px] text-amber-800">出入口が未設定です（「設備」タブで追加）。到達性の検証には出入口が必要です。</p>}
        {optimizing ? (
          <div data-testid="optimize-progress">
            <div className="h-2 w-full overflow-hidden rounded bg-neutral-200">
              <div className="h-full bg-teal transition-all" style={{ width: `${Math.round((optimizing.done / Math.max(1, optimizing.total)) * 100)}%` }} />
            </div>
            <div className="mt-1 flex items-center justify-between text-[13px] tabular-nums">
              <span>
                探索中 {optimizing.done}/{optimizing.total}（暫定 {optimizing.best}台）
              </span>
              <Btn variant="danger" onClick={cancelOptimize} testId="cancel-optimize">
                キャンセル
              </Btn>
            </div>
          </div>
        ) : (
          <Btn variant="primary" className="w-full" disabled={!site} onClick={() => runOptimize(fixed)} testId="run-optimize">
            配置案を探索する
          </Btn>
        )}
        {optimizeError && <p className="mt-2 text-[13px] text-signal">{optimizeError}</p>}
        {plans.length > 0 && bounds && (
          <div className="mt-3 space-y-3" data-testid="plans">
            <BoundsBox best={maxCount} />
            {angleSummary.length > 0 && (
              <div>
                <div className="text-[13px] font-bold">駐車角度の比較</div>
                <table className="mt-1 w-full text-[13px] tabular-nums" data-testid="angle-table">
                  <thead>
                    <tr className="text-left text-neutral-500">
                      <th className="font-normal">角度</th>
                      <th className="text-right font-normal">最良台数</th>
                      <th className="text-right font-normal">通路幅</th>
                      <th className="text-right font-normal">必要幅</th>
                      <th className="text-right font-normal">案</th>
                    </tr>
                  </thead>
                  <tbody>
                    {angleSummary.map((a) => (
                      <tr key={a.angle} className="border-t border-neutral-100">
                        <td>{a.angle}°</td>
                        <td className={cx('text-right font-mono font-bold', a.bestCount === maxCount && 'text-teal')}>{a.bestCount}台</td>
                        <td className="text-right font-mono">{a.aisleWidth.toFixed(2)}m</td>
                        <td className={cx('text-right font-mono', a.aisleWidth + 1e-6 < a.requiredAisle && 'text-amber-700')}>{a.requiredAisle.toFixed(2)}m</td>
                        <td className="text-right">{a.planName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[12px] text-neutral-500">必要幅は最小回転半径からの簡易判定です。橙色は設定した通路幅が不足しています。</p>
              </div>
            )}
            {plans.map((pl) => (
              <PlanCard key={pl.id} plan={pl} isMax={pl.metrics.count === maxCount} active={doc.activePlanName === pl.name && doc.stalls.length === pl.stalls.length} onApply={() => applyPlan(pl)} />
            ))}
            {optimizeStats && (
              <p className="text-[12px] text-neutral-500">
                探索：{optimizeStats.candidates.toLocaleString()}通りの配置を生成、{optimizeStats.refined}案を精査（{(optimizeStats.ms / 1000).toFixed(1)}秒）
              </p>
            )}
          </div>
        )}
      </Section>

      <Section title="現在の配置">
        <div className="grid grid-cols-2 gap-2 text-[13px]">
          <div className="rounded-md border border-neutral-200 p-2">
            <div className="text-neutral-500">駐車台数</div>
            <div className="font-mono text-[20px] font-bold" data-testid="stall-count">
              {doc.stalls.length}台
            </div>
          </div>
          <div className="rounded-md border border-neutral-200 p-2">
            <div className="text-neutral-500">干渉チェック</div>
            <div className={cx('font-bold', report?.ok ? 'text-teal' : 'text-signal')} data-testid="interference">
              {!report ? '—' : report.ok ? '問題なし' : '要確認'}
            </div>
          </div>
        </div>
        {report && !report.ok && (
          <ul className="mt-2 list-disc pl-5 text-[13px] text-signal">
            {report.outOfSite.length > 0 && <li>敷地からはみ出し：{report.outOfSite.length}台</li>}
            {report.overlapping.length > 0 && <li>枠同士の重なり：{report.overlapping.length}組</li>}
            {report.obstacleHits.length > 0 && <li>障害物・禁止エリアと干渉：{report.obstacleHits.length}件</li>}
            {report.aisleHits.length > 0 && <li>通路と重なる枠：{new Set(report.aisleHits.map((h) => h.stallId)).size}台</li>}
            {report.entranceBlocked.length > 0 && <li>出入口の前をふさぐ枠：{report.entranceBlocked.length}台</li>}
            {report.aislesOutOfSite.length > 0 && <li>敷地からはみ出した通路：{report.aislesOutOfSite.length}本</li>}
          </ul>
        )}
        {report && report.narrowAisles.length > 0 && (
          <p className="mt-2 text-[13px] text-amber-800">
            通路幅が旋回条件（簡易判定 {report.narrowAisles[0].required.toFixed(2)}m）を満たさない通路が{report.narrowAisles.length}本あります。
          </p>
        )}
        <Btn
          variant="danger"
          className="mt-2"
          disabled={!doc.stalls.length}
          onClick={() => commit('駐車枠を全削除', (d) => ({ ...d, stalls: [], aisles: [], activePlanName: undefined }))}
        >
          枠と通路をすべて削除
        </Btn>
      </Section>
    </div>
  );
}

const OPT_LABEL: Record<LayoutPlan['optimality'], { label: string; cls: string }> = {
  proven: { label: '数学的に最大（証明済み）', cls: 'bg-teal text-white' },
  'model-proven': { label: '前提条件の下で最大（証明済み）', cls: 'bg-teal-light text-teal' },
  heuristic: { label: '探索による最良案', cls: 'bg-neutral-100 text-neutral-700' },
};

function BoundsBox({ best }: { best: number }): JSX.Element {
  const bounds = useProject((s) => s.bounds)!;
  return (
    <div className="rounded-md border border-ink p-2 text-[13px]" data-testid="bounds">
      <div className="font-bold">数学的に保証された上限と探索結果</div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-center tabular-nums">
        <div className="rounded bg-neutral-50 p-1">
          <div className="text-[11px] text-neutral-500">面積上限（無条件）</div>
          <div className="font-mono text-[17px] font-bold" data-testid="area-bound">{bounds.areaBound}台</div>
        </div>
        <div className="rounded bg-neutral-50 p-1">
          <div className="text-[11px] text-neutral-500">通路考慮上限</div>
          <div className="font-mono text-[17px] font-bold" data-testid="access-bound">{bounds.accessBound}台</div>
        </div>
        <div className="rounded bg-teal-light p-1">
          <div className="text-[11px] text-teal">探索の最良</div>
          <div className="font-mono text-[17px] font-bold text-teal" data-testid="best-count">{best}台</div>
        </div>
      </div>
      <p className="mt-1 text-[12px] text-neutral-600">
        上限はどんな配置でも超えられない数です。探索の最良と上限が一致したときだけ「最大と証明済み」と表示します。一致しない場合、上限まで置ける配置が存在するとは限りません。
      </p>
      <details className="mt-1 text-[12px] text-neutral-600">
        <summary className="cursor-pointer">上限の根拠</summary>
        <ul className="mt-1 list-disc pl-4">
          {bounds.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const ISSUE_CLS = { error: 'text-signal', warning: 'text-amber-800', info: 'text-neutral-600' } as const;
const ISSUE_MARK = { error: '×', warning: '!', info: '・' } as const;

function PlanCard({ plan, onApply, active, isMax }: { plan: LayoutPlan; onApply: () => void; active: boolean; isMax: boolean }): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const site = currentSite(doc)!;
  const all = [...site, ...plan.stalls.flatMap(stallCorners)];
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = 92 / Math.max(maxX - minX, maxY - minY, 1e-6);
  const P = (p: { x: number; y: number }): string => `${4 + (p.x - minX) * s},${96 - (p.y - minY) * s}`;
  const m = plan.metrics;
  const opt = OPT_LABEL[plan.optimality];
  const errors = plan.issues.filter((i) => i.level === 'error').length;
  const warns = plan.issues.filter((i) => i.level === 'warning').length;
  return (
    <div className={cx('rounded-md border p-2', active ? 'border-teal ring-2 ring-teal' : 'border-neutral-200')} data-testid="plan-card" data-optimality={plan.optimality}>
      <div className="flex gap-2">
        <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0 rounded bg-neutral-50">
          <polygon points={site.map(P).join(' ')} fill="#fff" stroke="#14161a" strokeWidth="1" />
          {plan.aisles.map((a) => {
            const c = [
              [-a.w / 2, -a.h / 2],
              [a.w / 2, -a.h / 2],
              [a.w / 2, a.h / 2],
              [-a.w / 2, a.h / 2],
            ].map(([x, y]) => {
              const t = (a.angle * Math.PI) / 180;
              return { x: a.cx + x * Math.cos(t) - y * Math.sin(t), y: a.cy + x * Math.sin(t) + y * Math.cos(t) };
            });
            return <polygon key={a.id} points={c.map(P).join(' ')} fill="#dfe6ea" />;
          })}
          {plan.stalls.map((st) => (
            <polygon key={st.id} points={stallCorners(st).map(P).join(' ')} fill="#0b5d63" fillOpacity="0.35" stroke="#0b5d63" strokeWidth="0.5" />
          ))}
        </svg>
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="flex items-baseline justify-between gap-1">
            <span className="text-[15px] font-bold">
              {plan.name}
              {isMax && <span className="ml-1 rounded bg-ink px-1 text-[11px] font-normal text-white">最大台数</span>}
            </span>
            <span className="font-mono text-[20px] font-bold text-teal" data-testid="plan-count">
              {m.count}台
            </span>
          </div>
          <div className="text-neutral-700">
            {plan.stallAngle}°駐車・{plan.aisleKind === 'oneway' ? '一方通行' : '双方向'}・方向{plan.orientation.toFixed(0)}°
          </div>
          <div className="text-neutral-700" data-testid="plan-aisle">
            通路幅 {plan.aisleWidths.map((w) => `${w.toFixed(2)}m`).join(' / ')}
          </div>
          <span className={cx('mt-1 inline-block rounded px-1.5 py-0.5 text-[11px]', opt.cls)} data-testid="plan-optimality">
            {opt.label}
          </span>
        </div>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-2 text-[12px] tabular-nums">
        <span>有効利用率 {(m.utilization * 100).toFixed(1)}%</span>
        <span>デッドスペース {(m.deadSpaceRatio * 100).toFixed(1)}%</span>
        <span>整列度 {(m.alignment * 100).toFixed(0)}%</span>
        <span>動線評価 {(m.accessibility * 100).toFixed(0)}%</span>
      </div>
      <div className="mt-1 text-[12px] text-neutral-500">配置方法：{plan.strategy.join('・')}</div>
      <details className="mt-1" open={errors > 0}>
        <summary className="cursor-pointer text-[12px] font-bold" data-testid="plan-issues-summary">
          問題点 {errors ? `重大${errors}件・` : ''}
          {warns}件の注意
        </summary>
        <ul className="mt-1 space-y-0.5 text-[12px]" data-testid="plan-issues">
          {plan.issues.map((i, k) => (
            <li key={k} className={cx('flex gap-1', ISSUE_CLS[i.level])}>
              <span className="w-3 shrink-0 font-bold">{ISSUE_MARK[i.level]}</span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      </details>
      <Btn variant={active ? 'default' : 'primary'} className="mt-2 w-full" onClick={onApply} testId={`apply-${plan.name}`}>
        {active ? '適用中' : 'この案を図面に適用'}
      </Btn>
    </div>
  );
}
