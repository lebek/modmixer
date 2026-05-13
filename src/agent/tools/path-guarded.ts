import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { homedir } from 'node:os';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { getIndexPaths } from '../index/paths.js';

/**
 * Built-in pi tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) accept
 * arbitrary absolute paths — they resolve a `cwd` argument lexically but do
 * NOT bound the result to that cwd. A hostile mod's About.xml or README can
 * craft a tool call that reads or writes anywhere on disk.
 *
 * These wrappers enforce `assertPathAllowed` on the path-shaped argument
 * before delegating to the built-in tool. Custom tools win over built-ins
 * by name in pi's `_refreshToolRegistry`, so registering these under
 * `name: 'read' | 'write' | 'edit' | 'grep' | 'find' | 'ls'` shadows the
 * defaults.
 *
 * For tools that take a relative path (the agent's `cwd` is the workspace
 * already), we resolve relative paths against the workspace cwd and only
 * then run the policy check. Absolute paths are checked as-is.
 */

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a tool's path-shaped arg against the workspace cwd, then assert
 * it's inside the allowlist. Returns the canonicalized absolute path so
 * callers can pass it through to the inner tool.
 */
function resolveAndCheck(rawPath: string, cwd: string, label: string): string {
  const expanded = expandHome(rawPath);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  assertPathAllowed(abs, getPathPolicyRoots(), label);
  return abs;
}

function getStringField(params: unknown, name: string): string | null {
  if (!params || typeof params !== 'object') return null;
  const v = (params as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : null;
}

/**
 * Wrap a path-shaped tool so it rejects calls that would touch a path
 * outside the allowlist. `pathFields` lists every parameter name that holds
 * a path; each is validated before the inner tool runs. The wrapper passes
 * the original (un-canonicalized) params through to the inner tool so its
 * own resolution logic still kicks in for cwd-relative shortcuts.
 */
function wrapPathTool(
  inner: AgentTool<any>,
  cwd: string,
  pathFields: string[],
): AgentTool<any> {
  return {
    ...inner,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      for (const field of pathFields) {
        const raw = getStringField(params, field);
        if (raw === null) continue; // optional field absent
        resolveAndCheck(raw, cwd, `${inner.name}.${field}`);
      }
      return inner.execute(toolCallId, params as any, signal, onUpdate);
    },
  };
}

/**
 * True iff `absPath` is inside the indexed RimWorld C# source corpus
 * (`$MM/index/Source/...`) and is a .cs file. Used to nudge the agent toward
 * `read_csharp_symbol`, which returns a class/method body without juggling
 * line offsets and reuses the symbol index instead of re-reading the same
 * file at adjacent ranges. Failures (e.g. no index built yet) → false.
 */
function isIndexedCsharpSource(absPath: string): boolean {
  if (!absPath.toLowerCase().endsWith('.cs')) return false;
  let sourceRoot: string;
  try {
    sourceRoot = getIndexPaths().sourceRoot;
  } catch {
    return false;
  }
  const rel = path.relative(sourceRoot, absPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const READ_CSHARP_SYMBOL_HINT =
  '[hint] This file is in the RimWorld C# index. For class/method-level reads, `read_csharp_symbol "<SymbolName>"` returns the symbol body in one call without juggling offsets — use it when you know which symbol you need; this `read` is fine when you genuinely need surrounding lines.';

// Default line cap injected into unbounded reads of indexed C# source files.
// `read` without a `limit`/`offset` on a 600-line .cs file was a recurring
// context sink (run 2 read 14 KB of IncidentWorker_RaidEnemy.cs in one call).
// Anything past this many lines should come from `read_csharp_symbol` or an
// explicit slice.
const INDEXED_CS_DEFAULT_LIMIT = 120;

const READ_CSHARP_TRUNCATED_HINT = `[hint] Capped to first ${INDEXED_CS_DEFAULT_LIMIT} lines because this is an indexed RimWorld C# source file. To read a specific class/method body, call \`read_csharp_symbol "<SymbolName>"\` — it returns the body without juggling offsets. To read further into this file, re-call \`read\` with explicit \`offset\` + \`limit\`.`;

export function createGuardedReadTool(cwd: string): AgentTool<any> {
  // pi's read tool's renderer accepts both `file_path` and `path` for legacy
  // compatibility with Anthropic-style tool calls — guard both.
  const guarded = wrapPathTool(createReadTool(cwd), cwd, ['path', 'file_path']);
  return {
    ...guarded,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const raw =
        getStringField(params, 'path') ?? getStringField(params, 'file_path');
      let effectiveParams = params;
      let didCap = false;
      if (raw && params && typeof params === 'object') {
        const expanded = expandHome(raw);
        const abs = path.isAbsolute(expanded)
          ? expanded
          : path.resolve(cwd, expanded);
        const p = params as Record<string, unknown>;
        if (
          isIndexedCsharpSource(abs) &&
          p.limit === undefined &&
          p.offset === undefined
        ) {
          effectiveParams = { ...p, limit: INDEXED_CS_DEFAULT_LIMIT };
          didCap = true;
        }
      }
      const result = await guarded.execute(
        toolCallId,
        effectiveParams,
        signal,
        onUpdate,
      );
      if (!raw) return result;
      const expanded = expandHome(raw);
      const abs = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(cwd, expanded);
      if (!isIndexedCsharpSource(abs)) return result;
      // Append a hint as a separate text item so we don't disturb the file
      // body the read tool returned. Stronger wording when we capped, so the
      // agent knows the cap is the reason it sees a partial file.
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: 'text' as const,
            text: didCap ? READ_CSHARP_TRUNCATED_HINT : READ_CSHARP_SYMBOL_HINT,
          },
        ],
      };
    },
  };
}

export function createGuardedWriteTool(cwd: string): AgentTool<any> {
  // Override pi's default description to nudge the agent toward `edit` for
  // changes. Re-streaming a whole file every modification burns 5–10× the
  // tokens of a diff; enforced socially via the description rather than at
  // runtime so legitimate full rewrites still work.
  const inner = createWriteTool(cwd) as AgentTool<any>;
  const overridden: AgentTool<any> = {
    ...inner,
    description:
      "Create a new file with the given content. Use this ONLY for files that don't exist yet — for any change to an existing file, use edit instead (token-cheaper, since edit only sends the diff). Automatically creates parent directories.",
  };
  return wrapPathTool(overridden, cwd, ['path']);
}

export function createGuardedEditTool(cwd: string): AgentTool<any> {
  return wrapPathTool(createEditTool(cwd), cwd, ['path']);
}

export function createGuardedGrepTool(cwd: string): AgentTool<any> {
  // grep takes a `path` (root) + a `pattern`; only the path needs checking.
  return wrapPathTool(createGrepTool(cwd), cwd, ['path']);
}

export function createGuardedFindTool(cwd: string): AgentTool<any> {
  return wrapPathTool(createFindTool(cwd), cwd, ['path']);
}

export function createGuardedLsTool(cwd: string): AgentTool<any> {
  return wrapPathTool(createLsTool(cwd), cwd, ['path']);
}
