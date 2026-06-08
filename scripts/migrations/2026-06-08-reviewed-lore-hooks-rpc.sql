-- RPC backing the client-side prune of merged/adjudicated user lore.
--
-- The ModMixer client (anon role, publishable key) needs to know which of
-- ITS OWN submissions the /lore-review skill has finished with, so it can
-- delete the now-redundant local copy from userData/lore. We expose this as
-- a SECURITY DEFINER function rather than a table SELECT policy so the anon
-- role never gains read access to other submissions' markdown, review_notes,
-- or reviewer identity — the function returns only (topic, hook, reviewed_at)
-- and only for the device_id passed in.
--
-- Statuses returned are the TERMINAL ones: verified/dup (now served from
-- community_lore via the pull) and rejected/meta/auto_filter (judged
-- not-to-be-kept). `pending` and `needs_edit` are still in flight and are
-- intentionally excluded so in-progress entries stay on the user's machine.
--
-- Apply via: supabase MCP apply_migration, or psql against the project.

create or replace function public.reviewed_lore_hooks(p_device_id text)
returns table (topic text, hook text, reviewed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select topic, hook, reviewed_at
  from public.lore_submissions
  where device_id = p_device_id
    and review_status in ('verified', 'dup', 'rejected', 'meta', 'auto_filter')
$$;

-- Lock execution down to the anon/authenticated client roles only.
revoke all on function public.reviewed_lore_hooks(text) from public;
grant execute on function public.reviewed_lore_hooks(text) to anon, authenticated;
