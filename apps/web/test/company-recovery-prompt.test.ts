import { describe, it, expect, vi } from 'vitest';
import { deliverRecoveryPrompt, submitRecoveryPrompt } from '../src/company-recovery-prompt.js';
import { placeholderHoldsPrompt } from '../src/session-submit-verifier.js';

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
  it('recognizes a handoff split into several CLI paste placeholders by the laptop transport', () => {
    const composer = '[Pasted Content 1024 chars][Pasted Content 1016 chars]';
    expect(placeholderHoldsPrompt(composer, 'x'.repeat(2040))).toBe(true);
    expect(placeholderHoldsPrompt(composer, 'x'.repeat(3000))).toBe(false);
  });
  it('keeps one handoff submission alive through a slow CLI startup without typing the body twice', async () => {
    const session = fixture();
    let outcome: (value: 'submitted') => void = () => {};
    session.writeViaMux.mockImplementation(async (_text, options) => { outcome = options.onOutcome; return true; });
    let seconds = 0;
    await submitRecoveryPrompt(session, 'Saved handoff', () => true, async () => {
      if (++seconds === 50) outcome('submitted');
    });
    expect(seconds).toBe(50);
    expect(session.writeViaMux).toHaveBeenCalledTimes(1);
  });
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
