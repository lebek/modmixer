import { useEffect, useRef, useState } from 'react';
import type { AboutMetadata, WorkspaceMod } from '../agent/workspace';
import type { PublishProgressEvent } from '../agent/rimworld/workshop';
import { getGame } from '../agent/games/registry';
import { derivePackageId } from '@/lib/identifiers';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field, PublishProgress, Section } from './mod-publish/ui';
import { PreviewImage } from './mod-publish/preview-image';
import {
  LinkExistingControl,
  UnlinkExistingControl,
} from './mod-publish/link-controls';
import { DangerZone } from './mod-publish/danger-zone';
import { PublishConfirmDialog } from './mod-publish/publish-confirm-dialog';
import { MinecraftPublishPanel } from './mod-publish/minecraft-publish-panel';

export function ModPublishPanel(props: {
  mod: WorkspaceMod;
  hasAi: boolean;
  onGeneratePreview: () => void;
  onDeleted?: () => void;
}) {
  // Non-Workshop games (Minecraft → Modrinth) keep their identity in a different
  // manifest and get a separate panel. Branch here (before any hooks) so each
  // panel keeps a stable hook order.
  if (!getGame(props.mod.prefs.game).capabilities.steamWorkshop) {
    return <MinecraftPublishPanel mod={props.mod} onDeleted={props.onDeleted} />;
  }
  return <RimWorldPublishPanel {...props} />;
}

function RimWorldPublishPanel({
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
  const [externalUpdate, setExternalUpdate] = useState(false);

  const [progress, setProgress] = useState<PublishProgressEvent | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(
    workshopUrlFor(mod.publishedFileId),
  );
  const [agreementUrl, setAgreementUrl] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Track the latest defaultAuthor so the sticky-detection effect doesn't
  // need it as a dep (it would otherwise re-run too often).
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
    const a = defaultAuthorRef.current || 'author';
    const wouldDerive = derivePackageId(a, about.name);
    setPackageIdSticky(about.packageId !== '' && about.packageId !== wouldDerive);
  };

  useEffect(() => {
    reseedFromAbout(mod.about);
    setExternalUpdate(false);
    setPublishedUrl(workshopUrlFor(mod.publishedFileId));
    setAgreementUrl(null);
    setProgress(null);
    setConfirmOpen(false);
    // reseedFromAbout is stable enough for our purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.folder]);

  // If the agent rewrites About.xml while the user is editing, surface a
  // banner so they can choose to discard their unsaved changes.
  useEffect(() => {
    return window.modmixer.onModChanged(({ folder }) => {
      if (folder !== mod.folder) return;
      void window.modmixer.readModAbout(folder).then((about) => {
        if (!about) return;
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
  }, [mod.folder, name, packageId, author, description, savedSnapshot]);

  // Stream upload progress for THIS mod only.
  useEffect(() => {
    return window.modmixer.onWorkshopProgress((event) => {
      if (event.folder !== mod.folder) return;
      setProgress(event);
      if (event.agreementUrl) setAgreementUrl(event.agreementUrl);
      if (event.status === 'done' && event.url) setPublishedUrl(event.url);
    });
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

  const save = useAsyncAction(async () => {
    const updated = await window.modmixer.writeModAbout(mod.folder, {
      name,
      packageId,
      author,
      description,
    });
    const about =
      updated?.about ?? { ...savedSnapshot, name, packageId, author, description };
    setSavedSnapshot(about);
    setExternalUpdate(false);
  });

  const acceptExternal = async () => {
    const fresh = await window.modmixer.readModAbout(mod.folder);
    if (fresh) reseedFromAbout(fresh);
    setExternalUpdate(false);
  };

  const publish = useAsyncAction(
    async ({
      visibility,
      changeNote,
      trackOnLeaderboard,
    }: {
      visibility: number;
      changeNote: string;
      trackOnLeaderboard: boolean;
    }) => {
      setProgress(null);
      setAgreementUrl(null);
      // Persist any pending edits so what gets uploaded matches what's on screen.
      if (dirty) {
        const ok = await save.run();
        if (ok === null) return;
      }
      const result = await window.modmixer.publishToWorkshop(
        mod.folder,
        visibility,
        changeNote,
        trackOnLeaderboard,
      );
      setPublishedUrl(result.url);
      if (result.agreementUrl) setAgreementUrl(result.agreementUrl);
    },
  );

  const isUpdate = mod.publishedFileId !== null;

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

            <Field label="Author" hint="Display name shown in RimWorld's mod list. Free-form.">
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

          <Section
            title="Steam Workshop"
            description={
              isUpdate
                ? 'Push your latest changes as an update to your existing Workshop item.'
                : 'Publish this mod to the Steam Workshop. Steam must be running and you must own RimWorld.'
            }
          >
            <PreviewImage
              modFolder={mod.folder}
              hasAi={hasAi}
              onGeneratePreview={onGeneratePreview}
            />

            {mod.publishedFileId ? (
              <UnlinkExistingControl
                modFolder={mod.folder}
                publishedFileId={mod.publishedFileId}
                publishedUrl={publishedUrl}
                lastPublishedAt={mod.prefs.lastPublishedAt}
                onUnlinked={() => setPublishedUrl(null)}
              />
            ) : (
              <LinkExistingControl
                modFolder={mod.folder}
                onLinked={(id) => setPublishedUrl(workshopUrlFor(id))}
              />
            )}

            {agreementUrl && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">
                <span>
                  Steam needs you to accept the Workshop legal agreement once before this item becomes visible.
                </span>
                <button
                  onClick={() => void window.modmixer.openExternal(agreementUrl)}
                  className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-accent hover:underline"
                >
                  open agreement
                </button>
              </div>
            )}

            {publish.busy && progress && <PublishProgress progress={progress} />}

            {publish.error && <ErrorBanner>{publish.error}</ErrorBanner>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => void window.modmixer.openFolder(mod.workspacePath)}
                className="text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
              >
                Open mod folder
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={publish.busy || !name.trim() || !description.trim()}
                className="rounded-md bg-ink px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {publish.busy
                  ? 'Publishing…'
                  : isUpdate
                  ? 'Publish update'
                  : 'Publish to Workshop'}
              </button>
            </div>
          </Section>

          <DangerZone
            modFolder={mod.folder}
            expectedConfirmText={mod.about.name || mod.folder}
            hasWorkshopItem={mod.publishedFileId !== null}
            onDeleted={onDeleted}
          />
        </div>
      </div>

      <PublishConfirmDialog
        open={confirmOpen}
        isUpdate={isUpdate}
        modName={name}
        initialTrackOnLeaderboard={mod.prefs.trackOnLeaderboard}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={(result) => {
          setConfirmOpen(false);
          void publish.run(result);
        }}
      />
    </div>
  );
}

function workshopUrlFor(id: string | null): string | null {
  return id
    ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
    : null;
}
