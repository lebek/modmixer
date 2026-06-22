import { useEffect, useState } from 'react';
import type { WorkspaceMod } from '../../agent/workspace';
import type {
  ModrinthPublishProgressEvent,
  ModrinthSideSupport,
} from '../../agent/minecraft/modrinth';
import { useAsyncAction } from '@/lib/use-async-action';
import { ErrorBanner, Field, Section } from './ui';

/** Minecraft mods publish to Modrinth (not Steam Workshop). */
export function MinecraftPublishPanel({ mod }: { mod: WorkspaceMod }) {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  // Reveals the token form even when a token is already stored, so a wrong or
  // expired token can be replaced (otherwise publishing would just keep
  // failing with no way back to the input from this panel).
  const [editingToken, setEditingToken] = useState(false);

  // Modrinth project metadata (project-level, applied at first publish).
  const [slug, setSlug] = useState(slugify(mod.about.packageId || mod.about.name));
  const [title, setTitle] = useState(mod.about.name || 'My Mod');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState(mod.about.description || '');
  const [license, setLicense] = useState('MIT');
  const [categories, setCategories] = useState('');
  const [clientSide, setClientSide] = useState<ModrinthSideSupport>('required');
  const [serverSide, setServerSide] = useState<ModrinthSideSupport>('required');

  // Version metadata.
  const [versionNumber, setVersionNumber] = useState('1.0.0');
  const [changelog, setChangelog] = useState('');

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

  const publish = useAsyncAction(async () => {
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
        versionNumber,
        versionType: 'release',
        changelog,
      },
    );
  });

  // The token form shows up front until a token is stored, and on demand
  // afterwards (to replace a bad one). The metadata above is always editable.
  const showTokenForm = hasToken === false || editingToken;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="max-w-xl space-y-6">
          <Section
            title="Modrinth"
            description={
              isUpdate
                ? 'Upload a new version to your existing Modrinth project.'
                : 'Publish this mod to Modrinth. New projects are created as a draft pending Modrinth moderation review before they go public.'
            }
          >
            {!isUpdate && (
              <>
                <Field label="Slug" hint="Lowercase, hyphenated, unique on Modrinth.">
                  <input
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    className={inputCls}
                    placeholder="my-cool-mod"
                  />
                </Field>
                <Field label="Title">
                  <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Summary" hint="One-line description shown in listings.">
                  <input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} className={inputCls} placeholder="A short, punchy summary." />
                </Field>
                <Field label="Description" hint="Full markdown shown on the project page.">
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} className={`${inputCls} resize-y`} />
                </Field>
                <Field label="License (SPDX)" hint='e.g. MIT, Apache-2.0, LGPL-3.0-only. Required by Modrinth.'>
                  <input type="text" value={license} onChange={(e) => setLicense(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Categories" hint="Comma-separated Modrinth category slugs, e.g. utility, technology.">
                  <input type="text" value={categories} onChange={(e) => setCategories(e.target.value)} className={inputCls} placeholder="utility, technology" />
                </Field>
              </>
            )}

            <Field label="Version number" hint="Semver, e.g. 1.0.0. Targets Minecraft 1.21.1 / NeoForge.">
              <input type="text" value={versionNumber} onChange={(e) => setVersionNumber(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Changelog">
              <textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} rows={3} className={`${inputCls} resize-y`} placeholder="What changed in this version." />
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
                    onClick={() => void publish.run()}
                    disabled={publish.busy || !title.trim() || (!isUpdate && !slug.trim())}
                    className="rounded-md bg-ink px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {publish.busy ? 'Publishing…' : isUpdate ? 'Publish update' : 'Publish to Modrinth'}
                  </button>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none';

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
