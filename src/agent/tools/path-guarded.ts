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
import { assertWriteTargetIsNew } from './write-overwrite-guard.js';

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

interface ParamShape {
  [key: string]: unknown;
}

function getStringField(params: unknown, name: string): string | null {
  if (!params || typeof params !== 'object') return null;
  const v = (params as ParamShape)[name];
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

export function createGuardedReadTool(cwd: string): AgentTool<any> {
  // pi's read tool's renderer accepts both `file_path` and `path` for legacy
  // compatibility with Anthropic-style tool calls — guard both.
  return wrapPathTool(createReadTool(cwd), cwd, ['path', 'file_path']);
}

/**
 * Wrap pi's write tool so it refuses to overwrite an existing file. The agent
 * regularly reaches for `write` to apply small changes to files it just
 * authored — that streams the entire new contents through the model on every
 * iteration, costing 5–10× the tokens an `edit` would. Forcing the redirect
 * adds at most one extra `read` when the agent really does want a full
 * rewrite (it can `edit` with the whole file as the replacement). New files
 * still go through `write` unchanged.
 */
export function createGuardedWriteTool(cwd: string): AgentTool<any> {
  const inner = wrapPathTool(createWriteTool(cwd), cwd, ['path']);
  return {
    ...inner,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const raw = getStringField(params, 'path');
      if (raw !== null) {
        assertWriteTargetIsNew(raw, cwd);
      }
      return inner.execute(toolCallId, params as any, signal, onUpdate);
    },
  };
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
