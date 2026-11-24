-- LAND DESIGN CAD : Supabase スキーマ
-- 実行: Supabase ダッシュボード > SQL Editor に貼り付けて実行
-- 方針: 権限はすべてサーバー側（RLS + CHECK 制約 + SECURITY INVOKER 関数）で制御する

create extension if not exists pgcrypto;

create table if not exists public.projects (
  id            text primary key check (char_length(id) between 1 and 80 and id ~ '^[A-Za-z0-9_-]+$'),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 120),
  doc           jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 2000000),
  area_m2       double precision not null default 0 check (area_m2 >= 0 and area_m2 < 1e9),
  stall_count   integer not null default 0 check (stall_count between 0 and 100000),
  thumbnail_svg text check (thumbnail_svg is null or char_length(thumbnail_svg) < 200000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists projects_user_updated on public.projects (user_id, updated_at desc);

create table if not exists public.project_versions (
  id          bigint generated always as identity primary key,
  project_id  text not null references public.projects(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label       text not null default '自動保存' check (char_length(label) <= 80),
  doc         jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 2000000),
  created_at  timestamptz not null default now()
);
create index if not exists versions_project on public.project_versions (project_id, created_at desc);

-- ===== RLS（ユーザーごとのデータ分離）=====
alter table public.projects enable row level security;
alter table public.project_versions enable row level security;

drop policy if exists projects_owner_all on public.projects;
create policy projects_owner_all on public.projects
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists versions_owner_select on public.project_versions;
create policy versions_owner_select on public.project_versions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists versions_owner_insert on public.project_versions;
create policy versions_owner_insert on public.project_versions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );
-- バージョンは更新・削除不可（改ざん防止）。プロジェクト削除時のみ CASCADE で消える。

revoke all on public.projects, public.project_versions from anon;

-- ===== サーバー側入力検証つき保存（1トランザクション）=====
create or replace function public.save_project(
  p_id text, p_name text, p_doc jsonb, p_area double precision, p_stall_count integer,
  p_thumbnail text, p_snapshot boolean, p_label text
) returns void
language plpgsql
security invoker            -- 呼び出したユーザーの権限で実行（RLS が適用される）
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '認証が必要です'; end if;
  if p_doc->'land' is null or jsonb_typeof(p_doc->'land'->'vertexCount') <> 'number' then
    raise exception '図面データの形式が不正です';
  end if;
  if (p_doc->'land'->>'vertexCount')::int not between 3 and 40 then
    raise exception '頂点数が範囲外です';
  end if;
  if jsonb_typeof(p_doc->'stalls') <> 'array' or jsonb_array_length(p_doc->'stalls') > 5000 then
    raise exception '駐車枠データが不正です';
  end if;

  insert into public.projects (id, name, doc, area_m2, stall_count, thumbnail_svg, updated_at)
  values (p_id, p_name, p_doc, p_area, p_stall_count, p_thumbnail, now())
  on conflict (id) do update
    set name = excluded.name, doc = excluded.doc, area_m2 = excluded.area_m2,
        stall_count = excluded.stall_count, thumbnail_svg = excluded.thumbnail_svg, updated_at = now()
    where public.projects.user_id = auth.uid();   -- 他人のIDを上書きできない

  if not found then raise exception '保存権限がありません'; end if;

  if p_snapshot then
    insert into public.project_versions (project_id, label, doc) values (p_id, coalesce(p_label, '自動保存'), p_doc);
    -- 古いバージョンを整理（最新15件を保持）
    delete from public.project_versions v
     where v.project_id = p_id
       and v.id not in (select id from public.project_versions where project_id = p_id order by created_at desc limit 15);
  end if;
end;
$$;

-- 古いバージョン削除は関数内のみ許可するため、DELETE ポリシーは関数経由（invoker）でも必要
drop policy if exists versions_owner_delete on public.project_versions;
create policy versions_owner_delete on public.project_versions
  for delete to authenticated using (user_id = auth.uid());

grant execute on function public.save_project(text, text, jsonb, double precision, integer, text, boolean, text) to authenticated;
