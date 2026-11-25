// 出力サービス（ブラウザ）：PDF はベクターのまま（jsPDF + svg2pdf.js、日本語フォント埋め込み）、PNG/JPEG はラスタライズ
import type { ProjectDoc } from '@/types';
import { buildExportSvg, FONT, PAPER_MM, type ExportOptions } from '@/engine/export/paper';
import { claudeRuntime } from '@/services/storage/cloud';

let fontB64: Promise<string> | null = null;
async function loadFont(): Promise<string> {
  if (!fontB64) {
    fontB64 = (async () => {
      const res = await fetch('./fonts/NotoSansJP-subset.ttf');
      if (!res.ok) throw new Error('日本語フォントを読み込めませんでした');
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH));
      return btoa(bin);
    })();
    fontB64.catch(() => (fontB64 = null));
  }
  return fontB64;
}

export async function exportPdf(doc: ProjectDoc, opt: ExportOptions): Promise<{ blob: Blob; warnings: string[] }> {
  const { svg, warnings } = buildExportSvg(doc, opt);
  const [{ jsPDF }, svg2pdfMod] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const P = PAPER_MM[opt.paper];
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [P.w, P.h], compress: true });
  try {
    const b64 = await loadFont();
    pdf.addFileToVFS('NotoSansJP.ttf', b64);
    for (const style of ['normal', 'bold', 'italic', 'bolditalic']) pdf.addFont('NotoSansJP.ttf', FONT, style);
    pdf.setFont(FONT);
  } catch {
    warnings.push('日本語フォントを埋め込めなかったため、文字が正しく表示されない可能性があります。');
  }
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as unknown as Element;
  // svg2pdf は DOM に挿入された要素で計算するため一時的に配置
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden';
  host.appendChild(el);
  document.body.appendChild(host);
  try {
    const fn = (svg2pdfMod as unknown as { svg2pdf: (e: Element, p: unknown, o: unknown) => Promise<unknown> }).svg2pdf;
    await fn(el, pdf, { x: 0, y: 0, width: P.w, height: P.h });
  } finally {
    host.remove();
  }
  pdf.setProperties({ title: opt.title ?? doc.name, creator: 'LAND DESIGN CAD' });
  return { blob: pdf.output('blob'), warnings };
}

import { setJpegDpi, setPngDpi } from '@/engine/export/dpi';

export async function exportRaster(doc: ProjectDoc, opt: ExportOptions, format: 'png' | 'jpeg', dpi = 200): Promise<{ blob: Blob; warnings: string[] }> {
  const { svg, warnings } = buildExportSvg(doc, opt);
  const P = PAPER_MM[opt.paper];
  const pxW = Math.round((P.w / 25.4) * dpi);
  const pxH = Math.round((P.h / 25.4) * dpi);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('画像の生成に失敗しました'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = pxW;
    c.height = pxH;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas を利用できません');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(img, 0, 0, pxW, pxH);
    const raw = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の生成に失敗しました'))), format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
    c.width = c.height = 0; // iOS のメモリ解放
    // 解像度を書き込み、印刷時に用紙寸法（＝縮尺）どおりになるようにする
    const bytes = new Uint8Array(await raw.arrayBuffer());
    const fixed = format === 'png' ? setPngDpi(bytes, dpi) : setJpegDpi(bytes, dpi);
    const blob = new Blob([fixed], { type: raw.type });
    return { blob, warnings };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 保存：claude.ai 上では downloads 機能、通常ブラウザでは <a download> */
export async function saveFile(filename: string, blob: Blob): Promise<'saved' | 'declined'> {
  const rt = claudeRuntime();
  if (rt) {
    const dl = (await Promise.race([rt.use('downloads'), new Promise((r) => setTimeout(() => r(null), 4000))])) as {
      save: (r: { filename: string; data: Blob }) => Promise<unknown>;
    } | null;
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
        return 'saved';
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'declined') return 'declined';
        throw new Error(`保存できませんでした（${code ?? 'unknown'}）`);
      }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  return 'saved';
}

export const safeFileName = (s: string): string => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'drawing';
