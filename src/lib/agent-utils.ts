import type { AgentMessage } from '@earendil-works/pi-agent-core';

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

export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        (c as { type?: string }).type === 'thinking',
    )
    .map((c) => (c as { thinking?: string }).thinking ?? '')
    .join('\n\n')
    .trim();
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

/**
 * Image content blocks on a message — used to render attachment thumbnails
 * on a user bubble. pi stores attached images as ImageContent
 * (`{ type:'image', data, mimeType }`) so they persist across reloads.
 */
export function extractImages(
  content: unknown,
): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (c): c is { type: 'image'; data: string; mimeType: string } =>
      !!c &&
      typeof c === 'object' &&
      (c as { type?: string }).type === 'image' &&
      typeof (c as { data?: unknown }).data === 'string',
  );
}
