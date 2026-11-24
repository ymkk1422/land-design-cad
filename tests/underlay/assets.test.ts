import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalAdapter } from '@/services/storage';
import { IdbAssetStore, sniffType, base64ToBlob, blobToBase64 } from '@/services/storage/assets';
import { createProject } from '@/services/projectFactory';
import { newUnderlay } from '@/engine/underlay/transform';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  dump(): string { return [...this.m.values()].join('\n'); }
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakePng = (n: number): Blob => new Blob([new Uint8Array([...PNG_HEAD, ...Array.from({ length: n }, (_, i) => i % 251)])], { type: 'image/png' });

describe('下絵アセットの保存（図面データと分離）', () => {
  let ls: MemStorage;
  beforeEach(() => {
    ls = new MemStorage();
    (globalThis as unknown as { window: unknown }).window = { localStorage: ls };
  });

  it('元画像は IndexedDB、図面データは localStorage に別々に保存される', async () => {
    const st = new LocalAdapter();
    const img = fakePng(200_000);
    await st.saveAsset('as_orig', img);
    const doc = createProject('下絵テスト');
    doc.underlay = newUnderlay({ originalAssetId: 'as_orig', displayAssetId: 'as_orig', fileName: '測量図.png', source: 'image/png', pxWidth: 2000, pxHeight: 1500, rasterScale: 1 });
    doc.assetIds = ['as_orig'];
    await st.save(doc, { snapshot: true });
    // 図面データには画像本体が含まれない（ID のみ）
    const stored = ls.getItem(`ldc:p:${doc.id}`)!;
    expect(stored).toContain('as_orig');
    expect(stored.length).toBeLessThan(20_000);
    expect(ls.dump().length).toBeLessThan(60_000);
    // 再読込：図面と画像をそれぞれ復元
    const back = await st.load(doc.id);
    expect(back.underlay?.originalAssetId).toBe('as_orig');
    const blob = await st.loadAsset('as_orig');
    expect(blob.size).toBe(img.size);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await img.arrayBuffer()));
  });

  it('図面を削除すると参照していたアセットも削除される', async () => {
    const st = new LocalAdapter();
    await st.saveAsset('as_a', fakePng(10));
    await st.saveAsset('as_b', fakePng(10));
    const doc = createProject('削除');
    doc.assetIds = ['as_a', 'as_b'];
    await st.save(doc);
    await st.remove(doc.id);
    await expect(st.loadAsset('as_a')).rejects.toThrow();
    await expect(st.loadAsset('as_b')).rejects.toThrow();
  });

  it('上限サイズ超過は拒否、ファイル種類は中身で判定', async () => {
    const s = new IdbAssetStore();
    await expect(s.put('big', new Blob([new Uint8Array(31 * 1024 * 1024)]))).rejects.toThrow('大きすぎ');
    expect(await sniffType(fakePng(4))).toBe('image/png');
    expect(await sniffType(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]))).toBe('image/jpeg');
    expect(await sniffType(new Blob(['%PDF-1.7']))).toBe('application/pdf');
    expect(await sniffType(new Blob(['<svg onload=alert(1)>']))).toBeNull();
  });

  it('クラウド保存用の base64 分割・復元が可逆', async () => {
    const b = fakePng(500_000);
    const s = await blobToBase64(b);
    const back = base64ToBlob(s, 'image/png');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array(await b.arrayBuffer()));
  });
});
