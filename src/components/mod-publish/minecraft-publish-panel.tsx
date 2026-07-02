import { useEffect, useRef, useState } from 'react';
import type { AboutMetadata, WorkspaceMod } from '../../agent/workspace';
import type {
  ModrinthPublishProgressEvent,
  ModrinthSideSupport,
} from '../../agent/minecraft/modrinth';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field, Section } from './ui';
import { MinecraftPublishConfirmDialog } from './minecraft-publish-confirm-dialog';
import { DangerZone } from './danger-zone';

/** Minecraft mods publish to Modrinth (not Steam Workshop). */
export function MinecraftPublishPanel({
  mod,
  onDeleted,
}: {
  mod: WorkspaceMod;
  onDeleted?: () => void;
}) {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  // Reveals the token form even when a token is already stored, so a wrong or
  // expired token can be replaced (otherwise publishing would just keep
  // failing with no way back to the input from this panel).
  const [editingToken, setEditingToken] = useState(false);

  // Modrinth project metadata (project-level, applied at first publish). Seeded
  // from the metadata we stored on the last publish when present, so the form
  // survives past the first publish; otherwise from the mod's manifest fields
  // (gradle.properties, via mod.about) and Modrinth defaults for a first run.
  // Seeded (not plain) state so an identity change in the About section above
  // flows into fields the user hasn't hand-edited.
  const saved = mod.prefs.modrinthMeta;
  const [slug, setSlug] = useSeededState(
    saved?.slug || mod.prefs.modrinthSlug || slugify(mod.about.packageId || mod.about.name),
  );
  const [title, setTitle] = useSeededState(saved?.title || mod.about.name || 'My Mod');
  const [summary, setSummary] = useSeededState(
    saved?.summary || deriveSummary(mod.about.description || ''),
  );
  const [description, setDescription] = useSeededState(saved?.description || mod.about.description || '');
  const [license, setLicense] = useState(saved?.license || 'MIT');
  const [categories, setCategories] = useState(saved?.categories.join(', ') || '');
  // No UI control for side support yet; carry the saved/default values through
  // to the publish call (Modrinth requires both, default 'required').
  const clientSide: ModrinthSideSupport = saved?.clientSide || 'required';
  const serverSide: ModrinthSideSupport = saved?.serverSide || 'required';

  // Version number + changelog are per-publish; collected in the confirm
  // dialog (like RimWorld's change notes) rather than kept in the form.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [progress, setProgress] = useState<ModrinthPublishProgressEvent | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(
    mod.prefs.modrinthSlug ? `https://modrinth.com/mod/${mod.prefs.modrinthSlug}` : null,
  );

  const isUpdate = !!mod.prefs.modrinthProjectId;

  useEffect(() => {
    void window.modmixer.hasModrinthToken().then(setHasToken);
  }, []);

  useEffect(() => {
    return window.modmixer.onModrinthProgress((event) => {
      if (event.folder !== mod.folder) return;
      setProgress(event);
      if (event.status === 'done' && event.url) setPublishedUrl(event.url);
    });
  }, [mod.folder]);

  const saveToken = useAsyncAction(async () => {
    const ok = await window.modmixer.setModrinthToken(tokenInput.trim());
    setHasToken(ok);
    if (ok) {
      setTokenInput('');
      setEditingToken(false);
    }
  });

  const publish = useAsyncAction(
    async (version: { versionNumber: string; changelog: string }) => {
      setProgress(null);
      await window.modmixer.publishToModrinth(
        mod.folder,
        {
          slug: slugify(slug),
          title,
          summary,
          description,
          categories: categories
            .split(',')
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean),
          license,
          clientSide,
          serverSide,
        },
        {
          versionNumber: version.versionNumber,
          versionType: 'release',
          changelog: version.changelog,
        },
      );
    },
  );

  // The token form shows up front until a token is stored, and on demand
  // afterwards (to replace a bad one). The metadata above is always editable.
  const showTokenForm = hasToken === false || editingToken;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="max-w-xl space-y-6">
          <MinecraftAboutSection mod={mod} />

          <Section
            title="Modrinth"
            description={
              isUpdate
                ? 'Upload a new version to your existing Modrinth project.'
                : 'Publish this mod to Modrinth. New projects are created as a draft pending Modrinth moderation review before they go public.'
            }
          >
            {isUpdate && (
              <p className="text-xs text-muted">
                These project details were set on the first publish. A version
                update doesn't change them — edit them
                {publishedUrl ? (
                  <>
                    {' '}on{' '}
                    <button
                      onClick={() => void window.modmixer.openExternal(publishedUrl)}
                      className="text-accent hover:underline"
                    >
                      Modrinth
                    </button>
                  </>
                ) : (
                  ' on Modrinth'
                )}
                . Set the new version number + changelog when you publish.
              </p>
            )}
            <Field label="Slug" hint="Lowercase, hyphenated, unique on Modrinth.">
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={isUpdate}
                className={inputCls}
                placeholder="my-cool-mod"
              />
            </Field>
            <Field label="Title">
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={isUpdate} className={inputCls} />
            </Field>
            <Field label="Summary" hint="One-line description shown in listings. Required by Modrinth.">
              <input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} disabled={isUpdate} className={inputCls} placeholder="A short, punchy summary." />
            </Field>
            <Field label="Description" hint="Full markdown shown on the project page.">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={isUpdate} rows={6} className={`${inputCls} resize-y`} />
            </Field>
            <Field label="License (SPDX)" hint='e.g. MIT, Apache-2.0, LGPL-3.0-only. Required by Modrinth.'>
              <input type="text" value={license} onChange={(e) => setLicense(e.target.value)} disabled={isUpdate} className={inputCls} />
            </Field>
            <Field label="Categories" hint="Comma-separated Modrinth category slugs, e.g. utility, technology.">
              <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)} disabled={isUpdate} className={inputCls} placeholder="utility, technology" />
            </Field>

            {progress && (
              <div className="rounded-md border border-line bg-surface/40 px-3 py-2 text-xs text-muted">
                {progressLabel(progress)}
                {progress.awaitingReview && (
                  <span className="mt-1 block text-warning">
                    Draft created — Modrinth must review it before it's public.
                  </span>
                )}
              </div>
            )}
            {publishedUrl && (
              <button
                onClick={() => void window.modmixer.openExternal(publishedUrl)}
                className="text-xs text-accent hover:underline"
              >
                View on Modrinth →
              </button>
            )}
            {publish.error && <ErrorBanner>{publish.error}</ErrorBanner>}

            {/* Publish action — the only part gated on Modrinth credentials. */}
            <div className="space-y-3 border-t border-line pt-4">
              {hasToken === null ? (
                <p className="text-xs text-muted">Checking Modrinth connection…</p>
              ) : showTokenForm ? (
                <div className="space-y-3 rounded-md border border-line bg-surface/30 p-3">
                  <div>
                    <h3 className="text-xs font-medium text-ink">
                      Connect Modrinth to publish
                    </h3>
                    <p className="mt-0.5 text-xs text-muted">
                      Paste a Modrinth personal access token (Settings → PATs on
                      modrinth.com) with the Create projects + Create versions
                      scopes. It's stored encrypted on this machine.
                    </p>
                  </div>
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className={inputCls}
                    placeholder="mrp_…"
                  />
                  {saveToken.error && <ErrorBanner>{saveToken.error}</ErrorBanner>}
                  <div className="flex justify-end gap-2">
                    {hasToken && (
                      <button
                        onClick={() => {
                          setEditingToken(false);
                          setTokenInput('');
                        }}
                        className="rounded-md border border-line px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      onClick={() => void saveToken.run()}
                      disabled={!tokenInput.trim() || saveToken.busy}
                      className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {saveToken.busy ? 'Saving…' : 'Save token'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">
                    Modrinth connected ·{' '}
                    <button
                      onClick={() => setEditingToken(true)}
                      className="text-accent hover:underline"
                    >
                      change token
                    </button>
                  </span>
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={publish.busy || !title.trim() || !slug.trim() || !summary.trim()}
                    className="rounded-md bg-ink px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {publish.busy ? 'Publishing…' : isUpdate ? 'Publish update' : 'Publish to Modrinth'}
                  </button>
                </div>
              )}
            </div>
          </Section>

          <DangerZone
            game="minecraft"
            modFolder={mod.folder}
            expectedConfirmText={mod.about.name || mod.folder}
            hasWorkshopItem={!!mod.prefs.modrinthProjectId}
            onDeleted={onDeleted}
          />
        </div>
      </div>

      <MinecraftPublishConfirmDialog
        open={confirmOpen}
        isUpdate={isUpdate}
        modName={title}
        defaultVersion={nextVersion(mod.prefs.modrinthVersion)}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={(result) => {
          setConfirmOpen(false);
          void publish.run(result);
        }}
      />
    </div>
  );
}

/**
 * The mod's own identity — name / id / author / description as they ship in
 * the jar (gradle.properties). Distinct from the Modrinth project fields, and
 * editable at any time (unlike those, which freeze after first publish).
 * Mirrors the RimWorld panel's About section, including the banner shown when
 * the agent rewrites the metadata mid-edit.
 */
function MinecraftAboutSection({ mod }: { mod: WorkspaceMod }) {
  const [name, setName] = useState(mod.about.name);
  const [modId, setModId] = useState(mod.about.packageId);
  const [author, setAuthor] = useState(mod.about.author);
  const [description, setDescription] = useState(mod.about.description);
  const [savedSnapshot, setSavedSnapshot] = useState<AboutMetadata>(mod.about);
  const [externalUpdate, setExternalUpdate] = useState(false);

  const reseedFromAbout = (about: AboutMetadata) => {
    setName(about.name);
    setModId(about.packageId);
    setAuthor(about.author);
    setDescription(about.description);
    setSavedSnapshot(about);
  };

  // If the agent rewrites gradle.properties while the user is editing, surface
  // a banner so they can choose to discard their unsaved changes.
  useEffect(() => {
    return window.modmixer.onModChanged(({ folder }) => {
      if (folder !== mod.folder) return;
      void window.modmixer.readModAbout(folder).then((about) => {
        if (!about) return;
        const matchesLocal =
          about.name === name &&
          about.packageId === modId &&
          about.author === author &&
          about.description === description;
        if (matchesLocal) {
          setSavedSnapshot(about);
          setExternalUpdate(false);
          return;
        }
        const isDirty =
          name !== savedSnapshot.name ||
          modId !== savedSnapshot.packageId ||
          author !== savedSnapshot.author ||
          description !== savedSnapshot.description;
        if (isDirty) {
          setExternalUpdate(true);
          setSavedSnapshot(about);
        } else {
          reseedFromAbout(about);
        }
      });
    });
  }, [mod.folder, name, modId, author, description, savedSnapshot]);

  const dirty =
    name !== savedSnapshot.name ||
    modId !== savedSnapshot.packageId ||
    author !== savedSnapshot.author ||
    description !== savedSnapshot.description;

  const save = useAsyncAction(async () => {
    const updated = await window.modmixer.writeModAbout(mod.folder, {
      name,
      packageId: modId,
      author,
      description,
    });
    // Reseed from what actually landed on disk — the id gets slugified and the
    // description flattened to one line on write.
    if (updated) reseedFromAbout(updated.about);
    setExternalUpdate(false);
  });

  const acceptExternal = async () => {
    const fresh = await window.modmixer.readModAbout(mod.folder);
    if (fresh) reseedFromAbout(fresh);
    setExternalUpdate(false);
  };

  return (
    <Section
      title="About"
      description="The mod's identity as it ships in the jar — separate from the Modrinth project details below."
    >
      {externalUpdate && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">
          <span>
            The agent updated this mod's metadata while you were editing. Your
            unsaved changes are preserved.
          </span>
          <button
            onClick={() => void acceptExternal()}
            className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-accent hover:underline"
          >
            discard mine
          </button>
        </div>
      )}

      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
          placeholder="My Cool Mod"
        />
      </Field>

      <Field
        label="Mod ID"
        hint="Short lowercase id (letters, digits, underscores). Renaming it rebrands the project — the @Mod id, Java packages, and resource namespaces are renamed to match."
      >
        <input
          type="text"
          value={modId}
          onChange={(e) => setModId(e.target.value)}
          className={inputCls}
          placeholder="mycoolmod"
        />
      </Field>

      <Field label="Author" hint="Display name shown in the in-game mods list. Free-form.">
        <input
          type="text"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          className={inputCls}
          placeholder="Your name"
        />
      </Field>

      <Field
        label="Description"
        hint="Shown in the in-game mods list. Stored as a single line — line breaks become spaces."
      >
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={`${inputCls} resize-y`}
          placeholder="What this mod does, in a sentence or two."
        />
      </Field>

      {save.error && <ErrorBanner>{save.error}</ErrorBanner>}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={() => void save.run()}
          disabled={!dirty || save.busy}
          className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {save.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Section>
  );
}

/**
 * useState that re-follows its seed: while the current value is whatever the
 * seed last was (i.e. the user hasn't hand-edited it), a new seed — e.g. the
 * mod was renamed in the About section, changing the derived defaults —
 * replaces the value; a hand-edited value is left alone. Mod switches don't
 * come through here: the panel is keyed by folder and remounts.
 */
function useSeededState(seed: string): [string, (v: string) => void] {
  const [value, setValue] = useState(seed);
  const prevSeed = useRef(seed);
  if (seed !== prevSeed.current) {
    if (value === prevSeed.current) setValue(seed);
    prevSeed.current = seed;
  }
  return [value, setValue];
}

const inputCls =
  'w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Seed the next publish's version number: bump the last numeric component of
 * the previously published version (1.0.0 → 1.0.1), or start at 1.0.0 for a mod
 * that's never been published. Modrinth rejects a duplicate version, so a
 * sensible pre-fill beats re-typing — the user can still override it.
 */
function nextVersion(prev: string | undefined): string {
  if (!prev) return '1.0.0';
  const m = prev.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return prev;
  const [, head, num, tail] = m;
  return `${head}${Number(num) + 1}${tail}`;
}

/**
 * Seed Modrinth's required one-line Summary from the mod's description (the
 * agent fills that in at scaffold time), so the field isn't blank on a first
 * publish. Takes the first sentence, collapsed to a single line and capped well
 * under Modrinth's limit. The user can still rewrite it.
 */
function deriveSummary(desc: string): string {
  const flat = desc.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const firstSentence = flat.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() || flat;
  return firstSentence.slice(0, 120).trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function progressLabel(e: ModrinthPublishProgressEvent): string {
  switch (e.status) {
    case 'preparing':
      return 'Building the jar…';
    case 'creating-project':
      return 'Creating the Modrinth project…';
    case 'uploading-version':
      return 'Uploading the version…';
    case 'done':
      return 'Published.';
    case 'error':
      return `Error: ${e.error ?? 'unknown'}`;
  }
}
