// 下絵操作の一時状態（保存しない）
import { create } from 'zustand';
import type { PxPoint } from '@/types';

interface UnderlayUi {
  /** 2点指定中の1点目（基準寸法・回転補正） */
  pending: PxPoint[];
  /** 回転補正の目標（0=水平, 90=垂直） */
  rotateTarget: 0 | 90;
  status: string | null;
  confirmOpen: boolean;
  setPending(p: PxPoint[]): void;
  setRotateTarget(t: 0 | 90): void;
  setStatus(s: string | null): void;
  setConfirmOpen(v: boolean): void;
}

export const useUnderlayUi = create<UnderlayUi>((set) => ({
  pending: [],
  rotateTarget: 0,
  status: null,
  confirmOpen: false,
  setPending: (pending) => set({ pending }),
  setRotateTarget: (rotateTarget) => set({ rotateTarget }),
  setStatus: (status) => set({ status }),
  setConfirmOpen: (confirmOpen) => set({ confirmOpen }),
}));
