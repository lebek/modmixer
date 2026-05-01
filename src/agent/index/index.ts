export { getIndexPaths } from './paths.js';
export { getIndexStatus, rebuildIndex, ensureIndexFresh, isRebuilding, cancelRebuild } from './rebuild.js';
export type { IndexStatus, RebuildOptions } from './rebuild.js';
export type { IndexMeta } from './meta.js';
export type { IndexProgressEvent, IndexPhase } from './progress.js';
