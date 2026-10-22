import { describe, expect, it, vi } from 'vitest';
import { deliverPlanRequest } from '../src/plan-request-prompt.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import type { PlanRequestView } from '../src/plan-request.js';

const record = { id: 'request', fromAccount: 'first', toAccount: 'second', mode: 'codex', targetMode: 'claude' } as PlanRequestView;
describe('safe queued expert plan approval instruction', () => {
  it('waits for work and dialogs to finish before delivering one nonce-free instruction', async () => {
    const session = {
      mode: 'codex',
      pid: 10,
      paneDialog: null as string | null,
      isWorking: true,
      terminalBuffer: getCli('codex')!.capabilities.composerReadyMark!,
      writeViaMux: vi.fn(async (_text, options) => {
        options.onOutcome('submitted');
        return true;
      }),
    };
    let attempts = 0;
    await deliverPlanRequest(
      record,
      () => session,
      () => true,
      async () => {
        expect(session.writeViaMux).not.toHaveBeenCalled();
        if (++attempts === 1) {
          session.isWorking = false;
          session.paneDialog = 'sign in';
        } else session.paneDialog = null;
      }
    );
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
    const text = session.writeViaMux.mock.calls[0][0];
    expect(text).toContain('reverie agent plan-move approve request --handoff-file');
    expect(text).toContain('reverie agent plan-move reject request');
    expect(text).toContain('Claude harness');
    expect(text).toContain('rather than calling the owner-only session creation API directly');
    expect(text).not.toMatch(/[a-f0-9]{64}/);
    expect(text).not.toContain('/plan-request-capabilities/');
  });
  it('does not interrupt or deliver after cancellation/owner revocation', async () => {
    let allowed = true;
    const session = {
      mode: 'codex',
      pid: 10,
      paneDialog: null,
      isWorking: true,
      terminalBuffer: '',
      writeViaMux: vi.fn(),
    };
    await expect(
      deliverPlanRequest(
        record,
        () => session,
        () => allowed,
        async () => {
          allowed = false;
        }
      )
    ).rejects.toThrow('no longer authorized');
    expect(session.writeViaMux).not.toHaveBeenCalled();
  });
});
