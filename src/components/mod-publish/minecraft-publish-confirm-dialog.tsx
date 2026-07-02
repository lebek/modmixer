import { useState } from 'react';
import type { AboutMetadata } from '../../agent/workspace';

/** Modrinth project fields collected once, at first publish. */
export interface MinecraftProjectFields {
  slug: string;
  title: string;
  summary: string;
  description: string;
  license: string;
  categories: string[];
}

export interface MinecraftPublishConfirmResult {
  versionNumber: string;
  changelog: string;
  /** Present only on a first publish — the Modrinth project to create. */
  project?: MinecraftProjectFields;
}

/**
 * Final gate before pushing a Minecraft mod to Modrinth. Always collects the
 * per-version fields (version number, changelog). On a FIRST publish it also
 * collects the Modrinth project fields, seeded from the mod's identity — this
 * is deliberately the only place they exist in Modmixer: once the project is
 * created, Modrinth owns them and edits happen on modrinth.com.
 */
export function MinecraftPublishConfirmDialog({
  open,
  isUpdate,
  about,
  defaultVersion,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  isUpdate: boolean;
  about: AboutMetadata;
  defaultVersion: string;
  onCancel: () => void;
  onConfirm: (result: MinecraftPublishConfirmResult) => void;
}) {
  const [versionNumber, setVersionNumber] = useState(defaultVersion);
  const [changelog, setChangelog] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('MIT');
  const [categories, setCategories] = useState('');

  // Everything reseeds on the closed→open transition (and only then, so a
  // background agent edit can't clobber in-dialog typing): version/changelog
  // are per-publish, and the project fields derive fresh from the mod's
  // current identity — there is no long-lived form to drift out of sync.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setVersionNumber(defaultVersion);
      setChangelog('');
      if (!isUpdate) {
        setTitle(about.name || 'My Mod');
        setSlug(slugify(about.packageId || about.name));
        setSummary(deriveSummary(about.description || ''));
        setDescription(about.description || '');
        setLicense('MIT');
        setCategories('');
      }
    }
  }

  if (!open) return null;

  const projectOk =
    isUpdate ||
    (title.trim().length > 0 &&
      slugify(slug).length > 0 &&
      summary.trim().length > 0 &&
      license.trim().length > 0);
  const canConfirm = versionNumber.trim().length > 0 && projectOk;

  const confirm = () =>
    onConfirm({
      versionNumber: versionNumber.trim(),
      changelog,
      ...(isUpdate
        ? {}
        : {
            project: {
              slug: slugify(slug),
              title: title.trim(),
              summary: summary.trim(),
              description,
              license: license.trim(),
              categories: categories
                .split(',')
                .map((c) => c.trim().toLowerCase())
                .filter(Boolean),
            },
          }),
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-md border border-line bg-paper shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            modmixer · modrinth
          </div>
          <div className="mt-1 text-sm font-medium text-ink">
            {isUpdate ? 'Publish update?' : 'Publish to Modrinth?'}
          </div>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3 text-sm text-ink">
          <p>
            {isUpdate ? (
              <>
                Upload a new version of{' '}
                <span className="font-medium">{about.name}</span> to its
                existing Modrinth project.
              </>
            ) : (
              <>
                <span className="font-medium">{about.name}</span> will be
                created on Modrinth as a draft, pending moderation review
                before it's public. Its project details are set once here —
                afterwards you edit them on modrinth.com.
              </>
            )}
          </p>

          {!isUpdate && (
            <>
              <DialogField label="Title">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputCls}
                />
              </DialogField>
              <DialogField
                label="Slug"
                hint="The project's URL: modrinth.com/mod/<slug>. Lowercase, hyphenated, unique on Modrinth."
              >
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className={inputCls}
                  placeholder="my-cool-mod"
                />
              </DialogField>
              <DialogField
                label="Summary"
                hint="One-line description shown in listings. Required by Modrinth."
              >
                <input
                  type="text"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  className={inputCls}
                  placeholder="A short, punchy summary."
                />
              </DialogField>
              <DialogField
                label="Description"
                hint="Full markdown shown on the project page."
              >
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className={`${inputCls} resize-y`}
                />
              </DialogField>
              <DialogField
                label="License (SPDX)"
                hint="e.g. MIT, Apache-2.0, LGPL-3.0-only. Required by Modrinth."
              >
                <input
                  type="text"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  className={inputCls}
                />
              </DialogField>
              <DialogField
                label="Categories"
                hint="Comma-separated Modrinth category slugs, e.g. utility, technology. Optional."
              >
                <input
                  type="text"
                  value={categories}
                  onChange={(e) => setCategories(e.target.value)}
                  className={inputCls}
                  placeholder="utility, technology"
                />
              </DialogField>
            </>
          )}

          <DialogField
            label="Version number"
            hint="Semver, unique per upload. Baked into the jar. Targets Minecraft 1.21.1 / NeoForge."
          >
            <input
              type="text"
              value={versionNumber}
              onChange={(e) => setVersionNumber(e.target.value)}
              className={inputCls}
              placeholder="1.0.0"
            />
          </DialogField>

          <DialogField
            label="Changelog"
            hint="Shown on the version's Modrinth page. Leave blank to skip."
          >
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={4}
              className={`${inputCls} resize-y`}
              placeholder="What changed in this version?"
            />
          </DialogField>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            className="rounded-md bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isUpdate ? 'Publish update' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DialogField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
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
