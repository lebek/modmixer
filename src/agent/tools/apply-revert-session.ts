import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  getRegistry,
  getSessionManager,
  diffActiveLists,
} from '../registry/index.js';

const Empty = Type.Object({});

interface SessionEndResult {
  sessionId: string;
  type: 'test' | 'fix';
  diff: { added: string[]; removed: string[]; reordered: boolean } | null;
  outcome: 'applied' | 'reverted' | 'no-active-session';
}

export const applySessionTool: AgentTool<typeof Empty, SessionEndResult> = {
  name: 'apply_session',
  label: 'Apply session changes',
  description:
    "Persist the current state as the final mod list and end the active session. Drops the snapshot. Pair with revert_session as the two ways a fix or test session can end. ALWAYS surface the diff to the user (apply_session output includes it) before calling — they get the final say.",
  parameters: Empty,
  async execute(): Promise<AgentToolResult<SessionEndResult>> {
    const session = getSessionManager().getActive();
    if (!session) {
      return {
        content: [{ type: 'text', text: 'No active session.' }],
        details: {
          sessionId: '',
          type: 'fix',
          diff: null,
          outcome: 'no-active-session',
        },
      };
    }
    const registry = getRegistry();
    await registry.refresh();
    const current = registry.getSnapshot().activeOrder;
    const diff =
      session.initialActive
        ? diffActiveLists(session.initialActive, current)
        : null;
    await getSessionManager().apply();
    return {
      content: [
        {
          type: 'text',
          text: `Applied. Session ${session.id} (${session.type}) ended; current mod list is now permanent.`,
        },
      ],
      details: {
        sessionId: session.id,
        type: session.type,
        diff,
        outcome: 'applied',
      },
    };
  },
};

export const revertSessionTool: AgentTool<typeof Empty, SessionEndResult> = {
  name: 'revert_session',
  label: 'Revert session changes',
  description:
    "Restore the ModsConfig.xml snapshot taken at session start and end the session. Use when the user says no to the proposed fix or wants to bail out of a test. Idempotent if no session is active.",
  parameters: Empty,
  async execute(): Promise<AgentToolResult<SessionEndResult>> {
    const session = getSessionManager().getActive();
    if (!session) {
      return {
        content: [{ type: 'text', text: 'No active session to revert.' }],
        details: {
          sessionId: '',
          type: 'fix',
          diff: null,
          outcome: 'no-active-session',
        },
      };
    }
    const registry = getRegistry();
    await registry.refresh();
    const current = registry.getSnapshot().activeOrder;
    const diff =
      session.initialActive
        ? diffActiveLists(session.initialActive, current)
        : null;
    await getSessionManager().revert();
    await registry.refresh();
    return {
      content: [
        {
          type: 'text',
          text: `Reverted. Session ${session.id} (${session.type}) ended; ModsConfig.xml restored to snapshot.`,
        },
      ],
      details: {
        sessionId: session.id,
        type: session.type,
        diff,
        outcome: 'reverted',
      },
    };
  },
};
