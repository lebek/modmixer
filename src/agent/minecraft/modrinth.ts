import { app, safeStorage } from 'electron';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MINECRAFT_VERSION, LOADER } from './versions.js';

/**
 * Self-contained Modrinth publishing client (Modrinth API v2).
 *
 * Modrinth is the host ModMixer publishes Minecraft NeoForge mods to. This
 * module mirrors, at a high level, the shape of the Steam Workshop publisher
 * (src/agent/workshop.ts): a `PublishStatus` union, a `PublishProgressEvent`
 * with an `onProgress` callback, typed metadata inputs, and a single
 * high-level `publishToModrinth` orchestrator that emits progress events as it
 * walks the phases.
 *
 * API reference: https://docs.modrinth.com/api/ (v2 is official + stable).
 *
 * Rate limit: the API allows 300 requests/minute per IP. A normal publish
 * makes at most a handful of calls, so we don't bother with client-side
 * throttling — but bulk callers should pace themselves, and we surface a
 * 429 with an actionable message (see handleErrorResponse) so a backed-off
 * retry is the obvious next step.
 */

const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';

/** Web URL for a project page, given its slug (or id). */
function projectWebUrl(slugOrId: string): string {
  return `https://modrinth.com/mod/${slugOrId}`;
}

// --------------------------------------------------------------------------
// Token storage (Electron safeStorage)
// --------------------------------------------------------------------------

/**
 * The Modrinth Personal Access Token (PAT) is a secret and must never live in
 * plaintext settings.json. We persist it the same way the OAuth backend
 * persists tokens (src/agent/security/secure-auth-storage.ts): encrypted via
 * Electron's safeStorage into a small file under userData.
 *
 * Storage file: <userData>/modrinth-token.enc
 *
 * Fallback: if safeStorage.isEncryptionAvailable() is false (e.g. Linux with
 * no keyring, or before app.ready on some platforms) we store the token
 * base64-encoded with a leading marker so we can tell the two encodings apart
 * on read. base64 is NOT encryption — it only avoids casual shoulder-surfing
 * of the on-disk bytes. This is a deliberate, last-resort fallback so the
 * publish flow still works on a keyring-less machine; the token is the user's
 * own PAT, scoped to their Modrinth account, and they can revoke it any time.
 */

/** Marks a file written with the base64 (non-encrypted) fallback encoding. */
const PLAINTEXT_FALLBACK_MARKER = 'mmx-b64:';

function tokenFilePath(): string {
  return path.join(app.getPath('userData'), 'modrinth-token.enc');
}

function encryptionAvailable(): boolean {
  // safeStorage may report false before app.ready on some platforms; callers
  // run well after ready, but guard defensively all the same.
  if (!app.isReady()) return false;
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Read and decrypt the stored Modrinth PAT, or null if none is stored (or it
 * could not be decoded — e.g. the keyring changed and the ciphertext is no
 * longer readable, in which case the user must re-enter the token).
 */
export function getModrinthToken(): string | null {
  const file = tokenFilePath();
  if (!existsSync(file)) return null;

  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return null;
  }
  if (raw.length === 0) return null;

  const asText = raw.toString('utf-8');
  if (asText.startsWith(PLAINTEXT_FALLBACK_MARKER)) {
    // base64 fallback encoding — decode and return.
    const b64 = asText.slice(PLAINTEXT_FALLBACK_MARKER.length);
    try {
      const token = Buffer.from(b64, 'base64').toString('utf-8').trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  // Otherwise the file holds a safeStorage ciphertext blob.
  if (!encryptionAvailable()) {
    // Encryption was available when we wrote, but isn't now — we can't read it.
    console.warn(
      '[modmixer:modrinth] safeStorage unavailable; cannot decrypt stored token. ' +
        'Re-enter your Modrinth token.',
    );
    return null;
  }
  try {
    const token = safeStorage.decryptString(raw).trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    console.error('[modmixer:modrinth] Failed to decrypt Modrinth token:', err);
    return null;
  }
}

/**
 * Encrypt (or, as a fallback, base64-encode) and persist the Modrinth PAT.
 * Throws if `token` is blank — clearing should go through clearModrinthToken.
 */
export function setModrinthToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error('Modrinth token is empty. Paste a valid Personal Access Token.');
  }

  const file = tokenFilePath();
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (encryptionAvailable()) {
    const blob = safeStorage.encryptString(trimmed);
    writeFileSync(file, blob);
  } else {
    console.warn(
      '[modmixer:modrinth] safeStorage is not available on this system. ' +
        'Storing the Modrinth token base64-encoded (NOT encrypted) as a fallback.',
    );
    const b64 = Buffer.from(trimmed, 'utf-8').toString('base64');
    writeFileSync(file, `${PLAINTEXT_FALLBACK_MARKER}${b64}`, 'utf-8');
  }
  // Tighten permissions regardless of encoding — the file holds a secret.
  try {
    chmodSync(file, 0o600);
  } catch {
    // chmod is best-effort (e.g. on Windows); the encryption/encoding above is
    // the real protection.
  }
}

