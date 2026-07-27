import { app, safeStorage } from 'electron';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

interface LockResult<T> {
  result: T;
  next?: string;
}

/**
 * Locked read-modify-write over the credential blob. Mirrors the shape pi's
 * own `AuthStorageBackend` used to have — pi 0.82 stopped exporting that
 * interface (and the `AuthStorage` class that consumed it) from its public
 * entry point, so we declare the contract ourselves and pair it with
 * `SafeStorageCredentialStore` below.
 */
interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T>;
}

/**
 * Storage backend backed by Electron's safeStorage. Replaces pi's default
 * `FileAuthStorageBackend` which writes the JSON token blob plaintext.
 *
 * Storage layout:
 *   - `auth.enc` — Buffer payload, written via `safeStorage.encryptString`.
 *   - `auth.json` — legacy plaintext file. If present at first read, we
 *     migrate its contents into `auth.enc` and delete it. After migration the
 *     plaintext file no longer appears on disk, so even an attacker who
 *     reads the userData directory after the app has been launched once
 *     does not see tokens.
 *
 * The `auth.enc` file is locked the same way pi locks `auth.json` so a
 * concurrent token refresh from another process doesn't corrupt the file.
 *
 * Key behaviour notes:
 *   - `safeStorage.isEncryptionAvailable()` may be false on Linux without
 *     keyring or before `app.ready` on Windows. We *fail closed* — an
 *     unavailable keyring means we treat creds as missing (so the user is
 *     prompted to re-login), rather than silently falling back to plaintext.
 *   - We never throw out of `withLock` for missing-keyring; instead we
 *     return empty data and skip writing. AuthStorage's reload() can be
 *     called again later when encryption becomes available.
 */
export class SafeStorageAuthBackend implements AuthStorageBackend {
  /** Encryption is verified once and cached so subsequent calls are cheap. */
  private encryptionState: 'unknown' | 'available' | 'unavailable' = 'unknown';

  constructor(
    private readonly encPath: string,
    private readonly legacyPlaintextPath: string,
  ) {}

  private ensureParentDir(): void {
    const dir = dirname(this.encPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private isEncryptionAvailable(): boolean {
    if (this.encryptionState === 'available') return true;
    if (this.encryptionState === 'unavailable') return false;
    // Re-check each time until we've conclusively succeeded. On Linux
    // without a keyring this returns false even after ready; on Windows it
    // returns false before ready and true after.
    if (!app.isReady()) return false;
    const ok = safeStorage.isEncryptionAvailable();
    this.encryptionState = ok ? 'available' : 'unavailable';
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '[modmixer:auth] safeStorage is not available on this system. ' +
          'OAuth tokens will not be persisted. The user will need to re-login each session.',
      );
    }
    return ok;
  }

  /**
   * Read the on-disk JSON, performing a one-time migration from any legacy
   * plaintext `auth.json` to the encrypted `auth.enc`. Returns the decoded
   * JSON content as a string (the same shape pi's FileAuthStorageBackend
   * returns, so AuthStorage.parseStorageData can consume it untouched).
   */
  private readDecrypted(): string | undefined {
    if (existsSync(this.encPath)) {
      if (!this.isEncryptionAvailable()) return undefined;
      try {
        const blob = readFileSync(this.encPath);
        return safeStorage.decryptString(blob);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[modmixer:auth] Failed to decrypt auth.enc:', err);
        return undefined;
      }
    }

    if (existsSync(this.legacyPlaintextPath)) {
      // First-launch migration. Read the old plaintext, write encrypted,
      // then delete the plaintext. We do not attempt the migration if the
      // keyring is unavailable — better to leave the plaintext file alone
      // (the user can manually delete it / re-login) than write garbage.
      const plaintext = readFileSync(this.legacyPlaintextPath, 'utf-8');
      if (this.isEncryptionAvailable()) {
        try {
          this.writeEncrypted(plaintext);
          // Truncate the plaintext file to zero before unlinking, in case
          // the file is being held open by another process or backed up
          // somewhere outside our control.
          try {
            writeFileSync(this.legacyPlaintextPath, '', 'utf-8');
          } catch {
            // Ignore — the unlink below is the actual cleanup.
          }
          try {
            unlinkSync(this.legacyPlaintextPath);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              '[modmixer:auth] Migrated tokens to auth.enc but could not remove auth.json:',
              err,
            );
          }
          // eslint-disable-next-line no-console
          console.log('[modmixer:auth] Migrated plaintext auth.json to encrypted auth.enc.');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[modmixer:auth] Migration to encrypted store failed:', err);
        }
      }
      return plaintext;
    }

