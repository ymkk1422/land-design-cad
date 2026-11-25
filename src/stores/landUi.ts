// 土地入力パネルと図面の連携（いま入力している辺・対角線・角を図面上で強調する）
import { create } from 'zustand';

import type { LandFocus } from '@/types';
export type { LandFocus };

interface LandUi {
  /** 土地入力パネルを表示中（図面に始点・回る向きの案内を出す） */
  guide: boolean;
  focus: LandFocus | null;
  setGuide(v: boolean): void;
  setFocus(f: LandFocus | null): void;
}

export const useLandUi = create<LandUi>((set) => ({
  guide: false,
  focus: null,
  setGuide: (guide) => set({ guide }),
  setFocus: (focus) => set({ focus }),
}));
