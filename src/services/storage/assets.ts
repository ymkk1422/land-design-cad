// アセット（下絵の元画像・表示用画像）の保存。図面（CAD）データとは別の保存領域に置く。
//  端末内：IndexedDB（localStorage は容量が小さく画像に不向き）
//  ※ Blob ではなく ArrayBuffer＋MIME で保存（実装差・構造化複製の互換性のため）

export interface AssetRecord {
  id: string;
  mime: string;
  size: number;
  data: ArrayBuffer;
  savedAt: string;
}

export interface AssetStore {
  put(id: string, blob: Blob): Promise<void>;
  get(id: string): Promise<Blob>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
}

export const MAX_ASSET_BYTES = 30 * 1024 * 1024;

const DB_NAME = 'ldc-assets';
const STORE = 'assets';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けません'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error ?? new Error('保存に失敗しました'));
    t.onabort = () => reject(t.error ?? new Error('保存が中断されました（容量不足の可能性）'));
  });
}

export class IdbAssetStore implements AssetStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private mem = new Map<string, AssetRecord>();
  private get available(): boolean {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
      return false;
    }
  }
  private db(): Promise<IDBDatabase> {
    if (!this.dbp) this.dbp = openDb();
    return this.dbp;
  }
  async put(id: string, blob: Blob): Promise<void> {
    if (blob.size > MAX_ASSET_BYTES) throw new Error(`ファイルが大きすぎます（上限 ${MAX_ASSET_BYTES / 1024 / 1024}MB）`);
    const rec: AssetRecord = { id, mime: blob.type || 'application/octet-stream', size: blob.size, data: await blob.arrayBuffer(), savedAt: new Date().toISOString() };
    if (!this.available) {
      this.mem.set(id, rec);
      return;
    }
    await tx(await this.db(), 'readwrite', (s) => s.put(rec));
    // 書き込み検証（破損防止）
    const back = await tx<AssetRecord | undefined>(await this.db(), 'readonly', (s) => s.get(id) as IDBRequest<AssetRecord | undefined>);
    if (!back || back.size !== rec.size) throw new Error('画像の保存を検証できませんでした');
  }
  async get(id: string): Promise<Blob> {
    const rec = this.available ? await tx<AssetRecord | undefined>(await this.db(), 'readonly', (s) => s.get(id) as IDBRequest<AssetRecord | undefined>) : this.mem.get(id);
    if (!rec) throw new Error('下絵の画像が見つかりません（別の端末で取り込んだ可能性があります）');
    return new Blob([rec.data], { type: rec.mime });
  }
  async delete(id: string): Promise<void> {
    if (!this.available) {
      this.mem.delete(id);
      return;
    }
    await tx(await this.db(), 'readwrite', (s) => s.delete(id));
  }
  async has(id: string): Promise<boolean> {
    try {
      await this.get(id);
      return true;
    } catch {
      return false;
    }
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(bin);
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}

/** ファイルの先頭バイトで種類を判定（拡張子は信用しない） */
export async function sniffType(blob: Blob): Promise<'application/pdf' | 'image/png' | 'image/jpeg' | null> {
  const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/** 画像として展開してよい最大画素数（展開時のメモリ不足・いわゆる画像爆弾を防ぐ） */
export const MAX_DECODE_PIXELS = 100_000_000;

/**
 * 画像を展開する前に、ファイルのヘッダから縦横の画素数を読む（PNG: IHDR、JPEG: SOFn）。
 * 読めなければ null。
 */
export async function imageHeaderSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 512 * 1024)).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50) {
    if (head.length < 24) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const m = head[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (head[i + 2] << 8) | head[i + 3];
      // SOF0〜SOF15（DHT=C4, JPG=C8, DAC=CC を除く）
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (head[i + 5] << 8) | head[i + 6], w: (head[i + 7] << 8) | head[i + 8] };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}