    return undefined;
  }

  private writeEncrypted(content: string): void {
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        'safeStorage is not available — refusing to persist OAuth tokens in plaintext.',
      );
    }
    this.ensureParentDir();
    const blob = safeStorage.encryptString(content);
    writeFileSync(this.encPath, blob);
    chmodSync(this.encPath, 0o600);
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== 'ELOCKED' || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        // Synchronous spin so callers don't have to be async-aware. Matches
        // pi's FileAuthStorageBackend.acquireLockSyncWithRetry.
        while (Date.now() - start < delayMs) {
          // intentionally empty
        }
      }
    }
    throw (lastError as Error) ?? new Error('Failed to acquire auth storage lock');
  }

  /**
   * proper-lockfile expects the lock target to exist on disk. The encrypted
   * file may not exist on first run (no creds yet) — touch it so we can
   * acquire the lock, then leave the touch alone (subsequent writes overwrite).
   */
  private ensureLockableFile(): void {
    this.ensureParentDir();
    if (!existsSync(this.encPath)) {
      writeFileSync(this.encPath, '');
      chmodSync(this.encPath, 0o600);
    }
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureLockableFile();
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.encPath);
      const current = this.readDecrypted();
      const { result, next } = fn(current);
      if (next !== undefined) {
        this.writeEncrypted(next);
      }
      return result;
    } finally {
      if (release) release();
    }
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    this.ensureLockableFile();
    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Auth storage lock was compromised');
      }
    };
    try {
      release = await lockfile.lock(this.encPath, {
        retries: {
          retries: 10,
          factor: 2,
          minTimeout: 100,
          maxTimeout: 10000,
          randomize: true,
        },
        stale: 30000,
        onCompromised: (err: Error) => {
          lockCompromised = true;
          lockCompromisedError = err;
        },
      });
      throwIfCompromised();
      const current = this.readDecrypted();
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        this.writeEncrypted(next);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock errors when compromised.
        }
      }
    }
  }
}

/** On-disk shape: one credential per provider id, same as pi's auth.json. */
type CredentialData = Record<string, Credential>;

function parseCredentials(raw: string | undefined): CredentialData {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CredentialData;
  } catch {
    // A corrupt/undecryptable blob is treated as "no credentials" rather than
    // a hard failure — the user re-logins instead of the app failing to boot.
    return {};
  }
}

/**
 * pi-ai `CredentialStore` over the encrypted backend above.
 *
 * pi 0.80 gave us this for free: `AuthStorage.fromStorage(backend)` wrapped a
 * backend and pi's ModelRegistry consumed it. In 0.82 the credential layer
 * became the pi-ai `CredentialStore` interface and `AuthStorage` stopped
 * being exported, so we own the (small) adapter: parse the locked blob,
 * serve reads from an in-memory copy, and route every write through
 * `withLockAsync` so a concurrent OAuth refresh can't clobber the file.
 *
 * Reads are served from cache because pi calls `read()` on request paths and
 * the underlying decrypt is a keychain round-trip. `reload()` re-primes that
 * cache — see `AgentHost.primeAfterReady`, which calls it once safeStorage
 * is actually available.
 */
export class SafeStorageCredentialStore implements CredentialStore {
  private data: CredentialData = {};

  constructor(private readonly backend: AuthStorageBackend) {
    this.reload();
  }

  /** Re-read the encrypted blob into the in-memory cache. Never throws. */
  reload(): void {
    try {
      this.data = this.backend.withLock((current) => ({
        result: parseCredentials(current),
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[modmixer:auth] Failed to reload credentials:', err);
      this.data = {};
    }
  }

  /**
   * Synchronous cache peek for call sites that register providers during
   * startup and can't await (pi's own `read()` is async because other
   * implementations may hit the network).
   */
  peek(providerId: string): Credential | undefined {
    return this.data[providerId];
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.backend.withLockAsync(async (current) => {
      // Re-parse under the lock: another process may have refreshed a token
      // since our cache was primed.
      const data = parseCredentials(current);
      const next = await fn(data[providerId]);
      if (next === undefined) {
        this.data = data;
        return { result: data[providerId] };
      }
      data[providerId] = next;
      this.data = data;
      return { result: next, next: JSON.stringify(data, null, 2) };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.backend.withLockAsync(async (current) => {
      const data = parseCredentials(current);
      delete data[providerId];
      this.data = data;
      return { result: undefined, next: JSON.stringify(data, null, 2) };
    });
  }
}
