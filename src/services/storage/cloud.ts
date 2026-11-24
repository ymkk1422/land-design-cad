// クラウド保存アダプタ
// 1) Supabase（Next.js 版の本番構成。RLS でユーザー単位に分離）
// 2) Claude Artifact DB（claude.ai 上で公開した版。data/users/<id>/ は本人以外読み書き不可）
import type { ProjectDoc, ProjectSummary } from '@/types';
import { migrateProject } from '@/services/projectFactory';
import { MAX_VERSIONS, summarize, type StorageAdapter, type VersionInfo } from './index';

// ---- Claude Artifact ランタイムの最小型 ----
interface DbSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DbQuery {
  where(f: string, op: string, v: unknown): DbQuery;
  get(): Promise<{ docs: DbSnap[] }>;
}
interface DbDocRef {
  get(): Promise<DbSnap>;
  set(d: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}
interface DbCollection extends DbQuery {
  doc(id?: string): DbDocRef;
}
interface ClaudeDb {
  collection(p: string): DbCollection;
}
interface ClaudeUser {
  id(): Promise<string | null>;
}
interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

export function claudeRuntime(): ClaudeRuntime | null {
  const w = typeof window !== 'undefined' ? (window as unknown as { claude?: ClaudeRuntime }) : undefined;
  return w?.claude && typeof w.claude.use === 'function' ? w.claude : null;
}

const safeKey = (id: string): string => id.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');

export class ClaudeDbAdapter implements StorageAdapter {
  readonly kind = 'claude' as const;
  readonly label = 'クラウド（claude.ai アカウント）';
  private constructor(private db: ClaudeDb, private uid: string) {}

  static async connect(timeoutMs = 6000): Promise<ClaudeDbAdapter | null> {
    const rt = claudeRuntime();
    if (!rt) return null;
    const timer = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    const go = (async () => {
      const [db, user] = (await Promise.all([rt.use('db'), rt.use('user')])) as [ClaudeDb | null, ClaudeUser | null];
      if (!db || !user) return null;
      const uid = await user.id();
      if (!uid) return null;
      return new ClaudeDbAdapter(db, uid);
    })().catch(() => null);
    return Promise.race([go, timer]);
  }

  private col(): DbCollection {
    return this.db.collection(`data/users/${this.uid}`);
  }

  async list(): Promise<ProjectSummary[]> {
    const snap = await this.col().where('kind', '==', 'summary').get();
    return snap.docs
      .map((d) => d.data()?.summary as ProjectSummary | undefined)
      .filter((x): x is ProjectSummary => !!x && typeof x.id === 'string')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<ProjectDoc> {
    const s = await this.col().doc(`p_${safeKey(id)}`).get();
    if (!s.exists) throw new Error('図面が見つかりません');
    return migrateProject(JSON.parse(String(s.data()?.json)));
  }
  async save(doc: ProjectDoc, opts: { snapshot?: boolean; label?: string } = {}): Promise<void> {
    const json = JSON.stringify({ ...doc, solution: null });
    JSON.parse(json);
    await this.col().doc(`p_${safeKey(doc.id)}`).set({ kind: 'project', json, updatedAt: doc.updatedAt });
    await this.col().doc(`s_${safeKey(doc.id)}`).set({ kind: 'summary', summary: { ...summarize(doc) } as unknown as Record<string, unknown> });
    if (opts.snapshot) {
      const vid = `v${Date.now()}`;
      await this.col().doc(`v_${safeKey(doc.id)}_${vid}`).set({ kind: 'version', projectId: doc.id, versionId: vid, savedAt: new Date().toISOString(), label: opts.label ?? '自動保存', json });
      const vers = await this.listVersions(doc.id);
      for (const v of vers.slice(MAX_VERSIONS)) await this.col().doc(`v_${safeKey(doc.id)}_${v.versionId}`).delete();
    }
  }
  async remove(id: string): Promise<void> {
    for (const v of await this.listVersions(id)) await this.col().doc(`v_${safeKey(id)}_${v.versionId}`).delete();
    await this.col().doc(`p_${safeKey(id)}`).delete();
    await this.col().doc(`s_${safeKey(id)}`).delete();
  }
  async listVersions(id: string): Promise<VersionInfo[]> {
    const snap = await this.col().where('kind', '==', 'version').where('projectId', '==', id).get();
    return snap.docs
      .map((d) => d.data() as { versionId: string; savedAt: string; label: string })
      .map(({ versionId, savedAt, label }) => ({ versionId, savedAt, label }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async loadVersion(id: string, versionId: string): Promise<ProjectDoc> {
    const s = await this.col().doc(`v_${safeKey(id)}_${versionId}`).get();
    if (!s.exists) throw new Error('バージョンが見つかりません');
    return migrateProject(JSON.parse(String(s.data()?.json)));
  }
}

// ---- Supabase ----
// テーブル定義・RLS は supabase/schema.sql を参照。
// クライアント側の権限制御には依存せず、RLS（auth.uid() = user_id）と CHECK 制約で保護する。
import type { SupabaseClient } from '@supabase/supabase-js';

export class SupabaseAdapter implements StorageAdapter {
  readonly kind = 'supabase' as const;
  readonly label = 'クラウド（Supabase）';
  constructor(private sb: SupabaseClient) {}

  async list(): Promise<ProjectSummary[]> {
    const { data, error } = await this.sb
      .from('projects')
      .select('id,name,area_m2,stall_count,created_at,updated_at,thumbnail_svg')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      area: Number(r.area_m2),
      stallCount: Number(r.stall_count),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      thumbnail: (r.thumbnail_svg as string | null) ?? undefined,
    }));
  }
  async load(id: string): Promise<ProjectDoc> {
    const { data, error } = await this.sb.from('projects').select('doc').eq('id', id).single();
    if (error) throw new Error(error.message);
    return migrateProject(data.doc);
  }
  async save(doc: ProjectDoc, opts: { snapshot?: boolean; label?: string } = {}): Promise<void> {
    const sum = summarize(doc);
    const body = { ...doc, solution: null };
    // サーバー側 save_project 関数が入力検証・バージョン保存をトランザクションで行う
    const { error } = await this.sb.rpc('save_project', {
      p_id: doc.id,
      p_name: doc.name,
      p_doc: body,
      p_area: sum.area,
      p_stall_count: sum.stallCount,
      p_thumbnail: sum.thumbnail ?? null,
      p_snapshot: !!opts.snapshot,
      p_label: opts.label ?? '自動保存',
    });
    if (error) throw new Error(error.message);
  }
  async remove(id: string): Promise<void> {
    const { error } = await this.sb.from('projects').delete().eq('id', id);
    if (error) throw new Error(error.message);
  }
  async listVersions(id: string): Promise<VersionInfo[]> {
    const { data, error } = await this.sb
      .from('project_versions')
      .select('id,label,created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(MAX_VERSIONS);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ versionId: String(r.id), savedAt: r.created_at as string, label: r.label as string }));
  }
  async loadVersion(_id: string, versionId: string): Promise<ProjectDoc> {
    const { data, error } = await this.sb.from('project_versions').select('doc').eq('id', versionId).single();
    if (error) throw new Error(error.message);
    return migrateProject(data.doc);
  }
}
