// 測量図（PDF・PNG・JPEG）の取込。元ファイルはそのまま保存し、表示用のラスタ画像を別に作る。
import type { UnderlayMeta } from '@/types';
import type { StorageAdapter } from '@/services/storage';
import { MAX_ASSET_BYTES, sniffType } from '@/services/storage/assets';
import { newUnderlay } from '@/engine/underlay/transform';
import { newId } from '@/engine/parking-optimizer/stallOps';

/** iOS Safari のキャンバス上限（約1,670万画素・一辺4096px程度）を超えない表示用サイズ */
const MAX_SIDE = 4096;
const MAX_PIXELS = 14_000_000;

function fitSize(w: number, h: number): { w: number; h: number; k: number } {
  let k = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (w * k * h * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}

function canvasToBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の生成に失敗しました'))), type, q));
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('画像を読み込めませんでした（破損または未対応の形式）'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ---- PDF ----
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> };
type PdfPage = { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; background?: string }): { promise: Promise<void> } };

async function openPdf(blob: Blob): Promise<PdfDoc> {
  // pdf.js は PDF を読み込むときだけ別ファイルから読み込む（通常起動を軽くするため）
  const libUrl = new URL('./pdf.min.js', document.baseURI).href;
  const pdfjs = (await import(/* webpackIgnore: true */ libUrl)) as unknown as {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(o: object): { promise: Promise<PdfDoc> };
  };
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js', document.baseURI).href;
  const data = new Uint8Array(await blob.arrayBuffer());
  // セキュリティ：PDF内スクリプト・eval を無効化
  return pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, disableFontFace: false, useSystemFonts: true }).promise;
}

/** PDF の指定ページを表示用 PNG に描画。用紙寸法(mm)も返す */
export async function renderPdfPage(blob: Blob, pageNo: number): Promise<{ png: Blob; w: number; h: number; pages: number; paperMm: { w: number; h: number } }> {
  const doc = await openPdf(blob);
  try {
    const n = Math.min(Math.max(1, pageNo), doc.numPages);
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 }); // 1単位 = 1/72 inch
    const paperMm = { w: (vp1.width * 25.4) / 72, h: (vp1.height * 25.4) / 72 };
    // 線が読める解像度（約300dpi相当、上限あり）
    const target = fitSize(vp1.width * (300 / 72), vp1.height * (300 / 72));
    const scale = target.w / vp1.width;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas を利用できません');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
    const png = await canvasToBlob(c, 'image/png');
    c.width = c.height = 0; // iOS のメモリ解放
    return { png, w: Math.round(vp.width), h: Math.round(vp.height), pages: doc.numPages, paperMm };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

export interface ImportResult {
  meta: UnderlayMeta;
  newAssetIds: string[];
}

/**
 * ファイルを取り込み、元ファイルと表示用画像をそれぞれアセットとして保存する。
 * 図面（CAD）データには ID と縮尺などのメタデータだけを持たせる。
 */
export async function importUnderlayFile(file: File | Blob, fileName: string, storage: StorageAdapter, onStage?: (s: string) => void): Promise<ImportResult> {
  if (file.size > MAX_ASSET_BYTES) throw new Error(`ファイルが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB、上限30MB）`);
  if (file.size === 0) throw new Error('空のファイルです');
  const type = await sniffType(file);
  if (!type) throw new Error('PDF・PNG・JPEG のいずれかを選んでください（ファイルの中身を確認できませんでした）');
  const originalAssetId = newId('as');
  const original = new Blob([await file.arrayBuffer()], { type });
  onStage?.('元ファイルを保存中…');
  await storage.saveAsset(originalAssetId, original);

  if (type === 'application/pdf') {
    onStage?.('PDFを描画中…');
    const r = await renderPdfPage(original, 1);
    const displayAssetId = newId('as');
    await storage.saveAsset(displayAssetId, r.png);
    return {
      meta: newUnderlay({ originalAssetId, displayAssetId, fileName, source: type, pxWidth: r.w, pxHeight: r.h, rasterScale: 1, pdfPage: 1, pdfPageCount: r.pages, paperMm: r.paperMm }),
      newAssetIds: [originalAssetId, displayAssetId],
    };
  }

  onStage?.('画像を読み込み中…');
  const img = await loadImage(original);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H) throw new Error('画像の大きさを取得できませんでした');
  const fit = fitSize(W, H);
  if (fit.k >= 1) {
    // そのまま表示できる大きさ：表示用も元ファイルを共有
    return { meta: newUnderlay({ originalAssetId, displayAssetId: originalAssetId, fileName, source: type, pxWidth: W, pxHeight: H, rasterScale: 1 }), newAssetIds: [originalAssetId] };
  }
  onStage?.('表示用に縮小中…');
  const c = document.createElement('canvas');
  c.width = fit.w;
  c.height = fit.h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, fit.w, fit.h);
  const disp = await canvasToBlob(c, type, type === 'image/jpeg' ? 0.92 : undefined);
  c.width = c.height = 0;
  const displayAssetId = newId('as');
  await storage.saveAsset(displayAssetId, disp);
  return { meta: newUnderlay({ originalAssetId, displayAssetId, fileName, source: type, pxWidth: fit.w, pxHeight: fit.h, rasterScale: fit.k }), newAssetIds: [originalAssetId, displayAssetId] };
}

/** PDF の別ページに切り替え（元ファイルから再描画） */
export async function switchPdfPage(meta: UnderlayMeta, page: number, storage: StorageAdapter): Promise<{ patch: Partial<UnderlayMeta>; newAssetId: string }> {
  const original = await storage.loadAsset(meta.originalAssetId);
  const r = await renderPdfPage(original, page);
  const displayAssetId = newId('as');
  await storage.saveAsset(displayAssetId, r.png);
  const k = meta.pxWidth / r.w; // 同じ用紙なら縮尺を維持
  return { patch: { displayAssetId, pdfPage: page, pxWidth: r.w, pxHeight: r.h, paperMm: r.paperMm, scale: meta.scale * k, trace: [], measure: [], calibration: null }, newAssetId: displayAssetId };
}

// ---- 表示用 Object URL キャッシュ ----
const urlCache = new Map<string, Promise<string>>();
export function assetUrl(storage: StorageAdapter, id: string): Promise<string> {
  let p = urlCache.get(id);
  if (!p) {
    p = storage.loadAsset(id).then((b) => URL.createObjectURL(b));
    p.catch(() => urlCache.delete(id));
    urlCache.set(id, p);
  }
  return p;
}

export async function assetDataUrl(storage: StorageAdapter, id: string): Promise<string> {
  const b = await storage.loadAsset(id);
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('画像を読み込めませんでした'));
    r.readAsDataURL(b);
  });
}
