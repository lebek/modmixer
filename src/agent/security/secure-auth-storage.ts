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
import type { AuthStorageBackend } from '@mariozechner/pi-coding-agent';

interface LockResult<T> {
  result: T;
  next?: string;
}

/**
 * AuthStorageBackend backed by Electron's safeStorage. Replaces pi's default
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
