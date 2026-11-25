'use client';
import type { JSX } from 'react';
// エディタ画面
//  desktop（幅1000px以上）：左ツールバー／中央図面／右プロパティ
//  side   （横向きスマホ・タブレット）：図面＋右端タブ＋引き出しパネル
//  bottom （縦向きスマホ）：全面図面＋下部タブ＋3段階ボトムシート
//  全レイアウト共通：浮動の 元に戻す／やり直す／全体表示／全画面 と、選択時の操作バー（選択解除・回転・複製・削除）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject, type Tool } from '@/stores/projectStore';
import { DrawingCanvas } from '@/components/canvas/DrawingCanvas';
import { LandPanel } from '@/components/property-panel/LandPanel';
import { ParkingPanel } from '@/components/parking/ParkingPanel';
import { ObjectsPanel } from '@/components/property-panel/ObjectsPanel';
import { SelectionPanel } from '@/components/property-panel/SelectionPanel';
import { OutputPanel } from '@/components/dialogs/OutputPanel';
import { UnderlayPanel } from '@/components/underlay/UnderlayPanel';
import { useUnderlayUi } from '@/stores/underlayUi';
import { isUnderlayTool } from '@/stores/projectStore';
import { Btn, cx } from '@/components/ui';
import { currentSite } from '@/engine/export/drawingModel';
import { checkInterference } from '@/engine/validation/interference';
import { polygonArea } from '@/engine/geometry/polygon';
import { m2ToTsubo } from '@/engine/area-calculation';
import { deleteSelection, duplicateSelection, rotateSelection, SEL_NAME } from '@/components/selectionActions';
import { ELEMENT_NAMES, OBSTACLE_STYLE } from '@/engine/export/drawingModel';

