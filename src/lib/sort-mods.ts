import type { WorkspaceMod } from '../agent/workspace';

export function byUpdatedDesc(a: WorkspaceMod, b: WorkspaceMod): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.about.name.localeCompare(b.about.name);
}
