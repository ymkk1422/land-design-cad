// データ保存層：端末内（localStorage）／Claude Artifact DB／Supabase を同一インターフェースで扱う
import type { ProjectDoc, ProjectSummary } from '@/types';
import { migrateProject } from '@/services/projectFactory';
import { polygonArea } from '@/engine/geometry/polygon';
import { isDrawable } from '@/engine/constraints/solver';
import { IdbAssetStore } from './assets';

export interface VersionInfo {
  versionId: string;
  savedAt: string;
  label: string;
}

export interface StorageAdapter {
  readonly kind: 'local' | 'claude' | 'supabase';
  readonly label: string;
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDoc>;
  save(doc: ProjectDoc, opts?: { snapshot?: boolean; label?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  listVersions(id: string): Promise<VersionInfo[]>;
  loadVersion(id: string, versionId: string): Promise<ProjectDoc>;
  /** 下絵などのアセット（図面データとは別に保存） */
  saveAsset(id: string, blob: Blob): Promise<void>;
  loadAsset(id: string): Promise<Blob>;
  deleteAsset(id: string): Promise<void>;
}

export const MAX_VERSIONS = 15;

export function summarize(doc: ProjectDoc, thumbnail?: string): ProjectSummary {
  const sol = doc.solution;
  const pts = isDrawable(sol) ? sol!.candidates[Math.min(doc.selectedCandidate, sol!.candidates.length - 1)].points : [];
  return {
    id: doc.id,
    name: doc.name,
    area: pts.length ? polygonArea(pts) : 0,
    stallCount: doc.stalls.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    thumbnail: thumbnail ?? thumbnailSvg(pts, doc),
  };
}

/** 一覧用の簡易サムネイル（SVG文字列、数値のみから生成） */
export function thumbnailSvg(pts: { x: number; y: number }[], doc: ProjectDoc): string {
  if (pts.length < 3) return '';
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = 90 / Math.max(maxX - minX, maxY - minY, 1e-6);
  const tx = (x: number): string => (5 + (x - minX) * s).toFixed(1);
  const ty = (y: number): string => (95 - (y - minY) * s).toFixed(1);
  const poly = pts.map((p) => `${tx(p.x)},${ty(p.y)}`).join(' ');
  const stalls = doc.stalls
    .slice(0, 400)
    .map((st) => {
      const a = (st.angle * Math.PI) / 180;
      const c = Math.cos(a), si = Math.sin(a);
      const hw = st.width / 2, hd = st.depth / 2;
      const pp = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => `${tx(st.cx + x * c - y * si)},${ty(st.cy + x * si + y * c)}`);
      return `<polygon points="${pp.join(' ')}" fill="#0b5d63" fill-opacity="0.35" stroke="#0b5d63" stroke-width="0.4"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="${poly}" fill="#f4f7f7" stroke="#14161a" stroke-width="1"/>${stalls}</svg>`;
}

// ---------- 端末内保存 ----------
const KEY_INDEX = 'ldc:index';
const kDoc = (id: string): string => `ldc:p:${id}`;
const kVer = (id: string): string => `ldc:v:${id}`;

function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const t = '__ldc_test__';
    s.setItem(t, '1');
    s.removeItem(t);
    return s;
  } catch {
    return null;
  }
}

/** 書き込み→読み戻し検証→確定 の二段階保存で破損を防ぐ */
function atomicSet(s: Storage, key: string, value: string): void {
  const tmp = `${key}:tmp`;
  s.setItem(tmp, value);
  if (s.getItem(tmp) !== value) throw new Error('保存の検証に失敗しました');
  JSON.parse(value);
  s.setItem(key, value);
  s.removeItem(tmp);
}

export class LocalAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  readonly label = 'この端末に保存';
  private mem = new Map<string, string>(); // localStorage 不可時のフォールバック
  private assets = new IdbAssetStore();
  saveAsset(id: string, blob: Blob): Promise<void> {
    return this.assets.put(id, blob);
  }
  loadAsset(id: string): Promise<Blob> {
    return this.assets.get(id);
  }
  deleteAsset(id: string): Promise<void> {
    return this.assets.delete(id);
  }
  private get s(): Storage | null {
    return typeof window === 'undefined' ? null : safeStorage();
  }
  private get(key: string): string | null {
    const s = this.s;
    return s ? s.getItem(key) : this.mem.get(key) ?? null;
  }
  private set(key: string, v: string): void {
    const s = this.s;
    if (s) atomicSet(s, key, v);
    else this.mem.set(key, v);
  }
  private del(key: string): void {
    const s = this.s;
    if (s) s.removeItem(key);
    else this.mem.delete(key);
  }
  async list(): Promise<ProjectSummary[]> {
    try {
      const idx = JSON.parse(this.get(KEY_INDEX) ?? '[]') as ProjectSummary[];
      return idx.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }
  async load(id: string): Promise<ProjectDoc> {
    const raw = this.get(kDoc(id));
    try {
      if (!raw) throw new Error('missing');
      return migrateProject(JSON.parse(raw));
    } catch {
      // 本体が破損していれば最新バージョンから復旧
      const vers = this.versions(id);
      if (vers.length) return migrateProject(vers[vers.length - 1].doc);
      throw new Error('図面データが見つからないか破損しています');
    }
  }
  private versions(id: string): { versionId: string; savedAt: string; label: string; doc: ProjectDoc }[] {
    try {
      return JSON.parse(this.get(kVer(id)) ?? '[]');
    } catch {
      return [];
    }
  }
  async save(doc: ProjectDoc, opts: { snapshot?: boolean; label?: string } = {}): Promise<void> {
    const json = JSON.stringify(doc);
    this.set(kDoc(doc.id), json);
    const idx = (await this.list()).filter((p) => p.id !== doc.id);
    idx.push(summarize(doc));
    this.set(KEY_INDEX, JSON.stringify(idx));
    if (opts.snapshot) {
      const vers = this.versions(doc.id);
      vers.push({ versionId: `v${Date.now()}`, savedAt: new Date().toISOString(), label: opts.label ?? '自動保存', doc });
      while (vers.length > MAX_VERSIONS) vers.shift();
      try {
        this.set(kVer(doc.id), JSON.stringify(vers));
      } catch {
        // 容量超過時は古いバージョンを削って再試行
        this.set(kVer(doc.id), JSON.stringify(vers.slice(-3)));
      }
    }
  }
  async remove(id: string): Promise<void> {
    // 図面が参照していたアセット（下絵の元画像など）も削除
    const ids = new Set<string>();
    const collect = (raw: string | null): void => {
      try {
        const d = JSON.parse(raw ?? 'null') as { assetIds?: string[] } | null;
        d?.assetIds?.forEach((a) => ids.add(a));
      } catch {
        /* 破損データは無視 */
      }
    };
    collect(this.get(kDoc(id)));
    this.versions(id).forEach((v) => v.doc.assetIds?.forEach((a) => ids.add(a)));
    for (const a of ids) await this.assets.delete(a).catch(() => undefined);
    this.del(kDoc(id));
    this.del(kVer(id));
    const idx = (await this.list()).filter((p) => p.id !== id);
    this.set(KEY_INDEX, JSON.stringify(idx));
  }
  async listVersions(id: string): Promise<VersionInfo[]> {
    return this.versions(id).map(({ versionId, savedAt, label }) => ({ versionId, savedAt, label })).reverse();
  }
  async loadVersion(id: string, versionId: string): Promise<ProjectDoc> {
    const v = this.versions(id).find((x) => x.versionId === versionId);
    if (!v) throw new Error('バージョンが見つかりません');
    return migrateProject(v.doc);
  }
}
