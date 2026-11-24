'use client';
import type { JSX } from 'react';
// 図面キャンバス（SVG）。実寸の表示空間（m）を画面座標へ変換して描画し、
// パン・ピンチズーム・回転・選択・ドラッグ移動・頂点編集・要素追加を処理する
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObstacleKind, ProjectDoc, SiteElementKind, Vec2 } from '@/types';
import { buildModel, currentSite, modelExtent, type Prim } from '@/engine/export/drawingModel';
import { useProject } from '@/stores/projectStore';
import { moveStalls, newId, rotateStalls, snapValue } from '@/engine/parking-optimizer/stallOps';
import { solveLand } from '@/engine/constraints/solver';
import { deleteVertexLand, insertVertexLand, moveVertexLand, remapEdges } from '@/engine/constraints/vertexEdit';
import { vertexName } from '@/engine/geometry/polygon';
import type { PxPoint, UnderlayMeta } from '@/types';
import { isUnderlayTool } from '@/stores/projectStore';
import { UnderlayImage, UnderlayOverlay } from '@/components/underlay/UnderlayLayer';
import { placeUnderlayPoint } from '@/components/underlay/actions';
import { keepPivot, pxDist, pxToWorld, worldToPx } from '@/engine/underlay/transform';
import { useUnderlayUi } from '@/stores/underlayUi';

interface View {
  cx: number;
  cy: number;
  s: number; // px / m
  rot: number; // 度
}

const OBSTACLE_DEFAULT: Record<string, { w: number; h: number }> = {
  building: { w: 8, h: 6 },
  pole: { w: 0.4, h: 0.4 },
  tree: { w: 2, h: 2 },
  sign: { w: 2, h: 0.4 },
  fence: { w: 10, h: 0.15 },
  retainingWall: { w: 10, h: 0.3 },
  waterway: { w: 10, h: 1 },
  gutter: { w: 10, h: 0.3 },
  planting: { w: 4, h: 1 },
  structure: { w: 3, h: 3 },
  setback: { w: 10, h: 2 },
  noParking: { w: 5, h: 5 },
};
const ELEMENT_DEFAULT: Record<SiteElementKind, { w: number; h: number }> = {
  arrow: { w: 4, h: 1 },
  wheelStop: { w: 1.6, h: 0.15 },
  turningSpace: { w: 11, h: 11 },
  gate: { w: 5, h: 0.2 },
  pedestrianPath: { w: 10, h: 1.5 },
};

function renderPrim(p: Prim, k: number, view: View): JSX.Element | null {
  const dash = 'dash' in p && p.dash ? p.dash.join(' ') : undefined;
  if (p.t === 'poly') {
    const hit = p.id && p.layer !== 'site' ? { 'data-hit': p.layer, 'data-id': p.id } : {};
    return (
      <polygon
        key={k}
        points={p.pts.map((q) => `${q.x},${q.y}`).join(' ')}
        fill={p.fill}
        fillOpacity={p.op}
        stroke={p.stroke}
        strokeWidth={p.sw}
        strokeDasharray={dash}
        strokeLinejoin="round"
        {...hit}
        data-pid={p.id}
        pointerEvents={p.id && p.layer !== 'site' ? 'all' : 'none'}
        style={p.id && p.layer !== 'site' ? { cursor: 'pointer' } : undefined}
      />
    );
  }
  if (p.t === 'line') return <line key={k} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={p.stroke} strokeWidth={p.sw} strokeDasharray={dash} strokeLinecap="round" pointerEvents="none" />;
  if (p.t === 'circle') {
    const hit = p.id ? { 'data-hit': p.layer, 'data-id': p.id } : {};
    return <circle key={k} cx={p.c.x} cy={p.c.y} r={p.r} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} {...hit} pointerEvents={p.id ? 'all' : 'none'} />;
  }
  // 文字は画面回転に対して読みやすい向きを保つ
  let rot = (p.rot ?? 0) + 0;
  const total = rot + view.rot;
  if (total > 90 || total < -90) rot += 180;
  if (total > 270) rot -= 360;
  return (
    <text
      key={k}
      x={p.p.x}
      y={p.p.y}
      fontSize={p.size}
      fontWeight={p.weight ?? 400}
      textAnchor={p.anchor}
      dominantBaseline="middle"
      fill={p.fill}
      stroke={p.halo ? '#ffffff' : undefined}
      strokeWidth={p.halo ? p.size * 0.25 : undefined}
      paintOrder="stroke"
      transform={rot ? `rotate(${rot} ${p.p.x} ${p.p.y})` : undefined}
      pointerEvents="none"
      style={{ userSelect: 'none' }}
    >
      {p.text}
    </text>
  );
}

