-- Adds review-state columns to lore_submissions so the /lore-review skill
-- can track triage progress across sessions. All additive — existing rows
-- default to review_status='pending' so the 113 backlog enters the queue.
--
-- Apply via: supabase MCP apply_migration, or psql against the project.

alter table public.lore_submissions
  add column if not exists review_status text
    not null
    default 'pending'
    check (review_status in (
      'pending',     -- not yet looked at
      'verified',    -- claim checked + merged into community_lore
      'rejected',    -- claim wrong / unverifiable / not useful
      'dup',         -- already covered by an existing entry; no action
      'meta',        -- not RimWorld lore — harness/agent feedback, store separately
      'needs_edit', -- claim is true but markdown needs rewriting before promotion
      'auto_filter' -- coarse pre-filter swept it out (use review_notes to say why)
    )),
  add column if not exists review_notes text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists merged_topic text,
  add column if not exists merged_hook text,
  -- Client-supplied identifier of the model that generated the lore (e.g.
  -- "anthropic:claude-opus-4-7"). NULL for rows pushed before the client
  -- learned to include it — those have to be earned from scratch.
  add column if not exists client_model text;

create index if not exists lore_submissions_review_status_idx
  on public.lore_submissions (review_status);
