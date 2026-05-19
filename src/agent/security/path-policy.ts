import path from 'node:path';
import { homedir } from 'node:os';

/**
 * Filesystem allowlist + denylist for tools that take user-influenced paths
 * (decompile_dll, bash). The agent runs LLM-generated arguments, so a hostile
 * Workshop README or About.xml can craft a tool call that points anywhere on
 * disk; this module is the bound on that blast radius.
 *
 * Roots are passed in by the caller so the module stays pure and unit-testable
 * without touching the real filesystem or Electron's userData path.
 */
export interface PathPolicyRoots {
  /** Modmixer's workspace cwd — the only place the agent should write. */
  workspaceDir: string;
  /** RimWorld install Managed/ dir (Assembly-CSharp.dll lives here). */
  managedDir: string | null;
  /**
   * RimWorld DLC-pack parent dir (`<install>/Data/` on Win/Linux,
   * `<bundle>/Data/` on macOS). Holds Core/Royalty/Ideology/etc. with their
   * Defs/Sounds/Textures. Allowed so the agent can read canonical XML when
   * the def index isn't built — the data is read-only game content with the
   * same risk profile as the Workshop and Managed dirs.
   */
  dataDir: string | null;
  /** Steam Workshop subscriptions root for RimWorld (294100). */
  workshopDir: string | null;
  /** RimWorld user-data Mods/ dir (where syncModToGame drops symlinks). */
  rimworldModsDir: string | null;
  /** Player.log directory — kept allowable so the agent can `read` / `grep`
   * Player.log for forensic spelunking when bridge data isn't enough. */
  playerLogDir: string | null;
  /**
   * RimWorld source/def index root ($MM/index/). Read-only for the agent —
   * search_defs / read_csharp_symbol / search_source live here. The path
   * lives under the user's userData so a hostile path argument can't escape
   * into other Electron app data via this allowance.
   */
  indexDir: string | null;
  /**
   * Modmixer's curated cookbook root (`<repo>/cookbook/` in dev,
   * `Contents/Resources/cookbook/` packaged). Read-only reference shipped
   * with the app — allowed so the agent can `read` cookbook sections with
   * the ordinary read tool instead of needing a dedicated cookbook tool.
   */
  cookbookDir: string;
}

export class PathPolicyError extends Error {
  constructor(
    message: string,
    /** "allowlist" = path was outside permitted roots; "denylist" = path matched a sensitive substring. */
    public readonly kind: 'allowlist' | 'denylist',
  ) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

/**
 * Resolved canonical paths that callers must NOT touch even if they're
 * inside an allowed root. Substring-matched on the *normalized absolute path*
 * after `~` expansion. We don't realpath() — symlinks at these locations are
 * either expected (Steam) or themselves suspicious; a symlink that resolves
 * outside the denylist still gets caught by the allowlist check.
 *
 * The list is intentionally narrow: the OS keychains, browser profile dirs,
 * and ssh/aws/gcloud creds. Adding more here makes the agent less useful
 * without making it materially safer (the allowlist is the real bound).
 */
const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  // Shell + cloud credentials.
  '/.ssh/',
  '/.aws/',
  '/.gcloud/',
  '/.config/gcloud/',
  '/.kube/',
  '/.docker/config.json',
  '/.netrc',
  '/.pgpass',
  '/.npmrc',
  // OS keychains / credential stores.
  '/Library/Keychains/',
  '/AppData/Local/Microsoft/Credentials/',
  '/AppData/Roaming/Microsoft/Credentials/',
  '/.local/share/keyrings/',
  // Browser profile directories — cookies, saved passwords, session tokens.
  '/Library/Application Support/Google/Chrome/',
  '/Library/Application Support/Firefox/',
  '/Library/Application Support/BraveSoftware/',
  '/Library/Application Support/Microsoft Edge/',
  '/.mozilla/firefox/',
  '/.config/google-chrome/',
  '/.config/BraveSoftware/',
  '/AppData/Local/Google/Chrome/',
  '/AppData/Roaming/Mozilla/Firefox/',
  // GPG keyring.
  '/.gnupg/',
] as const;

/**
 * Expand `~` to the user's home directory. The shell does this for `bash`
 * commands automatically; we do it here for tool args (e.g. `dllPath`) so
 * `~/.ssh/id_rsa` and `/Users/x/.ssh/id_rsa` are caught by the same check.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Canonicalize a path for policy checks. Resolves `~`, makes it absolute, and
 * normalizes `..` segments. We deliberately do NOT call realpath() — the path
 * may not exist yet (e.g. a write target), and resolving symlinks can leak
 * filesystem layout to the agent. The allowlist boundary is enforced on the
 * lexical absolute path; symlinks pointing outside still fail the boundary.
 */
function canonicalize(input: string): string {
  return path.resolve(expandHome(input));
}

/**
 * True when `child` is inside `parent` (or equal to it). Both must already
 * be absolute. Uses path.relative + segment check, NOT prefix string match,
 * to avoid `/foo` matching `/foobar`.
 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith('..') &&
      !path.isAbsolute(rel) &&
      !rel.startsWith(`..${path.sep}`))
  );
}

/**
 * Throw PathPolicyError unless the canonical form of `input` is inside one
 * of the configured allowlist roots and is not under a sensitive denylisted
 * subpath. The label is stitched into the error message so the agent's
 * tool-result error tells the user (and the model) which path tripped the
 * check, but not the contents of the allowlist.
 *
 * `extraRoots` are per-call ad-hoc allowances — files or directories the
 * user explicitly attached to the chat. They widen the read side only (the
 * caller decides which tools receive them) so the agent can read or copy a
 * dragged-in file without us copying it into the workspace first. A file
 * path as a root permits exactly that file; a directory permits its subtree.
 */
