'use client';
import type { JSX } from 'react';
// 土地寸法入力（辺・対角線・角度・座標を同時保持して組み合わせ可能）
import { useState } from 'react';
import type { LandInput } from '@/types';
import { useProject } from '@/stores/projectStore';
import { AngleInput, Btn, LengthInput, NumInput, Section, Select, cx } from '@/components/ui';
import { vertexName } from '@/engine/geometry/polygon';
import { constraintSummary } from '@/engine/constraints/solver';
import { formatDMS, landMetrics, m2ToTsubo } from '@/engine/area-calculation';
import { currentSite } from '@/engine/export/drawingModel';
import { resizeLand } from '@/services/projectFactory';
import { newId } from '@/engine/parking-optimizer/stallOps';

type Tab = 'sides' | 'diagonals' | 'angles' | 'coords';

const STATUS: Record<string, { label: string; cls: string }> = {
  exact: { label: '厳密解（形状確定）', cls: 'bg-teal-light text-teal border-teal' },
  approximate: { label: '近似解（最小二乗・誤差内）', cls: 'bg-blue-50 text-blue-800 border-blue-300' },
  multiple: { label: '複数の候補あり', cls: 'bg-amber-50 text-amber-900 border-amber-300' },
  underdetermined: { label: '寸法不足', cls: 'bg-amber-50 text-amber-900 border-amber-300' },
  inconsistent: { label: '入力値の矛盾', cls: 'bg-red-50 text-signal border-signal' },
  invalid: { label: '入力エラー', cls: 'bg-red-50 text-signal border-signal' },
};

