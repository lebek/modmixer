import { useEffect, useRef, useState } from 'react';
import type { AboutMetadata, WorkspaceMod } from '../agent/workspace';
import type {
  PublishProgressEvent,
  PublishStatus,
} from '../agent/workshop';
import { derivePackageId } from '@/lib/identifiers';

export function ModPublishPanel({ mod }: { mod: WorkspaceMod }) {
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
            {publishedUrl && (
              <div className="rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  Workshop item
                </div>
                <button
                  onClick={() => void window.modmixer.openExternal(publishedUrl)}
                  className="mt-0.5 truncate text-left text-accent hover:underline"
                >
                  {publishedUrl}
                </button>
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
