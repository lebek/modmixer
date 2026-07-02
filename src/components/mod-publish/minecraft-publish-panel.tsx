import { useEffect, useState } from 'react';
import type { AboutMetadata, WorkspaceMod } from '../../agent/workspace';
import type { ModrinthPublishProgressEvent } from '../../agent/minecraft/modrinth';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field, Section } from './ui';
import {
  MinecraftPublishConfirmDialog,
  type MinecraftPublishConfirmResult,
} from './minecraft-publish-confirm-dialog';
import { DangerZone } from './danger-zone';

/**
 * Minecraft mods publish to Modrinth (not Steam Workshop). The panel holds the
 * mod's own identity (gradle.properties, editable any time) plus the publish
 * action; Modrinth project metadata is collected once in the first-publish
 * dialog and owned on modrinth.com afterwards — nothing here to go stale.
 */
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

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<ModrinthPublishProgressEvent | null>(null);
  // Project URLs are id-based: modrinth.com resolves ids, and unlike a slug an
  // id can't be renamed on the site out from under our stored link.
  const [publishedUrl, setPublishedUrl] = useState<string | null>(
    mod.prefs.modrinthProjectId
      ? `https://modrinth.com/mod/${mod.prefs.modrinthProjectId}`
      : null,
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

  const publish = useAsyncAction(async (result: MinecraftPublishConfirmResult) => {
    setProgress(null);
    await window.modmixer.publishToModrinth(
      mod.folder,
      // Project fields exist only on a first publish. Side support has no UI
      // control yet; Modrinth requires both, default 'required'.
      result.project
        ? { ...result.project, clientSide: 'required', serverSide: 'required' }
        : null,
      {
        versionNumber: result.versionNumber,
        versionType: 'release',
        changelog: result.changelog,
      },
    );
  });

  // The token form shows up front until a token is stored, and on demand
  // afterwards (to replace a bad one).
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
                ? 'Upload a new version to your existing Modrinth project. Project details (title, description, categories, …) are edited on Modrinth itself.'
                : "Publish this mod to Modrinth. You'll set the project details in the next step; new projects are created as a draft pending Modrinth moderation review before they go public."
            }
          >
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
                    disabled={publish.busy}
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
        about={mod.about}
        defaultVersion={defaultVersion(mod)}
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
 * editable at any time (unlike those, which Modrinth owns after first
 * publish). Mirrors the RimWorld panel's About section, including the banner
 * shown when the agent rewrites the metadata mid-edit.
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

const inputCls =
  'w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Seed the publish dialog's version. gradle.properties is the authority — the
 * mod's version IS what's baked into the jar — so a hand-bumped (or
 * agent-bumped) version is offered as-is. Only when it still equals the last
 * published version do we suggest the next patch bump (Modrinth rejects
 * duplicate version numbers). Falls back to bumping the last published
 * version for mods whose gradle.properties is missing/unreadable.
 */
function defaultVersion(mod: WorkspaceMod): string {
  const gradleVersion = mod.about.version?.trim();
  if (!gradleVersion) return nextVersion(mod.prefs.modrinthVersion);
  return gradleVersion === mod.prefs.modrinthVersion
    ? nextVersion(gradleVersion)
    : gradleVersion;
}

/**
 * Bump the last numeric component of a version (1.0.0 → 1.0.1), or start at
 * 1.0.0 when there's nothing to bump.
 */
function nextVersion(prev: string | undefined): string {
  if (!prev) return '1.0.0';
  const m = prev.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return prev;
  const [, head, num, tail] = m;
  return `${head}${Number(num) + 1}${tail}`;
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
