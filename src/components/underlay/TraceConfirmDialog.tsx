'use client';
// 画像から読み取った寸法の確認・修正ダイアログ。ここで確定するまで土地データは変更しない。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { useProject } from '@/stores/projectStore';
import { useUnderlayUi } from '@/stores/underlayUi';
import { Btn, LengthInput, Toggle, cx } from '@/components/ui';
import { applyFit, fitSimilarity, landFromReadings, normalizeTraceOrder, pxToWorld, traceReadings } from '@/engine/underlay/transform';
import { solveLand, isDrawable } from '@/engine/constraints/solver';
import { polygonArea } from '@/engine/geometry/polygon';
import { m2ToTsubo } from '@/engine/area-calculation';

export function TraceConfirmDialog(): JSX.Element | null {
  const open = useUnderlayUi((s) => s.confirmOpen);
  const setOpen = useUnderlayUi((s) => s.setConfirmOpen);
  const doc = useProject((s) => s.doc);
  const u = doc?.underlay;
  const norm = useMemo(() => (u && u.trace.length >= 3 ? normalizeTraceOrder(u, u.trace) : null), [u]);
  const readings = useMemo(() => (u && norm ? traceReadings(u, norm.pts) : []), [u, norm]);
  const [values, setValues] = useState<(number | null)[]>([]);
  const [checked, setChecked] = useState(false);
  const [align, setAlign] = useState(true);

  useEffect(() => {
    if (open) {
      // 初期値は読取値を cm 単位に丸めた値（あくまで仮の値）
      setValues(readings.map((r) => Math.round(r.measured * 100) / 100));
      setChecked(false);
    }
  }, [open, readings]);

  const preview = useMemo(() => {
    if (!open || !norm || values.some((v) => v === null || !(v! > 0))) return null;
    const land = landFromReadings(norm.pts.length, readings.map((r, i) => ({ ...r, value: values[i]! })), { ...doc!.land });
    return { land, sol: solveLand(land) };
  }, [open, norm, readings, values, doc]);

  if (!open || !u || !norm || !doc) return null;
  const n = norm.pts.length;
  const edited = values.map((v, i) => v !== null && Math.abs(v - Math.round(readings[i].measured * 100) / 100) > 1e-9);
  const hasLand = doc.land.sides.some((x) => x !== null) || doc.land.coords.some(Boolean) || doc.land.diagonals.length > 0;
  const ok = !!preview && isDrawable(preview.sol);
  const area = ok ? polygonArea(preview!.sol.candidates[0].points) : 0;

  const create = (): void => {
    if (!preview || !ok) return;
    const st = useProject.getState();
    st.commit('下絵から敷地図面を作成', (d) => {
      const sol = preview.sol;
      let selected = 0;
      let under = d.underlay ? { ...d.underlay, trace: norm.pts } : d.underlay;
      if (under) {
        // 複数解のときは下絵の形に最も近い候補を選び、下絵をCAD形状に位置合わせ
        const src = norm.pts.map((p) => pxToWorld(under!, p));
        const fits = sol.candidates.map((c) => fitSimilarity(src, c.points));
        selected = fits.reduce((bi, f, i) => (f.rms < fits[bi].rms ? i : bi), 0);
        if (align) under = { ...under, ...applyFit(under, fits[selected]), fitError: fits[selected].max };
      }
      return { ...d, land: preview.land, solution: sol, selectedCandidate: selected, underlay: under };
    });
    st.setTool('select');
    useUnderlayUi.getState().setStatus('敷地図面を作成しました。「土地」タブで寸法を確認・編集できます');
    setOpen(false);
    setTimeout(() => window.dispatchEvent(new CustomEvent('ldc:fit')), 60);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="tc-title" data-testid="trace-confirm">
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white sm:rounded-2xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 id="tc-title" className="text-[17px] font-bold">
            読み取った寸法の確認
          </h2>
          <p className="mt-1 text-[13px] text-neutral-600">
            下記は下絵の縮尺と頂点位置から計算した<b>読取値</b>で、まだ確定していません。測量図に記載の寸法がある場合はその値に修正してください。
          </p>
          {norm.reversed && <p className="mt-1 text-[12px] text-amber-800">頂点が時計回りに置かれていたため、A を起点に反時計回りの順へ並べ替えました（鏡像の作図を防ぐため）。</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
          <table className="w-full text-[13px] tabular-nums">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="font-normal">寸法</th>
                <th className="text-right font-normal">読取値</th>
                <th className="pl-2 font-normal">採用する値</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((r, i) => (
                <tr key={r.label} className="border-t border-neutral-100" data-testid={`tc-row-${r.label}`}>
                  <td className="py-1">
                    <div className="font-bold">{r.label}</div>
                    <div className="text-[11px] text-neutral-500">{r.kind === 'side' ? '辺' : '対角線'}</div>
                  </td>
                  <td className="text-right font-mono">
                    {r.measured.toFixed(3)}
                    <div className="text-[11px] text-neutral-500">±{(r.uncertainty * 100).toFixed(1)}cm</div>
                  </td>
                  <td className="py-1 pl-2">
                    <LengthInput unit="m" value={values[i] ?? null} allowEmpty={false} min={0.001} onChange={(v) => setValues((vs) => vs.map((x, k) => (k === i ? v : x)))} testId={`tc-value-${r.label}`} />
                    <span className={cx('mt-0.5 inline-block rounded px-1 text-[11px]', edited[i] ? 'bg-teal-light text-teal' : 'bg-amber-50 text-amber-800')} data-testid={`tc-state-${r.label}`}>
                      {edited[i] ? '修正済み' : '読取値（要確認）'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[12px] text-neutral-500">
            {n}角形の形状を一意に決めるため、全{n}辺と頂点Aからの対角線{n - 3}本を使います。作成後は「土地」タブで角度・座標などを追加・修正できます。
          </p>
          <div className={cx('mt-2 rounded-md border px-3 py-2 text-[13px]', ok ? 'border-teal bg-teal-light/50' : 'border-amber-300 bg-amber-50')} data-testid="tc-preview">
            {ok ? (
              <>
                作成される敷地：面積 <b className="font-mono">{area.toFixed(2)}㎡</b>（{m2ToTsubo(area).toFixed(2)}坪）
                {preview!.sol.status === 'multiple' && '・形状候補が複数あるため下絵に最も近い形を選びます'}
              </>
            ) : (
              preview?.sol.messages[0] ?? '寸法を入力してください'
            )}
          </div>
          {hasLand && <p className="mt-2 text-[12px] text-amber-800">現在の土地寸法はこの寸法で置き換えられます（元に戻す ↶ で復元できます）。</p>}
          <div className="mt-2">
            <Toggle label="下絵を作成した図面に位置合わせする" checked={align} onChange={setAlign} />
            <Toggle label="すべての寸法を確認しました" checked={checked} onChange={setChecked} testId="tc-checked" />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 px-4 py-3">
          <Btn onClick={() => setOpen(false)} testId="tc-cancel">
            キャンセル
          </Btn>
          <Btn variant="primary" disabled={!checked || !ok} onClick={create} testId="tc-create">
            この寸法で作図
          </Btn>
        </div>
      </div>
    </div>
  );
}
