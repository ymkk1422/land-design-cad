'use client';
import type { JSX } from 'react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LengthUnit } from '@/types';
import { fromUnit, parseAngle, parseLength, toUnit } from '@/engine/area-calculation';
import { useCoarsePointer, useKeypad, type KeypadMode } from '@/components/keypad/NumericKeypad';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

export function Btn({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className,
  active,
  testId,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  className?: string;
  active?: boolean;
  testId?: string;
  type?: 'button' | 'submit';
}): JSX.Element {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md px-3 min-h-[40px] text-[14px] font-medium transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal';
  const v = {
    default: active ? 'bg-teal text-white border border-teal' : 'bg-white border border-neutral-300 text-ink hover:bg-neutral-50 active:bg-neutral-100',
    primary: 'bg-teal text-white border border-teal hover:bg-[#09484d] active:bg-[#073a3e]',
    danger: 'bg-white border border-signal text-signal hover:bg-red-50',
    ghost: active ? 'bg-teal-light text-teal' : 'text-ink hover:bg-neutral-100',
  }[variant];
  return (
    <button type={type} className={cx(base, v, className)} onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-pressed={active} data-testid={testId}>
      {children}
    </button>
  );
}

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-neutral-200">
      <div className="flex items-center justify-between px-3 py-2">
        <button type="button" className="flex items-center gap-1 text-[13px] font-bold text-ink min-h-[32px]" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={cx('inline-block transition-transform', open && 'rotate-90')}>›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

const fmtNum = (v: number | null | undefined, digits: number): string => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 10 ** digits) / 10 ** digits));

/** 長さ入力：表示単位で編集、内部は m。空欄は null */
export function LengthInput({
  value,
  onChange,
  unit,
  label,
  placeholder,
  allowEmpty = true,
  testId,
  className,
  min,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  unit: LengthUnit;
  label?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  testId?: string;
  className?: string;
  min?: number;
}): JSX.Element {
  const digits = unit === 'm' ? 4 : unit === 'cm' ? 2 : 1;
  const shown = value === null ? '' : fmtNum(toUnit(value, unit), digits);
  const [text, setText] = useState(shown);
  const [err, setErr] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const commitText = (t: string): boolean => {
    focused.current = false;
    if (!t.trim()) {
      if (allowEmpty) {
        setErr(false);
        setText('');
        if (value !== null) onChange(null);
        return true;
      }
      setText(shown);
      return false;
    }
    const v = parseLength(t, unit);
    if (v === null || (min !== undefined && v < min)) {
      setErr(true);
      setText(t);
      return false;
    }
    setErr(false);
    setText(t);
    if (value === null || Math.abs(v - value) > 1e-12) onChange(v);
    return true;
  };
  const kp = useKeypadField(label ?? '', 'decimal', unit, text, commitText);
  return (
    <label className={cx('flex items-center gap-1', className)}>
      {label && <span className="w-12 shrink-0 text-[13px] text-neutral-600">{label}</span>}
      <input
        data-testid={testId}
        {...kp}
        enterKeyHint="next"
        className={cx('w-full min-w-0 rounded border px-2 h-11 text-[16px] font-mono tabular-nums data-[kp-active]:ring-2 data-[kp-active]:ring-teal', err ? 'border-signal bg-red-50' : 'border-neutral-300')}
        value={text}
        placeholder={placeholder ?? '未入力'}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => !kp.readOnly && commitText(text)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="w-7 shrink-0 text-[13px] text-neutral-500">{unit}</span>
    </label>
  );
}