export type PanelTab = 'land' | 'underlay' | 'parking' | 'objects' | 'selection' | 'output';
const TABS: { k: PanelTab; label: string; icon: string }[] = [
  { k: 'land', label: '土地', icon: '⬠' },
  { k: 'underlay', label: '下絵', icon: '▧' },
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
  type Layout = 'desktop' | 'side' | 'bottom';
  type Sheet = 'closed' | 'half' | 'full';
  const [layout, setLayout] = useState<Layout>('desktop');
  const [sheet, setSheet] = useState<Sheet>('half');
  const [maximized, setMaximized] = useState(false);
  const isMobile = layout !== 'desktop';

  useEffect(() => {
    const f = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setLayout(w >= 1000 ? 'desktop' : w >= 700 || (w > h && h < 600) ? 'side' : 'bottom');
    };
    f();
    window.addEventListener('resize', f);
    window.addEventListener('orientationchange', f);
    return () => {
      window.removeEventListener('resize', f);
      window.removeEventListener('orientationchange', f);
    };
  }, []);
  // 選択したら選択タブへ（モバイルではシートは開きすぎない：図面を優先）
  useEffect(() => {
    if (st.selIds.length) setTab('selection');
  }, [st.selIds.join('|')]);
  // 他の画面からタブを開く（例：土地タブの「測量図から作成」）
  useEffect(() => {
    const h = (e: Event): void => {
      setTab((e as CustomEvent<PanelTab>).detail);
      setSheet((s) => (s === 'closed' ? 'half' : s));
    };
    window.addEventListener('ldc:open-tab', h);
    return () => window.removeEventListener('ldc:open-tab', h);
  }, []);
  // 下絵上で点を置くツールを選んだら、図面を広く見せる
  useEffect(() => {
    if (isUnderlayTool(st.tool) && st.tool !== 'ulMove' && layout !== 'desktop') setSheet('closed');
  }, [st.tool, layout]);

  // 図面に触れたら、全面表示のシートは半分まで下げて図面を見せる
  useEffect(() => {
    const h = (): void => setSheet((s) => (s === 'full' ? 'half' : s));
    window.addEventListener('ldc:canvas-touch', h);
    const del = (): void => deleteSelection();
    window.addEventListener('ldc:delete-selection', del);
    return () => {
      window.removeEventListener('ldc:canvas-touch', h);
      window.removeEventListener('ldc:delete-selection', del);
    };
  }, []);
  // レイアウト・シート変更後は図面サイズが変わるので全体表示をやり直す
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new CustomEvent('ldc:fit-if-untouched')), 260);
    return () => clearTimeout(t);
  }, [layout, maximized]);

  const site = currentSite(doc);
  const report = useMemo(() => (site ? checkInterference(site, doc.stalls, doc.obstacles, doc.aisles, doc.parking, undefined, doc.entrances) : null), [site, doc.stalls, doc.obstacles, doc.aisles, doc.parking, doc.entrances]);
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
      {tab === 'underlay' && <UnderlayPanel />}
      {tab === 'parking' && <ParkingPanel report={report} />}
      {tab === 'objects' && <ObjectsPanel />}
      {tab === 'selection' && <SelectionPanel />}
      {tab === 'output' && <OutputPanel />}
    </>
  );

  const saveLabel = { saved: '保存済み', dirty: '未保存', saving: '保存中…', error: '保存エラー' }[st.saveState];
  const openTab = (k: PanelTab): void => {
    if (layout === 'bottom') {
      if (tab === k && sheet !== 'closed') setSheet('closed');
      else {
        setTab(k);
        setSheet((s) => (s === 'closed' ? 'half' : s));
      }
    } else if (layout === 'side') {
      if (tab === k && sheet !== 'closed') setSheet('closed');
      else {
        setTab(k);
        setSheet('full');
      }
    } else setTab(k);
  };
  const addLabel =
    st.tool === 'addStall' ? `${doc.stallTypes.find((t) => t.id === st.addKind)?.name ?? '駐車枠'}を配置` : st.tool === 'addObstacle' ? `${OBSTACLE_STYLE[st.addKind]?.name ?? '障害物'}を配置` : st.tool === 'addElement' ? `${ELEMENT_NAMES[st.addKind] ?? '設備'}を配置` : null;

  // ---------------- PC ----------------
  if (!isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col bg-white">
        <header className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1">
          <Btn variant="ghost" onClick={onBack} title="ホームへ戻る" testId="back-home">
            ‹ ホーム
          </Btn>
          <ProjectName />
          <div className="flex items-center gap-3 px-2 text-[13px] tabular-nums">
            <span>
              <b>{area.toFixed(2)}</b>㎡ / {m2ToTsubo(area).toFixed(2)}坪
            </span>
            <span>
              <b data-testid="header-count">{doc.stalls.length}</b>台
            </span>
          </div>
          <span className={cx('text-[12px]', st.saveState === 'error' ? 'text-signal' : 'text-neutral-500')} title={st.saveError ?? ''} data-testid="save-state">
            {saveLabel}
          </span>
          <ModeSwitch />
          <Btn variant="ghost" onClick={st.undo} disabled={!st.past.length} title="元に戻す" testId="undo">
            ↶
          </Btn>
          <Btn variant="ghost" onClick={st.redo} disabled={!st.future.length} title="やり直す" testId="redo">
            ↷
          </Btn>
        </header>
        <div className="flex min-h-0 flex-1">
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
          <main className="relative min-w-0 flex-1">
            <DrawingCanvas problems={problems} />
            <CanvasOverlay addLabel={addLabel} compact={false} />
          </main>
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-neutral-200">
            <div className="grid grid-cols-6 border-b border-neutral-200" role="tablist">
              {TABS.map((t) => (
                <button key={t.k} role="tab" aria-selected={tab === t.k} data-testid={`tab-${t.k}`} onClick={() => setTab(t.k)} className={cx('min-h-[44px] text-[13px]', tab === t.k ? 'border-b-2 border-teal font-bold text-teal' : 'text-neutral-600')}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{panel}</div>
          </aside>
        </div>
      </div>
    );
  }

  // ---------------- スマホ・タブレット ----------------
  const showChrome = !maximized;
  const sheetH = sheet === 'full' ? '86dvh' : sheet === 'half' ? '44dvh' : '0px';
  const panelBody = (
    <>
      <div className="flex items-center gap-1 overflow-x-auto overscroll-x-contain px-2 py-1.5 [scrollbar-width:none]">
        {tools.map((x) => (
          <button key={x.t} data-testid={`mtool-${x.t}`} onClick={() => st.setTool(x.t, x.t === 'addStall' ? doc.parking.stallTypeId : undefined)} className={cx('flex min-h-[44px] shrink-0 items-center gap-1 rounded-full border px-3 text-[14px]', st.tool === x.t ? 'border-teal bg-teal text-white' : 'border-neutral-300 bg-white')}>
            {x.icon} {x.label}
          </button>
        ))}
        <SnapAndFlags compact />
      </div>
      {panel}
    </>
  );

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-white" style={{ paddingTop: showChrome ? 'env(safe-area-inset-top)' : 0 }} data-layout={layout} data-testid="editor-mobile">
      {showChrome && (
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-neutral-200 px-1">
          <button className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-[22px] active:bg-neutral-100" onClick={onBack} aria-label="ホームへ戻る" data-testid="back-home">
            ‹
          </button>
          <ProjectName compact />
          <span className="shrink-0 font-mono text-[13px] tabular-nums" data-testid="header-count-wrap">
            <b data-testid="header-count">{doc.stalls.length}</b>台
          </span>
          <span className={cx('h-2 w-2 shrink-0 rounded-full', st.saveState === 'saved' ? 'bg-teal' : st.saveState === 'error' ? 'bg-signal' : 'bg-amber-400')} title={saveLabel} aria-label={saveLabel} data-testid="save-state" data-state={st.saveState} />
          <ModeSwitch compact />
        </header>
      )}

      <div className={cx('relative flex min-h-0 flex-1', layout === 'side' ? 'flex-row' : 'flex-col')}>
        <main className="relative min-h-0 min-w-0 flex-1">
          <DrawingCanvas problems={problems} />
          <CanvasOverlay addLabel={addLabel} compact maximized={maximized} onToggleMax={() => setMaximized(!maximized)} onDetails={() => openTab('selection')} />
        </main>

        {/* 縦向き：ボトムシート */}
        {layout === 'bottom' && showChrome && (
          <section
            className="relative shrink-0 border-t border-neutral-200 bg-white shadow-[0_-4px_12px_rgba(0,0,0,0.06)] transition-[height] duration-200 ease-out motion-reduce:transition-none"
            style={{ height: sheetH }}
            data-testid="mobile-sheet"
            data-sheet={sheet}
            hidden={sheet === 'closed'}
          >
            <SheetHandle sheet={sheet} setSheet={setSheet} />
            <div className="h-[calc(100%-28px)] overflow-y-auto overscroll-contain pb-2" data-testid="sheet-scroll">
              {panelBody}
            </div>
          </section>
        )}

        {/* 横向き・タブレット：右の引き出しパネル＋縦タブ */}
        {layout === 'side' && showChrome && (
          <>
            {sheet !== 'closed' && (
              <section className="absolute bottom-0 right-[60px] top-0 z-20 flex w-[min(380px,48vw)] flex-col border-l border-neutral-200 bg-white shadow-[-6px_0_16px_rgba(0,0,0,0.08)]" data-testid="mobile-sheet" data-sheet="full">
                <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-1">
                  <span className="text-[14px] font-bold">{TABS.find((t) => t.k === tab)?.label}</span>
                  <button className="h-10 min-w-[44px] rounded-md text-[18px] active:bg-neutral-100" onClick={() => setSheet('closed')} aria-label="パネルを閉じる" data-testid="toggle-sheet">
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="sheet-scroll">
                  {panelBody}
                </div>
              </section>
            )}
            <nav className="flex w-[60px] shrink-0 flex-col overflow-y-auto overscroll-contain border-l border-neutral-200 bg-white" aria-label="メニュー" style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}>
              {TABS.map((t) => (
                <button key={t.k} data-testid={`mtab-${t.k}`} onClick={() => openTab(t.k)} className={cx('flex min-h-[46px] flex-1 flex-col items-center justify-center text-[11px] leading-tight', tab === t.k && sheet !== 'closed' ? 'bg-teal-light font-bold text-teal' : 'text-neutral-600')}>
                  <span className="text-[18px] leading-none">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </nav>
          </>
        )}
      </div>

      {layout === 'bottom' && showChrome && (
        <nav className="grid shrink-0 grid-cols-6 border-t border-neutral-200 bg-white" aria-label="メニュー" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {TABS.map((t) => (
            <button key={t.k} data-testid={`mtab-${t.k}`} onClick={() => openTab(t.k)} className={cx('flex min-h-[54px] flex-col items-center justify-center text-[12px]', tab === t.k && sheet !== 'closed' ? 'font-bold text-teal' : 'text-neutral-600')}>
              <span className="text-[18px] leading-none">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** 3段階シートのつまみ：タップで切替、上下ドラッグでスナップ */
function SheetHandle({ sheet, setSheet }: { sheet: 'closed' | 'half' | 'full'; setSheet: (s: 'closed' | 'half' | 'full') => void }): JSX.Element {
  const start = useRef<{ y: number; t: number } | null>(null);
  return (
    <div
      className="flex h-7 touch-none items-center justify-center"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        start.current = { y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const s0 = start.current;
        start.current = null;
        if (!s0) return;
        const dy = e.clientY - s0.y;
        if (Math.abs(dy) < 8) setSheet(sheet === 'half' ? 'full' : 'half');
        else if (dy < 0) setSheet(sheet === 'half' ? 'full' : 'half');
        else setSheet(sheet === 'full' ? 'half' : 'closed');
      }}
      role="button"
      aria-label={sheet === 'full' ? 'パネルを縮める' : 'パネルを広げる'}
      data-testid="sheet-handle"
    >
      <span className="h-1.5 w-10 rounded-full bg-neutral-300" />
    </div>
  );
}

function ProjectName({ compact }: { compact?: boolean }): JSX.Element {
  const doc = useProject((s) => s.doc)!;
  const commit = useProject((s) => s.commit);
  return (
    <input
      className={cx('h-10 min-w-0 flex-1 rounded border border-transparent px-2 font-bold focus:border-teal', compact ? 'text-[16px]' : 'text-[16px] hover:border-neutral-300')}
      value={doc.name}
      maxLength={80}
      enterKeyHint="done"
      onChange={(e) => commit('名称変更', (d) => ({ ...d, name: e.target.value || '無題' }), { coalesce: true })}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="プロジェクト名"
      data-testid="project-name"
    />
  );
}

function ModeSwitch({ compact }: { compact?: boolean }): JSX.Element {
  const mode = useProject((s) => s.doc!.mode);
  const commit = useProject((s) => s.commit);
  const b = compact ? 'min-h-[36px] rounded px-2 text-[12px]' : 'min-h-[36px] rounded px-2 text-[13px]';
  return (
    <div className="flex shrink-0 rounded-md border border-neutral-300 p-0.5" role="group" aria-label="図面モード">
      <button data-testid="mode-cad" className={cx(b, mode === 'cad' ? 'bg-ink text-white' : '')} onClick={() => commit('モード切替', (d) => ({ ...d, mode: 'cad' }))}>
        {compact ? 'CAD' : '精密CAD'}
      </button>
      <button data-testid="mode-proposal" className={cx(b, mode === 'proposal' ? 'bg-teal text-white' : '')} onClick={() => commit('モード切替', (d) => ({ ...d, mode: 'proposal' }))}>
        {compact ? '提案' : '営業提案'}
      </button>
    </div>
  );
}

/** 図面上の浮動UI：元に戻す／やり直す／全体表示／全画面、配置モード表示、選択操作バー */
function CanvasOverlay({ addLabel, compact, maximized, onToggleMax, onDetails }: { addLabel: string | null; compact: boolean; maximized?: boolean; onToggleMax?: () => void; onDetails?: () => void }): JSX.Element {
  const st = useProject();
  const fire = (name: string, detail?: number): boolean => window.dispatchEvent(new CustomEvent(name, { detail }));
  const fb = 'flex h-12 w-12 items-center justify-center rounded-full border border-neutral-300 bg-white/95 text-[20px] text-ink shadow-md active:bg-neutral-100 disabled:opacity-35';
  const n = st.selIds.length;
  const isStall = st.selKind === 'stall';
  const canRotate = st.selKind !== 'vertex';
  return (
    <>
      {/* 配置モード表示 */}
      {addLabel && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 flex h-11 max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-ink/90 pl-4 pr-1 text-[14px] text-white shadow-lg" data-testid="add-banner">
          タップで{addLabel}
          <button className="pointer-events-auto h-9 rounded-full bg-white/20 px-3 text-[14px] active:bg-white/30" onClick={() => st.setTool('select')} data-testid="add-done">
            終了
          </button>
        </div>
      )}

      <UnderlayBanner />

      {/* 右下：表示操作 */}
      {compact && (
        <div className="absolute bottom-3 right-3 z-10 flex flex-row gap-2" style={{ marginBottom: n ? 64 : 0 }}>
          <button className={fb} onClick={() => fire('ldc:fit')} aria-label="図面全体を表示" data-testid="zoom-fit">
            ⤢
          </button>
          <button className={fb} onClick={onToggleMax} aria-label={maximized ? '全画面を終了' : '図面を全画面表示'} aria-pressed={maximized} data-testid="maximize">
            {maximized ? '⊟' : '⛶'}
          </button>
        </div>
      )}

      {/* 左下：元に戻す／やり直す */}
      {compact && (
        <div className="absolute bottom-3 left-3 z-10 flex gap-2" style={{ marginBottom: n ? 64 : 0 }}>
          <button className={fb} onClick={st.undo} disabled={!st.past.length} aria-label="元に戻す" data-testid="undo">
            ↶
          </button>
          <button className={fb} onClick={st.redo} disabled={!st.future.length} aria-label="やり直す" data-testid="redo">
            ↷
          </button>
        </div>
      )}

      {/* 選択操作バー */}
      {n > 0 && (
        <div className={cx('absolute inset-x-2 bottom-2 z-20 mx-auto flex max-w-[560px] items-center gap-1 overflow-x-auto rounded-2xl bg-ink p-1.5 text-white shadow-xl [scrollbar-width:none]', !compact && 'bottom-3')} data-testid="selection-bar">
          <button className="flex h-11 shrink-0 items-center gap-1 rounded-xl bg-white/15 px-3 text-[14px] active:bg-white/25" onClick={st.clearSelection} aria-label="選択解除" data-testid="deselect">
            ✕ <span className="whitespace-nowrap">{SEL_NAME[st.selKind ?? ''] ?? ''}{n > 1 ? ` ${n}件` : ''}</span>
          </button>
          {canRotate && (
            <>
              <BarBtn label="左に15°回転" onClick={() => rotateSelection(15)} testId="bar-rot-ccw" disabled={st.locked}>⟲15°</BarBtn>
              <BarBtn label="右に15°回転" onClick={() => rotateSelection(-15)} testId="bar-rot-cw" disabled={st.locked}>⟳15°</BarBtn>
              <BarBtn label="90°回転" onClick={() => rotateSelection(90)} testId="bar-rot-90" disabled={st.locked}>90°</BarBtn>
              <BarBtn label="複製" onClick={duplicateSelection} testId="bar-duplicate" disabled={st.locked}>複製</BarBtn>
            </>
          )}
          <BarBtn label="削除" onClick={deleteSelection} testId="bar-delete" danger disabled={st.locked}>削除</BarBtn>
          {onDetails && (
            <BarBtn label="数値で編集" onClick={onDetails} testId="bar-details">
              数値
            </BarBtn>
          )}
          {isStall && compact && (
            <BarBtn label="複数選択" onClick={() => st.setMultiSelect(!st.multiSelect)} testId="bar-multi" active={st.multiSelect}>
              複数
            </BarBtn>
          )}
        </div>
      )}
    </>
  );
}

/** 下絵ツール使用中の案内（パネルを閉じていても手順がわかるように） */
function UnderlayBanner(): JSX.Element | null {
  const tool = useProject((x) => x.tool);
  const setTool = useProject((x) => x.setTool);
  const status = useUnderlayUi((x) => x.status);
  const pending = useUnderlayUi((x) => x.pending);
  if (!isUnderlayTool(tool)) return null;
  const msg =
    status ??
    { ulMove: '下絵をドラッグして移動', ulCalibrate: '基準寸法の2点をタップ', ulRotate: '水平・垂直にする線の2点をタップ', ulTrace: '敷地の角を順にタップ', ulMeasure: '測る2点をタップ' }[tool];
  return (
    // 案内文はタップを透過（下の図面に点を置ける）。完了ボタンだけが反応する
    <div className="pointer-events-none absolute inset-x-2 top-2 z-10 mx-auto flex h-12 max-w-[520px] items-center gap-2 rounded-2xl bg-[#d9480f]/90 pl-3 pr-1.5 text-[14px] text-white shadow-lg" data-testid="underlay-banner">
      <span className="min-w-0 flex-1 truncate">
        {msg}
        {pending.length ? '（1点目を指定済み）' : ''}
      </span>
      <button className="pointer-events-auto h-10 shrink-0 rounded-xl bg-white/25 px-3 active:bg-white/35" onClick={() => (setTool('select'), useUnderlayUi.getState().setPending([]), useUnderlayUi.getState().setStatus(null))} data-testid="underlay-tool-done">
        完了
      </button>
    </div>
  );
}

function BarBtn({ children, onClick, label, testId, danger, disabled, active }: { children: React.ReactNode; onClick: () => void; label: string; testId: string; danger?: boolean; disabled?: boolean; active?: boolean }): JSX.Element {
  return (
    <button
      className={cx('h-11 min-w-[48px] shrink-0 rounded-xl px-2.5 text-[14px] font-medium disabled:opacity-35', danger ? 'text-[#ff8a8a] active:bg-white/20' : active ? 'bg-white text-ink' : 'active:bg-white/20')}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
    >
      {children}
    </button>
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
