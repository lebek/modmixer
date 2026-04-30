import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from './paths.js';

export interface LogError {
  text: string;
  firstLine: string;
  detectedAt: number;
}

export type LogErrorListener = (errors: LogError[]) => void;

const POLL_INTERVAL_MS = 1000;

export class LogWatcher {
  private position = 0;
  private inode: number | null = null;
  private logPath: string | null = null;
  private listeners = new Set<LogErrorListener>();
  private watchHandler: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;

  start(): void {
    const { playerLog } = detectRimWorldPaths();
    if (!playerLog) return;
    this.logPath = playerLog;
    this.snapshotEnd();
    // fs.watchFile polls the PATH (not the inode), so it survives RimWorld
    // rotating Player.log on each launch (rename to Player-prev.log + create
    // a fresh Player.log). fs.watch on a file follows the inode and silently
    // misses post-rotation writes.
    this.watchHandler = () => void this.readNew();
    fs.watchFile(this.logPath, { interval: POLL_INTERVAL_MS }, this.watchHandler);
  }

  /**
   * Set position to the current end of the file. Use right before triggering
   * a new RimWorld launch — combined with inode tracking, this skips any
   * pre-existing log content but captures everything written from this run on.
   */
  resetForNewSession(): void {
    this.snapshotEnd();
  }

  /**
   * Read the entire current Player.log immediately and emit any errors found.
   * Useful when the watcher missed events (first ModMixer launch after errors
   * already happened, or to manually retrigger a scan).
   */
  async scanNow(): Promise<LogError[]> {
    if (!this.logPath) return [];
    try {
      const stat = await fsp.stat(this.logPath);
      const buf = await fsp.readFile(this.logPath);
      this.position = stat.size;
      this.inode = stat.ino;
      const errors = parseErrors(buf.toString('utf8'));
      if (errors.length > 0) {
        this.listeners.forEach((l) => l(errors));
      }
      return errors;
    } catch {
      return [];
    }
  }

  subscribe(listener: LogErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.logPath && this.watchHandler) {
      fs.unwatchFile(this.logPath, this.watchHandler);
      this.watchHandler = null;
    }
  }

  private snapshotEnd(): void {
    if (!this.logPath) return;
    try {
      const stat = fs.statSync(this.logPath);
      this.position = stat.size;
      this.inode = stat.ino;
    } catch {
      this.position = 0;
      this.inode = null;
    }
  }

  private async readNew(): Promise<void> {
    if (!this.logPath) return;
    try {
      const stat = await fsp.stat(this.logPath);
      const rotated = this.inode !== null && stat.ino !== this.inode;
      if (rotated || stat.size < this.position) {
        // New file (rotation) or truncation — start from the beginning of
        // the current file so we capture this session's full output.
        this.position = 0;
        this.inode = stat.ino;
      }
      if (stat.size === this.position) return;

      const fd = await fsp.open(this.logPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - this.position);
        await fd.read(buf, 0, buf.length, this.position);
        this.position = stat.size;
        this.inode = stat.ino;
        const errors = parseErrors(buf.toString('utf8'));
        if (errors.length > 0) {
          this.listeners.forEach((l) => l(errors));
        }
      } finally {
        await fd.close();
      }
    } catch {
      // Transient — next poll retries.
    }
  }
}

const NOISE_PATTERNS = [
  /^Fallback handler could not load library/m,
  /^Could not load library/m,
  /\[PhysX\]/m,
];

const ERROR_PATTERNS = new RegExp(
  [
    // .NET / Verse.Log markers
    '\\bException\\b',
    '\\bRimWorld error\\b',
    '\\bVerse\\.Log:Error\\b',
    '\\bVerse\\.Log:Warning\\b',
    '\\bXML error\\b',
    '\\bSystem\\.\\w+Exception\\b',
    '\\bInvalidCastException\\b',
    '\\bNullReferenceException\\b',
    '\\bMissingMethodException\\b',
    '\\bFileNotFoundException\\b',
    '\\bTypeLoadException\\b',
    // RimWorld runtime markers — on macOS, Log.Error/Log.Warning calls land in
    // Player.log as plain text without the Verse.Log: prefix.
    'Could not load (?:AudioClip|texture|asset)',
    "couldn't resolve",
    'has no resolvedGrains',
    'Cannot play \\w+',
    'Tried to play .* but',
    'Could not resolve cross-reference',
    'Could not find a type named',
    'Could not load reference to',
  ].join('|'),
);

let instance: LogWatcher | null = null;

/** Process-wide singleton. The first call starts the watcher. */
export function getLogWatcher(): LogWatcher {
  if (!instance) {
    instance = new LogWatcher();
    instance.start();
  }
  return instance;
}

function parseErrors(text: string): LogError[] {
  const errors: LogError[] = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (NOISE_PATTERNS.some((p) => p.test(trimmed))) continue;
    if (!ERROR_PATTERNS.test(trimmed)) continue;
    const firstLine = trimmed.split('\n')[0].slice(0, 240);
    errors.push({
      text: trimmed,
      firstLine,
      detectedAt: Date.now(),
    });
  }
  return errors;
}
