// Identifier helpers shared across renderer, main, and the agent tool.
// No Node-only deps — must stay safe to import from the renderer.

/** PascalCase, alphanumerics only. Empty input → ''. Leading-digit guard prefixes "Mod". */
export function pascalCase(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9\s_-]+/g, ' ');
  const parts = cleaned.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const joined = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return /^[0-9]/.test(joined) ? `Mod${joined}` : joined;
}

/** Lowercase alphanumerics only. Empty/invalid → 'author'. */
export function sanitizeAuthorHandle(input: string): string {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || 'author';
}

/** `${author}.${PascalCaseName}`. Returns '' if name is empty. */
export function derivePackageId(author: string, name: string): string {
  const a = sanitizeAuthorHandle(author);
  const n = pascalCase(name);
  if (!n) return '';
  return `${a}.${n}`;
}
