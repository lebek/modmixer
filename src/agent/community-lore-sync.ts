import {
  LORE_TOPICS,
  deleteUserEntries,
  readAllUserEntries,
  seedCommunityLoreFromShipped,
  writeCommunityLore,
  type LoreTopic,
} from './lore.js';
import { loadSettings, saveSettings } from './settings.js';

// Publishable Supabase credentials — designed to ship in clients. Rotation
// is independent of any user-level secret. Keep these in sync with the
// Supabase project that owns the lore_submissions / community_lore tables.
const SUPABASE_URL = 'https://hietsknsycjlcrvfgqaz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_hNFzBbls5cjR-Huc80KJdA_4OIocei5';

interface CommunityLoreRow {
  topic: string;
  hook: string;
  markdown: string;
  updated_at: string;
}

function authHeaders(): Record<string, string> {
  // Only the apikey header — the publishable key is not a JWT, and
  // putting it in Authorization: Bearer makes Supabase try (and fail) to
  // decode it as a user token, which drops the request onto a role with
  // no RLS policies attached.
  return {
    apikey: SUPABASE_ANON_KEY,
  };
}

async function pushUserLore(deviceId: string): Promise<number> {
  const entries = await readAllUserEntries();
  if (entries.length === 0) return 0;
  const rows = entries.map((e) => ({
    device_id: deviceId,
    topic: e.topic,
    hook: e.hook,
    markdown: e.markdown,
    // Per-entry authoring attribution, parsed from the `<sub>` footer
    // `saveEntry` writes. Null for entries authored before the stamp
    // existed — those have to be re-verified from scratch by the
    // lore-review skill.
    client_model: e.clientModel ?? null,
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/lore_submissions`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
      // UPSERT semantics — replace the existing row for the same
      // (device_id, topic, hook). `return=minimal` skips the response body.
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(
      `push failed: ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  return rows.length;
}

function isLoreTopic(s: string): s is LoreTopic {
  return (LORE_TOPICS as readonly string[]).includes(s);
}

async function pullCommunityLore(): Promise<
  Array<{ topic: LoreTopic; hook: string; markdown: string }>
> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/community_lore?select=topic,hook,markdown`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(
      `pull failed: ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const rows = (await res.json()) as CommunityLoreRow[];
  return rows
    .filter((r) => isLoreTopic(r.topic))
    .map((r) => ({
      topic: r.topic as LoreTopic,
      hook: r.hook,
      markdown: r.markdown,
    }));
}

/**
 * Ask the server which of this device's submissions have reached a
 * terminal review state — meaning the local user-tier copy can be
 * pruned. The RPC filters to `verified, dup, rejected, meta, auto_filter`
 * (verified/dup are now served from community_lore and arrive via the
 * pull; the rest were judged not-to-be-kept); `pending` and `needs_edit`
 * are still in flight and are deliberately excluded.
 *
 * It's a SECURITY DEFINER RPC so the anon role can read its own rows'
 * status without a table-wide SELECT policy exposing every submission's
 * markdown/review_notes (see the migration that defines it).
 */
async function fetchReviewedHooks(
  deviceId: string,
): Promise<Array<{ topic: LoreTopic; hook: string; reviewedAt?: string }>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reviewed_lore_hooks`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_device_id: deviceId }),
  });
  if (!res.ok) {
    throw new Error(
      `reviewed-hooks fetch failed: ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const rows = (await res.json()) as Array<{
    topic: string;
    hook: string;
    reviewed_at: string | null;
  }>;
  return rows
    .filter((r) => isLoreTopic(r.topic))
    .map((r) => ({
      topic: r.topic as LoreTopic,
      hook: r.hook,
      reviewedAt: r.reviewed_at ?? undefined,
    }));
}

/**
 * Push the user's local lore, then pull the curated community lore and
 * write it into the local cache. Both halves are independent — a failed
 * push doesn't block the pull and vice versa. The toggle gate is checked
 * here so callers can fire this unconditionally on startup.
 */
export async function syncCommunityLore(): Promise<void> {
  const settings = loadSettings();
  if (!settings.useCommunityLore) return;

  // Make sure the cache has SOMETHING before the agent reads — covers the
  // first-launch path (default-on) where the toggle was never explicitly
  // flipped, plus any sync-failed-pull scenario where the cache emptied.
  // The helper is idempotent and only writes topics missing on disk.
  try {
    await seedCommunityLoreFromShipped();
  } catch (err) {
    console.error('[community-lore] seed failed:', err);
  }

  try {
    const pushed = await pushUserLore(settings.distinctId);
    saveSettings({ loreLastPushedAt: new Date().toISOString() });
    if (pushed > 0) {
      console.log(`[community-lore] pushed ${pushed} entries`);
    }
  } catch (err) {
    console.error('[community-lore] push failed:', err);
  }

  let pullOk = false;
  try {
    const rows = await pullCommunityLore();
    await writeCommunityLore(rows);
    pullOk = true;
    console.log(`[community-lore] pulled ${rows.length} entries`);
  } catch (err) {
    console.error('[community-lore] pull failed:', err);
  }

  // Prune local lessons the reviewer has finished with — but only after a
  // successful pull this run, so a verified entry's curated copy is in the
  // cache before we delete the local original (a stale/failed pull could
  // otherwise leave a gap).
  if (pullOk) {
    try {
      const reviewed = await fetchReviewedHooks(settings.distinctId);
      const removed = reviewed.length ? await deleteUserEntries(reviewed) : 0;
      if (removed > 0) {
        console.log(`[community-lore] pruned ${removed} reviewed user entries`);
      }
    } catch (err) {
      console.error('[community-lore] prune failed:', err);
    }
  }
}
