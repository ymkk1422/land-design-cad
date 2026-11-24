'use client';
// 図面キャンバス内の下絵レイヤー（表示空間の座標で描画）
import { useEffect, useState, type JSX } from 'react';
import type { PxPoint, UnderlayMeta } from '@/types';
import { useProject } from '@/stores/projectStore';
import { useUnderlayUi } from '@/stores/underlayUi';
import { displayMatrix, pxDist, pxToWorld } from '@/engine/underlay/transform';
import { assetUrl } from '@/services/underlayImport';
import { vertexName } from '@/engine/geometry/polygon';

export function useAssetUrl(id: string | undefined): { url: string | null; error: string | null } {
  const storage = useProject((s) => s.storage);
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    if (!id || !storage) return;
    let alive = true;
    setState({ url: null, error: null });
    assetUrl(storage, id)
      .then((url) => alive && setState({ url, error: null }))
      .catch((e: Error) => alive && setState({ url: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [id, storage]);
  return state;
}

const disp = (u: UnderlayMeta, p: PxPoint): { x: number; y: number } => {
  const w = pxToWorld(u, p);
  return { x: w.x, y: -w.y };
};

function Label({ x, y, text, s, color, testId }: { x: number; y: number; text: string; s: number; color: string; testId?: string }): JSX.Element {
  return (
    <text x={x} y={y} fontSize={13 / s} fontWeight={700} textAnchor="middle" dominantBaseline="middle" fill={color} stroke="#fff" strokeWidth={3.5 / s} paintOrder="stroke" pointerEvents="none" data-testid={testId}>
      {text}
    </text>
  );
}

/** 下絵画像（図面の最背面） */
export function UnderlayImage({ u }: { u: UnderlayMeta }): JSX.Element | null {
  const { url } = useAssetUrl(u.displayAssetId);
  if (!u.visible || !url) return null;
  const m = displayMatrix(u);
  return (
    <image
      href={url}
      x={0}
      y={0}
      width={u.pxWidth}
      height={u.pxHeight}
      transform={`matrix(${m.join(' ')})`}
      opacity={u.opacity}
      preserveAspectRatio="none"
      pointerEvents="none"
      data-testid="underlay-image"
      data-opacity={u.opacity}
    />
  );
}

/** 下絵上の作業レイヤー（基準寸法・頂点・測定）。図面より前面 */
export function UnderlayOverlay({ u, s }: { u: UnderlayMeta; s: number }): JSX.Element | null {
  const tool = useProject((x) => x.tool);
  const pending = useUnderlayUi((x) => x.pending);
  // 点はそのツールの使用中だけ掴める（例：頂点配置中に基準寸法の点を誤って動かさない）
  const owner: Record<string, string> = { trace: 'ulTrace', measure: 'ulMeasure', cal: 'ulCalibrate', pend: '-' };
  const pt = (ref: string, p: PxPoint, color: string, r = 9, label?: string): JSX.Element => {
    const q = disp(u, p);
    const grab = owner[ref.split(':')[0]] === tool && !u.locked;
    return (
      <g key={ref}>
        <circle cx={q.x} cy={q.y} r={(grab ? 20 : 0) / s} fill="#fff" fillOpacity={0.01} data-hit="ulpt" data-id={ref} pointerEvents={grab ? 'all' : 'none'} />
        <circle cx={q.x} cy={q.y} r={r / s} fill="#fff" stroke={color} strokeWidth={2.5 / s} pointerEvents="none" data-testid={`ulpt-${ref}`} />
        <circle cx={q.x} cy={q.y} r={2 / s} fill={color} pointerEvents="none" />
        {label && <Label x={q.x + 14 / s} y={q.y - 14 / s} text={label} s={s} color={color} />}
      </g>
    );
  };
  const els: JSX.Element[] = [];
  // 基準寸法
  if (u.calibration && (u.scaleMethod === 'reference' || tool === 'ulCalibrate')) {
    const a = disp(u, u.calibration.a);
    const b = disp(u, u.calibration.b);
    els.push(<line key="cal" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e4002b" strokeWidth={2 / s} strokeDasharray={`${6 / s} ${4 / s}`} pointerEvents="none" />);
    els.push(pt('cal:a', u.calibration.a, '#e4002b', 7));
    els.push(pt('cal:b', u.calibration.b, '#e4002b', 7));
    if (u.calibration.length > 0) els.push(<Label key="call" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 12 / s} text={`基準 ${u.calibration.length.toFixed(3)}m`} s={s} color="#e4002b" testId="cal-label" />);
  }
  // 2点指定中の1点目
  pending.forEach((p, i) => els.push(pt(`pend:${i}`, p, tool === 'ulRotate' ? '#1f5fbf' : '#e4002b', 7)));
  // 頂点（トレース）と辺の長さ
  if (u.trace.length) {
    const ps = u.trace.map((p) => disp(u, p));
    const closed = ps.length >= 3;
    els.push(<polyline key="tr" points={[...ps, ...(closed ? [ps[0]] : [])].map((q) => `${q.x},${q.y}`).join(' ')} fill="#ff7a00" fillOpacity={0.06} stroke="#d9480f" strokeWidth={2.2 / s} strokeDasharray={closed ? undefined : `${5 / s} ${3 / s}`} pointerEvents="none" />);
    u.trace.forEach((p, i) => {
      const j = (i + 1) % u.trace.length;
      if (j === 0 && !closed) return;
      if (u.trace.length < 2) return;
      const a = ps[i];
      const b = ps[j];
      const d = pxDist(p, u.trace[j]) * u.scale;
      els.push(<Label key={`trd${i}`} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} text={`${d.toFixed(2)}m`} s={s} color="#d9480f" testId={`trace-dist-${i}`} />);
    });
    u.trace.forEach((p, i) => els.push(pt(`trace:${i}`, p, '#d9480f', 9, vertexName(i))));
  }
  // 距離測定
  if (u.measure.length) {
    const ps = u.measure.map((p) => disp(u, p));
    if (ps.length === 2) {
      els.push(<line key="ms" x1={ps[0].x} y1={ps[0].y} x2={ps[1].x} y2={ps[1].y} stroke="#1f5fbf" strokeWidth={2 / s} pointerEvents="none" />);
      els.push(<Label key="msl" x={(ps[0].x + ps[1].x) / 2} y={(ps[0].y + ps[1].y) / 2 - 12 / s} text={`${(pxDist(u.measure[0], u.measure[1]) * u.scale).toFixed(3)}m`} s={s} color="#1f5fbf" testId="measure-label" />);
    }
    u.measure.forEach((p, i) => els.push(pt(`measure:${i}`, p, '#1f5fbf', 7)));
  }
  return <g data-testid="underlay-overlay">{els}</g>;
}
