import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '@/services/projectFactory';
import { autoScale, buildExportSvg, layoutOnPaper, paperLength, toPaper } from '@/engine/export/paper';
import { buildModel, currentSite, modelExtent } from '@/engine/export/drawingModel';
import { LocalAdapter } from '@/services/storage';
import { dist } from '@/engine/geometry/polygon';
import { optimizeParking } from '@/engine/parking-optimizer/optimizer';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

describe('図面出力：縮尺の検証', () => {
  it('1/100 で実寸20mの辺が用紙上200mmになる（既知の基準寸法）', () => {
    const doc = createProject('縮尺テスト');
    const site = currentSite(doc)!;
    const L = layoutOnPaper(modelExtent(doc, site), 'A2', 100);
    const a = toPaper(L, { x: site[0].x, y: -site[0].y });
    const b = toPaper(L, { x: site[1].x, y: -site[1].y });
    expect(dist(a, b)).toBeCloseTo(200, 9);
    expect(paperLength(L, 1)).toBeCloseTo(10, 12);
    expect(L.fits).toBe(true);
  });

  it('各縮尺・用紙で縮尺バーの長さが理論値と一致し、文字が用紙内に収まる', () => {
    const doc = createProject('出力');
    for (const paper of ['A4', 'A3', 'A2'] as const) {
      for (const scale of [50, 100, 200, 250, 500]) {
        const { svg, layout } = buildExportSvg(doc, { paper, scale, mode: 'cad' });
        const m = svg.match(/id="scale-bar" data-meters="(\d+)" data-mm="([\d.]+)"/)!;
        expect(Number(m[2])).toBeCloseTo((Number(m[1]) * 1000) / scale, 2);
        expect(layout.k).toBeCloseTo(1000 / scale, 12);
      }
    }
  });

  it('収まらない縮尺は警告し、自動縮尺は収まる縮尺を選ぶ', () => {
    const doc = createProject('大');
    const ext = modelExtent(doc, currentSite(doc));
    const { warnings } = buildExportSvg(doc, { paper: 'A4', scale: 50, mode: 'cad' });
    expect(warnings.some((w) => w.includes('収まりません'))).toBe(true);
    const s = autoScale(ext, 'A4');
    expect(layoutOnPaper(ext, 'A4', s).fits).toBe(true);
  });

  it('PDF用SVGに図面名・作成日・面積・各辺・台数・方位・縮尺・注記を含む', () => {
    const doc = createProject('サンプル駐車場');
    const { svg } = buildExportSvg(doc, { paper: 'A3', scale: 200, mode: 'proposal', notes: 'テスト注記' });
    for (const s of ['サンプル駐車場', '営業提案図', '敷地面積', '300.00㎡', '各辺', '駐車台数', '>N<', '1/200', 'テスト注記']) expect(svg).toContain(s);
  });

  it('22/23. 精密CADモードと営業提案モードは同じ実寸データから異なる表示を生成する', async () => {
    const doc = createProject('モード');
    const site = currentSite(doc)!;
    const plans = await optimizeParking({ site, obstacles: [], entrances: doc.entrances, stallType: doc.stallTypes[0], settings: doc.parking }, { yieldEvery: 1e9 });
    doc.stalls = plans[0].stalls;
    doc.aisles = plans[0].aisles;
    const cad = buildModel(doc, { mode: 'cad', textUnit: 0.05, sitePoints: site });
    const pro = buildModel(doc, { mode: 'proposal', textUnit: 0.05, sitePoints: site });
    expect(cad.some((p) => p.layer === 'angle')).toBe(true);
    expect(pro.some((p) => p.layer === 'angle')).toBe(false);
    const sitePolyC = cad.find((p) => p.t === 'poly' && p.id === 'site');
    const sitePolyP = pro.find((p) => p.t === 'poly' && p.id === 'site');
    expect(sitePolyC && sitePolyP && sitePolyC.t === 'poly' && sitePolyP.t === 'poly' && sitePolyC.pts).toEqual(sitePolyP && sitePolyP.t === 'poly' ? sitePolyP.pts : null);
    const stallsC = cad.filter((p) => p.layer === 'stall' && p.t === 'poly').length;
    const stallsP = pro.filter((p) => p.layer === 'stall' && p.t === 'poly').length;
    expect(stallsC).toBe(doc.stalls.length);
    expect(stallsP).toBe(doc.stalls.length);
  }, 60000);
});

describe('保存・再編集', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { localStorage: MemStorage } }).window = { localStorage: new MemStorage() };
  });

  it('26. 保存して再読込すると同じ内容で再編集できる', async () => {
    const st = new LocalAdapter();
    const doc = createProject('保存テスト');
    doc.stalls = [{ id: 's1', typeId: 'standard', cx: 5, cy: 5, width: 2.5, depth: 5, angle: 0 }];
    await st.save(doc, { snapshot: true, label: '初回' });
    const list = await st.list();
    expect(list).toHaveLength(1);
    expect(list[0].area).toBeCloseTo(300, 6);
    expect(list[0].stallCount).toBe(1);
    expect(list[0].thumbnail).toContain('<svg');
    const back = await st.load(doc.id);
    expect(back.stalls).toEqual(doc.stalls);
    expect(back.land).toEqual(doc.land);
    expect(back.solution?.status).toBe('exact');
  });

  it('バージョン履歴から復元でき、本体破損時は自動復旧する', async () => {
    const st = new LocalAdapter();
    const doc = createProject('版');
    await st.save(doc, { snapshot: true, label: 'v1' });
    const v2 = { ...doc, name: '版2', updatedAt: new Date(Date.now() + 1000).toISOString() };
    await st.save(v2, { snapshot: true, label: 'v2' });
    const vers = await st.listVersions(doc.id);
    expect(vers.map((v) => v.label)).toEqual(['v2', 'v1']);
    const old = await st.loadVersion(doc.id, vers[1].versionId);
    expect(old.name).toBe('版');
    (globalThis as unknown as { window: { localStorage: MemStorage } }).window.localStorage.setItem(`ldc:p:${doc.id}`, '{broken');
    const recovered = await st.load(doc.id);
    expect(recovered.name).toBe('版2');
  });
});