export function DrawingCanvas({ problems }: { problems: Set<string> }): JSX.Element {
  const doc = useProject((s) => s.doc) as ProjectDoc;
  const st = useProject();
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ cx: 10, cy: -7, s: 20, rot: 0 });
  const site = currentSite(doc);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const e = { ...modelExtent(doc, site) };
    // 下絵を表示中は画像全体も収める
    const u = doc.underlay;
    if (u && u.visible) {
      const cs = [{ u: 0, v: 0 }, { u: u.pxWidth, v: 0 }, { u: u.pxWidth, v: u.pxHeight }, { u: 0, v: u.pxHeight }].map((q) => pxToWorld(u, q));
      const hasModel = !!site || doc.stalls.length > 0;
      if (!hasModel) Object.assign(e, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      for (const c of cs) {
        e.minX = Math.min(e.minX, c.x);
        e.maxX = Math.max(e.maxX, c.x);
        e.minY = Math.min(e.minY, -c.y);
        e.maxY = Math.max(e.maxY, -c.y);
      }
    }
    // 画面上の余白（上：案内バナー、下：浮動ボタン）を確保して収める
    const w = e.maxX - e.minX + 2;
    const h = e.maxY - e.minY + 2;
    // 小さい画面（パネル表示中のiPhone SEなど）では余白を縮める
    // 案内バナー（高さ48px・上端8px）表示中はその下から、通常は方位マーク・縮尺バーの下から
    const bannerShown = st.tool.startsWith('ul') || st.tool.startsWith('add');
    const padTop = bannerShown ? Math.min(64, size.h * 0.22) : Math.min(112, size.h * 0.16);
    const padBottom = Math.min(76, size.h * 0.12);
    const s = Math.max(0.3, Math.min((size.w - 32) / w, Math.max(40, size.h - padTop - padBottom) / h));
    const cyShift = ((padTop - padBottom) / 2) / s;
    setView({ cx: (e.minX + e.maxX) / 2, cy: (e.minY + e.maxY) / 2 - cyShift, s, rot: 0 });
  }, [doc, site, size, st.tool]);

  // 初回・画面サイズ変更時（ユーザーが視点を動かすまで）は全体表示に合わせる
  const userMoved = useRef(false);
  useEffect(() => {
    if (size.w < 50) return;
    if (fitted.current !== doc.id) {
      fitted.current = doc.id;
      userMoved.current = false;
      fit();
    } else if (!userMoved.current) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, size.w, size.h]);

  useEffect(() => {
    const h = (): void => {
      userMoved.current = false;
      fit();
    };
    window.addEventListener('ldc:fit', h);
    const hu = (): void => {
      if (!userMoved.current) fit();
    };
    window.addEventListener('ldc:fit-if-untouched', hu);
    const r = (e: Event): void => setView((v) => ({ ...v, rot: (e as CustomEvent<number>).detail === 0 ? 0 : (v.rot + (e as CustomEvent<number>).detail) % 360 }));
    window.addEventListener('ldc:rotate', r);
    const z = (e: Event): void => (userMoved.current = true, setView((v) => ({ ...v, s: Math.min(400, Math.max(0.3, v.s * (e as CustomEvent<number>).detail)) })));
    window.addEventListener('ldc:zoom', z);
    return () => {
      window.removeEventListener('ldc:fit', h);
      window.removeEventListener('ldc:fit-if-untouched', hu);
      window.removeEventListener('ldc:rotate', r);
      window.removeEventListener('ldc:zoom', z);
    };
  }, [fit]);

  const textUnit = 1 / view.s;
  const highlight = useMemo(() => new Set(st.selIds), [st.selIds]);
  const seeThrough = !!(doc.underlay && doc.underlay.visible);
  const prims = useMemo(() => buildModel(doc, { mode: doc.mode, textUnit, sitePoints: site, highlight, problems, seeThrough }), [doc, textUnit, site, highlight, problems, seeThrough]);

  // 画面 ↔ 表示空間
  const toDisp = useCallback(
    (sx: number, sy: number): Vec2 => {
      const dx = (sx - size.w / 2) / view.s;
      const dy = (sy - size.h / 2) / view.s;
      const r = (-view.rot * Math.PI) / 180;
      return { x: view.cx + dx * Math.cos(r) - dy * Math.sin(r), y: view.cy + dx * Math.sin(r) + dy * Math.cos(r) };
    },
    [size, view],
  );
  const toWorld = (sx: number, sy: number): Vec2 => {
    const d = toDisp(sx, sy);
    return { x: d.x, y: -d.y };
  };

  // ---- ポインタ処理 ----
  // 操作ルール（iPhone 前提）
  //  ・2本指：ピンチで拡大縮小、2本指ドラッグで図面移動。2本目の指が触れたら進行中の1本指操作は取り消す
  //  ・1本指：選択済みの枠をドラッグで移動／未選択の枠はタップで選択（ドラッグした場合は図面移動）
  //  ・回転ハンドル：選択中の枠を回転（1°刻み、15°の倍数に吸着）
  //  ・追加ツール：指を離した位置に配置（ピンチ開始時に誤って配置しない）
  //  ・長押し：枠を複数選択に追加／解除
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  type ItemKind = 'stall' | 'obstacle' | 'element' | 'aisle';
  const gesture = useRef<
    | { type: 'pan'; start: Vec2; view: View; moved: boolean; tap?: { kind: ItemKind; id: string } | 'empty' | 'add' }
    | { type: 'pinch'; d0: number; mid0: Vec2; view: View }
    | { type: 'move'; start: Vec2; ids: Set<string>; kind: ItemKind; base: ProjectDoc; moved: boolean; screen0: Vec2 }
    | { type: 'rotate'; center: Vec2; a0: number; ids: Set<string>; base: ProjectDoc; baseAngle: number; moved: boolean }
    | { type: 'vertex'; idx: number; moved: boolean; screen0: Vec2 }
    | { type: 'ulpoint'; px: PxPoint }
    | { type: 'uldrag'; ref: string; moved: boolean }
    | { type: 'ulmove'; start: Vec2; base: UnderlayMeta; moved: boolean }
    | null
  >(null);
  // ルーペ（指の下を拡大表示：下絵上の点を正確に置くため）
  const [loupe, setLoupe] = useState<{ x: number; y: number } | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rotLabel, setRotLabel] = useState<{ x: number; y: number; text: string } | null>(null);
  const clearLong = (): void => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };

  const local = (e: React.PointerEvent | PointerEvent): Vec2 => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // 選択中の枠の回転中心とハンドル位置（ワールド座標）
  const selStalls = st.selKind === 'stall' ? doc.stalls.filter((x) => st.selIds.includes(x.id)) : [];
  const rotHandle = useMemo(() => {
    if (!selStalls.length || st.locked) return null;
    const c = { x: selStalls.reduce((a, x) => a + x.cx, 0) / selStalls.length, y: selStalls.reduce((a, x) => a + x.cy, 0) / selStalls.length };
    const gap = 34 / view.s;
    if (selStalls.length === 1) {
      const x = selStalls[0];
      const th = (x.angle * Math.PI) / 180;
      const front = { x: Math.sin(th), y: -Math.cos(th) }; // 奥行き方向の逆＝入庫側
      const r = x.depth / 2 + gap;
      return { c, h: { x: c.x + front.x * r, y: c.y + front.y * r } };
    }
    const R = Math.max(...selStalls.map((x) => Math.hypot(x.cx - c.x, x.cy - c.y) + Math.hypot(x.width, x.depth) / 2));
    // 画面の上方向（表示回転を考慮）にハンドルを置く：表示空間の (0,-1) を逆回転し、y を反転してワールドへ
    const phi = (-view.rot * Math.PI) / 180;
    return { c, h: { x: c.x + Math.sin(phi) * (R + gap), y: c.y + Math.cos(phi) * (R + gap) } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStalls.map((x) => `${x.id}:${x.cx}:${x.cy}:${x.angle}`).join('|'), view.s, view.rot, st.locked]);

  const startPinch = (): void => {
    const g = gesture.current;
    if (g && (g.type === 'move' || g.type === 'rotate' || g.type === 'vertex') && (('moved' in g && g.moved) || g.type === 'vertex')) st.cancelLive();
    if (g && (g.type === 'uldrag' || g.type === 'ulmove')) st.cancelLive();
    setLoupe(null);
    setRotLabel(null);
    clearLong();
    const [a, b] = [...pointers.current.values()];
    gesture.current = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    try {
      wrap.current?.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    const p = local(e);
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType });
    window.dispatchEvent(new CustomEvent('ldc:canvas-touch'));
    if (pointers.current.size >= 2) {
      startPinch();
      return;
    }
    const touch = e.pointerType !== 'mouse';
    const target = (e.target as Element).closest('[data-hit]') as HTMLElement | null;
    const hit = target?.getAttribute('data-hit');
    const id = target?.getAttribute('data-id') ?? '';
    const w = toWorld(p.x, p.y);

    // ---- 下絵ツール ----
    const ul = doc.underlay;
    if (ul && isUnderlayTool(st.tool)) {
      if (ul.locked) return;
      if (st.tool === 'ulMove') {
        st.beginLive('下絵の移動');
        gesture.current = { type: 'ulmove', start: w, base: ul, moved: false };
        return;
      }
      if (hit === 'ulpt' && !id.startsWith('pend:')) {
        st.beginLive('点の移動');
        gesture.current = { type: 'uldrag', ref: id, moved: false };
        setLoupe(p);
        return;
      }
      gesture.current = { type: 'ulpoint', px: worldToPx(ul, w) };
      setLoupe(p);
      return;
    }

    if (hit === 'rotate' && rotHandle) {
      const ids = new Set(useProject.getState().selIds);
      st.beginLive('回転');
      gesture.current = { type: 'rotate', center: rotHandle.c, a0: Math.atan2(w.y - rotHandle.c.y, w.x - rotHandle.c.x), ids, base: doc, baseAngle: selStalls[0]?.angle ?? 0, moved: false };
      return;
    }
    if (st.tool === 'vertex' && site) {
      if (hit === 'vertex' && !st.locked) {
        st.beginLive('頂点の移動');
        st.select('vertex', [id]);
        gesture.current = { type: 'vertex', idx: Number(id), moved: false, screen0: p };
        return;
      }
      if (hit === 'edge' && !st.locked) {
        const edge = Number(id);
        st.commit('頂点の追加', (d) => {
          const r = insertVertexLand(d.land, site, edge);
          return { ...d, land: r.land, solution: solveLand(r.land), selectedCandidate: 0, roads: remapEdges(d.roads, 'insert', edge, site.length), entrances: remapEdges(d.entrances, 'insert', edge, site.length) };
        });
        return;
      }
    }
    if (st.tool === 'addStall' || st.tool === 'addObstacle' || st.tool === 'addElement') {
      gesture.current = { type: 'pan', start: p, view, moved: false, tap: st.locked ? undefined : 'add' };
      return;
    }
    if (st.tool !== 'pan' && hit && ['stall', 'obstacle', 'element', 'aisle'].includes(hit) && id) {
      const kind = hit as ItemKind;
      const already = st.selKind === kind && st.selIds.includes(id);
      if (touch && !already) {
        // 未選択の枠：タップで選択、ドラッグなら図面移動、長押しで複数選択
        gesture.current = { type: 'pan', start: p, view, moved: false, tap: { kind, id } };
        longPress.current = setTimeout(() => {
          const g = gesture.current;
          if (g?.type === 'pan' && !g.moved && g.tap && typeof g.tap === 'object') {
            useProject.getState().select(g.tap.kind, [g.tap.id], true);
            g.tap = undefined;
          }
        }, 550);
        return;
      }
      if (!touch && (!already || st.multiSelect || e.shiftKey)) st.select(kind, [id], e.shiftKey);
      else if (touch && already && st.multiSelect) {
        // 複数選択モード中は選択済みのタップで解除（移動しなければ）
      }
      const ids = new Set(useProject.getState().selIds);
      if (!st.locked && ids.size) gesture.current = { type: 'move', start: w, ids, kind, base: doc, moved: false, screen0: p };
      if (touch && already) {
        longPress.current = setTimeout(() => {
          const g = gesture.current;
          if (g?.type === 'move' && !g.moved) {
            useProject.getState().select(kind, [id], true);
            gesture.current = null;
          }
        }, 550);
      }
      return;
    }
    gesture.current = { type: 'pan', start: p, view, moved: false, tap: 'empty' };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, { ...p, type: prev.type });
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      userMoved.current = true;
      const s = Math.min(400, Math.max(0.3, g.view.s * (d / Math.max(1, g.d0))));
      // ピンチ中心を固定してズーム＋2本指移動
      const r = (-g.view.rot * Math.PI) / 180;
      const anchorDx = (g.mid0.x - size.w / 2) / g.view.s;
      const anchorDy = (g.mid0.y - size.h / 2) / g.view.s;
      const ax = g.view.cx + anchorDx * Math.cos(r) - anchorDy * Math.sin(r);
      const ay = g.view.cy + anchorDx * Math.sin(r) + anchorDy * Math.cos(r);
      const ndx = (mid.x - size.w / 2) / s;
      const ndy = (mid.y - size.h / 2) / s;
      setView({ ...g.view, s, cx: ax - (ndx * Math.cos(r) - ndy * Math.sin(r)), cy: ay - (ndx * Math.sin(r) + ndy * Math.cos(r)) });
      return;
    }
    if (g.type === 'ulpoint' && doc.underlay) {
      g.px = worldToPx(doc.underlay, toWorld(p.x, p.y));
      setLoupe(p);
      return;
    }
    if (g.type === 'uldrag') {
      const w = toWorld(p.x, p.y);
      g.moved = true;
      setLoupe(p);
      st.live((d) => {
        const u = d.underlay;
        if (!u) return d;
        const q = worldToPx(u, w);
        const [kind, key] = g.ref.split(':');
        if (kind === 'trace') return { ...d, underlay: { ...u, trace: u.trace.map((x, i) => (i === Number(key) ? q : x)) } };
        if (kind === 'measure') return { ...d, underlay: { ...u, measure: u.measure.map((x, i) => (i === Number(key) ? q : x)) } };
        if (kind === 'cal' && u.calibration) {
          const cal = { ...u.calibration, [key]: q };
          // 実寸を入力済みなら縮尺を追従（もう一方の点を基点に固定）
          if (cal.length > 0 && pxDist(cal.a, cal.b) > 5) {
            const other = key === 'a' ? cal.b : cal.a;
            const scale = cal.length / pxDist(cal.a, cal.b);
            const pivotW = pxToWorld(u, other);
            const t = keepPivot(u, { scale, rotation: u.rotation }, pivotW);
            return { ...d, underlay: { ...u, calibration: cal, scale, ...t } };
          }
          return { ...d, underlay: { ...u, calibration: cal } };
        }
        return d;
      });
      return;
    }
    if (g.type === 'ulmove') {
      const w = toWorld(p.x, p.y);
      g.moved = true;
      st.live((d) => (d.underlay ? { ...d, underlay: { ...d.underlay, tx: g.base.tx + (w.x - g.start.x), ty: g.base.ty + (w.y - g.start.y) } } : d));
      return;
    }
    if (g.type === 'pan') {
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) <= 8) return;
      if (!g.moved) {
        g.moved = true;
        clearLong();
      }
      userMoved.current = true;
      const r = (-g.view.rot * Math.PI) / 180;
      setView({ ...g.view, cx: g.view.cx - (dx * Math.cos(r) - dy * Math.sin(r)) / g.view.s, cy: g.view.cy - (dx * Math.sin(r) + dy * Math.cos(r)) / g.view.s });
      return;
    }
    if (g.type === 'rotate') {
      const w = toWorld(p.x, p.y);
      const a = Math.atan2(w.y - g.center.y, w.x - g.center.x);
      let delta = ((a - g.a0) * 180) / Math.PI;
      // 結果の角度を1°刻みに、15°の倍数付近(±3°)は吸着
      let target = Math.round(g.baseAngle + delta);
      const m15 = Math.round(target / 15) * 15;
      if (Math.abs(target - m15) <= 3) target = m15;
      delta = target - g.baseAngle;
      g.moved = true;
      st.live((d) => ({ ...d, stalls: rotateStalls(g.base.stalls, g.ids, delta) }));
      const norm = ((target % 360) + 540) % 360 - 180;
      setRotLabel({ x: p.x, y: p.y - 48, text: g.ids.size === 1 ? `${norm}°` : `${delta > 0 ? '+' : ''}${Math.round(delta)}°` });
      return;
    }
    if (g.type === 'move') {
      if (!g.moved && Math.hypot(p.x - g.screen0.x, p.y - g.screen0.y) < 8) return; // 誤操作防止
      if (!g.moved) {
        g.moved = true;
        clearLong();
        st.beginLive('移動');
      }
      const w = toWorld(p.x, p.y);
      const dx = w.x - g.start.x;
      const dy = w.y - g.start.y;
      const sn = st.snap;
      st.live((d) => {
        if (g.kind === 'stall') return { ...d, stalls: moveStalls(g.base.stalls, g.ids, dx, dy, sn) };
        const mv = <T extends { id: string; cx: number; cy: number }>(arr: T[]): T[] => arr.map((o) => (g.ids.has(o.id) ? { ...o, cx: snapValue(o.cx + dx, sn), cy: snapValue(o.cy + dy, sn) } : o));
        if (g.kind === 'obstacle') return { ...d, obstacles: mv(g.base.obstacles) };
        if (g.kind === 'element') return { ...d, elements: mv(g.base.elements) };
        return { ...d, aisles: mv(g.base.aisles) };
      });
      return;
    }
    if (g.type === 'vertex' && site) {
      if (!g.moved && Math.hypot(p.x - g.screen0.x, p.y - g.screen0.y) < 8) return;
      g.moved = true;
      const w = toWorld(p.x, p.y);
      const np = { x: snapValue(w.x, st.snap), y: snapValue(w.y, st.snap) };
      st.live((d) => {
        const cur = currentSite(d) ?? site;
        const land = moveVertexLand(d.land, cur, g.idx, np);
        const pts = cur.map((q, i) => (i === g.idx ? np : q));
        return {
          ...d,
          land,
          solution: { status: 'exact', candidates: [{ points: pts, rms: 0, maxError: 0, maxAngleError: 0, residuals: [], selfIntersecting: false }], missingConstraints: 0, constraintCount: 0, rank: 0, messages: ['頂点編集中'], solvedAt: new Date().toISOString() },
          selectedCandidate: 0,
        };
      });
    }
  };

  const placeAt = (p: Vec2): void => {
    const w = toWorld(p.x, p.y);
    const sx = snapValue(w.x, st.snap);
    const sy = snapValue(w.y, st.snap);
    const ang = ((view.rot % 360) + 360) % 360;
    if (st.tool === 'addStall') {
      const t = doc.stallTypes.find((x) => x.id === st.addKind) ?? doc.stallTypes[0];
      const sid = newId('s');
      st.commit('駐車枠の追加', (d) => ({ ...d, stalls: [...d.stalls, { id: sid, typeId: t.id, cx: sx, cy: sy, width: t.width, depth: t.depth, angle: ang }] }));
      st.select('stall', [sid]);
    } else if (st.tool === 'addObstacle') {
      const k = st.addKind as ObstacleKind;
      const dim = OBSTACLE_DEFAULT[k] ?? { w: 3, h: 3 };
      const oid = newId('o');
      st.commit('障害物の追加', (d) => ({ ...d, obstacles: [...d.obstacles, { id: oid, kind: k, cx: sx, cy: sy, w: dim.w, h: dim.h, angle: ang }] }));
      st.select('obstacle', [oid]);
    } else if (st.tool === 'addElement') {
      const k = st.addKind as SiteElementKind;
      const dim = ELEMENT_DEFAULT[k] ?? { w: 2, h: 2 };
      const eid = newId('x');
      st.commit('設備の追加', (d) => ({ ...d, elements: [...d.elements, { id: eid, kind: k, cx: sx, cy: sy, w: dim.w, h: dim.h, angle: ang }] }));
      st.select('element', [eid]);
    }
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    const info = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    clearLong();
    const g = gesture.current;
    if (g?.type === 'pinch') {
      if (pointers.current.size === 1) {
        // 残った1本指は図面移動として継続（枠は動かさない）
        const [q] = [...pointers.current.values()];
        gesture.current = { type: 'pan', start: q, view, moved: true };
      } else if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (pointers.current.size > 0) return;
    if (e.type === 'pointercancel') {
      if (g && (g.type === 'move' || g.type === 'rotate' || g.type === 'vertex' || g.type === 'uldrag' || g.type === 'ulmove')) st.cancelLive();
      gesture.current = null;
      setRotLabel(null);
      setLoupe(null);
      return;
    }
    if (g?.type === 'ulpoint') {
      setLoupe(null);
      if (e.type !== 'pointercancel') placeUnderlayPoint(g.px);
      gesture.current = null;
      return;
    }
    if (g?.type === 'uldrag' || g?.type === 'ulmove') {
      setLoupe(null);
      if (g.moved) st.endLive();
      else st.cancelLive();
      gesture.current = null;
      return;
    }
    if (g?.type === 'pan' && !g.moved) {
      if (g.tap === 'add') placeAt(local(e));
      else if (g.tap === 'empty' && info?.type === 'mouse' && st.tool !== 'pan') st.clearSelection();
      else if (g.tap && typeof g.tap === 'object') st.select(g.tap.kind, [g.tap.id], st.multiSelect);
    }
    if (g?.type === 'move') {
      if (g.moved) st.endLive();
    }
    if (g?.type === 'rotate') {
      if (g.moved) st.endLive();
      else st.cancelLive();
      setRotLabel(null);
    }
    if (g?.type === 'vertex') {
      if (g.moved) {
        st.live((d) => ({ ...d, solution: solveLand(d.land) }));
        st.endLive();
      } else st.endLive();
    }
    gesture.current = null;
  };

  // iOS Safari：ページ自体のピンチズーム・スクロール・バウンスを図面上で抑止（タッチ操作とスクロールの干渉防止）
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const stop = (ev: Event): void => {
      if (ev.cancelable) ev.preventDefault();
    };
    el.addEventListener('touchstart', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('gesturestart', stop as EventListener, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gesturechange', stop as EventListener, { passive: false } as AddEventListenerOptions);
    el.addEventListener('contextmenu', stop);
    return () => {
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('gesturestart', stop as EventListener);
      el.removeEventListener('gesturechange', stop as EventListener);
      el.removeEventListener('contextmenu', stop);
    };
  }, []);

  const onWheel = (e: React.WheelEvent): void => {
    const p = local(e as unknown as PointerEvent);
    const before = toDisp(p.x, p.y);
    const f = Math.exp(-e.deltaY * 0.0015);
    userMoved.current = true;
    setView((v) => {
      const s = Math.min(400, Math.max(0.3, v.s * f));
      const r = (-v.rot * Math.PI) / 180;
      const dx = (p.x - size.w / 2) / s;
      const dy = (p.y - size.h / 2) / s;
      return { ...v, s, cx: before.x - (dx * Math.cos(r) - dy * Math.sin(r)), cy: before.y - (dx * Math.sin(r) + dy * Math.cos(r)) };
    });
  };

  // キーボード操作（PC）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const s = useProject.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selIds.length && !s.locked) {
        window.dispatchEvent(new CustomEvent('ldc:delete-selection'));
      } else if (e.key === 'Escape') s.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tf = `translate(${size.w / 2} ${size.h / 2}) rotate(${view.rot}) scale(${view.s}) translate(${-view.cx} ${-view.cy})`;

  // 画面縮尺バー
  const niceM = [0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((m) => m * view.s >= 60) ?? 500;
  const vertexHandles = st.tool === 'vertex' && site;

  return (
    <div
      ref={wrap}
      className="relative h-full w-full touch-none select-none overflow-hidden bg-[#fbfcfc] [-webkit-touch-callout:none] [-webkit-user-select:none]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={(e) => pointers.current.has(e.pointerId) && onPointerUp(e)}
      onWheel={onWheel}
      data-testid="canvas"
      style={{ cursor: st.tool === 'pan' ? 'grab' : st.tool.startsWith('add') ? 'crosshair' : 'default' }}
    >
      <svg width={size.w} height={size.h} className="block select-none" data-testid="drawing-svg" data-mode={doc.mode}>
        <defs>
          <pattern id="grid" width={niceM * view.s} height={niceM * view.s} patternUnits="userSpaceOnUse">
            <path d={`M ${niceM * view.s} 0 L 0 0 0 ${niceM * view.s}`} fill="none" stroke="#e6eaec" strokeWidth={1} />
          </pattern>
        </defs>
        {doc.mode === 'cad' && <rect width={size.w} height={size.h} fill="url(#grid)" />}
        <g transform={tf} id="ldc-scene">
          {doc.underlay && <UnderlayImage u={doc.underlay} />}
          {prims.map((p, i) => renderPrim(p, i, view))}
          {vertexHandles &&
            site!.map((q, i) => {
              const b = site![(i + 1) % site!.length];
              const m = { x: (q.x + b.x) / 2, y: -(q.y + b.y) / 2 };
              return (
                <g key={`h${i}`}>
                  <circle cx={m.x} cy={m.y} r={9 / view.s} fill="#ffffff" stroke="#0b5d63" strokeWidth={1.5 / view.s} data-hit="edge" data-id={String(i)} style={{ cursor: 'copy' }} />
                  <text x={m.x} y={m.y} fontSize={13 / view.s} textAnchor="middle" dominantBaseline="central" fill="#0b5d63" pointerEvents="none">
                    +
                  </text>
                </g>
              );
            })}
          {vertexHandles &&
            site!.map((q, i) => (
              <circle
                key={`v${i}`}
                cx={q.x}
                cy={-q.y}
                r={11 / view.s}
                fill={st.selKind === 'vertex' && st.selIds.includes(String(i)) ? '#e4002b' : '#0b5d63'}
                fillOpacity={0.85}
                stroke="#fff"
                strokeWidth={2 / view.s}
                data-hit="vertex"
                data-id={String(i)}
                data-testid={`vertex-${vertexName(i)}`}
                style={{ cursor: 'move' }}
              />
            ))}
          {doc.underlay && <UnderlayOverlay u={doc.underlay} s={view.s} />}
          {rotHandle && !isUnderlayTool(st.tool) && (
            <g data-testid="rotate-handle-group">
              <line x1={rotHandle.c.x} y1={-rotHandle.c.y} x2={rotHandle.h.x} y2={-rotHandle.h.y} stroke="#e4002b" strokeWidth={1.5 / view.s} strokeDasharray={`${4 / view.s} ${3 / view.s}`} pointerEvents="none" />
              <circle cx={rotHandle.c.x} cy={-rotHandle.c.y} r={3 / view.s} fill="#e4002b" pointerEvents="none" />
              {/* 指で掴みやすいよう当たり判定は 22px */}
              <circle cx={rotHandle.h.x} cy={-rotHandle.h.y} r={22 / view.s} fill="#ffffff" fillOpacity={0.01} data-hit="rotate" data-id="rotate" data-testid="rotate-handle" pointerEvents="all" />
              <circle cx={rotHandle.h.x} cy={-rotHandle.h.y} r={12 / view.s} fill="#ffffff" stroke="#e4002b" strokeWidth={2 / view.s} pointerEvents="none" />
              <path d={`M ${rotHandle.h.x - 5 / view.s} ${-rotHandle.h.y + 2 / view.s} a ${5 / view.s} ${5 / view.s} 0 1 1 ${5 / view.s} ${4 / view.s}`} fill="none" stroke="#e4002b" strokeWidth={1.8 / view.s} pointerEvents="none" />
            </g>
          )}
        </g>
      </svg>
      {loupe && <Loupe x={loupe.x} y={loupe.y} w={size.w} />}
      {rotLabel && (
        <div className="pointer-events-none absolute -translate-x-1/2 rounded bg-ink px-2 py-1 font-mono text-[15px] font-bold text-white" style={{ left: rotLabel.x, top: rotLabel.y }} data-testid="rotate-label">
          {rotLabel.text}
        </div>
      )}

      {/* 方位マーク */}
      <div className="pointer-events-none absolute right-3 top-3 flex h-14 w-14 items-center justify-center rounded-full border border-neutral-300 bg-white/90" style={{ transform: `rotate(${doc.northAngle + view.rot}deg)` }} aria-label="方位">
        <svg viewBox="-20 -20 40 40" width="44" height="44">
          <polygon points="0,-15 6,9 0,5 -6,9" fill="#14161a" />
          <text x="0" y="-15" fontSize="8" textAnchor="middle" fill="#e4002b" fontWeight="700" dy="-1">
            N
          </text>
        </svg>
      </div>
      {/* 縮尺バー */}
      <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/90 px-2 py-1 text-[12px] text-ink shadow-sm" data-testid="scale-bar" data-px-per-m={view.s.toFixed(4)}>
        <div className="flex items-end gap-2">
          <div style={{ width: niceM * view.s }} className="h-2 border-x-2 border-b-2 border-ink" />
          <span className="font-mono">{niceM}m</span>
        </div>
      </div>
      {!site && (
        <div className="pointer-events-none absolute inset-x-4 top-16 mx-auto max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          土地形状がまだ確定していません。寸法を入力してください（形状が一意に定まるまで図面は生成されません）。
        </div>
      )}
    </div>
  );
}

