import {
  createExtensionRuntime,
  type Extension,
  type LoadExtensionsResult,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';

/**
 * Minimal ResourceLoader that returns a single, externally-supplied system
 * prompt and no skills/themes/agents files. May host a small set of
 * pre-built in-process extensions (see buildStripThinkingExtension).
 *
 * pi-coding-agent's DefaultResourceLoader scans .pi/ folders for skills,
 * prompts, themes, extensions, and AGENTS.md/CLAUDE.md ancestor files. We
 * don't ship any of that — ModMixer's system prompt is composed in code from
 * the conversation scope. This loader keeps the AgentSession happy without
 * spinning up that machinery.
 *
 * Considered at pi 0.80.x and rejected: DefaultResourceLoader with the no*
 * flags + extensionFactories. Even fully flagged off, its reload() still
 * runs the extension package manager and settings-sourced extension
 * resolution against agentDir — meaning a user's pi settings.json could
 * inject extensions into ModMixer sessions. A custom ResourceLoader is the
 * documented SDK seam for exactly this hermetic setup (docs/sdk.md), so this
 * class is the deliberate choice, not a stopgap. Revisit only if upstream
 * exports loadExtensionFromFactory at the package root (it's internal as of
 * 0.80.3), which would let the extension shells in snapshot-extension.ts /
 * strip-thinking-extension.ts become plain factories.
 *
 * The system prompt is fixed for the lifetime of the loader. Scope changes
 * (e.g. a legacy folder-less conversation being bound to a mod on first open —
 * see bindNewScopeToMod) are handled by reconstructing the AgentSession with a
 * fresh loader, not by mutating an existing one.
 *
 * Stability matters beyond a single in-memory loader: the same byte string
 * must resurface on every rehydration of a conversation (across app
 * restarts, scope upgrades, etc.), because OpenRouter's sticky provider
 * routing keys off the hash of the first system message. The persisted
 * snapshot lives on the `Conversation` record — see
 * `Conversation.systemPrompt` and `buildSystemPrompt` for the broader
 * invariant.
 */
export class ScopedResourceLoader implements ResourceLoader {
  private readonly extensionsResult: LoadExtensionsResult;

  constructor(
    private readonly systemPrompt: string,
    extensions: Extension[] = [],
  ) {
    this.extensionsResult = {
      extensions,
      errors: [],
      runtime: createExtensionRuntime(),
    };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  extendResources(): void {
    // ModMixer doesn't have extensions, so there's nothing to extend.
  }

  async reload(): Promise<void> {
    // No on-disk resources to reload.
  }
}
