-- reviewed_lore_hooks now also returns `game`, so the ModMixer client prunes
-- the right game's local lore copy — topic+hook alone is ambiguous now that the
-- lore tables are partitioned by game (RimWorld and Minecraft share topic names
-- like recipes, build, test-loop, assets, distribution, misc).
--
-- The `game` column + the game-inclusive primary keys already exist:
--   lore_submissions: PRIMARY KEY (game, device_id, topic, hook)
--   community_lore:   PRIMARY KEY (game, topic, hook)
-- so this migration only touches the RPC. Changing a function's return columns
-- requires dropping it first. Additive for OLD clients — they read the result
-- by key (topic/hook/reviewed_at) and ignore the extra `game` column.
--
-- Apply via: supabase MCP apply_migration, or psql against the project.

drop function if exists public.reviewed_lore_hooks(text);
create or replace function public.reviewed_lore_hooks(p_device_id text)
returns table (game text, topic text, hook text, reviewed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select game, topic, hook, reviewed_at
  from public.lore_submissions
  where device_id = p_device_id
    and review_status in ('verified', 'dup', 'rejected', 'meta', 'auto_filter')
$$;

revoke all on function public.reviewed_lore_hooks(text) from public;
grant execute on function public.reviewed_lore_hooks(text) to anon, authenticated;
