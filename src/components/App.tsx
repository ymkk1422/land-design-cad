'use client';
import type { JSX } from 'react';
// アプリ本体：画面遷移（#home / #editor / #settings）、保存先初期化、自動保存
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProject } from '@/stores/projectStore';
import { Home } from '@/components/Home';
import { Editor, type PanelTab } from '@/components/Editor';
import { Settings } from '@/components/Settings';
import { NumericKeypad } from '@/components/keypad/NumericKeypad';
import { TraceConfirmDialog } from '@/components/underlay/TraceConfirmDialog';
import { pickStorage } from '@/services/storage/select';
import { createProject } from '@/services/projectFactory';

type View = 'home' | 'editor' | 'settings';
const CUR_KEY = 'ldc:current';
const ss = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(CUR_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null): void => {
    try {
      if (v) sessionStorage.setItem(CUR_KEY, v);
      else sessionStorage.removeItem(CUR_KEY);
    } catch {
      /* 利用不可でも動作継続 */
    }
  },
};

function readHash(): View {
  const h = typeof location !== 'undefined' ? location.hash.replace('#', '') : '';
  return h === 'editor' || h === 'settings' ? h : 'home';
}

export function App(): JSX.Element {
  const { storage, setStorage, load, close } = useProject();
  const doc = useProject((s) => s.doc);
  const [view, setView] = useState<View>('home');
  const [tab, setTab] = useState<PanelTab>('land');
  const [bootError, setBootError] = useState<string | null>(null);

  const go = useCallback((v: View) => {
    setView(v);
    try {
      if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
    } catch {
      /* noop */
    }
  }, []);

  // 保存先の決定と前回の作業の復帰
  useEffect(() => {
    let alive = true;
    pickStorage().then(async (s) => {
      if (!alive) return;
      setStorage(s);
      const v = readHash();
      const cur = ss.get();
      if (v === 'editor' && cur) {
        try {
          load(await s.load(cur));
          setView('editor');
          return;
        } catch {
          /* 一覧へ */
        }
      }
      setView(v === 'settings' ? 'settings' : 'home');
    });
    const onHash = (): void => {
      const v = readHash();
      if (v !== 'editor' || useProject.getState().doc) setView(v);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      alive = false;
      window.removeEventListener('hashchange', onHash);
    };
  }, [setStorage, load]);

  // 自動保存（デバウンス）＋定期的な版保存
  const lastSnap = useRef(0);
  useEffect(() => {
    if (!storage) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let saving = false;
    const flush = async (snapshot = false): Promise<void> => {
      const s = useProject.getState();
      if (!s.doc || (s.saveState !== 'dirty' && !snapshot) || saving) return;
      saving = true;
      const d = s.doc;
      s.setSaveState('saving');
      try {
        const snap = snapshot || Date.now() - lastSnap.current > 5 * 60 * 1000;
        await storage.save(d, { snapshot: snap, label: snapshot ? '終了時の自動保存' : '自動保存' });
        if (snap) lastSnap.current = Date.now();
        if (useProject.getState().doc === d) useProject.getState().markSaved(new Date().toISOString());
        else useProject.getState().setSaveState('dirty');
      } catch (e) {
        useProject.getState().setSaveState('error', (e as Error).message);
      } finally {
        saving = false;
      }
    };
    const unsub = useProject.subscribe((s, prev) => {
      if (s.doc !== prev.doc && s.saveState === 'dirty') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), 1500);
      }
    });
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') void flush(true);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [storage]);

  const openProject = async (id: string, t: PanelTab = 'land'): Promise<void> => {
    if (!storage) return;
    try {
      load(await storage.load(id));
      ss.set(id);
      setTab(t);
      go('editor');
    } catch (e) {
      setBootError((e as Error).message);
    }
  };
  const newProject = async (t: PanelTab = 'land'): Promise<void> => {
    if (!storage) return;
    const d = createProject(`土地図面 ${new Date().toLocaleDateString('ja-JP')}`);
    await storage.save(d, { snapshot: true, label: '新規作成' }).catch(() => undefined);
    load(d);
    ss.set(d.id);
    setTab(t);
    go('editor');
  };
  const backHome = async (): Promise<void> => {
    const s = useProject.getState();
    if (s.doc && storage) {
      try {
        await storage.save(s.doc, { snapshot: s.saveState === 'dirty', label: '編集終了' });
      } catch (e) {
        s.setSaveState('error', (e as Error).message);
        return;
      }
    }
    close();
    ss.set(null);
    go('home');
  };

  if (!storage) {
    return (
      <div className="flex h-[100dvh] items-center justify-center text-[15px] text-neutral-600" data-testid="booting">
        起動中…
      </div>
    );
  }
  return (
    <>
      {bootError && (
        <div className="fixed inset-x-0 top-0 z-50 bg-signal px-3 py-2 text-[14px] text-white" role="alert" onClick={() => setBootError(null)}>
          {bootError}
        </div>
      )}
      {view === 'editor' && doc ? (
        <Editor key={doc.id} onBack={backHome} initialTab={tab} />
      ) : view === 'settings' ? (
        <Settings onBack={() => go('home')} />
      ) : (
        <Home onOpen={openProject} onNew={newProject} onSettings={() => go('settings')} />
      )}
      <TraceConfirmDialog />
      <NumericKeypad />
    </>
  );
}
