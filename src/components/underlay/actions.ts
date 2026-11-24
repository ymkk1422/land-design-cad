// 下絵の操作（ストア更新）。キャンバス・パネル・ダイアログから共通利用
import type { PxPoint, UnderlayMeta } from '@/types';
import { useProject } from '@/stores/projectStore';
import { useUnderlayUi } from '@/stores/underlayUi';
import { useKeypad } from '@/components/keypad/NumericKeypad';
import { keepPivot, pxDist, pxToWorld, rotationToAlign, scaleFromReference } from '@/engine/underlay/transform';

export function updateUnderlay(label: string, patch: Partial<UnderlayMeta> | ((u: UnderlayMeta) => Partial<UnderlayMeta>)): void {
  useProject.getState().commit(label, (d) => {
    if (!d.underlay) return d;
    const p = typeof patch === 'function' ? patch(d.underlay) : patch;
    return { ...d, underlay: { ...d.underlay, ...p } };
  });
}

/** 縮尺を変更（基点 pivot を画面上で固定） */
export function setScale(u: UnderlayMeta, scale: number, method: UnderlayMeta['scaleMethod'], pivotPx: PxPoint, extra: Partial<UnderlayMeta> = {}): Partial<UnderlayMeta> {
  const pivotW = pxToWorld(u, pivotPx);
  const t = keepPivot(u, { scale, rotation: u.rotation }, pivotW);
  return { scale, scaleMethod: method, ...t, ...extra };
}

export function setRotation(u: UnderlayMeta, rotation: number, pivotPx: PxPoint): Partial<UnderlayMeta> {
  const pivotW = pxToWorld(u, pivotPx);
  const r = ((rotation % 360) + 540) % 360 - 180;
  const t = keepPivot(u, { scale: u.scale, rotation: r }, pivotW);
  return { rotation: r, ...t };
}

export const imageCenter = (u: UnderlayMeta): PxPoint => ({ u: u.pxWidth / 2, v: u.pxHeight / 2 });

/** 基準寸法の実寸を入力（テンキー）→ 縮尺確定 */
export function askReferenceLength(a: PxPoint, b: PxPoint): void {
  const open = useKeypad.getState().open;
  const u = useProject.getState().doc?.underlay;
  if (!u) return;
  const current = pxDist(a, b) * u.scale;
  open({
    label: '基準寸法：指定した2点間の実際の長さ（測量図に記載の寸法）',
    mode: 'decimal',
    suffix: 'm',
    initial: u.scaleMethod === 'none' ? '' : current.toFixed(3),
    anchor: null,
    commit: (t) => applyReferenceLength(a, b, Number(t)),
  });
}

export function applyReferenceLength(a: PxPoint, b: PxPoint, len: number): boolean {
  const sc = scaleFromReference(a, b, len);
  if (!sc) return false;
  updateUnderlay('下絵の縮尺合わせ（基準寸法）', (x) => setScale(x, sc, 'reference', a, { calibration: { a, b, length: len } }));
  useUnderlayUi.getState().setStatus(`縮尺を設定しました：1px = ${(sc * 1000).toFixed(2)}mm`);
  return true;
}

/** 画像上のタップ（px座標）をツールに応じて処理 */
export function placeUnderlayPoint(p: PxPoint): void {
  const st = useProject.getState();
  const ui = useUnderlayUi.getState();
  const u = st.doc?.underlay;
  if (!u || u.locked) return;
  if (st.tool === 'ulTrace') {
    updateUnderlay('下絵に頂点を配置', (x) => ({ trace: [...x.trace, p] }));
  } else if (st.tool === 'ulMeasure') {
    updateUnderlay('距離測定', (x) => ({ measure: x.measure.length >= 2 ? [p] : [...x.measure, p] }));
  } else if (st.tool === 'ulCalibrate') {
    if (!ui.pending.length) {
      ui.setPending([p]);
      ui.setStatus('基準寸法の2点目をタップしてください');
    } else {
      const a = ui.pending[0];
      ui.setPending([]);
      if (pxDist(a, p) < 5) {
        ui.setStatus('2点が近すぎます。離れた2点を指定してください');
        return;
      }
      updateUnderlay('基準寸法の2点', { calibration: { a, b: p, length: u.calibration?.length ?? 0 } });
      st.setTool('select');
      ui.setStatus('実際の長さを入力してください');
      askReferenceLength(a, p);
    }
  } else if (st.tool === 'ulRotate') {
    if (!ui.pending.length) {
      ui.setPending([p]);
      ui.setStatus(`${ui.rotateTarget === 0 ? '水平' : '垂直'}にしたい線の2点目をタップしてください`);
    } else {
      const a = ui.pending[0];
      ui.setPending([]);
      if (pxDist(a, p) < 5) return;
      const r = rotationToAlign(u, a, p, ui.rotateTarget);
      updateUnderlay('下絵の回転補正', (x) => setRotation(x, r, a));
      st.setTool('select');
      ui.setStatus(`回転を ${r.toFixed(2)}° に補正しました`);
    }
  }
}