/** True when a Modrinth PAT is stored and readable. */
export function hasModrinthToken(): boolean {
  return getModrinthToken() !== null;
}

/** Remove the stored Modrinth PAT. Idempotent. */
export function clearModrinthToken(): void {
  const file = tokenFilePath();
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Read the token, throwing a clear error when none is configured. */
function requireToken(): string {
  const token = getModrinthToken();
  if (!token) {
    throw new Error(
      'No Modrinth token configured. Create a Personal Access Token at ' +
        'https://modrinth.com/settings/pats (with the "Create projects" and ' +
        '"Create versions" scopes) and save it in ModMixer first.',
    );
  }
  return token;
}

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/** Modrinth side-support enum, used for both client_side and server_side. */
export type ModrinthSideSupport = 'required' | 'optional' | 'unsupported';

/** Modrinth version channel. */
export type ModrinthVersionType = 'release' | 'beta' | 'alpha';

/** How a declared dependency relates to the version being published. */
export type ModrinthDependencyType =
  | 'required'
  | 'optional'
  | 'incompatible'
  | 'embedded';

/**
 * A single declared dependency on another Modrinth project or version. At
 * least one of `projectId` / `versionId` should be set (Modrinth accepts a
 * project-level dependency without pinning a specific version).
 */
export interface ModrinthDependency {
  /** Target project id (or slug). */
  projectId?: string;
  /** Target version id, when pinning to an exact version. */
  versionId?: string;
  dependencyType: ModrinthDependencyType;
}

/**
 * Project-level metadata used when first creating a Modrinth project. These
 * map onto the POST /v2/project body. Edits a user makes on Modrinth's site
 * after creation are theirs to keep — on re-publish we reuse the existing
 * project id and only push a new version (see publishToModrinth), so this
 * metadata is applied once at creation time.
 */
export interface ModrinthPublishMeta {
  /** URL slug, e.g. "my-cool-mod". Lowercase, hyphenated, unique on Modrinth. */
  slug: string;
  /** Display title. */
  title: string;
  /** Short one-line summary (Modrinth `description` field). */
  summary: string;
  /** Full long-form description as markdown (Modrinth `body` field). */
  description: string;
  /** Modrinth category slugs, e.g. ["technology", "utility"]. */
  categories: string[];
  /** SPDX license id, e.g. "MIT", "Apache-2.0", "LGPL-3.0-only". */
  license: string;
  clientSide: ModrinthSideSupport;
  serverSide: ModrinthSideSupport;
  /** Optional source-code repository URL. */
  sourceUrl?: string;
  /** Optional issue-tracker URL. */
  issuesUrl?: string;
  /**
   * Optional path to a project icon (png/jpeg/gif/webp). Note: the create-
   * project endpoint takes the icon as a separate multipart file part; we
   * record the path here and attach it when creating the project.
   */
  iconPath?: string;
}

/**
 * Version-level metadata used when uploading a build. Maps onto the JSON
 * `data` field of POST /v2/version. The built jar is attached as the file
 * part separately (see publishToModrinth).
 */
export interface ModrinthVersionMeta {
  /** Semver-ish version number, e.g. "1.0.0" or "1.2.3+1.21.1". */
  versionNumber: string;
  /** Release channel. */
  versionType: ModrinthVersionType;
  /** Markdown changelog for this version. */
  changelog: string;
  /** Game versions this build supports. Defaults to [MINECRAFT_VERSION]. */
  gameVersions?: string[];
  /** Mod loaders this build supports. Defaults to [LOADER] ('neoforge'). */
  loaders?: string[];
  /** Optional dependency declarations. */
  dependencies?: ModrinthDependency[];
  /** Optional human-friendly version name. Defaults to the version number. */
  name?: string;
  /** Whether to feature this version on the project page. Defaults to true. */
  featured?: boolean;
}

/** Result of creating (or resolving) a project. */
export interface ModrinthProjectResult {
  projectId: string;
  slug: string;
  /** Public project page URL. */
  url: string;
  /**
   * True when this project was freshly created (and is therefore a draft that
   * Modrinth must review before it becomes publicly visible).
   */
  created: boolean;
}

/** Result of creating a version. */
export interface ModrinthVersionResult {
  versionId: string;
  versionNumber: string;
}

/** Final result of publishToModrinth. */
export interface ModrinthPublishResult {
  projectId: string;
  slug: string;
  versionId: string;
  versionNumber: string;
  /** Public project page URL. */
  url: string;
  /**
   * True when the project was created in this call. A newly-created project is
   * a draft pending Modrinth moderation review and won't be publicly listed
   * until approved.
   */
  projectCreated: boolean;
}

// --------------------------------------------------------------------------
// Progress events (mirrors workshop.ts PublishProgressEvent style)
// --------------------------------------------------------------------------

export type ModrinthPublishStatus =
  | 'preparing'
  | 'creating-project'
  | 'uploading-version'
  | 'done'
  | 'error';

export interface ModrinthPublishProgressEvent {
  status: ModrinthPublishStatus;
  /** Project id, available once the project is created/resolved. */
  projectId?: string;
  /** Project slug, available once the project is created/resolved. */
  slug?: string;
  /** Version id, set once the version upload returns. */
  versionId?: string;
  /** Public project page URL, set when status === 'done'. */
  url?: string;
  /**
   * Set on a 'done' for a freshly-created project: it's a draft awaiting
   * Modrinth's moderation review before it goes public.
   */
  awaitingReview?: boolean;
  /** Set when status === 'error'. */
  error?: string;
}

type ProgressHandler = (event: ModrinthPublishProgressEvent) => void;

// --------------------------------------------------------------------------
// Low-level HTTP helpers
// --------------------------------------------------------------------------

/** Shape of a Modrinth API error body: { error, description }. */
interface ModrinthErrorBody {
  error?: string;
  description?: string;
}

/**
 * User-Agent Modrinth asks API clients to set so they can identify traffic.
 * Format guidance: project/version (contact). Falls back to a generic string
 * if app.getVersion() is unavailable (e.g. outside a packaged app).
 */
function userAgent(): string {
  let version = '0.0.0';
  try {
    version = app.getVersion();
  } catch {
    // not in an Electron app context — keep the default.
  }
  return `modmixer/${version} (https://modmixer.com)`;
}

/**
 * Turn a non-2xx Modrinth response into a thrown Error with an actionable
 * message. Modrinth returns { error, description } JSON on failures; we map
 * the common status codes to guidance a modder can act on.
 */
async function handleErrorResponse(res: Response, context: string): Promise<never> {
  let body: ModrinthErrorBody = {};
  let rawText = '';
  try {
    rawText = await res.text();
    if (rawText) body = JSON.parse(rawText) as ModrinthErrorBody;
  } catch {
    // Non-JSON error body — keep the raw text for the fallback message.
  }

  const detail = body.description || rawText || res.statusText;
  const code = body.error ? ` (${body.error})` : '';

  switch (res.status) {
    case 401:
      throw new Error(
        `Modrinth rejected the token while ${context}: not authorized${code}. ` +
          'Check that your Personal Access Token is valid and has the right scopes ' +
          '("Create projects" / "Create versions"), then re-enter it.',
      );
    case 403:
      throw new Error(
        `Modrinth forbade the request while ${context}${code}. The token may lack the ` +
          `required scope, or you may not own this project. ${detail}`,
      );
    case 404:
      throw new Error(
        `Modrinth could not find the target while ${context}${code}. If you reused a ` +
          `project id, confirm it still exists. ${detail}`,
      );
    case 422:
      throw new Error(
        `Modrinth rejected the request data while ${context}${code}: ${detail}. ` +
          'Common causes: an unknown SPDX license id, a game version Modrinth does not ' +
          'recognize, an unavailable slug, or an invalid loader/category slug.',
      );
    case 429:
      throw new Error(
        `Modrinth rate limit hit while ${context}${code}. The API allows 300 requests ` +
          'per minute — wait a moment and try again.',
      );
    default:
      throw new Error(
        `Modrinth request failed while ${context} (HTTP ${res.status})${code}: ${detail}`,
      );
  }
}

/** Issue an authenticated JSON GET and parse the body. */
async function apiGetJson<T>(token: string, endpoint: string, context: string): Promise<T> {
  const res = await fetch(`${MODRINTH_API_BASE}${endpoint}`, {
    method: 'GET',
    headers: {
      // Modrinth PATs are sent raw in Authorization — NOT as a Bearer token.
      Authorization: token,
      'User-Agent': userAgent(),
    },
  });
  if (!res.ok) await handleErrorResponse(res, context);
  return (await res.json()) as T;
}

// --------------------------------------------------------------------------
// Tag validation helpers (optional)
// --------------------------------------------------------------------------

interface LoaderTag {
  name: string;
  supported_project_types?: string[];
}

interface GameVersionTag {
  version: string;
  version_type?: string;
}

/** Fetch the list of loader slugs Modrinth knows about. */
export async function fetchLoaders(token: string = requireToken()): Promise<string[]> {
  const tags = await apiGetJson<LoaderTag[]>(token, '/tag/loader', 'fetching loader tags');
  return tags.map((t) => t.name);
}

/** Fetch the list of game-version strings Modrinth knows about. */
export async function fetchGameVersions(token: string = requireToken()): Promise<string[]> {
  const tags = await apiGetJson<GameVersionTag[]>(
    token,
    '/tag/game_version',
    'fetching game-version tags',
  );
  return tags.map((t) => t.version);
}

/**
 * Optional preflight: confirm the requested loaders and game versions are
 * slugs Modrinth recognizes, so the user gets a clear local error instead of
 * an opaque 422 at upload time. Throws on the first unknown value.
 */
export async function validateVersionTags(
  loaders: string[],
  gameVersions: string[],
  token: string = requireToken(),
): Promise<void> {
  const [knownLoaders, knownVersions] = await Promise.all([
    fetchLoaders(token),
    fetchGameVersions(token),
  ]);
  const loaderSet = new Set(knownLoaders);
  for (const loader of loaders) {
    if (!loaderSet.has(loader)) {
      throw new Error(
        `Unknown Modrinth loader "${loader}". Known loaders include: ` +
          `${knownLoaders.slice(0, 10).join(', ')}…`,
      );
    }
  }
  const versionSet = new Set(knownVersions);
  for (const version of gameVersions) {
    if (!versionSet.has(version)) {
      throw new Error(
        `Modrinth does not recognize game version "${version}". ` +
          'Check src/agent/minecraft/versions.ts against Modrinth\'s game_version tags.',
      );
    }
  }
}

// --------------------------------------------------------------------------
// Create project
// --------------------------------------------------------------------------

interface CreateProjectResponse {
  id: string;
  slug: string;
}

/**
 * Create a new Modrinth project (POST /v2/project). The project is created as
 * a DRAFT and must be submitted for and pass Modrinth's moderation review
 * before it is publicly listed. The returned id/slug can be reused for future
 * version uploads (which then skip re-review of the project itself).
 *
 * The endpoint is multipart/form-data: a JSON `data` field plus optional image
 * file parts. We send the metadata as `data`; if an iconPath is provided we
 * attach it as the `icon` file part and reference it in data.icon.
 */
export async function createModrinthProject(
  meta: ModrinthPublishMeta,
  token: string = requireToken(),
): Promise<ModrinthProjectResult> {
  if (!meta.slug.trim()) throw new Error('A project slug is required to create a Modrinth project.');
  if (!meta.title.trim()) throw new Error('A project title is required to create a Modrinth project.');
  if (!meta.summary.trim()) {
    throw new Error('A short project summary (description) is required to create a Modrinth project.');
  }
  if (!meta.license.trim()) {
    throw new Error(
      'An SPDX license id is required (e.g. "MIT", "Apache-2.0", "All-Rights-Reserved"). ' +
        'Modrinth rejects projects without a license.',
    );
  }

  const form = new FormData();

  // The shape Modrinth expects in the JSON `data` field. project_type is
  // always 'mod' for ModMixer's NeoForge output.
  const data: Record<string, unknown> = {
    slug: meta.slug,
    title: meta.title,
    description: meta.summary,
    body: meta.description,
    categories: meta.categories,
    client_side: meta.clientSide,
    server_side: meta.serverSide,
    project_type: 'mod',
    license_id: meta.license,
    is_draft: true,
    // initial_versions is required by the schema; an empty array creates the
    // bare draft project, and we upload the build via POST /v2/version next.
    initial_versions: [],
  };
  if (meta.sourceUrl) data.source_url = meta.sourceUrl;
  if (meta.issuesUrl) data.issues_url = meta.issuesUrl;

  let iconBytes: Buffer | undefined;
  if (meta.iconPath) {
    try {
      iconBytes = await fsp.readFile(meta.iconPath);
    } catch (err) {
      throw new Error(
        `Could not read project icon at ${meta.iconPath}: ${(err as Error).message}`,
      );
    }
    // Modrinth reads the icon from the file part whose name we list here.
    data.icon = path.basename(meta.iconPath);
  }

  form.append('data', JSON.stringify(data));
  if (iconBytes && meta.iconPath) {
    const fileName = path.basename(meta.iconPath);
    form.append(
      'icon',
      new Blob([new Uint8Array(iconBytes)]),
      fileName,
    );
  }

  const res = await fetch(`${MODRINTH_API_BASE}/project`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'User-Agent': userAgent(),
    },
    body: form,
  });
  if (!res.ok) await handleErrorResponse(res, 'creating the Modrinth project');

  const created = (await res.json()) as CreateProjectResponse;
  return {
    projectId: created.id,
    slug: created.slug,
    url: projectWebUrl(created.slug),
    created: true,
  };
}

