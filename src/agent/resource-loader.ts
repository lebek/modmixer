import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
} from '@mariozechner/pi-coding-agent';

/**
 * Minimal ResourceLoader that returns a single, externally-supplied system
 * prompt and no skills/extensions/themes/agents files.
 *
 * pi-coding-agent's DefaultResourceLoader scans .pi/ folders for skills,
 * prompts, themes, extensions, and AGENTS.md/CLAUDE.md ancestor files. We
 * don't ship any of that — ModMixer's system prompt is composed in code from
 * the conversation scope. This loader keeps the AgentSession happy without
 * spinning up that machinery.
 *
 * The system prompt is fixed for the lifetime of the loader. Scope changes
 * (e.g. a "new mod" conversation upgrading to a "mod" scope after
 * scaffold_mod completes) are handled by reconstructing the AgentSession
 * with a fresh loader, not by mutating an existing one.
 */
export class ScopedResourceLoader implements ResourceLoader {
  private readonly extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  constructor(private readonly systemPrompt: string) {}

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
