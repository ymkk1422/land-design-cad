// 用紙・縮尺計算と出力用SVG（mm単位・ベクター）生成
import type { DrawingMode, ProjectDoc, Vec2 } from '@/types';
import { buildModel, currentSite, modelExtent, summaryLines, type Prim } from './drawingModel';
import { landMetrics } from '@/engine/area-calculation';
import { vertexName } from '@/engine/geometry/polygon';

export type PaperSize = 'A4' | 'A3' | 'A2';
export const PAPER_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
};
export const STANDARD_SCALES = [50, 100, 200, 250, 500, 1000];
export const MARGIN_MM = 10;
export const TITLE_H_MM = 34;

export interface PaperLayout {
  paper: PaperSize;
  scale: number; // 1/scale
  k: number; // mm per m（表示空間）
  ox: number;
  oy: number;
  area: { x: number; y: number; w: number; h: number };
  fits: boolean;
  drawingMm: { w: number; h: number };
}

export function drawingArea(paper: PaperSize): { x: number; y: number; w: number; h: number } {
  const p = PAPER_MM[paper];
  return { x: MARGIN_MM, y: MARGIN_MM, w: p.w - 2 * MARGIN_MM, h: p.h - 2 * MARGIN_MM - TITLE_H_MM };
}

/** 縮尺 1/scale のときのレイアウト。fits=false は用紙からはみ出す */
export function layoutOnPaper(ext: { minX: number; minY: number; maxX: number; maxY: number }, paper: PaperSize, scale: number, padM = 3): PaperLayout {
  const area = drawingArea(paper);
  const k = 1000 / scale;
  const w = (ext.maxX - ext.minX + 2 * padM) * k;
  const h = (ext.maxY - ext.minY + 2 * padM) * k;
  const ox = area.x + (area.w - w) / 2 - (ext.minX - padM) * k;
  const oy = area.y + (area.h - h) / 2 - (ext.minY - padM) * k;
  return { paper, scale, k, ox, oy, area, fits: w <= area.w + 1e-9 && h <= area.h + 1e-9, drawingMm: { w, h } };
}

/** 用紙に収まる最小の標準縮尺 */
export function autoScale(ext: { minX: number; minY: number; maxX: number; maxY: number }, paper: PaperSize): number {
  for (const s of STANDARD_SCALES) if (layoutOnPaper(ext, paper, s).fits) return s;
  const area = drawingArea(paper);
  const need = Math.max(((ext.maxX - ext.minX + 6) * 1000) / area.w, ((ext.maxY - ext.minY + 6) * 1000) / area.h);
  return Math.ceil(need / 100) * 100;
}

export const toPaper = (L: PaperLayout, p: Vec2): Vec2 => ({ x: L.ox + p.x * L.k, y: L.oy + p.y * L.k });

/** 実寸 m の長さが用紙上で何 mm になるか（縮尺検証用） */
export const paperLength = (L: PaperLayout, meters: number): number => meters * L.k;

/** PDF 埋め込みフォント名（exporter で同名登録） */
export const FONT = 'NotoSansJP';
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const f = (v: number): string => (Math.round(v * 1000) / 1000).toString();

export function primsToSvg(prims: Prim[], tf: (p: Vec2) => Vec2, kLen: number): string {
  const out: string[] = [];
  for (const p of prims) {
    if (p.t === 'poly') {
      const pts = p.pts.map(tf).map((q) => `${f(q.x)},${f(q.y)}`).join(' ');
      const dash = p.dash ? ` stroke-dasharray="${p.dash.map((x) => f(x * kLen)).join(' ')}"` : '';
      const fillOp = p.op !== undefined && p.fill !== 'none' ? ` fill-opacity="${p.op}"` : '';
      out.push(`<polygon points="${pts}" fill="${p.fill}"${fillOp} stroke="${p.stroke}" stroke-width="${f(p.sw * kLen)}" stroke-linejoin="round"${dash}/>`);
    } else if (p.t === 'line') {
      const a = tf(p.a);
      const b = tf(p.b);
      const dash = p.dash ? ` stroke-dasharray="${p.dash.map((x) => f(x * kLen)).join(' ')}"` : '';
      out.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${p.stroke}" stroke-width="${f(p.sw * kLen)}" stroke-linecap="round"${dash}/>`);
    } else if (p.t === 'circle') {
      const c = tf(p.c);
      out.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(p.r * kLen)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${f(p.sw * kLen)}"/>`);
    } else {
      const c = tf(p.p);
      const rot = p.rot ? ` transform="rotate(${f(p.rot)} ${f(c.x)} ${f(c.y)})"` : '';
      const weight = (p.weight ?? 400) >= 600 ? 'bold' : 'normal';
      const base = `x="${f(c.x)}" y="${f(c.y)}" font-size="${f(p.size * kLen)}" font-family="${FONT}" font-weight="${weight}" text-anchor="${p.anchor}" dominant-baseline="middle"${rot}`;
      // 縁取り（paint-order 非対応の PDF 変換でも崩れないよう、白縁と本体を別要素で重ねる）
      if (p.halo) out.push(`<text ${base} fill="#ffffff" stroke="#ffffff" stroke-width="${f(p.size * kLen * 0.25)}" stroke-linejoin="round">${esc(p.text)}</text>`);
      out.push(`<text ${base} fill="${p.fill}">${esc(p.text)}</text>`);
    }
  }
  return out.join('');
}

