-- Per-game partitioning for the community-lore tables, so Minecraft and
-- RimWorld lore never collide. The two games share several topic names
-- (recipes, build, test-loop, assets, distribution, misc), so `game` has to
-- enter the PRIMARY KEY of both tables — otherwise a RimWorld lesson and a
-- Minecraft lesson under the same topic+hook would collide on UPSERT and one
-- would silently overwrite the other.
--
-- WHY THIS FILE EXISTS: the original migration for this step
-- (2026-06-22-community-lore-game-id.sql, added in 859c2be) was authored
-- against a `game_id` + unique-INDEX design, then the live DB was hand-
-- corrected to a `game` column + game-inclusive PRIMARY KEYS and the stale file
-- was deleted in cfae866 without a committed replacement. That left the next
-- migration (2026-06-23-reviewed-lore-hooks-game.sql) selecting a `game` column
-- that no committed migration creates. This file restores the missing step in
-- the corrected shape and MUST run before 2026-06-23.
--
-- Everything here is additive, backfilling, and idempotent: existing rows
-- default to game='rimworld', and re-applying on a DB already at the target
-- shape (e.g. a branch forked from production) is a no-op.
--
-- Target shape (verified against project hietsknsycjlcrvfgqaz):
--   community_lore    PRIMARY KEY (game, topic, hook)
--   lore_submissions  PRIMARY KEY (game, device_id, topic, hook)
--
-- Apply via: supabase MCP apply_migration, or psql against the project.

-- 1. `game` columns. Adding a NOT NULL column with a constant default is a
--    metadata-only change (no table rewrite); existing rows read as 'rimworld'.
alter table public.community_lore
  add column if not exists game text not null default 'rimworld';
alter table public.lore_submissions
  add column if not exists game text not null default 'rimworld';

-- 2. Fold `game` into each table's PRIMARY KEY (game first), unless it's already
--    there. After the backfill, (game, …) uniqueness reduces to the OLD key's
--    uniqueness, so the new PK is guaranteed to build. The old PK name is read
--    from the catalog so this is independent of how it was named.
do $$
declare
  pk_name text;
  pk_cols text[];
begin
  select con.conname,
         (select array_agg(att.attname::text)
            from unnest(con.conkey) as k(attnum)
            join pg_attribute att
              on att.attrelid = con.conrelid and att.attnum = k.attnum)
    into pk_name, pk_cols
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'community_lore'
    and con.contype = 'p';

  if pk_name is null then
    alter table public.community_lore add primary key (game, topic, hook);
  elsif not ('game' = any(pk_cols)) then
    execute format('alter table public.community_lore drop constraint %I', pk_name);
    alter table public.community_lore add primary key (game, topic, hook);
  end if;
end $$;

do $$
declare
  pk_name text;
  pk_cols text[];
begin
  select con.conname,
         (select array_agg(att.attname::text)
            from unnest(con.conkey) as k(attnum)
            join pg_attribute att
              on att.attrelid = con.conrelid and att.attnum = k.attnum)
    into pk_name, pk_cols
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'lore_submissions'
    and con.contype = 'p';

  if pk_name is null then
    alter table public.lore_submissions add primary key (game, device_id, topic, hook);
  elsif not ('game' = any(pk_cols)) then
    execute format('alter table public.lore_submissions drop constraint %I', pk_name);
    alter table public.lore_submissions add primary key (game, device_id, topic, hook);
  end if;
end $$;

-- 3. Post-flight verification — the steps above lean on IF NOT EXISTS and
--    catalog matching, which can pass silently if an assumption is wrong.
--    Assert the end state so a botched apply raises instead of looking clean.
do $$
declare
  null_comm bigint;
  null_subs bigint;
  comm_pk text;
  subs_pk text;
begin
  select count(*) into null_comm from public.community_lore where game is null;
  select count(*) into null_subs from public.lore_submissions where game is null;
  if null_comm <> 0 or null_subs <> 0 then
    raise exception 'community-lore migration: NULL game remains (community_lore=%, lore_submissions=%)',
      null_comm, null_subs;
  end if;

  select pg_get_constraintdef(con.oid) into comm_pk
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'community_lore' and con.contype = 'p';

  select pg_get_constraintdef(con.oid) into subs_pk
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'lore_submissions' and con.contype = 'p';

  if comm_pk is distinct from 'PRIMARY KEY (game, topic, hook)' then
    raise exception 'community_lore PK is "%", expected PRIMARY KEY (game, topic, hook)', comm_pk;
  end if;
  if subs_pk is distinct from 'PRIMARY KEY (game, device_id, topic, hook)' then
    raise exception 'lore_submissions PK is "%", expected PRIMARY KEY (game, device_id, topic, hook)', subs_pk;
  end if;
end $$;
