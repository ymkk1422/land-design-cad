'use client';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@/types';
import { useProject } from '@/stores/projectStore';
import { Btn, Confirm, cx } from '@/components/ui';
import type { PanelTab } from '@/components/Editor';
import { m2ToTsubo } from '@/engine/area-calculation';

export function Home({ onOpen, onNew, onSettings }: { onOpen: (id: string, tab?: PanelTab) => void; onNew: (tab?: PanelTab) => void; onSettings: () => void }): JSX.Element {
  const storage = useProject((s) => s.storage);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null);
  const [pickFor, setPickFor] = useState<PanelTab | null>(null);

  const refresh = (): void => {
    if (!storage) return;
    storage
      .list()
      .then((l) => {
        setList(l);
        setErr(null);
      })
      .catch((e) => setErr(String((e as Error).message)));
  };
  useEffect(refresh, [storage]);

  const latest = list?.[0];
  const goto = (tab: PanelTab): void => {
    if (!list?.length) onNew(tab);
    else if (list.length === 1) onOpen(list[0].id, tab);
    else setPickFor(tab);
  };

  const actions: { label: string; sub: string; onClick: () => void; primary?: boolean; testId: string }[] = [
    { label: '新規土地図面作成', sub: '寸法入力から敷地図を作る', onClick: () => onNew('land'), primary: true, testId: 'home-new' },
    { label: '保存済み図面一覧', sub: `${list?.length ?? 0}件`, onClick: () => document.getElementById('project-list')?.scrollIntoView({ behavior: 'smooth' }), testId: 'home-list' },
    { label: '土地図面作成', sub: latest ? `「${latest.name}」の寸法を編集` : '新規作成', onClick: () => goto('land'), testId: 'home-land' },
    { label: '駐車場レイアウト', sub: '自動配置・複数案比較', onClick: () => goto('parking'), testId: 'home-parking' },
    { label: '図面編集', sub: '枠・建物・通路を編集', onClick: () => goto('selection'), testId: 'home-edit' },
    { label: 'PDF・画像出力', sub: 'A4/A3/A2・縮尺指定', onClick: () => goto('output'), testId: 'home-export' },
    { label: '設定', sub: '保存先・ログイン・バックアップ', onClick: onSettings, testId: 'home-settings' },
  ];

  return (
    <div className="min-h-[100dvh] bg-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header className="border-b-4 border-ink px-[max(5vw,16px)] pb-4 pt-6">
        <div className="mx-auto flex max-w-[1240px] items-end justify-between gap-4">
          <div>
            <h1 className="text-[34px] font-black leading-none tracking-tight sm:text-[44px]" style={{ fontFeatureSettings: '"palt"' }}>
              LAND DESIGN CAD
            </h1>
            <p className="mt-2 text-[15px] text-neutral-600">土地の寸法から敷地図を作図し、駐車場を自動配置する</p>
          </div>
          <span className="hidden text-[12px] text-neutral-500 sm:block">保存先：{storage?.label ?? '準備中'}</span>
        </div>
      </header>

      <main className="px-[max(5vw,16px)] py-6"><div className="mx-auto max-w-[1240px]">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {actions.map((a) => (
            <button
              key={a.label}
              data-testid={a.testId}
              onClick={a.onClick}
              className={cx('flex min-h-[96px] flex-col justify-between rounded-md border p-3 text-left transition-colors', a.primary ? 'col-span-2 border-teal bg-teal text-white hover:bg-[#09484d] sm:col-span-1' : 'border-neutral-300 hover:border-ink')}
            >
              <span className="text-[15px] font-bold leading-tight">{a.label}</span>
              <span className={cx('text-[12px]', a.primary ? 'text-white/80' : 'text-neutral-500')}>{a.sub}</span>
            </button>
          ))}
        </div>

        <h2 id="project-list" className="mt-8 border-b border-ink pb-1 text-[18px] font-bold">
          保存済み図面
        </h2>
        {err && <p className="mt-2 text-[14px] text-signal">一覧を読み込めませんでした：{err}</p>}
        {list === null && !err && <p className="mt-3 text-[14px] text-neutral-500">読み込み中…</p>}
        {list && !list.length && (
          <div className="mt-4 rounded-md border border-dashed border-neutral-300 p-6 text-center">
            <p className="text-[15px]">まだ図面がありません。</p>
            <Btn variant="primary" className="mt-3" onClick={() => onNew('land')}>
              最初の土地図面を作る
            </Btn>
          </div>
        )}
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
          {list?.map((p) => (
            <li key={p.id} className="flex gap-3 rounded-md border border-neutral-200 p-2 hover:border-ink">
              <button className="flex min-w-0 flex-1 gap-3 text-left" onClick={() => onOpen(p.id)} data-testid="project-item">
                <div className="h-24 w-24 shrink-0 rounded bg-neutral-50" dangerouslySetInnerHTML={{ __html: safeThumb(p.thumbnail) }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold">{p.name}</div>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[12px] tabular-nums text-neutral-600">
                    <dt>土地面積</dt>
                    <dd>
                      {p.area.toFixed(2)}㎡（{m2ToTsubo(p.area).toFixed(2)}坪）
                    </dd>
                    <dt>駐車台数</dt>
                    <dd>{p.stallCount}台</dd>
                    <dt>作成日</dt>
                    <dd>{new Date(p.createdAt).toLocaleDateString('ja-JP')}</dd>
                    <dt>最終更新</dt>
                    <dd>{new Date(p.updatedAt).toLocaleString('ja-JP')}</dd>
                  </dl>
                </div>
              </button>
              <button className="self-start rounded px-2 py-1 text-[12px] text-neutral-500 hover:text-signal" onClick={() => setToDelete(p)} aria-label={`${p.name}を削除`}>
                削除
              </button>
            </li>
          ))}
        </ul>
      </div></main>

      <Confirm
        open={!!toDelete}
        title="図面を削除しますか？"
        body={`「${toDelete?.name ?? ''}」と保存済みの版をすべて削除します。この操作は元に戻せません。`}
        okLabel="削除する"
        danger
        onCancel={() => setToDelete(null)}
        onOk={async () => {
          if (toDelete && storage) await storage.remove(toDelete.id);
          setToDelete(null);
          refresh();
        }}
      />
      {pickFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" role="dialog" aria-modal="true">
          <div className="max-h-[70dvh] w-full max-w-md overflow-auto rounded-lg bg-white p-4">
            <h2 className="text-[16px] font-bold">図面を選択</h2>
            <ul className="mt-2 divide-y divide-neutral-100">
              {list?.map((p) => (
                <li key={p.id}>
                  <button className="min-h-[48px] w-full text-left text-[15px]" onClick={() => onOpen(p.id, pickFor)}>
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Btn onClick={() => setPickFor(null)}>閉じる</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** サムネイルは数値のみから生成した SVG。保存データ改ざん対策として許可した要素以外は表示しない */
function safeThumb(s?: string): string {
  if (!s) return '';
  const ok = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">(<polygon points="[-0-9., ]*" fill="#[0-9a-f]{6}"( fill-opacity="[0-9.]+")? stroke="#[0-9a-f]{6}" stroke-width="[0-9.]+"\/>)*<\/svg>$/.test(s);
  return ok ? s : '';
}
