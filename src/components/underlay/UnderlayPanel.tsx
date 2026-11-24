'use client';
// 下絵パネル：測量図PDF・画像の取込、表示、縮尺合わせ、回転補正、頂点配置、距離測定、作図
import { useRef, useState, type JSX } from 'react';
import { useProject, type UnderlayTool } from '@/stores/projectStore';
import { useUnderlayUi } from '@/stores/underlayUi';
import { Btn, Confirm, LengthInput, NumInput, Section, Toggle, cx } from '@/components/ui';
import { importUnderlayFile, switchPdfPage } from '@/services/underlayImport';
import { imageCenter, setRotation, setScale, updateUnderlay, applyReferenceLength } from './actions';
import { pxDist, scaleFromDpi, scaleFromPdf, traceReadings } from '@/engine/underlay/transform';
import { vertexName } from '@/engine/geometry/polygon';

const SCALE_METHOD: Record<string, string> = { none: '未設定', reference: '基準寸法', 'pdf-scale': 'PDFの図面縮尺', dpi: '解像度と縮尺' };

export function UnderlayPanel(): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const { storage, commit, tool, setTool } = useProject();
  const ui = useUnderlayUi();
  const u = doc.underlay ?? null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pdfDenom, setPdfDenom] = useState<number | null>(250);
  const [dpi, setDpi] = useState<number | null>(300);
  const [dpiDenom, setDpiDenom] = useState<number | null>(250);

  const pickTool = (t: UnderlayTool): void => {
    ui.setPending([]);
    if (tool === t) {
      setTool('select');
      ui.setStatus(null);
      return;
    }
    setTool(t);
    ui.setStatus(
      {
        ulMove: '下絵をドラッグして移動します',
        ulCalibrate: '寸法がわかっている2点（例：辺の両端）を順にタップしてください',
        ulRotate: `${ui.rotateTarget === 0 ? '水平' : '垂直'}にしたい線（道路境界など）の2点をタップしてください`,
        ulTrace: '敷地の角を順番にタップして頂点を置きます（押したまま動かすと拡大鏡で微調整）',
        ulMeasure: '距離を測る2点をタップしてください',
      }[t],
    );
  };

  const onFile = async (f: File | undefined): Promise<void> => {
    if (!f || !storage) return;
    setError(null);
    try {
      const r = await importUnderlayFile(f, f.name, storage, setBusy);
      commit('測量図の取込', (d) => ({ ...d, underlay: r.meta, assetIds: [...new Set([...(d.assetIds ?? []), ...r.newAssetIds])] }));
      ui.setStatus('取り込みました。次に縮尺を合わせてください');
      setTimeout(() => window.dispatchEvent(new CustomEvent('ldc:fit')), 50);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const fileInput = (
    <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="underlay-file" />
  );

  if (!u) {
    return (
      <div data-testid="underlay-panel">
        <Section title="測量図を下絵として取り込む">
          <p className="text-[13px] text-neutral-600">既存の測量図・地積測量図（PDF・PNG・JPEG）を読み込み、縮尺を合わせて敷地の角をなぞると、寸法を読み取って敷地図面を作成できます。読み取った寸法は確認・修正してから確定します。</p>
          <Btn variant="primary" className="mt-3 w-full" onClick={() => fileRef.current?.click()} disabled={!!busy} testId="underlay-import">
            {busy ?? '測量図を読み込む（PDF・PNG・JPEG）'}
          </Btn>
          {fileInput}
          {error && (
            <p className="mt-2 text-[13px] text-signal" role="alert" data-testid="underlay-error">
              {error}
            </p>
          )}
          <p className="mt-2 text-[12px] text-neutral-500">元のファイルは図面データとは別に保存され、図面には参照だけが記録されます（上限30MB）。</p>
        </Section>
      </div>
    );
  }

  const readings = u.trace.length >= 2 ? traceReadings(u, u.trace) : [];
  const sides = readings.filter((r) => r.kind === 'side').slice(0, u.trace.length >= 3 ? u.trace.length : 1);
  const mmPerPx = u.scale * 1000;
  const ToolBtn = ({ t, children, testId }: { t: UnderlayTool; children: React.ReactNode; testId: string }): JSX.Element => (
    <Btn active={tool === t} onClick={() => pickTool(t)} disabled={u.locked} testId={testId} className="px-2">
      {children}
    </Btn>
  );

  return (
    <div data-testid="underlay-panel">
      {ui.status && (
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-teal bg-teal-light px-3 py-2 text-[13px] text-teal" role="status" data-testid="underlay-status">
          <span>{ui.status}</span>
          {tool.startsWith('ul') && (
            <button className="h-9 shrink-0 rounded bg-white px-2 text-[13px]" onClick={() => (setTool('select'), ui.setStatus(null), ui.setPending([]))}>
              終了
            </button>
          )}
        </div>
      )}
      <Section title="下絵">
        <div className="flex items-center justify-between gap-2 text-[13px]">
          <span className="min-w-0 truncate font-bold" data-testid="underlay-name">
            {u.fileName}
          </span>
          <span className="shrink-0 text-neutral-500">
            {u.source === 'application/pdf' ? 'PDF' : u.source === 'image/png' ? 'PNG' : 'JPEG'}・{u.pxWidth}×{u.pxHeight}px
          </span>
        </div>
        {u.source === 'application/pdf' && (u.pdfPageCount ?? 1) > 1 && (
          <label className="mt-2 flex items-center gap-2 text-[13px]">
            ページ
            <select
              className="h-10 rounded border border-neutral-300 bg-white px-2 text-[16px]"
              value={u.pdfPage ?? 1}
              onChange={async (e) => {
                if (!storage) return;
                setBusy('ページを描画中…');
                try {
                  const r = await switchPdfPage(u, Number(e.target.value), storage);
                  commit('PDFページの切替', (d) => (d.underlay ? { ...d, underlay: { ...d.underlay, ...r.patch }, assetIds: [...new Set([...(d.assetIds ?? []), r.newAssetId])] } : d));
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {Array.from({ length: u.pdfPageCount ?? 1 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1} / {u.pdfPageCount}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="mt-2 grid grid-cols-2 gap-x-2">
          <Toggle label="表示" checked={u.visible} onChange={(v) => updateUnderlay('下絵の表示', { visible: v })} testId="underlay-visible" />
          <Toggle label="ロック（誤操作防止）" checked={u.locked} onChange={(v) => updateUnderlay('下絵のロック', { locked: v })} />
        </div>
        <label className="mt-1 block text-[13px] text-neutral-600">
          透明度 <span className="font-mono tabular-nums" data-testid="underlay-opacity-value">{Math.round(u.opacity * 100)}%</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(u.opacity * 100)}
            onChange={(e) => useProject.getState().live((d) => (d.underlay ? { ...d, underlay: { ...d.underlay, opacity: Number(e.target.value) / 100 } } : d))}
            onPointerDown={() => useProject.getState().beginLive('下絵の透明度')}
            onPointerUp={() => useProject.getState().endLive()}
            onKeyUp={() => useProject.getState().endLive()}
            className="mt-1 h-8 w-full accent-[#0b5d63]"
            aria-label="下絵の不透明度"
            data-testid="underlay-opacity"
          />
        </label>
        {busy && <p className="text-[13px] text-neutral-600">{busy}</p>}
        {error && <p className="text-[13px] text-signal">{error}</p>}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Btn onClick={() => fileRef.current?.click()} disabled={!!busy}>
            別の図面に差し替え
          </Btn>
          <Btn variant="danger" onClick={() => setConfirmRemove(true)} testId="underlay-remove">
            下絵を外す
          </Btn>
        </div>
        {fileInput}
      </Section>

      <Section title="① 縮尺合わせ">
        <div className={cx('rounded-md border px-3 py-2 text-[13px]', u.scaleMethod === 'none' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-neutral-200')} data-testid="underlay-scale" data-method={u.scaleMethod}>
          {u.scaleMethod === 'none' ? '縮尺が未設定です。寸法の読み取りには縮尺合わせが必要です。' : `${SCALE_METHOD[u.scaleMethod]}：1px = ${mmPerPx.toFixed(2)}mm（画像幅 ${(u.pxWidth * u.scale).toFixed(2)}m）`}
        </div>
        <div className="mt-2 font-bold text-[13px]">基準寸法で合わせる（推奨）</div>
        <p className="text-[12px] text-neutral-500">図面に記載された寸法の両端を2点タップし、その実寸を入力します。</p>
        <div className="mt-1 grid grid-cols-[1fr_auto] items-end gap-2">
          <ToolBtn t="ulCalibrate" testId="ul-calibrate">
            {u.calibration ? '2点を指定し直す' : '画像上で2点を指定'}
          </ToolBtn>
          {u.calibration && <span className="pb-2 font-mono text-[12px] tabular-nums text-neutral-600">{pxDist(u.calibration.a, u.calibration.b).toFixed(1)}px</span>}
        </div>
        {u.calibration && (
          <LengthInput
            className="mt-2"
            label="実寸"
            unit="m"
            value={u.calibration.length > 0 ? u.calibration.length : null}
            min={0.001}
            onChange={(v) => v && applyReferenceLength(u.calibration!.a, u.calibration!.b, v)}
            testId="ul-ref-length"
          />
        )}
        {u.source === 'application/pdf' && u.paperMm && (
          <>
            <div className="mt-3 font-bold text-[13px]">PDFの図面縮尺で合わせる</div>
            <p className="text-[12px] text-neutral-500">
              用紙 {u.paperMm.w.toFixed(0)}×{u.paperMm.h.toFixed(0)}mm。原寸で作成されたPDFのみ正確です。
            </p>
            <div className="mt-1 grid grid-cols-[1fr_auto] items-end gap-2">
              <NumInput label="縮尺 1/" value={pdfDenom} digits={0} keypadMode="integer" onChange={setPdfDenom} />
              <Btn disabled={!pdfDenom || u.locked} onClick={() => pdfDenom && updateUnderlay('下絵の縮尺合わせ（PDF縮尺）', (x) => setScale(x, scaleFromPdf(x.paperMm!.w, x.pxWidth, pdfDenom), 'pdf-scale', imageCenter(x)))} testId="ul-pdf-scale">
                適用
              </Btn>
            </div>
          </>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-bold">スキャン解像度と縮尺で合わせる</summary>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <NumInput label="解像度" value={dpi} digits={0} suffix="dpi" keypadMode="integer" onChange={setDpi} />
            <NumInput label="縮尺 1/" value={dpiDenom} digits={0} keypadMode="integer" onChange={setDpiDenom} />
          </div>
          <Btn className="mt-2" disabled={!dpi || !dpiDenom || u.locked} onClick={() => dpi && dpiDenom && updateUnderlay('下絵の縮尺合わせ（解像度）', (x) => setScale(x, scaleFromDpi(dpi, dpiDenom, x.rasterScale), 'dpi', imageCenter(x)))}>
            適用
          </Btn>
        </details>
      </Section>

      <Section title="② 回転補正・位置">
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <NumInput label="回転" value={Math.round(u.rotation * 1000) / 1000} suffix="°" digits={3} onChange={(v) => v !== null && updateUnderlay('下絵の回転', (x) => setRotation(x, v, imageCenter(x)))} testId="ul-rotation" />
          <Btn onClick={() => updateUnderlay('下絵の回転', (x) => setRotation(x, 0, imageCenter(x)))} disabled={u.locked}>
            0°
          </Btn>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-1">
          {[-1, -0.1, 0.1, 1, 90].map((dlt) => (
            <Btn key={dlt} className="px-1 text-[13px]" disabled={u.locked} onClick={() => updateUnderlay('下絵の回転', (x) => setRotation(x, x.rotation + dlt, imageCenter(x)))} testId={`ul-rot-${dlt}`}>
              {dlt > 0 ? '+' : ''}
              {dlt}°
            </Btn>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Btn
            active={tool === 'ulRotate' && ui.rotateTarget === 0}
            disabled={u.locked}
            onClick={() => {
              ui.setRotateTarget(0);
              pickTool('ulRotate');
            }}
            testId="ul-rotate-h"
          >
            2点で水平に
          </Btn>
          <Btn
            active={tool === 'ulRotate' && ui.rotateTarget === 90}
            disabled={u.locked}
            onClick={() => {
              ui.setRotateTarget(90);
              pickTool('ulRotate');
            }}
          >
            2点で垂直に
          </Btn>
        </div>
        <div className="mt-2">
          <ToolBtn t="ulMove" testId="ul-move">
            下絵をドラッグで移動
          </ToolBtn>
        </div>
      </Section>

      <Section title="③ 敷地の角に頂点を配置">
        <div className="grid grid-cols-2 gap-2">
          <ToolBtn t="ulTrace" testId="ul-trace">
            {tool === 'ulTrace' ? '配置中（タップで追加）' : '頂点を配置する'}
          </ToolBtn>
          <ToolBtn t="ulMeasure" testId="ul-measure">
            距離を測る
          </ToolBtn>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Btn disabled={!u.trace.length || u.locked} onClick={() => updateUnderlay('頂点を1つ戻す', (x) => ({ trace: x.trace.slice(0, -1) }))} testId="ul-trace-undo">
            最後の頂点を削除
          </Btn>
          <Btn disabled={!u.trace.length || u.locked} onClick={() => updateUnderlay('頂点を全消去', { trace: [] })}>
            全消去
          </Btn>
        </div>
        {u.measure.length === 2 && (
          <p className="mt-2 text-[13px]" data-testid="measure-result">
            測定距離：<b className="font-mono">{(pxDist(u.measure[0], u.measure[1]) * u.scale).toFixed(3)}m</b>
          </p>
        )}
        {sides.length > 0 && (
          <table className="mt-2 w-full text-[13px] tabular-nums" data-testid="trace-table">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="font-normal">頂点間</th>
                <th className="text-right font-normal">読取距離</th>
                <th className="text-right font-normal">誤差目安</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((r) => (
                <tr key={r.label} className="border-t border-neutral-100">
                  <td>
                    {r.label}
                    {r.kind === 'diagonal' && <span className="ml-1 text-[11px] text-neutral-500">対角線</span>}
                  </td>
                  <td className="text-right font-mono">{r.measured.toFixed(3)}m</td>
                  <td className="text-right font-mono text-neutral-500">±{(r.uncertainty * 100).toFixed(1)}cm</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1 text-[12px] text-neutral-500">
          頂点 {u.trace.length}点{u.trace.length ? `（${u.trace.map((_, i) => vertexName(i)).join('・')}）` : ''}。誤差目安は頂点1点あたり±2画素の配置ずれを想定した値です。拡大して置くほど正確になります。
        </p>
        <Btn variant="primary" className="mt-2 w-full" disabled={u.trace.length < 3 || u.scaleMethod === 'none'} onClick={() => ui.setConfirmOpen(true)} testId="ul-confirm-open">
          寸法を確認して敷地図面を作成
        </Btn>
        {u.scaleMethod === 'none' && u.trace.length >= 3 && <p className="mt-1 text-[12px] text-amber-800">先に①で縮尺を合わせてください。</p>}
        {u.fitError !== undefined && (
          <p className="mt-2 text-[12px] text-neutral-600" data-testid="fit-error">
            下絵とCAD図面のずれ：最大 {(u.fitError * 100).toFixed(1)}cm（下絵はCADに合わせて位置・回転・縮尺を調整済み）
          </p>
        )}
      </Section>

      <Confirm
        open={confirmRemove}
        title="下絵を外しますか？"
        body="図面から下絵を外します。作成済みの敷地図面は残ります。元に戻す（↶）で復元できます。"
        okLabel="外す"
        danger
        onCancel={() => setConfirmRemove(false)}
        onOk={() => {
          setConfirmRemove(false);
          setTool('select');
          commit('下絵を外す', (d) => ({ ...d, underlay: null }));
        }}
      />
    </div>
  );
}
