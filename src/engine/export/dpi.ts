// 画像ファイルに解像度（DPI）を書き込む。
// Canvas の toBlob は解像度情報を持たない（多くのソフトが 72/96dpi と解釈し、印刷寸法＝縮尺が狂う）ため、
// PNG には pHYs チャンク、JPEG には JFIF の密度を設定する。

let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG に pHYs（1メートルあたりの画素数）を設定。既存の pHYs は置き換える */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('PNG ではありません');
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // 単位：メートル
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // 既存チャンクを走査（IHDR の直後に挿入、既存 pHYs は除去）
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let i = 8;
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let inserted = false;
  while (i + 12 <= png.length) {
    const len = src.getUint32(i);
    const type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]);
    const end = i + 12 + len;
    if (end > png.length) throw new Error('PNG が壊れています');
    if (type !== 'pHYs') parts.push(png.subarray(i, end));
    if (type === 'IHDR' && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    i = end;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PNG の pHYs から DPI を読む（無ければ null） */
export function readPngDpi(png: Uint8Array): number | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let i = 8;
  while (i + 12 <= png.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]);
    if (type === 'pHYs' && png[i + 16] === 1) return dv.getUint32(i + 8) * 0.0254;
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}

/** JPEG の JFIF(APP0) に密度（dpi）を設定。APP0 が無ければ SOI の直後に追加 */
export function setJpegDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('JPEG ではありません');
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  const isJfif = jpg[2] === 0xff && jpg[3] === 0xe0 && jpg[6] === 0x4a && jpg[7] === 0x46 && jpg[8] === 0x49 && jpg[9] === 0x46 && jpg[10] === 0;
  if (isJfif) {
    const out = jpg.slice();
    out[13] = 1; // 単位：dpi
    out[14] = d >> 8;
    out[15] = d & 0xff;
    out[16] = d >> 8;
    out[17] = d & 0xff;
    return out;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, d >> 8, d & 0xff, d >> 8, d & 0xff, 0x00, 0x00]);
  const out = new Uint8Array(jpg.length + app0.length);
  out.set(jpg.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(jpg.subarray(2), 2 + app0.length);
  return out;
}

export function readJpegDpi(jpg: Uint8Array): number | null {
  if (jpg[2] === 0xff && jpg[3] === 0xe0 && jpg[6] === 0x4a && jpg[13] === 1) {
    const x = (jpg[14] << 8) | jpg[15];
    return x || null;
  }
  return null;
}