export function LandPanel(): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const setLand = useProject((s) => s.setLand);
  const commit = useProject((s) => s.commit);
  const [tab, setTab] = useState<Tab>('sides');
  const land = doc.land;
  const unit = doc.display.unit;
  const n = land.vertexCount;
  const sol = doc.solution;
  const site = currentSite(doc);
  const met = site ? landMetrics(site) : null;
  const { count, required } = constraintSummary(land);
  const upd = (patch: Partial<LandInput>, label: string): void => setLand({ ...land, ...patch }, label);
  const dec = doc.display.decimals;

  return (
    <div data-testid="land-panel">
      <Section title="土地の形状">
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <Select
            label="頂点数"
            testId="vertex-count"
            value={n}
            onChange={(v) => setLand(resizeLand(land, v), '頂点数の変更')}
            options={Array.from({ length: 18 }, (_, i) => ({ value: i + 3, label: `${i + 3}角形（${vertexName(0)}〜${vertexName(i + 2)}）` }))}
          />
          <span className="text-[12px] text-neutral-500 tabular-nums">
            条件 {count}/{required}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1" role="tablist">
          {(
            [
              ['sides', '辺の長さ'],
              ['diagonals', '対角線'],
              ['angles', '角度'],
              ['coords', '座標'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              data-testid={`land-tab-${k}`}
              className={cx('min-h-[40px] rounded-md border text-[13px]', tab === k ? 'border-teal bg-teal text-white' : 'border-neutral-300 bg-white')}
              onClick={() => setTab(k)}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="mt-3 space-y-2">
          {tab === 'sides' &&
            land.sides.map((s, i) => (
              <LengthInput
                key={`s${i}-${n}`}
                testId={`side-${i}`}
                label={`${vertexName(i)}${vertexName((i + 1) % n)}`}
                unit={unit}
                value={s}
                min={0.001}
                onChange={(v) => {
                  const sides = [...land.sides];
                  sides[i] = v;
                  upd({ sides }, `辺${vertexName(i)}${vertexName((i + 1) % n)}の変更`);
                }}
              />
            ))}

          {tab === 'diagonals' && (
            <>
              {land.diagonals.map((d, k) => (
                <div key={d.id} className="grid grid-cols-[56px_56px_1fr_auto] items-center gap-1">
                  <select
                    aria-label="始点"
                    className="h-10 rounded border border-neutral-300 bg-white text-[16px]"
                    value={d.a}
                    onChange={(e) => upd({ diagonals: land.diagonals.map((x, j) => (j === k ? { ...x, a: Number(e.target.value) } : x)) }, '対角線の変更')}
                  >
                    {Array.from({ length: n }, (_, i) => (
                      <option key={i} value={i}>
                        {vertexName(i)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="終点"
                    className="h-10 rounded border border-neutral-300 bg-white text-[16px]"
                    value={d.b}
                    onChange={(e) => upd({ diagonals: land.diagonals.map((x, j) => (j === k ? { ...x, b: Number(e.target.value) } : x)) }, '対角線の変更')}
                  >
                    {Array.from({ length: n }, (_, i) => (
                      <option key={i} value={i}>
                        {vertexName(i)}
                      </option>
                    ))}
                  </select>
                  <LengthInput
                    testId={`diag-${k}`}
                    unit={unit}
                    value={d.length}
                    allowEmpty={false}
                    min={0.001}
                    onChange={(v) => v !== null && upd({ diagonals: land.diagonals.map((x, j) => (j === k ? { ...x, length: v } : x)) }, '対角線の変更')}
                  />
                  <Btn variant="ghost" title="対角線を削除" onClick={() => upd({ diagonals: land.diagonals.filter((_, j) => j !== k) }, '対角線の削除')}>
                    ✕
                  </Btn>
                </div>
              ))}
              <Btn
                testId="add-diagonal"
                onClick={() => {
                  // まだ使っていない非隣接の組を提案
                  let pair: [number, number] = [0, Math.min(2, n - 1)];
                  outer: for (let a = 0; a < n; a++)
                    for (let b = a + 2; b < n; b++) {
                      if (a === 0 && b === n - 1) continue;
                      if (!land.diagonals.some((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a))) {
                        pair = [a, b];
                        break outer;
                      }
                    }
                  const len = site ? Math.hypot(site[pair[0]].x - site[pair[1]].x, site[pair[0]].y - site[pair[1]].y) : 10;
                  upd({ diagonals: [...land.diagonals, { id: newId('d'), a: pair[0], b: pair[1], length: Math.round(len * 100) / 100 }] }, '対角線の追加');
                }}
              >
                ＋ 対角線を追加
              </Btn>
              <p className="text-[12px] text-neutral-500">任意の2頂点間の距離を入力します。複数入力すると誤差の検証にも使われます。</p>
            </>
          )}

          {tab === 'angles' && (
            <>
              {land.angles.map((a, i) => (
                <AngleInput
                  key={`a${i}-${n}`}
                  testId={`angle-${i}`}
                  label={vertexName(i)}
                  value={a}
                  allowEmpty
                  digits={6}
                  onChange={(v) => {
                    const angles = [...land.angles];
                    angles[i] = v;
                    upd({ angles }, `角${vertexName(i)}の変更`);
                  }}
                />
              ))}
              <p className="text-[12px] text-neutral-500">内角を入力。90.5 / 90°30′00″ / 90-30-00 / 90度30分 の形式に対応。</p>
            </>
          )}

          {tab === 'coords' && (
            <>
              {land.coords.map((c, i) => (
                <div key={`c${i}-${n}`} className="grid grid-cols-[28px_1fr_1fr_auto] items-center gap-1">
                  <span className="text-[13px] font-bold">{vertexName(i)}</span>
                  <NumInput
                    testId={`coord-x-${i}`}
                    value={c?.x ?? null}
                    allowEmpty
                    placeholder="X"
                    onChange={(v) => {
                      const coords = [...land.coords];
                      coords[i] = v === null ? null : { x: v, y: c?.y ?? 0 };
                      upd({ coords }, `座標${vertexName(i)}の変更`);
                    }}
                  />
                  <NumInput
                    testId={`coord-y-${i}`}
                    value={c?.y ?? null}
                    allowEmpty
                    placeholder="Y"
                    onChange={(v) => {
                      const coords = [...land.coords];
                      coords[i] = v === null ? null : { x: c?.x ?? 0, y: v };
                      upd({ coords }, `座標${vertexName(i)}の変更`);
                    }}
                  />
                  <Btn
                    variant="ghost"
                    title="計算座標を取り込む"
                    disabled={!site}
                    onClick={() => {
                      const coords = [...land.coords];
                      coords[i] = site ? { x: Math.round(site[i].x * 1e4) / 1e4, y: Math.round(site[i].y * 1e4) / 1e4 } : null;
                      upd({ coords }, '座標の取込');
                    }}
                  >
                    ⤓
                  </Btn>
                </div>
              ))}
              <p className="text-[12px] text-neutral-500">X=東, Y=北（m）。2点以上で位置と向きが固定されます。⤓ で現在の計算座標を取り込めます。</p>
            </>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <LengthInput label="許容誤差" unit="mm" value={land.tolerance} allowEmpty={false} min={0} onChange={(v) => v !== null && upd({ tolerance: v }, '許容誤差の変更')} />
          <Btn
            variant="ghost"
            onClick={() => {
              if (!site) return;
              commit('座標で確定', (d) => {
                const coords = site.map((p) => ({ x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 }));
                const nl = { ...d.land, coords };
                return { ...d, land: nl };
              });
            }}
            disabled={!site}
          >
            全座標を確定
          </Btn>
        </div>
      </Section>

      <Section title="計算結果">
        {sol && (
          <div className={cx('rounded-md border px-3 py-2 text-[13px]', STATUS[sol.status]?.cls)} data-testid="solve-status" data-status={sol.status}>
            <div className="font-bold">{STATUS[sol.status]?.label}</div>
            {sol.messages.map((m, i) => (
              <p key={i} className="mt-1">
                {m}
              </p>
            ))}
          </div>
        )}
        {sol && sol.candidates.length > 1 && (
          <div className="mt-2">
            <div className="text-[13px] font-bold">形状候補を選択</div>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {sol.candidates.map((c, i) => (
                <button
                  key={i}
                  data-testid={`candidate-${i}`}
                  onClick={() => commit('形状候補の選択', (d) => ({ ...d, selectedCandidate: i }))}
                  className={cx('rounded-md border p-1 text-[12px]', doc.selectedCandidate === i ? 'border-teal ring-2 ring-teal' : 'border-neutral-300')}
                >
                  <MiniPoly pts={c.points} />
                  候補{i + 1}
                  {c.mirrorOf !== undefined ? '（鏡像）' : ''}
                  <div className="tabular-nums text-neutral-500">{Math.abs(c.points.reduce((s, p, k) => s + p.x * c.points[(k + 1) % c.points.length].y - c.points[(k + 1) % c.points.length].x * p.y, 0) / 2).toFixed(2)}㎡</div>
                </button>
              ))}
            </div>
          </div>
        )}
        {met && (
          <div className="mt-3" data-testid="metrics">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="面積" value={`${met.area.toFixed(dec)}㎡`} sub={`${m2ToTsubo(met.area).toFixed(dec)}坪`} testId="area" />
              <Stat label="外周" value={`${met.perimeter.toFixed(dec)}m`} sub={`${met.sides.length}辺`} testId="perimeter" />
            </div>
            <table className="mt-2 w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="font-normal">辺</th>
                  <th className="text-right font-normal">長さ</th>
                  <th className="text-right font-normal">頂点角</th>
                </tr>
              </thead>
              <tbody>
                {met.sides.map((s, i) => (
                  <tr key={i} className="border-t border-neutral-100">
                    <td>
                      {vertexName(i)}
                      {vertexName((i + 1) % met.sides.length)}
                    </td>
                    <td className="text-right font-mono">{s.toFixed(dec + 1)}m</td>
                    <td className="text-right font-mono">
                      {vertexName(i)} {formatDMS(met.angles[i])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sol && sol.candidates[0] && sol.candidates[0].residuals.length > 0 && (sol.status === 'approximate' || sol.status === 'inconsistent') && (
          <details className="mt-2 text-[12px]" open={sol.status === 'inconsistent'}>
            <summary className="cursor-pointer font-bold">誤差の内訳</summary>
            <table className="mt-1 w-full tabular-nums">
              <tbody>
                {[...sol.candidates[Math.min(doc.selectedCandidate, sol.candidates.length - 1)].residuals]
                  .sort((a, b) => Math.abs(b.error) - Math.abs(a.error))
                  .map((r, i) => (
                    <tr key={i} className="border-t border-neutral-100">
                      <td>{{ side: '辺', diagonal: '対角線', angle: '角', coord: '座標' }[r.kind]}</td>
                      <td>{r.label}</td>
                      <td className="text-right font-mono">{r.target.toFixed(4)}</td>
                      <td className={cx('text-right font-mono', Math.abs(r.error) > land.tolerance && r.kind !== 'angle' && 'text-signal')}>
                        {r.error >= 0 ? '+' : ''}
                        {r.kind === 'angle' ? `${r.error.toFixed(4)}°` : `${(r.error * 1000).toFixed(1)}mm`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        )}
      </Section>
    </div>
  );
}

export function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }): JSX.Element {
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-3 py-2">
      <div className="text-[12px] text-neutral-500">{label}</div>
      <div className="font-mono text-[18px] font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      {sub && <div className="text-[12px] text-neutral-500 tabular-nums">{sub}</div>}
    </div>
  );
}

export function MiniPoly({ pts }: { pts: { x: number; y: number }[] }): JSX.Element {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = 50 / Math.max(maxX - minX, maxY - minY, 1e-6);
  return (
    <svg viewBox="0 0 60 60" className="mx-auto h-14 w-14">
      <polygon points={pts.map((p) => `${5 + (p.x - minX) * s},${55 - (p.y - minY) * s}`).join(' ')} fill="#e6f1f1" stroke="#0b5d63" strokeWidth="1.5" />
    </svg>
  );
}