export interface ExportOptions {
  paper: PaperSize;
  scale: number | 'auto';
  mode: DrawingMode;
  title?: string;
  notes?: string;
  date?: Date;
  /** 下絵を重ねて出力（href は data URL） */
  underlay?: { href: string; matrix: [number, number, number, number, number, number]; opacity: number; w: number; h: number };
}

/** 出力用SVG（viewBox=用紙mm）。縮尺バーは既知の基準長で描画し検証可能にする */
export function buildExportSvg(doc: ProjectDoc, opt: ExportOptions): { svg: string; layout: PaperLayout; warnings: string[] } {
  const site = currentSite(doc);
  const warnings: string[] = [];
  const ext = modelExtent(doc, site);
  const scale = opt.scale === 'auto' ? autoScale(ext, opt.paper) : opt.scale;
  const L = layoutOnPaper(ext, opt.paper, scale);
  if (!L.fits) warnings.push(`縮尺1/${scale}では図面が${opt.paper}用紙に収まりません（図面 ${L.drawingMm.w.toFixed(0)}×${L.drawingMm.h.toFixed(0)}mm）。縮尺を小さくするか用紙を大きくしてください。`);
  if (!site) warnings.push('土地形状が確定していないため、敷地は出力されません。');
  const P = PAPER_MM[opt.paper];
  // 文字単位 = 1mm 相当の実寸(m) → 3.0mm 程度の文字に
  const textUnit = (1 / L.k) * 0.27;
  const prims = buildModel({ ...doc, mode: opt.mode }, { mode: opt.mode, textUnit, sitePoints: site, lineUnit: 1 });
  const tf = (p: Vec2): Vec2 => toPaper(L, p);
  let body = primsToSvg(prims, tf, L.k);
  if (opt.underlay) {
    const [a, b, c, d, e, f2] = opt.underlay.matrix;
    const k = L.k;
    const m = [k * a, k * b, k * c, k * d, L.ox + k * e, L.oy + k * f2].map((v) => f(v)).join(' ');
    body = `<image href="${opt.underlay.href.replace(/"/g, '')}" x="0" y="0" width="${opt.underlay.w}" height="${opt.underlay.h}" transform="matrix(${m})" opacity="${opt.underlay.opacity}" preserveAspectRatio="none"/>` + body;
  }
  const area = L.area;

  // 縮尺バー（基準寸法）
  const nice = [1, 2, 5, 10, 20, 50, 100];
  const barM = nice.find((m) => m * L.k >= 30) ?? 100;
  const barMm = paperLength(L, barM);
  const bx = area.x + 4;
  const by = area.y + area.h - 6;
  let bar = `<g id="scale-bar" data-meters="${barM}" data-mm="${f(barMm)}">`;
  for (let i = 0; i < 4; i++) {
    bar += `<rect x="${f(bx + (barMm / 4) * i)}" y="${f(by)}" width="${f(barMm / 4)}" height="1.6" fill="${i % 2 ? '#ffffff' : '#14161a'}" stroke="#14161a" stroke-width="0.2"/>`;
  }
  bar += `<text x="${f(bx)}" y="${f(by - 1.6)}" font-size="2.6" font-family="${FONT}" fill="#14161a">0</text><text x="${f(bx + barMm)}" y="${f(by - 1.6)}" font-size="2.6" text-anchor="middle" font-family="${FONT}" fill="#14161a">${barM}m</text></g>`;

  // 方位マーク
  const nx = area.x + area.w - 12;
  const ny = area.y + 14;
  const rotN = doc.northAngle; // 時計回り（度）
  const north = `<g transform="rotate(${f(rotN)} ${f(nx)} ${f(ny)})"><circle cx="${f(nx)}" cy="${f(ny)}" r="8" fill="#fff" stroke="#14161a" stroke-width="0.35"/><polygon points="${f(nx)},${f(ny - 7)} ${f(nx + 3)},${f(ny + 4)} ${f(nx)},${f(ny + 2)} ${f(nx - 3)},${f(ny + 4)}" fill="#14161a"/><text x="${f(nx)}" y="${f(ny - 9.5)}" font-size="3.4" text-anchor="middle" font-family="${FONT}" font-weight="bold" fill="#14161a">N</text></g>`;

  // 表題欄
  const tY = P.h - MARGIN_MM - TITLE_H_MM;
  const date = (opt.date ?? new Date()).toLocaleDateString('ja-JP');
  const met = site ? landMetrics(site) : null;
  const sides = site ? met!.sides.map((s, i) => `${vertexName(i)}${vertexName((i + 1) % site.length)}=${s.toFixed(2)}m`).join('  ') : '';
  const lines = summaryLines(doc, site);
  const modeName = opt.mode === 'cad' ? '精密CAD図' : '営業提案図';
  const colW = (P.w - 2 * MARGIN_MM) / 4;
  const cell = (x: number, y: number, label: string, value: string, w = colW): string =>
    `<text x="${f(x + 2)}" y="${f(y + 4)}" font-size="2.4" fill="#6b6f76" font-family="${FONT}">${esc(label)}</text><text x="${f(x + 2)}" y="${f(y + 10)}" font-size="${value.length * 2.2 > w ? Math.max(2.2, (w - 4) / value.length / 0.62).toFixed(2) : '3.8'}" font-family="${FONT}" font-weight="bold" fill="#14161a">${esc(value)}</text>`;
  const title = opt.title ?? doc.name;
  let tb = `<g id="title-block"><rect x="${MARGIN_MM}" y="${f(tY)}" width="${P.w - 2 * MARGIN_MM}" height="${TITLE_H_MM}" fill="#fff" stroke="#14161a" stroke-width="0.4"/>`;
  tb += `<line x1="${MARGIN_MM}" y1="${f(tY + 14)}" x2="${P.w - MARGIN_MM}" y2="${f(tY + 14)}" stroke="#14161a" stroke-width="0.2"/>`;
  for (let i = 1; i < 4; i++) tb += `<line x1="${f(MARGIN_MM + colW * i)}" y1="${f(tY)}" x2="${f(MARGIN_MM + colW * i)}" y2="${f(tY + 14)}" stroke="#14161a" stroke-width="0.2"/>`;
  tb += cell(MARGIN_MM, tY, '図面名', `${title}（${modeName}）`);
  tb += cell(MARGIN_MM + colW, tY, '作成日 / 縮尺 / 用紙', `${date}  1/${scale}  ${opt.paper}`);
  tb += cell(MARGIN_MM + colW * 2, tY, lines[0]?.label ?? '敷地面積', lines[0]?.value ?? '—');
  tb += cell(MARGIN_MM + colW * 3, tY, '駐車台数 / 外周', `${doc.stalls.length}台  /  ${met ? met.perimeter.toFixed(2) + 'm' : '—'}`);
  const noteText = `各辺：${sides}`;
  tb += `<text x="${MARGIN_MM + 2}" y="${f(tY + 19)}" font-size="2.5" font-family="${FONT}" fill="#14161a">${esc(noteText.slice(0, 220))}</text>`;
  const note2 = `注記：${opt.notes || doc.notes || '寸法は入力値に基づく計算値です。駐車台数は探索アルゴリズムによる配置案であり、法令・条例・現地条件の確認が必要です。'}`;
  tb += `<text x="${MARGIN_MM + 2}" y="${f(tY + 25)}" font-size="2.5" font-family="${FONT}" fill="#14161a">${esc(note2.slice(0, 200))}</text>`;
  tb += `<text x="${MARGIN_MM + 2}" y="${f(tY + 31)}" font-size="2.3" font-family="${FONT}" fill="#6b6f76">印刷時は「実際のサイズ（100%）」を選んでください（「用紙に合わせる」では縮尺が変わります）。縮尺バーで確認できます。</text>`;
  tb += `<text x="${P.w - MARGIN_MM - 2}" y="${f(tY + 31)}" font-size="2.3" text-anchor="end" font-family="${FONT}" fill="#6b6f76">LAND DESIGN CAD</text></g>`;

  const clipId = 'drawclip';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${P.w}mm" height="${P.h}mm" viewBox="0 0 ${P.w} ${P.h}"><rect width="${P.w}" height="${P.h}" fill="#ffffff"/><defs><clipPath id="${clipId}"><rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}"/></clipPath></defs><rect x="${MARGIN_MM / 2}" y="${MARGIN_MM / 2}" width="${P.w - MARGIN_MM}" height="${P.h - MARGIN_MM}" fill="none" stroke="#14161a" stroke-width="0.5"/><g clip-path="url(#${clipId})">${body}</g>${bar}${north}${tb}</svg>`;
  return { svg, layout: L, warnings };
}
