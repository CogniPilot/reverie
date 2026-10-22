import { describe, it, expect, vi } from 'vitest';
import { deliverRecoveryPrompt } from '../src/company-recovery-prompt.js';

function fixture() {
  const session = {
    mode: 'claude',
    pid: 42 as number | null,
    paneDialog: null as string | null,
    isWorking: false,
    terminalBuffer: '',
    writeViaMux: vi.fn(async (_text, options) => {
      options.onOutcome('submitted');
      return true;
    }),
  };
  return session;
}
describe('crash recovery kickoff delivery', () => {
  it('waits for composer readiness, then verifies one submission into the same pane', async () => {
    const session = fixture();
    const sleep = vi.fn(async () => {
      session.terminalBuffer = 'shift+tab';
    });
    await deliverRecoveryPrompt(session, 'Restore\norganization', () => true, sleep);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
    expect(session.writeViaMux.mock.calls[0][0]).toBe('Restore organization\r');
  });
  it('never types into startup dialogs even when a readiness footer is visible', async () => {
    const session = fixture();
    session.terminalBuffer = 'shift+tab';
    session.paneDialog = 'Enter to continue';
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => true,
        async () => {}
      )
    ).rejects.toThrow('did not become ready');
    expect(session.writeViaMux).not.toHaveBeenCalled();
  });
  it('cancels if the owner changes selection or stops the expert while readiness is awaited', async () => {
    const session = fixture();
    let allowed = true;
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => allowed,
        async () => {
          allowed = false;
        }
      )
    ).rejects.toThrow('canceled');
    expect(session.writeViaMux).not.toHaveBeenCalled();
  });
  it('never pastes the body twice when submission is unverified', async () => {
    const session = fixture();
    session.terminalBuffer = 'shift+tab';
    session.writeViaMux.mockImplementation(async (_text, options) => {
      options.onOutcome('unverified');
      return true;
    });
    await expect(
      deliverRecoveryPrompt(
        session,
        'Restore',
        () => true,
        async () => {}
      )
    ).rejects.toThrow('not confirmed');
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
  });
});
