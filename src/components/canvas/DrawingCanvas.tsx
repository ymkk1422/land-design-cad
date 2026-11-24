'use client';
import type { JSX } from 'react';
// 図面キャンバス（SVG）。実寸の表示空間（m）を画面座標へ変換して描画し、
// パン・ピンチズーム・回転・選択・ドラッグ移動・頂点編集・要素追加を処理する
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObstacleKind, ProjectDoc, SiteElementKind, Vec2 } from '@/types';
import { buildModel, currentSite, modelExtent, type Prim } from '@/engine/export/drawingModel';
import { useProject } from '@/stores/projectStore';
import { moveStalls, newId, snapValue } from '@/engine/parking-optimizer/stallOps';
import { solveLand } from '@/engine/constraints/solver';
import { deleteVertexLand, insertVertexLand, moveVertexLand, remapEdges } from '@/engine/constraints/vertexEdit';
import { vertexName } from '@/engine/geometry/polygon';

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
    const e = modelExtent(doc, site);
    const w = e.maxX - e.minX + 8;
    const h = e.maxY - e.minY + 8;
    const s = Math.max(0.5, Math.min(size.w / w, size.h / h));
    setView({ cx: (e.minX + e.maxX) / 2, cy: (e.minY + e.maxY) / 2, s, rot: 0 });
  }, [doc, site, size]);

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
    const r = (e: Event): void => setView((v) => ({ ...v, rot: (e as CustomEvent<number>).detail === 0 ? 0 : (v.rot + (e as CustomEvent<number>).detail) % 360 }));
    window.addEventListener('ldc:rotate', r);
    const z = (e: Event): void => (userMoved.current = true, setView((v) => ({ ...v, s: Math.min(400, Math.max(0.3, v.s * (e as CustomEvent<number>).detail)) })));
    window.addEventListener('ldc:zoom', z);
    return () => {
      window.removeEventListener('ldc:fit', h);
      window.removeEventListener('ldc:rotate', r);
      window.removeEventListener('ldc:zoom', z);
    };
  }, [fit]);

  const textUnit = 1 / view.s;
  const highlight = useMemo(() => new Set(st.selIds), [st.selIds]);
  const prims = useMemo(() => buildModel(doc, { mode: doc.mode, textUnit, sitePoints: site, highlight, problems }), [doc, textUnit, site, highlight, problems]);

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
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { type: 'pan'; start: Vec2; view: View; moved: boolean }
    | { type: 'pinch'; d0: number; mid0: Vec2; view: View }
    | { type: 'move'; start: Vec2; ids: Set<string>; kind: 'stall' | 'obstacle' | 'element' | 'aisle'; base: ProjectDoc; moved: boolean; screen0: Vec2 }
    | { type: 'vertex'; idx: number; moved: boolean; screen0: Vec2 }
    | null
  >(null);

  const local = (e: React.PointerEvent | PointerEvent): Vec2 => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      if (gesture.current?.type === 'move' || gesture.current?.type === 'vertex') st.endLive();
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
      return;
    }
    const target = (e.target as Element).closest('[data-hit]') as HTMLElement | null;
    const hit = target?.getAttribute('data-hit');
    const id = target?.getAttribute('data-id') ?? '';
    const w = toWorld(p.x, p.y);

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
    if ((st.tool === 'addStall' || st.tool === 'addObstacle' || st.tool === 'addElement') && !st.locked && e.button === 0) {
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
      } else {
        const k = st.addKind as SiteElementKind;
        const dim = ELEMENT_DEFAULT[k] ?? { w: 2, h: 2 };
        const eid = newId('x');
        st.commit('設備の追加', (d) => ({ ...d, elements: [...d.elements, { id: eid, kind: k, cx: sx, cy: sy, w: dim.w, h: dim.h, angle: ang }] }));
        st.select('element', [eid]);
      }
      return;
    }
    if (st.tool !== 'pan' && hit && ['stall', 'obstacle', 'element', 'aisle'].includes(hit) && id) {
      const kind = hit as 'stall' | 'obstacle' | 'element' | 'aisle';
      const already = st.selKind === kind && st.selIds.includes(id);
      if (!already || st.multiSelect || e.shiftKey) st.select(kind, [id], e.shiftKey);
      const ids = new Set(useProject.getState().selIds);
      if (!st.locked && ids.size) {
        gesture.current = { type: 'move', start: w, ids, kind, base: doc, moved: false, screen0: p };
      }
      return;
    }
    gesture.current = { type: 'pan', start: p, view, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      userMoved.current = true;
      const s = Math.min(400, Math.max(0.3, g.view.s * (d / Math.max(1, g.d0))));
      // ピンチ中心を固定してズーム＋パン
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
    if (g.type === 'pan') {
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (Math.hypot(dx, dy) > 4) {
        g.moved = true;
        userMoved.current = true;
      }
      const r = (-g.view.rot * Math.PI) / 180;
      setView({ ...g.view, cx: g.view.cx - (dx * Math.cos(r) - dy * Math.sin(r)) / g.view.s, cy: g.view.cy - (dx * Math.sin(r) + dy * Math.cos(r)) / g.view.s });
      return;
    }
    if (g.type === 'move') {
      if (!g.moved && Math.hypot(p.x - g.screen0.x, p.y - g.screen0.y) < 6) return; // 誤操作防止
      if (!g.moved) {
        g.moved = true;
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
      if (!g.moved && Math.hypot(p.x - g.screen0.x, p.y - g.screen0.y) < 6) return;
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

  const onPointerUp = (e: React.PointerEvent): void => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.type === 'pinch') {
      if (pointers.current.size === 1) {
        const [q] = [...pointers.current.values()];
        gesture.current = { type: 'pan', start: q, view, moved: true };
      } else gesture.current = null;
      return;
    }
    if (pointers.current.size > 0) return;
    if (g?.type === 'pan' && !g.moved && st.tool !== 'pan') st.clearSelection();
    if (g?.type === 'move' && g.moved) st.endLive();
    if (g?.type === 'vertex') {
      if (g.moved) {
        st.live((d) => ({ ...d, solution: solveLand(d.land) }));
        st.endLive();
      } else st.endLive();
    }
    gesture.current = null;
  };

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
      className="relative h-full w-full touch-none overflow-hidden bg-[#fbfcfc]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
        <g transform={tf}>
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
        </g>
      </svg>

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
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-white/90 px-2 py-1 text-[12px] text-ink shadow-sm">
        <div className="flex items-end gap-2">
          <div style={{ width: niceM * view.s }} className="h-2 border-x-2 border-b-2 border-ink" />
          <span className="font-mono">{niceM}m</span>
        </div>
      </div>
      {!site && (
        <div className="pointer-events-none absolute inset-x-4 top-4 mx-auto max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          土地形状がまだ確定していません。寸法を入力してください（形状が一意に定まるまで図面は生成されません）。
        </div>
      )}
    </div>
  );
}

export function deleteSelectedVertex(doc: ProjectDoc, idx: number): Partial<ProjectDoc> | null {
  const site = currentSite(doc);
  if (!site) return null;
  const r = deleteVertexLand(doc.land, site, idx);
  if (!r) return null;
  return { land: r.land, solution: solveLand(r.land), selectedCandidate: 0, roads: remapEdges(doc.roads, 'delete', idx, site.length), entrances: remapEdges(doc.entrances, 'delete', idx, site.length) };
}