// --------------------------------------------------------------------------
// Create version (upload jar)
// --------------------------------------------------------------------------

interface CreateVersionResponse {
  id: string;
  version_number: string;
}

/**
 * Upload a build as a new version of an existing project (POST /v2/version).
 *
 * The endpoint is multipart/form-data: a JSON `data` field plus one or more
 * file parts named in `data.file_parts`. We attach the jar as the part named
 * "file" and mark it the primary file.
 */
export async function createModrinthVersion(
  projectId: string,
  jarPath: string,
  version: ModrinthVersionMeta,
  token: string = requireToken(),
): Promise<ModrinthVersionResult> {
  if (!version.versionNumber.trim()) {
    throw new Error('A version number (semver) is required to upload a Modrinth version.');
  }

  let jarBytes: Buffer;
  try {
    jarBytes = await fsp.readFile(jarPath);
  } catch (err) {
    throw new Error(
      `Could not read the built jar at ${jarPath}: ${(err as Error).message}. ` +
        'Build the mod before publishing.',
    );
  }
  const jarName = path.basename(jarPath);

  const gameVersions = version.gameVersions ?? [MINECRAFT_VERSION];
  const loaders = version.loaders ?? [LOADER];

  // Map our ModrinthDependency into Modrinth's wire shape. Modrinth keys are
  // project_id / version_id / dependency_type; only the ids that are present
  // are sent.
  const dependencies = (version.dependencies ?? []).map((dep) => {
    const wire: Record<string, string> = { dependency_type: dep.dependencyType };
    if (dep.projectId) wire.project_id = dep.projectId;
    if (dep.versionId) wire.version_id = dep.versionId;
    return wire;
  });

  const data: Record<string, unknown> = {
    project_id: projectId,
    name: version.name ?? version.versionNumber,
    version_number: version.versionNumber,
    changelog: version.changelog,
    dependencies,
    game_versions: gameVersions,
    version_type: version.versionType,
    loaders,
    featured: version.featured ?? true,
    // The names of the multipart file parts that carry the actual files, and
    // which of those is the primary download.
    file_parts: ['file'],
    primary_file: 'file',
  };

  const form = new FormData();
  form.append('data', JSON.stringify(data));
  form.append(
    'file',
    // Wrap the bytes in a Blob so undici/FormData streams it as a file part.
    new Blob([new Uint8Array(jarBytes)], { type: 'application/java-archive' }),
    jarName,
  );

  const res = await fetch(`${MODRINTH_API_BASE}/version`, {
    method: 'POST',
    headers: {
      Authorization: token,
      'User-Agent': userAgent(),
    },
    body: form,
  });
  if (!res.ok) await handleErrorResponse(res, 'uploading the Modrinth version');

  const result = (await res.json()) as CreateVersionResponse;
  return {
    versionId: result.id,
    versionNumber: result.version_number,
  };
}

