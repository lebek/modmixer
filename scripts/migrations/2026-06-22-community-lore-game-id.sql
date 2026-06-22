-- Per-game partitioning for the community-lore tables, so Minecraft and
-- RimWorld lore never mix.
--
-- RimWorld and Minecraft share several topic names (recipes, build, test-loop,
-- assets, distribution, misc), so game_id has to enter the UNIQUENESS KEY on
-- both tables — otherwise a RimWorld lesson and a Minecraft lesson under the
-- same topic+hook would collide on UPSERT and one would silently overwrite the
-- other. Everything here is additive + backfilling: existing rows default to
-- game_id='rimworld', so the live RimWorld pool is untouched.
--
-- Apply via: supabase MCP apply_migration, or psql against the project.

-- 1. game_id columns. Adding a NOT NULL column with a constant default is a
--    metadata-only change (no table rewrite); existing rows read as 'rimworld'.
alter table public.lore_submissions
  add column if not exists game_id text not null default 'rimworld';
alter table public.community_lore
  add column if not exists game_id text not null default 'rimworld';

-- 2. Re-key lore_submissions uniqueness:
--      (device_id, topic, hook) -> (device_id, game_id, topic, hook)
--    The old unique may have been created as a CONSTRAINT or a bare unique
--    INDEX; both are dropped by matching the column set, so this is independent
--    of whatever the original object was named.
do $$
declare r record;
begin
  for r in
    select con.conname as name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'lore_submissions'
      and con.contype = 'u'
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(con.conkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) = array['device_id','hook','topic']
  loop
    execute format('alter table public.lore_submissions drop constraint %I', r.name);
  end loop;

  for r in
    select c.relname as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'lore_submissions'
      and i.indisunique
      and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(i.indkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = i.indrelid and att.attnum = k.attnum
      ) = array['device_id','hook','topic']
  loop
    execute format('drop index public.%I', r.name);
  end loop;
end $$;

create unique index if not exists lore_submissions_device_game_topic_hook_key
  on public.lore_submissions (device_id, game_id, topic, hook);

-- 3. Re-key community_lore uniqueness:
--      (topic, hook) -> (game_id, topic, hook)
do $$
declare r record;
begin
  for r in
    select con.conname as name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'community_lore'
      and con.contype = 'u'
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(con.conkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = k.attnum
      ) = array['hook','topic']
  loop
    execute format('alter table public.community_lore drop constraint %I', r.name);
  end loop;

  for r in
    select c.relname as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'community_lore'
      and i.indisunique
      and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(i.indkey) as k(attnum)
        join pg_attribute att
          on att.attrelid = i.indrelid and att.attnum = k.attnum
      ) = array['hook','topic']
  loop
    execute format('drop index public.%I', r.name);
  end loop;
end $$;

create unique index if not exists community_lore_game_topic_hook_key
  on public.community_lore (game_id, topic, hook);

-- 4. reviewed_lore_hooks now also returns game_id, so the client prunes the
--    right game's local copy (topic+hook is ambiguous across games). Changing
--    a function's return columns requires dropping it first.
drop function if exists public.reviewed_lore_hooks(text);
create or replace function public.reviewed_lore_hooks(p_device_id text)
returns table (game_id text, topic text, hook text, reviewed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select game_id, topic, hook, reviewed_at
  from public.lore_submissions
  where device_id = p_device_id
    and review_status in ('verified', 'dup', 'rejected', 'meta', 'auto_filter')
$$;

revoke all on function public.reviewed_lore_hooks(text) from public;
grant execute on function public.reviewed_lore_hooks(text) to anon, authenticated;

-- 5. Post-flight verification — the steps above rely on catalog matching and
--    IF NOT EXISTS, which fail silently if an assumption is wrong. Assert the
--    end state so a botched apply raises instead of looking like a success.
do $$
declare
  null_subs bigint;
  null_comm bigint;
  idx_count bigint;
begin
  select count(*) into null_subs from public.lore_submissions where game_id is null;
  select count(*) into null_comm from public.community_lore where game_id is null;
  select count(*) into idx_count
  from pg_indexes
  where schemaname = 'public'
    and indexname in (
      'lore_submissions_device_game_topic_hook_key',
      'community_lore_game_topic_hook_key'
    );
  if null_subs <> 0 or null_comm <> 0 then
    raise exception 'community-lore migration: NULL game_id remains (lore_submissions=%, community_lore=%)',
      null_subs, null_comm;
  end if;
  if idx_count <> 2 then
    raise exception 'community-lore migration: expected 2 game-aware unique indexes, found %', idx_count;
  end if;
end $$;
