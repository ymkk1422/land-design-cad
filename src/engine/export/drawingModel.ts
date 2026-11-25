// 図面モデル：実寸データ → 描画プリミティブ（画面・PDF・PNG で共通）
// 座標は「表示空間」(X=実寸x, Y=−実寸y, 単位m)。文字サイズは textUnit（1表示単位あたりのm）で指定し、
// 画面では px、出力では mm 基準で一定の大きさになる。
import type { ConstraintResidual, DrawingMode, LandFocus, ProjectDoc, SitePreview, Vec2 } from '@/types';
import {
  bbox,
  centroid,
  dist,
  interiorAngles,
  isCCW,
  rectCorners,
  vertexName,
} from '@/engine/geometry/polygon';
import { formatDMS, formatLength, m2ToTsubo } from '@/engine/area-calculation';
import { entranceGeometry } from '@/engine/parking-optimizer/optimizer';
import { stallCorners } from '@/engine/validation/interference';

export type Prim =
  | { t: 'poly'; pts: Vec2[]; fill: string; stroke: string; sw: number; dash?: number[]; op?: number; id?: string; layer: string; closed?: boolean }
  | { t: 'line'; a: Vec2; b: Vec2; stroke: string; sw: number; dash?: number[]; layer: string }
  | { t: 'text'; p: Vec2; text: string; size: number; fill: string; anchor: 'start' | 'middle' | 'end'; rot?: number; weight?: number; halo?: boolean; layer: string }
  | { t: 'circle'; c: Vec2; r: number; fill: string; stroke: string; sw: number; layer: string; id?: string };

export interface ModelOptions {
  mode: DrawingMode;
  /** 1 文字単位（画面1px／出力1mm）が何メートルか */
  textUnit: number;
  sitePoints: Vec2[] | null;
  highlight?: Set<string>;
  problems?: Set<string>;
  /** 線幅の基準（文字単位） */
  lineUnit?: number;
  /** 下絵を表示中：敷地・道路の塗りを透明にして下絵を透かす */
  seeThrough?: boolean;
  /** 形状が確定していない「仮の形」（sitePoints はその頂点）。合わない寸法を赤、自動で決めた寸法を灰色で示す */
  preview?: SitePreview | null;
  /** 入力中の案内（画面のみ）：始点Aと回る向き、入力中の辺などの強調 */
  guide?: { focus: LandFocus | null } | null;
}

const flip = (p: Vec2): Vec2 => ({ x: p.x, y: -p.y });

export const OBSTACLE_STYLE: Record<string, { name: string; fill: string; stroke: string }> = {
  building: { name: '建物', fill: '#d9d4c7', stroke: '#5b5647' },
  pole: { name: '電柱', fill: '#3d3d3d', stroke: '#111' },
  tree: { name: '樹木', fill: '#9cc79a', stroke: '#3c7a3a' },
  sign: { name: '看板', fill: '#f2d16b', stroke: '#8a6d12' },
  fence: { name: 'フェンス', fill: '#8a8f96', stroke: '#45494f' },
  retainingWall: { name: '擁壁', fill: '#b5aea0', stroke: '#5b5647' },
  waterway: { name: '水路', fill: '#a9d3ef', stroke: '#2c6fa0' },
  gutter: { name: '側溝', fill: '#c6dbe8', stroke: '#2c6fa0' },
  planting: { name: '植栽', fill: '#c4e3b5', stroke: '#4f8a3a' },
  structure: { name: '既存構造物', fill: '#cfc7d9', stroke: '#5a4a72' },
  setback: { name: 'セットバック', fill: '#f6c6c6', stroke: '#c0392b' },
  noParking: { name: '駐車禁止', fill: '#fbe0e0', stroke: '#e4002b' },
};

export const ELEMENT_NAMES: Record<string, string> = {
  arrow: '進行方向矢印',
  wheelStop: '車止め',
  turningSpace: '旋回スペース',
  gate: '門扉',
  pedestrianPath: '歩行者通路',
};

