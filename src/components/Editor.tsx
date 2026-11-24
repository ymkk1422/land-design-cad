'use client';
import type { JSX } from 'react';
// エディタ画面：PC=左ツールバー／中央図面／右プロパティ、スマホ=全面図面＋下部メニュー
import { useEffect, useMemo, useState } from 'react';
import { useProject, type Tool } from '@/stores/projectStore';
import { DrawingCanvas } from '@/components/canvas/DrawingCanvas';
import { LandPanel } from '@/components/property-panel/LandPanel';
import { ParkingPanel } from '@/components/parking/ParkingPanel';
import { ObjectsPanel } from '@/components/property-panel/ObjectsPanel';
import { SelectionPanel } from '@/components/property-panel/SelectionPanel';
import { OutputPanel } from '@/components/dialogs/OutputPanel';
import { Btn, cx } from '@/components/ui';
import { currentSite } from '@/engine/export/drawingModel';
import { checkInterference } from '@/engine/validation/interference';
import { polygonArea } from '@/engine/geometry/polygon';
import { m2ToTsubo } from '@/engine/area-calculation';

export type PanelTab = 'land' | 'parking' | 'objects' | 'selection' | 'output';
const TABS: { k: PanelTab; label: string; icon: string }[] = [
  { k: 'land', label: '土地', icon: '⬠' },
  { k: 'parking', label: '駐車場', icon: 'P' },
  { k: 'objects', label: '設備', icon: '▦' },
  { k: 'selection', label: '選択', icon: '◎' },
  { k: 'output', label: '出力', icon: '⇩' },
];
const SNAPS = [0, 0.01, 0.05, 0.1, 0.5, 1.0];

