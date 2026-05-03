import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getRegistry, getSessionManager } from '../registry/index.js';

const Params = Type.Object({});

interface StartFixSessionResult {
  sessionId: string;
  startedAt: string;
  initialActive: string[];
}

export const startFixSessionTool: AgentTool<
  typeof Params,
  StartFixSessionResult
> = {
  name: 'start_fix_session',
  label: 'Start fix session',
  description:
    "Snapshot the current ModsConfig.xml and enter fix mode. While a fix session is active, the agent can mutate the active mod list with set_active_mods (and reorder/disable freely) without per-call confirmation — the session itself is the consent. Call apply_session at the end to keep the changes, or revert_session to restore the original list. RimWorld's bytes are safe either way: the snapshot is on disk, so a crash mid-session still recovers via the startup prompt.",
  parameters: Params,
  async execute(): Promise<AgentToolResult<StartFixSessionResult>> {
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const snapshot = registry.getSnapshot();
    const session = await getSessionManager().startFixSession(snapshot.activeOrder);
    return {
      content: [
        {
          type: 'text',
          text: `Fix session started. Initial active list: ${snapshot.activeOrder.length} mods. Mutate freely with set_active_mods, then call apply_session or revert_session.`,
        },
      ],
      details: {
        sessionId: session.id,
        startedAt: session.startedAt,
        initialActive: session.initialActive ?? [],
      },
    };
  },
};