export function currentSite(p: ProjectDoc): Vec2[] | null {
  const s = p.solution;
  if (!s || !s.candidates.length) return null;
  if (!['exact', 'approximate', 'multiple'].includes(s.status)) return null;
  return s.candidates[Math.min(p.selectedCandidate, s.candidates.length - 1)].points;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function textBox(p: Vec2, text: string, size: number, anchor: 'start' | 'middle' | 'end'): Box {
  const w = text.length * size * 0.62;
  const x0 = anchor === 'start' ? p.x : anchor === 'end' ? p.x - w : p.x - w / 2;
  return { x0, y0: p.y - size * 0.8, x1: x0 + w, y1: p.y + size * 0.3 };
}

export function buildModel(doc: ProjectDoc, o: ModelOptions): Prim[] {
  const prims: Prim[] = [];
  const u = o.textUnit;
  const lw = (o.lineUnit ?? 1) * u;
  const cad = o.mode === 'cad';
  const d = doc.display;
  const site = o.sitePoints;
  const occupied: Box[] = [];
  const unit = d.unit;
  const fmt = (m: number): string => formatLength(m, unit, d.decimals);

  const placeText = (base: Vec2, dir: Vec2, text: string, size: number, layer: string, fill = '#14161a', rot = 0): void => {
    // 重なりを避けて dir 方向へずらしながら配置
    for (let k = 0; k < 6; k++) {
      const p = { x: base.x + dir.x * k * size * 1.2, y: base.y + dir.y * k * size * 1.2 };
      const b = textBox(p, text, size, 'middle');
      if (!occupied.some((q) => overlaps(q, b)) || k === 5) {
        occupied.push(b);
        prims.push({ t: 'text', p, text, size, fill, anchor: 'middle', rot, halo: true, layer });
        return;
      }
    }
  };

  if (site && site.length >= 3) {
    const sp = site.map(flip);
    const ccw = isCCW(site);
    // 前面道路
    for (const r of doc.roads) {
      const n = site.length;
      if (r.edgeIndex < 0 || r.edgeIndex >= n) continue;
      const a = site[r.edgeIndex];
      const b = site[(r.edgeIndex + 1) % n];
      const L = dist(a, b) || 1;
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const out = ccw ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
      const ext = Math.min(L * 0.15, 3);
      const q = [
        { x: a.x - t.x * ext, y: a.y - t.y * ext },
        { x: b.x + t.x * ext, y: b.y + t.y * ext },
        { x: b.x + t.x * ext + out.x * r.width, y: b.y + t.y * ext + out.y * r.width },
        { x: a.x - t.x * ext + out.x * r.width, y: a.y - t.y * ext + out.y * r.width },
      ];
      prims.push({ t: 'poly', pts: q.map(flip), fill: o.seeThrough ? 'none' : cad ? '#ffffff' : '#e9ebee', stroke: '#8a8f96', sw: lw * 0.6, dash: cad ? [lw * 6, lw * 3] : undefined, layer: 'road' });
      const mid = { x: (a.x + b.x) / 2 + out.x * r.width * 0.72, y: (a.y + b.y) / 2 + out.y * r.width * 0.72 };
      const ang = (-Math.atan2(t.y, t.x) * 180) / Math.PI;
      const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
      prims.push({ t: 'text', p: flip(mid), text: `${r.name}（幅員 ${fmt(r.width)}・接道 ${fmt(L)}）`, size: 11 * u, fill: '#45494f', anchor: 'middle', rot, layer: 'road' });
    }

    // 敷地
    if (o.preview) {
      // 仮の形：破線の輪郭（確定した図面と見分けられるように）
      prims.push({ t: 'poly', pts: sp, fill: o.seeThrough ? 'none' : '#fff8ec', stroke: '#b45309', sw: lw * 1.8, dash: [lw * 7, lw * 4], layer: 'site', id: 'site' });
    } else prims.push({ t: 'poly', pts: sp, fill: o.seeThrough ? 'none' : cad ? '#ffffff' : '#f3f6f4', stroke: '#14161a', sw: lw * (cad ? 1.6 : 2.2), layer: 'site', id: 'site' });

    // 通路
    if (d.showAisles || !cad) {
      for (const a of doc.aisles) {
        const c = rectCorners(a).map(flip);
        const fill = a.kind === 'pedestrian' ? '#fff4d6' : cad ? 'none' : '#dfe6ea';
        prims.push({ t: 'poly', pts: c, fill, stroke: cad ? '#8a8f96' : '#b7c2c9', sw: lw * 0.6, dash: cad ? [lw * 4, lw * 2] : undefined, layer: 'aisle', id: a.id, op: 1 });
        if (!cad || a.kind === 'oneway') {
          // 進行方向矢印
          const th = (a.angle * Math.PI) / 180;
          const dir = { x: Math.cos(th) * a.direction, y: Math.sin(th) * a.direction };
          const len = Math.min(a.w * 0.25, 4);
          const count = a.kind === 'oneway' ? Math.max(1, Math.floor(a.w / 12)) : 1;
          for (let k = 0; k < count; k++) {
            const off = (k + 0.5) / count - 0.5;
            const cx = a.cx + Math.cos(th) * a.w * off;
            const cy = a.cy + Math.sin(th) * a.w * off;
            const tail = { x: cx - dir.x * len / 2, y: cy - dir.y * len / 2 };
            const head = { x: cx + dir.x * len / 2, y: cy + dir.y * len / 2 };
            const nrm = { x: -dir.y, y: dir.x };
            const hs = Math.min(1, len * 0.3);
            prims.push({ t: 'line', a: flip(tail), b: flip(head), stroke: '#ffffff', sw: lw * 3, layer: 'flow' });
            prims.push({ t: 'line', a: flip(tail), b: flip(head), stroke: '#0b5d63', sw: lw * 1.6, layer: 'flow' });
            prims.push({
              t: 'poly',
              pts: [head, { x: head.x - dir.x * hs + nrm.x * hs * 0.6, y: head.y - dir.y * hs + nrm.y * hs * 0.6 }, { x: head.x - dir.x * hs - nrm.x * hs * 0.6, y: head.y - dir.y * hs - nrm.y * hs * 0.6 }].map(flip),
              fill: '#0b5d63',
              stroke: '#0b5d63',
              sw: lw * 0.5,
              layer: 'flow',
            });
            if (a.kind === 'twoway') {
              const t2 = { x: tail.x + nrm.x * 1.2, y: tail.y + nrm.y * 1.2 };
              const h2 = { x: head.x + nrm.x * 1.2, y: head.y + nrm.y * 1.2 };
              prims.push({ t: 'line', a: flip(h2), b: flip(t2), stroke: '#0b5d63', sw: lw * 1.6, layer: 'flow' });
              prims.push({ t: 'poly', pts: [t2, { x: t2.x + dir.x * hs + nrm.x * hs * 0.6, y: t2.y + dir.y * hs + nrm.y * hs * 0.6 }, { x: t2.x + dir.x * hs - nrm.x * hs * 0.6, y: t2.y + dir.y * hs - nrm.y * hs * 0.6 }].map(flip), fill: '#0b5d63', stroke: '#0b5d63', sw: lw * 0.5, layer: 'flow' });
            }
          }
        }
      }
    }

    // 障害物
    for (const ob of doc.obstacles) {
      const st = OBSTACLE_STYLE[ob.kind] ?? OBSTACLE_STYLE.structure;
      const c = rectCorners(ob).map(flip);
      const sel = o.highlight?.has(ob.id);
      if (ob.kind === 'pole' || ob.kind === 'tree') {
        prims.push({ t: 'circle', c: flip({ x: ob.cx, y: ob.cy }), r: Math.max(ob.w, ob.h) / 2, fill: cad ? 'none' : st.fill, stroke: sel ? '#e4002b' : st.stroke, sw: lw * (sel ? 2 : 1), layer: 'obstacle', id: ob.id });
      } else {
        prims.push({ t: 'poly', pts: c, fill: cad ? (ob.kind === 'noParking' || ob.kind === 'setback' ? '#fdeeee' : '#f4f4f4') : st.fill, stroke: sel ? '#e4002b' : st.stroke, sw: lw * (sel ? 2 : 1), dash: ob.kind === 'setback' || ob.kind === 'noParking' ? [lw * 4, lw * 2] : undefined, layer: 'obstacle', id: ob.id });
      }
      prims.push({ t: 'text', p: flip({ x: ob.cx, y: ob.cy }), text: ob.label || st.name, size: 10 * u, fill: '#333', anchor: 'middle', halo: true, layer: 'obstacle' });
    }

    // 設備要素
    for (const el of doc.elements) {
      const c = rectCorners(el).map(flip);
      if (el.kind === 'turningSpace') {
        prims.push({ t: 'circle', c: flip({ x: el.cx, y: el.cy }), r: el.w / 2, fill: 'none', stroke: '#1f5fbf', sw: lw, layer: 'element', id: el.id });
      } else if (el.kind === 'arrow') {
        const th = (el.angle * Math.PI) / 180;
        const dir = { x: Math.cos(th), y: Math.sin(th) };
        const tail = { x: el.cx - dir.x * el.w / 2, y: el.cy - dir.y * el.w / 2 };
        const head = { x: el.cx + dir.x * el.w / 2, y: el.cy + dir.y * el.w / 2 };
        const nrm = { x: -dir.y, y: dir.x };
        const hs = Math.min(1.2, el.w * 0.3);
        prims.push({ t: 'line', a: flip(tail), b: flip(head), stroke: '#e4002b', sw: lw * 2, layer: 'element' });
        prims.push({ t: 'poly', pts: [head, { x: head.x - dir.x * hs + nrm.x * hs * 0.6, y: head.y - dir.y * hs + nrm.y * hs * 0.6 }, { x: head.x - dir.x * hs - nrm.x * hs * 0.6, y: head.y - dir.y * hs - nrm.y * hs * 0.6 }].map(flip), fill: '#e4002b', stroke: '#e4002b', sw: lw * 0.5, layer: 'element', id: el.id });
      } else {
        const fill = el.kind === 'wheelStop' ? '#f2c14e' : el.kind === 'gate' ? '#8a8f96' : el.kind === 'pedestrianPath' ? '#fff4d6' : '#ddd';
        prims.push({ t: 'poly', pts: c, fill, stroke: '#45494f', sw: lw * 0.8, layer: 'element', id: el.id });
      }
      const nm = ELEMENT_NAMES[el.kind];
      if (nm && el.kind !== 'wheelStop' && el.kind !== 'arrow') prims.push({ t: 'text', p: flip({ x: el.cx, y: el.cy }), text: nm, size: 9 * u, fill: '#333', anchor: 'middle', halo: true, layer: 'element' });
    }

    // 駐車枠
    const typeMap = new Map(doc.stallTypes.map((t) => [t.id, t]));
    doc.stalls.forEach((s, i) => {
      const c = stallCorners(s).map(flip);
      const tp = typeMap.get(s.typeId);
      const color = tp?.color ?? '#0b5d63';
      const sel = o.highlight?.has(s.id);
      const bad = o.problems?.has(s.id);
      prims.push({
        t: 'poly',
        pts: c,
        fill: cad ? (bad ? '#fde8e8' : 'none') : bad ? '#f8c9c9' : color,
        op: cad ? 1 : 0.22,
        stroke: bad ? '#e4002b' : sel ? '#e4002b' : cad ? '#14161a' : color,
        sw: lw * (sel ? 2.2 : cad ? 0.8 : 1.2),
        layer: 'stall',
        id: s.id,
      });
      // 車止め（奥側）
      const th = (s.angle * Math.PI) / 180;
      const dv = { x: -Math.sin(th), y: Math.cos(th) };
      const wv = { x: Math.cos(th), y: Math.sin(th) };
      const back = { x: s.cx + dv.x * (s.depth / 2 - 0.7), y: s.cy + dv.y * (s.depth / 2 - 0.7) };
      prims.push({
        t: 'line',
        a: flip({ x: back.x - wv.x * s.width * 0.3, y: back.y - wv.y * s.width * 0.3 }),
        b: flip({ x: back.x + wv.x * s.width * 0.3, y: back.y + wv.y * s.width * 0.3 }),
        stroke: cad ? '#45494f' : '#7a6a2e',
        sw: lw * 1.4,
        layer: 'stall',
      });
      if (d.showStallNumbers || !cad) {
        const label = tp?.category === 'wheelchair' ? `車椅子${i + 1}` : `${i + 1}`;
        const sz = Math.min(10 * u, s.width * 0.45);
        const fp = flip({ x: s.cx, y: s.cy });
        occupied.push(textBox(fp, label, sz, 'middle'));
        prims.push({ t: 'text', p: fp, text: label, size: sz, fill: cad ? '#14161a' : '#0d3b3f', anchor: 'middle', weight: 700, layer: 'stallText' });
      }
    });

    // 出入口
    for (const e of doc.entrances) {
      if (e.edgeIndex >= site.length) continue;
      const g = entranceGeometry(site, e);
      const hw = e.width / 2;
      const a = { x: g.point.x - g.tangent.x * hw, y: g.point.y - g.tangent.y * hw };
      const b = { x: g.point.x + g.tangent.x * hw, y: g.point.y + g.tangent.y * hw };
      prims.push({ t: 'line', a: flip(a), b: flip(b), stroke: '#ffffff', sw: lw * 4, layer: 'entrance' });
      prims.push({ t: 'line', a: flip(a), b: flip(b), stroke: '#e4002b', sw: lw * 2.4, dash: [lw * 3, lw * 2], layer: 'entrance' });
      const inP = { x: g.point.x + g.inward.x * 2.2, y: g.point.y + g.inward.y * 2.2 };
      const outP = { x: g.point.x - g.inward.x * 1.4, y: g.point.y - g.inward.y * 1.4 };
      prims.push({ t: 'line', a: flip(outP), b: flip(inP), stroke: '#e4002b', sw: lw * 1.6, layer: 'entrance' });
      const hs = 0.8;
      const nrm = g.tangent;
      prims.push({ t: 'poly', pts: [inP, { x: inP.x - g.inward.x * hs + nrm.x * hs * 0.6, y: inP.y - g.inward.y * hs + nrm.y * hs * 0.6 }, { x: inP.x - g.inward.x * hs - nrm.x * hs * 0.6, y: inP.y - g.inward.y * hs - nrm.y * hs * 0.6 }].map(flip), fill: '#e4002b', stroke: '#e4002b', sw: lw * 0.4, layer: 'entrance' });
      placeText(flip({ x: g.point.x - g.inward.x * 1.9 + g.tangent.x * (hw + 2.2), y: g.point.y - g.inward.y * 1.9 + g.tangent.y * (hw + 2.2) }), flip({ x: -g.inward.x, y: -g.inward.y }), `出入口 ${fmt(e.width)}`, 10 * u, 'entrance', '#e4002b');
    }

    // ---- 寸法・角度・頂点（精密CAD中心）----
    const n = site.length;
    const cen = centroid(site);
    const pv = o.preview ?? null;
    const tolM = Math.max(doc.land.tolerance, 0.0005);
    const resOf = (kind: ConstraintResidual['kind'], label: string): ConstraintResidual | undefined => pv?.residuals.find((r) => r.kind === kind && r.label === label);
    const bad = (r: ConstraintResidual | undefined): boolean => !!r && (r.kind === 'angle' ? Math.abs(r.error) > 0.01 : Math.abs(r.error) > tolM);
    const RED = '#c8102e';
    const AUTO = '#6b6f76';
    const GUIDE = '#1d4ed8'; // 始点・回る向きの案内（出入口の赤と区別する）
    const bb = bbox(site);
    const ext = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const dimSize = 11 * u;
    if (d.showDimensions || pv) {
      site.forEach((a, i) => {
        const b = site[(i + 1) % n];
        const L = dist(a, b);
        if (L < 1e-9) return;
        const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
        const out = ccw ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
        const off = cad ? Math.max(dimSize * 1.8, ext * 0.035) : dimSize * 1.2;
        const a2 = { x: a.x + out.x * off, y: a.y + out.y * off };
        const b2 = { x: b.x + out.x * off, y: b.y + out.y * off };
        if (cad) {
          prims.push({ t: 'line', a: flip({ x: a.x + out.x * off * 0.15, y: a.y + out.y * off * 0.15 }), b: flip({ x: a.x + out.x * off * 1.15, y: a.y + out.y * off * 1.15 }), stroke: '#6b6f76', sw: lw * 0.5, layer: 'dim' });
          prims.push({ t: 'line', a: flip({ x: b.x + out.x * off * 0.15, y: b.y + out.y * off * 0.15 }), b: flip({ x: b.x + out.x * off * 1.15, y: b.y + out.y * off * 1.15 }), stroke: '#6b6f76', sw: lw * 0.5, layer: 'dim' });
          prims.push({ t: 'line', a: flip(a2), b: flip(b2), stroke: '#0b5d63', sw: lw * 0.7, layer: 'dim' });
          // 端部の斜線（建築寸法線）
          for (const p of [a2, b2]) {
            const k = dimSize * 0.35;
            prims.push({ t: 'line', a: flip({ x: p.x - (t.x + out.x) * k, y: p.y - (t.y + out.y) * k }), b: flip({ x: p.x + (t.x + out.x) * k, y: p.y + (t.y + out.y) * k }), stroke: '#0b5d63', sw: lw * 1, layer: 'dim' });
          }
        }
        const mid = { x: (a2.x + b2.x) / 2 + out.x * dimSize * 0.55, y: (a2.y + b2.y) / 2 + out.y * dimSize * 0.55 };
        const ang = (-Math.atan2(t.y, t.x) * 180) / Math.PI;
        const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
        const name = `${vertexName(i)}${vertexName((i + 1) % n)}`;
        const sr = pv ? resOf('side', name) : undefined;
        const isBad = bad(sr);
        const isAuto = !!pv && pv.autoSides.includes(i);
        const label = isBad ? `${name} 図${fmt(L)}／入力${fmt(sr!.target)}` : isAuto ? `${name} ${fmt(L)}（自動）` : `${name} ${fmt(L)}`;
        if (isBad) prims.push({ t: 'line', a: flip(a), b: flip(b), stroke: RED, sw: lw * 3.2, layer: 'mismatch' });
        // 他の文字と重なる場合は外側へずらす
        let fp = flip(mid);
        for (let k = 0; k < 5; k++) {
          const b = textBox(fp, label, dimSize, 'middle');
          if (!occupied.some((q) => overlaps(q, b))) break;
          fp = flip({ x: mid.x + out.x * dimSize * 1.3 * (k + 1), y: mid.y + out.y * dimSize * 1.3 * (k + 1) });
        }
        occupied.push(textBox(fp, label, dimSize, 'middle'));
        prims.push({ t: 'text', p: fp, text: label, size: dimSize, fill: isBad ? RED : isAuto ? AUTO : '#0b5d63', anchor: 'middle', rot, halo: true, weight: isBad ? 700 : 600, layer: 'dim' });
      });
    }
    if ((cad && d.showDiagonals) || pv) {
      for (const dg of doc.land.diagonals) {
        if (dg.a >= n || dg.b >= n) continue;
        const a = site[dg.a];
        const b = site[dg.b];
        const name = `${vertexName(dg.a)}${vertexName(dg.b)}`;
        const r = pv ? resOf('diagonal', name) : undefined;
        const isBad = bad(r);
        const col = isBad ? RED : '#7a5c12';
        prims.push({ t: 'line', a: flip(a), b: flip(b), stroke: col, sw: lw * (isBad ? 2 : 0.7), dash: [lw * 5, lw * 3], layer: 'diag' });
        const L = dist(a, b);
        if (L < 1e-9) continue;
        const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
        const ang = (-Math.atan2(t.y, t.x) * 180) / Math.PI;
        const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
        placeText(flip({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), flip(t), isBad ? `${name} 図${fmt(L)}／入力${fmt(r!.target)}` : `${name} ${fmt(L)}`, dimSize * 0.95, 'diag', col, rot);
      }
    }
    if ((cad && d.showAngles) || pv) {
      const angs = interiorAngles(site);
      site.forEach((p, i) => {
        const dir = { x: cen.x - p.x, y: cen.y - p.y };
        const l = Math.hypot(dir.x, dir.y) || 1;
        const q = { x: p.x + (dir.x / l) * dimSize * 2.6, y: p.y + (dir.y / l) * dimSize * 2.6 };
        const r = pv ? resOf('angle', vertexName(i)) : undefined;
        const isBad = bad(r);
        const isAuto = !!pv && pv.autoAngles.includes(i);
        const text = isBad ? `図${formatDMS(angs[i])}／入力${formatDMS(r!.target)}` : isAuto ? `${formatDMS(angs[i])}（自動）` : formatDMS(angs[i]);
        placeText(flip(q), flip({ x: dir.x / l, y: dir.y / l }), text, dimSize * 0.85, 'angle', isBad ? RED : isAuto ? AUTO : '#5a4a72');
      });
    }
    if (d.showVertexNames || cad || pv || o.guide) {
      site.forEach((p, i) => {
        const dir = { x: p.x - cen.x, y: p.y - cen.y };
        const l = Math.hypot(dir.x, dir.y) || 1;
        const q = { x: p.x + (dir.x / l) * dimSize * 1.3, y: p.y + (dir.y / l) * dimSize * 1.3 };
        prims.push({ t: 'circle', c: flip(p), r: 2.2 * u, fill: '#14161a', stroke: '#14161a', sw: 0, layer: 'vertex' });
        const base = i === 0 && o.guide ? 'A（始点）' : vertexName(i);
        const label = d.showCoords && cad ? `${base} (${p.x.toFixed(d.decimals)}, ${p.y.toFixed(d.decimals)})` : base;
        placeText(flip(q), flip({ x: dir.x / l, y: dir.y / l }), label, dimSize * (i === 0 && o.guide ? 1.2 : 1.05), 'vertex', i === 0 && o.guide ? GUIDE : '#14161a');
      });
    }
    if (o.guide) {
      // 始点Aと回る向き（A→B→C…）。各辺の中央に進行方向の矢印、辺ABは赤で強調
      const arrow = (a: Vec2, b: Vec2, at: number, size: number, fill: string): void => {
        const L = dist(a, b);
        if (L < 1e-9) return;
        const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
        const nrm = { x: -t.y, y: t.x };
        const c = { x: a.x + t.x * L * at, y: a.y + t.y * L * at };
        const tip = { x: c.x + t.x * size, y: c.y + t.y * size };
        const l1 = { x: c.x - t.x * size * 0.6 + nrm.x * size * 0.75, y: c.y - t.y * size * 0.6 + nrm.y * size * 0.75 };
        const l2 = { x: c.x - t.x * size * 0.6 - nrm.x * size * 0.75, y: c.y - t.y * size * 0.6 - nrm.y * size * 0.75 };
        prims.push({ t: 'poly', pts: [tip, l1, l2].map(flip), fill, stroke: 'none', sw: 0, layer: 'guide' });
      };
      site.forEach((a, i) => {
        if (i === 0) return;
        arrow(a, site[(i + 1) % n], 0.5, 5 * u, '#8a8f96');
      });
      const A = site[0];
      const B = site[1 % n];
      const LAB = dist(A, B);
      if (LAB > 1e-9) {
        const t = { x: (B.x - A.x) / LAB, y: (B.y - A.y) / LAB };
        const s0 = { x: A.x + t.x * Math.min(LAB * 0.12, 14 * u), y: A.y + t.y * Math.min(LAB * 0.12, 14 * u) };
        const s1 = { x: A.x + t.x * LAB * 0.5, y: A.y + t.y * LAB * 0.5 };
        prims.push({ t: 'line', a: flip(s0), b: flip(s1), stroke: GUIDE, sw: lw * 2.4, layer: 'guide' });
        arrow(A, B, 0.5, 8 * u, GUIDE);
      }
      prims.push({ t: 'circle', c: flip(A), r: 5.5 * u, fill: GUIDE, stroke: '#ffffff', sw: lw * 1.2, layer: 'guide' });
      const f = o.guide.focus;
      if (f) {
        const HL = 'rgba(0, 140, 150, 0.38)';
        if (f.kind === 'side' && f.index < n) prims.push({ t: 'line', a: flip(site[f.index]), b: flip(site[(f.index + 1) % n]), stroke: HL, sw: 12 * u, layer: 'focus' });
        else if (f.kind === 'diagonal' && f.a < n && f.b < n) prims.push({ t: 'line', a: flip(site[f.a]), b: flip(site[f.b]), stroke: HL, sw: 10 * u, layer: 'focus' });
        else if ((f.kind === 'angle' || f.kind === 'vertex') && f.index < n) prims.push({ t: 'circle', c: flip(site[f.index]), r: 16 * u, fill: HL, stroke: 'none', sw: 0, layer: 'focus' });
      }
    }
    // 基準点（精密CAD：頂点A）
    if (cad) {
      const a = flip(site[0]);
      prims.push({ t: 'circle', c: a, r: 4 * u, fill: 'none', stroke: '#e4002b', sw: lw * 0.8, layer: 'ref' });
      prims.push({ t: 'line', a: { x: a.x - 6 * u, y: a.y }, b: { x: a.x + 6 * u, y: a.y }, stroke: '#e4002b', sw: lw * 0.6, layer: 'ref' });
      prims.push({ t: 'line', a: { x: a.x, y: a.y - 6 * u }, b: { x: a.x, y: a.y + 6 * u }, stroke: '#e4002b', sw: lw * 0.6, layer: 'ref' });
    }
  }
  return prims;
}

/** 図面の表示範囲（表示空間, m） */
export function modelExtent(doc: ProjectDoc, site: Vec2[] | null): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts: Vec2[] = [];
  if (site) pts.push(...site);
  doc.stalls.forEach((s) => pts.push(...stallCorners(s)));
  doc.obstacles.forEach((o) => pts.push(...rectCorners(o)));
  if (site) {
    for (const r of doc.roads) {
      if (r.edgeIndex >= site.length) continue;
      const a = site[r.edgeIndex];
      const b = site[(r.edgeIndex + 1) % site.length];
      const L = dist(a, b) || 1;
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const out = isCCW(site) ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
      pts.push({ x: a.x + out.x * r.width, y: a.y + out.y * r.width }, { x: b.x + out.x * r.width, y: b.y + out.y * r.width });
    }
  }
  if (!pts.length) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const b = bbox(pts.map(flip));
  return b;
}

export function summaryLines(doc: ProjectDoc, site: Vec2[] | null): { label: string; value: string }[] {
  if (!site) return [];
  const area = Math.abs(site.reduce((s, p, i) => s + p.x * site[(i + 1) % site.length].y - site[(i + 1) % site.length].x * p.y, 0)) / 2;
  const stallArea = doc.stalls.reduce((s, x) => s + x.width * x.depth, 0);
  const aisleArea = doc.aisles.reduce((s, a) => s + a.w * a.h, 0);
  return [
    { label: '敷地面積', value: `${area.toFixed(2)}㎡（${m2ToTsubo(area).toFixed(2)}坪）` },
    { label: '駐車台数', value: `${doc.stalls.length}台` },
    { label: '駐車可能面積', value: `${(stallArea + Math.min(aisleArea, Math.max(0, area - stallArea))).toFixed(2)}㎡` },
  ];
}