// --------------------------------------------------------------------------
// High-level orchestrator
// --------------------------------------------------------------------------

export interface PublishToModrinthOptions {
  /** Path to the built NeoForge jar to upload. */
  jarPath: string;
  /**
   * Existing Modrinth project id to update. When set, project creation is
   * skipped and the version is added to this project (so a re-publish does
   * NOT trigger a fresh moderation review). When omitted, a new draft project
   * is created from `meta` first.
   */
  projectId?: string;
  /** Project-level metadata. Required when creating a new project (no
   *  projectId); ignored on update — Modrinth owns it after first publish. */
  meta?: ModrinthPublishMeta;
  /** Version-level metadata for the build being uploaded. */
  version: ModrinthVersionMeta;
  /** Optional progress callback; mirrors workshop.ts's onProgress shape. */
  onProgress?: ProgressHandler;
}

/**
 * Publish a build to Modrinth end to end.
 *
 * Phases (emitted via onProgress, mirroring workshop.ts):
 *   preparing → creating-project (only when no projectId) → uploading-version → done
 * On any failure an 'error' event is emitted before the error is re-thrown.
 *
 * Reuse: pass `projectId` to add a version to an existing project — this skips
 * project creation and its moderation review. Omit it to create a new draft
 * project (which Modrinth must review before it's public; the result flags
 * this via projectCreated / the 'done' event's awaitingReview).
 */
