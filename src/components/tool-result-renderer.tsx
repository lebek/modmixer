import { useState, type ReactNode } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { cn } from '@/lib/cn';
import { extractText } from '@/lib/agent-utils';

type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;

export type ToolRenderArgs = {
  toolName: string;
  isError: boolean;
  output: string;
  args: Record<string, unknown> | undefined;
};

export type ToolRenderer = {
  summary: (args: ToolRenderArgs) => ReactNode;
  defaultExpanded?: boolean;
  body?: (args: ToolRenderArgs) => ReactNode;
};

const registry = new Map<string, ToolRenderer>();

export function registerToolRenderer(name: string, r: ToolRenderer) {
  registry.set(name, r);
}

export function getToolRenderer(name: string): ToolRenderer {
  return registry.get(name) ?? defaultRenderer;
}

const lineCount = (s: string) => (s ? s.split('\n').length : 0);
const truncate = (s: string, n = 120) =>
  s.length > n ? s.slice(0, n) + '…' : s;

const defaultRenderer: ToolRenderer = {
  summary: ({ output, isError }) =>
    isError ? truncate(output) : `${lineCount(output)} lines`,
};

registerToolRenderer('read', {
  summary: ({ args, output }) => {
    const path = (args?.file_path ?? args?.path) as string | undefined;
    return `${path ?? 'file'} · ${lineCount(output)} lines`;
  },
});

registerToolRenderer('ls', {
  summary: ({ args, output }) => {
    const path = (args?.path ?? args?.dir) as string | undefined;
    const entries = output.split('\n').filter(Boolean).length;
    return `${path ?? '.'} · ${entries} entries`;
  },
});

registerToolRenderer('grep', {
  summary: ({ args, output }) => {
    const pattern = args?.pattern as string | undefined;
    const matches = output.split('\n').filter(Boolean).length;
    return `${pattern ? `"${truncate(pattern, 40)}" · ` : ''}${matches} matches`;
  },
});

registerToolRenderer('find', {
  summary: ({ output }) => {
    const hits = output.split('\n').filter(Boolean).length;
    return `${hits} paths`;
  },
});

registerToolRenderer('edit', {
  summary: ({ args }) => {
    const path = (args?.file_path ?? args?.path) as string | undefined;
    return path ? `edited ${path}` : 'edit';
  },
});

registerToolRenderer('write', {
  summary: ({ args, output }) => {
    const path = (args?.file_path ?? args?.path) as string | undefined;
    return `${path ?? 'file'} · ${lineCount(output)} lines written`;
  },
});

registerToolRenderer('bash', {
  summary: ({ args, output, isError }) => {
    const cmd = args?.command as string | undefined;
    const tail = output.trimEnd().split('\n').slice(-1)[0] ?? '';
    return (
      <span className="flex min-w-0 items-center gap-2">
        {cmd && (
          <span className="truncate font-mono text-ink/80">
            $ {truncate(cmd, 60)}
          </span>
        )}
        <span className="truncate text-subtle">
          {isError ? truncate(tail, 60) : `${lineCount(output)} lines`}
        </span>
      </span>
    );
  },
});

registerToolRenderer('build_mod', {
  summary: ({ output, isError }) => {
    if (isError) return truncate(output.split('\n').slice(-1)[0] ?? 'failed', 80);
    const m = output.match(/\b(\d+)\s+errors?,\s+(\d+)\s+warnings?/i);
    return m ? `${m[1]} errors · ${m[2]} warnings` : 'build complete';
  },
});

registerToolRenderer('launch_rimworld', { summary: () => 'launched' });
registerToolRenderer('quit_rimworld', { summary: () => 'quit' });
registerToolRenderer('is_rimworld_running', {
  summary: ({ output }) => truncate(output.trim(), 80),
});

export function ToolResultBubble({
  message,
  args,
}: {
  message: ToolResultMessage;
  args: Record<string, unknown> | undefined;
}) {
  const output = extractText(message.content);
  const renderer = getToolRenderer(message.toolName);
  const isError = !!message.isError;
  const [expanded, setExpanded] = useState(
    isError ? true : (renderer.defaultExpanded ?? false),
  );

  const renderArgs: ToolRenderArgs = {
    toolName: message.toolName,
    isError,
    output,
    args,
  };

  return (
    <div
      className={cn(
        'rounded-md border text-xs',
        isError
          ? 'border-failed/40 bg-failed/5 text-failed'
          : 'border-ready/40 bg-ready/5 text-ink',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          {message.toolName} {isError ? '✗' : '✓'}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {renderer.summary(renderArgs)}
        </span>
        <span className="font-mono text-[10px] text-subtle">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-line/60 px-3 py-2 font-mono text-[11px] leading-relaxed">
          {renderer.body ? (
            renderer.body(renderArgs)
          ) : (
            <pre className="whitespace-pre-wrap break-words">
              {output || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