export function assertPathAllowed(
  input: string,
  roots: PathPolicyRoots,
  label = 'path',
  extraRoots: readonly string[] = [],
): string {
  const abs = canonicalize(input);
  // Patterns are forward-slash; normalize so the same denylist works on Windows.
  const absForward = abs.split(path.sep).join('/');

  // Denylist runs first so we don't leak which roots are allowed for an
  // explicitly-sensitive path.
  for (const pat of SENSITIVE_PATH_PATTERNS) {
    if (absForward.includes(pat)) {
      throw new PathPolicyError(
        `${label} ${abs} is in a sensitive system location and cannot be accessed by the agent.`,
        'denylist',
      );
    }
  }

  const candidates = [
    roots.workspaceDir,
    roots.managedDir,
    roots.dataDir,
    roots.workshopDir,
    roots.rimworldModsDir,
    roots.playerLogDir,
    roots.indexDir,
    roots.cookbookDir,
    ...extraRoots,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const root of candidates) {
    if (isInside(canonicalize(root), abs)) return abs;
  }

  throw new PathPolicyError(
    `${label} ${abs} is outside the modmixer workspace and known RimWorld install paths.`,
    'allowlist',
  );
}

/**
 * Substring scan for `bash` commands. We can't statically extract every path
 * an arbitrary shell command will touch (subshells, env-var expansion, xargs
 * pipelines), so we deny the command if its raw text mentions a sensitive
 * location. The allowlist root for bash is the cwd, which the spawn already
 * enforces; this denylist catches commands that read absolute paths regardless
 * of cwd (e.g. `cat ~/.ssh/id_rsa`, `cp /etc/passwd .`).
 *
 * Patterns include both expanded (`/Users/foo/.ssh`) and unexpanded (`~/.ssh`)
 * forms, plus a handful of system paths the agent never needs to touch.
 */
const SENSITIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_./-])~\/\.ssh\b/,
  /(?<![A-Za-z0-9_./-])~\/\.aws\b/,
  /(?<![A-Za-z0-9_./-])~\/\.gcloud\b/,
  /(?<![A-Za-z0-9_./-])~\/\.config\/gcloud\b/,
  /(?<![A-Za-z0-9_./-])~\/\.kube\b/,
  /(?<![A-Za-z0-9_./-])~\/\.gnupg\b/,
  /(?<![A-Za-z0-9_./-])~\/\.netrc\b/,
  /(?<![A-Za-z0-9_./-])~\/\.npmrc\b/,
  /(?<![A-Za-z0-9_./-])~\/\.pgpass\b/,
  /(?<![A-Za-z0-9_./-])~\/Library\/Keychains\b/,
  /\/\.ssh\//,
  /\/\.aws\//,
  /\/\.gcloud\//,
  /\/\.config\/gcloud\//,
  /\/\.kube\//,
  /\/\.gnupg\//,
  /\/\.netrc\b/,
  /\/\.pgpass\b/,
  /\/\.npmrc\b/,
  /\/Library\/Keychains\//,
  /\/AppData\/Local\/Microsoft\/Credentials\b/i,
  /\/AppData\/Roaming\/Microsoft\/Credentials\b/i,
  /\/etc\/passwd\b/,
  /\/etc\/shadow\b/,
  /\/etc\/sudoers\b/,
  /\bsecurity\s+find-(?:generic|internet)-password\b/,
];

/**
 * Throw PathPolicyError if `command` references a known-sensitive path. The
 * matcher is intentionally simple and pre-shell-evaluation — anything more
 * sophisticated would either falsely allow shell tricks (subshells, IFS
 * games) or falsely reject legitimate commands. The point is to catch the
 * obvious "cat ~/.ssh/id_rsa" cases that account for most prompt-injection
 * payloads.
 */
export function assertCommandAllowed(command: string): void {
  for (const re of SENSITIVE_COMMAND_PATTERNS) {
    if (re.test(command)) {
      throw new PathPolicyError(
        `bash command was rejected because it references a sensitive system path. Modmixer's agent is restricted from reading credentials and OS keychains.`,
        'denylist',
      );
    }
  }
  for (const { re, message } of REDIRECTED_COMMAND_PATTERNS) {
    if (re.test(command)) {
      throw new PathPolicyError(message, 'denylist');
    }
  }
}

/**
 * Commands that have a dedicated, path-policy-guarded tool. Running them
 * through bash works but forces a user approval prompt every time, so we
 * reject the bash path and tell the model to use the proper tool instead.
 * The match is a word-boundary check on the executable name; we don't try
 * to defeat shell tricks like `il""spycmd` — the model has no incentive to
 * obfuscate, and a hostile prompt that did would still be bounded by the
 * bash tool's confirmation gate.
 */
const REDIRECTED_COMMAND_PATTERNS: readonly { re: RegExp; message: string }[] = [
  {
    re: /(?<![A-Za-z0-9_./-])ilspycmd(?![A-Za-z0-9_-])/,
    message:
      'Use the decompile_dll tool to run ilspycmd, not bash. decompile_dll enforces the same path policy without prompting the user for approval on every call.',
  },
];
