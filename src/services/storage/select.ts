// 保存先の自動選択：Supabase（環境変数設定＋ログイン済み）→ claude.ai クラウド → 端末内
import type { SupabaseClient } from '@supabase/supabase-js';
import { LocalAdapter, type StorageAdapter } from './index';
import { ClaudeDbAdapter, SupabaseAdapter } from './cloud';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabaseConfigured = (): boolean => !!SUPABASE_URL && !!SUPABASE_ANON;

let sbClient: SupabaseClient | null = null;
export async function getSupabase(): Promise<SupabaseClient | null> {
  if (!supabaseConfigured()) return null;
  if (!sbClient) {
    const { createClient } = await import('@supabase/supabase-js');
    sbClient = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return sbClient;
}

export async function pickStorage(): Promise<StorageAdapter> {
  const sb = await getSupabase();
  if (sb) {
    const { data } = await sb.auth.getSession();
    if (data.session) return new SupabaseAdapter(sb);
  }
  const claude = await ClaudeDbAdapter.connect();
  if (claude) return claude;
  return new LocalAdapter();
}
