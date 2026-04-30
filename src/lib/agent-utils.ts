import type { AgentMessage } from '@mariozechner/pi-agent-core';

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (c) =>
        c && typeof c === 'object' && (c as { type?: string }).type === 'text',
    )
    .map((c) => (c as { text?: string }).text ?? '')
    .join('');
}

export function extractToolCalls(
  content: unknown,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (c): c is {
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    } =>
      !!c &&
      typeof c === 'object' &&
      (c as { type?: string }).type === 'toolCall',
  );
}

export function messageText(message: AgentMessage): string {
  return extractText((message as { content: unknown }).content);
}
