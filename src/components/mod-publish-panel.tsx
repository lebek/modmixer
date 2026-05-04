import { useEffect, useRef, useState } from 'react';
import type { AboutMetadata, WorkspaceMod } from '../agent/workspace';
import type {
  PublishProgressEvent,
  PublishStatus,
} from '../agent/workshop';
import { derivePackageId } from '@/lib/identifiers';

export function ModPublishPanel({
  mod,
  hasAi,
  onGeneratePreview,
  onDeleted,
}: {
  mod: WorkspaceMod;
  hasAi: boolean;
  onGeneratePreview: () => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(mod.about.name);
  const [packageId, setPackageId] = useState(mod.about.packageId);
  const [author, setAuthor] = useState(mod.about.author);
  const [description, setDescription] = useState(mod.about.description);
  const [defaultAuthor, setDefaultAuthor] = useState('');
  const [savedSnapshot, setSavedSnapshot] = useState<AboutMetadata>(mod.about);
  const [packageIdSticky, setPackageIdSticky] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalUpdate, setExternalUpdate] = useState(false);

  // Publish state
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<PublishProgressEvent | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(
    mod.publishedFileId
      ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedFileId}`
      : null,
  );
  const [agreementUrl, setAgreementUrl] = useState<string | null>(null);

  // Preview image state. About/Preview.png is what Steam ships as the
  // workshop thumbnail; we load it into a data URL so the renderer can
  // display the bytes without a custom file:// scheme handler.
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Delete state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const expectedDeleteText = mod.about.name || mod.folder;

  // Unlink state — drops PublishedFileId.txt so the next publish creates a
  // fresh Workshop item. Useful when the imported mod was someone else's,
  // or the user wants to publish a fork as a separate item.
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  // Link state — manually associate this mod with an existing Workshop ID
  // (e.g. mod was published outside Modmixer or PublishedFileId.txt was lost).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Track the latest defaultAuthor for the sticky-detection initialization.
  const defaultAuthorRef = useRef('');
  defaultAuthorRef.current = defaultAuthor;

  useEffect(() => {
    void window.modmixer.getSettings().then((s) => setDefaultAuthor(s.defaultAuthor));
  }, []);

  const reseedFromAbout = (about: AboutMetadata) => {
    setName(about.name);
    setPackageId(about.packageId);
    setAuthor(about.author);
    setDescription(about.description);
    setSavedSnapshot(about);
    const author = defaultAuthorRef.current || 'author';
    const wouldDerive = derivePackageId(author, about.name);
    setPackageIdSticky(about.packageId !== '' && about.packageId !== wouldDerive);
  };

  useEffect(() => {
    reseedFromAbout(mod.about);
    setExternalUpdate(false);
    setPublishedUrl(
      mod.publishedFileId
        ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedFileId}`
        : null,
    );
    setAgreementUrl(null);
    setPublishError(null);
    setProgress(null);
    setDeleteOpen(false);
    setDeleteConfirmText('');
    setDeleteError(null);
    setUnlinkConfirmOpen(false);
    setUnlinkError(null);
    setLinkOpen(false);
    setLinkInput('');
    setLinkError(null);
  }, [mod.folder]);

  useEffect(() => {
    if (!defaultAuthor) return;
    const pristine =
      name === savedSnapshot.name &&
      packageId === savedSnapshot.packageId &&
      author === savedSnapshot.author &&
      description === savedSnapshot.description;
    if (!pristine) return;
    const wouldDerive = derivePackageId(defaultAuthor, savedSnapshot.name);
    setPackageIdSticky(
      savedSnapshot.packageId !== '' && savedSnapshot.packageId !== wouldDerive,
    );
  }, [defaultAuthor, savedSnapshot, name, packageId, author, description]);

  useEffect(() => {
    const off = window.modmixer.onModChanged(({ folder }) => {
      if (folder !== mod.folder) return;
      void window.modmixer.readModAbout(folder).then((about) => {
        if (!about) return;
        // Disk already matches what's in the form — this is our own save
        // landing (or an external write that happened to converge). Sync
        // the baseline and don't surface an "agent updated" banner.
        const matchesLocal =
          about.name === name &&
          about.packageId === packageId &&
          about.author === author &&
          about.description === description;
        if (matchesLocal) {
          setSavedSnapshot(about);
          setExternalUpdate(false);
          return;
        }
        const isDirty =
          name !== savedSnapshot.name ||
          packageId !== savedSnapshot.packageId ||
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
    return off;
  }, [mod.folder, name, packageId, author, description, savedSnapshot]);

  // Stream upload progress for THIS mod only.
  useEffect(() => {
    const off = window.modmixer.onWorkshopProgress((event) => {
      if (event.folder !== mod.folder) return;
      setProgress(event);
      if (event.agreementUrl) setAgreementUrl(event.agreementUrl);
      if (event.status === 'done' && event.url) {
        setPublishedUrl(event.url);
      }
    });
    return off;
  }, [mod.folder]);

  // Load Preview.png on mount + folder switch + relevant change events.
  // The asset watcher is started by AssetsView/scan paths; we trigger it on
  // mount via scanAssets so file changes (Browse copy, agent write) fire
  // onAssetsChanged for this folder. Re-reads use a cache-busting suffix
  // because the data URL itself doesn't change identity but the bytes do.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const url = await window.modmixer.readAssetDataUrl(
        mod.folder,
        'About/Preview.png',
      );
      if (!cancelled) setPreviewDataUrl(url);
    };
    void refresh();
    void window.modmixer.scanAssets(mod.folder).catch(() => undefined);
    const offAssets = window.modmixer.onAssetsChanged(({ folder }) => {
      if (folder === mod.folder) void refresh();
    });
    return () => {
      cancelled = true;
      offAssets();
    };
  }, [mod.folder]);

  const browsePreview = async () => {
    setPreviewError(null);
    try {
      const sourceAbs = await window.modmixer.pickAssetFile('texture');
      if (!sourceAbs) return;
      setPreviewBusy(true);
      await window.modmixer.addAsset(mod.folder, 'About/Preview.png', sourceAbs);
      const url = await window.modmixer.readAssetDataUrl(
        mod.folder,
        'About/Preview.png',
      );
      setPreviewDataUrl(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(false);
    }
  };

  const onNameChange = (v: string) => {
    setName(v);
    if (!packageIdSticky) {
      setPackageId(derivePackageId(defaultAuthor || 'author', v));
    }
  };

  const onPackageIdChange = (v: string) => {
    setPackageId(v);
    setPackageIdSticky(true);
  };

  const resetPackageIdToAuto = () => {
    setPackageIdSticky(false);
    setPackageId(derivePackageId(defaultAuthor || 'author', name));
  };

  const dirty =
    name !== savedSnapshot.name ||
    packageId !== savedSnapshot.packageId ||
    author !== savedSnapshot.author ||
    description !== savedSnapshot.description;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await window.modmixer.writeModAbout(mod.folder, {
        name,
        packageId,
        author,
        description,
      });
      const about = updated?.about ?? {
        ...savedSnapshot,
        name,
        packageId,
        author,
        description,
      };
      setSavedSnapshot(about);
      setExternalUpdate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const acceptExternal = async () => {
    const fresh = await window.modmixer.readModAbout(mod.folder);
    if (fresh) reseedFromAbout(fresh);
    setExternalUpdate(false);
  };

  const publish = async () => {
    setPublishError(null);
    setProgress(null);
    setAgreementUrl(null);
    setPublishing(true);
    try {
      // Persist any pending edits so what gets uploaded matches what the user sees.
      if (dirty) await save();
      const result = await window.modmixer.publishToWorkshop(mod.folder);
      setPublishedUrl(result.url);
      if (result.agreementUrl) setAgreementUrl(result.agreementUrl);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  };

  const isUpdate = mod.publishedFileId !== null;

  const performUnlink = async () => {
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await window.modmixer.unlinkWorkshopItem(mod.folder);
      // App.tsx's mod:changed listener will refresh `mod`, which clears
      // mod.publishedFileId and removes this UI block on the next render.
      setPublishedUrl(null);
      setUnlinkConfirmOpen(false);
    } catch (err) {
      setUnlinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlinking(false);
    }
  };

  const performLink = async () => {
    setLinking(true);
    setLinkError(null);
    try {
      await window.modmixer.linkWorkshopItem(mod.folder, linkInput);
      // mod:changed will repopulate mod.publishedFileId; flip our local
      // publishedUrl too so the linked URL shows immediately.
      setPublishedUrl(
        `https://steamcommunity.com/sharedfiles/filedetails/?id=${linkInput.trim()}`,
      );
      setLinkOpen(false);
      setLinkInput('');
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  };

  const deleteConfirmMatches =
    deleteConfirmText.trim() === expectedDeleteText.trim() &&
    expectedDeleteText.trim() !== '';

  const performDelete = async () => {
    if (!deleteConfirmMatches) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await window.modmixer.deleteMod(mod.folder);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="max-w-xl space-y-6">
          {externalUpdate && (
            <div className="flex items-start justify-between gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">
              <span>
                The agent updated this mod's metadata while you were editing.
                Your unsaved changes are preserved.
              </span>
              <button
                onClick={() => void acceptExternal()}
                className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-accent hover:underline"
              >
                discard mine
              </button>
            </div>
          )}

          <Section title="About">
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                placeholder="My Cool Mod"
              />
            </Field>

            <Field
              label="Package ID"
              hint={
                packageIdSticky
                  ? 'Manually set. Reset to auto-derive from Name.'
                  : `Auto-derived from Name as ${defaultAuthor || 'author'}.PascalName.`
              }
              action={
                packageIdSticky ? (
                  <button
                    onClick={resetPackageIdToAuto}
                    className="text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
                  >
                    reset to auto
                  </button>
                ) : null
              }
            >
              <input
                type="text"
                value={packageId}
                onChange={(e) => onPackageIdChange(e.target.value)}
                className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                placeholder={`${defaultAuthor || 'author'}.MyCoolMod`}
              />
            </Field>

            <Field
              label="Author"
              hint="Display name shown in RimWorld's mod list. Free-form."
            >
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                placeholder="Your name"
              />
            </Field>

            <Field
              label="Description"
              hint="Shown in RimWorld's in-game mod list and on the Steam Workshop page. Free-form, can run long."
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
                className="w-full resize-y rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                placeholder="What this mod does, how it works, and anything a player needs to know."
              />
            </Field>

            {error && (
              <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </Section>

          <Section
            title="Steam Workshop"
            description={
              isUpdate
                ? 'Push your latest changes as an update to your existing Workshop item.'
                : 'Publish this mod to the Steam Workshop. Steam must be running and you must own RimWorld.'
            }
          >
            <Field
              label="Preview image"
              hint="Shown on the Workshop page and in the in-game browser. 1280×720 recommended."
            >
              <div className="flex items-start gap-3">
                <div className="aspect-video w-40 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
                  {previewDataUrl ? (
                    <img
                      src={previewDataUrl}
                      alt="Preview"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-[0.18em] text-muted">
                      no image
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void browsePreview()}
                      disabled={previewBusy}
                      className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {previewBusy ? 'Copying…' : previewDataUrl ? 'Replace…' : 'Browse…'}
                    </button>
                    <button
                      onClick={onGeneratePreview}
                      disabled={!hasAi || previewBusy}
                      title={
                        !hasAi
                          ? 'Connect an AI provider in Settings to generate.'
                          : undefined
                      }
                      className="rounded-md bg-accent px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {previewDataUrl ? 'Regenerate' : 'Generate'}
                    </button>
                  </div>
                  {previewError && (
                    <div className="rounded-md border border-failed/40 bg-failed/5 px-2.5 py-1.5 text-xs text-failed">
                      {previewError}
                    </div>
                  )}
                </div>
              </div>
            </Field>

            {mod.publishedFileId && (
              <div className="space-y-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                      Workshop item
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted">
                      ID {mod.publishedFileId}
                    </div>
                    {publishedUrl && (
                      <button
                        onClick={() =>
                          void window.modmixer.openExternal(publishedUrl)
                        }
                        className="mt-0.5 block w-full truncate text-left text-accent hover:underline"
                      >
                        {publishedUrl}
                      </button>
                    )}
                  </div>
                  {!unlinkConfirmOpen && (
                    <button
                      onClick={() => {
                        setUnlinkConfirmOpen(true);
                        setUnlinkError(null);
                      }}
                      className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-failed"
                    >
                      disconnect
                    </button>
                  )}
                </div>

                {unlinkConfirmOpen && (
                  <div className="space-y-2 rounded-md border border-failed/40 bg-failed/5 px-2.5 py-2">
                    <p className="text-[11px] text-ink">
                      Disconnecting clears the Workshop link locally so the
                      next publish creates a new item. The existing Workshop
                      item is not deleted.
                    </p>
                    {unlinkError && (
                      <div className="rounded-md border border-failed/40 bg-paper px-2.5 py-1.5 text-[11px] text-failed">
                        {unlinkError}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setUnlinkConfirmOpen(false);
                          setUnlinkError(null);
                        }}
                        disabled={unlinking}
                        className="text-[10px] uppercase tracking-[0.18em] text-muted hover:text-ink disabled:opacity-40"
                      >
                        cancel
                      </button>
                      <button
                        onClick={() => void performUnlink()}
                        disabled={unlinking}
                        className="rounded-md border border-failed/50 bg-paper px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {unlinking ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!mod.publishedFileId && (
              <div className="space-y-2 rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                      Workshop item
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      Not linked. Publishing will create a new Workshop item.
                    </div>
                  </div>
                  {!linkOpen && (
                    <button
                      onClick={() => {
                        setLinkOpen(true);
                        setLinkError(null);
                      }}
                      className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
                    >
                      link existing
                    </button>
                  )}
                </div>

                {linkOpen && (
                  <div className="space-y-2 rounded-md border border-line bg-paper px-2.5 py-2">
                    <p className="text-[11px] text-muted">
                      Paste the Workshop ID to associate this mod with an
                      existing item. Find it in the Steam Workshop URL after
                      <span className="font-mono"> ?id=</span>.
                    </p>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={linkInput}
                      onChange={(e) => setLinkInput(e.target.value)}
                      disabled={linking}
                      autoFocus
                      placeholder="1234567890"
                      className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
                    />
                    {linkError && (
                      <div className="rounded-md border border-failed/40 bg-failed/5 px-2.5 py-1.5 text-[11px] text-failed">
                        {linkError}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setLinkOpen(false);
                          setLinkInput('');
                          setLinkError(null);
                        }}
                        disabled={linking}
                        className="text-[10px] uppercase tracking-[0.18em] text-muted hover:text-ink disabled:opacity-40"
                      >
                        cancel
                      </button>
                      <button
                        onClick={() => void performLink()}
                        disabled={linking || !linkInput.trim()}
                        className="rounded-md bg-ink px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {linking ? 'Linking…' : 'Link'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {agreementUrl && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">
                <span>
                  Steam needs you to accept the Workshop legal agreement once
                  before this item becomes visible.
                </span>
                <button
                  onClick={() => void window.modmixer.openExternal(agreementUrl)}
                  className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-accent hover:underline"
                >
                  open agreement
                </button>
              </div>
            )}

            {publishing && progress && (
              <PublishProgress progress={progress} />
            )}

            {publishError && (
              <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
                {publishError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => void window.modmixer.openFolder(mod.workspacePath)}
                className="text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
              >
                Open mod folder
              </button>
              <button
                onClick={() => void publish()}
                disabled={publishing || !name.trim() || !description.trim()}
                className="rounded-md bg-ink px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {publishing
                  ? 'Publishing…'
                  : isUpdate
                  ? 'Publish update'
                  : 'Publish to Workshop'}
              </button>
            </div>
          </Section>

          <section className="space-y-3 border-t border-failed/30 pt-6">
            <header>
              <h2 className="font-display text-sm font-medium text-failed">
                Danger zone
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                Deleting removes the mod folder from disk, the symlink in
                RimWorld's Mods/ directory, the entry in ModsConfig.xml,
                and any agent chats for this mod. This cannot be undone.
                {mod.publishedFileId && (
                  <>
                    {' '}
                    The Steam Workshop item is <em>not</em> removed —
                    delete it from the Workshop page yourself if you want
                    it gone.
                  </>
                )}
              </p>
            </header>

            {!deleteOpen ? (
              <div className="flex items-center justify-end pt-1">
                <button
                  onClick={() => setDeleteOpen(true)}
                  className="rounded-md border border-failed/50 bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/5"
                >
                  Delete this mod…
                </button>
              </div>
            ) : (
              <div className="space-y-3 rounded-md border border-failed/40 bg-failed/5 px-3 py-3">
                <p className="text-xs text-ink">
                  Type{' '}
                  <span className="rounded bg-paper px-1 py-0.5 font-mono text-[11px] text-failed">
                    {expectedDeleteText}
                  </span>{' '}
                  to confirm.
                </p>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  disabled={deleting}
                  autoFocus
                  className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-failed focus:outline-none"
                  placeholder={expectedDeleteText}
                />
                {deleteError && (
                  <div className="rounded-md border border-failed/40 bg-paper px-3 py-2 text-xs text-failed">
                    {deleteError}
                  </div>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => {
                      setDeleteOpen(false);
                      setDeleteConfirmText('');
                      setDeleteError(null);
                    }}
                    disabled={deleting}
                    className="rounded-md border border-line bg-paper px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void performDelete()}
                    disabled={!deleteConfirmMatches || deleting}
                    className="rounded-md bg-failed px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {deleting ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PublishProgress({ progress }: { progress: PublishProgressEvent }) {
  const pct =
    progress.total && progress.uploaded !== undefined && progress.total > 0
      ? Math.min(100, Math.round((progress.uploaded / progress.total) * 100))
      : null;
  return (
    <div className="rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          {labelForStatus(progress.status)}
        </span>
        {pct !== null && (
          <span className="font-mono text-[10px] text-muted">{pct}%</span>
        )}
      </div>
      {pct !== null && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-line/60">
          <div
            className="h-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function labelForStatus(status: PublishStatus): string {
  switch (status) {
    case 'preparing': return 'Preparing';
    case 'creating-item': return 'Creating Workshop item';
    case 'agreement-required': return 'Awaiting agreement';
    case 'uploading-content': return 'Uploading content';
    case 'uploading-preview': return 'Uploading preview';
    case 'committing': return 'Committing';
    case 'done': return 'Done';
    case 'error': return 'Error';
  }
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="font-display text-sm font-medium text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        )}
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-[0.18em] text-muted">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