export function Editor({ onBack, initialTab = 'land' }: { onBack: () => void; initialTab?: PanelTab }): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const st = useProject();
  const [tab, setTab] = useState<PanelTab>(initialTab);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const f = (): void => setIsMobile(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  useEffect(() => {
    if (st.selIds.length && isMobile) {
      setTab('selection');
      setSheetOpen(true);
    }
  }, [st.selIds.length, isMobile]);
  useEffect(() => {
    if (!isMobile && st.selIds.length) setTab('selection');
  }, [st.selIds, isMobile]);

  const site = currentSite(doc);
  const report = useMemo(() => (site ? checkInterference(site, doc.stalls, doc.obstacles, doc.aisles, doc.parking, 90, doc.entrances) : null), [site, doc.stalls, doc.obstacles, doc.aisles, doc.parking, doc.entrances]);
  const problems = useMemo(() => {
    const s = new Set<string>();
    if (!report) return s;
    report.outOfSite.forEach((id) => s.add(id));
    report.overlapping.forEach(([a, b]) => (s.add(a), s.add(b)));
    report.obstacleHits.forEach((h) => s.add(h.stallId));
    report.aisleHits.forEach((h) => s.add(h.stallId));
    report.entranceBlocked.forEach((id) => s.add(id));
    return s;
  }, [report]);
  const area = site ? polygonArea(site) : 0;

  const tools: { t: Tool; label: string; icon: string }[] = [
    { t: 'select', label: '選択・移動', icon: '↖' },
    { t: 'pan', label: '画面移動', icon: '⇔' },
    { t: 'vertex', label: '頂点編集', icon: '◇' },
    { t: 'addStall', label: '枠を追加', icon: '▭' },
  ];

  const panel = (
    <>
      {tab === 'land' && <LandPanel />}
      {tab === 'parking' && <ParkingPanel report={report} />}
      {tab === 'objects' && <ObjectsPanel />}
      {tab === 'selection' && <SelectionPanel />}
      {tab === 'output' && <OutputPanel />}
    </>
  );

  const saveLabel = { saved: '保存済み', dirty: '未保存', saving: '保存中…', error: '保存エラー' }[st.saveState];

  return (
    <div className="flex h-[100dvh] flex-col bg-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* ヘッダー */}
      <header className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1">
        <Btn variant="ghost" onClick={onBack} title="ホームへ戻る" testId="back-home">
          ‹ ホーム
        </Btn>
        <input
          className="h-10 min-w-0 flex-1 rounded border border-transparent px-2 text-[16px] font-bold hover:border-neutral-300 focus:border-teal"
          value={doc.name}
          maxLength={80}
          onChange={(e) => st.commit('名称変更', (d) => ({ ...d, name: e.target.value || '無題' }))}
          aria-label="プロジェクト名"
          data-testid="project-name"
        />
        <div className="hidden items-center gap-3 px-2 text-[13px] tabular-nums sm:flex">
          <span>
            <b>{area.toFixed(2)}</b>㎡ / {m2ToTsubo(area).toFixed(2)}坪
          </span>
          <span>
            <b data-testid="header-count">{doc.stalls.length}</b>台
          </span>
        </div>
        <span className={cx('hidden text-[12px] sm:inline', st.saveState === 'error' ? 'text-signal' : 'text-neutral-500')} title={st.saveError ?? ''} data-testid="save-state">
          {saveLabel}
        </span>
        <div className="flex rounded-md border border-neutral-300 p-0.5" role="group" aria-label="図面モード">
          <button data-testid="mode-cad" className={cx('min-h-[36px] rounded px-2 text-[13px]', doc.mode === 'cad' ? 'bg-ink text-white' : '')} onClick={() => st.commit('モード切替', (d) => ({ ...d, mode: 'cad' }))}>
            精密CAD
          </button>
          <button data-testid="mode-proposal" className={cx('min-h-[36px] rounded px-2 text-[13px]', doc.mode === 'proposal' ? 'bg-teal text-white' : '')} onClick={() => st.commit('モード切替', (d) => ({ ...d, mode: 'proposal' }))}>
            営業提案
          </button>
        </div>
        <Btn variant="ghost" onClick={st.undo} disabled={!st.past.length} title="元に戻す" testId="undo">
          ↶
        </Btn>
        <Btn variant="ghost" onClick={st.redo} disabled={!st.future.length} title="やり直す" testId="redo">
          ↷
        </Btn>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左ツールバー（PC） */}
        {!isMobile && (
          <nav className="flex w-[76px] shrink-0 flex-col items-stretch gap-1 border-r border-neutral-200 p-1.5" aria-label="ツール">
            {tools.map((x) => (
              <button key={x.t} data-testid={`tool-${x.t}`} onClick={() => st.setTool(x.t, x.t === 'addStall' ? doc.parking.stallTypeId : undefined)} className={cx('flex min-h-[56px] flex-col items-center justify-center rounded-md text-[11px]', st.tool === x.t ? 'bg-teal text-white' : 'hover:bg-neutral-100')}>
                <span className="text-[18px] leading-none">{x.icon}</span>
                {x.label}
              </button>
            ))}
            <ViewButtons vertical />
            <SnapAndFlags />
          </nav>
        )}

        {/* 図面 */}
        <main className="relative min-w-0 flex-1">
          <DrawingCanvas problems={problems} />
          {isMobile && (
            <div className="absolute left-2 top-2 flex flex-col gap-1">
              <ViewButtons vertical />
            </div>
          )}
        </main>

        {/* 右プロパティ（PC） */}
        {!isMobile && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-neutral-200">
            <div className="grid grid-cols-5 border-b border-neutral-200" role="tablist">
              {TABS.map((t) => (
                <button key={t.k} role="tab" aria-selected={tab === t.k} data-testid={`tab-${t.k}`} onClick={() => setTab(t.k)} className={cx('min-h-[44px] text-[13px]', tab === t.k ? 'border-b-2 border-teal font-bold text-teal' : 'text-neutral-600')}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{panel}</div>
          </aside>
        )}
      </div>

      {/* スマホ：下部シート＋メニュー */}
      {isMobile && (
        <div className="border-t border-neutral-200 bg-white" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {sheetOpen && (
            <div className="max-h-[38dvh] overflow-y-auto border-b border-neutral-200" data-testid="mobile-sheet">
              <div className="flex items-center gap-1 overflow-x-auto px-2 py-1">
                {tools.map((x) => (
                  <button key={x.t} data-testid={`mtool-${x.t}`} onClick={() => st.setTool(x.t, x.t === 'addStall' ? doc.parking.stallTypeId : undefined)} className={cx('flex min-h-[44px] shrink-0 items-center gap-1 rounded-md border px-2 text-[13px]', st.tool === x.t ? 'border-teal bg-teal text-white' : 'border-neutral-300')}>
                    {x.icon} {x.label}
                  </button>
                ))}
                <SnapAndFlags compact />
              </div>
              {panel}
            </div>
          )}
          <nav className="grid grid-cols-6" aria-label="メニュー">
            {TABS.map((t) => (
              <button
                key={t.k}
                data-testid={`mtab-${t.k}`}
                onClick={() => {
                  if (tab === t.k) setSheetOpen(!sheetOpen);
                  else {
                    setTab(t.k);
                    setSheetOpen(true);
                  }
                }}
                className={cx('flex min-h-[56px] flex-col items-center justify-center text-[12px]', tab === t.k && sheetOpen ? 'font-bold text-teal' : 'text-neutral-600')}
              >
                <span className="text-[18px] leading-none">{t.icon}</span>
                {t.label}
              </button>
            ))}
            <button onClick={() => setSheetOpen(!sheetOpen)} className="flex min-h-[56px] flex-col items-center justify-center text-[12px] text-neutral-600" data-testid="toggle-sheet">
              <span className="text-[18px] leading-none">{sheetOpen ? '▾' : '▴'}</span>
              {sheetOpen ? '図面を広く' : 'パネル'}
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}

function ViewButtons({ vertical }: { vertical?: boolean }): JSX.Element {
  const fire = (name: string, detail?: number): boolean => window.dispatchEvent(new CustomEvent(name, { detail }));
  const b = 'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-neutral-300 bg-white/95 text-[15px] shadow-sm active:bg-neutral-100';
  return (
    <div className={cx('flex gap-1', vertical ? 'flex-col' : '')}>
      <button className={b} onClick={() => fire('ldc:zoom', 1.25)} aria-label="拡大" data-testid="zoom-in">
        ＋
      </button>
      <button className={b} onClick={() => fire('ldc:zoom', 0.8)} aria-label="縮小" data-testid="zoom-out">
        −
      </button>
      <button className={b} onClick={() => fire('ldc:fit')} aria-label="全体表示" data-testid="zoom-fit">
        ⤢
      </button>
      <button className={b} onClick={() => fire('ldc:rotate', 15)} aria-label="画面を回転">
        ⟳
      </button>
      <button className={b} onClick={() => fire('ldc:rotate', 0)} aria-label="回転をリセット">
        0°
      </button>
    </div>
  );
}

function SnapAndFlags({ compact }: { compact?: boolean }): JSX.Element {
  const { snap, setSnap, multiSelect, setMultiSelect, locked, setLocked } = useProject();
  return (
    <div className={cx('flex gap-1', compact ? 'shrink-0 items-center' : 'mt-2 flex-col')}>
      <label className={cx('text-[11px] text-neutral-600', compact && 'flex items-center gap-1')}>
        スナップ
        <select className="h-10 w-full rounded border border-neutral-300 bg-white text-[14px]" value={snap} onChange={(e) => setSnap(Number(e.target.value))} data-testid="snap-select">
          {SNAPS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'なし' : `${s}m`}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => setMultiSelect(!multiSelect)} className={cx('min-h-[44px] shrink-0 rounded-md border px-1 text-[12px]', multiSelect ? 'border-teal bg-teal-light text-teal' : 'border-neutral-300')} data-testid="multi-select" aria-pressed={multiSelect}>
        複数選択
      </button>
      <button onClick={() => setLocked(!locked)} className={cx('min-h-[44px] shrink-0 rounded-md border px-1 text-[12px]', locked ? 'border-signal bg-red-50 text-signal' : 'border-neutral-300')} aria-pressed={locked} title="誤操作防止のため編集をロック">
        {locked ? 'ロック中' : '編集ロック'}
      </button>
    </div>
  );
}
