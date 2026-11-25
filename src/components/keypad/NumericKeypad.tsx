'use client';
// アプリ内テンキー（iPhone 用）
// iOS 標準の数字キーボードにはマイナス・度分秒・「次へ」が無いため、タッチ端末ではこのテンキーで入力する。
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { create } from 'zustand';

export type KeypadMode = 'decimal' | 'signed' | 'angle' | 'integer';

interface KeypadRequest {
  label: string;
  mode: KeypadMode;
  suffix?: string;
  initial: string;
  /** 確定。false を返すと入力エラーとして閉じない */
  commit: (text: string) => boolean;
  anchor: HTMLElement | null;
}

interface KeypadState {
  req: KeypadRequest | null;
  open(r: KeypadRequest): void;
  close(): void;
}

export const useKeypad = create<KeypadState>((set) => ({
  req: null,
  open: (r) => set({ req: r }),
  close: () => set({ req: null }),
}));

/** 粗いポインタ（指）の端末か */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const f = (): void => setCoarse(mq.matches || navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return coarse;
}

function nextField(from: HTMLElement | null): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('[data-kp]')].filter((el) => el.offsetParent !== null);
  if (!from) return null;
  const i = all.indexOf(from);
  return i >= 0 && i + 1 < all.length ? all[i + 1] : null;
}

export function NumericKeypad(): JSX.Element | null {
  const { req, close } = useKeypad();
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const [fresh, setFresh] = useState(true);

  useEffect(() => {
    if (req) {
      setText(req.initial);
      setError(false);
      setFresh(true);
      req.anchor?.setAttribute('data-kp-active', '1');
      req.anchor?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return () => req.anchor?.removeAttribute('data-kp-active');
    }
  }, [req]);

  // PC：物理キーボードでも入力できる
  useEffect(() => {
    if (!req) return;
    const h = (e: KeyboardEvent): void => {
      // テンキー表示中のキー入力はテンキーだけが受け取る（図面側の Delete/Backspace による選択削除や Ctrl+Z を発火させない）
      e.stopImmediatePropagation();
      const map: Record<string, string> = { Backspace: '⌫', Delete: 'C', '-': '±' };
      if (e.key === 'Enter') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-testid="kp-ok"]')?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      else if (e.key === 'Tab') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-testid="kp-next"]')?.click();
      } else if (/^[0-9.]$/.test(e.key) || map[e.key]) {
        e.preventDefault();
        const k = map[e.key] ?? e.key;
        document.querySelector<HTMLButtonElement>(`[data-testid="${k === '.' ? 'kp-dot' : k === '⌫' ? 'kp-back' : k === 'C' ? 'kp-clear' : k === '±' ? 'kp-sign' : `kp-${k}`}"]`)?.click();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [req, close]);

  if (!req) return null;
  const { mode } = req;

  const press = (k: string): void => {
    setError(false);
    // 最初のキー入力は既存値を置き換える（電卓と同じ挙動）
    const base = fresh && !['⌫', '±'].includes(k) ? '' : text;
    setFresh(false);
    if (k === '⌫') return setText(base.slice(0, -1));
    if (k === 'C') return setText('');
    if (k === '±') return setText(base.startsWith('-') ? base.slice(1) : base ? `-${base}` : '-');
    if (k === '.') {
      const seg = base.split(/[°′″]/).pop() ?? '';
      if (seg.includes('.') || mode === 'integer') return;
      return setText(base + (seg === '' || seg === '-' ? '0.' : '.'));
    }
    if (k === '°' || k === '′' || k === '″') {
      if (!base || /[°′″]$/.test(base) || base.includes(k)) return;
      return setText(base + k);
    }
    if (base.replace(/[^0-9]/g, '').length >= 12) return;
    setText(base + k);
  };

  const done = (goNext: boolean): void => {
    const ok = req.commit(text);
    if (!ok) {
      setError(true);
      return;
    }
    const nx = goNext ? nextField(req.anchor) : null;
    close();
    if (nx) setTimeout(() => nx.click(), 30);
  };

  const signed = mode === 'signed' || mode === 'angle';
  const keyCls = 'flex h-[52px] items-center justify-center rounded-lg bg-white text-[22px] font-medium text-ink shadow-[0_1px_0_#c9ced3] active:bg-neutral-200 select-none';
  const fnCls = 'flex h-[52px] items-center justify-center rounded-lg bg-[#d5dade] text-[17px] text-ink shadow-[0_1px_0_#aab1b7] active:bg-neutral-400 select-none';
  const K = ({ k, cls = keyCls, label, testId }: { k: string; cls?: string; label?: string; testId?: string }): JSX.Element => (
    <button type="button" className={cls} onPointerDown={(e) => e.preventDefault()} onClick={() => press(k)} data-testid={testId ?? `kp-${k}`} aria-label={label ?? k}>
      {label ?? k}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-label="数値入力" data-testid="keypad">
      <button type="button" aria-label="閉じる" className="flex-1 bg-black/10" onClick={() => done(false)} data-testid="kp-backdrop" />
      <div className="bg-[#e9ecef] px-2 pt-2" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-white px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] text-neutral-500">{req.label}</div>
            <div className={`truncate font-mono text-[26px] font-semibold tabular-nums ${error ? 'text-signal' : fresh ? 'text-neutral-400' : 'text-ink'}`} data-testid="kp-display">
              {text || <span className="text-neutral-300">未入力</span>}
              {req.suffix && <span className="ml-1 text-[16px] text-neutral-500">{req.suffix}</span>}
            </div>
          </div>
          <button type="button" className="h-11 rounded-lg px-3 text-[15px] text-neutral-600 active:bg-neutral-100" onClick={close} data-testid="kp-cancel">
            取消
          </button>
        </div>
        {error && <p className="mb-1 px-1 text-[13px] text-signal">入力値を確認してください</p>}
        {mode === 'angle' && (
          <div className="mb-1.5 grid grid-cols-3 gap-1.5">
            <K k="°" cls={fnCls} label="度 °" testId="kp-deg" />
            <K k="′" cls={fnCls} label="分 ′" testId="kp-min" />
            <K k="″" cls={fnCls} label="秒 ″" testId="kp-sec" />
          </div>
        )}
        <div className="grid grid-cols-4 gap-1.5">
          <K k="7" />
          <K k="8" />
          <K k="9" />
          <K k="⌫" cls={fnCls} label="⌫" testId="kp-back" />
          <K k="4" />
          <K k="5" />
          <K k="6" />
          <K k="C" cls={fnCls} label="クリア" testId="kp-clear" />
          <K k="1" />
          <K k="2" />
          <K k="3" />
          {signed ? <K k="±" cls={fnCls} label="＋/−" testId="kp-sign" /> : <div />}
          <K k="0" />
          <K k="." label="." testId="kp-dot" />
          <button type="button" className={fnCls} onClick={() => done(true)} data-testid="kp-next">
            次へ
          </button>
          <button type="button" className="flex h-[52px] items-center justify-center rounded-lg bg-teal text-[17px] font-bold text-white active:bg-[#073a3e]" onClick={() => done(false)} data-testid="kp-ok">
            決定
          </button>
        </div>
      </div>
    </div>
  );
}
