// Public barrel for the mod registry. Other modules should import from here
// rather than reaching into individual files.

export { getRegistry } from './registry.js';
export type {
  ModSource,
  RegistryMod,
  ActiveMod,
  RegistrySnapshot,
} from './types.js';
export { parseAboutXml } from './about-xml.js';
export type { AboutXml, ModDependency } from './about-xml.js';
export {
  readModsConfig,
  writeActiveMods,
  parseModsConfig,
  snapshotModsConfig,
  restoreFromSnapshot,
  listBackups,
} from './mods-config.js';
export { analyzeSnapshot } from './analysis.js';
export type { ModIssue, IssueKind, AnalysisResult } from './analysis.js';
export { autosort } from './autosort.js';
export type { AutosortResult, AutosortConflict, AutosortOptions } from './autosort.js';
export {
  getCommunityRules,
  refreshCommunityRules,
} from './community-rules.js';
export type {
  CommunityRule,
  CommunityRulesSnapshot,
} from './community-rules.js';
export { getSessionManager } from './session.js';
export type { ActiveSession, SessionType, SessionEvent } from './session.js';
export { computeTestSet, diffActiveLists } from './test-set.js';
export type { TestSetResult, ActiveDiff } from './test-set.js';
