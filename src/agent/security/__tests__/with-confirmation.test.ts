import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { withConfirmation } from '../with-confirmation.js';

/**
 * Stub for the gate so the test runs without Electron's `app` or `ipcMain`.
 * We inject it by setting the module-level `gateInstance` in
 * `confirmation-gate.ts` via a tiny test helper.
 */
import {
  installTestConfirmationGateForTests,
  getConfirmationGate,
} from '../confirmation-gate.js';

interface TestParams {
  folder: string;
}

function makeStubTool(): { tool: AgentTool<any>; calls: TestParams[] } {
  const calls: TestParams[] = [];
  const Params = Type.Object({ folder: Type.String() });
  const tool: AgentTool<any> = {
    name: 'stub_destructive',
    label: 'Stub destructive op',
    description: 'For tests only.',
    parameters: Params,
    async execute(_id, params) {
      const typed = params as TestParams;
      calls.push(typed);
      return {
        content: [{ type: 'text', text: `did ${typed.folder}` }],
        details: undefined,
      };
    },
  };
  return { tool, calls };
}

describe('withConfirmation', () => {
  beforeEach(() => {
    // Each test installs a fresh stub gate so state does not leak between
    // cases.
    installTestConfirmationGateForTests();
  });

  it('runs the wrapped tool when the gate approves', async () => {
    getConfirmationGate().setTestAutoApprove(true);
    const { tool, calls } = makeStubTool();
    const wrapped = withConfirmation(tool, {
      label: 'Do the thing',
      summary: 'Tests want it done.',
    });

    const result = await wrapped.execute('id-1', { folder: 'MyMod' }, undefined, undefined);
    assert.deepEqual(calls, [{ folder: 'MyMod' }]);
    assert.equal(
      result.content[0].type === 'text' ? result.content[0].text : null,
      'did MyMod',
    );
  });

  it('does NOT run the wrapped tool when the gate denies, and throws so the agent surfaces a tool error', async () => {
    getConfirmationGate().setTestAutoApprove(false);
    const { tool, calls } = makeStubTool();
    const wrapped = withConfirmation(tool, {
      label: 'Do the thing',
      summary: 'Tests want it done.',
    });

    await assert.rejects(
      () => wrapped.execute('id-2', { folder: 'MyMod' }, undefined, undefined),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('User denied permission to run stub_destructive'),
    );
    assert.deepEqual(
      calls,
      [],
      'wrapped tool must NOT run after denial — this is the structural gate consent depends on',
    );
  });
});