/** 指で隠れる位置を拡大して表示（十字線の中心＝配置位置） */
function Loupe({ x, y, w }: { x: number; y: number; w: number }): JSX.Element {
  const R = 64;
  const Z = 3;
  const left = Math.min(Math.max(x - R, 4), w - 2 * R - 4);
  const top = y - 2 * R - 36 < 4 ? y + 36 : y - 2 * R - 36;
  return (
    <svg className="pointer-events-none absolute rounded-full border-2 border-ink bg-white shadow-xl" style={{ left, top, width: 2 * R, height: 2 * R }} viewBox={`0 0 ${2 * R} ${2 * R}`} data-testid="loupe">
      <defs>
        <clipPath id="loupe-clip">
          <circle cx={R} cy={R} r={R - 1} />
        </clipPath>
      </defs>
      <g clipPath="url(#loupe-clip)">
        <rect width={2 * R} height={2 * R} fill="#fbfcfc" />
        <g transform={`translate(${R} ${R}) scale(${Z}) translate(${-x} ${-y})`}>
          <use href="#ldc-scene" />
        </g>
      </g>
      <line x1={R} y1={R - 18} x2={R} y2={R - 4} stroke="#e4002b" strokeWidth={1.5} />
      <line x1={R} y1={R + 4} x2={R} y2={R + 18} stroke="#e4002b" strokeWidth={1.5} />
      <line x1={R - 18} y1={R} x2={R - 4} y2={R} stroke="#e4002b" strokeWidth={1.5} />
      <line x1={R + 4} y1={R} x2={R + 18} y2={R} stroke="#e4002b" strokeWidth={1.5} />
    </svg>
  );
}

export function deleteSelectedVertex(doc: ProjectDoc, idx: number): Partial<ProjectDoc> | null {
  const site = currentSite(doc);
  if (!site) return null;
  const r = deleteVertexLand(doc.land, site, idx);
  if (!r) return null;
  return { land: r.land, solution: solveLand(r.land), selectedCandidate: 0, roads: remapEdges(doc.roads, 'delete', idx, site.length), entrances: remapEdges(doc.entrances, 'delete', idx, site.length) };
}