export async function publishToModrinth(
  opts: PublishToModrinthOptions,
): Promise<ModrinthPublishResult> {
  const { jarPath, version, meta, onProgress } = opts;
  const emit = (event: ModrinthPublishProgressEvent) => onProgress?.(event);

  emit({ status: 'preparing' });

  try {
    const token = requireToken();

    let projectId = opts.projectId?.trim() || '';
    let slug = '';
    let projectCreated = false;

    if (!projectId) {
      if (!meta) {
        throw new Error(
          'Project metadata is required to create a new Modrinth project.',
        );
      }
      emit({ status: 'creating-project' });
      const project = await createModrinthProject(meta, token);
      projectId = project.projectId;
      slug = project.slug;
      projectCreated = project.created;
      emit({
        status: 'creating-project',
        projectId,
        slug,
        url: project.url,
      });
    }
    // On update, slug stays '' and URLs fall back to the project id below —
    // modrinth.com resolves ids, and unlike a slug an id can't be renamed on
    // the site out from under our stored link.

    emit({ status: 'uploading-version', projectId, slug });
    const uploaded = await createModrinthVersion(projectId, jarPath, version, token);

    const url = projectWebUrl(slug || projectId);
    emit({
      status: 'done',
      projectId,
      slug,
      versionId: uploaded.versionId,
      url,
      awaitingReview: projectCreated,
    });

    return {
      projectId,
      slug: slug || projectId,
      versionId: uploaded.versionId,
      versionNumber: uploaded.versionNumber,
      url,
      projectCreated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ status: 'error', error: message });
    throw err instanceof Error ? err : new Error(message);
  }
}
