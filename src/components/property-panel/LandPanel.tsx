'use client';
import type { JSX } from 'react';
// 土地寸法入力（辺・対角線・角度・座標を同時保持して組み合わせ可能）
import { useEffect, useState } from 'react';
import type { LandFocus, LandInput, SitePreview, Vec2 } from '@/types';
import { useLandUi } from '@/stores/landUi';
import { useProject } from '@/stores/projectStore';
import { AngleInput, Btn, LengthInput, NumInput, Section, Select, cx } from '@/components/ui';
import { interiorAngles, vertexName } from '@/engine/geometry/polygon';
import { constraintSummary } from '@/engine/constraints/solver';
import { formatDMS, formatLength, landMetrics, m2ToTsubo } from '@/engine/area-calculation';
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
  const preview = !site && sol?.preview && sol.preview.points.length >= 3 ? sol.preview : null;
  const drawSite = site ?? preview?.points ?? null;
  const met = drawSite ? landMetrics(drawSite) : null;
  const shownAngles = drawSite ? interiorAngles(drawSite) : null;
  const setGuide = useLandUi((x) => x.setGuide);
  const setFocus = useLandUi((x) => x.setFocus);
  useEffect(() => {
    setGuide(true);
    return () => {
      setGuide(false);
      setFocus(null);
    };
  }, [setGuide, setFocus]);
  // 入力欄にフォーカスしている間、その辺・角を図面上で強調する
  const focusProps = (f: LandFocus): { onFocusCapture: () => void; onBlurCapture: () => void } => ({
    onFocusCapture: () => setFocus(f),
    onBlurCapture: () => setFocus(null),
  });
  const coordCount = land.coords.filter(Boolean).length;
  const { count, required } = constraintSummary(land);
  const upd = (patch: Partial<LandInput>, label: string): void => setLand({ ...land, ...patch }, label);
  const dec = doc.display.decimals;

  return (
    <div data-testid="land-panel">
      <div className="border-b border-neutral-200 px-3 py-2">
        <Btn className="w-full" onClick={() => window.dispatchEvent(new CustomEvent('ldc:open-tab', { detail: 'underlay' }))} testId="land-from-underlay">
          ▧ 測量図（PDF・画像）から作成
        </Btn>
      </div>
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
        <div className="mt-2">
          <Select
            label="回る向き"
            testId="vertex-order"
            value={land.order === 'cw' ? 'cw' : 'ccw'}
            onChange={(v) => upd({ order: v === 'cw' ? 'cw' : undefined }, '頂点の並び順の変更')}
            options={[
              { value: 'ccw', label: '反時計回り（A→B を右へ、左回り）' },
              { value: 'cw', label: '時計回り（A→B を右へ、右回り）' },
            ]}
          />
          {coordCount >= 3 && <p className="mt-1 text-[12px] text-neutral-500">座標を3点以上入力しているため、回る向きは座標の並びで決まります。</p>}
        </div>
        <StartGuide pts={drawSite} n={n} cw={coordCount >= 3 ? (drawSite ? signed(drawSite) < 0 : false) : land.order === 'cw'} />
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
              <div key={`s${i}-${n}`} {...focusProps({ kind: 'side', index: i })}>
              <LengthInput
                testId={`side-${i}`}
                label={`${vertexName(i)}${vertexName((i + 1) % n)}`}
                unit={unit}
                value={s}
                min={0.001}
                allowEmpty
                placeholder={met && s === null ? `自動 ${formatLength(met.sides[i], unit, 2)}` : '未入力'}
                onChange={(v) => {
                  const sides = [...land.sides];
                  sides[i] = v;
                  upd({ sides }, `辺${vertexName(i)}${vertexName((i + 1) % n)}の変更`);
                }}
              />
              </div>
            ))}

          {tab === 'diagonals' && (
            <>
              {land.diagonals.map((d, k) => (
                <div key={d.id} className="grid grid-cols-[56px_56px_1fr_auto] items-center gap-1" {...focusProps({ kind: 'diagonal', a: d.a, b: d.b })}>
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
                <div key={`a${i}-${n}`} {...focusProps({ kind: 'angle', index: i })}>
                <AngleInput
                  testId={`angle-${i}`}
                  label={vertexName(i)}
                  value={a}
                  allowEmpty
                  digits={6}
                  placeholder={shownAngles && a === null ? `自動 ${formatDMS(shownAngles[i])}` : '未入力'}
                  onChange={(v) => {
                    const angles = [...land.angles];
                    angles[i] = v;
                    upd({ angles }, `角${vertexName(i)}の変更`);
                  }}
                />
                </div>
              ))}
              <p className="text-[12px] text-neutral-500">内角（土地の内側の角度）を入力。90.5 / 90°30′00″ / 90-30-00 / 90度30分 の形式に対応。空欄の角は自動で調整されます。</p>
            </>
          )}

          {tab === 'coords' && (
            <>
              {land.coords.map((c, i) => (
                <div key={`c${i}-${n}`} className="grid grid-cols-[28px_1fr_1fr_auto] items-center gap-1" {...focusProps({ kind: 'vertex', index: i })}>
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
        {preview && <PreviewActions preview={preview} />}
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
              <Stat label={preview ? '面積（仮の形）' : '面積'} value={`${met.area.toFixed(dec)}㎡`} sub={`${m2ToTsubo(met.area).toFixed(dec)}坪`} testId="area" />
              <Stat label={preview ? '外周（仮の形）' : '外周'} value={`${met.perimeter.toFixed(dec)}m`} sub={`${met.sides.length}辺`} testId="perimeter" />
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
        {sol && (preview?.kind === 'mismatch' || (sol.candidates[0] && sol.candidates[0].residuals.length > 0 && sol.status === 'approximate')) && (
          <details className="mt-2 text-[12px]" open={!!preview} data-testid="residual-table">
            <summary className="cursor-pointer font-bold">誤差の内訳（入力値と図上の値の差）</summary>
            <table className="mt-1 w-full tabular-nums">
              <tbody>
                {[...(preview?.kind === 'mismatch' ? preview.residuals : sol.candidates[Math.min(doc.selectedCandidate, sol.candidates.length - 1)].residuals)]
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

function signed(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += (p.x - pts[0].x) * (q.y - pts[0].y) - (q.x - pts[0].x) * (p.y - pts[0].y);
  }
  return a / 2;
}

/** 始点Aと回る向きの説明（形が無いときは見本の形で示す） */
function StartGuide({ pts, n, cw }: { pts: Vec2[] | null; n: number; cw: boolean }): JSX.Element {
  // 見本：正多角形（A を左下、AB を右向き）
  const sample = (): Vec2[] => {
    const out: Vec2[] = [{ x: 0, y: 0 }];
    let h = 0;
    for (let i = 1; i < n; i++) {
      out.push({ x: out[i - 1].x + Math.cos(h), y: out[i - 1].y + Math.sin(h) });
      h += ((cw ? -1 : 1) * 2 * Math.PI) / n;
    }
    return out;
  };
  const P = pts && pts.length === n ? pts : sample();
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = 64 / Math.max(maxX - minX, maxY - minY, 1e-6);
  const W = (maxX - minX) * k + 28, H = (maxY - minY) * k + 28;
  const T = (p: Vec2): [number, number] => [14 + (p.x - minX) * k, H - 14 - (p.y - minY) * k];
  const cxp = P.reduce((a, p) => a + p.x, 0) / n, cyp = P.reduce((a, p) => a + p.y, 0) / n;
  const [ax, ay] = T(P[0]);
  const [bx, by] = T(P[1 % n]);
  const mx = ax + (bx - ax) * 0.55, my = ay + (by - ay) * 0.55;
  const ang = Math.atan2(by - ay, bx - ax);
  const order = Array.from({ length: Math.min(n, 4) }, (_, i) => vertexName(i)).join('→');
  return (
    <div className="mt-2 flex items-center gap-3 rounded-md border border-neutral-200 bg-white px-2 py-2" data-testid="start-guide">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[84px] w-[96px] shrink-0" aria-hidden>
        <polygon points={P.map((p) => T(p).join(',')).join(' ')} fill="#eef5f5" stroke="#0b5d63" strokeWidth={1.4} strokeDasharray={pts ? undefined : '3 2'} />
        <line x1={ax} y1={ay} x2={mx} y2={my} stroke="#1d4ed8" strokeWidth={2.4} />
        <polygon points="0,-4 8,0 0,4" fill="#1d4ed8" transform={`translate(${mx} ${my}) rotate(${(ang * 180) / Math.PI})`} />
        <circle cx={ax} cy={ay} r={4} fill="#1d4ed8" stroke="#fff" strokeWidth={1} />
        {P.map((p, i) => {
          const [x, y] = T(p);
          const [cx0, cy0] = T({ x: cxp, y: cyp });
          const dx = x - cx0, dy = y - cy0, l = Math.hypot(dx, dy) || 1;
          return (
            <text key={i} x={x + (dx / l) * 9} y={y + (dy / l) * 9 + 3.5} fontSize={i === 0 ? 11 : 9.5} fontWeight={i === 0 ? 700 : 500} textAnchor="middle" fill={i === 0 ? '#1d4ed8' : '#14161a'}>
              {vertexName(i)}
            </text>
          );
        })}
      </svg>
      <div className="text-[12px] leading-snug text-neutral-700">
        <div className="font-bold text-ink">
          <span className="text-[#1d4ed8]">A</span> が始点、{order}{n > 4 ? '…' : ''} の順に{cw ? '時計回り（右回り）' : '反時計回り（左回り）'}
        </div>
        <div className="mt-0.5">辺「AB」は A から B まで。図面の青い矢印が A→B の向きです。入力中の辺は図面で水色に光ります。</div>
        {!pts && <div className="mt-0.5 text-neutral-500">（図は見本です）</div>}
      </div>
    </div>
  );
}

/** 仮の形のときの操作（自動調整した形の確定・合わない寸法の修正） */
function PreviewActions({ preview }: { preview: SitePreview }): JSX.Element {
  const doc = useProject((x) => x.doc)!;
  const setLand = useProject((x) => x.setLand);
  const land = doc.land;
  const n = land.vertexCount;
  const pts = preview.points;
  const angs = interiorAngles(pts);
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  const c = preview.conflict;
  const kindName = (k: string): string => (k === 'side' ? '辺' : k === 'diagonal' ? '対角線' : k === 'angle' ? '角' : '座標');
  const fixConflict = (mode: 'replace' | 'remove'): void => {
    if (!c) return;
    let next: LandInput = land;
    if (c.kind === 'side') {
      const i = land.sides.findIndex((_, j) => `${vertexName(j)}${vertexName((j + 1) % n)}` === c.label);
      if (i < 0) return;
      next = { ...land, sides: land.sides.map((v, j) => (j === i ? (mode === 'replace' ? r6(c.actual) : null) : v)) };
    } else if (c.kind === 'diagonal') {
      const k = land.diagonals.findIndex((d) => `${vertexName(d.a)}${vertexName(d.b)}` === c.label);
      if (k < 0) return;
      next = { ...land, diagonals: mode === 'replace' ? land.diagonals.map((d, j) => (j === k ? { ...d, length: r6(c.actual) } : d)) : land.diagonals.filter((_, j) => j !== k) };
    } else if (c.kind === 'angle') {
      const i = land.angles.findIndex((_, j) => vertexName(j) === c.label);
      if (i < 0) return;
      next = { ...land, angles: land.angles.map((v, j) => (j === i ? (mode === 'replace' ? r6(c.actual) : null) : v)) };
    } else return;
    setLand(next, `${kindName(c.kind)}${c.label}の修正`);
  };
  if (preview.kind === 'auto') {
    return (
      <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900" data-testid="preview-auto">
        <div className="font-bold">仮の形を表示中（角度を自動調整）</div>
        <p className="mt-1 text-[12px]">
          自動で決めた値：
          {[...preview.autoAngles.map((i) => `角${vertexName(i)} ${formatDMS(angs[i])}`), ...preview.autoSides.map((i) => `辺${vertexName(i)}${vertexName((i + 1) % n)} ${Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y).toFixed(2)}m`)].join('、')}
        </p>
        <p className="mt-1 text-[12px]">現地と同じ形なら確定してください。違う場合は、分かっている角度か対角線を入力すると形が変わります。</p>
        <Btn
          className="mt-2 w-full"
          testId="accept-preview"
          onClick={() =>
            setLand(
              {
                ...land,
                angles: land.angles.map((a, i) => (a === null ? r6(angs[i]) : a)),
                sides: land.sides.map((v, i) => (v === null ? r6(Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y)) : v)),
              },
              '自動調整した形で確定',
            )
          }
        >
          この形で確定（自動の値を入力欄に反映）
        </Btn>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-signal bg-red-50 px-3 py-2 text-[13px] text-signal" data-testid="preview-mismatch">
      <div className="font-bold">寸法が合っていません（仮の形を表示中）</div>
      {c ? (
        <>
          <p className="mt-1 text-[12px] text-ink">
            {kindName(c.kind)}
            <b>{c.label}</b> が合いません。入力 {c.kind === 'angle' ? formatDMS(c.target) : `${c.target.toFixed(3)}m`} ／ 他の寸法から求めた値 {c.kind === 'angle' ? formatDMS(c.actual) : `${c.actual.toFixed(3)}m`}。
            入力ミスか、頂点の順番（どの角がAか・回る向き）が違う可能性があります。
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Btn testId="conflict-replace" onClick={() => fixConflict('replace')}>
              {c.kind === 'angle' ? formatDMS(c.actual) : `${c.actual.toFixed(2)}m`} に直す
            </Btn>
            <Btn variant="ghost" testId="conflict-remove" onClick={() => fixConflict('remove')}>
              {c.kind === 'diagonal' ? 'この対角線を削除' : '未入力に戻す'}
            </Btn>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[12px] text-ink">合わない寸法が複数あります。下の「誤差の内訳」で差の大きい寸法から確認してください。</p>
      )}
    </div>
  );
}
