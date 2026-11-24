'use client';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { DisplaySettings, DrawingMode, LengthUnit } from '@/types';
import { useProject } from '@/stores/projectStore';
import { Btn, NumInput, Section, Select, Toggle } from '@/components/ui';
import { buildExportSvg, STANDARD_SCALES, type PaperSize } from '@/engine/export/paper';
import type { VersionInfo } from '@/services/storage';
import { displayMatrix } from '@/engine/underlay/transform';
import { assetDataUrl } from '@/services/underlayImport';

export function OutputPanel(): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const { commit, storage, load } = useProject();
  const [paper, setPaper] = useState<PaperSize>('A3');
  const [scaleSel, setScaleSel] = useState<number | 'auto' | 'custom'>('auto');
  const [customScale, setCustomScale] = useState<number | null>(300);
  const [mode, setMode] = useState<DrawingMode>(doc.mode);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [withUnderlay, setWithUnderlay] = useState(false);
  const [ulHref, setUlHref] = useState<string | null>(null);
  const ul = doc.underlay;
  useEffect(() => {
    if (!withUnderlay || !ul || !storage) return setUlHref(null);
    let alive = true;
    assetDataUrl(storage, ul.displayAssetId).then((h) => alive && setUlHref(h)).catch(() => alive && setUlHref(null));
    return () => {
      alive = false;
    };
  }, [withUnderlay, ul?.displayAssetId, storage]);
  const underlayOpt = useMemo(() => (withUnderlay && ul && ulHref ? { href: ulHref, matrix: displayMatrix(ul), opacity: ul.opacity, w: ul.pxWidth, h: ul.pxHeight } : undefined), [withUnderlay, ul, ulHref]);
  const d = doc.display;
  const setD = (patch: Partial<DisplaySettings>): void => commit('表示設定', (x) => ({ ...x, display: { ...x.display, ...patch } }));
  const scale = scaleSel === 'custom' ? customScale ?? 100 : scaleSel;

  const preview = useMemo(() => buildExportSvg(doc, { paper, scale, mode, underlay: underlayOpt }), [doc, paper, scale, mode, underlayOpt]);

  useEffect(() => {
    storage?.listVersions(doc.id).then(setVersions).catch(() => setVersions([]));
  }, [storage, doc.id, doc.updatedAt]);

  const run = async (fmt: 'pdf' | 'png' | 'jpeg'): Promise<void> => {
    setBusy(fmt);
    setMsg(null);
    try {
      const ex = await import('@/services/exporter');
      const opt = { paper, scale, mode, title: doc.name, underlay: underlayOpt };
      const r = fmt === 'pdf' ? await ex.exportPdf(doc, opt) : await ex.exportRaster(doc, opt, fmt);
      // 一部ブラウザで日本語ファイル名が無視されるため英数字名にする（図面名はPDF内・プロパティに記載）
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const name = `LandDesignCAD_${ex.safeFileName(doc.name).replace(/[^A-Za-z0-9_-]/g, '') || 'drawing'}_${ymd}_${mode === 'cad' ? 'cad' : 'proposal'}_${paper}_1-${preview.layout.scale}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
      const res = await ex.saveFile(name, r.blob);
      setMsg(res === 'saved' ? `${name} を出力しました（${(r.blob.size / 1024).toFixed(0)}KB）${r.warnings.length ? '／' + r.warnings.join(' ') : ''}` : '保存がキャンセルされました');
    } catch (e) {
      setMsg(`出力に失敗しました：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="output-panel">
      <Section title="図面表示">
        <div className="grid grid-cols-2 gap-x-2">
          <Toggle label="寸法" checked={d.showDimensions} onChange={(v) => setD({ showDimensions: v })} testId="toggle-dims" />
          <Toggle label="対角線" checked={d.showDiagonals} onChange={(v) => setD({ showDiagonals: v })} />
          <Toggle label="内角" checked={d.showAngles} onChange={(v) => setD({ showAngles: v })} />
          <Toggle label="座標" checked={d.showCoords} onChange={(v) => setD({ showCoords: v })} />
          <Toggle label="頂点名" checked={d.showVertexNames} onChange={(v) => setD({ showVertexNames: v })} />
          <Toggle label="枠番号" checked={d.showStallNumbers} onChange={(v) => setD({ showStallNumbers: v })} />
          <Toggle label="通路" checked={d.showAisles} onChange={(v) => setD({ showAisles: v })} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Select<LengthUnit> label="単位" value={d.unit} onChange={(v) => setD({ unit: v })} options={[{ value: 'm', label: 'm' }, { value: 'cm', label: 'cm' }, { value: 'mm', label: 'mm' }]} testId="unit-select" />
          <Select<number> label="小数桁" value={d.decimals} onChange={(v) => setD({ decimals: v })} options={[0, 1, 2, 3, 4].map((x) => ({ value: x, label: String(x) }))} />
        </div>
        <p className="mt-1 text-[12px] text-neutral-500">計算は倍精度で行い、表示桁数のみ変更します。</p>
      </Section>

      <Section title="PDF・画像出力">
        <div className="space-y-2">
          <Select<DrawingMode> label="図面" value={mode} onChange={setMode} options={[{ value: 'cad', label: '精密CADモード' }, { value: 'proposal', label: '営業提案モード' }]} testId="export-mode" />
          <Select<PaperSize> label="用紙" value={paper} onChange={setPaper} options={[{ value: 'A4', label: 'A4 横' }, { value: 'A3', label: 'A3 横' }, { value: 'A2', label: 'A2 横' }]} testId="export-paper" />
          <Select<number | 'auto' | 'custom'>
            label="縮尺"
            value={scaleSel}
            onChange={setScaleSel}
            options={[{ value: 'auto', label: `自動（${preview.layout.scale === undefined ? '' : '1/' + preview.layout.scale}）` }, ...STANDARD_SCALES.filter((s) => s <= 500).map((s) => ({ value: s, label: `1/${s}` })), { value: 'custom', label: '任意縮尺' }]}
            testId="export-scale"
          />
          {scaleSel === 'custom' && <NumInput label="1 /" value={customScale} digits={0} keypadMode="integer" onChange={(v) => v && v > 0 && setCustomScale(v)} />}
          {ul && <Toggle label="下絵（取り込んだ測量図）を重ねて出力" checked={withUnderlay} onChange={setWithUnderlay} testId="export-underlay" />}
          <label className="block text-[13px] text-neutral-600">
            注記
            <textarea className="mt-1 w-full rounded border border-neutral-300 p-2 text-[16px]" rows={2} value={doc.notes} maxLength={200} onChange={(e) => commit('注記の変更', (x) => ({ ...x, notes: e.target.value }))} placeholder="PDFの注記欄に表示されます" />
          </label>
          <div className="overflow-hidden rounded border border-neutral-300 bg-white" aria-label="出力プレビュー" data-testid="export-preview" dangerouslySetInnerHTML={{ __html: preview.svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="auto"') }} />
          {preview.warnings.map((w, i) => (
            <p key={i} className="text-[13px] text-amber-800">
              {w}
            </p>
          ))}
          <div className="grid grid-cols-3 gap-1">
            <Btn variant="primary" onClick={() => run('pdf')} disabled={!!busy} testId="export-pdf">
              {busy === 'pdf' ? '作成中…' : 'PDF'}
            </Btn>
            <Btn onClick={() => run('png')} disabled={!!busy} testId="export-png">
              {busy === 'png' ? '作成中…' : 'PNG'}
            </Btn>
            <Btn onClick={() => run('jpeg')} disabled={!!busy} testId="export-jpeg">
              {busy === 'jpeg' ? '作成中…' : 'JPEG'}
            </Btn>
          </div>
          {msg && (
            <p className="text-[13px]" data-testid="export-msg">
              {msg}
            </p>
          )}
        </div>
      </Section>

      <Section title="バージョン履歴" defaultOpen={false}>
        <Btn
          onClick={async () => {
            if (!storage) return;
            await storage.save(doc, { snapshot: true, label: '手動保存' });
            setVersions(await storage.listVersions(doc.id));
          }}
        >
          現在の状態を版として保存
        </Btn>
        <ul className="mt-2 divide-y divide-neutral-100 text-[13px]">
          {versions.map((v) => (
            <li key={v.versionId} className="flex items-center justify-between py-1">
              <span>
                {new Date(v.savedAt).toLocaleString('ja-JP')}　{v.label}
              </span>
              <Btn
                variant="ghost"
                onClick={async () => {
                  if (!storage) return;
                  await storage.save(doc, { snapshot: true, label: '復元前の自動退避' });
                  const old = await storage.loadVersion(doc.id, v.versionId);
                  load({ ...old, updatedAt: new Date().toISOString() });
                  useProject.getState().setSaveState('dirty');
                }}
              >
                復元
              </Btn>
            </li>
          ))}
          {!versions.length && <li className="py-1 text-neutral-500">保存された版はまだありません。</li>}
        </ul>
        {doc.historyLog && doc.historyLog.length > 0 && (
          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer font-bold">編集履歴（{doc.historyLog.length}件）</summary>
            <ol className="mt-1 max-h-40 overflow-auto">
              {[...doc.historyLog].reverse().map((h, i) => (
                <li key={i} className="tabular-nums text-neutral-600">
                  {new Date(h.at).toLocaleTimeString('ja-JP')} {h.label}
                </li>
              ))}
            </ol>
          </details>
        )}
      </Section>
    </div>
  );
}