/** 汎用数値入力（角度・座標など） */
export function NumInput({
  value,
  onChange,
  label,
  suffix,
  digits = 4,
  allowEmpty = false,
  parse,
  testId,
  className,
  placeholder,
  keypadMode,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label?: string;
  suffix?: string;
  digits?: number;
  allowEmpty?: boolean;
  parse?: (s: string) => number | null;
  testId?: string;
  className?: string;
  placeholder?: string;
  keypadMode?: KeypadMode;
}): JSX.Element {
  const shown = fmtNum(value, digits);
  const [text, setText] = useState(shown);
  const [err, setErr] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const commitText = (t: string): boolean => {
    focused.current = false;
    if (!t.trim()) {
      if (allowEmpty) {
        setErr(false);
        setText('');
        if (value !== null) onChange(null);
        return true;
      }
      setText(shown);
      return false;
    }
    const norm = t.replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const v = parse ? parse(norm) : Number(norm);
    if (v === null || !Number.isFinite(v)) {
      setErr(true);
      setText(t);
      return false;
    }
    setErr(false);
    setText(t);
    if (value === null || Math.abs(v - value) > 1e-12) onChange(v);
    return true;
  };
  const kp = useKeypadField(label ?? placeholder ?? '', keypadMode ?? (parse ? 'angle' : 'signed'), suffix, text, commitText);
  return (
    <label className={cx('flex items-center gap-1', className)}>
      {label && <span className="w-12 shrink-0 text-[13px] text-neutral-600">{label}</span>}
      <input
        data-testid={testId}
        {...kp}
        className={cx('w-full min-w-0 rounded border px-2 h-11 text-[16px] font-mono tabular-nums data-[kp-active]:ring-2 data-[kp-active]:ring-teal', err ? 'border-signal bg-red-50' : 'border-neutral-300')}
        value={text}
        placeholder={placeholder ?? (allowEmpty ? '未入力' : '')}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => !kp.readOnly && commitText(text)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="shrink-0 text-[13px] text-neutral-500">{suffix}</span>}
    </label>
  );
}

export const AngleInput = (p: Omit<Parameters<typeof NumInput>[0], 'parse'>): JSX.Element => <NumInput {...p} parse={parseAngle} suffix={p.suffix ?? '°'} />;

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  label,
  testId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
  testId?: string;
}): JSX.Element {
  return (
    <label className="flex items-center gap-1">
      {label && <span className="w-16 shrink-0 text-[13px] text-neutral-600">{label}</span>}
      <select
        data-testid={testId}
        className="h-10 w-full min-w-0 rounded border border-neutral-300 bg-white px-2 text-[16px]"
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }): JSX.Element {
  return (
    <label className="flex min-h-[36px] cursor-pointer items-center gap-2 text-[14px]">
      <input data-testid={testId} type="checkbox" className="h-5 w-5 accent-[#0b5d63]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** 確認ダイアログ（window.confirm は使わない：埋め込み環境で無効なため） */
export function Confirm({ open, title, body, okLabel = 'OK', danger, onOk, onCancel }: { open: boolean; title: string; body?: string; okLabel?: string; danger?: boolean; onOk: () => void; onCancel: () => void }): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
        <h2 className="text-[16px] font-bold">{title}</h2>
        {body && <p className="mt-2 text-[14px] text-neutral-700">{body}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Btn onClick={onCancel}>キャンセル</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} onClick={onOk} testId="confirm-ok">
            {okLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}

export const fromM = fromUnit;

/**
 * タッチ端末では OS キーボードを出さず（readOnly + inputMode=none）、タップでアプリ内テンキーを開く。
 * PC では通常の入力欄（数字キーボード指定）として動作。
 */
function useKeypadField(label: string, mode: KeypadMode, suffix: string | undefined, text: string, commit: (t: string) => boolean) {
  const coarse = useCoarsePointer();
  const open = useKeypad((s) => s.open);
  if (!coarse) return { inputMode: 'decimal' as const, readOnly: false, 'data-kp': '1' };
  return {
    inputMode: 'none' as const,
    readOnly: true,
    'data-kp': '1',
    onClick: (e: React.MouseEvent<HTMLInputElement>) => {
      open({ label, mode, suffix, initial: text, commit, anchor: e.currentTarget });
    },
  };
}
