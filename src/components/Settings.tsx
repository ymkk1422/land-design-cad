'use client';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useProject } from '@/stores/projectStore';
import { Btn, Section } from '@/components/ui';
import { getSupabase, pickStorage, supabaseConfigured } from '@/services/storage/select';
import { migrateProject } from '@/services/projectFactory';

export function Settings({ onBack }: { onBack: () => void }): JSX.Element {
  const { storage, setStorage } = useProject();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSupabase().then(async (sb) => {
      if (!sb) return;
      const { data } = await sb.auth.getUser();
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  const auth = async (mode: 'in' | 'up' | 'out'): Promise<void> => {
    const sb = await getSupabase();
    if (!sb) return;
    setMsg(null);
    const r = mode === 'in' ? await sb.auth.signInWithPassword({ email, password }) : mode === 'up' ? await sb.auth.signUp({ email, password }) : await sb.auth.signOut();
    if (r.error) setMsg(r.error.message);
    else {
      setMsg(mode === 'up' ? '確認メールを送信しました。メール内のリンクで登録を完了してください。' : mode === 'in' ? 'ログインしました' : 'ログアウトしました');
      const { data } = await sb.auth.getUser();
      setUserEmail(data.user?.email ?? null);
      setStorage(await pickStorage());
    }
  };

  const backup = async (): Promise<void> => {
    if (!storage) return;
    const list = await storage.list();
    const docs = [];
    for (const p of list) docs.push(await storage.load(p.id));
    const blob = new Blob([JSON.stringify({ app: 'LAND DESIGN CAD', exportedAt: new Date().toISOString(), projects: docs.map((d) => ({ ...d, solution: null })) })], { type: 'application/json' });
    const { saveFile } = await import('@/services/exporter');
    await saveFile(`land-design-cad-backup-${new Date().toISOString().slice(0, 10)}.json`, blob);
  };

  const restore = async (f: File): Promise<void> => {
    if (!storage) return;
    try {
      if (f.size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
      const data = JSON.parse(await f.text()) as { projects?: unknown[] };
      if (!Array.isArray(data.projects)) throw new Error('バックアップ形式ではありません');
      let n = 0;
      for (const raw of data.projects) {
        const d = migrateProject(raw);
        await storage.save(d, { snapshot: true, label: 'バックアップから復元' });
        n++;
      }
      setMsg(`${n}件の図面を復元しました`);
    } catch (e) {
      setMsg(`復元できませんでした：${(e as Error).message}`);
    }
  };

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl bg-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="flex items-center gap-2 border-b-4 border-ink px-3 py-3">
        <Btn variant="ghost" onClick={onBack} testId="settings-back">
          ‹ ホーム
        </Btn>
        <h1 className="text-[22px] font-black">設定</h1>
      </header>
      <Section title="保存先">
        <p className="text-[14px]">
          現在：<b data-testid="storage-kind">{storage?.label ?? '—'}</b>
        </p>
        <p className="mt-1 text-[13px] text-neutral-600">編集内容は約1.5秒ごとに自動保存され、5分ごと・アプリ終了時に復元用の版が作られます（最新15版）。</p>
      </Section>
      {supabaseConfigured() ? (
        <Section title="ログイン（クラウド保存）">
          {userEmail ? (
            <div className="flex items-center justify-between">
              <span className="text-[14px]">{userEmail} でログイン中</span>
              <Btn onClick={() => auth('out')}>ログアウト</Btn>
            </div>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                auth('in');
              }}
            >
              <input className="h-11 w-full rounded border border-neutral-300 px-2 text-[16px]" type="email" autoComplete="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <input className="h-11 w-full rounded border border-neutral-300 px-2 text-[16px]" type="password" autoComplete="current-password" placeholder="パスワード（8文字以上）" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <div className="flex gap-2">
                <Btn variant="primary" type="submit">
                  ログイン
                </Btn>
                <Btn onClick={() => auth('up')}>新規登録</Btn>
              </div>
            </form>
          )}
        </Section>
      ) : (
        <Section title="クラウド保存について">
          <p className="text-[13px] text-neutral-600">Supabase の接続情報（環境変数）が設定されていないため、ログイン機能は無効です。claude.ai 上で開いている場合はアカウントのクラウドに、それ以外ではこの端末に保存されます。</p>
        </Section>
      )}
      <Section title="バックアップ">
        <div className="flex flex-wrap gap-2">
          <Btn onClick={backup}>全図面をJSONで書き出し</Btn>
          <Btn onClick={() => file.current?.click()}>JSONから復元</Btn>
          <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
        </div>
      </Section>
      <Section title="iPhone のホーム画面に追加">
        <p className="text-[13px] text-neutral-600">Safari で開き、共有ボタン →「ホーム画面に追加」を選ぶと、アプリのように全画面で起動できます。</p>
      </Section>
      {msg && <p className="p-3 text-[14px]">{msg}</p>}
    </div>
  );
}
